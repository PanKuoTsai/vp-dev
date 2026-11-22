'use strict';
// Edits from the platform view: software images, adding and deleting modules, connections, restructuring.
const vscode = require('vscode');
const path = require('path');
const core = require('../lib/platform/core');
const images = require('../lib/platform/images');
const jsonedit = require('../lib/platform/jsonedit');
const params = require('../lib/platform/params');
const modules = require('../lib/platform/modules');
const connect = require('../lib/platform/connect');
const restructure = require('../lib/platform/restructure');
const shared = require('./shared');
const common = require('./common');
const catalogUi = require('./catalogUi');
const platformFiles = require('./platformFiles');
const devicetreeUi = require('./devicetreeUi');
const traceUi = require('./traceUi');
const platformView = require('./platformView');

/** Apply one text edit computed from the current document text and parsed data. */
async function editPlatform(uri, makeEdit) {
  const textDoc = await vscode.workspace.openTextDocument(uri);
  const text = textDoc.getText();
  const edit = makeEdit(text, JSON.parse(text));
  if (!edit) return;
  const we = new vscode.WorkspaceEdit();
  we.replace(uri, new vscode.Range(textDoc.positionAt(edit.start), textDoc.positionAt(edit.end)), edit.text);
  if (!(await vscode.workspace.applyEdit(we))) throw new Error('the editor rejected the change');
}

async function pickFile(uri, title, elfOnly) {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false, title, defaultUri: vscode.Uri.file(path.dirname(uri.fsPath)),
    filters: elfOnly ? { 'ELF files': ['elf', 'axf', 'out', '*'] } : { 'Images': ['bin', 'elf', 'img', 'dtb', 'axf', '*'] },
  });
  return picked && picked[0] ? picked[0].fsPath : undefined;
}

const entriesEdit = (text, moduleName, entries) =>
  jsonedit.setProperty(text, core.jsonPath(moduleName), 'entries', (ind) => jsonedit.renderRows(entries, ind));

function rowsFromEntries(entries) {
  return entries.map((e, orig) => {
    const kind = images.kindOf(e);
    return { orig, kind, file: kind === 'bin' ? e.bin_file : e.elf_file, address: typeof e.address === 'string' || typeof e.address === 'number' ? String(e.address) : '' };
  });
}

