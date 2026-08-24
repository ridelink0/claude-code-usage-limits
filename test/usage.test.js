'use strict';

const test = require('node:test');
const assert = require('node:assert');

const usage = require('../skills/usage-limits/scripts/usage.js');

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-23T22:00:00.000Z');

function near(actual, expected, tolerance) {
  assert.ok(
    Math.abs(actual - expected) <= (tolerance || 1e-6),
    'expected ' + actual + ' to be near ' + expected
  );
}

test('rateFor matches known ids exactly', () => {
  assert.deepStrictEqual(usage.rateFor('claude-opus-5'), { input: 5, output: 25 });
  assert.deepStrictEqual(usage.rateFor('claude-haiku-4-5'), { input: 1, output: 5 });
  assert.deepStrictEqual(usage.rateFor('claude-fable-5'), { input: 10, output: 50 });
});

test('rateFor falls back to the family when the id is unknown', () => {
  assert.deepStrictEqual(usage.rateFor('claude-sonnet-9-9'), { input: 3, output: 15 });
  assert.deepStrictEqual(usage.rateFor('CLAUDE-OPUS-9'), { input: 5, output: 25 });
  assert.deepStrictEqual(usage.rateFor(''), { input: 5, output: 25 });
  assert.deepStrictEqual(usage.rateFor(undefined), { input: 5, output: 25 });
});

test('costOf prices cache traffic at its own multipliers', () => {
  const record = {
    input_tokens: 2,
    cache_read_input_tokens: 24780,
    cache_creation_input_tokens: 8049,
    output_tokens: 2144,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 8049 },
  };
  // 2 + (24780 * 0.1) + (8049 * 2) = 18578 input units at $5/M,
  // plus 2144 output tokens at $25/M.
  const expected = (18578 * 5 + 2144 * 25) / 1e6;
  near(usage.costOf(record, 'claude-opus-5'), expected, 1e-9);
});

test('costOf handles records that only carry the cache total', () => {
  const record = {
    input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 1000,
    output_tokens: 0,
  };
  near(usage.costOf(record, 'claude-opus-5'), (1000 * 1.25 * 5) / 1e6, 1e-9);
});

test('costOf is zero for a missing record', () => {
  assert.strictEqual(usage.costOf(null, 'claude-opus-5'), 0);
  assert.strictEqual(usage.costOf(undefined, ''), 0);
});

test('tokensOf sums every token class once', () => {
  const record = {
    input_tokens: 10,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 50,
    output_tokens: 5,
  };
  assert.strictEqual(usage.tokensOf(record), 165);
});

test('eventFrom reads an assistant turn', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-23T22:00:00.000Z',
    requestId: 'req_1',
    effort: 'xhigh',
    message: {
      id: 'msg_1',
      model: 'claude-opus-5',
      usage: { input_tokens: 100, output_tokens: 100 },
    },
  });
  const event = usage.eventFrom(line, new Set());
  assert.strictEqual(event.at, NOW);
  assert.strictEqual(event.model, 'claude-opus-5');
  assert.strictEqual(event.effort, 'xhigh');
  near(event.cost, (100 * 5 + 100 * 25) / 1e6, 1e-9);
});

test('eventFrom skips a turn already counted in another file', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-23T22:00:00.000Z',
    requestId: 'req_1',
    message: { id: 'msg_1', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 } },
  });
  const seen = new Set();
  assert.ok(usage.eventFrom(line, seen));
  assert.strictEqual(usage.eventFrom(line, seen), null);
});

test('eventFrom ignores lines that are not billable turns', () => {
  const seen = new Set();
  assert.strictEqual(usage.eventFrom('', seen), null);
  assert.strictEqual(usage.eventFrom('not json at all', seen), null);
  assert.strictEqual(
    usage.eventFrom('{"type":"user","message":{"usage":{}},"assistant":1}', seen),
    null
  );
  assert.strictEqual(
    usage.eventFrom(JSON.stringify({ type: 'assistant', message: { usage: {} } }), seen),
    null,
    'a turn with no timestamp cannot be placed in a window'
  );
});

