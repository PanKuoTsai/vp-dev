'use strict';
// HTML of the Address Translation panel. The extension posts {type: 'mmu',
// cpu, expr, result?, error?} (result from lib/debug/mmu.js forView); the
// page sends back translate, copy, memory (show the VA in Memory Inspector)
// and register (reveal the peripheral register at the PA).
// No VS Code dependency.

const { css, ICON } = require('./webtheme');
const media = require('./media');

// Widths of the address fields, by bit count: classes, since the CSP drops style attributes.
const widths = Array.from({ length: 64 }, (_, i) => `.seg.b${i + 1}{flex-grow:${i + 1}}`).join('');

const LAYERS = '<svg class="brand" width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7"/><path class="pins" d="M7 10h18M7 16h12M7 22h6M21 16l4 6-4 0"/></svg>';

function render(nonce, cspSource) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Address Translation</title>
<style nonce="${nonce}">
${css}
${media.read('mmu.css')}
${widths}
</style></head><body>
<div class="app">
<header class="head">
  <div class="ident">${LAYERS}<div class="ident-text">
    <div class="title-row"><h1>Address Translation</h1><span id="cstate" class="status idle" aria-live="polite"><span class="dot"></span><span id="cstate-t">No debug session</span></span></div>
    <p class="desc">A virtual address through the selected CPU's translation tables (stage 1, EL1&amp;0): every descriptor, the physical address and the access rights.</p>
  </div></div>
  <form class="actions" id="form">
    <input type="text" id="expr" class="mono" placeholder="0xffff800008010000, &amp;jiffies, $sp" aria-label="Virtual address or expression" spellcheck="false">
    <button id="go" class="primary" type="submit">${ICON.play}Translate</button>
  </form>
</header>
<section class="stats" aria-label="Result">
  <div class="stat"><div class="stat-label">Physical address</div><div class="stat-value mono" id="st-pa">–</div><div class="stat-sub" id="st-where"></div></div>
  <div class="stat"><div class="stat-label">Mapping</div><div class="stat-value" id="st-map">–</div><div class="stat-sub" id="st-map-s"></div></div>
  <div class="stat"><div class="stat-label">EL1 (kernel)</div><div class="stat-value mono" id="st-el1">–</div><div class="stat-sub">read · write · execute</div></div>
  <div class="stat"><div class="stat-label">EL0 (user)</div><div class="stat-value mono" id="st-el0">–</div><div class="stat-sub">read · write · execute</div></div>
  <div class="stat"><div class="stat-label">Memory type</div><div class="stat-value" id="st-attr">–</div><div class="stat-sub" id="st-attr-s"></div></div>
</section>
<div class="content">
  <p class="banner warn" id="warn" role="alert" hidden></p>
  <div class="banner stop" id="fault" role="alert" hidden><span><b id="fault-k"></b> <span id="fault-t"></span> <span class="hint" id="fault-h"></span></span></div>
  <div class="tools" id="tools" hidden>
    <button id="mem" title="Open the virtual address in Memory Inspector">${ICON.list}Show in Memory Inspector</button>
    <button id="reg" title="Select the register at this physical address in Peripheral Registers" hidden>${ICON.file}Show register</button>
    <button id="copy" title="Copy the walk as text">${ICON.download}Copy</button>
    <span class="muted" id="ctx"></span>
  </div>
  <section aria-label="Virtual address fields"><div class="bar" id="bar"></div></section>
  <table class="walk" aria-label="Translation table walk" hidden id="walk"><thead><tr><th>Level</th><th>Table</th><th class="num">Index</th><th>Descriptor at</th><th>Descriptor</th><th>Type</th><th>Points to</th><th>Bits</th></tr></thead>
  <tbody id="steps"></tbody></table>
  <ul class="notes" id="notes" aria-label="Notes"></ul>
  <section class="hist" aria-label="Recent addresses"><span class="muted">Recent:</span><span class="chips" id="hist"></span></section>
  <p class="muted empty" id="empty">Enter a virtual address or an expression gdb understands, with the target paused. The last one is translated again at every stop and when you choose another CPU in Call Stack.</p>
</div>
</div>
<script nonce="${nonce}">
${media.read('mmu.js')}
</script></body></html>`;
}

module.exports = { render };
