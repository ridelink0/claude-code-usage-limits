'use strict';

// Which agent this is running inside, and therefore whose meter to read.
//
// The plugin ships for two hosts. Claude Code keeps its usage figures in
// ~/.claude.json and its turn history under ~/.claude/projects. Codex keeps
// both in its session rollouts under ~/.codex/sessions. The maths downstream is
// the same either way; only the two readers differ.
//
// Guessing wrong is worse than not guessing, because a machine with both
// installed would confidently report the other agent's budget. So anything that
// installs a hook or a command states the host outright, and detection is only
// the fallback for someone running the script by hand.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE = 'claude';
const CODEX = 'codex';

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch (err) {
    return false;
  }
}

// Claude Code only writes this once it has talked to the API, so its presence
// is a stronger signal than the directory existing.
function claudeHasSnapshot() {
  const scoped = path.join(claudeConfigDir(), '.claude.json');
  const file = exists(scoped) ? scoped : path.join(os.homedir(), '.claude.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Boolean(parsed && parsed.cachedUsageUtilization);
  } catch (err) {
    return false;
  }
}

function codexHasSessions() {
  return exists(path.join(codexHome(), 'sessions'));
}

function normalise(value) {
  const name = String(value || '').trim().toLowerCase();
  if (name === CODEX || name === 'chatgpt' || name === 'openai') return CODEX;
  if (name === CLAUDE || name === 'claude-code' || name === 'anthropic') return CLAUDE;
  return null;
}

// `--host codex` beats everything, then the environment variable, then what is
// actually on disk. Claude wins ties: it is the host the hook was written for,
// and its reader fails loudly rather than silently reporting nothing.
function detect(argv, env) {
  const args = argv || [];
  const at = args.indexOf('--host');
  const explicit = at !== -1 ? normalise(args[at + 1]) : null;
  if (explicit) return explicit;

  const environment = env || process.env;
  const fromEnv = normalise(environment.USAGE_LIMITS_HOST);
  if (fromEnv) return fromEnv;

  // Set by Claude Code for plugin hooks and commands.
  if (environment.CLAUDE_PLUGIN_ROOT || environment.CLAUDE_PROJECT_DIR) return CLAUDE;
  // Set by Codex for the processes it launches.
  if (environment.CODEX_HOME || environment.CODEX_CLI_PATH) return CODEX;

  if (claudeHasSnapshot()) return CLAUDE;
  if (codexHasSessions()) return CODEX;
  return CLAUDE;
}

module.exports = {
  CLAUDE,
  CODEX,
  detect,
  normalise,
  codexHome,
  claudeConfigDir,
  claudeHasSnapshot,
  codexHasSessions,
  exists,
};
