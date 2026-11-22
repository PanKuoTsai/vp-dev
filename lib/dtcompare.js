'use strict';
// Device tree preview and comparison for the platform view: a line diff, and
// dtc round trips that put two device trees in the same form (sorted nodes and
// properties, numbers as dtc prints them) so only real differences remain.
// Uses child_process and fs, not VS Code.

const fs = require('fs');
const { spawn } = require('child_process');

/** Whether a file is a flattened device tree (magic 0xd00dfeed, big-endian). */
function isFdt(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(4);
      return fs.readSync(fd, b, 0, 4, 0) === 4 && b.readUInt32BE(0) === 0xd00dfeed;
    } finally { fs.closeSync(fd); }
  } catch (e) { return false; }
}

const MAX_CELLS = 16e6; // lines(a) × lines(b) left after the common ends; beyond it, no line diff

/**
 * Line diff of old text a and new text b: [{ op: ' ' | '-' | '+', text, a, b }]
 * (a, b: 1-based line numbers in each side, null where the line is absent).
 * The common start and end are matched first; the middle by longest common
 * subsequence. Returns null when the middle is too large to compare.
 */
function diffLines(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  if (A.length && A[A.length - 1] === '') A.pop();
  if (B.length && B[B.length - 1] === '') B.pop();
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a0 = A.slice(pre, A.length - suf), b0 = B.slice(pre, B.length - suf);
  const n = a0.length, m = b0.length;
  if (n * m > MAX_CELLS) return null;
  // lcs[i][j] = LCS length of a0[i..] and b0[j..], one row per i.
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a0[i] === b0[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out = [];
  let la = 1, lb = 1;
  const same = (t) => out.push({ op: ' ', text: t, a: la++, b: lb++ });
  for (let k = 0; k < pre; k++) same(A[k]);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a0[i] === b0[j]) { same(a0[i]); i++; j++; }
    // Removed lines before added ones, as diff tools show a change.
    else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) { out.push({ op: '-', text: a0[i], a: la++, b: null }); i++; }
    else { out.push({ op: '+', text: b0[j], a: null, b: lb++ }); j++; }
  }
  for (let k = A.length - suf; k < A.length; k++) same(A[k]);
  return out;
}

/**
 * The changed parts of a diff with `context` unchanged lines around each:
 * [{ lines: [...diff entries] } | { skip: count }], plus { added, removed }.
 */
function hunks(ops, context = 3) {
  const keep = new Uint8Array(ops.length);
  ops.forEach((o, k) => {
    if (o.op === ' ') return;
    for (let d = Math.max(0, k - context); d <= Math.min(ops.length - 1, k + context); d++) keep[d] = 1;
  });
  const parts = [];
  let cur = null, skip = 0;
  ops.forEach((o, k) => {
    if (keep[k]) {
      if (skip) { parts.push({ skip }); skip = 0; }
      if (!cur) { cur = { lines: [] }; parts.push(cur); }
      cur.lines.push(o);
    } else { cur = null; skip++; }
  });
  if (skip) parts.push({ skip });
  return { parts, added: ops.filter((o) => o.op === '+').length, removed: ops.filter((o) => o.op === '-').length };
}

/**
 * Run dtc with input on stdin; resolves stdout as a Buffer. dtc is a command,
 * or a function (args, input) => Promise<Buffer> that runs it elsewhere (on the
 * simulation host, for VS Code on Windows).
 */
function runDtc(dtc, args, input) {
  if (typeof dtc === 'function') return Promise.resolve(dtc(args, input));
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(dtc, args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { reject(e); return; }
    const out = [], err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => reject(e.code === 'ENOENT'
      ? new Error(`${dtc} not found; install the device tree compiler (Ubuntu: apt install device-tree-compiler) or set "vpStudio.dtc"`)
      : e));
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`dtc: ${Buffer.concat(err).toString().trim() || `exit ${code}`}`))));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

// Properties whose value is a list of single phandles (no argument cells).
const PHANDLE_PROPS = new Set(['interrupt-parent', 'msi-parent', 'cpu', 'next-level-cache', 'memory-region', 'cpu-idle-states']);

/**
 * Replace phandle numbers, which differ between two trees built separately,
 * by the path of the node they name: the "phandle" lines go, and properties
 * that hold only phandles (interrupt-parent = <0x01>) become <&/path>.
 * Phandles inside longer cell lists (interrupt-map, clocks with arguments) stay numbers.
 * text: dtc's DTS output (one node or property per line).
 */
function symbolizePhandles(text) {
  const lines = text.split('\n');
  const paths = new Map();
  const stack = [];
  for (const l of lines) {
    const t = l.trim();
    const open = /^([^\s=]+)\s*\{$/.exec(t);
    if (open) { stack.push(open[1] === '/' ? '' : open[1]); continue; }
    if (t === '};') { stack.pop(); continue; }
    const ph = /^(?:linux,)?phandle = <(0x[0-9a-f]+)>;$/.exec(t);
    if (ph) paths.set(BigInt(ph[1]), stack.join('/') || '/');
  }
  const name = (n) => { const p = paths.get(BigInt(n)); return p ? `&${p}` : n; };
  return lines.filter((l) => !/^\s*(?:linux,)?phandle = <0x[0-9a-f]+>;$/.test(l)).map((l) => {
    const m = /^(\s*)([\w,#.+-]+) = <((?:0x[0-9a-f]+\s*)+)>;$/.exec(l);
    if (!m || !PHANDLE_PROPS.has(m[2])) return l;
    return `${m[1]}${m[2]} = <${m[3].trim().split(/\s+/).map(name).join(' ')}>;`;
  }).join('\n');
}

/**
 * A device tree in the form dtc prints a compiled tree, nodes and properties
 * sorted: DTS text -> DTB -> DTS, or DTB bytes -> DTS. Labels and comments
 * disappear on both sides alike, and phandles are named by path (symbolizePhandles).
 */
async function normalize(dtc, input, kind) {
  const blob = kind === 'dts' ? await runDtc(dtc, ['-q', '-I', 'dts', '-O', 'dtb', '-o', '-', '-'], input) : input;
  return symbolizePhandles((await runDtc(dtc, ['-q', '-s', '-I', 'dtb', '-O', 'dts', '-o', '-', '-'], blob)).toString('utf8'));
}

/**
 * Compare the device tree generated from the platform with another one.
 * against: { kind: 'dts', file } (a DTS written earlier by VP Studio, compared
 * as text) or { kind: 'dtb', file } (a compiled tree, both sides normalized
 * with dtc). Old side = the file, new side = what the platform generates now.
 */
async function compare(generated, against, dtc = 'dtc') {
  if (against.kind === 'dts') {
    const old = fs.readFileSync(against.file, 'utf8');
    return { ops: diffLines(old, generated), normalized: false };
  }
  const [old, now] = await Promise.all([normalize(dtc, fs.readFileSync(against.file), 'dtb'), normalize(dtc, generated, 'dts')]);
  return { ops: diffLines(old, now), normalized: true };
}

module.exports = { isFdt, diffLines, hunks, runDtc, normalize, compare, symbolizePhandles };
