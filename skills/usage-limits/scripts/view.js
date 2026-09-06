'use strict';

// The display model: what the status line, the side panel and the VS Code
// view all draw. Given whatever readings exist - the usage endpoint's answer,
// Claude Code's own cache, the per-response rate-limit headers the status line
// receives - plus which model is running, it decides the rows, their colours,
// which per-model week to show, and what the footer should admit about the
// freshness of it all.
//
// Everything here is a pure function of its input so the three surfaces
// cannot drift apart.

const usage = require('./usage.js');
const bars = require('./bars.js');

const MINUTE = 60 * 1000;

// Claude Code's own titles from /usage.
const TITLES = { five_hour: 'Current session', seven_day: 'Current week (all models)' };
const SPEND_TITLE = 'Spend limit';

// A reading older than this is "cached" in the footer, however it was taken.
const LIVE_AGE_MS = 5 * MINUTE;

function scopedTitle(name) {
  return 'Current week (' + name + ')';
}

function epochMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // The status line hands over epoch seconds; the endpoint hands over ISO
    // strings. A number small enough to be seconds is seconds.
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function fromHeaders(key, headers, headersAt) {
  if (!headers || typeof headers !== 'object') return null;
  const bucket = headers[key];
  if (!bucket || typeof bucket !== 'object' || typeof bucket.used_percentage !== 'number') return null;
  return {
    percent: bucket.used_percentage,
    resetsAtMs: epochMs(bucket.resets_at),
    at: Number.isFinite(headersAt) ? headersAt : 0,
    source: 'headers',
  };
}

function fromSnapshot(key, utilization, fetchedAtMs, source) {
  if (!utilization || typeof utilization !== 'object') return null;
  const bucket = utilization[key];
  if (!bucket || typeof bucket !== 'object' || typeof bucket.utilization !== 'number') return null;
  return {
    percent: bucket.utilization,
    resetsAtMs: epochMs(bucket.resets_at),
    at: Number.isFinite(fetchedAtMs) ? fetchedAtMs : 0,
    source: source === 'api' || source === 'live' ? 'api' : 'cache',
  };
}

function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.at >= b.at ? a : b;
}

function percentText(percent, stale, unreported) {
  if (stale) return 'rolling';
  if (unreported) return '?';
  if (!Number.isFinite(percent)) return 'no reading';
  return Math.floor(percent) + '%';
}

function row(key, title, family, picked, now) {
  const percent = picked && Number.isFinite(picked.percent) ? picked.percent : null;
  const resetsAtMs = picked && Number.isFinite(picked.resetsAtMs) ? picked.resetsAtMs : null;
  const msToReset = resetsAtMs === null ? null : resetsAtMs - now;
  const stale = msToReset !== null && msToReset <= 0;
  // Zero with no reset time is a window with nothing in it. From a reading
  // taken just now that is simply true. From an old cache it may equally be a
  // bucket that never reported, and the status line has no way to tell.
  const idle = percent === 0 && resetsAtMs === null;
  const unreported = idle && Boolean(picked) && picked.source === 'cache';
  return {
    key,
    title,
    family: family || null,
    percent,
    percentText: percentText(percent, stale, unreported),
    resetsAtMs,
    msToReset,
    level: bars.level(percent),
    source: picked ? picked.source : null,
    at: picked ? picked.at : null,
    stale,
    idle,
    unreported,
  };
}

function ageText(ageMs) {
  return Number.isFinite(ageMs) ? 'showing the reading from ' + usage.formatDuration(ageMs) + ' ago' : 'no reading yet';
}

function noteFor(outcome, ageMs) {
  if (!outcome || outcome.ok) return null;
  const suffix = ', ' + ageText(ageMs);
  switch (outcome.kind) {
    case 'offline':
      return 'offline' + suffix;
    case 'disabled':
      return 'network off' + suffix;
    case 'unauthorized':
      return 'sign in to Claude Code again' + suffix;
    case 'expired':
      return 'the login has expired, Claude Code renews it on its next call' + suffix;
    case 'forbidden':
      return 'usage is not available for this login' + suffix;
    case 'no_credentials':
      return 'no Claude login found' + suffix;
    case 'rate_limited':
      return 'the usage endpoint is busy, retrying' + suffix;
    default:
      return 'the usage endpoint answered with an error' + suffix;
  }
}

