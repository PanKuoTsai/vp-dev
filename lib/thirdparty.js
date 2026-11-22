'use strict';
// Third-party debuggers (G-11): set-up files for debuggers that speak the GDB
// remote serial protocol to the simulator's QEMU gdbstub.
//
//   TRACE32   confirmed from Lauterbach's "TRACE32 as GDB Front-End"
//             (frontend_gdb.pdf, "Example: Connecting to QEMU"): config.t32
//             PBI=GDB; SYStem.CPU, SYStem.PORT host:port,
//             SYStem.GDBconfig GDBSERVER OFF, SYStem.Mode Attach. Each core of
//             an SMP target is a thread of execution.
//   Arm DS    not confirmed: Arm's forum says bare-metal debug does not use
//             gdbserver; a third-party guide shows a "Connections via gdbserver
//             to a bare metal target" connection type. Written as steps to try.
//   gdb       any GDB-protocol client (gdb-multiarch, Eclipse CDT, ...).
//
// QBox opens the gdbstub as "tcp::<port>", which listens on every interface:
// a debugger on another machine can connect to <this host>:<port>.
// No VS Code dependency.

const path = require('path');
const core = require('./core');

/**
 * TRACE32 SYStem.CPU names for QBox CPU module types. Lauterbach writes Arm
 * cores as CortexA53 etc.; the exact name for a core must still be checked in
 * TRACE32's SYStem.CPU list (the script says so).
 */
const TRACE32_CPU = {
  cpu_arm_cortexA53: 'CortexA53',
  cpu_arm_cortexA55: 'CortexA55',
  cpu_arm_cortexA72: 'CortexA72',
  cpu_arm_cortexA76: 'CortexA76',
  cpu_arm_cortexA710: 'CortexA710',
  cpu_arm_neoverseN1: 'NeoverseN1',
  cpu_arm_neoverseN2: 'NeoverseN2',
  cpu_arm_cortexR5: 'CortexR5',
  cpu_arm_cortexR52: 'CortexR52',
  cpu_arm_cortexM7: 'CortexM7',
  cpu_arm_cortexM55: 'CortexM55',
};

/** The TRACE32 executable for a CPU type: t32marm64 for 64-bit Arm, t32marm for 32-bit, t32mriscv, ... */
function trace32Exe(type) {
  const t = String(type);
  if (/riscv/i.test(t)) return 't32mriscv';
  if (/cortex[MR]\d/i.test(t)) return 't32marm';
  if (/arm|neoverse/i.test(t)) return 't32marm64';
  return 't32m<architecture>';
}

/** gdb architecture name for a CPU type. */
function gdbArch(type) {
  const t = String(type);
  if (/riscv/i.test(t)) return 'riscv';
  if (/cortex[MR]\d/i.test(t)) return 'arm';
  if (/arm|neoverse/i.test(t)) return 'aarch64';
  return undefined;
}

/**
 * Where the platform's gdbstub is. The port is the gdb_port of a CPU in the
 * platform, or else the one "Start Simulation with Target Debug Port" sets
 * (settings vpStudio.debug.gdbPort on vpStudio.debug.cpuInstance).
 * Returns { port, source: 'platform'|'debug-start', cpu, type, cores } or
 * throws Error when the platform has no CPU.
 */
function gdbTarget(doc, analysis, { port = 1234, cpuInstance = 'cpu_0' } = {}) {
  const a = analysis || core.analyze(doc);
  const cpus = a.instances.filter((i) => String(i.type).startsWith('cpu_'));
  if (!cpus.length) throw new Error('The platform has no CPU (no module type starting with cpu_).');
  const env = a.env;
  const withPort = cpus.find((i) => {
    if (!('gdb_port' in i.params)) return false;
    try { return core.evalInt(i.params.gdb_port, env) !== 0n; } catch (e) { return false; }
  });
  const cpu = withPort || cpus.find((i) => i.name === cpuInstance) || cpus[0];
  const qemuOf = (i) => { const q = i.args.find((x) => typeof x === 'object'); return q ? q.ref : ''; };
  const cores = cpus.filter((i) => qemuOf(i) === qemuOf(cpu)).length;
  return {
    port: withPort ? Number(core.evalInt(withPort.params.gdb_port, env)) : Number(port),
    source: withPort ? 'platform' : 'debug-start',
    cpu: cpu.name, type: cpu.type, cores,
  };
}

