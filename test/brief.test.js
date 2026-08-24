'use strict';

const test = require('node:test');
const assert = require('node:assert');

const brief = require('../skills/usage-limits/scripts/brief.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-08-24T12:00:00.000Z');

const config = brief.DEFAULTS;

// A weekly window that opened `elapsed` ago with `percent` of the budget gone.
function weekly(percent, elapsed, extra) {
  return Object.assign(
    {
      key: 'seven_day',
      label: 'weekly',
      percentUsed: percent,
      windowStart: NOW - elapsed,
      spanMs: 7 * DAY,
      msToReset: 7 * DAY - elapsed,
      stale: false,
      verdict: 'resets-first',
      turnsLeft: 40,
    },
    extra
  );
}

test('aheadOfPace measures spending against the clock, not the budget alone', () => {
  // Two days into a week is 28.6% elapsed, so 60% spent is well ahead.
  assert.ok(Math.abs(brief.aheadOfPace(weekly(60, 2 * DAY), NOW) - 31.4) < 0.2);
  assert.ok(Math.abs(brief.aheadOfPace(weekly(29, 2 * DAY), NOW)) < 1);
  assert.ok(brief.aheadOfPace(weekly(10, 2 * DAY), NOW) < 0);
});

test('aheadOfPace gives up rather than guessing', () => {
  assert.strictEqual(brief.aheadOfPace(null, NOW), null);
  assert.strictEqual(brief.aheadOfPace({ percentUsed: 50 }, NOW), null);
});

test('a window in step with the clock reads roomy', () => {
  assert.strictEqual(brief.pressure(weekly(20, 2 * DAY), NOW, config), 'roomy');
  assert.strictEqual(brief.pressure(weekly(29, 2 * DAY), NOW, config), 'roomy');
});

test('near the wall reads tight regardless of pace', () => {
  assert.strictEqual(brief.pressure(weekly(85, 6 * DAY), NOW, config), 'tight');
});

test('well ahead of pace reads tight before the wall', () => {
  assert.strictEqual(brief.pressure(weekly(60, 2 * DAY), NOW, config), 'tight');
});

test('ahead of pace but barely used is still roomy', () => {
  assert.strictEqual(brief.pressure(weekly(30, HOUR), NOW, config), 'roomy');
});

test('the verdict overrides the arithmetic', () => {
  assert.strictEqual(
    brief.pressure(weekly(12, HOUR, { verdict: 'runs-out' }), NOW, config),
    'tight'
  );
  assert.strictEqual(
    brief.pressure(weekly(100, HOUR, { verdict: 'exhausted' }), NOW, config),
    'gone'
  );
});

test('a stale window is unknown rather than tight', () => {
  assert.strictEqual(
    brief.pressure(weekly(100, 6 * DAY, { stale: true }), NOW, config),
    'unknown',
    'its number is known to be wrong, so it must not drive the wording'
  );
  assert.strictEqual(brief.pressure(null, NOW, config), 'unknown');
});

test('sessionSpend counts only the session it was asked about', () => {
  const events = [
    { sessionId: 'a', cost: 1 },
    { sessionId: 'b', cost: 10 },
    { sessionId: 'a', cost: 2 },
  ];
  assert.deepStrictEqual(brief.sessionSpend(events, 'a'), { turns: 2, cost: 3 });
  assert.deepStrictEqual(brief.sessionSpend(events, 'b'), { turns: 1, cost: 10 });
});

test('sessionSpend says nothing rather than zero when it cannot tell', () => {
  assert.strictEqual(brief.sessionSpend([{ sessionId: 'a', cost: 1 }], null), null);
  assert.strictEqual(brief.sessionSpend([{ sessionId: 'a', cost: 1 }], 'missing'), null);
  assert.strictEqual(brief.sessionSpend([], 'a'), null);
});

test('summarise lists the windows and flags a rolling one', () => {
  const text = brief.summarise([
    weekly(16, 2 * DAY),
    Object.assign(weekly(100, 6 * DAY), { label: '5-hour', stale: true }),
  ]);
  assert.strictEqual(text, 'weekly 16%, 5-hour rolling over');
});

test('summarise skips windows with no reading', () => {
  const text = brief.summarise([weekly(16, 2 * DAY), { label: 'x', percentUsed: null }]);
  assert.strictEqual(text, 'weekly 16%');
});

test('the line carries the numbers, the session, and an instruction', () => {
  const text = brief.briefText({
    windowSummary: 'weekly 16%, 5-hour 47%',
    turnsLeft: 75,
    resetsIn: '3h 52m',
    session: { turns: 229, cost: 64.16 },
    pressure: 'roomy',
  });
  assert.match(text, /^\[usage-limits\]/);
  assert.match(text, /weekly 16%, 5-hour 47%/);
  assert.match(text, /about 75 turns of headroom/);
  assert.match(text, /resets in 3h 52m/);
  assert.match(text, /this session 229 turns/);
  assert.match(text, /Open your reply with one short line/);
  assert.match(text, /single line/, 'the roomy case must ask for brevity');
});

