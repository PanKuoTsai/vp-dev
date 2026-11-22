'use strict';
// HTML of the Build QBox view. The extension posts
// { type: 'state', status, form, choices, check, command, running, last };
// the page shows the QBox folder's state and the build settings, and posts
// { type: 'ready' | 'set' (form) | 'browse' (field) | 'build' | 'moveBuild' | 'cmakeToolsOff' | 'command' (name) }.
// No VS Code dependency.

const { css, ICON, BRAND } = require('./webtheme');
const media = require('./media');

function render(nonce, cspSource) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Build QBox</title>
<style nonce="${nonce}">
${css}
${media.read('qbox.css')}
</style></head><body>
<div class="app">
<header class="head">
  <div class="ident">${BRAND}<div class="ident-text">
    <div class="title-row"><h1>Build QBox</h1><span class="status idle" id="state"><span class="dot"></span><span id="state-t">Reading…</span></span></div>
    <p class="desc" id="desc">The QBox VP Studio runs, and how it is built.</p>
  </div></div>
</header>
<section class="stats" aria-label="QBox state" id="stats"></section>
<div class="layout">
  <div class="col">
    <section class="card" aria-labelledby="h-src">
      <div class="card-h"><span class="n">1</span><h2 id="h-src">QBox folder</h2><span class="sub" id="src-kind"></span></div>
      <div class="row"><input type="text" id="src" spellcheck="false" aria-label="QBox folder"><button id="src-browse">Browse…</button></div>
      <div class="facts" id="src-facts"></div>
      <div class="checks" id="checkout-box" hidden>
        <label class="check"><input type="checkbox" id="checkout"><span>Check out the pinned commit first<span class="d" id="checkout-d"></span></span></label>
      </div>
      <p class="hint">A QBox source tree, or an empty folder: VP Studio clones the pinned QBox into it. The build directory is <span class="mono">&lt;folder&gt;/build</span>.</p>
    </section>
    <section class="card" aria-labelledby="h-cfg">
      <div class="card-h"><span class="n">2</span><h2 id="h-cfg">Build settings</h2><span class="sub" id="cfg-was"></span></div>
      <div class="field"><span class="lbl">Configure preset</span><select id="preset" aria-label="Configure preset"></select></div>
      <div class="field"><span class="lbl">QEMU targets</span><div class="targets" id="targets" role="group" aria-label="QEMU targets"></div>
        <p class="hint">AArch64 is enough for the Ubuntu AArch64 platform; every target adds build time.</p></div>
      <div class="field"><span class="lbl">Parallel jobs</span><input type="number" id="jobs" min="1" max="256" aria-label="Parallel jobs"></div>
    </section>
    <section class="card" aria-labelledby="h-cpm">
      <div class="card-h"><span class="n">3</span><h2 id="h-cpm">Dependencies' sources (CPM_SOURCE_CACHE)</h2></div>
      <div class="opts" id="cache" role="radiogroup" aria-label="Package cache"></div>
      <div class="row" id="cache-custom" hidden><input type="text" id="cache-dir" spellcheck="false" aria-label="Package cache folder"><button id="cache-browse">Browse…</button></div>
      <p class="hint">SystemC, CCI, libqemu and the other packages QBox downloads. The choice is kept in build/CMakeCache.txt; a cache can be shared by several QBox builds.</p>
    </section>
    <section class="card" aria-labelledby="h-patch">
      <div class="card-h"><span class="n">4</span><h2 id="h-patch">VP Studio patches</h2></div>
      <label class="check"><input type="checkbox" id="patches"><span>Apply the patches that are not applied yet<span class="d">The MTTCG fix (multi-CPU platforms start reliably), VP Studio's probes and OpenOCD debug port (systemc-components/probes, debug_dap; the sim agent needs them), the performance models (systemc-components/perf) and libqemu's device state (checkpoints).</span></span></label>
      <ul class="plist" id="plist"></ul>
    </section>
    <section class="card" aria-labelledby="h-after">
      <div class="card-h"><span class="n">5</span><h2 id="h-after">After building</h2></div>
      <div class="checks">
        <label class="check"><input type="checkbox" id="agent"><span>Build the sim agent<span class="d" id="agent-d">It links to QBox's probes.so, so it is built against this QBox.</span></span></label>
        <label class="check"><input type="checkbox" id="useForSim"><span>Use this QBox for simulations<span class="d" id="use-d"></span></span></label>
      </div>
    </section>
  </div>
  <aside class="col side" aria-label="Build">
    <section class="card">
      <div class="card-h"><h2>Build</h2></div>
      <div class="msgs" id="msgs"></div>
      <div class="field"><span class="lbl">Runs</span><pre class="cmd" id="cmd"></pre></div>
      <div class="actions">
        <button class="primary big" id="build">${ICON.play}Build QBox</button>
        <button id="move" hidden>Move the old build directory aside</button>
        <button id="cmt-off" hidden title="Sets cmake.configureOnOpen, cmake.automaticReconfigure and cmake.configureOnEdit to false in the QBox folder's .vscode/settings.json">Turn off CMake Tools auto-configure</button>
        <div class="row"><button class="run" data-name="checkQbox">Check QBox Version</button><button class="run" data-name="buildSimAgent">Build Sim Agent</button></div>
        <div class="last" id="last"></div>
      </div>
    </section>
  </aside>
</div>
</div>
<script nonce="${nonce}">
${media.read('qbox.js')}
</script></body></html>`;
}

module.exports = { render };
