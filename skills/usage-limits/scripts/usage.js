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

// USD per million tokens, first-party API rates.
const RATES = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
// A model can ship before this table knows about it. Rather than refusing to
// price it, fall back to the average of the family it names. Averaging assumes
// nothing about which direction prices moved, unlike pinning to one release.
// An unrecognised family falls back to Opus rates on purpose: over-estimating
// cost understates headroom, and that is the safe direction for a budget.
const FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];
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

// Whether the price came from the table or from an assumption.
function isKnownModel(model) {
  return Object.prototype.hasOwnProperty.call(RATES, String(model || '').toLowerCase());
}

// Cache traffic is priced as a multiple of the input rate.
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const CACHE_READ = 0.1;

const WINDOWS = [
  { key: 'five_hour', label: '5-hour', span: 5 * HOUR },
  { key: 'seven_day', label: 'weekly', span: 7 * DAY },
  { key: 'seven_day_opus', label: 'weekly (Opus)', span: 7 * DAY },
  { key: 'seven_day_sonnet', label: 'weekly (Sonnet)', span: 7 * DAY },
];

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
function accountFile() {
  const scoped = path.join(configDir(), '.claude.json');
  if (fs.existsSync(scoped)) return scoped;
  return path.join(os.homedir(), '.claude.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function rateFor(model) {
  const id = String(model || '').toLowerCase();
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
    // Older records only carry the undifferentiated total.
    writeUnits = (usage.cache_creation_input_tokens || 0) * CACHE_WRITE_5M;
  }

  const inputUnits =
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) * CACHE_READ +
    writeUnits;

  return (inputUnits * rate.input + (usage.output_tokens || 0) * rate.output) / 1e6;
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

