'use strict';
// Run with: node test/debug.test.js (every file: npm test)
const { test, testAsync } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/platform/core');
const trace = require('../lib/analysis/trace');
const { load, shipped } = require('./helpers');

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
  for (const cmd of ['-vp-ps', '-vp-dmesg', '-vp-kaslr', '-vp-linux-version', '-vp-lsmod']) assert.ok(py.includes(`"${cmd}"`), cmd);
  assert.ok(shipped('tools/gdb/vp-linux.py') && shipped('tools/gdb/README.md'));
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

test('memory view: addresses and expressions for Memory Inspector', () => {
  const mv = require('../lib/debug/memview');
  assert.strictEqual(mv.normalize('  0xFFFF8000080EBD80 '), '0xffff8000080ebd80');
  assert.strictEqual(mv.normalize('0xffffc98ba36e1000 <runqueues+2240>'), '0xffffc98ba36e1000');
  assert.strictEqual(mv.normalize('&jiffies'), '&jiffies');
  assert.strictEqual(mv.normalize('$sp + 16'), '$sp + 16');
  assert.strictEqual(mv.normalize(undefined), '');
  assert.ok(mv.looksLikeAddress('0xffff6e82ff7d6620'));
  assert.ok(mv.looksLikeAddress('0x40000000'));
  assert.ok(!mv.looksLikeAddress('0x41'));
  assert.ok(!mv.looksLikeAddress('0xfff'));
  assert.ok(!mv.looksLikeAddress('12345678'));
  assert.ok(!mv.looksLikeAddress('{u = 0x1}'));
  // Memory Inspector opens a Watch item's value: an object with a string name that is not a Variables context.
  assert.deepStrictEqual(mv.goToArgs('0xABC0 <x>'), { name: '0xabc0', value: '0xabc0' });
  assert.strictEqual(mv.EXTENSION_ID, 'eclipse-cdt.memory-inspector');
});

test('debug layout: panes already open are reused', () => {
  const ly = require('../lib/debug/layout');
  assert.deepStrictEqual(ly.missingPanes([]), { disassembly: true, memory: true });
  assert.deepStrictEqual(ly.missingPanes(['idle.c', 'Disassembly', 'Memory 3']), { disassembly: false, memory: false });
  assert.deepStrictEqual(ly.missingPanes(['memory.c', 'Memory', 'disassembly.md']), { disassembly: true, memory: true });
  // Three groups: the left one and a right column split in two.
  assert.strictEqual(ly.EDITOR_LAYOUT.groups.length, 2);
  assert.strictEqual(ly.EDITOR_LAYOUT.groups[1].groups.length, 2);
});

test('debug layout: offer instructions-only disassembly only when nobody chose', () => {
  const ly = require('../lib/debug/layout');
  assert.ok(ly.offerPlainDisassembly({ key: 'debug.disassemblyView.showSourceCode', defaultValue: true }));
  assert.ok(!ly.offerPlainDisassembly({ defaultValue: true, workspaceValue: true }));
  assert.ok(!ly.offerPlainDisassembly({ defaultValue: true, globalValue: false }));
});

