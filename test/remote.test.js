'use strict';
// Run with: node test/remote.test.js (every file: npm test)
const { test, testAsync } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { load } = require('./helpers');

test('remote: settings, ports, paths and the ssh command line', () => {
  const remote = require('../lib/sim/remote');
  assert.strictEqual(remote.config({ host: '' }), undefined);
  assert.throws(() => remote.config({ host: '-oProxyCommand=x', root: '/r' }), /ssh destination/);
  assert.throws(() => remote.config({ host: 'sim', root: 'qbox' }), /absolute path/);
  const rc = remote.config({ host: 'me@sim', root: '/home/me/qbox/', sshArgs: ['-p', '2222'] });
  assert.deepStrictEqual(rc, { host: 'me@sim', sshArgs: ['-p', '2222'], root: '/home/me/qbox', executable: '/home/me/qbox/build/platforms-vp', buildDir: '/home/me/qbox/build' });
  assert.strictEqual(remote.config({ host: 'sim', root: '/q', executable: '/opt/qbox/bin/platforms-vp' }).buildDir, '/opt/qbox/bin');
  assert.deepStrictEqual(remote.sshArgsFor(rc, 'true'), ['-p', '2222', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'me@sim', 'true']);
  // /proc/net/tcp: listening (0A) sockets only; ports are hex.
  const proc = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:08AE 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1',
    '   1: 0100007F:D431 0100007F:08AE 01 00000000:00000000 00:00000000 00000000  1000        0 2 1',
    '   0: 00000000000000000000000000000000:5BA0 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3 1',
  ].join('\n');
  assert.deepStrictEqual([...remote.listeningPorts(proc)].sort(), [2222, 23456]);
  let k = 0;
  const ports = remote.pickPorts(new Set([2222, 20000]), [{ name: 'SSH', preferred: 2222 }, { name: 'FTP', preferred: 2221 }, { name: '@agent' }, { name: '@gdb', preferred: 2221 }],
    { from: 20000, to: 20003, random: () => (k++ ? 0 : 0) });
  assert.deepStrictEqual(ports, { SSH: 20001, FTP: 2221, '@agent': 20002, '@gdb': 20003 });
  assert.throws(() => remote.pickPorts(new Set([5, 6]), [{ name: 'a' }], { from: 5, to: 6 }), /no free port/);
  assert.strictEqual(remote.mapPath('/w/qbox', '/r/qbox', '/w/qbox/platforms/u/x.lua'), '/r/qbox/platforms/u/x.lua');
  assert.strictEqual(remote.mapPath('/w/qbox', '/r/qbox', '/w/qbox'), '/r/qbox');
  assert.strictEqual(remote.mapPath('/w/qbox', '/r/qbox', '/w/qbox2/x'), undefined);
  assert.strictEqual(remote.mapPath('/w/qbox', '/r/qbox', '/etc/x'), undefined);
  assert.strictEqual(remote.mapText('dylib_path = "/w/qbox/m/x";\nf="/w/qbox";\nother="/w/qbox2/y"', '/w/qbox', '/r'), 'dylib_path = "/r/m/x";\nf="/r";\nother="/w/qbox2/y"');
  const args = remote.terminalArgs(rc, { forwards: [{ local: 1234, remote: 41234 }], cwd: '/home/me/qbox', command: "/home/me/qbox/build/platforms-vp -l '/x y.lua'" });
  assert.deepStrictEqual(args, ['-p', '2222', '-tt', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-L', '127.0.0.1:1234:127.0.0.1:41234', 'me@sim',
    "cd /home/me/qbox && exec /home/me/qbox/build/platforms-vp -l '/x y.lua'"]);
  assert.strictEqual(remote.shq("it's"), `'it'\\''s'`);
  assert.match(remote.commandLine(args), /^ssh -p 2222 -tt .* me@sim 'cd \/home\/me\/qbox && exec/);
  // The files a platform names, absolute; the remote check leaves symbol files out.
  const files = remote.platformFiles(load(), '/w/qbox/platforms/ubuntu');
  assert.ok(files.some((f) => f.file === '/w/qbox/platforms/fw/utils.lua' && f.role === 'lua'));
  assert.ok(files.some((f) => f.file === '/w/qbox/platforms/ubuntu/fw/Artifacts/image_ext4.img' && f.role === 'disk'));
  assert.strictEqual(new Set(files.map((f) => f.file)).size, files.length);
});

