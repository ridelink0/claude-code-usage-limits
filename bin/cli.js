#!/usr/bin/env node
'use strict';

// One entry point for the npm package. The plugin and skill call the scripts
// under skills/usage-limits/scripts directly; this just gives npx users a
// single command that reaches the same code.

const HELP = `claude-usage-limits - how much Claude Code usage is left, and whether the job fits

  claude-usage-limits                     the report
  claude-usage-limits --json              the same numbers, machine readable
  claude-usage-limits --status            one short line, for a status line
  claude-usage-limits --forecast 15       what a 15 turn job would cost

  claude-usage-limits lowpower status     show the current effort setting
  claude-usage-limits lowpower on         lower effortLevel, remembering the old value
  claude-usage-limits lowpower on --effort medium --model sonnet
  claude-usage-limits lowpower off        put back exactly what was there

Reads the usage figures Claude Code already caches locally, plus your session
transcripts, to report the remaining headroom as turns of work. Nothing is
uploaded and no credentials are read.

  https://github.com/ridelink0/claude-code-usage-limits
`;

function run(argv) {
  const args = argv || [];

  if (args.indexOf('--help') !== -1 || args.indexOf('-h') !== -1) {
    process.stdout.write(HELP);
    return Promise.resolve(0);
  }

  if (args.indexOf('--version') !== -1 || args.indexOf('-v') !== -1) {
    process.stdout.write(require('../package.json').version + '\n');
    return Promise.resolve(0);
  }

  if (args[0] === 'lowpower') {
    const lowpower = require('../skills/usage-limits/scripts/lowpower.js');
    return Promise.resolve(lowpower.main(args.slice(1)));
  }

  const usage = require('../skills/usage-limits/scripts/usage.js');
  return Promise.resolve(usage.main(args));
}

if (require.main === module) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code || 0;
    },
    (err) => {
      process.stderr.write(
        'claude-usage-limits: ' + (err && err.message ? err.message : String(err)) + '\n'
      );
      process.exitCode = 1;
    }
  );
}

module.exports = { run, HELP };
