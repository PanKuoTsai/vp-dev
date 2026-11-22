'use strict';
// Run with: node test/trace.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/platform/core');
const os = require('os');
const trace = require('../lib/analysis/trace');
const pin = require('../lib/setup/pin');
const { load } = require('./helpers');

test('trace points: bus-mapped ports of modules that are not replicated, by address', () => {
  const d = load();
  const pts = trace.tracePoints(d);
  const ids = pts.map((p) => p.id);
  assert.ok(ids.includes('pl011_uart_0.target_socket') && ids.includes('virtioblk_0.mem') && ids.includes('gic_0.dist_iface'));
  assert.ok(!ids.some((i) => i.startsWith('cpu')));
  assert.ok(pts.find((p) => p.id === 'ram_0.target_socket').memory);
  assert.ok(!pts.find((p) => p.id === 'pl011_uart_0.target_socket').memory);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i - 1].address <= pts[i].address);
});

test('trace options: a tracer takes the port address, the port is rebound to it', () => {
  const d = load();
  const t = trace.traceOptions(d, ['pl011_uart_0.target_socket', 'ram_0.target_socket'], '/x/vp_sim_agent');
  assert.deepStrictEqual(t.extraModules[0], {
    name: 'trace_pl011_uart_0_target_socket', type: 'tracer', dylib: '/x/vp_sim_agent',
    params: { label: 'pl011_uart_0.target_socket', allow_dmi: false },
    ports: { target_socket: { address: '${UART0}', size: '0x1000', bind: 'router.initiator_socket' } },
  });
  assert.strictEqual(t.extraModules[1].params.allow_dmi, true);
  const lua = core.generate(d, { extraModules: t.extraModules, portOverrides: t.portOverrides });
  assert.ok(lua.includes('platform["trace_pl011_uart_0_target_socket"] = { moduletype = "tracer"; dylib_path = "/x/vp_sim_agent"; label = "pl011_uart_0.target_socket"; allow_dmi = false; target_socket = {address = UART0, size = 0x1000, bind = "&router.initiator_socket"} }'));
  // The traced port keeps its address and size (gs_memory reads its size from them; 2026-11-15
  // a traced fallback_0 stopped the simulator with "Unable to get parameter ...target_socket.size").
  assert.ok(lua.includes('platform["pl011_uart_0"]["target_socket"] = {address = UART0, size = 0x1000, bind = "&trace_pl011_uart_0_target_socket.initiator_socket"}'));
  assert.ok(lua.includes('platform["ram_0"]["target_socket"] = {address = INITIAL_DDR_SPACE, size = 0x100000000, bind = "&trace_ram_0_target_socket.initiator_socket"}'));
  assert.throws(() => trace.traceOptions(d, ['cpu.mem'], '/x'), /cannot be traced/);
});

test('trace records: decoded with point names, little-endian values, CSV', () => {
  // Agent 0.12.0 adds the initiator as a ninth element; older agents send eight.
  const res = { points: ['uart.target_socket'], records: [[7, 1.5, 0, 'R', '0x10000fe0', 4, '11000000', 1, 'cpu_3.mem'], [8, 1.6, 0, 'W', '0x10000000', 1, '41', -2]] };
  const r = trace.decodeRecords(res);
  assert.deepStrictEqual(r[0], { seq: 7, time: 1.5, point: 'uart.target_socket', dir: 'R', address: '0x10000fe0', length: 4, data: '11000000', value: '0x11', status: 'OK', initiator: 'cpu_3.mem' });
  assert.strictEqual(r[1].initiator, '');
  assert.deepStrictEqual([r[1].value, r[1].status], ['0x41', 'ADDRESS_ERROR']);
  assert.strictEqual(trace.leValue('00000000', 4), '0x0');
  assert.strictEqual(trace.leValue('0102030405060708090a', 10), null);
  assert.strictEqual(trace.toCsv(r).split('\n')[0], 'seq,time_s,point,dir,address,length,value,data,status,initiator');
  assert.strictEqual(trace.toCsv(r).split('\n')[1], '7,1.5,uart.target_socket,R,0x10000fe0,4,0x11,11000000,OK,cpu_3.mem');
});