const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

/**
 * A TRACE32 PRACTICE script (.cmm) that attaches to the gdbstub and loads the
 * symbol files without code.
 */
function trace32Script({ platform, host, port, type, cores, symbols = [] }) {
  const cpu = TRACE32_CPU[type];
  const lines = [
    `; TRACE32 GDB Front-End: attach to the VP Studio simulation of ${platform}.`,
    '; Written by "VP Studio: Third-Party Debugger Setup…"; run it again to rewrite this file.',
    ';',
    `; 1. TRACE32 as GDB Front-End: add PBI=GDB (with an empty line before and after) to config.t32,`,
    `;    and start ${trace32Exe(type)}.`,
    `; 2. Start the simulation with its gdb port (${port}) open, then run this script (DO ${'<this file>'}).`,
    `;    The simulator's ${cores} core${cores === 1 ? '' : 's'} appear${cores === 1 ? 's' : ''} as threads of the target.`,
    '',
    'RESet',
    'SYStem.RESet',
  ];
  if (cpu) lines.push(`SYStem.CPU ${cpu}  ; QBox type ${type}: if TRACE32 names it differently, pick it in the SYStem.CPU list`);
  else lines.push(`; QBox type ${type} has no TRACE32 name here: choose the core in the SYStem.CPU list, then continue.`, 'SYStem.CPU');
  lines.push(
    `SYStem.PORT ${host}:${port}`,
    'SYStem.GDBconfig GDBSERVER OFF  ; the remote end is a gdbstub (QEMU), not a GNU gdbserver',
    'SYStem.Mode Attach',
    '',
  );
  if (symbols.length) {
    lines.push('; Symbols only (/NoCODE): the code is already in the simulated memory.');
    lines.push('; With KASLR the kernel runs at a random offset; boot with nokaslr, or relocate the symbols.');
    for (const s of symbols) lines.push(`Data.LOAD.Elf ${q(s)} /NoCODE`);
  } else {
    lines.push('; No symbol file is set in the platform ("debug.symbols"). To add one:');
    lines.push(';   Data.LOAD.Elf "vmlinux" /NoCODE');
  }
  lines.push('', 'List.auto', 'Register.view', 'ENDDO', '');
  return lines.join('\n');
}

