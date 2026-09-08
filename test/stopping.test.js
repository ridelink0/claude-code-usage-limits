'use strict';

// The stopping decision, checked exhaustively rather than by spot-reading.
//
// Gev's complaint about this plugin was specific: under Codex it "doesn't stop
// at a good stopping point", and it "just makes a plan". Both are failures of
// one decision - what the budget line tells the agent to DO - and that decision
// now has five inputs: how full the binding window is, whether that window is
// scoped to a model or shared by the account, which host is reading, whether a
// relay is armed, and whether a cheaper lever exists.
//
// Five inputs is too many to spot-check. Walking the whole product found a real
// bug the first time it was tried (a spent shared window telling the agent it
// was "not out of budget" because a cheaper effort existed), so it is a matrix
// here rather than a handful of cases, and the invariants are stated as rules
// the whole matrix must satisfy.

const test = require('node:test');
const assert = require('node:assert');

const brief = require('../skills/usage-limits/scripts/brief.js');
const usage = require('../skills/usage-limits/scripts/usage.js');

const NOW = Date.parse('2026-09-08T23:00:00.000Z');
const CONFIG = { near: 90, floor: 40, ahead: 15, cacheSeconds: 60, fewTurns: 10, runwayMinutes: 10, refreshSeconds: 180 };

const other = { key: 'seven_day', label: 'weekly', family: null, percentUsed: 30, stale: false, applies: true };

function windowAt(percent, family) {
  return {
    key: family ? 'seven_day_scoped:' + family : 'five_hour',
    label: family ? 'weekly (' + family + ')' : '5-hour',
    family: family || null,
    percentUsed: percent,
    percentLeft: 100 - percent,
    stale: false,
    applies: true,
    resetsAt: NOW + 90 * 60 * 1000,
    turnsLeft: Math.max(0, Math.round((100 - percent) * 1.2)),
    headroomMs: Math.max(0, (100 - percent) * 60 * 1000),
    usdPerPercent: 0.5,
  };
}

// Every combination that can reach a reader.
const PERCENTS = [10, 50, 70, 80, 88, 90, 92, 95, 97, 100];
const FAMILIES = [null, 'fable'];
const HOSTS = ['claude', 'codex'];
const EFFORTS = [null, { effort: 'high', cheaper: { effort: 'medium', multiple: 4 } }];
const RELAYS = [null, { armed: { wakeAt: NOW + 3e6, mode: 'notify', continuation: true, warning: null }, config: { graceMinutes: 5 } }];

function* matrix() {
  for (const percent of PERCENTS) {
    for (const family of FAMILIES) {
      for (const host of HOSTS) {
        for (const effortNote of EFFORTS) {
          for (const relay of RELAYS) {
            const binding = windowAt(percent, family);
            const escape = usage.escapeRoute([binding, other], binding, effortNote, host);
            const pressure = brief.pressure(binding, NOW, CONFIG, binding.turnsLeft);
            const text = brief.briefText({
              binding, pressure, escape, relay, host, sessions: 1, critical: [],
              turnsLeft: binding.turnsLeft, effortWarning: effortNote,
            });
            yield { percent, family, host, effortNote, relay, binding, escape, pressure, text,
              where: `${percent}% ${family || 'shared'} host=${host} effort=${effortNote ? 'cheaper' : 'none'} relay=${relay ? 'armed' : 'off'}` };
          }
        }
      }
    }
  }
}

const says = (c, re) => re.test(c.text);
const STOPS = /nothing further will run/;
const CARRY_ON = /must not stop as though you were/;

test('it never tells a spent shared window that it still has budget', () => {
  for (const c of matrix()) {
    if (c.pressure !== 'gone' || c.family) continue;
    assert.ok(!says(c, CARRY_ON), 'a spent shared window claimed budget it does not have: ' + c.where);
  }
});

test('a spent model-scoped window is offered the switch, never a plain stop', () => {
  for (const c of matrix()) {
    if (c.pressure !== 'gone' || !c.family) continue;
    // The escape only exists when another window is genuinely emptier, which
    // is true throughout this matrix (the other window sits at 30).
    assert.ok(says(c, CARRY_ON), 'a model-scoped window is one model\'s budget, not the account\'s: ' + c.where);
    assert.ok(!says(c, STOPS), 'it must not say nothing further will run: ' + c.where);
  }
});

test('it never contradicts itself in one line', () => {
  for (const c of matrix()) {
    assert.ok(!(says(c, STOPS) && says(c, CARRY_ON)), 'both stop and carry on: ' + c.where);
  }
});

// "It just makes a plan." Below the wall, writing a handoff instead of working
// is the failure; the instruction there must be to get on with the work.
test('below the wall it never asks for a handoff instead of the work', () => {
  for (const c of matrix()) {
    if (c.percent >= 90) continue;
    assert.strictEqual(c.pressure, 'roomy', 'the wall is 90 and nothing below it escalates: ' + c.where);
    assert.ok(says(c, /get on with the work/), 'below the wall the instruction is the work: ' + c.where);
    assert.ok(!says(c, /write the handoff/), 'no handoff is asked for below the wall: ' + c.where);
  }
});

// The commands must exist in the host being spoken to. /model and /effort do
// not exist in Codex; naming them there is telling it to do nothing.
test('it never names a Claude Code command to Codex', () => {
  for (const c of matrix()) {
    if (c.host !== 'codex') continue;
    assert.ok(!says(c, /\/model\b/), 'named /model to Codex: ' + c.where);
    assert.ok(!says(c, /\/effort\b/), 'named /effort to Codex: ' + c.where);
  }
});

test('under Claude Code the lever is a command that can actually be typed', () => {
  for (const c of matrix()) {
    if (c.host !== 'claude' || !c.escape) continue;
    if (c.binding.percentUsed < 50) continue;
    assert.ok(says(c, /\/model |\/effort /), 'an escape with no usable command: ' + c.where);
  }
});

// A relay changes what being cut off costs, so at the wall it must change the
// instruction from "stop" to "keep working and write the continuation".
test('an armed relay never leaves a stop instruction standing alone', () => {
  for (const c of matrix()) {
    if (!c.relay || c.pressure === 'roomy') continue;
    assert.ok(says(c, /relay/i), 'the relay is armed and unmentioned: ' + c.where);
    if (says(c, STOPS)) {
      assert.ok(says(c, /relay note|acted on when the window reopens/i),
        'told to stop with a relay armed and no word on the continuation: ' + c.where);
    }
  }
});

test('no reachable combination produces an empty or malformed instruction', () => {
  let seen = 0;
  for (const c of matrix()) {
    seen += 1;
    assert.ok(c.text && c.text.length > 80, 'empty instruction: ' + c.where);
    assert.ok(!/undefined|NaN|null|\[object/.test(c.text), 'a value leaked into the line: ' + c.where + '\n' + c.text);
  }
  assert.strictEqual(seen, PERCENTS.length * FAMILIES.length * HOSTS.length * EFFORTS.length * RELAYS.length);
  assert.strictEqual(seen, 160);
});
