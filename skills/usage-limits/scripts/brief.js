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
  // Few enough turns that the count itself is the warning.
  fewTurns: 20,
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

// A cache written before slots were keyed by session keeps its fields at the
// top level, so upgrading would carry "at", "turnsLeft", "session" and
// "sessionId" forward as if each were a session, crowding out real slots and
// quietly undoing the per-session caching. Anything that is not a slot goes.
function keepSlots(parsed) {
  if (!parsed || typeof parsed !== 'object') return {};
  const slots = {};
  for (const key of Object.keys(parsed)) {
    const value = parsed[key];
    if (value && typeof value === 'object' && Number.isFinite(value.at)) {
      slots[key] = value;
    }
  }
  return slots;
}

function readCache() {
  try {
    return keepSlots(JSON.parse(fs.readFileSync(cacheFile(), 'utf8')));
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
    fewTurns: number(env.USAGE_LIMITS_FEW_TURNS, DEFAULTS.fewTurns),
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
// Not whether to speak, which is always, but how hard to lean on it.
function pressure(window, now, config, turnsLeft) {
  if (!window || window.percentUsed === null || window.stale) return 'unknown';
  if (window.verdict === 'exhausted' || window.percentUsed >= 100) return 'gone';
  if (window.verdict === 'runs-out') return 'tight';

  // A rebuilt figure only counts this machine, so it reads low. React to it
  // sooner than to a figure the API actually reported.
  const near = window.estimated ? Math.min(config.near, 70) : config.near;
  if (window.percentUsed >= near) return 'tight';

  // Turns are the number the work is planned in, so a short count is tight
  // whatever the percentage says.
  if (Number.isFinite(turnsLeft) && turnsLeft <= config.fewTurns) {
    return 'tight';
  }

  // Pace only means something for a window with a real start. A rebuilt one
  // is anchored at now minus its span, so it is always "fully elapsed" and
  // the comparison can never fire.
  if (!window.estimated) {
    const lead = aheadOfPace(window, now);
    if (window.percentUsed >= config.floor && lead !== null && lead >= config.ahead) {
      return 'tight';
    }
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

// Kept as a re-export so there is exactly one implementation.
const sessionSpend = usage.sessionSpend;

function describeWindow(window) {
  if (!window) return null;
  if (window.stale) return window.label + ' rolling over';
  const about = window.estimated || window.adjusted ? ' about ' : ' ';
  return window.label + about + window.percentUsed + '%';
}

// Everything except the window that will actually stop the work.
function summariseOthers(windows, bindingKey) {
  return windows
    .filter((window) => window.percentUsed !== null && window.key !== bindingKey)
    .map(describeWindow)
    .join(', ');
}

function briefText(parts) {
  // The turns and the reset time belong to one specific window. Listing every
  // window and then the numbers invites reading them against the wrong one, so
  // the binding window is named and its figures are attached to it.
  const bound = [];
  const described = describeWindow(parts.binding);
  if (described) bound.push(described + (parts.binding.stale ? '' : ' used'));
  if (Number.isFinite(parts.turnsLeft)) {
    // Another session spending the same budget means fewer of those turns are
    // yours, so say both numbers rather than the flattering one.
    const shared =
      parts.sessions > 1 && Number.isFinite(parts.yourTurnsLeft)
        ? ' (' + parts.sessions + ' sessions active, roughly ' + parts.yourTurnsLeft +
          ' of them yours)'
        : '';
    bound.push('about ' + parts.turnsLeft + ' turns of headroom' + shared);
  }
  if (parts.resetsIn) bound.push('resets in ' + parts.resetsIn);

  const sentences = [];
  sentences.push(
    bound.length
      ? '[usage-limits] binding window is ' + bound.join(', ') + '.'
      : '[usage-limits] no usable window reading.'
  );
  if (parts.rebuilt) {
    sentences.push(
      'That figure was rebuilt from local history because the ' +
        'snapshot is ' + parts.snapshotAge + ' old; run /usage to refresh it.'
    );
  } else if (parts.pointsSinceSnapshot) {
    sentences.push(
      'That includes about ' + parts.pointsSinceSnapshot + ' points spent since the ' +
        'snapshot was taken ' + parts.snapshotAge + ' ago, which it does not know about yet.'
    );
  } else if (parts.staleWindows) {
    // Do not quietly carry on with a window we know is wrong and could not
    // rebuild. Say it is unknown and point at the one command that fixes it.
    sentences.push(
      'A window is past its reset and could not be rebuilt from local history, ' +
        'so its reading is unknown rather than current; the snapshot is ' +
        parts.snapshotAge + ' old, so run /usage before trusting the rest.'
    );
  }
  if (parts.othersSummary) sentences.push('Other windows: ' + parts.othersSummary + '.');
  if (parts.session) {
    sentences.push(
      'This session: ' + parts.session.turns + ' turns, ' +
        usage.formatUSD(parts.session.cost) + '.'
    );
  }

  const instruction =
    parts.pressure === 'tight' || parts.pressure === 'gone'
      ? 'Open your reply with one line on where this leaves the budget, then say ' +
        'what you will do now and what you will leave for after the reset. ' +
        'Do not start work that clearly will not finish. If several additions ' +
        'arrive while you are working, say once that sending them together ' +
        'costs less, then carry on; never say it about a correction or a stop.'
      : 'Open your reply with one short line stating this and confirming the ' +
        'request fits, then get on with the work. Keep it to a single line.';

  // The mistake this guards against: quoting the roomiest window and pinning
  // the binding window figures to it.
  const care =
    ' Quote the binding window, not whichever one has the most left. The turns ' +
    'and reset time above belong to the binding window alone; do not read them ' +
    'against another window percentage.';

  return sentences.join(' ') + '\n' + instruction + care;
}

async function run(now, hookInput) {
  if (String(process.env.USAGE_LIMITS_BRIEF || '').toLowerCase() === 'off') return '';

  const config = settings();
  const base = usage.collect(now);
  if (!base.utilization) return '';

  const sessionId = hookInput && hookInput.session_id ? hookInput.session_id : null;
  const all = readCache();
  let view = pickCached(all, sessionId, now, config.cacheSeconds * SECOND);

  // Everything shown has to come from one pass. Deriving the turns from a
  // full scan and the binding window from somewhere cheaper is how the two
  // end up describing different windows.
  if (!view || !view.binding) {
    // One call, shared with the report. Building the view twice is how the
    // snapshot correction reached the report and never reached the hook.
    const data = await usage.report(now, { sessionId });
    const binding = data.binding;
    view = {
      at: now,
      turnsLeft: binding && Number.isFinite(binding.turnsLeft) ? binding.turnsLeft : null,
      session: data.session,
      othersSummary: summariseOthers(data.windows, binding && binding.key),
      sessions: data.sessions,
      staleWindows: data.staleWindows,
      snapshotAge: usage.formatDuration(data.snapshotAgeMs),
      binding: binding
        ? {
            key: binding.key,
            label: binding.label,
            percentUsed: binding.percentUsed,
            stale: binding.stale,
            estimated: binding.estimated,
            adjusted: binding.adjusted,
            pointsSinceSnapshot: binding.pointsSinceSnapshot,
            correctionUnreliable: binding.correctionUnreliable,
            resetsAt: binding.resetsAt,
            verdict: binding.verdict,
            windowStart: binding.windowStart,
            spanMs: binding.spanMs,
          }
        : null,
    };
    writeCache(mergeCache(all, sessionId, view, KEEP_SESSIONS));
  }

  const binding = view.binding;
  const sessions = view.sessions || [];
  const share = usage.shareOf(sessions, sessionId);
  return briefText({
    sessions: sessions.length,
    yourTurnsLeft: Number.isFinite(view.turnsLeft)
      ? Math.max(1, Math.round(view.turnsLeft * share))
      : null,
    binding,
    othersSummary: view.othersSummary,
    turnsLeft: view.turnsLeft,
    resetsIn:
      binding && !binding.stale && Number.isFinite(binding.resetsAt)
        ? usage.formatDuration(binding.resetsAt - now)
        : null,
    session: view.session,
    rebuilt: Boolean(binding && binding.estimated),
    staleWindows: view.staleWindows || 0,
    pointsSinceSnapshot: (binding && binding.pointsSinceSnapshot) || 0,
    snapshotAge: view.snapshotAge,
    pressure: pressure(binding, now, config, view.turnsLeft),
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
  describeWindow,
  summariseOthers,
  briefText,
  settings,
  keepSlots,
  pickCached,
  mergeCache,
  KEEP_SESSIONS,
  run,
  cacheFile,
};
