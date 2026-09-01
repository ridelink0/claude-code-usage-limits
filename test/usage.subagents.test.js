'use strict';

// Subagent transcripts live under <project>/<session>/subagents/ and spend
// the same budget as the session that spawned them. They count toward cost
// and calibration; they do not count as turns, because a turn is one
// main-thread call and that is the unit the headroom is planned in.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const usage = require('../skills/usage-limits/scripts/usage.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-01T10:00:00.000Z');
const SESSION = 'sess-sub';

// One Opus call: (1000 * 5 + 100 * 25) / 1e6 dollars.
const CALL = 0.0075;

function line(id, at, over) {
  return JSON.stringify(
    Object.assign(
      {
        type: 'assistant',
        timestamp: new Date(at).toISOString(),
        requestId: 'req_' + id,
        sessionId: SESSION,
        message: {
          id: 'msg_' + id,
          model: 'claude-opus-5',
          usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 },
        },
      },
      over || {}
    )
  );
}

function event(over) {
  return Object.assign({ at: NOW - 10 * MINUTE, cost: 1, tokens: 100, model: 'claude-opus-5', sidechain: false }, over || {});
}

test('eventFrom leaves out a synthetic message, which is not an API call', () => {
  const synthetic = line('syn', NOW, {
    message: { id: 'msg_syn', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } },
  });
  assert.strictEqual(usage.eventFrom(synthetic, new Set(), 'proj'), null);
});

test('typicalTurnCost and costPercentiles measure main-thread calls only', () => {
  const sample = [];
  for (let i = 0; i < 5; i += 1) sample.push(event({ cost: 1 }));
  for (let i = 0; i < 20; i += 1) sample.push(event({ cost: 0.01, sidechain: true }));
  assert.strictEqual(usage.typicalTurnCost(sample, sample, sample, 5), 1);
  const spread = usage.costPercentiles(sample);
  assert.strictEqual(spread.sample, 5);
  assert.strictEqual(spread.median, 1);
});

test('buildWindow counts subagent spend in the money and leaves it out of the turns', () => {
  const spec = { key: 'five_hour', label: '5-hour', span: 5 * HOUR };
  const snapshot = { utilization: 10, resets_at: new Date(NOW + HOUR).toISOString() };
  const sample = [];
  for (let i = 0; i < 5; i += 1) sample.push(event({ at: NOW - 30 * MINUTE, cost: 1 }));
  for (let i = 0; i < 4; i += 1) sample.push(event({ at: NOW - 30 * MINUTE, cost: 0.25, sidechain: true }));
  const window = usage.buildWindow(spec, snapshot, sample, NOW);
  assert.strictEqual(window.turns, 5);
  assert.strictEqual(window.subagentTurns, 4);
  assert.ok(Math.abs(window.spentUSD - 6) < 1e-9, 'five dollars of turns plus a dollar of subagents');
  assert.ok(Math.abs(window.usdPerPercent - 0.6) < 1e-9, 'and the point is priced from all of it');
});

test('sessionSpend counts main-thread turns and all of the money', () => {
  const events = [
    { sessionId: 'a', cost: 1, tokens: 10, sidechain: false },
    { sessionId: 'a', cost: 0.5, tokens: 5, sidechain: true },
    { sessionId: 'b', cost: 9, tokens: 9, sidechain: false },
  ];
  assert.deepStrictEqual(usage.sessionSpend(events, 'a'), { turns: 1, cost: 1.5, tokens: 15 });
});

test('the report reads subagent transcripts and says how many calls they made', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-limits-sub-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  usage.setHost('claude');
  try {
    fs.writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({
        oauthAccount: { organizationType: 'claude_max', userRateLimitTier: 'default_claude_max_5x' },
        cachedUsageUtilization: {
          fetchedAtMs: NOW - MINUTE,
          utilization: {
            five_hour: { utilization: 10, resets_at: new Date(NOW + 4 * HOUR).toISOString() },
            seven_day: { utilization: 5, resets_at: new Date(NOW + 6 * DAY).toISOString() },
          },
        },
      })
    );
    const project = path.join(dir, 'projects', 'C--proj');
    fs.mkdirSync(path.join(project, SESSION, 'subagents'), { recursive: true });
    const main = [];
    for (let i = 0; i < 6; i += 1) main.push(line('m' + i, NOW - (30 - i) * MINUTE));
    main.push(line('syn', NOW - 2 * MINUTE, { message: { id: 'msg_syn', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } }));
    fs.writeFileSync(path.join(project, SESSION + '.jsonl'), main.join('\n') + '\n');
    const sub = [];
    for (let i = 0; i < 3; i += 1) sub.push(line('s' + i, NOW - (20 - i) * MINUTE, { isSidechain: true, agentId: 'abc' }));
    fs.writeFileSync(path.join(project, SESSION, 'subagents', 'agent-abc.jsonl'), sub.join('\n') + '\n');

    const data = await usage.report(NOW, { sessionId: SESSION });
    assert.strictEqual(data.measuredTurns, 6, 'six main calls; the synthetic line is not one');
    assert.strictEqual(data.subagentTurns, 3);
    const five = data.windows.find((w) => w.key === 'five_hour');
    assert.strictEqual(five.turns, 6);
    assert.ok(Math.abs(five.spentUSD - 9 * CALL) < 1e-9, 'nine calls of spend inside the window');
    assert.deepStrictEqual(data.session, { turns: 6, cost: 9 * CALL, tokens: 9 * 1100 });

    const text = usage.render(data);
    assert.match(text, /Measured\s+6 turns of local transcript [(][+]3 subagent calls[)]/);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
