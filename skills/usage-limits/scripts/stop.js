#!/usr/bin/env node
'use strict';

// The end-of-reply tally.
//
// Runs as the Stop hook, after Claude has finished a reply, and puts one line
// in front of the user saying what that reply cost and what the session has
// cost so far. It costs the model nothing: the line goes to the person, not
// into the context, and the numbers come from bytes of the transcript that
// have already been written.
//
// It must never exit with code 2. On this event that would stop Claude from
// stopping.

const usage = require('./usage.js');
const host = require('./host.js');
const tally = require('./tally.js');
const activity = require('./activity.js');
const mode = require('./mode.js');
const drift = require('./drift.js');

async function run(now, hookInput) {
  const sessionId = hookInput && hookInput.session_id ? hookInput.session_id : null;

  // `off` means off here too, and that is the whole reason this check is the
  // first thing in the hook rather than a filter on the line at the end.
  //
  // This hook was the expensive one left running: it read the entire
  // transcript after every reply - 2.77 MB on the session that measured it -
  // wrote two state files and printed a line, in the mode documented as "the
  // hooks return before reading anything: no scan, no state write, no line".
  // The line goes to the person rather than into the context, so it cost no
  // tokens; the scan cost exactly what `standard` costs, which is the half of
  // that promise that was false.
  //
  // Two consequences, both stated where the user sets the mode and in the
  // docs: no end-of-reply cost line in `off`, and no drift-ledger rows tagged
  // `off` - a mode that injects nothing has no injection to attribute a cost
  // to, so there is nothing for the ledger to compare.
  //
  // USAGE_LIMITS_TALLY stays the independent control, for anyone who wants the
  // briefing and not the cost line.
  const budget = mode.forSession({ sessionId });
  if (budget.policy.briefStyle === 'none') return '';

  // The reply is finished: the panel beside the chat can stop animating.
  activity.mark('idle', sessionId, null, now);

  if (String(process.env.USAGE_LIMITS_TALLY || '').toLowerCase() === 'off') return '';
  usage.setHost(host.detect(process.argv.slice(2), process.env));

  const transcript = hookInput && hookInput.transcript_path ? hookInput.transcript_path : null;
  if (!sessionId || !transcript) return '';

  const all = tally.readState();
  const { session, delta, created } = tally.update(all, sessionId, transcript, now, {
    cwd: hookInput.cwd || null,
  });
  tally.writeState(tally.trim(all));

  // The mode ledger: what a reply actually cost, tagged with the mode that was
  // in force while it ran. Modes should be evidence rather than vibes, and this
  // is the only place that knows both halves at once. Skipped on the first
  // sighting of a session, where the figures are history rather than this
  // reply, and never allowed to disturb the hook.
  try {
    if (!created) {
      drift.recordTurns(
        budget.name,
        delta.turns,
        delta.cost,
        now,
        usage.isCodex() ? require('./codex.js').homeDir() : null
      );
    }
  } catch (err) {
    // A ledger entry is worth nothing next to the line this hook exists for.
  }

  // The first time a session is seen, everything read is history rather than
  // the reply that just finished, so only the total is shown.
  return JSON.stringify({
    systemMessage: tally.formatTally(session, created ? null : delta, tally.pricing(now)),
  });
}

if (require.main === module) {
  tally
    .readHookInput()
    .then((input) => run(Date.now(), input))
    .then(
      (text) => {
        if (text) process.stdout.write(text + '\n');
        process.exit(0);
      },
      () => {
        process.exit(0);
      }
    );
}

module.exports = { run };
