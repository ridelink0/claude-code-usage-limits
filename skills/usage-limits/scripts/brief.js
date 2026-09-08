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
const activity = require('./activity.js');
const live = require('./live.js');
const relay = require('./relay.js');
const reading = require('./reading.js');
const voice = require('./voice.js');

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
  // How old the reading may be before the hook takes a fresh one.
  refreshSeconds: 180,
};

// A hook has ten seconds; the reading gets four of them at most.
const REFRESH_TIMEOUT_MS = 4000;

// The hook is given ten seconds, and a live reading may take four of them, so
// the transcript scan gets five and the last second is slack. A warm scan
// takes about a quarter of a second; this is the guard for the first run on a
// machine with months of transcripts, where the alternative is the hook being
// killed and Claude being told nothing at all.
const SCAN_BUDGET_MS = 5000;

// How far into the hook arming may still start. See relayState: the task
// registration is about a second and the hook is allowed ten.
const ARM_DEADLINE_MS = 5000;

// Past this much of a per-model week, say how to free it. Below it the advice
// is noise: there is room, and the model in use is the right one.
const HALF_SPENT = 50;

// "fable" -> "Fable", the way the account names the window.
function familyLabel(family) {
  const name = String(family || '');
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

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

// How many sessions are sharing the budget, and how much of it is this one's.
// One place for both hooks. The pulse once counted only sessions that had
// spent while the brief also counted those that had merely prompted, and the
// two lines disagreed about how many sessions there were minutes apart. The
// spend-derived count is the accurate one when it has caught up; the
// open-session count is the one that is right immediately. Take whichever is
// higher, because under-counting is what makes the headroom read as more
// yours than it is.
function activeShare(sessions, slots, now, sessionId) {
  const spent = sessions || [];
  const active = Math.max(spent.length, liveSessions(slots, now, LIVE_WINDOW_MS, sessionId) + 1);
  return { active, share: active > 1 ? usage.shareOf(spent, sessionId, active) : 1 };
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
  // Never throws: a cache miss costs a scan, a crash costs the prompt. Atomic
  // because every open window's prompt hook writes this same file, and a torn
  // read by one of them wiped the others' slots on the way back.
  usage.writeJsonAtomic(cacheFile(), all);
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
    refreshSeconds: number(env.USAGE_LIMITS_REFRESH, DEFAULTS.refreshSeconds),
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
  // The model family a per-model weekly is scoped to. Read by the line that
  // says a model switch is the only thing that frees such a window, so it has
  // to survive the cache like every other field the wording depends on.
  'family',
  'applies',
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

// One is not a plural. The line is read by an agent that then repeats it to
// the user, so "about 1 points" is a small error that gets copied out loud.
function count(value, word) {
  return value + ' ' + word + (Math.abs(value) === 1 ? '' : 's');
}

// The other agent's meter, in one clause.
//
// Codex reports what is LEFT where Claude reports what is USED, so every
// figure here carries the word "left" - a bare percentage next to Claude's
// would be read as the same kind of number and mean the opposite thing.
//
// Read from Codex's rollouts on disk. Nothing spawns Codex, nothing waits on
// it, and a machine without it pays one stat call.
function codexSummary(now) {
  try {
    if (usage.isCodex() || !host.codexHasSessions()) return null;
    const display = require('./view.js');
    const codex = require('./codex.js');
    const other = codex.collect(now);
    const block = display.buildCodex({
      now,
      utilization: other.utilization,
      fetchedAtMs: other.snapshotFetchedAt,
      windowSpecs: other.windowSpecs,
      plan: other.plan,
      windowless: other.windowless,
    });
    if (!block.present) return null;
    const names = { five_hour: '5-hour', seven_day: 'weekly' };
    const bits = block.rows
      .filter((row) => row.percentLeft !== null)
      .map((row) => (names[row.key] || row.title) + ' ' + Math.floor(row.percentLeft) + '% left');
    if (!bits.length) return null;
    return { plan: block.plan, bits, stale: block.state !== 'live' };
  } catch (err) {
    // An unreadable Codex is simply no Codex clause.
    return null;
  }
}

function describeWindow(window) {
  if (!window) return null;
  if (window.stale) return window.label + ' rolling over';
  const about = window.estimated || window.adjusted ? ' about ' : ' ';
  // A per-model weekly for a model this session is not running is listed, but
  // never bare: 88% beside the other percentages is read as 88% of the budget
  // in hand, and the reply that follows sizes the work down for a limit not one
  // turn here can move.
  const idle = window.applies === false ? " (not this session's model)" : '';
  return window.label + about + window.percentUsed + '%' + idle;
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
    bound.push('about ' + count(parts.turnsLeft, 'turn') + ' of headroom' + shared);
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
      'That includes about ' + count(parts.pointsSinceSnapshot, 'point') + ' spent since the ' +
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
        parts.snapshotAge + ' old and about ' + count(parts.pointsBeyondSnapshot, 'point') +
        ' have been spent since, more than it said was left. Either the window is ' +
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
  // The other agent, when there is one on this machine. Its own budget, its
  // own direction: Codex counts down.
  if (parts.codex && parts.codex.bits.length) {
    sentences.push(
      'Codex' + (parts.codex.plan ? ' (' + parts.codex.plan + ')' : '') + ' has ' +
        parts.codex.bits.join(' and ') +
        (parts.codex.stale ? ', from the last reading it wrote' : '') + '.'
    );
  }
  // The effort setting changes the PRICE of a turn rather than how many there
  // are, and the blended headroom above hides that completely: an account that
  // has just moved to a dearer effort goes on being priced at the old one until
  // enough dear turns have landed to drag the average up, and on a small window
  // there is no "enough" - the window is gone first.
  //
  // A ChatGPT Plus account running gpt-6-astra at ultra effort emptied a whole
  // five-hour window on one ordinary task while this hook reported room the
  // entire way. Saying it here is what turns "plenty of room" into "about
  // twenty turns" before the window is spent rather than after.
  if (parts.effortWarning) {
    const warning = parts.effortWarning;
    const bits = [];
    if (Number.isFinite(warning.turnsLeft)) {
      const blended = warning.blendedTurnsLeft;
      bits.push(
        'at ' + warning.effort + ' effort this window holds about ' + count(warning.turnsLeft, 'turn') +
          (Number.isFinite(blended) && blended > warning.turnsLeft
            ? ', not the ' + blended + ' the headroom above suggests'
            : '')
      );
    }
    if (warning.cheaper && Number.isFinite(warning.cheaper.multiple)) {
      bits.push(
        warning.effort + ' writes about ' + warning.cheaper.multiple.toFixed(1) +
          ' times the output per turn that ' + warning.cheaper.effort + ' does'
      );
    }
    if (bits.length) {
      sentences.push(
        'The effort setting is what is spending this: ' + bits.join(', and ') +
          '. Keep it where the work genuinely needs the thinking and drop it where it ' +
          'does not; it changes what every turn costs, not how many you get.'
      );
    }
  }
  // A per-model weekly is the one window effort cannot help with. Nothing you
  // do more cheaply on this model frees it; only running a different model
  // does, and that has to be said, because the obvious move at 90 percent is
  // to drop the effort and keep going, which spends the same window slower.
  if (parts.family) {
    sentences.push(
      'That window counts ' + parts.family + ' turns only, so lowering effort does not free it: ' +
        'switching model does. Use /model (or scripts/lowpower.js on --model <other>) for work ' +
        'that does not need ' + parts.family + ', and keep this one for what does.'
    );
  }
  if (parts.othersSummary) sentences.push('Other windows: ' + parts.othersSummary + '.');

  // Being at the wall and being out of budget are different things, and the
  // difference is a command. Said as soon as the window is half gone, so it is
  // already known by the time it matters.
  const escape = parts.escape;
  const escapeText =
    escape && escape.kind === 'model'
      ? 'This window is scoped to one model, so it is not the account\'s budget: switching model retires it. ' +
        (escape.nextLabel
          ? 'After a switch the binding window would be ' + escape.nextLabel + ' at ' + escape.nextPercent + ' per cent. '
          : '') +
        'Use /model ' + (escape.suggest || '<another model>') + ' (or scripts/lowpower.js on --model <id>).'
      : escape && escape.kind === 'effort'
        ? 'A model switch does not free this window - it follows the account - but effort does: ' +
          escape.to + ' measured ' + (escape.multiple ? escape.multiple + 'x ' : '') + 'cheaper a turn than ' +
          (escape.from || 'the current effort') + '. Use /effort ' + escape.to + '.'
        : null;
  if (escapeText && parts.binding && Number.isFinite(parts.binding.percentUsed) && parts.binding.percentUsed >= HALF_SPENT) {
    sentences.push(escapeText);
  }

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

  if (parts.voiceNote) sentences.push('How this user wants to be written to: ' + parts.voiceNote);

  // What the relay changes about all of this.
  //
  // With a wake booked, the end of the window stops being the end of the work,
  // and the instruction at the wall changes shape: the handoff is no longer a
  // note somebody has to find and read, it is the prompt this conversation
  // will be handed back. That is worth two minutes of writing, and it is worth
  // saying plainly, because a session told only "you are about to be cut off"
  // spends its last turns hedging.
  const carry = parts.relay;
  if (carry && carry.armed) {
    const wake = new Date(carry.armed.wakeAt);
    sentences.push(
      'A relay is armed: ' + (carry.justArmed ? 'booked just now' : 'booked') + ' for ' +
        wake.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ', ' +
        carry.config.graceMinutes + ' minutes after this window resets, and it will ' +
        (carry.armed.mode === 'resume' ? 'hand your continuation straight back to this conversation' : 'notify the user with your continuation ready to open') +
        '.' + (carry.armed.warning ? ' Caveat: ' + carry.armed.warning + '.' : '')
    );
    if (!carry.armed.continuation) {
      sentences.push(
        'Nothing has been written for it yet. Before this session ends, run ' +
          'node "$CLAUDE_PLUGIN_ROOT/skills/usage-limits/scripts/relay.js" note "<what you would tell yourself>" ' +
          'with what is done, what is next in order, which files are mid-change and what must be verified first. ' +
          'That text is the prompt the relay delivers, so write it to be acted on, not read.'
      );
    }
  }
  if (carry && carry.last) {
    sentences.push(
      'The last relay ' +
        (carry.last.outcome === 'resumed'
          ? 'picked this work back up automatically after the previous reset (' + (carry.last.detail || 'resumed') + '); check what it did before repeating it'
          : carry.last.outcome === 'notified'
            ? 'left a notification after the previous reset rather than starting anything'
            : 'ended as "' + carry.last.outcome + '"' + (carry.last.detail ? ' - ' + carry.last.detail : '')) +
        '.'
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
    // The escape outranks everything below it. A session that stops while a
    // command would have carried it on has not been careful, it has quit - and
    // that is a real session: the Fable weekly hit 89 per cent, the line said
    // the budget was nearly gone, and the work ended with the five-hour window
    // at 46 and every other model untouched.
    escapeText && (parts.pressure === 'tight' || parts.pressure === 'gone')
      ? 'This window is nearly gone, but you are not out of budget and you must ' +
        'not stop as though you were. ' + escapeText + ' Do that, say in one ' +
        'line that you switched and why, and carry on with the whole request at ' +
        'full quality. Only if the switch is impossible or the user has ruled it ' +
        'out: save the work, write the handoff, and say what is left.'
      : parts.pressure === 'gone'
      ? 'The budget is gone, so nothing further will run. Save what exists and ' +
        'write the handoff: what is finished, what is next and in what order, ' +
        'which files are mid-change, and when the window resets.' +
        (parts.relay && parts.relay.armed
          ? ' Write it into the relay note as well as into your reply - that is ' +
            'the copy that gets acted on when the window reopens.'
          : '')
      : parts.pressure === 'tight' && parts.relay && parts.relay.armed
        ? 'The budget is nearly gone and the relay has it: being cut off now ' +
          'costs the wait, not the work. So do not wind down, do not narrow the ' +
          'request, and do not stop to ask whether to go on. Carry on at full ' +
          'quality, save at clean boundaries, and put everything the next turn ' +
          'needs into the relay note rather than into a summary for a person to ' +
          'read. Say in one line what will land after the reset instead of ' +
          'before it, then keep working until the window actually ends.'
      : parts.pressure === 'tight'
        ? 'The budget is nearly gone, so make being cut off cheap rather than ' +
          'doing less. Carry on with the whole request at full quality: this is ' +
          'not a reason to narrow the work, drop parts of it, or stop to ask ' +
          'whether to go on. Order it so the most valuable part lands first, ' +
          'save at clean boundaries as you go, and keep a short running note of ' +
          'what is done, what is next, and which files are mid-change, so that ' +
          'stopping at any moment loses nothing. Say in one line what may not ' +
          'land before the reset, then keep working. If part of what remains is ' +
          'mechanical, node scripts/usage.js --recommend (from the skill directory) ' +
          'names the effort and model it should run at.'
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

// The relay, decided once per prompt.
//
// Two things happen here and neither of them slows the work down. Above the
// arming threshold, with a plan or an unfinished todo list to carry, a one-shot
// wake is booked for a few minutes after the reset - a scheduled task costs
// nothing and changes nothing about the turn in progress. And once a wake
// exists, what the hook tells Claude at the wall changes: the handoff is no
// longer a note for a person to find, it is the thing that will be handed back
// automatically, so it is worth writing properly.
//
// It also reports what happened last time. A relay that fired while nobody was
// watching is exactly the sort of thing a session should not have to be asked
// about.
function relayState(now, hookInput, binding, sessionId) {
  try {
    const state = relay.read();
    const config = relay.settings(state);
    const last = state.history[state.history.length - 1];
    const recent = last && Number.isFinite(last.endedAt) && now - last.endedAt < 6 * 60 * 60 * 1000 ? last : null;
    if (!config.enabled) return recent ? { enabled: false, last: recent } : null;

    // Already armed for this session: nothing to decide, just say so.
    if (state.armed && state.armed.id === sessionId) {
      return { enabled: true, armed: state.armed, config, last: recent };
    }
    const work = relay.detectWork(hookInput && hookInput.transcript_path, {});
    const able = relay.armable({ config, binding, sessionId, work });
    if (!able.ok) return { enabled: true, why: able.why, config, last: recent, work };
    // Registering a scheduled task measured 936 ms, and this hook has ten
    // seconds of which the live reading may take four and the scan five. A
    // hook that is killed tells Claude nothing at all, which is far worse than
    // a relay that arms on the next prompt instead of this one - and if there
    // is no next prompt, the session ended and there was nothing to carry.
    if (Date.now() - now > ARM_DEADLINE_MS) {
      return { enabled: true, why: 'no time left in this hook; arming on the next prompt', config, last: recent, work };
    }
    const armed = relay.arm({
      now,
      config,
      // Registration must be finished, not merely started, inside the hook's
      // ten seconds; the scheduler trims its own waits to this.
      deadline: now + ARM_DEADLINE_MS + 4000,
      sessionId,
      binding,
      work,
      resetsAt: binding.resetsAt,
      cwd: (hookInput && hookInput.cwd) || process.cwd(),
      project: path.basename((hookInput && hookInput.cwd) || process.cwd()),
      hostName: usage.currentHost(),
    });
    return armed.ok
      ? { enabled: true, armed: armed.record, justArmed: true, config, last: recent, work }
      : { enabled: true, error: armed.error, config, last: recent, work };
  } catch (err) {
    // Nothing about carrying work forward is worth breaking the prompt for.
    return null;
  }
}

async function run(now, hookInput) {
  if (String(process.env.USAGE_LIMITS_BRIEF || '').toLowerCase() === 'off') return '';

  // Codex cannot ship a hook inside a plugin, so its hook is installed into
  // ~/.codex/hooks.json with the host written into the command. Settle it here,
  // before any file is read.
  usage.setHost(host.detect(process.argv.slice(2), process.env));

  const sessionId = hookInput && hookInput.session_id ? hookInput.session_id : null;
  // A prompt has arrived, so this session is working, and the prompt itself
  // says whether it asked for ultracode. The panel animates from this.
  activity.mark(
    'working',
    sessionId,
    Object.assign(
      {
        // Whole words only: both are real directives in the prompt. Ultrathink
        // is per prompt, so it is set true or false every time.
        ultrathink: Boolean(
          hookInput && typeof hookInput.prompt === 'string' && /\bultrathink\b/i.test(hookInput.prompt)
        ),
      },
      // Ultracode is Claude Code's own keyword trigger and it sticks for the
      // session once used, so it is only ever set on here and otherwise
      // carried forward. It is safe to read from the text now that every
      // display reads the mark of the one session it describes.
      hookInput && typeof hookInput.prompt === 'string' && /\bultracode\b/i.test(hookInput.prompt)
        ? { ultracode: true }
        : {}
    ),
    now
  );

  const config = settings();
  // The reading ages during long turns, and a burst of parallel agents can
  // spend half a window between two of them. Before the numbers go in front
  // of Claude, take the same reading Claude Code takes for /usage when the
  // one on disk is older than a few minutes. Offline or signed out this is
  // one quick failure and then a widening backoff, never a wait on every
  // prompt; USAGE_LIMITS_FETCH=off turns it off.
  try {
    if (usage.isCodex()) {
      // Codex only writes its meter when it makes a request, so between turns
      // the newest figure can be half an hour old. Ask it, the way /status
      // does, when the reading has aged.
      await require('./codex.js').refreshIfStale({
        now,
        maxAgeMs: config.refreshSeconds * SECOND,
        timeoutMs: REFRESH_TIMEOUT_MS,
      });
    } else {
      const cached = usage.collect(now);
      await live.refreshIfStale({
        now,
        maxAgeMs: config.refreshSeconds * SECOND,
        cacheFetchedAtMs: cached.snapshotFetchedAt,
        accountUuid: usage.accountUuid(),
        timeoutMs: REFRESH_TIMEOUT_MS,
      });
    }
  } catch (err) {
    // The reading on disk is still there.
  }
  const base = usage.collect(now);
  if (!base.utilization) return '';

  const all = readCache();
  let view = pickCached(all, sessionId, now, config.cacheSeconds * SECOND);

  // Everything shown has to come from one pass. Deriving the turns from a
  // full scan and the binding window from somewhere cheaper is how the two
  // end up describing different windows.
  if (!view || !view.binding) {
    // One call, shared with the report. Building the view twice is how the
    // snapshot correction reached the report and never reached the hook.
    const data = await usage.report(now, { sessionId, budgetMs: SCAN_BUDGET_MS });
    const binding = data.binding;
    view = {
      at: now,
      turnsLeft: binding && Number.isFinite(binding.turnsLeft) ? binding.turnsLeft : null,
      session: data.session,
      othersSummary: summariseOthers(data.windows, binding && binding.key),
      // The way out that is not stopping. Cached with the rest of the view
      // because it is derived from the same one pass over the windows.
      escape: usage.escapeRoute(data.windows, binding, data.effortWarning || null),
      // Every window, trimmed to the cacheable fields, so the corrected reading
      // can be recorded for all three columns of the status line on a cache
      // hit too. Recording the binding window alone left the other two at
      // their raw snapshots on every short turn, where the pulse never runs.
      windows: (data.windows || []).map(cacheableBinding),
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
      effortWarning: data.effortWarning || null,
    };
    writeCache(mergeCache(all, sessionId, view, KEEP_SESSIONS));
  }

  const binding = view.binding;
  const { active, share } = activeShare(view.sessions, all, now, sessionId);
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
  // Learning how the user writes, from the prompt that just arrived. Counters
  // only, no model call, and it never speaks: what it knows is read back by
  // /usage-limits:voice and used when the relay writes as them.
  try {
    if (hookInput && typeof hookInput.prompt === 'string') voice.observe(hookInput.prompt, now);
  } catch (err) {
    // Style is not worth a failed hook.
  }
  // This hook has just paid for a transcript scan, so the corrected figure is
  // in hand. Leave it where the status line can read it: that line redraws far
  // too often to scan for itself, and without this it shows the raw snapshot,
  // which during a heavy session is wrong by tens of points in the flattering
  // direction.
  reading.recordAll(view.windows && view.windows.length ? view.windows : [binding], now, usage.isCodex() ? require('./codex.js').homeDir() : null);
  const carry = relayState(now, hookInput, binding, sessionId);
  // An instruction the user typed at /usage-limits:voice set. The learned
  // traits are for writing AS them and stay out of the way; this is them
  // saying how they want to be talked to, so it is said every time.
  let voiceNote = null;
  try {
    voiceNote = voice.read().note;
  } catch (err) {
    voiceNote = null;
  }
  return briefText({
    relay: carry,
    voiceNote,
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
    // Named only while the window is actually tight: at 20 percent nobody
    // needs telling how to free it.
    family:
      binding && binding.family && Number.isFinite(binding.percentUsed) && binding.percentUsed >= HALF_SPENT
        ? familyLabel(binding.family)
        : null,
    othersSummary: view.othersSummary,
    escape: view.escape || null,
    turnsLeft: view.turnsLeft,
    effortWarning: view.effortWarning || null,
    // Outside the cache: it is cheap, and it belongs to the other agent's
    // clock rather than this session's.
    codex: codexSummary(now),
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
  codexSummary,
  tallyContext,
  LARGE_CONTEXT_TOKENS,
  settings,
  keepSlots,
  pickCached,
  mergeCache,
  liveSessions,
  activeShare,
  readCache,
  cacheableBinding,
  pressureInputs,
  CACHED_BINDING_FIELDS,
  LIVE_WINDOW_MS,
  RUNWAY_MENTION_MS,
  KEEP_SESSIONS,
  run,
  cacheFile,
};