const spec = { key: 'five_hour', label: '5-hour', span: 5 * HOUR };

function events(list) {
  return list.map((item) => ({
    at: NOW + item.offset,
    cost: item.cost,
    tokens: item.tokens || 0,
    model: 'claude-opus-5',
    effort: item.effort || null,
  }));
}

test('buildWindow calibrates dollars per percent from measured spend', () => {
  const snapshot = { utilization: 10, resets_at: new Date(NOW + HOUR).toISOString() };
  const sample = events([
    { offset: -3 * HOUR, cost: 1 },
    { offset: -3 * HOUR, cost: 1 },
    { offset: -3 * HOUR, cost: 1 },
    { offset: -0.5 * HOUR, cost: 1 },
    { offset: -0.5 * HOUR, cost: 1 },
  ]);
  const window = usage.buildWindow(spec, snapshot, sample, NOW);

  assert.strictEqual(window.percentUsed, 10);
  assert.strictEqual(window.percentLeft, 90);
  assert.strictEqual(window.turns, 5);
  near(window.usdPerPercent, 0.5);
  near(window.remainingUSD, 45);
  near(window.percentPerTurn, 2);
  assert.strictEqual(window.turnsLeft, 45);
  near(window.headroomMs, 22.5 * HOUR, 1);
  assert.strictEqual(window.verdict, 'resets-first');
});

test('buildWindow reports runs-out when the pace beats the reset', () => {
  const snapshot = { utilization: 90, resets_at: new Date(NOW + HOUR).toISOString() };
  const sample = events([
    { offset: -3 * HOUR, cost: 1 },
    { offset: -3 * HOUR, cost: 1 },
    { offset: -3 * HOUR, cost: 1 },
    { offset: -0.5 * HOUR, cost: 1 },
    { offset: -0.5 * HOUR, cost: 1 },
  ]);
  const window = usage.buildWindow(spec, snapshot, sample, NOW);

  assert.strictEqual(window.verdict, 'runs-out');
  assert.ok(window.headroomMs < window.msToReset);
});

test('buildWindow stays idle when nothing recent can set a pace', () => {
  const snapshot = { utilization: 10, resets_at: new Date(NOW + HOUR).toISOString() };
  const sample = events([
    { offset: -3 * HOUR, cost: 1 },
    { offset: -3 * HOUR, cost: 1 },
  ]);
  const window = usage.buildWindow(spec, snapshot, sample, NOW);

  assert.strictEqual(window.headroomMs, null);
  assert.strictEqual(window.verdict, 'idle');
  assert.strictEqual(window.turnsLeft, 18, 'the window average still gives a per-turn cost');
});

test('buildWindow leaves an untouched window uncalibrated', () => {
  const snapshot = { utilization: 0, resets_at: new Date(NOW + HOUR).toISOString() };
  const window = usage.buildWindow(spec, snapshot, [], NOW);

  assert.strictEqual(window.usdPerPercent, null);
  assert.strictEqual(window.remainingUSD, null);
  assert.strictEqual(window.verdict, 'idle');
});

test('buildWindow survives a missing snapshot', () => {
  const window = usage.buildWindow(spec, null, [], NOW);
  assert.strictEqual(window.percentUsed, null);
  assert.strictEqual(window.msToReset, null);
  assert.strictEqual(window.verdict, 'unknown');
});

test('buildWindow marks a low reading as coarse', () => {
  const snapshot = { utilization: 2, resets_at: new Date(NOW + HOUR).toISOString() };
  const sample = events([{ offset: -0.5 * HOUR, cost: 1 }]);
  assert.strictEqual(usage.buildWindow(spec, snapshot, sample, NOW).coarse, true);

  const higher = { utilization: 40, resets_at: new Date(NOW + HOUR).toISOString() };
  assert.strictEqual(usage.buildWindow(spec, higher, sample, NOW).coarse, false);
});

