'use strict';

// The Codex reader.
//
// Codex turns out to keep both of the things this plugin needs in one place.
// Every session writes a rollout under ~/.codex/sessions, one JSON object per
// line, and each model request appends a `token_count` event carrying:
//
//   info.last_token_usage   what that request cost, in tokens
//   rate_limits             the account meter, as percentages with reset times
//
// So the rollouts are Claude's ~/.claude.json and ~/.claude/projects at once:
// the newest `rate_limits` is the snapshot, and the `last_token_usage` records
// are the pace. That means the window arithmetic in usage.js works unchanged;
// only the two readers below are different.
//
// Reading files is the fast path and costs nothing. `refresh()` asks Codex
// itself for a live reading, which takes about a second and starts a child
// process, so it is reserved for the times the newest rollout has gone stale.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const host = require('./host.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Codex reports up to two windows, a primary and a secondary, and which of them
// exist is a property of the plan rather than a constant.
//
// Plus and Pro both get the five-hour window, and a weekly one "may apply" on
// top. Enterprise and Edu on flexible pricing get neither: usage scales with
// credits instead, so the account reports no rolling window at all. Business
// tiers have been seen reporting none as well. And it moves: the five-hour
// window was withdrawn from Plus and later reinstated.
//
// So nothing here is assumed. A slot the payload does not carry produces no
// window, the length of a window comes from the payload, and the key it is
// filed under is derived from that length rather than from which slot it
// arrived in. Filing a seven-day window under `five_hour` because it happened
// to be the primary would price a point of one window with the cost of another.
const SLOTS = [
  { slot: 'primary', span: 5 * HOUR },
  { slot: 'secondary', span: 7 * DAY },
];

// Tokens are not all worth the same, and the meter is moved by what they cost
// rather than by how many there are. These weights are relative, not money:
// what matters downstream is only the ratio between the classes, because the
// calibration step divides the total by the meter's own percentage and so
// cancels the scale out. Output is the dear one, cached input the cheap one.
const WEIGHTS = { input: 1, cached: 0.1, cacheWrite: 1.25, output: 8 };

// What each plan means for how careful to be. Which windows a plan actually
// gets is never taken from here: that is read from the payload, because it
// differs by plan and has changed more than once. This is only the advice.
const POOLED =
  'Seats are pooled and the allowance is a workspace setting. Confirm headroom ' +
  'with whoever administers it before planning a long job around these numbers.';

const PLANS = {
  free: {
    label: 'ChatGPT Free',
    advice:
      'Free has the least room of any plan, and whichever window it reports ' +
      'will bind almost at once. Do one thing at a time and land it.',
  },
  go: {
    label: 'ChatGPT Go',
    advice:
      'Go sits just above Free. Expect the shorter window to bind first and ' +
      'size the job before starting it.',
  },
  plus: {
    label: 'ChatGPT Plus',
    advice:
      'Plus has room for ordinary work, but a long agentic run will find the ' +
      'five-hour window well before the weekly one. Size the job first.',
  },
  prolite: {
    label: 'ChatGPT Pro Lite',
    advice: 'Pro Lite has more room than Plus. Watch whichever window is reported as higher.',
  },
  pro: {
    label: 'ChatGPT Pro',
    advice:
      'Pro has the five-hour window too, with far more in it. It rarely binds, ' +
      'but a heavy day still reaches it, so do not assume it cannot.',
  },
  business: { label: 'ChatGPT Business', advice: POOLED },
  self_serve_business_prolite: { label: 'ChatGPT Business', advice: POOLED },
  self_serve_business_usage_based: {
    label: 'ChatGPT Business',
    advice:
      'This workspace is billed by usage rather than capped, so the limit is ' +
      'cost rather than a window. Watch the credits, not a percentage.',
  },
  team: { label: 'ChatGPT Team', advice: POOLED },
  enterprise: { label: 'ChatGPT Enterprise', advice: POOLED },
  ent26: { label: 'ChatGPT Enterprise', advice: POOLED },
  enterprise_cbp_automation: { label: 'ChatGPT Enterprise', advice: POOLED },
  enterprise_cbp_usage_based: {
    label: 'ChatGPT Enterprise',
    advice:
      'On flexible pricing there is no rolling window at all: usage scales ' +
      'with credits, so the credit balance is the budget to plan against.',
  },
  edu: { label: 'ChatGPT Edu', advice: POOLED },
  edu_plus: { label: 'ChatGPT Edu', advice: POOLED },
  edu_pro: { label: 'ChatGPT Edu', advice: POOLED },
};

