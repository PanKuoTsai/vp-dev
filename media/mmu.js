const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
const post = (m) => { if (vscode) vscode.postMessage(m); };
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const S = Object.assign({ hist: [] }, (vscode && vscode.getState()) || {});
const save = () => { if (vscode) vscode.setState(S); };
let last = null;

function remember(expr) {
  if (!expr) return;
  S.hist = [expr].concat(S.hist.filter((h) => h !== expr)).slice(0, 8);
  save();
  drawHist();
}

function drawHist() {
  const h = $('hist');
  h.textContent = '';
  for (const x of S.hist) {
    const c = el('span', 'chip h', x);
    c.title = 'Translate ' + x;
    c.tabIndex = 0;
    const go = () => { $('expr').value = x; submit(); };
    c.addEventListener('click', go);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    h.append(c);
  }
  h.parentElement.classList.toggle('none', !S.hist.length);
}

function submit() {
  const expr = $('expr').value.trim();
  if (!expr) return;
  remember(expr);
  $('go').disabled = true;
  post({ type: 'translate', expr });
}

function setState(cpu) {
  const st = $('cstate');
  const t = $('cstate-t');
  if (!cpu || cpu.state === 'none') { st.className = 'status idle'; t.textContent = 'No debug session'; return; }
  if (cpu.state === 'running') { st.className = 'status live'; t.textContent = 'Running: pause to translate'; return; }
  st.className = 'status good';
  t.textContent = cpu.name ? `Stopped · ${cpu.name}` : 'Stopped';
}

const set = (id, text, cls) => { const e = $(id); e.textContent = text === undefined || text === null || text === '' ? '–' : text; if (cls !== undefined) e.className = cls; };

function drawBar(r) {
  const bar = $('bar');
  bar.textContent = '';
  if (!r.fields || !r.fields.length) return;
  const failed = r.fault ? r.fault.level : -1;
  for (const f of r.fields) {
    const n = f.hi - f.lo + 1;
    const kind = f.level !== undefined ? 'idx' : f.name === 'page offset' ? 'off' : f.name.startsWith('tag') ? 'tag' : 'sel';
    const s = el('div', `seg b${Math.min(n, 64)} ${kind}${f.level !== undefined && f.level === failed ? ' fault' : ''}`);
    s.append(el('span', 'nm', f.name), el('span', 'val', f.level !== undefined ? String(f.value) : '0x' + f.value.toString(16)), el('span', 'rng', f.hi === f.lo ? `[${f.hi}]` : `[${f.hi}:${f.lo}]`));
    s.title = `${f.name}: bits ${f.hi}..${f.lo} = ${f.value} (0x${f.value.toString(16)})`;
    bar.append(s);
  }
}

function drawSteps(r) {
  const tb = $('steps');
  tb.textContent = '';
  $('walk').hidden = !r.steps.length;
  for (const s of r.steps) {
    const tr = el('tr');
    tr.append(el('td', 'lv', 'L' + s.level), el('td', '', s.table), el('td', 'num', String(s.index)), el('td', '', s.address), el('td', '', s.desc || '?'));
    const ty = el('td', 'ty');
    ty.append(el('span', 't ' + (s.type || 'unread'), s.type || 'not read'));
    tr.append(ty, el('td', '', s.next || s.output || ''));
    const fl = el('td', 'fl');
    for (const f of s.flags) fl.append(el('span', '', f));
    tr.append(fl);
    tr.title = 'Click to copy the descriptor';
    tr.addEventListener('click', () => post({ type: 'copy', text: `L${s.level} [${s.index}] @ ${s.address} = ${s.desc || '?'} ${s.type || ''}` }));
    tb.append(tr);
  }
}

function draw(m) {
  setState(m.cpu);
  $('go').disabled = false;
  if (m.expr !== undefined && document.activeElement !== $('expr') && !$('expr').value) $('expr').value = m.expr;
  const warn = $('warn');
  warn.hidden = !m.error;
  warn.textContent = m.error || '';
  if (m.error) return;
  if (!m.result) return;
  const r = m.result;
  last = r;
  $('empty').hidden = true;
  set('st-pa', r.pa, 'stat-value mono' + (r.fault && !r.pa ? ' bad' : ''));
  if (!r.pa && r.fault) $('st-pa').textContent = 'fault';
  set('st-where', r.where ? `${r.where.instance} + ${r.where.offset}` : r.pa ? 'not in the platform\'s memory map' : '');
  if (!r.mmu) { set('st-map', 'MMU off'); set('st-map-s', 'PA = VA'); }
  else if (r.kind) { set('st-map', `${r.size} ${r.kind}`); set('st-map-s', `L${r.steps[r.steps.length - 1].level} · TTBR${r.ttbr} · ASID ${r.asid}`); }
  else { set('st-map', 'not mapped'); set('st-map-s', `TTBR${r.ttbr} · ${r.granule || ''} granule`); }
  set('st-el1', r.perms ? r.perms.el1 : '', 'stat-value mono rwx');
  set('st-el0', r.perms ? r.perms.el0 : '', 'stat-value mono rwx');
  set('st-attr', r.attr ? r.attr.text : '');
  $('st-attr').title = r.attr ? r.attr.text : '';
  set('st-attr-s', r.attr && r.attr.index !== undefined ? `MAIR[${r.attr.index}] = 0x${r.attr.byte.toString(16).padStart(2, '0')}${r.shareability ? ' · ' + r.shareability : ''}` : r.shareability || '');
  const f = $('fault');
  f.hidden = !r.fault;
  if (r.fault) {
    $('fault-k').textContent = `${r.fault.kind[0].toUpperCase()}${r.fault.kind.slice(1)} fault, level ${r.fault.level}:`;
    $('fault-t').textContent = r.fault.text;
    $('fault-h').textContent = r.hint || '';
  }
  $('tools').hidden = false;
  $('reg').hidden = !(r.where && r.attr && r.attr.device);
  $('ctx').textContent = `${r.va}${r.mmu ? ` · ${r.inputBits}-bit VA, ${r.granule} granule, TTBR${r.ttbr} = ${r.ttbrValue}` : ''}${m.reader ? ` · descriptors read with the ${m.reader}` : ''}`;
  drawBar(r);
  drawSteps(r);
  const notes = $('notes');
  notes.textContent = '';
  for (const n of (r.notes || []).concat(r.perms ? r.perms.notes : [])) notes.append(el('li', '', n));
}

$('form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
$('mem').addEventListener('click', () => { if (last) post({ type: 'memory', va: last.va.replace(/_/g, '') }); });
$('reg').addEventListener('click', () => { if (last && last.pa) post({ type: 'register', pa: last.pa }); });
$('copy').addEventListener('click', () => { if (last) post({ type: 'copy', text: last.text }); });
window.addEventListener('message', (e) => { const m = e.data; if (m && m.type === 'mmu') draw(m); });
drawHist();
post({ type: 'ready' });
