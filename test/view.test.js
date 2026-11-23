'use strict';
// Run with: node test/view.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const core = require('../lib/platform/core');
const view = require('../lib/webview/view');
const images = require('../lib/platform/images');
const params = require('../lib/platform/params');
const connect = require('../lib/platform/connect');
const { load, examplePath, workspace, catalog } = require('./helpers');

test('platform view renders and escapes', () => {
  const d = load();
  d.description = '<script>alert(1)</script>';
  const html = view.render(d, core.analyze(d), 'nonce', 'vscode-resource:');
  assert.ok(html.includes('cpu ×8'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('0x80000000'));
});

test('platform view shows the images form', () => {
  const dir = workspace();
  const d = load();
  const a = core.analyze(d);
  const html = view.render(d, a, 'nonce', 'x', images.collect(d, a, dir));
  assert.ok(html.includes('Software images'));
  assert.ok(html.includes('value="${TOP}fw/Artifacts/Image.bin"'));
  assert.ok(html.includes('0x81200000 – 0x81200fff'));
  assert.ok(html.includes('<td>ram_0<span'));
});

test('platform view: parameter panels render, escaped, with input kinds', () => {
  const d = load();
  d.modules.router.params['<x>'] = 'a"b';
  const a = core.analyze(d, { catalog });
  const html = view.render(d, a, 'nonce', 'x', undefined, params.moduleForms(d, a, catalog));
  assert.ok(html.includes('<section class="mod-panel" data-panel="cpu" hidden>'));
  assert.ok(html.includes('<option value="all">all 8 instances</option><option value="0">cpu_0 only</option>'));
  assert.ok(/data-name="has_el3"[\s\S]*?<select class="p-input" data-kind="bool" aria-label[\s\S]*?<option value="false" selected>/.test(html));
  assert.ok(html.includes('value="Lua: ACCEL == &quot;kvm&quot; and &quot;hvc&quot; or &quot;smc&quot;"'));
  assert.ok(html.includes('data-name="&lt;x&gt;"') && !html.includes('<x>'));
  assert.ok(html.includes('overridden for cpu_0'));
  assert.ok(html.includes('<div class="p-scope-body" data-scope="7" hidden>'));
  assert.ok(/data-scope="all">[\s\S]*?data-name="gdb_port"[\s\S]*?disabled title="A QEMU instance has one gdb server/.test(html));
});

test('block diagram: one bar per bus, each selectable, devices under their own bus', () => {
  const d = load();
  d.modules.router_1 = { type: 'router' };
  d.modules.uart1 = { type: 'Pl011', dylib: 'uart-pl011', ports: { target_socket: { address: '0x0', size: '0x1000', bind: 'router_1.initiator_socket' } } };
  const svg = view.diagram(core.analyze(d));
  assert.ok(svg.includes('<g class="node bus" data-module="router"'));
  assert.ok(svg.includes('<g class="node bus" data-module="router_1"'));
  assert.ok(!svg.includes('router, router_1'));
  // uart1 is drawn after (below) the router_1 bar, ram_0 before it.
  const at = (s) => svg.indexOf(s);
  assert.ok(at('data-module="ram_0"') < at('data-module="router_1"') && at('data-module="router_1"') < at('data-module="uart1"'));
  delete d.modules.uart1;
  assert.ok(view.diagram(core.analyze(d)).includes('router_1 (bus) — nothing connected yet'));
});

test('platform view: roles, summary strip, outline and header actions', () => {
  assert.strictEqual(view.cpuLabel('cpu_arm_cortexA76'), 'Cortex-A76');
  assert.strictEqual(view.cpuLabel('cpu_arm_neoverseN2'), 'Neoverse N2');
  assert.strictEqual(view.fmtAddr(0x80000000n), '0x8000_0000');
  assert.strictEqual(view.fmtAddr(0x400000000n), '0x4_0000_0000');
  assert.strictEqual(view.fmtAddr(0n), '0x0');
  const role = (type, extra = {}) => view.roleOf(Object.assign({ type }, extra));
  assert.deepStrictEqual(['cpu_arm_cortexA53', 'gs_memory', 'arm_gicv3', 'qemu_gpex', 'loader', 'router', 'QemuInstance'].map((t) => role(t)),
    ['compute', 'memory', 'irq', 'pcie', 'boot', 'bus', 'infra']);
  assert.strictEqual(role('Pl011', { target: true }), 'periph');
  assert.strictEqual(role('Container', { subsystem: true }), 'subsystem');
  const d = load();
  const a = core.analyze(d, { catalog });
  const gs = view.groups(a);
  const s = view.summary(d, a, gs);
  const by = Object.fromEntries(s.map((x) => [x.label, x]));
  assert.strictEqual(by.Compute.value, '8 × Cortex-A76');
  assert.strictEqual(by.Memory.value, '4 GiB');
  assert.strictEqual(by.Memory.sub, '@ 0x8000_0000');
  assert.strictEqual(by['Address map'].value, '11 regions');
  assert.strictEqual(by.Interrupts.value, 'arm_gicv3 · 960 SPI');
  assert.strictEqual(by.Interrupts.sub, '4 sources wired');
  assert.strictEqual(by['Host ports'].value, 'ssh 2222');
  const html = view.render(d, a, 'nonce', 'x', undefined, params.moduleForms(d, a, catalog), { connections: new Map() });
  // Interrupt numbers on the blocks, CPUs as one block with core tiles, modules by role on the left.
  assert.ok(html.includes('>SPI 379</text>') && html.includes('>SPI 541–544</text>'));
  assert.strictEqual((html.match(/class="core"/g) || []).length, 8);
  assert.ok(/class="ol-item role-periph" data-module="pl011_uart_0"/.test(html));
  assert.ok(html.includes('data-command="start"') && html.includes('data-command="generate"'));
  assert.ok(html.includes('Valid · no problems'));
  // Each module's inspector has the parameter and connection tabs and its facts.
  assert.ok(/data-panel="pl011_uart_0"[\s\S]*?<div class="fact-k">Interrupt<\/div><div class="fact-v mono" title="pl011_uart_0.irq → gic_0.spi_in_379">SPI 379</.test(html));
  // The badge's tooltip lists every line; each core tile is one instance.
  assert.ok(html.includes('<title>gpex_0.irq_out_0 → gic_0.spi_in_541\ngpex_0.irq_out_1 → gic_0.spi_in_542'));
  assert.ok(html.includes('<rect class="core" data-index="3"'));
  // Address lookup: the region data is embedded and the lookup runs in the webview.
  assert.ok(html.includes('id="vp-regions"') && html.includes('function lookupAddress('));
  assert.ok(/data-panel="cpu"[\s\S]*?data-tab="params"[\s\S]*?data-tab="conns"/.test(html));
});

test('platform view: address lookup picks the region that answers on each bus', () => {
  const a = core.analyze(load());
  const hit = view.lookupAddress(a.memoryMap, view.parseAddress('0x1000_0010'));
  assert.strictEqual(hit.length, 1);
  assert.strictEqual(hit[0].bus, 'router');
  assert.strictEqual(hit[0].hit.instance, 'pl011_uart_0');
  assert.strictEqual(hit[0].hit.offset, 0x10n);
  // The UART shadows the background memory, which maps everything below 32 GiB.
  assert.deepStrictEqual(hit[0].shadowed.map((r) => r.instance), ['fallback_0']);
  assert.strictEqual(view.lookupAddress(a.memoryMap, 0x8000_0000n)[0].hit.instance, 'ram_0');
  assert.deepStrictEqual(view.lookupAddress(a.memoryMap, 0x9_0000_0000n), []);
  assert.strictEqual(view.parseAddress('268435472'), 0x10000010n);
  assert.strictEqual(view.parseAddress('ram'), null);
});

test('platform view: signal layer draws interrupt and stream lines between blocks', () => {
  const d = load();
  const svg = view.diagram(core.analyze(d));
  const edges = [...svg.matchAll(/<g class="sig sig-(\w+)" data-a="([^"]+)" data-b="([^"]+)">([\s\S]*?)<\/g>/g)]
    .map((m) => ({ kind: m[1], a: m[2], b: m[3], label: (/<text[^>]*>([^<]*)<\/text>/.exec(m[4]) || [])[1] || '', both: m[4].includes('marker-start') }));
  const by = (a, b) => edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
  // Interrupts into the GIC: one line per device, no label (the number is on the device's block).
  assert.deepStrictEqual(['pl011_uart_0', 'virtioblk_0', 'virtionet0_0', 'gpex_0'].map((m) => [by(m, 'gic_0').kind, by(m, 'gic_0').label]), [['irq', ''], ['irq', ''], ['irq', ''], ['irq', '']]);
  // GIC and the 8 CPUs: one line both ways.
  const gc = by('gic_0', 'cpu');
  assert.ok(gc.both && /^irq ×\d+ ⇄ ×\d+$/.test(gc.label), JSON.stringify(gc));
  // The UART's console is a byte stream to a block that is on no bus.
  assert.strictEqual(by('pl011_uart_0', 'charbackend_stdio_0').kind, 'stream');
  // A collapsed subsystem is one end for everything inside it.
  const rs = require('../lib/platform/restructure');
  const text = fs.readFileSync(examplePath, 'utf8');
  const g = JSON.parse(rs.groupText(text, rs.groupPlan(JSON.parse(text), ['pl011_uart_0', 'virtioblk_0'], 'periph')));
  const svg2 = view.diagram(core.analyze(g), new Set(['periph']));
  assert.ok(svg2.includes('data-a="periph" data-b="gic_0"') || svg2.includes('data-a="gic_0" data-b="periph"'));
  assert.ok(!svg2.includes('data-a="periph.pl011_uart_0"'));
  // Subsystem blocks carry their own collapse / expand button.
  assert.ok(svg2.includes('<g class="sub-toggle" data-module="periph" tabindex="0" role="button" aria-label="Expand subsystem periph">'));
  assert.ok(view.diagram(core.analyze(g)).includes('aria-label="Collapse subsystem periph"'));
  // The subsystem's own (Container) parameters are folded into an advanced block; other modules' are not.
  const ag = core.analyze(g, { catalog });
  const html2 = view.render(g, ag, 'n', 'x', undefined, params.moduleForms(g, ag, catalog), { connections: new Map() });
  assert.ok(/data-panel="periph" hidden>[\s\S]*?<details class="advanced" data-panel="periph"><summary>Advanced: Container settings/.test(html2));
  assert.ok(!/data-panel="gic_0" hidden>(?:(?!<\/section>)[\s\S])*?<details class="advanced"/.test(html2));
  // The toolbar switches the layer between the selected block, all lines, and off.
  const html = view.render(d, core.analyze(d), 'n', 'x');
  assert.ok(['selected', 'all', 'off'].every((m) => html.includes(`data-sig="${m}"`)));
});

test('platform view: replace and multiple selection controls', () => {
  const d = load();
  const a = core.analyze(d, { catalog });
  const html = view.render(d, a, 'n', 'x', undefined, params.moduleForms(d, a, catalog), { connections: new Map() });
  assert.ok(html.includes('<button class="swap-module" data-module="pl011_uart_0"'));
  assert.ok(html.includes('class="group-modules primary"') && html.includes("post({type:'groupModules',modules:ms})"));
});

test('summary strip: dividers drawn per figure, not by showing the border color', () => {
  const { css } = require('../lib/webview/webtheme');
  const stats = /\.stats\{[^}]*\}/.exec(css)[0];
  // An empty cell at the end of a wrapped row showed the border color: a bright block in high-contrast themes.
  assert.ok(!/background:var\(--vp-border\)/.test(stats), stats);
  assert.ok(/\.stat\{[^}]*box-shadow:[^}]*var\(--vp-border\)/.test(css));
});

