'use strict';
// Password login for remote simulation (vpStudio.remote.auth = "password").
//
// VP Studio runs ssh many times without a terminal to type into (file checks,
// uploads, the Lua, builds), so ssh cannot ask for a password itself. With
// SSH_ASKPASS and SSH_ASKPASS_REQUIRE=force (OpenSSH 8.4 and later, also the
// OpenSSH of Windows 10/11) ssh runs a helper program for every prompt and
// reads the answer from its output. The helper (askpass-helper.js, started
// with VS Code's own Node) asks this process over a local TCP connection that
// needs a random token, so the password is never in a file, an argument or an
// environment variable: only in the memory of the extension.
// No VS Code dependency.

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const HELPER = path.join(__dirname, 'askpass-helper.js');

/**
 * What a prompt asks: 'password' (a password or passphrase), 'confirm' (a
 * yes/no question such as an unknown host key), or 'other'.
 */
function promptKind(prompt) {
  const p = String(prompt || '');
  if (/\(yes\/no(\/\[fingerprint\])?\)/i.test(p) || /continue connecting/i.test(p)) return 'confirm';
  if (/pass(word|phrase|code)|PIN/i.test(p)) return 'password';
  return 'other';
}

/**
 * The askpass server. answer({ host, prompt, kind }) resolves the text to give
 * ssh, or null to give none (ssh then fails). Resolves { port, token, close() }.
 */
function startServer(answer) {
  const token = crypto.randomBytes(24).toString('hex');
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buf = '';
    let done = false;
    const reply = (obj) => { if (!done) { done = true; socket.end(JSON.stringify(obj) + '\n'); } };
    socket.on('error', () => {});
    socket.setTimeout(10 * 60 * 1000, () => socket.destroy());
    socket.on('data', async (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0 || done) return;
      let req;
      try { req = JSON.parse(buf.slice(0, nl)); } catch (e) { reply({ error: 'bad request' }); return; }
      // Constant-time token check; a wrong token gets nothing.
      const a = Buffer.from(String(req.token || ''));
      const b = Buffer.from(token);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { reply({ error: 'bad token' }); return; }
      try {
        const text = await answer({ host: String(req.host || ''), prompt: String(req.prompt || ''), kind: promptKind(req.prompt) });
        reply(typeof text === 'string' ? { answer: text } : { error: 'no answer' });
      } catch (e) { reply({ error: e.message }); }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      resolve({ port: server.address().port, token, close: () => server.close() });
    });
  });
}

/** The Windows launcher, built from tools/askpass/vp-askpass.c (tools/askpass/build.sh). */
const WINDOWS_LAUNCHER = path.join(__dirname, 'vp-askpass.exe');

/** A path the OpenSSH of Windows can start: printable ASCII and no spaces. */
const sshSafePath = (p) => /^[\x21-\x7e]+$/.test(String(p));

/** The user's SID from "whoami /user /fo csv /nh" ("domain\\name","S-1-5-21-..."). */
function sidFrom(whoamiOut) {
  const m = /"(S-1-[0-9-]+)"\s*$/m.exec(String(whoamiOut || ''));
  return m ? m[1] : null;
}

/**
 * Where the launcher goes when its own path is not one ssh can start (a user
 * name such as 潘國才 puts non-ASCII characters in it: OpenSSH for Windows then
 * fails with "CreateProcessW failed error:2", 2026-11-21): a folder of this
 * user under ProgramData, named after the SID so the path is ASCII.
 */
function windowsLauncherDir(sid, env = process.env) {
  const base = env.ProgramData && sshSafePath(env.ProgramData) ? env.ProgramData : `${env.SystemDrive || 'C:'}\\ProgramData`;
  const tag = crypto.createHash('sha256').update(String(sid)).digest('hex').slice(0, 16);
  return path.win32.join(base, `VPStudio-${tag}`);
}

