'use strict';
// Run with: node test/launch.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/platform/core');
const os = require('os');
const launch = require('../lib/sim/launch');
const vprun = require('../bin/vp-run.js');

test('launch: the agent module gets one bus socket per router', () => {
  const launch = require('../lib/sim/launch');
  assert.deepStrictEqual(launch.agentModule('/a/sim_agent', 5000, ['router', 'periph.router_1']), {
    name: 'sim_agent', type: 'sim_agent', dylib: '/a/sim_agent', params: { port: 5000, buses: 2 },
    ports: { bus_0: { bind: 'router.target_socket' }, bus_1: { bind: 'periph.router_1.target_socket' } },
  });
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'ubuntu-aarch64.platform.json'), 'utf8'));
  const lua = core.generate(doc, { extraModules: [launch.agentModule('/a/sim_agent', 5000, core.analyze(doc).buses)] });
  assert.ok(lua.includes('platform["sim_agent"] = { moduletype = "sim_agent"; dylib_path = "/a/sim_agent"; port = 5000; buses = 1; bus_0 = {bind = "&router.target_socket"} }'), lua.slice(-400));
});

test('vp-run: steps keep their order; options are checked', () => {
  const o = vprun.parseArgs(['--qbox', '/q', '--expect', 'login:', '--send', 'root', '--expect', 'root@\\w+', '--timeout', '900',
    '--sim-timeout', '30 s', '--snapshot', '--param', 'cpu_0.gdb_port=1234', '--param', 'uart_0.name=con 1', '--junit', 'r.xml', 'p.platform.json']);
  assert.strictEqual(o.platform, 'p.platform.json');
  assert.strictEqual(o.qbox, '/q');
  assert.deepStrictEqual(o.steps.map((s) => (s.send !== undefined ? 'send ' + s.send : 'expect ' + s.source)), ['expect login:', 'send root', 'expect root@\\w+']);
  assert.ok(o.steps[2].expect.test('x\nroot@ubuntu:~#'));
  assert.strictEqual(o.timeout, 900);
  assert.deepStrictEqual(o.simTimeout, { seconds: 30, text: '30 s' });
  assert.strictEqual(o.snapshot, true);
  assert.deepStrictEqual(o.params, [{ instance: 'cpu_0', param: 'gdb_port', value: 1234 }, { instance: 'uart_0', param: 'name', value: 'con 1' }]);
  assert.strictEqual(o.junit, 'r.xml');
  // Defaults.
  const d = vprun.parseArgs(['x.platform.json']);
  assert.strictEqual(d.timeout, 600);
  assert.strictEqual(d.exe, 'build/platforms-vp');
  assert.deepStrictEqual(d.steps, []);
  // A parameter of a module inside a subsystem keeps its dotted instance path.
  assert.deepStrictEqual(vprun.parseArgs(['--param', 'periph.uart_0.baud=9600', 'x']).params[0], { instance: 'periph.uart_0', param: 'baud', value: 9600 });
  // A value with dots and "=" (a disk option string).
  assert.deepStrictEqual(vprun.parseArgs(['--param', 'blk_0.blkdev_str=file=/a/b.img,format=raw', 'x']).params[0], { instance: 'blk_0', param: 'blkdev_str', value: 'file=/a/b.img,format=raw' });
  assert.strictEqual(vprun.parseArgs(['-h']).help, true);
  process.env.VP_TEST_SECRET = 's3cret';
  assert.deepStrictEqual(vprun.parseArgs(['--send-env', 'VP_TEST_SECRET', 'x']).steps, [{ sendEnv: 'VP_TEST_SECRET' }]);
  delete process.env.VP_TEST_SECRET;
  assert.throws(() => vprun.parseArgs(['--send-env', 'VP_TEST_SECRET', 'x']), /the variable is not set/);
  assert.throws(() => vprun.parseArgs(['--send-env', 'A-B', 'x']), /not an environment variable name/);
  for (const [args, re] of [
    [[], /no platform file/],
    [['a', 'b'], /only one platform/],
    [['--expect'], /needs a value/],
    [['--expect', '(', 'x'], /--expect \(/],
    [['--timeout', '0', 'x'], /greater than 0/],
    [['--sim-timeout', '3 parsecs', 'x'], /Unknown unit/],
    [['--param', 'nodot=1', 'x'], /INSTANCE\.NAME=VALUE/],
    [['--agent-port', '70000', 'x'], /port number/],
    [['--wait-exit', '--exec', 'true', 'x'], /cannot be used together/],
    [['--bogus', 'x'], /unknown option --bogus/],
  ]) {
    assert.throws(() => vprun.parseArgs(args), (e) => e instanceof vprun.UsageError && re.test(e.message), args.join(' '));
  }
});

test('vp-run: JUnit report escapes console text and counts failures', () => {
  const xml = vprun.junitXml('ubuntu <a&b>', [
    { name: 'expect /login:/', seconds: 12.5 },
    { name: 'expect /root@/', seconds: 600, failure: 'timed out after 600 s waiting for /root@/' },
  ], 'boot \u001b[0mok <tag> & "q"\u0007\n');
  assert.match(xml, /<testsuite name="ubuntu &lt;a&amp;b&gt;" tests="2" failures="1" errors="0" time="612.500">/);
  assert.match(xml, /<testcase classname="[^"]*" name="expect \/login:\/" time="12.500"\/>/);
  assert.match(xml, /<failure message="timed out after 600 s waiting for \/root@\/"\/>/);
  assert.match(xml, /<system-out>boot \[0mok &lt;tag&gt; &amp; &quot;q&quot;\n<\/system-out>/); // ESC and BEL dropped: not allowed in XML
  assert.strictEqual(vprun.envName('HOST_PORT_SSH'), 'VP_HOST_PORT_SSH');
  assert.strictEqual(vprun.envName('hostPort-gdb'), 'VP_HOSTPORT_GDB');
});

test('launch: snapshot=on for writable disk images only', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'ubuntu-aarch64.platform.json'), 'utf8'));
  assert.deepStrictEqual(launch.snapshotOverrides(doc), [{
    instance: 'virtioblk_0', param: 'blkdev_str', value: 'file=${TOP}fw/Artifacts/image_ext4.img,format=raw,if=none,readonly=off,snapshot=on',
  }]);
  // The override ends up after the platform table, ${TOP} kept as in the platform.
  const lua = core.generate(doc, { overrides: launch.snapshotOverrides(doc) });
  assert.ok(lua.includes('platform["virtioblk_0"]["blkdev_str"] = "file="..top().."fw/Artifacts/image_ext4.img,format=raw,if=none,readonly=off,snapshot=on"'));
  const d2 = JSON.parse(JSON.stringify(doc));
  d2.modules.virtioblk_0.params.blkdev_str = 'file=a.img,readonly=on';
  assert.deepStrictEqual(launch.snapshotOverrides(d2), []);
  d2.modules.virtioblk_0.params.blkdev_str = 'file=a.img,snapshot=off,format=raw';
  assert.strictEqual(launch.snapshotOverrides(d2)[0].value, 'file=a.img,snapshot=on,format=raw');
});