/** The guide (Markdown) for every third-party debugger, with this platform's values filled in. */
function guide({ platform, host, port, source, cpu, type, cores, symbols = [], cmmFile, hostNames = [] }) {
  const arch = gdbArch(type);
  const where = source === 'platform'
    ? `\`${cpu}\` sets \`gdb_port\` ${port} in the platform, so every Start Simulation opens it.`
    : `The platform sets no \`gdb_port\`: use **Start Simulation with Target Debug Port**, which opens port ${port} on \`${cpu}\` (settings \`vpStudio.debug.gdbPort\`, \`vpStudio.debug.cpuInstance\`).`;
  const others = hostNames.length ? ` From another machine, use this machine's name or address (${hostNames.map((h) => `\`${h}\``).join(', ')}).` : '';
  const sym = symbols[0];
  const md = [];
  md.push(`# Third-party debuggers for ${platform}`, '');
  md.push('Written by **VP Studio: Third-Party Debugger Setup…**; run it again to rewrite this file.', '');
  md.push('## The gdbstub', '');
  md.push(`- ${where}`);
  md.push(`- Address: \`${host}:${port}\`.${others}`);
  md.push(`- The simulator has one gdb server per QEMU instance. It shows all ${cores} core${cores === 1 ? '' : 's'} (\`${type}\`) as threads.`);
  md.push('- QBox opens it on every network interface, without a password: anyone who can reach the port controls the simulation. On a shared network, block the port and use an SSH tunnel: `ssh -L ' + `${port}:localhost:${port} <user>@<simulation host>` + '`, then connect to `localhost:' + port + '`.');
  md.push('- Only one debugger can be attached at a time. Detach VS Code (Disconnect, not Stop) before attaching another.');
  md.push('- With KASLR on, kernel symbols do not match the running addresses. Boot with `nokaslr`, or use a debugger that relocates them. VP Studio\'s own gdb does this with `vp-kaslr`.', '');

  md.push('## Lauterbach TRACE32', '');
  md.push('Supported by Lauterbach: QEMU is a documented target of the TRACE32 GDB Front-End ("TRACE32 as GDB Front-End", frontend_gdb.pdf, "Example: Connecting to QEMU"). Needs a TRACE32 installation with the GDB Front-End.', '');
  md.push(`1. Add to \`config.t32\` (an empty line before and after is required):`, '', '   ```', '', '   PBI=GDB', '', '   ```', '');
  md.push(`2. Start \`${trace32Exe(type)}\`. Start the simulation.`);
  md.push(`3. Run the script: \`DO ${cmmFile ? path.basename(cmmFile) : 'attach.cmm'}\` (next to this file). It runs:`, '');
  md.push('   ```', `   SYStem.CPU ${TRACE32_CPU[type] || '<core>'}`, `   SYStem.PORT ${host}:${port}`, '   SYStem.GDBconfig GDBSERVER OFF', '   SYStem.Mode Attach');
  if (sym) md.push(`   Data.LOAD.Elf "${sym}" /NoCODE`);
  md.push('   ```', '');
  md.push(`- If TRACE32 names \`${type}\` differently, pick the core in the \`SYStem.CPU\` list.`);
  md.push('- Breakpoints are sent to the gdbstub as Z packets. QEMU implements them, so there is no limit of hardware comparators. TRACE32\'s secure and non-secure memory classes need Lauterbach\'s `qtrace32.memory` protocol extension, which QEMU does not implement: memory is read the way the selected core sees it.');
  md.push('- Linux awareness (task list): load the Lauterbach Linux awareness for the GDB Front-End as its documentation describes. It needs symbols that match the running kernel.', '');

  md.push('## Arm Development Studio', '');
  md.push('**Not confirmed.** Arm\'s forum answers say Arm DS bare-metal debug does not use gdbserver; it uses debug probes and Arm models (Iris/CADI). A third-party guide (Corellium) does show a connection type **Connections via gdbserver to a bare metal target**. Try:', '');
  md.push('1. **Run > Debug Configurations… > Generic Arm C/C++ Application > New**.');
  md.push(`2. **Connection** tab: under **Bare Metal Debug**, pick a generic ${arch === 'aarch64' ? 'Armv8-A' : 'Arm'} target, then **Connections via gdbserver to a bare metal target**. If your Arm DS has no such entry, it cannot attach to the simulator this way.`);
  md.push(`3. **gdbserver (TCP)**: address \`${host}\`, port \`${port}\`.`);
  md.push(`4. **Files**: ${sym ? `load symbols from \`${sym}\` only (no image download)` : 'symbols only, no image download'}. **Debugger**: Connect only.`);
  md.push('5. Start the simulation, then **Debug**.', '');
  md.push('If that connection type is missing, Arm DS needs an Iris or CADI interface, which QBox does not provide. That would mean a QBox change, and is out of scope for now.', '');

  md.push('## Any GDB client', '');
  md.push('Command line:', '', '```', `gdb-multiarch${sym ? ` ${sym}` : ''}`, ...(arch ? [`(gdb) set architecture ${arch}`] : []), `(gdb) target extended-remote ${host}:${port}`, '(gdb) info threads', '```', '');
  md.push('Other IDEs (Eclipse CDT, CLion, Ozone…): use their "GDB remote" or "gdbserver" connection with the same host and port, without loading an image.');
  md.push('');
  return md.join('\n');
}

module.exports = { TRACE32_CPU, trace32Exe, gdbArch, gdbTarget, trace32Script, guide };
