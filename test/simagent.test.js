'use strict';
// Run with: node test/simagent.test.js (every file: npm test)
const { test, testAsync } = require('./harness');
const assert = require('assert');
const agent = require('../lib/sim/simagent');

/** A fake agent: answers each request line with reply(msg), which may return a string, object or undefined. */
function fakeAgent(reply) {
  const net = require('net');
  return new Promise((resolve) => {
    const sockets = [];
    const srv = net.createServer((s) => {
      sockets.push(s);
      let buf = '';
      s.setEncoding('utf8');
      s.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          const out = reply(msg, s);
          if (out !== undefined) s.write((typeof out === 'string' ? out : JSON.stringify(out)) + '\n');
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      port: srv.address().port,
      close: () => { sockets.forEach((s) => s.destroy()); srv.close(); },
    }));
  });
}

test('param tree groups dotted names, objects first, numeric order', () => {
  const tree = agent.buildParamTree([
    { name: 'platform.cpu_10.gdb_port', value: 0 },
    { name: 'platform.cpu_2.gdb_port', value: 0 },
    { name: 'platform.quantum_ns', value: 1000 },
    { name: 'log_level', value: 0 },
    { name: 'platform.cpu_2', value: 'odd but legal' },
  ]);
  assert.deepStrictEqual(tree.map((n) => n.label), ['platform', 'log_level']);
  const plat = tree[0];
  assert.deepStrictEqual(plat.children.map((n) => n.label), ['cpu_2', 'cpu_10', 'cpu_2', 'quantum_ns']);
  assert.strictEqual(plat.children[1].children[0].path, 'platform.cpu_10.gdb_port');
  assert.strictEqual(plat.children[2].param.value, 'odd but legal');
});

test('param values format on one line', () => {
  assert.strictEqual(agent.formatValue('a"b'), '"a\\"b"');
  assert.strictEqual(agent.formatValue(null), '—');
  assert.strictEqual(agent.formatValue(42), '42');
  assert.ok(agent.formatValue(Array(100).fill(1)).endsWith('…'));
});

test('simulated time formats with a fitting unit', () => {
  assert.strictEqual(agent.formatTime(0), '0 s');
  assert.strictEqual(agent.formatTime(19.090650666), '19.091 s');
  assert.strictEqual(agent.formatTime(0.25), '250 ms');
  assert.strictEqual(agent.formatTime(1.5e-5), '15 µs');
  assert.strictEqual(agent.formatTime(2e-9), '2 ns');
  assert.strictEqual(agent.formatTime(undefined), '?');
});

test('typed simulated times parse into what sim.runFor accepts', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-12, `${a} != ${b}`);
  const p = agent.parseSimTime;
  assert.deepStrictEqual(p('500 ms'), { seconds: 0.5, text: '500 ms' });
  assert.strictEqual(p('1.5s').text, '1.5 s');
  near(p('1.5s').seconds, 1.5);
  assert.strictEqual(p('2').text, '2 s'); // no unit: seconds, as the agent reads a bare number
  assert.strictEqual(p(' 250 us ').text, '250 us');
  assert.strictEqual(p('250 µs').text, '250 us'); // the agent gets the ASCII spelling
  near(p('250 µs').seconds, 250e-6);
  assert.strictEqual(p('10 MS').text, '10 ms');
  near(p('1e3 ns').seconds, 1e-6);
  near(p('.5 ps').seconds, 0.5e-12);
  for (const bad of ['', 'abc', '-1 ms', '1 parsec', '1 2 ms', 'ms']) {
    assert.throws(() => p(bad), Error, bad);
  }
  assert.throws(() => p('1 min'), /Unknown unit "min"/);
});

testAsync('agent client: results, errors and notifications', async () => {
  const srv = await fakeAgent((m, s) => {
    if (m.method === 'sim.pause') {
      // Partial writes and a notification ahead of the response.
      const n = JSON.stringify({ jsonrpc: '2.0', method: 'sim.stateChanged', params: { state: 'paused' } });
      const r = JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { state: 'paused' } });
      s.write(n.slice(0, 10));
      setTimeout(() => s.write(n.slice(10) + '\n' + r + '\n'), 20);
      return undefined;
    }
    if (m.method === 'cci.getParam') return { jsonrpc: '2.0', id: m.id, error: { code: -32001, message: 'no parameter named x' } };
    return { jsonrpc: '2.0', id: m.id, result: { echo: m.params } };
  });
  const c = await agent.SimAgentClient.connect({ port: srv.port });
  const notes = [];
  c.on('notification', (method, params) => notes.push([method, params.state]));
  assert.deepStrictEqual(await c.request('x', { a: 1 }), { echo: { a: 1 } });
  assert.deepStrictEqual(await c.request('sim.pause'), { state: 'paused' });
  assert.deepStrictEqual(notes, [['sim.stateChanged', 'paused']]);
  await assert.rejects(c.request('cci.getParam', { name: 'x' }), (e) => e instanceof agent.RpcError && e.code === -32001);
  c.close();
  srv.close();
});

testAsync('agent client: pending requests fail when the simulator goes away', async () => {
  const srv = await fakeAgent(() => undefined); // never answers
  const c = await agent.SimAgentClient.connect({ port: srv.port });
  let closed = false;
  c.on('close', () => { closed = true; });
  const p = c.request('sim.getStatus');
  srv.close();
  await assert.rejects(p, /closed/);
  assert.ok(closed);
  await assert.rejects(c.request('sim.getStatus'), /not connected/);
});

