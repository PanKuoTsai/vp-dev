'use strict';
// Modeling wizard: model descriptions, their diagnostics, New Model and Import IP-XACT.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const jsonedit = require('../lib/platform/jsonedit');
const modelgen = require('../lib/generate/modelgen');
const models = require('../lib/generate/models');
const registers = require('../lib/analysis/registers');
const ipxact = require('../lib/generate/ipxact');
const shared = require('./shared');
const common = require('./common');
const catalogUi = require('./catalogUi');
const qboxUi = require('./qboxUi');

const MODEL_SUFFIX = '.model.json';
const isModel = (doc) => !!doc && doc.fileName.endsWith(MODEL_SUFFIX);

/** Problems of a model description, placed on the JSON property they are about. */
function refreshModelDiagnostics(textDoc) {
  if (!isModel(textDoc)) return;
  const text = textDoc.getText();
  let spec;
  try { spec = JSON.parse(text); } catch (e) { shared.modelDiagnostics.delete(textDoc.uri); return; }
  const { problems } = modelgen.check(spec);
  let root;
  try { root = jsonedit.scan(text); } catch (e) { root = null; }
  const sev = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning };
  shared.modelDiagnostics.set(textDoc.uri, problems.map((p) => {
    // "registers[2].offset" -> ["registers", 2, "offset"]; fall back to the closest found.
    const keys = String(p.path || '').split(/[.[\]]/).filter(Boolean).map((k) => (/^\d+$/.test(k) ? Number(k) : k));
    let node = null;
    for (let n = keys.length; n > 0 && root && !node; n--) node = jsonedit.find(root, keys.slice(0, n));
    const at = node ? node.start : 0;
    const d = new vscode.Diagnostic(textDoc.lineAt(textDoc.positionAt(at).line).range, p.message, sev[p.severity]);
    d.source = 'VP Studio';
    return d;
  }));
}

async function pickModel(arg) {
  if (arg instanceof vscode.Uri) return arg;
  const ed = vscode.window.activeTextEditor;
  if (ed && isModel(ed.document)) return ed.document.uri;
  const found = await vscode.workspace.findFiles('**/*' + MODEL_SUFFIX, '**/node_modules/**', 50);
  if (!found.length) { vscode.window.showWarningMessage('No *.model.json in this workspace. Run "VP Studio: New Model…" first.'); return undefined; }
  if (found.length === 1) return found[0];
  const sel = await vscode.window.showQuickPick(found.map((u) => ({ label: vscode.workspace.asRelativePath(u), u })), { placeHolder: 'Which model?' });
  return sel && sel.u;
}

/** Write the model's C++ (generated files every time, starter files once). */
async function generateModel(uri, quiet) {
  const textDoc = await vscode.workspace.openTextDocument(uri);
  let spec;
  try { spec = JSON.parse(textDoc.getText()); } catch (e) {
    if (!quiet) vscode.window.showErrorMessage(`${path.basename(uri.fsPath)} is not valid JSON: ${e.message}`);
    return undefined;
  }
  try {
    const r = models.writeFiles(uri.fsPath, spec);
    if (!quiet || r.written.length) {
      vscode.window.setStatusBarMessage(`VP Studio: ${r.written.length ? 'wrote ' + r.written.join(', ') : 'model code is up to date'}`, 8000);
    }
    return r;
  } catch (e) {
    if (!quiet) vscode.window.showErrorMessage(`Model code not generated: ${e.message.split('\n')[0]}${e.message.includes('\n') ? ' (see the Problems panel)' : ''}`);
    return undefined;
  }
}

