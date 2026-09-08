#!/usr/bin/env node
'use strict';

// Reports how much of the current Claude Code usage window is left, and
// converts that into something you can plan with: turns remaining and
// minutes remaining at the pace of the last hour.
//
// Two data sources, both local:
//   ~/.claude.json          cachedUsageUtilization - the real percentages
//                           and reset times, refreshed by the CLI itself
//   ~/.claude/projects/**   session transcripts, one JSON object per line,
//                           each assistant turn carrying a usage record
//
// The percentages alone tell you where you are but not how fast you are
// moving. The transcripts alone tell you how fast you are moving but not
// where the ceiling is. Combining them gives a dollars-per-percent factor
// for this account and plan, which is what the projections are built on.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const host = require('./host.js');
const codex = require('./codex.js');
const live = require('./live.js');
const reading = require('./reading.js');

// Which agent's meter to read. Resolved once from the command line or the
// environment, because a process that changed its mind halfway through would
// mix one host's percentages with the other's turns.
let activeHost = null;

function currentHost() {
  if (!activeHost) activeHost = host.detect(process.argv.slice(2), process.env);
  return activeHost;
}

function setHost(name) {
  activeHost = host.normalise(name) || host.CLAUDE;
  return activeHost;
}

function isCodex() {
  return currentHost() === host.CODEX;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// USD per million tokens, first-party API rates. `cacheRead` is an absolute
// $/MTok override for the few models that price reads outright instead of at
// a tenth of input; everything else uses the CACHE_READ multiplier below.
const RATES = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
// A model can ship before this table knows about it. Rather than refusing to
// price it, fall back to the average of the family it names. Averaging assumes
// nothing about which direction prices moved, unlike pinning to one release.
// An unrecognised family falls back to Opus rates on purpose: over-estimating
// cost understates headroom, and that is the safe direction for a budget.
const FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];

// Settings that name a strategy rather than a model. `opusplan` plans on Opus
// and executes on Sonnet, so it spends into both families and neither of them
// is what a substring match would find on its own.
const MODEL_ALIASES = { opusplan: ['opus', 'sonnet'] };
const FALLBACK_RATE = { input: 5, output: 25 };

function familyOf(model) {
  const id = String(model || '').toLowerCase();
  for (const family of FAMILIES) {
    // Mythos is priced with Fable, so it counts as the same family.
    if (id.indexOf(family) !== -1) return family === 'mythos' ? 'fable' : family;
  }
  return null;
}

function familyAverage(family, table) {
  if (!family) return null;
  const rates = table || RATES;
  const members = Object.keys(rates).filter((id) => familyOf(id) === family);
  if (!members.length) return null;

  let input = 0;
  let output = 0;
  for (const id of members) {
    input += rates[id].input;
    output += rates[id].output;
  }
  return { input: input / members.length, output: output / members.length };
}

// Claude Code aliases and some transcript records carry a bracketed variant
// suffix - "fable[1m]" is the 1M-context toggle on the same model, not a
// different one. Left in place it misses the exact rate lookup and lands on
// the family average, which is wrong whenever a family's members price
// differently (sonnet 5 at $2 against sonnet 4.6 at $3).
function normalizeModel(model) {
  return String(model || '')
    .toLowerCase()
    .replace(/\[[^\]]*\]\s*$/, '')
    .trim();
}

// Whether the price came from the table or from an assumption.
function isKnownModel(model) {
  return Object.prototype.hasOwnProperty.call(RATES, normalizeModel(model));
}

// Cache traffic is priced as a multiple of the input rate.
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const CACHE_READ = 0.1;

// `family` marks a window that caps one model family rather than the account
// as a whole. It is what tells the rest of the file that a window cannot stop
// work which does not use that family.
const WINDOWS = [
  { key: 'five_hour', label: '5-hour', span: 5 * HOUR },
  { key: 'seven_day', label: 'weekly', span: 7 * DAY },
  { key: 'seven_day_opus', label: 'weekly (Opus)', span: 7 * DAY, family: 'opus' },
  { key: 'seven_day_sonnet', label: 'weekly (Sonnet)', span: 7 * DAY, family: 'sonnet' },
];

// Which model families this agent can actually spend into.
//
// A per-model weekly caps one family's spend and nothing else, so it can only
// ever stop work that uses that family. Reported without that qualification it
// becomes the loudest number in the brief for a limit the session cannot move:
// a session running Opus was told to weigh a Fable weekly at 88%, and no
// amount of work it did would have moved it a single point.
//
// The configured model is the floor. A session's own turns are added on top,
// because subagents and a mid-session /model both spend into families the
// setting never mentions. Other sessions' turns are deliberately not counted:
// what another window is burning is not this one's constraint.
//
// An empty set means the model could not be worked out at all, and nothing is
// suppressed on the strength of a guess.
function familiesInUse(events, sessionId, models) {
  const families = new Set();
  const hints = Array.isArray(models) ? models : [models];
  for (const hint of hints) {
    const name = normalizeModel(hint);
    // Some settings name more than one model. `opusplan` plans on Opus and
    // executes on Sonnet, so a session set to it spends into both, and reading
    // only the first would suppress a Sonnet weekly while Sonnet is running.
    const alias = MODEL_ALIASES[name];
    if (alias) {
      for (const family of alias) families.add(family);
      continue;
    }
    const family = familyOf(name);
    if (family) families.add(family);
  }
  // This session's own turns only. What another window is burning is not this
  // one's constraint, and counting it is how a weekly for a model this agent
  // never runs gets weighed against work that cannot move it. With no session
  // to scan - the CLI report - the configured model is the whole answer, and
  // when that says nothing usable, nothing is suppressed.
  if (sessionId) {
    for (const event of events || []) {
      if (!event || event.sessionId !== sessionId) continue;
      const family = familyOf(event.model);
      if (family) families.add(family);
    }
  }
  return families;
}

// Whether a window is one this agent can spend into. Windows that cap the whole
// account always are; a per-model one only when that model is in use.
function appliesTo(window, families) {
  if (!window || !window.family) return true;
  if (!families || !families.size) return true;
  // Only ever suppress on a family this file recognises on both sides. A
  // scoped weekly names its model by display name, and one for a model
  // released after this table was written falls back to that raw name - which
  // familyOf() will never return for the setting either, so the window would
  // be suppressed permanently, including while it is the thing being spent.
  if (FAMILIES.indexOf(window.family) === -1) return true;
  return families.has(window.family);
}

// Stamps the answer onto each window so every reader - the binding choice, the
// critical warning, the report table - makes the same call from the same field.
function markApplicable(windows, families) {
  for (const window of windows || []) {
    if (window) window.applies = appliesTo(window, families);
  }
  return windows;
}

// organizationType gives the family; the rate limit tier is what separates
// Max 5x from Max 20x. Both come out of oauthAccount.
// Abbreviations for the status line, where there is no room to spell it out.
const SHORT_LABELS = {
  five_hour: '5h',
  seven_day: 'wk',
  seven_day_opus: 'wk opus',
  seven_day_sonnet: 'wk sonnet',
};

const PLANS = {
  pro: {
    label: 'Claude Pro',
    advice:
      'Pro has the smallest budget and the 5-hour window usually binds first. ' +
      'Keep Opus for the hard calls and let Sonnet do the mechanical work.',
  },
  max_5x: {
    label: 'Claude Max 5x',
    advice:
      'Max 5x has room for Opus on most work. On a heavy week the weekly ' +
      'window is the one that bites, not the 5-hour one.',
  },
  max_20x: {
    label: 'Claude Max 20x',
    advice:
      'Max 20x rarely binds. Do not slow down unless the weekly window is ' +
      'already high.',
  },
  max: {
    label: 'Claude Max',
    advice:
      'Max, but the tier was not reported. Treat it as roughly 5x Pro until ' +
      'the measured numbers say otherwise.',
  },
  team: {
    label: 'Claude Team',
    advice:
      'Team seats are pooled and overage is an org setting. Confirm headroom ' +
      'with whoever administers the org.',
  },
  enterprise: {
    label: 'Claude Enterprise',
    advice:
      'Enterprise seats are pooled and overage is an org setting. Confirm ' +
      'headroom with whoever administers the org.',
  },
  unknown: { label: 'unknown', advice: null },
};

const RATE_LIMIT_TIERS = {
  default_claude_max_5x: 'max_5x',
  default_claude_max_20x: 'max_20x',
};

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// The CLI keeps its account state in ~/.claude.json, or next to the config
// directory when CLAUDE_CONFIG_DIR moves it.
//
// Both can exist at once, and the one in the config directory is not
// necessarily the one with the meter in it: a Claude Code migration writes a
// small ~/.claude/.claude.json holding machine ids and migration flags while
// the account state, including cachedUsageUtilization, stays in the home
// directory file. Picking on existence alone found that stub, reported no
// snapshot, and sent host detection off to Codex - which is how a Claude
// session ends up quoting another agent's meter entirely. So choose the file
// that actually carries a snapshot, and only fall back to existence.
function accountFiles() {
  const scoped = path.join(configDir(), '.claude.json');
  const home = path.join(os.homedir(), '.claude.json');
  return scoped === home ? [home] : [scoped, home];
}

function hasSnapshot(file) {
  const parsed = readJson(file);
  return Boolean(parsed && parsed.cachedUsageUtilization);
}

function accountFile() {
  const candidates = accountFiles();
  for (const file of candidates) {
    if (hasSnapshot(file)) return file;
  }
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return candidates[candidates.length - 1];
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function rateFor(model) {
  const id = normalizeModel(model);
  if (RATES[id]) return RATES[id];
  return familyAverage(familyOf(id)) || FALLBACK_RATE;
}

// Cost of one assistant turn, in USD, from its usage record.
function costOf(usage, model) {
  if (!usage) return 0;
  const rate = rateFor(model);
  const creation = usage.cache_creation || {};
  const write5m = creation.ephemeral_5m_input_tokens || 0;
  const write1h = creation.ephemeral_1h_input_tokens || 0;

  let writeUnits = write5m * CACHE_WRITE_5M + write1h * CACHE_WRITE_1H;
  if (writeUnits === 0) {
    // Older records only carry the undifferentiated total. Five minutes is
    // the default TTL, so that is the assumption; an old-format one-hour
    // session is under-priced by it, but assuming 2x would overcharge the
    // common case to be right about the rare one.
    writeUnits = (usage.cache_creation_input_tokens || 0) * CACHE_WRITE_5M;
  }

  // Reads price at a tenth of the input rate unless the model prices them
  // outright. The distinction matters most exactly where reads dominate: a
  // long session re-reads its whole context every turn, and pricing Fable
  // 5.1's $0.25 reads by the tenth rule would overstate that spend fourfold.
  const readTokens = usage.cache_read_input_tokens || 0;
  const readCost = Number.isFinite(rate.cacheRead)
    ? readTokens * rate.cacheRead
    : readTokens * CACHE_READ * rate.input;

  const inputUnits = (usage.input_tokens || 0) + writeUnits;
  return (
    (inputUnits * rate.input + readCost + (usage.output_tokens || 0) * rate.output) / 1e6
  );
}

function tokensOf(usage) {
  if (!usage) return 0;
  const creation = usage.cache_creation || {};
  const written =
    usage.cache_creation_input_tokens ||
    (creation.ephemeral_5m_input_tokens || 0) + (creation.ephemeral_1h_input_tokens || 0);
  return (
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    written +
    (usage.output_tokens || 0)
  );
}

// The four token classes, kept apart because they are priced differently
// and because knowing the split is what makes the totals reasonable about.
function tokenParts(usage) {
  if (!usage) return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0 };
  const creation = usage.cache_creation || {};
  const written =
    usage.cache_creation_input_tokens ||
    (creation.ephemeral_5m_input_tokens || 0) + (creation.ephemeral_1h_input_tokens || 0);
  return {
    input: usage.input_tokens || 0,
    cacheWrite: written,
    cacheRead: usage.cache_read_input_tokens || 0,
    output: usage.output_tokens || 0,
    // Reasoning is not a fifth class of token, it is a slice of the fourth.
    // Measured over 1,565 turns of this account's transcripts, thinking never
    // once exceeded output, so it is counted inside it and must not be added to
    // any total: doing that would price every thinking turn twice.
    //
    // It is worth carrying separately all the same. Output is the dearest class
    // there is, reasoning is about half of it, and it is the one part of the
    // bill a setting can change. The skill has always said so; this is the
    // number that says how much.
    reasoning: (usage.output_tokens_details && usage.output_tokens_details.thinking_tokens) || 0,
  };
}

// One transcript line to an event, or null if it is not a billable turn.
function eventFrom(line, seen, project) {
  if (line.indexOf('"assistant"') === -1 || line.indexOf('"usage"') === -1) return null;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch (err) {
    return null;
  }
  if (entry.type !== 'assistant' || !entry.message || !entry.message.usage) return null;

  const at = Date.parse(entry.timestamp);
  if (!Number.isFinite(at)) return null;

  // A request the limit refused is written like an assistant turn, with a
  // synthetic model and a usage block of zeros. Two things follow.
  //
  // It is not a turn, and counting it as one dilutes the measured cost per turn
  // with free ones, which makes the remaining headroom read longer than it is.
  //
  // And it is the only place the account says outright which window stopped the
  // work and when that window comes back. The cached snapshot reports the
  // 5-hour bucket as 0% with a null reset on this plan, so without reading
  // these there is nothing at all to anchor that window to.
  const quota = entry.quotaLimits;
  if (entry.isApiErrorMessage && quota && typeof quota === 'object') {
    const resetsAt = Number(quota.resetsAt);
    return {
      at,
      model: '',
      effort: null,
      cost: 0,
      tokens: 0,
      parts: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0 },
      project: project || null,
      sessionId: entry.sessionId || null,
      rejected: {
        status: typeof quota.status === 'string' ? quota.status : null,
        key: typeof quota.rateLimitType === 'string' ? quota.rateLimitType : null,
        // Seconds on the wire, milliseconds everywhere in here.
        resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt * 1000 : null,
      },
    };
  }

  // Interrupts and client-side errors are written as assistant messages from
  // a model called <synthetic>, with a usage block of zeros. Not a call.
  if (entry.message.model === '<synthetic>') return null;

  // A resumed or forked session repeats earlier turns in a new file.
  const id = (entry.message.id || '') + '|' + (entry.requestId || '');
  if (id !== '|' && seen) {
    if (seen.has(id)) return null;
    seen.add(id);
  }

  const parts = tokenParts(entry.message.usage);
  return {
    at,
    // Carried on the event so the scan cache can dedup across files without
    // re-parsing them: a resumed or forked session repeats earlier turns, and
    // a cached file is never read again to find that out.
    dedupId: id === '|' ? null : id,
    model: entry.message.model || '',
    effort: entry.effort || null,
    cost: costOf(entry.message.usage, entry.message.model),
    tokens: tokensOf(entry.message.usage),
    parts,
    // What the model was shown on this call: everything except what it wrote.
    // It is re-sent on every later call, so it is the recurring cost of the
    // session, and the one number that says how bloated the context has got.
    context: parts.input + parts.cacheRead + parts.cacheWrite,
    project: project || null,
    sessionId: entry.sessionId || null,
    // A subagent's turns are written under the parent session with these set.
    sidechain: Boolean(entry.isSidechain || entry.agentId),
  };
}

// Whether a transcript line is a prompt the user typed. Tool results are also
// written as user messages, and so are internal notes marked isMeta; neither
// is something a person asked for.
function promptFrom(line) {
  if (line.indexOf('"user"') === -1) return false;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch (err) {
    return false;
  }
  if (!entry || entry.type !== 'user' || entry.isMeta || !entry.message) return false;
  const content = entry.message.content;
  if (typeof content === 'string') return content.length > 0;
  if (!Array.isArray(content)) return false;
  let typed = false;
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'tool_result') return false;
    if (block.type === 'text') typed = true;
  }
  return typed;
}

async function readEvents(since, options) {
  if (isCodex()) return codex.readEvents(since, options);
  return readClaudeEvents(since, options);
}

// A file last touched before the window opened holds nothing useful.
function fresh(file, since) {
  try {
    return fs.statSync(file).mtimeMs >= since;
  } catch (err) {
    return false;
  }
}

function freshFiles(dir, since) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(dir, name))
    .filter((file) => fresh(file, since));
}

// Every transcript under a session's subagents directory. Plain subagents
// write straight into it; the agents a Workflow runs write under
// subagents/workflows/<run id>/, and eight of those spending in parallel is
// exactly the burst that empties a window between two readings, so they must
// be counted. Two levels down is as deep as Claude Code goes today; a bounded
// walk copes if that changes.
function subagentTranscripts(dir, since, depth) {
  const left = Number.isFinite(depth) ? depth : 3;
  const files = freshFiles(dir, since);
  if (left <= 0) return files;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const file of subagentTranscripts(path.join(dir, entry.name), since, left - 1)) files.push(file);
  }
  return files;
}

