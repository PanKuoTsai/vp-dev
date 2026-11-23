'use strict';
// Function trace (G-05, second layer): the sim agent's call and return
// records (ftrace.save) turned into function slices per CPU, a Perfetto /
// Chrome trace file and a per-function summary. No VS Code dependency.
//
// File written by the agent ("VPFTRC01"): u32 version (1), u32 CPUs; per CPU
// u32 cpu, u32 0, u64 total, u64 stored, then `stored` records of four u64:
// branch address | kind (1 call, 2 return), target, host ns, instructions the
// vCPU had executed. Little-endian, oldest first.

const fs = require('fs');
const elfsym = require('./elfsym');

const MAGIC = 'VPFTRC01';
const MIN_AGENT = '0.11.0'; // the agent version with ftrace.*
const CALL = 1;
const RET = 2;
const KERNEL_BASE = 0xffff000000000000n;
const MAX_DEPTH = 512;
// Returning from these switches stacks: the frames open before belong to
// another task (Linux arm64).
const SWITCH_FUNCTIONS = new Set(['cpu_switch_to']);

/** Parse a trace file's bytes: { cpus: [{cpu, total, events: [{kind, from, to, ns, insns}]}] }. */
function parse(buf) {
  if (buf.length < 16 || buf.toString('latin1', 0, 8) !== MAGIC) throw new Error('not a VP Studio function trace (VPFTRC01)');
  const version = buf.readUInt32LE(8);
  if (version !== 1) throw new Error(`function trace version ${version} is not supported`);
  const n = buf.readUInt32LE(12);
  let o = 16;
  const cpus = [];
  for (let k = 0; k < n; k++) {
    if (o + 24 > buf.length) throw new Error('truncated function trace');
    const cpu = buf.readUInt32LE(o);
    const total = Number(buf.readBigUInt64LE(o + 8));
    const stored = Number(buf.readBigUInt64LE(o + 16));
    o += 24;
    if (o + stored * 32 > buf.length) throw new Error('truncated function trace');
    const events = new Array(stored);
    for (let i = 0; i < stored; i++, o += 32) {
      const fk = buf.readBigUInt64LE(o);
      events[i] = {
        kind: Number(fk & 3n),
        from: fk & ~3n,
        to: buf.readBigUInt64LE(o + 8),
        ns: Number(buf.readBigUInt64LE(o + 16)),
        insns: Number(buf.readBigUInt64LE(o + 24)),
      };
    }
    cpus.push({ cpu, total, events });
  }
  return { cpus };
}

const hex = (v) => '0x' + v.toString(16);

/**
 * A namer for addresses: kernel addresses through the symbol file's
 * functions (shifted by the KASLR offset), kernel addresses outside it as
 * "module 0x...", others as "user 0x...".
 * Returns (addr: BigInt) => { name, start: BigInt|undefined }.
 */
function namer(functions = [], offset = 0n) {
  const cache = new Map();
  // Kernel addresses outside the symbol file's range: loadable modules, BPF.
  const lo = functions.length ? functions[0].start : undefined;
  const last = functions[functions.length - 1];
  const hi = last ? last.start + (last.size || 0x10000n) : undefined;
  return (addr) => {
    let r = cache.get(addr);
    if (r) return r;
    if (addr < KERNEL_BASE) r = { name: `user ${hex(addr)}`, user: true };
    else {
      const a = addr - offset;
      const f = functions.length ? elfsym.lookup(functions, a) : undefined;
      if (f) r = { name: f.name, start: f.start + offset };
      else r = { name: lo !== undefined && (a < lo || a >= hi) ? `module ${hex(addr)}` : hex(addr) };
    }
    cache.set(addr, r);
    return r;
  };
}

/**
 * KASLR offset guessed from the trace alone: call targets are function
 * starts, and arm64 moves the kernel in 2 MiB steps, so the offset that makes
 * the most frequent targets land on a function start wins. 0n when nothing
 * matches better than no offset.
 */
