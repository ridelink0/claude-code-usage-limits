'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const feed = require('../skills/usage-limits/scripts/feed.js');
const view = require('../skills/usage-limits/scripts/view.js');
const bars = require('../skills/usage-limits/scripts/bars.js');
const statusline = require('../skills/usage-limits/scripts/statusline.js');

const script = path.join(__dirname, '..', 'skills', 'usage-limits', 'scripts', 'feed.js');
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-05T12:00:00.000Z');

function account(now) {
  return {
    oauthAccount: { accountUuid: 'acc', organizationType: 'claude_max' },
    cachedUsageUtilization: {
      fetchedAtMs: now - 1000,
      accountUuid: 'acc',
      utilization: {
        five_hour: { utilization: 42, resets_at: new Date(now + HOUR).toISOString() },
        seven_day: { utilization: 7, resets_at: new Date(now + 24 * HOUR).toISOString() },
        limits: [
          {
            kind: 'weekly_scoped',
            percent: 3,
            resets_at: new Date(now + 24 * HOUR).toISOString(),
            scope: { model: { id: null, display_name: 'Fable' } },
            is_active: false,
          },
        ],
      },
    },
  };
}

function tempConfig(withSnapshot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-limits-feed-'));
  const data = withSnapshot === false ? { cachedUsageUtilization: {} } : account(Date.now());
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(data));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'claude-opus-5' }));
  return dir;
}

function run(dir, input, env) {
  return spawnSync(process.execPath, [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    timeout: 15000,
    env: Object.assign({ NO_COLOR: '1', COLUMNS: '120' }, process.env, { CLAUDE_CONFIG_DIR: dir }, env || {}),
  });
}

function statusInput(model, extra) {
  return Object.assign(
    {
      session_id: 'sess-1',
      model: { id: model, display_name: bars.prettyModel(model) },
      effort: { level: 'xhigh' },
      cost: { total_cost_usd: 1.25 },
      context_window: { used_percentage: 12 },
    },
    extra || {}
  );
}

test('the line names the windows with their percentages', () => {
  const dir = tempConfig();
  const result = run(dir, statusInput('claude-opus-5'));
  assert.strictEqual(result.status, 0, result.stderr);
  const line = result.stdout.trim();
  assert.match(line, /Opus 5/);
  assert.match(line, /xhigh/);
  assert.match(line, /session .*42%/);
  assert.match(line, /week .*7%/);
  assert.strictEqual(line.indexOf('fable'), -1, 'Fable is not running');
  assert.strictEqual(line.indexOf('\x1b'), -1, 'NO_COLOR means no escapes');
});

test('the Fable week appears when Fable is the model', () => {
  const dir = tempConfig();
  const result = run(dir, statusInput('claude-fable-5-1[1m]'));
  assert.match(result.stdout, /fable .*3%/);
});

test('per-response rate limits from Claude Code win over the cache', () => {
  const dir = tempConfig();
  const result = run(
    dir,
    statusInput('claude-opus-5', {
      rate_limits: {
        five_hour: { used_percentage: 61.7, resets_at: Math.floor((Date.now() + HOUR) / 1000) },
        seven_day: { used_percentage: 9.2, resets_at: Math.floor((Date.now() + 24 * HOUR) / 1000) },
      },
    })
  );
  assert.match(result.stdout, /session .*61%/);
  assert.match(result.stdout, /week .*9%/);
});

test('the feed records the session, and a quick second update means working', () => {
  const dir = tempConfig();
  run(dir, statusInput('claude-opus-5', { rate_limits: { five_hour: { used_percentage: 5, resets_at: 1 } } }));
  let all = JSON.parse(fs.readFileSync(path.join(dir, 'usage-limits-feed.json'), 'utf8'));
  assert.strictEqual(all['sess-1'].model, 'claude-opus-5');
  assert.strictEqual(all['sess-1'].effort, 'xhigh');
  assert.strictEqual(all['sess-1'].rateLimits.five_hour.used_percentage, 5);
  assert.strictEqual(all['sess-1'].cost, 1.25);
  assert.strictEqual(feed.isWorking(all['sess-1'], Date.now()), false, 'one update is not a turn');

  // A run without rate_limits keeps the ones already seen.
  run(dir, statusInput('claude-opus-5'));
  all = JSON.parse(fs.readFileSync(path.join(dir, 'usage-limits-feed.json'), 'utf8'));
  assert.strictEqual(all['sess-1'].rateLimits.five_hour.used_percentage, 5);
  assert.strictEqual(feed.isWorking(all['sess-1'], Date.now()), true);
  assert.strictEqual(feed.isWorking(all['sess-1'], Date.now() + 10000), false);
});

test('it fits the columns it is given', () => {
  const dir = tempConfig();
  for (const columns of [120, 60, 38, 24]) {
    const result = run(dir, statusInput('claude-fable-5-1[1m]'), { COLUMNS: String(columns) });
    const line = result.stdout.trim();
    assert.ok(bars.visibleWidth(line) <= columns, columns + ' columns: ' + line);
    assert.match(line, /42%/);
  }
});

