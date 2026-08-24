#!/usr/bin/env node
'use strict';

// npm version bumps package.json and nothing else, but the plugin manifest
// carries its own version and the marketplace pins to it. Run from the npm
// "version" lifecycle script so the two can never drift.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const manifest = path.join(root, '.claude-plugin', 'plugin.json');

const plugin = JSON.parse(fs.readFileSync(manifest, 'utf8'));
if (plugin.version === version) {
  process.stdout.write('plugin.json already at ' + version + '\n');
} else {
  const before = plugin.version;
  plugin.version = version;
  fs.writeFileSync(manifest, JSON.stringify(plugin, null, 2) + '\n', 'utf8');
  process.stdout.write('plugin.json ' + before + ' -> ' + version + '\n');
}
