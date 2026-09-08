#!/usr/bin/env node
'use strict';

// The other end of the relay: what the operating system runs a few minutes
// after the window resets.
//
// Nothing here is on a hook's ten-second clock. It runs on its own, in its own
// process, long after the session that armed it has gone, so it can afford to
// check its assumptions before acting - and it has to, because the one thing
// worse than not resuming is resuming into a limit that has not lifted and
// burning the first minutes of a fresh window on a refusal.
//
// The order is deliberate:
//
//   1. Is there still something armed, and is it this one.
//   2. Has the window actually turned over. The reset time is a prediction;
//      the meter is the fact. If it has not, book another wake and stop.
//   3. Is a person sitting at this machine right now. If Computer Use is
//      installed it can answer that, and if the answer is yes the default is
//      to leave a notification rather than start a second agent in the same
//      directory as the one they are typing into.
//   4. Deliver.
//
// Every branch ends with a record on disk, because the next session's first
// job is to say what happened while nobody was watching.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const relay = require('./relay.js');
const voice = require('./voice.js');
const host = require('./host.js');

const MINUTE = 60 * 1000;
const RESUME_TIMEOUT_MS = 3 * 60 * 60 * 1000;

function argOf(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1] || null;
}

// Settled before anything reads a file. A scheduled task inherits none of the
// session's environment, so the config directory has to be carried in the
// command line or every path below points at the wrong account.
const configDirArg = argOf(process.argv.slice(2), '--config-dir');
if (configDirArg) process.env.CLAUDE_CONFIG_DIR = configDirArg;

// A notification that needs no module installed and no identity registered.
// The WinRT toast looks better and fails silently when the calling process has
// no app identity, which a scheduled task frequently does not; a balloon from
// the in-box Forms assembly has shown up every time.
function toast(title, body) {
  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$icon = New-Object System.Windows.Forms.NotifyIcon',
      '$icon.Icon = [System.Drawing.SystemIcons]::Information',
      '$icon.Visible = $true',
      '$icon.ShowBalloonTip(15000, ' + relay.psQuote(title) + ', ' + relay.psQuote(body) + ', [System.Windows.Forms.ToolTipIcon]::Info)',
      'Start-Sleep -Seconds 12',
      '$icon.Dispose()',
    ].join('\n');
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    });
    return;
  }
  if (process.platform === 'darwin') {
    spawnSync('osascript', ['-e', 'display notification ' + JSON.stringify(body) + ' with title ' + JSON.stringify(title)], {
      encoding: 'utf8',
      timeout: 15000,
    });
    return;
  }
  spawnSync('notify-send', [title, body], { encoding: 'utf8', timeout: 15000 });
}

// Has the window really opened? The endpoint is the only thing that knows, and
// it is worth four seconds to ask rather than trusting arithmetic done an hour
// ago on a reset time that can move.
async function windowReopened(record, now) {
  try {
    if (record.host === host.CODEX) {
      const codex = require('./codex.js');
      await codex.refresh({ now, timeoutMs: 8000 }).catch(() => null);
      const collected = codex.collect(now);
      // Same shape as the Claude side: keyed by window, each { utilization }.
      // Reading a flat "primary" that codex.collect never writes answered
      // "cannot tell" every time and disabled this check under Codex.
      const bucket = collected && collected.utilization ? collected.utilization[record.windowKey || 'five_hour'] : null;
      const value = bucket && typeof bucket.utilization === 'number' ? bucket.utilization : null;
      return { known: value !== null, percent: value };
    }
    const live = require('./live.js');
    const usage = require('./usage.js');
    await live.refresh({ now, accountUuid: usage.accountUuid(), timeoutMs: 8000 }).catch(() => null);
    const collected = usage.collect(now);
    const utilization = collected && collected.utilization;
    if (!utilization) return { known: false, percent: null };
    // The window the relay was armed against, by the key it was armed with.
    // Each entry is { utilization, resets_at, ... }; reading a flattened
    // "five_hour_utilization" off the top gave undefined every time, which read
    // as "cannot tell" and quietly disabled this whole check.
    const bucket = utilization[record.windowKey || 'five_hour'];
    const value = bucket && typeof bucket.utilization === 'number' ? bucket.utilization : null;
    return { known: value !== null, percent: value };
  } catch (err) {
    return { known: false, percent: null, error: err.message };
  }
}