function homeDir() {
  return host.codexHome();
}

function sessionsDir() {
  return path.join(homeDir(), 'sessions');
}

// ---------------------------------------------------------------------------
// Finding codex itself
// ---------------------------------------------------------------------------

// The Codex desktop app does not put codex.exe on PATH. It installs it under a
// content-hashed directory that changes with every update, which is why the
// first port of this reader could never find it and reported "not signed in" on
// a machine that was signed in. Look where it actually lives, newest first.
function windowsCandidates() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const root = path.join(local, 'OpenAI', 'Codex', 'bin');
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    return [];
  }

  const found = [];
  for (const name of names) {
    const file = path.join(root, name, 'codex.exe');
    try {
      found.push({ file, at: fs.statSync(file).mtimeMs });
    } catch (err) {
      // A half-written or superseded install directory.
    }
  }
  return found.sort((a, b) => b.at - a.at).map((entry) => entry.file);
}

// The app records the path it is using in its own config, which is the most
// reliable pointer of all when it is there.
function fromConfig() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(homeDir(), 'config.toml'), 'utf8');
  } catch (err) {
    return null;
  }
  const match = /^\s*CODEX_CLI_PATH\s*=\s*['"](.+?)['"]\s*$/m.exec(raw);
  return match ? match[1] : null;
}

function onPath() {
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const found = [];
  for (const dir of dirs) {
    const file = path.join(dir, name);
    // A .cmd or .ps1 shim cannot be spawned without a shell, so only take the
    // real executable.
    if (host.exists(file)) found.push(file);
  }
  return found;
}

function findExecutable(override) {
  const candidates = [];
  if (override) candidates.push(override);
  if (process.env.USAGE_LIMITS_CODEX) candidates.push(process.env.USAGE_LIMITS_CODEX);
  if (process.env.CODEX_CLI_PATH) candidates.push(process.env.CODEX_CLI_PATH);

  const configured = fromConfig();
  if (configured) candidates.push(configured);

  if (process.platform === 'win32') {
    candidates.push(...windowsCandidates());
  } else {
    candidates.push(path.join(homeDir(), 'bin', 'codex'));
    candidates.push('/usr/local/bin/codex');
    candidates.push('/opt/homebrew/bin/codex');
  }
  candidates.push(...onPath());

  for (const file of candidates) {
    if (file && host.exists(file)) return file;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading the rollouts
// ---------------------------------------------------------------------------

function rolloutFiles(since) {
  const root = sessionsDir();
  const files = [];

  // Rollouts are filed under sessions/YYYY/MM/DD, so walking is cheap, but
  // guard the depth anyway rather than trusting the layout.
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      try {
        const at = fs.statSync(full).mtimeMs;
        // A file untouched since before the window opened holds nothing for it.
        if (Number.isFinite(since) && at < since) continue;
        files.push({ file: full, at });
      } catch (err) {
        // Deleted between the listing and the stat.
      }
    }
  };

  walk(root, 0);
  return files.sort((a, b) => a.at - b.at);
}

// The session id is in the first line of the rollout, and also in its name.
// Take it from the name, which costs nothing and is right either way.
function sessionOf(file) {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
    .exec(path.basename(file));
  return match ? match[1] : null;
}

