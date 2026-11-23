'use strict';
// The Peripheral Registers view.
const vscode = require('vscode');
const path = require('path');
const registers = require('../lib/analysis/registers');
const shared = require('./shared');
const common = require('./common');
const modulesTree = require('./modulesTree');

/*
 * Peripheral Registers view. Peripherals of the running platform that a
 * register description covers (registers, wizard models); their
 * registers are read with the agent's mem.read while the simulation is
 * paused (or halted by a debugger), once per pause, when a peripheral is
 * expanded. Registers whose reading changes the device are read only on
 * request.
 */
class RegisterTree {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.stopped = false;
    this.values = new Map(); // "periph id|reg name" -> {value, was?} | {error}; was: its value at the previous stop, when different
    this.previous = new Map(); // "periph id|reg name" -> {value} read at an earlier stop: what "changed" compares with
    this.reading = new Map(); // periph id -> Promise
    this.nodes = new Map(); // stable tree elements, so a register can be revealed
  }
  reset() { this.values.clear(); this.previous.clear(); this.reading.clear(); this.stopped = false; this.emitter.fire(); }
  /** Keep this stop's values as the base for the next stop's changes. */
  keep() {
    for (const [k, v] of this.values) if (v.value !== undefined) this.previous.set(k, { value: v.value });
    this.values.clear(); // values of the last stop are old once it runs again
    this.reading.clear();
  }
  /** A new stop (a debugger stop or a pause): read again, and mark what changed since the last one. */
  newStop() { this.keep(); this.stopped = true; this.emitter.fire(undefined); }
  /** The target runs again. */
  running() { this.keep(); this.stopped = false; this.emitter.fire(undefined); }
  /** Whether registers can be read now, without starting a new stop (a debugger holds the target). */
  setReadable(readable) { if (this.stopped !== readable) { this.stopped = readable; this.emitter.fire(undefined); } }
  /** Kept for callers of the old interface: a pause is a new stop. */
  setStopped(stopped) { if (stopped) this.newStop(); else this.running(); }
  refresh() { this.values.clear(); this.reading.clear(); this.emitter.fire(undefined); }
  node(key, make) { if (!this.nodes.has(key)) this.nodes.set(key, make()); return this.nodes.get(key); }
  getParent(node) {
    if (!node || node.item || !node.reg) return undefined;
    if (node.field) return this.node(`${node.periph.id}|${node.reg.name}`, () => ({ periph: node.periph, reg: node.reg, regNode: true }));
    return this.node(node.periph.id, () => ({ periph: node.periph }));
  }
  /** The tree element of a register (for reveal), or undefined. */
  elementFor(periphId, regName) {
    const p = this.peripherals().find((x) => x.id === periphId);
    const r = p && p.registers.find((x) => x.name === regName);
    if (!r) return undefined;
    this.node(p.id, () => ({ periph: p }));
    return this.node(`${p.id}|${r.name}`, () => ({ periph: p, reg: r, regNode: true }));
  }
  /** How many registers of a peripheral changed since the last stop (of those read). */
  changedCount(periphId) {
    let n = 0;
    for (const [k, v] of this.values) if (k.startsWith(periphId + '|') && v.was !== undefined) n++;
    return n;
  }
  descriptions() {
    // The workspace's descriptions come first, so they win over the shipped ones for the same type and port.
    const own = registers.loadFiles(shared.workspaceRegisterFiles);
    const shipped = registers.loadDir(path.join(common.ROOT, 'registers'));
    const descs = own.descs.concat(shipped.descs);
    const problems = own.problems.concat(shipped.problems);
    for (const m of shared.modelSpecs) {
      try { descs.push(registers.fromModelSpec(m.spec, m.file)); } catch (e) { problems.push(`${path.basename(m.file)}: ${e.message}`); }
    }
    return { descs, problems };
  }
  peripherals() {
    if (!shared.runningDoc) return [];
    return registers.peripherals(shared.runningDoc, this.descriptions().descs, shared.runningBuses);
  }
  note(text, icon = 'info') {
    const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(icon);
    return { item };
  }
  async getChildren(node) {
    if (!shared.agent) return [];
    if (!node) {
      if (!shared.agentMethods.includes('mem.read')) return [this.note('This sim agent cannot read registers (that needs agent 0.6.0). Run "VP Studio: Build Sim Agent" and start the simulation again.', 'warning')];
      if (!shared.runningDoc) return [this.note('Registers are shown for simulations started with "Start Simulation".')];
      const ps = this.peripherals();
      if (!ps.length) return [this.note('No peripheral of this platform has a register description.')];
      // A new peripheral list (another simulation) replaces the elements.
      const ids = ps.map((p) => p.id).join(',');
      if (ids !== this.nodeIds) { this.nodes.clear(); this.nodeIds = ids; }
      return ps.map((p) => this.node(p.id, () => ({ periph: p })));
    }
    if (node.field) return [];
    if (node.regNode) {
      const v = this.values.get(`${node.periph.id}|${node.reg.name}`);
      return node.reg.fields.map((f) => ({ periph: node.periph, reg: node.reg, field: f, value: v && v.value, was: v && v.was }));
    }
    if (node.periph) {
      if (!this.stopped) return [this.note('Pause the simulation to read the registers.', 'debug-pause')];
      const first = !this.reading.has(node.periph.id);
      await this.readPeriph(node.periph);
      // Once read, show how many changed on the peripheral's own line too.
      if (first && this.changedCount(node.periph.id)) setTimeout(() => this.emitter.fire(undefined), 0);
      return node.periph.registers.map((r) => this.node(`${node.periph.id}|${r.name}`, () => ({ periph: node.periph, reg: r, regNode: true })));
    }
    return [];
  }
  readPeriph(p) {
    if (!this.reading.has(p.id)) {
      this.reading.set(p.id, (async () => {
        for (const r of p.registers) {
          if (registers.notReadReason(r)) continue;
          await this.readReg(p, r);
        }
      })());
    }
    return this.reading.get(p.id);
  }
  async readReg(p, r) {
    const key = `${p.id}|${r.name}`;
    try {
      const res = await shared.agent.request('mem.read', { address: '0x' + (p.address + r.offset).toString(16), size: r.size, bus: p.busIndex });
      const value = registers.fromBytes(res.data);
      const before = this.previous.get(key);
      this.values.set(key, before && before.value !== value ? { value, was: before.value } : { value });
    } catch (e) {
      this.values.set(key, { error: e.message });
    }
  }
  getTreeItem(node) {
    if (node.item) return node.item;
    const p = node.periph;
    if (!node.reg) {
      const item = new vscode.TreeItem(p.module, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'r:' + p.id;
      const changed = this.changedCount(p.id);
      item.description = `${p.type} · ${registers.hexOf(p.address, 4).replace(/_/g, '')}${changed ? ` · ${changed} changed` : ''}`;
      item.tooltip = `${p.title}\n${p.id} at ${'0x' + p.address.toString(16)} on ${p.bus}`;
      item.iconPath = new vscode.ThemeIcon('plug', new vscode.ThemeColor(modulesTree.MODULE_ROLE_LOOK.periph.color));
      item.contextValue = 'vpPeriph';
      return item;
    }
    const r = node.reg;
    const addr = '0x' + (p.address + r.offset).toString(16);
    const v = this.values.get(`${p.id}|${r.name}`);
    if (!node.field) {
      const item = new vscode.TreeItem(r.name, r.fields.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.id = `r:${p.id}|${r.name}`;
      const why = registers.notReadReason(r);
      item.description = v && v.value !== undefined ? registers.hexOf(v.value, r.size) + (v.was !== undefined ? `  ● was ${registers.hexOf(v.was, r.size)}` : '') : v && v.error ? 'read failed' : why ? `not read: ${why}` : '';
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${r.name}** · offset 0x${r.offset.toString(16)} · ${addr} · ${r.size * 8} bits · ${r.access}\n\n`);
      if (r.description) md.appendText(r.description + '\n\n');
      if (v && v.error) md.appendText(`Read failed: ${v.error}\n\n`);
      if (v && v.was !== undefined) {
        const fs = registers.changedFields(r, v.value, v.was);
        md.appendMarkdown(`**Changed since the last stop**: was ${registers.hexOf(v.was, r.size)}${fs.length ? ` (${fs.map((f) => `${f.name} ${f.was}→${f.now}`).join(', ')})` : ''}\n\n`);
      }
      if (r.readSideEffect) md.appendMarkdown('*Reading this register changes the device (for example, it takes a received character), so it is read only with Read Now.*');
      item.tooltip = md;
      item.iconPath = new vscode.ThemeIcon(r.access === 'ro' ? 'lock' : 'symbol-field', v && v.was !== undefined ? new vscode.ThemeColor('charts.orange') : undefined);
      item.contextValue = ['vpReg', r.access === 'ro' ? 'RO' : 'W', why ? 'Unread' : ''].join('');
      return item;
    }
    const f = node.field;
    const item = new vscode.TreeItem(`${f.name} ${registers.bitsText(f)}`, vscode.TreeItemCollapsibleState.None);
    item.id = `r:${p.id}|${r.name}|${f.name}`;
    const fmt = (fv) => (f.msb === f.lsb ? String(fv) : `0x${fv.toString(16)} (${fv})`);
    let fieldChanged = false;
    if (node.value !== undefined) {
      const fv = registers.fieldValue(node.value, f);
      fieldChanged = node.was !== undefined && registers.fieldValue(node.was, f) !== fv;
      item.description = fmt(fv) + (fieldChanged ? `  ● was ${fmt(registers.fieldValue(node.was, f))}` : '');
    }
    item.tooltip = f.description || `${f.name}, bits ${registers.bitsText(f)} of ${r.name}`;
    item.iconPath = new vscode.ThemeIcon('symbol-constant', fieldChanged ? new vscode.ThemeColor('charts.orange') : undefined);
    // A field is set by read-modify-write, which needs a readable register (w1c writes the field alone).
    const settable = r.access !== 'ro' && (r.access === 'w1c' || !registers.notReadReason(r));
    item.contextValue = settable ? 'vpField' : 'vpFieldRO';
    return item;
  }
}

function registerStopped() {
  if (!shared.agent) { vscode.window.showWarningMessage('Not connected to a simulation.'); return false; }
  if (!shared.registerTree.stopped) { vscode.window.showWarningMessage('Pause the simulation first: registers are read and written while it is paused.'); return false; }
  return true;
}

/** Read a register now, even one whose reading changes the device. */
async function cmdReadRegister(node) {
  if (!node || !node.reg || !registerStopped()) return;
  await shared.registerTree.readReg(node.periph, node.reg);
  shared.registerTree.emitter.fire();
}

/** Write a register, or a field of it (read-modify-write), after asking. */
async function cmdSetRegister(node) {
  if (!node || !node.reg || !registerStopped()) return;
  const p = node.periph;
  const r = node.reg;
  const f = node.field;
  if (r.access === 'ro') { vscode.window.showWarningMessage(`${r.name} is read-only.`); return; }
  const key = `${p.id}|${r.name}`;
  const cur = shared.registerTree.values.get(key);
  const curValue = cur && cur.value;
  const bits = f ? f.msb - f.lsb + 1 : r.size * 8;
  const now = f ? (curValue !== undefined ? registers.fieldValue(curValue, f) : undefined) : curValue;
  const text = await vscode.window.showInputBox({
    title: `Set ${f ? `${r.name}.${f.name} ${registers.bitsText(f)}` : r.name} of ${p.module}`,
    prompt: `${bits} bit${bits > 1 ? 's' : ''}${now !== undefined ? ` · now 0x${now.toString(16)}` : ''}${r.access === 'w1c' ? ' · write 1 to clear' : ''}. Decimal, 0x hex or 0b binary.`,
    value: now !== undefined ? '0x' + now.toString(16) : '',
    validateInput: (t) => { try { registers.parseValue(t, bits); return undefined; } catch (e) { return e.message; } },
  });
  if (text === undefined) return;
  const v = registers.parseValue(text, bits);
  let regValue = v;
  if (f) {
    if (r.access === 'w1c') regValue = registers.withField(0n, f, v); // only this field's 1s clear
    else if (curValue === undefined) { vscode.window.showWarningMessage(`${r.name} has not been read, so its other fields are unknown; set the whole register instead.`); return; }
    else regValue = registers.withField(curValue, f, v);
  }
  const addr = p.address + r.offset;
  const pick = await vscode.window.showWarningMessage(`Write ${registers.hexOf(regValue, r.size)} to ${r.name} of ${p.module} (0x${addr.toString(16)})?`, {
    modal: true,
    detail: 'The device sees it as a write from the bus, as if the CPU wrote it: it may act on it (send data, clear an interrupt, reset a queue). The guest software is not told.',
  }, 'Write');
  if (pick !== 'Write') return;
  try {
    await shared.agent.request('mem.write', { address: '0x' + addr.toString(16), data: registers.toBytes(regValue, r.size), bus: p.busIndex });
  } catch (e) {
    vscode.window.showErrorMessage(`Writing ${r.name} failed: ${e.message}`);
    return;
  }
  if (!registers.notReadReason(r)) await shared.registerTree.readReg(p, r);
  shared.registerTree.emitter.fire();
}

exports.RegisterTree = RegisterTree;
exports.cmdReadRegister = cmdReadRegister;
exports.cmdSetRegister = cmdSetRegister;
