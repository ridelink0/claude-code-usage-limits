#!/usr/bin/env node
'use strict';

// The hook entry point. Runs before each prompt is handled and puts one line
// into Claude's context saying where the budget stands, what this session has
// cost so far, and to open the reply with it.
//
// It runs on every prompt, so two things matter more than features: it has to
// be one line, and it has to be fast. The expensive half is cached for a
// minute, and the numbers that change every turn are the cheap ones.

const fs = require('fs');
const os = require('os');
const path = require('path');

const usage = require('./usage.js');

const SECOND = 1000;
const DAY = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  // Close enough to the wall that the wording should change.
  near: 80,
  // Below this, pace is not worth worrying about.
  floor: 40,
  // Points of budget spent beyond the share of the window that has elapsed.
  ahead: 15,
  // How long the measured part stays good for. Prompts often arrive in
  // bursts, and a transcript scan per prompt would be wasteful.
  cacheSeconds: 60,
};

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function cacheFile() {
  return path.join(configDir(), 'usage-limits-brief.json');
}

// One slot per session. A single shared slot meant that alternating between
// two Claude Code windows invalidated the cache on every prompt, so neither
// ever got a hit and both paid for a full scan each time.
const KEEP_SESSIONS = 5;

function readCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function pickCached(all, sessionId, now, ttlMs) {
  const entry = all ? all[sessionId || '_'] : null;
  if (!entry || !Number.isFinite(entry.at)) return null;
  return now - entry.at < ttlMs ? entry : null;
}

// Keep the newest few so a machine with many sessions does not grow the file
// without bound.
function mergeCache(all, sessionId, entry, keep) {
  const next = Object.assign({}, all || {});
  next[sessionId || '_'] = entry;
  const ordered = Object.keys(next).sort((a, b) => (next[b].at || 0) - (next[a].at || 0));
  const trimmed = {};
  for (const key of ordered.slice(0, keep || KEEP_SESSIONS)) trimmed[key] = next[key];
  return trimmed;
}

function writeCache(all) {
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify(all), 'utf8');
  } catch (err) {
    // A cache miss costs a scan. A crash costs the prompt. Prefer the scan.
  }
}

function settings() {
  const env = process.env;
  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    near: number(env.USAGE_LIMITS_NEAR, DEFAULTS.near),
    floor: number(env.USAGE_LIMITS_FLOOR, DEFAULTS.floor),
    ahead: number(env.USAGE_LIMITS_AHEAD, DEFAULTS.ahead),
    cacheSeconds: number(env.USAGE_LIMITS_CACHE, DEFAULTS.cacheSeconds),
  };
}

// How far ahead of the clock the spending is. A weekly window two days in
// should be near 29 percent spent; 60 percent means it will not last.
function aheadOfPace(window, now) {
  if (!window || !window.spanMs || !Number.isFinite(window.windowStart)) return null;
  if (window.percentUsed === null) return null;
  const elapsed = ((now - window.windowStart) / window.spanMs) * 100;
  return window.percentUsed - Math.min(100, Math.max(0, elapsed));
}

// Not whether to speak, which is always, but how hard to lean on it.
function pressure(window, now, config) {
  if (!window || window.percentUsed === null || window.stale) return 'unknown';
  if (window.verdict === 'exhausted') return 'gone';
  if (window.verdict === 'runs-out') return 'tight';
  if (window.percentUsed >= config.near) return 'tight';

  const lead = aheadOfPace(window, now);
  if (window.percentUsed >= config.floor && lead !== null && lead >= config.ahead) {
    return 'tight';
  }
  return 'roomy';
}

// The hook is handed JSON on stdin. The session id in it is what lets this
// report what the current session has cost rather than the whole window.
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

    // A hook must never hang the prompt waiting for input that is not coming.
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

function sessionSpend(events, sessionId) {
  if (!sessionId) return null;
  let cost = 0;
  let turns = 0;
  for (const event of events) {
    if (event.sessionId !== sessionId) continue;
    cost += event.cost;
    turns += 1;
  }
  return turns ? { turns, cost } : null;
}

function summarise(windows) {
  return windows
    .filter((window) => window.percentUsed !== null)
    .map((window) =>
      window.stale
        ? window.label + ' rolling over'
        : window.label + ' ' + window.percentUsed + '%'
    )
    .join(', ');
}

function briefText(parts) {
  const facts = [];
  if (parts.windowSummary) facts.push(parts.windowSummary);
  if (Number.isFinite(parts.turnsLeft)) {
    facts.push('about ' + parts.turnsLeft + ' turns of headroom');
  }
  if (parts.resetsIn) facts.push('resets in ' + parts.resetsIn);
  if (parts.session) {
    facts.push(
      'this session ' + parts.session.turns + ' turns, ' +
        usage.formatUSD(parts.session.cost)
    );
  }

  const head = '[usage-limits] ' + facts.join(', ') + '.';

  const instruction =
    parts.pressure === 'tight' || parts.pressure === 'gone'
      ? 'Open your reply with one line on where this leaves the budget, then say ' +
        'what you will do now and what you will leave for after the reset. ' +
        'Do not start work that clearly will not finish.'
      : 'Open your reply with one short line stating this and confirming the ' +
        'request fits, then get on with the work. Keep it to a single line.';

  return head + '\n' + instruction;
}

async function run(now, hookInput) {
  if (String(process.env.USAGE_LIMITS_BRIEF || '').toLowerCase() === 'off') return '';

  const config = settings();
  const base = usage.collect(now);
  if (!base.utilization) return '';

  const sessionId = hookInput && hookInput.session_id ? hookInput.session_id : null;

  // The percentages are cheap: one small file, no transcripts.
  const cheap = usage.buildWindows(base.utilization, [], now);
  if (!cheap.length) return '';

  const all = readCache();
  const cached = pickCached(all, sessionId, now, config.cacheSeconds * SECOND);

  let turnsLeft = cached ? cached.turnsLeft : null;
  let session = cached ? cached.session : null;
  let windows = cheap;

  if (!cached) {
    const events = await usage.readEvents(now - 8 * DAY);
    windows = usage.buildWindows(base.utilization, events, now);
    const binding = usage.bindingWindow(windows);
    turnsLeft = binding && Number.isFinite(binding.turnsLeft) ? binding.turnsLeft : null;
    session = sessionSpend(events, sessionId);
    writeCache(mergeCache(all, sessionId, { at: now, turnsLeft, session }, KEEP_SESSIONS));
  }

  const binding = usage.bindingWindow(windows) || windows[0];

  return briefText({
    windowSummary: summarise(windows),
    turnsLeft,
    resetsIn:
      binding && !binding.stale && binding.msToReset !== null
        ? usage.formatDuration(binding.msToReset)
        : null,
    session,
    pressure: pressure(binding, now, config),
  });
}

if (require.main === module) {
  readHookInput()
    .then((input) => run(Date.now(), input))
    .then(
      (text) => {
        if (text) process.stdout.write(text + '\n');
        process.exit(0);
      },
      () => {
        // A hook that throws must not disrupt the prompt it runs before.
        process.exit(0);
      }
    );
}

module.exports = {
  DEFAULTS,
  aheadOfPace,
  pressure,
  sessionSpend,
  summarise,
  briefText,
  settings,
  pickCached,
  mergeCache,
  KEEP_SESSIONS,
  run,
  cacheFile,
};