test('a tight budget changes the instruction, not just the numbers', () => {
  const text = brief.briefText({
    windowSummary: 'weekly 88%',
    turnsLeft: 6,
    resetsIn: '40m',
    session: null,
    pressure: 'tight',
  });
  assert.match(text, /what you will do now and what you will leave/);
  assert.match(text, /will not finish/);
  assert.doesNotMatch(text, /confirming the request fits/);
});

test('the line still works when parts are missing', () => {
  const text = brief.briefText({
    windowSummary: 'weekly 16%',
    turnsLeft: null,
    resetsIn: null,
    session: null,
    pressure: 'roomy',
  });
  assert.match(text, /weekly 16%/);
  assert.doesNotMatch(text, /turns of headroom/);
  assert.doesNotMatch(text, /resets in/);
  assert.doesNotMatch(text, /this session/);
});

test('thresholds are configurable through the environment', () => {
  const previous = process.env.USAGE_LIMITS_NEAR;
  process.env.USAGE_LIMITS_NEAR = '55';
  try {
    const settings = brief.settings();
    assert.strictEqual(settings.near, 55);
    assert.strictEqual(settings.floor, brief.DEFAULTS.floor, 'unset values keep defaults');
  } finally {
    if (previous === undefined) delete process.env.USAGE_LIMITS_NEAR;
    else process.env.USAGE_LIMITS_NEAR = previous;
  }
});

test('nonsense in the environment falls back rather than producing NaN', () => {
  const previous = process.env.USAGE_LIMITS_NEAR;
  process.env.USAGE_LIMITS_NEAR = 'soon';
  try {
    assert.strictEqual(brief.settings().near, brief.DEFAULTS.near);
  } finally {
    if (previous === undefined) delete process.env.USAGE_LIMITS_NEAR;
    else process.env.USAGE_LIMITS_NEAR = previous;
  }
});

test('the off switch wins over everything', async () => {
  const previous = process.env.USAGE_LIMITS_BRIEF;
  process.env.USAGE_LIMITS_BRIEF = 'off';
  try {
    assert.strictEqual(await brief.run(NOW, { session_id: 'a' }), '');
  } finally {
    if (previous === undefined) delete process.env.USAGE_LIMITS_BRIEF;
    else process.env.USAGE_LIMITS_BRIEF = previous;
  }
});

test('pickCached returns a slot that is still warm', () => {
  const all = { alpha: { at: NOW - 10 * 1000, turnsLeft: 40 } };
  const hit = brief.pickCached(all, 'alpha', NOW, 60 * 1000);
  assert.strictEqual(hit.turnsLeft, 40);
});

test('pickCached ignores a slot that has gone cold', () => {
  const all = { alpha: { at: NOW - 90 * 1000, turnsLeft: 40 } };
  assert.strictEqual(brief.pickCached(all, 'alpha', NOW, 60 * 1000), null);
});

test('one session never reads another session slot', () => {
  const all = { alpha: { at: NOW, turnsLeft: 40 } };
  assert.strictEqual(brief.pickCached(all, 'beta', NOW, 60 * 1000), null);
});

test('pickCached survives a missing or malformed cache', () => {
  assert.strictEqual(brief.pickCached(null, 'a', NOW, 1000), null);
  assert.strictEqual(brief.pickCached({}, 'a', NOW, 1000), null);
  assert.strictEqual(brief.pickCached({ a: {} }, 'a', NOW, 1000), null);
  assert.strictEqual(brief.pickCached({ a: { at: 'soon' } }, 'a', NOW, 1000), null);
});

test('a session with no id still gets a slot of its own', () => {
  const merged = brief.mergeCache({}, null, { at: NOW, turnsLeft: 5 }, 5);
  assert.deepStrictEqual(Object.keys(merged), ['_']);
  assert.strictEqual(brief.pickCached(merged, null, NOW, 60 * 1000).turnsLeft, 5);
});

test('mergeCache keeps other sessions rather than replacing them', () => {
  const existing = { alpha: { at: NOW - 5000, turnsLeft: 40 } };
  const merged = brief.mergeCache(existing, 'beta', { at: NOW, turnsLeft: 12 }, 5);
  assert.deepStrictEqual(Object.keys(merged).sort(), ['alpha', 'beta']);
  assert.strictEqual(merged.alpha.turnsLeft, 40, 'the other session must survive');
});

test('mergeCache prunes the oldest so the file cannot grow forever', () => {
  let all = {};
  for (let i = 0; i < 8; i += 1) {
    all = brief.mergeCache(all, 'session' + i, { at: NOW + i, turnsLeft: i }, 3);
  }
  const keys = Object.keys(all);
  assert.strictEqual(keys.length, 3);
  assert.deepStrictEqual(keys.sort(), ['session5', 'session6', 'session7'], 'newest survive');
});

test('mergeCache defaults to the shipped slot count', () => {
  let all = {};
  for (let i = 0; i < 9; i += 1) {
    all = brief.mergeCache(all, 's' + i, { at: NOW + i, turnsLeft: i });
  }
  assert.strictEqual(Object.keys(all).length, brief.KEEP_SESSIONS);
});