test('trace view renders with a nonce and escapes the title', () => {
  const html = require('../lib/webview/traceview').render('N1', 'vscode-resource:', 'Trace: <x>');
  assert.ok(html.includes("script-src 'nonce-N1'") && html.includes('<title>Trace: &lt;x&gt;</title>'));
  assert.ok(html.includes("post({ type: 'ready' })"));
  // Same look as the platform view: shared tokens, the name and the platform in the header.
  const theme = require('../lib/webview/webtheme');
  assert.ok(html.includes(theme.css.slice(0, 200)) && html.includes('<h1>Trace</h1><span class="tag mono">&lt;x&gt;</span>'));
  const prof = require('../lib/webview/profileview').render('N2', 'x', 'Profile: demo');
  assert.ok(prof.includes(theme.css.slice(0, 200)) && prof.includes('<h1>Profile</h1>'));
  // The controls the extension listens to are all there.
  for (const id of ['record', 'follow', 'clear', 'export', 'vcd', 'pchoose', 'point', 'dir', 'addr', 'bpoint', 'baccess', 'baddr', 'bval', 'bmask', 'badd', 'hit', 'hitcont', 'rows', 'st-total', 'st-probes']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  for (const id of ['cpu', 'sampling', 'reset', 'choose', 'rows', 'hot', 'st-samples', 'warn']) assert.ok(prof.includes(`id="${id}"`), id);
  // A breakpoint stop (with Continue) is outside the scrolling table, so it stays in sight.
  const tmain = html.slice(html.indexOf('id="tmain"'), html.indexOf('</main>'));
  assert.ok(html.includes('id="hit"') && !tmain.includes('id="hit"'));
  // No style attributes (the content security policy would drop them).
  for (const h of [html, prof]) assert.ok(!/<[a-z]+ [^>]*style="/.test(h.replace(/<style[\s\S]*?<\/style>/, '')));
});

test('trace options: bus tracers name their router for agent 0.12.0 (who issued an access)', () => {
  const d = load();
  const t = trace.traceOptions(d, ['pl011_uart_0.target_socket'], '/x/vp_sim_agent', undefined, { router: true });
  assert.strictEqual(t.extraModules[0].params.router, 'router');
  assert.strictEqual(trace.traceOptions(d, ['pl011_uart_0.target_socket'], '/x/vp_sim_agent').extraModules[0].params.router, undefined);
  assert.ok(core.generate(d, { extraModules: t.extraModules, portOverrides: t.portOverrides }).includes('router = "router"'));
});

test('trace view: Initiator column and clickable bus accesses', () => {
  const html = require('../lib/webview/traceview').render('N1', 'vscode-resource:', 'Trace');
  // The page script compiles (a quote escaped for the template, such as \\', breaks the whole panel).
  const scripts = [...html.matchAll(/<script nonce="N1">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1);
  for (const src of scripts) assert.doesNotThrow(() => new Function(src));
  assert.ok(html.includes('<th>Point</th><th title="Who issued the access (sim agent 0.12.0 and later)">Initiator</th><th>Access</th>'));
  assert.ok(html.includes("type: 'showRoute'"));
});

// ------------------------------------------------------------------ G-07: signal tracing

test('signal tracing: which connections, and how the tracer is wired in', () => {
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'ubuntu-aarch64.platform.json'), 'utf8'));
  // QEMU-to-QEMU lines (GIC to CPUs, timers, virtio) are wired inside QEMU and left out.
  const pts = trace.signalPoints(doc, cat);
  assert.deepStrictEqual(pts.map((p) => `${p.id}>${p.dest}.${p.destPort}/${p.declaredBy}`), ['pl011_uart_0.irq>gic_0.spi_in_379/source']);
  assert.deepStrictEqual(trace.signalPoints(doc, undefined), []); // no catalog, no kinds
  // The source declares the binding: it now binds to the tracer, which binds on to the destination.
  const o = trace.traceOptions(doc, ['pl011_uart_0.irq', 'pl011_uart_0.target_socket'], '/a/vp', cat);
  assert.deepStrictEqual(o.extraModules[0], { name: 'trace_sig_pl011_uart_0_irq', type: 'signal_tracer', dylib: '/a/vp', params: { label: 'pl011_uart_0.irq' }, ports: { out: { bind: 'gic_0.spi_in_379' } } });
  assert.deepStrictEqual(o.portOverrides[0], { instance: 'pl011_uart_0', port: 'irq', value: { bind: 'trace_sig_pl011_uart_0_irq.in' } });
  assert.strictEqual(o.extraModules[1].type, 'tracer'); // bus points as before
  const lua = core.generate(doc, o);
  assert.ok(lua.includes('platform["pl011_uart_0"]["irq"] = {bind = "&trace_sig_pl011_uart_0_irq.in"}'));
  assert.ok(lua.includes('platform["trace_sig_pl011_uart_0_irq"] = { moduletype = "signal_tracer"; dylib_path = "/a/vp"; label = "pl011_uart_0.irq"; out = {bind = "&gic_0.spi_in_379"} }'));
  // The destination declares it: the tracer takes the source's place.
  const d2 = JSON.parse(JSON.stringify(doc));
  delete d2.modules.pl011_uart_0.ports.irq;
  d2.modules.gic_0.ports = Object.assign({}, d2.modules.gic_0.ports, { spi_in_379: { bind: 'pl011_uart_0.irq' } });
  const p2 = trace.signalPoints(d2, cat).find((p) => p.id === 'pl011_uart_0.irq');
  assert.strictEqual(p2 && p2.declaredBy, 'dest');
  const o2 = trace.traceOptions(d2, ['pl011_uart_0.irq'], '/a/vp', cat);
  assert.deepStrictEqual(o2.extraModules[0].ports, { in: { bind: 'pl011_uart_0.irq' } });
  assert.deepStrictEqual(o2.portOverrides[0], { instance: 'gic_0', port: 'spi_in_379', value: { bind: 'trace_sig_pl011_uart_0_irq.out' } });
});