test('buildWindow excludes spend from before the window opened', () => {
  const snapshot = { utilization: 10, resets_at: new Date(NOW + HOUR).toISOString() };
  const sample = events([
    { offset: -10 * HOUR, cost: 99 },
    { offset: -1 * HOUR, cost: 1 },
  ]);
  const window = usage.buildWindow(spec, snapshot, sample, NOW);
  assert.strictEqual(window.turns, 1);
  near(window.spentUSD, 1);
});

test('bindingWindow picks the limit that stops the work first', () => {
  const soon = { key: 'a', percentUsed: 50, headroomMs: 10 * HOUR };
  const sooner = { key: 'b', percentUsed: 20, headroomMs: 2 * HOUR };
  assert.strictEqual(usage.bindingWindow([soon, sooner]).key, 'b');
});

test('bindingWindow falls back to the fullest window with no pace', () => {
  const low = { key: 'a', percentUsed: 12, headroomMs: null };
  const high = { key: 'b', percentUsed: 88, headroomMs: null };
  assert.strictEqual(usage.bindingWindow([low, high]).key, 'b');
});

test('bindingWindow returns nothing when no window has a reading', () => {
  assert.strictEqual(usage.bindingWindow([{ key: 'a', percentUsed: null }]), null);
  assert.strictEqual(usage.bindingWindow([]), null);
});

test('formatDuration reads like a clock', () => {
  assert.strictEqual(usage.formatDuration(0), 'now');
  assert.strictEqual(usage.formatDuration(-5000), 'now');
  assert.strictEqual(usage.formatDuration(45 * 60 * 1000), '45m');
  assert.strictEqual(usage.formatDuration(2 * HOUR), '2h');
  assert.strictEqual(usage.formatDuration(2 * HOUR + 30 * 60 * 1000), '2h 30m');
  assert.strictEqual(usage.formatDuration(50 * HOUR), '2d 2h');
  assert.strictEqual(usage.formatDuration(null), '-');
});

test('formatUSD keeps small amounts readable', () => {
  assert.strictEqual(usage.formatUSD(0.164), '$0.164');
  assert.strictEqual(usage.formatUSD(12.5), '$12.50');
  assert.strictEqual(usage.formatUSD(121.4), '$121');
  assert.strictEqual(usage.formatUSD(null), '-');
});

test('dominantEffort reports the level most turns ran at', () => {
  const sample = events([
    { offset: -1, cost: 0, effort: 'xhigh' },
    { offset: -2, cost: 0, effort: 'xhigh' },
    { offset: -3, cost: 0, effort: 'low' },
  ]);
  assert.strictEqual(usage.dominantEffort(sample), 'xhigh');
  assert.strictEqual(usage.dominantEffort([]), null);
});

test('verdictLine says something useful in every state', () => {
  const base = { label: 'weekly', percentUsed: 50, msToReset: HOUR, resetsAt: NOW + HOUR };
  for (const verdict of ['exhausted', 'resets-first', 'runs-out', 'idle', 'unknown']) {
    const line = usage.verdictLine(
      Object.assign({}, base, { verdict, headroomMs: 2 * HOUR })
    );
    assert.ok(line.length > 20, verdict + ' should produce a sentence');
  }
  assert.match(usage.verdictLine(null), /\/usage/);
});

test('render explains itself when there is no snapshot', () => {
  const text = usage.render({
    plan: 'unknown',
    snapshotAgeMs: null,
    settings: { model: 'default', effortLevel: 'default' },
    extraUsage: null,
    windows: [],
    binding: null,
    recent: { turns: 0, usd: 0, usdPerTurn: null, tokens: 0, effort: null },
    measuredTurns: 0,
  });
  assert.match(text, /No usage snapshot/);
});

