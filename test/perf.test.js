'use strict';
// Run with: node test/perf.test.js (every file: npm test)
const { test, testAsync } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/platform/core');
const os = require('os');
const { load, extensionSource } = require('./helpers');

const PERF_STATS = {
  format: 'vp-perf-stats', version: 1, complete: true, simTimeNs: 1000000,
  initiators: [
    { name: 'platform.cpu', label: 'cpu', issued: 10, reads: 7, writes: 3, bytes: 640, bandwidthMBps: 812.5, latencyNs: { count: 10, mean: 95, p50: 90, p99: 180, max: 200, histogram: { upperNs: [100, 200], counts: [8, 2] } }, done: true },
    { name: 'platform.sub.display', label: 'display', issued: 4, reads: 4, writes: 0, bytes: 256, bandwidthMBps: 3000, latencyNs: { count: 4, mean: 50, p50: 50, p99: 60, max: 60 }, done: true },
  ],
  buses: [{ name: 'platform.bus', requestBusyNs: 10, responseBusyNs: 20, requestUtilization: 0.01, responseUtilization: 0.02, waitNs: { cpu: { count: 10, mean: 3, p99: 9 } } }],
  memories: [{ name: 'platform.ddr', reads: 11, writes: 3, bytes: 896, rowHits: 6, rowMisses: 4, rowConflicts: 4, rowHitRate: 0.43, refreshes: 128, dataBusyNs: 50, dataBusUtilization: 0.25, bandwidthMBps: 0.9, serviceNs: { count: 14, mean: 40, p99: 70 } }],
};

test('perf: at_bus is a bus for the view, not for the agent and probes; only traffic_gen may bind to it', () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'ddr-contention.platform.json'), 'utf8'));
  const a = core.analyze(d);
  assert.deepStrictEqual(a.buses, ['bus']);
  assert.deepStrictEqual(a.routers, []);
  assert.deepStrictEqual(a.problems, []);
  assert.deepStrictEqual(a.memoryMap.map((r) => [r.instance, r.bus]), [['ddr', 'bus']]);
  assert.strictEqual(require('../lib/analysis/trace').tracePoints(d).length, 0);
  assert.strictEqual(require('../lib/platform/dataflow').hasDataFlow(a, 'cpu'), true);
  // The connect flow treats at_bus like a router: the device end writes the binding.
  assert.strictEqual(require('../lib/platform/connect').declaringEnd(d, 'ddr', 'bus'), 'a');
  // A QEMU-style initiator on an at_bus is flagged.
  const bad = JSON.parse(JSON.stringify(d));
  bad.modules.load = { type: 'loader', ports: { initiator_socket: { bind: 'bus.target_socket' } } };
  assert.ok(core.analyze(bad).problems.some((p) => /takes approximately-timed initiators only/.test(p.message) && p.severity === 'warning'));
  // The two-channel example: two DRAM controllers, each 512 MiB, on the same bus; its sweep fits it.
  const d2 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'ddr-2ch.platform.json'), 'utf8'));
  const a2 = core.analyze(d2, { catalog: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8')) });
  assert.deepStrictEqual(a2.problems, []);
  assert.deepStrictEqual(a2.memoryMap.map((r) => [r.instance, Number(r.start), Number(r.size)]), [['ddr0', 0, 0x20000000], ['ddr1', 0x20000000, 0x20000000]]);
  const sw2 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'ddr-2ch.perfsweep.json'), 'utf8'));
  assert.deepStrictEqual(require('../lib/analysis/perf').checkSweep(sw2, d2), []);
  // Each generator stays in its channel.
  const inCh = (g, base) => { const p = d2.modules[g].params; return Number(p.address) >= base && Number(p.address) + Number(p.size) <= base + 0x20000000; };
  assert.ok(inCh('display', 0) && inCh('dma', 0x20000000) && inCh('cpu', 0x20000000));
  // Two DDRs, each behind its own MAU with QoS; every example file is copied by Create Performance Example.
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
  const d3 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'mau-2ddr.platform.json'), 'utf8'));
  const a3 = core.analyze(d3, { catalog: cat });
  assert.deepStrictEqual(a3.problems, []);
  assert.deepStrictEqual(a3.memoryMap.map((r) => [r.instance, Number(r.start), Number(r.size)]), [['ddr0', 0, 0x80000000], ['ddr1', 0x80000000, 0x60000000]]);
  assert.deepStrictEqual(a3.buses.map((b) => b.name || b).sort(), ['mau0', 'mau1']);
  const sw3 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'mau-qos.perfsweep.json'), 'utf8'));
  assert.deepStrictEqual(require('../lib/analysis/perf').checkSweep(sw3, d3), []);
  const ext = extensionSource();
  const listed = JSON.parse(/const PERF_EXAMPLES = (\[[^\]]*\]);/.exec(ext)[1].replace(/'/g, '"'));
  assert.deepStrictEqual(listed.slice().sort(), fs.readdirSync(path.join(__dirname, '..', 'examples', 'perf')).filter((f) => f.endsWith('.json')).sort());
  // The Ubuntu example: routers and buses are the same.
  const u = core.analyze(load());
  assert.deepStrictEqual(u.routers, u.buses);
  // The generated Lua loads the perf library for every perf module.
  const lua = core.generate(d);
  assert.strictEqual((lua.match(/dylib_path = "perf"/g) || []).length, 6);
  // The schema accepts the example and the sweep.
  // Only with ajv 8: the platform schema is draft 2020-12 (ajv/dist/2020), the sweep schema draft-07 (ajv).
  // The ajv 6 that ESLint installs has no ajv/dist/2020 and cannot read the platform schema.
  const Ajv = (() => { try { return { draft2020: require('ajv/dist/2020'), draft7: require('ajv') }; } catch (e) { return null; } })();
  if (Ajv) {
    const ajv = new Ajv.draft2020({ allErrors: true, strict: false });
    assert.ok(ajv.validate(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'qbox-platform.schema.json'), 'utf8')), d), JSON.stringify(ajv.errors));
    const sw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'cpu-outstanding.perfsweep.json'), 'utf8'));
    const ajv7 = new Ajv.draft7({ allErrors: true, strict: false });
    assert.ok(ajv7.validate(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'vp-perfsweep.schema.json'), 'utf8')), sw), JSON.stringify(ajv7.errors));
  }
});

