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
  const m = /^(0x[0-9a-f]+|\d+)(?:\s*-\s*(0x[0-9a-f]+|\d+))?$/i.exec(s.replace(/_/g, ''));
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
let mark = { from: 0, to: 0 }; // accesses made between the previous stop and the last one (cross-probing)
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
    tr.className = r.dir + (r.status !== 'OK' ? ' err' : '') + (hitSeq && r.seq === hitSeq ? ' hitrow' : '') + (r.dir !== 'S' ? ' routable' : '') + (r.seq === routeSeq ? ' sel' : '') + (r.seq > mark.from && r.seq <= mark.to ? ' since' : '');
    if (r.seq > mark.from && r.seq <= mark.to) tr.title = 'Made since the previous stop';
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
  if (list.join('\n') === points.join('\n')) return;
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
  } else if (m.type === 'stopMark') {
    mark = { from: Number(m.from) || 0, to: Number(m.to) || 0 };
    const n = Math.max(0, mark.to - mark.from);
    $('sincenote').hidden = !mark.to;
    $('sincenote').textContent = n ? `${n} access${n === 1 ? '' : 'es'} since the previous stop (marked)` : 'No access since the previous stop';
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
