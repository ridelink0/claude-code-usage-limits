'use strict';

// vscode/lib/ is a generated copy of skills/usage-limits/scripts/, made by
// vscode/build.js so the extension packages with no dependencies. The only
// tests that touch it (vscode.test.js) run build.js first, which regenerates
// it in place - so a stale checked-in copy would sail through that test
// undetected, and the packaged extension would ship whatever logic was last
// committed there rather than whatever the plugin actually does now.
//
// This test never calls build.js. It recomputes what build.js would write,
// straight from the same source files, and diffs that against whatever is
// on disk in vscode/lib/ right now - so it catches drift whether or not
// build.js happened to run first in this process.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const from = path.join(root, 'skills', 'usage-limits', 'scripts');
const to = path.join(root, 'vscode', 'lib');

// The one deliberate difference: live.js resolves the package version from a
// different depth when it lives under vscode/lib/ than it does under
// skills/usage-limits/scripts/.
function expectedContent(name, source) {
  if (name === 'live.js') {
    return source.replace("require('../../../package.json')", "require('./package.json')");
  }
  return source;
}

test('vscode/lib/ matches skills/usage-limits/scripts/, apart from the one known live.js patch', () => {
  const sourceFiles = fs.readdirSync(from).filter((name) => name.endsWith('.js')).sort();
  const packagedFiles = fs
    .readdirSync(to)
    .filter((name) => name.endsWith('.js'))
    .sort();

  assert.deepStrictEqual(
    packagedFiles,
    sourceFiles,
    'vscode/lib/ must carry exactly the scripts the plugin ships, no more and no fewer'
  );

  const mismatched = [];
  for (const name of sourceFiles) {
    const source = fs.readFileSync(path.join(from, name), 'utf8');
    const packaged = fs.readFileSync(path.join(to, name), 'utf8');
    const expected = expectedContent(name, source);
    if (packaged !== expected) mismatched.push(name);
  }

  assert.deepStrictEqual(
    mismatched,
    [],
    'these packaged scripts have drifted from skills/usage-limits/scripts/: run `node vscode/build.js` and commit the result'
  );
});
