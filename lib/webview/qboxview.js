'use strict';
// HTML of the Build QBox view. The extension posts
// { type: 'state', status, form, choices, check, command, running, last };
// the page shows the QBox folder's state and the build settings, and posts
// { type: 'ready' | 'set' (form) | 'browse' (field) | 'build' | 'moveBuild' | 'cmakeToolsOff' | 'command' (name) }.
// No VS Code dependency.

const { css, ICON, BRAND, esc } = require('./webtheme');

function render(nonce, cspSource) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Build QBox</title>
<style nonce="${nonce}">
${css}
body{overflow-y:auto}
[hidden]{display:none!important}
button:disabled{opacity:.45;cursor:default;filter:saturate(.4)}
.app{display:flex;flex-direction:column;min-height:100vh}
.head .ident h1{font-size:16px}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;padding:16px 20px 24px;align-items:start}
.col{display:flex;flex-direction:column;gap:14px;min-width:0}
.card{padding:14px 16px}
.card-h{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.card-h .n{width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;background:color-mix(in srgb,var(--vp-accent) 20%,transparent);color:var(--vscode-foreground)}
.card-h h2{font-size:13px}
.card-h .sub{margin-left:auto;font-size:11.5px;color:var(--vp-muted)}
.row{display:flex;gap:8px;align-items:center}
.row input[type=text]{flex:1;min-width:0;font-family:var(--vp-mono)}
.field{display:flex;flex-direction:column;gap:4px;margin-top:10px}
.field>.lbl{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--vp-muted)}
.hint{font-size:12px;color:var(--vp-muted);line-height:1.45;margin:6px 0 0}
.facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;margin-top:10px}
.fact{border:1px solid var(--vp-border);border-radius:6px;padding:5px 8px;background:var(--vp-bg);min-width:0}
.fact .k{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--vp-muted)}
.fact .v{font-family:var(--vp-mono);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fact.good .v{color:var(--vp-good)}.fact.warn .v{color:var(--vscode-editorWarning-foreground)}.fact.bad .v{color:var(--vscode-errorForeground)}
.opts{display:flex;flex-direction:column;gap:6px;margin-top:4px}
.opt{display:flex;gap:8px;align-items:flex-start;padding:7px 9px;border:1px solid var(--vp-border);border-radius:6px;background:var(--vp-bg);cursor:pointer}
.opt:hover{border-color:color-mix(in srgb,var(--vp-accent) 60%,var(--vp-border))}
.opt.on{border-color:var(--vp-accent);background:color-mix(in srgb,var(--vp-accent) 9%,var(--vp-bg))}
.opt input{margin-top:2px}
.opt .t{font-size:12.5px}.opt .d{font-size:11.5px;color:var(--vp-muted);margin-top:2px}
.opt .t.mono{font-family:var(--vp-mono);word-break:break-all}
.targets{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.tgt{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid var(--vp-border);border-radius:999px;font-family:var(--vp-mono);font-size:12px;cursor:pointer}
.tgt.on{border-color:var(--vp-accent);background:color-mix(in srgb,var(--vp-accent) 12%,transparent)}
.tgt .was{font-family:var(--vscode-font-family);font-size:10.5px;color:var(--vp-muted)}
select,input[type=number]{height:26px}
input[type=number]{width:80px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vp-border));border-radius:4px;padding:0 6px;font:inherit}
.checks{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.check{display:flex;gap:8px;align-items:flex-start;font-size:12.5px}
.check .d{display:block;font-size:11.5px;color:var(--vp-muted)}
.plist{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}
.plist li{display:flex;gap:8px;align-items:baseline;font-size:12px}
.plist .st{font-size:11px;padding:0 7px;border-radius:999px;border:1px solid var(--vp-border);flex:none}
.plist .st.yes{color:var(--vp-good);border-color:color-mix(in srgb,var(--vp-good) 50%,transparent)}
.plist .st.no{color:var(--vscode-editorWarning-foreground);border-color:currentColor}
.plist .ttl{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side{position:sticky;top:12px}
.msgs{display:flex;flex-direction:column;gap:6px}
.msg{font-size:12px;line-height:1.45;padding:7px 9px;border-radius:6px;border:1px solid var(--vp-border)}
.msg.err{border-color:color-mix(in srgb,var(--vscode-errorForeground) 60%,transparent);background:color-mix(in srgb,var(--vscode-errorForeground) 8%,transparent)}
.msg.warn{border-color:color-mix(in srgb,var(--vscode-editorWarning-foreground) 60%,transparent);background:color-mix(in srgb,var(--vscode-editorWarning-foreground) 8%,transparent)}
.msg.chg{border-color:color-mix(in srgb,var(--vp-accent) 50%,transparent)}
.cmd{font-family:var(--vp-mono);font-size:11.5px;background:var(--vp-bg);border:1px solid var(--vp-border);border-radius:6px;padding:8px;white-space:pre-wrap;word-break:break-all;margin:0;max-height:180px;overflow:auto}
.actions{display:flex;flex-direction:column;gap:8px}
.actions button{width:100%;justify-content:center}
.actions .row button{width:auto;flex:1}
button.big{height:34px;font-size:13px}
.last{font-size:12px;color:var(--vp-muted)}
.stat-value.warn{color:var(--vscode-editorWarning-foreground)}
.last.ok{color:var(--vp-good)}.last.bad{color:var(--vscode-errorForeground)}
@media (max-width:900px){.layout{grid-template-columns:minmax(0,1fr)}.side{position:static}}
</style></head><body>
<div class="app">
<header class="head">
  <div class="ident">${BRAND}<div class="ident-text">
    <div class="title-row"><h1>Build QBox</h1><span class="status idle" id="state"><span class="dot"></span><span id="state-t">Reading…</span></span></div>
    <p class="desc" id="desc">The QBox VP Studio runs, and how it is built.</p>
  </div></div>
</header>
<section class="stats" aria-label="QBox state" id="stats"></section>
<div class="layout">
  <div class="col">
    <section class="card" aria-labelledby="h-src">
      <div class="card-h"><span class="n">1</span><h2 id="h-src">QBox folder</h2><span class="sub" id="src-kind"></span></div>
      <div class="row"><input type="text" id="src" spellcheck="false" aria-label="QBox folder"><button id="src-browse">Browse…</button></div>
      <div class="facts" id="src-facts"></div>
      <div class="checks" id="checkout-box" hidden>
        <label class="check"><input type="checkbox" id="checkout"><span>Check out the pinned commit first<span class="d" id="checkout-d"></span></span></label>
      </div>
      <p class="hint">A QBox source tree, or an empty folder: VP Studio clones the pinned QBox into it. The build directory is <span class="mono">&lt;folder&gt;/build</span>.</p>
    </section>
    <section class="card" aria-labelledby="h-cfg">
      <div class="card-h"><span class="n">2</span><h2 id="h-cfg">Build settings</h2><span class="sub" id="cfg-was"></span></div>
      <div class="field"><span class="lbl">Configure preset</span><select id="preset" aria-label="Configure preset"></select></div>
      <div class="field"><span class="lbl">QEMU targets</span><div class="targets" id="targets" role="group" aria-label="QEMU targets"></div>
        <p class="hint">AArch64 is enough for the Ubuntu AArch64 platform; every target adds build time.</p></div>
      <div class="field"><span class="lbl">Parallel jobs</span><input type="number" id="jobs" min="1" max="256" aria-label="Parallel jobs"></div>
    </section>
    <section class="card" aria-labelledby="h-cpm">
      <div class="card-h"><span class="n">3</span><h2 id="h-cpm">Dependencies' sources (CPM_SOURCE_CACHE)</h2></div>
      <div class="opts" id="cache" role="radiogroup" aria-label="Package cache"></div>
      <div class="row" id="cache-custom" hidden><input type="text" id="cache-dir" spellcheck="false" aria-label="Package cache folder"><button id="cache-browse">Browse…</button></div>
      <p class="hint">SystemC, CCI, libqemu and the other packages QBox downloads. The choice is kept in build/CMakeCache.txt; a cache can be shared by several QBox builds.</p>
    </section>
    <section class="card" aria-labelledby="h-patch">
      <div class="card-h"><span class="n">4</span><h2 id="h-patch">VP Studio patches</h2></div>
      <label class="check"><input type="checkbox" id="patches"><span>Apply the patches that are not applied yet<span class="d">The MTTCG fix (multi-CPU platforms start reliably), VP Studio's probes and OpenOCD debug port (systemc-components/probes, debug_dap; the sim agent needs them), the performance models (systemc-components/perf) and libqemu's device state (checkpoints).</span></span></label>
      <ul class="plist" id="plist"></ul>
    </section>
    <section class="card" aria-labelledby="h-after">
      <div class="card-h"><span class="n">5</span><h2 id="h-after">After building</h2></div>
      <div class="checks">
        <label class="check"><input type="checkbox" id="agent"><span>Build the sim agent<span class="d" id="agent-d">It links to QBox's probes.so, so it is built against this QBox.</span></span></label>
        <label class="check"><input type="checkbox" id="useForSim"><span>Use this QBox for simulations<span class="d" id="use-d"></span></span></label>
      </div>
    </section>
  </div>
  <aside class="col side" aria-label="Build">
    <section class="card">
      <div class="card-h"><h2>Build</h2></div>
      <div class="msgs" id="msgs"></div>
      <div class="field"><span class="lbl">Runs</span><pre class="cmd" id="cmd"></pre></div>
      <div class="actions">
        <button class="primary big" id="build">${ICON.play}Build QBox</button>
        <button id="move" hidden>Move the old build directory aside</button>
        <button id="cmt-off" hidden title="Sets cmake.configureOnOpen, cmake.automaticReconfigure and cmake.configureOnEdit to false in the QBox folder's .vscode/settings.json">Turn off CMake Tools auto-configure</button>
        <div class="row"><button class="run" data-name="checkQbox">Check QBox Version</button><button class="run" data-name="buildSimAgent">Build Sim Agent</button></div>
        <div class="last" id="last"></div>
      </div>
    </section>
  </aside>
</div>
</div>
<script nonce="${nonce}">
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
const post = (m) => { if (vscode) vscode.postMessage(m); };
const $ = (id) => document.getElementById(id);
let S = null; // the last state from the extension
let form = null;
const short = (c) => (c ? String(c).slice(0, 12) : '–');
const when = (t) => (t ? new Date(t).toLocaleString() : '');
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function fact(k, v, cls, tip) { const f = el('div', 'fact' + (cls ? ' ' + cls : '')); f.append(el('div', 'k', k)); const vv = el('div', 'v', v); if (tip) vv.title = tip; f.append(vv); return f; }
function stat(label, value, sub, cls) { const s = el('div', 'stat'); s.append(el('div', 'stat-label', label)); s.append(el('div', 'stat-value' + (cls ? ' ' + cls : ''), value)); s.append(el('div', 'stat-sub', sub || '')); return s; }
function send() { post({ type: 'set', form }); }
function draw() {
  const st = S.status, ch = S.check || { errors: [], warnings: [], changes: [] };
  const running = !!S.running;
  const ready = st.kind === 'qbox' && st.cache && st.cache.configured;
  const state = $('state');
  state.className = 'status ' + (running ? 'live' : S.last && S.last.code !== 0 && S.last.code !== undefined ? 'bad' : ready && st.products[0].exists ? 'good' : 'idle');
  $('state-t').textContent = running ? 'Building…' : S.last && S.last.code !== 0 && S.last.code !== undefined ? 'Last build failed' : !form.src ? 'No QBox folder' : st.kind === 'empty' ? 'Not cloned yet' : !ready ? 'Not configured' : st.products[0].exists ? 'Built' : 'Configured, not built';
  $('desc').textContent = form.src ? form.src : 'Choose the QBox folder VP Studio runs.';
  // Figures
  const stats = $('stats'); stats.textContent = '';
  stats.append(stat('QBox commit', st.head ? short(st.head) : st.kind === 'empty' ? 'to clone' : '–', st.atPin ? 'the pinned commit' : st.head ? 'pinned ' + short(st.pinned) : '', st.head && !st.atPin ? 'warn' : ''));
  stats.append(stat('Build directory', st.cache && st.cache.configured ? (st.cache.preset + (st.cache.targets ? ' · ' + st.cache.targets.join(', ') : '')) : 'not configured', st.cache && st.cache.configured ? (st.cache.cpm ? 'cache ' + st.cache.cpm : 'no package cache') : ''));
  const ap = st.patches.filter((p) => p.applied === true).length;
  stats.append(stat('Patches', st.patches.length ? ap + ' / ' + st.patches.length : '–', 'applied', st.patches.length && ap < st.patches.length ? 'warn' : ''));
  const pv = st.products[0];
  stats.append(stat('Simulator', pv.exists ? 'built' : 'missing', pv.exists ? when(pv.mtime) : 'build/platforms-vp', pv.exists ? '' : 'warn'));
  const pr = st.products.slice(1).filter((p) => p.exists).length;
  const want = st.products.length - 1;
  stats.append(stat('VP Studio components', pr + ' / ' + want, st.products.slice(1).map((p) => p.file).join(', '), pr < want ? 'warn' : ''));
  stats.append(stat('Sim agent', st.agent && st.agent.exists ? (st.agent.version || 'built') : 'not built', st.agent && st.agent.older ? 'older than probes.so: rebuild' : '', st.agent && st.agent.older ? 'warn' : ''));
  // 1 QBox folder
  if (document.activeElement !== $('src')) $('src').value = form.src || '';
  $('src-kind').textContent = { qbox: 'QBox source', empty: 'empty: cloned at the pinned commit', other: 'not a QBox source folder' }[st.kind] || '';
  const sf = $('src-facts'); sf.textContent = '';
  if (st.kind === 'qbox') {
    sf.append(fact('Commit', short(st.head), st.atPin ? 'good' : 'warn', st.head || ''));
    sf.append(fact('Pinned', short(st.pinned), '', st.pinned || ''));
    sf.append(fact('Local changes', st.dirty === null ? 'unknown' : st.dirty ? 'yes' : 'none', st.dirty ? 'warn' : ''));
  }
  $('checkout-box').hidden = !(st.kind === 'qbox' && st.head && !st.atPin);
  $('checkout').checked = !!form.checkout;
  $('checkout-d').textContent = st.dirty ? 'The folder has local changes to tracked files: commit or stash them first.' : 'Off: builds the folder at its current commit.';
  // 2 settings
  const pre = $('preset'); pre.textContent = '';
  for (const p of S.choices.presets) { const o = el('option', '', p.label + (st.cache && st.cache.configured && p.name === st.cache.preset ? '  (configured)' : '')); o.value = p.name; pre.append(o); }
  pre.value = form.preset;
  $('cfg-was').textContent = st.cache && st.cache.configured ? 'configured: ' + st.cache.compiler + ', ' + (st.cache.buildType || '?') : '';
  const tg = $('targets'); tg.textContent = '';
  for (const t of S.choices.targets) {
    const on = form.targets.includes(t);
    const b = el('label', 'tgt' + (on ? ' on' : ''));
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = on; cb.dataset.target = t;
    b.append(cb, document.createTextNode(t));
    if (st.cache && st.cache.targets && st.cache.targets.includes(t)) b.append(el('span', 'was', 'built'));
    tg.append(b);
  }
  if (document.activeElement !== $('jobs')) $('jobs').value = form.jobs;
  // 3 cache
  const ca = $('cache'); ca.textContent = '';
  for (const c of S.choices.cache) {
    const on = form.cache.mode === c.id || (c.id === 'choose' && form.cache.mode === 'custom');
    const o = el('label', 'opt' + (on ? ' on' : ''));
    const r = el('input'); r.type = 'radio'; r.name = 'cache'; r.checked = on; r.dataset.id = c.id; if (c.dir) r.dataset.dir = c.dir;
    const t = el('div'); t.append(el('div', 't' + (c.dir ? ' mono' : ''), c.id === 'choose' ? 'Another folder' : c.label)); t.append(el('div', 'd', c.detail));
    o.append(r, t); ca.append(o);
  }
  const custom = form.cache.mode === 'custom';
  $('cache-custom').hidden = !custom;
  if (document.activeElement !== $('cache-dir')) $('cache-dir').value = custom ? form.cache.dir || '' : '';
  // 4 patches
  $('patches').checked = form.patches !== false;
  const pl = $('plist'); pl.textContent = '';
  for (const p of st.patches) {
    const li = el('li');
    li.append(el('span', 'st ' + (p.applied === true ? 'yes' : 'no'), p.applied === true ? 'applied' : p.applied === false ? 'not applied' : 'unknown'));
    li.append(el('span', 'mono', p.target));
    const t = el('span', 'ttl', p.title || p.file); t.title = p.file; li.append(t);
    pl.append(li);
  }
  if (!st.patches.length) pl.append(el('li', 'muted', st.kind === 'empty' ? 'Applied after the clone.' : 'No patch information.'));
  // 5 after
  $('agent').checked = !!form.agent;
  $('useForSim').checked = !!form.useForSim;
  $('use-d').textContent = S.simulator === S.built ? 'VP Studio already uses ' + S.built + '.' : 'Sets vpStudio.executable to ' + S.built + ' (now ' + S.simulator + ').';
  // Build
  const msgs = $('msgs'); msgs.textContent = '';
  for (const e of ch.errors) msgs.append(el('div', 'msg err', e));
  for (const w of ch.warnings) msgs.append(el('div', 'msg warn', w));
  for (const c of ch.changes) msgs.append(el('div', 'msg chg', 'Changes ' + c + '.'));
  if (!ch.errors.length && !ch.warnings.length && !ch.changes.length) msgs.append(el('div', 'msg', ready ? 'Same settings as the build directory: builds what changed.' : st.kind === 'empty' ? 'First build: clones QBox and downloads its dependencies (network; about 20 minutes or more).' : 'First build of this QBox: configures and builds it (about 20 minutes or more).'));
  $('cmd').textContent = S.command || '';
  $('build').disabled = running || ch.errors.length > 0;
  $('move').hidden = !(S.compilerChange && !running);
  $('cmt-off').hidden = !(st.cmakeTools && st.cmakeTools.auto.length);
  for (const b of document.querySelectorAll('button.run')) b.disabled = running;
  const last = $('last');
  last.className = 'last' + (S.last ? (S.last.code === 0 ? ' ok' : ' bad') : '');
  last.textContent = S.last ? (S.last.code === 0 ? 'Built ' : 'Failed (exit code ' + S.last.code + ') ') + when(S.last.at) + (S.last.text ? ' · ' + S.last.text : '') : '';
}
window.addEventListener('message', (ev) => {
  const m = ev.data || {};
  if (m.type === 'state') { S = m; form = JSON.parse(JSON.stringify(m.form)); draw(); }
});
$('src').addEventListener('change', () => { form.src = $('src').value.trim(); send(); });
$('src-browse').addEventListener('click', () => post({ type: 'browse', field: 'src' }));
$('checkout').addEventListener('change', () => { form.checkout = $('checkout').checked; send(); });
$('preset').addEventListener('change', () => { form.preset = $('preset').value; send(); });
$('targets').addEventListener('change', (e) => {
  const t = e.target.dataset.target; if (!t) return;
  form.targets = S.choices.targets.filter((x) => (x === t ? e.target.checked : form.targets.includes(x)));
  send();
});
$('jobs').addEventListener('change', () => { const n = Math.max(1, Math.min(256, Number($('jobs').value) || 1)); form.jobs = n; send(); });
$('cache').addEventListener('change', (e) => {
  const id = e.target.dataset.id; if (!id) return;
  if (id === 'choose') { form.cache = { mode: 'custom', dir: form.cache.mode === 'custom' ? form.cache.dir : '' }; send(); if (!form.cache.dir) post({ type: 'browse', field: 'cache' }); return; }
  form.cache = id === 'none' ? { mode: 'none', dir: null } : { mode: id, dir: e.target.dataset.dir };
  send();
});
$('cache-dir').addEventListener('change', () => { form.cache = { mode: 'custom', dir: $('cache-dir').value.trim() }; send(); });
$('cache-browse').addEventListener('click', () => post({ type: 'browse', field: 'cache' }));
$('patches').addEventListener('change', () => { form.patches = $('patches').checked; send(); });
$('agent').addEventListener('change', () => { form.agent = $('agent').checked; send(); });
$('useForSim').addEventListener('change', () => { form.useForSim = $('useForSim').checked; send(); });
$('build').addEventListener('click', () => post({ type: 'build' }));
$('move').addEventListener('click', () => post({ type: 'moveBuild' }));
$('cmt-off').addEventListener('click', () => post({ type: 'cmakeToolsOff' }));
for (const b of document.querySelectorAll('button.run')) b.addEventListener('click', () => post({ type: 'command', name: b.dataset.name }));
post({ type: 'ready' });
</script></body></html>`;
}

module.exports = { render };