test('launch: build folders, local catalogs and the agent library', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-launch-'));
  const ext = path.join(home, 'ext');
  const saved = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    const dirs = launch.buildDirs(ext, home);
    assert.deepStrictEqual(dirs, [
      path.join(home, '.config', 'Code', 'User', 'globalStorage', 'novatek.vp-studio', 'build'),
      path.join(home, '.config', 'VSCodium', 'User', 'globalStorage', 'novatek.vp-studio', 'build'),
      path.join(home, '.theia', 'globalStorage', 'novatek.vp-studio', 'build'),
      path.join(ext, 'tools'),
    ]);
    assert.strictEqual(launch.findBuilt(dirs, 'sim-agent', 'sim_agent.so'), undefined);
    // Built in the extension folder by an older version, and in Theia's user data: Theia's wins.
    fs.mkdirSync(path.join(ext, 'tools', 'sim-agent'), { recursive: true });
    fs.writeFileSync(path.join(ext, 'tools', 'sim-agent', 'sim_agent.so'), '');
    assert.strictEqual(launch.findBuilt(dirs, 'sim-agent', 'sim_agent.so'), path.join(ext, 'tools', 'sim-agent', 'sim_agent.so'));
    fs.mkdirSync(path.join(dirs[2], 'sim-agent'), { recursive: true });
    fs.writeFileSync(path.join(dirs[2], 'sim-agent', 'sim_agent.so'), '');
    assert.strictEqual(launch.findBuilt(dirs, 'sim-agent', 'sim_agent.so'), path.join(dirs[2], 'sim-agent', 'sim_agent.so'));

    // A bundled module built in the user data folder, and a wizard model in a workspace.
    fs.mkdirSync(path.join(dirs[0], 'cpu-a73'), { recursive: true });
    fs.writeFileSync(path.join(dirs[0], 'cpu-a73', 'cpu_arm_cortexA73.catalog.json'), JSON.stringify({
      library: '/built/cpu_arm_cortexA73.so', modules: { cpu_arm_cortexA73: { ports: {}, params: {} } },
    }));
    const ws = path.join(home, 'ws');
    for (const d of ['models/my_timer/build', 'node_modules/x', 'build/y']) fs.mkdirSync(path.join(ws, d), { recursive: true });
    fs.writeFileSync(path.join(ws, 'models', 'my_timer', 'my_timer.model.json'), JSON.stringify({ name: 'my_timer' }));
    fs.writeFileSync(path.join(ws, 'models', 'my_timer', 'build', 'my_timer.catalog.json'), JSON.stringify({
      library: path.join(ws, 'models', 'my_timer', 'build', 'my_timer.so'), modules: { my_timer: { ports: {}, params: {} } },
    }));
    fs.writeFileSync(path.join(ws, 'node_modules', 'x', 'skip.model.json'), '{}');
    fs.writeFileSync(path.join(ws, 'build', 'y', 'skip.model.json'), '{}');
    const specs = launch.findModelSpecs(ws);
    assert.deepStrictEqual(specs, [path.join(ws, 'models', 'my_timer', 'my_timer.model.json')]);
    const r = launch.catalogWithLocal({ modules: { router: { ports: {}, params: {} } } }, { bundled: [{ type: 'cpu_arm_cortexA73', dir: 'cpu-a73' }], dirs, modelSpecs: specs });
    assert.deepStrictEqual(Object.keys(r.catalog.modules).sort(), ['cpu_arm_cortexA73', 'my_timer', 'router']);
    const libs = require('../lib/generate/models').libraries(r.catalog);
    assert.strictEqual(libs.cpu_arm_cortexA73, path.join(dirs[0], 'cpu-a73', 'cpu_arm_cortexA73')); // next to its catalog

    // --agent: an explicit path must exist; "none" turns it off; VP_SIM_AGENT is the default.
    assert.deepStrictEqual(vprun.agentLibrary('none'), { lib: undefined, why: 'disabled with --agent none' });
    assert.throws(() => vprun.agentLibrary(path.join(home, 'nope')), /not found: .*nope\.so/);
    const so = path.join(ext, 'tools', 'sim-agent', 'sim_agent');
    assert.deepStrictEqual(vprun.agentLibrary(undefined, { VP_SIM_AGENT: so }), { lib: so });
    assert.deepStrictEqual(vprun.agentLibrary(so + '.so', {}), { lib: so });
  } finally {
    if (saved !== undefined) process.env.XDG_CONFIG_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('launch: Lua path and the agent module', () => {
  assert.strictEqual(launch.luaPathFor('/p/x.platform.json', { name: 'ubuntu' }), '/p/ubuntu.generated.lua');
  assert.strictEqual(launch.luaPathFor('/p/x.platform.json', {}), '/p/x.generated.lua');
  assert.deepStrictEqual(launch.agentModule('/a/sim_agent', 5000), { name: 'sim_agent', type: 'sim_agent', dylib: '/a/sim_agent', params: { port: 5000 } });
  // A library built before the rename (vp_sim_agent.so) registered the old type name.
  assert.deepStrictEqual(launch.agentModule('/a/vp_sim_agent', 5000), { name: 'sim_agent', type: 'vp_sim_agent', dylib: '/a/vp_sim_agent', params: { port: 5000 } });
});
