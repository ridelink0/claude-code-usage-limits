#!/usr/bin/env node
'use strict';

// The mid-turn ping.
//
// brief.js runs when a prompt is submitted, and that is the only budget figure
// the agent gets for the whole turn. A turn that runs for half an hour through
// hundreds of tool calls is working from a number taken before any of it
// happened, and it has no way to notice the budget draining underneath it.
//
// That is not hypothetical. On 2026-08-30 three sessions were told the 5-hour
// window had about 190 turns of headroom and were all rejected nine minutes
// later. Nothing in between ever told them otherwise, because nothing ran in
// between.
//
// So this runs after tool calls and puts a fresh line in front of the agent
// every couple of minutes. It has to be cheap, because it is called constantly:
// the common case is reading one small file, comparing a timestamp, and
// exiting without doing anything else.

const fs = require('fs');
const path = require('path');

const usage = require('./usage.js');
const brief = require('./brief.js');
const host = require('./host.js');

const SECOND = 1000;
const DEFAULT_INTERVAL_SECONDS = 120;

// One slot per session, same shape and same trimming as the brief's cache.
const KEEP_SESSIONS = 8;

function stateFile() {
  const dir = usage.isCodex()
    ? require('./codex.js').homeDir()
    : process.env.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude');
  return path.join(dir, 'usage-limits-pulse.json');
}

function intervalMs() {
  const configured = Number(process.env.USAGE_LIMITS_PULSE_SECONDS);
  const seconds = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_INTERVAL_SECONDS;
  return seconds * SECOND;
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

function writeState(all) {
  try {
    const file = stateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all), 'utf8');
  } catch (err) {
    // Losing the throttle means one extra scan, which is survivable. Failing
    // the tool call it runs after is not.
  }
}

function trim(all, sessionId, at) {
  const next = Object.assign({}, all);
  next[sessionId || '_'] = { at };
  const ordered = Object.keys(next).sort((a, b) => (next[b].at || 0) - (next[a].at || 0));
  const kept = {};
  for (const key of ordered.slice(0, KEEP_SESSIONS)) kept[key] = next[key];
  return kept;
}

function due(all, sessionId, now, every) {
  const entry = all ? all[sessionId || '_'] : null;
  if (!entry || !Number.isFinite(entry.at)) return true;
  return now - entry.at >= every;
}

// Deliberately shorter than the prompt-submit brief. That one sets up the whole
// turn; this one interrupts work already in progress, so it earns its place only
// by being one line and only by carrying something that changes what happens
// next.
function pulseText(parts) {
  const bits = [];
  if (parts.percentUsed !== null && parts.percentUsed !== undefined) {
    bits.push(parts.label + ' now ' + (parts.approximate ? 'about ' : '') + parts.percentUsed + '%');
  }
  if (Number.isFinite(parts.turnsLeft)) bits.push('about ' + parts.turnsLeft + ' turns left');
  if (parts.runsOutIn) bits.push(parts.runsOutIn + ' at this pace');
  if (parts.sessions > 1) bits.push(parts.sessions + ' sessions sharing it');
  if (!bits.length) return '';

  const head = '[usage-limits] ' + bits.join(', ') + '.';
  if (parts.pressure === 'gone') {
    return head + ' The budget is gone. Stop adding work, save what exists and write the handoff.';
  }
  if (parts.pressure === 'tight') {
    // Mid-turn, so this has to change how the work is carried out without
    // changing what the work is. Keep going; just keep it landable.
    return (
      head + ' Keep going with the whole job, but make a cutoff cheap: land the ' +
      'valuable part first, save at clean boundaries, and keep a note of what is ' +
      'done and what is next.'
    );
  }
  return head + ' Still room; carry on.';
}

async function run(now, hookInput) {
  if (String(process.env.USAGE_LIMITS_PULSE || '').toLowerCase() === 'off') return '';
  usage.setHost(host.detect(process.argv.slice(2), process.env));

  const sessionId = hookInput && hookInput.session_id ? hookInput.session_id : null;
  const all = readState();
  const every = intervalMs();
  // The cheap path, and the one taken almost every time.
  if (!due(all, sessionId, now, every)) return '';

  // Claimed before the scan rather than after, so a slow scan cannot let a
  // second tool call start another one.
  writeState(trim(all, sessionId, now));

  const data = await usage.report(now, { sessionId });
  const binding = data.binding;
  if (!binding) return '';

  const sessions = data.sessions || [];
  const share = usage.shareOf(sessions, sessionId);
  const turnsLeft = Number.isFinite(binding.turnsLeft)
    ? sessions.length > 1
      ? Math.max(1, Math.round(binding.turnsLeft * share))
      : binding.turnsLeft
    : null;

  const config = brief.settings();
  const runwayMs = brief.RUNWAY_MENTION_MS;
  const pressure = brief.pressure(binding, now, config, turnsLeft);

  // Quiet when there is nothing to act on. A line every two minutes saying the
  // budget is fine is noise that costs the budget it is reporting on.
  if (pressure === 'roomy' && String(process.env.USAGE_LIMITS_PULSE || '').toLowerCase() !== 'always') {
    return '';
  }

  return pulseText({
    label: binding.label,
    percentUsed: binding.percentUsed,
    approximate: Boolean(binding.estimated || binding.adjusted),
    turnsLeft,
    runsOutIn:
      Number.isFinite(binding.headroomMs) && binding.headroomMs <= runwayMs
        ? usage.formatDuration(binding.headroomMs)
        : null,
    sessions: sessions.length,
    pressure,
  });
}

// PostToolUse does not take plain stdout as context the way UserPromptSubmit
// does, so the line is returned in the documented envelope instead.
function envelope(text) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: text,
    },
  });
}

function readHookInput() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let raw = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try {
        resolve(raw ? JSON.parse(raw) : null);
      } catch (err) {
        resolve(null);
      }
    };
    const timer = setTimeout(done, 500);
    if (timer.unref) timer.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

if (require.main === module) {
  readHookInput()
    .then((input) => run(Date.now(), input))
    .then(
      (text) => {
        if (text) process.stdout.write(envelope(text) + '\n');
        process.exit(0);
      },
      () => {
        // A hook that throws must never disturb the tool call it runs after.
        process.exit(0);
      }
    );
}

module.exports = {
  DEFAULT_INTERVAL_SECONDS,
  KEEP_SESSIONS,
  stateFile,
  intervalMs,
  readState,
  writeState,
  trim,
  due,
  pulseText,
  envelope,
  run,
};
