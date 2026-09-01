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
const host = require('./host.js');
const tally = require('./tally.js');

const SECOND = 1000;
const DAY = 24 * 60 * 60 * 1000;

// There is one threshold that changes behaviour, and it is the wall.
//
// Everything below it is reported and nothing below it is discouraged. That is
// the whole design, and it is a correction: an earlier version escalated from
// 40 per cent used, or whenever the runway dropped under three quarters of an
// hour, and so spent its time telling a session with a third of its budget left
// to stop starting things. Budget left unspent at the reset is not saved, it is
// destroyed, so winding down early is not caution. It is waste with a
// respectable name.
//
// Above the wall the instruction is not "hurry" either. It is: write the plan
// for what is left, save the work, and stop.
const DEFAULTS = {
  // The wall. Below this, work normally at full quality.
  near: 90,
  // Kept for `aheadOfPace`, which is still reported. It no longer decides
  // anything: spending a week's budget faster than the clock is information,
  // not a reason to slow down.
  floor: 40,
  ahead: 15,
  // How long the measured part stays good for. Prompts often arrive in
  // bursts, and a transcript scan per prompt would be wasteful.
  cacheSeconds: 60,
  // Few enough turns that the count itself is the wall.
  fewTurns: 10,
  // Minutes of runway left at the current pace, below which there is no longer
  // time to land the work and write the handoff. Not "too little time to start
  // something ambitious" - that judgement belongs to whoever is doing the work,
  // and it needs the number, not an instruction.
  runwayMinutes: 10,
};

