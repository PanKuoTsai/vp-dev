'use strict';
// Run with: node test/manifest.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { extensionFiles, extensionSource, shipped } = require('./helpers');

test('settings that name this machine\'s programs and hosts are machine-overridable', () => {
  // In a VS Code Remote-SSH window the extension runs on the Linux machine; the
  // Windows user settings (remote.host = the Linux machine itself, 2026-11-21)
  // must not apply there, or VP Studio sshes to itself and the forwards clash.
  const props = require('../package.json').contributes.configuration.properties;
  for (const k of ['vpStudio.executable', 'vpStudio.simAgent.library', 'vpStudio.dtc', 'vpStudio.debug.targetGdb',
    'vpStudio.remote.host', 'vpStudio.remote.root', 'vpStudio.remote.executable', 'vpStudio.remote.sshArgs', 'vpStudio.remote.auth']) {
    assert.strictEqual(props[k].scope, 'machine-overridable', k);
  }
});

test('tasks set their working folder (no ${workspaceFolder} when no folder is open)', () => {
  const ext = extensionSource();
  const execs = ext.match(/new vscode\.(Shell|Process)Execution\([^\n]*/g) || [];
  assert.ok(execs.length >= 4, execs.length);
  for (const e of execs) assert.match(e, /cwd: (common\.)?taskCwd\(/, e);
});

test('Windows: extension.js and src/ parse, local-only commands are hidden by vpStudio.localSim', () => {
  for (const [name, text] of extensionFiles()) new (require('vm').Script)(text, { filename: name });
  const menu = require('../lib/menu');
  const titles = menu.titlesFrom(require('../package.json'));
  const shown = (ctx) => menu.visible(ctx, titles).flatMap((g) => g.items.map((i) => i.command));
  const linux = shown({ 'vpStudio.localSim': true });
  const win = shown({ 'vpStudio.localSim': false });
  for (const c of ['vpStudio.buildQbox', 'vpStudio.buildSimAgent', 'vpStudio.checkQBox', 'vpStudio.startOpenOcd', 'vpStudio.startFromCheckpoint']) {
    assert.ok(linux.includes(c) && !win.includes(c), c);
  }
  for (const c of ['vpStudio.start', 'vpStudio.remote.selectHost', 'vpStudio.remote.buildSimAgent', 'vpStudio.remote.buildModel', 'vpStudio.buildModel', 'vpStudio.generateDeviceTree']) {
    assert.ok(win.includes(c), c);
  }
});

test('menu: every command is in a group, package.json matches, when clauses follow the state', () => {
  const menu = require('../lib/menu');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const declared = pkg.contributes.commands.map((c) => c.command);
  const hidden = new Set(pkg.contributes.menus.commandPalette.filter((m) => m.when === 'false').map((m) => m.command));
  // Buttons of their own views, and the menu itself, are not in the menu.
  const own = new Set(['vpStudio.menu', 'vpStudio.refreshRegisters', 'vpStudio.refreshParams', 'vpStudio.refreshGuest']);
  const inMenu = menu.commands();
  assert.strictEqual(new Set(inMenu).size, inMenu.length, 'a command is in the menu twice');
  for (const c of inMenu) assert.ok(declared.includes(c), `${c} is not a declared command`);
  assert.deepStrictEqual(declared.filter((c) => !hidden.has(c) && !own.has(c) && !inMenu.includes(c)), [], 'commands missing from the menu');
  // Every entry of the Actions view has an icon (a codicon in package.json).
  const iconOf = menu.titlesFrom(pkg);
  assert.deepStrictEqual(inMenu.filter((c) => !iconOf[c].icon), [], 'menu commands without an icon');
  // ...and the icon exists (a name that does not shows nothing; checked when the
  // codicons that come with the standalone application are installed).
  // debug-configure is an alias VS Code and Theia add to the font.
  const css = path.join(__dirname, '..', 'theia', 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css');
  if (fs.existsSync(css)) {
    const known = fs.readFileSync(css, 'utf8');
    const used = [...new Set([...Object.values(iconOf).map((t) => t.icon), ...menu.GROUPS.map((g) => g.icon)].filter(Boolean))];
    assert.deepStrictEqual(used.filter((i) => i !== 'debug-configure' && !known.includes(`.codicon-${i}:before`)), [], 'icons that do not exist');
  }
  // The "VP Studio ▾" submenus in package.json are exactly what lib/menu.js describes.
  const c = menu.contributions();
  assert.deepStrictEqual(pkg.contributes.submenus, c.submenus);
  for (const [k, v] of Object.entries(c.menus)) assert.deepStrictEqual(pkg.contributes.menus[k], v, k);
  assert.deepStrictEqual(pkg.contributes.menus['editor/title'][0], c.editorTitle);
  assert.ok(pkg.contributes.views.vpStudio.some((v) => v.id === 'vpStudio.actions'));

  assert.strictEqual(menu.evaluate('', {}), true);
  assert.strictEqual(menu.evaluate('a && !b', { a: true }), true);
  assert.strictEqual(menu.evaluate('a && !b', { a: true, b: true }), false);
  assert.strictEqual(menu.evaluate('x || a && b', { a: true, b: true }), true);
  assert.throws(() => menu.evaluate('a == 1', {}), /unsupported/);

  const titles = menu.titlesFrom(pkg);
  const flat = (ctx) => menu.visible(ctx, titles).flatMap((g) => g.items.map((i) => i.command));
  const idle = flat({});
  assert.ok(idle.includes('vpStudio.start') && idle.includes('vpStudio.connectAgent'));
  assert.ok(!idle.includes('vpStudio.pause') && !idle.includes('vpStudio.stop') && !idle.includes('vpStudio.ftrace.record'));
  const running = flat({ 'vpStudio.running': true, 'vpStudio.agentConnected': true });
  assert.ok(running.includes('vpStudio.pause') && running.includes('vpStudio.stop') && running.includes('vpStudio.ftrace.record'));
  assert.ok(!running.includes('vpStudio.start') && !running.includes('vpStudio.continue') && !running.includes('vpStudio.connectAgent'));
  const paused = flat({ 'vpStudio.running': true, 'vpStudio.agentConnected': true, 'vpStudio.paused': true });
  assert.ok(paused.includes('vpStudio.continue') && !paused.includes('vpStudio.pause'));
  const sim = menu.visible({}, titles).find((g) => g.id === 'simulation');
  assert.strictEqual(sim.items[0].label, 'Start Simulation');
  assert.strictEqual(sim.items[0].icon, 'play');
  // A separator only before the first item of a later section that shows.
  assert.deepStrictEqual(sim.items.filter((i) => i.separatorBefore).map((i) => i.command), ['vpStudio.connectAgent']);
  const ana = menu.visible({}, titles).find((g) => g.id === 'analysis');
  assert.deepStrictEqual(ana.items.map((i) => [i.command, i.separatorBefore]), [
    ['vpStudio.showTrace', false], ['vpStudio.showProfile', true], ['vpStudio.ftrace.convert', true],
    ['vpStudio.perf.newSweep', true], ['vpStudio.perf.open', false], ['vpStudio.perf.createExample', false]]);
  // Running performance experiments needs QBox on this machine.
  const anaLocal = menu.visible({ 'vpStudio.localSim': true }, titles).find((g) => g.id === 'analysis');
  assert.ok(anaLocal.items.some((i) => i.command === 'vpStudio.perf.run') && anaLocal.items.some((i) => i.command === 'vpStudio.perf.sweep'));
  assert.strictEqual(ana.items[1].icon, 'flame');
});

test('menu: the standalone application puts the same menu in its menu bar', () => {
  const file = path.join(__dirname, '..', 'theia', 'vp-studio-menu', 'lib', 'frontend-module.js');
  let mod;
  try { mod = require(file); } catch (e) {
    if (/Cannot find module '@theia/.test(e.message)) { console.log('     (skipped: theia/node_modules not installed)'); return; }
    throw e;
  }
  const menu = require('../lib/menu');
  const submenus = [];
  const actions = [];
  mod.registerMenus({
    registerSubmenu: (p, label) => submenus.push([p.join('/'), label]),
    registerMenuAction: (p, a) => actions.push(Object.assign({ path: p.join('/') }, a)),
  });
  assert.deepStrictEqual(submenus.slice(0, 3), [
    ['menubar/8_vpstudio', 'VP Studio'], ['menubar/8_vpstudio/1_groups/1_simulation', 'Simulation'], ['menubar/8_vpstudio/1_groups/2_analysis', 'Analysis']]);
  assert.deepStrictEqual(actions.map((a) => a.commandId), menu.commands());
  const pause = actions.find((a) => a.commandId === 'vpStudio.pause');
  assert.deepStrictEqual(pause, { path: 'menubar/8_vpstudio/1_groups/1_simulation/2_section', commandId: 'vpStudio.pause', label: 'Pause Simulation', order: '01', when: 'vpStudio.agentConnected && !vpStudio.paused' });
});

test('container-sshd.sh: valid shell, shipped, documented (INSTALL.md section 11)', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'tools/container/container-sshd.sh');
  const r = require('child_process').spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const text = fs.readFileSync(script, 'utf8');
  // Keys only, forwarding for VP Studio's -L, the image's environment passed on.
  for (const line of ['PasswordAuthentication no', 'AllowTcpForwarding local', 'PermitUserEnvironment yes']) assert.ok(text.includes(line), line);
  assert.ok(shipped('tools/container/container-sshd.sh'));
  const install = fs.readFileSync(path.join(root, 'INSTALL.md'), 'utf8');
  assert.match(install, /## 11\. Windows 電腦搭配 server 上的容器/);
  assert.match(install, /container-sshd\.sh --key/);
});
