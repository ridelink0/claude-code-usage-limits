#!/usr/bin/env node
'use strict';

// The panel: the session, weekly and per-model limits as live bars in a pane
// beside the Claude Code chat.
//
//   node scripts/panel.js              the live panel, q to quit
//   node scripts/panel.js --open       open it in a split pane to the right
//   node scripts/panel.js --once       one frame, for a pipe or a screenshot
//   node scripts/panel.js --json       the same frame as fields
//   node scripts/panel.js --no-fetch   never use the network
//
// Where the numbers come from, in order of freshness: the rate-limit headers
// on Claude's own API responses (recorded by the status line), the usage
// endpoint Claude Code calls for /usage (polled here), and Claude Code's own
// cache. Whichever is newest wins, and the footer says how old it is.
//
// Where the animation comes from: the hooks. A prompt marks the session as
// working, every tool call keeps it so, the Stop hook marks it idle. While
// Claude works the title shimmers and the spinner turns, in Claude's colours;
// under ultracode it turns rainbow, which is what Claude Code does too.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const usage = require('./usage.js');
const host = require('./host.js');
const bars = require('./bars.js');
const view = require('./view.js');
const live = require('./live.js');
const feed = require('./feed.js');
const activity = require('./activity.js');
const brief = require('./brief.js');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
// How often to take a reading: quickly while Claude works, slowly while it
// waits. The status line feeds per-response figures in between.
const POLL_WORKING_MS = 30 * SECOND;
const POLL_IDLE_MS = 2 * MINUTE;
const POLL_FLOOR_MS = 15 * SECOND;
const FILE_CHECK_MS = SECOND;
const FRAME_MS = 100;
const MIN_COLUMNS = 24;
const TITLE = 'Claude usage';

const HELP = `claude-usage-limits panel - live limits in a pane beside the chat

  panel                the live panel; q or Esc quits, r takes a fresh reading
  panel --open         open the panel in a split pane to the right of this one
  panel --once         print one frame and exit
  panel --json         print one frame as JSON and exit
  panel --no-fetch     never use the network: show the reading already on disk
  panel --poll 45      seconds between readings (default 30 working, 120 idle)
  panel --width 40     draw for this many columns instead of the terminal's
  panel --ascii        plain characters instead of block glyphs

Shows the current session (5-hour) window, the current week, and the week for
the model in use when the account caps that model on its own. Bars turn yellow
at 80 percent and red at 90. Readings come from the same call Claude Code
makes for /usage, plus the rate-limit headers on Claude's own responses when
the status line is installed. USAGE_LIMITS_FETCH=off is the same as --no-fetch.
`;

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function parseArgs(argv) {
  const args = {
    once: false,
    json: false,
    open: false,
    fetch: true,
    poll: null,
    width: null,
    help: false,
    ascii: false,
    hostName: null,
  };
  const list = argv || [];
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (arg === '--once') args.once = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--open') args.open = true;
    else if (arg === '--no-fetch') args.fetch = false;
    else if (arg === '--ascii') args.ascii = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--poll') args.poll = Number(list[++i]);
    else if (arg.indexOf('--poll=') === 0) args.poll = Number(arg.slice('--poll='.length));
    else if (arg === '--width') args.width = Number(list[++i]);
    else if (arg.indexOf('--width=') === 0) args.width = Number(arg.slice('--width='.length));
    else if (arg === '--host') args.hostName = list[++i] || null;
  }
  return args;
}

function settingsFor() {
  return readJson(path.join(configDir(), 'settings.json')) || {};
}

function accountUuid() {
  const account = readJson(usage.accountFile());
  return account && account.oauthAccount && account.oauthAccount.accountUuid ? account.oauthAccount.accountUuid : null;
}