test('perf: statistics, metric paths, sweeps, checks and CSV', () => {
  const perf = require('../lib/analysis/perf');
  assert.throws(() => perf.parseStats('{"a":1}'), /not a VP Studio perf statistics file/);
  const st = perf.parseStats(JSON.stringify(PERF_STATS));
  assert.strictEqual(perf.metric(st, 'initiators.cpu.latencyNs.p99'), 180);
  assert.strictEqual(perf.metric(st, 'initiator.display.bandwidthMBps'), 3000);       // singular section name
  assert.strictEqual(perf.metric(st, 'initiators.sub.display.bandwidthMBps'), 3000);  // a name with a dot
  assert.strictEqual(perf.metric(st, 'memories.ddr.rowHitRate'), 0.43);
  assert.strictEqual(perf.metric(st, 'buses.bus.waitNs.cpu.p99'), 9);
  assert.strictEqual(perf.metric(st, 'simTimeNs'), 1000000);
  assert.strictEqual(perf.metric(st, 'initiators.gpu.bandwidthMBps'), undefined);
  assert.strictEqual(perf.metric(st, 'initiators.cpu.latencyNs'), undefined); // not a number
  const all = perf.listMetrics(st);
  assert.ok(all.includes('initiators.cpu.latencyNs.p99') && all.includes('memories.ddr.dataBusUtilization') && all.includes('buses.bus.waitNs.cpu.p99'));
  assert.ok(!all.some((m) => /histogram|\.name$|\.label$/.test(m)));
  const sm = perf.summary(st);
  assert.deepStrictEqual(sm.initiators.map((g) => [g.label, g.p99]), [['cpu', 180], ['display', 60]]);
  assert.deepStrictEqual(sm.memories[0].label, 'ddr');
  assert.match(perf.runCsv(st), /^kind,name,.*\ninitiator,cpu,7,3,640,812\.5,95,90,180,200,,\n/);

  // Sweeps.
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'ddr-contention.platform.json'), 'utf8'));
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'cpu-outstanding.perfsweep.json'), 'utf8'));
  assert.deepStrictEqual(perf.checkSweep(spec, d), []);
  assert.strictEqual(perf.runCount(spec), 12);
  const runs = perf.expandSweep(spec);
  assert.strictEqual(runs.length, 12);
  assert.deepStrictEqual(runs[0].values, { 'ddr.scheduler': 'fr_fcfs', 'cpu.max_outstanding': 1 });
  assert.deepStrictEqual(runs[10].overrides, [{ instance: 'ddr', param: 'scheduler', value: 'fcfs' }, { instance: 'cpu', param: 'max_outstanding', value: 16 }]);
  assert.strictEqual(perf.runLabel(runs[10].values), 'ddr.scheduler=fcfs, cpu.max_outstanding=16');
  assert.deepStrictEqual(perf.splitParam('periph.dma.rate_mbps'), { instance: 'periph.dma', param: 'rate_mbps' });
  assert.throws(() => perf.splitParam('rate'), /<module>\.<parameter>/);
  const bad = perf.checkSweep({ sweep: [{ param: 'gpu.x', values: [] }], checks: [{ metric: 'a' }, { metric: 'b', min: 1, where: { 'z.y': 1 } }] }, d);
  assert.ok(bad.some((p) => /no module gpu/.test(p)) && bad.some((p) => /non-empty list/.test(p)) && bad.some((p) => /give "min", "max"/.test(p)) && bad.some((p) => /does not vary/.test(p)));
  assert.match(perf.checkSweep({}, d)[0], /"sweep" must list/);

  // Lua for one run: the overrides and the statistics file; a perf_stats is added when there is none.
  const lua = perf.runLua(d, { overrides: runs[10].overrides, outFile: '/tmp/x/run-9.json' });
  assert.ok(lua.includes('platform["ddr"]["scheduler"] = "fcfs"') && lua.includes('platform["cpu"]["max_outstanding"] = 16'));
  assert.ok(lua.includes('platform["stats"]["output"] = "/tmp/x/run-9.json"') && lua.includes('platform["stats"]["stop_when_done"] = true'));
  const noStats = JSON.parse(JSON.stringify(d));
  delete noStats.modules.stats;
  assert.match(perf.runLua(noStats, { outFile: '/o.json' }), /platform\["perf_stats"\] = \{ moduletype = "perf_stats"; dylib_path = "perf"; output = "\/o\.json"; stop_when_done = true \}/);

  // Checks and CSV over results.
  const results = {
    sweep: [{ param: 'bus.arbitration', values: ['round_robin', 'priority'] }, { param: 'cpu.max_outstanding', values: [1, 2, 4] }],
    runs: [
      { index: 0, values: { 'bus.arbitration': 'priority', 'cpu.max_outstanding': 1 }, label: 'p1', ok: true, metrics: { 'initiators.display.bandwidthMBps': 2950.5 } },
      { index: 1, values: { 'bus.arbitration': 'priority', 'cpu.max_outstanding': 2 }, label: 'p2', ok: true, metrics: { 'initiators.display.bandwidthMBps': 2800 } },
      { index: 2, values: { 'bus.arbitration': 'round_robin', 'cpu.max_outstanding': 2 }, label: 'r2', ok: true, metrics: { 'initiators.display.bandwidthMBps': 100 } },
      { index: 3, values: { 'bus.arbitration': 'priority', 'cpu.max_outstanding': 4 }, label: 'p4', ok: false, error: 'timed out', metrics: {} },
    ],
  };
  const cr = perf.evaluateChecks(results, [{ metric: 'initiators.display.bandwidthMBps', min: 2900, where: { 'bus.arbitration': 'priority' } }]);
  assert.deepStrictEqual(cr.map((c) => c.ok), [true, false, false]); // round_robin is skipped by "where"
  assert.match(cr[1].message, /2800 \(expected >= 2900\)/);
  assert.match(cr[2].message, /run failed: timed out/);
  const csv = perf.resultsCsv(results).split('\n');
  assert.strictEqual(csv[0], 'run,bus.arbitration,cpu.max_outstanding,ok,initiators.display.bandwidthMBps,error');
  assert.strictEqual(csv[4], '3,priority,4,false,,timed out');
  assert.strictEqual(perf.fmt(2950.5), '2951');
  assert.strictEqual(perf.fmt(0.4321), '0.432');
  assert.match(perf.resultsDir('/w/a.perfsweep.json', new Date('2026-11-21T08:09:10Z')), /\/w\/perf-results\/a-20261121-080910$/);
  const tpl = perf.sweepTemplate(d, 'ddr-contention.platform.json');
  assert.deepStrictEqual(tpl.sweep.map((s) => s.param), ['cpu.max_outstanding', 'bus.arbitration']);
  assert.deepStrictEqual(perf.checkSweep(tpl, d), []);
});