test('conditional breakpoints: function lookup and hit counts as the CDT adapter takes them', () => {
  const bp = require('../lib/debug/breakpoints');
  assert.strictEqual(bp.symbolCommand('update_process_times'), '-symbol-info-functions --name ^update_process_times$');
  assert.throws(() => bp.symbolCommand('a b'));
  assert.throws(() => bp.symbolCommand('x; shell rm'));
  // As gdb 15 answered for the Ubuntu kernel.
  const r = { symbols: { debug: [{ filename: '/build/linux-oPNunh/linux-5.15.0/kernel/time/timer.c', fullname: '/build/linux-oPNunh/linux-5.15.0/kernel/time/timer.c',
    symbols: [{ line: '2012', name: 'update_process_times', type: 'void (int)', description: 'void update_process_times(int);' }] }] } };
  assert.deepStrictEqual(bp.functionLocations(r, 'update_process_times'), [{ file: '/build/linux-oPNunh/linux-5.15.0/kernel/time/timer.c', line: 2012 }]);
  assert.deepStrictEqual(bp.functionLocations(r, 'other'), []);
  assert.deepStrictEqual(bp.functionLocations({}, 'x'), []);
  assert.strictEqual(bp.normalizeHitCount(''), '');
  assert.strictEqual(bp.normalizeHitCount(' 5 '), '5');
  assert.strictEqual(bp.normalizeHitCount('==3'), '3');
  assert.strictEqual(bp.normalizeHitCount('> 5'), '>5');
  assert.strictEqual(bp.normalizeHitCount('>=5'), '>4');
  assert.throws(() => bp.normalizeHitCount('0'));
  assert.throws(() => bp.normalizeHitCount('%2'));
  assert.strictEqual(bp.describe('update_process_times', { file: '/a/kernel/time/timer.c', line: 2012 }, 'user_tick == 0', '>5'),
    'update_process_times (timer.c:2012), if user_tick == 0, hit count >5');
});

test('exceptions: decode the agent events seen on the Ubuntu platform', () => {
  const ex = require('../lib/debug/exceptions');
  // A user-space write to a copy-on-write page (CPU 6), as agent 0.15.0 reported it.
  const e = ex.decode([43140, 60228460580, 6, 2, 8, 0, 1, '0xffffb755cda4', '0xfffffbfffdbf7400', '0x9200004f', '0xaaab2139a008', '0xffffb755cda4']);
  assert.strictEqual(e.kind, 'sync');
  assert.strictEqual(e.group, 'lower EL, AArch64');
  assert.strictEqual(e.ec, 0x24);
  assert.strictEqual(e.detail, 'permission fault, level 3, write');
  assert.strictEqual(e.far, '0xaaab2139a008');
  assert.strictEqual(e.title, 'Data abort from a lower EL (permission fault, level 3, write) at 0xaaab2139a008');
  assert.ok(ex.describe(e).includes('CPU 6, EL0 → EL1'));
  // An IRQ taken in the kernel: the ESR is stale and not shown.
  const i = ex.decode([39017, 58096474559, 4, 1, 5, 1, 1, '0xffffc98ba18f2cbc', '0xffffc98ba1611280', '0x92000047', '0xaaaae13ac000', '0xffffc98ba18f2cbc']);
  assert.strictEqual(i.kind, 'irq');
  assert.strictEqual(i.esr, undefined);
  assert.strictEqual(i.title, 'IRQ on CPU 4');
  // A system call and a FnV abort.
  assert.strictEqual(ex.decode([1, 0, 0, 2, 8, 0, 1, '0x1', '0x2', '0x56000000', '0x0', '0x1']).title, 'SVC (system call) (#0)');
  const f = ex.decode([1, 0, 0, 2, 4, 1, 1, '0x1', '0x2', String(0x96000410), '0x0', '0x1']);
  assert.strictEqual(f.far, undefined);
  assert.ok(f.detail.includes('FnV'));
  // No VBAR match: the kind comes from QEMU's type.
  assert.strictEqual(ex.decode([1, 0, 0, 1, 255, 1, 1, '0x1', '0x2', '0x0', '0x0', '0x1']).kind, 'irq');
  assert.strictEqual(ex.faultStatus(0x21), 'alignment fault');
});

test('exceptions: catch rules and counts', () => {
  const ex = require('../lib/debug/exceptions');
  assert.deepStrictEqual(ex.rulesFor(['dataAbort', 'serror']), [{ kind: 'sync', ec: 0x24 }, { kind: 'sync', ec: 0x25 }, { kind: 'serror' }]);
  assert.deepStrictEqual(ex.rulesFor(['irq'], 'el0'), [{ kind: 'irq', fromEl: 0 }]);
  assert.deepStrictEqual(ex.rulesFor([]), []);
  const rows = ex.countRows([{ kind: 'sync', ec: 21, count: 3976 }, { kind: 'irq', count: 37345 }, { kind: 'sync', ec: 36, count: 1560 }]);
  assert.deepStrictEqual(rows.map((r) => [r.label, r.code, r.count]), [['IRQ', '', 37345], ['SVC (system call)', 'EC 0x15', 3976], ['Data abort from a lower EL', 'EC 0x24', 1560]]);
  // Every catch choice has a distinct id and every exception class it names is known.
  assert.strictEqual(new Set(ex.CATCH.map((c) => c.id)).size, ex.CATCH.length);
  for (const c of ex.CATCH) for (const ec of c.ec || []) assert.ok(ex.EC[ec], `EC 0x${ec.toString(16)}`);
});