test('signal tracing: records and the VCD file', () => {
  const recs = trace.decodeRecords({ points: ['pl011_uart_0.target_socket', 'pl011_uart_0.irq', 'my_dev.irq'], records: [
    [1, 55.867376157, 1, 'S', '0x0', 1, '00', 1],
    [2, 229.126844701, 1, 'S', '0x0', 1, '01', 1],
    [3, 229.134661, 0, 'R', '0x1000003c', 4, '30000000', 1],
    [4, 229.137211123, 1, 'S', '0x0', 1, '00', 1],
    [5, 229.130000000, 2, 'S', '0x0', 1, '01', 1], // reached the store late, from another thread
  ] });
  assert.deepStrictEqual([recs[1].dir, recs[1].value, recs[1].address], ['S', '1', '']);
  assert.strictEqual(recs[2].value, '0x30');
  const vcd = trace.toVcd(recs, { date: 'd' });
  assert.strictEqual(vcd, [
    '$date d $end', '$version VP Studio $end', '$timescale 1ps $end', '$scope module vp $end',
    '$var wire 1 ! my_dev.irq $end', '$var wire 1 " pl011_uart_0.irq $end', '$upscope $end', '$enddefinitions $end',
    '#0', '$dumpvars', '0!', '0"', '$end',
    '#55867376157000', '0"', '#229126844701000', '1"', '#229130000000000', '1!', '#229137211123000', '0"', '',
  ].join('\n'));
  assert.match(trace.toVcd(recs, { initial: 'x', date: 'd' }), /\$dumpvars\nx!\nx"\n\$end/);
  assert.strictEqual(trace.toVcd([], { date: 'd' }).includes('$var'), false);
});

// ------------------------------------------------------------------ G-04: bus breakpoints

test('bus breakpoints: panel input to break.set objects', () => {
  const p = trace.parseBreakInput;
  assert.deepStrictEqual(p({ point: 'pl011_uart_0.target_socket', access: 'w', address: '0x10000000' }),
    { point: 'pl011_uart_0.target_socket', access: 'w', from: '0x10000000', to: '0x10000000' });
  assert.deepStrictEqual(p({ access: 'r', address: ' 0x1c0d0000 - 0x1C0D0FFF ' }), { access: 'r', from: '0x1c0d0000', to: '0x1c0d0fff' });
  assert.deepStrictEqual(p({ point: 'x.p', address: '' }), { point: 'x.p', access: 'rw' }); // the whole point
  assert.deepStrictEqual(p({ access: 'w', address: '4096', value: '0x0a', mask: '0xff' }), { access: 'w', from: '0x1000', to: '0x1000', value: '0xa', mask: '0xff' });
  assert.strictEqual(p({ address: '0x0', value: '0x1', mask: ' ' }).mask, '0xffffffffffffffff'); // empty mask: the whole value
  assert.strictEqual(p({ address: '0x0', value: '10' }).mask, '0xffffffffffffffff');
  assert.strictEqual(p({ address: '0xffffffffffffffff' }).to, '0xffffffffffffffff'); // 64-bit addresses stay exact
  for (const [input, re] of [
    [{ address: '' }, /Fill in the Address of the breakpoint .* or choose a trace point/],
    [{ address: 'abc' }, /Address: enter/],
    [{ address: '0x10000000000000000' }, /Address: enter/],
    [{ address: '0x20-0x10' }, /below its start/],
    [{ address: '0x0', value: 'x' }, /Value: enter/],
    [{ address: '0x0', value: '0x0a/0xff' }, /Value: enter/], // the mask has its own box
    [{ address: '0x0', value: '1', mask: 'x' }, /Mask: enter/],
    [{ address: '0x0', value: '1', mask: '0' }, /Mask: 0 would compare no bit/],
    [{ address: '0x0', mask: '0xff' }, /Mask: give a Value too/],
    [{ address: '0x0', access: 'x' }, /read, write or any/],
  ]) assert.throws(() => p(input), re, JSON.stringify(input));
});

test('bus breakpoints: labels and hit descriptions', () => {
  assert.strictEqual(trace.breakLabel({ id: 2, point: 'pl011_uart_0.target_socket', access: 'w', from: '0x10000000', to: '0x10000000', mask: '0xff', value: '0xa' }),
    '#2 pl011_uart_0.target_socket write 0x10000000 value 0xa mask 0xff');
  assert.strictEqual(trace.breakLabel({ id: 1, point: null, access: 'r', from: '0x1c0d0000', to: '0x1c0d0fff' }), '#1 any point read 0x1c0d0000-0x1c0d0fff');
  assert.strictEqual(trace.breakLabel({ id: 3, point: 'a.b', access: 'rw', from: '0x0', to: '0xffffffffffffffff' }), '#3 a.b access 0x0-0xffffffffffffffff');
  assert.strictEqual(trace.breakLabel({ id: 4, access: 'w', from: '0x4', to: '0x4', value: '0x1', mask: '0xffffffffffffffff' }), '#4 any point write 0x4 value 0x1');
  const hit = { breakpoint: 1, accessesAfter: 3, matchesAfter: 2, record: { seq: 9, point: 'pl011_uart_0.target_socket', rw: 'W', address: '0x10000000', length: 2, data: '5b00' } };
  assert.strictEqual(trace.describeHit(hit),
    'Breakpoint #1: write 0x10000000 = 0x5b on pl011_uart_0.target_socket. The CPUs made 3 more traced accesses before the pause took hold; 2 of them matched a breakpoint too and did not stop it.');
  assert.strictEqual(trace.describeHit({ breakpoint: 2, accessesAfter: 0, matchesAfter: 0, record: { point: 'v.mem', rw: 'R', address: '0x1c0d0000', length: 4, data: '76697274' } }),
    'Breakpoint #2: read 0x1c0d0000 → 0x74726976 on v.mem.');
  // Agent 0.12.0 names who made the access.
  assert.ok(trace.describeHit({ breakpoint: 3, record: { point: 'v.mem', rw: 'W', address: '0x1c0d0070', length: 4, data: '0f000000', initiator: 'cpu_2.mem' } }).includes('on v.mem by cpu_2.mem.'));
});

// ------------------------------------------------------------------ G-12: probes everywhere

test('probes: every place one fits, and which ones record from the start', () => {
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'ubuntu-aarch64.platform.json'), 'utf8'));
  const list = trace.probeList(doc, cat);
  // The bus-mapped ports first (by address), then the signals.
  assert.deepStrictEqual(list.map((p) => p.id), trace.tracePoints(doc).map((p) => p.id).concat(['pl011_uart_0.irq']));
  assert.ok(list.some((p) => p.kind === 'memory') && list.some((p) => p.kind === 'bus'));
  assert.strictEqual(list.find((p) => p.id === 'pl011_uart_0.irq').description, '→ gic_0.spi_in_379 · signal');
  assert.match(list.find((p) => p.id === 'pl011_uart_0.target_socket').description, /^0x10000000 \(0x1000\) · /);
  // recording: each tracer gets "record"; without it the params stay as before (agents before 0.9.0).
  const ids = list.map((p) => p.id);
  const o = trace.traceOptions(doc, ids, '/a/vp', cat, { recording: ['pl011_uart_0.irq'] });
  assert.strictEqual(o.extraModules.length, ids.length);
  const rec = Object.fromEntries(o.extraModules.map((m) => [m.params.label, m.params.record]));
  assert.strictEqual(rec['pl011_uart_0.irq'], true);
  assert.strictEqual(rec['pl011_uart_0.target_socket'], false);
  assert.ok(Object.values(rec).filter(Boolean).length === 1);
  const old = trace.traceOptions(doc, ['pl011_uart_0.target_socket'], '/a/vp', cat);
  assert.ok(!('record' in old.extraModules[0].params));
  // Every probe at once still gives a platform the generator takes.
  const lua = core.generate(doc, o);
  assert.ok(lua.includes('record = false') && lua.includes('record = true'));
});