/** container: where to add ('' for the top level); undefined asks when the platform has subsystems. */
async function cmdAddModule(arg, container) {
  const uri = await platformFiles.pickPlatform(arg);
  if (!uri) return;
  const cat = catalogUi.catalog();
  if (!cat) {
    vscode.window.showWarningMessage('Adding a module needs the component catalog, which is turned off ("vpStudio.catalog").');
    return;
  }
  const loaded = await platformFiles.load(uri);
  if (!loaded) return;
  const data = loaded.data;
  const analysis = core.analyze(data);
  const typeOf = new Map(analysis.instances.map((i) => [i.name, i.type]));
  if (container === undefined) {
    const where = modules.containerChoices(data);
    if (where.length > 1) {
      const sel = await vscode.window.showQuickPick(where.map((c) => ({ label: c || '(top level)', description: c ? 'subsystem' : '', c })),
        { title: 'Add Module', placeHolder: 'Where should the new module go?' });
      if (!sel) return;
      container = sel.c;
    } else container = '';
  }
  const SUBSYSTEM = '$(folder) Subsystem';
  const choices = [{ label: SUBSYSTEM, description: 'a Container holding other modules', type: 'Container', subsystem: true }]
    .concat(modules.typeChoices(cat).map((c) => ({ label: c.type, description: c.summary, detail: c.source, type: c.type })));

  const pick = await vscode.window.showQuickPick(
    choices,
    { title: container ? `Add Module to ${container}` : 'Add Module', placeHolder: 'Type of the new module (from the QBox component catalog)', matchOnDescription: true, matchOnDetail: true });
  if (!pick) return;

  const name = await vscode.window.showInputBox({
    title: `Add ${pick.subsystem ? 'subsystem' : pick.type}${container ? ` to ${container}` : ''}`, prompt: 'Name of the new instance',
    value: modules.suggestName(data, analysis, pick.subsystem ? 'subsys' : pick.type, container),
    validateInput: (v) => modules.nameProblem(data, analysis, v.trim(), container) || undefined,
  });
  if (!name) return;
  const inst = name.trim();
  const full = container ? `${container}.${inst}` : inst;
  if (pick.subsystem) {
    common.pendingSelect.set(uri.toString(), full);
    await editPlatform(uri, (text, fresh) => {
      const why = modules.nameProblem(fresh, core.analyze(fresh), inst, container);
      if (why) throw new Error(why);
      return modules.addModuleEdit(text, inst, { type: 'Container', modules: {} }, container);
    });
    if (!common.panels.get(uri.toString())) await platformView.cmdShowPlatform(uri);
    vscode.window.setStatusBarMessage(`VP Studio: added subsystem ${full}. Use "Add module here…" in its panel to fill it.`, 10000);
    return;
  }

  const args = [];
  const specs = modules.argSpecs(cat, pick.type);
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    if (spec.ref) {
      const c = modules.argCandidates(analysis, spec.expects);
      if (!c.names.length) {
        vscode.window.showErrorMessage(`${pick.type} needs a ${spec.expects} as constructor argument, but this platform has no module to pass. Add one first.`);
        return;
      }
      const sel = await vscode.window.showQuickPick(
        c.names.map((n) => ({ label: n, description: typeOf.get(n) })),
        { title: `${full}: ${spec.label}`, placeHolder: c.exact ? `Choose the ${spec.expects} to pass` : `No ${spec.expects} module found; choose the module to pass` });
      if (!sel) return;
      args.push({ ref: sel.label });
    } else {
      const v = await vscode.window.showInputBox({
        title: `${inst}: ${spec.label}`, prompt: `Value passed to the constructor (${spec.decl})`,
        value: modules.existingArg(data, pick.type, i),
      });
      if (v === undefined) return;
      args.push(v);
    }
  }

  common.pendingSelect.set(uri.toString(), full);
  try {
    await editPlatform(uri, (text, fresh) => {
      const why = modules.nameProblem(fresh, core.analyze(fresh), inst, container);
      if (why) throw new Error(why);
      return modules.addModuleEdit(text, inst, modules.moduleDef(cat, pick.type, args, path.dirname(uri.fsPath)), container);
    });
  } catch (e) {
    common.pendingSelect.delete(uri.toString());
    throw e;
  }
  const panel = common.panels.get(uri.toString());
  if (!panel) await platformView.cmdShowPlatform(uri);
  const required = (cat.modules[pick.type].requiredParams || []);
  vscode.window.setStatusBarMessage(
    `VP Studio: added ${full} (${pick.type}). Its ports are not connected yet` + (required.length ? `; it needs ${required.join(', ')}.` : '.'), 10000);
}

async function deleteModule(uri, base) {
  const loaded = await platformFiles.load(uri);
  if (!loaded) return;
  const plan = modules.deletePlan(loaded.data, base);
  if (plan.blockers.length) {
    const who = [...new Set(plan.blockers.map((b) => b.module))];
    vscode.window.showErrorMessage(`Cannot delete ${base}`, {
      modal: true,
      detail: `${who.join(', ')} ${who.length > 1 ? 'take' : 'takes'} it as a constructor argument and could not be built without it. Delete or change ${who.length > 1 ? 'those modules' : 'that module'} first.`,
    });
    return;
  }
  const n = plan.bindings.length;
  const list = plan.bindings.slice(0, 12).map((b) => `${b.module}.${b.port} → ${b.bind}`).join('\n');
  const isSub = !!core.modulesOf(loaded.data)[base].container;
  const inside = plan.contents.length ? `It holds ${plan.contents.length} module${plan.contents.length > 1 ? 's' : ''}, deleted with it: ${plan.contents.slice(0, 8).join(', ')}${plan.contents.length > 8 ? ' …' : ''}.\n\n` : '';
  const detail = inside + (n
    ? `This also removes ${n} connection${n > 1 ? 's' : ''} to it from other modules:\n${list}${n > 12 ? `\n… and ${n - 12} more` : ''}\n\nUndo (Ctrl+Z in the JSON file) brings everything back.`
    : `No other module is connected to it.${inside ? ' Undo (Ctrl+Z in the JSON file) brings everything back.' : ''}`);
  const ok = await vscode.window.showWarningMessage(`Delete ${isSub ? 'subsystem' : 'module'} ${base}?`, { modal: true, detail }, 'Delete');
  if (ok !== 'Delete') return;
  await editPlatform(uri, (text, fresh) => {
    const p = modules.deletePlan(fresh, base);
    if (p.blockers.length) throw new Error(`${base} is now used as a constructor argument; nothing was deleted`);
    return modules.minimalEdit(text, modules.deleteModuleText(text, base, p));
  });
}

