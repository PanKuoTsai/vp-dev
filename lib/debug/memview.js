'use strict';
// Memory viewing while debugging. VP Studio does not draw its own memory view:
// it opens Eclipse CDT's Memory Inspector (eclipse-cdt.memory-inspector, which
// reads through the debug adapter's readMemory) at an address or expression.
// No VS Code dependency.

const EXTENSION_ID = 'eclipse-cdt.memory-inspector';
/** Memory Inspector command that opens a new memory tab at {value} (its "Go to value" for watch items). */
const GO_TO_COMMAND = 'memory-inspector.go-to-value';
/** Memory Inspector command that opens an empty memory tab. */
const SHOW_COMMAND = 'memory-inspector.show';

/**
 * Clean up what the user typed or what a register holds: trims, drops a gdb
 * value's trailing symbol (`0xffff… <jiffies>`), and lowercases a hex prefix.
 * Anything else (`&jiffies`, `$sp + 16`) is passed on as an expression.
 * Returns '' for an empty input.
 */
function normalize(text) {
  let s = String(text === undefined || text === null ? '' : text).trim();
  const m = /^(0[xX][0-9a-fA-F]+)\s+<[^>]*>$/.exec(s);
  if (m) s = m[1];
  if (/^0[xX][0-9a-fA-F]+$/.test(s)) s = '0x' + s.slice(2).toLowerCase();
  return s;
}

/**
 * Whether a register value is worth offering "show in memory" for: a hex
 * number that is not small (below 0x1000 it is a count or a flag, not an
 * address). Values from the CPU Registers view are hex strings.
 */
function looksLikeAddress(value) {
  const s = normalize(value);
  if (!/^0x[0-9a-f]+$/.test(s)) return false;
  try { return BigInt(s) >= 0x1000n; } catch (e) { return false; }
}

/** The argument for GO_TO_COMMAND: Memory Inspector treats an object with a string `name` as a Watch item and opens its `value`. */
function goToArgs(expression) {
  const value = normalize(expression);
  return { name: value, value };
}

/** Debug types Memory Inspector works with by default that VP Studio uses. */
const DEBUG_TYPES = ['gdbtarget', 'gdb'];

module.exports = { EXTENSION_ID, GO_TO_COMMAND, SHOW_COMMAND, DEBUG_TYPES, normalize, looksLikeAddress, goToArgs };
