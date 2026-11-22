'use strict';
// G-13 (first stage): an Arm debug port that OpenOCD reaches over JTAG
// (remote_bitbang). The debug_dap module is a QBox component
// (systemc-components/debug_dap; in the sim agent's library up to agent
// 0.13.0). This file adds it to a platform and writes the matching OpenOCD
// configuration. No VS Code dependency.

const core = require('./core');

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
 * their `mem` port is bound to, and whether a `halt` port is already wired.
 * { cpus: [{ name, base, index, type }], bus, problems: [text] }
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
  return { cpus: cpus.map((c) => ({ name: c.name, base: c.base, index: c.index, type: c.type })), bus: [...buses][0] || null, problems };
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
  const blocking = t.problems.filter((p) => !/different routers/.test(p));
  if (blocking.length) throw new Error(blocking.join(' '));
  const ports = { mem: { bind: `${t.bus}.target_socket` } };
  t.cpus.forEach((c, k) => { ports[`halt_${k}`] = { bind: `${c.name}.halt` }; });
  const params = { port, cpus: t.cpus.length };
  const midr = MIDR[t.cpus[0].type];
  if (midr) params.midr = midr;
  const m = { name: INSTANCE, type, params, ports };
  if (dylib) m.dylib = dylib;
  return m;
}

const hex = (n) => '0x' + n.toString(16).toUpperCase().padStart(8, '0');

/**
 * OpenOCD configuration for the debug port: the JTAG TAP and DAP, a mem_ap
 * target on each access port (vp.sys: system bus, vp.dbg: debug bus), one CTI
 * per core, and commands vp_halt, vp_resume and vp_status.
 * opts: { port, host = '127.0.0.1', cpus (count), platform (name, for the comment), gdbPort (first gdb port for the mem_ap targets) }
 */
function openocdConfig({ port, host = '127.0.0.1', cpus, platform = '', gdbPort = 3333 }) {
  const n = Math.max(1, cpus | 0);
  const L = [];
  L.push(`# OpenOCD configuration for the VP Studio debug port${platform ? ` of ${platform}` : ''} (G-13, first stage).`);
  L.push('# Written by VP Studio. Start the simulation with "Start Simulation with OpenOCD Port", then:');
  L.push('#   openocd -f <this file>');
  L.push('# and in another terminal: telnet localhost 4444 (or nc localhost 4444).');
  L.push('#');
  L.push('# What works in this stage: the DAP and ROM table (vp.dap info 1), memory on the system');
  L.push('# bus (vp.sys mdw / mww, 64-bit addresses), and halting or resuming a core through');
  L.push('# its CTI (vp_halt / vp_resume / vp_halt_all / vp_resume_all / vp_status). OpenOCD\'s aarch64 target, which reads');
  L.push('# core registers by running instructions in Debug state, is not supported yet.');
  L.push('# Use "vp.dap info", not the bare "dap info": with only mem_ap targets, OpenOCD 0.12');
  L.push('# finds no DAP for the bare command and crashes.');
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
  L.push(`target create vp.sys mem_ap -dap vp.dap -ap-num 0 -gdb-port ${gdbPort}`);
  L.push(`target create vp.dbg mem_ap -dap vp.dap -ap-num 1 -gdb-port ${gdbPort + 1}`);
  L.push('');
  for (let k = 0; k < n; k++) L.push(`cti create vp.cti${k} -dap vp.dap -ap-num 1 -baseaddr ${hex(ctiBase(k))}`);
  L.push('');
  L.push(`set VP_CORES ${n}`);
  L.push('proc vp_core_base {n} { return [expr {' + `${hex(DBG_BASE + 0x10000)} + $n * 0x20000` + '}] }');
  L.push('');
  L.push('# Unlock the OS lock, enable halting debug (EDSCR.HDE) and route the CTI:');
  L.push('# channel 0 -> trigger out 0 (debug request), channel 1 -> trigger out 1 (restart).');
  L.push('proc vp_setup {n} {');
  L.push('    set b [vp_core_base $n]');
  L.push('    vp.dbg mww [expr {$b + 0x300}] 0');
  L.push('    set edscr [vp.dbg read_memory [expr {$b + 0x088}] 32 1]');
  L.push('    vp.dbg mww [expr {$b + 0x088}] [expr {$edscr | 0x4000}]');
  L.push('    vp.cti$n enable on');
  L.push('    vp.cti$n write OUTEN0 1');
  L.push('    vp.cti$n write OUTEN1 2');
  L.push('    vp.cti$n write GATE 0');
  L.push('}');
  L.push('');
  L.push('# Without n: every core.');
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
  L.push('# Halt core n: a debug request through its CTI (channel 0).');
  L.push('proc vp_halt {n} {');
  L.push('    vp_setup $n');
  L.push('    vp.cti$n channel 0 pulse');
  L.push('    vp_status $n');
  L.push('}');
  L.push('');
  L.push('# Resume core n: acknowledge the debug request, then a restart request (channel 1).');
  L.push('proc vp_resume {n} {');
  L.push('    vp.cti$n ack 0');
  L.push('    vp.cti$n channel 1 pulse');
  L.push('    vp_status $n');
  L.push('}');
  L.push('');
  L.push('# Every core at once: the CTIs pass channels 0 and 1 to each other (cross-triggering),');
  L.push('# so one pulse on core 0\'s CTI reaches all of them.');
  L.push('proc vp_halt_all {} {');
  L.push('    global VP_CORES');
  L.push('    for {set k 0} {$k < $VP_CORES} {incr k} { vp_setup $k; vp.cti$k write GATE 3 }');
  L.push('    vp.cti0 channel 0 pulse');
  L.push('    vp_status');
  L.push('}');
  L.push('');
  L.push('proc vp_resume_all {} {');
  L.push('    global VP_CORES');
  L.push('    for {set k 0} {$k < $VP_CORES} {incr k} { vp.cti$k ack 0; vp.cti$k write GATE 3 }');
  L.push('    vp.cti0 channel 1 pulse');
  L.push('    vp_status');
  L.push('}');
  L.push('');
  L.push('init');
  return L.join('\n') + '\n';
}

module.exports = { MIN_AGENT, IN_QBOX_AGENT, INSTANCE, DBG_BASE, coreBase, ctiBase, targets, dapModule, openocdConfig };