function build(input) {
  const opts = input || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const env = opts.env || process.env;
  const utilization = opts.utilization && typeof opts.utilization === 'object' ? opts.utilization : null;
  const fetchedAtMs = Number.isFinite(opts.fetchedAtMs) ? opts.fetchedAtMs : null;
  const source = opts.source || (utilization ? 'cache' : null);
  const headers = opts.headers && typeof opts.headers === 'object' ? opts.headers : null;
  const headersAt = Number.isFinite(opts.headersAt) ? opts.headersAt : null;

  // The model in use decides which per-model week is shown. The status line
  // knows for certain; the setting is the fallback; nothing is hidden when
  // neither says.
  const model = opts.model || opts.settingsModel || env.ANTHROPIC_MODEL || null;
  // When Claude Code has said which model is running, that is the whole
  // answer: adding the setting on top would keep a Fable week on screen after
  // /model moved the session to Opus. The setting is only the fallback.
  const families = usage.familiesInUse(null, null, opts.model ? [opts.model] : [opts.settingsModel, env.ANTHROPIC_MODEL]);

  const rows = [];
  for (const key of ['five_hour', 'seven_day']) {
    const picked = newer(fromHeaders(key, headers, headersAt), fromSnapshot(key, utilization, fetchedAtMs, source));
    rows.push(row(key, TITLES[key], null, picked, now));
  }

  const spend = fromHeaders('spend_limit', headers, headersAt);
  if (spend) rows.push(row('spend_limit', SPEND_TITLE, null, spend, now));

  // A host that meters windows of other lengths (Codex names its own) gets a
  // row per window it reports, after the two everyone has.
  for (const spec of Array.isArray(opts.windowSpecs) ? opts.windowSpecs : []) {
    if (!spec || !spec.key || spec.key === 'five_hour' || spec.key === 'seven_day') continue;
    const picked = fromSnapshot(spec.key, utilization, fetchedAtMs, source);
    if (picked) rows.push(row(spec.key, 'Current ' + (spec.label || spec.key) + ' window', null, picked, now));
  }

  let fable = null;
  const hidden = [];
  for (const limit of usage.limitWindows(utilization)) {
    if (!limit.family) continue;
    const name = limit.label && limit.label.indexOf('weekly (') === 0 ? limit.label.slice(8, -1) : limit.family;
    const picked = {
      percent: limit.percent,
      resetsAtMs: limit.resetsAt,
      at: Number.isFinite(fetchedAtMs) ? fetchedAtMs : 0,
      source: source === 'api' || source === 'live' ? 'api' : 'cache',
    };
    const built = row(limit.key, scopedTitle(name), limit.family, picked, now);
    if (usage.appliesTo(limit, families)) {
      rows.push(built);
      if (limit.family === 'fable') fable = built;
    } else {
      hidden.push(built);
    }
  }

  // Freshness is judged on the newest thing shown.
  let newestAt = null;
  for (const item of rows) {
    if (Number.isFinite(item.at) && item.at > 0 && (newestAt === null || item.at > newestAt)) newestAt = item.at;
  }
  const ageMs = newestAt === null ? null : Math.max(0, now - newestAt);
  const hasData = rows.some((item) => item.percent !== null);
  const state = !hasData ? 'none' : ageMs !== null && ageMs < LIVE_AGE_MS ? 'live' : 'cached';

  const effort = opts.effort ? String(opts.effort).toLowerCase() : null;
  const ultracode = Boolean(opts.ultracode) || effort === 'max' || effort === 'ultracode';

  return {
    rows,
    fable,
    hidden,
    model,
    modelLabel: opts.modelName || bars.prettyModel(model),
    effort,
    ultracode,
    working: Boolean(opts.working),
    state,
    ageMs,
    note: noteFor(opts.outcome, ageMs),
  };
}

module.exports = {
  TITLES,
  LIVE_AGE_MS,
  scopedTitle,
  epochMs,
  build,
  noteFor,
};