function claudeTranscriptFiles(since) {
  const root = path.join(configDir(), 'projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return [];
  }

  const files = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const full = path.join(root, dir.name);
    let entries = [];
    try {
      entries = fs.readdirSync(full, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // A session's subagents write their transcripts under
        // <project>/<session id>/subagents/. Same budget, different file, and
        // for a long time an Explore or Plan agent's whole spend went unseen.
        for (const file of subagentTranscripts(path.join(full, entry.name, 'subagents'), since)) {
          files.push({ file, project: dir.name });
        }
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      const file = path.join(full, entry.name);
      if (!fresh(file, since)) continue;
      files.push({ file, project: dir.name });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// The effort level in force right now
// ---------------------------------------------------------------------------
//
// Claude Code stamps `effort` on every assistant line it writes, which makes
// the transcript the only source that is always current. It follows /effort
// the moment the model answers; it exists for a session that has no status
// line at all, which is every VS Code window; and it can say "max", which
// settings.json is not allowed to hold at all.
//
// Reading it off settings.json instead is what made the panel insist on
// "xhigh" through a whole session running at max, and made a session with no
// status line show the setting rather than the session.
//
// Only the tail is read, and only whole lines from it are parsed, so a
// megabyte is enough however long the transcript grows.
const EFFORT_TAIL_BYTES = 1024 * 1024;
const EFFORT_TAIL_LINES = 60;

function sessionTranscriptFile(sessionId) {
  if (!sessionId) return null;
  const root = path.join(configDir(), 'projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return null;
  }
  let best = null;
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const file = path.join(root, dir.name, sessionId + '.jsonl');
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      continue;
    }
    // A session id is unique, but a resumed session can leave a copy under an
    // older project directory; the one being written to is the live one.
    if (!best || stat.mtimeMs > best.at) best = { file, at: stat.mtimeMs, size: stat.size };
  }
  return best;
}

// The newest effort this session ran at, with the time it was stamped, so a
// caller holding a status-line reading can take whichever is newer.
function liveEffort(sessionId) {
  const found = sessionTranscriptFile(sessionId);
  if (!found) return null;
  const from = Math.max(0, found.size - EFFORT_TAIL_BYTES);
  const text = readSlice(found.file, from, found.size).toString('utf8');
  const lines = text.split('\n');
  // The first line of a mid-file slice is a fragment, and the last is whatever
  // was half-written when the read happened. Neither is parsed.
  const start = Math.max(from > 0 ? 1 : 0, lines.length - EFFORT_TAIL_LINES);
  for (let i = lines.length - 1; i >= start; i -= 1) {
    const line = lines[i];
    if (!line || line.indexOf('"effort"') === -1) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (err) {
      // A fragment, or the half-written tail.
      continue;
    }
    if (!entry || typeof entry.effort !== 'string' || !entry.effort) continue;
    const at = Date.parse(entry.timestamp);
    return { effort: entry.effort, at: Number.isFinite(at) ? at : found.at };
  }
  return null;
}

// The model a session is running, from the tail of its own transcript. Every
// assistant line carries message.model, so this is the session's word rather
// than a setting's or another window's. The VS Code panel has no status line
// of its own to ask, and until this existed it borrowed the newest status-line
// slot on the machine - which on 2026-09-08 was a 19-hour-old Opus session,
// shown over a Fable one.
function liveModel(sessionId) {
  const found = sessionTranscriptFile(sessionId);
  if (!found) return null;
  const from = Math.max(0, found.size - EFFORT_TAIL_BYTES);
  const text = readSlice(found.file, from, found.size).toString('utf8');
  const lines = text.split('\n');
  const start = Math.max(from > 0 ? 1 : 0, lines.length - EFFORT_TAIL_LINES);
  for (let i = lines.length - 1; i >= start; i -= 1) {
    const line = lines[i];
    if (!line || line.indexOf('"assistant"') === -1 || line.indexOf('"model"') === -1) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (err) {
      continue;
    }
    const model = entry && entry.message && typeof entry.message.model === 'string' ? entry.message.model : null;
    if (!model || model === '<synthetic>') continue;
    const at = Date.parse(entry.timestamp);
    return { model, at: Number.isFinite(at) ? at : found.at };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The scan cache
// ---------------------------------------------------------------------------
//
// Reading every transcript from the start, every time, is what the scan used to
// do, and it stopped being affordable the moment workflows arrived. One machine
// here had 950 subagent transcripts totalling 114 MB inside the eight-day
// window, and a full scan took 200 seconds. The prompt hook is given ten, so it
// was killed on every prompt and the reported percentage froze at whatever a
// cached view last said: 3% while the account was at 32%.
//
// Transcripts are append-only, and almost all of them are finished. So each
// file's parsed events are kept, keyed by its size and mtime, and a file that
// has grown is read only from where the last read stopped. The offset is
// counted in bytes, at the last complete line, so a half-written tail is simply
// read again next time.
const SCAN_VERSION = 1;
// A day wider than the widest window anything asks for, so a report never wants
// an event the cache has just pruned.
const SCAN_KEEP_MS = 9 * DAY;
// Enough for weeks of heavy use; the oldest go first if it is ever reached.
const SCAN_MAX_EVENTS = 250000;

function scanFile() {
  return path.join(configDir(), 'usage-limits-scan.json');
}

function readScanCache() {
  const parsed = readJson(scanFile());
  if (!parsed || parsed.version !== SCAN_VERSION || !parsed.files || typeof parsed.files !== 'object') {
    return { version: SCAN_VERSION, files: {} };
  }
  return { version: SCAN_VERSION, files: parsed.files };
}

// Every state file the plugin shares between processes goes through here.
//
// Two windows run the same hooks at the same moment, and the status line runs
// every few hundred milliseconds. A plain writeFileSync is a truncate followed
// by a write, and a reader that lands between the two sees an empty or
// half-written file, parses nothing, and - for anything read, changed and
// written back, like the tally - then writes its own slot over everyone
// else's. Writing beside the file and renaming into place means every read
// sees either the old whole or the new whole. A rename Windows refuses leaves
// nothing behind, and the caller carries on with what is on disk.
function writeJsonAtomic(file, value) {
  const temp = file + '.' + process.pid + '.usage-limits-tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(value), 'utf8');
    fs.renameSync(temp, file);
    return true;
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch (gone) {
      // Nothing to clean up.
    }
    return false;
  }
}

// Losing the scan cache costs one slow scan, never a wrong number.
function writeScanCache(cache) {
  return writeJsonAtomic(scanFile(), cache);
}

// A byte range of a file, without pulling the whole thing into memory.
function readSlice(file, start, end) {
  const length = Math.max(0, end - start);
  if (!length) return Buffer.alloc(0);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    return Buffer.alloc(0);
  }
  try {
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const got = fs.readSync(fd, buffer, read, length - read, start + read);
      if (got <= 0) break;
      read += got;
    }
    return read === length ? buffer : buffer.subarray(0, read);
  } catch (err) {
    return Buffer.alloc(0);
  } finally {
    try {
      fs.closeSync(fd);
    } catch (err) {
      // Already closed.
    }
  }
}

// Events are kept as tuples rather than objects, because in a file of ten
// thousand of them the key names alone were two thirds of the bytes. The
// project is a property of the file, so it is stored once on the entry and put
// back on the way out.
const ROW_TURN = 0;
const ROW_REFUSAL = 1;

function whole(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function packEvent(event) {
  if (event.rejected) {
    const rejected = event.rejected;
    return [
      ROW_REFUSAL,
      event.at,
      event.sessionId || '',
      rejected.status || '',
      rejected.key || '',
      Number.isFinite(rejected.resetsAt) ? rejected.resetsAt : 0,
    ];
  }
  const parts = event.parts || {};
  return [
    ROW_TURN,
    event.at,
    whole(event.cost),
    whole(event.tokens),
    whole(parts.input),
    whole(parts.cacheWrite),
    whole(parts.cacheRead),
    whole(parts.output),
    whole(parts.reasoning),
    event.sidechain ? 1 : 0,
    event.model || '',
    event.sessionId || '',
    event.effort || '',
    event.dedupId || '',
  ];
}

function unpackEvent(row, project) {
  if (!Array.isArray(row)) return null;
  if (row[0] === ROW_REFUSAL) {
    return {
      at: row[1],
      model: '',
      effort: null,
      cost: 0,
      tokens: 0,
      parts: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0 },
      project: project || null,
      sessionId: row[2] || null,
      rejected: {
        status: row[3] || null,
        key: row[4] || null,
        resetsAt: row[5] || null,
      },
    };
  }
  const parts = {
    input: row[4],
    cacheWrite: row[5],
    cacheRead: row[6],
    output: row[7],
    reasoning: row[8],
  };
  return {
    at: row[1],
    dedupId: row[13] || null,
    model: row[10] || '',
    effort: row[12] || null,
    cost: row[2],
    tokens: row[3],
    parts,
    context: parts.input + parts.cacheRead + parts.cacheWrite,
    project: project || null,
    sessionId: row[11] || null,
    sidechain: row[9] === 1,
  };
}

// Split on newlines in the buffer itself rather than after decoding, because
// the offset has to be a byte count: a transcript is full of characters that
// are more than one byte, and counting them as one would drift the offset and
// silently drop turns. A trailing partial line is left unconsumed.
function parseSlice(buffer, project, baseOffset) {
  const events = [];
  let start = 0;
  let consumed = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] !== 0x0a) continue;
    const event = eventFrom(buffer.toString('utf8', start, i), null, project);
    if (event) events.push(event);
    start = i + 1;
    consumed = start;
  }
  return { events, offset: baseOffset + consumed };
}

// One file's events, reusing whatever the cache already holds of it.
function eventsForFile(entry, cache, keepFrom) {
  let stat;
  try {
    stat = fs.statSync(entry.file);
  } catch (err) {
    delete cache.files[entry.file];
    return null;
  }

  const cached = cache.files[entry.file];
  const usable =
    cached &&
    Array.isArray(cached.rows) &&
    Number.isFinite(cached.offset) &&
    Number.isFinite(cached.size) &&
    // Appended to, or untouched. Anything else - a rewrite, a truncation, a
    // clock that went backwards - is read again from the beginning, because
    // the offset can no longer be trusted to point where it says.
    stat.size >= cached.size &&
    cached.offset <= stat.size;

  if (usable && stat.size === cached.size && stat.mtimeMs === cached.mtimeMs) {
    return { rows: cached.rows, project: cached.project || entry.project, changed: false };
  }

  const from = usable ? cached.offset : 0;
  const parsed = parseSlice(readSlice(entry.file, from, stat.size), entry.project, from);
  const rows = (usable ? cached.rows : [])
    .concat(parsed.events.map(packEvent))
    .filter((row) => row[1] >= keepFrom);
  cache.files[entry.file] = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    offset: parsed.offset,
    project: entry.project,
    rows,
  };
  return { rows, project: entry.project, changed: true };
}

async function readClaudeEvents(since, options) {
  const opts = options || {};
  const startedAt = Date.now();
  // Zero is a real budget - spent before the first file - not "no budget";
  // absent or negative means unlimited. A test relies on zero being exact,
  // which Date.now() cannot promise: a scan of a few small files fits inside
  // one millisecond tick, so "elapsed > 0" stayed false all the way through
  // and the scan reported a complete total it had no right to. The budget is
  // measured on the monotonic sub-millisecond clock, and spent means reached.
  const clock = performance.now();
  const budgetMs = Number.isFinite(opts.budgetMs) && opts.budgetMs >= 0 ? opts.budgetMs : null;
  const keepFrom = Math.min(since, startedAt - SCAN_KEEP_MS);

  const files = claudeTranscriptFiles(since);
  // Newest first, so a scan that runs out of time has done the files that
  // describe the window running now rather than the ones from last Tuesday.
  const ordered = files
    .map((entry) => {
      let at = 0;
      try {
        at = fs.statSync(entry.file).mtimeMs;
      } catch (err) {
        at = 0;
      }
      return Object.assign({ at }, entry);
    })
    .sort((a, b) => b.at - a.at);

  const cache = opts.cache === false ? { version: SCAN_VERSION, files: {} } : readScanCache();
  const collected = [];
  const alive = new Set();
  let changed = false;
  let partial = false;

  for (const entry of ordered) {
    if (budgetMs !== null && performance.now() - clock >= budgetMs) {
      partial = true;
      break;
    }
    alive.add(entry.file);
    const result = eventsForFile(entry, cache, keepFrom);
    if (!result) {
      changed = true;
      continue;
    }
    if (result.changed) changed = true;
    collected.push(result);
  }

  // Files that have gone cold or been deleted, and anything left over the cap.
  if (opts.cache !== false) {
    let total = 0;
    for (const file of Object.keys(cache.files)) {
      const held = cache.files[file];
      if (!held || !Array.isArray(held.rows)) {
        delete cache.files[file];
        changed = true;
        continue;
      }
      // Past the window is gone whatever happened. An entry the scan merely
      // did not reach is dropped only when the scan was complete: a partial
      // one has not seen every file and must not be what decides they are dead.
      const tooOld = !(Number.isFinite(held.mtimeMs) && held.mtimeMs >= keepFrom);
      if (tooOld || (!partial && !alive.has(file))) {
        delete cache.files[file];
        changed = true;
        continue;
      }
      total += held.rows.length;
    }
    if (total > SCAN_MAX_EVENTS) {
      const oldest = Object.keys(cache.files).sort(
        (a, b) => (cache.files[a].mtimeMs || 0) - (cache.files[b].mtimeMs || 0)
      );
      for (const file of oldest) {
        if (total <= SCAN_MAX_EVENTS) break;
        total -= cache.files[file].rows.length;
        delete cache.files[file];
        changed = true;
      }
    }
    // Through a temporary file named for this process, so two windows running
    // the hook at the same moment cannot interleave a half-written cache.
    if (changed) writeScanCache(cache);
  }

  const seen = new Set();
  const events = [];
  for (const held of collected) {
    for (const row of held.rows) {
      if (row[1] < since) continue;
      const id = row[0] === ROW_TURN ? row[13] : '';
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const event = unpackEvent(row, held.project);
      if (event) events.push(event);
    }
  }

  events.sort((a, b) => a.at - b.at);
  if (partial) {
    // Non-enumerable, so nothing that iterates or serialises the events can
    // trip over it; the report reads it to say the correction may be short.
    Object.defineProperty(events, 'partial', { value: true, enumerable: false });
  }
  return events;
}

// A turn is one main-thread call, the unit the headroom is planned in. A
// subagent's calls spend the same budget, so they count in the money and the
// tokens, and are counted apart so they never inflate the turn figures.
function totals(events) {
  let cost = 0;
  let tokens = 0;
  let turns = 0;
  let subagentTurns = 0;
  const parts = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0 };
  for (const event of events) {
    cost += event.cost;
    tokens += event.tokens;
    if (event.sidechain) subagentTurns += 1;
    else turns += 1;
    if (event.parts) {
      parts.input += event.parts.input;
      parts.cacheWrite += event.parts.cacheWrite;
      parts.cacheRead += event.parts.cacheRead;
      parts.output += event.parts.output;
      parts.reasoning += event.parts.reasoning || 0;
    }
  }
  return { cost, tokens, turns, subagentTurns, parts };
}

function mainThread(events) {
  return (events || []).filter((event) => !event.sidechain);
}

// What each model actually cost, dearest first.
function byModel(events) {
  const rows = new Map();
  for (const event of events) {
    const id = event.model || 'unknown';
    if (!rows.has(id)) {
      rows.set(id, {
        model: id,
        estimated: !isKnownModel(id),
        turns: 0,
        tokens: 0,
        cost: 0,
        parts: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0 },
      });
    }
    const row = rows.get(id);
    row.turns += 1;
    row.tokens += event.tokens;
    row.cost += event.cost;
    if (event.parts) {
      row.parts.input += event.parts.input;
      row.parts.cacheWrite += event.parts.cacheWrite;
      row.parts.cacheRead += event.parts.cacheRead;
      row.parts.output += event.parts.output;
      row.parts.reasoning += event.parts.reasoning || 0;
    }
  }
  const list = [...rows.values()].sort((a, b) => b.cost - a.cost);
  const total = list.reduce((sum, row) => sum + row.cost, 0);
  for (const row of list) row.share = total > 0 ? row.cost / total : 0;
  return list;
}

const MIN_PACE_SAMPLE = 5;

// The middle turn, not the mean, and never from a sample so small that one
// turn defines the pace. A compaction or a big file read can cost ten times an
// ordinary turn, and treating that as "the" turn cost sends the headroom
// estimate swinging: a single $7 turn once put a 13% full window at nine turns
// left. Too few recent turns to be sure, so widen to the whole window.
// A turn that fanned out ten agents is real, and so is the budget it spent, but
// it should not price every remaining turn as though it will do the same. Five
// is generous enough to catch a habitually agent-heavy session and mean enough
// that one workflow does not flatten the estimate to nothing.
const SUBAGENT_FACTOR_MAX = 5;