test('exceptions: system calls by name (x8 of an SVC, agent 0.15.0)', () => {
  const ex = require('../lib/debug/exceptions');
  assert.deepStrictEqual(ex.parseSyscalls('ioctl, mmap 29 openat'), [29, 222, 56]);
  assert.deepStrictEqual(ex.parseSyscalls('sys_execve'), [221]);
  assert.throws(() => ex.parseSyscalls('nosuchcall'), /unknown system call/);
  assert.strictEqual(ex.syscallName(98), 'futex');
  const e = ex.decode([1, 0, 0, 2, 8, 0, 1, '0x1', '0x2', '0x56000000', '0x0', '0x1', '0x38']);
  assert.strictEqual(e.title, 'SVC (system call) (openat, #56)');
  assert.strictEqual(e.syscall, 56);
  assert.deepStrictEqual(ex.rulesFor(['svc'], 'el0', [29, 222]), [{ kind: 'sync', ec: 0x15, syscalls: [29, 222], fromEl: 0 }]);
  assert.deepStrictEqual(ex.rulesFor(['svc']), [{ kind: 'sync', ec: 0x15 }, { kind: 'sync', ec: 0x11 }]);
});

testAsync('gdb tools: patterns, sizes and searching across chunks', async () => {
  const t = require('../lib/debug/gdbtools');
  assert.strictEqual(t.parsePattern('0xd00dfeed').text, 'ed fe 0d d0'); // as a little-endian target stores it
  assert.strictEqual(t.parsePattern('0xd00dfeed:be').text, 'd0 0d fe ed'); // an FDT header
  assert.strictEqual(t.parsePattern('hex: d0 0d fe ed').text, 'd0 0d fe ed');
  assert.strictEqual(t.parsePattern('"Linux"').bytes.toString(), 'Linux');
  assert.strictEqual(t.parsePattern('0x1').bytes.length, 1);
  assert.strictEqual(t.parsePattern('0x00001234').bytes.length, 4);
  assert.throws(() => t.parsePattern('hex: abc'));
  assert.throws(() => t.parsePattern('foo'));
  assert.strictEqual(t.parseSize('64k'), 65536n);
  assert.strictEqual(t.parseSize('0x100000'), 0x100000n);
  assert.throws(() => t.parseSize('lots'));
  // 10 bytes per chunk; the pattern straddles the first boundary and one chunk is unreadable.
  const mem = Buffer.alloc(40); mem.write('abcd', 8); mem.write('abcd', 33);
  const read = async (a, n) => (a >= 0x1014n && a < 0x101en ? null : mem.subarray(Number(a - 0x1000n), Number(a - 0x1000n) + n));
  const r = await t.search((a, n) => read(a, n), 0x1000n, 40n, Buffer.from('abcd'), { chunk: 10 });
  assert.deepStrictEqual(r.hits, [0x1008n, 0x1021n]);
  assert.strictEqual(r.unreadable, 10n);
  assert.strictEqual(t.castExpression('struct task_struct *', '$sp_el0'), '*(struct task_struct *)(unsigned long)($sp_el0)');
  assert.throws(() => t.castExpression('x; y', '1'));
  assert.strictEqual(t.addSymbolFileCommand('/a/m.ko', '0xffff8000'), 'add-symbol-file "/a/m.ko" 0xffff8000');
  assert.strictEqual(t.xpCommand('0x80000000', 16), 'xp /16xw 0x80000000');
  assert.strictEqual(t.parseLocking('Mode for locking scheduler during execution is "step".'), 'step');
});

