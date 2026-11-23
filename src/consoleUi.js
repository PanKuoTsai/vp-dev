'use strict';
// UART consoles: one VS Code terminal per char_backend_socket of the running
// platform (lib/sim/consoles.js), connected over TCP to the socket the
// simulator listens on. What is typed goes to the UART's receiver; what the
// UART sends is shown. The terminals close when the simulation stops.
const vscode = require('vscode');
const net = require('net');
const consoles = require('../lib/sim/consoles');

const open = new Map(); // backend name -> { terminal, close() }

/** A terminal for one console at host:port, retrying the connection until it is accepted. */
function openOne(c, { host, port, where }) {
  const write = new vscode.EventEmitter();
  const done = new vscode.EventEmitter();
  let sock;
  let closed = false;
  let timer;
  let attempts = 0;
  const say = (text) => write.fire(`\x1b[2m${text}\x1b[0m\r\n`);
  const connect = () => {
    if (closed) return;
    attempts++;
    const s = net.connect({ host, port });
    s.setNoDelay(true);
    s.once('connect', () => {
      sock = s;
      say(`Connected to ${c.uart || c.name} through ${c.name} (${host}:${port}${where ? ', ' + where : ''}).`);
    });
    s.on('data', (b) => write.fire(consoles.toTerminal(b.toString('latin1'))));
    s.once('error', () => { /* 'close' follows */ });
    s.once('close', () => {
      const was = sock === s;
      sock = undefined;
      if (closed) return;
      if (was) say('Connection closed by the simulator.');
      else if (attempts === 1) say(`Waiting for the simulator to listen on ${host}:${port}…`);
      // The simulator opens the socket during elaboration; keep trying while it runs.
      if (attempts < 600) timer = setTimeout(connect, was ? 2000 : 500);
      else say('Gave up: nothing listens there. Check the backend\'s address in the platform.');
    });
  };
  const pty = {
    onDidWrite: write.event,
    onDidClose: done.event,
    open: () => connect(),
    close: () => { closed = true; clearTimeout(timer); if (sock) sock.destroy(); open.delete(c.name); },
    handleInput: (data) => { if (sock) sock.write(Buffer.from(data, 'latin1')); },
  };
  const terminal = vscode.window.createTerminal({ name: consoles.terminalName(c), pty, iconPath: new vscode.ThemeIcon('terminal') });
  open.set(c.name, { terminal, close: () => { closed = true; clearTimeout(timer); if (sock) sock.destroy(); done.fire(undefined); } });
  return terminal;
}

/**
 * Open a terminal for every console in list ([{name, uart, host, port}]). mapPort(port) gives the
 * local port to connect to (a remote simulation's SSH forward); host is then 127.0.0.1.
 * @param {Array<{name: string, uart: string, host: string, port: number}>} list
 * @param {{mapPort?: (port: number) => number|undefined, where?: string}} [opts]
 */
function openAll(list, { mapPort = undefined, where = '' } = {}) {
  closeAll();
  for (const c of list) {
    const port = mapPort ? mapPort(c.port) : c.port;
    if (!port) continue;
    openOne(c, { host: mapPort ? '127.0.0.1' : (c.host === '0.0.0.0' ? '127.0.0.1' : c.host), port, where });
  }
}

/** The simulation stopped: close the console terminals. */
function closeAll() {
  for (const x of [...open.values()]) x.close();
  open.clear();
}

/** The open console terminals (for Show UART Consoles). */
function terminals() { return [...open.values()].map((x) => x.terminal); }

exports.openAll = openAll;
exports.closeAll = closeAll;
exports.terminals = terminals;