function typicalTurnCost(recentEvents, windowEvents, allEvents, minSample) {
  const floor = Number.isFinite(minSample) ? minSample : MIN_PACE_SAMPLE;

  // What a turn costs is a fact about how you work, not about which budget it
  // is being measured against, so a thin window borrows from a wider sample
  // rather than inventing a figure from two turns. Subagent calls are left
  // out: they are small and many, and would make a turn look cheap.
  const sources = [recentEvents, windowEvents, allEvents];
  const tiers = sources.map((tier) => mainThread(tier));
  let pool = [];
  let source = null;
  for (let i = 0; i < tiers.length; i++) {
    if (tiers[i] && tiers[i].length >= floor) {
      pool = tiers[i];
      source = sources[i];
      break;
    }
    if (tiers[i] && tiers[i].length > pool.length) {
      pool = tiers[i];
      source = sources[i];
    }
  }
  const costs = pool
    .map((event) => event.cost)
    .filter((cost) => Number.isFinite(cost) && cost > 0)
    .sort((a, b) => a - b);
  if (!costs.length) return null;

  // The middle turn resists a freak one, which is the point, but it is the
  // wrong statistic for counting how many more turns fit. Turn costs are
  // skewed: most are cheap, a few are far dearer, and they get dearer still as
  // the context grows. The remaining budget is divided by the *average*, so
  // taking the middle one systematically promises more turns than there are.
  // Measured on the window that ran out on 2026-08-30: 182 turns promised, 110
  // actually left.
  //
  // Trimming both ends and averaging what is left keeps the resistance to a
  // single $7 turn while respecting the skew, and errs toward under-promising,
  // which is the safe direction for a budget.
  const cut = costs.length >= MIN_PACE_SAMPLE ? Math.max(1, Math.round(costs.length * 0.1)) : 0;
  const kept = cut > 0 ? costs.slice(cut, costs.length - cut) : costs;
  const middle = kept.length ? kept : costs;
  const perMainThreadTurn = middle.reduce((sum, cost) => sum + cost, 0) / middle.length;

  // And then the part that was missing, which is why a fan-out session was
  // promised four hundred turns and got sixty.
  //
  // Subagent calls are excluded from the sample above for a good reason: they
  // are small and many, and counting each as a turn makes a turn look cheap.
  // But their spend does not disappear - it comes out of the same window. A
  // turn that dispatches three research agents costs what the agents cost, and
  // measuring only its main-thread half prices it as though they were free.
  //
  // Rather than attributing each call to a parent turn, which the transcripts
  // do not reliably say, scale by how much of this pool's spend the main
  // thread actually accounts for. If subagents were two thirds of it, a turn
  // costs three times its visible half. Clamped, because a single enormous
  // fan-out should not price every future turn as another one.
  const total = sumCost(source);
  const visible = sumCost(pool);
  const factor = visible > 0 && total > visible ? Math.min(SUBAGENT_FACTOR_MAX, total / visible) : 1;
  return perMainThreadTurn * factor;
}

function sumCost(events) {
  let total = 0;
  for (const event of events || []) {
    if (event && Number.isFinite(event.cost) && event.cost > 0) total += event.cost;
  }
  return total;
}

function dominantEffort(events) {
  const counts = new Map();
  for (const event of events) {
    if (!event.effort) continue;
    counts.set(event.effort, (counts.get(event.effort) || 0) + 1);
  }
  let best = null;
  for (const entry of counts) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best ? best[0] : null;
}

// What a turn has actually cost at each effort level, measured separately.
//
// The blended cost per turn is the right answer to "what has this been
// costing" and the wrong one the moment the effort changes. An account that
// usually runs at medium and switches to ultra is priced at the medium rate
// until enough ultra turns have landed to drag the average up - and on a plan
// with a small window there is no "enough", because the window is gone first.
//
// That is not hypothetical either. A ChatGPT Plus account running gpt-6-astra
// at ultra effort emptied a whole five-hour window on one ordinary task, with
// this plugin reporting room the entire way, because every turn it had on
// record was a cheaper one.
//
// Subagent calls are left out for the same reason turns leave them out: they
// are errands, not turns, and averaging them in makes a turn look cheap.
function effortRates(events) {
  const rows = new Map();
  for (const event of events || []) {
    if (!event || event.rejected || event.sidechain) continue;
    if (!event.effort) continue;
    if (!rows.has(event.effort)) {
      rows.set(event.effort, { effort: event.effort, turns: 0, cost: 0, tokens: 0, output: 0, reasoning: 0 });
    }
    const row = rows.get(event.effort);
    const parts = event.parts || {};
    row.turns += 1;
    row.cost += Number.isFinite(event.cost) ? event.cost : 0;
    row.tokens += Number.isFinite(event.tokens) ? event.tokens : 0;
    row.output += Number.isFinite(parts.output) ? parts.output : 0;
    row.reasoning += Number.isFinite(parts.reasoning) ? parts.reasoning : 0;
  }
  return [...rows.values()]
    .map((row) =>
      Object.assign(row, {
        perTurn: row.turns ? row.cost / row.turns : null,
        // What the effort setting actually moves. Cost per turn is dominated by
        // how big the context happened to be, which is why measuring it that
        // way can report "low" as dearer than "ultra": a small ultra turn on a
        // short context really did cost less than a huge low-effort one. The
        // output is the part the setting controls, and it is the dear part -
        // eight times the weight of fresh input on Codex's own meter.
        outputPerTurn: row.turns ? row.output / row.turns : null,
        reasoningPerTurn: row.turns ? row.reasoning / row.turns : null,
      })
    )
    .sort((a, b) => (a.outputPerTurn || 0) - (b.outputPerTurn || 0));
}

// Enough turns at one effort to believe the figure at all.
const MIN_EFFORT_SAMPLE = 3;
// Dearer than the cheapest measured effort by this much before it is worth
// saying anything. Below it the setting is not what is spending the budget.
const EFFORT_DEARER_BY = 1.5;
// At or under this many turns left at the CURRENT effort, say so whether or
// not a cheaper effort has ever been measured.
const FEW_TURNS_AT_EFFORT = 12;

// The other agent's meter, for the surfaces that draw both.
//
// view.js is required at call time rather than at the top of the file: it
// requires this module back, and a cycle resolved at load time would hand it a
// half-built exports object. By the time a report is being built both are
// finished loading.
function codexBlock(now) {
  if (isCodex()) return null;
  try {
    if (!host.codexHasSessions()) return null;
    const display = require('./view.js');
    const other = codex.collect(now);
    const block = display.buildCodex({
      now,
      utilization: other.utilization,
      fetchedAtMs: other.snapshotFetchedAt,
      windowSpecs: other.windowSpecs,
      plan: other.plan,
      windowless: other.windowless,
      unreadable: other.unreadable,
    });
    return block.present ? block : null;
  } catch (err) {
    return null;
  }
}

// The warning that would have caught that incident: what the window holds at
// the effort actually set, rather than at the average of everything ever run.
function effortWarning(events, current, window) {
  if (!current || !window || window.stale) return null;
  const rates = effortRates(events);
  const here = rates.find((row) => row.effort === current);
  if (!here || here.turns < MIN_EFFORT_SAMPLE || !here.perTurn || here.perTurn <= 0) return null;

  // Compared on output per turn, because that is what the effort setting
  // moves; cost per turn is mostly a fact about how long the context was.
  const measure = (row) => (Number.isFinite(row.outputPerTurn) && row.outputPerTurn > 0 ? row.outputPerTurn : null);
  const mine = measure(here);
  const cheaper = mine
    ? rates.find(
        (row) =>
          row.effort !== current &&
          row.turns >= MIN_EFFORT_SAMPLE &&
          measure(row) &&
          mine / measure(row) >= EFFORT_DEARER_BY
      )
    : null;

  const turnsLeft =
    Number.isFinite(window.usdPerPercent) && window.usdPerPercent > 0 && Number.isFinite(window.percentLeft)
      ? Math.max(0, Math.floor((window.percentLeft * window.usdPerPercent) / here.perTurn))
      : null;

  // Nothing to say when the effort is not the dear one and the window is not
  // nearly out at it.
  if (!cheaper && (turnsLeft === null || turnsLeft > FEW_TURNS_AT_EFFORT)) return null;

  return {
    effort: current,
    perTurn: here.perTurn,
    sample: here.turns,
    turnsLeft,
    blendedTurnsLeft: Number.isFinite(window.turnsLeft) ? window.turnsLeft : null,
    outputPerTurn: here.outputPerTurn,
    cheaper: cheaper
      ? {
          effort: cheaper.effort,
          perTurn: cheaper.perTurn,
          outputPerTurn: cheaper.outputPerTurn,
          // How many times more the current setting writes per turn. This is
          // the number worth saying out loud: "ultra writes 6x the output of
          // medium" is what makes someone change it.
          multiple: measure(cheaper) ? mine / measure(cheaper) : null,
        }
      : null,
  };
}

// What the thinking actually cost, rather than what it is generally said to
// cost. Reasoning is billed as output, so it is priced at the output rate of
// whichever models did the thinking, weighted by how much each of them did.
//
// This deliberately does not try to tell an `ultrathink` turn from a high
// effort setting from a model that simply chose to think. They are the same
// spend and the same lever, and the transcript does not reliably separate them
// anyway. What matters is how much of the bill is reasoning.
function reasoningSpend(models, tokens) {
  const total = tokens && Number.isFinite(tokens.reasoning) ? tokens.reasoning : 0;
  const output = tokens && Number.isFinite(tokens.output) ? tokens.output : 0;
  if (total <= 0 || output <= 0) return null;

  let cost = 0;
  let priced = 0;
  for (const row of models || []) {
    const amount = row.parts && Number.isFinite(row.parts.reasoning) ? row.parts.reasoning : 0;
    if (amount <= 0) continue;
    cost += (amount * rateFor(row.model).output) / 1e6;
    priced += amount;
  }

  return {
    tokens: total,
    shareOfOutput: total / output,
    // Only claim a price when the models that did the thinking were priced.
    cost: priced > 0 ? cost : null,
  };
}

// Which project directory the spend went to. Claude Code names these after
// the working directory, so they are recognisable even though the mangling
// is not reversible.
function byProject(events) {
  const rows = new Map();
  for (const event of events) {
    const id = event.project || 'unknown';
    if (!rows.has(id)) rows.set(id, { project: id, turns: 0, tokens: 0, cost: 0 });
    const row = rows.get(id);
    row.turns += 1;
    row.tokens += event.tokens;
    row.cost += event.cost;
  }
  const list = [...rows.values()].sort((a, b) => b.cost - a.cost);
  const total = list.reduce((sum, row) => sum + row.cost, 0);
  for (const row of list) row.share = total > 0 ? row.cost / total : 0;
  return list;
}

// Keep the tail, which is the part that identifies the project.
function shortenProject(name, width) {
  const value = String(name || '');
  if (value.length <= width) return value;
  return '...' + value.slice(value.length - (width - 3));
}

// Paid credits sit behind the plan allowance. Two blocks describe them and
// either can be absent, so read both and prefer whichever actually carries a
// number.
function creditsFrom(utilization) {
  const extra = (utilization && utilization.extra_usage) || null;
  const spend = (utilization && utilization.spend) || null;
  if (!extra && !spend) return null;

  const money = (amount) => {
    if (!amount || typeof amount.amount_minor !== 'number') return null;
    const exponent = typeof amount.exponent === 'number' ? amount.exponent : 2;
    return amount.amount_minor / Math.pow(10, exponent);
  };

  const used = money(spend && spend.used);
  const limit = money(spend && spend.limit);
  const percent =
    extra && typeof extra.utilization === 'number'
      ? extra.utilization
      : spend && typeof spend.percent === 'number'
        ? spend.percent
        : null;

  return {
    enabled: Boolean((extra && extra.is_enabled) || (spend && spend.enabled)),
    everEnabled: Boolean(extra && extra.credits_ever_enabled),
    limitReached: Boolean(extra && extra.spend_limit_reached),
    used,
    limit: limit === null && extra ? extra.monthly_limit : limit,
    percent,
    currency: (spend && spend.used && spend.used.currency) || (extra && extra.currency) || 'USD',
    disabledReason: (extra && extra.disabled_reason) || (spend && spend.disabled_reason) || null,
  };
}

// Turn cost is not a single number, it is a spread: a turn that reads three
// files costs many times one that answers from context. A median alone
// under-promises on the expensive half, so carry a high end too.
function callPercentiles(events) {
  const costs = (events || [])
    .map((event) => event.cost)
    .filter((cost) => Number.isFinite(cost) && cost > 0)
    .sort((a, b) => a - b);
  if (!costs.length) return null;

  const at = (fraction) => costs[Math.min(costs.length - 1, Math.floor(fraction * costs.length))];
  return { median: at(0.5), high: at(0.8), sample: costs.length };
}

function costPercentiles(events) {
  return callPercentiles(mainThread(events));
}

// What a turn of each model family has actually cost on this machine.
//
// The account's snapshot has no model dimension at all. It says a window is at
// 88 per cent and never says whose turns put it there, so the report could say
// how much room was left and not what that room would buy. Every transcript
// line carries its model, which is the half the snapshot is missing.
//
// Cost is measured over main-thread turns, because a turn of headroom means a
// main-thread turn everywhere else in this file. A family that has only ever
// run as a subagent has none to measure - Sonnet on this machine had 114 calls
// and not one turn - and pricing it at nothing would hand back an unlimited
// budget, so it is priced per call instead and the row says so.
function modelSpend(events) {
  const byFamily = new Map();
  for (const event of events || []) {
    const family = familyOf(event.model);
    if (!family) continue;
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family).push(event);
  }

  const rows = [];
  for (const [family, own] of byFamily) {
    const spent = totals(own);
    const main = costPercentiles(own);
    const rates = main || callPercentiles(own);
    rows.push({
      family,
      calls: own.length,
      turns: spent.turns,
      usd: spent.cost,
      tokens: spent.tokens,
      usdPerTurn: rates ? rates.median : null,
      sample: rates ? rates.sample : 0,
      // True when the figure prices a subagent call rather than a turn.
      perCall: !main,
    });
  }
  return rows.sort((a, b) => b.usd - a.usd);
}

// Which window a family's spend lands in: its own weekly where the account
// gives it one, and the shared weekly otherwise.
function windowForFamily(windows, family) {
  const own = (windows || []).find((w) => w && w.family === family);
  if (own) return own;
  return (windows || []).find((w) => w && w.key === 'seven_day') || null;
}

// Too few turns to price one. The figure is divided into the whole remaining
// budget, so an error in it is multiplied up rather than averaged away.
const MIN_MODEL_SAMPLE = 5;

// What the room that is left buys, counted in turns of each model.
//
// Families that share the weekly window are alternatives, not additions: each
// row says what the same remaining room would buy if it all went on that model.
// A family with a weekly of its own is the exception, and it is the case worth
// knowing about, because it is the one where changing model changes which wall
// the work is walking towards.
function modelHeadroom(windows, events, families, remembered) {
  return modelSpend(events).map((row) => {
    const window = windowForFamily(windows, row.family);
    const learned = remembered && remembered[row.family];
    // A handful of turns prices a turn badly. What was measured when there was
    // a proper sample is better evidence than what this week happens to hold.
    const thin = row.sample < MIN_MODEL_SAMPLE;
    const canRemember =
      thin && Boolean(learned) && Number.isFinite(learned.usdPerTurn) && learned.usdPerTurn > 0 &&
      // A remembered per-call price is not a turn price either, whatever it is
      // worth for delegation. See below.
      !learned.perCall;
    const usdPerTurn = canRemember ? learned.usdPerTurn : row.usdPerTurn;
    const perCall = canRemember ? Boolean(learned.perCall) : row.perCall;
    // No turn count for a model that has never taken a turn.
    //
    // A family that has only ever run as a subagent has errands to price, not
    // turns: 114 Sonnet calls here averaged under two cents because they were
    // one-shot lookups, and dividing the remaining budget by that promised
    // twenty-two thousand Sonnet turns. Those turns would not be doing the work
    // the Opus turns are doing, and the error is in the direction that promises
    // room, which is the direction that gets a session cut off mid-edit. The
    // row still says what the model has cost; it does not project from it.
    //
    // Nor against a window that has already rolled over. Its remaining money
    // describes the allowance the stale reading was taken from, not the one
    // running now, and dividing by a turn price turns that into a confident
    // count of turns nobody has: a weekly past its reset offered five hundred.
    const turnsLeft =
      !perCall &&
      window &&
      !window.stale &&
      Number.isFinite(window.remainingUSD) &&
      Number.isFinite(usdPerTurn) &&
      usdPerTurn > 0
        ? Math.max(0, Math.floor(window.remainingUSD / usdPerTurn))
        : null;
    return Object.assign({}, row, {
      windowKey: window ? window.key : null,
      windowLabel: window ? window.label : null,
      // True when this family has a weekly of its own rather than sharing.
      ownWindow: Boolean(window && window.family),
      // False when the window is one this agent cannot spend into anyway.
      windowApplies: !window || window.applies !== false,
      inUse: !families || !families.size || families.has(row.family),
      usdPerTurn,
      perCall,
      // True when the price came off the record rather than this week's turns.
      remembered: Boolean(canRemember),
      turnsLeft,
    });
  });
}