testAsync('mmu: a stage 1 walk through tables in memory (4 KB and 64 KB granules), faults, rights, attributes', async () => {
  const mmu = require('../lib/debug/mmu');
  const mem = new Map();
  const read8 = async (a) => (mem.has(a) ? mem.get(a) : 0n);
  const tableD = (pa, extra = 0n) => BigInt(pa) | 3n | extra;
  // Leaf: AttrIndx (2..4), AP (6..7), SH (8..9), AF (10), nG (11), PXN (53), UXN (54).
  const leaf = (pa, { attr = 0, ap = 0, sh = 3, af = 1, ng = 0, pxn = 0, uxn = 0, page = false } = {}) =>
    BigInt(pa) | (page ? 3n : 1n) | (BigInt(attr) << 2n) | (BigInt(ap) << 6n) | (BigInt(sh) << 8n) | (BigInt(af) << 10n) | (BigInt(ng) << 11n) | (BigInt(pxn) << 53n) | (BigInt(uxn) << 54n);
  // TCR as Linux sets it: T0SZ = T1SZ = 16 (48-bit), TG0 4 KB, TG1 4 KB (2), IPS 40 bits, A1 = 0, AS, TBI0, HA, HD.
  const TCR = 16n | (16n << 16n) | (2n << 30n) | (2n << 32n) | (1n << 36n) | (1n << 37n);
  const MAIR = 0x000000f0ff440400n; // Linux: 0 nGnRnE, 1 nGnRE, 2 NC, 3 normal, 4 tagged
  const regs = { SCTLR_EL1: 0x30d5d91dn, TCR_EL1: TCR, TTBR0_EL1: 0x41000000n | (5n << 48n), TTBR1_EL1: 0x42000000n | (7n << 48n), MAIR_EL1: MAIR, cpsr: 0x3c5n };
  // Kernel 0xffff800008010123: L0[256] -> L1[0] -> L2[0x40] -> L3[0x10] page at 0x40210000, normal, EL1 rw, PXN by table? no.
  const va = 0xffff800008010123n;
  mem.set(0x42000000n + 256n * 8n, tableD(0x43000000));
  mem.set(0x43000000n + 0n * 8n, tableD(0x44000000, 1n << 60n)); // UXNTable
  mem.set(0x44000000n + 0x40n * 8n, tableD(0x45000000));
  mem.set(0x45000000n + 0x10n * 8n, leaf(0x40210000, { attr: 3, ap: 0, page: true, ng: 0, uxn: 0 }));
  let r = await mmu.translate(va, regs, read8);
  assert.strictEqual(r.fault, undefined, JSON.stringify(r.fault));
  assert.deepStrictEqual([r.ttbr, r.granule, r.inputBits, r.startLevel, r.asid], [1, '4 KB', 48, 0, 5]); // A1 = 0: ASID from TTBR0
  assert.deepStrictEqual(r.steps.map((s) => [s.level, s.index, s.decoded.type]), [[0, 256, 'table'], [1, 0, 'table'], [2, 0x40, 'table'], [3, 0x10, 'page']]);
  assert.strictEqual(r.pa, 0x40210123n);
  assert.strictEqual(r.size, 4096n);
  assert.deepStrictEqual([mmu.rwx(r.perms.el1), mmu.rwx(r.perms.el0)], ['rwx', '---']); // UXNTable: EL0 not executable either
  assert.strictEqual(r.attr.text, 'Normal, write-back, read/write-allocate');
  assert.strictEqual(r.shareability, 'inner shareable');
  assert.deepStrictEqual(r.fields.map((f) => [f.name, f.hi, f.lo, f.value]),
    [['TTBR1 select', 63, 48, 0xffff], ['L0 index', 47, 39, 256], ['L1 index', 38, 30, 0], ['L2 index', 29, 21, 0x40], ['L3 index', 20, 12, 0x10], ['page offset', 11, 0, 0x123]]);
  assert.ok(mmu.toText(r).includes('PA 0x0000_0000_4021_0123'));
  // A 2 MiB block at level 2, device memory, user read-only, PXN + UXN.
  mem.set(0x44000000n + 0x41n * 8n, leaf(0x09000000 & ~0x1fffff, { attr: 1, ap: 3, pxn: 1, uxn: 1 }));
  r = await mmu.translate(0xffff800008200010n + 0x123n, regs, read8);
  assert.strictEqual(r.leaf.type, 'block');
  assert.strictEqual(r.size, 2n * 1024n * 1024n);
  assert.strictEqual(r.pa, 0x09000133n);
  assert.deepStrictEqual([mmu.rwx(r.perms.el1), mmu.rwx(r.perms.el0), r.attr.text, r.shareability], ['r--', 'r--', 'Device-nGnRE', 'outer shareable (device memory)']);
  // EL0-writable data: never executable at EL1; with WXN not at EL0 either.
  mem.set(0x41000000n, tableD(0x46000000)); mem.set(0x46000000n, tableD(0x47000000)); mem.set(0x47000000n, tableD(0x48000000));
  mem.set(0x48000000n + 8n, leaf(0x50001000, { attr: 3, ap: 1, ng: 1, page: true }));
  r = await mmu.translate(0x1abcn, regs, read8);
  assert.deepStrictEqual([r.ttbr, r.pa, mmu.rwx(r.perms.el1), mmu.rwx(r.perms.el0), r.leaf.ng], [0, 0x50001abcn, 'rw-', 'rwx', 1]);
  assert.ok(r.perms.notes.some((n) => /privileged execute-never/.test(n)));
  r = await mmu.translate(0x1abcn, Object.assign({}, regs, { SCTLR_EL1: regs.SCTLR_EL1 | (1n << 19n) }), read8);
  assert.strictEqual(mmu.rwx(r.perms.el0), 'rw-');
  // TBI0: a tagged user pointer still translates; without TBI it is outside both ranges.
  r = await mmu.translate(0x5a00000000001abcn, regs, read8);
  assert.strictEqual(r.pa, 0x50001abcn);
  r = await mmu.translate(0x5a00000000001abcn, Object.assign({}, regs, { TCR_EL1: TCR & ~(1n << 37n) }), read8);
  assert.deepStrictEqual([r.fault.kind, r.fault.level], ['translation', 0]);
  // Faults: unmapped, AF = 0 (with and without hardware AF), reserved block at level 0, unreadable.
  r = await mmu.translate(0x2000n, regs, read8);
  assert.deepStrictEqual([r.fault.kind, r.fault.level, r.steps.length], ['translation', 3, 4]);
  mem.set(0x48000000n + 3n * 8n, leaf(0x50003000, { af: 0, page: true }));
  r = await mmu.translate(0x3000n, regs, read8);
  assert.strictEqual(r.fault.kind, 'access flag');
  assert.strictEqual(mmu.faultHint(r), 'The page is mapped; the OS has not marked it accessed yet.');
  r = await mmu.translate(0x3000n, Object.assign({}, regs, { TCR_EL1: TCR | (1n << 39n) }), read8);
  assert.strictEqual(r.fault, undefined);
  assert.ok(r.notes.some((n) => /hardware/.test(n)));
  mem.set(0x41000000n + 8n, leaf(0x8000000000, {}));
  r = await mmu.translate(0x0000008000000000n, regs, read8);
  assert.ok(/reserved/.test(r.fault.text));
  r = await mmu.translate(0x1abcn, regs, async () => null);
  assert.deepStrictEqual([r.fault.kind, r.fault.level], ['unreadable', 0]);
  // KPTI: a CPU at EL0 sees no kernel, and the hint says so.
  r = await mmu.translate(0xffff800009000000n, Object.assign({}, regs, { cpsr: 0x0n }), read8);
  assert.ok(r.fault && /KPTI/.test(mmu.faultHint(r)));
  // MMU off; HCR_EL2.VM; missing registers.
  r = await mmu.translate(0x40000000n, Object.assign({}, regs, { SCTLR_EL1: 0n, HCR_EL2: 1n }), read8);
  assert.deepStrictEqual([r.mmu, r.pa], [false, 0x40000000n]);
  assert.ok(r.notes.some((n) => /stage 2/.test(n)));
  await assert.rejects(mmu.translate(0n, { TCR_EL1: 0n }, read8), /SCTLR_EL1/);
  // 64 KB granule, 42-bit VA (T0SZ 22): two levels (2 and 3), 512 MiB blocks at level 2.
  const T64 = 22n | (1n << 14n) | (2n << 32n);
  const r64 = Object.assign({}, regs, { TCR_EL1: T64, TTBR0_EL1: 0x60000000n });
  mem.set(0x60000000n + 1n * 8n, leaf(0x20000000, { attr: 3 }));
  r = await mmu.translate(0x20001234n, r64, read8);
  assert.deepStrictEqual([r.granule, r.startLevel, r.steps.length, r.leaf.type, r.pa, mmu.formatSize(r.size)], ['64 KB', 2, 1, 'block', 0x20001234n, '512 MiB']);
  // MAIR decoding.
  assert.deepStrictEqual([0x00, 0x04, 0x0c, 0x44, 0xff, 0xbb, 0xf0, 0x4f].map((b) => mmu.decodeAttr(b).text),
    ['Device-nGnRnE', 'Device-nGnRE', 'Device-GRE', 'Normal, non-cacheable', 'Normal, write-back, read/write-allocate',
      'Normal, write-through, read/write-allocate', 'Normal, write-back, read/write-allocate, tagged (MTE)', 'Normal, outer non-cacheable; inner write-back, read/write-allocate']);
  // Helpers.
  assert.strictEqual(mmu.parseXp('0000000040210000: 0x00e8000041234f03\n'), 0x00e8000041234f03n);
  assert.strictEqual(mmu.parseXp('nothing'), null);
  assert.deepStrictEqual(Object.keys(mmu.pickRegisters([{ name: 'TCR_EL1', value: '0x10' }, { name: 'x0', value: '0x1' }, { name: 'cpsr', value: '0x3c5' }, { name: 'MAIR_EL1', value: '{…}' }])), ['TCR_EL1', 'cpsr']);
  const map = [{ instance: 'ram', port: 'target_socket', bus: 'router', start: 0x40000000n, end: 0x7fffffffn, priority: 0 }];
  assert.deepStrictEqual(mmu.regionAt(map, 0x40210123n), { instance: 'ram', port: 'target_socket', bus: 'router', start: 0x40000000n, offset: 0x210123n });
  const v = mmu.forView(await mmu.translate(va, regs, read8), map);
  assert.deepStrictEqual([v.pa, v.where.instance, v.where.offset, v.perms.el1, v.steps[3].type], ['0x0000_0000_4021_0123', 'ram', '0x210123', 'rwx', 'page']);
  JSON.stringify(v); // no BigInt left
});