async function readEvents(since) {
  if (isCodex()) return codex.readEvents(since);
  return readClaudeEvents(since);
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

async function readClaudeEvents(since) {
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
        for (const file of freshFiles(path.join(full, entry.name, 'subagents'), since)) {
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

  const seen = new Set();
  const events = [];
  for (const entry of files) {
    const stream = fs.createReadStream(entry.file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const event = eventFrom(line, seen, entry.project);
        if (event && event.at >= since) events.push(event);
      }
    } catch (err) {
      // A half-written line at the tail of a live session is expected.
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  events.sort((a, b) => a.at - b.at);
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
function typicalTurnCost(recentEvents, windowEvents, allEvents, minSample) {
  const floor = Number.isFinite(minSample) ? minSample : MIN_PACE_SAMPLE;

  // What a turn costs is a fact about how you work, not about which budget it
  // is being measured against, so a thin window borrows from a wider sample
  // rather than inventing a figure from two turns. Subagent calls are left
  // out: they are small and many, and would make a turn look cheap.
  const tiers = [mainThread(recentEvents), mainThread(windowEvents), mainThread(allEvents)];
  let pool = [];
  for (const tier of tiers) {
    if (tier && tier.length >= floor) {
      pool = tier;
      break;
    }
    if (tier && tier.length > pool.length) pool = tier;
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
  return middle.reduce((sum, cost) => sum + cost, 0) / middle.length;
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
function costPercentiles(events) {
  const costs = mainThread(events)
    .map((event) => event.cost)
    .filter((cost) => Number.isFinite(cost) && cost > 0)
    .sort((a, b) => a - b);
  if (!costs.length) return null;

  const at = (fraction) => costs[Math.min(costs.length - 1, Math.floor(fraction * costs.length))];
  return { median: at(0.5), high: at(0.8), sample: costs.length };
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
    fs.mkdirSync(path.dirname(calibrationFile()), { recursive: true });
    fs.writeFileSync(calibrationFile(), JSON.stringify(all), 'utf8');
  } catch (err) {
    // Losing it costs accuracy on the next thin baseline, nothing more.
  }
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

// A sample is better when it rests on more turns. Percentages read in whole
// numbers, so a bigger percentage also divides more precisely.
function betterCalibration(current, candidate) {
  if (!candidate || !Number.isFinite(candidate.usdPerPercent) || candidate.usdPerPercent <= 0) {
    return current || null;
  }
  if (!current || !Number.isFinite(current.turns)) return candidate;
  return candidate.turns > current.turns ? candidate : current;
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
      rawPercent > 0 && upTo.cost > 0 && upTo.turns >= MIN_BASELINE_TURNS
        ? { usdPerPercent: upTo.cost / rawPercent, turns: upTo.turns, percent: rawPercent }
        : null;
    if (selfPriced) window.calibration = selfPriced;

    const known = extra.knownCalibration;
    const usable =
      known && Number.isFinite(known.usdPerPercent) && known.usdPerPercent > 0 ? known : null;
    // Trust the better-sampled of the two, whichever that is.
    const chosen =
      selfPriced && usable
        ? (usable.turns > selfPriced.turns ? usable : selfPriced)
        : selfPriced || usable;

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
  const measured = percent !== null && percent > 0 && spent.cost > 0 && !thin;
  const derived = measured ? spent.cost / percent : null;
  const known = extra.knownCalibration;
  const priced =
    derived !== null
      ? derived
      : Number.isFinite(extra.usdPerPercent) && extra.usdPerPercent > 0
        ? extra.usdPerPercent
        : known && Number.isFinite(known.usdPerPercent) && known.usdPerPercent > 0
          ? known.usdPerPercent
          : null;

  if (percent !== null && priced !== null) {
    window.usdPerPercent = priced;
    window.remainingUSD = window.usdPerPercent * window.percentLeft;
    // The API reports whole numbers, so a low reading is a wide bracket.
    window.coarse = percent < 5;

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
      w.percentUsed !== null &&
      w.percentUsed >= limit
  );
}

// The window that will stop the work first.
function bindingWindow(windows) {
  const known = windows.filter((w) => w.percentUsed !== null);
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

function collect(now) {
  if (isCodex()) return codex.collect(now);
  return collectClaude(now);
}

function collectClaude(now) {
  const account = readJson(accountFile()) || {};
  const settings = readJson(path.join(configDir(), 'settings.json')) || {};
  const cache = account.cachedUsageUtilization || null;
  const utilization = cache && cache.utilization ? cache.utilization : null;
  const oauth = account.oauthAccount || {};
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
    snapshotAgeMs: cache && cache.fetchedAtMs ? now - cache.fetchedAtMs : null,
    snapshotFetchedAt: cache && cache.fetchedAtMs ? cache.fetchedAtMs : null,
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
  return table.map((spec) => {
    const snapshot = utilization[spec.key];
    // The per-model weekly windows only exist on some plans.
    if (spec.key !== 'five_hour' && spec.key !== 'seven_day' && !snapshot) return null;

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

    const window = buildWindow(spec, anchored, events, now, {
      fetchedAt,
      knownCalibration: known,
      ...(windowStart === undefined ? {} : { windowStart }),
    });
    if (refusal) {
      window.refusedAt = refusal.at;
      window.refusedResetsAt = refusal.resetsAt;
    }
    if (!window.stale) {
      return reconstructUnanchored(spec, window, events, now, known) || window;
    }

    // Rolled over. Rebuild from local history rather than going blind on it.
    const rebuilt = reconstructWindow(spec, snapshot, events, now);
    if (!rebuilt) return window;
    return buildWindow(
      spec,
      { utilization: rebuilt.percentUsed, resets_at: null },
      events,
      now,
      {
        estimated: true,
        windowStart: rebuilt.windowStart,
        usdPerPercent: rebuilt.usdPerPercent,
      }
    );
  }).filter(Boolean);
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
  const all = await readEvents(earliest);
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
    staleWindows: windows.filter((w) => w.stale).length,
    rates: costPercentiles(recentEvents.length >= 5 ? recentEvents : scoped),
    resumeAt: binding ? binding.resetsAt : null,
    models: scopedModels,
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
  const parts = [];
  for (const spec of collected.windowSpecs && collected.windowSpecs.length
    ? collected.windowSpecs
    : WINDOWS) {
    const snapshot = utilization[spec.key];
    if (!snapshot || typeof snapshot.utilization !== 'number') continue;
    const resetsAt = snapshot.resets_at ? Date.parse(snapshot.resets_at) : null;
    const msToReset = Number.isFinite(resetsAt) ? resetsAt - now : null;
    parts.push({
      label: SHORT_LABELS[spec.key] || spec.label,
      percent: snapshot.utilization,
      msToReset,
      stale: msToReset !== null && msToReset <= 0,
      // Zero with no reset time is not an empty window, it is a bucket that is
      // not reporting: a real window at 0% has just reset and says when it will
      // do so again. The status line cannot scan transcripts to find out which,
      // so it must not print the flattering reading as though it were measured.
      unreported: snapshot.utilization === 0 && !Number.isFinite(resetsAt),
    });
  }
  if (!parts.length) return '';

  const trusted = parts.filter((part) => !part.stale && !part.unreported);
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
      (data.snapshotAgeMs === null ? 'none on disk' : formatDuration(data.snapshotAgeMs) + ' old')
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
    if (data.windowless) {
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
    const marker = data.binding && window.key === data.binding.key ? '   <- binding' : '';
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
  lines.push('');

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
        .map((window) => forecastWindow(window, turns, data.rates))
        .filter(Boolean);
      process.stdout.write(JSON.stringify({ turns, rates: data.rates, windows: rows }, null, 2) + '\n');
    } else {
      process.stdout.write(renderForecast(data, turns) + '\n');
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
  readClaudeEvents,
  RATES,
  WINDOWS,
  rateFor,
  familyOf,
  familyAverage,
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
  buildWindows,
  lastRejections,
  bindingWindow,
  criticalOthers,
  betterCalibration,
  calibrationForPlan,
  stampPlan,
  calibrationFile,
  CRITICAL_PERCENT,
  dominantEffort,
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
