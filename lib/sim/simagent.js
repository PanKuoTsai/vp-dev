'use strict';
/**
 * Client for the sim agent (tools/sim-agent/sim_agent.cc): JSON-RPC 2.0 over TCP, one
 * message per line. No VS Code dependency.
 */
const net = require('net');
const { EventEmitter } = require('events');

const PROTOCOL = 1;

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Events: 'notification' (method, params), 'close' (error|undefined).
 */
class SimAgentClient extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.buffer = '';
    this.closed = false;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (e) => this.shutdown(e));
    socket.on('close', () => this.shutdown());
  }

  /** Connect once. Rejects if nothing listens at host:port. */
  static connect({ host = '127.0.0.1', port, timeoutMs = 3000 }) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => { socket.destroy(); reject(new Error(`timed out connecting to ${host}:${port}`)); }, timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(new SimAgentClient(socket)); });
      socket.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg && msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message));
        else p.resolve(msg.result);
      } else if (msg && typeof msg.method === 'string' && msg.id === undefined) {
        this.emit('notification', msg.method, msg.params);
      }
    }
  }

  /** Call a method. Rejects with RpcError for agent errors, Error otherwise. */
  request(method, params, { timeoutMs = 10000 } = {}) {
    if (this.closed) return Promise.reject(new Error('not connected to the simulation'));
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer from the simulation within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify(msg) + '\n');
    });
  }

  shutdown(err) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('connection to the simulation closed'));
    }
    this.pending.clear();
    this.socket.destroy();
    this.emit('close', err);
  }

  close() { this.shutdown(); }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Keep trying to connect while the simulator elaborates (QEMU start-up can
 * take seconds). shouldStop() lets the caller give up early, for example when
 * the simulator terminal was closed. Resolves undefined when it gives up.
 */
async function connectWithRetry({ host = '127.0.0.1', port, totalMs = 120000, intervalMs = 500, shouldStop = () => false, handshake = false }) {
  const end = Date.now() + totalMs;
  while (Date.now() < end && !shouldStop()) {
    let client;
    try {
      client = await SimAgentClient.connect({ host, port, timeoutMs: Math.min(3000, Math.max(1, end - Date.now())) });
      // Through an ssh tunnel (remote simulation) the connect succeeds as soon
      // as ssh listens, and the connection closes when nothing listens on the
      // remote end yet: only an answer to agent.getInfo means the agent is there.
      if (handshake) await client.request('agent.getInfo', undefined, { timeoutMs: 5000 });
      return client;
    } catch (e) {
      if (client) client.close();
      await delay(intervalMs);
    }
  }
  return undefined;
}

/** A TCP port that is free right now on host (there is a small race until the simulator binds it). */
function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Simulated time in seconds as short text, e.g. "19.091 s", "250 ms", "0 s". */
function formatTime(seconds) {
  if (typeof seconds !== 'number' || !isFinite(seconds)) return '?';
  const a = Math.abs(seconds);
  const fmt = (v, unit) => `${Number(v.toPrecision(5))} ${unit}`;
  if (a === 0) return '0 s';
  if (a < 1e-6) return fmt(seconds * 1e9, 'ns');
  if (a < 1e-3) return fmt(seconds * 1e6, 'µs');
  if (a < 1) return fmt(seconds * 1e3, 'ms');
  return `${seconds.toFixed(3)} s`;
}

const TIME_UNITS = { s: 1, ms: 1e-3, us: 1e-6, 'µs': 1e-6, ns: 1e-9, ps: 1e-12 };

/**
 * A simulated time typed by the user: "500 ms", "1.5s", "250 us", "2" (seconds).
 * Returns { seconds, text } where text is what sim.runFor / sim.runUntil accept,
 * or throws Error with a message for the input box.
 */
function parseSimTime(input) {
  const m = /^\s*(\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d+))?\s*([a-zµ]*)\s*$/i.exec(String(input === undefined ? '' : input));
  if (!m) throw new Error('Enter a time such as 500 ms, 1.5 s or 250 us');
  const unit = m[3] === '' ? 's' : m[3].toLowerCase();
  if (!(unit in TIME_UNITS)) throw new Error(`Unknown unit "${m[3]}" (use s, ms, us, ns or ps)`);
  const value = Number(m[1]) * Math.pow(10, Number(m[2] || 0));
  if (!isFinite(value)) throw new Error('The time is too large');
  const agentUnit = unit === 'µs' ? 'us' : unit;
  return { seconds: value * TIME_UNITS[unit], text: `${value} ${agentUnit}` };
}

