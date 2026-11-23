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

// Memory Inspector shows bytes in groups: bytesPerMAU bytes make an addressable unit, MAUsPerGroup
// units a group (here: a word, its value in the target's byte order) and groupsPerRow groups a row.
// Its own default is one byte per group and 4 groups per row (4 bytes a row); VP Studio's
// configurationDefaults (package.json) make that 4 words of 4 bytes.
const SECTION = 'memory-inspector';
const KEYS = { mau: 'groupings.bytesPerMAU', group: 'groupings.MAUsPerGroup', row: 'groupings.groupsPerRow' };
const DEFAULT_LAYOUT = { wordBytes: 4, wordsPerRow: 4 };
const WORD_SIZES = [1, 2, 4, 8, 16];
const ROW_CHOICES = [1, 2, 4, 8, 16, 32, 'Autofit'];

/** Memory Inspector's settings (keys under "memory-inspector.") for words of wordBytes bytes, wordsPerRow to a row. */
function layoutSettings(wordBytes, wordsPerRow) {
  if (!WORD_SIZES.includes(Number(wordBytes))) throw new Error(`word size ${wordBytes}: one of ${WORD_SIZES.join(', ')} bytes`);
  if (!ROW_CHOICES.includes(wordsPerRow)) throw new Error(`words per row ${wordsPerRow}: one of ${ROW_CHOICES.join(', ')}`);
  return { [KEYS.mau]: 1, [KEYS.group]: Number(wordBytes), [KEYS.row]: wordsPerRow };
}

/** The layout those settings give: { wordBytes, wordsPerRow, text }. */
function describeLayout(bytesPerMAU, mausPerGroup, groupsPerRow) {
  const wordBytes = Number(bytesPerMAU || 1) * Number(mausPerGroup || 1);
  const perRow = groupsPerRow === 'Autofit' ? 'Autofit' : Number(groupsPerRow || 4);
  const unit = wordBytes === 1 ? 'byte' : `${wordBytes * 8}-bit word`;
  const text = perRow === 'Autofit' ? `${unit}s, as many as fit in a row` : `${perRow} ${unit}${perRow === 1 ? '' : 's'} per row (${perRow * wordBytes} bytes)`;
  return { wordBytes, wordsPerRow: perRow, text };
}

module.exports = {
  EXTENSION_ID, GO_TO_COMMAND, SHOW_COMMAND, DEBUG_TYPES, normalize, looksLikeAddress, goToArgs,
  SECTION, KEYS, DEFAULT_LAYOUT, WORD_SIZES, ROW_CHOICES, layoutSettings, describeLayout,
};
