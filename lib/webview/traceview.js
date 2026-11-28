'use strict';
// HTML of the Transaction Trace panel. The extension posts batches of decoded
// records ({type: 'records', records, points, status}); the page keeps them,
// filters them and shows the newest matching rows. No VS Code dependency.
//
// Layout (same look as the platform view): a header with the recording state
// and the main actions, a strip of key figures, the probes, filter and
// breakpoint settings on the left, and the accesses on the right.

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
${media.read('trace.css')}
</style></head><body>
<div class="app">
<header class="head">
  <div class="ident">${ICON.pulse}<div class="ident-text">
    <div class="title-row"><h1>${esc(name)}</h1>${platform ? `<span class="tag mono">${esc(platform)}</span>` : ''}<span id="rstate" class="status idle" aria-live="polite"><span class="dot"></span><span id="rstate-t">Waiting for the simulation</span></span></div>
    <p class="desc">Bus accesses and signal changes seen by the probes; newest at the bottom.</p>
  </div></div>
  <div class="actions">
    <button id="record" class="toggle" aria-pressed="true" title="Record at the probes that are on; off pauses all of them and keeps which ones are on">${ICON.record}<span id="record-t">Recording</span></button>
    <button id="follow" class="toggle-soft" aria-pressed="true" title="Show new accesses as they arrive">${ICON.follow}Follow</button>
    <button id="clear" title="Drop the accesses recorded so far">${ICON.clear}Clear</button>
    <button id="export" title="The accesses kept here as a CSV file">${ICON.download}CSV…</button>
    <button id="vcd" title="Signal changes as a VCD file for a waveform viewer">${ICON.download}VCD…</button>
    <button id="replay" title="Accesses as a replay file for an architecture model (traffic_gen of the perf models)">${ICON.download}Replay…</button>
  </div>
</header>
<section class="stats" aria-label="Trace summary">
  <div class="stat"><div class="stat-label">Recorded</div><div class="stat-value" id="st-total">0</div><div class="stat-sub" id="st-total-s">accesses</div></div>
  <div class="stat"><div class="stat-label">Shown</div><div class="stat-value" id="st-shown">0</div><div class="stat-sub" id="st-shown-s">of 0 kept here</div></div>
  <div class="stat"><div class="stat-label">Reads</div><div class="stat-value R" id="st-r">0</div><div class="stat-sub">kept here</div></div>
  <div class="stat"><div class="stat-label">Writes</div><div class="stat-value W" id="st-w">0</div><div class="stat-sub">kept here</div></div>
  <div class="stat"><div class="stat-label">Signal changes</div><div class="stat-value S" id="st-s">0</div><div class="stat-sub">kept here</div></div>
  <div class="stat"><div class="stat-label">Probes</div><div class="stat-value" id="st-probes">–</div><div class="stat-sub">recording</div></div>
  <div class="stat"><div class="stat-label">Breakpoints</div><div class="stat-value" id="st-bp">0</div><div class="stat-sub">set</div></div>
</section>
<div class="banner stop" id="hit" hidden><span><span id="hittext" aria-live="assertive"></span> <span class="hit-note">The simulation stays paused here until you press Continue, also after the breakpoint is removed.</span></span><button id="hitcont" class="primary">${ICON.play}Continue</button></div>
<div class="tbody">
<aside class="side" aria-label="Trace settings">
  <section class="card" role="group" aria-label="Probes">
    <div class="card-h" title="Every bus-mapped port and signal has a probe; only those turned on record">Probes<span class="grow"></span><button id="pchoose" class="tinted" title="Choose which probes record; applies at once, without a restart">${ICON.list}Choose…</button></div>
    <p id="psum" class="muted" aria-live="polite">…</p>
    <div class="chips" id="plist" aria-label="Probes recording"></div>
  </section>
  <section class="card" role="group" aria-label="Filter the table">
    <div class="card-h" title="Filters which accesses the table shows; it does not stop the simulation">Filter</div>
    <label class="field">Point<select id="point" aria-label="Trace point"><option value="">all</option></select></label>
    <div class="row2">
      <label class="field">Access<select id="dir" aria-label="Read or write"><option value="">all</option><option value="R">read</option><option value="W">write</option><option value="S">signal</option></select></label>
      <label class="field">Address<input id="addr" type="text" spellcheck="false" placeholder="0x1000 or 0x1000-0x1fff" aria-label="Show only accesses to this address or address range"></label>
    </div>
  </section>
  <section class="card" role="group" aria-label="Breakpoints">
    <div class="card-h" title="Pause the simulation when an access matches">Break on</div>
    <label class="field">Point<select id="bpoint" aria-label="Trace point of the breakpoint"><option value="">any point</option></select></label>
    <div class="row2">
      <label class="field">Access<select id="baccess" aria-label="Access of the breakpoint"><option value="w">write</option><option value="r">read</option><option value="rw">read or write</option></select></label>
      <label class="field">Address<input id="baddr" type="text" spellcheck="false" placeholder="0x10000000 or a range" aria-label="Breakpoint address or address range"></label>
    </div>
    <div class="row2">
      <label class="field">Value<input id="bval" type="text" spellcheck="false" placeholder="optional, 0x0a" aria-label="Breakpoint data value" title="Optional: stop only when the data written or read equals this value (data read as a little-endian number)"></label>
      <label class="field">Mask<input id="bmask" type="text" spellcheck="false" placeholder="optional, 0xff" aria-label="Breakpoint data mask" title="Optional: which bits of the data to compare: (data &amp; mask) == (value &amp; mask). Empty compares the whole value"></label>
    </div>
    <div><button id="badd" class="tinted">${ICON.add}Add breakpoint</button></div>
    <span id="berr" class="err-text" role="alert"></span>
    <div class="chips" id="bps" aria-label="Breakpoints set"></div>
  </section>
</aside>
<main class="tmain" id="tmain">
  <p class="muted" id="summary" aria-live="polite">Waiting for the simulation…</p>
  <p id="sincenote" aria-live="polite" hidden></p>
  <table class="acc" aria-label="Bus accesses"><thead><tr><th class="num">#</th><th class="num">Time (s)</th><th>Point</th><th title="Who issued the access (sim agent 0.12.0 and later)">Initiator</th><th>Access</th><th>Address</th><th class="num">Size</th><th>Value</th><th>Bytes</th><th>Status</th></tr></thead>
  <tbody id="rows"></tbody></table>
  <p class="muted empty" id="empty">No accesses yet.</p>
</main>
</div>
</div>
<script nonce="${nonce}">
${media.read('trace.js')}
</script></body></html>`;
}

module.exports = { render };