test('probes: agent version next to the library', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-ver-'));
  try {
    const so = path.join(dir, 'vp_sim_agent.so');
    assert.strictEqual(pin.agentVersion(so), null); // no vp_sim_agent.json
    fs.writeFileSync(path.join(dir, 'vp_sim_agent.json'), JSON.stringify({ qbox: { commit: null } }));
    assert.strictEqual(pin.agentVersion(so), null); // written by an agent before 0.9.0
    fs.writeFileSync(path.join(dir, 'vp_sim_agent.json'), JSON.stringify({ version: '0.9.0', qbox: { commit: null } }));
    assert.strictEqual(pin.agentVersion(so), '0.9.0');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.strictEqual(pin.versionAtLeast('0.9.0', '0.9.0'), true);
  assert.strictEqual(pin.versionAtLeast('0.10.1', '0.9.0'), true);
  assert.strictEqual(pin.versionAtLeast('1.0.0', '0.9.0'), true);
  assert.strictEqual(pin.versionAtLeast('0.8.9', '0.9.0'), false);
  assert.strictEqual(pin.versionAtLeast(null, '0.9.0'), false);
  // The source and build script agree on where the version is written.
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'sim-agent', 'sim_agent.cc'), 'utf8');
  assert.match(src, /^const char\* const AGENT_VERSION = "\d+\.\d+\.\d+";$/m);
});