test('jump to cursor: gdb locations for a local line, breakpoint answers, the jump', () => {
  const j = require('../lib/debug/jump');
  const map = { '/build/linux-oPNunh/linux-5.15.0': '/home/me/src/linux-5.15.0' };
  assert.deepStrictEqual(j.locationCandidates('/home/me/src/linux-5.15.0/kernel/time/timer.c', 2013, map), [
    '/build/linux-oPNunh/linux-5.15.0/kernel/time/timer.c:2013', '/home/me/src/linux-5.15.0/kernel/time/timer.c:2013',
    'me/src/linux-5.15.0/kernel/time/timer.c:2013', 'src/linux-5.15.0/kernel/time/timer.c:2013', 'linux-5.15.0/kernel/time/timer.c:2013',
    'kernel/time/timer.c:2013', 'time/timer.c:2013', 'timer.c:2013']);
  assert.deepStrictEqual(j.locationCandidates('C:\\src\\my app\\main.c', 7, {}, { win32: true }).slice(-2), ['"my app/main.c":7', 'main.c:7']);
  // -break-insert answers: one address; several locations (inlined).
  assert.deepStrictEqual(j.breakpointAddresses({ bkpt: { number: '3', addr: '0xffffc98ba1a8c0e4', func: 'update_process_times', line: '2013' } }),
    [{ address: 0xffffc98ba1a8c0e4n, func: 'update_process_times', file: undefined, line: 2013 }]);
  const multi = { bkpt: { number: '4', addr: '<MULTIPLE>', locations: [{ number: '4.1', addr: '0x10', func: 'a' }, { number: '4.2', addr: '0x20', func: 'b' }] } };
  assert.deepStrictEqual(j.breakpointAddresses(multi).map((a) => [a.address, a.func]), [[0x10n, 'a'], [0x20n, 'b']]);
  assert.deepStrictEqual(j.breakpointAddresses({}), []);
  assert.strictEqual(j.chooseAddress(j.breakpointAddresses(multi), 'b').address, 0x20n);
  assert.strictEqual(j.chooseAddress(j.breakpointAddresses(multi), 'c'), undefined);
  assert.deepStrictEqual(j.jumpCommands(3, 0xffff800008010000n), ['-gdb-set scheduler-locking on', '-break-insert -t *0xffff800008010000', '-exec-jump --thread 3 *0xffff800008010000']);
});