test('view: transaction route (Data flow rows, address lookup, a route sent by the trace panel)', () => {
  const d = load();
  const a = core.analyze(d, { catalog });
  const forms = params.moduleForms(d, a, catalog);
  const connections = new Map([...forms.keys()].map((b) => [b, connect.portRows(d, catalog, b)]));
  const spec = { region: 'pl011_uart_0.target_socket', initiator: 'cpu_3.mem', detail: 'write 0x10000000 · "quoted" <b>' };
  const html = view.render(d, a, 'nonce', 'x', undefined, forms, { connections, route: { id: 4, spec } });
  // The route table for the page, and the route bar above the diagram.
  const json = /<script type="application\/json" id="vp-routes">([^<]*)<\/script>/.exec(html);
  assert.ok(json && JSON.parse(json[1]).regions['pl011_uart_0.target_socket']);
  assert.ok(html.includes('<div class="route-bar"'));
  assert.ok(html.includes('function routeFor('));
  // The route the trace panel sent goes into the page, escaped.
  const m = /data-route="([^"]*)"/.exec(html);
  const back = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  assert.deepStrictEqual(back, { id: 4, spec });
  assert.ok(!html.includes('<b>'));
  // Data flow rows of the CPU carry the route from the CPU; the router's from no initiator.
  const panel = (mod) => { const i = html.indexOf(`<section class="mod-panel" data-panel="${mod}"`); return html.slice(i, html.indexOf('</section>', i)); };
  assert.ok(panel('cpu').includes('data-route-region="pl011_uart_0.target_socket" data-route-from="cpu" data-route-bus="router"'));
  assert.ok(panel('router').includes('data-route-region="pl011_uart_0.target_socket" data-route-bus="router"'));
  // A device's "Reached from": each initiator chip previews its route.
  assert.ok(panel('pl011_uart_0').includes('data-route-region="pl011_uart_0.target_socket" data-route-from="cpu"'));
  // The diagram has the arrow for the route line; still no style attributes (CSP).
  assert.ok(html.includes('id="vp-arrow-route"'));
  assert.ok(!/<[^>]+\sstyle=/.test(html.replace(/<html style='[^']*'/, '')));
  // Without a route, no data-route attribute.
  assert.ok(!/data-route="/.test(view.render(d, a, 'nonce', 'x', undefined, forms, { connections })));
});

test('view: Transactions tab in the dock, and the page script compiles', () => {
  const d = load();
  const a = core.analyze(d, { catalog });
  const forms = params.moduleForms(d, a, catalog);
  const connections = new Map([...forms.keys()].map((b) => [b, connect.portRows(d, catalog, b)]));
  const html = view.render(d, a, 'nonce', 'x', undefined, forms, { connections, route: { id: 1, spec: { region: 'ram_0.target_socket', detail: 'a\nb "c"' } } });
  assert.ok(html.includes('<button class="dtab" role="tab" data-dock="tx">Transactions<span class="count tx-count">–</span></button>'));
  assert.ok(html.includes('<div class="dock-body" data-dock="tx" hidden>'));
  assert.ok(html.includes('<tbody class="tx-rows"></tbody>'));
  // The tab asks the extension for records while it is shown (txWatch); its buttons run only allowed commands.
  assert.ok(html.includes("post({type:'txWatch',on})"));
  for (const c of ['probes', 'trace']) assert.ok(html.includes(`class="run-cmd" data-command="${c}"`));
  // The route bar sits in the toolbar (it must not push the diagram down when it appears).
  const tb = html.indexOf('<div class="toolbar">');
  assert.ok(html.indexOf('<div class="route-bar"') > tb && html.indexOf('<div class="route-bar"') < html.indexOf('<div class="canvas">'));
  // Every inline script compiles (a slip in the template, such as a bare \n in a string, breaks the whole page).
  const scripts = [...html.matchAll(/<script nonce="nonce">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1);
  for (const src of scripts) assert.doesNotThrow(() => new Function(src));
});

test('webviews: the scripts of the profile and CPU register pages compile', () => {
  const exc = require('../lib/webview/excview').render('N2', 'x', 'Exceptions & Interrupts: p', require('../lib/debug/exceptions').CATCH);
  assert.ok(!/ style="/.test(exc));
  const gicPage = require('../lib/webview/gicview').render('N2', 'x', 'Interrupts (GIC): p');
  assert.ok(!/ style="/.test(gicPage));
  const mmuPage = require('../lib/webview/mmuview').render('N2', 'x');
  assert.ok(!/ style="/.test(mmuPage));
  assert.ok(mmuPage.includes('.seg.b64{flex-grow:64}'));
  for (const html of [require('../lib/webview/profileview').render('N2', 'x', 'Profile'), require('../lib/webview/cpuregsview').render('N2', 'x'), exc, gicPage, mmuPage]) {
    const scripts = [...html.matchAll(/<script nonce="N2">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length >= 1);
    for (const src of scripts) assert.doesNotThrow(() => new Function(src));
  }
});

test('view: Socket Inspector and Data flow tab in the inspector', () => {
  const d = load();
  const a = core.analyze(d, { catalog });
  const forms = params.moduleForms(d, a, catalog);
  const connections = new Map([...forms.keys()].map((b) => [b, connect.portRows(d, catalog, b)]));
  const html = view.render(d, a, 'nonce', 'x', undefined, forms, { connections });
  const panel = (m) => { const i = html.indexOf(`<section class="mod-panel" data-panel="${m}"`); return html.slice(i, html.indexOf('</section>', i)); };
  // The router's initiator socket lists its targets with their addresses, in address order.
  const router = panel('router');
  assert.match(router, /data-tab="flow">Data flow/);
  const conns = router.slice(router.indexOf('data-tab="conns" hidden'));
  assert.match(conns, /dir-init[^>]*>▼ Initiator/);
  assert.ok(conns.indexOf('fallback_0.target_socket') < conns.indexOf('pl011_uart_0.target_socket'));
  assert.ok(conns.indexOf('pl011_uart_0.target_socket') < conns.indexOf('ram_0.target_socket'));
  assert.match(conns, /0x1000_0000 – 0x1000_0FFF · 4 KiB/);
  // Every connection keeps its Disconnect button with the data the extension needs.
  assert.match(conns, /class="unbind x" data-module="pl011_uart_0" data-key="target_socket" data-scope=""/);
  // The CPU: bus first, then signals; unused ports folded away.
  const cpu = panel('cpu');
  assert.ok(cpu.indexOf('c-group-h">Bus') < cpu.indexOf('c-group-h">Signals'));
  assert.match(cpu, /<details class="c-free"><summary>\d+ unconnected ports<\/summary>/);
  assert.match(cpu, /class="connect" data-module="cpu" data-port="halt"/);
  // Data flow: the CPU reaches the UART; the UART is reached from the CPUs.
  assert.match(cpu, /<span class="mono">mem<\/span> ×8/);
  assert.match(cpu, /data-module="pl011_uart_0">pl011_uart_0\.target_socket/);
  assert.match(panel('pl011_uart_0'), /Reached from[\s\S]*cpu\.mem ×8/);
  // Modules without bus traffic get no Data flow tab; nothing uses style attributes (CSP).
  assert.doesNotMatch(panel('charbackend_stdio_0'), /data-tab="flow"/);
  assert.doesNotMatch(html, /<[a-z][^>]*\sstyle="/i);
});