test('detectPlan identifies Pro', () => {
  const plan = usage.detectPlan({
    organizationType: 'claude_pro',
    organizationRateLimitTier: 'default_claude_ai',
  });
  assert.strictEqual(plan.id, 'pro');
  assert.strictEqual(plan.label, 'Claude Pro');
  assert.ok(plan.advice.length > 20);
});

test('detectPlan separates Max 5x from Max 20x', () => {
  const five = usage.detectPlan({
    organizationType: 'claude_max',
    organizationRateLimitTier: 'default_claude_max_5x',
  });
  const twenty = usage.detectPlan({
    organizationType: 'claude_max',
    organizationRateLimitTier: 'default_claude_max_20x',
  });
  assert.strictEqual(five.id, 'max_5x');
  assert.strictEqual(five.label, 'Claude Max 5x');
  assert.strictEqual(twenty.id, 'max_20x');
  assert.strictEqual(twenty.label, 'Claude Max 20x');
  assert.notStrictEqual(five.advice, twenty.advice);
});

test('detectPlan prefers the user tier over the org tier', () => {
  const plan = usage.detectPlan({
    organizationType: 'claude_max',
    organizationRateLimitTier: 'default_claude_max_5x',
    userRateLimitTier: 'default_claude_max_20x',
  });
  assert.strictEqual(plan.id, 'max_20x');
  assert.strictEqual(plan.tier, 'default_claude_max_20x');
});

test('detectPlan falls back to plain Max when no tier is reported', () => {
  const plan = usage.detectPlan({ organizationType: 'claude_max' });
  assert.strictEqual(plan.id, 'max');
  assert.strictEqual(plan.tier, null);
  assert.ok(plan.advice.includes('5x Pro'));
});

test('detectPlan handles Team and Enterprise', () => {
  assert.strictEqual(usage.detectPlan({ organizationType: 'claude_team' }).id, 'team');
  assert.strictEqual(
    usage.detectPlan({ organizationType: 'claude_enterprise' }).id,
    'enterprise'
  );
});

test('detectPlan degrades instead of throwing', () => {
  assert.strictEqual(usage.detectPlan(null).id, 'unknown');
  assert.strictEqual(usage.detectPlan({}).id, 'unknown');
  assert.strictEqual(usage.detectPlan({}).advice, null);

  const future = usage.detectPlan({ organizationType: 'claude_something_new' });
  assert.strictEqual(future.id, 'unknown');
  assert.strictEqual(
    future.label,
    'something_new',
    'an unseen plan should still show what the account reported'
  );
});

test('render prints the plan advice when there is one', () => {
  // An empty window list returns early, so give it a window to render.
  const window = {
    key: 'five_hour',
    label: '5-hour',
    percentUsed: 40,
    percentLeft: 60,
    msToReset: 2 * HOUR,
    resetsAt: NOW + 2 * HOUR,
    remainingUSD: 12,
    turnsLeft: 80,
    headroomMs: 3 * HOUR,
    coarse: false,
    verdict: 'resets-first',
  };
  const data = {
    plan: 'Claude Max 20x',
    planAdvice: 'Max 20x rarely binds.',
    snapshotAgeMs: 60000,
    settings: { model: 'opus', effortLevel: 'xhigh' },
    extraUsage: null,
    windows: [window],
    binding: window,
    recent: { turns: 3, usd: 0.5, usdPerTurn: 0.16, tokens: 0, effort: 'xhigh' },
    measuredTurns: 100,
  };
  const text = usage.render(data);
  assert.match(text, /Claude Max 20x/);
  assert.match(text, /Max 20x rarely binds\./);

  const silent = usage.render(Object.assign({}, data, { planAdvice: null }));
  assert.doesNotMatch(silent, /rarely binds/);
});

