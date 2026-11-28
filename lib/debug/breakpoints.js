'use strict';
// Conditional function breakpoints. The CDT GDB adapter (cdt-gdb-vscode 3.0.0)
// drops the condition and hit count of *function* breakpoints, but honours them
// on *source line* breakpoints, even for files that are not on this machine.
// So VP Studio looks the function up in gdb (-symbol-info-functions), asks gdb
// where `break <function>` would stop in its own code (entryLine) and sets a
// source line breakpoint there. No VS Code dependency.

const NAME = /^[A-Za-z_][A-Za-z0-9_.$]*$/;

/** gdb MI command listing functions named exactly `name` (with debug info). */
function symbolCommand(name) {
  if (!NAME.test(String(name || ''))) throw new Error(`not a function name: ${name}`);
  return `-symbol-info-functions --name ^${name.replace(/[.$]/g, (c) => '\\' + c)}$`;
}

/**
 * The places `name` is defined, from the -symbol-info-functions result:
 * [{ file, line }] (file is gdb's full name, after set substitute-path).
 */
function functionLocations(result, name) {
  const out = [];
  const debug = result && result.symbols && Array.isArray(result.symbols.debug) ? result.symbols.debug : [];
  for (const f of debug) {
    for (const sym of f.symbols || []) {
      const line = parseInt(sym.line, 10);
      if (sym.name !== name || !(line > 0)) continue;
      const file = f.fullname || f.filename;
      if (file && !out.some((o) => o.file === file && o.line === line)) out.push({ file, line });
    }
  }
  return out;
}

/**
 * A hit count as the CDT adapter understands it (it maps it to gdb's ignore
 * count): '' for none, 'N' (stop once, on the Nth hit; the breakpoint is then
 * removed in gdb) or '>N' (stop on every hit after the Nth). '>=N' and '==N'
 * are accepted and rewritten. Throws on anything else.
 */
function normalizeHitCount(text) {
  const s = String(text === undefined || text === null ? '' : text).trim();
  if (!s) return '';
  let m = /^(?:==?\s*)?(\d+)$/.exec(s);
  if (m && parseInt(m[1], 10) >= 1) return String(parseInt(m[1], 10));
  m = /^>\s*(\d+)$/.exec(s);
  if (m) return '>' + parseInt(m[1], 10);
  m = /^>=\s*(\d+)$/.exec(s);
  if (m && parseInt(m[1], 10) >= 1) return '>' + (parseInt(m[1], 10) - 1);
  throw new Error('use a number N (stop once, on the Nth hit) or >N (every hit after the Nth)');
}

/** One line for a message: "update_process_times (timer.c:2012) if user_tick == 0, hit count >5". */
function describe(name, loc, condition, hit) {
  const base = String(loc.file).split(/[\\/]/).pop();
  const parts = [`${name} (${base}:${loc.line})`];
  if (condition) parts.push(`if ${condition}`);
  if (hit) parts.push(`hit count ${hit}`);
  return parts.join(', ');
}

/** The address in a -data-evaluate-expression answer for &function ("(void (*)(int)) 0xffff… <name>"). */
function functionAddress(result) {
  const m = /0x[0-9a-f]+/i.exec(String((result && result.value) || ''));
  return m ? BigInt(m[0]) : undefined;
}

/**
 * The line gdb itself stops at for `break <function>`, from the answer of
 * -break-insert -d <function>: the location just past the start of the
 * function's own (out-of-line) code at `address`, not a copy inlined into a
 * caller. The declaration line that -symbol-info-functions gives can resolve
 * to inlined copies only (Linux's arm64_force_sig_fault: line 265 is two
 * inlined copies, the body that do_page_fault calls is at line 267).
 * Returns { file, line } or undefined.
 */
function entryLine(result, address) {
  const b = result && result.bkpt;
  if (!b || address === undefined) return undefined;
  const one = (x) => (x && /^0x[0-9a-f]+$/i.test(String(x.addr)) && x.line ? [{ address: BigInt(x.addr), file: x.fullname || x.file, line: Number(x.line) }] : []);
  // CDT's MI parser gives a breakpoint with several locations as an array: the breakpoint, then its locations.
  const all = Array.isArray(b) ? b.slice(1).flatMap(one)
    : Array.isArray(b.locations) && b.locations.length ? b.locations.flatMap(one)
      : Array.isArray(result.locations) ? result.locations.flatMap(one) : one(b);
  const near = all.filter((l) => l.address >= address && l.address - address < 0x100n).sort((x, y) => (x.address < y.address ? -1 : 1));
  return near.length ? { file: near[0].file, line: near[0].line } : undefined;
}

/** The number of the breakpoint in a -break-insert answer (one location or several). */
function breakpointNumber(result) {
  const b = result && result.bkpt;
  const head = Array.isArray(b) ? b[0] : b;
  return head && head.number ? String(head.number) : undefined;
}

module.exports = { symbolCommand, functionLocations, functionAddress, entryLine, breakpointNumber, normalizeHitCount, describe };
