'use strict';
// HTML of the CPU Registers view (in the Run and Debug side bar). The extension
// posts {type: 'regs', state, thread, regs, pstate, error}; the page shows the
// selected CPU's key registers, the decoded PSTATE, and every register by group
// with the ones that changed since the last stop marked. No VS Code dependency.

const { css, esc } = require('./webtheme');
const media = require('./media');

function render(nonce, cspSource) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc('CPU Registers')}</title>
<style nonce="${nonce}">
${css}
${media.read('cpuregs.css')}
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
${media.read('cpuregs.js')}
</script></body></html>`;
}

module.exports = { render };
