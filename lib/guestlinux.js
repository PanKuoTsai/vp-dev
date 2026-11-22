'use strict';
// Linux awareness (G-06): what the extension does with tools/gdb/vp-linux.py
// in a CDT debug session. The script defines MI commands (-vp-ps, -vp-dmesg);
// the extension sends them as DAP "evaluate" requests with a leading ">"
// (CDT's rule for gdb commands in the REPL context), and CDT answers with the
// MI result as JSON in body.result. No VS Code dependency.

const SCRIPT_VERSION = '0.1.0';

/** The evaluate arguments for a gdb command through CDT. */
const evaluateArgs = (command) => ({ expression: '>' + command, context: 'repl' });

/**
 * gdb CLI command that loads the script. Through Python, so any path works
 * (a JSON string is a Python string literal; gdb's "source" keeps quotes).
 */
const loadCommand = (scriptPath) => `python import runpy; runpy.run_path(${JSON.stringify(String(scriptPath))})`;

/** The same as an MI command (for evaluate): an MI c-string, so quotes and backslashes are escaped. */
function sourceCommand(scriptPath) {
  return `-interpreter-exec console "${loadCommand(scriptPath).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * A gdbtarget debug configuration that loads the script after connecting and
 * moves the kernel symbols to the running kernel's KASLR offset, while the
 * target is still stopped, so the first call stack is already right. After the
 * configuration's own initCommands (they may add symbol files). Unchanged when
 * it loads the script already.
 */
function withLinuxAwareness(config, scriptPath) {
  const init = Array.isArray(config.initCommands) ? config.initCommands.slice() : [];
  if (init.some((c) => /vp-linux\.py/.test(String(c)))) return config;
  init.push(loadCommand(scriptPath), 'vp-kaslr -q');
  return Object.assign({}, config, { initCommands: init });
}

/**
 * Where the debugger should look for sources built elsewhere: vmlinux names
 * /build/linux-oPNunh/linux-5.15.0/arch/arm64/kernel/idle.c (Ubuntu's build
 * machine). Given a local source tree, the longest tail of the path that exists
 * under it gives the mapping { from: '/build/linux-oPNunh/linux-5.15.0', to: localRoot }.
 * exists(path) tells whether a local file exists. null when no tail is found.
 */
function sourceMapping(remotePath, localRoot, exists) {
  const parts = String(remotePath).split('/').filter(Boolean);
  const root = String(localRoot).replace(/\/+$/, '');
  // Longest tail first: the more of the path matches, the surer the match.
  for (let i = 1; i < parts.length; i++) {
    const tail = parts.slice(i).join('/');
    if (exists(`${root}/${tail}`)) return { from: '/' + parts.slice(0, i).join('/'), to: root, file: `${root}/${tail}` };
  }
  return null;
}

/** gdb commands for a source map { from: to }: set substitute-path, one per entry. */
const substituteCommands = (map) => Object.entries(map || {})
  .filter(([from, to]) => from && to)
  .map(([from, to]) => `set substitute-path ${JSON.stringify(from)} ${JSON.stringify(to)}`);

/** A debug configuration with the source map applied when gdb starts (not twice). */
function withSourceMap(config, map) {
  const cmds = substituteCommands(map);
  if (!cmds.length) return config;
  const init = Array.isArray(config.initCommands) ? config.initCommands.slice() : [];
  for (const c of cmds) if (!init.includes(c)) init.push(c);
  return Object.assign({}, config, { initCommands: init });
}

/** body.result of a CDT evaluate of an MI command: the MI result object, or {} for none. */
function parseResult(body) {
  const r = body && body.result;
  if (typeof r !== 'string' || r === '\r' || r === '') return {};
  try {
    return JSON.parse(r);
  } catch (e) {
    throw new Error(`unexpected answer from the debugger: ${r.slice(0, 200)}`);
  }
}

/** Whether an error from the debugger means the script is not loaded in this gdb. */
const notLoaded = (message) => /Undefined MI command|undefined command/i.test(String(message || ''));

const num = (v) => (v === undefined || v === null || v === '' ? -1 : Number(v));
const flag = (v) => v === true || v === '1' || v === 'true';

/** -vp-ps -t result (MI values are strings) as numbers and booleans. */
function normalizePs(r) {
  const processes = (r.processes || []).map((p) => ({
    pid: num(p.pid), tgid: num(p.tgid), ppid: num(p.ppid), uid: num(p.uid),
    state: String(p.state || '?'), cpu: num(p.cpu), running: num(p.running),
    kernel: flag(p.kernel), comm: String(p.comm || ''), task: String(p.task || ''),
  }));
  const cpus = (r.cpus || []).map((c) => ({ cpu: num(c.cpu), pid: num(c.pid), comm: String(c.comm || ''), idle: flag(c.idle) }));
  return { processes, cpus };
}

const STATE_NAMES = {
  R: 'running or runnable', S: 'sleeping', D: 'uninterruptible sleep', I: 'idle (kernel thread)',
  T: 'stopped', t: 'traced', Z: 'zombie', X: 'dead', W: 'waking', P: 'parked', '?': 'unknown',
};

/**
 * The processes as a tree: each process under its parent (the kernel's
 * threads under kthreadd, as in pstree), its other threads first.
 * Returns { roots: [node], cpus, count: {processes, threads, kernel} },
 * node = { proc, threads: [proc], children: [node] }.
 */
function processTree(ps) {
  const { processes, cpus } = ps;
  const leaders = processes.filter((p) => p.pid === p.tgid);
  const threads = processes.filter((p) => p.pid !== p.tgid);
  const byPid = new Map(leaders.map((p) => [p.pid, { proc: p, threads: [], children: [] }]));
  for (const t of threads) {
    const n = byPid.get(t.tgid);
    if (n) n.threads.push(t);
  }
  const roots = [];
  for (const n of byPid.values()) {
    const parent = n.proc.pid !== n.proc.ppid && byPid.get(n.proc.ppid);
    if (parent) parent.children.push(n); else roots.push(n);
  }
  const byNumber = (a, b) => a.proc.pid - b.proc.pid;
  const sort = (list) => { list.sort(byNumber); for (const n of list) { n.threads.sort((a, b) => a.pid - b.pid); sort(n.children); } };
  sort(roots);
  return {
    roots, cpus,
    count: { processes: leaders.length, threads: threads.length, kernel: leaders.filter((p) => p.kernel).length },
  };
}

/** Tree label and description of a process or thread. */
function procLabel(p, isThread) {
  const name = p.kernel ? `[${p.comm}]` : p.comm;
  const parts = [`${isThread ? 'tid' : 'pid'} ${p.pid}`, p.state];
  if (p.running >= 0) parts.push(`running on cpu ${p.running}`);
  else if (p.cpu >= 0) parts.push(`cpu ${p.cpu}`);
  return { label: name, description: parts.join(' · ') };
}

/** Tooltip lines of a process or thread. */
function procTooltip(p, isThread) {
  return [
    `${p.kernel ? 'Kernel thread' : isThread ? 'Thread' : 'Process'} ${p.comm}`,
    `${isThread ? 'TID' : 'PID'} ${p.pid}${isThread ? `, process ${p.tgid}` : ''}, parent ${p.ppid}${p.uid >= 0 ? `, uid ${p.uid}` : ''}`,
    `State ${p.state}: ${STATE_NAMES[p.state] || 'unknown'}`,
    p.running >= 0 ? `Running on cpu ${p.running} now` : `Last ran on cpu ${p.cpu}`,
    `task_struct at ${p.task}`,
  ].join('\n');
}

/** Label of a CPU row. */
const cpuLabel = (c) => ({ label: `cpu ${c.cpu}`, description: c.idle ? 'idle' : `${c.comm} (pid ${c.pid})` });

/** -vp-dmesg result as dmesg prints it: "[    1.234567] text", one line per text line. */
function formatDmesg(r) {
  const out = [];
  for (const rec of r.records || []) {
    const ns = BigInt(rec.ts || 0);
    const ts = `[${String(ns / 1000000000n).padStart(5)}.${String((ns % 1000000000n) / 1000n).padStart(6, '0')}]`;
    for (const line of String(rec.text || '').split('\n')) out.push(`${ts} ${line}`);
  }
  return out.join('\n') + (out.length ? '\n' : '');
}

module.exports = {
  SCRIPT_VERSION, evaluateArgs, loadCommand, sourceCommand, withLinuxAwareness, sourceMapping, substituteCommands, withSourceMap, parseResult, notLoaded, normalizePs, processTree,
  procLabel, procTooltip, cpuLabel, formatDmesg, STATE_NAMES,
};