// One frame's worth of facts. Reads every file the plugin keeps, takes a
// fresh reading when asked, and hands the lot to the display model.
async function snapshot(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  let outcome = opts.outcome || null;

  if (opts.fetch) {
    const result = await live.refresh({ now, accountUuid: accountUuid(), env, timeoutMs: opts.timeoutMs });
    outcome = result.outcome;
  }

  const collected = usage.collect(now);
  const slots = feed.readFeed();
  const slot = feed.newest(slots);
  const seen = activity.summarise(activity.read(), now);
  const settings = settingsFor();

  const built = view.build({
    now,
    utilization: collected.utilization,
    fetchedAtMs: collected.snapshotFetchedAt,
    source: collected.snapshotSource,
    headers: slot ? slot.rateLimits : null,
    headersAt: slot ? slot.headersAt : null,
    model: (slot && slot.model) || seen.model || null,
    modelName: slot ? slot.modelName : null,
    effort: slot ? slot.effort : null,
    working: seen.working || feed.isWorking(slot, now),
    ultracode: seen.ultracode || settings.ultracode === true,
    settingsModel: collected.settings ? collected.settings.model : null,
    outcome,
    env,
  });
  built.now = now;
  built.plan = collected.plan || null;
  built.sessions = brief.liveSessions(brief.readCache(), now, brief.LIVE_WINDOW_MS, null);
  // Whether the panel is allowed the network at all, which is what the footer
  // reports. A frame rebuilt from disk between readings is not "network off".
  built.fetch = opts.network !== undefined ? Boolean(opts.network) : Boolean(opts.fetch);
  built.outcome = outcome;
  return built;
}

// Cut a painted line to a width without leaving an escape open.
function fit(text, width) {
  if (bars.visibleWidth(text) <= width) return text;
  let out = '';
  let shown = 0;
  let i = 0;
  const s = String(text);
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const match = s.slice(i).match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/);
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    if (shown >= width) break;
    const point = s.codePointAt(i);
    const ch = String.fromCodePoint(point);
    out += ch;
    shown += 1;
    i += ch.length;
  }
  return out + '\x1b[0m';
}

function subline(row, mode, opts) {
  if (row.stale) return bars.dim('window rolled over, taking a fresh reading', mode);
  if (row.unreported) return bars.dim('not reported yet, run /usage in Claude Code', mode);
  if (row.idle) return bars.dim('nothing in this window yet', mode);
  if (row.percent === null) return bars.dim('no reading yet', mode);
  const reset = bars.formatReset(row.msToReset, row.resetsAtMs, opts.now, { clock: opts.clock });
  return reset ? bars.dim(reset, mode) : '';
}

// Seconds while it is seconds; the report's formatter rounds to minutes, which
// reads as "0m ago" for a reading taken just now.
function since(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 60 * SECOND) return Math.max(0, Math.round(ms / SECOND)) + 's';
  return usage.formatDuration(ms);
}

function stateLine(built, mode) {
  const bits = [];
  if (built.state === 'none') bits.push('no reading yet');
  else if (built.state === 'live') bits.push('live' + (Number.isFinite(built.ageMs) ? ', updated ' + since(built.ageMs) + ' ago' : ''));
  else bits.push('cached' + (Number.isFinite(built.ageMs) ? ', reading from ' + since(built.ageMs) + ' ago' : ''));
  if (built.fetch === false) bits.push('network off');
  return bars.dim(bits.join(' · '), mode);
}

function noteColour(built) {
  const kind = built.outcome && !built.outcome.ok ? built.outcome.kind : null;
  if (kind === 'unauthorized' || kind === 'forbidden' || kind === 'no_credentials') return bars.THEME.error;
  if (kind === 'offline' || kind === 'rate_limited' || kind === 'server' || kind === 'http' || kind === 'bad_response') {
    return bars.THEME.warning;
  }
  return null;
}