function guessOffset(trace, functions) {
  if (!functions.length) return 0n;
  const counts = new Map();
  for (const c of trace.cpus) for (const e of c.events) if (e.kind === CALL && e.to >= KERNEL_BASE) counts.set(e.to, (counts.get(e.to) || 0) + 1);
  const targets = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 200);
  const byLow = new Map(); // low 21 bits -> function starts
  for (const f of functions) {
    const low = f.start & 0x1fffffn;
    if (!byLow.has(low)) byLow.set(low, []);
    byLow.get(low).push(f.start);
  }
  const votes = new Map();
  for (const [t, n] of targets) {
    for (const s of byLow.get(t & 0x1fffffn) || []) {
      const off = t - s;
      votes.set(off, (votes.get(off) || 0) + n);
    }
  }
  let best = 0n;
  let bestVotes = votes.get(0n) || 0;
  for (const [off, v] of votes) if (v > bestVotes) { best = off; bestVotes = v; }
  return best;
}

/** Whether a return from `from` leaves the function of frame f: the same symbol, or close after an unnamed target. */
function returnsFrom(f, from, name) {
  const n = name(from);
  if (f.start !== undefined && n.start !== undefined) return n.start === f.start;
  return from >= f.target && from - f.target < 0x1000n;
}

/**
 * Match returns to calls, per CPU. Calls open a frame expecting a return to
 * the instruction after the call; a return closes the newest frame waiting
 * for its target and every frame above it (tail calls, longjmp). A return no
 * frame waits for began before the recording, or after a stack switch, and
 * is counted as unmatched; but one out of the newest frame's own function
 * ends that frame (code that calls with BL and returns elsewhere). Returning from cpu_switch_to (to another task)
 * closes every frame, marked open: that task is suspended, not finished.
 *
 * Returns { cpus: [{cpu, slices: [{name, start, end, depth, insns, self, open}], unmatched, switches}],
 *   start, end, functions: Map name -> {calls, insns, self, ns} }.
 * start/end: ns; insns: instructions inside the frame; self: without callees.
 */
function build(trace, { functions = [], offset = 0n } = {}) {
  const name = namer(functions, offset);
  const totals = new Map();
  let start = Infinity;
  let end = -Infinity;
  const out = [];
  for (const c of trace.cpus) {
    const ev = c.events;
    const slices = [];
    const stack = [];
    let unmatched = 0;
    let switches = 0;
    const close = (f, ns, insns, open) => {
      const total = Math.max(0, insns - f.insns);
      const s = { name: f.name, start: f.ns, end: Math.max(ns, f.ns), depth: f.depth, insns: total, self: Math.max(0, total - f.child), open };
      slices.push(s);
      const t = totals.get(s.name) || { calls: 0, insns: 0, self: 0, ns: 0, user: !!f.user };
      t.calls++; t.self += s.self; t.ns += s.end - s.start;
      // A recursive function counts its outermost frame only, for inclusive figures.
      if (!stack.some((g) => g.name === f.name)) t.insns += total;
      totals.set(s.name, t);
      if (stack.length) stack[stack.length - 1].child += total;
    };
    for (const e of ev) {
      if (e.ns < start) start = e.ns;
      if (e.ns > end) end = e.ns;
      if (e.kind === CALL) {
        if (stack.length >= MAX_DEPTH) stack.shift(); // runaway: drop the oldest frame, unrecorded
        const n = name(e.to);
        stack.push({ name: n.name, user: n.user, start: n.start, target: e.to, ret: e.from + 4n, ns: e.ns, insns: e.insns, depth: stack.length, child: 0 });
      } else if (e.kind === RET) {
        // First: every task switches in the same code, so the return out of
        // the switch lands on the same address in the next task, and would
        // look like an ordinary return.
        if (SWITCH_FUNCTIONS.has(name(e.from).name)) {
          switches++;
          while (stack.length) close(stack.pop(), e.ns, e.insns, true);
          continue;
        }
        const find = () => { let i = stack.length - 1; while (i >= 0 && stack[i].ret !== e.to) i--; return i; };
        let i = find();
        if (i < 0 && stack.length && returnsFrom(stack[stack.length - 1], e.from, name)) {
          // The newest frame's function returned, but not to its caller's
          // next instruction: JIT code and trampolines "call" with BL to get
          // a return address they then replace. The frame ends here anyway.
          close(stack.pop(), e.ns, e.insns, false);
          i = find();
          if (i < 0) continue;
        }
        if (i >= 0) {
          while (stack.length > i) close(stack.pop(), e.ns, e.insns, false);
        } else {
          unmatched++;
        }
      }
    }
    const last = ev.length ? ev[ev.length - 1] : undefined;
    while (stack.length) close(stack.pop(), last.ns, last.insns, true);
    slices.sort((a, b) => a.start - b.start || a.depth - b.depth);
    out.push({ cpu: c.cpu, total: c.total, recorded: ev.length, slices, unmatched, switches });
  }
  return { cpus: out, start: start === Infinity ? 0 : start, end: end === -Infinity ? 0 : end, functions: totals };
}