const KIND_TEXT = { tlm_initiator: 'bus initiator', tlm_target: 'bus target', signal_out: 'signal out', signal_in: 'signal in', biflow: 'byte stream' };

function usageText(row) {
  const parts = row.out.map((o) => `→ ${o.bind}`).concat(row.in.map((i) => `← ${i.from}.${i.key}`));
  if (!parts.length) return 'not connected';
  return parts.length > 3 ? `${parts.slice(0, 3).join(', ')} … (${parts.length})` : parts.join(', ');
}

/**
 * Connect a port of module a, asking for whatever is not given: the port, the
 * other module b, its port, the instance and vector index, and the address
 * and size when a mapped socket goes on a bus.
 */
async function connectFlow(uri, a, portA, b) {
  const cat = catalogUi.catalog();
  if (!cat) { vscode.window.showWarningMessage('Connecting ports needs the component catalog, which is turned off ("vpStudio.catalog").'); return; }
  const loaded = await platformFiles.load(uri);
  if (!loaded) return;
  const data = loaded.data;
  const analysis = core.analyze(data);
  const mods = core.modulesOf(data);
  if (!mods[a]) throw new Error(`module ${a} no longer exists`);
  // A subsystem block stands for its modules: ask which one.
  const member = async (c, what) => {
    const inner = Object.keys(mods).filter((n) => n.startsWith(c + '.') && !mods[n].container);
    if (!inner.length) { vscode.window.showWarningMessage(`${c} has no modules to connect yet.`); return undefined; }
    const sel = await vscode.window.showQuickPick(inner.map((n) => ({ label: n, description: mods[n].type })), { title: `Connect: ${what} inside ${c}`, placeHolder: `Which module of ${c}?` });
    return sel && sel.label;
  };
  if (mods[a].container) { a = await member(a, 'module to connect'); if (!a) return; portA = undefined; }
  if (b && mods[b] && mods[b].container) { b = await member(b, 'module to connect to'); if (!b) return; }
  const title = (step) => `Connect ${a}${b ? ` → ${b}` : ''}: ${step}`;

  if (!portA) {
    let rows = connect.portRows(data, cat, a).filter((r) => r.kind);
    if (b) rows = rows.filter((r) => connect.compatiblePorts(cat, mods[b].type, r.kind).length);
    if (!rows.length) {
      vscode.window.showWarningMessage(b ? `No port of ${a} (${mods[a].type}) fits a port of ${b} (${mods[b].type}).` : `The component catalog lists no ports for ${mods[a].type}.`);
      return;
    }
    const sel = await vscode.window.showQuickPick(rows.map((r) => ({
      label: r.name, description: (KIND_TEXT[r.kind] || r.kind) + (r.vector ? ', vector' : ''), detail: usageText(r),
    })), { title: title(`port of ${a}`), placeHolder: `Which port of ${a} (${mods[a].type})?`, matchOnDetail: true });
    if (!sel) return;
    portA = sel.label;
  }
  const pa = connect.portOf(cat, mods[a].type, portA);
  if (!pa) { vscode.window.showWarningMessage(`${mods[a].type} has no port ${portA} in the component catalog.`); return; }

  if (!b) {
    const cands = connect.compatibleModules(data, cat, a, pa.kind);
    if (!cands.length) { vscode.window.showWarningMessage(`No other module has a port that fits ${a}.${pa.name} (${KIND_TEXT[pa.kind] || pa.kind}).`); return; }
    const sel = await vscode.window.showQuickPick(cands.map((n) => ({ label: n, description: mods[n].type })),
      { title: title(`module to connect ${a}.${pa.name} to`), placeHolder: `Modules with a port that fits a ${KIND_TEXT[pa.kind] || pa.kind}` });
    if (!sel) return;
    b = sel.label;
  }
  const pbs = connect.compatiblePorts(cat, mods[b].type, pa.kind);
  if (!pbs.length) { vscode.window.showWarningMessage(`${b} (${mods[b].type}) has no port that fits ${a}.${pa.name} (${KIND_TEXT[pa.kind] || pa.kind}).`); return; }
  let pb = pbs[0];
  if (pbs.length > 1) {
    const rowsB = new Map(connect.portRows(data, cat, b).map((r) => [r.name, r]));
    const sel = await vscode.window.showQuickPick(pbs.map((p) => ({
      label: p.name, description: (KIND_TEXT[p.kind] || p.kind) + (p.vector ? ', vector' : ''), detail: rowsB.has(p.name) ? usageText(rowsB.get(p.name)) : '', port: p,
    })), { title: title(`port of ${b}`), placeHolder: `Which port of ${b} (${mods[b].type})?` });
    if (!sel) return;
    pb = sel.port;
  }

  // The device end writes a binding to a bus; otherwise the end you started from.
  const aEnd = { base: a, port: pa };
  const bEnd = { base: b, port: pb };
  const [D, O] = connect.declaringEnd(data, a, b) === 'a' ? [aEnd, bEnd] : [bEnd, aEnd];
  const dRepl = mods[D.base].count !== undefined;

  const insts = connect.peerInstances(data, analysis, D.base, O.base);
  let oInst = insts[0];
  if (insts.length > 1) {
    const sel = await vscode.window.showQuickPick(insts.map((n) => ({
      label: n, description: n.endsWith('_{i}') ? `each instance of ${D.base} to the ${O.base} instance with the same number` : '',
    })), { title: title(`instance of ${O.base}`), placeHolder: `${O.base} has ${insts.length - (insts[0].endsWith('_{i}') ? 1 : 0)} instances; which one?` });
    if (!sel) return;
    oInst = sel.label;
  }
  const askIndex = async (end) => {
    const v = await vscode.window.showInputBox({
      title: title(`index of ${end.base}.${end.port.name}`),
      prompt: `${end.port.name} is a vector port: which element (${end.port.name}_N)?` + (dRepl ? ' {i} uses the number of each instance.' : ''),
      value: String(connect.nextIndex(data, end.base, end.port.name)),
      validateInput: (x) => connect.indexProblem(x, dRepl) || undefined,
    });
    return v === undefined ? undefined : v.trim();
  };
  let dKey = D.port.name;
  if (D.port.vector) { const i = await askIndex(D); if (i === undefined) return; dKey += `_${i}`; }
  let oPort = O.port.name;
  if (O.port.vector) { const i = await askIndex(O); if (i === undefined) return; oPort += `_${i}`; }

  const entry = {};
  if (connect.needsAddress(data, D.port.kind, O.base)) {
    const address = await vscode.window.showInputBox({
      title: title(`address of ${D.base}.${dKey} on ${O.base}`), prompt: 'Start address on the bus', placeHolder: '0x09000000',
      validateInput: (x) => connect.addressProblem(x) || undefined,
    });
    if (address === undefined) return;
    const size = await vscode.window.showInputBox({
      title: title(`size of ${D.base}.${dKey} on ${O.base}`), prompt: 'Size of the address range', value: '0x1000',
      validateInput: (x) => connect.addressProblem(x) || undefined,
    });
    if (size === undefined) return;
    entry.address = address.trim();
    entry.size = size.trim();
  }
  entry.bind = `${oInst}.${oPort}`;

  const existing = connect.declared(data, D.base).find((x) => x.key === dKey && x.scope === null);
  if (existing && existing.bind !== entry.bind) {
    const ok = await vscode.window.showWarningMessage(`${D.base}.${dKey} is already connected to ${existing.bind}.`,
      { modal: true, detail: `Replace that connection with ${entry.bind}?` }, 'Replace');
    if (ok !== 'Replace') return;
  }
  await editPlatform(uri, (text) => connect.bindEdit(text, D.base, dKey, entry));
  vscode.window.setStatusBarMessage(`VP Studio: connected ${D.base}.${dKey} → ${entry.bind}` + (D.base !== a ? ` (written on ${D.base}, the device end)` : ''), 8000);
}