// The frame, as lines. Fits any width from MIN_COLUMNS up and any height,
// dropping breathing room first and footers second.
function render(built, options) {
  const opts = options || {};
  const columns = Math.max(MIN_COLUMNS, Number.isFinite(opts.columns) ? Math.floor(opts.columns) : 40);
  const height = Number.isFinite(opts.rows) ? Math.floor(opts.rows) : null;
  const mode = opts.mode || 'none';
  const tick = Number.isFinite(opts.tick) ? opts.tick : 0;
  const reduced = Boolean(opts.reduced);
  const ascii = Boolean(opts.ascii);
  const now = Number.isFinite(opts.now) ? opts.now : built.now || Date.now();
  const clock = opts.clock || '12h';
  const barWidth = Math.max(8, Math.min(50, columns - 6));
  const animate = built.working && !reduced;

  const glyph = built.working
    ? built.ultracode
      ? bars.rainbow(bars.spinner(tick, { ascii, reduced }), tick, { mode, reduced })
      : bars.paint(bars.spinner(tick, { ascii, reduced }), bars.THEME.claude, mode)
    : bars.paint(ascii ? '*' : '✻', bars.THEME.claude, mode);
  const title = built.ultracode
    ? bars.rainbow(TITLE, tick, { mode, reduced })
    : animate
      ? bars.shimmer(TITLE, tick, bars.THEME.claude, bars.THEME.claudeShimmer, { mode, reduced })
      : bars.paint(TITLE, bars.THEME.claude, mode);

  const effortName = built.ultracode ? 'ultracode' : built.effort;
  const effort = effortName ? bars.effortColour(effortName) : null;
  const effortText = !effortName
    ? ''
    : effort.rainbow
      ? bars.rainbow(effortName, tick, { mode, reduced })
      : effort.shimmer && animate
        ? bars.shimmer(effortName, tick, effort.rgb, effort.shimmer, { mode, reduced })
        : bars.paint(effortName, effort.rgb, mode);
  const status = built.working ? 'working' : 'idle';
  const who = [built.modelLabel, effortText, bars.dim(status, mode)].filter(Boolean).join(bars.dim(' · ', mode));

  const head = [glyph + ' ' + bars.bold(title, mode), who];
  const body = [];
  for (const row of built.rows) {
    const percent =
      row.level === 'fill' ? row.percentText : bars.paint(row.percentText, bars.levelColour(row.level), mode);
    body.push({
      lines: [
        bars.bold(row.title, mode),
        (row.percent === null ? bars.paint((ascii ? '-' : '░').repeat(barWidth), bars.THEME.empty, mode) : bars.bar(row.percent, barWidth, { mode, level: row.level, ascii })) +
          ' ' +
          percent,
        subline(row, mode, { now, clock }),
      ].filter((line) => line !== ''),
    });
  }

  const footer = [];
  if (built.sessions > 1) footer.push(bars.dim(built.sessions + ' sessions sharing this budget', mode));
  if (built.note) {
    const colour = noteColour(built);
    footer.push(colour ? bars.paint(built.note, colour, mode) : bars.dim(built.note, mode));
  }
  footer.push(stateLine(built, mode));
  if (opts.interactive !== false) footer.push(bars.dim('q quit · r refresh', mode));

  // Full layout first, then without spacers, then without the footer.
  const compose = (spacers, withFooter) => {
    const lines = head.slice();
    for (const section of body) {
      if (spacers) lines.push('');
      for (const line of section.lines) lines.push(line);
    }
    if (withFooter) {
      if (spacers) lines.push('');
      for (const line of footer) lines.push(line);
    }
    return lines;
  };
  let lines = compose(true, true);
  if (height !== null && lines.length > height) lines = compose(false, true);
  if (height !== null && lines.length > height) lines = compose(false, false);
  if (height !== null && lines.length > height) lines = lines.slice(0, height);
  return lines.map((line) => fit(line, columns));
}

