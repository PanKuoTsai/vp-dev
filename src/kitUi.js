'use strict';
// Delivery kits (G-09): Export Kit and Open Kit.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const pin = require('../lib/setup/pin');
const kit = require('../lib/setup/kit');
const shared = require('./shared');
const common = require('./common');
const catalogUi = require('./catalogUi');
const platformFiles = require('./platformFiles');
const qboxUi = require('./qboxUi');
const simUi = require('./simUi');

const GIB = 1 << 30;

/** Run fn(report, signal) under a cancellable notification; report({ phase, done, total }) moves the bar. */
function withKitProgress(title, fn) {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => {
    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    let shown = 0;
    let phase = '';
    const report = ({ phase: ph, done, total }) => {
      const pct = total ? Math.floor((done / total) * 100) : 0;
      if (ph !== phase) { phase = ph; shown = 0; progress.report({ message: `${ph} 0%` }); }
      if (pct > shown) { progress.report({ increment: 0, message: `${ph} ${pct}%` }); shown = pct; }
    };
    return fn(report, ac.signal);
  });
}

async function cmdExportKit(arg) {
  const uri = await platformFiles.pickPlatform(arg);
  if (!uri) return;
  const textDoc = await vscode.workspace.openTextDocument(uri);
  if (textDoc.isDirty) await textDoc.save();
  const loaded = await platformFiles.load(uri);
  if (!loaded) return;
  let p;
  try {
    p = kit.plan(loaded.data, uri.fsPath, { catalog: catalogUi.catalog(), pinFile: path.join(common.ROOT, 'qbox.pin.json'), bundledTypes: catalogUi.BUNDLED.map((b) => b.type) });
  } catch (e) {
    vscode.window.showErrorMessage(`Cannot make a kit of ${path.basename(uri.fsPath)}: ${e.message}`);
    return;
  }
  if (p.missing.length) {
    const list = p.missing.map((m) => `• ${m.ref}`).join('\n');
    const go = await vscode.window.showWarningMessage(`${p.missing.length} file${p.missing.length > 1 ? 's' : ''} the platform names ${p.missing.length > 1 ? 'do' : 'does'} not exist:`,
      { modal: true, detail: `${list}\n\nThe kit will not boot without ${p.missing.length > 1 ? 'them' : 'it'} unless the receiver adds ${p.missing.length > 1 ? 'them' : 'it'}.` }, 'Export Without Them');
    if (!go) return;
  }
  const items = p.files.map((f) => ({
    label: path.posix.basename(f.path),
    description: `${kit.ROLE_NAMES[f.role] || f.role} · ${kit.fmtSize(f.size)}`,
    detail: f.path,
    picked: f.size < GIB,
    file: f,
  }));
  const chosen = await common.pickMany(items, {
    title: `Export Kit: ${p.name}`,
    placeHolder: 'Files to put in the kit. Unchecked ones are left out; the README gives their size and sha256 so the receiver can add them.',
    ignoreFocusOut: true,
  });
  if (!chosen) return;
  const omit = new Set(p.files.filter((f) => !chosen.some((c) => c.file === f)).map((f) => f.path));
  const urls = {};
  for (const f of p.files.filter((x) => omit.has(x.path))) {
    const url = await vscode.window.showInputBox({
      title: `Left out: ${path.posix.basename(f.path)} (${kit.fmtSize(f.size)})`,
      prompt: 'Where can the receiver get this file? A URL or a note for the README (optional; Enter to skip).',
      ignoreFocusOut: true,
    });
    if (url === undefined) return;
    if (url.trim()) urls[f.path] = url.trim();
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(folder ? folder.uri.fsPath : path.dirname(uri.fsPath), `${p.name}-kit.tar.gz`)),
    filters: { 'VP Studio kit': ['tar.gz', 'tgz'] },
    title: 'Save the kit',
  });
  if (!target) return;
  const file = kit.kitFileName(target.fsPath);
  const { exePath } = simUi.simulatorPath(uri);
  const src = pin.qboxSourceOf(exePath);
  const used = src && pin.gitHead(src.source);
  const t0 = Date.now();
  let m;
  try {
    m = await withKitProgress(`Exporting kit ${p.name}`, (report, signal) => kit.exportKit(p, file, {
      omit, urls, allowMissing: true, signal, onProgress: report,
      vpStudio: shared.extContext && shared.extContext.extension ? shared.extContext.extension.packageJSON.version : undefined,
      qboxUsed: used ? { commit: used } : undefined,
    }));
  } catch (e) {
    vscode.window.showErrorMessage(e.message === 'cancelled' ? 'Kit export cancelled.' : `Kit not written: ${e.message}`);
    return;
  }
  const out = common.outputChannel();
  out.appendLine(`Kit ${file}: ${m.files.length} files, ${kit.fmtSize(m.archive.size)}, in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  for (const x of m.omitted) out.appendLine(`  left out ${x.path} (${kit.fmtSize(x.size)}, sha256 ${x.sha256})${x.url ? ` from ${x.url}` : ''}`);
  for (const x of p.missing) out.appendLine(`  not found ${x.ref}`);
  for (const n of p.notes) out.appendLine(`  note: ${n}`);
  const left = m.omitted.length ? `, ${m.omitted.length} file${m.omitted.length > 1 ? 's' : ''} left out` : '';
  const pick = await vscode.window.showInformationMessage(`Wrote ${path.basename(file)}: ${m.files.length} files, ${kit.fmtSize(m.archive.size)}${left}.`, 'Reveal', 'Details');
  if (pick === 'Reveal') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
  else if (pick === 'Details') out.show(true);
}

async function cmdOpenKit(arg) {
  let archive = arg instanceof vscode.Uri ? arg : undefined;
  if (!archive) {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'VP Studio kit': ['tar.gz', 'tgz', 'tar'] }, title: 'Open a VP Studio kit' });
    if (!picked) return;
    archive = picked[0];
  }
  let head;
  try {
    head = await kit.readManifest(archive.fsPath);
  } catch (e) {
    vscode.window.showErrorMessage(e.message);
    return;
  }
  const ws = (vscode.workspace.workspaceFolders || [])[0];
  const into = await vscode.window.showOpenDialog({
    canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
    defaultUri: ws ? ws.uri : vscode.Uri.file(path.dirname(archive.fsPath)),
    openLabel: `Unpack ${head.top} here`,
    title: `Where to unpack ${head.manifest.name} (a folder ${head.top} is made there)`,
  });
  if (!into) return;
  const unpack = (overwrite) => withKitProgress(`Opening kit ${head.manifest.name}`, (report) => kit.importKit(archive.fsPath, into[0].fsPath, { overwrite, onProgress: report }));
  let r;
  try {
    r = await unpack(false);
  } catch (e) {
    if (e.code !== 'EEXIST') { vscode.window.showErrorMessage(`Kit not opened: ${e.message}`); return; }
    const again = await vscode.window.showWarningMessage(`${e.message}.`, { modal: true, detail: 'Unpacking again overwrites the files of the kit there; other files stay.' }, 'Overwrite');
    if (!again) return;
    try { r = await unpack(true); } catch (e2) { vscode.window.showErrorMessage(`Kit not opened: ${e2.message}`); return; }
  }
  const out = common.outputChannel();
  out.appendLine(`Kit ${head.manifest.name} unpacked to ${r.dir}`);
  if (r.bad.length) {
    for (const b of r.bad) out.appendLine(`  damaged: ${b}`);
    vscode.window.showErrorMessage(`${r.bad.length} file${r.bad.length > 1 ? 's' : ''} of the kit ${r.bad.length > 1 ? 'are' : 'is'} damaged (checksum or size wrong): ${r.bad.slice(0, 3).join(', ')}${r.bad.length > 3 ? ', …' : ''}. Get the kit again.`, 'Details')
      .then((x) => x && out.show(true));
  }
  // The QBox version it was tested with.
  const want = r.manifest.qbox && r.manifest.qbox.commit;
  let local;
  try { local = pin.readPin(path.join(common.ROOT, 'qbox.pin.json')); } catch (e) { local = undefined; }
  if (want && local && local.qbox.commit !== want) {
    out.appendLine(`  the kit was tested with QBox ${pin.short(want)}; this VP Studio pins ${pin.short(local.qbox.commit)}`);
    vscode.window.showWarningMessage(`The kit was tested with QBox ${pin.short(want)}, this VP Studio with ${pin.short(local.qbox.commit)}. It may still work; see qbox/qbox.pin.json in the kit.`);
  }
  // What the receiver has to build or add.
  const cat = catalogUi.catalog();
  for (const t of r.manifest.bundled || []) {
    const b = catalogUi.BUNDLED.find((x) => x.type === t);
    if (b && !fs.existsSync(catalogUi.bundledCatalogFile(b))) {
      vscode.window.showInformationMessage(`The platform uses ${t}, which has not been built on this machine yet.`, `Build ${b.title}`)
        .then((x) => x && vscode.commands.executeCommand(b.command));
    }
  }
  for (const m of r.manifest.models || []) {
    const spec = path.join(r.dir, ...m.spec.split('/'));
    if (cat && cat.modules && cat.modules[m.name]) continue;
    vscode.window.showInformationMessage(`The kit has the model ${m.name}; build it before starting the platform.`, 'Build Model')
      .then((x) => x && qboxUi.cmdBuildModel(vscode.Uri.file(spec)));
  }
  for (const o of kit.omittedReport(r.dir, r.manifest)) {
    if (o.state === 'present') continue;
    out.appendLine(`  ${o.state === 'missing' ? 'to add' : 'wrong size'}: ${o.path} (${kit.fmtSize(o.size)}, sha256 ${o.sha256})${o.url ? ` from ${o.url}` : ''}`);
    omittedPrompt(r.dir, o);
  }
  // Open it.
  const inWs = !!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(r.platform));
  await vscode.window.showTextDocument(vscode.Uri.file(r.platform), { preview: false });
  vscode.commands.executeCommand('vpStudio.showPlatform', vscode.Uri.file(r.platform));
  if (!inWs) {
    const add = await vscode.window.showInformationMessage(`Opened ${path.basename(r.platform)} from ${r.dir}. Add the kit to the workspace, so its models and files are found?`, 'Add to Workspace');
    if (add) vscode.workspace.updateWorkspaceFolders((vscode.workspace.workspaceFolders || []).length, 0, { uri: vscode.Uri.file(r.dir) });
  }
}

/** Ask for a file the kit left out: pick one (checked against the kit's sha256, then copied into place) or see where to get it. */
async function omittedPrompt(dir, o) {
  const name = path.posix.basename(o.path);
  const buttons = ['Locate…', ...(o.url ? ['Where to Get It'] : []), 'Copy Checksum'];
  const pick = await vscode.window.showWarningMessage(
    `The kit leaves out ${name} (${kit.fmtSize(o.size)})${o.state === 'size' ? ', and the file there has the wrong size' : ''}. Add it before starting the platform.`, ...buttons);
  if (pick === 'Copy Checksum') { vscode.env.clipboard.writeText(`${o.sha256}  ${o.path}`); return; }
  if (pick === 'Where to Get It') {
    if (/^https?:\/\//.test(o.url)) vscode.env.openExternal(vscode.Uri.parse(o.url));
    else vscode.window.showInformationMessage(`${name}: ${o.url}`);
    return;
  }
  if (pick !== 'Locate…') return;
  const f = await vscode.window.showOpenDialog({ canSelectMany: false, title: `Locate ${name} (${kit.fmtSize(o.size)})` });
  if (!f) return;
  const src = f[0].fsPath;
  if (fs.statSync(src).size !== o.size) {
    vscode.window.showErrorMessage(`${path.basename(src)} is ${kit.fmtSize(fs.statSync(src).size)}, but the kit expects ${kit.fmtSize(o.size)}. Not copied.`);
    return;
  }
  try {
    await withKitProgress(`Checking and copying ${name}`, async (report, signal) => {
      const ok = await kit.checkOmitted(o, src, (done) => { if (signal.aborted) throw new Error('cancelled'); report({ phase: 'checksum', done, total: o.size }); });
      if (!ok) throw new Error(`${path.basename(src)} is not the file the kit was made with (its sha256 differs)`);
      report({ phase: 'copying', done: 0, total: 1 });
      await fs.promises.mkdir(path.dirname(o.file), { recursive: true });
      await fs.promises.copyFile(src, o.file);
    });
  } catch (e) {
    vscode.window.showErrorMessage(e.message === 'cancelled' ? `${name} not copied.` : `${e.message}.`);
    return;
  }
  vscode.window.showInformationMessage(`Copied ${name} into the kit.`);
}

Object.assign(exports, { cmdExportKit, cmdOpenKit });
