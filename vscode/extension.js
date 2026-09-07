'use strict';

// The VS Code side of usage-limits: the same bars the terminal panel draws,
// as a view that sits directly under the Claude Code chat in the secondary
// side bar, and as a status bar item. The numbers come from the same code the
// plugin runs (copied into lib/ by build.js), so the two never disagree.

const vscode = require('vscode');
const path = require('path');

let panel = null;
let bars = null;
try {
  panel = require('./lib/panel.js');
  bars = require('./lib/bars.js');
} catch (err) {
  panel = null;
}

const FILE_CHECK_MS = 2000;

function rgb(triplet) {
  return 'rgb(' + triplet.join(',') + ')';
}

function levelColour(level) {
  if (!bars) return '#b1b9f9';
  if (level === 'error') return rgb(bars.THEME.error);
  if (level === 'warning') return rgb(bars.THEME.warning);
  return rgb(bars.THEME.fill);
}

function escape(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

// What the webview and the tooltip both need, precomputed here because the
// webview has no access to the plugin's formatting.
function prepare(built, clock) {
  const now = built.now || Date.now();
  const rows = built.rows.map((row) => ({
    key: row.key,
    title: row.title,
    percent: row.percent,
    percentText: row.percentText,
    level: row.level,
    colour: levelColour(row.level),
    sub: row.stale
      ? 'window rolled over, taking a fresh reading'
      : row.unreported
        ? 'not reported yet, run /usage in Claude Code'
        : row.idle
          ? 'nothing in this window yet'
          : row.percent === null
            ? 'no reading yet'
            : bars
              ? bars.formatReset(row.msToReset, row.resetsAtMs, now, { clock })
              : '',
  }));
  const sessions = (built.sessionsList || []).slice(0, 5).map((row) => ({
    model: row.modelName || (row.model ? (bars ? bars.prettyModel(row.model) : row.model) : 'Claude'),
    where: row.cwd ? path.basename(String(row.cwd)) : row.project || '',
    working: row.state === 'working',
    ultracode: Boolean(row.ultracode),
    agoMs: Math.max(0, now - (row.lastAt || now)),
  }));
  // The other agent's block, counting the other way. Every figure says "left",
  // and the bar is drawn from what remains, so it drains where Claude's fills.
  const codex =
    built.codex && Array.isArray(built.codex.rows) && built.codex.rows.length
      ? {
          title: built.codex.title,
          plan: built.codex.plan || '',
          note: built.codex.note || '',
          freshness: Number.isFinite(built.codex.ageMs) ? 'reading from ' + since(built.codex.ageMs) + ' ago' : '',
          rows: built.codex.rows.map((row) => ({
            title: row.title,
            percentLeft: row.percentLeft,
            percentText: row.percentText,
            level: row.level,
            colour: levelColour(row.level),
            sub: row.stale
              ? 'window rolled over since Codex last ran'
              : row.percentLeft === null
                ? 'no reading yet'
                : bars
                  ? bars.formatReset(row.msToReset, row.resetsAtMs, now, { clock })
                  : '',
          })),
        }
      : null;

  let freshness;
  if (built.state === 'none') freshness = 'no reading yet';
  else if (built.state === 'live') freshness = 'live, updated ' + since(built.ageMs) + ' ago';
  else freshness = 'cached, reading from ' + since(built.ageMs) + ' ago';
  if (built.fetch === false) freshness += ' · network off';
  return {
    rows,
    modelLabel: built.modelLabel,
    effort: built.effort,
    working: Boolean(built.working),
    // The bars carry the animation: "rainbow" for ultrathink and max effort,
    // "ultra" for the ultracode effort level. The title never changes colour.
    style: built.style || '',
    codex,
    ultrathink: Boolean(built.ultrathink),
    note: built.note,
    noteKind: built.outcome && !built.outcome.ok ? built.outcome.kind : null,
    freshness,
    sessions,
    sessionsSummary: sessions.length
      ? [
          sessions.filter((s) => s.working).length ? sessions.filter((s) => s.working).length + ' working' : null,
          sessions.filter((s) => !s.working).length ? sessions.filter((s) => !s.working).length + ' idle' : null,
        ]
          .filter(Boolean)
          .join(', ')
      : '',
  };
}

function since(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 60000) return Math.max(0, Math.round(ms / 1000)) + 's';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return minutes + 'm';
  const hours = Math.floor(minutes / 60);
  return hours + 'h ' + (minutes % 60) + 'm';
}