function quote(value) {
  return '"' + String(value).replace(/"/g, '\\"') + '"';
}

// How to put the panel in a pane to the right of the current one, for the
// terminals that can be told to. Pure, so the table can be tested.
function openCommand(env, panelPath, nodePath, platform) {
  const e = env || process.env;
  const os = platform || process.platform;
  const node = nodePath || process.execPath;
  const panel = panelPath || __filename;
  const cmd = quote(node) + ' ' + quote(panel);

  if (e.TMUX) {
    return {
      program: 'tmux',
      args: ['split-window', '-h', '-d', '-l', '32%', cmd],
      note: 'opened a pane to the right in tmux',
    };
  }
  if (e.WEZTERM_PANE) {
    return {
      program: 'wezterm',
      args: ['cli', 'split-pane', '--right', '--percent', '32', '--', node, panel],
      note: 'opened a pane to the right in WezTerm',
    };
  }
  if (e.KITTY_WINDOW_ID) {
    return {
      program: 'kitten',
      args: ['@', 'launch', '--location=vsplit', '--bias=32', '--cwd=current', node, panel],
      note: 'opened a pane to the right in kitty (needs allow_remote_control)',
    };
  }
  if (e.ZELLIJ) {
    return {
      program: 'zellij',
      args: ['action', 'new-pane', '-d', 'right', '--', node, panel],
      note: 'opened a pane to the right in zellij',
    };
  }
  if (os === 'win32') {
    if (e.WT_SESSION) {
      return {
        command:
          'start "" wt.exe -w 0 sp -V --size 0.32 --title "Claude usage" --suppressApplicationTitle ' + cmd,
        shell: true,
        note: 'opened a pane to the right in Windows Terminal',
      };
    }
    return {
      command: 'start "Claude usage" ' + cmd,
      shell: true,
      note: 'opened the panel in a new terminal window (run this from inside Windows Terminal to get a split pane)',
    };
  }
  if (String(e.TERM_PROGRAM || '') === 'iTerm.app') {
    const script =
      'tell application "iTerm2" to tell current session of current window to split vertically with default profile command ' +
      quote(cmd);
    return { program: 'osascript', args: ['-e', script], note: 'opened a pane to the right in iTerm2' };
  }
  return null;
}

function openPanel(env) {
  const plan = openCommand(env, __filename, process.execPath, process.platform);
  if (!plan) {
    process.stdout.write(
      'This terminal cannot be told to split. Open a second pane to the right and run:\n  ' +
        quote(process.execPath) +
        ' ' +
        quote(__filename) +
        '\n'
    );
    return 0;
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(plan.command || plan.program, plan.args || [], {
        shell: Boolean(plan.shell),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch (err) {
      process.stderr.write('panel: could not start ' + (plan.program || 'the terminal') + ': ' + err.message + '\n');
      return resolve(1);
    }
    child.on('error', (err) => {
      process.stderr.write('panel: could not start ' + (plan.program || 'the terminal') + ': ' + err.message + '\n');
      resolve(1);
    });
    // Give a launcher that fails fast a moment to say so; otherwise get out of
    // its way.
    setTimeout(() => {
      child.unref();
      process.stdout.write(plan.note + '\n');
      resolve(0);
    }, 300);
  });
}

function pollBase(built, args, env) {
  const configured = Number.isFinite(args.poll) && args.poll > 0 ? args.poll * SECOND : Number((env || process.env).USAGE_LIMITS_POLL) * SECOND;
  if (Number.isFinite(configured) && configured > 0) return Math.max(POLL_FLOOR_MS, configured);
  return built && built.working ? POLL_WORKING_MS : POLL_IDLE_MS;
}

async function interactive(args) {
  const out = process.stdout;
  const env = process.env;
  const settings = settingsFor();
  const reduced = feed.motionOff(settings, env);
  const clock = feed.clockFor(settings, env);
  const mode = bars.colourMode(env, out.isTTY);
  const fetch = args.fetch && !live.fetchDisabled(env);

  const state = {
    built: null,
    outcome: null,
    lastFetchAt: 0,
    delayMs: 0,
    fetching: false,
    lastFrame: '',
    lastTick: -1,
    lastCheck: 0,
    dirty: true,
    stopped: false,
  };

  const leave = () => {
    if (state.stopped) return;
    state.stopped = true;
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch (err) {
      // Not a TTY any more; nothing to restore.
    }
    out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  };
  out.write('\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J');
  process.on('exit', leave);
  process.on('SIGINT', () => {
    leave();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    leave();
    process.exit(0);
  });
  out.on('resize', () => {
    state.dirty = true;
  });

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', (ch, key) => {
      const name = key && key.name;
      if (name === 'q' || name === 'escape' || (key && key.ctrl && name === 'c')) {
        leave();
        process.exit(0);
      }
      if (name === 'r') {
        state.lastFetchAt = 0;
        state.delayMs = 0;
        state.dirty = true;
      }
    });
  }

  const draw = (now) => {
    const width = Number.isFinite(args.width) && args.width > 0 ? args.width : out.columns || 40;
    const lines = render(state.built, {
      columns: width,
      rows: out.rows || null,
      tick: Math.floor(now / bars.TICK_MS),
      mode,
      reduced,
      ascii: args.ascii,
      now,
      clock,
    });
    const frame = lines.map((line) => '\x1b[2K' + line).join('\n') + '\x1b[J';
    if (frame === state.lastFrame && !state.dirty) return;
    state.lastFrame = frame;
    state.dirty = false;
    out.write('\x1b[H' + frame);
  };

  const step = async () => {
    if (state.stopped) return;
    const now = Date.now();
    const due = fetch && !state.fetching && now - state.lastFetchAt >= state.delayMs;
    if (due) {
      state.fetching = true;
      try {
        state.built = await snapshot({ fetch: true, network: fetch, env, now });
        state.outcome = state.built.outcome;
      } catch (err) {
        state.outcome = { ok: false, kind: 'bad_response', message: err.message };
      }
      state.lastFetchAt = Date.now();
      state.delayMs = live.nextDelayMs(state.outcome, state.delayMs, {
        baseMs: pollBase(state.built, args, env),
        maxMs: POLL_IDLE_MS,
      });
      state.fetching = false;
      state.dirty = true;
    } else if (!state.built || now - state.lastCheck >= FILE_CHECK_MS) {
      state.lastCheck = now;
      try {
        state.built = await snapshot({ fetch: false, network: fetch, env, now, outcome: state.outcome });
      } catch (err) {
        // Keep the last frame; a transient read error is not worth a blank.
      }
      // A window that rolled over deserves a reading sooner than the timer.
      if (fetch && state.built && state.built.rows.some((row) => row.stale) && state.delayMs > 5 * SECOND) {
        state.delayMs = 5 * SECOND;
      }
    }
    if (state.built) {
      const tick = Math.floor(Date.now() / bars.TICK_MS);
      const animating = (state.built.working || state.built.ultracode) && !reduced;
      if (state.dirty || (animating && tick !== state.lastTick) || now - state.lastCheck < FRAME_MS) {
        state.lastTick = tick;
        draw(Date.now());
      }
    }
    if (!state.stopped) setTimeout(step, FRAME_MS);
  };
  await step();
  return new Promise(() => {});
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  usage.setHost(host.detect(argv || [], process.env));
  if (usage.isCodex()) {
    process.stderr.write(
      'panel: this reads the usage call Claude Code makes, which Codex does not have. ' +
        'Under Codex use the report: usage.js --host codex\n'
    );
    return 2;
  }
  if (args.open) return openPanel(process.env);

  const once = args.once || args.json || !process.stdout.isTTY;
  if (once) {
    const network = args.fetch && !live.fetchDisabled(process.env);
    const built = await snapshot({ fetch: network, network, env: process.env });
    if (args.json) {
      process.stdout.write(JSON.stringify(built, null, 2) + '\n');
      return 0;
    }
    const settings = settingsFor();
    const lines = render(built, {
      columns: Number.isFinite(args.width) && args.width > 0 ? args.width : process.stdout.columns || 40,
      tick: 0,
      mode: bars.colourMode(process.env, process.stdout.isTTY),
      reduced: true,
      ascii: args.ascii,
      clock: feed.clockFor(settings, process.env),
      interactive: false,
    });
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }
  return interactive(args);
}

module.exports = {
  HELP,
  TITLE,
  MIN_COLUMNS,
  POLL_WORKING_MS,
  POLL_IDLE_MS,
  parseArgs,
  snapshot,
  fit,
  since,
  render,
  openCommand,
  pollBase,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (Number.isFinite(code)) process.exitCode = code;
    },
    (err) => {
      process.stderr.write('panel: ' + (err && err.message ? err.message : String(err)) + '\n');
      process.exitCode = 1;
    }
  );
}