/** Text of a parameter value for a one-line display. */
function formatValue(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return JSON.stringify(v);
  const s = JSON.stringify(v);
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

/**
 * Group parameters by their dotted names: "platform.cpu_0.gdb_port" becomes
 * platform > cpu_0 > gdb_port. Returns the root's children, each node being
 * {label, path, children} for an object or {label, path, param} for a parameter.
 * A name that is both a parameter and a prefix of others keeps both nodes.
 * Objects come before parameters, each sorted with numeric parts compared as numbers.
 */
function buildParamTree(params) {
  const root = { children: new Map() };
  for (const p of params) {
    const parts = String(p.name).split('.');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = 'o:' + parts[i];
      if (!node.children.has(key)) {
        node.children.set(key, { label: parts[i], path: parts.slice(0, i + 1).join('.'), children: new Map() });
      }
      node = node.children.get(key);
    }
    const leaf = parts[parts.length - 1];
    node.children.set('p:' + leaf, { label: leaf, path: p.name, param: p });
  }
  const collator = new Intl.Collator('en', { numeric: true });
  const finish = (node) => [...node.children.values()]
    .sort((a, b) => (!!a.param - !!b.param) || collator.compare(a.label, b.label))
    .map((n) => (n.param ? n : { label: n.label, path: n.path, children: finish(n) }));
  return finish(root);
}

// Integer C++ types and their ranges, for checking a value before it is sent.
const INT_BITS = {
  int8_t: [8, true], uint8_t: [8, false], int16_t: [16, true], uint16_t: [16, false],
  int32_t: [32, true], uint32_t: [32, false], int64_t: [64, true], uint64_t: [64, false],
  'signed char': [8, true], 'unsigned char': [8, false], short: [16, true], 'unsigned short': [16, false],
  int: [32, true], 'unsigned int': [32, false], long: [64, true], 'unsigned long': [64, false],
  'long long': [64, true], 'unsigned long long': [64, false], size_t: [64, false],
};

/** Text to start editing a parameter with: strings without quotes, the rest as JSON. */
function paramInputText(p) {
  if (p.value === null || p.value === undefined) return '';
  return typeof p.value === 'string' ? p.value : JSON.stringify(p.value);
}

/**
 * Check the text typed for a running simulation's parameter and turn it into
 * the JSON text to send (cci.setParam valueJson). Integers may be decimal or
 * 0x hex and keep every digit; strings are taken literally.
 * Returns { json } or { error }.
 */
function parseParamValue(text, p) {
  const s = String(text);
  const t = s.trim();
  switch (p.category) {
  case 'bool':
    if (t === 'true' || t === 'false') return { json: t };
    return { error: 'Use true or false.' };
  case 'integer': {
    const m = /^(-)?(0x[0-9a-f]+|\d+)$/i.exec(t);
    if (!m) return { error: 'Use a whole number, decimal or 0x hex.' };
    const n = (m[1] ? -1n : 1n) * BigInt(m[2]);
    const r = INT_BITS[p.type];
    if (r) {
      const [bits, signed] = r;
      const lo = signed ? -(1n << BigInt(bits - 1)) : 0n;
      const hi = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
      if (n < lo || n > hi) return { error: `${p.type} holds ${lo} to ${hi}.` };
    }
    return { json: n.toString() };
  }
  case 'real': {
    if (t === '' || !isFinite(Number(t))) return { error: 'Use a number, for example 1.5 or 2e-3.' };
    return { json: JSON.stringify(Number(t)) };
  }
  case 'string':
    return { json: JSON.stringify(s) };
  default:
    try { JSON.parse(t); } catch (e) { return { error: `Use JSON (${e.message}).` }; }
    return { json: t };
  }
}

/** Why a parameter cannot be set while the simulation runs, or undefined. */
function readOnlyReason(p) {
  if (p.locked) return 'locked by its owner';
  if (p.mutability === 'immutable') return 'immutable: it can only be set in the platform before the simulation starts';
  if (p.value === null || p.value === undefined) return 'its type has no JSON conversion';
  return undefined;
}

module.exports = { SimAgentClient, RpcError, connectWithRetry, freePort, buildParamTree, formatValue, formatTime, parseSimTime, paramInputText, parseParamValue, readOnlyReason, PROTOCOL };