// The runway is worth saying long before it is worth acting on, because it is
// the figure that stops a turn count from flattering. Two hundred turns sounds
// like plenty and can be twenty minutes when three sessions are spending.
const RUNWAY_MENTION_MS = 2 * 60 * 60 * 1000;

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// One cache per host. The slots double as the count of open sessions, so mixing
// two agents' sessions into one file would have each of them reporting the
// other's windows as competition for a budget they do not share.
function cacheFile() {
  const dir = usage.isCodex() ? require('./codex.js').homeDir() : configDir();
  return path.join(dir, 'usage-limits-brief.json');
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

// How many sessions are actually open right now.
//
// The count derived from spend is the accurate one, but it is always late: a
// session only appears in it once it has finished a turn and written the cost
// to its transcript. Three windows that all submit a prompt at the same moment
// each see a count of one, which is exactly when knowing about the other two
// would have mattered most.
//
// This cache is the earlier signal. Every session writes its own slot when the
// hook runs, so a slot touched in the last few minutes is a session that was
// being used, whether or not its spend has landed yet. It costs nothing: the
// file has already been read.
const LIVE_WINDOW_MS = 15 * 60 * 1000;

// Counts the other sessions, not this one. This session's own slot may not be
// written yet on its first prompt, so counting slots directly would report two
// when three windows are open.
function liveSessions(all, now, windowMs, exceptId) {
  const within = Number.isFinite(windowMs) ? windowMs : LIVE_WINDOW_MS;
  const mine = exceptId || '_';
  let count = 0;
  for (const key of Object.keys(all || {})) {
    if (key === mine) continue;
    const entry = all[key];
    if (!entry || !Number.isFinite(entry.at)) continue;
    if (now - entry.at <= within) count += 1;
  }
  return count;
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
    runwayMinutes: number(env.USAGE_LIMITS_RUNWAY, DEFAULTS.runwayMinutes),
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

// Spending faster than the clock only means something for a window you have to
// make last. A window that comes back in hours is meant to be spent in a burst:
// nothing carries over, so holding budget back buys nothing at all, and the
// only thing an even pace achieves is getting less done for the same money.
const PACE_MIN_SPAN_MS = 24 * 60 * 60 * 1000;
const PACE_MIN_ELAPSED = 0.25;

function pacingMatters(window, now) {
  if (!window || !window.spanMs || !Number.isFinite(window.windowStart)) return false;
  if (window.spanMs < PACE_MIN_SPAN_MS) return false;
  // Early on, the comparison is dominated by how little of the window has gone
  // rather than by how much has been spent. Twenty minutes into a five hour
  // window every working session is far "ahead of pace", which is exactly how
  // 44 per cent used came to be reported as tight.
  return (now - window.windowStart) / window.spanMs >= PACE_MIN_ELAPSED;
}

// Not whether to speak, which is always, but how hard to lean on it.
function pressure(window, now, config, turnsLeft) {
  if (!window || window.percentUsed === null || window.stale) return 'unknown';
  if (window.verdict === 'exhausted' || window.percentUsed >= 100) return 'gone';
  if (window.verdict === 'runs-out') return 'tight';

  // How long the budget lasts at the pace it is actually being spent at. This
  // is the only figure here that answers "am I about to be cut off", and it was
  // being computed and then ignored.
  //
  // When a reset time is known, a short runway already shows up as the
  // 'runs-out' verdict above. When it is not - and a 5-hour window whose
  // resets_at comes back null is exactly that case - the verdict is only
  // 'burning', which fell through every branch below to 'roomy'. Three sessions
  // were told the budget fitted easily while this number said forty-three
  // minutes; nine minutes later all three were rejected.
  //
  // It is also the right figure when several agents share one budget: the pace
  // it is measured from is the whole account's, not this session's, so the
  // runway already shortens as others spend.
  const runwayMs = Math.max(0, config.runwayMinutes) * 60 * 1000;
  if (Number.isFinite(window.headroomMs) && window.headroomMs <= runwayMs) {
    return 'tight';
  }

  if (window.percentUsed >= config.near) return 'tight';

  // Turns are the number the work is planned in, so a count this short is the
  // wall whatever the percentage says.
  if (Number.isFinite(turnsLeft) && turnsLeft <= config.fewTurns) {
    return 'tight';
  }

  // Being ahead of the clock is reported and is deliberately not escalated. A
  // five hour window is meant to be spent in a burst, and even a weekly one
  // being spent quickly is a fact about how the week is going rather than a
  // reason to do less today. The figures are in the line; the judgement is the
  // reader's.
  return 'roomy';
}

// Everything about the binding window that has to survive the cache, because
// the cached copy is what every later prompt in the minute is judged against.
//
// This is a list rather than the window itself so the cache stays small, and it
// is a named function so it can be checked: leaving `headroomMs` off it once
// meant the escalation that depends on the runway was dead in production while
// passing every unit test, which is the quietest way for a warning to fail.
const CACHED_BINDING_FIELDS = [
  'key',
  'label',
  'percentUsed',
  'stale',
  'estimated',
  'adjusted',
  'pointsSinceSnapshot',
  'correctionUnreliable',
  'pointsBeyondSnapshot',
  'resetsAt',
  'verdict',
  'windowStart',
  'spanMs',
  'headroomMs',
  'msToReset',
  'refusedAt',
  'refusedResetsAt',
];

function cacheableBinding(binding) {
  if (!binding) return null;
  const copy = {};
  for (const field of CACHED_BINDING_FIELDS) {
    copy[field] = binding[field] === undefined ? null : binding[field];
  }
  return copy;
}

// Every field `pressure` reads has to be one the cache keeps, or the decision
// it makes on a cache hit is made from missing data.
function pressureInputs() {
  return ['percentUsed', 'stale', 'verdict', 'headroomMs', 'windowStart', 'spanMs', 'estimated'];
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
  // When spending since the snapshot has outrun what the snapshot said was
  // left, the percentage is the last real reading, not the current one, and
  // the headline has to say so or every later prompt repeats a stale number.
  if (described) bound.push(described + (parts.binding.stale ? '' : (parts.correctionUnreliable ? ' used at the last real reading' : ' used')));
  if (Number.isFinite(parts.turnsLeft)) {
    // Another session spending the same budget means fewer of those turns are
    // yours, so say both numbers rather than the flattering one.
    const shared =
      parts.sessions > 1 && Number.isFinite(parts.yourTurnsLeft)
        ? ' (' + parts.sessions + ' sessions active, roughly ' + parts.yourTurnsLeft +
          ' of them yours)'
        : '';
    bound.push('about ' + parts.turnsLeft + ' turns of headroom' + shared);
    // A turn count is a poor sense of urgency when several agents are spending
    // at once: two hundred turns sounds like plenty and can be gone in ten
    // minutes. The runway is the figure that does not flatter.
    if (parts.runsOutIn) bound.push('about ' + parts.runsOutIn + ' of that at the current pace');
  } else if (parts.sessions > 1) {
    // The headroom could not be worked out, but the fact that the budget is
    // being shared is still the most important thing about it. Attaching this
    // only to a turn count meant it went unsaid exactly when there was no
    // reading to attach it to.
    bound.push(parts.sessions + ' sessions active and sharing it');
  }
  if (parts.resetsIn) bound.push('resets in ' + parts.resetsIn);

  const sentences = [];
  sentences.push(
    bound.length
      ? '[usage-limits] binding window is ' + bound.join(', ') + '.'
      : '[usage-limits] no usable window reading.'
  );
  if (parts.planChanged) {
    sentences.push(
      'The plan has changed since these figures were learned, so the reading ' +
        'above was measured against a different allowance and may predate the ' +
        'change; run /usage before trusting it.'
    );
  }
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
  if (parts.correctionUnreliable) {
    // A reading three hours old that has been spent past its own remainder is
    // not 82%; it is unknown, with 82% as the floor. Say exactly that.
    sentences.push(
      'That percentage is a floor, not a current reading: the last real snapshot is ' +
        parts.snapshotAge + ' old and about ' + parts.pointsBeyondSnapshot +
        ' points have been spent since, more than it said was left. Either the window is ' +
        'already exhausted or the snapshot is wrong; /usage refreshes it.'
    );
  }
  // Work having actually been stopped is the most useful thing that can be said
  // about a budget, and the percentages stop showing it the moment the window
  // turns over. Saying it plainly is what stops the next session opening with
  // "plenty of room" an hour after the last one was cut off mid-edit.
  if (parts.refusedAgo) {
    sentences.push(
      'This limit refused work ' + parts.refusedAgo + ' ago, so treat the room above as ' +
        'the amount that ran out last time, not a fresh allowance.'
    );
  }
  if (parts.othersSummary) sentences.push('Other windows: ' + parts.othersSummary + '.');

  // A window that is not binding can still be the expensive one to exhaust.
  if (parts.critical && parts.critical.length) {
    for (const other of parts.critical) {
      sentences.push(
        'Note that ' + other.label + ' is at ' + other.percentUsed + '% and resets in ' +
          other.resetsIn + ', so running that one out stops work for far longer than the ' +
          'binding window would. Weigh it even though it is not what runs out first.'
      );
    }
  }
  if (parts.session) {
    sentences.push(
      'This session: ' + parts.session.turns + ' turns, ' +
        (Number.isFinite(parts.session.tokens) ? usage.formatTokens(parts.session.tokens) + ' tokens, ' : '') +
        usage.formatUSD(parts.session.cost) + '.'
    );
  }
  // From the tally the Stop hook keeps, so these are exact as of the last reply.
  if (parts.lastReply && Number.isFinite(parts.lastReply.cost)) {
    sentences.push('Last reply ' + usage.formatMoney(parts.lastReply.cost) + '.');
  }
  if (Number.isFinite(parts.context) && parts.context > 0) {
    // The context is re-sent on every call, so past a point it is the cost of
    // the session. One clause, once it is large; no advice while it is not.
    sentences.push(
      'Context about ' + usage.formatTokens(parts.context) + ' tokens' +
        (parts.context >= LARGE_CONTEXT_TOKENS
          ? '; each turn re-reads that, so a fresh session or /compact at the next clean boundary cuts per-turn cost.'
          : '.')
    );
  }
  // Said once, on a session's first prompt, because the previous session's
  // total is the one figure nothing else ever shows.
  if (parts.lastSession && parts.lastSession.turns) {
    const last = parts.lastSession;
    sentences.push(
      'Last session: ' + last.turns + ' turns, ' + usage.formatTokens(last.tokens) + ' tokens, ' +
        roundMoney(last.cost) +
        (last.project || last.endedAgo
          ? ' (' +
            [
              last.project,
              last.endedAgo
                ? (last.open ? 'still open, last active ' : 'ended ') + last.endedAgo + ' ago'
                : null,
            ]
              .filter(Boolean)
              .join(', ') +
            ')'
          : '') + '.'
    );
  }

  // Three states, and only the last one stops anything.
  //
  // The middle one is the one that keeps being got wrong. Near the wall the
  // instinct is to do less of what was asked, and that is the wrong trade: it
  // spends the user's request to protect a budget that expires anyway. The job
  // near the wall is to make being cut off cheap - order the work, save as you
  // go, keep a note of where things stand - not to shrink the work until it is
  // guaranteed to fit.
  const instruction =
    parts.pressure === 'gone'
      ? 'The budget is gone, so nothing further will run. Save what exists and ' +
        'write the handoff: what is finished, what is next and in what order, ' +
        'which files are mid-change, and when the window resets.'
      : parts.pressure === 'tight'
        ? 'The budget is nearly gone, so make being cut off cheap rather than ' +
          'doing less. Carry on with the whole request at full quality: this is ' +
          'not a reason to narrow the work, drop parts of it, or stop to ask ' +
          'whether to go on. Order it so the most valuable part lands first, ' +
          'save at clean boundaries as you go, and keep a short running note of ' +
          'what is done, what is next, and which files are mid-change, so that ' +
          'stopping at any moment loses nothing. Say in one line what may not ' +
          'land before the reset, then keep working.'
        : 'Open your reply with one short line stating this and confirming the ' +
          'request fits, then get on with the work. Keep it to a single line. ' +
          'There is room, so use it: work at full quality, take on the whole ' +
          'request, and do not hold budget back or economise, as anything left ' +
          'unspent is lost at the reset rather than saved.';

  // The mistake this guards against: quoting the roomiest window and pinning
  // the binding window figures to it.
  const care =
    ' Quote the binding window, not whichever one has the most left. The turns ' +
    'and reset time above belong to the binding window alone; do not read them ' +
    'against another window percentage.';

  // Finished work closes with what it cost. Not every reply: a progress note
  // mid-task is not the moment, and once the budget is gone nothing further
  // runs, so there is no reply to close.
  const closing =
    parts.pressure === 'gone'
      ? ''
      : ' When this reply completes what was asked, or wraps up the session, end it ' +
        'with one plain line giving the session total above (turns, tokens and cost). ' +
        'Skip it on partial progress; the hook prints the exact figure after you stop.';

  return sentences.join(' ') + '\n' + instruction + closing + care;
}

// Past this the context is the cost of the session, not a detail of it.
const LARGE_CONTEXT_TOKENS = 150000;

// A previous session's total reads better in whole dollars once it is large.
function roundMoney(value) {
  if (!Number.isFinite(value)) return '-';
  return value >= 10 ? '$' + Math.round(value) : usage.formatMoney(value);
}

function isTallyEntry(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// What the Stop hook's tally can add to the line: this session's last reply
// and context when it is a session the tally has seen, or the previous
// session's total when it has not, which is how a first prompt gets told what
// the last session cost.
function tallyContext(all, sessionId, now) {
  const none = { lastReply: null, context: null, lastSession: null };
  if (!all || typeof all !== 'object') return none;

  const mine = sessionId && isTallyEntry(all[sessionId]) ? all[sessionId] : null;
  if (mine) {
    return {
      lastReply: mine.lastReply || null,
      context: Number.isFinite(mine.context) ? mine.context : null,
      lastSession: null,
    };
  }

  const others = Object.keys(all)
    .filter((key) => key !== tally.IDS_KEY && isTallyEntry(all[key]))
    .map((key) => all[key])
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  const last = others[0];
  if (!last || !last.turns) return none;

  const open = !Number.isFinite(last.endedAt);
  const ended = open ? last.lastAt : last.endedAt;
  return {
    lastReply: null,
    context: null,
    lastSession: {
      turns: last.turns,
      tokens: tally.totalTokens(last.tokens),
      cost: last.cost,
      project: last.project || null,
      // Another window may still be in it, so say when it was last active
      // rather than claiming it ended.
      open,
      endedAgo: Number.isFinite(ended) ? usage.formatDuration(now - ended) : null,
    },
  };
}

async function run(now, hookInput) {
  if (String(process.env.USAGE_LIMITS_BRIEF || '').toLowerCase() === 'off') return '';

  // Codex cannot ship a hook inside a plugin, so its hook is installed into
  // ~/.codex/hooks.json with the host written into the command. Settle it here,
  // before any file is read.
  usage.setHost(host.detect(process.argv.slice(2), process.env));

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
      planChanged: data.planChanged,
      critical: usage.criticalOthers(data.windows, binding && binding.key).map((w) => ({
        label: w.label,
        percentUsed: w.percentUsed,
        resetsIn: Number.isFinite(w.msToReset) ? usage.formatDuration(w.msToReset) : 'an unknown time',
      })),
      snapshotAge: usage.formatDuration(data.snapshotAgeMs),
      binding: cacheableBinding(binding),
    };
    writeCache(mergeCache(all, sessionId, view, KEEP_SESSIONS));
  }

  const binding = view.binding;
  const sessions = view.sessions || [];
  // The spend-derived count is the accurate one when it has caught up; the
  // open-session count is the one that is right immediately. Take whichever is
  // higher rather than the one that happens to be handy, because under-counting
  // is what makes the headroom read as more yours than it is.
  const active = Math.max(sessions.length, liveSessions(all, now, LIVE_WINDOW_MS, sessionId) + 1);
  const share =
    sessions.length > 1 ? usage.shareOf(sessions, sessionId) : active > 1 ? 1 / active : 1;
  const yourTurnsLeft = Number.isFinite(view.turnsLeft)
    ? Math.max(1, Math.round(view.turnsLeft * share))
    : null;
  // Only a short runway is worth saying. Quoting it when there are hours left
  // would make the line longer without making it more useful.
  const shortRunway =
    binding && Number.isFinite(binding.headroomMs) &&
    binding.headroomMs <= RUNWAY_MENTION_MS;
  // Outside the cache on purpose: the tally moves after every reply.
  const found = tallyContext(tally.readState(), sessionId, now);
  return briefText({
    lastReply: found.lastReply,
    context: found.context,
    lastSession: found.lastSession,
    sessions: active,
    yourTurnsLeft,
    runsOutIn: shortRunway ? usage.formatDuration(binding.headroomMs) : null,
    // Only while it is still the thing that just happened. A refusal from days
    // ago says nothing about now.
    refusedAgo:
      binding && Number.isFinite(binding.refusedAt) && now - binding.refusedAt < 6 * 60 * 60 * 1000
        ? usage.formatDuration(now - binding.refusedAt)
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
    planChanged: Boolean(view.planChanged),
    critical: view.critical || [],
    pointsSinceSnapshot: (binding && binding.pointsSinceSnapshot) || 0,
    correctionUnreliable: Boolean(binding && binding.correctionUnreliable),
    pointsBeyondSnapshot: (binding && binding.pointsBeyondSnapshot) || 0,
    snapshotAge: view.snapshotAge,
    // The turn count that matters for this session is its share of a shared
    // budget, not the whole window's. Escalating on the whole window meant a
    // count that looked comfortable while the part actually available here was
    // a third of it.
    pressure: pressure(binding, now, config, Number.isFinite(yourTurnsLeft)
      ? yourTurnsLeft
      : view.turnsLeft),
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
  pacingMatters,
  PACE_MIN_SPAN_MS,
  PACE_MIN_ELAPSED,
  pressure,
  sessionSpend,
  describeWindow,
  summariseOthers,
  briefText,
  tallyContext,
  LARGE_CONTEXT_TOKENS,
  settings,
  keepSlots,
  pickCached,
  mergeCache,
  liveSessions,
  cacheableBinding,
  pressureInputs,
  CACHED_BINDING_FIELDS,
  LIVE_WINDOW_MS,
  RUNWAY_MENTION_MS,
  KEEP_SESSIONS,
  run,
  cacheFile,
};
