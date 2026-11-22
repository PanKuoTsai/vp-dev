'use strict';
// Remote simulation (F-03): the simulator runs on another machine reached with
// OpenSSH, VP Studio stays on this one. No VS Code dependency, no Microsoft
// Remote extension: only the ssh client.
//
//   - The workspace folder on this machine corresponds to a folder on the
//     remote host (remote.root). The generated Lua is written to the remote
//     copy of the platform's folder, so ${TOP} paths resolve there; absolute
//     paths under the local folder are rewritten to the remote one.
//   - Files the platform needs are checked on the remote host; missing ones
//     can be uploaded (cat over ssh, no scp/rsync needed).
//   - The simulator runs in "ssh -tt", in a VS Code terminal: closing it hangs
//     up the remote pty, so the simulator gets SIGHUP as it does locally.
//   - The sim agent, gdb and the platform's host ports are forwarded with -L
//     to ports of this machine; everything else talks to localhost.
//   - Libraries VP Studio builds (sim agent) are built on the
//     remote host against its QBox, from sources sent over ssh.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Local files a platform names (loader images, disks, Lua includes, symbol
 * files...), absolute, without duplicates: what the remote host must have too.
 */
function platformFiles(doc, platformDir) {
  const kit = require('./kit');
  const P = pathFor(platformDir);
  const top = platformDir.endsWith(P.sep) ? platformDir : platformDir + P.sep;
  const out = [];
  for (const r of kit.references(doc).refs) {
    const e = r.expanded;
    if (/\$\{/.test(e.replace(/^\$\{TOP\}/, ''))) continue;
    // On Windows an absolute /path can only be one on the (Linux) simulation
    // host: remoteOnly, there is no local copy to compare or upload.
    const remoteOnly = P === path.win32 && e.startsWith('/');
    const f = remoteOnly ? path.posix.normalize(e) : e.startsWith('${TOP}') ? P.resolve(top + e.slice(6)) : P.resolve(e);
    if (!out.some((x) => x.file === f)) out.push(Object.assign({ file: f, role: r.role, key: r.key }, remoteOnly ? { remoteOnly } : {}));
  }
  return out;
}

/** Quote for a POSIX shell. */
function shq(s) {
  const t = String(s);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(t) ? t : `'${t.replace(/'/g, `'\\''`)}'`;
}

/** Normalize the settings: { host, sshArgs, root, executable, buildDir, home? }. Throws on bad values. */
function config(c) {
  const host = String((c && c.host) || '').trim();
  if (!host) return undefined;
  if (/^-/.test(host) || /\s/.test(host)) throw new Error(`remote.host "${host}" must be an ssh destination such as user@host or a Host from ~/.ssh/config`);
  const root = String(c.root || '').trim().replace(/\/+$/, '');
  if (!root.startsWith('/')) throw new Error('remote.root must be the absolute path on the remote host of the folder that matches this workspace folder, e.g. /home/me/qbox');
  const sshArgs = Array.isArray(c.sshArgs) ? c.sshArgs.map(String) : [];
  const exe = String(c.executable || 'build/platforms-vp').trim().replace(/\/+$/, '') || 'build/platforms-vp';
  const executable = exe.startsWith('/') ? exe : `${root}/${exe}`;
  return { host, sshArgs, root, executable, buildDir: path.posix.dirname(executable) };
}

/**
 * Shell script that finds the simulator from what was given for it: the
 * program itself, or a QBox build folder or QBox folder holding it (users
 * typed the folder, 2026-11-21: the build then looked for CMakeCache.txt one
 * level too high). Prints the program's path, or nothing.
 */
function findExecutableScript(given) {
  const q = shq(given);
  return `for f in ${q} ${q}/platforms-vp ${q}/build/platforms-vp; do if [ -f "$f" ] && [ -x "$f" ]; then printf '%s\\n' "$f"; exit 0; fi; done; exit 0`;
}

/** The simulator on the remote host found from rc.executable (or given): its path, or null. */
async function findExecutable(rc, given = rc.executable, opts) {
  const p = given.startsWith('/') ? given : `${rc.root}/${given}`;
  const out = (await runOk(rc, findExecutableScript(p.replace(/\/+$/, '')), opts)).trim();
  return out ? out.split('\n')[0] : null;
}

/**
 * The login options: BatchMode (keys only: a password prompt would hang
 * without a terminal), or, with password login (rc.askpass, see askpass.js),
 * prompts answered by VP Studio's askpass program.
 */
const authOptions = (rc) => (rc.askpass ? require('./askpass').SSH_OPTIONS : ['-o', 'BatchMode=yes']);

/** Environment for an ssh process: this one's, plus the askpass variables for password login. */
const sshEnvOf = (rc) => (rc.askpass ? Object.assign({}, process.env, rc.askpass.env) : process.env);

/** Arguments for a non-interactive ssh command. */
function sshArgsFor(rc, command, extra = []) {
  return [...rc.sshArgs, ...authOptions(rc), '-o', 'ConnectTimeout=15', ...extra, rc.host, command];
}

/**
 * Run a command on the remote host. Resolves { code, stdout, stderr }.
 * input: a string or a readable stream for its stdin. Rejects when ssh cannot run.
 */
function run(rc, command, { input, timeoutMs = 60000, onStdout, spawnFn = spawn, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    // windowsHide: no console window flashing on Windows for each ssh call.
    const p = spawnFn('ssh', sshArgsFor(rc, command), { stdio: ['pipe', 'pipe', 'pipe'], env: sshEnvOf(rc), windowsHide: true });
    let stdout = '';
    const chunks = [];
    let stderr = '';
    let timer;
    if (timeoutMs) timer = setTimeout(() => { p.kill('SIGTERM'); }, timeoutMs);
    p.stdout.on('data', (d) => { if (binary) chunks.push(d); else stdout += d; if (onStdout) onStdout(String(d)); });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error('ssh is not installed (OpenSSH client)') : e); });
    // ssh may end before reading all its input (a refused connection, a command
    // that does not read stdin): the write then fails with EPIPE. That is not the
    // result; the exit code and stderr are, so the stdin error is only swallowed.
    p.stdin.on('error', () => {});
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) { reject(new Error(`ssh ${rc.host}: ${signal === 'SIGTERM' && timeoutMs ? `no answer in ${timeoutMs / 1000} s` : `ended by ${signal}`}`)); return; }
      // A refused password is forgotten, so the next try asks again.
      if (code === 255 && rc.askpass && rc.askpass.onRefused && require('./askpass').authRefused(stderr)) rc.askpass.onRefused();
      else if (code !== 255 && rc.askpass && rc.askpass.onAccepted) rc.askpass.onAccepted();
      resolve({ code, stdout: binary ? Buffer.concat(chunks) : stdout, stderr });
    });
    if (input && typeof input.pipe === 'function') {
      input.on('error', (e) => { p.kill('SIGTERM'); reject(e); });
      input.pipe(p.stdin);
    } else {
      p.stdin.end(input === undefined ? '' : input);
    }
  });
}

/** Run and require exit code 0; returns stdout. The error says what ssh printed. */
async function runOk(rc, command, opts) {
  const r = await run(rc, command, opts);
  if (r.code !== 0) {
    const msg = String(r.stderr || (Buffer.isBuffer(r.stdout) ? '' : r.stdout)).trim().split('\n').slice(-3).join(' ');
    if (r.code === 255) {
      const e = new Error(rc.askpass
        ? `cannot connect with ssh to ${rc.host}: ${msg || 'ssh exit code 255'}${require('./askpass').authRefused(r.stderr) ? '. The password was not accepted; the next try asks again.' : ''}`
        : `cannot connect with ssh to ${rc.host}: ${msg || 'ssh exit code 255'}. VP Studio uses key authentication (BatchMode); check that "ssh ${rc.host}" logs in without a password, or set "vpStudio.remote.auth" to "password".`);
      e.sshStderr = r.stderr;
      throw e;
    }
    throw new Error(`${msg || `exit code ${r.code}`}`);
  }
  return r.stdout;
}

/** Ports in LISTEN state in /proc/net/tcp and /proc/net/tcp6 text. */
function listeningPorts(procText) {
  const out = new Set();
  for (const line of String(procText).split('\n')) {
    const m = /^\s*\d+:\s+[0-9A-Fa-f]+:([0-9A-Fa-f]{4})\s+[0-9A-Fa-f]+:[0-9A-Fa-f]{4}\s+0A\s/.exec(line);
    if (m) out.add(parseInt(m[1], 16));
  }
  return out;
}

/**
 * Ports for each wanted name: the preferred one when it is not busy and not
 * already given, else the next free one from `from`. wanted: [{name, preferred?}].
 * Returns {name: port}.
 */
function pickPorts(busy, wanted, { from = 20000, to = 60999, random = Math.random } = {}) {
  const taken = new Set(busy);
  const out = {};
  for (const w of wanted) {
    let p = w.preferred;
    if (!(p > 0 && p < 65536) || taken.has(p)) {
      const span = to - from + 1;
      const start = from + Math.floor(random() * span);
      p = undefined;
      for (let k = 0; k < span; k++) {
        const c = from + ((start - from + k) % span);
        if (!taken.has(c)) { p = c; break; }
      }
      if (p === undefined) throw new Error('no free port');
    }
    taken.add(p);
    out[w.name] = p;
  }
  return out;
}

/** True for a Windows path (C:\\work, \\\\server\\share): VS Code on Windows, with the simulator on a Linux host. */
const isWindowsPath = (p) => /^[A-Za-z]:[\\/]|^\\\\/.test(String(p || ''));
const pathFor = (p) => (isWindowsPath(p) ? path.win32 : path.posix);

/** The remote path of a local path under localRoot, or undefined when it is outside. */
function mapPath(localRoot, remoteRoot, p) {
  const P = pathFor(localRoot);
  const rel = P.relative(localRoot, p);
  if (rel === '' ) return remoteRoot;
  if (rel.startsWith('..') || P.isAbsolute(rel)) return undefined;
  return `${remoteRoot}/${rel.split(P.sep).join('/')}`;
}

/**
 * Text with every local absolute path under localRoot rewritten to the remote
 * root. A Windows localRoot matches in any letter case, with a backslash, a
 * doubled one (inside a Lua or JSON string) or / between the parts, and the
 * rest of the path gets / too.
 */
function mapText(text, localRoot, remoteRoot) {
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (isWindowsPath(localRoot)) {
    const sep = '(?:\\\\\\\\|\\\\|/)';
    const parts = String(localRoot).split(/[\\/]+/).filter(Boolean);
    const lead = /^\\\\/.test(localRoot) ? `${sep}${sep}` : '';
    const re = new RegExp(lead + parts.map(esc).join(sep) + `(?=${sep}|"|'|,|$)((?:${sep}[^"'\\n,\\\\/]*)*)`, 'gim');
    return String(text).replace(re, (m, rest) => remoteRoot + rest.replace(/\\\\|\\/g, '/'));
  }
  const lr = localRoot.replace(/\/+$/, '');
  const re = new RegExp(esc(lr) + '(?=/|"|\'|,|$)', 'gm');
  return String(text).replace(re, remoteRoot);
}

/** Shell script that prints "<size>\t<path>" or "-\t<path>" for each file. */
function fileCheckScript(files) {
  return `for f in ${files.map(shq).join(' ')}; do if [ -e "$f" ]; then printf '%s\\t%s\\n' "$(stat -L -c %s -- "$f")" "$f"; else printf -- '-\\t%s\\n' "$f"; fi; done`;
}

/** Parse fileCheckScript output: Map path -> size (number) or null when missing. */
function parseFileCheck(out) {
  const m = new Map();
  for (const line of String(out).split('\n')) {
    const i = line.indexOf('\t');
    if (i < 0) continue;
    const size = line.slice(0, i);
    m.set(line.slice(i + 1), size === '-' ? null : Number(size));
  }
  return m;
}

/**
 * Compare local files with the remote ones: [{local, remote, state: 'missing'|'size'|'ok', localSize, remoteSize}].
 * files: [{local, remote}].
 */
async function checkFiles(rc, files, opts) {
  if (!files.length) return [];
  const out = await runOk(rc, fileCheckScript(files.map((f) => f.remote)), opts);
  const sizes = parseFileCheck(out);
  return files.map((f) => {
    let localSize = null;
    try { localSize = fs.statSync(f.local).size; } catch (e) { /* not here either */ }
    const remoteSize = sizes.has(f.remote) ? sizes.get(f.remote) : null;
    const state = remoteSize === null ? 'missing' : localSize !== null && localSize !== remoteSize ? 'size' : 'ok';
    return Object.assign({}, f, { state, localSize, remoteSize });
  });
}

/** Upload one local file (cat over ssh into a temporary name, then rename). */
function upload(rc, localFile, remoteFile, { onProgress, spawnFn } = {}) {
  const dir = path.posix.dirname(remoteFile);
  const tmp = `${remoteFile}.vp-upload`;
  const stream = fs.createReadStream(localFile);
  if (onProgress) {
    let sent = 0;
    stream.on('data', (d) => { sent += d.length; onProgress(sent); });
  }
  return runOk(rc, `mkdir -p ${shq(dir)} && cat > ${shq(tmp)} && mv -f ${shq(tmp)} ${shq(remoteFile)}`, { input: stream, timeoutMs: 0, spawnFn });
}

/** Write a text file on the remote host. */
function writeText(rc, remoteFile, text, opts) {
  return runOk(rc, `mkdir -p ${shq(path.posix.dirname(remoteFile))} && cat > ${shq(remoteFile)}`, Object.assign({ input: text }, opts));
}

/** Upload a folder of VP Studio (a tar stream into remoteDir, which is replaced). */
async function uploadTree(rc, entries, remoteDir, tarWrite, tmpFile) {
  await tarWrite(tmpFile, entries, { gzip: true });
  try {
    await runOk(rc, `rm -rf ${shq(remoteDir)} && mkdir -p ${shq(remoteDir)} && tar -xzf - -C ${shq(remoteDir)}`, { input: fs.createReadStream(tmpFile), timeoutMs: 0 });
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

/**
 * A runner for a tool on the remote host, for code that takes a command or a
 * function (args, input) => Promise<Buffer> (dtc): input on stdin, stdout back as a Buffer.
 */
const toolRunner = (rc, tool, opts = {}) => async (args, input) => {
  const r = await run(rc, [tool, ...args].map(shq).join(' '), Object.assign({ input, binary: true }, opts));
  if (r.code === 127) throw new Error(`${tool} is not installed on ${rc.host}${tool === 'dtc' ? ' (Ubuntu: apt install device-tree-compiler)' : ''}`);
  if (r.code !== 0) throw new Error(`${tool} on ${rc.host}: ${String(r.stderr).trim() || `exit code ${r.code}`}`);
  return r.stdout;
};

/**
 * The files of a local folder for uploadFiles: [{path (with /), file}], with
 * keep(rel) choosing (rel uses /). Symbolic links and other special files are left out.
 */
function folderEntries(dir, keep = () => true) {
  const out = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!keep(r)) continue;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else if (e.isFile()) out.push({ path: r, file: path.join(abs, e.name) });
    }
  };
  walk(dir, '');
  return out;
}