function weigh(usage) {
  if (!usage) return 0;
  const input = Number(usage.input_tokens) || 0;
  const cached = Number(usage.cached_input_tokens) || 0;
  const written = Number(usage.cache_write_input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  // input_tokens is the whole prompt including whatever was served from cache,
  // so the uncached part is the difference. Reasoning tokens are already
  // counted inside output_tokens.
  const fresh = Math.max(0, input - cached);
  return (
    fresh * WEIGHTS.input +
    cached * WEIGHTS.cached +
    written * WEIGHTS.cacheWrite +
    output * WEIGHTS.output
  ) / 1e6;
}

function partsOf(usage) {
  if (!usage) return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0 };
  const input = Number(usage.input_tokens) || 0;
  const cached = Number(usage.cached_input_tokens) || 0;
  return {
    input: Math.max(0, input - cached),
    cacheWrite: Number(usage.cache_write_input_tokens) || 0,
    cacheRead: cached,
    output: Number(usage.output_tokens) || 0,
    // Codex reports the same thing Claude does under a different name, and the
    // same way round: inside output rather than beside it. Its own totals prove
    // it, with total_tokens coming to input plus output on 11,064 of 11,133
    // recorded turns. So it is carried for reporting and never added to a sum.
    reasoning: Number(usage.reasoning_output_tokens) || 0,
  };
}

function tokensOf(usage) {
  if (!usage) return 0;
  const total = Number(usage.total_tokens);
  if (Number.isFinite(total) && total > 0) return total;
  const parts = partsOf(usage);
  return parts.input + parts.cacheWrite + parts.cacheRead + parts.output;
}

// The model and effort in force are announced once per turn in a `turn_context`
// line, not repeated on each request, so a reader has to carry the last one
// forward. Without that every row in the report reads "unknown".
function contextFrom(line) {
  if (line.indexOf('"turn_context"') === -1) return null;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch (err) {
    return null;
  }
  if (!entry || entry.type !== 'turn_context' || !entry.payload) return null;
  return {
    model: typeof entry.payload.model === 'string' ? entry.payload.model : '',
    effort: typeof entry.payload.effort === 'string' ? entry.payload.effort : null,
  };
}

// One rollout line to an event, or null if it is not a billable request.
function eventFrom(line, file, project, context) {
  if (line.indexOf('"token_count"') === -1) return null;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch (err) {
    return null;
  }
  const payload = entry && entry.payload;
  if (!payload || payload.type !== 'token_count') return null;

  const at = Date.parse(entry.timestamp);
  if (!Number.isFinite(at)) return null;

  const usage = payload.info && payload.info.last_token_usage;
  if (!usage) return null;

  return {
    at,
    model: (context && context.model) || '',
    effort: (context && context.effort) || null,
    cost: weigh(usage),
    tokens: tokensOf(usage),
    parts: partsOf(usage),
    project: project || null,
    sessionId: sessionOf(file),
    // Carried so the newest meter reading can be picked out of the same pass.
    meter: payload.rate_limits || null,
  };
}

// Codex names the rollout's working directory in its first line. Reading one
// line per file is cheap and it is what makes the "projects" table mean
// something.
function projectOf(file) {
  let raw;
  try {
    const handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(4096);
    const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
    fs.closeSync(handle);
    raw = buffer.slice(0, read).toString('utf8');
  } catch (err) {
    return null;
  }
  const newline = raw.indexOf('\n');
  if (newline === -1) return null;
  let entry;
  try {
    entry = JSON.parse(raw.slice(0, newline));
  } catch (err) {
    return null;
  }
  const cwd = entry && entry.payload && entry.payload.cwd;
  return typeof cwd === 'string' ? cwd : null;
}