test('perf: at_bus QoS per master (masters): parsing, checks, sweeps and statistics', () => {
  const qos = require('../lib/analysis/qos');
  const perf = require('../lib/analysis/perf');
  const core = require('../lib/platform/core');
  // The text perf.so reads.
  const p = qos.parseMasters('display: priority=3 min_mbps=6000;\n cpu@ddr0: max_mbps=8000, outstanding=8 ; ');
  assert.deepStrictEqual(p.errors, []);
  assert.deepStrictEqual(p.entries, [
    { name: 'display', settings: { priority: 3, min_mbps: 6000 } },
    { name: 'cpu@ddr0', settings: { max_mbps: 8000, outstanding: 8 } }]);
  assert.strictEqual(qos.formatMasters(p.entries), 'display: priority=3 min_mbps=6000; cpu@ddr0: max_mbps=8000 outstanding=8');
  assert.deepStrictEqual(qos.parseMasters('a: speed=1; b min=2; c: max_mbps=x; d: outstanding=-1').errors, [
    'a: unknown key speed (priority, max_mbps, min_mbps, outstanding, window_ns)', '"b min=2" is not <master>: key=value ...',
    'c: max_mbps needs a number, got "x"', 'd: outstanding cannot be negative']);
  assert.strictEqual(qos.setMaster('display: priority=3', 'display', 'min_mbps', 6000), 'display: priority=3 min_mbps=6000');
  assert.strictEqual(qos.setMaster('display: priority=3', 'cpu', 'max_mbps', '7000'), 'display: priority=3; cpu: max_mbps=7000');
  assert.throws(() => qos.setMaster('', 'cpu', 'speed', 1), /unknown QoS key speed/);
  assert.deepStrictEqual(qos.qosPath('mau0.masters.display.min_mbps'), { instance: 'mau0', master: 'display', key: 'min_mbps' });
  assert.deepStrictEqual(qos.qosPath('soc.mau0.masters.cpu@ddr0.priority'), { instance: 'soc.mau0', master: 'cpu@ddr0', key: 'priority' });
  assert.strictEqual(qos.qosPath('mau0.masters'), null);
  assert.strictEqual(qos.qosPath('mau0.masters.display.speed'), null);
  assert.ok(qos.matches('dma', 'periph.dma', 'dma') && qos.matches('periph.dma', 'periph.dma', 'x') && !qos.matches('ma', 'periph.dma', 'x'));

  // Two DDRs behind their own MAU (at_bus + dram_ctrl).
  const gen = (address, bus, extra) => ({ type: 'traffic_gen', dylib: 'perf', params: Object.assign({ address, count: 0, duration_ns: 1000 }, extra), ports: { initiator_socket: { bind: bus + '.target_socket' } } });
  const doc = { schemaVersion: '0.2', name: 'mau', platform: { moduletype: 'Container' }, modules: {
    display: gen('0x0', 'mau0'), cpu_ddr0: gen('0x40000000', 'mau0', { label: 'cpu@ddr0' }), dma: gen('0x80000000', 'mau1'),
    mau0: { type: 'at_bus', dylib: 'perf', params: { arbitration: 'priority', masters: 'display: min_mbps=6000; cpu@ddr0: max_mbps=7000' } },
    mau1: { type: 'at_bus', dylib: 'perf', params: {} },
    ddr0: { type: 'dram_ctrl', dylib: 'perf', params: { qos: true }, ports: { target_socket: { address: '0x0', size: '0x80000000', bind: 'mau0.initiator_socket' } } },
    ddr1: { type: 'dram_ctrl', dylib: 'perf', ports: { target_socket: { address: '0x80000000', size: '0x60000000', bind: 'mau1.initiator_socket' } } },
  } };
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
  assert.deepStrictEqual(core.analyze(doc, { catalog: cat }).problems, []);
  const bad = JSON.parse(JSON.stringify(doc));
  bad.modules.mau0.params = { masters: 'display: priority=2 bogus=1; dma: max_mbps=1; cpu_ddr0: outstanding=4; cpu@ddr0: priority=1' };
  assert.deepStrictEqual(core.analyze(bad).problems.map((x) => `${x.severity} ${x.module}: ${x.message}`), [
    'error mau0: mau0.masters: display: unknown key bogus (priority, max_mbps, min_mbps, outstanding, window_ns)',
    'warning mau0: mau0.masters: display has a priority, which is used only with "arbitration": "priority"',
    'warning mau0: mau0.masters: dma is not a traffic_gen whose accesses reach mau0 (display, cpu_ddr0); its settings are not used',
    'warning mau0: mau0.masters: cpu@ddr0 has a priority, which is used only with "arbitration": "priority"',
    'warning mau0: mau0.masters: cpu_ddr0 matches cpu_ddr0 and cpu@ddr0; only the first is used']);

  // Sweeping one QoS value: folded into the bus's masters text, starting from the platform's.
  const spec = { platform: 'x', sweep: [{ param: 'mau0.masters.cpu@ddr0.max_mbps', values: [4000, 8000] }, { param: 'mau0.masters.dma2.priority', values: [1] }] };
  assert.deepStrictEqual(perf.checkSweep(spec, doc), []);
  assert.deepStrictEqual(perf.checkSweep({ platform: 'x', sweep: [{ param: 'ddr0.masters.display.priority', values: [1] }, { param: 'nope.masters.a.priority', values: [1] }] }, doc), [
    'sweep[0]: ddr0 is a dram_ctrl; QoS settings (masters) belong to an at_bus', 'sweep[1]: the platform has no module nope']);
  const run = perf.expandSweep(spec)[1];
  assert.deepStrictEqual(perf.foldQos(doc, run.overrides), [
    { instance: 'mau0', param: 'masters', value: 'display: min_mbps=6000; cpu@ddr0: max_mbps=8000; dma2: priority=1' }]);
  // vp-run --param: a plain masters text first, then one value; other parameters pass through.
  assert.deepStrictEqual(perf.foldQos(doc, [{ instance: 'mau0', param: 'masters', value: 'display: priority=1' }, { instance: 'mau0.masters.display', param: 'max_mbps', value: 100 }, { instance: 'ddr0', param: 'qos', value: false }]), [
    { instance: 'mau0', param: 'masters', value: 'display: priority=1 max_mbps=100' }, { instance: 'ddr0', param: 'qos', value: false }]);
  const lua = perf.runLua(doc, { overrides: run.overrides, outFile: '/tmp/s.json' });
  assert.ok(lua.includes('platform["mau0"]["masters"] = "display: min_mbps=6000; cpu@ddr0: max_mbps=8000; dma2: priority=1"'), lua);

  // Statistics from perf 1.1.0 carry each master's bandwidth, settings and effect per bus.
  const stats = { format: 'vp-perf-stats', version: 1, complete: true, simTimeNs: 1000, initiators: [], memories: [], buses: [{
    name: 'platform.mau0', requestUtilization: 0.4, responseUtilization: 0.97, waitNs: { display: { count: 2, mean: 1, p99: 3 } },
    masters: { display: { bytes: 128, bandwidthMBps: 6000, grants: 2, urgentGrants: 2, limitedGrants: 0, limitWaitNs: 0, responseWaitNs: { count: 2, mean: 5, p99: 53.75 }, qos: 'min_mbps=6000' } } }] };
  assert.deepStrictEqual(perf.summary(stats).buses[0].masters, [{ label: 'display', qos: 'min_mbps=6000', bandwidthMBps: 6000, grants: 2, urgentGrants: 2, limitedGrants: 0, limitWaitNs: 0, waitP99: 3, responseWaitP99: 53.75 }]);
  assert.strictEqual(perf.metric(stats, 'buses.mau0.masters.display.urgentGrants'), 2);
  assert.strictEqual(perf.metric(stats, 'buses.mau0.masters.display.responseWaitNs.p99'), 53.75);
  assert.ok(perf.listMetrics(stats).includes('buses.mau0.masters.display.bandwidthMBps'));
});

