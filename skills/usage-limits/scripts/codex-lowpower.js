'use strict';
// Reversible edits to Codex's top-level defaults. Never changes a running turn.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const KEYS = ['model', 'model_reasoning_effort'];
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function scan(text) {
  // Do not pretend a line editor is a full TOML parser.
  if (text.includes('"""') || text.includes("'''")) throw new Error('Multiline TOML requires manual editing; config was not changed.');
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const found = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\uFEFF/, '');
    if (/^\s*\[/.test(line)) break;
    for (const key of KEYS) {
      const re = new RegExp('^\\s*(?:' + key + '|"' + key + '"|\\x27' + key + '\\x27)\\s*=');
      if (!re.test(line)) continue;
      if (Object.hasOwn(found, key)) throw new Error('Duplicate top-level ' + key + '; config was not changed.');
      if (!/=\s*(?:"(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?(?:\r?\n)?$/.test(line))
        throw new Error('Unsupported value for ' + key + '; config was not changed.');
      found[key] = { index: i, line: lines[i] };
    }
  }
  return { lines, found };
}
function rewrite(text, values) {
  const { lines, found } = scan(text);
  const prepend = [];
  for (const [key, line] of Object.entries(values)) {
    if (!KEYS.includes(key)) throw new Error('Invalid managed setting');
    if (found[key]) lines[found[key].index] = line || '';
    else if (line) prepend.push(line);
  }
  return prepend.join('') + lines.join('');
}
function read(file, fallback) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function atomic(file, text) {
  const temp = file + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function checkState(state) {
  if (!state) return;
  if (state.version !== 1 || !state.previous || !state.applied) throw new Error('Unrecognized restore state; config was not changed.');
  const keys = Object.keys(state.previous);
  if (!keys.length || keys.some(k => !KEYS.includes(k)) || JSON.stringify(keys.sort()) !== JSON.stringify(Object.keys(state.applied).sort()))
    throw new Error('Invalid restore state; config was not changed.');
  for (const values of [state.previous, state.applied]) {
    for (const [key, line] of Object.entries(values)) {
      if (line === null) continue;
      if (typeof line !== 'string') throw new Error('Invalid restore line');
      const parsed = scan(line);
      if (parsed.lines.length !== 1 || !parsed.found[key]) throw new Error('Invalid restore line');
    }
  }
}
function plan(text, options, state) {
  checkState(state);
  const { found } = scan(text);
  const lineOf = key => found[key] ? found[key].line : null;
  if (state) for (const [key, line] of Object.entries(state.applied)) {
    if (lineOf(key) !== line) throw new Error(key + ' changed outside lowpower; review config and restore state before continuing.');
  }
  if (options.command === 'off') return { text: state ? rewrite(text, state.previous) : text, state: null };
  const effort = options.effort || 'low';
  if (!EFFORTS.includes(effort)) throw new Error('Unknown Codex effort: ' + effort);
  if (options.model !== null && options.model !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/.test(options.model))
    throw new Error('Invalid Codex model identifier');
  const wanted = { model_reasoning_effort: effort };
  if (options.model) wanted.model = options.model;
  const previous = { ...(state && state.previous) };
  const applied = { ...(state && state.applied) };
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  for (const [key, value] of Object.entries(wanted)) {
    if (!Object.hasOwn(previous, key)) previous[key] = lineOf(key);
    applied[key] = key + ' = ' + JSON.stringify(value) + newline;
  }
  return { text: rewrite(text, applied), state: { version: 1, previous, applied } };
}
function main(args) {
  if (!['status', 'on', 'off'].includes(args.command)) throw new Error('Expected status, on or off');
  const dir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const file = path.join(dir, 'config.toml');
  const stateFile = path.join(dir, 'usage-limits-lowpower.json');
  const notice = 'Codex defaults only: new sessions. Active tasks, profiles and command-line overrides keep their own settings.';
  // A lock serializes our writers. Other editors are detected before commit.
  let lock;
  if (args.command !== 'status' && !args.dryRun) {
    fs.mkdirSync(dir, { recursive: true });
    lock = fs.openSync(stateFile + '.lock', 'wx');
  }
  try {
    const text = read(file, '');
    const rawState = read(stateFile, null);
    const state = rawState ? JSON.parse(rawState) : null;
    checkState(state);
    if (args.command === 'status') {
      const { found } = scan(text);
      console.log('Codex low power: ' + (state ? 'on' : 'off'));
      for (const key of KEYS) console.log(found[key] ? found[key].line.trim() : key + ' = (unset)');
      console.log(notice);
      return 0;
    }
    const result = plan(text, args, state);
    if (args.dryRun) {
      console.log('Dry run; no files changed.\n' + notice);
      const { found } = scan(result.text);
      for (const key of KEYS) console.log(found[key] ? found[key].line.trim() : key + ' = (unset)');
      return 0;
    }
    if (read(file, '') !== text || read(stateFile, null) !== rawState) throw new Error('Settings changed concurrently; retry.');
    // Save recovery information before changing defaults; roll it back on error.
    if (result.state) atomic(stateFile, JSON.stringify(result.state, null, 2) + '\n');
    try {
      if (result.text !== text) {
        if (!state && fs.existsSync(file)) fs.copyFileSync(file, file + '.usage-limits-backup');
        atomic(file, result.text);
      }
    } catch (e) {
      if (rawState !== null) atomic(stateFile, rawState);
      else if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
      throw e;
    }
    if (!result.state && fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    console.log('Codex low power ' + args.command + '.\n' + notice);
    return 0;
  } finally {
    if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(stateFile + '.lock'); }
  }
}
module.exports = { scan, rewrite, plan, main, EFFORTS };
