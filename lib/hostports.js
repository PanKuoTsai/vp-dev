'use strict';
// Host TCP ports a platform opens (QEMU hostfwd and the like): which
// variables hold them, and which ports to use when some are taken. Variables
// marked "hostPort" keep their configured port when it is free, so habits
// such as "ssh -p 2222" keep working, and move to a free port otherwise.
// No VS Code dependency.

const net = require('net');
const core = require('./core');

/** The platform's host port variables: [{ name, port }] (port null when not a constant). */
function hostPortVariables(doc) {
  const env = core.buildEnv(doc);
  return (doc.variables || []).filter((v) => v && v.hostPort).map((v) => {
    const n = core.evalInt(v.value, env);
    return { name: v.name, port: n === null ? null : Number(n) };
  });
}

/** Whether a TCP port can be bound on host right now (QEMU's hostfwd binds all addresses). */
function isPortFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/** A port that is free right now on host. */
function freePort(host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen({ port: 0, host, exclusive: true }, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Choose a port for each host port variable.
 * Returns { values: {NAME: port}, moved: [{ name, from, to }] }.
 * isFree(port) and pick() are injectable for tests.
 */
async function choosePorts(vars, { isFree = isPortFree, pick = freePort } = {}) {
  const values = {};
  const moved = [];
  const used = new Set();
  for (const v of vars) {
    let port = v.port;
    if (port === null || !(port > 0 && port < 65536) || used.has(port) || !(await isFree(port))) {
      let p;
      do { p = await pick(); } while (used.has(p));
      moved.push({ name: v.name, from: v.port, to: p });
      port = p;
    }
    used.add(port);
    values[v.name] = port;
  }
  return { values, moved };
}

module.exports = { hostPortVariables, isPortFree, freePort, choosePorts };