test('perf: a system bus (crossbar) in front of two MAUs: relative_addresses, QoS behind a bus, data flow, statistics', () => {
  const core = require('../lib/platform/core');
  const perf = require('../lib/analysis/perf');
  const dataflow = require('../lib/platform/dataflow');
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'mau-sysbus.platform.json'), 'utf8'));
  const a = core.analyze(d, { catalog: cat });
  assert.deepStrictEqual(a.problems, []);
  assert.deepStrictEqual(a.buses.slice().sort(), ['mau0', 'mau1', 'sysbus']);
  const sw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'mau-sysbus.perfsweep.json'), 'utf8'));
  assert.deepStrictEqual(perf.checkSweep(sw, d), []);
  // The MAUs decode the same absolute addresses: the system bus passes them on unchanged.
  const lua = core.generate(d);
  assert.ok(lua.includes('target_socket = {address = 0x80000000, size = 0x60000000, relative_addresses = false, bind = "&sysbus.initiator_socket"};'), lua);
  assert.ok(lua.includes('topology = "crossbar";'));
  // The Ubuntu example has no such port: its Lua is unchanged (no relative_addresses anywhere).
  assert.ok(!core.generate(load()).includes('relative_addresses'));
  // Data flow from the CPU: DDR1 at its own address behind MAU1, not at 0x8000_0000 + 0x8000_0000.
  const reach = dataflow.reachFrom(a, 'cpu')[0].targets.map((t) => [t.instance, t.depth, '0x' + t.start.toString(16)]);
  assert.deepStrictEqual(reach, [['mau0', 0, '0x0'], ['ddr0', 1, '0x0'], ['mau1', 0, '0x80000000'], ['ddr1', 1, '0x80000000']]);
  const by = dataflow.reachedBy(a, 'ddr1').map((r) => [r.bus, '0x' + r.start.toString(16), r.path.join('>'), r.initiators.map((i) => i.base).join(',')]);
  assert.deepStrictEqual(by, [['sysbus', '0x80000000', 'sysbus>mau1', 'display,cpu,dma']]);
  // With relative addresses (the default) the window start is added, as on QBox's router.
  const rel = JSON.parse(JSON.stringify(d));
  delete rel.modules.mau1.ports.target_socket.relative_addresses;
  assert.strictEqual(dataflow.reachFrom(core.analyze(rel), 'cpu')[0].targets.find((t) => t.instance === 'ddr1').start, 0x100000000n);
  // QoS on a MAU names the masters behind the system bus.
  const bad = JSON.parse(JSON.stringify(d));
  bad.modules.mau0.params.masters = 'cpu: priority=3; dma: min_mbps=1';
  // Every master on the system bus counts as reaching each MAU behind it (the check does not decode addresses).
  assert.deepStrictEqual(core.analyze(bad).problems, []);
  bad.modules.mau0.params.masters = 'cpu: priority=3; gpu: min_mbps=1';
  assert.deepStrictEqual(core.analyze(bad).problems.map((x) => x.message), [
    'mau0.masters: gpu is not a traffic_gen whose accesses reach mau0 (display, cpu, dma); its settings are not used']);
  // The schema takes relative_addresses only with an address.
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'qbox-platform.schema.json'), 'utf8'));
  assert.strictEqual(schema.$defs.port.properties.relative_addresses.type, 'boolean');
  assert.deepStrictEqual(schema.$defs.port.dependentRequired.relative_addresses, ['address']);
  // Statistics of a crossbar: topology and each channel.
  const stats = { format: 'vp-perf-stats', version: 1, complete: true, simTimeNs: 1000, initiators: [], memories: [], buses: [{
    name: 'platform.sysbus', topology: 'crossbar', requestUtilization: 0.65, responseUtilization: 0.89, waitNs: {}, masters: {},
    channels: { request: { 'to mau0': 0.35, 'to mau1': 0.65 }, response: { 'to cpu': 0.89, 'to display': 0.47 } } }] };
  const b = perf.summary(stats).buses[0];
  assert.strictEqual(b.topology, 'crossbar');
  assert.deepStrictEqual(b.channels.request, { 'to mau0': 0.35, 'to mau1': 0.65 });
  assert.strictEqual(perf.metric(stats, 'buses.sysbus.channels.response.to cpu'), 0.89);
  assert.strictEqual(perf.summary({ initiators: [], memories: [], buses: [{ name: 'platform.bus', requestUtilization: 0.1, responseUtilization: 0.2 }] }).buses[0].topology, 'shared');
  // Failed accesses (perf 1.2.0) are counted apart and fail the run: a missing relative_addresses made them look like bandwidth.
  const lat = { count: 1, mean: 1, p50: 1, p99: 1, max: 1 };
  const failed = { initiators: [
    { name: 'platform.cpu', label: 'cpu', reads: 17153, writes: 7327, errors: 24098, firstError: 'access at 0x959f1e40 failed: TLM_ADDRESS_ERROR_RESPONSE', latencyNs: lat },
    { name: 'platform.display', label: 'display', reads: 10, writes: 0, errors: 0, latencyNs: lat }], buses: [], memories: [] };
  assert.deepStrictEqual(perf.failures(failed), ['cpu: 24098 of 48578 accesses failed (access at 0x959f1e40 failed: TLM_ADDRESS_ERROR_RESPONSE)']);
  assert.deepStrictEqual(perf.summary(failed).initiators.map((g) => g.errors), [24098, 0]);
  assert.deepStrictEqual(perf.failures({ initiators: [{ name: 'platform.x', reads: 1, writes: 0, latencyNs: lat }] }), []);
});

