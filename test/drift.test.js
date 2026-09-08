'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const drift = require('../skills/usage-limits/scripts/drift.js');
const reading = require('../skills/usage-limits/scripts/reading.js');

const MINUTE = 60 * 1000;
const NOW = Date.parse('2026-09-08T20:40:00.000Z');

function withConfigDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-limits-drift-'));
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

test('reading.record measures drift against whatever was there before it', () =>
  withConfigDir(() => {
    const first = {
      key: 'five_hour',
      percentUsed: 13,
      turnsLeft: 190,
      resetsAt: NOW + 3 * 60 * MINUTE,
      adjusted: true,
    };
    const second = Object.assign({}, first, { percentUsed: 73, turnsLeft: 40 });

    assert.strictEqual(reading.record(first, NOW), true);
    assert.strictEqual(drift.summary().sample, 0, 'nothing to compare against yet');

    assert.strictEqual(reading.record(second, NOW + 20 * MINUTE), true);
    const stats = drift.summary();
    assert.strictEqual(stats.sample, 1);
    assert.strictEqual(stats.medianAbsPercent, 60);
    assert.strictEqual(stats.worstAbsPercent, 60);
    assert.strictEqual(stats.medianAbsTurns, 150);

    const raw = drift.read();
    assert.strictEqual(raw.entries[0].predictedPercentUsed, 13);
    assert.strictEqual(raw.entries[0].actualPercentUsed, 73);
    assert.strictEqual(raw.entries[0].ageMs, 20 * MINUTE);
  }));

test('a window reset between two readings is a fresh start, not drift', () =>
  withConfigDir(() => {
    const before = {
      key: 'five_hour',
      percentUsed: 90,
      turnsLeft: 5,
      resetsAt: NOW + 5 * MINUTE,
      adjusted: true,
    };
    const after = {
      key: 'five_hour',
      percentUsed: 2,
      turnsLeft: 300,
      resetsAt: NOW + 5 * 60 * MINUTE,
      adjusted: true,
    };
    reading.record(before, NOW);
    reading.record(after, NOW + 10 * MINUTE);
    assert.strictEqual(drift.summary().sample, 0);
  }));

test('the ledger is bounded and never grows without limit', () =>
  withConfigDir(() => {
    for (let i = 0; i < drift.MAX_ENTRIES + 25; i++) {
      const at = NOW + i * MINUTE;
      reading.record(
        { key: 'five_hour', percentUsed: i % 100, turnsLeft: 100, resetsAt: at + 10 * 60 * MINUTE, adjusted: true },
        at
      );
    }
    const raw = drift.read();
    assert.ok(raw.entries.length <= drift.MAX_ENTRIES);
  }));

test('drift.describe reads plainly with nothing on record', () =>
  withConfigDir(() => {
    assert.match(drift.describe(), /no corrections measured/);
  }));

test('drift.describe reports the median and worst once there is something to say', () =>
  withConfigDir(() => {
    reading.record({ key: 'five_hour', percentUsed: 10, turnsLeft: 100, resetsAt: NOW + 60 * MINUTE, adjusted: true }, NOW);
    reading.record({ key: 'five_hour', percentUsed: 40, turnsLeft: 60, resetsAt: NOW + 60 * MINUTE, adjusted: true }, NOW + MINUTE);
    const text = drift.describe();
    assert.match(text, /median 30 points off, worst 30 points off/);
  }));

test('recording never throws on a malformed pair', () =>
  withConfigDir(() => {
    assert.strictEqual(drift.record(null, {}, {}, NOW), false);
    assert.strictEqual(drift.record('k', { percentUsed: 1, at: NOW }, { percentUsed: NaN, at: NOW }, NOW), false);
    assert.strictEqual(drift.record('k', {}, { percentUsed: 1, at: NOW }, NOW), false);
  }));