testAsync('agent client: request timeout', async () => {
  const srv = await fakeAgent(() => undefined);
  const c = await agent.SimAgentClient.connect({ port: srv.port });
  await assert.rejects(c.request('sim.getStatus', undefined, { timeoutMs: 50 }), /no answer/);
  c.close();
  srv.close();
});

testAsync('agent client: connectWithRetry waits for the agent, and gives up', async () => {
  const port = await agent.freePort();
  assert.strictEqual(await agent.connectWithRetry({ port, totalMs: 300, intervalMs: 50 }), undefined);
  let stop = false;
  setTimeout(() => { stop = true; }, 100);
  const t0 = Date.now();
  assert.strictEqual(await agent.connectWithRetry({ port, totalMs: 5000, intervalMs: 20, shouldStop: () => stop }), undefined);
  assert.ok(Date.now() - t0 < 2000);
  const srv = await fakeAgent((m) => ({ jsonrpc: '2.0', id: m.id, result: 1 }));
  const c = await agent.connectWithRetry({ port: srv.port, totalMs: 2000 });
  assert.strictEqual(await c.request('agent.getInfo'), 1);
  c.close();
  srv.close();
});

testAsync('agent client: with handshake, a tunnel that accepts and closes is retried', async () => {
  const net = require('net');
  // Like ssh -L before the remote agent listens: accept, then close at once.
  let accepted = 0;
  const tunnel = net.createServer((sock) => { accepted++; sock.destroy(); });
  await new Promise((r) => tunnel.listen(0, '127.0.0.1', r));
  const port = tunnel.address().port;
  assert.strictEqual(await agent.connectWithRetry({ port, totalMs: 600, intervalMs: 50, handshake: true }), undefined);
  assert.ok(accepted >= 2);
  // Without the handshake the first accept counts as connected.
  const c0 = await agent.connectWithRetry({ port, totalMs: 600, intervalMs: 50 });
  assert.ok(c0);
  c0.close();
  tunnel.close();
  const srv = await fakeAgent((m) => ({ jsonrpc: '2.0', id: m.id, result: { protocol: 1 } }));
  const c = await agent.connectWithRetry({ port: srv.port, totalMs: 2000, handshake: true });
  assert.deepStrictEqual(await c.request('agent.getInfo'), { protocol: 1 });
  c.close();
  srv.close();
});

testAsync('uart consoles: socket backends, their UARTs, ports when taken, terminal text', async () => {
  const cs = require('../lib/sim/consoles');
  assert.deepStrictEqual(cs.parseAddress('127.0.0.1:4001'), { host: '127.0.0.1', port: 4001 });
  assert.deepStrictEqual(cs.parseAddress('[::1]:5000'), { host: '::1', port: 5000 });
  assert.strictEqual(cs.parseAddress('localhost'), null);
  assert.strictEqual(cs.parseAddress('h:70000'), null);
  const doc = { schemaVersion: '0.2', name: 'u', modules: {
    router: { type: 'router' },
    stdio: { type: 'char_backend_stdio' },
    uart0: { type: 'Pl011', ports: { target_socket: { address: '0x9000000', size: '0x1000', bind: 'router.initiator_socket' }, backend_socket: { bind: 'stdio.biflow_socket' } } },
    uart1: { type: 'Pl011', ports: { target_socket: { address: '0x9001000', size: '0x1000', bind: 'router.initiator_socket' } } },
    uart1_console: { type: 'char_backend_socket', params: { address: '127.0.0.1:4001' }, ports: { biflow_socket: { bind: 'uart1.backend_socket' } } },
    uart2_console: { type: 'char_backend_socket', ports: {} },
    out: { type: 'char_backend_socket', params: { address: '10.0.0.5:7000', server: false } },
    bad: { type: 'char_backend_socket', params: { address: 'nowhere' } },
  } };
  const c = cs.consoles(doc);
  assert.deepStrictEqual(c.stdio, [{ name: 'stdio', uart: 'uart0.backend_socket' }]);
  assert.deepStrictEqual(c.sockets.map((k) => [k.name, k.uart, k.host, k.port, k.server, !!k.problem]), [
    ['uart1_console', 'uart1.backend_socket', '127.0.0.1', 4001, true, false],
    ['uart2_console', '', '127.0.0.1', 4001, true, false], // the backend's default address
    ['out', '', '10.0.0.5', 7000, false, false],
    ['bad', '', null, null, true, true]]);
  // 4001 is free for the first; the second asks for it too and moves; client and bad ones are left alone.
  const freeList = [40500, 40501];
  const r = await cs.choosePorts(c.sockets, { isFree: async (p) => p === 4001, pick: async () => freeList.shift() });
  assert.deepStrictEqual(r.list.map((k) => [k.name, k.port]), [['uart1_console', 4001], ['uart2_console', 40500]]);
  assert.deepStrictEqual(r.overrides, [{ instance: 'uart2_console', param: 'address', value: '127.0.0.1:40500' }]);
  assert.deepStrictEqual(r.moved, [{ name: 'uart2_console', from: 4001, to: 40500 }]);
  assert.strictEqual(cs.toTerminal('a\nb\r\nc'), 'a\r\nb\r\nc');
  assert.deepStrictEqual(c.sockets.map(cs.terminalName), ['UART uart1', 'UART uart2_console', 'UART out', 'UART bad']);
});
