'use strict';
// Run with: node test/dataflow.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const core = require('../lib/core');
const dataflow = require('../lib/dataflow');
const { load, catalog } = require('./helpers');

test('dataflow: what the CPUs reach and who reaches a device (Ubuntu example)', () => {
  const d = load();
  const a = core.analyze(d, { catalog });
  const r = dataflow.reachFrom(a, 'cpu');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].port, 'mem');
  assert.strictEqual(r[0].bus, 'router');
  assert.strictEqual(r[0].instances, 8);
  const uart = r[0].targets.find((t) => t.base === 'pl011_uart_0');
  assert.strictEqual(uart.start, 0x10000000n);
  assert.strictEqual(uart.end, 0x10000fffn);
  assert.ok(r[0].targets.find((t) => t.base === 'fallback_0').background);
  // Sorted by address.
  for (let i = 1; i < r[0].targets.length; i++) assert.ok(r[0].targets[i - 1].start <= r[0].targets[i].start);
  const by = dataflow.reachedBy(a, 'pl011_uart_0');
  assert.strictEqual(by.length, 1);
  assert.deepStrictEqual(by[0].path, ['router']);
  assert.deepStrictEqual(by[0].initiators.map((x) => `${x.base}.${x.port}×${x.count}`).sort(),
    ['cpu.mem×8', 'global_peripheral_initiator_arm_0.global_initiator×1', 'gpex_0.bus_master×1', 'load.initiator_socket×1']);
  assert.deepStrictEqual(dataflow.reachFrom(a, 'pl011_uart_0'), []);
  assert.ok(dataflow.hasDataFlow(a, 'router') && dataflow.hasDataFlow(a, 'cpu') && dataflow.hasDataFlow(a, 'pl011_uart_0'));
  assert.ok(!dataflow.hasDataFlow(a, 'charbackend_stdio_0'));
  assert.deepStrictEqual(dataflow.regionsByPort(a).get('pl011_uart_0.target_socket'), { start: 0x10000000n, size: 0x1000n, bus: 'router', priority: 0 });
});

test('dataflow: a router behind a router sees its window offset', () => {
  // Synthetic analysis: cpu -> top; top decodes sub at 0x4000_0000; sub decodes dev at 0x100.
  const a = {
    buses: ['top', 'sub'],
    connections: [{ from: 'cpu_0', fromBase: 'cpu', fromPort: 'mem', to: 'top', toPort: 'target_socket' }],
    memoryMap: [
      { instance: 'sub', base: 'sub', port: 'target_socket', bus: 'top', start: 0x40000000n, size: 0x1000000n, priority: 0 },
      { instance: 'dev', base: 'dev', port: 'target_socket', bus: 'sub', start: 0x100n, size: 0x100n, priority: 0 },
    ],
  };
  const t = dataflow.reachFrom(a, 'cpu')[0].targets;
  assert.deepStrictEqual(t.map((x) => [x.instance, x.start, x.depth]), [['sub', 0x40000000n, 0], ['dev', 0x40000100n, 1]]);
  const by = dataflow.reachedBy(a, 'dev');
  // sub has no initiator of its own; through top the CPU sees dev at window + 0x100.
  assert.strictEqual(by.length, 1);
  assert.deepStrictEqual(by[0].path, ['top', 'sub']);
  assert.strictEqual(by[0].start, 0x40000100n);
  assert.deepStrictEqual(by[0].initiators.map((x) => x.base), ['cpu']);
  // A loop of routers does not recurse forever.
  a.memoryMap.push({ instance: 'top', base: 'top', port: 'target_socket', bus: 'sub', start: 0n, size: 0x10n, priority: 0 });
  assert.ok(dataflow.reachFrom(a, 'cpu')[0].targets.length < 20);
});

test('dataflow: route of a transaction, from the trace initiator name to the device', () => {
  const d = load();
  const a = core.analyze(d);
  const t = dataflow.routeTable(a);
  assert.deepStrictEqual(t.inst.cpu_3, ['cpu', 3]);
  assert.deepStrictEqual(t.inst.pl011_uart_0, ['pl011_uart_0', null]);
  assert.deepStrictEqual(t.regions['pl011_uart_0.target_socket'].ways[0].path, ['router']);
  assert.ok(t.regions['pl011_uart_0.target_socket'].ways[0].initiators.includes('cpu'));
  // JSON only (the view embeds it).
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t)), t);
  assert.deepStrictEqual(dataflow.routeFor(t, { region: 'pl011_uart_0.target_socket', initiator: 'cpu_3.mem' }),
    { from: 'cpu', index: 3, port: 'mem', buses: ['router'], target: 'pl011_uart_0', region: 'pl011_uart_0.target_socket' });
  // Without an initiator (an older agent, or the address lookup): the bus and the device only.
  const r = dataflow.routeFor(t, { region: 'ram_0.target_socket' });
  assert.deepStrictEqual([r.from, r.buses, r.target], [null, ['router'], 'ram_0']);
  // An initiator the platform does not know is kept out of the route.
  assert.strictEqual(dataflow.routeFor(t, { region: 'ram_0.target_socket', initiator: 'vp_sim_agent.bus_0' }).from, null);
  assert.strictEqual(dataflow.routeFor(t, { region: 'nothing.here' }), null);
  // Self-contained, as the view embeds it with toString().
  const embedded = new Function(`return (${dataflow.routeFor.toString()})`)();
  assert.deepStrictEqual(embedded(t, { region: 'pl011_uart_0.target_socket', initiator: 'cpu_0.mem' }).index, 0);
  // Behind two routers: the path is the outer router first.
  const n = {
    instances: [{ name: 'cpu_0', base: 'cpu', index: 0 }, { name: 'dev', base: 'dev', index: null }],
    buses: ['top', 'sub'],
    connections: [{ from: 'cpu_0', fromBase: 'cpu', fromPort: 'mem', to: 'top', toPort: 'target_socket' }],
    memoryMap: [
      { instance: 'sub', base: 'sub', port: 'target_socket', bus: 'top', start: 0x40000000n, size: 0x1000000n, priority: 0 },
      { instance: 'dev', base: 'dev', port: 'target_socket', bus: 'sub', start: 0x100n, size: 0x100n, priority: 0 },
    ],
  };
  assert.deepStrictEqual(dataflow.routeFor(dataflow.routeTable(n), { region: 'dev.target_socket', initiator: 'cpu_0.mem' }).buses, ['top', 'sub']);
});
