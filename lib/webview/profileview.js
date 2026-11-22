'use strict';
// HTML of the Profile panel (G-05). The extension posts {type: 'profile', ...}
// every few seconds; the page shows the functions with the most samples and
// sends back the controls (CPU, sampling on/off, reset, symbol file).
// No VS Code dependency.
//
// Layout (same look as the platform view): a header with the sampling state and
// the controls, a strip of key figures, the three hottest functions as cards,
// and every function with its share.

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
${media.read('profile.css')}
</style></head><body>
<div class="app">
<header class="head">
  <div class="ident">${ICON.flame}<div class="ident-text">
    <div class="title-row"><h1>${esc(name)}</h1>${platform ? `<span class="tag mono">${esc(platform)}</span>` : ''}<span id="pstate" class="status idle" aria-live="polite"><span class="dot"></span><span id="pstate-t">Waiting for the simulation</span></span></div>
    <p class="desc">Where the guest software spends its instructions, by function; a sample every so many instructions.</p>
  </div></div>
  <div class="actions">
    <label class="cpu-pick">CPU <select id="cpu" aria-label="CPU"><option value="">all</option></select></label>
    <button id="sampling" class="toggle" aria-pressed="true" title="Take samples; off keeps what was taken">${ICON.record}<span id="sampling-t">Sampling</span></button>
    <button id="reset" class="tinted" title="Start a new interval: drop the samples taken so far">${ICON.reset}Reset</button>
    <button id="choose" title="Choose the symbol file (for example vmlinux)">${ICON.file}Symbols…</button>
  </div>
</header>
<section class="stats" aria-label="Profile summary">
  <div class="stat"><div class="stat-label">Samples</div><div class="stat-value" id="st-samples">0</div><div class="stat-sub" id="st-samples-s">all CPUs</div></div>
  <div class="stat"><div class="stat-label">Instructions</div><div class="stat-value" id="st-ins">–</div><div class="stat-sub">about, from the samples</div></div>
  <div class="stat"><div class="stat-label">Host time</div><div class="stat-value" id="st-time">–</div><div class="stat-sub">of this interval</div></div>
  <div class="stat"><div class="stat-label">Interval</div><div class="stat-value" id="st-period">–</div><div class="stat-sub">instructions per sample</div></div>
  <div class="stat"><div class="stat-label">Symbols</div><div class="stat-value mono" id="sym">none</div><div class="stat-sub mono" id="st-kaslr">no KASLR offset</div></div>
</section>
<div class="content">
  <p class="banner warn" id="warn" role="alert" hidden></p>
  <div class="hot" id="hot" aria-label="Hottest functions"></div>
  <p class="muted" id="summary" aria-live="polite">Waiting for the simulation…</p>
  <table class="fns" aria-label="Functions by samples"><thead><tr><th class="num">#</th><th class="num">%</th><th class="bar"></th><th class="num">Samples</th><th>Function</th><th>Space</th></tr></thead>
  <tbody id="rows"></tbody></table>
  <p class="muted empty" id="empty">No samples yet.</p>
</div>
</div>
<script nonce="${nonce}">
${media.read('profile.js')}
</script></body></html>`;
}

module.exports = { render };