test('kernel modules: .ko files by name, modules.dep, add-symbol-file at the loaded sections', () => {
  const km = require('../lib/debug/kmodules');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-kmod-'));
  fs.mkdirSync(path.join(dir, 'kernel/drivers/net'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'kernel/sound'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'kernel/drivers/net/virtio_net.ko'), '');
  fs.writeFileSync(path.join(dir, 'kernel/sound/snd-hda-intel.ko'), '');
  fs.writeFileSync(path.join(dir, 'kernel/sound/snd-pcm.ko.zst'), '');
  const idx = km.indexFiles([dir, path.join(dir, 'nope')]);
  assert.deepStrictEqual([...idx.files.keys()].sort(), ['snd_hda_intel', 'virtio_net']);
  assert.strictEqual(idx.compressed, 1);
  const dep = km.parseModulesDep('kernel/drivers/net/virtio_net.ko: kernel/drivers/net/net_failover.ko\nkernel/fs/fat/vfat.ko: kernel/fs/fat/fat.ko\n\nbad line\n');
  assert.deepStrictEqual([...dep], [['virtio_net', 'kernel/drivers/net/virtio_net.ko'], ['vfat', 'kernel/fs/fat/vfat.ko']]);
  const mod = { name: 'virtio_net', state: 'live', base: '0xffffc98b9a3e0000', size: 61440, sections: [
    { name: '.note.gnu.build-id', address: '0xffffc98b9a3ec000' }, { name: '.text', address: '0xffffc98b9a3e0000' },
    { name: '.init.text', address: '0xffffc98b9a3f8000' }, { name: '.rodata', address: '0xffffc98b9a3ed000' },
    { name: '.data', address: '0xffffc98b9a3f0000' }, { name: '.bss', address: '0xffffc98b9a3f1000' }, { name: '__ksymtab', address: '0xffffc98b9a3ec100' }] };
  assert.strictEqual(km.addSymbolFile('/m/virtio_net.ko', mod),
    'add-symbol-file "/m/virtio_net.ko" 0xffffc98b9a3e0000 -s .rodata 0xffffc98b9a3ed000 -s .data 0xffffc98b9a3f0000 -s .bss 0xffffc98b9a3f1000');
  assert.strictEqual(km.addSymbolFile('/m/x.ko', { name: 'x', base: '0xffff000000001000', sections: [] }), 'add-symbol-file "/m/x.ko" 0xffff000000001000');
  const mods = [mod, { name: 'snd_hda_intel', state: 'live', base: '0x1000', sections: [] }, { name: 'zfs', state: 'live', base: '0x2000' }, { name: 'new', state: 'unformed', base: '0x3000' }];
  const p = km.plan(mods, idx.files, new Set([km.loadKey(mods[1])]));
  assert.deepStrictEqual([p.load.map((x) => x.mod.name), p.done.map((x) => x.name), p.missing.map((x) => x.name)], [['virtio_net'], ['snd_hda_intel'], ['zfs']]);
  assert.deepStrictEqual(km.debugfsArgs('/i/img.ext4', 'cat /lib/modules/5.15.0/modules.dep'), ['-c', '-R', 'cat /lib/modules/5.15.0/modules.dep', '/i/img.ext4']);
  assert.strictEqual(km.extractDir('/fw/vmlinux', '5.15.0-203-generic'), path.join('/fw', 'modules', '5.15.0-203-generic'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gdb targets: one gdb server per QEMU instance, ports, kept platform ports', () => {
  const gt = require('../lib/debug/gdbtargets');
  // The Ubuntu example: one QEMU instance, 8 CPUs; the server opens on cpu_0.
  const one = gt.targets(load());
  assert.deepStrictEqual(one.map((t) => [t.qemu, t.cpus.length, t.cpu, t.port, t.preset, t.arch]), [['qemu_inst', 8, 'cpu_0', 1234, false, 'aarch64']]);
  assert.deepStrictEqual(gt.overrides(one), [{ instance: 'cpu_0', param: 'gdb_port', value: 1234 }]);
  // Two instances: an AArch64 cluster and a Cortex-M core whose platform already opens port 1234.
  const doc = { schemaVersion: '0.2', name: 'two', modules: {
    mgr: { type: 'QemuInstanceManager' },
    qa: { type: 'QemuInstance', args: [{ ref: 'mgr' }, 'AARCH64'] },
    qm: { type: 'QemuInstance', args: [{ ref: 'mgr' }, 'ARM'] },
    cpu: { type: 'cpu_arm_cortexA53', count: 2, args: [{ ref: 'qa' }] },
    mcu: { type: 'cpu_arm_cortexM55', args: [{ ref: 'qm' }], params: { gdb_port: 1234 } },
  } };
  const two = gt.targets(doc, { basePort: 1234 });
  assert.deepStrictEqual(two.map((t) => [t.qemu, t.cpu, t.port, t.preset, t.arch]), [['qa', 'cpu_0', 1235, false, 'aarch64'], ['qm', 'mcu', 1234, true, 'arm']]);
  assert.deepStrictEqual(gt.overrides(two), [{ instance: 'cpu_0', param: 'gdb_port', value: 1235 }]);
  assert.deepStrictEqual(two.map((t, k) => gt.configName(t, k)), ['VP: attach to target software', 'VP: attach to target software (qm)']);
  assert.strictEqual(gt.targets(doc, { preferCpu: 'cpu_1' })[0].cpu, 'cpu_1');
});

test('memory layout: Memory Inspector groupings for words per row, and VP Studio\'s defaults', () => {
  const mv = require('../lib/debug/memview');
  assert.deepStrictEqual(mv.layoutSettings(4, 4), { 'groupings.bytesPerMAU': 1, 'groupings.MAUsPerGroup': 4, 'groupings.groupsPerRow': 4 });
  assert.deepStrictEqual(mv.layoutSettings(8, 'Autofit')['groupings.groupsPerRow'], 'Autofit');
  assert.throws(() => mv.layoutSettings(3, 4), /word size/);
  assert.throws(() => mv.layoutSettings(4, 5), /words per row/);
  assert.strictEqual(mv.describeLayout(1, 1, 4).text, '4 bytes per row (4 bytes)');
  assert.strictEqual(mv.describeLayout(1, 4, 4).text, '4 32-bit words per row (16 bytes)');
  assert.strictEqual(mv.describeLayout(1, 8, 'Autofit').text, '64-bit words, as many as fit in a row');
  // package.json makes 4 words of 4 bytes Memory Inspector's default.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const d = pkg.contributes.configurationDefaults;
  assert.strictEqual(d[`${mv.SECTION}.${mv.KEYS.group}`], mv.DEFAULT_LAYOUT.wordBytes);
  assert.strictEqual(d[`${mv.SECTION}.${mv.KEYS.row}`], mv.DEFAULT_LAYOUT.wordsPerRow);
});
