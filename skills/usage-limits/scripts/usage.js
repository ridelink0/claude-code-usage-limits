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
const FALLBACK_RATE = { input: 5, output: 25 };

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
  if (id.includes('fable') || id.includes('mythos')) return RATES['claude-fable-5'];
  if (id.includes('opus')) return RATES['claude-opus-5'];
  if (id.includes('sonnet')) return RATES['claude-sonnet-5'];
  if (id.includes('haiku')) return RATES['claude-haiku-4-5'];
  return FALLBACK_RATE;
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
  if (!usage) return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const creation = usage.cache_creation || {};
  const written =
    usage.cache_creation_input_tokens ||
    (creation.ephemeral_5m_input_tokens || 0) + (creation.ephemeral_1h_input_tokens || 0);
  return {
    input: usage.input_tokens || 0,
    cacheWrite: written,
    cacheRead: usage.cache_read_input_tokens || 0,
    output: usage.output_tokens || 0,
  };
}

// One transcript line to an event, or null if it is not a billable turn.
function eventFrom(line, seen) {
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

  // A resumed or forked session repeats earlier turns in a new file.
  const id = (entry.message.id || '') + '|' + (entry.requestId || '');
  if (id !== '|' && seen) {
    if (seen.has(id)) return null;
    seen.add(id);
  }

  return {
    at,
    model: entry.message.model || '',
    effort: entry.effort || null,
    cost: costOf(entry.message.usage, entry.message.model),
    tokens: tokensOf(entry.message.usage),
    parts: tokenParts(entry.message.usage),
  };
}

async function readEvents(since) {
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
    let names = [];
    try {
      names = fs.readdirSync(full);
    } catch (err) {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(full, name);
      try {
        // A file last touched before the window opened holds nothing useful.
        if (fs.statSync(file).mtimeMs < since) continue;
      } catch (err) {
        continue;
      }
      files.push(file);
    }
  }

  const seen = new Set();
  const events = [];
  for (const file of files) {
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const event = eventFrom(line, seen);
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

function totals(events) {
  let cost = 0;
  let tokens = 0;
  const parts = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const event of events) {
    cost += event.cost;
    tokens += event.tokens;
    if (event.parts) {
      parts.input += event.parts.input;
      parts.cacheWrite += event.parts.cacheWrite;
      parts.cacheRead += event.parts.cacheRead;
      parts.output += event.parts.output;
    }
  }
  return { cost, tokens, turns: events.length, parts };
}

