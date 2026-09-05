#!/usr/bin/env node
'use strict';

// Copies the plugin's scripts into lib/ so the extension has no dependencies
// and packages as one file. Run before `vsce package`.
//
// The scripts are used exactly as they are, with one adjustment: live.js reads
// the package version from three directories up, which from lib/ is nowhere,
// so it is pointed at a package.json written beside it.

const fs = require('fs');
const path = require('path');

const here = __dirname;
const root = path.join(here, '..');
const from = path.join(root, 'skills', 'usage-limits', 'scripts');
const to = path.join(here, 'lib');

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });

let copied = 0;
for (const name of fs.readdirSync(from)) {
  if (!name.endsWith('.js')) continue;
  let source = fs.readFileSync(path.join(from, name), 'utf8');
  if (name === 'live.js') {
    source = source.replace("require('../../../package.json')", "require('./package.json')");
  }
  fs.writeFileSync(path.join(to, name), source, 'utf8');
  copied += 1;
}
fs.writeFileSync(
  path.join(to, 'package.json'),
  JSON.stringify({ name: 'claude-usage-limits', version, private: true }, null, 2) + '\n',
  'utf8'
);
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(here, 'LICENSE'));
require('./media/make-icon.js').write(path.join(here, 'media', 'icon.png'));

// The extension carries the plugin's version.
const manifestFile = path.join(here, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
if (manifest.version !== version) {
  manifest.version = version;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

process.stdout.write('copied ' + copied + ' scripts into lib/ at version ' + version + '\n');
