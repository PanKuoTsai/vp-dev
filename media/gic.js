const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
const post = (m) => { if (vscode) vscode.postMessage(m); };
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const S = Object.assign({ show: 'used', cpu: '', q: '' }, (vscode && vscode.getState()) || {});
const save = () => { if (vscode) vscode.setState(S); };
let last = null;

const hasProblem = (r) => r.problems.some((p) => p.level !== 'info');
function visible(r) {
  if (S.cpu !== '' && r.cpu !== undefined && String(r.cpu) !== S.cpu) return false;
  if (S.show === 'used' && !r.interesting) return false;
  if (S.show === 'problems' && !hasProblem(r)) return false;
  if (S.show === 'pa' && !r.pending && !r.active) return false;
  const q = S.q.trim().toLowerCase();
  if (q && !(String(r.intid) === q || r.sources.some((s) => (s.module + '.' + s.port).toLowerCase().includes(q)))) return false;
  return true;
}

function flag(on, cls, letter, title) { const f = el('span', 'flag ' + cls + (on ? ' on' : ''), letter); f.title = title + (on ? '' : ' (no)'); return f; }

function rowFor(r) {
  const tr = el('tr');
  tr.append(el('td', 'id', String(r.intid)));
  tr.append(el('td', 'kind', r.kind + (r.cpu !== undefined ? ` · cpu ${r.cpu}` : '')));
  const src = el('td', 'src');
  if (r.sources.length) {
    src.append(document.createTextNode(`${r.sources[0].module}.${r.sources[0].port}`));
    if (r.sources.length > 1) src.append(el('span', 'more', ` +${r.sources.length - 1}`));
  } else src.append(el('span', 'more', '–'));
  tr.append(src);
  const st = el('td', 'st');
  st.append(flag(r.enabled, 'e', 'E', 'Enabled'), flag(r.pending, 'p', 'P', 'Pending'), flag(r.active, 'a', 'A', 'Active'));
  tr.append(st);
  tr.append(el('td', 'pr', '0x' + r.priority.toString(16).padStart(2, '0')), el('td', '', r.edge ? 'edge' : 'level'), el('td', '', r.group), el('td', '', r.route ? r.route.text : '–'));
  const notes = el('td', 'notes');
  for (const p of r.problems) notes.append(el('span', 'note ' + p.level, p.text));
  tr.append(notes);
  tr.title = 'Click to copy';
  tr.addEventListener('click', () => post({ type: 'copy', text: `INTID ${r.intid} ${r.kind}${r.cpu !== undefined ? ` cpu ${r.cpu}` : ''} ${r.sources.map((s) => s.module + '.' + s.port).join(', ') || '-'} enabled=${r.enabled} pending=${r.pending} active=${r.active} priority=0x${r.priority.toString(16)} ${r.edge ? 'edge' : 'level'} ${r.group} -> ${r.route ? r.route.text : '-'}${r.problems.length ? ' | ' + r.problems.map((p) => p.text).join('; ') : ''}` }));
  return tr;
}

function draw() {
  if (!last || !last.rows) return;
  const tb = $('rows'); tb.textContent = '';
  const list = last.rows.filter(visible);
  const frag = document.createDocumentFragment();
  for (const r of list) frag.appendChild(rowFor(r));
  tb.appendChild(frag);
  $('empty').hidden = list.length > 0;
  $('count').textContent = `${list.length} of ${last.rows.length}`;
}

window.addEventListener('message', (ev) => {
  const m = ev.data || {};
  if (m.type !== 'gic') return;
  $('live').setAttribute('aria-pressed', String(!!m.live));
  $('warn').hidden = !m.problem;
  $('warn').textContent = m.problem || '';
  const st = $('gstate');
  if (m.problem) { st.className = 'status idle'; $('gstate-t').textContent = 'Not available'; return; }
  last = m;
  st.className = 'status ' + (m.running ? 'live' : 'idle');
  $('gstate-t').textContent = (m.running ? 'Read while running' : 'Read while stopped') + (m.at ? ` at ${m.at}` : '');
  const d = m.dist;
  $('st-dist').textContent = `G1 ${d.grp1 ? 'on' : 'off'}${d.grp0 ? ' · G0 on' : ''}`;
  $('st-dist').className = 'stat-value' + (d.grp1 || d.grp0 ? '' : ' bad');
  $('st-dist-s').textContent = `${m.gic} · ${d.lines} INTIDs · ARE ${d.are ? 'on' : 'off'}${d.ds ? ' · one security state' : ''}`;
  $('st-wired').textContent = String(m.summary.wired);
  $('st-en').textContent = String(m.summary.enabled);
  $('st-pa').textContent = `${m.summary.pending} / ${m.summary.active}`;
  $('st-at').textContent = m.at ? `at ${m.at}` : '';
  $('st-prob').textContent = String(m.summary.problems);
  $('st-prob').className = 'stat-value' + (m.summary.problems ? ' bad' : '');
  const cpus = $('cpus'); cpus.textContent = '';
  for (const c of m.cpus) {
    const chip = el('span', 'cpu-chip' + (c.asleep ? ' asleep' : ''));
    chip.append(document.createTextNode(`CPU ${c.cpu}`), el('span', 'aff', c.affinity), document.createTextNode(c.asleep ? 'asleep' : 'awake'));
    chip.title = `Redistributor ${c.index}, affinity ${c.affinity}; GICR_WAKER ${c.asleep ? 'ChildrenAsleep: it forwards nothing to this CPU' : 'awake'}`;
    cpus.appendChild(chip);
  }
  const sel = $('cpu');
  const want = m.cpus.map((c) => String(c.cpu));
  if (want.join(',') !== [...sel.options].slice(1).map((o) => o.value).join(',')) {
    sel.length = 1;
    for (const c of want) { const o = document.createElement('option'); o.value = c; o.textContent = 'cpu ' + c; sel.appendChild(o); }
  }
  sel.value = want.includes(S.cpu) ? S.cpu : '';
  draw();
});

$('show').value = S.show;
$('show').addEventListener('change', () => { S.show = $('show').value; save(); draw(); });
$('cpu').addEventListener('change', () => { S.cpu = $('cpu').value; save(); draw(); });
$('q').value = S.q;
$('q').addEventListener('input', () => { S.q = $('q').value; save(); draw(); });
$('refresh').addEventListener('click', () => post({ type: 'refresh' }));
$('live').addEventListener('click', () => post({ type: 'live', on: $('live').getAttribute('aria-pressed') !== 'true' }));
post({ type: 'ready' });