// Is somebody at the keyboard? Computer Use knows, because it tracks physical
// input to stay out of the user's way. Without it, assume nobody is: the relay
// only ever fires after a window that was spent to exhaustion, which is not
// usually a moment somebody is still sitting there.
function userIsPresent(cli) {
  if (!cli) return { known: false, present: false };
  const run = spawnSync(process.execPath, [cli, '--json', 'status'], {
    encoding: 'utf8',
    timeout: 45000,
    windowsHide: true,
    env: Object.assign({}, process.env, { CLI_QUIET: '1', CU_OVERLAY: 'off' }),
  });
  if (run.status !== 0 || !run.stdout) return { known: false, present: false };
  try {
    const parsed = JSON.parse(run.stdout);
    const text = JSON.stringify(parsed);
    // The status report names the user when it has seen them recently. This
    // is a coarse read on purpose: a false "present" costs a notification
    // instead of a resume, which is the safe way round.
    return { known: true, present: /user (?:is )?active|user_active|physical input/i.test(text) };
  } catch (err) {
    return { known: false, present: false };
  }
}

// None of this is restored by --resume: a headless resume starts in the
// permission mode a fresh -p run would, so a session that was running with
// edits accepted comes back asking a person who is not there.
function claudeArgs(record, prompt, config, fallback) {
  const args = fallback ? ['--continue', '-p', prompt] : ['--resume', record.id, '-p', prompt];
  if (config.permissionMode) args.push('--permission-mode', config.permissionMode);
  if (!fallback && config.model) args.push('--model', config.model);
  return args;
}

function deliverClaude(record, prompt, config, cli) {
  const args = claudeArgs(record, prompt, config, false);
  const run = spawnSync(cli, args, {
    encoding: 'utf8',
    cwd: record.cwd,
    timeout: RESUME_TIMEOUT_MS,
    windowsHide: true,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli),
  });
  if (run.status === 0) return { ok: true, how: 'claude --resume' };
  const detail = ((run.stderr || run.stdout || '') + '').trim().split('\n')[0];
  // A session id that no longer resolves is the one failure worth a second
  // attempt: the work still needs doing, only the thread is gone.
  if (/No conversation found/i.test(detail)) {
    const second = spawnSync(cli, claudeArgs(record, prompt, config, true), {
      encoding: 'utf8',
      cwd: record.cwd,
      timeout: RESUME_TIMEOUT_MS,
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli),
    });
    if (second.status === 0) return { ok: true, how: 'claude --continue' };
    return { ok: false, error: ((second.stderr || second.stdout || '') + '').trim().split('\n')[0] || detail };
  }
  return { ok: false, error: detail || 'claude exited ' + run.status };
}

function deliverCodex(record, prompt, cli) {
  // Codex keeps interactive sessions on a local app server, and queue is the
  // supported way to put a message into one from outside. If the thread is
  // gone, exec resume does the same work in a fresh process.
  const queued = spawnSync(cli, ['queue', '--thread', record.id, '--message', prompt], {
    encoding: 'utf8',
    cwd: record.cwd,
    timeout: 60000,
    windowsHide: true,
  });
  if (queued.status === 0) return { ok: true, how: 'codex queue' };
  const run = spawnSync(cli, ['exec', 'resume', record.id, prompt, '--skip-git-repo-check'], {
    encoding: 'utf8',
    cwd: record.cwd,
    timeout: RESUME_TIMEOUT_MS,
    windowsHide: true,
  });
  if (run.status === 0) return { ok: true, how: 'codex exec resume' };
  return { ok: false, error: ((run.stderr || run.stdout || '') + '').trim().split('\n')[0] || 'codex exited ' + run.status };
}

function finish(state, record, outcome, detail, now) {
  state.history.push(
    Object.assign({}, record, { endedAt: now, outcome, detail: detail || null })
  );
  state.history = state.history.slice(-10);
  state.armed = null;
  relay.write(state);
  relay.note('wake ' + record.id + ': ' + outcome + (detail ? ' - ' + detail : ''), now);
  // Last, deliberately: this deletes the task this process is running under,
  // so everything that had to be recorded is already on disk before it runs.
  if (record.task) {
    try {
      relay.cancelSchedule(record.task);
    } catch (err) {
      // The expiry set at registration removes it either way.
    }
  }
}

