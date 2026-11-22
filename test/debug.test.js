'use strict';
// Run with: node test/debug.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/platform/core');
const trace = require('../lib/analysis/trace');
const { load } = require('./helpers');

test('cpu registers: groups, PSTATE, changes, compact SIMD values, the view', () => {
  const cr = require('../lib/debug/cpuregs');
  assert.deepStrictEqual(['x0', 'x30', 'sp', 'pc', 'cpsr', 'v31', 'fpsr', 'SCTLR_EL1', 'tpidr', 'w3', 'q0', 'b31'].map(cr.classify),
    ['general', 'general', 'general', 'general', 'general', 'fp', 'fp', 'system', 'system', 'alias', 'alias', 'alias']);
  // cpsr as QEMU's gdbstub gave it for a CPU idling in the kernel: N set, IRQ and FIQ masked, EL1 on SP_EL1.
  const p = cr.decodePstate('0x800000c5');
  assert.deepStrictEqual([p.n, p.z, p.c, p.v, p.d, p.a, p.i, p.f, p.mode], [1, 0, 0, 0, 0, 0, 1, 1, 'EL1h']);
  assert.strictEqual(cr.decodePstate('0x3c4').mode, 'EL1t');
  assert.strictEqual(cr.decodePstate('nonsense'), null);
  const v0 = '{d = {f = {0x0, 0x0}, u = {0x0, 0x0}, s = {0x0, 0x0}}, b = {u = {0x0 <repeats 16 times>}}, q = {u = {0x3f800000}, s = {0x3f800000}}}';
  assert.strictEqual(cr.compactValue(v0), '0x3f800000');
  const names = { 'register-names': ['x0', 'x1', '', 'pc', 'v0', 'w0'] };
  const vals = { 'register-values': [{ number: '0', value: '0x1' }, { number: '1', value: '0x2' }, { number: '3', value: '0xffffc98ba16430b4' }, { number: '4', value: v0 }, { number: '5', value: '0x1' }] };
  const first = cr.snapshot(names, vals);
  assert.deepStrictEqual(first.map((r) => [r.name, r.group, r.changed]), [['x0', 'general', false], ['x1', 'general', false], ['pc', 'general', false], ['v0', 'fp', false]]);
  const prev = new Map(first.map((r) => [r.name, r.value]));
  vals['register-values'][1].value = '0x3';
  assert.deepStrictEqual(cr.snapshot(names, vals, prev).filter((r) => r.changed).map((r) => r.name), ['x1']);
  assert.strictEqual(cr.valuesCommand(8), '-data-list-register-values --thread 8 --frame 0 x');
  const html = require('../lib/webview/cpuregsview').render('N3', 'x');
  assert.ok(html.includes("script-src 'nonce-N3'") && html.includes('id="g-system"') && html.includes("post({ type: 'ready' })"));
  assert.ok(!/<[a-z]+ [^>]*style="/.test(html.replace(/<style[\s\S]*?<\/style>/, '')));
});

test('kernel sources: map a build path to a local tree, and gdb gets it at attach', () => {
  const gl = require('../lib/debug/guestlinux');
  const local = new Set(['/home/me/linux/arch/arm64/kernel/idle.c']);
  const m = gl.sourceMapping('/build/linux-oPNunh/linux-5.15.0/arch/arm64/kernel/idle.c', '/home/me/linux/', (p) => local.has(p));
  assert.deepStrictEqual(m, { from: '/build/linux-oPNunh/linux-5.15.0', to: '/home/me/linux', file: '/home/me/linux/arch/arm64/kernel/idle.c' });
  assert.strictEqual(gl.sourceMapping('/build/x/linux/kernel/fork.c', '/home/me/linux', () => false), null);
  assert.deepStrictEqual(gl.substituteCommands({ '/build/a b': '/home/me/x' }), ['set substitute-path "/build/a b" "/home/me/x"']);
  const c = gl.withSourceMap({ type: 'gdbtarget', initCommands: ['foo'] }, { '/build/a': '/b' });
  assert.deepStrictEqual(c.initCommands, ['foo', 'set substitute-path "/build/a" "/b"']);
  assert.strictEqual(gl.withSourceMap(c, { '/build/a': '/b' }).initCommands.length, 2); // not twice
  const none = { type: 'gdbtarget' };
  assert.strictEqual(gl.withSourceMap(none, {}), none);
});

test('debug port (G-13): module wiring for the Ubuntu example and the OpenOCD configuration', () => {
  const dd = require('../lib/debug/debugdap');
  const d = load();
  const t = dd.targets(d);
  assert.deepStrictEqual(t.cpus.map((c) => c.name), ['cpu_0', 'cpu_1', 'cpu_2', 'cpu_3', 'cpu_4', 'cpu_5', 'cpu_6', 'cpu_7']);
  assert.strictEqual(t.bus, 'router');
  assert.deepStrictEqual(t.problems, []);
  // QBox's vp_debug_dap component (agent 0.14.0): no dylib, QBox finds it by the type name.
  const m = dd.dapModule(d, 3335);
  assert.strictEqual(m.dylib, undefined);
  assert.strictEqual(dd.dapModule(d, 3335, '/x/vp_sim_agent').dylib, '/x/vp_sim_agent'); // agent 0.13.0 carried it
  assert.deepStrictEqual(m.params, { port: 3335, cpus: 8, midr: 0x414FD0B1 });
  assert.deepStrictEqual(m.ports.mem, { bind: 'router.target_socket' });
  assert.deepStrictEqual(m.ports.halt_7, { bind: 'cpu_7.halt' });
  const lua = core.generate(d, { extraModules: [m] });
  // Type debug_dap, as its library: QBox finds build/debug_dap.so by the name, so no dylib_path.
  const dapLine = lua.split('\n').find((l) => l.includes('moduletype = "debug_dap"')) || '';
  assert.ok(dapLine && !dapLine.includes('dylib_path'));
  assert.ok(lua.includes('halt_3 = {bind = "&cpu_3.halt"}'));
  // A platform that already drives a CPU's halt signal is refused (the port needs it).
  const d2 = JSON.parse(JSON.stringify(d));
  d2.modules.resetctl = { type: 'keep_alive', ports: { out: { bind: 'cpu_2.halt' } } };
  assert.throws(() => dd.dapModule(d2, 1), /cpu_2\.halt is already connected/);
  // No Arm CPU: nothing to halt.
  assert.throws(() => dd.dapModule({ schemaVersion: '0.1', name: 'x', modules: { ram: { type: 'gs_memory' } } }, 1), /no Arm CPU/);
  // Where the probes come from, by agent version: QBox's components from 0.14.0, the agent's library before.
  const at = (v) => trace.probeLibraries(v, '/x/vp_sim_agent', require('../lib/setup/pin').versionAtLeast);
  assert.deepStrictEqual(at('0.14.0'), { probes: 'probes', dap: null, types: { tracer: 'tracer', signal: 'signal_tracer', dap: 'debug_dap' }, inQbox: true, files: ['probes.so', 'debug_dap.so'] });
  assert.deepStrictEqual(at('0.13.0'), { probes: '/x/vp_sim_agent', dap: '/x/vp_sim_agent', types: { tracer: 'vp_tracer', signal: 'vp_signal_tracer', dap: 'vp_debug_dap' }, inQbox: false, files: [] });
  const t2 = trace.traceOptions(d, ['pl011_uart_0.target_socket'], at('0.14.0').probes);
  assert.ok(core.generate(d, { extraModules: t2.extraModules, portOverrides: t2.portOverrides }).includes('moduletype = "tracer"; dylib_path = "probes";'));
  // An agent up to 0.13.0 carries the old type names in its own library.
  const t3 = trace.traceOptions(d, ['pl011_uart_0.target_socket'], at('0.13.0').probes, undefined, { types: at('0.13.0').types });
  assert.deepStrictEqual([t3.extraModules[0].type, t3.extraModules[0].dylib], ['vp_tracer', '/x/vp_sim_agent']);
  assert.deepStrictEqual(at('0.13.0').types, { tracer: 'vp_tracer', signal: 'vp_signal_tracer', dap: 'vp_debug_dap' });
  assert.strictEqual(dd.dapModule(d, 1, at('0.13.0').dap, at('0.13.0').types.dap).type, 'vp_debug_dap');
  // The OpenOCD configuration matches the model's map.
  const cfg = dd.openocdConfig({ port: 3335, cpus: 2, platform: 'ubuntu-aarch64' });
  assert.ok(cfg.includes('remote_bitbang port 3335'));
  assert.ok(cfg.includes('jtag newtap vp cpu -irlen 4 -expected-id 0x4ba00477'));
  assert.ok(cfg.includes('target create vp.sys mem_ap -dap vp.dap -ap-num 0'));
  assert.ok(cfg.includes(`cti create vp.cti1 -dap vp.dap -ap-num 1 -baseaddr 0x${dd.ctiBase(1).toString(16).toUpperCase()}`));
  assert.strictEqual(dd.coreBase(1), 0x80030000);
  assert.strictEqual(dd.ctiBase(0), 0x80020000);
  assert.ok(cfg.includes('set VP_CORES 2') && /proc vp_halt \{n\}/.test(cfg) && /proc vp_resume \{n\}/.test(cfg));
  assert.ok(/proc vp_halt_all \{\}/.test(cfg) && /proc vp_resume_all \{\}/.test(cfg) && cfg.includes('vp.cti$k write GATE 3'));
  assert.ok(cfg.trim().endsWith('init'));
});

test('guest linux: the CDT evaluate answers of -vp-ps and -vp-dmesg', () => {
  const gl = require('../lib/debug/guestlinux');
  // As CDT returns them: the MI result as JSON, every value a string, plus CDT's own keys.
  const proc = (pid, tgid, ppid, comm, o = {}) => Object.assign({ pid: String(pid), tgid: String(tgid), ppid: String(ppid), uid: '0', state: 'S', cpu: '0', running: '-1', kernel: '0', comm, task: '0xffff0001' }, o);
  const body = { result: JSON.stringify({
    processes: [
      proc(1, 1, 0, 'systemd'), proc(2, 2, 0, 'kthreadd', { kernel: '1' }), proc(13, 13, 2, 'ksoftirqd/0', { kernel: '1' }),
      proc(369, 369, 1, 'NetworkManager', { cpu: '7' }), proc(390, 369, 1, 'gmain', { cpu: '3' }),
      proc(472, 472, 440, 'bash'), proc(440, 440, 1, 'login'), proc(510, 510, 472, 'sh', { state: 'R', cpu: '5', running: '5' }),
    ],
    cpus: [{ cpu: '0', pid: '0', comm: 'swapper/0', idle: '1' }, { cpu: '5', pid: '510', comm: 'sh', idle: '0' }],
    'cdt-token': '12', 'cdt-command': '-vp-ps -t',
  }) };
  const t = gl.processTree(gl.normalizePs(gl.parseResult(body)));
  assert.deepStrictEqual(t.count, { processes: 7, threads: 1, kernel: 2 });
  assert.deepStrictEqual(t.roots.map((n) => n.proc.comm), ['systemd', 'kthreadd']);
  const systemd = t.roots[0];
  assert.deepStrictEqual(systemd.children.map((n) => n.proc.pid), [369, 440]);
  assert.deepStrictEqual(systemd.children[0].threads.map((x) => x.comm), ['gmain']); // a thread under its process
  const sh = systemd.children[1].children[0].children[0];
  assert.strictEqual(sh.proc.comm, 'sh');
  assert.deepStrictEqual(gl.procLabel(sh.proc), { label: 'sh', description: 'pid 510 · R · running on cpu 5' });
  assert.deepStrictEqual(gl.procLabel(t.roots[1].children[0].proc), { label: '[ksoftirqd/0]', description: 'pid 13 · S · cpu 0' });
  assert.strictEqual(gl.procLabel(systemd.children[0].threads[0], true).description, 'tid 390 · S · cpu 3');
  assert.match(gl.procTooltip(systemd.children[0].threads[0], true), /TID 390, process 369, parent 1/);
  assert.match(gl.procTooltip(sh.proc), /State R: running or runnable\nRunning on cpu 5 now/);
  assert.deepStrictEqual(t.cpus.map(gl.cpuLabel), [{ label: 'cpu 0', description: 'idle' }, { label: 'cpu 5', description: 'sh (pid 510)' }]);
  // A process whose parent is gone (or pid 0) is a root.
  assert.strictEqual(gl.processTree(gl.normalizePs({ processes: [proc(9, 9, 4, 'orphan')] })).roots.length, 1);

  // dmesg as dmesg prints it, a record with two lines gets the stamp twice.
  const dm = gl.parseResult({ result: JSON.stringify({ records: [
    { seq: '0', ts: '0', level: '5', text: 'Booting Linux on physical CPU 0x0000000000 [0x414fd0b1]' },
    { seq: '388', ts: '139439840256', level: '5', text: 'random: 217 urandom warning(s)\nsecond line' },
  ] }) });
  assert.strictEqual(gl.formatDmesg(dm), '[    0.000000] Booting Linux on physical CPU 0x0000000000 [0x414fd0b1]\n' +
    '[  139.439840] random: 217 urandom warning(s)\n[  139.439840] second line\n');
  assert.strictEqual(gl.formatDmesg({}), '');
  assert.deepStrictEqual(gl.parseResult({ result: '\r' }), {}); // a CLI command: nothing back
  assert.throws(() => gl.parseResult({ result: 'not json' }), /unexpected answer/);
});

test('guest linux: loading the gdb script', () => {
  const gl = require('../lib/debug/guestlinux');
  assert.deepStrictEqual(gl.evaluateArgs('-vp-ps -t'), { expression: '>-vp-ps -t', context: 'repl' });
  assert.strictEqual(gl.notLoaded('Undefined MI command: vp-ps'), true);
  assert.strictEqual(gl.notLoaded('The target is running: pause it first.'), false);
  // Through Python, so a path with spaces or quotes works; as MI, a c-string.
  assert.strictEqual(gl.loadCommand('/a b/x.py'), 'python import runpy; runpy.run_path("/a b/x.py")');
  assert.strictEqual(gl.sourceCommand('/a b/"x".py'), '-interpreter-exec console "python import runpy; runpy.run_path(\\"/a b/\\\\\\"x\\\\\\".py\\")"');
  // initCommands: after the configuration's own (they may add symbol files); once only.
  const c = gl.withLinuxAwareness({ type: 'gdbtarget', initCommands: ['add-symbol-file "/x/app"'] }, '/ext/tools/gdb/vp-linux.py');
  assert.deepStrictEqual(c.initCommands, ['add-symbol-file "/x/app"', 'python import runpy; runpy.run_path("/ext/tools/gdb/vp-linux.py")', 'vp-kaslr -q']);
  assert.strictEqual(gl.withLinuxAwareness(c, '/ext/tools/gdb/vp-linux.py'), c);
  assert.deepStrictEqual(gl.withLinuxAwareness({ type: 'gdbtarget' }, '/s/vp-linux.py').initCommands.length, 2);
  // The script and the module agree on the version; the script ships in the .vsix.
  const py = fs.readFileSync(path.join(__dirname, '..', 'tools', 'gdb', 'vp-linux.py'), 'utf8');
  assert.strictEqual(/^VERSION = "(.*)"$/m.exec(py)[1], gl.SCRIPT_VERSION);
  for (const cmd of ['-vp-ps', '-vp-dmesg', '-vp-kaslr', '-vp-linux-version']) assert.ok(py.includes(`"${cmd}"`), cmd);
  assert.match(fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8'), /^!tools\/gdb\/\*\*$/m);
});

test('third-party debuggers: gdbstub of the platform, TRACE32 script and guide', () => {
  const tp = require('../lib/debug/thirdparty');
  const d = load();
  let g = tp.gdbTarget(d, undefined, { port: 4321 });
  assert.deepStrictEqual(g, { port: 4321, source: 'debug-start', cpu: 'cpu_0', type: 'cpu_arm_cortexA76', cores: 8 });
  // A gdb_port set in the platform wins, on whichever CPU it is.
  d.modules.cpu.perIndex = { 2: { params: { gdb_port: 2000 } } };
  g = tp.gdbTarget(d);
  assert.deepStrictEqual([g.port, g.source, g.cpu], [2000, 'platform', 'cpu_2']);
  const cmm = tp.trace32Script(Object.assign({ platform: 'u.platform.json', host: 'sim-host', symbols: ['/k/vmlinux'] }, g));
  assert.match(cmm, /^SYStem\.CPU CortexA76 /m);
  assert.match(cmm, /^SYStem\.PORT sim-host:2000$/m);
  assert.match(cmm, /^SYStem\.GDBconfig GDBSERVER OFF /m);
  assert.match(cmm, /^SYStem\.Mode Attach$/m);
  assert.match(cmm, /^Data\.LOAD\.Elf "\/k\/vmlinux" \/NoCODE$/m);
  assert.match(cmm, /start t32marm64/);
  const unknown = tp.trace32Script({ platform: 'p', host: 'h', port: 1, type: 'cpu_riscv64', cores: 1 });
  assert.match(unknown, /^SYStem\.CPU$/m);
  assert.match(unknown, /t32mriscv/);
  const md = tp.guide(Object.assign({ platform: 'u.platform.json', host: 'localhost', symbols: ['/k/vmlinux'], cmmFile: '/x/debug/u.trace32.cmm', hostNames: ['box', '10.0.0.5'] }, g));
  assert.match(md, /`cpu_2` sets `gdb_port` 2000/);
  assert.match(md, /DO u\.trace32\.cmm/);
  assert.match(md, /`box`, `10\.0\.0\.5`/);
  assert.match(md, /target extended-remote localhost:2000/);
  assert.match(md, /set architecture aarch64/);
  assert.match(md, /\*\*Not confirmed\.\*\*/);
  assert.throws(() => tp.gdbTarget({ schemaVersion: '0.1', modules: { ram: { type: 'gs_memory' } } }), /no CPU/);
});