async function readEvents(since) {
  const files = rolloutFiles(since);
  const events = [];

  for (const entry of files) {
    const project = projectOf(entry.file);
    const stream = fs.createReadStream(entry.file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let context = null;
    try {
      for await (const line of lines) {
        const next = contextFrom(line);
        if (next) {
          context = next;
          continue;
        }
        const event = eventFrom(line, entry.file, project, context);
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

// ---------------------------------------------------------------------------
// The meter
// ---------------------------------------------------------------------------

function isoOf(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

// Turn one `rate_limits` payload into the shape the window table already reads,
// so nothing downstream has to know which host it came from.
// A window is filed under what it actually is. The two lengths the shared table
// already knows keep its keys, so the calibration learned for a 5-hour window
// under Claude Code and under Codex stay comparable in shape; anything else is
// named by its own length so it gets a calibration of its own.
function keyFor(span, taken) {
  const preferred =
    span === 5 * HOUR ? 'five_hour' : span === 7 * DAY ? 'seven_day' : 'window_' + Math.round(span / MINUTE) + 'm';
  if (!taken || !taken.has(preferred)) return preferred;
  // Two windows of the same length would otherwise overwrite each other.
  let suffix = 2;
  while (taken.has(preferred + '_' + suffix)) suffix += 1;
  return preferred + '_' + suffix;
}

// One reading of one window, with the key it belongs under already worked out.
//
// Both the report and the calibration have to agree about which window is
// which, and they have to keep agreeing as the payload changes shape. Deriving
// the key in two places is how they stop agreeing: the calibration was once
// looking the key up in a table that no longer had one, and quietly measured
// nothing at all. So it is derived here, once.
function readingsOf(meter) {
  if (!meter || typeof meter !== 'object') return [];
  const taken = new Set();
  const readings = [];

  for (const entry of SLOTS) {
    const window = meter[entry.slot];
    if (!window || typeof window !== 'object') continue;
    const percent = Number(window.used_percent);
    if (!Number.isFinite(percent)) continue;

    const minutes = Number(window.window_minutes);
    const span = Number.isFinite(minutes) && minutes > 0 ? minutes * MINUTE : entry.span;
    const key = keyFor(span, taken);
    taken.add(key);
    readings.push({
      key,
      slot: entry.slot,
      span,
      label: labelFor(span, entry.slot),
      percent,
      resetsAt: Number(window.resets_at) || null,
    });
  }
  return readings;
}

function utilizationFrom(meter) {
  if (!meter || typeof meter !== 'object') return null;

  const utilization = {};
  const specs = [];

  for (const reading of readingsOf(meter)) {
    utilization[reading.key] = {
      // The meter reports fractional percentages; the rest of the code expects
      // whole numbers, the way Claude's own snapshot reports them.
      utilization: Math.round(reading.percent),
      resets_at: isoOf(reading.resetsAt),
    };
    specs.push({ key: reading.key, label: reading.label, span: reading.span });
  }

  // No windows is a real answer, not a missing one: on flexible pricing the
  // account has no rolling limit and usage scales with credits. Returning null
  // here would throw away the plan and the credit balance, which on such an
  // account are the only figures there are.
  const credits = meter.credits && typeof meter.credits === 'object' ? meter.credits : null;
  return {
    windowless: specs.length === 0,
    utilization: specs.length ? utilization : null,
    specs,
    planType: typeof meter.plan_type === 'string' ? meter.plan_type : null,
    // Codex says outright when a limit has already been hit, which is a firmer
    // signal than a rounded percentage and must not be rounded away.
    reachedType:
      typeof meter.rate_limit_reached_type === 'string' ? meter.rate_limit_reached_type : null,
    spendControlReached: meter.spend_control_reached === true,
    credits: credits
      ? {
          enabled: credits.has_credits === true || credits.unlimited === true,
          everEnabled: credits.has_credits === true,
          limitReached: false,
          used: null,
          limit: null,
          percent: null,
          unlimited: credits.unlimited === true,
          balance: credits.balance === undefined ? null : credits.balance,
          currency: 'credits',
          disabledReason: null,
        }
      : null,
  };
}

// A span the table already has a name for keeps that name; anything else is
// described by its own length rather than mislabelled as one of the two. The
// slot name is the last resort, because "primary" at least does not claim a
// duration the window may not have.
function labelFor(span, fallback) {
  if (span === 5 * HOUR) return '5-hour';
  if (span === 7 * DAY) return 'weekly';
  const hours = span / HOUR;
  if (hours >= 24 && hours % 24 === 0) return hours / 24 + '-day';
  if (hours >= 1 && hours % 1 === 0) return hours + '-hour';
  const minutes = Math.round(span / MINUTE);
  return minutes > 0 ? minutes + '-minute' : fallback || 'window';
}

function planFrom(planType) {
  const id = String(planType || '').toLowerCase();
  const known = PLANS[id];
  if (known) return { id, label: known.label, advice: known.advice };
  return {
    id: id || 'unknown',
    // Show whatever was reported rather than "unknown" for a plan name that is
    // simply new.
    label: id ? 'ChatGPT ' + id : 'unknown',
    advice: null,
  };
}

// What one point of a window costs, measured rather than assumed.
//
// Claude Code has to infer this: its meter and its transcripts are separate
// files, so the price of a point is derived from a snapshot and everything
// spent around it. Codex writes both into the same record, which makes the
// measurement direct. Every request logs the meter as it stood and what that
// request cost, so the price of a point is the spend between two readings
// divided by how far the meter moved between them.
//
// The earlier port asked the user to count every turn by hand and refused to
// estimate without it, which is why it never produced a turn figure at all.
const MIN_POINTS_MOVED = 2;
const MIN_SAMPLE_TURNS = 5;

function calibrate(events, key, now) {
  const readings = [];
  for (const event of events) {
    if (!event.meter) continue;
    // The same assignment the report uses, so the window being calibrated is
    // certainly the window being reported.
    const reading = readingsOf(event.meter).find((one) => one.key === key);
    if (!reading) continue;
    readings.push({ at: event.at, percent: reading.percent, resetsAt: reading.resetsAt });
  }
  if (readings.length < 2) return null;

  // Only inside one window instance. A reset makes the meter fall, and pairing
  // across it would measure a negative pace or price a point at almost nothing.
  const last = readings[readings.length - 1];
  let first = last;
  for (let index = readings.length - 1; index >= 0; index -= 1) {
    const reading = readings[index];
    if (reading.resetsAt !== last.resetsAt) break;
    if (reading.percent > last.percent) break;
    first = reading;
  }

  const moved = last.percent - first.percent;
  if (moved < MIN_POINTS_MOVED) return null;

  // The spend that moved it is what happened after the first reading was taken,
  // up to and including the last.
  let cost = 0;
  let turns = 0;
  for (const event of events) {
    if (event.at <= first.at || event.at > last.at) continue;
    cost += event.cost;
    turns += 1;
  }
  if (turns < MIN_SAMPLE_TURNS || cost <= 0) return null;

  return { usdPerPercent: cost / moved, turns, percent: Math.round(last.percent) };
}

// The newest meter reading in the rollouts, and when it was taken.
function latestMeter(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].meter) return { meter: events[index].meter, at: events[index].at };
  }
  return null;
}

// Scanning only the newest few rollouts, for the meter alone. `collect` runs on
// the status-line path where a full scan would be far too slow.
function meterFromDisk() {
  const files = rolloutFiles(NaN).slice(-12).reverse();
  for (const entry of files) {
    let raw;
    try {
      raw = fs.readFileSync(entry.file, 'utf8');
    } catch (err) {
      continue;
    }
    const lines = raw.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line || line.indexOf('"token_count"') === -1) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        continue;
      }
      const meter = parsed && parsed.payload && parsed.payload.rate_limits;
      const at = Date.parse(parsed && parsed.timestamp);
      if (meter && Number.isFinite(at)) return { meter, at };
    }
  }
  return null;
}