function short(row) {
  const label = { five_hour: '5h', seven_day: 'wk', spend_limit: 'spend' }[row.key] || row.key.replace(/^seven_day_scoped:/, '');
  return label + ' ' + row.percentText;
}

function html(webview, nonce) {
  const theme = bars ? bars.THEME : null;
  const claude = theme ? rgb(theme.claude) : '#d77757';
  const shimmer = theme ? rgb(theme.claudeShimmer) : '#eb9f7f';
  const empty = theme ? rgb(theme.empty) : '#505370';
  const ultra = theme ? rgb(theme.ultra) : '#af87ff';
  const codexColour = theme ? rgb(theme.codex) : '#10a37f';
  const rainbow = theme ? theme.rainbow.map(rgb).join(',') : '#eb5f57,#f58b57,#fac35f,#91c882,#82aadc,#9b82c8,#c882b4';
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">',
    '<style>',
    'body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);margin:0;padding:8px 12px;}',
    '.title{color:' + claude + ';font-weight:600;display:flex;align-items:center;gap:6px;}',
    '.spin{display:inline-block;width:1em;text-align:center;}',
    '.working .spin::after{content:"·";animation:spin 1.8s steps(1) infinite;}',
    '.idle .spin::after{content:"✻";}',
    '@keyframes spin{0%{content:"·"}8.3%{content:"✢"}16.6%{content:"✳"}25%{content:"✶"}33.3%{content:"✻"}41.6%{content:"✽"}50%{content:"✽"}58.3%{content:"✻"}66.6%{content:"✶"}75%{content:"✳"}83.3%{content:"✢"}91.6%{content:"·"}}',
    '.working .title .text{background:linear-gradient(90deg,' + claude + ' 0%,' + claude + ' 40%,' + shimmer + ' 50%,' + claude + ' 60%,' + claude + ' 100%);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:sweep 1.8s linear infinite;}',
    '.rainbow .fill{background:linear-gradient(90deg,' + rainbow + ',' + (theme ? rgb(theme.rainbow[0]) : '#eb5f57') + ') !important;background-size:300% 100% !important;animation:slide 3s linear infinite;}',
    '.ultra .fill{background:linear-gradient(90deg,' + ultra + ',' + (theme ? rgb(theme.ultraShimmer) : '#d0b4ff') + ',' + ultra + ') !important;background-size:200% 100% !important;animation:slide 2s linear infinite;}',
    '@keyframes slide{0%{background-position:0 0}100%{background-position:-200% 0}}',
    '@keyframes sweep{0%{background-position:100% 0}100%{background-position:-100% 0}}',
    '.who{opacity:.75;margin:2px 0 10px;}',
    '.effort{color:' + ultra + ';}',
    // The word ultrathink in the rainbow, as Claude Code paints it. Only the
    // word: the bars keep their own colour under ultrathink.
    '.think{background:linear-gradient(90deg,' + rainbow + ');background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:slide 3s linear infinite;}',
    '.row{margin:0 0 10px;}',
    '.row h4{margin:0 0 4px;font-weight:600;font-size:inherit;}',
    '.bar{display:flex;align-items:center;gap:8px;}',
    '.track{flex:1;height:8px;background:' + empty + ';border-radius:2px;overflow:hidden;}',
    '.fill{height:100%;transition:width .4s ease;}',
    '.pct{min-width:3.2em;text-align:right;font-variant-numeric:tabular-nums;}',
    '.sub{opacity:.6;font-size:.92em;margin-top:3px;}',
    '.sessions h4{margin:12px 0 4px;font-weight:600;font-size:inherit;}',
    '.sessions .s{display:flex;gap:8px;align-items:center;margin:2px 0;}',
    '.sessions .where{opacity:.6;}',
    '.sessions .state{margin-left:auto;opacity:.75;}',
    '.sessions .on .state{color:' + claude + ';opacity:1;}',
    '.codex{margin-top:16px;}',
    '.codex .ctitle{color:' + codexColour + ';font-weight:600;display:flex;align-items:center;gap:6px;margin-bottom:8px;}',
    // A plain hexagon, not the Codex logo. Codex has no mark of its own: it
    // uses OpenAI\'s Blossom, whose brand guidelines forbid recolouring it and
    // forbid lookalikes, and a third-party extension shipping it recoloured
    // would be doing both.
    '.cx{width:1em;height:1em;fill:currentColor;flex:none;}',
    // "100% left" needs more room than "100%".
    '.pct.wide{min-width:5.4em;}',
    '.note{margin-top:10px;}',
    '.note.warn{color:' + (theme ? rgb(theme.warning) : '#ffc107') + ';}',
    '.note.bad{color:' + (theme ? rgb(theme.error) : '#ff6b80') + ';}',
    '.foot{opacity:.6;margin-top:8px;display:flex;justify-content:space-between;gap:8px;}',
    'a{color:inherit;cursor:pointer;}',
    '@media (prefers-reduced-motion: reduce){.spin::after,.text,.effort{animation:none !important;}}',
    '</style></head><body>',
    '<div id="root">Reading the limits…</div>',
    '<script nonce="' + nonce + '">',
    'const vscode = acquireVsCodeApi();',
    'const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]));',
    // The Codex mark: an ordinary hexagon drawn in currentColor, so it takes
    // the block\'s green and needs no image, no CDN and no trademark.
    'const CX = \'<svg class="cx" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.798 23.976a5.7 5.7 0 0 1-2.26-.456 6.1 6.1 0 0 1-1.903-1.27 5.7 5.7 0 0 1-1.88.311 5.75 5.75 0 0 1-2.95-.79 6.2 6.2 0 0 1-2.188-2.159q-.81-1.366-.809-3.045 0-.695.19-1.51a6.4 6.4 0 0 1-1.475-2.038A5.95 5.95 0 0 1 0 10.573Q0 9.278.547 8.08q.547-1.2 1.523-2.062a5.5 5.5 0 0 1 2.307-1.223A5.7 5.7 0 0 1 5.472 2.35 6.1 6.1 0 0 1 7.565.623 5.8 5.8 0 0 1 10.206 0q1.19 0 2.26.456a6.1 6.1 0 0 1 1.903 1.27 5.7 5.7 0 0 1 1.88-.311q1.594 0 2.95.79a6 6 0 0 1 2.165 2.159q.832 1.366.832 3.045 0 .695-.19 1.51a6.3 6.3 0 0 1 1.475 2.062q.523 1.15.523 2.422a5.9 5.9 0 0 1-.547 2.493q-.547 1.2-1.546 2.086a5.4 5.4 0 0 1-2.284 1.199 5.56 5.56 0 0 1-1.118 2.445 5.9 5.9 0 0 1-2.07 1.727 5.8 5.8 0 0 1-2.64.623m-5.876-2.997q1.19 0 2.07-.504l4.472-2.589a.53.53 0 0 0 .238-.455v-2.062L8.945 18.7a.96.96 0 0 1-1.047 0l-4.496-2.613a.7.7 0 0 1-.024.168v.287q0 1.224.571 2.254a4.24 4.24 0 0 0 1.642 1.583q1.047.6 2.331.599m.238-3.908a.6.6 0 0 0 .262.072q.118 0 .238-.072l1.784-1.031-5.734-3.357q-.522-.312-.523-.935V6.545a4.3 4.3 0 0 0-1.903 1.63 4.25 4.25 0 0 0-.714 2.398q0 1.176.595 2.254.594 1.08 1.546 1.63zm5.638 5.323q1.26 0 2.284-.576a4.3 4.3 0 0 0 1.618-1.582q.595-1.008.595-2.254v-5.179a.47.47 0 0 0-.238-.431l-1.808-1.055v6.689q0 .624-.524.935l-4.496 2.613a4.3 4.3 0 0 0 2.57.84m.904-8.776v-3.26l-2.688-1.535-2.712 1.535v3.26l2.712 1.535zM7.756 5.97q0-.623.523-.935l4.496-2.613a4.3 4.3 0 0 0-2.569-.84q-1.26 0-2.284.576A4.3 4.3 0 0 0 6.304 3.74q-.57 1.008-.57 2.254v5.155q0 .287.237.455l1.785 1.055zM19.84 17.43a4.16 4.16 0 0 0 1.88-1.63 4.33 4.33 0 0 0 .713-2.397q0-1.176-.595-2.254-.594-1.08-1.546-1.63l-4.449-2.59q-.143-.096-.261-.072a.46.46 0 0 0-.238.072L13.56 7.936l5.758 3.38a.9.9 0 0 1 .38.384q.143.216.143.528zM15.059 5.25q.524-.335 1.047 0l4.52 2.662V7.48q0-1.15-.57-2.181A4.14 4.14 0 0 0 18.46 3.62q-1.023-.623-2.379-.623-1.19 0-2.07.503L9.54 6.09a.53.53 0 0 0-.238.455v2.062z"/></svg>\';',
    'function render(v){',
    '  const cls = (v.style ? v.style + " " : "") + (v.working ? "working" : "idle");',
    '  let h = `<div class="${cls}"><div class="title"><span class="spin"></span><span class="text">Claude usage</span></div>`;',
    '  h += `<div class="who">${esc(v.modelLabel)}${v.effort ? ` · <span class="effort">${esc(v.effort)}</span>` : ""}${v.ultrathink ? ` · <span class="think">ultrathink</span>` : ""} · ${v.working ? "working" : "idle"}</div>`;',
    '  for (const r of v.rows) {',
    '    const w = r.percent == null ? 0 : Math.max(r.percent > 0 ? 2 : 0, Math.min(100, r.percent));',
    '    h += `<div class="row"><h4>${esc(r.title)}</h4><div class="bar"><div class="track"><div class="fill" style="width:${w}%;background:${r.colour}"></div></div><span class="pct" style="${r.level === "fill" ? "" : "color:" + r.colour}">${esc(r.percentText)}</span></div>${r.sub ? `<div class="sub">${esc(r.sub)}</div>` : ""}</div>`;',
    '  }',
    '  if (v.codex) {',
    '    h += `<div class="codex"><div class="ctitle">${CX}<span>${esc(v.codex.title)}</span>${v.codex.plan ? `<span class="where">${esc(v.codex.plan)}</span>` : ""}</div>`;',
    '    for (const r of v.codex.rows) {',
    // Drawn from what is LEFT, so the bar empties as Codex is spent.
    '      const w = r.percentLeft == null ? 0 : Math.max(r.percentLeft > 0 ? 2 : 0, Math.min(100, r.percentLeft));',
    '      h += `<div class="row"><h4>${esc(r.title)}</h4><div class="bar"><div class="track"><div class="fill" style="width:${w}%;background:${r.colour}"></div></div><span class="pct wide" style="${r.level === "fill" ? "" : "color:" + r.colour}">${esc(r.percentText)}</span></div>${r.sub ? `<div class="sub">${esc(r.sub)}</div>` : ""}</div>`;',
    '    }',
    '    const tail = v.codex.note || v.codex.freshness;',
    '    if (tail) h += `<div class="sub">${esc(tail)}</div>`;',
    '    h += `</div>`;',
    '  }',
    '  if (v.sessions.length) {',
    '    h += `<div class="sessions"><h4>Sessions <span class="where">· ${esc(v.sessionsSummary)}</span></h4>`;',
    '    for (const s of v.sessions) h += `<div class="s ${s.working ? "on" : ""}"><span class="${s.working ? "working" : "idle"}"><span class="spin"></span></span><span>${esc(s.model)}</span>${s.where ? `<span class="where">${esc(s.where)}</span>` : ""}<span class="state">${s.working ? "working" : "idle " + ago(s.agoMs) + " ago"}</span></div>`;',
    '    h += `</div>`;',
    '  }',
    '  if (v.note) h += `<div class="note ${v.noteKind === "unauthorized" || v.noteKind === "forbidden" || v.noteKind === "no_credentials" ? "bad" : "warn"}">${esc(v.note)}</div>`;',
    '  h += `<div class="foot"><span>${esc(v.freshness)}</span><a id="r">refresh</a></div></div>`;',
    '  document.getElementById("root").innerHTML = h;',
    '  document.getElementById("r").onclick = () => vscode.postMessage({ type: "refresh" });',
    '}',
    'function ago(ms){ if (ms < 60000) return Math.round(ms/1000) + "s"; const m = Math.round(ms/60000); return m < 60 ? m + "m" : Math.floor(m/60) + "h " + (m%60) + "m"; }',
    'window.addEventListener("message", (e) => { if (e.data && e.data.type === "view") render(e.data.view); });',
    'vscode.postMessage({ type: "ready" });',
    '</script></body></html>',
  ].join('\n');
}

