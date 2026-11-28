'use strict';
// G-13: an Arm debug port that OpenOCD reaches over JTAG (remote_bitbang).
// The debug_dap module is a QBox component (systemc-components/debug_dap; in
// the sim agent's library up to agent 0.13.0). With the cores' QEMU instance
// (its `qemu` parameter) it also gives core debug: OpenOCD's aarch64 target
// halts, steps, reads and writes registers and memory, and sets breakpoints,
// and its gdb server serves gdb. This file adds the module to a platform and
// writes the matching OpenOCD configuration. No VS Code dependency.

const core = require('../platform/core');

const MIN_AGENT = '0.13.0';
// From agent 0.14.0 the probes and this port are QBox components
// (systemc-components/probes, debug_dap): built with QBox, loaded from
// its build directory. Agent 0.13.0 carried them in its own library.
const IN_QBOX_AGENT = '0.14.0';
const INSTANCE = 'debug_dap';
const DBG_BASE = 0x80000000;
const coreBase = (n) => DBG_BASE + 0x10000 + n * 0x20000;
const ctiBase = (n) => coreBase(n) + 0x10000;

// MIDR_EL1 of the Arm CPU models QBox has, as their external debug registers show it.
const MIDR = {
  cpu_arm_cortexA53: 0x410FD034, cpu_arm_cortexA55: 0x412FD050, cpu_arm_cortexA76: 0x414FD0B1,
  cpu_arm_cortexA710: 0x412FD471, cpu_arm_neoverseN2: 0x410FD490,
};

/**
 * The CPUs the debug port can reach: Arm cores in index order, the router
 * their `mem` port is bound to, whether a `halt` port is already wired, and
 * the cores' QEMU instance (null when they are in several: then the port
 * only halts and resumes them; core n is QEMU's CPU n of the instance).
 * { cpus: [{ name, base, index, type }], bus, qemu, problems: [text] }
 */
function targets(doc) {
  const a = core.analyze(doc);
  const cpus = a.instances.filter((i) => !i.isContainer && /^cpu_arm_/.test(i.type));
  const problems = [];
  if (!cpus.length) problems.push('The platform has no Arm CPU (types cpu_arm_…), so there is nothing for the debug port to halt.');
  const buses = new Set(cpus.map((c) => {
    const m = a.connections.find((x) => x.from === c.name && x.fromPort === 'mem' && a.buses.includes(x.to));
    return m ? m.to : null;
  }));
  buses.delete(null);
  if (cpus.length && !buses.size) problems.push('The CPUs\' mem ports are not bound to a router, so the system access port has no bus to use.');
  if (buses.size > 1) problems.push(`The CPUs use different routers (${[...buses].join(', ')}); the system access port goes to ${[...buses][0]}.`);
  for (const c of cpus) {
    const used = a.connections.some((x) => (x.to === c.name && x.toPort === 'halt') || (x.from === c.name && x.fromPort === 'halt'));
    if (used) problems.push(`${c.name}.halt is already connected in the platform; the debug port needs it to halt that core.`);
  }
  const qemus = new Set();
  const names = new Set(cpus.map((c) => c.name));
  for (const inst of core.expand(doc).instances) {
    if (!names.has(inst.name)) continue;
    const q = inst.args.find((x) => x && typeof x === 'object' && x.ref);
    qemus.add(q ? q.ref : null);
  }
  const qemu = qemus.size === 1 ? [...qemus][0] : null;
  if (cpus.length && qemus.size > 1) problems.push(`The CPUs are in ${qemus.size} QEMU instances; the debug port can halt and resume them, but core debug (registers, stepping, breakpoints) needs them in one.`);
  return { cpus: cpus.map((c) => ({ name: c.name, base: c.base, index: c.index, type: c.type })), bus: [...buses][0] || null, qemu, problems };
}

/**
 * The extraModules entry that adds the debug port, or throws with the
 * problems that stop it. port: TCP port for OpenOCD's remote_bitbang.
 * dylib and type: QBox's debug_dap component (type debug_dap, found by its
 * name: no dylib) for agent 0.14.0; the agent's library and vp_debug_dap for
 * agent 0.13.0 (trace.probeLibraries gives both).
 */
function dapModule(doc, port, dylib = null, type = 'debug_dap') {
  const t = targets(doc);
  const blocking = t.problems.filter((p) => !/different routers|QEMU instances/.test(p));
  if (blocking.length) throw new Error(blocking.join(' '));
  const ports = { mem: { bind: `${t.bus}.target_socket` } };
  t.cpus.forEach((c, k) => { ports[`halt_${k}`] = { bind: `${c.name}.halt` }; });
  const params = { port, cpus: t.cpus.length };
  const midr = MIDR[t.cpus[0].type];
  if (midr) params.midr = midr;
  if (t.qemu) params.qemu = `platform.${t.qemu}`; // its SystemC name
  const m = { name: INSTANCE, type, params, ports };
  if (dylib) m.dylib = dylib;
  return m;
}