// What a job of this many turns would take out of one window.
function forecastWindow(window, turns, rates) {
  if (!window || !rates || !window.usdPerPercent || window.stale) return null;
  if (!Number.isFinite(turns) || turns <= 0) return null;

  const usdLow = turns * rates.median;
  const usdHigh = turns * rates.high;
  const percentLow = usdLow / window.usdPerPercent;
  const percentHigh = usdHigh / window.usdPerPercent;

  return {
    key: window.key,
    label: window.label,
    turns,
    usdLow,
    usdHigh,
    percentLow,
    percentHigh,
    // The pessimistic cost is what decides whether it fits, so the room left
    // over is measured against that.
    leaves: window.percentLeft - percentHigh,
    fits: percentHigh <= window.percentLeft,
    tight: percentHigh > window.percentLeft * 0.75 && percentHigh <= window.percentLeft,
  };
}

const CONCURRENT_WINDOW_MS = 15 * MINUTE;

// Sessions that have spent something recently. Two Claude Code windows share
// one limit, so headroom measured in "turns" is optimistic when another one is
// also working: the budget drains while you are not the one spending it.
function activeSessions(events, now, windowMs) {
  const since = now - (Number.isFinite(windowMs) ? windowMs : CONCURRENT_WINDOW_MS);
  const bySession = new Map();

  for (const event of events) {
    if (event.at < since || event.at > now) continue;
    const id = event.sessionId || 'unknown';
    if (!bySession.has(id)) bySession.set(id, { sessionId: id, turns: 0, cost: 0 });
    const row = bySession.get(id);
    row.turns += 1;
    row.cost += event.cost;
  }

  const rows = [...bySession.values()].sort((a, b) => b.cost - a.cost);
  const total = rows.reduce((sum, row) => sum + row.cost, 0);
  for (const row of rows) row.share = total > 0 ? row.cost / total : 0;
  return rows;
}

// The slice of the shared budget this session is actually getting. With
// another session spending half of it, only half those turns are yours.
//
// Past spend says how the budget has been going, not how it will go. A
// session that has only just started has almost none of it, and dividing its
// headroom by that share once turned 208 turns into "about 6 turns left" two
// tool calls into a session at 13 per cent used. So an equal split is the
// floor: a measured share can raise it, never lower it. `activeCount` is how
// many sessions are open, which can exceed how many have spent yet; the split
// is among all of them.
function shareOf(sessions, sessionId, activeCount) {
  const spent = sessions || [];
  const n = Math.max(spent.length, Number.isFinite(activeCount) ? activeCount : 0);
  if (n < 2) return 1;
  const equal = 1 / n;
  // One session's spend is not a comparison. Until a second one has spent,
  // being the only one on record says nothing about who owns the budget.
  if (spent.length < 2) return equal;
  const mine = spent.find((row) => row.sessionId === sessionId);
  if (!mine || !(mine.share > 0)) return equal;
  return Math.max(mine.share, equal);
}

// What a point of a window costs is a property of the plan, not of the moment,
// so it should be learned once from a good sample rather than re-derived from
// whatever slice happens to be to hand. A thin baseline prices a point badly
// and every correction built on it inherits the error: a 24 minute old
// snapshot once turned a window truly at 70 per cent into a confident 82.
// Kept beside whichever agent it describes. The two hosts happen to use the
// same window keys, so a shared file would price a Codex point with what a
// Claude point costs and be wrong on both.
function calibrationFile() {
  const dir = isCodex() ? codex.homeDir() : configDir();
  return path.join(dir, 'usage-limits-calibration.json');
}