/**
 * The launcher on Windows: vp-askpass.exe where the extension is, or, when that
 * path has non-ASCII characters or spaces, a copy in windowsLauncherDir. The
 * copy's folder is limited to this user, SYSTEM and Administrators (icacls,
 * inheritance off; it fails, and so does this, when another user made the
 * folder), and the copy is checked against the original before each use.
 * run(cmd, args) runs a program and returns its output (tests pass their own).
 */
function windowsLauncher({ exe = WINDOWS_LAUNCHER, run = defaultRun, env = process.env, fsx = fs } = {}) {
  if (sshSafePath(exe)) return exe;
  const sid = sidFrom(run('whoami', ['/user', '/fo', 'csv', '/nh']));
  if (!sid) throw new Error('cannot find this Windows user\'s SID (whoami /user)');
  const dir = windowsLauncherDir(sid, env);
  fsx.mkdirSync(dir, { recursive: true });
  run('icacls', [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
  const copy = path.win32.join(dir, 'vp-askpass.exe');
  const want = fsx.readFileSync(exe);
  let have = null;
  try { have = fsx.readFileSync(copy); } catch (e) { /* not there yet */ }
  if (!have || !have.equals(want)) fsx.writeFileSync(copy, want);
  return copy;
}

/** True when the copy made by windowsLauncher is still the same program. */
function launcherIntact(copy, exe = WINDOWS_LAUNCHER, fsx = fs) {
  if (copy === exe) return true;
  try { return fsx.readFileSync(copy).equals(fsx.readFileSync(exe)); } catch (e) { return false; }
}

function defaultRun(cmd, args) {
  return require('child_process').execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The small program ssh starts (SSH_ASKPASS cannot take arguments), which runs
 * askpass-helper.js with VS Code's Node (ELECTRON_RUN_AS_NODE). Returns its path.
 * On Windows it is vp-askpass.exe next to this file: the OpenSSH of Windows
 * starts SSH_ASKPASS with CreateProcess, which runs only .exe files (a .cmd
 * failed with "CreateProcessW failed error:2", 2026-11-21). Elsewhere a shell
 * script written into dir.
 */
function writeLauncher(dir, platform = process.platform) {
  if (platform === 'win32') return windowsLauncher();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'vp-askpass.sh');
  fs.writeFileSync(file, '#!/bin/sh\nexec "$VP_ASKPASS_NODE" "$VP_ASKPASS_SCRIPT" "$@"\n', { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

/**
 * Environment for ssh so that it asks through the launcher: { name: value }.
 * node: a Node executable (VS Code's own: process.execPath, run as Node).
 * DISPLAY is set because ssh before 8.4 uses SSH_ASKPASS only with a DISPLAY
 * and without a terminal.
 */
function sshEnv({ launcher, node, port, token, host }) {
  return {
    SSH_ASKPASS: launcher,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY || ':0',
    ELECTRON_RUN_AS_NODE: '1',
    VP_ASKPASS_NODE: node,
    VP_ASKPASS_SCRIPT: HELPER,
    VP_ASKPASS_PORT: String(port),
    VP_ASKPASS_TOKEN: token,
    VP_ASKPASS_HOST: host,
  };
}

/**
 * ssh options for password login: prompts allowed (not BatchMode), one try
 * per prompt, and a host seen for the first time is accepted and remembered
 * (no yes/no question to answer); a changed host key still fails.
 */
const SSH_OPTIONS = ['-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'StrictHostKeyChecking=accept-new'];

/** True when ssh's error output says the login itself was refused. */
const authRefused = (stderr) => /Permission denied|Authentication failed|Too many authentication failures/i.test(String(stderr || ''));

/** True when the server would take a password (it lists password or keyboard-interactive). */
const offersPassword = (stderr) => /Permission denied \([^)]*(password|keyboard-interactive)[^)]*\)/i.test(String(stderr || ''));

module.exports = { HELPER, WINDOWS_LAUNCHER, sshSafePath, sidFrom, windowsLauncherDir, windowsLauncher, launcherIntact, promptKind, startServer, writeLauncher, sshEnv, SSH_OPTIONS, authRefused, offersPassword };
