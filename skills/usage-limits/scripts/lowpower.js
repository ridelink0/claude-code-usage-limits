#!/usr/bin/env node
'use strict';

// Turns the expensive knobs down and remembers what they were.
//
// effortLevel is the setting behind the /effort picker. It drives how much
// reasoning the model does per turn, and reasoning is billed as output
// tokens, which are the priciest tokens in the request. Dropping xhigh to
// low is the single largest per-turn saving available without changing
// model or scope.
//
//   node scripts/lowpower.js status
//   node scripts/lowpower.js on
//   node scripts/lowpower.js on --effort medium --model sonnet
//   node scripts/lowpower.js off
//
// The saved values live in usage-limits-lowpower.json inside the config
// directory, so "off" puts back exactly what was there, including keys
// that were not set in the first place.

const fs = require('fs');
const os = require('os');
const path = require('path');

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MANAGED_KEYS = ['effortLevel', 'model'];
const DEFAULTS = { effortLevel: 'low' };

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function settingsFile() {
  return path.join(configDir(), 'settings.json');
}

function stateFile() {
  return path.join(configDir(), 'usage-limits-lowpower.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Replace through a temporary file so an interrupted run cannot leave
// settings.json half written.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.usage-limits-tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, file);
}

function parseArgs(argv) {
  const args = { command: null, effort: null, model: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--effort') args.effort = argv[++i];
    else if (arg === '--model') args.model = argv[++i];
    else if (arg.startsWith('--effort=')) args.effort = arg.slice('--effort='.length);
    else if (arg.startsWith('--model=')) args.model = arg.slice('--model='.length);
    else if (!args.command) args.command = arg;
  }
  if (!args.command) args.command = 'status';
  return args;
}

// Work out the new settings without touching disk. Returns the object to
// write, the state to remember, and a readable list of what moved.
function planApply(settings, options, existingState) {
  const current = settings || {};
  const wanted = {};
  const effort = options.effort || DEFAULTS.effortLevel;

  if (EFFORT_LEVELS.indexOf(effort) === -1) {
    throw new Error('unknown effort "' + effort + '", expected one of ' + EFFORT_LEVELS.join(', '));
  }
  wanted.effortLevel = effort;
  if (options.model) wanted.model = options.model;

  // A second "on" must not record the already-lowered values as the
  // originals, or "off" would restore low power forever.
  const saved =
    existingState && existingState.previous ? existingState.previous : capture(current);

  const next = Object.assign({}, current, wanted);
  const changes = [];
  for (const key of Object.keys(wanted)) {
    const before = current[key] === undefined ? '(unset)' : current[key];
    if (String(before) !== String(wanted[key])) {
      changes.push(key + ': ' + before + ' -> ' + wanted[key]);
    }
  }

  return {
    settings: next,
    state: { savedAt: new Date().toISOString(), previous: saved, applied: wanted },
    changes,
  };
}

// Snapshot only the keys this tool is allowed to touch. A key that was not
// present is recorded as null so it can be removed again on restore.
function capture(settings) {
  const previous = {};
  for (const key of MANAGED_KEYS) {
    previous[key] = Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : null;
  }
  return previous;
}

function planRestore(settings, state) {
  if (!state || !state.previous) {
    return { settings: settings || {}, changes: [], restored: false };
  }
  const next = Object.assign({}, settings || {});
  const changes = [];

  for (const key of MANAGED_KEYS) {
    const before = next[key] === undefined ? '(unset)' : next[key];
    const target = state.previous[key];
    if (target === null || target === undefined) {
      if (Object.prototype.hasOwnProperty.call(next, key)) {
        delete next[key];
        changes.push(key + ': ' + before + ' -> (unset)');
      }
    } else if (String(before) !== String(target)) {
      next[key] = target;
      changes.push(key + ': ' + before + ' -> ' + target);
    }
  }

  return { settings: next, changes, restored: true };
}

function describe(settings, state) {
  const lines = [];
  const current = settings || {};
  lines.push('Low power    ' + (state ? 'on since ' + state.savedAt : 'off'));
  lines.push('effortLevel  ' + (current.effortLevel || '(unset, defaults to xhigh)'));
  lines.push('model        ' + (current.model || '(unset)'));
  if (state && state.previous) {
    const previous = state.previous;
    const parts = MANAGED_KEYS.map(
      (key) => key + '=' + (previous[key] === null ? '(unset)' : previous[key])
    );
    lines.push('will restore ' + parts.join('  '));
  }
  return lines.join('\n');
}

function main(argv) {
  const args = parseArgs(argv);
  const file = settingsFile();
  const settings = readJson(file) || {};
  const state = readJson(stateFile());

  if (args.command === 'status') {
    process.stdout.write(describe(settings, state) + '\n');
    return 0;
  }

  if (args.command === 'on') {
    const plan = planApply(settings, args, state);
    if (!plan.changes.length && state) {
      process.stdout.write('Already in low power. Nothing to change.\n');
      return 0;
    }
    if (args.dryRun) {
      process.stdout.write('Would change:\n  ' + (plan.changes.join('\n  ') || '(nothing)') + '\n');
      return 0;
    }
    if (!state && fs.existsSync(file)) fs.copyFileSync(file, file + '.usage-limits-backup');
    writeJson(file, plan.settings);
    writeJson(stateFile(), plan.state);
    process.stdout.write(
      'Low power on.\n  ' + (plan.changes.join('\n  ') || '(nothing to change)') + '\n' +
        'Applies to new sessions. For the session you are in, run /effort ' +
        plan.state.applied.effortLevel + '.\n'
    );
    return 0;
  }

  if (args.command === 'off') {
    if (!state) {
      process.stdout.write('Low power is not on. Nothing to restore.\n');
      return 0;
    }
    const plan = planRestore(settings, state);
    if (args.dryRun) {
      process.stdout.write('Would restore:\n  ' + (plan.changes.join('\n  ') || '(nothing)') + '\n');
      return 0;
    }
    writeJson(file, plan.settings);
    fs.unlinkSync(stateFile());
    process.stdout.write(
      'Low power off.\n  ' + (plan.changes.join('\n  ') || '(nothing to change)') + '\n'
    );
    return 0;
  }

  process.stderr.write('usage: lowpower.js [status|on|off] [--effort level] [--model name] [--dry-run]\n');
  return 1;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write('lowpower: ' + (err && err.message ? err.message : String(err)) + '\n');
    process.exitCode = 1;
  }
}

module.exports = {
  EFFORT_LEVELS,
  MANAGED_KEYS,
  parseArgs,
  capture,
  planApply,
  planRestore,
  describe,
};
