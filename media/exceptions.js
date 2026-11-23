const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
const post = (m) => { if (vscode) vscode.postMessage(m); };
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const S = Object.assign({ follow: true, kind: '', cpu: '' }, (vscode && vscode.getState()) || {});
const save = () => { if (vscode) vscode.setState(S); };
const MAX = 3000;
let events = [];
let hitSeq = 0;
let catchShown = '';
let lastCounts = [];

function rowFor(e) {
  const tr = el('tr', e.seq === hitSeq ? 'hitrow' : '');
  tr.append(el('td', 'seq num', String(e.seq)), el('td', 't', (e.timeNs / 1e9).toFixed(6)), el('td', 'cpu', String(e.cpu)));
  const k = el('td'); k.append(el('span', 'pill ' + e.kind, e.kind === 'sync' ? 'sync' : e.kind.toUpperCase())); tr.append(k);
  const what = el('td', 'what', e.kind === 'sync' ? e.title : e.group ? `vector: ${e.group}` : '');
  if (e.esr) what.title = `ESR ${e.esr}${e.far ? `  FAR ${e.far}` : ''}  ELR ${e.elr}`;
  tr.append(what, el('td', 'el', `EL${e.fromEl}→EL${e.toEl}`), el('td', 'pc', e.fromPc), el('td', 'vec', e.toPc));
  tr.title = 'Click to copy the event';
  tr.addEventListener('click', () => post({ type: 'copy', text: `#${e.seq} ${(e.timeNs / 1e9).toFixed(6)} s CPU ${e.cpu} ${e.title} EL${e.fromEl}->EL${e.toEl} from ${e.fromPc} vector ${e.toPc}${e.esr ? ` ESR ${e.esr}` : ''}${e.far ? ` FAR ${e.far}` : ''} ELR ${e.elr}` }));
  return tr;
}

const shown = (e) => (!S.kind || (S.kind === 'sync' ? e.kind === 'sync' : e.kind !== 'sync')) && (S.cpu === '' || String(e.cpu) === S.cpu);

function draw() {
  const tb = $('rows'); tb.textContent = '';
  const list = events.filter(shown);
  const frag = document.createDocumentFragment();
  for (const e of list.slice(-1000)) frag.appendChild(rowFor(e));
  tb.appendChild(frag);
  $('empty').hidden = list.length > 0;
  $('summary').textContent = events.length ? `${fmt(list.length)} of ${fmt(events.length)} kept here` + (list.length > 1000 ? ' (the newest 1,000 shown)' : '') : '';
  if (S.follow) { const m = document.querySelector('.tmain'); m.scrollTop = m.scrollHeight; }
}

function cpus() {
  const set = [...new Set(events.map((e) => e.cpu))].sort((a, b) => a - b).map(String);
  const sel = $('cpu');
  if (set.join(',') === [...sel.options].slice(1).map((o) => o.value).join(',')) return;
  sel.length = 1;
  for (const c of set) { const o = document.createElement('option'); o.value = c; o.textContent = 'cpu ' + c; sel.appendChild(o); }
  sel.value = set.includes(S.cpu) ? S.cpu : '';
}

function setCatch(c) {
  const key = JSON.stringify(c);
  if (key === catchShown) return;
  catchShown = key;
  document.querySelectorAll('.catch').forEach((b) => { b.checked = c.ids.includes(b.value); });
  $('origin').value = c.origin || 'any';
  if (document.activeElement !== $('syscalls')) $('syscalls').value = c.syscalls || '';
  $('syscalls').disabled = !c.ids.includes('svc');
  $('syserr').hidden = !c.error;
  $('syserr').textContent = c.error || '';
  note(c.ids.length);
}
function note(n) {
  $('catchnote').textContent = n ? 'The simulation pauses on the first match; the CPU that took it stops on the vector, before the handler runs.' : 'Nothing chosen: events are only recorded.';
}
function sendCatch() {
  const ids = [...document.querySelectorAll('.catch')].filter((b) => b.checked).map((b) => b.value);
  const c = { ids, origin: $('origin').value, syscalls: $('syscalls').value.trim() };
  $('syscalls').disabled = !ids.includes('svc');
  catchShown = '';
  note(ids.length);
  post(Object.assign({ type: 'catch' }, c));
}