const hex = (n) => '0x' + n.toString(16).toUpperCase().padStart(8, '0');

/**
 * OpenOCD configuration for the debug port: the JTAG TAP and DAP, an aarch64
 * target per core (with its CTI) in one SMP group whose gdb server shows each
 * core as a thread, mem_ap targets on the two access ports (vp.sys: system
 * bus, vp.dbg: debug bus), and the command vp_status.
 * opts: { port, host = '127.0.0.1', cpus (count), platform (name, for the comment), gdbPort (the gdb server) }
 */
function openocdConfig({ port, host = '127.0.0.1', cpus, platform = '', gdbPort = 3333 }) {
  const n = Math.max(1, cpus | 0);
  const L = [];
  L.push(`# OpenOCD configuration for the VP Studio debug port${platform ? ` of ${platform}` : ''} (G-13).`);
  L.push('# Written by VP Studio. Start the simulation with "Start Simulation with OpenOCD Port", then:');
  L.push('#   openocd -f <this file>');
  L.push('# In another terminal: telnet localhost 4444 (or nc localhost 4444) for OpenOCD\'s commands:');
  L.push('#   halt, resume, step, reg, reg pc, mdw <address>, bp <address> 4 [hw], rbp all, targets,');
  L.push('#   vp.sys mdw <physical address>, vp_status');
  L.push(`# or gdb: gdb-multiarch -ex "target extended-remote localhost:${gdbPort}" (one thread per core).`);
  L.push('#');
  L.push('# The cores are one SMP group: halting one halts all of them. Memory through a core');
  L.push('# (mdw, gdb) uses its virtual addresses; vp.sys reads the system bus. System registers');
  L.push('# are read-only. Needs QBox\'s debug_dap with core debug (VP Studio 0.2.10 or later:');
  L.push('# rebuild QBox with "VP Studio: Build QBox"); an older one only halts and resumes.');
  L.push('');
  L.push('adapter driver remote_bitbang');
  L.push(`remote_bitbang host ${host}`);
  L.push(`remote_bitbang port ${port}`);
  L.push('transport select jtag');
  L.push('adapter speed 10000');
  L.push('');
  L.push('jtag newtap vp cpu -irlen 4 -expected-id 0x4ba00477');
  L.push('dap create vp.dap -chain-position vp.cpu');
  L.push('');
  L.push('# AP0: system bus, as the CPUs see it. AP1: debug bus (ROM table, core debug, CTIs).');
  L.push('target create vp.sys mem_ap -dap vp.dap -ap-num 0 -gdb-port disabled');
  L.push('target create vp.dbg mem_ap -dap vp.dap -ap-num 1 -gdb-port disabled');
  L.push('');
  L.push(`set VP_CORES ${n}`);
  L.push('proc vp_core_base {n} { return [expr {' + `${hex(DBG_BASE + 0x10000)} + $n * 0x20000` + '}] }');
  L.push('set vp_smp {}');
  L.push('for {set k 0} {$k < $VP_CORES} {incr k} {');
  L.push(`    cti create vp.cti$k -dap vp.dap -ap-num 1 -baseaddr [expr {${hex(ctiBase(0))} + $k * 0x20000}]`);
  L.push(`    target create vp.cpu$k aarch64 -dap vp.dap -ap-num 1 -dbgbase [vp_core_base $k] -cti vp.cti$k -coreid $k -gdb-port [expr {$k == 0 ? ${gdbPort} : "disabled"}]`);
  L.push('    vp.cpu$k configure -rtos hwthread');
  L.push('    lappend vp_smp vp.cpu$k');
  L.push('}');
  L.push('target smp {*}$vp_smp');
  L.push('# OpenOCD leaves the cores halted when gdb disconnects; let them run on.');
  L.push('vp.cpu0 configure -event gdb-detach { resume }');
  L.push('');
  L.push('# Each core\'s state from its external debug registers. Without n: every core.');
  L.push('proc vp_status {{n -1}} {');
  L.push('    global VP_CORES');
  L.push('    set list {}');
  L.push('    if {$n < 0} { for {set k 0} {$k < $VP_CORES} {incr k} { lappend list $k } } else { lappend list $n }');
  L.push('    foreach k $list {');
  L.push('        set b [vp_core_base $k]');
  L.push('        set prsr [vp.dbg read_memory [expr {$b + 0x314}] 32 1]');
  L.push('        set scr [vp.dbg read_memory [expr {$b + 0x088}] 32 1]');
  L.push('        echo [format "core %d: %s (EDSCR 0x%08x, EDPRSR 0x%08x)" $k [expr {$prsr & 0x10 ? "halted" : "running"}] $scr $prsr]');
  L.push('    }');
  L.push('}');
  L.push('');
  L.push('init');
  return L.join('\n') + '\n';
}

module.exports = { MIN_AGENT, IN_QBOX_AGENT, INSTANCE, DBG_BASE, coreBase, ctiBase, targets, dapModule, openocdConfig };
