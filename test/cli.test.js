'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../bin/cli.js');

// Collect what the command prints instead of letting it reach the runner.
function capture(fn) {
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .then(
      (value) => {
        process.stdout.write = original;
        return { value, output: written.join('') };
      },
      (err) => {
        process.stdout.write = original;
        throw err;
      }
    );
}

test('--help lists every mode', async () => {
  const { value, output } = await capture(() => cli.run(['--help']));
  assert.strictEqual(value, 0);
  assert.match(output, /--json/);
  assert.match(output, /--status/);
  assert.match(output, /lowpower/);
  assert.match(output, /Nothing is\s+uploaded/);
});

test('-h is the same as --help', async () => {
  const { value, output } = await capture(() => cli.run(['-h']));
  assert.strictEqual(value, 0);
  assert.strictEqual(output, cli.HELP);
});

test('--version prints the packaged version', async () => {
  const { value, output } = await capture(() => cli.run(['--version']));
  assert.strictEqual(value, 0);
  assert.strictEqual(output.trim(), require('../package.json').version);
});

test('lowpower is routed to the settings tool, not the report', async () => {
  // Point at an empty directory so the read-only status command cannot see,
  // let alone touch, the real settings.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-limits-cli-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = sandbox;
  try {
    const { value, output } = await capture(() => cli.run(['lowpower', 'status']));
    assert.strictEqual(value, 0);
    assert.match(output, /Low power/);
    assert.doesNotMatch(output, /Claude Code usage/, 'that would be the report, not lowpower');
    assert.deepStrictEqual(
      fs.readdirSync(sandbox),
      [],
      'status must not create anything'
    );
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('the bin entry named in package.json exists and is executable by node', () => {
  const pkg = require('../package.json');
  const target = pkg.bin['claude-usage-limits'];
  assert.strictEqual(target, 'bin/cli.js');

  const file = path.join(__dirname, '..', target);
  assert.ok(fs.existsSync(file), 'the published bin target must exist');
  assert.match(
    fs.readFileSync(file, 'utf8').split('\n')[0],
    /^#!\/usr\/bin\/env node$/,
    'npx needs the shebang'
  );
});

test('everything the bin needs is in the published file list', () => {
  const pkg = require('../package.json');
  assert.strictEqual(pkg.private, undefined, 'a private package cannot be published');
  for (const needed of ['bin/', 'skills/']) {
    assert.ok(pkg.files.includes(needed), needed + ' must be published');
  }
});
