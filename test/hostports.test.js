'use strict';
// Run with: node test/hostports.test.js (every file: npm test)
const { test, testAsync } = require('./harness');
const assert = require('assert');
const core = require('../lib/platform/core');
const hostports = require('../lib/sim/hostports');
const { load } = require('./helpers');

test('host port variables: listed, emitted as overridable, preset values win', () => {
  const d = load();
  assert.deepStrictEqual(hostports.hostPortVariables(d).map((v) => [v.name, v.port]),
    [['HOST_PORT_SSH', 2222], ['HOST_PORT_FTP', 2221], ['HOST_PORT_56283', 56283], ['HOST_PORT_65534', 55534], ['HOST_PORT_65535', 55535]]);
  const lua = core.generate(d, { variableValues: { HOST_PORT_SSH: 40001 } });
  const preset = lua.indexOf('HOST_PORT_SSH = 40001');
  const fallback = lua.indexOf('if HOST_PORT_SSH == nil then HOST_PORT_SSH = 2222 end');
  assert.ok(preset > 0 && fallback > preset);
  assert.ok(lua.includes('netdev_str = "type=user,hostfwd=tcp::"..tostring(HOST_PORT_SSH).."-:22,'));
  assert.ok(!core.generate(d).includes('HOST_PORT_SSH = 40001'));
});

testAsync('host ports: keep free ones, move taken or duplicate ones', async () => {
  const taken = new Set([2222]);
  let next = 40000;
  const r = await hostports.choosePorts(
    [{ name: 'A', port: 2222 }, { name: 'B', port: 2221 }, { name: 'C', port: 2221 }, { name: 'D', port: null }],
    { isFree: async (p) => !taken.has(p), pick: async () => next++ });
  assert.deepStrictEqual(r.values, { A: 40000, B: 2221, C: 40001, D: 40002 });
  assert.deepStrictEqual(r.moved.map((m) => [m.name, m.from, m.to]), [['A', 2222, 40000], ['C', 2221, 40001], ['D', null, 40002]]);
});

testAsync('host ports: a port held by another process is seen as taken', async () => {
  const net = require('net');
  const srv = net.createServer();
  await new Promise((r) => srv.listen({ port: 0, host: '0.0.0.0' }, r));
  const port = srv.address().port;
  assert.strictEqual(await hostports.isPortFree(port), false);
  await new Promise((r) => srv.close(r));
  assert.strictEqual(await hostports.isPortFree(port), true);
  const r = await hostports.choosePorts([{ name: 'X', port }]);
  assert.deepStrictEqual(r, { values: { X: port }, moved: [] });
});