/** Upload files into remoteDir (created when missing), keeping what else is there. */
async function uploadFiles(rc, entries, remoteDir, tarWrite, tmpFile, opts = {}) {
  await tarWrite(tmpFile, entries, { gzip: true });
  try {
    await runOk(rc, `mkdir -p ${shq(remoteDir)} && tar -xzf - -C ${shq(remoteDir)}`, Object.assign({ input: fs.createReadStream(tmpFile), timeoutMs: 0 }, opts));
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

/** The remote user's home directory. */
async function home(rc, opts) {
  const h = (await runOk(rc, 'printf %s "$HOME"', opts)).trim();
  if (!h.startsWith('/')) throw new Error(`unexpected home directory "${h}" on ${rc.host}`);
  return h;
}

/** Where VP Studio builds its libraries on the remote host: <home>/.vp-studio/build/<what>. */
const remoteBuildDir = (homeDir, what) => `${homeDir}/.vp-studio/build/${what}`;

/**
 * ssh arguments for the simulator's terminal: a pty (-tt) so closing the
 * terminal hangs up the simulator, the forwards, and the command.
 * forwards: [{local, remote}] (TCP ports on 127.0.0.1 at both ends).
 */
function terminalArgs(rc, { forwards = [], cwd, command }) {
  const args = [...rc.sshArgs, ...(rc.askpass ? authOptions(rc) : []), '-tt', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15'];
  for (const f of forwards) args.push('-L', `127.0.0.1:${f.local}:127.0.0.1:${f.remote}`);
  args.push(rc.host, `cd ${shq(cwd)} && exec ${command}`);
  return args;
}

/** A shell line that runs terminalArgs (for display and for terminals without shellArgs). */
const commandLine = (args) => ['ssh', ...args].map(shq).join(' ');

module.exports = {
  platformFiles, shq, config, findExecutableScript, findExecutable, isWindowsPath, authOptions, sshEnvOf, sshArgsFor, run, runOk, listeningPorts, pickPorts, mapPath, mapText, fileCheckScript, parseFileCheck,
  checkFiles, upload, writeText, uploadTree, uploadFiles, folderEntries, toolRunner, home, remoteBuildDir, terminalArgs, commandLine,
};