function readCalibration() {
  try {
    const parsed = JSON.parse(fs.readFileSync(calibrationFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function writeCalibration(all) {
  try {
    writeJsonAtomic(calibrationFile(), all);
  } catch (err) {
    // Losing it costs accuracy on the next thin baseline, nothing more.
  }
}

// What each model has cost, kept so the next session does not have to have
// spent anything to know.
//
// The transcripts only answer for as long as they are on disk and as far back
// as the scan reaches, which is eight days. A session that opens on a model it
// has not used this week would otherwise have no price for it at all, and what
// Sonnet would buy is worth answering before the first Sonnet turn rather than
// after. One entry per family, so it cannot grow.
//
// It is stamped with the plan and read back through the same guard as the
// window calibration. What a turn costs is a fact about the model; what it buys
// is a fact about the allowance, and that moves when the plan does.
function modelRecordFile() {
  const dir = isCodex() ? codex.homeDir() : configDir();
  return path.join(dir, 'usage-limits-models.json');
}

function readModelRecord() {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelRecordFile(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

function writeModelRecord(all) {
  try {
    writeJsonAtomic(modelRecordFile(), all);
  } catch (err) {
    // The record is a convenience for a thin week, not a source of truth.
  }
}

// The measurement to keep. Deliberately the freshest adequate one rather than
// the largest: what a turn costs drifts as a session's context grows, so an old
// figure with a big sample behind it is not the better answer, only the better
// attested one.
function modelSamples(headroom, previous) {
  const kept = Object.assign({}, previous || {});
  let changed = false;
  for (const row of headroom || []) {
    if (row.remembered) continue;
    if (!Number.isFinite(row.usdPerTurn) || row.usdPerTurn <= 0) continue;
    if (row.sample < MIN_MODEL_SAMPLE) continue;
    // Rounded before comparing, so a fraction of a cent of drift does not
    // rewrite the file on every prompt.
    const usdPerTurn = Math.round(row.usdPerTurn * 1e6) / 1e6;
    const before = kept[row.family];
    if (
      before &&
      before.usdPerTurn === usdPerTurn &&
      before.perCall === Boolean(row.perCall) &&
      before.sample === row.sample
    ) {
      continue;
    }
    kept[row.family] = { usdPerTurn, sample: row.sample, perCall: Boolean(row.perCall) };
    changed = true;
  }
  return { models: kept, changed };
}

// Everything learned about a budget belongs to the plan it was learned on.
//
// A point of a window is a share of an allowance, so changing the allowance
// changes what a point is worth, and every figure derived from the old one is
// then wrong by the ratio between the plans. Upgrading Pro to Max 5x is roughly
// a fivefold move: a calibration saying a point costs $0.40 keeps being applied
// to a point now worth several times that, and the turn estimates built on it
// are wrong in the direction that promises room there is not.
//
// There is no timestamp anywhere that says when the plan changed.
// `subscriptionCreatedAt` is the original signup, not the upgrade. So the plan
// is stamped onto the calibration instead, and a stamp that no longer matches
// is itself the proof that it moved.
function calibrationForPlan(all, planId) {
  const kept = {};
  let dropped = false;
  for (const key of Object.keys(all || {})) {
    const entry = all[key];
    if (!entry || typeof entry !== 'object') continue;
    // A stamp that no longer matches is proof the plan moved, and worth saying
    // so: the reading on disk was measured against the other allowance too.
    if (entry.plan && planId && entry.plan !== planId) {
      dropped = true;
      continue;
    }
    // An entry saved before the stamp existed cannot be shown to belong to this
    // plan. Keeping it would be assuming the answer, and the cost of assuming
    // wrong is the whole bug this guards: a point priced for Pro applied to a
    // Max window, promising several times the turns that exist. It is dropped
    // instead, which costs one relearn and says "unknown" in the meantime.
    // Unknown is not claimed as a plan change, because it is not evidence of
    // one; every install upgrading to this version passes through here once.
    if (!entry.plan && planId) continue;
    kept[key] = entry;
  }
  return { learned: kept, planChanged: dropped };
}

function stampPlan(all, planId) {
  if (!planId) return all;
  const stamped = {};
  for (const key of Object.keys(all || {})) {
    stamped[key] = Object.assign({}, all[key], { plan: planId });
  }
  return stamped;
}

// A sample is better when it rests on more of the meter. Percentages read in
// whole numbers, so a reading at 1% prices a point against a bracket that is
// mostly rounding, while one at 60% divides by a number that means something.
// Turn count only breaks the tie: it says how much local spend sat behind the
// reading, not how precise the denominator was, and preferring it outright is
// how a 44-turn baseline read at 1% once beat every honest sample after it.
// Which of two prices to keep, and which to write back to disk.
//
// A wider reading is a better measurement, so percent still ranks - but only
// between two readings that are measurements at all. An entry learned at either
// end of the meter is not one, and ranking on percent alone meant a price
// learned at 100 could never be displaced by an honest one from the middle:
// 100 is the highest number there is, so it won every comparison and was
// written back for ever. The file could not heal itself even once the readers
// had started ignoring it.
function betterCalibration(current, candidate) {
  const fresh = usableCalibration(candidate);
  const held = usableCalibration(current);
  if (!fresh) return held || null;
  if (!held || !Number.isFinite(held.turns)) return fresh;
  if (Number.isFinite(fresh.percent) && Number.isFinite(held.percent) && fresh.percent !== held.percent) {
    return fresh.percent > held.percent ? fresh : held;
  }
  return fresh.turns > held.turns ? fresh : held;
}

// Everything the report needs about one limit window.
function buildWindow(spec, snapshot, events, now, options) {
  const extra = options || {};
  const rawPercent =
    snapshot && typeof snapshot.utilization === 'number' ? snapshot.utilization : null;
  const resetsAt = snapshot && snapshot.resets_at ? Date.parse(snapshot.resets_at) : null;
  const hasReset = Number.isFinite(resetsAt);
  const start = Number.isFinite(extra.windowStart)
    ? extra.windowStart
    : hasReset
      ? resetsAt - spec.span
      : now - spec.span;

  const inWindow = events.filter((event) => event.at >= start && event.at <= now);
  const spent = totals(inWindow);

  const recentStart = Math.max(start, now - HOUR);
  const recentEvents = events.filter((event) => event.at >= recentStart && event.at <= now);
  const recent = totals(recentEvents);
  const recentHours = Math.max((now - recentStart) / HOUR, 1 / 60);

  const window = {
    key: spec.key,
    label: spec.label,
    percentUsed: rawPercent,
    percentLeft: rawPercent === null ? null : Math.max(0, 100 - rawPercent),
    resetsAt: hasReset ? resetsAt : null,
    msToReset: hasReset ? resetsAt - now : null,
    windowStart: start,
    spanMs: spec.span,
    spentUSD: spent.cost,
    spentTokens: spent.tokens,
    turns: spent.turns,
    subagentTurns: spent.subagentTurns,
    recentTurns: recent.turns,
    recentUSDPerHour: recent.cost / recentHours,
    recentUSDPerTurn: recent.turns ? recent.cost / recent.turns : null,
    usdPerPercent: null,
    remainingUSD: null,
    percentPerHour: null,
    percentPerTurn: null,
    turnsLeft: null,
    headroomMs: null,
    coarse: false,
    stale: false,
    // True when the percentage was rebuilt from local history because the
    // snapshot had gone stale, rather than read from the snapshot itself.
    estimated: Boolean(extra.estimated),
    // True when spend since the snapshot was added to its reading.
    adjusted: false,
    pointsSinceSnapshot: 0,
    // Set when spend since the snapshot could not be priced sensibly.
    correctionUnreliable: false,
    // The price-per-point this window derived from its own baseline.
    calibration: null,
    // True when the bucket quoted its limit in dollars, so the price of a
    // point is known rather than learned.
    metered: false,
    // What the account's own list of limits says about this one.
    severity: null,
    isActive: false,
    scoped: false,
    // The model family this window caps, when it caps one. Set from the spec
    // here for the bucket-table weeklies, and again by the caller for the
    // per-model limits that only exist in the account's own `limits` list.
    family: spec.family || null,
    // Whether this session's models spend into it. Filled in by
    // markApplicable once the models in use are known; assume they do until
    // then, so a reader that never marks them behaves exactly as before.
    applies: true,
    verdict: 'unknown',
  };

  // Worked out before anything reads it: the adjustment below and the verdict
  // chain both branch on whether this window has already rolled over.
  window.stale = hasReset && resetsAt <= now;

  // Calibrate against this account: how many dollars of measured traffic
  // moved the meter one point. A rebuilt window hands its own figure in,
  // because rounding to 0% would otherwise leave it unpriced and drop it out
  // of the binding choice just after a reset.
  // The snapshot is a reading from a moment in the past, not from now. Spend
  // since then is real and uncounted, and with several sessions running it adds
  // up fast: forty points went missing in nine minutes once, so a window that
  // was truly at 88% was reported at 49%. Calibrate on spend up to the reading
  // only, or the very spend being accounted for inflates the price per point
  // and shrinks its own correction.
  // A reading with no reset time cannot be told apart from a current one by
  // looking at it, so age is the only guide. Once the snapshot is older than
  // the window itself, whatever it says describes a window that has since
  // rolled over at least once, and quoting it as current is how a long gap
  // ends up reported as a full budget.
  window.snapshotOlderThanWindow =
    Number.isFinite(extra.fetchedAt) && now - extra.fetchedAt >= spec.span;

  let percent = rawPercent;
  let sinceSnapshot = 0;
  if (
    rawPercent !== null &&
    !window.stale &&
    Number.isFinite(extra.fetchedAt) &&
    extra.fetchedAt > start
  ) {
    const upTo = totals(inWindow.filter((e) => e.at <= extra.fetchedAt));
    const after = totals(inWindow.filter((e) => e.at > extra.fetchedAt));

    // The baseline has to be worth something. Pricing a point off two or three
    // turns makes it far too cheap, and every dollar spent since then is then
    // divided by that, which is how a window truly at 55% got corrected all the
    // way to a confident 100.
    //
    // A reading of exactly 0 cannot price itself at all: there is no meter
    // movement to divide the spend by. That used to end the correction here,
    // which was the worst place to stop, because 0% is what a window reads
    // right after a reset and therefore what a snapshot most often goes stale
    // holding. The learned price covers it: what a point costs is a property
    // of the plan, not of this reading.
    const selfPriced =
      rawPercent >= MIN_BASELINE_PERCENT &&
      rawPercent <= MAX_BASELINE_PERCENT &&
      upTo.cost > 0 &&
      upTo.turns >= MIN_BASELINE_TURNS
        ? { usdPerPercent: upTo.cost / rawPercent, turns: upTo.turns, percent: rawPercent }
        : null;
    // A metered window has nothing to learn: its price per point is stated.
    if (selfPriced && !extra.metered) window.calibration = selfPriced;

    // A remembered price is only as good as the reading it was learned from,
    // and both ends of the meter lie. One gate, shared with the headroom
    // arithmetic below.
    const usable = usableCalibration(extra.knownCalibration);
    // Trust the better-measured of the two, whichever that is; a stated price
    // beats both.
    const stated =
      extra.metered && Number.isFinite(extra.usdPerPercent) && extra.usdPerPercent > 0
        ? { usdPerPercent: extra.usdPerPercent, turns: Infinity }
        : null;
    const chosen =
      stated ||
      (selfPriced && usable ? betterCalibration(usable, selfPriced) : selfPriced || usable);

    if (after.cost > 0 && chosen) {
      const pricePerPoint = chosen.usdPerPercent;
      sinceSnapshot = after.cost / pricePerPoint;

      // Same rule as a rebuild: past this it is the calibration that is full,
      // not the window. Better to leave the reading uncorrected and say the
      // snapshot is old than to assert a budget that is gone.
      if (rawPercent + sinceSnapshot > SATURATION_LIMIT) {
        // Keep the size of the overshoot: the brief needs it to say how far
        // past the snapshot the spending has gone, instead of repeating the
        // snapshot figure for hours as if it were current.
        window.pointsBeyondSnapshot = Math.round(sinceSnapshot);
        sinceSnapshot = 0;
        window.correctionUnreliable = true;
      } else if (sinceSnapshot >= 1) {
        percent = Math.min(100, Math.round(rawPercent + sinceSnapshot));
        window.adjusted = true;
        window.pointsSinceSnapshot = Math.round(sinceSnapshot);
        window.percentUsed = percent;
        window.percentLeft = Math.max(0, 100 - percent);
      }
    }
  }

  // Pricing a point off this window's own spend only works when this machine
  // did most of that spending. It often has not: another device, a cloud task,
  // or simply a window that opened before the local history did, and then a
  // meter reading 61% divides by almost nothing and every remaining point looks
  // free. The visible symptom is a window with plenty left reporting one turn
  // of headroom, which is worse advice than reporting none.
  // A couple of turns cannot account for a meter already well into the window,
  // so when the two disagree that badly it is the local history that is
  // incomplete, not the meter.
  const thin = spent.turns < MIN_BASELINE_TURNS && percent >= UNEXPLAINED_PERCENT;
  // The same rounding bracket again, in the optimistic direction this time: a
  // window reading 1% divided a full hour of spend by one and priced the
  // remaining 99 points at thousands of dollars. Below the floor the learned
  // price takes over through the fallback chain.
  // The ceiling is the same rule the other way up: at 100 the meter has
  // stopped counting, so the spend past it divides against points that were
  // never registered and every remaining point looks cheaper than it is.
  const measured =
    percent !== null &&
    percent >= MIN_BASELINE_PERCENT &&
    percent <= MAX_BASELINE_PERCENT &&
    spent.cost > 0 &&
    !thin;
  const derived = measured ? spent.cost / percent : null;
  const known = usableCalibration(extra.knownCalibration);
  const metered =
    Boolean(extra.metered) && Number.isFinite(extra.usdPerPercent) && extra.usdPerPercent > 0;
  const priced = metered
    ? extra.usdPerPercent
    : derived !== null
      ? derived
      : Number.isFinite(extra.usdPerPercent) && extra.usdPerPercent > 0
        ? extra.usdPerPercent
        : known && Number.isFinite(known.usdPerPercent) && known.usdPerPercent > 0
          ? known.usdPerPercent
          : null;
  window.metered = metered;

  // The API reports whole numbers, so a low reading is a wide bracket. A fact
  // about the reading, not the pricing, so it is set whether or not a price
  // per point could be found.
  window.coarse = percent !== null && percent < MIN_BASELINE_PERCENT;

  if (percent !== null && priced !== null) {
    window.usdPerPercent = priced;
    window.remainingUSD = window.usdPerPercent * window.percentLeft;

    const perTurn = typicalTurnCost(recentEvents, inWindow, events, MIN_PACE_SAMPLE);
    window.percentPerTurn = perTurn === null ? null : perTurn / window.usdPerPercent;
    window.typicalTurnUSD = perTurn;
    window.percentPerHour = window.recentUSDPerHour / window.usdPerPercent;
    if (window.percentPerTurn !== null && window.percentPerTurn > 0) {
      window.turnsLeft = Math.floor(window.percentLeft / window.percentPerTurn);
    }
    if (window.percentPerHour > 0) {
      window.headroomMs = (window.percentLeft / window.percentPerHour) * HOUR;
    }
  }

  // A reset time in the past means the window already turned over and the
  // cached percentage describes a window that no longer exists. Reporting it
  // as current would claim the budget is gone when it has just come back.
  if (window.stale) {
    window.remainingUSD = null;
    window.turnsLeft = null;
    window.headroomMs = null;
    window.percentPerHour = null;
    window.percentPerTurn = null;
  }

  if (percent === null) window.verdict = 'unknown';
  else if (window.stale) window.verdict = 'rolled-over';
  else if (percent >= 100) window.verdict = 'exhausted';
  else if (window.headroomMs === null) window.verdict = 'idle';
  else if (window.msToReset === null) window.verdict = 'burning';
  else if (window.headroomMs >= window.msToReset) window.verdict = 'resets-first';
  else window.verdict = 'runs-out';

  return window;
}

// The most recent time the account actually refused work, per window. This is
// ground truth: not an estimate of where the budget stands but a record of it
// having run out, with the window named and its reset time attached.
function lastRejections(events) {
  const byKey = new Map();
  for (const event of events || []) {
    const rejected = event && event.rejected;
    if (!rejected || rejected.status !== 'rejected') continue;
    const key = rejected.key || 'unknown';
    const seen = byKey.get(key);
    if (!seen || event.at > seen.at) {
      byKey.set(key, { key, at: event.at, resetsAt: rejected.resetsAt });
    }
  }
  return byKey;
}

// Which window binds is about what stops you soonest. It says nothing about
// what stopping costs. Running out of a 5-hour window waits hours; running out
// of the weekly one waits days. So a weekly window near the wall is worth
// hearing about even while a shorter window binds.
const CRITICAL_PERCENT = 85;

function criticalOthers(windows, bindingKey, threshold) {
  const limit = Number.isFinite(threshold) ? threshold : CRITICAL_PERCENT;
  return (windows || []).filter(
    (w) =>
      w &&
      w.key !== bindingKey &&
      !w.stale &&
      // A full window that this session cannot spend into is not a warning, it
      // is someone else's news. Told to weigh it, the only thing an agent can
      // do about it is less work, against a limit its work never touches.
      w.applies !== false &&
      w.percentUsed !== null &&
      w.percentUsed >= limit
  );
}

// The window that will stop the work first.
function bindingWindow(windows) {
  // A per-model weekly for a model that is not running cannot be the window
  // that stops the work, however full it is - and the account's own is_active
  // flag says nothing about which model this session happens to be using, so
  // it must not promote one either. Kept as a fallback in the impossible case
  // that every window is a model's, so this never returns nothing.
  // Ordered this way round on purpose: the fallback has to fire when there is
  // no readable window left after suppression, not merely no window. Testing
  // the unfiltered list first returned nothing at all where a suppressed
  // per-model weekly was the only window carrying a reading.
  const readable = windows.filter((w) => w && w.percentUsed !== null);
  const relevant = readable.filter((w) => w.applies !== false);
  const known = relevant.length ? relevant : readable;
  // Prefer windows we can still trust; fall back only if every one is stale.
  const fresh = known.filter((w) => !w.stale);
  const live = fresh.length ? fresh : known;
  if (!live.length) return null;

  // How soon this window stops the work. A window with no pace estimate is
  // ranked by how full it is instead, because a nearly full window must never
  // be passed over merely because nothing has been spent in it lately.
  const soonest = (w) => {
    if (Number.isFinite(w.headroomMs)) return w.headroomMs;
    return w.percentUsed >= 90 ? 0 : Infinity;
  };

  return live.reduce((best, w) => {
    const mine = soonest(w);
    const theirs = soonest(best);
    if (mine !== theirs) return mine < theirs ? w : best;

    // Equally urgent by our own measure: the account says which limit it is
    // enforcing, and that is worth more than a rule of thumb.
    if (Boolean(w.isActive) !== Boolean(best.isActive)) return w.isActive ? w : best;

    // Equally urgent: the shorter window is the one hit first in practice, so
    // the 5-hour limit wins a tie against the weekly one.
    const myspan = Number.isFinite(w.spanMs) ? w.spanMs : Infinity;
    const theirspan = Number.isFinite(best.spanMs) ? best.spanMs : Infinity;
    if (myspan !== theirspan) return myspan < theirspan ? w : best;

    return w.percentUsed > best.percentUsed ? w : best;
  });
}

function formatDuration(ms) {
  if (ms === null || !Number.isFinite(ms)) return '-';
  if (ms <= 0) return 'now';
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return minutes + 'm';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? hours + 'h ' + rest + 'm' : hours + 'h';
  const days = Math.floor(hours / 24);
  return days + 'd ' + (hours % 24) + 'h';
}

function formatClock(ms) {
  if (!Number.isFinite(ms)) return '-';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatUSD(value) {
  if (value === null || !Number.isFinite(value)) return '-';
  if (value >= 100) return '$' + Math.round(value);
  if (value >= 1) return '$' + value.toFixed(2);
  return '$' + value.toFixed(3);
}

// Money to two places. Three below a dollar is right for a per-turn price and
// wrong for a total someone reads after every reply.
function formatMoney(value) {
  if (value === null || !Number.isFinite(value)) return '-';
  if (value >= 100) return '$' + Math.round(value);
  return '$' + value.toFixed(2);
}

function formatTokens(value) {
  if (!Number.isFinite(value)) return '-';
  if (value >= 1e9) return (value / 1e9).toFixed(1) + 'B';
  if (value >= 1e6) return (value / 1e6).toFixed(1) + 'M';
  if (value >= 1e3) return Math.round(value / 1e3) + 'k';
  return String(Math.round(value));
}

function formatCount(value) {
  if (value === null || !Number.isFinite(value)) return '-';
  return Math.round(value).toLocaleString('en-US');
}

function pad(text, width) {
  const value = String(text);
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function padLeft(text, width) {
  const value = String(text);
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

// Pro, Max 5x, Max 20x, Team and Enterprise all have different amounts of
// room, which changes the advice even though it does not change the
// arithmetic. The window maths calibrates itself either way.
function detectPlan(oauth) {
  const account = oauth || {};
  const family = String(account.organizationType || '')
    .replace(/^claude_/, '')
    .toLowerCase();
  const tier = String(account.userRateLimitTier || account.organizationRateLimitTier || '');

  let id = family || 'unknown';
  if (family === 'max') id = RATE_LIMIT_TIERS[tier] || 'max';
  if (!PLANS[id]) id = 'unknown';

  const plan = PLANS[id];
  return {
    id,
    tier: tier || null,
    // Show the raw value rather than "unknown" when it is a name we have
    // simply not seen before.
    label: id === 'unknown' && family ? family : plan.label,
    advice: plan.advice,
  };
}

// The snapshot carries buckets this table has never heard of, and it gains more
// over time: alongside five_hour and seven_day there are per-product and
// codenamed limits that come and go. Dropping them silently means a limit that
// is actually biting never gets mentioned, so anything carrying real spend is
// reported even though there is no span to price it against.
const KNOWN_KEYS = new Set(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']);
const NOT_A_WINDOW = new Set(['extra_usage', 'spend', 'limits', 'member_dashboard_available']);

function otherLimits(utilization, threshold) {
  if (!utilization) return [];
  const floor = Number.isFinite(threshold) ? threshold : 1;
  const rows = [];
  for (const key of Object.keys(utilization)) {
    if (KNOWN_KEYS.has(key) || NOT_A_WINDOW.has(key)) continue;
    const bucket = utilization[key];
    if (!bucket || typeof bucket.utilization !== 'number') continue;
    if (bucket.utilization < floor) continue;
    const resetsAt = bucket.resets_at ? Date.parse(bucket.resets_at) : null;
    rows.push({
      key,
      label: key.replace(/_/g, ' '),
      percentUsed: bucket.utilization,
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    });
  }
  return rows.sort((a, b) => b.percentUsed - a.percentUsed);
}

// Beside the per-window buckets, the snapshot carries `limits`: one entry per
// limit the account enforces, with a severity, whether it is the active one,
// and for the per-model weeklies which model it scopes to. It is the account's
// own description of its limits, and it can name a window the bucket table
// does not: on a Max plan the Fable weekly sat at 17% while the shared weekly
// read 11%, and nothing reported the higher of the two.
const LIMIT_KINDS = { session: 'five_hour', weekly_all: 'seven_day' };

function limitWindows(utilization) {
  const list = utilization && Array.isArray(utilization.limits) ? utilization.limits : [];
  const rows = [];
  for (const limit of list) {
    if (!limit || typeof limit !== 'object' || typeof limit.percent !== 'number') continue;
    const resetsAt = limit.resets_at ? Date.parse(limit.resets_at) : null;
    const base = {
      kind: limit.kind,
      percent: limit.percent,
      severity: typeof limit.severity === 'string' ? limit.severity : null,
      isActive: Boolean(limit.is_active),
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
      family: null,
    };
    if (LIMIT_KINDS[limit.kind]) {
      rows.push(Object.assign(base, { key: LIMIT_KINDS[limit.kind] }));
      continue;
    }
    if (limit.kind === 'weekly_scoped' && limit.scope && limit.scope.model) {
      const model = limit.scope.model;
      const name = model.display_name || model.id || 'model';
      const family = familyOf(name) || familyOf(model.id) || String(name).toLowerCase();
      rows.push(
        Object.assign(base, {
          key: 'seven_day_scoped:' + family,
          label: 'weekly (' + name + ')',
          family,
          spanMs: 7 * DAY,
        })
      );
    }
  }
  return rows;
}

function collect(now) {
  if (isCodex()) return codex.collect(now);
  return collectClaude(now);
}

// Whether the plugin's own live reading should stand in for Claude Code's
// cache. Both describe the same account; the newer one is simply the more
// recent fact. A reading for a different account, or one stamped from a clock
// that is ahead, is not a fresher reading of this account.
function preferLive(cache, fresh, accountUuid, now) {
  if (!fresh || !fresh.utilization || typeof fresh.utilization !== 'object') return false;
  if (!Number.isFinite(fresh.fetchedAtMs)) return false;
  if (fresh.fetchedAtMs > now + MINUTE) return false;
  if (fresh.accountUuid && accountUuid && fresh.accountUuid !== accountUuid) return false;
  if (!cache || !Number.isFinite(cache.fetchedAtMs)) return true;
  return fresh.fetchedAtMs > cache.fetchedAtMs;
}

// The account the login belongs to, so a live reading can be stamped with it.
function accountUuid() {
  const account = readJson(accountFile());
  return account && account.oauthAccount && account.oauthAccount.accountUuid
    ? account.oauthAccount.accountUuid
    : null;
}

function collectClaude(now) {
  const account = readJson(accountFile()) || {};
  const settings = readJson(path.join(configDir(), 'settings.json')) || {};
  const cache = account.cachedUsageUtilization || null;
  const oauth = account.oauthAccount || {};
  // The panel and the status line take the same reading Claude Code takes for
  // /usage and keep it in a file of their own. When that is newer than what
  // Claude Code cached, it is the better description of the same account.
  const fresh = live.readLive();
  const useLive = preferLive(cache, fresh, oauth.accountUuid, now);
  const snapshot = useLive ? fresh : cache;
  const utilization = snapshot && snapshot.utilization ? snapshot.utilization : null;
  const plan = detectPlan(oauth);

  return {
    now,
    host: host.CLAUDE,
    money: true,
    accountFile: accountFile(),
    plan: plan.label,
    planId: plan.id,
    planTier: plan.tier,
    planAdvice: plan.advice,
    snapshotAgeMs: snapshot && snapshot.fetchedAtMs ? now - snapshot.fetchedAtMs : null,
    snapshotFetchedAt: snapshot && snapshot.fetchedAtMs ? snapshot.fetchedAtMs : null,
    snapshotSource: utilization ? (useLive ? 'live' : 'cache') : null,
    utilization,
    settings: {
      model: settings.model || 'default',
      effortLevel: settings.effortLevel || 'default',
    },
    extraUsage: utilization && utilization.extra_usage ? utilization.extra_usage : null,
  };
}

// A snapshot only refreshes when Claude Code talks to the API, so after a
// gap it can be hours old and its 5-hour window long since rolled over.
// Dropping that window loses the limit that actually stops short work, so
// rebuild it from the transcripts instead.
//
// The trick is that the stale reading is still a usable calibration: whatever
// was spent inside the window it describes equalled its percentage. That
// dollars-per-point figure is a property of the plan, not of the moment, so it
// still prices the window running now.
// Anything above this and the calibration, not the budget, is what is full.
const SATURATION_LIMIT = 105;

// Fewer turns than this before the snapshot and a point cannot be priced.
const MIN_BASELINE_TURNS = 5;

// A reading below this cannot price a point either. The API reports whole
// numbers, so at 1% the denominator is mostly rounding: the true figure is
// anywhere in a bracket as wide as the reading itself, and a point priced
// against it converts later spend into several times the points it really
// moved. A snapshot taken just after a reset is the common case - one sat at
// 1% while the local spend divided by it asserted 97% of a window that was
// truly at 35.
const MIN_BASELINE_PERCENT = 5;

// And a reading near the top cannot price one either, for the opposite reason.
//
// The price of a point is the spend inside the window divided by the meter's
// own percentage, and that arithmetic assumes the meter is still counting. It
// stops at 100. Everything spent past the cap is real money that moved no
// points, so dividing by 100 counts it against points that were never
// registered and the price comes out too cheap - which then converts later
// spend into far more points than it moved, and the reported percentage
// overshoots the account.
//
// Measured here on 2026-09-07: a five-hour price learned at a reading of 100
// said a point cost $0.67, while the same window measured between two live
// readings in the healthy range - 24% to 47% on $20.85 - said $0.91. Thirty-six
// per cent too cheap, and the display was reading 54% against an account at 47.
const MAX_BASELINE_PERCENT = 95;

// Whether a remembered price may be used at all.
//
// Defined once because the question is asked in two different places, and
// gating only one of them was exactly how the capped price kept getting
// through: the correction refused it and the headroom arithmetic took it
// anyway. A price with no reading recorded against it predates this check and
// is taken on trust; a recorded one has to be from the middle of the meter.
function usableCalibration(known) {
  if (!known || !Number.isFinite(known.usdPerPercent) || known.usdPerPercent <= 0) return null;
  if (!Number.isFinite(known.percent)) return known;
  if (known.percent < MIN_BASELINE_PERCENT || known.percent > MAX_BASELINE_PERCENT) return null;
  return known;
}

// Past this much of a window, a handful of local turns is not what spent it,
// so their total is not a fair price for a point.
const UNEXPLAINED_PERCENT = 20;

function reconstructWindow(spec, snapshot, events, now) {
  if (!snapshot || typeof snapshot.utilization !== 'number') return null;
  if (snapshot.utilization <= 0) return null;

  const resetsAt = snapshot.resets_at ? Date.parse(snapshot.resets_at) : null;
  if (!Number.isFinite(resetsAt) || resetsAt > now) return null;

  const pastStart = resetsAt - spec.span;
  const past = totals(events.filter((e) => e.at >= pastStart && e.at <= resetsAt));
  if (past.cost <= 0) return null;

  // The same rounding bracket that poisons the live correction poisons a
  // rebuild: a closed window that read 1% prices a point off almost nothing.
  if (snapshot.utilization < MIN_BASELINE_PERCENT) return null;

  const usdPerPercent = past.cost / snapshot.utilization;

  // The window running now began when the old one reset, not five hours ago.
  // Summing a rolling span sweeps in the window that already expired: three
  // minutes after a reset that meant counting 103 turns instead of 6, and
  // reporting a fresh window as completely full.
  const liveStart = Math.max(now - spec.span, resetsAt);
  const live = totals(events.filter((e) => e.at >= liveStart && e.at <= now));
  const raw = live.cost / usdPerPercent;

  // A rebuild that overflows the window is not a full window, it is a broken
  // calibration. Local transcripts only see this machine, so if the closed
  // window was mostly spent elsewhere its price per point comes out far too
  // small and any live spend divides to hundreds of percent. Capping that at
  // 100 would report a full budget to someone sitting at half, which is worse
  // than admitting the reading cannot be rebuilt.
  if (raw > SATURATION_LIMIT) return null;

  return {
    percentUsed: Math.min(100, Math.round(raw)),
    usdPerPercent,
    spentUSD: live.cost,
    turns: live.turns,
    windowStart: liveStart,
  };
}

// The snapshot can be older than the window it describes without ever looking
// stale, because a window with no reset time has nothing to compare against.
// That is the ordinary case after a long gap: the 5-hour reading was taken
// seven hours ago and says 0%, the window running now started two hours ago,
// and the reading is about a window that no longer exists. Adding spend to it
// is not the fix, because none of that spend is inside the window it describes.
// Rebuilding is: the learned price per point turns this window's own spend
// straight into a percentage.
function reconstructUnanchored(spec, window, events, now, learned) {
  if (!window || window.stale) return null;
  if (!window.snapshotOlderThanWindow) return null;
  // Only worth doing when the reading is low enough to be the thing that is
  // wrong. A high reading that is old is already alarming and is left alone.
  if (window.percentUsed === null || window.percentUsed > 5) return null;
  if (!learned || !Number.isFinite(learned.usdPerPercent) || learned.usdPerPercent <= 0) {
    return null;
  }

  const start = window.windowStart;
  const live = totals(events.filter((event) => event.at >= start && event.at <= now));
  if (live.cost <= 0) return null;

  const raw = live.cost / learned.usdPerPercent;
  if (raw < 1) return null;
  // Same rule as every other rebuild: past this it is the calibration that is
  // full rather than the window, and claiming a spent budget is worse than
  // admitting the reading could not be rebuilt.
  if (raw > SATURATION_LIMIT) return null;

  return buildWindow(
    spec,
    { utilization: Math.min(100, Math.round(raw)), resets_at: null },
    events,
    now,
    { estimated: true, windowStart: start, usdPerPercent: learned.usdPerPercent }
  );
}

// No snapshot at all means no windows, which is what tells the report to
// explain itself rather than print a table of dashes.
function buildWindows(utilization, events, now, fetchedAt, learned, specs, rejections) {
  if (!utilization) return [];
  const refused = rejections || new Map();
  // Claude Code's windows are fixed and known. Codex reports the length of each
  // of its two windows in the payload, so it hands its own spans in rather than
  // having them assumed.
  const table = specs && specs.length ? specs : WINDOWS;
  const limits = limitWindows(utilization);
  const limitByKey = new Map(limits.map((limit) => [limit.key, limit]));

  const one = (spec, snapshot, own, limit) => {
    const known = learned ? learned[spec.key] : null;
    const refusal = refused.get(spec.key);

    // With no reset time the window has to be treated as rolling, which starts
    // it five hours ago and sweeps in whatever the window before it spent. When
    // the account has refused work on this window, its reset time is known
    // exactly: a refusal in the future is this window's own reset, and one in
    // the past is the moment the window running now began.
    let anchored = snapshot;
    let windowStart;
    if (snapshot && !snapshot.resets_at && refusal && Number.isFinite(refusal.resetsAt)) {
      if (refusal.resetsAt > now) {
        anchored = Object.assign({}, snapshot, {
          resets_at: new Date(refusal.resetsAt).toISOString(),
        });
      } else if (now - refusal.resetsAt < spec.span) {
        windowStart = refusal.resetsAt;
      }
    }

    // A bucket that quotes its limit in dollars needs no calibration: a
    // hundred dollars is a hundred points. Null on the plans seen so far, but
    // the field is there, and when it fills in it beats any estimate.
    const dollars =
      snapshot && Number.isFinite(snapshot.limit_dollars) && snapshot.limit_dollars > 0
        ? snapshot.limit_dollars / 100
        : null;

    const window = buildWindow(
      spec,
      anchored,
      own,
      now,
      Object.assign(
        { fetchedAt, knownCalibration: known },
        windowStart === undefined ? {} : { windowStart },
        dollars === null ? {} : { metered: true, usdPerPercent: dollars }
      )
    );
    if (refusal) {
      window.refusedAt = refusal.at;
      window.refusedResetsAt = refusal.resetsAt;
    }

    let result = window;
    if (!window.stale) {
      result = reconstructUnanchored(spec, window, own, now, known) || window;
    } else {
      // Rolled over. Rebuild from local history rather than going blind on it.
      const rebuilt = reconstructWindow(spec, snapshot, own, now);
      if (rebuilt) {
        result = buildWindow(
          spec,
          { utilization: rebuilt.percentUsed, resets_at: null },
          own,
          now,
          {
            estimated: true,
            windowStart: rebuilt.windowStart,
            usdPerPercent: rebuilt.usdPerPercent,
          }
        );
      }
    }
    // What the account itself says about this limit rides along.
    if (limit) {
      result.severity = limit.severity;
      result.isActive = limit.isActive;
    }
    return result;
  };

  const windows = table
    .map((spec) => {
      let snapshot = utilization[spec.key];
      const limit = limitByKey.get(spec.key);
      // The account's own list can carry a window the bucket table does not.
      if ((!snapshot || typeof snapshot.utilization !== 'number') && limit) {
        snapshot = {
          utilization: limit.percent,
          resets_at: limit.resetsAt ? new Date(limit.resetsAt).toISOString() : null,
        };
      }
      // The per-model weekly windows only exist on some plans.
      if (spec.key !== 'five_hour' && spec.key !== 'seven_day' && !snapshot) return null;
      return one(spec, snapshot, events, limit);
    })
    .filter(Boolean);

  // A per-model weekly is a limit on one model's spend, so it is priced from
  // that model's calls alone; the shared windows still see everything.
  for (const limit of limits) {
    if (!limit.family) continue;
    const spec = { key: limit.key, label: limit.label, span: limit.spanMs };
    const own = events.filter((event) => familyOf(event.model) === limit.family);
    const snapshot = {
      utilization: limit.percent,
      resets_at: limit.resetsAt ? new Date(limit.resetsAt).toISOString() : null,
    };
    const window = one(spec, snapshot, own, limit);
    window.scoped = true;
    window.family = limit.family;
    windows.push(window);
  }
  return windows;
}

// What one session has spent, out of everything on record.
function sessionSpend(events, sessionId) {
  if (!sessionId) return null;
  let cost = 0;
  let turns = 0;
  let tokens = 0;
  for (const event of events) {
    if (event.sessionId !== sessionId) continue;
    cost += event.cost;
    tokens += event.tokens || 0;
    if (!event.sidechain) turns += 1;
  }
  return turns ? { turns, cost, tokens } : null;
}

async function report(now, options) {
  let base = collect(now);
  // A stale snapshot can put a window's start slightly further back than
  // seven days, so give the scan a day of slack.
  const earliest = now - 8 * DAY;
  // A hook is given ten seconds; the panel and the CLI have all the time they
  // want. A scan that runs out of its budget returns what it managed to read
  // and says so, which is how the report knows its correction may be short.
  const all = await readEvents(earliest, options && options.budgetMs ? { budgetMs: options.budgetMs } : undefined);
  const scanPartial = Boolean(all && all.partial);
  // A refused request is a record of the limit, not a turn against it, so it is
  // kept apart from everything that measures spend or pace.
  const rejections = lastRejections(all);
  const events = all.filter((event) => !event.rejected);

  // Codex carries the meter inside the same records as the turns, so the full
  // scan can find a newer reading than the quick one collect() does. Reuse it
  // rather than scanning twice or reporting the older of the two.
  if (isCodex()) {
    const live = options && options.codexMeter;
    const latest = live || codex.latestMeter(events);
    if (latest && (live || !base.snapshotFetchedAt || latest.at > base.snapshotFetchedAt)) {
      base = codex.collect(now, { meter: latest });
    }
  }

  const onDisk = readCalibration();
  // Anything learned on a different plan is void, and its absence is what makes
  // the report say so rather than quietly pricing this plan with the last one's
  // numbers.
  const calibrated = calibrationForPlan(onDisk, base.planId);
  const learned = Object.assign({}, calibrated.learned);

  // Codex logs the meter next to every request, so the price of a point can be
  // measured outright instead of inferred. A measurement from this session
  // beats anything remembered from an earlier one.
  if (isCodex()) {
    for (const spec of base.windowSpecs || []) {
      const measured = codex.calibrate(events, spec.key, now);
      if (measured) learned[spec.key] = betterCalibration(learned[spec.key], measured);
    }
  }

  const windows = buildWindows(
    base.utilization,
    events,
    now,
    base.snapshotFetchedAt,
    learned,
    base.windowSpecs,
    // A refusal describes the allowance that refused it. After a plan change
    // that allowance is gone, so anchoring the new window to it, or warning
    // that the room "ran out last time", is describing a budget that no longer
    // exists.
    calibrated.planChanged ? new Map() : rejections
  );

  // Which of those windows this agent can actually spend into. Everything that
  // ranks or warns about a window reads the answer off the window itself.
  const families = familiesInUse(
    events,
    options && options.sessionId,
    [base.settings && base.settings.model, process.env.ANTHROPIC_MODEL]
  );
  markApplicable(windows, families);

  // What the room left buys in turns of each model, and the record that lets a
  // later session answer that for a model it has not run yet. Scoped to a week
  // because every window a family draws on here is a weekly one.
  const remembered = calibrationForPlan(readModelRecord(), base.planId).learned;
  const headroom = modelHeadroom(
    windows,
    events.filter((event) => event.at >= now - 7 * DAY),
    families,
    remembered
  );
  const sampled = modelSamples(headroom, remembered);
  if (sampled.changed) writeModelRecord(stampPlan(sampled.models, base.planId));

  // Keep the best sample seen so far, so a thin baseline never has to guess.
  const updated = Object.assign({}, learned);
  for (const window of windows) {
    if (!window.calibration) continue;
    const best = betterCalibration(updated[window.key], window.calibration);
    if (best) updated[window.key] = best;
  }
  // Compared against what is actually on disk, so a measurement taken during
  // this run is saved too rather than only the ones inferred from a window.
  let changed = calibrated.planChanged;
  for (const key of Object.keys(updated)) {
    if (updated[key] !== onDisk[key]) changed = true;
  }
  if (changed) writeCalibration(stampPlan(updated, base.planId));

  const recentEvents = events.filter((event) => event.at >= now - HOUR);
  const recent = totals(recentEvents);

  const binding = bindingWindow(windows);

  // The effort the next turn will run at. Codex states it outright in
  // config.toml; Claude Code stamps it on every assistant line, which is the
  // only source that follows /effort mid-session. The setting is last.
  let effortNow = (options && options.effort) || null;
  if (!effortNow && !isCodex() && options && options.sessionId) {
    const seen = liveEffort(options.sessionId);
    if (seen && seen.effort) effortNow = seen.effort;
  }
  if (!effortNow) {
    const configured = base.settings && base.settings.effortLevel;
    if (configured && configured !== 'default') effortNow = configured;
  }
  if (!effortNow) effortNow = dominantEffort(recentEvents) || null;
  const scopeStart = binding ? binding.windowStart : now - 7 * DAY;
  const scoped = events.filter((event) => event.at >= scopeStart && event.at <= now);
  const scopedTotals = totals(scoped);
  // Worked out once and used twice: the table of models, and the price of the
  // reasoning inside it.
  const scopedModels = byModel(scoped);

  return Object.assign({}, base, {
    windows,
    binding,
    otherLimits: otherLimits(base.utilization),
    // The plan moved since anything was last learned about it, so the cached
    // percentage was measured against a different allowance and everything
    // derived from the old one has been dropped.
    planChanged: calibrated.planChanged,
    // The last time the account actually refused work, so a report taken just
    // after a cutoff says so rather than describing the fresh window as though
    // nothing happened.
    lastRefusal: [...rejections.values()].sort((a, b) => b.at - a.at)[0] || null,
    credits: base.codexCredits || creditsFrom(base.utilization),
    sessions: activeSessions(events, now, CONCURRENT_WINDOW_MS),
    session: sessionSpend(events, options && options.sessionId),
    // A per-model weekly for a model that is not running could be a week past
    // its reset without that saying anything about the numbers this agent is
    // working from, and it should not put "run /usage" on every prompt.
    staleWindows: windows.filter((w) => w.stale && w.applies !== false).length,
    rates: costPercentiles(recentEvents.length >= 5 ? recentEvents : scoped),
    resumeAt: binding ? binding.resetsAt : null,
    models: scopedModels,
    modelHeadroom: headroom,
    projects: byProject(scoped),
    tokens: scopedTotals.parts,
    reasoning: reasoningSpend(scopedModels, scopedTotals.parts),
    scopeLabel: binding ? binding.label : 'last 7 days',
    recent: {
      turns: recent.turns,
      usd: recent.cost,
      usdPerTurn: recent.turns ? recent.cost / recent.turns : null,
      tokens: recent.tokens,
      effort: dominantEffort(recentEvents),
    },
    measuredTurns: mainThread(events).length,
    subagentTurns: events.length - mainThread(events).length,
    // The effort the NEXT turn will run at, and what a turn has cost at each
    // effort on record. Codex states it in config.toml; Claude Code stamps it
    // on every line of the transcript.
    effortNow,
    effortRates: effortRates(events),
    effortWarning: effortWarning(events, effortNow, binding),
    codex: codexBlock(now),
    // True when the scan hit its time budget before it had read everything, so
    // the spend since the snapshot is a floor rather than a total. Anything
    // that warns on the number says "at least" when this is set.
    scanPartial,
  });
}

function verdictLine(window) {
  if (!window) {
    return 'No limit snapshot on disk yet. Run /usage once in Claude Code to populate it.';
  }
  const name = window.label + ' limit';
  switch (window.verdict) {
    case 'rolled-over':
      return (
        'The ' + name + ' passed its reset time, so the cached reading is out ' +
        'of date and the window has already turned over. Claude Code refreshes ' +
        'it on the next request.'
      );
    case 'exhausted':
      return 'The ' + name + ' is used up. It resets in ' + formatDuration(window.msToReset) + '.';
    case 'resets-first':
      return (
        'The ' + name + ' is the binding one. At the current pace it lasts about ' +
        formatDuration(window.headroomMs) + ', and it resets in ' +
        formatDuration(window.msToReset) + ', so the window turns over before you run out.'
      );
    case 'runs-out':
      return (
        'The ' + name + ' is the binding one. At the current pace it runs out in about ' +
        formatDuration(window.headroomMs) + ', which is ' +
        formatDuration(window.msToReset - window.headroomMs) + ' short of the reset. ' +
        'Size the work to fit, or slow the burn.'
      );
    case 'burning':
      return (
        'The ' + name + ' is at ' + window.percentUsed + '% and has about ' +
        formatDuration(window.headroomMs) + ' left at the current pace. No reset time was reported.'
      );
    case 'idle':
      return (
        'The ' + name + ' is at ' + window.percentUsed +
        '% with no recent traffic to measure. Percentages are current, pace is not.'
      );
    default:
      return 'Not enough local data to project the ' + name + '.';
  }
}

// One short line for the Claude Code status line. Deliberately reads only
// the cached percentages, never the transcripts, so it stays fast enough to
// run on every redraw.
function statusLine(collected) {
  const utilization = collected && collected.utilization;
  if (!utilization) return '';

  const now = collected.now || Date.now();
  // No transcripts here on purpose, so the only thing that says which model is
  // running is the setting. That is enough to keep a weekly for a model this
  // agent is not using out of a line that is meant to read as "your room".
  const families = familiesInUse(null, null, [
    collected.settings && collected.settings.model,
    process.env.ANTHROPIC_MODEL,
  ]);
  const parts = [];
  for (const spec of collected.windowSpecs && collected.windowSpecs.length
    ? collected.windowSpecs
    : WINDOWS) {
    const snapshot = utilization[spec.key];
    if (!snapshot || typeof snapshot.utilization !== 'number') continue;
    const resetsAt = snapshot.resets_at ? Date.parse(snapshot.resets_at) : null;
    const msToReset = Number.isFinite(resetsAt) ? resetsAt - now : null;
    // The snapshot is what the account last said; the spend since then is
    // measured by a transcript scan this line can never afford. When a hook has
    // already paid for that scan recently, use its answer. Measured on a real
    // session, the difference was 13 per cent here against 73 in the report,
    // and the flattering one was the one on screen.
    const corrected = reading.correctedFor(spec.key, now, collected.snapshotFetchedAt);
    parts.push({
      label: SHORT_LABELS[spec.key] || spec.label,
      percent: corrected ? corrected.percentUsed : snapshot.utilization,
      adjusted: Boolean(corrected && corrected.adjusted),
      msToReset,
      // A per-model weekly for a model that is not running is shown - hiding a
      // limit outright is the one failure worse than over-reporting one, and
      // the only thing telling this line which model is running is the
      // setting, which can be behind. It just does not raise the alarm.
      idle: !appliesTo(spec, families),
      stale: msToReset !== null && msToReset <= 0,
      // Zero with no reset time is not an empty window, it is a bucket that is
      // not reporting: a real window at 0% has just reset and says when it will
      // do so again. The status line cannot scan transcripts to find out which,
      // so it must not print the flattering reading as though it were measured.
      unreported: snapshot.utilization === 0 && !Number.isFinite(resetsAt),
    });
  }

  // The per-model weeklies are not bucket keys, they are entries in the
  // account's own `limits` list, so a loop over the bucket table never saw
  // them. On a plan where the Fable weekly is the limit that actually binds,
  // that meant the status line quoting the shared weekly at 24% while the
  // window about to stop the work sat at 76, which is the wrong number in the
  // most convincing possible place.
  for (const limit of limitWindows(utilization)) {
    if (!limit.family) continue;
    const msToReset = Number.isFinite(limit.resetsAt) ? limit.resetsAt - now : null;
    parts.push({
      label: limit.family,
      percent: limit.percent,
      msToReset,
      idle: !appliesTo(limit, families),
      stale: msToReset !== null && msToReset <= 0,
      unreported: false,
    });
  }

  if (!parts.length) return '';

  // Shown, but never the alarm. Hiding a limit outright is the one failure
  // worse than over-reporting one, and the only thing telling this line which
  // model is running is the setting, which can be behind a /model. So an idle
  // per-model weekly stays on the line and is left out of the worst-of.
  const trusted = parts.filter((part) => !part.stale && !part.unreported && !part.idle);
  const worst = trusted.length
    ? trusted.reduce((a, b) => (b.percent > a.percent ? b : a))
    : null;
  const text = parts
    .map((part) =>
      part.stale
        ? part.label + ' rolling'
        : part.unreported
          ? part.label + ' ?'
          : part.label + ' ' + part.percent + '%' +
            (part.msToReset === null ? '' : ' ' + formatDuration(part.msToReset))
    )
    .join('  ');

  return (worst && worst.percent >= 90 ? 'LOW  ' : '') + text;
}

function render(data) {
  const lines = [];
  // Codex meters an allowance and never quotes a price, so its report has no
  // honest money column. Everything else in the table means the same thing on
  // both hosts.
  const money = data.money !== false;
  lines.push((data.host === host.CODEX ? 'Codex usage' : 'Claude Code usage'));
  lines.push('');
  lines.push('  Plan       ' + data.plan);
  lines.push(
    '  Snapshot   ' +
      (data.snapshotAgeMs === null
        ? 'none on disk'
        : formatDuration(data.snapshotAgeMs) + ' old' + (data.snapshotSource === 'live' ? ' (live reading)' : ''))
  );
  lines.push('  Settings   model=' + data.settings.model + '  effort=' + data.settings.effortLevel);
  if (data.planChanged) {
    lines.push('  Plan change  this is a different plan from the one the figures below');
    lines.push('               were learned on, so what a point of a window is worth has');
    lines.push('               changed with it. The cached reading may predate the change:');
    lines.push('               run /usage for one measured against this plan.');
  }
  const credits = data.credits;
  if (credits && credits.unlimited) {
    lines.push('  Credits    unlimited');
  } else if (credits) {
    if (!credits.enabled) {
      lines.push('  Credits    off, work stops when the plan allowance runs out');
    } else if (!money) {
      lines.push('  Credits    on, balance ' + (credits.balance === null ? 'unknown' : credits.balance));
    } else {
      const amounts =
        credits.used === null
          ? 'on'
          : 'on, ' + formatUSD(credits.used) + ' used' +
            (credits.limit ? ' of ' + formatUSD(credits.limit) : '') +
            (credits.percent === null ? '' : ' (' + credits.percent + '%)');
      lines.push(
        '  Credits    ' + amounts +
          (credits.limitReached ? ', spend limit reached' : '')
      );
    }
  }
  lines.push('');

  if (!data.windows.length) {
    // Two different situations, and telling them apart matters. Nothing to read
    // is a setup problem. Nothing to report is the correct answer on a plan
    // whose usage scales with credits rather than resetting on a clock.
    if (data.unreadable) {
      lines.push('  The meter reports usage windows but no readable percentage for them.');
      lines.push('  That is a reading problem, not flexible pricing: the limit still');
      lines.push('  applies. Run /status in Codex, or try again in a minute.');
    } else if (data.windowless) {
      lines.push('  This account reports no rolling usage window.');
      lines.push('  On flexible pricing there is no percentage to run down: usage scales');
      lines.push('  with credits, so the credit balance above is the budget to plan against.');
      if (data.planAdvice) {
        lines.push('');
        lines.push(data.planAdvice);
      }
      return lines.join('\n');
    }
    lines.push('  No usage snapshot in ' + (data.accountFile || '~/.claude.json') + '.');
    lines.push(
      data.host === host.CODEX
        ? '  Run a Codex turn once so it writes one, or --refresh to ask for it now.'
        : '  Run /usage once inside Claude Code to populate it, then try again.'
    );
    return lines.join('\n');
  }

  lines.push(
    '  ' + pad('Window', 15) + padLeft('Used', 6) + padLeft('Resets in', 12) +
      (money ? padLeft('Left', 10) : '') + padLeft('Turns left', 12)
  );
  for (const window of data.windows) {
    const bound = data.binding && window.key === data.binding.key;
    // The account's own severity, when it says critical, is worth a word.
    const critical = window.severity === 'critical';
    // A per-model weekly for a model that is not running still belongs in the
    // table - it is real, and switching to that model would make it bite - but
    // it is not this agent's room, and a bare percentage next to the others
    // reads as though it were. The row says which it is.
    const idle = window.applies === false;
    const marker = bound
      ? '   <- binding' + (critical ? ', critical' : '')
      : idle
        ? '   not in use' + (critical ? ', critical for that model' : '')
        : critical
          ? '   critical'
          : '';
    lines.push(
      '  ' + pad(window.label, 15) +
        padLeft(
          window.stale
            ? 'stale'
            : window.percentUsed === null
              ? '-'
              : (window.estimated || window.adjusted ? '~' : '') + window.percentUsed + '%',
          6
        ) +
        padLeft(formatDuration(window.msToReset), 12) +
        (money ? padLeft(formatUSD(window.remainingUSD), 10) : '') +
        padLeft(window.turnsLeft === null ? '-' : '~' + formatCount(window.turnsLeft), 12) +
        marker
    );
  }
  if (data.windows.some((window) => window.applies === false)) {
    // Named from what is actually running rather than from the setting, which
    // can say 'default', or name a strategy like 'opusplan', or be behind a
    // /model - and the legend would then assert a model nothing was decided
    // from.
    const running = (data.modelHeadroom || [])
      .filter((row) => row.inUse)
      .map((row) => row.family);
    lines.push(
      '    not in use  caps one model, and this agent is running ' +
        (running.length ? running.join(' and ') : 'another model') +
        ', so nothing here spends into it'
    );
  }
  lines.push('');

  // The other agent, directly under this one's windows and counting the other
  // way: Codex reports what is LEFT, so every figure here says "left" and none
  // of them can be read as a percentage spent.
  if (data.codex && data.codex.rows.length) {
    lines.push('  Codex usage' + (data.codex.plan ? '   ' + data.codex.plan : ''));
    lines.push('  Window           Left   Resets in');
    for (const row of data.codex.rows) {
      lines.push(
        '  ' + pad(row.title, 15) +
          padLeft(row.percentLeft === null ? (row.stale ? 'rolled' : '-') : row.percentLeft + '%', 6) +
          padLeft(row.stale ? '-' : formatDuration(row.msToReset), 12)
      );
    }
    if (data.codex.note) lines.push('    ' + data.codex.note);
    else if (Number.isFinite(data.codex.ageMs)) {
      lines.push('    reading from ' + formatDuration(data.codex.ageMs) + ' ago, out of the rollouts Codex writes');
    }
    lines.push('');
  }

  // How much room is left is only half the question. The other half is what
  // that room buys, and the answer is different for every model: the same
  // weekly holds a few hundred Fable turns or several thousand Sonnet ones.
  // The account's own figures cannot say this - they have no model in them.
  const headroom = money ? (data.modelHeadroom || []) : [];
  if (headroom.some((row) => row.turnsLeft !== null)) {
    lines.push('  Model headroom, what the room left buys in turns of each model');
    lines.push(
      '  ' + pad('  Model', 12) + pad('Window', 17) + padLeft('Turns', 7) +
        padLeft('Spent', 9) + padLeft('Per turn', 10) + padLeft('Turns left', 12)
    );
    for (const row of headroom) {
      lines.push(
        '  ' + pad('  ' + row.family, 12) +
          pad(row.windowLabel || '-', 17) +
          padLeft(formatCount(row.sample), 7) +
          padLeft(formatUSD(row.usd), 9) +
          padLeft(formatUSD(row.usdPerTurn) + (row.perCall ? '*' : ''), 10) +
          padLeft(row.turnsLeft === null ? '-' : '~' + formatCount(row.turnsLeft), 12) +
          (row.inUse ? '   <- running' : '')
      );
    }
    if (headroom.some((row) => row.perCall)) {
      lines.push('    * a subagent call, not a turn: this model has taken no turns of its own,');
      lines.push('      so there is nothing here to project a turn count from. The price is');
      lines.push('      still what delegating to it has cost.');
    }
    if (headroom.some((row) => row.remembered)) {
      lines.push('    A row with too few turns this week is priced from the record of what');
      lines.push('    that model cost when there were enough.');
    }
    // The two tables price the same window differently on purpose, and someone
    // is going to notice, so say why before it gets read as a bug.
    lines.push('    Turns left in the table above is a blend of every model on record;');
    lines.push("    these are each model's own measured cost per turn, and rows sharing a");
    lines.push('    window are alternatives rather than additions: the same room, spent on');
    lines.push('    a different model.');
    lines.push('');
  }

  // A bucket with no span cannot be priced or projected, but saying nothing
  // about one that is nearly full would be the worse failure.
  if (data.otherLimits && data.otherLimits.length) {
    lines.push('  Other limits reported by the account');
    for (const row of data.otherLimits) {
      lines.push(
        '  ' + pad('  ' + row.label, 24) + padLeft(row.percentUsed + '%', 6) +
          padLeft(
            Number.isFinite(row.resetsAt) ? formatDuration(row.resetsAt - data.now) : '-',
            12
          )
      );
    }
    lines.push('    No window length is reported for these, so they are not projected.');
    lines.push('');
  }

  if (data.models && data.models.length) {
    lines.push('  Models in the ' + (data.scopeLabel || 'window') + ' window');
    lines.push(
      '  ' + pad('  Model', 24) + padLeft('Turns', 7) + padLeft('Tokens', 10) +
        padLeft('Output', 9) + padLeft('Share', 8)
    );
    for (const row of data.models) {
      lines.push(
        '  ' + pad('  ' + row.model + (money && row.estimated ? ' *' : ''), 24) +
          padLeft(row.turns, 7) +
          padLeft(formatTokens(row.tokens), 10) +
          padLeft(formatTokens(row.parts.output), 9) +
          padLeft(Math.round(row.share * 100) + '%', 8)
      );
    }
    // The footnote is about the price table, which only the Claude reader uses.
    if (money && data.models.some((row) => row.estimated)) {
      lines.push('    * no published rate for this one yet, priced at the family average');
    }
    if (data.tokens) {
      lines.push(
        '    Tokens  input ' + formatTokens(data.tokens.input) +
          ', cache write ' + formatTokens(data.tokens.cacheWrite) +
          ', cache read ' + formatTokens(data.tokens.cacheRead) +
          ', output ' + formatTokens(data.tokens.output)
      );
      // Output is the dearest class and reasoning is usually about half of it,
      // which makes this the largest number on the report that a setting can
      // actually move. Saying so without measuring it was advice; this is the
      // measurement.
      const reasoning = data.reasoning;
      if (reasoning && reasoning.tokens > 0) {
        lines.push(
          '    Of that output, ' + formatTokens(reasoning.tokens) + ' was reasoning (' +
            Math.round(reasoning.shareOfOutput * 100) + '%' +
            (money && reasoning.cost !== null ? ', about ' + formatUSD(reasoning.cost) : '') +
            '), the part effort controls.'
        );
      }
    }
    lines.push('');
  }

  if (data.projects && data.projects.length > 1) {
    lines.push('  Projects in the ' + (data.scopeLabel || 'window') + ' window');
    lines.push(
      '  ' + pad('  Project', 24) + padLeft('Turns', 7) + padLeft('Tokens', 10) +
        padLeft('Share', 8)
    );
    for (const row of data.projects.slice(0, 5)) {
      lines.push(
        '  ' + pad('  ' + shortenProject(row.project, 22), 24) +
          padLeft(row.turns, 7) + padLeft(formatTokens(row.tokens), 10) +
          padLeft(Math.round(row.share * 100) + '%', 8)
      );
    }
    lines.push('');
  }

  if (data.sessions && data.sessions.length > 1) {
    const split = data.sessions.map((row) => Math.round(row.share * 100) + '%').join(' / ');
    lines.push(
      '  Sharing       ' + data.sessions.length + ' sessions have spent in the last 15m, ' +
        'splitting this budget ' + split
    );
    lines.push(
      '                The turns above are the whole window, not your slice of it.'
    );
  }

  if (data.recent.turns) {
    lines.push(
      '  Recent pace   ' + data.recent.turns + ' turns in the last hour' +
        (money ? ', ' + formatUSD(data.recent.usdPerTurn) + ' per turn' : '') +
        (data.recent.effort ? ', effort ' + data.recent.effort : '')
    );
  } else {
    lines.push('  Recent pace   no turns in the last hour');
  }
  lines.push(
    '  Measured      ' + formatCount(data.measuredTurns) + ' turns of local transcript' +
      (data.subagentTurns > 0 ? ' (+' + formatCount(data.subagentTurns) + ' subagent calls)' : '')
  );

  // What a turn costs at each effort, when more than one has been measured.
  // The single most useful line for anyone wondering where the budget went:
  // effort changes the price of every turn rather than how many there are.
  const rates = (data.effortRates || []).filter((row) => row.turns >= MIN_EFFORT_SAMPLE && row.outputPerTurn);
  if (rates.length > 1) {
    lines.push('');
    lines.push('  What each effort costs, measured on this machine');
    lines.push('    Effort        Turns   Output/turn' + (money ? '   Per turn' : ''));
    for (const row of rates) {
      lines.push(
        '    ' +
          String(row.effort + (row.effort === data.effortNow ? ' *' : '')).padEnd(12) +
          padLeft(formatCount(row.turns), 7) +
          padLeft(formatCount(Math.round(row.outputPerTurn)), 14) +
          (money ? padLeft(formatUSD(row.perTurn), 11) : '')
      );
    }
    if (data.effortNow) lines.push('    * the effort set now');
    lines.push('    Output per turn is the part the effort setting controls; cost per turn');
    lines.push('    also moves with how big the context happened to be.');
  }

  if (data.effortWarning) {
    const warning = data.effortWarning;
    lines.push('');
    if (Number.isFinite(warning.turnsLeft)) {
      lines.push(
        '  Careful       at ' + warning.effort + ' effort this window holds about ' +
          formatCount(warning.turnsLeft) + ' more turns' +
          (Number.isFinite(warning.blendedTurnsLeft) && warning.blendedTurnsLeft > warning.turnsLeft
            ? ', not the ' + formatCount(warning.blendedTurnsLeft) + ' above'
            : '')
      );
    }
    if (warning.cheaper && Number.isFinite(warning.cheaper.multiple)) {
      lines.push(
        '                ' + warning.effort + ' writes about ' + warning.cheaper.multiple.toFixed(1) +
          'x the output per turn that ' + warning.cheaper.effort + ' does'
      );
    }
  }

  if (data.windows.some((window) => window.adjusted)) {
    lines.push(
      '  Note          ~ includes spend since the snapshot was taken, which its own'
    );
    lines.push(
      '                reading does not cover yet. Run /usage for a fresh one.'
    );
  }

  if (data.windows.some((window) => window.estimated)) {
    lines.push(
      '  Note          ~ means the snapshot had gone stale and that window was rebuilt'
    );
    lines.push(
      '                from local history. Run /usage to replace it with a real reading.'
    );
  }

  if (data.binding && data.binding.coarse) {
    lines.push('  Note          the meter reads in whole percent, so a low reading is a wide bracket');
  }

  // A report taken shortly after a cutoff should say so. The percentages
  // describe the window running now and look perfectly healthy, which is
  // exactly why the fact that work was stopped an hour ago has to be stated
  // rather than left to be inferred from a number that no longer shows it.
  if (data.lastRefusal && Number.isFinite(data.lastRefusal.at) &&
      data.now - data.lastRefusal.at < 12 * HOUR) {
    const window = data.windows.find((one) => one.key === data.lastRefusal.key);
    lines.push(
      '  Cut off       ' + formatDuration(data.now - data.lastRefusal.at) + ' ago the ' +
        ((window && window.label) || data.lastRefusal.key) + ' limit refused work' +
        (Number.isFinite(data.lastRefusal.resetsAt)
          ? ', and came back at ' + formatClock(data.lastRefusal.resetsAt)
          : '')
    );
  }

  if (data.windows.some((window) => window.snapshotOlderThanWindow && !window.stale)) {
    lines.push(
      '  Note          the snapshot is older than one of these windows, so its reading'
    );
    lines.push(
      '                describes a window that has since rolled over. ' +
        (data.host === host.CODEX
          ? 'Run --refresh for a live one.'
          : 'Run /usage for a fresh one.')
    );
  }

  lines.push('');
  lines.push(verdictLine(data.binding));
  const binding = data.binding;
  const outOfRoom = binding && (binding.verdict === 'runs-out' || binding.verdict === 'exhausted');
  if (outOfRoom) {
    // With credits on, Claude Code announces the switch itself and asks
    // before drawing on them, so repeating it here would only add noise.
    // With credits off there is no such prompt, and the wall is a hard stop.
    const credits = data.credits;
    if (!credits || !credits.enabled || credits.limitReached) {
      lines.push('  Work stops when it does. Nothing carries on into paid credits.');
    }
    if (Number.isFinite(data.resumeAt)) {
      lines.push(
        '  Land what exists, write the handoff, and resume after ' +
          formatClock(data.resumeAt) + '.'
      );
    }
  }

  if (data.planAdvice) {
    lines.push('');
    lines.push(data.planAdvice);
  }
  return lines.join('\n');
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '-';
  if (value >= 10) return Math.round(value) + '%';
  return value.toFixed(1) + '%';
}

function renderForecast(data, turns) {
  const lines = [];

  // Checked before the heading is built, or a bad argument prints straight
  // into it: "Forecast for NaN turns".
  if (!Number.isFinite(turns) || turns <= 0) {
    lines.push('Forecast');
    lines.push('');
    lines.push('  Give a number of turns, for example --forecast 15.');
    return lines.join('\n');
  }

  lines.push('Forecast for ' + turns + ' turns');
  lines.push('');
  if (!data.rates) {
    lines.push('  Nothing recent to price this against yet. Do some work in this');
    lines.push('  session first, then ask again.');
    return lines.join('\n');
  }

  const rows = data.windows
    // A limit this agent cannot spend into is not what a job fails to fit in,
    // so it is never offered as a reason to cut the work down.
    .filter((window) => window.applies !== false)
    .map((window) => forecastWindow(window, turns, data.rates))
    .filter(Boolean);

  if (!rows.length) {
    lines.push('  No window has enough measured spend to price a forecast against.');
    return lines.join('\n');
  }

  lines.push(
    '  ' + pad('Window', 15) + padLeft('Would cost', 18) + padLeft('Leaves', 10) + '   Verdict'
  );
  for (const row of rows) {
    const verdict = row.fits ? (row.tight ? 'fits, barely' : 'fits') : 'does not fit';
    lines.push(
      '  ' + pad(row.label, 15) +
        padLeft(formatPercent(row.percentLow) + ' to ' + formatPercent(row.percentHigh), 18) +
        padLeft(formatPercent(Math.max(0, row.leaves)), 10) +
        '   ' + verdict
    );
  }
  lines.push('');
  lines.push(
    data.money === false
      ? '  Priced from ' + data.rates.sample + ' recent turns, cheapest to dearest.'
      : '  Priced from ' + data.rates.sample + ' recent turns: ' +
        formatUSD(data.rates.median) + ' typical, ' + formatUSD(data.rates.high) +
        ' at the expensive end.'
  );

  const blocked = rows.filter((row) => !row.fits);
  const tight = rows.filter((row) => row.fits && row.tight);
  lines.push('');
  if (blocked.length) {
    lines.push(
      '  The ' + blocked[0].label + ' window does not cover this. Cut it down or ' +
        'split it at a clean boundary rather than starting and getting cut off.'
    );
  } else if (tight.length) {
    lines.push(
      '  It fits, but only if nothing goes wrong. Order the work so the valuable ' +
        'part lands first.'
    );
  } else if (data.sessions && data.sessions.length > 1) {
    // The percentages say it fits, and they would be right if this were the
    // only thing spending. It is not: the budget drains while these turns run,
    // so a verdict of "room for this" on its own is the one that gets someone
    // cut off mid-job.
    lines.push(
      '  It fits on its own, but ' + data.sessions.length + ' sessions are spending this ' +
        'budget at once, so it will be gone sooner than these figures alone suggest.'
    );
  } else {
    lines.push('  There is room for this. No need to work around the limit.');
  }
  lines.push(
    '  Turns get dearer as context grows, so the higher number is the honest one ' +
      'for a long run.'
  );

  return lines.join('\n');
}

// The session history kept by the Stop hook, one row per session.
function sessionTokens(session) {
  const t = (session && session.tokens) || {};
  return (t.input || 0) + (t.cacheWrite || 0) + (t.cacheRead || 0) + (t.output || 0);
}

function shortId(sessionId) {
  return String(sessionId || '').slice(0, 8);
}

function renderSessions(list, now) {
  const lines = [];
  lines.push('Sessions on this machine, newest first');
  lines.push('');
  if (!list || !list.length) {
    lines.push('  No sessions on record yet. The Stop hook writes one after each reply, so');
    lines.push('  this fills in as soon as a session with the hook installed has run.');
    return lines.join('\n');
  }
  lines.push(
    '  ' + pad('Id', 10) + pad('When', 12) + pad('Project', 24) + padLeft('Prompts', 7) +
      padLeft('Turns', 9) + padLeft('Tokens', 9) + padLeft('Cost', 9)
  );
  for (const session of list) {
    const turns =
      String(session.turns || 0) + (session.subagentTurns > 0 ? '+' + session.subagentTurns : '');
    lines.push(
      '  ' + pad(shortId(session.sessionId), 10) +
        pad(Number.isFinite(session.lastAt) ? formatDuration(now - session.lastAt) + ' ago' : '-', 12) +
        pad(shortenProject(session.project || '-', 22), 24) +
        padLeft(session.prompts || 0, 7) +
        padLeft(turns, 9) +
        padLeft(formatTokens(sessionTokens(session)), 9) +
        padLeft(formatMoney(session.cost || 0), 9) +
        (Number.isFinite(session.endedAt) ? '' : '  open')
    );
  }
  lines.push('');
  lines.push('  Turns are main-thread calls; +N is what subagents made on top.');
  return lines.join('\n');
}

function renderSession(session, now) {
  const lines = [];
  lines.push('Session ' + shortId(session.sessionId) + (session.project ? ' (' + session.project + ')' : ''));
  lines.push('');
  const started = Number.isFinite(session.firstAt)
    ? formatClock(session.firstAt) + ', ' + formatDuration(now - session.firstAt) + ' ago, '
    : '';
  const ended = Number.isFinite(session.endedAt)
    ? 'closed ' + formatDuration(now - session.endedAt) + ' ago' + (session.reason ? ' (' + session.reason + ')' : '')
    : 'still open';
  lines.push('  Started    ' + started + ended);
  lines.push('  Prompts    ' + (session.prompts || 0));
  lines.push(
    '  Turns      ' + (session.turns || 0) +
      (session.subagentTurns > 0 ? ', plus ' + session.subagentTurns + ' by subagents' : '')
  );
  const t = session.tokens || {};
  lines.push(
    '  Tokens     ' + formatTokens(sessionTokens(session)) + ': input ' + formatTokens(t.input || 0) +
      ', cache write ' + formatTokens(t.cacheWrite || 0) + ', cache read ' + formatTokens(t.cacheRead || 0) +
      ', output ' + formatTokens(t.output || 0) +
      (t.reasoning > 0 ? ' (' + formatTokens(t.reasoning) + ' of it reasoning)' : '')
  );
  lines.push('  Cost       ' + formatMoney(session.cost || 0));
  if (Number.isFinite(session.context) && session.context > 0) {
    lines.push('  Context    ' + formatTokens(session.context) + ' tokens at the last call');
  }
  const models = Object.keys(session.models || {}).sort(
    (a, b) => (session.models[b].cost || 0) - (session.models[a].cost || 0)
  );
  models.forEach((id, index) => {
    const row = session.models[id];
    lines.push(
      (index === 0 ? '  Models     ' : '             ') + pad(id, 24) +
        padLeft((row.turns || 0) + ' turns', 12) + padLeft(formatMoney(row.cost || 0), 10)
    );
  });
  return lines.join('\n');
}

// "last", an exact id, or an unambiguous prefix of one.
function pickSession(list, which) {
  const rows = list || [];
  if (!rows.length) return null;
  const want = String(which || 'last');
  if (want === 'last') {
    return rows.slice().sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))[0];
  }
  const exact = rows.find((row) => row.sessionId === want);
  if (exact) return exact;
  const prefixed = rows.filter((row) => String(row.sessionId || '').startsWith(want));
  return prefixed.length === 1 ? prefixed[0] : null;
}

async function main(argv) {
  // Settle the host before anything reads a file, so one run never mixes one
  // agent's percentages with the other's turns.
  setHost(host.detect(argv, process.env));

  // The status line runs on every redraw, so it must not scan transcripts.
  if (argv.indexOf('--status') !== -1) {
    process.stdout.write(statusLine(collect(Date.now())) + '\n');
    return 0;
  }

  // The session history is a file the Stop hook keeps, so neither of these
  // opens a transcript. Required lazily: tally.js depends on this module.
  const sessionAt = argv.indexOf('--session');
  if (sessionAt !== -1 || argv.indexOf('--sessions') !== -1) {
    const tally = require('./tally.js');
    const list = tally.sessions(tally.readState());
    const now = Date.now();
    const json = argv.indexOf('--json') !== -1;
    if (sessionAt !== -1) {
      const next = argv[sessionAt + 1];
      const which = next && next.indexOf('--') !== 0 ? next : 'last';
      const picked = pickSession(list, which);
      if (!picked) {
        process.stderr.write('usage: no session matches "' + which + '". Run --sessions to list them.\n');
        return 2;
      }
      process.stdout.write((json ? JSON.stringify(picked, null, 2) : renderSession(picked, now)) + '\n');
      return 0;
    }
    process.stdout.write((json ? JSON.stringify(list, null, 2) : renderSessions(list, now)) + '\n');
    return 0;
  }

  // Codex writes its meter into the session rollouts, so the cached reading is
  // only as fresh as the last request it made. Asking Codex itself is a second
  // and a child process, which is why it is opt-in rather than the default.
  let codexMeter = null;
  if (argv.indexOf('--refresh') !== -1) {
    if (!isCodex()) {
      process.stderr.write('usage: --refresh applies to Codex. Run /usage in Claude Code.\n');
      return 2;
    }
    try {
      codexMeter = await codex.refresh();
    } catch (err) {
      process.stderr.write(
        'usage: could not read a live figure from Codex (' +
          ((err && err.code) || 'unknown') + '). Falling back to the newest one on disk.\n'
      );
    }
  }

  const wantsJson = argv.indexOf('--json') !== -1;
  const data = await report(Date.now(), { codexMeter });

  const forecastAt = argv.indexOf('--forecast');
  if (forecastAt !== -1) {
    const turns = Number(argv[forecastAt + 1]);
    if (wantsJson) {
      const rows = data.windows
        // A limit this agent cannot spend into is not what a job fails to fit in,
    // so it is never offered as a reason to cut the work down.
    .filter((window) => window.applies !== false)
    .map((window) => forecastWindow(window, turns, data.rates))
        .filter(Boolean);
      process.stdout.write(JSON.stringify({ turns, rates: data.rates, windows: rows }, null, 2) + '\n');
    } else {
      process.stdout.write(renderForecast(data, turns) + '\n');
    }
    return 0;
  }
  const recommendAt = argv.indexOf('--recommend');
  if (recommendAt !== -1) {
    // The turn count is optional: with one the verdict is about that job,
    // without one it is about the headroom in general.
    const next = argv[recommendAt + 1];
    const turns = next && next.indexOf('--') !== 0 ? Number(next) : null;
    const recommend = require('./recommend.js');
    if (wantsJson) {
      process.stdout.write(
        JSON.stringify(recommend.decide(recommend.fromReport(data, turns)), null, 2) + '\n'
      );
    } else {
      process.stdout.write(recommend.renderRecommend(data, turns) + '\n');
    }
    return 0;
  }

  if (wantsJson) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    process.stdout.write(render(data) + '\n');
  }
  return 0;
}

// Assigned before main() can run: tally.js requires this module back, and a
// lazy require from inside main() would otherwise see an empty exports object.
module.exports = {
  main,
  setHost,
  currentHost,
  isCodex,
  otherLimits,
  collectClaude,
  preferLive,
  accountUuid,
  subagentTranscripts,
  claudeTranscriptFiles,
  readClaudeEvents,
  SCAN_VERSION,
  SCAN_KEEP_MS,
  SCAN_MAX_EVENTS,
  sessionTranscriptFile,
  liveEffort,
  liveModel,
  EFFORT_TAIL_BYTES,
  scanFile,
  readScanCache,
  writeScanCache,
  writeJsonAtomic,
  parseSlice,
  RATES,
  WINDOWS,
  rateFor,
  familyOf,
  familyAverage,
  familiesInUse,
  appliesTo,
  markApplicable,
  callPercentiles,
  modelSpend,
  windowForFamily,
  modelHeadroom,
  modelSamples,
  modelRecordFile,
  readModelRecord,
  writeModelRecord,
  MIN_MODEL_SAMPLE,
  isKnownModel,
  costOf,
  tokensOf,
  eventFrom,
  promptFrom,
  readEvents,
  readCalibration,
  buildWindow,
  reconstructWindow,
  SATURATION_LIMIT,
  MIN_BASELINE_TURNS,
  MIN_BASELINE_PERCENT,
  usableCalibration,
  MAX_BASELINE_PERCENT,
  accountFile,
  buildWindows,
  limitWindows,
  lastRejections,
  bindingWindow,
  criticalOthers,
  betterCalibration,
  calibrationForPlan,
  stampPlan,
  calibrationFile,
  CRITICAL_PERCENT,
  dominantEffort,
  effortRates,
  codexBlock,
  effortWarning,
  MIN_EFFORT_SAMPLE,
  EFFORT_DEARER_BY,
  FEW_TURNS_AT_EFFORT,
  typicalTurnCost,
  activeSessions,
  sessionSpend,
  shareOf,
  CONCURRENT_WINDOW_MS,
  MIN_PACE_SAMPLE,
  formatDuration,
  formatUSD,
  formatMoney,
  formatCount,
  renderSessions,
  renderSession,
  pickSession,
  verdictLine,
  render,
  report,
  collect,
  detectPlan,
  costPercentiles,
  reasoningSpend,
  forecastWindow,
  renderForecast,
  creditsFrom,
  formatClock,
  statusLine,
  SHORT_LABELS,
  tokenParts,
  byModel,
  byProject,
  shortenProject,
  formatTokens,
  PLANS,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write('usage: ' + (err && err.message ? err.message : String(err)) + '\n');
    process.exitCode = 1;
  });
}