async function cmdNewModel() {
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  if (!folder) { vscode.window.showWarningMessage('Open a folder first.'); return; }
  const name = await vscode.window.showInputBox({
    title: 'New Model', prompt: 'Name of the module type (also the C++ class name)', value: 'my_device',
    validateInput: (v) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim()) ? undefined : 'Use letters, digits and _, not starting with a digit.'),
  });
  if (!name) return;
  const n = name.trim();
  const cat = catalogUi.catalog();
  if (cat && cat.modules && cat.modules[n] && !cat.modules[n].model) {
    vscode.window.showErrorMessage(`${n} is already a QBox module type; choose another name.`);
    return;
  }
  const def = vscode.Uri.joinPath(folder.uri, 'models', n);
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: folder.uri,
    openLabel: 'Create Here', title: `Folder to create the model folder ${n} in (default: models/)`,
  });
  const dir = picked && picked[0] ? vscode.Uri.joinPath(picked[0], n) : def;
  const spec = path.join(dir.fsPath, n + MODEL_SUFFIX);
  if (fs.existsSync(spec)) { vscode.window.showErrorMessage(`${vscode.workspace.asRelativePath(spec)} already exists.`); return; }
  await fs.promises.mkdir(dir.fsPath, { recursive: true });
  await fs.promises.writeFile(spec, JSON.stringify(modelgen.template(n), null, 2) + '\n', 'utf8');
  models.writeFiles(spec, modelgen.template(n));
  await vscode.window.showTextDocument(vscode.Uri.file(spec), { preview: false });
  vscode.window.showTextDocument(vscode.Uri.file(path.join(dir.fsPath, 'include', n + '.h')), { preview: false, viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
  vscode.window.showInformationMessage(`Created model ${n}. Edit the registers, parameters and ports in ${n}.model.json (saving regenerates ${n}_regs.h), add behaviour in ${n}.h, then run "Build Model".`, 'Build Model')
    .then((p) => p && qboxUi.cmdBuildModel(vscode.Uri.file(spec)));
}

/**
 * Import IP-XACT… (G-10): the register map of an IP-XACT component becomes a
 * new model, the registers of an existing model, or a register description
 * (*.registers.json) of a platform module type for the Peripheral Registers view.
 */
async function cmdImportIpxact(arg) {
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  if (!folder) { vscode.window.showWarningMessage('Open a folder first.'); return; }
  let file = arg instanceof vscode.Uri ? arg.fsPath : undefined;
  if (!file) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false, defaultUri: folder.uri, openLabel: 'Import', title: 'IP-XACT component to import',
      filters: { 'IP-XACT': ['xml', 'ipxact', 'spirit'], 'All files': ['*'] },
    });
    if (!picked || !picked[0]) return;
    file = picked[0].fsPath;
  }
  const doc = ipxact.parse(await fs.promises.readFile(file, 'utf8'));
  const usable = doc.blocks.filter((b) => b.registers.length);
  if (!usable.length) {
    throw new Error(`${path.basename(file)} has no address block with registers${doc.notes.length ? ': ' + doc.notes.join(' ') : ''}`);
  }
  let block = usable[0];
  if (usable.length > 1) {
    const sel = await vscode.window.showQuickPick(usable.map((b) => ({ label: b.key, description: ipxact.blockSummary(b), detail: b.description || undefined, b })),
      { title: `Import IP-XACT: ${doc.vlnv.name || path.basename(file)}`, placeHolder: 'Which address block?' });
    if (!sel) return;
    block = sel.b;
  }
  const modelFiles = await vscode.workspace.findFiles('**/*' + MODEL_SUFFIX, '**/node_modules/**', 100);
  const choices = [
    { label: 'New model', detail: 'Create a modeling-wizard model with these registers; add behaviour, parameters and ports, then Build Model.', kind: 'new' },
  ];
  if (modelFiles.length) choices.push({ label: 'Replace the registers of a model…', detail: 'Keep its parameters, ports and your C++; regenerate the register code.', kind: 'update' });
  choices.push({ label: 'Register description for a module type…', detail: 'For a module that already exists (a QBox or QEMU device): the Peripheral Registers view then shows its registers.', kind: 'desc' });
  const what = await vscode.window.showQuickPick(choices, { title: `Import ${block.key} (${ipxact.blockSummary(block)})`, placeHolder: 'Import as' });
  if (!what) return;

  const report = () => {
    const out = common.outputChannel();
    out.appendLine(`Imported IP-XACT ${file} (${doc.standard}), address block ${block.key}: ${ipxact.blockSummary(block)}`);
    for (const n of doc.notes.concat(block.notes)) out.appendLine(`  note: ${n}`);
    const count = doc.notes.length + block.notes.length;
    return count ? ` ${count} note${count === 1 ? '' : 's'} on what was not imported as-is: see the VP Studio output.` : '';
  };

  if (what.kind === 'new') {
    const cat = catalogUi.catalog();
    const name = await vscode.window.showInputBox({
      title: 'Import IP-XACT: new model', prompt: 'Name of the module type (also the C++ class name)', value: ipxact.modelNameFor(doc, block),
      validateInput: (v) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim())) return 'Use letters, digits and _, not starting with a digit.';
        if (modelgen.RESERVED.has(v.trim())) return `${v.trim()} cannot be used as a name.`;
        if (cat && cat.modules && cat.modules[v.trim()] && !cat.modules[v.trim()].model) return `${v.trim()} is already a QBox module type.`;
        return undefined;
      },
    });
    if (!name) return;
    const n = name.trim();
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: folder.uri,
      openLabel: 'Create Here', title: `Folder to create the model folder ${n} in (default: models/)`,
    });
    const dir = picked && picked[0] ? path.join(picked[0].fsPath, n) : path.join(folder.uri.fsPath, 'models', n);
    const specFile = path.join(dir, n + MODEL_SUFFIX);
    if (fs.existsSync(specFile)) throw new Error(`${vscode.workspace.asRelativePath(specFile)} already exists; use "Replace the registers of a model…"`);
    const { spec, problems } = ipxact.toModel(doc, block, { name: n });
    const errors = problems.filter((p) => p.severity === 'error');
    if (errors.length) throw new Error(errors.map((e) => e.message).join(' '));
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(specFile, JSON.stringify(spec, null, 2) + '\n', 'utf8');
    models.writeFiles(specFile, spec);
    await vscode.window.showTextDocument(vscode.Uri.file(specFile), { preview: false });
    vscode.window.showInformationMessage(`Created model ${n} with ${spec.registers.length} registers from ${path.basename(file)}. Add parameters and signal ports in ${n}.model.json, behaviour in ${n}.h, then run "Build Model".${report()}`, 'Build Model')
      .then((p) => p && qboxUi.cmdBuildModel(vscode.Uri.file(specFile)));
    return;
  }

  if (what.kind === 'update') {
    let target = modelFiles[0];
    if (modelFiles.length > 1) {
      const sel = await vscode.window.showQuickPick(modelFiles.map((u) => ({ label: vscode.workspace.asRelativePath(u), u })), { placeHolder: 'Replace the registers of which model?' });
      if (!sel) return;
      target = sel.u;
    }
    const existing = JSON.parse(await fs.promises.readFile(target.fsPath, 'utf8'));
    const old = (existing.registers || []).length;
    const ok = await vscode.window.showWarningMessage(`Replace the ${old} register${old === 1 ? '' : 's'} of ${existing.name} with the ${block.registers.length} of ${block.key}? Parameters, ports and the files you edit (${existing.name}.h, .cc) stay; hooks for registers that no longer exist will not compile until you remove them.`,
      { modal: true }, 'Replace');
    if (ok !== 'Replace') return;
    const { spec, problems } = ipxact.toModel(doc, block, { existing });
    const errors = problems.filter((p) => p.severity === 'error');
    if (errors.length) throw new Error(errors.map((e) => e.message).join(' '));
    await fs.promises.writeFile(target.fsPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
    models.writeFiles(target.fsPath, spec);
    await vscode.window.showTextDocument(target, { preview: false });
    vscode.window.showInformationMessage(`${existing.name} now has the ${spec.registers.length} registers of ${block.key}; ${existing.name}_regs.h is regenerated.${report()}`, 'Build Model')
      .then((p) => p && qboxUi.cmdBuildModel(target));
    return;
  }

  // A register description of an existing module type.
  const cat = catalogUi.catalog();
  const types = Object.entries((cat && cat.modules) || {})
    .filter(([, m]) => !m.isContainer && ((m.introspection && m.introspection.ports) || []).some((p) => p.kind === 'tlm_target'))
    .map(([t, m]) => ({ label: t, description: m.model ? 'model' : (m.source || '').split('/').slice(0, 2).join('/'), t, m }));
  const ty = await vscode.window.showQuickPick(types, { title: `Registers of ${block.key} describe which module type?`, placeHolder: 'Module type (with a bus target port)', matchOnDescription: true });
  if (!ty) return;
  const ports = ty.m.introspection.ports.filter((p) => p.kind === 'tlm_target');
  let port = ports[0].name;
  if (ports.length > 1) {
    const sel = await vscode.window.showQuickPick(ports.map((p) => ({ label: p.name })), { placeHolder: `Which bus port of ${ty.t} has these registers?` });
    if (!sel) return;
    port = sel.label;
  }
  const out = path.join(folder.uri.fsPath, 'registers', `${ty.t}${port === 'target_socket' ? '' : '.' + port}.registers.json`);
  if (fs.existsSync(out)) {
    const ok = await vscode.window.showWarningMessage(`${vscode.workspace.asRelativePath(out)} exists. Replace it?`, { modal: true }, 'Replace');
    if (ok !== 'Replace') return;
  }
  const desc = ipxact.toDescription(doc, block, { types: [ty.t], port });
  registers.expand(desc, path.basename(out)); // throws on a description the view could not use
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  await fs.promises.writeFile(out, JSON.stringify(desc, null, 2) + '\n', 'utf8');
  await catalogUi.refreshModelCatalogs();
  await vscode.window.showTextDocument(vscode.Uri.file(out), { preview: false });
  vscode.window.showInformationMessage(`Wrote ${vscode.workspace.asRelativePath(out)}: the Peripheral Registers view shows these ${desc.registers.length} registers for every ${ty.t} on a bus.${report()}`);
}

Object.assign(exports, { isModel, refreshModelDiagnostics, pickModel, generateModel, cmdNewModel, cmdImportIpxact });