test('bad stdin is not a crash', () => {
  const dir = tempConfig();
  const result = run(dir, '{not json');
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stderr, '');
  const empty = run(dir, '');
  assert.strictEqual(empty.status, 0);
});

test('no snapshot at all says so rather than inventing bars', () => {
  const dir = tempConfig(false);
  const result = run(dir, statusInput('claude-opus-5'));
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /no reading yet/);
});

test('a previous status line runs first and its output goes above ours', () => {
  const dir = tempConfig();
  // Written where the child will look, never through stateFile(): that reads
  // CLAUDE_CONFIG_DIR from this process, which is the real config directory.
  fs.writeFileSync(
    path.join(dir, 'usage-limits-statusline.json'),
    JSON.stringify({
      previous: { type: 'command', command: '"' + process.execPath + '" -e "process.stdout.write(\'prev line\')"' },
      chain: true,
    })
  );
  const result = run(dir, statusInput('claude-opus-5'));
  const lines = result.stdout.trim().split('\n');
  assert.strictEqual(lines[0], 'prev line');
  assert.match(lines[1], /session .*42%/);
});

test('a previous status line that fails is skipped silently', () => {
  const dir = tempConfig();
  fs.writeFileSync(
    path.join(dir, 'usage-limits-statusline.json'),
    JSON.stringify({ previous: { type: 'command', command: '"' + process.execPath + '" -e "process.exit(1)"' }, chain: true })
  );
  const result = run(dir, statusInput('claude-opus-5'));
  const lines = result.stdout.trim().split('\n');
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /session .*42%/);
});

test('USAGE_LIMITS_STATUSLINE=off still records the feed but prints nothing', () => {
  const dir = tempConfig();
  const result = run(dir, statusInput('claude-opus-5'), { USAGE_LIMITS_STATUSLINE: 'off' });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
  assert.ok(fs.existsSync(path.join(dir, 'usage-limits-feed.json')));
});

test('line paints the percentage only once it is worth noticing', () => {
  const built = view.build({
    now: NOW,
    utilization: {
      five_hour: { utilization: 85, resets_at: new Date(NOW + HOUR).toISOString() },
      seven_day: { utilization: 12, resets_at: new Date(NOW + HOUR).toISOString() },
    },
    fetchedAtMs: NOW,
    source: 'api',
    model: 'claude-opus-5',
  });
  const text = feed.line(built, { columns: 120, mode: 'truecolor', tick: 0 });
  assert.ok(text.indexOf('\x1b[38;2;255;193;7m85%') !== -1, 'the warning percentage is yellow');
  assert.ok(text.indexOf('\x1b[38;2;255;193;7m12%') === -1, 'the calm one is not');
  assert.match(bars.stripAnsi(text), /^✻ Opus 5  session █+░+ 85%  week █+░+ 12%$/);
});

test('line shows the spinner while working and the rainbow under ultracode', () => {
  const built = view.build({ now: NOW, headers: { five_hour: { used_percentage: 5, resets_at: 1 } }, headersAt: NOW, model: 'claude-opus-5', working: true, effort: 'xhigh' });
  const a = bars.stripAnsi(feed.line(built, { columns: 120, mode: 'truecolor', tick: 1 }));
  assert.strictEqual(a.charAt(0), '✢');
  const ultra = view.build({ now: NOW, headers: { five_hour: { used_percentage: 5, resets_at: 1 } }, headersAt: NOW, model: 'claude-opus-5', working: true, effort: 'xhigh', ultracode: true });
  const painted = feed.line(ultra, { columns: 120, mode: 'truecolor', tick: 1 });
  const rainbow = bars.THEME.rainbow.concat(bars.THEME.rainbowShimmer).map((rgb) => '38;2;' + rgb.join(';') + 'm');
  assert.ok(rainbow.some((code) => painted.indexOf(code) !== -1), 'rainbow colours present');
  assert.match(bars.stripAnsi(painted), /ultracode/, 'named as its own level');
});

test('slotFrom keeps what an update does not repeat', () => {
  const first = feed.slotFrom({ session_id: 's', model: { id: 'claude-opus-5', display_name: 'Opus 5' }, rate_limits: { five_hour: { used_percentage: 1 } } }, null, NOW);
  const second = feed.slotFrom({ session_id: 's' }, first, NOW + 1000);
  assert.strictEqual(second.model, 'claude-opus-5');
  assert.strictEqual(second.modelName, 'Opus 5');
  assert.strictEqual(second.rateLimits.five_hour.used_percentage, 1);
  assert.strictEqual(second.headersAt, NOW);
  assert.strictEqual(second.prevAt, NOW);
  assert.strictEqual(second.at, NOW + 1000);
});

test('record keeps the newest sessions and newest picks the latest', () => {
  let all = {};
  for (let index = 0; index < 12; index += 1) {
    all = feed.record(all, { session_id: 's' + index }, NOW + index * 1000);
  }
  assert.strictEqual(Object.keys(all).length, feed.KEEP_SESSIONS);
  assert.strictEqual(feed.newest(all).sessionId, 's11');
  assert.strictEqual(feed.record(all, null, NOW), all);
  assert.strictEqual(feed.newest({}), null);
});