async function run(now, argv) {
  const id = argOf(argv, '--id');
  const state = relay.read();
  const record = state.armed;
  if (!record) return { outcome: 'nothing-armed' };
  if (id && record.id !== id) return { outcome: 'superseded' };

  const config = relay.settings(state);
  const capabilities = relay.capabilities();

  const reopened = await windowReopened(record, now);
  // Only reschedule on a reading that says the window is still full. An
  // unreadable meter is not evidence of a limit, and refusing to act on it
  // would turn every offline moment into a cancelled relay.
  if (reopened.known && Number.isFinite(reopened.percent) && reopened.percent >= config.at) {
    const attempt = (record.attempt || 0) + 1;
    if (attempt >= config.attempts) {
      toast('Usage limits', 'The window still reads ' + Math.round(reopened.percent) + ' per cent after ' + attempt + ' checks. The plan is saved; pick it up when you are ready.');
      finish(state, record, 'gave-up', 'window still at ' + Math.round(reopened.percent) + '%', now);
      return { outcome: 'gave-up' };
    }
    const again = relay.arm({
      now,
      sessionId: record.id,
      cwd: record.cwd,
      hostName: record.host,
      resetsAt: now + config.graceMinutes * MINUTE,
      binding: { percentUsed: reopened.percent, resetsAt: now + config.graceMinutes * MINUTE },
      work: Object.assign({ hasWork: true, pending: 1, source: null, todos: [] }, record.work || {}),
      config,
    });
    if (again.ok) {
      const held = relay.read();
      held.armed.attempt = attempt;
      held.armed.continuation = record.continuation;
      relay.write(held);
    }
    relay.note('wake ' + record.id + ': window still at ' + Math.round(reopened.percent) + '%, retry ' + attempt, now);
    return { outcome: 'rescheduled', attempt };
  }

  const continuation = relay.readContinuation(record.id);
  const prompt = relay.compose({
    continuation,
    work: record.work && record.work.todos ? record.work : null,
    thinking: config.thinking !== 'off',
    voice: voice.card(),
  });

  let mode = config.mode;
  const presence = userIsPresent(config.mode === 'resume' ? capabilities.computerUse : null);
  if (mode === 'resume' && presence.known && presence.present && config.whenBusy === 'notify') {
    mode = 'notify';
    relay.note('wake ' + record.id + ': someone is at the machine, leaving a note instead', now);
  }

  if (mode === 'notify') {
    toast(
      'Usage limits: the window has reset',
      'The plan for ' + (record.project || path.basename(record.cwd)) + ' is ready to pick up. Run: claude --resume ' + record.id.slice(0, 8)
    );
    finish(state, record, 'notified', presence.present ? 'user present' : null, now);
    return { outcome: 'notified' };
  }

  const cli = record.host === host.CODEX ? capabilities.codex : capabilities.claude;
  if (!cli) {
    toast('Usage limits', 'The window has reset but the ' + record.host + ' CLI could not be found, so the plan was left on disk.');
    finish(state, record, 'no-cli', null, now);
    return { outcome: 'no-cli' };
  }

  toast('Usage limits: resuming', 'Carrying on with ' + (record.project || path.basename(record.cwd)) + ' where the limit stopped it.');
  const delivered = record.host === host.CODEX ? deliverCodex(record, prompt, cli) : deliverClaude(record, prompt, config, cli);
  if (delivered.ok) {
    toast('Usage limits: done', 'The resumed run finished. Open the session to read it.');
    finish(state, record, 'resumed', delivered.how, now);
    return { outcome: 'resumed', how: delivered.how };
  }
  toast('Usage limits: could not resume', delivered.error || 'The plan is still on disk.');
  finish(state, record, 'failed', delivered.error, now);
  return { outcome: 'failed', error: delivered.error };
}

if (require.main === module) {
  run(Date.now(), process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(0);
    },
    (err) => {
      relay.note('wake crashed: ' + err.message, Date.now());
      process.exit(0);
    }
  );
}

module.exports = { run, toast, userIsPresent, claudeArgs, deliverClaude, deliverCodex, windowReopened, argOf };
