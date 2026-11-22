'use strict';
// HTML of the Performance panel: the result of one experiment (per initiator
// bandwidth and latency, the latency histogram, the bus and the DRAM) or of a
// parameter sweep (a line chart of one metric over one swept parameter, a line
// per value of the others, every run in a table, the checks). The extension
// posts {type: 'status'|'progress'|'run'|'sweep'}; the page posts commands back.
// No VS Code dependency. The page script is a real function below, embedded
// with toString(), so it needs no escaping inside a template.

const { css, ICON, esc } = require('./webtheme');

function render(nonce, cspSource, title) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style nonce="${nonce}">
${css}
body{--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#0ca30c;--s7:#9085e9;--s8:#e66767;--seq:#3987e5;--grid:color-mix(in srgb,var(--vp-muted) 22%,transparent);--surface:var(--vp-bg)}
body.vscode-light{--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#6250d6;--s8:#e34948;--seq:#2a78d6}
html,body{height:100%}
.app{display:grid;grid-template-rows:auto auto minmax(0,1fr);height:100vh}
.content{padding:16px 20px 24px;display:flex;flex-direction:column;gap:16px;overflow:auto;min-height:0}
h2{font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:var(--vp-muted);font-weight:600;margin:4px 0 0}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.row label{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--vp-muted)}
.row select{height:30px;font-family:inherit;max-width:340px}
.chart{position:relative;background:var(--vp-panel);border:1px solid var(--vp-border);border-radius:8px;padding:10px 12px}
.chart svg{display:block;max-width:100%;height:auto;overflow:visible}
.chart .ttl{font-size:13px;font-weight:600;margin:0 0 2px}
.chart .sub{font-size:11.5px;color:var(--vp-muted);margin:0 0 6px}
.axis text,.lbl{font-size:11px;fill:var(--vp-muted)}
.lbl.strong{fill:var(--vscode-foreground);font-weight:600}
.gridline{stroke:var(--grid);stroke-width:1}
.baseline{stroke:color-mix(in srgb,var(--vp-muted) 55%,transparent);stroke-width:1}
.series{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.dot{stroke:var(--vp-panel);stroke-width:2}
.cross{stroke:color-mix(in srgb,var(--vp-muted) 60%,transparent);stroke-width:1}
.bar{fill:var(--seq)}
.bar:hover,.bar:focus{opacity:.8;outline:none}
.tip{position:absolute;pointer-events:none;background:var(--vscode-editorHoverWidget-background,var(--vp-panel));border:1px solid var(--vscode-editorHoverWidget-border,var(--vp-border));border-radius:6px;padding:6px 9px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.25);white-space:nowrap;z-index:5}
.tip[hidden]{display:none}
.tip .h{color:var(--vp-muted);font-size:11px;margin-bottom:3px}
.tip .r{display:flex;align-items:center;gap:7px}
.tip .r b{font-weight:600;min-width:56px;text-align:right}
.key{display:inline-block;width:12px;height:2px;border-radius:1px;vertical-align:middle}
.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;margin:2px 0 4px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.k1{background:var(--s1)}.k2{background:var(--s2)}.k3{background:var(--s3)}.k4{background:var(--s4)}.k5{background:var(--s5)}.k6{background:var(--s6)}.k7{background:var(--s7)}.k8{background:var(--s8)}
.c1{stroke:var(--s1)}.c2{stroke:var(--s2)}.c3{stroke:var(--s3)}.c4{stroke:var(--s4)}.c5{stroke:var(--s5)}.c6{stroke:var(--s6)}.c7{stroke:var(--s7)}.c8{stroke:var(--s8)}
.f1{fill:var(--s1)}.f2{fill:var(--s2)}.f3{fill:var(--s3)}.f4{fill:var(--s4)}.f5{fill:var(--s5)}.f6{fill:var(--s6)}.f7{fill:var(--s7)}.f8{fill:var(--s8)}
table.data th{position:sticky;top:0;background:var(--vp-bg);z-index:1;white-space:nowrap}
table.data td.num,table.data th.num{text-align:right;font-variant-numeric:tabular-nums}
table.data tr.fail td{color:var(--vscode-errorForeground)}
tbody tr:hover td{background:var(--vscode-list-hoverBackground)}
.meterbox{height:6px;border-radius:3px;background:color-mix(in srgb,var(--seq) 18%,transparent);overflow:hidden;min-width:60px}
.meter{height:100%;border-radius:3px;background:var(--seq)}
.pass{color:var(--vp-good)}.failc{color:var(--vscode-errorForeground)}
.checks li{margin:2px 0}
.note{font-size:12px;color:var(--vp-muted);margin:0;max-width:900px}
.hscroll{overflow-x:auto;max-width:100%}
table.data tr.sub td{color:var(--vp-muted);font-size:12px;padding-top:2px;padding-bottom:2px;border-top:none}
.mono{font-family:var(--vp-mono)}
.empty{padding:24px 0;text-align:center}
[hidden]{display:none!important}
details.passed summary{cursor:pointer;color:var(--vp-muted);font-size:12px;margin:4px 0}
.twocol{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}
@media (max-width:1300px){.twocol{grid-template-columns:minmax(0,1fr)}}
@media (max-width:760px){.stats{grid-template-columns:repeat(auto-fit,minmax(96px,1fr))}.stat{padding:7px 12px}.stat-value{font-size:14px}.stat-sub{display:none}.head{padding:10px 14px}.desc{display:none}}
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
<script nonce="${nonce}">(${pageScript.toString()})();</script>
</body></html>`;
}

/* ------------------------------------------------------------------ page script (runs in the webview) */
function pageScript() {
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  const post = (m) => { if (vscode) vscode.postMessage(m); };
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const saved = (vscode && vscode.getState()) || {};
  const S = { data: null, metric: saved.metric || '', x: saved.x || '', hist: saved.hist || '', lines: saved.lines || '', fix: saved.fix || {} };
  const keep = () => vscode && vscode.setState({ metric: S.metric, x: S.x, hist: S.hist, lines: S.lines, fix: S.fix });

  for (const id of ['rerun', 'stop', 'csv', 'reveal']) $(id).addEventListener('click', () => post({ type: 'command', command: id }));

  const el = (tag, attrs, text) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const sv = (tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  };

  /** Numbers for people: 1,234 / 12.3K / 0.873, units added by the caller. */
  const num = (v, digits) => {
    if (typeof v !== 'number' || !isFinite(v)) return '–';
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K';
    if (a >= 100 || Number.isInteger(v)) return Math.round(v).toLocaleString('en-US');
    return v.toFixed(digits === undefined ? (a >= 10 ? 1 : a >= 1 ? 2 : 3) : digits);
  };
  /** Whole numbers in full (tables): 10,420. */
  const full = (v) => (typeof v === 'number' && isFinite(v) ? (Math.abs(v) >= 100 || Number.isInteger(v) ? Math.round(v).toLocaleString('en-US') : v.toFixed(Math.abs(v) >= 10 ? 1 : 2)) : '–');
  const pct = (v) => (typeof v === 'number' ? (v * 100).toFixed(v >= 0.995 || v < 0.1 ? 1 : 0) + '%' : '–');
  const unitOf = (m) => (/MBps$/.test(m) ? 'MB/s' : /Ns(\.|$)|Ns\b|latency|service|wait/i.test(m) ? 'ns' : /Rate$|Utilization$/.test(m) ? '%' : '');
  const showMetric = (m, v) => (unitOf(m) === '%' ? pct(v) : full(v) + (unitOf(m) ? ' ' + unitOf(m) : ''));
  const prettyMetric = (m) => m.replace(/^initiators\./, '').replace(/^memories\./, '').replace(/^buses\./, '')
    .replace('.bandwidthMBps', ' bandwidth').replace('.latencyNs.', ' latency ').replace('.serviceNs.', ' service ')
    .replace('.dataBusUtilization', ' data bus use').replace('.rowHitRate', ' row hit rate').replace('.waitNs.', ' wait ')
    .replace('.requestUtilization', ' request channel use').replace('.responseUtilization', ' response channel use');

  const tip = $('tip');
  const showTip = (host, x, y, head, rows) => {
    tip.replaceChildren();
    tip.appendChild(el('div', { class: 'h' }, head));
    for (const r of rows) {
      const d = el('div', { class: 'r' });
      if (r.k) d.appendChild(el('span', { class: 'key ' + r.k }));
      d.appendChild(el('b', {}, r.v));
      d.appendChild(el('span', {}, r.label));
      tip.appendChild(d);
    }
    tip.hidden = false;
    const hb = host.getBoundingClientRect();
    const tw = tip.offsetWidth;
    let left = hb.left + x + 14;
    if (left + tw > window.innerWidth - 8) left = hb.left + x - tw - 14;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, hb.top + y - 10) + 'px';
  };
  const hideTip = () => { tip.hidden = true; };

  function setState(kind, text) {
    $('state').className = 'status ' + kind;
    $('state-t').textContent = text;
  }

  function stat(label, value, sub) {
    const d = el('div', { class: 'stat' });
    d.appendChild(el('div', { class: 'stat-label' }, label));
    d.appendChild(el('div', { class: 'stat-value' }, value));
    if (sub) d.appendChild(el('div', { class: 'stat-sub' }, sub));
    return d;
  }

  const short = (s) => (s.length > 110 ? s.slice(0, 108) + '…' : s);

  function table(head, rows, opts) {
    const t = el('table', { class: 'data', 'aria-label': (opts && opts.label) || '' });
    const tr = el('tr');
    head.forEach((h) => tr.appendChild(el('th', { class: h.num ? 'num' : '' }, h.t)));
    t.appendChild(el('thead')).appendChild(tr);
    const tb = t.appendChild(el('tbody'));
    for (const r of rows) {
      const row = el('tr', { class: r.cls || '' });
      r.cells.forEach((c, i) => {
        const td = el('td', { class: head[i].num ? 'num' : '' });
        if (c instanceof Node) td.appendChild(c); else td.textContent = c;
        row.appendChild(td);
      });
      tb.appendChild(row);
    }
    return t;
  }

  function meter(frac) {
    const box = el('div', { class: 'meterbox' });
    const m = box.appendChild(el('div', { class: 'meter' }));
    m.style.width = Math.max(0, Math.min(100, frac * 100)) + '%';
    return box;
  }

  /* ---------------- one experiment */

  function renderRun(d) {
    const s = d.summary;
    $('desc').textContent = 'One run of ' + (d.platform || 'the platform') + '.';
    const st = $('stats');
    st.replaceChildren();
    st.appendChild(stat('Simulated time', num(s.simTimeNs / 1000) + ' µs', s.complete ? 'all generators done' : 'incomplete'));
    // Every memory counts: the total bandwidth, the busiest data bus, the hit rate over all accesses.
    const mems = s.memories;
    if (mems.length === 1) {
      const mem = mems[0];
      st.appendChild(stat('DRAM bandwidth', full(mem.bandwidthMBps) + ' MB/s', mem.label));
      st.appendChild(stat('Data bus use', pct(mem.dataBusUtilization), 'time moving data'));
      st.appendChild(stat('Row hit rate', pct(mem.rowHitRate), full(mem.rowConflicts) + ' conflicts'));
    } else if (mems.length > 1) {
      const sum = (f) => mems.reduce((a, m) => a + (m[f] || 0), 0);
      const busiest = mems.reduce((a, m) => ((m.dataBusUtilization || 0) > (a.dataBusUtilization || 0) ? m : a), mems[0]);
      const accesses = sum('rowHits') + sum('rowMisses') + sum('rowConflicts');
      st.appendChild(stat('DRAM bandwidth', full(sum('bandwidthMBps')) + ' MB/s', mems.map((m) => m.label + ' ' + full(m.bandwidthMBps)).join(' · ')));
      st.appendChild(stat('Data bus use', pct(busiest.dataBusUtilization), 'busiest: ' + busiest.label));
      st.appendChild(stat('Row hit rate', pct(accesses ? sum('rowHits') / accesses : 0), full(sum('rowConflicts')) + ' conflicts, ' + mems.length + ' memories'));
    }
    // The busiest bus channel: where a bus limits the traffic.
    let busiest = null;
    for (const b of s.buses) {
      const chans = b.topology === 'crossbar'
        ? [...Object.entries(b.channels.request).map(([n, u]) => [b.label + ' request ' + n, u]), ...Object.entries(b.channels.response).map(([n, u]) => [b.label + ' response ' + n, u])]
        : [[b.label + ' request channel', b.requestUtilization], [b.label + ' response channel', b.responseUtilization]];
      for (const [text, u] of chans) if (!busiest || u > busiest.u) busiest = { u, text };
    }
    if (busiest) st.appendChild(stat('Busiest bus channel', pct(busiest.u), busiest.text));

    const body = $('body');
    body.replaceChildren();
    body.appendChild(el('h2', {}, 'Initiators'));
    const maxBw = Math.max(1, ...s.initiators.map((g) => g.bandwidthMBps || 0));
    // Failed accesses (no target at the address, ...) moved no data: a column only when there are some.
    const anyFailed = s.initiators.some((g) => g.errors > 0);
    body.appendChild(table(
      [{ t: 'Initiator' }, { t: 'Reads', num: 1 }, { t: 'Writes', num: 1 }, ...(anyFailed ? [{ t: 'Failed', num: 1 }] : []), { t: 'MB/s', num: 1 }, { t: '' }, { t: 'Mean ns', num: 1 }, { t: 'p50 ns', num: 1 }, { t: 'p99 ns', num: 1 }, { t: 'Max ns', num: 1 }],
      s.initiators.map((g) => ({ cls: g.errors > 0 ? 'fail' : '', cells: [g.label, full(g.reads), full(g.writes), ...(anyFailed ? [full(g.errors || 0)] : []), full(g.bandwidthMBps), meter((g.bandwidthMBps || 0) / maxBw), full(g.mean), full(g.p50), full(g.p99), full(g.max)] })),
      { label: 'Initiators' }));

    const withHist = s.initiators.filter((g) => g.histogram);
    if (withHist.length) {
      if (!withHist.some((g) => g.label === S.hist)) S.hist = withHist[0].label;
      const row = el('div', { class: 'row' });
      const lab = row.appendChild(el('label', {}, 'Latency histogram of '));
      const sel = lab.appendChild(el('select', { 'aria-label': 'Initiator' }));
      for (const g of withHist) { const o = sel.appendChild(el('option', { value: g.label }, g.label)); if (g.label === S.hist) o.selected = true; }
      sel.addEventListener('change', () => { S.hist = sel.value; keep(); renderRun(S.data); });
      body.appendChild(row);
      const g = withHist.find((x) => x.label === S.hist);
      body.appendChild(histogram(g));
    }

    const two = el('div', { class: 'twocol' });
    const left = two.appendChild(el('div'));
    const right = two.appendChild(el('div'));
    left.appendChild(el('h2', {}, 'Memory'));
    left.appendChild(table([{ t: 'Memory' }, { t: 'MB/s', num: 1 }, { t: 'Data bus', num: 1 }, { t: 'Row hits', num: 1 }, { t: 'Misses', num: 1 }, { t: 'Conflicts', num: 1 }, { t: 'Refreshes', num: 1 }, { t: 'Service p99 ns', num: 1 }],
      s.memories.map((m) => ({ cells: [m.label, full(m.bandwidthMBps), pct(m.dataBusUtilization), full(m.rowHits), full(m.rowMisses), full(m.rowConflicts), full(m.refreshes), full(m.serviceP99)] })), { label: 'Memories' }));
    right.appendChild(el('h2', {}, 'Buses'));
    // A crossbar has a channel per target and per initiator: its row shows the busiest, the channels follow.
    const brows = [];
    for (const b of s.buses) {
      const xb = b.topology === 'crossbar';
      brows.push({ cells: [b.label, xb ? 'crossbar' : 'shared', pct(b.requestUtilization), pct(b.responseUtilization)] });
      if (!xb) continue;
      const rq = Object.entries(b.channels.request), rs = Object.entries(b.channels.response);
      for (let i = 0; i < Math.max(rq.length, rs.length); i++) {
        brows.push({ cls: 'sub', cells: ['', '',
          rq[i] ? rq[i][0] + ' ' + pct(rq[i][1]) : '', rs[i] ? rs[i][0] + ' ' + pct(rs[i][1]) : ''] });
      }
    }
    right.appendChild(table([{ t: 'Bus' }, { t: 'Topology' }, { t: 'Request channel', num: 1 }, { t: 'Response channel', num: 1 }], brows, { label: 'Buses' }));
    body.appendChild(two);

    // Per master on each bus: the QoS settings (at_bus masters) and what they did.
    const mrows = [];
    let anyQos = false;
    for (const b of s.buses) {
      if (b.masters && b.masters.length) {
        for (const m of b.masters) {
          anyQos = anyQos || !!m.qos;
          mrows.push({ cells: [b.label, m.label, m.qos || '–', full(m.bandwidthMBps), full(m.waitP99), full(m.responseWaitP99),
            m.grants ? pct(m.urgentGrants / m.grants) : '–', full(m.limitedGrants)] });
        }
      } else {
        // Statistics from perf 1.0.0: only the arbitration wait.
        for (const [who, w] of Object.entries(b.waitNs)) mrows.push({ cells: [b.label, who, '–', '–', full(w.p99), '–', '–', '–'] });
      }
    }
    body.appendChild(el('h2', {}, 'Masters on each bus'));
    body.appendChild(el('p', { class: 'note' }, anyQos
      ? 'QoS is the bus\'s masters setting. Reserved share: grants made within min_mbps (they go first). Held by limit: grants that waited for max_mbps.'
      : 'Set QoS per master with the bus\'s "masters" parameter, e.g. "display: priority=3 min_mbps=6000; cpu: max_mbps=8000".'));
    const wrap = body.appendChild(el('div', { class: 'hscroll' }));
    wrap.appendChild(table([{ t: 'Bus' }, { t: 'Master' }, { t: 'QoS' }, { t: 'MB/s', num: 1 }, { t: 'Req. wait p99 ns', num: 1 },
      { t: 'Resp. wait p99 ns', num: 1 }, { t: 'Reserved share', num: 1 }, { t: 'Held by limit', num: 1 }], mrows, { label: 'Masters on each bus' }));
  }

  /** Columns per latency bucket (1-2-5 edges), one hue: the count is a magnitude. */
  function histogram(g) {
    const h = g.histogram;
    const box = el('div', { class: 'chart' });
    box.appendChild(el('p', { class: 'ttl' }, 'Latency of ' + g.label));
    box.appendChild(el('p', { class: 'sub' }, num(g.reads + g.writes) + ' accesses; p50 ' + num(g.p50) + ' ns, p99 ' + num(g.p99) + ' ns'));
    const W = chartWidth(), H = 200, L = 48, R = 12, T = 10, B = 34;
    const svg = box.appendChild(sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, role: 'img', 'aria-label': 'Latency histogram of ' + g.label }));
    // Only the buckets from the first to the last one used.
    let lo0 = h.counts.findIndex((c) => c > 0);
    if (lo0 < 0) lo0 = 0;
    let hi0 = h.counts.length - 1;
    while (hi0 > lo0 && h.counts[hi0] === 0) hi0--;
    const counts = h.counts.slice(lo0, hi0 + 1);
    const edges = h.upperNs.slice(lo0, hi0 + 1);
    const lowOf = (i) => (i + lo0 === 0 ? 0 : h.upperNs[i + lo0 - 1]);
    const lastOpen = hi0 === h.counts.length - 1;
    const n = counts.length;
    const top = Math.max(1, ...counts);
    const step = niceStep(top / 4);
    const yMax = Math.ceil(top / step) * step;
    const y = (v) => T + (H - T - B) * (1 - v / yMax);
    const ax = svg.appendChild(sv('g', { class: 'axis' }));
    for (let v = 0; v <= yMax + 1e-9; v += step) {
      ax.appendChild(sv('line', { class: v === 0 ? 'baseline' : 'gridline', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
      ax.appendChild(sv('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, num(v)));
    }
    const band = (W - L - R) / n;
    const bw = Math.min(24, band - 2);
    counts.forEach((c, i) => {
      const lo = lowOf(i);
      const hi = edges[i];
      const x = L + band * i + (band - bw) / 2;
      const yy = y(c);
      const hgt = Math.max(0, y(0) - yy);
      const r = Math.min(4, hgt / 2, bw / 2);
      const p = sv('path', { class: 'bar', tabindex: '0', d: `M${x},${y(0)}V${yy + r}Q${x},${yy} ${x + r},${yy}H${x + bw - r}Q${x + bw},${yy} ${x + bw},${yy + r}V${y(0)}Z` });
      const open = lastOpen && i === n - 1;
      const head = (open ? '≥ ' + num(lo) : num(lo) + '–' + num(hi)) + ' ns';
      const show = () => {
        const sb = svg.getBoundingClientRect();
        const bb = box.getBoundingClientRect();
        showTip(box, sb.left - bb.left + (x + bw / 2) * sb.width / W, sb.top - bb.top + yy * sb.height / H, head, [{ v: num(c), label: 'accesses' }]);
      };
      p.addEventListener('pointerenter', show);
      p.addEventListener('focus', show);
      p.addEventListener('pointerleave', hideTip);
      p.addEventListener('blur', hideTip);
      svg.appendChild(p);
      if (band >= 44 || i % 2 === 0) svg.appendChild(sv('text', { class: 'lbl', x: L + band * i + band / 2, y: H - B + 16, 'text-anchor': 'middle' }, open ? '≥' + num(lo) : num(lo) + '–' + num(hi)));
    });
    svg.appendChild(sv('text', { class: 'lbl', x: (L + W - R) / 2, y: H - 4, 'text-anchor': 'middle' }, 'latency, ns'));
    return box;
  }

  /** Chart width in CSS pixels, so the text keeps its size: the content column less the chart's padding. */
  const chartWidth = () => Math.max(360, Math.min(1400, ($('body').clientWidth || 720) - 26));

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-12))));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
    return 10 * p;
  }

  /* ---------------- a sweep */

  function renderSweep(d) {
    const r = d.results;
    const params = (r.sweep || []).map((s) => s.param);
    const metrics = [];
    for (const run of r.runs) for (const k of Object.keys(run.metrics || {})) if (!metrics.includes(k)) metrics.push(k);
    if (!metrics.includes(S.metric)) S.metric = metrics[0] || '';
    if (!params.includes(S.x)) S.x = params[params.length - 1] || '';
    const ok = r.runs.filter((x) => x.ok).length;
    const checks = r.checkResults || [];
    const failed = checks.filter((c) => !c.ok).length;
    $('desc').textContent = 'Sweep of ' + (r.platform || 'the platform') + (r.specFile ? ' (' + r.specFile + ')' : '') + '.';
    const st = $('stats');
    st.replaceChildren();
    st.appendChild(stat('Runs', ok + ' / ' + r.runs.length, ok === r.runs.length ? 'all finished' : (r.runs.length - ok) + ' failed'));
    st.appendChild(stat('Parameters', String(params.length), params.join(', ')));
    if (checks.length) st.appendChild(stat('Checks', failed ? failed + ' failed' : 'all passed', checks.length + ' checked'));
    const secs = r.runs.reduce((a, x) => a + (x.seconds || 0), 0);
    st.appendChild(stat('Host time', num(secs) + ' s', 'all runs together'));

    const body = $('body');
    body.replaceChildren();
    if (metrics.length) {
      const row = el('div', { class: 'row' });
      const l1 = row.appendChild(el('label', {}, 'Metric '));
      const ms = l1.appendChild(el('select', { 'aria-label': 'Metric' }));
      for (const m of metrics) { const o = ms.appendChild(el('option', { value: m }, prettyMetric(m))); if (m === S.metric) o.selected = true; }
      ms.addEventListener('change', () => { S.metric = ms.value; keep(); renderSweep(S.data); });
      if (params.length > 1) {
        const l2 = row.appendChild(el('label', {}, 'Along '));
        const xs = l2.appendChild(el('select', { 'aria-label': 'Parameter on the horizontal axis' }));
        for (const p of params) { const o = xs.appendChild(el('option', { value: p }, p)); if (p === S.x) o.selected = true; }
        xs.addEventListener('change', () => { S.x = xs.value; keep(); renderSweep(S.data); });
      }
      // With more than two parameters: one of the others gives the lines, the rest are held at a value.
      let others = params.filter((p) => p !== S.x);
      let runs = r.runs;
      if (others.length > 1) {
        if (!others.includes(S.lines)) S.lines = others[0];
        const l3 = row.appendChild(el('label', {}, 'Lines '));
        const ls = l3.appendChild(el('select', { 'aria-label': 'Parameter that gives the lines' }));
        for (const p of others) { const o = ls.appendChild(el('option', { value: p }, p)); if (p === S.lines) o.selected = true; }
        ls.addEventListener('change', () => { S.lines = ls.value; keep(); renderSweep(S.data); });
        S.fix = S.fix || {};
        for (const p of others.filter((q) => q !== S.lines)) {
          const vals = (r.sweep.find((s) => s.param === p) || { values: [] }).values.map((v) => JSON.stringify(v));
          if (!vals.includes(S.fix[p])) S.fix[p] = vals[0];
          const lf = row.appendChild(el('label', {}, p + ' = '));
          const fs = lf.appendChild(el('select', { 'aria-label': 'Value of ' + p }));
          for (const v of vals) { const o = fs.appendChild(el('option', { value: v }, String(JSON.parse(v)))); if (v === S.fix[p]) o.selected = true; }
          fs.addEventListener('change', () => { S.fix[p] = fs.value; keep(); renderSweep(S.data); });
          runs = runs.filter((x) => JSON.stringify(x.values[p]) === S.fix[p]);
        }
        others = [S.lines];
      }
      body.appendChild(row);
      body.appendChild(lineChart(Object.assign({}, r, { runs }), S.metric, S.x, others));
    }
    if (checks.length) {
      body.appendChild(el('h2', {}, 'Checks'));
      const item = (ul, c) => {
        const li = ul.appendChild(el('li'));
        li.appendChild(el('span', { class: c.ok ? 'pass' : 'failc' }, c.ok ? '✓ pass ' : '✗ fail '));
        li.appendChild(el('span', { class: 'mono' }, c.name + ': '));
        li.appendChild(el('span', {}, c.message));
      };
      const bad = checks.filter((c) => !c.ok);
      const good = checks.filter((c) => c.ok);
      if (bad.length) { const ul = body.appendChild(el('ul', { class: 'checks' })); bad.forEach((c) => item(ul, c)); }
      if (good.length) {
        const d = body.appendChild(el('details', { class: 'passed' }));
        if (!bad.length) d.open = true;
        d.appendChild(el('summary', {}, good.length + ' passed'));
        const ul = d.appendChild(el('ul', { class: 'checks' }));
        good.forEach((c) => item(ul, c));
      }
    }
    body.appendChild(el('h2', {}, 'Runs'));
    body.appendChild(table(
      [{ t: '#', num: 1 }, ...params.map((p) => ({ t: p })), ...metrics.map((m) => ({ t: prettyMetric(m), num: 1 })), { t: 'Result' }],
      r.runs.map((x) => ({ cls: x.ok ? '' : 'fail', cells: [String(x.index), ...params.map((p) => String(x.values[p])), ...metrics.map((m) => showMetric(m, x.metrics[m])), x.ok ? 'ok' : short(x.error || 'failed')] })),
      { label: 'Runs' }));
  }

  /** One line per combination of the other parameters; x = the values of one parameter, evenly spaced in sweep order. */
  function lineChart(r, metric, xParam, others) {
    const xs = (r.sweep.find((s) => s.param === xParam) || { values: [] }).values;
    const groups = new Map();
    for (const run of r.runs) {
      const key = others.map((p) => p + '=' + JSON.stringify(run.values[p])).join(', ');
      if (!groups.has(key)) groups.set(key, { key, name: others.map((p) => String(run.values[p])).join(' · ') || prettyMetric(metric), pts: [] });
      const xi = xs.findIndex((v) => JSON.stringify(v) === JSON.stringify(run.values[xParam]));
      const v = run.ok ? run.metrics[metric] : undefined;
      groups.get(key).pts.push({ xi, v, run });
    }
    const series = [...groups.values()].slice(0, 8);
    series.forEach((s, i) => { s.n = i + 1; s.pts.sort((a, b) => a.xi - b.xi); });
    const box = el('div', { class: 'chart' });
    box.appendChild(el('p', { class: 'ttl' }, prettyMetric(metric) + (unitOf(metric) && unitOf(metric) !== '%' ? ' (' + unitOf(metric) + ')' : '')));
    box.appendChild(el('p', { class: 'sub' }, 'by ' + xParam + (others.length ? ', a line per ' + others.join(' and ') : '')));
    if (series.length > 1) {
      const lg = box.appendChild(el('div', { class: 'legend' }));
      for (const s of series) { const sp = lg.appendChild(el('span')); sp.appendChild(el('span', { class: 'key k' + s.n })); sp.appendChild(document.createTextNode(s.name)); }
    }
    const W = chartWidth(), H = 260, L = 56, R = series.length > 1 && series.length <= 4 ? 120 : 20, T = 12, B = 34;
    const svg = box.appendChild(sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, role: 'img', 'aria-label': prettyMetric(metric) + ' by ' + xParam }));
    const vals = series.flatMap((s) => s.pts.map((p) => p.v)).filter((v) => typeof v === 'number');
    if (!vals.length) { box.appendChild(el('p', { class: 'muted' }, 'No finished run has this metric.')); return box; }
    const isPct = unitOf(metric) === '%';
    const top = Math.max(...vals);
    const step = isPct ? (top > 0.5 ? 0.25 : 0.1) : niceStep(top / 4 || 1);
    const yMax = isPct ? Math.min(1, Math.ceil(top / step) * step) || step : Math.ceil(top / step) * step || step;
    const y = (v) => T + (H - T - B) * (1 - v / yMax);
    const n = Math.max(1, xs.length);
    const x = (i) => (n === 1 ? (L + W - R) / 2 : L + 8 + (W - L - R - 16) * i / (n - 1));
    const ax = svg.appendChild(sv('g', { class: 'axis' }));
    for (let v = 0; v <= yMax + 1e-9; v += step) {
      ax.appendChild(sv('line', { class: v === 0 ? 'baseline' : 'gridline', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
      ax.appendChild(sv('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, isPct ? Math.round(v * 100) + '%' : num(v)));
    }
    xs.forEach((v, i) => ax.appendChild(sv('text', { x: x(i), y: H - B + 16, 'text-anchor': 'middle' }, String(v))));
    svg.appendChild(sv('text', { class: 'lbl', x: (L + W - R) / 2, y: H - 4, 'text-anchor': 'middle' }, xParam));
    const ends = [];
    for (const s of series) {
      const pts = s.pts.filter((p) => typeof p.v === 'number' && p.xi >= 0);
      if (pts.length > 1) svg.appendChild(sv('path', { class: 'series c' + s.n, d: pts.map((p, i) => (i ? 'L' : 'M') + x(p.xi) + ',' + y(p.v)).join('') }));
      for (const p of pts) svg.appendChild(sv('circle', { class: 'dot f' + s.n, cx: x(p.xi), cy: y(p.v), r: 4 }));
      const last = pts[pts.length - 1];
      if (last && series.length > 1 && series.length <= 4) ends.push({ x: x(last.xi) + 10, y: y(last.v) + 4, name: s.name });
    }
    // End labels, pushed apart where lines end close together (or on top of each other).
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
    for (const e of ends) svg.appendChild(sv('text', { class: 'lbl strong', x: e.x, y: e.y }, e.name));
    // Crosshair: snaps to the nearest x value, one readout for every line.
    const cross = svg.appendChild(sv('line', { class: 'cross', y1: T, y2: H - B, visibility: 'hidden' }));
    const hit = svg.appendChild(sv('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent', tabindex: '0', 'aria-label': 'Values; use the arrow keys' }));
    let cur = -1;
    const at = (i) => {
      cur = Math.max(0, Math.min(n - 1, i));
      cross.setAttribute('x1', x(cur)); cross.setAttribute('x2', x(cur)); cross.setAttribute('visibility', 'visible');
      const rows = series.map((s) => { const p = s.pts.find((q) => q.xi === cur); return { k: 'k' + s.n, v: p ? (typeof p.v === 'number' ? showMetric(metric, p.v) : (p.run.ok ? '–' : 'failed')) : '–', label: series.length > 1 ? s.name : '' }; });
      const sb = svg.getBoundingClientRect();
      const bb = box.getBoundingClientRect();
      showTip(box, sb.left - bb.left + x(cur) * sb.width / W, sb.top - bb.top + T * sb.height / H + 20, xParam + ' = ' + String(xs[cur]), rows);
    };
    hit.addEventListener('pointermove', (e) => {
      const sb = svg.getBoundingClientRect();
      const px = (e.clientX - sb.left) * W / sb.width;
      let best = 0;
      for (let i = 1; i < n; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
      at(best);
    });
    hit.addEventListener('focus', () => at(cur < 0 ? 0 : cur));
    hit.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { at(cur + 1); e.preventDefault(); } if (e.key === 'ArrowLeft') { at(cur - 1); e.preventDefault(); } });
    const off = () => { cross.setAttribute('visibility', 'hidden'); hideTip(); };
    hit.addEventListener('pointerleave', off);
    hit.addEventListener('blur', off);
    return box;
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (S.data) (S.data.type === 'sweep' ? renderSweep : renderRun)(S.data); }, 150);
  });

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'status') {
      setState(m.kind || 'idle', m.text || '');
      $('stop').hidden = !m.running;
      $('rerun').disabled = !!m.running;
      if (m.title) $('title').textContent = m.title;
      if (m.warn !== undefined) { $('warn').hidden = !m.warn; $('warn-t').textContent = m.warn || ''; }
    } else if (m.type === 'run') {
      S.data = m; renderRun(m);
    } else if (m.type === 'sweep') {
      S.data = m; renderSweep(m);
    }
  });
  post({ type: 'ready' });
}

module.exports = { render, pageScript };