/**
 * Write a Chrome trace event file (opens in ui.perfetto.dev and
 * chrome://tracing): one thread per CPU, a complete event ("X") per slice,
 * times in µs from the first record. Written in pieces: traces are large.
 * CPU n is thread n + 1: Perfetto treats tid 0 as the idle thread and puts its
 * events on another thread's track (CPU 0 ended up on CPU 1's track, with
 * thousands of "overlapping complete event" errors). The pid differs from
 * every tid so that no CPU is shown as the "main thread".
 */
function writeChromeTrace(file, built, { title = 'guest', note } = {}) {
  const fd = fs.openSync(file, 'w');
  let pending = '';
  const put = (s) => {
    pending += s;
    if (pending.length > 1 << 20) { fs.writeSync(fd, pending); pending = ''; }
  };
  const us = (ns) => +((ns - built.start) / 1000).toFixed(3);
  const PID = 1000;
  const tid = (cpu) => cpu + 1;
  try {
    put('{"displayTimeUnit":"ns","otherData":');
    put(JSON.stringify({ source: 'VP Studio function trace', time: 'host time while simulating', note: note || '' }));
    put(',"traceEvents":[\n');
    put(JSON.stringify({ ph: 'M', name: 'process_name', pid: PID, args: { name: title } }));
    for (const c of built.cpus) {
      put(',\n' + JSON.stringify({ ph: 'M', name: 'thread_name', pid: PID, tid: tid(c.cpu), args: { name: `cpu ${c.cpu}` } }));
      put(',\n' + JSON.stringify({ ph: 'M', name: 'thread_sort_index', pid: PID, tid: tid(c.cpu), args: { sort_index: c.cpu } }));
      for (const s of c.slices) {
        const args = s.open ? { insns: s.insns, self: s.self, open: true } : { insns: s.insns, self: s.self };
        // the duration is taken from the rounded ends, so a callee never ends after its caller
        const ts = us(s.start);
        put(',\n' + JSON.stringify({ ph: 'X', name: s.name, pid: PID, tid: tid(c.cpu), ts, dur: +(us(s.end) - ts).toFixed(3), args }));
      }
    }
    put('\n]}\n');
    fs.writeSync(fd, pending);
  } finally {
    fs.closeSync(fd);
  }
}

/** The functions with the most instructions of their own: [{name, calls, insns, self, ns, share}]. */
function topFunctions(built, limit = 50) {
  let all = 0;
  for (const t of built.functions.values()) all += t.self;
  return [...built.functions].map(([name, t]) => Object.assign({ name, share: all ? t.self / all : 0 }, t))
    .sort((a, b) => b.self - a.self).slice(0, limit);
}

const num = (n) => n.toLocaleString('en-US');