// What each model actually cost, dearest first.
function byModel(events) {
  const rows = new Map();
  for (const event of events) {
    const id = event.model || 'unknown';
    if (!rows.has(id)) {
      rows.set(id, {
        model: id,
        turns: 0,
        tokens: 0,
        cost: 0,
        parts: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
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
    }
  }
  const list = [...rows.values()].sort((a, b) => b.cost - a.cost);
  const total = list.reduce((sum, row) => sum + row.cost, 0);
  for (const row of list) row.share = total > 0 ? row.cost / total : 0;
  return list;
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

// Everything the report needs about one limit window.
function buildWindow(spec, snapshot, events, now) {
  const percent =
    snapshot && typeof snapshot.utilization === 'number' ? snapshot.utilization : null;
  const resetsAt = snapshot && snapshot.resets_at ? Date.parse(snapshot.resets_at) : null;
  const hasReset = Number.isFinite(resetsAt);
  const start = hasReset ? resetsAt - spec.span : now - spec.span;

  const inWindow = events.filter((event) => event.at >= start && event.at <= now);
  const spent = totals(inWindow);

  const recentStart = Math.max(start, now - HOUR);
  const recentEvents = events.filter((event) => event.at >= recentStart && event.at <= now);
  const recent = totals(recentEvents);
  const recentHours = Math.max((now - recentStart) / HOUR, 1 / 60);

  const window = {
    key: spec.key,
    label: spec.label,
    percentUsed: percent,
    percentLeft: percent === null ? null : Math.max(0, 100 - percent),
    resetsAt: hasReset ? resetsAt : null,
    msToReset: hasReset ? resetsAt - now : null,
    windowStart: start,
    spentUSD: spent.cost,
    spentTokens: spent.tokens,
    turns: spent.turns,
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
    verdict: 'unknown',
  };

  // Calibrate against this account: how many dollars of measured traffic
  // moved the meter one point.
  if (percent !== null && percent > 0 && spent.cost > 0) {
    window.usdPerPercent = spent.cost / percent;
    window.remainingUSD = window.usdPerPercent * window.percentLeft;
    // The API reports whole numbers, so a low reading is a wide bracket.
    window.coarse = percent < 5;

    const perTurn = recent.turns
      ? recent.cost / recent.turns
      : spent.cost / Math.max(spent.turns, 1);
    window.percentPerTurn = perTurn / window.usdPerPercent;
    window.percentPerHour = window.recentUSDPerHour / window.usdPerPercent;
    if (window.percentPerTurn > 0) {
      window.turnsLeft = Math.floor(window.percentLeft / window.percentPerTurn);
    }
    if (window.percentPerHour > 0) {
      window.headroomMs = (window.percentLeft / window.percentPerHour) * HOUR;
    }
  }

  if (percent === null) window.verdict = 'unknown';
  else if (percent >= 100) window.verdict = 'exhausted';
  else if (window.headroomMs === null) window.verdict = 'idle';
  else if (window.msToReset === null) window.verdict = 'burning';
  else if (window.headroomMs >= window.msToReset) window.verdict = 'resets-first';
  else window.verdict = 'runs-out';

  return window;
}

// The window that will stop the work first.
function bindingWindow(windows) {
  const live = windows.filter((w) => w.percentUsed !== null);
  if (!live.length) return null;

  const measured = live.filter((w) => w.headroomMs !== null);
  if (measured.length) {
    return measured.reduce((worst, w) => (w.headroomMs < worst.headroomMs ? w : worst));
  }
  return live.reduce((worst, w) => (w.percentUsed > worst.percentUsed ? w : worst));
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

function formatUSD(value) {
  if (value === null || !Number.isFinite(value)) return '-';
  if (value >= 100) return '$' + Math.round(value);
  if (value >= 1) return '$' + value.toFixed(2);
  return '$' + value.toFixed(3);
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

function collect(now) {
  const account = readJson(accountFile()) || {};
  const settings = readJson(path.join(configDir(), 'settings.json')) || {};
  const cache = account.cachedUsageUtilization || null;
  const utilization = cache && cache.utilization ? cache.utilization : null;
  const oauth = account.oauthAccount || {};
  const plan = detectPlan(oauth);

  return {
    now,
    accountFile: accountFile(),
    plan: plan.label,
    planId: plan.id,
    planTier: plan.tier,
    planAdvice: plan.advice,
    snapshotAgeMs: cache && cache.fetchedAtMs ? now - cache.fetchedAtMs : null,
    utilization,
    settings: {
      model: settings.model || 'default',
      effortLevel: settings.effortLevel || 'default',
    },
    extraUsage: utilization && utilization.extra_usage ? utilization.extra_usage : null,
  };
}

// No snapshot at all means no windows, which is what tells the report to
// explain itself rather than print a table of dashes.
function buildWindows(utilization, events, now) {
  if (!utilization) return [];
  return WINDOWS.map((spec) => {
    const snapshot = utilization[spec.key];
    // The per-model weekly windows only exist on some plans.
    if (spec.key !== 'five_hour' && spec.key !== 'seven_day' && !snapshot) return null;
    return buildWindow(spec, snapshot, events, now);
  }).filter(Boolean);
}

async function report(now) {
  const base = collect(now);
  // A stale snapshot can put a window's start slightly further back than
  // seven days, so give the scan a day of slack.
  const earliest = now - 8 * DAY;
  const events = await readEvents(earliest);

  const windows = buildWindows(base.utilization, events, now);

  const recentEvents = events.filter((event) => event.at >= now - HOUR);
  const recent = totals(recentEvents);

  const binding = bindingWindow(windows);
  const scopeStart = binding ? binding.windowStart : now - 7 * DAY;
  const scoped = events.filter((event) => event.at >= scopeStart && event.at <= now);
  const scopedTotals = totals(scoped);

  return Object.assign({}, base, {
    windows,
    binding,
    models: byModel(scoped),
    tokens: scopedTotals.parts,
    scopeLabel: binding ? binding.label : 'last 7 days',
    recent: {
      turns: recent.turns,
      usd: recent.cost,
      usdPerTurn: recent.turns ? recent.cost / recent.turns : null,
      tokens: recent.tokens,
      effort: dominantEffort(recentEvents),
    },
    measuredTurns: events.length,
  });
}

function verdictLine(window) {
  if (!window) {
    return 'No limit snapshot on disk yet. Run /usage once in Claude Code to populate it.';
  }
  const name = window.label + ' limit';
  switch (window.verdict) {
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
  for (const spec of WINDOWS) {
    const snapshot = utilization[spec.key];
    if (!snapshot || typeof snapshot.utilization !== 'number') continue;
    const resetsAt = snapshot.resets_at ? Date.parse(snapshot.resets_at) : null;
    parts.push({
      label: SHORT_LABELS[spec.key] || spec.label,
      percent: snapshot.utilization,
      msToReset: Number.isFinite(resetsAt) ? resetsAt - now : null,
    });
  }
  if (!parts.length) return '';

  const worst = parts.reduce((a, b) => (b.percent > a.percent ? b : a));
  const text = parts
    .map(
      (part) =>
        part.label + ' ' + part.percent + '%' +
        (part.msToReset === null ? '' : ' ' + formatDuration(part.msToReset))
    )
    .join('  ');

  return (worst.percent >= 90 ? 'LOW  ' : '') + text;
}

function render(data) {
  const lines = [];
  lines.push('Claude Code usage');
  lines.push('');
  lines.push('  Plan       ' + data.plan);
  lines.push(
    '  Snapshot   ' +
      (data.snapshotAgeMs === null ? 'none on disk' : formatDuration(data.snapshotAgeMs) + ' old')
  );
  lines.push('  Settings   model=' + data.settings.model + '  effort=' + data.settings.effortLevel);
  if (data.extraUsage) {
    lines.push(
      '  Overage    ' +
        (data.extraUsage.is_enabled
          ? 'on, spending continues past the limit'
          : 'off, work stops at the limit')
    );
  }
  lines.push('');

  if (!data.windows.length) {
    lines.push('  No usage snapshot in ' + (data.accountFile || '~/.claude.json') + '.');
    lines.push('  Run /usage once inside Claude Code to populate it, then try again.');
    return lines.join('\n');
  }

  lines.push(
    '  ' + pad('Window', 15) + padLeft('Used', 6) + padLeft('Resets in', 12) +
      padLeft('Left', 10) + padLeft('Turns left', 12)
  );
  for (const window of data.windows) {
    const marker = data.binding && window.key === data.binding.key ? '   <- binding' : '';
    lines.push(
      '  ' + pad(window.label, 15) +
        padLeft(window.percentUsed === null ? '-' : window.percentUsed + '%', 6) +
        padLeft(formatDuration(window.msToReset), 12) +
        padLeft(formatUSD(window.remainingUSD), 10) +
        padLeft(window.turnsLeft === null ? '-' : '~' + formatCount(window.turnsLeft), 12) +
        marker
    );
  }
  lines.push('');

  if (data.models && data.models.length) {
    lines.push('  Models in the ' + (data.scopeLabel || 'window') + ' window');
    lines.push(
      '  ' + pad('  Model', 24) + padLeft('Turns', 7) + padLeft('Tokens', 10) +
        padLeft('Output', 9) + padLeft('Share', 8)
    );
    for (const row of data.models) {
      lines.push(
        '  ' + pad('  ' + row.model, 24) + padLeft(row.turns, 7) +
          padLeft(formatTokens(row.tokens), 10) +
          padLeft(formatTokens(row.parts.output), 9) +
          padLeft(Math.round(row.share * 100) + '%', 8)
      );
    }
    if (data.tokens) {
      lines.push(
        '    Tokens  input ' + formatTokens(data.tokens.input) +
          ', cache write ' + formatTokens(data.tokens.cacheWrite) +
          ', cache read ' + formatTokens(data.tokens.cacheRead) +
          ', output ' + formatTokens(data.tokens.output)
      );
    }
    lines.push('');
  }

  if (data.recent.turns) {
    lines.push(
      '  Recent pace   ' + data.recent.turns + ' turns in the last hour, ' +
        formatUSD(data.recent.usdPerTurn) + ' per turn' +
        (data.recent.effort ? ', effort ' + data.recent.effort : '')
    );
  } else {
    lines.push('  Recent pace   no turns in the last hour');
  }
  lines.push('  Measured      ' + formatCount(data.measuredTurns) + ' turns of local transcript');

  if (data.binding && data.binding.coarse) {
    lines.push('  Note          the meter reads in whole percent, so a low reading is a wide bracket');
  }

  lines.push('');
  lines.push(verdictLine(data.binding));
  if (data.planAdvice) {
    lines.push('');
    lines.push(data.planAdvice);
  }
  return lines.join('\n');
}

async function main(argv) {
  // The status line runs on every redraw, so it must not scan transcripts.
  if (argv.indexOf('--status') !== -1) {
    process.stdout.write(statusLine(collect(Date.now())) + '\n');
    return 0;
  }

  const wantsJson = argv.indexOf('--json') !== -1;
  const data = await report(Date.now());
  if (wantsJson) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    process.stdout.write(render(data) + '\n');
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write('usage: ' + (err && err.message ? err.message : String(err)) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  RATES,
  WINDOWS,
  rateFor,
  costOf,
  tokensOf,
  eventFrom,
  buildWindow,
  buildWindows,
  bindingWindow,
  dominantEffort,
  formatDuration,
  formatUSD,
  formatCount,
  verdictLine,
  render,
  report,
  collect,
  detectPlan,
  statusLine,
  SHORT_LABELS,
  tokenParts,
  byModel,
  formatTokens,
  PLANS,
};
