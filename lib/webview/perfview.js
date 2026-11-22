'use strict';
// HTML of the Performance panel: the result of one experiment (per initiator
// bandwidth and latency, the latency histogram, the bus and the DRAM) or of a
// parameter sweep (a line chart of one metric over one swept parameter, a line
// per value of the others, every run in a table, the checks). The extension
// posts {type: 'status'|'progress'|'run'|'sweep'}; the page posts commands back.
// No VS Code dependency. The style sheet and the page script are
// media/perf.css and media/perf.js.

const { css, ICON, esc } = require('./webtheme');
const media = require('./media');

function render(nonce, cspSource, title) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style nonce="${nonce}">
${css}
${media.read('perf.css')}
</style></head><body>
<div class="app">
<header class="head">
  <div class="ident">${ICON.pulse}<div class="ident-text">
    <div class="title-row"><h1 id="title">${esc(title)}</h1><span id="state" class="status idle" aria-live="polite"><span class="dot"></span><span id="state-t">Waiting</span></span></div>
    <p class="desc" id="desc">Architecture exploration: traffic generators, an approximately-timed bus and a DRAM controller.</p>
  </div></div>
  <div class="actions">
    <button id="stop" class="tinted" hidden title="Stop the running simulations">${ICON.stop}Stop</button>
    <button id="rerun" title="Run the same experiment or sweep again">${ICON.play}Run Again</button>
    <button id="csv" title="Save the table as CSV">${ICON.download}CSV</button>
    <button id="reveal" title="Open the folder with the results">${ICON.file}Results</button>
  </div>
</header>
<section class="stats" id="stats" aria-label="Summary"></section>
<div class="content">
  <p class="banner warn" id="warn" role="alert" hidden><span id="warn-t"></span></p>
  <div id="body"><p class="muted empty">No results yet.</p></div>
</div>
</div>
<div class="tip" id="tip" role="tooltip" hidden></div>
<script nonce="${nonce}">${media.read('perf.js')}</script>
</body></html>`;
}

module.exports = { render };
