'use strict';
// Jump to Cursor for the target debugger: the CDT adapter has no "goto", so
// VP Studio moves the PC itself. A temporary breakpoint goes on the target
// address, and gdb's jump resumes there with only the selected CPU allowed to
// run (scheduler-locking on): the CPU stops at once on that breakpoint, which
// gives the debugger a normal stop to show. No VS Code dependency.

const path = require('path');

/**
 * gdb locations to try for a line of a local file, best first: the file
 * through the source map (local folder back to the build path), the local
 * path itself, then shorter and shorter path suffixes ("kernel/time/timer.c",
 * "timer.c"), which gdb matches against the end of its file names.
 * sourceMap: { buildPath: localPath } (vpStudio.debug.sourceMap).
 */
function locationCandidates(localFile, line, sourceMap = {}, { win32 = false } = {}) {
  const p = win32 ? path.win32 : path.posix;
  const norm = (f) => String(f).replace(/\\/g, '/');
  const file = norm(localFile);
  const out = [];
  const add = (f) => { const loc = `${quote(f)}:${Number(line)}`; if (!out.includes(loc)) out.push(loc); };
  for (const [from, to] of Object.entries(sourceMap || {})) {
    const local = norm(to).replace(/\/+$/, '');
    if (local && (file === local || file.startsWith(local + '/'))) add(norm(from).replace(/\/+$/, '') + file.slice(local.length));
  }
  add(file);
  const parts = norm(p.normalize(localFile)).split('/').filter(Boolean);
  for (let k = Math.min(parts.length - 1, 6); k >= 1; k--) add(parts.slice(parts.length - k).join('/'));
  return out;
}

/** A file name for a gdb location: quoted when it has spaces or quotes. */
function quote(f) { return /[\s"']/.test(f) ? `"${f.replace(/(["\\])/g, '\\$1')}"` : f; }

/**
 * Addresses of a -break-insert answer: [{ address: BigInt, func, file, line }]. A breakpoint
 * with several locations (an inlined line, a line in a macro) has them in `locations`.
 */
function breakpointAddresses(result) {
  const b = result && result.bkpt;
  if (!b) return [];
  const one = (x) => (x && /^0x[0-9a-f]+$/i.test(String(x.addr)) ? [{ address: BigInt(x.addr), func: x.func, file: x.file || x.fullname, line: x.line ? Number(x.line) : undefined }] : []);
  if (Array.isArray(b.locations) && b.locations.length) return b.locations.flatMap(one);
  if (Array.isArray(result.locations)) return result.locations.flatMap(one);
  return one(b);
}

/** Which of several addresses to jump to: the one in the function the CPU is in, else none (ask). */
function chooseAddress(addresses, currentFunction) {
  if (addresses.length === 1) return addresses[0];
  const same = addresses.filter((a) => currentFunction && a.func === currentFunction);
  return same.length === 1 ? same[0] : undefined;
}

/** MI commands of the jump, in order (the locking is put back after the stop). */
function jumpCommands(thread, address) {
  const a = '*0x' + BigInt(address).toString(16);
  return [
    '-gdb-set scheduler-locking on',
    `-break-insert -t ${a}`,
    `-exec-jump --thread ${Number(thread)} ${a}`,
  ];
}

module.exports = { locationCandidates, breakpointAddresses, chooseAddress, jumpCommands, quote };
