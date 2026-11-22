'use strict';
// HTML of the Transaction Trace panel. The extension posts batches of decoded
// records ({type: 'records', records, points, status}); the page keeps them,
// filters them and shows the newest matching rows. No VS Code dependency.
//
// Layout (same look as the platform view): a header with the recording state
// and the main actions, a strip of key figures, the probes, filter and
// breakpoint settings on the left, and the accesses on the right.

const { css, ICON, esc } = require('./webtheme');

function render(nonce, cspSource, title) {
  const [name, platform] = String(title).split(/:\s*/, 2);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style nonce="${nonce}">
${css}
html,body{height:100%}
.app{display:grid;grid-template-rows:auto auto auto minmax(0,1fr);height:100vh}
.tbody{display:grid;grid-template-columns:300px minmax(0,1fr);min-height:0;grid-row:4}
/* A breakpoint stop stays in sight above the scrolling parts until Continue. */
#hit{grid-row:3;margin:10px 18px 0}
.status.bad{border:1px solid currentColor;background:color-mix(in srgb,var(--vscode-errorForeground) 10%,transparent)}
.hit-note{color:var(--vp-muted);font-size:12px}
.side{overflow:auto;padding:14px;display:flex;flex-direction:column;gap:12px;border-right:1px solid var(--vp-border);background:var(--vp-bg)}
.tmain{overflow:auto;min-height:0;padding:0 18px 18px;display:flex;flex-direction:column}
#summary{margin:10px 0 6px;font-size:12px}
.side .muted{margin:0;font-size:12px;line-height:1.45}
button.toggle-soft[aria-pressed=true]{background:color-mix(in srgb,var(--vp-accent) 22%,var(--vp-panel));border-color:color-mix(in srgb,var(--vp-accent) 70%,transparent)}
button.toggle-soft[aria-pressed=true] .ico{color:var(--vp-accent)}
#record[aria-pressed=false] .ico{color:var(--vscode-errorForeground)}
table.acc{font-family:var(--vp-mono);font-size:12px}
table.acc th{position:sticky;top:0;background:var(--vp-bg);z-index:1;font-family:var(--vscode-font-family);padding-top:8px}
table.acc td{padding:3px 14px 3px 0}
td.seq,td.bytes,td.st{color:var(--vp-muted)}
.pill.R{color:var(--vp-bus);background:color-mix(in srgb,var(--vp-bus) 14%,transparent)}
.pill.W{color:var(--vp-memory);background:color-mix(in srgb,var(--vp-memory) 16%,transparent)}
.pill.S{color:var(--vp-irq);background:color-mix(in srgb,var(--vp-irq) 15%,transparent)}
tr.err td{color:var(--vscode-errorForeground)}
#rows tr.routable{cursor:pointer}#rows tr.routable:hover td{background:var(--vscode-list-hoverBackground)}#rows tr.sel td{background:color-mix(in srgb,var(--vp-route) 16%,transparent)}td.ini{color:var(--vp-muted)}
tr.hitrow td{background:var(--vscode-editor-findMatchHighlightBackground,rgba(234,92,0,.33))}
tbody tr:hover td{background:var(--vscode-list-hoverBackground)}
.empty{padding:24px 0;text-align:center}
.stat-value.R{color:var(--vp-bus)}.stat-value.W{color:var(--vp-memory)}.stat-value.S{color:var(--vp-irq)}
/* Narrow panels (the trace opens beside the editor): the header and figures stay on top; the settings
   go above the table with a height of their own, and only they and the table scroll. */
@media (max-width:760px){.tbody{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
  .side{max-height:34vh;border-right:0;border-bottom:1px solid var(--vp-border);padding:10px}
  .stats{grid-template-columns:repeat(auto-fit,minmax(96px,1fr))}.stat{padding:7px 12px}.stat-value{font-size:14px}.stat-sub{display:none}
  .head{padding:10px 14px}.desc{display:none}}
</style></head><body>
<div class="app">
<header class="head">
  <div class="ident">${ICON.pulse}<div class="ident-text">
    <div class="title-row"><h1>${esc(name)}</h1>${platform ? `<span class="tag mono">${esc(platform)}</span>` : ''}<span id="rstate" class="status idle" aria-live="polite"><span class="dot"></span><span id="rstate-t">Waiting for the simulation</span></span></div>
    <p class="desc">Bus accesses and signal changes seen by the probes; newest at the bottom.</p>
  </div></div>
  <div class="actions">
    <button id="record" class="toggle" aria-pressed="true" title="Record at the probes that are on; off pauses all of them and keeps which ones are on">${ICON.record}<span id="record-t">Recording</span></button>
    <button id="follow" class="toggle-soft" aria-pressed="true" title="Show new accesses as they arrive">${ICON.follow}Follow</button>
    <button id="clear" title="Drop the accesses recorded so far">${ICON.clear}Clear</button>
    <button id="export" title="The accesses kept here as a CSV file">${ICON.download}CSV…</button>
    <button id="vcd" title="Signal changes as a VCD file for a waveform viewer">${ICON.download}VCD…</button>
  </div>
</header>
<section class="stats" aria-label="Trace summary">
  <div class="stat"><div class="stat-label">Recorded</div><div class="stat-value" id="st-total">0</div><div class="stat-sub" id="st-total-s">accesses</div></div>
  <div class="stat"><div class="stat-label">Shown</div><div class="stat-value" id="st-shown">0</div><div class="stat-sub" id="st-shown-s">of 0 kept here</div></div>
  <div class="stat"><div class="stat-label">Reads</div><div class="stat-value R" id="st-r">0</div><div class="stat-sub">kept here</div></div>
  <div class="stat"><div class="stat-label">Writes</div><div class="stat-value W" id="st-w">0</div><div class="stat-sub">kept here</div></div>
  <div class="stat"><div class="stat-label">Signal changes</div><div class="stat-value S" id="st-s">0</div><div class="stat-sub">kept here</div></div>
  <div class="stat"><div class="stat-label">Probes</div><div class="stat-value" id="st-probes">–</div><div class="stat-sub">recording</div></div>
  <div class="stat"><div class="stat-label">Breakpoints</div><div class="stat-value" id="st-bp">0</div><div class="stat-sub">set</div></div>
</section>
<div class="banner stop" id="hit" hidden><span><span id="hittext" aria-live="assertive"></span> <span class="hit-note">The simulation stays paused here until you press Continue, also after the breakpoint is removed.</span></span><button id="hitcont" class="primary">${ICON.play}Continue</button></div>
<div class="tbody">
<aside class="side" aria-label="Trace settings">
  <section class="card" role="group" aria-label="Probes">
    <div class="card-h" title="Every bus-mapped port and signal has a probe; only those turned on record">Probes<span class="grow"></span><button id="pchoose" class="tinted" title="Choose which probes record; applies at once, without a restart">${ICON.list}Choose…</button></div>
    <p id="psum" class="muted" aria-live="polite">…</p>
    <div class="chips" id="plist" aria-label="Probes recording"></div>
  </section>
  <section class="card" role="group" aria-label="Filter the table">
    <div class="card-h" title="Filters which accesses the table shows; it does not stop the simulation">Filter</div>
    <label class="field">Point<select id="point" aria-label="Trace point"><option value="">all</option></select></label>
    <div class="row2">
      <label class="field">Access<select id="dir" aria-label="Read or write"><option value="">all</option><option value="R">read</option><option value="W">write</option><option value="S">signal</option></select></label>
      <label class="field">Address<input id="addr" type="text" spellcheck="false" placeholder="0x1000 or 0x1000-0x1fff" aria-label="Show only accesses to this address or address range"></label>
    </div>
  </section>
  <section class="card" role="group" aria-label="Breakpoints">
    <div class="card-h" title="Pause the simulation when an access matches">Break on</div>
    <label class="field">Point<select id="bpoint" aria-label="Trace point of the breakpoint"><option value="">any point</option></select></label>
    <div class="row2">
      <label class="field">Access<select id="baccess" aria-label="Access of the breakpoint"><option value="w">write</option><option value="r">read</option><option value="rw">read or write</option></select></label>
      <label class="field">Address<input id="baddr" type="text" spellcheck="false" placeholder="0x10000000 or a range" aria-label="Breakpoint address or address range"></label>
    </div>
    <div class="row2">
      <label class="field">Value<input id="bval" type="text" spellcheck="false" placeholder="optional, 0x0a" aria-label="Breakpoint data value" title="Optional: stop only when the data written or read equals this value (data read as a little-endian number)"></label>
      <label class="field">Mask<input id="bmask" type="text" spellcheck="false" placeholder="optional, 0xff" aria-label="Breakpoint data mask" title="Optional: which bits of the data to compare: (data &amp; mask) == (value &amp; mask). Empty compares the whole value"></label>
    </div>
    <div><button id="badd" class="tinted">${ICON.add}Add breakpoint</button></div>
    <span id="berr" class="err-text" role="alert"></span>
    <div class="chips" id="bps" aria-label="Breakpoints set"></div>
  </section>
</aside>
<main class="tmain" id="tmain">
  <p class="muted" id="summary" aria-live="polite">Waiting for the simulation…</p>
  <table class="acc" aria-label="Bus accesses"><thead><tr><th class="num">#</th><th class="num">Time (s)</th><th>Point</th><th title="Who issued the access (sim agent 0.12.0 and later)">Initiator</th><th>Access</th><th>Address</th><th class="num">Size</th><th>Value</th><th>Bytes</th><th>Status</th></tr></thead>
  <tbody id="rows"></tbody></table>
  <p class="muted empty" id="empty">No accesses yet.</p>
</main>
</div>
</div>
<script nonce="${nonce}">
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
const post = (m) => { if (vscode) vscode.postMessage(m); };
const SHOW = 1000;          // rows shown at most
const KEEP = 100000;        // records kept in the page
let sigPoints = new Set(); // points that are signals: no bus breakpoints there
let all = [], points = [], follow = true, dropped = 0, total = 0, frozen = null, hitSeq = 0, ended = false, recording = true, seen = false, stopped = false;
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');
function parseAddr(s) {
  s = s.trim(); if (!s) return null;
  const m = /^(0x[0-9a-f]+|\\d+)(?:\\s*-\\s*(0x[0-9a-f]+|\\d+))?$/i.exec(s.replace(/_/g, ''));
  if (!m) return undefined;
  const lo = BigInt(m[1]); const hi = m[2] ? BigInt(m[2]) : lo;
  return [lo, hi];
}
function matches(r, f) {
  if (f.point && r.point !== f.point) return false;
  if (f.dir && r.dir !== f.dir) return false;
  if (f.range) { if (r.dir === 'S') return false; const a = BigInt(r.address); const end = a + BigInt(Math.max(r.length, 1) - 1); if (end < f.range[0] || a > f.range[1]) return false; }
  return true;
}
function setState() {
  const st = $('rstate');
  const live = seen && !ended && recording && !stopped;
  st.className = 'status ' + (stopped && !ended ? 'bad' : live ? 'live' : 'idle');
  $('rstate-t').textContent = ended ? 'Not connected' : stopped ? 'Paused at breakpoint' : !seen ? 'Waiting for the simulation' : recording ? 'Recording' : 'Recording paused';
  $('record').setAttribute('aria-pressed', String(recording));
  $('record-t').textContent = recording ? 'Recording' : 'Record';
}
const scroller = () => $('tmain'); // the table scrolls; the header and the figures never leave the top
function draw() {
  const range = parseAddr($('addr').value);
  $('addr').setAttribute('aria-invalid', range === undefined ? 'true' : 'false');
  const f = { point: $('point').value, dir: $('dir').value, range: range || null };
  const src = frozen || all;
  const hits = [];
  for (let i = src.length - 1; i >= 0 && hits.length < SHOW; i--) if (matches(src[i], f)) hits.push(src[i]);
  hits.reverse();
  const tb = $('rows');
  tb.textContent = '';
  const frag = document.createDocumentFragment();
  for (const r of hits) {
    const tr = document.createElement('tr');
    tr.className = r.dir + (r.status !== 'OK' ? ' err' : '') + (hitSeq && r.seq === hitSeq ? ' hitrow' : '') + (r.dir !== 'S' ? ' routable' : '') + (r.seq === routeSeq ? ' sel' : '');
    tr.dataset.seq = r.seq;
    if (r.dir !== 'S') { tr.tabIndex = 0; tr.title = 'Click to show the route of this access in the platform view'; }
    const access = r.dir === 'S' ? (r.value === '1' ? 'signal ↑' : 'signal ↓') : r.dir === 'W' ? 'write' : 'read';
    const cells = [[r.seq, 'num seq'], [r.time.toFixed(9), 'num'], [r.point, ''], [r.dir === 'S' ? '' : r.initiator || '–', 'ini'], [null, 'dir'], [r.address, ''], [r.dir === 'S' ? '' : r.length, 'num'], [r.value || '', ''], [r.dir === 'S' ? '' : r.data, 'bytes'], [r.status, r.status === 'OK' ? 'st' : '']];
    for (const [t, c] of cells) {
      const td = document.createElement('td'); if (c) td.className = c;
      if (t === null) { const p = document.createElement('span'); p.className = 'pill ' + r.dir; p.textContent = access; td.appendChild(p); } else td.textContent = t;
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  tb.appendChild(frag);
  $('empty').hidden = hits.length > 0;
  $('empty').textContent = src.length ? 'No access matches the filter.' : probesKnown && !probesOn ? 'No probe is recording. Choose… on the left turns probes on.' : 'No accesses yet.';
  let nr = 0, nw = 0, ns = 0;
  for (const r of all) { if (r.dir === 'R') nr++; else if (r.dir === 'W') nw++; else ns++; }
  $('st-total').textContent = fmt(total);
  $('st-total-s').textContent = dropped ? fmt(dropped) + ' oldest dropped' : 'accesses';
  $('st-shown').textContent = fmt(hits.length);
  $('st-shown-s').textContent = 'of ' + fmt(all.length) + ' kept here';
  $('st-r').textContent = fmt(nr); $('st-w').textContent = fmt(nw); $('st-s').textContent = fmt(ns);
  const shown = hits.length === SHOW ? 'the newest ' + SHOW + ' matching' : hits.length + ' matching';
  $('summary').textContent = 'Showing ' + shown + '.' + (frozen ? ' Follow is off: new accesses are kept but not shown.' : '') + (ended ? ' The simulation is no longer connected.' : '');
  if (follow && !frozen) { const sc = scroller(); sc.scrollTop = sc.scrollHeight; }
}
function setPoints(list) {
  const sel = $('point'); const cur = sel.value;
  if (list.join('\\n') === points.join('\\n')) return;
  points = list.slice();
  sel.length = 1;
  for (const p of points) { const o = document.createElement('option'); o.value = p; o.textContent = p; sel.appendChild(o); }
  sel.value = points.includes(cur) ? cur : '';
  const bsel = $('bpoint'); const bcur = bsel.value;
  bsel.length = 1;
  const busPoints = points.filter((p) => !sigPoints.has(p));
  for (const p of busPoints) { const o = document.createElement('option'); o.value = p; o.textContent = p; bsel.appendChild(o); }
  // With a single bus trace point, that is the one a breakpoint is for.
  bsel.value = busPoints.includes(bcur) ? bcur : busPoints.length === 1 ? busPoints[0] : '';
}
function setBreakpoints(list) {
  const box = $('bps'); box.textContent = '';
  $('st-bp').textContent = String(list.length);
  for (const b of list) {
    const c = document.createElement('span'); c.className = 'chip' + (b.active ? '' : ' off');
    c.appendChild(document.createTextNode(b.label + (b.active ? '' : ' (not traced in this run)')));
    const x = document.createElement('button'); x.textContent = '✕'; x.title = 'Remove breakpoint #' + b.id; x.setAttribute('aria-label', 'Remove breakpoint #' + b.id);
    x.addEventListener('click', () => post({ type: 'removeBreak', id: b.id }));
    c.appendChild(x); box.appendChild(c);
  }
}
let probesKnown = false, probesOn = 0;
function setProbes(m) {
  const list = m.list || [];
  const on = list.filter((p) => p.recording);
  probesKnown = list.length > 0; probesOn = on.length; seen = true; setState(); schedule();
  let newSig = false;
  for (const p of list) if (p.kind === 'signal' && !sigPoints.has(p.name)) { sigPoints.add(p.name); newSig = true; }
  if (newSig) { const keep = points; points = []; setPoints(keep); }
  $('pchoose').disabled = !m.choose;
  $('st-probes').textContent = list.length ? on.length + ' / ' + list.length : '–';
  $('psum').textContent = m.hint ? m.hint : !list.length ? 'None in this simulation.' :
    on.length ? on.length + ' of ' + list.length + ' recording:' : 'None of ' + list.length + ' recording. Choose the lines to watch.';
  const box = $('plist'); box.textContent = '';
  for (const p of on) {
    const c = document.createElement('span'); c.className = 'chip';
    c.appendChild(document.createTextNode(p.name + ' '));
    const k = document.createElement('span'); k.className = 'kind'; k.textContent = p.kind; c.appendChild(k);
    if (m.choose) {
      const x = document.createElement('button'); x.textContent = '✕'; x.title = 'Stop recording at ' + p.name; x.setAttribute('aria-label', 'Stop recording at ' + p.name);
      x.addEventListener('click', () => post({ type: 'stopProbe', name: p.name }));
      c.appendChild(x);
    }
    box.appendChild(c);
  }
}
// A bus access clicked in the table: the platform view shows its route.
let routeSeq = 0;
function showRoute(tr) {
  const seq = Number(tr.dataset.seq); const src = frozen || all;
  let r = null; for (let i = src.length - 1; i >= 0; i--) if (src[i].seq === seq) { r = src[i]; break; }
  if (!r || r.dir === 'S') return;
  routeSeq = seq; document.querySelectorAll('#rows tr.sel').forEach((x) => x.classList.remove('sel')); tr.classList.add('sel');
  post({ type: 'showRoute', point: r.point, initiator: r.initiator || '', dir: r.dir, address: r.address, length: r.length, value: r.value || '', time: r.time, seq: r.seq });
}
$('rows').addEventListener('click', (e) => { const tr = e.target.closest('tr.routable'); if (tr) showRoute(tr); });
$('rows').addEventListener('keydown', (e) => { const tr = e.target.closest('tr.routable'); if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showRoute(tr); } });
let pending = false;
const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; draw(); }); } };
window.addEventListener('message', (ev) => {
  const m = ev.data || {};
  if (m.type === 'records') {
    seen = true; setState();
    let newSig = false;
    for (const r of m.records || []) { all.push(r); if (r.dir === 'S' && !sigPoints.has(r.point)) { sigPoints.add(r.point); newSig = true; } }
    if (newSig) points = []; // rebuild the lists
    if (m.points) setPoints(m.points);
    if (all.length > KEEP) all = all.slice(all.length - KEEP);
    if (m.status) { total = m.status.lastSeq; dropped = m.status.dropped; }
    schedule();
  } else if (m.type === 'cleared') { all = []; frozen = null; total = 0; dropped = 0; schedule(); }
  else if (m.type === 'probes') setProbes(m);
  else if (m.type === 'recording') { recording = !!m.enabled; seen = true; setState(); }
  else if (m.type === 'ended') { ended = true; setState(); schedule(); }
  else if (m.type === 'breakpoints') { setBreakpoints(m.list || []); $('berr').textContent = m.error || ''; if (!m.error && m.added) { $('baddr').value = ''; $('bval').value = ''; $('bmask').value = ''; } }
  else if (m.type === 'hit') {
    $('hit').hidden = !m.text; $('hittext').textContent = m.text || '';
    stopped = !!m.text; setState();
    hitSeq = m.text ? (m.seq || 0) : 0;
    if (m.text && hitSeq && follow) { follow = false; $('follow').setAttribute('aria-pressed', 'false'); frozen = null; }
    schedule();
    if (m.text && hitSeq) requestAnimationFrame(() => { const row = document.querySelector('tr.hitrow'); if (row) row.scrollIntoView({ block: 'center' }); });
  }
});
$('follow').addEventListener('click', () => {
  follow = !follow; $('follow').setAttribute('aria-pressed', String(follow));
  frozen = follow ? null : all.slice(); draw();
});
$('record').addEventListener('click', () => post({ type: 'setRecording', enabled: $('record').getAttribute('aria-pressed') !== 'true' }));
$('clear').addEventListener('click', () => post({ type: 'clear' }));
$('pchoose').addEventListener('click', () => post({ type: 'chooseProbes' }));
$('export').addEventListener('click', () => post({ type: 'export' }));
$('vcd').addEventListener('click', () => post({ type: 'exportVcd' }));
$('badd').addEventListener('click', () => {
  // The address typed in the filter (which only filters the table) is the usual slip.
  if (!$('baddr').value.trim() && $('addr').value.trim()) {
    $('berr').textContent = 'The address ' + $('addr').value.trim() + ' is in Filter, which only filters the table. Put it in the Address box under Break on.';
    $('baddr').focus();
    return;
  }
  post({ type: 'addBreak', point: $('bpoint').value, access: $('baccess').value, address: $('baddr').value, value: $('bval').value, mask: $('bmask').value });
});
for (const id of ['baddr', 'bval', 'bmask']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('badd').click(); });
$('hitcont').addEventListener('click', () => post({ type: 'continue' }));
for (const id of ['point', 'dir']) $(id).addEventListener('change', draw);
$('addr').addEventListener('input', draw);
post({ type: 'ready' });
</script></body></html>`;
}

module.exports = { render };