test('tokenParts splits the four classes', () => {
  const parts = usage.tokenParts({
    input_tokens: 10,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 50,
    output_tokens: 5,
  });
  assert.deepStrictEqual(parts, { input: 10, cacheWrite: 50, cacheRead: 100, output: 5 });
  assert.deepStrictEqual(usage.tokenParts(null), {
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
  });
});

test('byModel groups by model, dearest first, with shares summing to one', () => {
  const sample = [
    { model: 'claude-haiku-4-5', cost: 1, tokens: 100, parts: { input: 1, cacheWrite: 2, cacheRead: 3, output: 4 } },
    { model: 'claude-opus-5', cost: 3, tokens: 300, parts: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 } },
    { model: 'claude-opus-5', cost: 6, tokens: 600, parts: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 } },
  ];
  const rows = usage.byModel(sample);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].model, 'claude-opus-5');
  assert.strictEqual(rows[0].turns, 2);
  assert.strictEqual(rows[0].tokens, 900);
  assert.strictEqual(rows[0].parts.output, 2);
  assert.strictEqual(Math.round(rows[0].share * 100), 90);
  assert.strictEqual(Math.round(rows[1].share * 100), 10);
  assert.deepStrictEqual(usage.byModel([]), []);
});

test('formatTokens stays short at every scale', () => {
  assert.strictEqual(usage.formatTokens(318), '318');
  assert.strictEqual(usage.formatTokens(631000), '631k');
  assert.strictEqual(usage.formatTokens(26200000), '26.2M');
  assert.strictEqual(usage.formatTokens(2e9), '2.0B');
  assert.strictEqual(usage.formatTokens(NaN), '-');
});

test('statusLine is short and names every window', () => {
  const line = usage.statusLine({
    now: NOW,
    utilization: {
      five_hour: { utilization: 62, resets_at: new Date(NOW + 100 * 60000).toISOString() },
      seven_day: { utilization: 75, resets_at: new Date(NOW + 52 * HOUR).toISOString() },
    },
  });
  assert.strictEqual(line, '5h 62% 1h 40m  wk 75% 2d 4h');
});

test('statusLine flags a window that is nearly gone', () => {
  const line = usage.statusLine({
    now: NOW,
    utilization: { five_hour: { utilization: 94, resets_at: new Date(NOW + HOUR).toISOString() } },
  });
  assert.match(line, /^LOW {2}5h 94%/);
});

test('statusLine says nothing rather than something wrong', () => {
  assert.strictEqual(usage.statusLine({ now: NOW, utilization: null }), '');
  assert.strictEqual(usage.statusLine(null), '');
  assert.strictEqual(usage.statusLine({ now: NOW, utilization: { five_hour: null } }), '');
});

test('statusLine copes with a window that reports no reset time', () => {
  const line = usage.statusLine({
    now: NOW,
    utilization: { seven_day: { utilization: 40, resets_at: null } },
  });
  assert.strictEqual(line, 'wk 40%');
});

test('byProject groups spend by working directory, dearest first', () => {
  const rows = usage.byProject([
    { project: 'C--Users-OWNER', cost: 1, tokens: 10 },
    { project: 'd--work-app', cost: 6, tokens: 60 },
    { project: 'd--work-app', cost: 3, tokens: 30 },
    { project: null, cost: 0, tokens: 0 },
  ]);
  assert.strictEqual(rows[0].project, 'd--work-app');
  assert.strictEqual(rows[0].turns, 2);
  assert.strictEqual(rows[0].tokens, 90);
  assert.strictEqual(Math.round(rows[0].share * 100), 90);
  assert.strictEqual(rows[2].project, 'unknown');
  assert.deepStrictEqual(usage.byProject([]), []);
});

test('shortenProject keeps the identifying tail', () => {
  assert.strictEqual(usage.shortenProject('short', 22), 'short');
  assert.strictEqual(usage.shortenProject('a'.repeat(30), 10), '...' + 'a'.repeat(7));
  assert.strictEqual(usage.shortenProject(null, 10), '');
});

