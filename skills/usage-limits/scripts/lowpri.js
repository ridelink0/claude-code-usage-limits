'use strict';

// Claude Code's own features at the usage wall, as far as a hook can read them.
//
// There are five of them and they are not equally knowable, so this module
// exists mostly to keep the difference straight. Everything here was verified
// against the installed CLI on 2026-09-25 (@anthropic-ai/claude-code 2.1.283,
// C:/Users/OWNER/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code).
//
//   /low-priority - a hidden toggle offered when the 5-hour session limit is
//   reached: it keeps the session running at lower priority and spends the
//   WEEKLY limit, plus a separate weekly lower-priority allowance. Whether the
//   account is PROVISIONED for it is readable, from one field in the same
//   ~/.claude.json this plugin already parses:
//     cachedGrowthBookFeatures.tengu_toasty_breeze
//   In the bundle: Cj="tengu_toasty_breeze", AKe()=Au().enabled===!0, and the
//   command declares isEnabled:()=>pt()&&(WL()||AKe()).
//
//   Whether it is ON is NOT readable. The state lives in process memory only -
//   WL()=mr().state.phase==="active", phases idle/armed/active/stale - and is
//   written to no file. ~/.claude/state holds only mcp-discover-verdicts.json
//   and skill-runs.jsonl; ~/.claude/usage-limits is empty; the documented hook
//   payload (code.claude.com/docs/en/hooks) carries no usage field on any
//   event; the statusLine payload has no low_priority field. So this module
//   offers three states and never a fourth: absent, offered, and acknowledged
//   by the user in their own words. activeKnown is false in all of them.
//
//   Two further gates sit in front of the offer that nothing here can see: the
//   experiment arm arrives in a response header (ZIe() requires
//   lowPriorityOffer==="treatment"), and the CLI withholds the offer during a
//   cooloff and once the weekly allowance is spent. So every sentence built
//   from this is a possibility, never a promise - and the grant can be
//   withdrawn mid-week (github.com/anthropics/claude-code/issues/95470), which
//   is why the flag is re-read on every brief instead of remembered.
//
//   The wait and retry are per-request, from lowPriorityRetryAfterSeconds and
//   lowPriorityMaxWaitSeconds on the response headers. There is no client-side
//   constant, so no number is printed for them. ($Fn=1800000 in the bundle is a
//   30-minute freshness cutoff on cached window readings, nothing to do with
//   this.)
//
//   /limit-reset - a once-weekly manual refill of the 5-hour window, usable
//   only AT a limit, whose work still spends the weekly. Gated on
//   tengu_cedar_ember, which is ABSENT from this account's feature cache, with
//   cachedUsageUtilization.utilization.cedar_ember null. So there is nothing to
//   spend here and nothing is built on it: only a detector that starts
//   reporting if a grant ever appears. resets_left is served by a live
//   endpoint, never a file, so the count is never claimed.
//
//   The graceful wrap-up note - the CLI injecting "finish up" at the wall. The
//   mechanism is real and the treatment TEXT is provisioned on this machine
//   (tengu_lantern_wick_text), but the gate is the MODE flag, and the bundle's
//   own normalizer keeps only "wrap-up" and "next-steps" and maps everything
//   else to "off":
//     function kuo(e){let n=typeof e==="string"?e.trim().toLowerCase():e;
//       return n==="wrap-up"||n==="next-steps"?n:"off"}
//   tengu_lantern_wick_mode reads "off" here, so the note does not fire on this
//   machine today and the plugin's own near-wall instruction must stay. When
//   the flag flips, hostWrapsUp goes true and the plugin stands down rather
//   than telling the model to wrap up in different words. (tengu_lantern_wick
//   is in the cache but is not a string this build contains at all, so it reads
//   nothing; the near-limit note is a separate flag, tengu_vellum_anchor,
//   T1()=x("tengu_vellum_anchor",!1), which reads false here.)
//
//   Usage credits - blocked at the org level on this account
//   (cachedExtraUsageDisabledReason "org_level_disabled", extra_usage
//   is_enabled false), so nothing should offer /usage-credits here.
//
//   autoContinueAtUsageLimit - documented at
//   code.claude.com/docs/en/settings-reference, shipped in 2.1.234, and
//   DEFAULTED TO TRUE in the bundle (value:r?.autoContinueAtUsageLimit??!0). It
//   waits out the reset and continues the same open session. That is better
//   than a scheduled wake when the terminal stays open, and it is why the relay
//   has to say so rather than presenting its wake as the only route.

