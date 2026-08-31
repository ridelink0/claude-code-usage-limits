'use strict';

const test = require('node:test');
const assert = require('node:assert');

const pulse = require('../skills/usage-limits/scripts/pulse.js');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const NOW = Date.parse('2026-08-31T05:00:00.000Z');

test('a session is due the first time it is seen', () => {
  assert.strictEqual(pulse.due({}, 'a', NOW, 2 * MINUTE), true);
  assert.strictEqual(pulse.due(null, 'a', NOW, 2 * MINUTE), true);
});

test('a session is not due again until the interval has passed', () => {
  const state = { a: { at: NOW } };
  assert.strictEqual(pulse.due(state, 'a', NOW + MINUTE, 2 * MINUTE), false);
  assert.strictEqual(pulse.due(state, 'a', NOW + 2 * MINUTE, 2 * MINUTE), true);
  assert.strictEqual(pulse.due(state, 'a', NOW + 5 * MINUTE, 2 * MINUTE), true);
});

test('sessions are throttled independently', () => {
  // Two windows working at once must not silence each other: the whole point is
  // that each one is told the budget is draining under it.
  const state = { a: { at: NOW } };
  assert.strictEqual(pulse.due(state, 'a', NOW + MINUTE, 2 * MINUTE), false);
  assert.strictEqual(pulse.due(state, 'b', NOW + MINUTE, 2 * MINUTE), true);
});

test('a corrupt or missing slot does not silence the ping', () => {
  assert.strictEqual(pulse.due({ a: null }, 'a', NOW, 2 * MINUTE), true);
  assert.strictEqual(pulse.due({ a: { at: 'soon' } }, 'a', NOW, 2 * MINUTE), true);
  assert.strictEqual(pulse.due({ a: {} }, 'a', NOW, 2 * MINUTE), true);
});

test('trim keeps the newest sessions and records this one', () => {
  const many = {};
  for (let index = 0; index < 12; index += 1) many['s' + index] = { at: NOW - index * MINUTE };
  const kept = pulse.trim(many, 'fresh', NOW + MINUTE);

  assert.strictEqual(Object.keys(kept).length, pulse.KEEP_SESSIONS);
  assert.strictEqual(kept.fresh.at, NOW + MINUTE);
  assert.ok(!kept.s11, 'the oldest slot is dropped rather than growing the file');
});

test('an unnamed session still gets a slot', () => {
  const kept = pulse.trim({}, null, NOW);
  assert.strictEqual(kept._.at, NOW);
});

test('the envelope is the documented PostToolUse shape', () => {
  const parsed = JSON.parse(pulse.envelope('hello'));
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.strictEqual(parsed.hookSpecificOutput.additionalContext, 'hello');
});

test('the line names the window, the runway and the sharing', () => {
  const text = pulse.pulseText({
    label: '5-hour',
    percentUsed: 69,
    approximate: true,
    turnsLeft: 34,
    runsOutIn: '14m',
    sessions: 3,
    pressure: 'tight',
  });
  assert.match(text, /5-hour now about 69%/);
  assert.match(text, /about 34 turns left/);
  assert.match(text, /14m at this pace/);
  assert.match(text, /3 sessions sharing it/);
  assert.match(text, /write the plan for the next session/);
});

test('an exhausted budget says to stop rather than to hurry', () => {
  const text = pulse.pulseText({ label: '5-hour', percentUsed: 100, sessions: 1, pressure: 'gone' });
  assert.match(text, /budget is gone/);
  assert.match(text, /handoff/);
});

test('a window at zero is still reported, not treated as missing', () => {
  const text = pulse.pulseText({ label: '5-hour', percentUsed: 0, sessions: 1, pressure: 'tight' });
  assert.match(text, /5-hour now 0%/);
});

test('nothing worth saying produces no line at all', () => {
  assert.strictEqual(pulse.pulseText({ label: '5-hour', sessions: 1, pressure: 'roomy' }), '');
});

test('a single session is not described as sharing', () => {
  const text = pulse.pulseText({
    label: 'weekly', percentUsed: 40, turnsLeft: 10, sessions: 1, pressure: 'tight',
  });
  assert.ok(text.indexOf('sharing') === -1);
});

test('the interval is two minutes unless the environment says otherwise', () => {
  const before = process.env.USAGE_LIMITS_PULSE_SECONDS;
  try {
    delete process.env.USAGE_LIMITS_PULSE_SECONDS;
    assert.strictEqual(pulse.intervalMs(), pulse.DEFAULT_INTERVAL_SECONDS * SECOND);
    process.env.USAGE_LIMITS_PULSE_SECONDS = '30';
    assert.strictEqual(pulse.intervalMs(), 30 * SECOND);
    // Nonsense must not turn into a zero interval, which would fire the scan
    // after every single tool call.
    process.env.USAGE_LIMITS_PULSE_SECONDS = 'soon';
    assert.strictEqual(pulse.intervalMs(), pulse.DEFAULT_INTERVAL_SECONDS * SECOND);
    process.env.USAGE_LIMITS_PULSE_SECONDS = '0';
    assert.strictEqual(pulse.intervalMs(), pulse.DEFAULT_INTERVAL_SECONDS * SECOND);
    process.env.USAGE_LIMITS_PULSE_SECONDS = '-5';
    assert.strictEqual(pulse.intervalMs(), pulse.DEFAULT_INTERVAL_SECONDS * SECOND);
  } finally {
    if (before === undefined) delete process.env.USAGE_LIMITS_PULSE_SECONDS;
    else process.env.USAGE_LIMITS_PULSE_SECONDS = before;
  }
});

test('the ping can be turned off entirely', async () => {
  const before = process.env.USAGE_LIMITS_PULSE;
  try {
    process.env.USAGE_LIMITS_PULSE = 'off';
    assert.strictEqual(await pulse.run(NOW, { session_id: 'a' }), '');
  } finally {
    if (before === undefined) delete process.env.USAGE_LIMITS_PULSE;
    else process.env.USAGE_LIMITS_PULSE = before;
  }
});
