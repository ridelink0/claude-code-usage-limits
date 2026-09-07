#!/usr/bin/env node
'use strict';

// The status line: one line of bars under the Claude Code prompt, in Claude's
// own colours, from Claude's own numbers.
//
// Claude Code runs this on every change and hands it JSON on stdin. Two things
// in that JSON are worth more than anything on disk: `rate_limits`, which
// Claude Code fills from the rate-limit headers on its own API responses, and
// `model`, which is the one certain answer to which model is running. Both
// are recorded in a small feed file, one slot per session, so the side panel
// (which never sees this JSON) can draw from them too.
//
// It must be fast and it must never fail: no transcript scan, no network, one
// read of a few small files, and any error prints nothing rather than a stack
// trace where the bars should be.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const usage = require('./usage.js');
const host = require('./host.js');
const bars = require('./bars.js');
const view = require('./view.js');
const activity = require('./activity.js');
const statusline = require('./statusline.js');
const live = require('./live.js');

const KEEP_SESSIONS = 8;
// Two updates this close together mean Claude is mid-turn.
const WORKING_GAP_MS = 4000;
// A previous status line gets this long, then we go on without it.
const CHAIN_TIMEOUT_MS = 2000;
const STDIN_WAIT_MS = 500;
// How long a display keeps describing the session it chose before it will
// follow a different one.
const STICKY_QUIET_MS = 5 * 60 * 1000;
// Claude Code draws the status line inside its own margins, a few columns
// narrower than COLUMNS, and clips what does not fit.
const STATUSLINE_MARGIN = 4;