const fs = require('fs');
const os = require('os');
const path = require('path');

const atomic = require('./atomic.js');

const FLAG = 'tengu_toasty_breeze';
const RESET_FLAG = 'tengu_cedar_ember';
const WRAPUP_MODE_FLAG = 'tengu_lantern_wick_mode';
const WRAPUP_TEXT_FLAG = 'tengu_lantern_wick_text';
const NEAR_WALL_FLAG = 'tengu_vellum_anchor';

// The only two mode values the CLI's own normalizer keeps.
const WRAPUP_MODES = new Set(['wrap-up', 'next-steps']);

// The client default in the bundle (xj=10), clamped there to 1440 minutes.
const DEFAULT_COOLOFF_MINUTES = 10;
const MAX_COOLOFF_MINUTES = 1440;

// The recommendation rule, in one number so it can be argued with.
//
// /low-priority spends the weekly and draws on a weekly allowance whose size is
// exposed nowhere a hook can read, and a real user measured it burning "almost
// a week of usage in a couple hours"
// (github.com/anthropics/claude-code/issues/92544). So it is worth naming only
// while the weekly still has real room. At or below this it is offered; above
// it the brief says not to, and says why.
const WEEKLY_HEADROOM_MAX = 80;

// Past this the 5-hour window is the wall, which is the only place the CLI
// offers the toggle at all.
const WALL_PERCENT = 90;

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function stateFile() {
  return path.join(configDir(), 'usage-limits-lowpri.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

// The same choice usage.js and host.js make, for the same reason: a migration
// leaves a small ~/.claude/.claude.json with machine ids and no meter while the
// account state stays in the home file, so pick the one that carries a
// snapshot and only fall back to existence.
function accountFiles() {
  const scoped = path.join(configDir(), '.claude.json');
  const home = path.join(os.homedir(), '.claude.json');
  return scoped === home ? [home] : [scoped, home];
}

function snapshot() {
  const files = accountFiles();
  let fallback = null;
  for (const file of files) {
    const parsed = readJson(file);
    if (!parsed) continue;
    if (parsed.cachedUsageUtilization) return parsed;
    if (!fallback) fallback = parsed;
  }
  return fallback;
}

function features(account) {
  return account && account.cachedGrowthBookFeatures && typeof account.cachedGrowthBookFeatures === 'object'
    ? account.cachedGrowthBookFeatures
    : null;
}

function utilization(account) {
  const cache = account && account.cachedUsageUtilization;
  return cache && cache.utilization && typeof cache.utilization === 'object' ? cache.utilization : null;
}

// A string the server sent, or null. Never a default: the wording is
// Anthropic's and it can change, so a sentence built on a made-up version of it
// would be quoting the plugin to itself.
function copy(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

// Whether this ACCOUNT is provisioned for /low-priority, plus the copy the
// server shipped with it.
//
// A missing key is "not offered" and known:false - it is the absence of a fact,
// not the fact of an absence, and the difference decides whether the docs can
// say anything about this machine at all.
function offer(account) {
  const gb = features(account);
  const raw = gb && Object.prototype.hasOwnProperty.call(gb, FLAG) ? gb[FLAG] : undefined;
  if (raw === undefined) {
    return {
      known: false,
      offered: false,
      version: null,
      label: null,
      noticeLine: null,
      statusLine: null,
      allowanceNote: null,
      waitBanner: null,
      budgetExhaustedCopy: null,
      cooloffMinutes: DEFAULT_COOLOFF_MINUTES,
    };
  }
  const flag = raw && typeof raw === 'object' ? raw : {};
  const cooloff = Number(flag.cooloffMinutes);
  return {
    known: true,
    offered: flag.enabled === true,
    version: Number.isFinite(Number(flag.version)) ? Number(flag.version) : null,
    label: copy(flag.label),
    noticeLine: copy(flag.noticeLine),
    statusLine: copy(flag.statusLine),
    allowanceNote: copy(flag.allowanceNote),
    waitBanner: copy(flag.waitBanner),
    budgetExhaustedCopy: copy(flag.budgetExhaustedCopy),
    cooloffMinutes: Number.isFinite(cooloff)
      ? Math.round(Math.min(MAX_COOLOFF_MINUTES, Math.max(0, cooloff)))
      : DEFAULT_COOLOFF_MINUTES,
  };
}

// The manual session reset. Detected, never spent: this account holds no grant,
// so a feature built on it would be untestable here.
function sessionReset(account) {
  const gb = features(account);
  const util = utilization(account);
  const flagged = Boolean(gb && Object.prototype.hasOwnProperty.call(gb, RESET_FLAG) && gb[RESET_FLAG]);
  const grant = util && util.cedar_ember ? util.cedar_ember : null;
  return {
    known: Boolean(gb || util),
    present: Boolean(flagged || grant),
    // resets_left is served from /api/organizations/<uuid>/reset_rate_limits,
    // not from any file a hook can read, so it stays unreported.
    resetsLeft: null,
  };
}

// Whether the CLI itself will tell the model to wrap up at the wall.
function wrapUp(account) {
  const gb = features(account);
  const rawMode = gb ? gb[WRAPUP_MODE_FLAG] : undefined;
  const normalised = typeof rawMode === 'string' ? rawMode.trim().toLowerCase() : rawMode;
  const mode = WRAPUP_MODES.has(normalised) ? normalised : 'off';
  return {
    known: Boolean(gb && (Object.prototype.hasOwnProperty.call(gb, WRAPUP_MODE_FLAG) || Object.prototype.hasOwnProperty.call(gb, WRAPUP_TEXT_FLAG))),
    mode,
    hostWrapsUp: mode !== 'off',
    textProvisioned: Boolean(gb && copy(gb[WRAPUP_TEXT_FLAG])),
    nearWallNote: Boolean(gb && gb[NEAR_WALL_FLAG] === true),
  };
}

// Whether usage credits are a lever on this account at all.
function credits(account) {
  const util = utilization(account);
  const extra = util && util.extra_usage ? util.extra_usage : null;
  const reason =
    account && typeof account.cachedExtraUsageDisabledReason === 'string'
      ? account.cachedExtraUsageDisabledReason
      : (extra && typeof extra.disabled_reason === 'string' ? extra.disabled_reason : null);
  if (!extra) return { available: null, reason: reason };
  if (extra.is_enabled === true) return { available: true, reason: null };
  if (extra.is_enabled === false) return { available: false, reason: reason };
  return { available: null, reason: reason };
}

function settingsFiles() {
  return [path.join(configDir(), 'settings.local.json'), path.join(configDir(), 'settings.json')];
}

// The CLI's own wait-and-continue. Documented as user-or-managed scope, and the
// bundle defaults it to true, so an absent key is TRUE - the one reading a
// relay must not get wrong, because it decides whether the wake is the only
// route across the reset or a second one.
function autoContinue() {
  for (const file of settingsFiles()) {
    const parsed = readJson(file);
    if (parsed && typeof parsed.autoContinueAtUsageLimit === 'boolean') {
      return { value: parsed.autoContinueAtUsageLimit, source: path.basename(file) };
    }
  }
  return { value: true, source: 'default' };
}

// ---------------------------------------------------------------------------
// The acknowledgement. The plugin's own record that the USER said he turned
// low-priority on, because nothing else can tell it.
//
// It carries the window it belongs to and that window's reset, and it lapses at
// that reset: low-priority ends when the limit does, so a fact that outlived
// its window would go on redirecting the headroom maths at the weekly in a
// session where the 5-hour wall is real again.
// ---------------------------------------------------------------------------

function readState() {
  const parsed = readJson(stateFile());
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function writeState(state) {
  try {
    atomic.writeFileAtomic(stateFile(), JSON.stringify(state, null, 2) + '\n');
    return true;
  } catch (err) {
    return false;
  }
}

function acknowledge(input) {
  const options = input || {};
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  if (!options.on) {
    const state = readState();
    delete state.ack;
    writeState(state);
    return { on: false, at: now };
  }
  const record = {
    on: true,
    at: now,
    windowKey: options.windowKey || null,
    resetsAt: Number.isFinite(options.resetsAt) ? options.resetsAt : null,
  };
  const state = readState();
  state.ack = record;
  writeState(state);
  return record;
}

function readAck(now) {
  const at = Number.isFinite(now) ? now : Date.now();
  const state = readState();
  const ack = state.ack;
  if (!ack || ack.on !== true) return null;
  // Past the reset of the window it was recorded against, the fact is spent.
  if (Number.isFinite(ack.resetsAt) && at >= ack.resetsAt) return null;
  return ack;
}

// Exactly three states, and activeKnown is false in every one of them.
function stateOf(input) {
  const options = input || {};
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const account = options.account !== undefined ? options.account : snapshot();
  const provisioned = offer(account);
  const ack = readAck(now);
  return {
    state: ack ? 'acknowledged' : provisioned.offered ? 'offered' : 'absent',
    offered: provisioned.offered,
    known: provisioned.known,
    ack,
    // Never readable. Said out loud here so no caller can talk itself into it.
    activeKnown: false,
    offer: provisioned,
  };
}

function weeklyOf(windows) {
  return (windows || []).find((w) => w && w.key === 'seven_day') || null;
}

// Whether to say anything about /low-priority on this prompt, and which way.
//
// Null unless the account is provisioned, the 5-hour window is the binding one,
// it is at the wall, and there is a weekly reading to judge against. A guess at
// any of those would be the plugin recommending a spend it cannot price.
function advise(input) {
  const options = input || {};
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const account = options.account !== undefined ? options.account : snapshot();
  if (!offer(account).offered) return null;
  const binding = options.binding;
  if (!binding || binding.key !== 'five_hour') return null;
  if (binding.stale) return null;
  if (!Number.isFinite(binding.percentUsed) || binding.percentUsed < WALL_PERCENT) return null;
  const weekly = weeklyOf(options.windows);
  if (!weekly || !Number.isFinite(weekly.percentUsed) || weekly.stale) return null;
  const percent = Math.round(weekly.percentUsed);
  return {
    kind: percent <= WEEKLY_HEADROOM_MAX ? 'offer' : 'hold',
    weeklyPercent: percent,
    threshold: WEEKLY_HEADROOM_MAX,
    weeklyLabel: weekly.label || 'weekly',
    now,
  };
}

// Everything the brief needs, in one read of one file.
function forBrief(input) {
  const options = input || {};
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const account = options.account !== undefined ? options.account : snapshot();
  const state = stateOf({ account, now });
  const weekly = weeklyOf(options.windows);
  const five = (options.windows || []).find((w) => w && w.key === 'five_hour') || null;
  return {
    state: state.state,
    activeKnown: false,
    advise: advise({ account, now, binding: options.binding, windows: options.windows }),
    notice: state.offer.noticeLine,
    cooloffMinutes: state.offer.cooloffMinutes,
    budgetExhaustedCopy: state.offer.budgetExhaustedCopy,
    weeklyLabel: weekly ? weekly.label || 'weekly' : 'weekly',
    weeklyPercent: weekly && Number.isFinite(weekly.percentUsed) ? Math.round(weekly.percentUsed) : null,
    fiveHourPercent: five && Number.isFinite(five.percentUsed) ? Math.round(five.percentUsed) : null,
    resetGrant: sessionReset(account).present,
    credits: credits(account),
    autoContinue: autoContinue(),
  };
}

module.exports = {
  FLAG,
  RESET_FLAG,
  WRAPUP_MODE_FLAG,
  WRAPUP_TEXT_FLAG,
  NEAR_WALL_FLAG,
  WRAPUP_MODES,
  DEFAULT_COOLOFF_MINUTES,
  MAX_COOLOFF_MINUTES,
  WEEKLY_HEADROOM_MAX,
  WALL_PERCENT,
  configDir,
  stateFile,
  accountFiles,
  snapshot,
  offer,
  sessionReset,
  wrapUp,
  credits,
  autoContinue,
  acknowledge,
  readAck,
  readState,
  stateOf,
  advise,
  forBrief,
  weeklyOf,
};
