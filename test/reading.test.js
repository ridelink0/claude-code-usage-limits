'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const reading = require('../skills/usage-limits/scripts/reading.js');
const usage = require('../skills/usage-limits/scripts/usage.js');

const MINUTE = 60 * 1000;
const NOW = Date.parse('2026-09-08T20:40:00.000Z');

function withConfigDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-limits-reading-'));
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

const BINDING = {
  key: 'five_hour',
  percentUsed: 73,
  pointsSinceSnapshot: 60,
  adjusted: true,
  resetsAt: NOW + 30 * MINUTE,
  turnsLeft: 55,
};

test('a correction is kept and handed back while it is fresh', () =>
  withConfigDir(() => {
    assert.strictEqual(reading.correctedFor('five_hour', NOW, NOW - MINUTE), null);
    assert.strictEqual(reading.record(BINDING, NOW), true);
    const found = reading.correctedFor('five_hour', NOW, NOW - MINUTE);
    assert.strictEqual(found.percentUsed, 73);
    assert.strictEqual(found.pointsSinceSnapshot, 60);
    assert.strictEqual(found.adjusted, true);
  }));

test('a correction older than the snapshot it would correct is refused', () =>
  withConfigDir(() => {
    reading.record(BINDING, NOW);
    // The spend it measured is already inside a newer snapshot; applying it
    // again would count the same turns twice.
    assert.strictEqual(reading.correctedFor('five_hour', NOW, NOW + MINUTE), null);
  }));

test('a correction goes stale, because turns happen after it', () =>
  withConfigDir(() => {
    reading.record(BINDING, NOW);
    assert.ok(reading.correctedFor('five_hour', NOW + 7 * MINUTE, NOW - MINUTE));
    assert.strictEqual(reading.correctedFor('five_hour', NOW + 9 * MINUTE, NOW - MINUTE), null);
  }));

test('a window that has reset describes a budget that no longer exists', () =>
  withConfigDir(() => {
    reading.record(BINDING, NOW);
    assert.strictEqual(reading.correctedFor('five_hour', NOW + 31 * MINUTE, NOW - MINUTE), null);
  }));

test('only a figure the report itself trusts is worth putting in front of a reader', () =>
  withConfigDir(() => {
    assert.strictEqual(reading.record({ key: 'a', percentUsed: 50, correctionUnreliable: true }, NOW), false);
    assert.strictEqual(reading.record({ key: 'b', percentUsed: 50, estimated: true }, NOW), false);
    assert.strictEqual(reading.record({ key: 'c', percentUsed: 50, stale: true }, NOW), false);
    assert.strictEqual(reading.record({ key: 'd', percentUsed: null }, NOW), false);
    assert.strictEqual(reading.record(null, NOW), false);
    assert.deepStrictEqual(reading.read(), {});
  }));

test('the file cannot grow: expired windows are dropped on the next write', () =>
  withConfigDir(() => {
    reading.record({ key: 'old', percentUsed: 10, resetsAt: NOW - MINUTE }, NOW - 2 * MINUTE);
    reading.record(BINDING, NOW);
    assert.deepStrictEqual(Object.keys(reading.read()), ['five_hour']);
  }));

test('a corrupt reading file is empty, not fatal', () =>
  withConfigDir((dir) => {
    fs.writeFileSync(path.join(dir, 'usage-limits-reading.json'), 'not json');
    assert.deepStrictEqual(reading.read(), {});
    assert.strictEqual(reading.correctedFor('five_hour', NOW, null), null);
  }));

// The bug this whole file exists for: the status line showed the raw snapshot
// while the report, given a scan, said sixty points more. The flattering number
// was the one on screen.
test('the status line prefers the corrected figure over the raw snapshot', () =>
  withConfigDir(() => {
    const collected = {
      now: NOW,
      snapshotFetchedAt: NOW - 20 * MINUTE,
      settings: {},
      windowSpecs: [{ key: 'five_hour', label: '5-hour' }],
      utilization: {
        five_hour: { utilization: 13, resets_at: new Date(NOW + 30 * MINUTE).toISOString() },
      },
    };
    assert.match(usage.statusLine(collected), /5h 13%/);
    reading.record(BINDING, NOW);
    assert.match(usage.statusLine(collected), /5h 73%/);
  }));

test('a correction taken before the snapshot never reaches the status line', () =>
  withConfigDir(() => {
    reading.record(BINDING, NOW - 30 * MINUTE);
    const collected = {
      now: NOW,
      snapshotFetchedAt: NOW - MINUTE,
      settings: {},
      windowSpecs: [{ key: 'five_hour', label: '5-hour' }],
      utilization: {
        five_hour: { utilization: 13, resets_at: new Date(NOW + 30 * MINUTE).toISOString() },
      },
    };
    assert.match(usage.statusLine(collected), /5h 13%/);
  }));