const SHORT = { five_hour: 'session', seven_day: 'week', spend_limit: 'spend' };
// When even that is too wide.
const SHORTER = { five_hour: '5h', seven_day: 'wk', spend_limit: 'spend' };
// Codex names its own windows "5h limit" and "Weekly limit"; on one line they
// are the same two abbreviations Claude's get.
const SHORT_CODEX = { five_hour: '5h', seven_day: 'week' };
const SHORTER_CODEX = { five_hour: '5h', seven_day: 'wk' };

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function feedFile() {
  return path.join(configDir(), 'usage-limits-feed.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function readFeed() {
  const parsed = readJson(feedFile());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const slots = {};
  for (const key of Object.keys(parsed)) {
    const value = parsed[key];
    if (value && typeof value === 'object' && Number.isFinite(value.at)) slots[key] = value;
  }
  return slots;
}

function writeFeed(all) {
  return live.writeAtomic(feedFile(), JSON.stringify(all));
}

// Two updates a few seconds apart mean a turn in progress, unless the status
// line is on a timer that fires that often anyway, in which case the gap says
// nothing and only the hooks' marks do.
function gapMeansWorking(settings) {
  const line = settings && settings.statusLine;
  const every = line && Number.isFinite(line.refreshInterval) ? line.refreshInterval * 1000 : null;
  return !(every !== null && every <= WORKING_GAP_MS);
}

// This session's own mark, from the hooks. Another window working must not
// spin this one's line.
function ownState(marks, sessionId, now) {
  const mine = sessionId && marks ? marks[sessionId] : null;
  if (!mine || !Number.isFinite(mine.at) || now - mine.at > activity.STALE_MS) {
    return { working: false, ultracode: false, ultrathink: false };
  }
  return { working: mine.state === 'working', ultracode: Boolean(mine.ultracode), ultrathink: Boolean(mine.ultrathink) };
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// What one status line update tells us, folded onto what the last one said.
// A run without rate_limits (they only appear after the first API response)
// keeps the previous ones rather than forgetting them.
function slotFrom(input, previous, now) {
  const prior = previous && typeof previous === 'object' ? previous : {};
  const model = input.model && typeof input.model === 'object' ? input.model : {};
  const hasHeaders = Boolean(input.rate_limits && typeof input.rate_limits === 'object');
  return {
    at: now,
    prevAt: Number.isFinite(prior.at) ? prior.at : null,
    sessionId: input.session_id || null,
    model: typeof model.id === 'string' ? model.id : prior.model || null,
    modelName: typeof model.display_name === 'string' ? model.display_name : prior.modelName || null,
    effort: input.effort && typeof input.effort.level === 'string' ? input.effort.level : prior.effort || null,
    rateLimits: hasHeaders ? input.rate_limits : prior.rateLimits || null,
    headersAt: hasHeaders ? now : Number.isFinite(prior.headersAt) ? prior.headersAt : null,
    context: input.context_window ? number(input.context_window.used_percentage) : number(prior.context),
    cost: input.cost ? number(input.cost.total_cost_usd) : number(prior.cost),
    cwd: typeof input.cwd === 'string' ? input.cwd : prior.cwd || null,
    version: typeof input.version === 'string' ? input.version : prior.version || null,
    fastMode: input.fast_mode === true,
  };
}

function trim(all, keep) {
  const ordered = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
  const kept = {};
  for (const key of ordered.slice(0, keep || KEEP_SESSIONS)) kept[key] = all[key];
  return kept;
}

function record(all, input, now) {
  if (!input || typeof input !== 'object' || !input.session_id) return all || {};
  const next = Object.assign({}, all || {});
  next[input.session_id] = slotFrom(input, next[input.session_id], now);
  return trim(next);
}

function newest(all) {
  let best = null;
  for (const key of Object.keys(all || {})) {
    const slot = all[key];
    if (slot && Number.isFinite(slot.at) && (!best || slot.at > best.at)) best = slot;
  }
  return best;
}

// Which session a display with no session of its own should describe.
//
// "Whichever moved last" reads badly with two windows open: two Claudes on the
// same model at different efforts made the line flip between ultracode and
// xhigh every few seconds, which is noise, not news. So a display sticks to
// the session it is already describing until that one has been quiet for a
// while, and only then moves to the newest.
function stickySlot(all, previousId, now, quietMs) {
  const slots = all || {};
  const quiet = Number.isFinite(quietMs) ? quietMs : STICKY_QUIET_MS;
  const at = Number.isFinite(now) ? now : Date.now();
  const held = previousId ? slots[previousId] : null;
  if (held && Number.isFinite(held.at) && at - held.at <= quiet) return held;
  return newest(slots);
}

function isWorking(slot, now) {
  if (!slot || !Number.isFinite(slot.at) || !Number.isFinite(slot.prevAt)) return false;
  return now - slot.at < WORKING_GAP_MS && slot.at - slot.prevAt < WORKING_GAP_MS;
}

function shortLabel(row, shorter) {
  const table = shorter ? SHORTER : SHORT;
  if (table[row.key]) return table[row.key];
  return row.family || row.key;
}

// The line. Widest form first, then narrower bars, then no model, then no
// bars, so it always fits whatever COLUMNS says.
function line(built, options) {
  const opts = options || {};
  const columns = Number.isFinite(opts.columns) && opts.columns > 0 ? opts.columns : 80;
  const mode = opts.mode || 'none';
  const tick = Number.isFinite(opts.tick) ? opts.tick : 0;
  const reduced = Boolean(opts.reduced);
  const ascii = Boolean(opts.ascii);

  if (!built || !built.rows || !built.rows.length) return '';
  if (built.state === 'none') return bars.dim('usage: no reading yet', mode);

  const glyph = built.working
    ? bars.paint(bars.spinner(tick, { ascii, reduced }), bars.THEME.claude, mode)
    : bars.paint(ascii ? '*' : '✻', bars.THEME.claude, mode);
  const effortName = built.effort;
  const effort = effortName ? bars.effortColour(effortName) : null;
  const effortText = !effortName
    ? ''
    : effort.rainbow
      ? bars.rainbow(effortName, tick, { mode, reduced })
      : effort.shimmer && built.working
        ? bars.shimmer(effortName, tick, effort.rgb, effort.shimmer, { mode, reduced })
        : bars.paint(effortName, effort.rgb, mode);
  // The word, in the rainbow, the way Claude Code paints it in the prompt.
  const thinking = built.ultrathink ? ' ' + bars.dim('·', mode) + ' ' + bars.rainbow('ultrathink', tick, { mode, reduced }) : '';
  const head =
    glyph + ' ' + built.modelLabel + (effortText ? ' ' + bars.dim('·', mode) + ' ' + effortText : '') + thinking;

  const segment = (row, width, shorter) => {
    const label = shortLabel(row, shorter);
    const percent = row.level === 'fill' ? row.percentText : bars.paint(row.percentText, bars.levelColour(row.level), mode);
    if (!width || row.percent === null) return label + ' ' + percent;
    return label + ' ' + bars.bar(row.percent, width, { mode, level: row.level, ascii, tick, reduced, style: built.style }) + ' ' + percent;
  };

  const attempts = [
    { width: 10, head: true },
    { width: 8, head: true },
    { width: 6, head: true },
    { width: 6, head: false },
    { width: 4, head: false },
    { width: 4, head: false, shorter: true },
    { width: 0, head: false },
    { width: 0, head: false, shorter: true },
    { width: 0, head: false, shorter: true, gap: ' ' },
  ];

  // The Codex tail.
  //
  // It always says "left", and if that does not fit it is not shown at all.
  // Codex reports what remains and Claude reports what is spent, so a bare
  // "85%" sitting beside a bare "15%" would be read as the same kind of
  // number when they run in opposite directions - which is precisely the
  // confusion this row exists to remove.
  const codexTail = (attempt) => {
    if (!built.codex || !Array.isArray(built.codex.rows) || !built.codex.rows.length) return [];
    const parts = [];
    for (const row of built.codex.rows) {
      if (row.percentLeft === null) continue;
      const label = (attempt.shorter ? SHORTER_CODEX : SHORT_CODEX)[row.key] || row.key;
      const text = Math.floor(row.percentLeft) + '% left';
      const painted = row.level === 'fill' ? text : bars.paint(text, bars.levelColour(row.level), mode);
      const drawn = attempt.width
        ? bars.bar(row.percentLeft, attempt.width, { mode, level: row.level, ascii, tick, reduced }) + ' '
        : '';
      parts.push(label + ' ' + drawn + painted);
    }
    if (!parts.length) return [];
    return [bars.paint(bars.mark('codex', { ascii }), bars.THEME.codex, mode) + ' ' + parts.join('  ')];
  };
  // Another Claude spending the same budget is worth a word on the line.
  const others =
    Number.isFinite(built.othersWorking) && built.othersWorking > 0
      ? bars.paint('+' + built.othersWorking + ' working', bars.THEME.claude, mode)
      : '';
  const compose = (attempt, withCodex) => {
    const parts = built.rows.map((row) => segment(row, attempt.width, attempt.shorter));
    if (others) parts.push(others);
    if (attempt.head) parts.unshift(head);
    const tail = withCodex ? codexTail(attempt) : [];
    return parts.concat(tail).join(attempt.gap || '  ');
  };

  // Narrower bars are a smaller loss than dropping the other agent's meter
  // entirely, so every width is tried WITH Codex before any is tried without.
  let text = '';
  for (const attempt of attempts) {
    text = compose(attempt, true);
    if (bars.visibleWidth(text) <= columns) return text;
  }
  for (const attempt of attempts) {
    text = compose(attempt, false);
    if (bars.visibleWidth(text) <= columns) return text;
  }
  return text;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let raw = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(raw);
    };
    const timer = setTimeout(done, STDIN_WAIT_MS);
    if (timer.unref) timer.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

// The status line that was there before ours, run with the same stdin, so
// installing this one loses nothing.
function runPrevious(command, raw, env, budgetMs) {
  try {
    const result = spawnSync(command, {
      shell: true,
      input: raw,
      encoding: 'utf8',
      timeout: Math.max(300, Number.isFinite(budgetMs) ? budgetMs : CHAIN_TIMEOUT_MS),
      env: env || process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0) return '';
    return String(result.stdout || '').replace(/\s+$/, '');
  } catch (err) {
    return '';
  }
}

function settingsFor(dir) {
  return readJson(path.join(dir, 'settings.json')) || {};
}

function clockFor(settings, env) {
  const e = env || process.env;
  if (e.USAGE_LIMITS_CLOCK === '24h') return '24h';
  if (e.USAGE_LIMITS_CLOCK === '12h') return '12h';
  const format = settings && typeof settings.timeFormat === 'string' ? settings.timeFormat : '';
  return format.indexOf('24') === 0 ? '24h' : '12h';
}

function motionOff(settings, env) {
  const e = env || process.env;
  const flag = String(e.USAGE_LIMITS_MOTION || '').toLowerCase();
  if (flag === 'off' || flag === '0' || flag === 'false') return true;
  return Boolean(settings && settings.prefersReducedMotion === true);
}

// Written and flushed before the process is allowed to end: stdout is a pipe
// here, and a pipe write can still be in flight when process.exit runs.
function out(text) {
  return new Promise((resolve) => {
    process.stdout.write(text, () => resolve());
  });
}

async function main(argv) {
  const env = process.env;
  const started = Date.now();
  const now = started;
  let chained = '';
  try {
    usage.setHost(host.detect(argv || [], env));
    const raw = await readStdin();
    let input = null;
    try {
      input = raw.trim() ? JSON.parse(raw) : null;
    } catch (err) {
      input = null;
    }
    if (input && typeof input !== 'object') input = null;

    const state = statusline.readState();
    if (state && state.chain && state.previous && state.previous.type === 'command' && state.previous.command) {
      // Whatever the stdin wait used comes out of the previous line's time.
      chained = runPrevious(state.previous.command, raw, env, CHAIN_TIMEOUT_MS - (Date.now() - started));
    }

    let all = readFeed();
    if (input && input.session_id) {
      all = record(all, input, now);
      writeFeed(all);
    }

    const off = String(env.USAGE_LIMITS_STATUSLINE || '').toLowerCase();
    if (off === 'off' || off === '0' || off === 'false') {
      if (chained) await out(chained + '\n');
      return 0;
    }
    if (usage.isCodex()) {
      if (chained) await out(chained + '\n');
      return 0;
    }

    const slot = input && input.session_id ? all[input.session_id] : newest(all);
    const collected = usage.collect(now);
    const settings = settingsFor(configDir());
    const marks = activity.read();
    const mine = input && input.session_id ? input.session_id : null;
    // This session's own state; only with no session id at all does the
    // machine-wide picture stand in for it.
    const own = mine ? ownState(marks, mine, now) : activity.summarise(marks, now);
    // The other sessions working right now, so the line can say so.
    const othersWorking = activity
      .combine({ marks, feed: all }, now, activity.STALE_MS)
      .filter((row) => row.state === 'working' && row.sessionId !== mine).length;
    const built = view.build({
      now,
      utilization: collected.utilization,
      fetchedAtMs: collected.snapshotFetchedAt,
      source: collected.snapshotSource,
      headers: slot ? slot.rateLimits : null,
      headersAt: slot ? slot.headersAt : null,
      model: slot ? slot.model : null,
      modelName: slot ? slot.modelName : null,
      // Claude Code hands this line the effort outright, so the slot is
      // already current and nothing else need be read. It is only when the
      // slot has none - the very first update of a session, or a build that
      // does not send it - that the transcript is worth a look.
      effort:
        slot && slot.effort
          ? slot.effort
          : view.pickEffort(
              null,
              usage.liveEffort(mine || (slot && slot.sessionId) || null),
              collected.settings ? collected.settings.effortLevel : null
            ),
      working: own.working || (gapMeansWorking(settings) && isWorking(slot, now)),
      ultrathink: Boolean(own.ultrathink),
      ultracode: Boolean(own.ultracode) || settings.ultracode === true,
      settingsModel: collected.settings ? collected.settings.model : null,
      env,
    });
    // The other agent's meter, from its rollouts on disk. Required lazily and
    // guarded by a single stat, so a machine without Codex pays nothing, and
    // wrapped because a status line must never fail over an optional row.
    // USAGE_LIMITS_CODEX_ROW=off turns it off.
    built.codex = null;
    if (String(env.USAGE_LIMITS_CODEX_ROW || '').toLowerCase() !== 'off' && host.codexHasSessions()) {
      try {
        const codex = require('./codex.js');
        const other = codex.collect(now);
        const block = view.buildCodex({
          now,
          utilization: other.utilization,
          fetchedAtMs: other.snapshotFetchedAt,
          windowSpecs: other.windowSpecs,
          plan: other.plan,
          windowless: other.windowless,
        });
        if (block.present) built.codex = block;
      } catch (err) {
        // No Codex row, and the Claude line is unaffected.
      }
    }

    const text = line(built, {
      columns: Math.max(20, (Number(env.COLUMNS) || 80) - STATUSLINE_MARGIN),
      // Claude Code captures the output, so stdout is never a TTY here, and
      // ANSI is supported all the same.
      mode: bars.colourMode(env, true),
      tick: Math.floor(now / bars.TICK_MS),
      reduced: motionOff(settings, env),
      ascii: String(env.USAGE_LIMITS_ASCII || '') === '1',
      clock: clockFor(settings, env),
    });
    await out((chained ? chained + '\n' : '') + text + '\n');
    return 0;
  } catch (err) {
    if (chained) await out(chained + '\n');
    return 0;
  }
}

module.exports = {
  KEEP_SESSIONS,
  WORKING_GAP_MS,
  CHAIN_TIMEOUT_MS,
  feedFile,
  readFeed,
  writeFeed,
  slotFrom,
  record,
  newest,
  isWorking,
  stickySlot,
  STICKY_QUIET_MS,
  gapMeansWorking,
  ownState,
  line,
  runPrevious,
  clockFor,
  motionOff,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code || 0;
    },
    () => {
      process.exitCode = 0;
    }
  );
}
