'use strict';
// UART consoles beyond the first: the simulator's own terminal is the one UART
// whose backend is char_backend_stdio; every other UART that should be
// reachable gets a char_backend_socket (a TCP server in the simulator), and
// VP Studio opens a terminal connected to it. Here: which socket consoles a
// platform has, which UART each serves, which ports to use when the configured
// one is taken, and the text conversion for a terminal.
// No VS Code dependency.

const core = require('../platform/core');

const SOCKET_TYPE = 'char_backend_socket';
const STDIO_TYPE = 'char_backend_stdio';
const DEFAULT_ADDRESS = '127.0.0.1:4001'; // char_backend_socket's own default

/** "127.0.0.1:4001" -> { host, port }; null when it is not host:port. */
function parseAddress(text) {
  const m = /^\s*([^:\s]+|\[[^\]]+\]):(\d{1,5})\s*$/.exec(String(text || ''));
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1].replace(/^\[|\]$/g, ''), port } : null;
}

/** What a backend is bound to (either end may declare the binding): "pl011_uart_1.backend_socket", or ''. */
function peerOf(analysis, name) {
  for (const c of analysis.connections) {
    if (c.to === name) return `${c.from}.${c.fromPort}`;
    if (c.from === name) return `${c.to}.${c.toPort}`;
  }
  return '';
}

/**
 * The platform's consoles: { stdio: [{name, uart}], sockets: [{name, base, uart, address, host, port, server, problem?}] }.
 * A socket console in client mode (server = false) connects out by itself; VP Studio leaves it alone.
 */
function consoles(doc) {
  const a = core.analyze(doc);
  const stdio = [];
  const sockets = [];
  for (const inst of a.instances) {
    if (inst.type === STDIO_TYPE) stdio.push({ name: inst.name, uart: peerOf(a, inst.name) });
    if (inst.type !== SOCKET_TYPE) continue;
    const raw = inst.params.address === undefined ? DEFAULT_ADDRESS : inst.params.address;
    const addr = typeof raw === 'string' ? parseAddress(raw) : null;
    const server = inst.params.server === undefined ? true : inst.params.server !== false && inst.params.server !== 'false';
    const s = { name: inst.name, base: inst.base, uart: peerOf(a, inst.name), address: String(raw), host: addr ? addr.host : null, port: addr ? addr.port : null, server };
    if (!addr) s.problem = `address ${JSON.stringify(raw)} is not host:port`;
    sockets.push(s);
  }
  return { stdio, sockets };
}

/**
 * Ports for the socket consoles: the configured one when it is free, another free one otherwise
 * (two consoles on the same port, or a port another program uses). isFree(port, host) and pick(host)
 * as in hostports.js. Returns { overrides: [{instance, param: 'address', value}], moved: [{name, from, to}],
 * list: [{...console, host, port}] } for the server-mode consoles with a valid address.
 */
async function choosePorts(sockets, { isFree, pick }) {
  const overrides = [];
  const moved = [];
  const list = [];
  const used = new Set();
  for (const s of sockets) {
    if (!s.server || s.problem) continue;
    let port = s.port;
    if (used.has(port) || !(await isFree(port, s.host))) {
      let p;
      do { p = await pick(s.host); } while (used.has(p));
      moved.push({ name: s.name, from: s.port, to: p });
      overrides.push({ instance: s.name, param: 'address', value: `${s.host}:${p}` });
      port = p;
    }
    used.add(port);
    list.push(Object.assign({}, s, { port }));
  }
  return { overrides, moved, list };
}

/** Bytes from the UART, for a terminal: a lone LF moves to the start of the next line too. */
const toTerminal = (text) => String(text).replace(/\r?\n/g, '\r\n');

/** The terminal's name for a console: the UART it serves, else the backend. */
const terminalName = (s) => `UART ${s.uart ? s.uart.replace(/\.[^.]*$/, '') : s.name}`;

module.exports = { SOCKET_TYPE, STDIO_TYPE, DEFAULT_ADDRESS, parseAddress, peerOf, consoles, choosePorts, toTerminal, terminalName };
