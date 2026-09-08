'use strict';

// The second bug pass of 8 September 2026: nine findings that survived two
// independent skeptics each. The tests here pin the ones that were arithmetic
// or quoting - the kind that come back.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const usage = require('../skills/usage-limits/scripts/usage.js');
const relay = require('../skills/usage-limits/scripts/relay.js');
const statusline = require('../skills/usage-limits/scripts/statusline.js');

const NOW = Date.parse('2026-09-08T22:00:00.000Z');

function withConfigDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-limits-round2-'));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A window whose spend has outrun its snapshot: the percentage is a floor,
// the price per point came from a dead denominator, and buildWindow nulls the
// turn count. Everything else that derives a number from it has to agree.
const OVERSHOT = {
  key: 'five_hour',
  label: '5-hour',
  stale: false,
  applies: true,
  percentUsed: 13,
  percentLeft: 87,
  usdPerPercent: 0.5,
  turnsLeft: null,
  headroomMs: null,
  remainingUSD: null,
  pointsBeyondSnapshot: 400,
  correctionUnreliable: true,
};

test('effortWarning quotes no turn count off a window whose spend outran its snapshot', () => {
  const events = [];
  for (let i = 0; i < 5; i += 1) events.push({ at: NOW - i * 60000, cost: 0.5, effort: 'ultra', sidechain: false });
  for (let i = 0; i < 5; i += 1) events.push({ at: NOW - i * 60000, cost: 0.1, effort: 'medium', sidechain: false });
  // Before: {effort:'ultra', turnsLeft:72, ...} printed beside the warning
  // that the window may already be exhausted.
  assert.strictEqual(usage.effortWarning(events, 'ultra', OVERSHOT), null);
});

test('an overshot window is the binding one, however low its floor reads', () => {
  const busy = { key: 'seven_day', label: 'weekly', stale: false, applies: true, percentUsed: 40, headroomMs: 3 * 60 * 60 * 1000 };
  assert.strictEqual(usage.bindingWindow([busy, OVERSHOT]).key, 'five_hour');
  assert.strictEqual(usage.bindingWindow([OVERSHOT, busy]).key, 'five_hour');
});

test('an overshot window is named among the critical others whatever its floor says', () => {
  const others = usage.criticalOthers([OVERSHOT, { key: 'seven_day', stale: false, applies: true, percentUsed: 40 }], 'seven_day');
  assert.deepStrictEqual(others.map((w) => w.key), ['five_hour']);
});

// The wake's command line is unquoted by CommandLineToArgvW, whose one rule a
// naive quoter misses: a backslash escapes only a quote, so a run of them
// before the closing quote has to be doubled or the quote is eaten.
test('a Windows argument ending in a backslash keeps its closing quote', () => {
  assert.strictEqual(relay.winArg('plain'), 'plain');
  assert.strictEqual(relay.winArg('C:\\Users\\Two Words\\'), '"C:\\Users\\Two Words\\\\"');
  assert.strictEqual(relay.winArg('say "hi"'), '"say \\"hi\\""');
  assert.strictEqual(relay.winArg('a\\"b'), '"a\\\\\\"b"');
  assert.strictEqual(relay.winArg('C:\\no space\\'), '"C:\\no space\\\\"');
});

test('the scheduler trims its waits to the time the caller has left', () => {
  const now = Date.now();
  assert.strictEqual(relay.remainingMs(now + 3000, 8000) <= 3000, true);
  assert.strictEqual(relay.remainingMs(now - 1000, 8000), 0);
  assert.strictEqual(relay.remainingMs(null, 8000), 8000);
  assert.strictEqual(relay.remainingMs(now + 60000, 8000), 8000);
});

test('a settings file saved with a byte order mark is read, not refused', () =>
  withConfigDir((dir) => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ model: 'opus' }));
    const applied = relay.applyAlwaysThinking(true);
    assert.strictEqual(applied.ok, true, applied.error);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).alwaysThinkingEnabled, true);
  }));

