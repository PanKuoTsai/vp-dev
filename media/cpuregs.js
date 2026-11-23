const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
const post = (m) => { if (vscode) vscode.postMessage(m); };
const $ = (id) => document.getElementById(id);
const S = Object.assign({ open: {}, filter: {} }, (vscode && vscode.getState()) || {});
const save = () => { if (vscode) vscode.setState(S); };
let last = null;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const ADDR = (v) => { const s = String(v || '').trim(); return /^0x[0-9a-fA-F]+$/.test(s) && s.replace(/^0x0*/, '').length > 3; };
function memBtn(r) {
  const b = el('button', 'mem', 'mem'); b.title = `Show memory at ${r.value} (${r.name})`; b.setAttribute('aria-label', b.title);
  b.addEventListener('click', (e) => { e.stopPropagation(); post({ type: 'memory', value: r.value }); });
  return b;
}
function copy(text) { post({ type: 'copy', text }); const t = $('toast'); t.hidden = false; clearTimeout(copy.t); copy.t = setTimeout(() => { t.hidden = true; }, 900); }
function fill(group) {
  const tb = $('t-' + group); tb.textContent = '';
  const q = (S.filter[group] || '').trim().toLowerCase();
  const list = (last ? last.regs : []).filter((r) => r.group === group);
  let changed = 0;
  for (const r of list) {
    if (r.changed) changed++;
    if (q && !r.name.toLowerCase().includes(q)) continue;
    const tr = el('tr', r.changed ? 'changed' : '');
    tr.append(el('td', 'n', r.name));
    const v = el('td', 'val', r.value); v.title = 'Click to copy'; v.addEventListener('click', () => copy(r.value)); tr.append(v);
    const mc = el('td', 'm'); if (group === 'general' && ADDR(r.value)) mc.append(memBtn(r)); tr.append(mc);
    tb.appendChild(tr);
  }
  $('n-' + group).textContent = String(list.length);
  $('ch-' + group).textContent = changed ? changed + ' changed' : '';
}
function draw(m) {
  last = m;
  const st = $('state');
  $('cpu').textContent = m.thread ? m.thread.name : 'No CPU';
  st.className = 'status ' + (m.state === 'stopped' ? 'bad' : m.state === 'running' ? 'live' : 'idle');
  $('state-t').textContent = m.state === 'stopped' ? 'paused' : m.state === 'running' ? 'running' : 'not debugging';
  const has = m.regs && m.regs.length;
  $('msg').hidden = !!(has && !m.error && m.state === 'stopped');
  $('msg').textContent = m.error ? m.error : m.state === 'running' ? (has ? 'Running: these are the values from the last stop. Pause to read them again.' : 'Pause the target in the debugger to read the registers.') :
    m.state === 'none' ? 'Attach the debugger to the target ("VP: attach to target software") and pause it to see the CPU\'s registers.' : 'Reading…';
  $('body').hidden = !has;
  $('body').classList.toggle('dim', m.state !== 'stopped');
  if (!has) return;
  const by = new Map(m.regs.map((r) => [r.name, r]));
  const keys = $('keys'); keys.textContent = '';
  const p = m.pstate;
  for (const [k, name] of [['PC', 'pc'], ['SP', 'sp'], ['LR (x30)', 'x30'], ['Mode', null]]) {
    const r = name ? by.get(name) : null;
    const box = el('div', 'key' + (r && r.changed ? ' changed' : ''));
    box.append(el('div', 'k', k), el('div', 'v', name ? (r ? r.value : '–') : (p ? p.mode : '–')));
    if (r) {
      box.title = 'Click to copy'; box.addEventListener('click', () => copy(r.value));
      if (name === 'pc') {
        const d = el('button', 'mem', 'dis'); d.title = 'Show disassembly at the PC'; d.setAttribute('aria-label', d.title);
        d.addEventListener('click', (e) => { e.stopPropagation(); post({ type: 'disassembly' }); });
        box.append(d);
      }
      if (ADDR(r.value)) {
        box.append(memBtn(r));
        const t = el('button', 'mem', 'pa'); t.title = `Translate ${r.value} (${r.name}) to a physical address`; t.setAttribute('aria-label', t.title);
        t.addEventListener('click', (e) => { e.stopPropagation(); post({ type: 'translate', value: r.value }); });
        box.append(t);
      }
    }
    keys.appendChild(box);
  }
  const fl = $('flags'); fl.textContent = '';
  if (p) {
    fl.append(el('span', 'lbl', 'PSTATE'));
    for (const f of ['n', 'z', 'c', 'v']) { const e = el('span', 'flag' + (p[f] ? ' on' : ''), f.toUpperCase()); e.title = { n: 'Negative', z: 'Zero', c: 'Carry', v: 'Overflow' }[f] + (p[f] ? ' set' : ' clear'); fl.append(e); }
    fl.append(el('span', 'sep'));
    for (const f of ['d', 'a', 'i', 'f']) { const e = el('span', 'flag mask' + (p[f] ? ' on' : ''), f.toUpperCase()); e.title = { d: 'Debug', a: 'SError', i: 'IRQ', f: 'FIQ' }[f] + (p[f] ? ' masked' : ' not masked'); fl.append(e); }
  }
  for (const g of ['general', 'fp', 'system']) fill(g);
}
for (const g of ['general', 'fp', 'system']) {
  const d = $('g-' + g);
  if (S.open[g] !== undefined) d.open = S.open[g];
  d.addEventListener('toggle', () => { S.open[g] = d.open; save(); });
}
document.querySelectorAll('.filter').forEach((f) => { f.value = S.filter[f.dataset.group] || ''; f.addEventListener('input', () => { S.filter[f.dataset.group] = f.value; save(); fill(f.dataset.group); }); });
$('refresh').addEventListener('click', () => post({ type: 'refresh' }));
window.addEventListener('message', (ev) => { const m = ev.data || {}; if (m.type === 'regs') draw(m); });
post({ type: 'ready' });
