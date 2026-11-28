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
$('program').addEventListener('click', () => post({ type: 'chooseProgram' }));
post({ type: 'ready' });