/** A Markdown summary of a built trace. */
function summary(built, { title = 'Function trace', symbolFile, offset = 0n, traceFile, jsonFile, limit = 50 } = {}) {
  const lines = [`# ${title}`, ''];
  const secs = (built.end - built.start) / 1e9;
  const recorded = built.cpus.reduce((s, c) => s + c.recorded, 0);
  lines.push(`${num(recorded)} calls and returns on ${built.cpus.length} CPU${built.cpus.length === 1 ? '' : 's'} over ${secs.toFixed(3)} s of host time.`);
  const dropped = built.cpus.filter((c) => c.total > c.recorded);
  if (dropped.length) {
    lines.push('', `The buffer kept only the newest records on ${dropped.map((c) => `cpu ${c.cpu} (${num(c.recorded)} of ${num(c.total)})`).join(', ')}; that CPU's trace starts later than the others. Record a shorter time or raise vpStudio.ftrace.bufferPerCpu.`);
  }
  lines.push('', symbolFile ? `Symbols: \`${symbolFile}\`${offset ? ` (KASLR offset ${hex(offset)})` : ''}.` : 'No symbol file: kernel functions are shown by address.');
  if (jsonFile) lines.push('', `Timeline: \`${jsonFile}\`. Open it in [Perfetto UI](https://ui.perfetto.dev) (Open trace file; the file stays on this computer).`);
  lines.push('', '## Functions by own instructions', '',
    '| Function | Calls | Own instructions | Share | With callees |', '|---|---:|---:|---:|---:|');
  for (const f of topFunctions(built, limit)) {
    lines.push(`| \`${f.name}\` | ${num(f.calls)} | ${num(f.self)} | ${(f.share * 100).toFixed(1)}% | ${num(f.insns)} |`);
  }
  lines.push('', '## CPUs', '', '| CPU | Records | Slices | Unmatched returns | Stack switches |', '|---:|---:|---:|---:|---:|');
  for (const c of built.cpus) lines.push(`| ${c.cpu} | ${num(c.recorded)} | ${num(c.slices.length)} | ${num(c.unmatched)} | ${num(c.switches)} |`);
  lines.push('', 'Notes:', '',
    '- Times are host time while simulating, not simulated time; instruction counts are exact.',
    '- A return without a recorded call (the call came before the recording, or on another task\'s stack) is counted as unmatched. Frames still open at the end of the recording are marked `open` in the timeline.',
    '- Tail calls (a plain branch to a function) are not seen; their time counts in the caller.');
  if (traceFile) lines.push(`- Raw records: \`${traceFile}\`.`);
  return lines.join('\n') + '\n';
}

/** ftrace.tail's answer (agent 0.15.0) as events: [{kind, from, to, ns, insns}], oldest first. */
function tailEvents(res) {
  return ((res && res.records) || []).map(([fk, to, ns, insns]) => {
    const v = BigInt(fk);
    return { kind: Number(v & 3n), from: v & ~3n, to: BigInt(to), ns: Number(ns), insns: Number(insns) };
  });
}

/**
 * The calls and returns a CPU made last, for reading: rows oldest first with an indentation depth
 * (calls open a level, a return closes the frame waiting for its address and those above it),
 * and the frames still open at the end, outermost first: a call chain at the moment of the stop.
 * name: (addr) => {name, start} as from namer().
 * Taking an exception right after a call shows as a call into the vector table, which no return
 * closes (ERET is not a RET): such calls (targets in a 2 KiB table of `vectors`, or into a function
 * named like vectors) become 'exception' rows and open no frame.
 * Returns { rows: [{kind: 'call'|'ret'|'exception', depth, name, site, insnsBefore}], open: [name], lastInsns }.
 */
function recentCalls(events, name, { vectors = [] } = {}) {
  const tables = new Set(vectors.map((v) => BigInt(v) & ~0x7ffn));
  const isVector = (to) => tables.has(to & ~0x7ffn) || /(^|_)vectors$/.test(name(to).name);
  const rows = [];
  const stack = [];
  let depth = 0;
  const lastInsns = events.length ? events[events.length - 1].insns : 0;
  for (const e of events) {
    if (e.kind === CALL && isVector(e.to)) {
      rows.push({ kind: 'exception', depth, name: name(e.to).name, site: name(e.from).name, insnsBefore: lastInsns - e.insns });
    } else if (e.kind === CALL) {
      rows.push({ kind: 'call', depth, name: name(e.to).name, site: name(e.from).name, insnsBefore: lastInsns - e.insns });
      stack.push({ ret: e.from + 4n, name: name(e.to).name, depth });
      depth++;
    } else if (e.kind === RET) {
      let i = stack.length - 1;
      while (i >= 0 && stack[i].ret !== e.to) i--;
      if (i >= 0) { depth = stack[i].depth; stack.length = i; } else depth--;
      rows.push({ kind: 'ret', depth, name: name(e.from).name, site: name(e.to).name, insnsBefore: lastInsns - e.insns });
    }
  }
  const min = rows.reduce((m, r) => Math.min(m, r.depth), 0);
  for (const r of rows) r.depth -= min;
  return { rows, open: stack.map((f) => f.name), lastInsns };
}

module.exports = { parse, build, namer, guessOffset, writeChromeTrace, topFunctions, summary, tailEvents, recentCalls, CALL, RET, KERNEL_BASE, MAGIC, MIN_AGENT };
