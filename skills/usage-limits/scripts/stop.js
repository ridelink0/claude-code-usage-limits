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

async function run(now, hookInput) {
  if (String(process.env.USAGE_LIMITS_TALLY || '').toLowerCase() === 'off') return '';
  usage.setHost(host.detect(process.argv.slice(2), process.env));

  const sessionId = hookInput && hookInput.session_id ? hookInput.session_id : null;
  const transcript = hookInput && hookInput.transcript_path ? hookInput.transcript_path : null;
  if (!sessionId || !transcript) return '';

  const all = tally.readState();
  const { session, delta, created } = tally.update(all, sessionId, transcript, now, {
    cwd: hookInput.cwd || null,
  });
  tally.writeState(tally.trim(all));

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