test('remote from Windows: local C:\\ paths map to the Linux host, in paths and in generated text', () => {
  const remote = require('../lib/sim/remote');
  assert.ok(remote.isWindowsPath('C:\\work') && remote.isWindowsPath('c:/work') && remote.isWindowsPath('\\\\srv\\share'));
  assert.ok(!remote.isWindowsPath('/home/me') && !remote.isWindowsPath('work'));
  // VS Code gives c:\ (lower case) for the workspace and C:\ elsewhere: the same folder.
  assert.strictEqual(remote.mapPath('c:\\Users\\me\\work', '/r/work', 'C:\\Users\\me\\work\\platforms\\u\\x.lua'), '/r/work/platforms/u/x.lua');
  assert.strictEqual(remote.mapPath('C:\\Users\\me\\work', '/r/work', 'C:\\Users\\me\\work'), '/r/work');
  assert.strictEqual(remote.mapPath('C:\\Users\\me\\work', '/r/work', 'C:/Users/me/work/m/build/x'), '/r/work/m/build/x');
  assert.strictEqual(remote.mapPath('C:\\Users\\me\\work', '/r/work', 'C:\\Users\\me\\work2\\x'), undefined);
  assert.strictEqual(remote.mapPath('C:\\Users\\me\\work', '/r/work', 'D:\\Users\\me\\work\\x'), undefined);
  // In Lua (luaStr doubles backslashes), plain, and with / — all become /r/... with / inside.
  const core = require('../lib/platform/core');
  const lua = core.generate({ schemaVersion: '0.1', name: 'w', modules: { m_0: { type: 'mymodel' } } },
    { libraries: { mymodel: 'C:\\Users\\me\\work\\models\\m\\build\\mymodel' } });
  assert.match(lua, /dylib_path = "C:\\\\Users\\\\me\\\\work\\\\models/);
  assert.match(remote.mapText(lua, 'c:\\users\\me\\work', '/r/work'), /dylib_path = "\/r\/work\/models\/m\/build\/mymodel";/);
  assert.strictEqual(remote.mapText('a="C:\\Users\\me\\work\\x\\y.img", b="C:/Users/me/work/z", c="C:\\Users\\me\\work2\\q"', 'C:\\Users\\me\\work', '/r'),
    'a="/r/x/y.img", b="/r/z", c="C:\\Users\\me\\work2\\q"');
  // The platform's files: ${TOP} ones under the Windows folder; an absolute /path
  // can only be on the Linux host (remoteOnly, nothing to compare or upload).
  const doc = { schemaVersion: '0.1', name: 'w', modules: {
    loader_0: { type: 'loader', params: { 'load_0.bin_file': '${TOP}/fw/Image.bin', 'load_1.bin_file': '/data/images/initrd.img' } } } };
  const files = remote.platformFiles(doc, 'C:\\Users\\me\\work\\platforms\\u');
  const img = files.find((f) => /Image\.bin$/.test(f.file));
  assert.strictEqual(img.file, 'C:\\Users\\me\\work\\platforms\\u\\fw\\Image.bin');
  assert.ok(!img.remoteOnly);
  assert.strictEqual(remote.mapPath('C:\\Users\\me\\work', '/r/work', img.file), '/r/work/platforms/u/fw/Image.bin');
  const rd = files.find((f) => /initrd/.test(f.file));
  assert.deepStrictEqual([rd.file, rd.remoteOnly], ['/data/images/initrd.img', true]);
  // On Linux the same absolute path is a local file as before.
  assert.ok(!remote.platformFiles(doc, '/w/platforms/u').find((f) => /initrd/.test(f.file)).remoteOnly);
});

testAsync('remote: checking and uploading files with the remote shell commands', async () => {
  const remote = require('../lib/sim/remote');
  const { spawn } = require('child_process');
  // "ssh" that runs the remote command in a local shell, so the commands themselves are tested.
  const calls = [];
  const spawnFn = (cmd, args, opts) => { calls.push(args); return spawn('bash', ['-c', args[args.length - 1]], opts); };
  const rc = remote.config({ host: 'sim', root: '/r' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-remote-'));
  const local = path.join(dir, 'local.bin');
  fs.writeFileSync(local, Buffer.alloc(70000, 7));
  fs.writeFileSync(path.join(dir, 'same.txt'), 'abc');
  const there = path.join(dir, 'there');
  fs.mkdirSync(there);
  fs.writeFileSync(path.join(there, 'same.txt'), 'abc');
  fs.writeFileSync(path.join(there, 'other.txt'), 'abcdef');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'abc');
  const st = await remote.checkFiles(rc, [
    { local, remote: path.join(there, 'sub dir', "it's.bin") },
    { local: path.join(dir, 'same.txt'), remote: path.join(there, 'same.txt') },
    { local: path.join(dir, 'other.txt'), remote: path.join(there, 'other.txt') },
  ], { spawnFn });
  assert.deepStrictEqual(st.map((x) => [x.state, x.localSize, x.remoteSize]), [['missing', 70000, null], ['ok', 3, 3], ['size', 3, 6]]);
  assert.strictEqual(calls[0][calls[0].length - 2], 'sim');
  let progress = 0;
  await remote.upload(rc, local, path.join(there, 'sub dir', "it's.bin"), { spawnFn, onProgress: (n) => { progress = n; } });
  assert.strictEqual(progress, 70000);
  assert.ok(fs.readFileSync(path.join(there, 'sub dir', "it's.bin")).equals(fs.readFileSync(local)));
  assert.ok(!fs.existsSync(path.join(there, 'sub dir', "it's.bin.vp-upload")));
  await remote.writeText(rc, path.join(there, 'new', 'p.lua'), 'print(1)\n', { spawnFn });
  assert.strictEqual(fs.readFileSync(path.join(there, 'new', 'p.lua'), 'utf8'), 'print(1)\n');
  assert.strictEqual(await remote.home(rc, { spawnFn }), os.homedir());
  // A failing command reports what it printed; exit code 255 is ssh itself.
  const fail = (code, msg) => (cmd, args, opts) => spawn('bash', ['-c', `echo ${msg} >&2; exit ${code}`], opts);
  await assert.rejects(remote.runOk(rc, 'x', { spawnFn: fail(1, 'nope') }), /nope/);
  await assert.rejects(remote.runOk(rc, 'x', { spawnFn: fail(255, 'Permission denied') }), /cannot connect with ssh to sim: Permission denied.*without a password/);
  // A tool on the host (dtc for VS Code on Windows): stdin in, binary stdout back.
  const bytes = await remote.toolRunner(rc, 'printf', { spawnFn })(['\\001\\377%s', 'x'], '');
  assert.ok(Buffer.isBuffer(bytes) && bytes.equals(Buffer.from([1, 255, 0x78])));
  const echo = await remote.toolRunner(rc, 'cat', { spawnFn })([], 'DTS in');
  assert.strictEqual(echo.toString(), 'DTS in');
  await assert.rejects(remote.toolRunner(rc, 'no-such-tool-vp', { spawnFn })([], ''), /no-such-tool-vp is not installed on sim/);
  // A model folder sent next to what is already there (its remote build/ stays).
  const model = path.join(dir, 'model');
  fs.mkdirSync(path.join(model, 'src'), { recursive: true });
  fs.mkdirSync(path.join(model, 'build'));
  fs.writeFileSync(path.join(model, 'm.model.json'), '{}');
  fs.writeFileSync(path.join(model, 'src', 'm.cc'), '// m');
  fs.writeFileSync(path.join(model, 'build', 'm.so'), 'local build');
  const entries = remote.folderEntries(model, (rel) => !/^build(\/|$)/.test(rel));
  assert.deepStrictEqual(entries.map((e) => e.path).sort(), ['m.model.json', 'src/m.cc']);
  const rmodel = path.join(there, 'models', 'm');
  fs.mkdirSync(path.join(rmodel, 'build'), { recursive: true });
  fs.writeFileSync(path.join(rmodel, 'build', 'm.so'), 'remote build');
  await remote.uploadFiles(rc, entries, rmodel, require('../lib/setup/tar').write, path.join(dir, 'up.tar.gz'), { spawnFn });
  assert.strictEqual(fs.readFileSync(path.join(rmodel, 'src', 'm.cc'), 'utf8'), '// m');
  assert.strictEqual(fs.readFileSync(path.join(rmodel, 'build', 'm.so'), 'utf8'), 'remote build');
  assert.ok(!fs.existsSync(path.join(dir, 'up.tar.gz')));
  fs.rmSync(dir, { recursive: true, force: true });
});

testAsync('remote password login: askpass server, launcher and helper; ssh options and hooks', async () => {
  const askpass = require('../lib/sim/askpass');
  const remote = require('../lib/sim/remote');
  const { spawnSync, spawn } = require('child_process');
  assert.strictEqual(askpass.promptKind("me@sim's password: "), 'password');
  assert.strictEqual(askpass.promptKind('Enter passphrase for key /home/me/.ssh/id_ed25519: '), 'password');
  assert.strictEqual(askpass.promptKind('Are you sure you want to continue connecting (yes/no/[fingerprint])? '), 'confirm');
  assert.strictEqual(askpass.promptKind('Verification code: '), 'other');
  assert.ok(askpass.offersPassword('me@sim: Permission denied (publickey,password).'));
  assert.ok(!askpass.offersPassword('me@sim: Permission denied (publickey).'));
  assert.ok(askpass.authRefused('Permission denied, please try again.') && !askpass.authRefused('Connection refused'));
  // The real thing: the launcher runs the helper with this Node, which asks the server.
  const asked = [];
  const srv = await askpass.startServer(async (q) => { asked.push(q); return q.kind === 'confirm' ? 'no' : 's3cret pa$$ "x"'; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-askpass-'));
  const launcher = askpass.writeLauncher(dir);
  assert.ok(fs.statSync(launcher).mode & 0o100);
  const env = askpass.sshEnv({ launcher, node: process.execPath, port: srv.port, token: srv.token, host: 'me@sim' });
  assert.strictEqual(env.SSH_ASKPASS_REQUIRE, 'force');
  const ask = (prompt, e = env) => new Promise((resolve) => {
    const p = spawn(launcher, [prompt], { env: Object.assign({}, process.env, e) });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
  assert.deepStrictEqual(await ask("me@sim's password: "), { code: 0, out: 's3cret pa$$ "x"\n' });
  assert.deepStrictEqual(asked[0], { host: 'me@sim', prompt: "me@sim's password: ", kind: 'password' });
  assert.deepStrictEqual(await ask('continue connecting (yes/no)? '), { code: 0, out: 'no\n' });
  // A wrong token gets no answer: the helper exits 1 and ssh gives up.
  assert.strictEqual((await ask('password: ', Object.assign({}, env, { VP_ASKPASS_TOKEN: 'x'.repeat(48) }))).code, 1);
  assert.strictEqual(asked.length, 2);
  // No answer (the input box was closed): exit 1.
  const srv2 = await askpass.startServer(async () => null);
  assert.strictEqual((await ask('password: ', askpass.sshEnv({ launcher, node: process.execPath, port: srv2.port, token: srv2.token, host: 'h' }))).code, 1);
  srv.close(); srv2.close();
  // ssh options: BatchMode for keys; prompts allowed and new host keys accepted for passwords.
  const rc = remote.config({ host: 'me@sim', root: '/r' });
  assert.deepStrictEqual(remote.sshArgsFor(rc, 'true').slice(0, 2), ['-o', 'BatchMode=yes']);
  let refused = 0, accepted = 0;
  rc.askpass = { env: { SSH_ASKPASS: launcher, VP_ASKPASS_TOKEN: 't' }, onRefused: () => refused++, onAccepted: () => accepted++ };
  assert.deepStrictEqual(remote.sshArgsFor(rc, 'true').slice(0, 6), ['-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'StrictHostKeyChecking=accept-new']);
  assert.deepStrictEqual(remote.terminalArgs(rc, { cwd: '/r', command: 'x' }).slice(0, 7), ['-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'StrictHostKeyChecking=accept-new', '-tt']);
  // Every ssh gets the askpass environment; a refused password is forgotten, a login that worked is reported.
  let seenEnv;
  const fake = (code, err) => (cmd, args, opts) => { seenEnv = opts.env; return spawn('bash', ['-c', `echo '${err}' >&2; exit ${code}`], opts); };
  await assert.rejects(remote.runOk(rc, 'x', { spawnFn: fake(255, 'me@sim: Permission denied (publickey,password).') }), /password was not accepted; the next try asks again/);
  assert.strictEqual(seenEnv.VP_ASKPASS_TOKEN, 't');
  assert.strictEqual(seenEnv.PATH, process.env.PATH);
  assert.deepStrictEqual([refused, accepted], [1, 0]);
  await remote.runOk(rc, 'x', { spawnFn: fake(0, '') });
  assert.deepStrictEqual([refused, accepted], [1, 1]);
  await assert.rejects(remote.runOk(rc, 'x', { spawnFn: fake(255, 'ssh: connect to host sim port 22: Connection refused') }), (e) => !/password was not accepted/.test(e.message));
  assert.deepStrictEqual([refused, accepted], [1, 1]);
  // Key login refused: the error carries ssh's message, for the offer to use a password.
  delete rc.askpass;
  await assert.rejects(remote.runOk(rc, 'x', { spawnFn: fake(255, 'me@sim: Permission denied (publickey,password).') }),
    (e) => askpass.offersPassword(e.sshStderr) && /set "vpStudio.remote.auth" to "password"/.test(e.message));
  fs.rmSync(dir, { recursive: true, force: true });
  // On Windows the launcher is vp-askpass.exe (OpenSSH for Windows runs only .exe as SSH_ASKPASS):
  // shipped next to askpass.js, a 64-bit Windows program built from tools/askpass/vp-askpass.c.
  const exe = askpass.writeLauncher(path.join(os.tmpdir(), 'unused'), 'win32');
  assert.strictEqual(exe, path.join(__dirname, '..', 'lib', 'sim', 'vp-askpass.exe'));
  const pe = fs.readFileSync(exe);
  assert.strictEqual(pe.toString('latin1', 0, 2), 'MZ');
  const peAt = pe.readUInt32LE(0x3c);
  assert.strictEqual(pe.toString('latin1', peAt, peAt + 4), 'PE\0\0');
  assert.strictEqual(pe.readUInt16LE(peAt + 4), 0x8664); // x86-64
  // It reads the same variables sshEnv sets, and is in the .vsix.
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'askpass', 'vp-askpass.c'), 'utf8');
  for (const v of ['VP_ASKPASS_NODE', 'VP_ASKPASS_SCRIPT']) { assert.ok(src.includes(v) && env[v] !== undefined, v); }
  // A Windows user folder with non-ASCII characters (潘國才): OpenSSH cannot start
  // the launcher there ("CreateProcessW failed error:2", 2026-11-21), so it is copied to
  // an ASCII folder of this user under ProgramData, limited to the user with icacls.
  assert.ok(askpass.sshSafePath('C:\\Users\\me\\.vscode\\extensions\\novatek.vp-studio-0.2.0\\lib\\vp-askpass.exe'));
  assert.ok(!askpass.sshSafePath('C:\\Users\\潘國才\\.vscode\\x.exe') && !askpass.sshSafePath('C:\\Users\\Pan Kuo\\x.exe'));
  assert.strictEqual(askpass.sidFrom('"vm\\pan","S-1-5-21-1004336348-1177238915-682003330-1001"\r\n'), 'S-1-5-21-1004336348-1177238915-682003330-1001');
  assert.strictEqual(askpass.sidFrom('garbage'), null);
  const sid = 'S-1-5-21-1-2-3-1001';
  const wdir = askpass.windowsLauncherDir(sid, { ProgramData: 'C:\\ProgramData' });
  assert.match(wdir, /^C:\\ProgramData\\VPStudio-[0-9a-f]{16}$/);
  assert.strictEqual(askpass.windowsLauncherDir(sid, { ProgramData: 'D:\\資料', SystemDrive: 'C:' }).startsWith('C:\\ProgramData\\VPStudio-'), true);
  const files = new Map([['C:\\Users\\潘國才\\ext\\lib\\vp-askpass.exe', Buffer.from('MZ launcher v1')]]);
  const fsx = {
    mkdirSync: (d) => { files.set(d + '\\', null); },
    readFileSync: (f) => { if (!files.has(f) || files.get(f) === null) throw new Error('ENOENT ' + f); return files.get(f); },
    writeFileSync: (f, b) => { files.set(f, Buffer.from(b)); },
  };
  const runs = [];
  const run = (cmd, args) => { runs.push([cmd, ...args]); return cmd === 'whoami' ? `"vm\\潘國才","${sid}"\r\n` : 'processed 1 files'; };
  const orig = 'C:\\Users\\潘國才\\ext\\lib\\vp-askpass.exe';
  const copy = askpass.windowsLauncher({ exe: orig, run, env: { ProgramData: 'C:\\ProgramData' }, fsx });
  assert.strictEqual(copy, wdir + '\\vp-askpass.exe');
  assert.ok(askpass.sshSafePath(copy));
  assert.deepStrictEqual(runs[1], ['icacls', wdir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
  assert.ok(files.get(copy).equals(files.get(orig)));
  assert.ok(askpass.launcherIntact(copy, orig, fsx));
  files.set(copy, Buffer.from('something else'));
  assert.ok(!askpass.launcherIntact(copy, orig, fsx));
  askpass.windowsLauncher({ exe: orig, run, env: { ProgramData: 'C:\\ProgramData' }, fsx }); // rewritten
  assert.ok(askpass.launcherIntact(copy, orig, fsx));
  // An ASCII path is used where it is; icacls failing (another user's folder) stops it.
  assert.strictEqual(askpass.windowsLauncher({ exe: 'C:\\Users\\me\\lib\\vp-askpass.exe', run: () => { throw new Error('not called'); } }), 'C:\\Users\\me\\lib\\vp-askpass.exe');
  assert.throws(() => askpass.windowsLauncher({ exe: orig, env: {}, fsx, run: (cmd) => { if (cmd === 'icacls') throw new Error('Access is denied.'); return `"x","${sid}"`; } }), /Access is denied/);
  assert.ok(!/^(lib\/\*\*|\*\.exe|lib\/vp-askpass\.exe)$/m.test(fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8')));
});

testAsync('remote: the simulator is found when a QBox or build folder was given for it', async () => {
  const remote = require('../lib/sim/remote');
  const { spawn } = require('child_process');
  const spawnFn = (cmd, args, opts) => spawn('bash', ['-c', args[args.length - 1]], opts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-exe-'));
  const q = path.join(dir, 'my qbox');
  fs.mkdirSync(path.join(q, 'build'), { recursive: true });
  fs.writeFileSync(path.join(q, 'build', 'platforms-vp'), '#!/bin/sh\n', { mode: 0o755 });
  const exe = path.join(q, 'build', 'platforms-vp');
  // 2026-11-21: "…/qbox/build" given, so the build folder was taken as …/qbox (no CMakeCache.txt).
  const given = remote.config({ host: 'h', root: '/r', executable: path.join(q, 'build') + '/' });
  assert.strictEqual(given.executable, path.join(q, 'build'));
  assert.strictEqual(given.buildDir, q);
  for (const g of [exe, path.join(q, 'build'), q]) assert.strictEqual(await remote.findExecutable(given, g, { spawnFn }), exe, g);
  assert.strictEqual(await remote.findExecutable(given, path.join(dir, 'nothing'), { spawnFn }), null);
  // Relative to remote.root.
  const rel = remote.config({ host: 'h', root: dir, executable: 'my qbox' });
  assert.strictEqual(await remote.findExecutable(rel, undefined, { spawnFn }), exe);
  fs.rmSync(dir, { recursive: true, force: true });
});