window.addEventListener('message', (ev) => {
  const m = ev.data || {};
  if (m.type !== 'exc') return;
  if (m.catch) setCatch(m.catch);
  $('warn').hidden = !m.problem;
  $('warn').textContent = m.problem || '';
  if (m.reset) events = [];
  if (m.events && m.events.length) { events = events.concat(m.events); if (events.length > MAX) events = events.slice(-MAX); }
  const on = m.recording !== false;
  $('record').setAttribute('aria-pressed', String(on));
  $('record-t').textContent = on ? 'Recording' : 'Record';
  const counts = m.counts || lastCounts; lastCounts = counts;
  let sync = 0; let irq = 0;
  const tb = $('counts'); tb.textContent = '';
  for (const c of counts) {
    if (c.kind === 'sync') sync += c.count; else irq += c.count;
    const tr = el('tr'); tr.append(el('td', 'n', fmt(c.count)), el('td', '', c.label), el('td', 'code', c.code)); tb.appendChild(tr);
  }
  $('nocounts').hidden = counts.length > 0;
  $('st-total').textContent = fmt(m.total);
  $('st-sync').textContent = fmt(sync);
  $('st-irq').textContent = fmt(irq);
  $('st-hits').textContent = fmt(m.hits);
  const st = $('xstate');
  const hit = m.hit;
  st.className = 'status ' + (hit ? 'bad' : m.active && on && !m.paused ? 'live' : 'idle');
  $('xstate-t').textContent = hit ? 'Stopped on an exception' : m.problem && !m.active ? 'Not recording' : !m.active ? 'Waiting for the simulation' : m.paused ? 'Simulation paused' : on ? 'Recording' : 'Recording off';
  $('hit').hidden = !hit;
  if (hit) {
    hitSeq = hit.seq;
    $('hittext').textContent = `${hit.title}, EL${hit.fromEl} → EL${hit.toEl}, from ${hit.fromPc}; vector ${hit.toPc}${hit.esr ? `, ESR ${hit.esr}` : ''}.`;
    $('hitnote').textContent = m.debugging ? `CPU ${hit.cpu} stopped on the vector. In Call Stack, select CPU#${hit.cpu} to see it; Continue here or in the debugger.` : `CPU ${hit.cpu} stopped on the vector, before the handler; the others stopped where they were.`;
    $('hitdis').hidden = !m.debugging;
  } else hitSeq = 0;
  drawCalls(hit ? m.calls : null);
  cpus();
  draw();
});

document.querySelectorAll('.catch').forEach((b) => b.addEventListener('change', sendCatch));
$('origin').addEventListener('change', sendCatch);
$('syscalls').addEventListener('change', sendCatch);
$('record').addEventListener('click', () => post({ type: 'recording', on: $('record').getAttribute('aria-pressed') !== 'true' }));
$('follow').setAttribute('aria-pressed', String(S.follow));
$('follow').addEventListener('click', () => { S.follow = !S.follow; save(); $('follow').setAttribute('aria-pressed', String(S.follow)); draw(); });
$('clear').addEventListener('click', () => { events = []; draw(); post({ type: 'clear' }); });
let callsSeq = -1;
function drawCalls(c) {
  const box = $('calls');
  box.hidden = !c;
  if (!c) return;
  // A new catch: open when there are calls to show, closed when there is only the hint.
  if (hitSeq !== callsSeq) { callsSeq = hitSeq; box.open = !!(c.rows && c.rows.length); }
  const note = $('callnote');
  note.hidden = !c.note;
  note.textContent = c.note || '';
  $('callsub').textContent = c.rows ? `· CPU ${c.cpu}, the last ${c.rows.length} calls and returns${c.symbols ? '' : ' (no symbol file: addresses)'}${c.recording ? '' : ' · recording is off'}` : '';
  const chain = $('chain');
  chain.textContent = '';
  (c.open || []).forEach((n, i) => { if (i) chain.append(el('span', 'sep', '›')); chain.append(el('span', 'fn', n)); });
  chain.hidden = !(c.open && c.open.length);
  const ol = $('crows');
  ol.textContent = '';
  for (const r of c.rows || []) {
    const li = el('li', `${r.kind} d${Math.min(r.depth, 15)}`);
    const exc = r.kind === 'exception';
    li.append(el('span', 'ar', exc ? '⚡' : r.kind === 'call' ? '→' : '←'), el('span', 'nm', exc ? `exception entry (${r.name})` : r.name), el('span', 'ago', `${exc ? 'after' : r.kind === 'call' ? 'from' : 'to'} ${r.site} · ${r.insnsBefore.toLocaleString('en-US')} insns before`));
    ol.append(li);
  }
  if (box.open) ol.scrollTop = ol.scrollHeight;
}

$('hitcont').addEventListener('click', () => post({ type: 'continue' }));
$('hitdis').addEventListener('click', () => post({ type: 'disassembly' }));
$('kind').value = S.kind;
$('kind').addEventListener('change', () => { S.kind = $('kind').value; save(); draw(); });
$('cpu').addEventListener('change', () => { S.cpu = $('cpu').value; save(); draw(); });
post({ type: 'ready' });
