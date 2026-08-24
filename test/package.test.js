'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.join(__dirname, '..');

// What npm would actually put in the tarball, straight from npm rather than
// from our own reading of the files list.
function packedFiles() {
  const out = execSync('npm pack --dry-run --json', {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = JSON.parse(out);
  return parsed[0].files.map((entry) => entry.path.split(path.sep).join('/'));
}

// Every local module reachable from an entry point, followed through the
// require graph rather than guessed at.
function reachableFrom(entry) {
  const seen = new Set();
  const queue = [path.resolve(root, entry)];

  while (queue.length) {
    const file = queue.pop();
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (seen.has(relative)) continue;
    seen.add(relative);

    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (err) {
      continue;
    }

    const pattern = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      let target = path.resolve(path.dirname(file), match[1]);
      if (!fs.existsSync(target)) target += '.js';
      if (fs.existsSync(target)) queue.push(target);
    }
  }

  return [...seen];
}

test('everything the published CLI requires is inside the tarball', () => {
  const packed = packedFiles();
  const needed = reachableFrom('bin/cli.js');

  assert.ok(needed.length >= 3, 'expected the CLI to pull in the two scripts');
  for (const file of needed) {
    assert.ok(
      packed.includes(file),
      file + ' is required at runtime but would not be published. Add it to the ' +
        'files list in package.json, or npx installs will break while every ' +
        'other test still passes.'
    );
  }
});

test('the skill itself ships, not just the scripts', () => {
  const packed = packedFiles();
  for (const file of [
    'skills/usage-limits/SKILL.md',
    'skills/usage-limits/references/tactics.md',
    'skills/usage-limits/references/how-it-works.md',
    'commands/check.md',
    '.claude-plugin/plugin.json',
  ]) {
    assert.ok(packed.includes(file), file + ' should be in the package');
  }
});

test('the tarball stays small enough to be uncontroversial', () => {
  const out = execSync('npm pack --dry-run --json', {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const info = JSON.parse(out)[0];
  assert.ok(
    info.unpackedSize < 2 * 1024 * 1024,
    'unpacked size grew to ' + info.unpackedSize + ' bytes; something large got in'
  );
});

test('the package version and the plugin manifest version agree', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')
  );
  assert.strictEqual(
    pkg.version,
    manifest.version,
    'a release bumps package.json; plugin.json has to move with it or the ' +
      'marketplace pins an older version than npm serves'
  );
});
