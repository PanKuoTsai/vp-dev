'use strict';
// HTML of the Profile panel (G-05). The extension posts {type: 'profile', ...}
// every few seconds; the page shows the functions with the most samples and
// sends back the controls (CPU, sampling on/off, reset, symbol file).
// No VS Code dependency.
//
// Layout (same look as the platform view): a header with the sampling state and
// the controls, a strip of key figures, the three hottest functions as cards,
// and every function with its share.

const { css, ICON, esc } = require('./webtheme');

function render(nonce, cspSource, title) {
  const [name, platform] = String(title).split(/:\s*/, 2);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style nonce="${nonce}">
${css}
.cpu-pick{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--vp-muted)}.cpu-pick select{height:32px;font-family:inherit}
html,body{height:100%}
.app{display:grid;grid-template-rows:auto auto minmax(0,1fr);height:100vh}
.content{padding:16px 20px 24px;display:flex;flex-direction:column;gap:14px;overflow:auto;min-height:0}
@media (max-width:760px){.stats{grid-template-columns:repeat(auto-fit,minmax(96px,1fr))}.stat{padding:7px 12px}.stat-value{font-size:14px}.stat-sub{display:none}.head{padding:10px 14px}.desc{display:none}}
.hot{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.hotcard{background:var(--vp-panel);border:1px solid var(--vp-border);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:4px;min-width:0}
.hotcard .rank{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--vp-muted)}
.hotcard .pct{font-size:24px;font-weight:600;letter-spacing:-.02em;color:var(--vp-accent)}
.hotcard.user .pct{color:var(--vp-periph)}
.hotcard .fn{font-family:var(--vp-mono);font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hotcard .meta{font-size:11.5px;color:var(--vp-muted)}
.hotcard .track{height:5px;border-radius:3px;background:color-mix(in srgb,var(--vp-muted) 20%,transparent);overflow:hidden;margin-top:4px}
.hotcard .track div,.meter{height:100%;border-radius:3px;background:var(--vp-accent)}
.hotcard.user .track div,tr.user .meter{background:var(--vp-periph)}
table.fns th{position:sticky;top:0;background:var(--vp-bg);z-index:1}
td.rank{color:var(--vp-muted);width:36px}
td.pct{width:56px;font-weight:600}
td.bar,th.bar{width:160px;min-width:120px}td.bar .meterbox{height:8px;border-radius:3px;background:color-mix(in srgb,var(--vp-muted) 14%,transparent);overflow:hidden}
td.fn{font-family:var(--vp-mono);width:100%}
tr.nosym td.fn{color:var(--vp-muted);font-style:italic}
.pill.kernel{color:var(--vp-accent);background:color-mix(in srgb,var(--vp-accent) 14%,transparent)}
.pill.user{color:var(--vp-periph);background:color-mix(in srgb,var(--vp-periph) 15%,transparent)}
tbody tr:hover td{background:var(--vscode-list-hoverBackground)}
#summary{font-size:12px;margin:0}
.empty{padding:24px 0;text-align:center}
</style></head><body>
<div class="app">
<header class="head">
  <div class="ident">${ICON.flame}<div class="ident-text">
    <div class="title-row"><h1>${esc(name)}</h1>${platform ? `<span class="tag mono">${esc(platform)}</span>` : ''}<span id="pstate" class="status idle" aria-live="polite"><span class="dot"></span><span id="pstate-t">Waiting for the simulation</span></span></div>
    <p class="desc">Where the guest software spends its instructions, by function; a sample every so many instructions.</p>
  </div></div>
  <div class="actions">
    <label class="cpu-pick">CPU <select id="cpu" aria-label="CPU"><option value="">all</option></select></label>
    <button id="sampling" class="toggle" aria-pressed="true" title="Take samples; off keeps what was taken">${ICON.record}<span id="sampling-t">Sampling</span></button>
    <button id="reset" class="tinted" title="Start a new interval: drop the samples taken so far">${ICON.reset}Reset</button>
    <button id="choose" title="Choose the symbol file (for example vmlinux)">${ICON.file}Symbols…</button>
  </div>
</header>
<section class="stats" aria-label="Profile summary">
  <div class="stat"><div class="stat-label">Samples</div><div class="stat-value" id="st-samples">0</div><div class="stat-sub" id="st-samples-s">all CPUs</div></div>
  <div class="stat"><div class="stat-label">Instructions</div><div class="stat-value" id="st-ins">–</div><div class="stat-sub">about, from the samples</div></div>
  <div class="stat"><div class="stat-label">Host time</div><div class="stat-value" id="st-time">–</div><div class="stat-sub">of this interval</div></div>
  <div class="stat"><div class="stat-label">Interval</div><div class="stat-value" id="st-period">–</div><div class="stat-sub">instructions per sample</div></div>
  <div class="stat"><div class="stat-label">Symbols</div><div class="stat-value mono" id="sym">none</div><div class="stat-sub mono" id="st-kaslr">no KASLR offset</div></div>
</section>
<div class="content">
  <p class="banner warn" id="warn" role="alert" hidden></p>
  <div class="hot" id="hot" aria-label="Hottest functions"></div>
  <p class="muted" id="summary" aria-live="polite">Waiting for the simulation…</p>
  <table class="fns" aria-label="Functions by samples"><thead><tr><th class="num">#</th><th class="num">%</th><th class="bar"></th><th class="num">Samples</th><th>Function</th><th>Space</th></tr></thead>
  <tbody id="rows"></tbody></table>
  <p class="muted empty" id="empty">No samples yet.</p>
</div>
</div>
<script nonce="${nonce}">
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
const post = (m) => { if (vscode) vscode.postMessage(m); };
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');
const big = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + ' billion' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' million' : fmt(n);
let cpus = [];
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
window.addEventListener('message', (ev) => {
  const m = ev.data || {};
  if (m.type !== 'profile') return;
  const list = (m.cpus || []).map((c) => String(c.cpu));
  if (list.join(',') !== cpus.join(',')) {
    const sel = $('cpu'); const cur = sel.value; cpus = list; sel.length = 1;
    for (const c of m.cpus) { const o = document.createElement('option'); o.value = String(c.cpu); o.textContent = 'cpu ' + c.cpu; sel.appendChild(o); }
    sel.value = cpus.includes(cur) ? cur : '';
  }
  const on = !!m.enabled;
  $('sampling').setAttribute('aria-pressed', String(on));
  $('sampling-t').textContent = on ? 'Sampling' : 'Sample';
  const st = $('pstate');
  st.className = 'status ' + (m.active && on ? 'live' : 'idle');
  $('pstate-t').textContent = m.problem ? 'Not profiling' : !m.active ? 'Waiting for the simulation' : on ? 'Sampling' : 'Sampling off';
  const s = m.stats || {};
  $('st-samples').textContent = fmt(m.total || 0);
  $('st-samples-s').textContent = s.cpu ? 'cpu ' + s.cpu : 'all CPUs';
  $('st-ins').textContent = s.instructions ? big(s.instructions) : '–';
  $('st-time').textContent = s.seconds !== undefined ? Math.round(s.seconds) + ' s' : '–';
  $('st-period').textContent = s.period ? fmt(s.period) : '–';
  $('sym').textContent = m.symbolFile || 'none';
  $('st-kaslr').textContent = s.offset ? 'KASLR offset ' + s.offset : 'no KASLR offset';
  $('summary').textContent = m.text || '';
  $('summary').hidden = !!(s.period && m.text); // the strip above says the same
  $('warn').hidden = !m.warning; $('warn').textContent = m.warning || '';
  const rows = m.rows || [];
  const top = rows.length ? rows[0].samples : 1;
  const pctOf = (r) => (m.total ? (100 * r.samples / m.total) : 0);
  // The three hottest functions, as cards.
  const hot = $('hot'); hot.textContent = '';
  rows.slice(0, 3).forEach((r, k) => {
    const c = el('div', 'hotcard ' + (r.space === 'user' ? 'user' : 'kernel'));
    c.append(el('div', 'rank', (k === 0 ? 'Hottest' : '#' + (k + 1)) + ' · ' + r.space), el('div', 'pct', pctOf(r).toFixed(1) + '%'), el('div', 'fn', r.name),
      el('div', 'meta', fmt(r.samples) + ' samples'));
    const t = el('div', 'track'); const b = el('div'); b.style.width = Math.max(1, Math.round(pctOf(r))) + '%'; t.appendChild(b); c.appendChild(t);
    c.title = r.name; hot.appendChild(c);
  });
  const tb = $('rows'); tb.textContent = '';
  rows.forEach((r, k) => {
    const tr = document.createElement('tr');
    tr.className = (r.space === 'user' ? 'user' : 'kernel') + (r.resolved ? '' : ' nosym');
    tr.append(el('td', 'num rank', String(k + 1)), el('td', 'num pct', pctOf(r).toFixed(1)));
    const td = el('td', 'bar'); const box = el('div', 'meterbox'); const bar = el('div', 'meter');
    bar.style.width = Math.max(1, Math.round(100 * r.samples / top)) + '%'; box.appendChild(bar); td.appendChild(box); tr.appendChild(td);
    tr.append(el('td', 'num', fmt(r.samples)), el('td', 'fn', r.name));
    const sp = el('td'); sp.appendChild(el('span', 'pill ' + (r.space === 'user' ? 'user' : 'kernel'), r.space)); tr.appendChild(sp);
    tb.appendChild(tr);
  });
  $('empty').hidden = rows.length > 0;
  $('empty').textContent = m.problem ? 'Profiling is off: ' + m.problem : 'No samples yet.';
});
$('cpu').addEventListener('change', () => post({ type: 'cpu', cpu: $('cpu').value }));
$('sampling').addEventListener('click', () => post({ type: 'sampling', enabled: $('sampling').getAttribute('aria-pressed') !== 'true' }));
$('reset').addEventListener('click', () => post({ type: 'reset' }));
$('choose').addEventListener('click', () => post({ type: 'chooseSymbols' }));
post({ type: 'ready' });
</script></body></html>`;
}

module.exports = { render };
