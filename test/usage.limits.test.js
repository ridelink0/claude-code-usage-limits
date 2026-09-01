'use strict';

// The snapshot carries a `limits` array beside the per-window buckets: one
// entry per limit the account enforces, with a severity, whether it is the
// active one, and for the per-model weeklies which model it scopes to. This
// is the account's own description of its limits, and it was being ignored.

const test = require('node:test');
const assert = require('node:assert');

const usage = require('../skills/usage-limits/scripts/usage.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-01T10:00:00.000Z');

function iso(at) {
  return new Date(at).toISOString();
}

// The shape captured from ~/.claude.json on 2026-09-01, trimmed to what matters.
function snapshot(over) {
  return Object.assign(
    {
      five_hour: { utilization: 28, resets_at: iso(NOW + 2 * HOUR), limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
      seven_day: { utilization: 11, resets_at: iso(NOW + 5 * DAY), limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
      seven_day_opus: null,
      seven_day_sonnet: null,
      nimbus_quill: { utilization: 0, resets_at: null },
      extra_usage: { is_enabled: false },
      limits: [
        { kind: 'session', group: 'session', percent: 28, severity: 'normal', resets_at: iso(NOW + 2 * HOUR), scope: null, is_active: true },
        { kind: 'weekly_all', group: 'weekly', percent: 11, severity: 'normal', resets_at: iso(NOW + 5 * DAY), scope: null, is_active: false },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 17,
          severity: 'normal',
          resets_at: iso(NOW + 5 * DAY),
          scope: { model: { id: '', display_name: 'Fable' }, surface: null },
          is_active: false,
        },
      ],
      spend: { enabled: false },
      member_dashboard_available: false,
    },
    over || {}
  );
}

function event(model, cost, at) {
  return { at: at || NOW - HOUR, cost, tokens: 100, model, sidechain: false, sessionId: 's' };
}

function mixed() {
  const list = [];
  for (let i = 0; i < 6; i += 1) list.push(event('claude-fable-5', 1));
  for (let i = 0; i < 4; i += 1) list.push(event('claude-opus-5', 0.5));
  return list;
}

test('limitWindows reads every limit the account lists, scoped ones included', () => {
  const rows = usage.limitWindows(snapshot());
  assert.deepStrictEqual(rows.map((row) => row.key), ['five_hour', 'seven_day', 'seven_day_scoped:fable']);

  const session = rows[0];
  assert.strictEqual(session.percent, 28);
  assert.strictEqual(session.isActive, true);
  assert.strictEqual(session.severity, 'normal');
  assert.strictEqual(session.resetsAt, NOW + 2 * HOUR);

  const scoped = rows[2];
  assert.strictEqual(scoped.label, 'weekly (Fable)');
  assert.strictEqual(scoped.family, 'fable');
  assert.strictEqual(scoped.spanMs, 7 * DAY);
  assert.strictEqual(scoped.percent, 17);
  assert.strictEqual(scoped.isActive, false);
});

test('limitWindows copes with a snapshot that has no such list', () => {
  assert.deepStrictEqual(usage.limitWindows({}), []);
  assert.deepStrictEqual(usage.limitWindows({ limits: 'nope' }), []);
  assert.deepStrictEqual(usage.limitWindows(null), []);
  assert.deepStrictEqual(usage.limitWindows({ limits: [{ kind: 'session' }, null, { kind: 'weekly_scoped', percent: 3 }] }), []);
});

test('buildWindows adds a per-model weekly window priced from that model alone', () => {
  const windows = usage.buildWindows(snapshot(), mixed(), NOW, NOW - MINUTE, {}, null, new Map());
  const scoped = windows.find((w) => w.key === 'seven_day_scoped:fable');
  assert.ok(scoped, 'the Fable weekly is a window in its own right');
  assert.strictEqual(scoped.label, 'weekly (Fable)');
  assert.strictEqual(scoped.percentUsed, 17);
  assert.strictEqual(scoped.spanMs, 7 * DAY);
  assert.strictEqual(scoped.scoped, true);
  assert.strictEqual(scoped.family, 'fable');
  assert.strictEqual(scoped.turns, 6, 'only the Fable calls');
  assert.ok(Math.abs(scoped.spentUSD - 6) < 1e-9, 'and only their money');
  assert.ok(Math.abs(scoped.usdPerPercent - 6 / 17) < 1e-9);

  const five = windows.find((w) => w.key === 'five_hour');
  assert.ok(Math.abs(five.spentUSD - 8) < 1e-9, 'the shared window still sees everything');
  assert.strictEqual(five.isActive, true);
  assert.strictEqual(five.severity, 'normal');
  const week = windows.find((w) => w.key === 'seven_day');
  assert.strictEqual(week.isActive, false);
});

test('buildWindows takes a window from the limits list when its bucket is missing', () => {
  const only = { limits: snapshot().limits, extra_usage: { is_enabled: false } };
  const windows = usage.buildWindows(only, mixed(), NOW, NOW - MINUTE, {}, null, new Map());
  const five = windows.find((w) => w.key === 'five_hour');
  assert.strictEqual(five.percentUsed, 28);
  assert.strictEqual(five.resetsAt, NOW + 2 * HOUR);
  assert.strictEqual(five.verdict === 'unknown', false);
});

test('buildWindows prices a metered window from its dollar limit, not from calibration', () => {
  const metered = snapshot({
    five_hour: { utilization: 28, resets_at: iso(NOW + 2 * HOUR), limit_dollars: 100, used_dollars: 28, remaining_dollars: 72 },
  });
  const windows = usage.buildWindows(metered, mixed(), NOW, NOW - MINUTE, {}, null, new Map());
  const five = windows.find((w) => w.key === 'five_hour');
  assert.strictEqual(five.metered, true);
  assert.ok(Math.abs(five.usdPerPercent - 1) < 1e-9, 'a hundred dollars is a hundred points');
  assert.ok(Math.abs(five.remainingUSD - 72) < 1e-9);
});

test('bindingWindow trusts the limit the account marks active when its own measure is a tie', () => {
  const five = { key: 'five_hour', label: '5-hour', percentUsed: 30, stale: false, spanMs: 5 * HOUR, headroomMs: null, isActive: false };
  const week = { key: 'seven_day', label: 'weekly', percentUsed: 40, stale: false, spanMs: 7 * DAY, headroomMs: null, isActive: true };
  assert.strictEqual(usage.bindingWindow([five, week]).key, 'seven_day');
  // Without the flag the shorter window wins the tie, as before.
  assert.strictEqual(
    usage.bindingWindow([Object.assign({}, five, { isActive: false }), Object.assign({}, week, { isActive: false })]).key,
    'five_hour'
  );
  // But a measured pace still beats the flag: whichever runs out first binds.
  assert.strictEqual(
    usage.bindingWindow([Object.assign({}, five, { headroomMs: HOUR }), Object.assign({}, week, { headroomMs: 3 * HOUR })]).key,
    'five_hour'
  );
});

test('render marks a window the account calls critical', () => {
  const five = {
    key: 'five_hour', label: '5-hour', percentUsed: 96, stale: false, msToReset: HOUR, remainingUSD: 1,
    turnsLeft: 2, severity: 'critical', verdict: 'burning', headroomMs: HOUR, isActive: true,
  };
  const text = usage.render({
    host: 'claude', money: true, plan: 'Claude Max 5x', snapshotAgeMs: MINUTE, now: NOW,
    settings: { model: 'default', effortLevel: 'xhigh' }, credits: null,
    windows: [five], binding: five, otherLimits: [], models: [], projects: [], sessions: [],
    recent: { turns: 0 }, measuredTurns: 0,
  });
  const row = text.split('\n').find((line) => line.indexOf('5-hour') === 2);
  assert.ok(row, 'the window has a row');
  assert.match(row, /<- binding, critical$/);
});