function activate(context) {
  const host = vscode.extensions.getExtension('anthropic.claude-code');
  vscode.commands.executeCommand('setContext', 'claudeUsageLimits.hostPresent', Boolean(host));
  // The standalone view is gated on this key, which is unset until now, so it
  // never flashes on before the Claude Code check has run.
  vscode.commands.executeCommand('setContext', 'claudeUsageLimits.standalone', !host);
  // This is VS Code with Claude Code in it. Never let the host detection wander
  // off to a Codex install that happens to be on the same machine.
  try {
    require('./lib/usage.js').setHost('claude');
  } catch (err) {
    // Without lib/ there is nothing to pin; the status bar says so below.
  }

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  item.name = 'Claude usage';
  item.command = 'claudeUsageLimits.show';
  context.subscriptions.push(item);

  const state = { views: [], last: null, prepared: null, timer: null, fetching: false, lastFetchAt: 0 };

  function config() {
    return vscode.workspace.getConfiguration('claudeUsageLimits');
  }

  // Claude Code's own timeFormat setting, from its settings.json, not a VS
  // Code setting of the same name.
  function clock() {
    try {
      const feed = require('./lib/feed.js');
      return feed.clockFor(panel.settingsFor(), process.env);
    } catch (err) {
      return '12h';
    }
  }

  function updateStatusBar(built, prepared) {
    // Off unless asked for: the panel beside the chat is the one place.
    if (!config().get('statusBar', false)) {
      item.hide();
      return;
    }
    const parts = prepared.rows.filter((row) => row.key === 'five_hour' || row.key === 'seven_day' || row.key.indexOf('seven_day_scoped:') === 0).map(short);
    item.text = '$(pulse) ' + (parts.length ? parts.join('  ') : 'usage ?');
    const worst = built.rows.reduce((acc, row) => (row.level === 'error' ? 'error' : acc === 'error' ? acc : row.level === 'warning' ? 'warning' : acc), 'fill');
    item.backgroundColor =
      worst === 'error'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : worst === 'warning'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    const tip = new vscode.MarkdownString('', true);
    tip.appendMarkdown('**Claude usage** · ' + escape(prepared.modelLabel) + (prepared.effort ? ' · ' + escape(prepared.effort) : '') + (prepared.working ? ' · working' : '') + '\n\n');
    for (const row of prepared.rows) {
      tip.appendMarkdown('**' + escape(row.title) + '** ' + escape(row.percentText) + (row.sub ? '  \n' + escape(row.sub) : '') + '\n\n');
    }
    if (prepared.sessions.length) {
      tip.appendMarkdown('**Sessions** · ' + escape(prepared.sessionsSummary) + '\n\n');
      for (const s of prepared.sessions) tip.appendMarkdown('- ' + escape(s.model) + (s.where ? ' · ' + escape(s.where) : '') + ' · ' + (s.working ? 'working' : 'idle') + '\n');
      tip.appendMarkdown('\n');
    }
    if (prepared.note) tip.appendMarkdown(escape(prepared.note) + '\n\n');
    tip.appendMarkdown(escape(prepared.freshness));
    item.tooltip = tip;
    item.show();
  }

  function broadcast() {
    for (const view of state.views) {
      try {
        view.webview.postMessage({ type: 'view', view: state.prepared });
      } catch (err) {
        // A view that has gone away is removed on dispose.
      }
    }
  }

  async function refresh(fetchNow) {
    if (!panel) {
      item.text = '$(pulse) usage: extension not built';
      item.show();
      return;
    }
    const network = config().get('fetch', true) !== false;
    const doFetch = Boolean(fetchNow) && network;
    if (doFetch && state.fetching) return;
    if (doFetch) state.fetching = true;
    try {
      const built = await panel.snapshot({
        fetch: doFetch,
        network,
        outcome: doFetch ? null : state.last && state.last.outcome,
        // Keep describing the same session, so two windows at different
        // efforts do not flip the header back and forth.
        sessionId: state.last ? state.last.sessionId : null,
      });
      state.last = built;
      state.prepared = prepare(built, clock());
      updateStatusBar(built, state.prepared);
      broadcast();
    } catch (err) {
      item.text = '$(pulse) usage ?';
      item.tooltip = 'Claude usage: ' + (err && err.message ? err.message : String(err));
      item.show();
    } finally {
      if (doFetch) {
        state.fetching = false;
        state.lastFetchAt = Date.now();
      }
    }
  }

  const provider = {
    resolveWebviewView(webviewView) {
      const nonce = String(Date.now()) + Math.random().toString(16).slice(2);
      webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
      webviewView.webview.html = html(webviewView.webview, nonce);
      state.views.push(webviewView);
      webviewView.onDidDispose(() => {
        state.views = state.views.filter((view) => view !== webviewView);
      });
      webviewView.webview.onDidReceiveMessage((message) => {
        if (message && message.type === 'refresh') refresh(true);
        if (message && message.type === 'ready' && state.prepared) {
          webviewView.webview.postMessage({ type: 'view', view: state.prepared });
        }
      });
    },
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeUsageLimits.panel', provider),
    vscode.commands.registerCommand('claudeUsageLimits.refresh', () => refresh(true)),
    vscode.commands.registerCommand('claudeUsageLimits.show', () =>
      vscode.commands.executeCommand('claudeUsageLimits.panel.focus')
    ),
    vscode.window.onDidChangeWindowState((windowState) => {
      if (windowState.focused) refresh(true);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('claudeUsageLimits')) refresh(true);
    })
  );

  // A reading on a timer, and a cheap rebuild from the plugin's files in
  // between so the working state and the other sessions stay current.
  const tick = () => {
    const pollMs = Math.max(15, Number(config().get('pollSeconds', 60)) || 60) * 1000;
    refresh(Date.now() - state.lastFetchAt >= pollMs);
  };
  state.timer = setInterval(tick, FILE_CHECK_MS);
  context.subscriptions.push({ dispose: () => clearInterval(state.timer) });
  refresh(true);
  // Open the panel in the right sidebar, so it is there beside the chat
  // without anyone having to find it.
  if (config().get('showOnStartup', true)) {
    Promise.resolve(vscode.commands.executeCommand('workbench.view.extension.claude-usage-limits')).catch(() => {});
  }
}

function deactivate() {}

module.exports = { activate, deactivate, prepare, short, html };
