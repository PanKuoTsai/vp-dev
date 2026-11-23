'use strict';
// Debug Layout: source on the left, Disassembly above Memory on the right, with
// the Run and Debug side bar. The panes are VS Code's own Disassembly View and
// Eclipse CDT's Memory Inspector tabs. No VS Code dependency.

/** Argument for the vscode.setEditorLayout command: group 1 left, 2 top right, 3 bottom right. */
const EDITOR_LAYOUT = { orientation: 0, groups: [{ size: 0.5 }, { size: 0.5, groups: [{ size: 0.55 }, { size: 0.45 }] }] };

/** VS Code command that opens the Disassembly View at the focused frame's instruction pointer. */
const DISASSEMBLY_COMMAND = 'debug.action.openDisassemblyView';

const isDisassemblyTab = (label) => /^Disassembly$/i.test(String(label || '').trim());
const isMemoryTab = (label) => /^Memory \d+$/.test(String(label || '').trim());

/**
 * Which panes still have to be opened, given the labels of the open editor tabs:
 * { disassembly: bool, memory: bool }. An open pane is reused, not opened twice.
 */
function missingPanes(tabLabels) {
  const labels = tabLabels || [];
  return { disassembly: !labels.some(isDisassemblyTab), memory: !labels.some(isMemoryTab) };
}

/**
 * VS Code's Disassembly View mixes in source lines by default; with the CDT GDB
 * adapter and the Linux kernel the instructions then come out of address order,
 * with repeats (seen with cdt-gdb-vscode 3.0.0). Offer to turn the source lines
 * off, but only when nobody has set the option: `inspect` is
 * WorkspaceConfiguration.inspect('debug.disassemblyView.showSourceCode').
 */
const SOURCE_SETTING = 'debug.disassemblyView.showSourceCode';
function offerPlainDisassembly(inspect) {
  if (!inspect) return true;
  return ['globalValue', 'workspaceValue', 'workspaceFolderValue'].every((k) => inspect[k] === undefined);
}

module.exports = { EDITOR_LAYOUT, DISASSEMBLY_COMMAND, SOURCE_SETTING, isDisassemblyTab, isMemoryTab, missingPanes, offerPlainDisassembly };
