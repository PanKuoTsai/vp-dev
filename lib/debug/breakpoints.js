'use strict';
// Conditional function breakpoints. The CDT GDB adapter (cdt-gdb-vscode 3.0.0)
// drops the condition and hit count of *function* breakpoints, but honours them
// on *source line* breakpoints, even for files that are not on this machine.
// So VP Studio looks the function up in gdb (-symbol-info-functions) and sets a
// source line breakpoint at its first line. No VS Code dependency.

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

module.exports = { symbolCommand, functionLocations, normalizeHitCount, describe };
