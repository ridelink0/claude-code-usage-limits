'use strict';

// Whether Claude is working right now, as told by the hooks that already run.
//
// The panel wants to animate while Claude works and sit still while it waits,
// and the hooks are the cheapest honest signal there is: the prompt hook
// fires when a turn starts, the tool hook fires after every tool call, and the
// Stop hook fires when the reply is done. Each one writes a few bytes here.
//
// One slot per session, because two windows can be in different states at
// once and a Stop in one must not make the other look idle.

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEEP_SESSIONS = 8;
// A session that has said nothing for this long is not working, whatever its
// last word was: a crash never sends Stop.
const STALE_MS = 15 * 60 * 1000;

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function activityFile() {
  return path.join(configDir(), 'usage-limits-activity.json');
}

function read() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(activityFile(), 'utf8'));
  } catch (err) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const slots = {};
  for (const key of Object.keys(parsed)) {
    const value = parsed[key];
    if (value && typeof value === 'object' && Number.isFinite(value.at)) slots[key] = value;
  }
  return slots;
}

function trim(all, keep) {
  const ordered = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
  const kept = {};
  for (const key of ordered.slice(0, keep || KEEP_SESSIONS)) kept[key] = all[key];
  return kept;
}

// Record a state for a session. Never throws: this runs inside hooks, and a
// hook that fails over a status file would be far worse than a panel that
// animates a little late.
function mark(state, sessionId, extra, now) {
  try {
    const all = read();
    const previous = all[sessionId || '_'] || {};
    const entry = {
      at: Number.isFinite(now) ? now : Date.now(),
      state: state === 'working' ? 'working' : 'idle',
      // The keyword is per prompt, so a Stop keeps what the prompt said and the
      // next prompt says again.
      ultracode: extra && typeof extra.ultracode === 'boolean' ? extra.ultracode : Boolean(previous.ultracode),
    };
    if (extra && extra.model) entry.model = String(extra.model);
    else if (previous.model) entry.model = previous.model;
    all[sessionId || '_'] = entry;
    const file = activityFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.' + process.pid + '.usage-limits-tmp';
    fs.writeFileSync(temp, JSON.stringify(trim(all)), 'utf8');
    fs.renameSync(temp, file);
    return true;
  } catch (err) {
    return false;
  }
}

// The picture across every session: is anything working, and is the most
// recently active working session in ultracode.
function summarise(all, now) {
  const at = Number.isFinite(now) ? now : Date.now();
  let working = null;
  let newest = null;
  for (const key of Object.keys(all || {})) {
    const entry = all[key];
    if (!entry || !Number.isFinite(entry.at)) continue;
    if (at - entry.at > STALE_MS) continue;
    if (!newest || entry.at > newest.at) newest = entry;
    if (entry.state === 'working' && (!working || entry.at > working.at)) working = entry;
  }
  return {
    working: Boolean(working),
    ultracode: Boolean(working ? working.ultracode : newest && newest.ultracode),
    model: (working && working.model) || (newest && newest.model) || null,
    at: newest ? newest.at : null,
  };
}

module.exports = {
  KEEP_SESSIONS,
  STALE_MS,
  activityFile,
  read,
  mark,
  trim,
  summarise,
};
