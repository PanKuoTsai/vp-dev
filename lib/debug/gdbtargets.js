'use strict';
// Debug targets of a platform: each QEMU instance has one gdb server that
// shows all of its CPUs, opened by the gdb_port parameter of one of them. A
// platform with several instances (an application cluster and a real-time
// core, say) gets one port and one debug configuration per instance, and a
// compound configuration that attaches to all of them.
// No VS Code dependency.

const core = require('../platform/core');

/** gdb's name for the architecture of a QBox CPU type, for the configuration's description. */
function archOf(type) {
  const t = String(type).toLowerCase();
  if (/riscv/.test(t)) return 'riscv';
  if (/hexagon/.test(t)) return 'hexagon';
  if (/cortexm|cortex_m|cortexr|cortex_r/.test(t)) return 'arm';
  if (/^cpu_arm/.test(t)) return 'aarch64';
  return '';
}

/**
 * [{ qemu, cpus: [instance names], cpu: the one that opens the server, port, preset, arch }] in the order
 * the platform lists them. A port the platform already sets (gdb_port not 0 on one of the instance's CPUs)
 * is kept (preset); the others get basePort, basePort + 1, ... skipping ports in use. preferCpu
 * (vpStudio.debug.cpuInstance) opens the server of its own instance.
 */
function targets(doc, { basePort = 1234, preferCpu = 'cpu_0', param = 'gdb_port' } = {}) {
  const { instances, env } = core.expand(doc);
  const groups = new Map();
  for (const inst of instances) {
    if (!String(inst.type).startsWith('cpu_')) continue;
    const q = inst.args.find((a) => typeof a === 'object');
    const key = q ? q.ref : '';
    if (!groups.has(key)) groups.set(key, { qemu: key || '(no QEMU instance)', cpus: [], types: [], preset: null });
    const g = groups.get(key);
    g.cpus.push(inst.name);
    g.types.push(inst.type);
    if (param in inst.params && g.preset === null) {
      const v = core.evalInt(inst.params[param], env);
      if (v !== null && v !== 0n) g.preset = { cpu: inst.name, port: Number(v) };
    }
  }
  const used = new Set([...groups.values()].filter((g) => g.preset).map((g) => g.preset.port));
  let next = basePort;
  const out = [];
  for (const g of groups.values()) {
    let cpu;
    let port;
    if (g.preset) ({ cpu, port } = g.preset);
    else {
      while (used.has(next)) next++;
      port = next;
      used.add(port);
      cpu = g.cpus.includes(preferCpu) ? preferCpu : g.cpus[0];
    }
    out.push({ qemu: g.qemu, cpus: g.cpus, cpu, port, preset: !!g.preset, arch: archOf(g.types[0]) });
  }
  return out;
}

/** The parameter overrides that open the gdb servers the platform does not open itself. */
const overrides = (list, param = 'gdb_port') => list.filter((t) => !t.preset).map((t) => ({ instance: t.cpu, param, value: t.port }));

const BASE_NAME = 'VP: attach to target software';
const COMPOUND_NAME = 'VP: attach to every QEMU instance';

/** Name of target k's configuration: the first keeps the one-instance name, so existing launch.json entries still match. */
const configName = (t, k) => (k === 0 ? BASE_NAME : `${BASE_NAME} (${t.qemu})`);

module.exports = { archOf, targets, overrides, configName, BASE_NAME, COMPOUND_NAME };