test('perf: the Performance panel has no style attributes and its script compiles', () => {
  const pv = require('../lib/webview/perfview');
  const html = pv.render('N3', 'x', 'Performance: t');
  assert.ok(!/<[a-z]+ [^>]*style="/.test(html.replace(/<style[\s\S]*?<\/style>/, '')));
  const scripts = [...html.matchAll(/<script nonce="N3">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.strictEqual(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  for (const id of ['rerun', 'stop', 'csv', 'reveal', 'stats', 'body', 'tip', 'state-t']) assert.ok(html.includes(`id="${id}"`), id);
});

testAsync('perf: a sweep runs every combination with a stand-in simulator and keeps going after a failed run', async () => {
  const perf = require('../lib/analysis/perf');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-perf-'));
  // The stand-in reads the Lua, writes statistics where it is told, bandwidth = 100 x max_outstanding;
  // max_outstanding 3 "crashes" without statistics.
  const js = path.join(dir, 'fake.js');
  fs.writeFileSync(js, `const fs=require('fs');const lua=fs.readFileSync(process.argv[3],'utf8');
const out=/\\["output"\\] = "([^"]+)"/.exec(lua)[1];const n=Number((/\\["max_outstanding"\\] = (\\d+)/.exec(lua)||[0,1])[1]);
if(n===3){console.log('boom');process.exit(7)}
fs.writeFileSync(out,JSON.stringify({format:'vp-perf-stats',version:1,complete:true,simTimeNs:1000,initiators:[{name:'platform.cpu',label:'cpu',reads:1,writes:0,bytes:64,bandwidthMBps:100*n,latencyNs:{count:1,mean:10,p50:10,p99:10,max:10}}],buses:[],memories:[]}));console.log('perf: done');`);
  const exe = path.join(dir, 'fake-sim');
  fs.writeFileSync(exe, `#!/bin/sh\nexec "$VP_TEST_NODE" "${js}" "$@"\n`, { mode: 0o755 });
  process.env.VP_TEST_NODE = process.execPath;
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'ddr-contention.platform.json'), 'utf8'));
  const platformFile = path.join(dir, 'p.platform.json');
  fs.writeFileSync(platformFile, JSON.stringify(d));
  const spec = { platform: 'p.platform.json', sweep: [{ param: 'cpu.max_outstanding', values: [1, 2, 3, 4] }], metrics: ['initiators.cpu.bandwidthMBps'], checks: [{ metric: 'initiators.cpu.bandwidthMBps', min: 150 }] };
  const seen = [];
  const r = await perf.runSweep({ spec, doc: d, platformFile, exe, cwd: dir, outDir: path.join(dir, 'out'), jobs: 2, onProgress: (p) => seen.push(p.done) });
  assert.deepStrictEqual(seen, [1, 2, 3, 4]);
  assert.deepStrictEqual(r.runs.map((x) => [x.index, x.ok, x.metrics['initiators.cpu.bandwidthMBps']]), [[0, true, 100], [1, true, 200], [2, false, undefined], [3, true, 400]]);
  assert.match(r.runs[2].error, /no statistics were written \(exit 7\): boom/);
  assert.deepStrictEqual(r.checkResults.map((c) => c.ok), [false, true, false, true]);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'results.json'), 'utf8'));
  assert.strictEqual(saved.format, 'vp-perf-sweep');
  assert.ok(fs.existsSync(path.join(dir, 'out', 'results.csv')) && fs.existsSync(path.join(dir, 'out', 'run-3.json')));
  // The Lua files next to the platform are removed.
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.lua')), []);
  // One experiment; a timeout stops the simulator.
  const one = await perf.runExperiment({ doc: d, platformFile, exe, cwd: dir, outFile: path.join(dir, 'one.json') });
  assert.ok(one.ok && one.stats.initiators[0].bandwidthMBps === 100, JSON.stringify(one.error)); // no override: the stand-in's default
  const hang = path.join(dir, 'hang-sim');
  fs.writeFileSync(hang, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const t = await perf.runExperiment({ doc: d, platformFile, exe: hang, cwd: dir, outFile: path.join(dir, 'h.json'), timeoutMs: 300 });
  assert.ok(!t.ok && /timed out/.test(t.error));
  // vp-run --perf-sweep with JUnit: a failed check exits with 1.
  const vprun = require('../bin/vp-run.js');
  const specFile = path.join(dir, 's.perfsweep.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  fs.writeFileSync(path.join(dir, 'perf.so'), '');
  const o = vprun.parseArgs(['--perf-sweep', specFile, '--exe', exe, '--qbox', dir, '--out', path.join(dir, 'o2'), '--junit', path.join(dir, 'j.xml'), '--quiet']);
  const logs = [];
  const code = await vprun.perfSweepCmd(o, (x) => logs.push(x));
  assert.strictEqual(code, vprun.EXIT.FAIL, logs.join('\n'));
  const xml = fs.readFileSync(path.join(dir, 'j.xml'), 'utf8');
  assert.match(xml, /tests="5" failures="3"/); // 4 checks (2 fail) + the failed run
  // --param reaches perf runs: max_outstanding 3 makes the stand-in fail.
  const po = vprun.parseArgs(['--perf', '--exe', exe, '--qbox', dir, '--out', path.join(dir, 'p3.json'), '--param', 'cpu.max_outstanding=3', '--quiet', platformFile]);
  assert.strictEqual(await vprun.perfCmd(po, () => {}), vprun.EXIT.SIM);
  const po2 = vprun.parseArgs(['--perf', '--exe', exe, '--qbox', dir, '--out', path.join(dir, 'p2.json'), '--param', 'cpu.max_outstanding=2', '--quiet', platformFile]);
  assert.strictEqual(await vprun.perfCmd(po2, () => {}), vprun.EXIT.PASS);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'p2.json'), 'utf8')).initiators[0].bandwidthMBps, 200);
  assert.throws(() => vprun.parseArgs(['--perf-sweep', specFile, 'p.platform.json']), /give no platform file/);
  assert.throws(() => vprun.parseArgs(['--perf', '--expect', 'x', 'p.platform.json']), /takes no steps/);
  fs.rmSync(dir, { recursive: true, force: true });
});
