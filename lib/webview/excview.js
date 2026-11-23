'use strict';
// HTML of the Exceptions & Interrupts panel (sim agent 0.15.0). The extension
// posts {type: 'exc', ...} with the counts, the new events (decoded by
// lib/debug/exceptions.js) and a catch that stopped the simulation; the page
// sends back the catch choices, Recording, Clear and Continue.
// No VS Code dependency.

const { css, ICON, esc } = require('./webtheme');
const media = require('./media');

function render(nonce, cspSource, title, choices) {
  const [name, platform] = String(title).split(/:\s*/, 2);
  const boxes = choices.map((c) => `<label class="chk" title="${esc(c.hint)}"><input type="checkbox" class="catch" value="${esc(c.id)}">${esc(c.label)}</label>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style nonce="${nonce}">
${css}
${media.read('exceptions.css')}
${Array.from({ length: 16 }, (_, i) => `.crows li.d${i}{padding-left:${i * 14}px}`).join('')}
</style></head><body>
<div class="app">
<header class="head">
  <div class="ident">${ICON.pulse}<div class="ident-text">
    <div class="title-row"><h1>${esc(name)}</h1>${platform ? `<span class="tag mono">${esc(platform)}</span>` : ''}<span id="xstate" class="status idle" aria-live="polite"><span class="dot"></span><span id="xstate-t">Waiting for the simulation</span></span></div>
    <p class="desc">Every exception and interrupt the CPUs take, decoded from ESR and FAR; stop the simulation on the kinds you choose.</p>
  </div></div>
  <div class="actions">
    <button id="record" class="toggle" aria-pressed="true" title="Record events; off keeps what was recorded (catching still works)">${ICON.record}<span id="record-t">Recording</span></button>
    <button id="follow" class="toggle-soft" aria-pressed="true" title="Show new events as they arrive">${ICON.follow}Follow</button>
    <button id="clear" title="Drop the events and counts recorded so far">${ICON.clear}Clear</button>
  </div>
</header>
<section class="stats" aria-label="Summary">
  <div class="stat"><div class="stat-label">Recorded</div><div class="stat-value" id="st-total">0</div><div class="stat-sub">since the last clear</div></div>
  <div class="stat"><div class="stat-label">Synchronous</div><div class="stat-value sync" id="st-sync">0</div><div class="stat-sub">exceptions</div></div>
  <div class="stat"><div class="stat-label">Interrupts</div><div class="stat-value irq" id="st-irq">0</div><div class="stat-sub">IRQ, FIQ, SError</div></div>
  <div class="stat"><div class="stat-label">Stops</div><div class="stat-value" id="st-hits">0</div><div class="stat-sub">by the catch rules</div></div>
</section>
<div class="hitwrap"><div class="banner stop" id="hit" hidden><span><b>Stopped:</b> <span id="hittext" aria-live="assertive"></span> <span class="hit-note" id="hitnote"></span></span><button id="hitdis" hidden>${ICON.list}Disassembly</button><button id="hitcont" class="primary">${ICON.play}Continue</button></div>
  <details class="card calls" id="calls" open hidden><summary class="card-h">Calls before this exception <span class="muted" id="callsub"></span></summary>
    <p class="muted" id="callnote" hidden></p>
    <div class="chain" id="chain" aria-label="Calls still open at the exception, outermost first"></div>
    <ol class="crows" id="crows" aria-label="Last calls and returns, oldest first"></ol>
  </details>
</div>
<div class="tbody">
<aside class="side">
  <section class="card" role="group" aria-label="Stop on">
    <div class="card-h" title="Pause the simulation when the CPU takes one of these; the CPU stops on the vector, before the handler runs">Stop on</div>
    <div class="boxes">${boxes}</div>
    <label class="field">From <select id="origin" aria-label="Taken from">
      <option value="any">any exception level</option><option value="el0">EL0 (user space)</option><option value="el1">EL1 (kernel)</option><option value="el2">EL2 (hypervisor)</option>
    </select></label>
    <label class="field col" title="System call names or numbers (arm64), for example: openat, ioctl 222. Empty: every system call">Only these system calls <input type="text" id="syscalls" placeholder="e.g. openat, ioctl" aria-label="Only these system calls"></label>
    <p class="note-err" id="syserr" role="alert" hidden></p>
    <p class="muted" id="catchnote">Nothing chosen: events are only recorded.</p>
  </section>
  <section class="card" role="group" aria-label="Counts">
    <div class="card-h">Counts</div>
    <table class="counts"><tbody id="counts"></tbody></table>
    <p class="muted" id="nocounts">None yet.</p>
  </section>
</aside>
<main class="tmain">
  <p class="banner warn" id="warn" role="alert" hidden></p>
  <div class="filters"><label class="field">Show <select id="kind" aria-label="Show">
    <option value="">all</option><option value="sync">synchronous only</option><option value="nosync">interrupts only</option>
  </select></label><label class="field">CPU <select id="cpu" aria-label="CPU"><option value="">all</option></select></label><span class="muted" id="summary"></span></div>
  <table class="ev" aria-label="Events, newest at the bottom"><thead><tr><th class="num">#</th><th>Time (s)</th><th>CPU</th><th>Kind</th><th>What</th><th>EL</th><th>From PC</th><th>Vector</th></tr></thead>
  <tbody id="rows"></tbody></table>
  <p class="muted empty" id="empty">No events yet.</p>
</main>
</div>
</div>
<script nonce="${nonce}">
${media.read('exceptions.js')}
</script></body></html>`;
}

module.exports = { render };
