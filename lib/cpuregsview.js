'use strict';
// HTML of the CPU Registers view (in the Run and Debug side bar). The extension
// posts {type: 'regs', state, thread, regs, pstate, error}; the page shows the
// selected CPU's key registers, the decoded PSTATE, and every register by group
// with the ones that changed since the last stop marked. No VS Code dependency.

const { css, esc } = require('./webtheme');

function render(nonce, cspSource) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc('CPU Registers')}</title>
<style nonce="${nonce}">
${css}
body{background:var(--vp-panel);font-size:12.5px}
.wrap{padding:8px 10px 14px;display:flex;flex-direction:column;gap:10px}
.top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.top .cpu{font-family:var(--vp-mono);font-weight:600;font-size:13px}
.top .status{height:20px;font-size:11px}
.status.bad{border:1px solid currentColor}
.msg{color:var(--vp-muted);line-height:1.45;margin:0}
.keys{display:flex;flex-direction:column;gap:4px}
.key{background:var(--vp-bg);border:1px solid var(--vp-border);border-radius:6px;padding:4px 8px;min-width:0;cursor:pointer;display:flex;align-items:baseline;gap:8px}
.key .k{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--vp-muted);width:54px;flex:none}
.key .v{font-family:var(--vp-mono);font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.key.changed{border-color:var(--vp-memory)}.key.changed .v{color:var(--vp-memory)}
.flags{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.flag{font-family:var(--vp-mono);font-size:11px;width:22px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;border:1px solid var(--vp-border);color:var(--vp-muted)}
.flag.on{background:color-mix(in srgb,var(--vp-accent) 22%,transparent);border-color:var(--vp-accent);color:var(--vscode-foreground);font-weight:600}
.flag.mask.on{background:color-mix(in srgb,var(--vp-irq) 22%,transparent);border-color:var(--vp-irq)}
.flags .sep{width:8px}.flags .lbl{font-size:10.5px;color:var(--vp-muted);margin-right:2px}
details{border:1px solid var(--vp-border);border-radius:6px;background:var(--vp-bg)}
details>summary{cursor:pointer;padding:6px 8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--vp-muted);display:flex;align-items:center;gap:6px;list-style:none}
details>summary::-webkit-details-marker{display:none}details>summary::before{content:'▸'}details[open]>summary::before{content:'▾'}
details>summary .count{margin-left:auto}
.ch{color:var(--vp-memory);font-size:10.5px;text-transform:none;letter-spacing:0}
.filter{margin:0 8px 6px;width:calc(100% - 16px);height:24px}
table.regs{font-family:var(--vp-mono);font-size:12px}
table.regs td{padding:2px 8px;border-bottom:1px solid color-mix(in srgb,var(--vp-border) 60%,transparent)}
table.regs td.n{color:var(--vp-muted);width:1%}
table.regs td.val{cursor:pointer;white-space:normal;word-break:break-all}
table.regs tr.changed td.val{color:var(--vp-memory);font-weight:600}
table.regs tr.changed td.n::after{content:' ●';color:var(--vp-memory)}
table.regs tr:hover td{background:var(--vscode-list-hoverBackground)}
.dim{opacity:.55}
.toast{position:fixed;bottom:8px;left:50%;transform:translateX(-50%);background:var(--vp-card);border:1px solid var(--vp-border);border-radius:5px;padding:3px 10px;font-size:11.5px}
.toast[hidden]{display:none}
</style></head><body>
<div class="wrap" id="wrap">
  <div class="top"><span class="cpu" id="cpu">No CPU</span><span id="state" class="status idle"><span class="dot"></span><span id="state-t">not debugging</span></span>
    <button id="refresh" title="Read the registers again" aria-label="Read the registers again">↻</button></div>
  <p class="msg" id="msg">Attach the debugger to the target ("VP: attach to target software") and pause it to see the CPU's registers.</p>
  <div id="body" hidden>
    <div class="keys" id="keys"></div>
    <div class="flags" id="flags" aria-label="PSTATE"></div>
    <details open id="g-general"><summary>General <span class="ch" id="ch-general"></span><span class="count" id="n-general">0</span></summary><table class="regs"><tbody id="t-general"></tbody></table></details>
    <details id="g-fp"><summary>FP / SIMD <span class="ch" id="ch-fp"></span><span class="count" id="n-fp">0</span></summary><input type="search" class="filter" data-group="fp" placeholder="Filter" aria-label="Filter FP and SIMD registers"><table class="regs"><tbody id="t-fp"></tbody></table></details>
    <details id="g-system"><summary>System <span class="ch" id="ch-system"></span><span class="count" id="n-system">0</span></summary><input type="search" class="filter" data-group="system" placeholder="Filter, e.g. SCTLR or _EL1" aria-label="Filter system registers"><table class="regs"><tbody id="t-system"></tbody></table></details>
  </div>
</div>
<div class="toast" id="toast" hidden>Copied</div>
<script nonce="${nonce}">
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
const post = (m) => { if (vscode) vscode.postMessage(m); };
const $ = (id) => document.getElementById(id);
const S = Object.assign({ open: {}, filter: {} }, (vscode && vscode.getState()) || {});
const save = () => { if (vscode) vscode.setState(S); };
let last = null;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
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
    m.state === 'none' ? 'Attach the debugger to the target ("VP: attach to target software") and pause it to see the CPU\\'s registers.' : 'Reading…';
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
    if (r) { box.title = 'Click to copy'; box.addEventListener('click', () => copy(r.value)); }
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
</script></body></html>`;
}

module.exports = { render };