// Two "on" runs with a different status line set between them: the second
// run must remember the one in front of it, not the one from the first run,
// or "off" restores something the user already replaced.
test('a status line set between two on runs is what off will restore', () => {
  const launcher = 'C:/x/usage-limits-statusline.js';
  const first = statusline.planOn({ statusLine: { type: 'command', command: 'old-thing' } }, null, { launcher });
  assert.deepStrictEqual(first.state.previous, { type: 'command', command: 'old-thing' });
  // The user then installs something else by hand.
  const second = statusline.planOn({ statusLine: { type: 'command', command: 'new-thing' } }, first.state, { launcher });
  assert.deepStrictEqual(second.state.previous, { type: 'command', command: 'new-thing' });
  // And a plain second "on" over our own launcher keeps the memory.
  const third = statusline.planOn(second.settings, second.state, { launcher });
  assert.deepStrictEqual(third.state.previous, { type: 'command', command: 'new-thing' });
});

test('relay and reading state files are written whole or not at all', () =>
  withConfigDir((dir) => {
    relay.configure({ enabled: true });
    assert.strictEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0, 'no temp file is left behind');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'usage-limits-relay.json'), 'utf8')).config.enabled, true);
  }));

// The session that ended for no reason: the Fable weekly at 89 per cent was
// binding, the line said the budget was nearly gone, and the work stopped -
// with the five-hour window at 46 and every other model untouched. A per-model
// weekly is one model's budget, not the account's, and a switch retires it.
test('a model-scoped wall names the switch that clears it', () => {
  const fable = { key: 'seven_day_scoped:fable', label: 'weekly (Fable)', family: 'fable', percentUsed: 89, stale: false, applies: true };
  const five = { key: 'five_hour', label: '5-hour', family: null, percentUsed: 46, stale: false, applies: true };
  const week = { key: 'seven_day', label: 'weekly', family: null, percentUsed: 77, stale: false, applies: true };
  const opus = { key: 'seven_day_opus', label: 'weekly (Opus)', family: 'opus', percentUsed: 12, stale: false, applies: false };
  const out = usage.escapeRoute([fable, five, week, opus], fable, null);
  assert.strictEqual(out.kind, 'model');
  assert.strictEqual(out.nextLabel, 'weekly');
  assert.strictEqual(out.nextPercent, 77);
  assert.strictEqual(out.suggest, 'opus', 'name the emptiest other model, not just "switch"');
});

test('a lateral move is not an escape, and neither is a guess', () => {
  const fable = { key: 'f', label: 'weekly (Fable)', family: 'fable', percentUsed: 89, stale: false };
  // 89 -> 87 buys nothing.
  assert.strictEqual(usage.escapeRoute([fable, { key: 'w', label: 'weekly', family: null, percentUsed: 87, stale: false }], fable, null), null);
  // With no other readable window there is no evidence a switch helps.
  assert.strictEqual(usage.escapeRoute([fable], fable, null), null);
  assert.strictEqual(usage.escapeRoute([], fable, null), null);
  // A stale window is not evidence either.
  assert.strictEqual(usage.escapeRoute([fable, { key: 'w', label: 'weekly', family: null, percentUsed: 10, stale: true }], fable, null), null);
});

test('a shared window follows the account, so effort is the only lever', () => {
  const five = { key: 'five_hour', label: '5-hour', family: null, percentUsed: 92, stale: false, applies: true };
  const week = { key: 'seven_day', label: 'weekly', family: null, percentUsed: 40, stale: false, applies: true };
  assert.strictEqual(usage.escapeRoute([five, week], five, null), null, 'no cheaper effort measured, so nothing to promise');
  const withEffort = usage.escapeRoute([five, week], five, { effort: 'ultra', cheaper: { effort: 'medium', multiple: 6 } });
  assert.strictEqual(withEffort.kind, 'effort');
  assert.strictEqual(withEffort.to, 'medium');
  assert.strictEqual(withEffort.multiple, 6);
});

test('at the wall with an escape, the instruction is switch and carry on - not stop', () => {
  const brief = require('../skills/usage-limits/scripts/brief.js');
  const binding = { key: 'f', label: 'weekly (Fable)', family: 'fable', percentUsed: 89, stale: false, resetsAt: null };
  const text = brief.briefText({
    binding,
    pressure: 'tight',
    escape: { kind: 'model', frees: 'weekly (Fable)', family: 'fable', nextLabel: 'weekly', nextPercent: 77, suggest: 'opus' },
    sessions: 1,
    critical: [],
  });
  assert.match(text, /must\s+not stop as though you were/);
  assert.match(text, /\/model opus/);
  assert.match(text, /77 per cent/);
  assert.doesNotMatch(text, /nothing further will run/);
});