async function disconnectFlow(uri, module, key, scope) {
  const loaded = await platformFiles.load(uri);
  if (!loaded) return;
  const item = connect.declared(loaded.data, module).find((x) => x.key === key && String(x.scope) === String(scope));
  if (!item) return;
  await editPlatform(uri, (text) => connect.unbindEdit(text, item));
  vscode.window.setStatusBarMessage(`VP Studio: disconnected ${module}.${key} from ${item.bind}. Ctrl+Z in the JSON file undoes it.`, 8000);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Replace a module's model type, keeping its connections where the new type has the same ports. */
async function swapFlow(uri, base) {
  const loaded = await platformFiles.load(uri);
  if (!loaded) return;
  const cat = catalogUi.catalog();
  const mod = core.modulesOf(loaded.data)[base];
  if (!mod) return;
  const choices = restructure.swapChoices(loaded.data, cat, base);
  const pick = await vscode.window.showQuickPick(choices.map((c) => ({
    label: c.type,
    description: !c.checked ? 'ports unknown, cannot be checked' : c.lost ? `loses ${plural(c.lost, 'connection')}` : c.rename ? `keeps all connections, ${plural(c.rename, 'port')} renamed` : 'keeps all connections',
    detail: c.summary, c,
  })), { title: `Replace ${base} (${mod.type})`, placeHolder: 'New model type; the best fits come first', matchOnDescription: true, matchOnDetail: true });
  if (!pick) return;
  let plan;
  try { plan = restructure.swapPlan(loaded.data, cat, base, pick.label, path.dirname(uri.fsPath)); } catch (e) {
    vscode.window.showErrorMessage(`Cannot replace ${base}: ${e.message}`);
    return;
  }
  const args = plan.args.now.slice();
  for (const a of plan.args.ask) {
    if (a.spec.ref) {
      const sel = await vscode.window.showQuickPick(a.candidates.names.map((n) => ({ label: n })), { title: `${plan.newType}: ${a.spec.label}`, placeHolder: `Module to pass (${a.spec.expects})` });
      if (!sel) return;
      args[a.index] = { ref: sel.label };
    } else {
      const v = await vscode.window.showInputBox({ title: `${plan.newType}: ${a.spec.label}`, prompt: a.spec.decl, ignoreFocusOut: true });
      if (v === undefined) return;
      args[a.index] = v;
    }
  }
  const lines = [];
  if (plan.unchecked) lines.push(`The component catalog cannot look into ${plan.newType}: its ports and parameters are not checked.`);
  if (plan.keep.length) lines.push(`Connections kept: ${plan.keep.join(', ')}`);
  for (const r of plan.rename) lines.push(`Port renamed: ${r.from} → ${r.to} (its connections follow)`);
  for (const l of plan.lost) lines.push(`Removed: ${l.port} (${plural(l.connections, 'connection')}); ${plan.newType} has no such ${l.kind || 'port'}${l.choices.length > 1 ? `, it has ${l.choices.join(', ')}` : ''}`);
  if (plan.dropParams.length) lines.push(`Parameters removed (${plan.newType} does not have them): ${plan.dropParams.map((p) => (p.scope === null ? p.name : `${p.name} (${base}_${p.scope})`)).join(', ')}`);
  const fmtArg = (a) => (a && typeof a === 'object' ? a.ref : JSON.stringify(a));
  if (JSON.stringify(args) !== JSON.stringify(plan.args.old)) lines.push(`Constructor arguments: ${args.length ? args.map(fmtArg).join(', ') : 'none'}`);
  if (plan.dylib.now !== plan.dylib.old) lines.push(`Library (dylib): ${plan.dylib.old || 'none'} → ${plan.dylib.now || 'none'}`);
  const ok = await vscode.window.showWarningMessage(`Replace ${base} (${plan.oldType}) with ${plan.newType}?`,
    { modal: true, detail: `${lines.join('\n')}\n\nCtrl+Z in the JSON file undoes it.` }, 'Replace');
  if (ok !== 'Replace') return;
  common.pendingSelect.set(uri.toString(), base);
  await editPlatform(uri, (text, data) => modules.minimalEdit(text, restructure.swapText(text, data, plan, args)));
  vscode.window.setStatusBarMessage(`VP Studio: ${base} is now a ${plan.newType}. Ctrl+Z in the JSON file undoes it.`, 8000);
}

/** Group modules of one container into a new subsystem. */
async function groupFlow(uri, bases) {
  const loaded = await platformFiles.load(uri);
  if (!loaded || !bases.length) return;
  const data = loaded.data;
  const flat = core.flatten(data);
  const container = flat.parent[bases[0]];
  if (bases.some((b) => flat.parent[b] !== container)) {
    vscode.window.showWarningMessage('The modules to group must be in the same subsystem, or all at the top level.');
    return;
  }
  const analysis = catalogUi.analyzeWithCatalog(data);
  let suggestion = 'subsystem';
  for (let n = 0; modules.nameProblem(data, analysis, suggestion, container); n++) suggestion = `subsystem_${n}`;
  const name = await vscode.window.showInputBox({
    title: `Group ${plural(bases.length, 'module')} into a subsystem`, prompt: `Name of the new subsystem${container ? ` inside ${container}` : ''}`,
    value: suggestion, ignoreFocusOut: true, validateInput: (v) => modules.nameProblem(data, analysis, v.trim(), container),
  });
  if (!name) return;
  let plan;
  try { plan = restructure.groupPlan(data, bases, name.trim()); } catch (e) {
    vscode.window.showErrorMessage(`Cannot group: ${e.message}`);
    return;
  }
  const w = plan.rewrites;
  const detail = (w.length
    ? `${plural(w.length, 'reference')} from other modules will reach them through ${plan.name}:\n${w.slice(0, 10).map((x) => `${x.module}: ${x.from} → ${x.to}`).join('\n')}${w.length > 10 ? `\n… and ${w.length - 10} more` : ''}`
    : 'No other module refers to them, so nothing else changes.') + '\n\nEvery connection stays the same. Ctrl+Z in the JSON file undoes it.';
  const ok = await vscode.window.showInformationMessage(`Group ${bases.join(', ')} into the subsystem ${plan.path}?`, { modal: true, detail }, 'Group');
  if (ok !== 'Group') return;
  common.pendingSelect.set(uri.toString(), plan.path);
  await editPlatform(uri, (text) => modules.minimalEdit(text, restructure.groupText(text, plan)));
  vscode.window.setStatusBarMessage(`VP Studio: grouped ${plural(bases.length, 'module')} into ${plan.path}. Ctrl+Z in the JSON file undoes it.`, 8000);
}

async function handleFormMessage(uri, msg, reply) {
  const topDir = path.dirname(uri.fsPath);
  switch (msg.type) {
    case 'command': {
      // Buttons in the view's header; only these commands, always for this platform.
      const commands = { generate: 'vpStudio.generate', start: 'vpStudio.start', startTrace: 'vpStudio.startTrace', trace: 'vpStudio.showTrace', probes: 'vpStudio.chooseProbes' };
      return commands[msg.command] ? vscode.commands.executeCommand(commands[msg.command], uri) : undefined;
    }
    case 'txWatch': {
      // The Transactions tab opened (or closed): records of the running platform go to it.
      const key = uri.toString();
      if (!msg.on) { traceUi.txWatch.delete(key); return undefined; }
      traceUi.txWatch.add(key);
      reply(traceUi.txState(key));
      if (shared.runningPlatform && shared.runningPlatform.toString() === key) reply({ type: 'tx', records: shared.traceRecords.slice(-5000), reset: true });
      traceUi.traceConnected();
      return undefined;
    }
    case 'swapModule':
      return swapFlow(uri, String(msg.module));
    case 'groupModules':
      return groupFlow(uri, Array.isArray(msg.modules) ? msg.modules.map(String) : []);
    case 'deviceTree': {
      const m = await devicetreeUi.deviceTreePane(uri, String(msg.against || 'auto'));
      return m ? reply(m) : undefined;
    }
    case 'deviceTreeWrite': {
      const loaded = await platformFiles.load(uri);
      if (!loaded) return undefined;
      try {
        const r = await devicetreeUi.deviceTreeFor(uri, loaded.data);
        vscode.window.setStatusBarMessage(`VP Studio: wrote ${vscode.workspace.asRelativePath(r.dts)} and ${path.basename(r.dtb)}`, 8000);
      } catch (e) {
        vscode.window.showErrorMessage(`Device tree not generated: ${e.message}`);
      }
      const m = await devicetreeUi.deviceTreePane(uri, String(msg.against || 'auto'));
      return m ? reply(m) : undefined;
    }
    case 'addModule':
      return cmdAddModule(uri, typeof msg.container === 'string' && msg.container ? msg.container : undefined);
    case 'toggleSubsystem': {
      const set = platformView.collapsedFor(uri);
      const m = String(msg.module);
      if (set.has(m)) set.delete(m); else set.add(m);
      platformView.saveCollapsed(uri);
      common.pendingSelect.set(uri.toString(), m);
      const panel = common.panels.get(uri.toString());
      return panel ? platformView.renderPanel(uri, panel) : undefined;
    }
    case 'deleteModule':
      return deleteModule(uri, String(msg.module));
    case 'connect':
      return connectFlow(uri, String(msg.module), msg.port ? String(msg.port) : undefined, msg.peer ? String(msg.peer) : undefined);
    case 'disconnect':
      return disconnectFlow(uri, String(msg.module), String(msg.key), msg.scope === null || msg.scope === undefined ? null : String(msg.scope));
    case 'setParam':
    case 'resetParam': {
      const name = String(msg.name);
      const module = String(msg.module);
      const index = msg.index === null || msg.index === undefined ? null : String(msg.index);
      return editPlatform(uri, (text, data) => {
        if (msg.type === 'resetParam') return params.resetParamEdit(text, module, name, index);
        // The input kind comes from the form row built here, not from the webview.
        const row = params.findRow(params.moduleForms(data, core.analyze(data), catalogUi.catalog()), module, name, index);
        if (!row && index !== null) throw new Error(`${module} has no instance ${index}`);
        if (row && row.locked) { reply({ type: 'paramError', module, index, name, message: row.locked }); return undefined; }
        const r = params.parseInput(msg.input, row ? row.kind : 'json');
        if (r.error) { reply({ type: 'paramError', module, index, name, message: r.error }); return undefined; }
        if (r.reset) return params.resetParamEdit(text, module, name, index);
        if (row && row.set && JSON.stringify(row.value) === JSON.stringify(r.value)) return undefined;
        return params.setParamEdit(text, module, name, r.value, index);
      });
    }
    case 'setImages':
      return editPlatform(uri, (text, data) => {
        const mod = core.modulesOf(data)[msg.module];
        if (!mod) throw new Error(`module ${msg.module} no longer exists`);
        return entriesEdit(text, msg.module, images.rebuildEntries(mod.entries || [], msg.rows));
      });
    case 'browseImage':
    case 'addImage': {
      const file = await pickFile(uri, msg.type === 'addImage' ? 'Select an image to load into memory' : 'Select the image file', false);
      if (!file) return undefined;
      const kind = images.isElf(file) ? 'elf' : 'bin';
      return editPlatform(uri, (text, data) => {
        const mod = core.modulesOf(data)[msg.module];
        if (!mod) throw new Error(`module ${msg.module} no longer exists`);
        const old = mod.entries || [];
        const rows = rowsFromEntries(old);
        const fallback = images.collect(data, core.analyze(data), topDir).defaultAddress;
        const row = { orig: null, kind, file: images.toTemplate(file, topDir), address: fallback };
        if (msg.type === 'addImage') {
          rows.push(row);
        } else {
          const cur = rows[msg.index];
          if (!cur || cur.kind === 'raw') throw new Error('that entry cannot be changed here');
          rows[msg.index] = Object.assign(row, { orig: msg.index, address: cur.address || fallback });
        }
        return entriesEdit(text, msg.module, images.rebuildEntries(old, rows));
      });
    }
    case 'addLoader':
      return editPlatform(uri, (text, data) => {
        const bus = core.analyze(data).routers[0];
        if (!bus) throw new Error('the platform has no router to attach a loader to');
        let name = 'load';
        for (let n = 1; core.modulesOf(data)[name]; n++) name = `load_${n}`;
        return jsonedit.setProperty(text, ['modules'], name, (ind) => {
          const s = '  ';
          return `{\n${ind}${s}"type": "loader",\n${ind}${s}"ports": {\n${ind}${s}${s}"initiator_socket": { "bind": "${bus}.target_socket" }\n${ind}${s}},\n${ind}${s}"entries": []\n${ind}}`;
        });
      });
    case 'browseSymbols': {
      const file = await pickFile(uri, 'Select an ELF file with debug symbols (for example vmlinux)', true);
      if (!file) return undefined;
      if (!images.isElf(file)) {
        vscode.window.showWarningMessage(`${path.basename(file)} is not an ELF file, so a debugger cannot read symbols from it.`);
        return undefined;
      }
      const value = JSON.stringify([images.toTemplate(file, topDir)]);
      return editPlatform(uri, (text, data) => (data.debug && typeof data.debug === 'object'
        ? jsonedit.setProperty(text, ['debug'], 'symbols', () => value)
        : jsonedit.setProperty(text, [], 'debug', () => `{ "symbols": ${value} }`)));
    }
    case 'clearSymbols':
      return editPlatform(uri, (text) => jsonedit.removeProperty(text, [], 'debug'));
    default:
      return undefined;
  }
}

Object.assign(exports, { editPlatform, cmdAddModule, handleFormMessage });