function collect(now, options) {
  const found = (options && options.meter) || meterFromDisk();
  const mapped = found ? utilizationFrom(found.meter) : null;
  const plan = planFrom(mapped && mapped.planType);

  return {
    now,
    host: host.CODEX,
    // Codex quotes a percentage of an allowance, never a price, so there is no
    // honest money column to print.
    money: false,
    accountFile: sessionsDir(),
    plan: plan.label,
    planId: plan.id,
    planTier: null,
    planAdvice: plan.advice,
    snapshotAgeMs: found ? now - found.at : null,
    snapshotFetchedAt: found ? found.at : null,
    utilization: mapped ? mapped.utilization : null,
    // The account was read and genuinely reports no rolling window, which is
    // what flexible pricing looks like. That is a different thing from having
    // found nothing to read, and it needs to be said differently.
    windowless: Boolean(mapped && mapped.windowless),
    windowSpecs: mapped ? mapped.specs : null,
    reachedType: mapped ? mapped.reachedType : null,
    spendControlReached: Boolean(mapped && mapped.spendControlReached),
    codexCredits: mapped ? mapped.credits : null,
    settings: {
      model: readConfigValue('model') || 'default',
      effortLevel: readConfigValue('model_reasoning_effort') || 'default',
    },
    extraUsage: null,
  };
}

