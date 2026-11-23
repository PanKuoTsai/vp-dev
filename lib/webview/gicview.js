'use strict';
// HTML of the Interrupts (GIC) panel. The extension posts {type: 'gic', ...}
// with the distributor, the CPUs' redistributors and one row per interrupt
// (lib/analysis/gic.js); the page filters them and sends back Refresh and Live.
// No VS Code dependency.

const { css, ICON, esc } = require('./webtheme');
const media = require('./media');

function render(nonce, cspSource, title) {
  const [name, platform] = String(title).split(/:\s*/, 2);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style nonce="${nonce}">
${css}
${media.read('gic.css')}
</style></head><body>
<div class="app">
<header class="head">
  <div class="ident">${ICON.pulse}<div class="ident-text">
    <div class="title-row"><h1>${esc(name)}</h1>${platform ? `<span class="tag mono">${esc(platform)}</span>` : ''}<span id="gstate" class="status idle" aria-live="polite"><span class="dot"></span><span id="gstate-t">Waiting for the simulation</span></span></div>
    <p class="desc">Every interrupt of the GIC: what drives it, whether it is enabled, pending or active, its priority and target, and why it does not reach a CPU.</p>
  </div></div>
  <div class="actions">
    <button id="live" class="toggle-soft" aria-pressed="false" title="Read again every second while the simulation runs (the values then come from different moments)">${ICON.pulse}Live</button>
    <button id="refresh" class="tinted" title="Read the GIC now">${ICON.reset}Refresh</button>
  </div>
</header>
<section class="stats" aria-label="Summary">
  <div class="stat"><div class="stat-label">Distributor</div><div class="stat-value" id="st-dist">–</div><div class="stat-sub" id="st-dist-s"></div></div>
  <div class="stat"><div class="stat-label">Wired</div><div class="stat-value" id="st-wired">0</div><div class="stat-sub">driven by a device</div></div>
  <div class="stat"><div class="stat-label">Enabled</div><div class="stat-value" id="st-en">0</div><div class="stat-sub" id="st-en-s"></div></div>
  <div class="stat"><div class="stat-label">Pending / active</div><div class="stat-value" id="st-pa">0 / 0</div><div class="stat-sub" id="st-at"></div></div>
  <div class="stat"><div class="stat-label">Problems</div><div class="stat-value" id="st-prob">0</div><div class="stat-sub">warnings and errors</div></div>
</section>
<div class="content">
  <p class="banner warn" id="warn" role="alert" hidden></p>
  <div class="cpus" id="cpus" aria-label="Redistributors"></div>
  <div class="filters">
    <label class="field">Show <select id="show" aria-label="Show">
      <option value="used">wired or in use</option><option value="problems">with problems</option><option value="pa">pending or active</option><option value="all">all</option>
    </select></label>
    <label class="field">SGIs and PPIs of <select id="cpu" aria-label="CPU"><option value="">every CPU</option></select></label>
    <input type="search" id="q" placeholder="Filter: INTID or device" aria-label="Filter by INTID or device">
    <span class="muted" id="count"></span>
  </div>
  <table class="irq" aria-label="Interrupts"><thead><tr><th class="num">INTID</th><th>Type</th><th>Driven by</th><th>State</th><th class="num">Priority</th><th>Trigger</th><th>Group</th><th>Target</th><th>Notes</th></tr></thead>
  <tbody id="rows"></tbody></table>
  <p class="muted empty" id="empty" hidden>No interrupt matches.</p>
</div>
</div>
<script nonce="${nonce}">
${media.read('gic.js')}
</script></body></html>`;
}

module.exports = { render };