test('render shows the project split only when more than one ran', () => {
  const window = {
    key: 'seven_day',
    label: 'weekly',
    percentUsed: 40,
    percentLeft: 60,
    msToReset: 2 * HOUR,
    resetsAt: NOW + 2 * HOUR,
    remainingUSD: 12,
    turnsLeft: 80,
    headroomMs: 3 * HOUR,
    coarse: false,
    verdict: 'resets-first',
  };
  const base = {
    plan: 'Claude Pro',
    planAdvice: null,
    snapshotAgeMs: 60000,
    settings: { model: 'opus', effortLevel: 'xhigh' },
    extraUsage: null,
    windows: [window],
    binding: window,
    scopeLabel: 'weekly',
    models: [],
    tokens: null,
    recent: { turns: 3, usd: 0.5, usdPerTurn: 0.16, tokens: 0, effort: 'xhigh' },
    measuredTurns: 100,
  };

  const two = usage.render(
    Object.assign({}, base, {
      projects: [
        { project: 'd--work-app', turns: 930, tokens: 45200000, share: 0.78 },
        { project: 'C--Users-OWNER', turns: 240, tokens: 12100000, share: 0.22 },
      ],
    })
  );
  assert.match(two, /Projects in the weekly window/);
  assert.match(two, /d--work-app/);
  assert.match(two, /78%/);

  const one = usage.render(
    Object.assign({}, base, {
      projects: [{ project: 'd--work-app', turns: 930, tokens: 45200000, share: 1 }],
    })
  );
  assert.doesNotMatch(one, /Projects in the/);
});

test('buildWindow treats a passed reset time as stale, not as exhausted', () => {
  const snapshot = {
    utilization: 100,
    resets_at: new Date(NOW - 5 * 60000).toISOString(),
  };
  const sample = events([{ offset: -2 * HOUR, cost: 1 }, { offset: -0.5 * HOUR, cost: 1 }]);
  const window = usage.buildWindow(spec, snapshot, sample, NOW);

  assert.strictEqual(window.stale, true);
  assert.strictEqual(window.verdict, 'rolled-over');
  assert.strictEqual(window.turnsLeft, null, 'a stale window cannot project turns');
  assert.strictEqual(window.remainingUSD, null);
  assert.strictEqual(window.headroomMs, null);
});

test('buildWindow leaves a live window unstale', () => {
  const snapshot = { utilization: 50, resets_at: new Date(NOW + HOUR).toISOString() };
  assert.strictEqual(usage.buildWindow(spec, snapshot, [], NOW).stale, false);
});

test('bindingWindow ignores a stale window when a live one exists', () => {
  const stale = { key: 'a', percentUsed: 100, stale: true, headroomMs: 0 };
  const live = { key: 'b', percentUsed: 10, stale: false, headroomMs: 5 * HOUR };
  assert.strictEqual(usage.bindingWindow([stale, live]).key, 'b');
  assert.strictEqual(
    usage.bindingWindow([stale]).key,
    'a',
    'it still reports something when every window is stale'
  );
});

test('verdictLine explains a rolled over window', () => {
  const line = usage.verdictLine({
    label: '5-hour',
    verdict: 'rolled-over',
    percentUsed: 100,
    msToReset: -5000,
    headroomMs: null,
  });
  assert.match(line, /out of date/);
  assert.match(line, /turned over/);
});

test('statusLine says rolling instead of a percentage it knows is wrong', () => {
  const line = usage.statusLine({
    now: NOW,
    utilization: {
      five_hour: { utilization: 95, resets_at: new Date(NOW - 60000).toISOString() },
      seven_day: { utilization: 12, resets_at: new Date(NOW + 3 * HOUR).toISOString() },
    },
  });
  assert.strictEqual(line, '5h rolling  wk 12% 3h');
  assert.doesNotMatch(line, /LOW/, 'a stale window must not raise the alarm');
});