function readConfigValue(key) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(homeDir(), 'config.toml'), 'utf8');
  } catch (err) {
    return null;
  }
  // Only the top-level table; a key of the same name inside a section is a
  // different setting.
  const head = raw.split(/^\s*\[/m)[0];
  const match = new RegExp('^\\s*' + key + '\\s*=\\s*[\'"](.+?)[\'"]\\s*$', 'm').exec(head);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// A live reading
// ---------------------------------------------------------------------------

// Ask Codex for the meter now, rather than taking the newest one it happened to
// write. Costs about a second and a child process, so it is for when the
// rollout reading has gone stale, not for every prompt.
function refresh(options) {
  const settings = options || {};
  const executable = findExecutable(settings.codexPath);
  if (!executable) {
    return Promise.reject(
      Object.assign(new Error('Codex was not found on this machine.'), { code: 'CODEX_NOT_FOUND' })
    );
  }

  const childProcess = require('child_process');
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = childProcess.spawn(executable, ['app-server'], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (err) {
      reject(Object.assign(new Error('Codex could not be started.'), { code: 'CODEX_START_FAILED' }));
      return;
    }

    let settled = false;
    let buffer = '';
    let bytes = 0;
    const limit = 2 * 1024 * 1024;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch (error) {
        // Already gone.
      }
      // Closing stdin is how app-server is asked to stop. Kill only if it does
      // not take the hint, and only ever this one process.
      const grace = setTimeout(() => {
        try {
          child.kill();
        } catch (error) {
          // Already gone.
        }
      }, 1000);
      if (grace.unref) grace.unref();
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(Object.assign(new Error('Codex did not answer in time.'), { code: 'CODEX_TIMEOUT' })),
      Number.isFinite(settings.timeoutMs) ? settings.timeoutMs : 15000
    );

    child.once('error', (err) =>
      finish(
        Object.assign(new Error('Codex could not be started.'), {
          code: err && err.code === 'ENOENT' ? 'CODEX_NOT_FOUND' : 'CODEX_START_FAILED',
        })
      )
    );
    child.once('close', () =>
      finish(
        Object.assign(new Error('Codex closed before reporting its limits.'), {
          code: 'CODEX_CLOSED',
        })
      )
    );

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        finish(Object.assign(new Error('Codex sent too much.'), { code: 'CODEX_OUTPUT_LIMIT' }));
        return;
      }
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (err) {
          continue;
        }
        // A server-initiated request is answered with a refusal and nothing
        // else; this client never approves anything or hands over credentials.
        if (message && message.method && message.id !== undefined) {
          write({
            id: message.id,
            error: { code: -32601, message: 'This reader does not support server requests.' },
          });
          continue;
        }
        if (!message || message.id === undefined) continue;
        if (message.id === 1 && message.result) {
          write({ method: 'initialized', params: {} });
          write({ method: 'account/rateLimits/read', id: 2 });
          continue;
        }
        if (message.id === 2) {
          if (message.error) {
            finish(
              Object.assign(new Error('Codex would not report its limits.'), {
                code: 'CODEX_LIMITS_UNAVAILABLE',
              })
            );
            return;
          }
          const limits = message.result && message.result.rateLimits;
          finish(null, { at: Date.now(), meter: limits || null });
          return;
        }
      }
    });

    const write = (message) => {
      try {
        child.stdin.write(JSON.stringify(message) + '\n');
      } catch (err) {
        finish(Object.assign(new Error('Codex stopped listening.'), { code: 'CODEX_CLOSED' }));
      }
    };

    write({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: { name: 'usage-limits', title: 'Usage Limits', version: '1.0.0' },
      },
    });
  });
}

module.exports = {
  SLOTS,
  WEIGHTS,
  PLANS,
  homeDir,
  sessionsDir,
  findExecutable,
  windowsCandidates,
  fromConfig,
  rolloutFiles,
  sessionOf,
  weigh,
  partsOf,
  tokensOf,
  contextFrom,
  eventFrom,
  readEvents,
  keyFor,
  readingsOf,
  utilizationFrom,
  labelFor,
  planFrom,
  latestMeter,
  meterFromDisk,
  calibrate,
  MIN_POINTS_MOVED,
  MIN_SAMPLE_TURNS,
  collect,
  refresh,
};
