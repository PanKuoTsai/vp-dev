'use strict';
// Checkpoints (G-08): Save Checkpoint and Start from Checkpoint.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const simagent = require('../lib/sim/simagent');
const pin = require('../lib/setup/pin');
const checkpoint = require('../lib/sim/checkpoint');
const shared = require('./shared');
const common = require('./common');
const catalogUi = require('./catalogUi');
const platformFiles = require('./platformFiles');
const simUi = require('./simUi');

async function cmdSaveCheckpoint() {
  if (shared.runningRemote) {
    vscode.window.showWarningMessage(`Checkpoints of remote simulations are not supported yet: the checkpoint files and disk copies would be on ${shared.runningRemote.host}.`);
    return;
  }
  if (!shared.agent || !shared.runningPlatform || !shared.runningDoc) {
    vscode.window.showWarningMessage('Save Checkpoint needs a simulation started with "VP Studio: Start Simulation" and its sim agent connected.');
    return;
  }
  let info;
  try { info = await shared.agent.request('agent.getInfo'); } catch (e) { vscode.window.showErrorMessage(`The sim agent did not answer: ${e.message}`); return; }
  if (!(info.methods || []).includes('ckpt.save')) {
    vscode.window.showErrorMessage(`This sim agent (${info.version}) cannot save checkpoints; it needs ${checkpoint.MIN_AGENT}. Rebuild it with "VP Studio: Build Sim Agent" and start the simulation again.`);
    return;
  }
  if (info.checkpoints === false) {
    const pick = await vscode.window.showErrorMessage(
      "This QBox's libqemu does not save the state of its devices (GIC, virtio, …), so a checkpoint would not run.", {
        modal: true,
        detail: 'Apply VP Studio\'s patches/libqemu/0001-register-device-vmstate.patch in libqemu\'s sources (QBox\'s build/_deps/libqemu-src, or libqemu_SOURCE_DIR in build/CMakeCache.txt when QBox uses a CPM source cache) with git apply and rebuild QBox (cmake --build build), or build QBox with tools/qbox-pin/build-qbox.sh.',
      }, 'Check QBox Version');
    if (pick) vscode.commands.executeCommand('vpStudio.checkQBox');
    return;
  }
  const root = checkpoint.rootFor(shared.runningPlatform.fsPath);
  const name = await vscode.window.showInputBox({
    title: 'Save Checkpoint',
    prompt: `Name of the checkpoint (a folder in ${vscode.workspace.asRelativePath(root)})`,
    value: checkpoint.defaultName(shared.runningDoc),
    validateInput: (v) => (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v) ? undefined : 'Letters, digits, ".", "_" and "-"'),
  });
  if (!name) return;
  const dir = path.join(root, name);
  if (fs.existsSync(dir)) {
    const ok = await vscode.window.showWarningMessage(`A checkpoint ${name} exists already.`, { modal: true }, 'Replace');
    if (ok !== 'Replace') return;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  let p;
  try {
    p = checkpoint.plan(shared.runningDoc, {
      catalog: catalogUi.catalog(), descs: shared.registerTree.descriptions().descs, buses: shared.runningBuses,
      topDir: path.dirname(shared.runningPlatform.fsPath), overrides: shared.runningOverrides,
    });
  } catch (e) {
    vscode.window.showErrorMessage(`Cannot save a checkpoint: ${e.message}`);
    return;
  }
  if (p.unsaved.length) {
    const list = p.unsaved.map((u) => `• ${u.instance} (${u.type})`).join('\n');
    const go = await vscode.window.showWarningMessage(`The state of ${p.unsaved.length} SystemC model${p.unsaved.length > 1 ? 's' : ''} is not saved.`, {
      modal: true, detail: `${list}\n\nThey start from their reset state when the checkpoint is loaded, which may make the guest misbehave.`,
    }, 'Save Anyway');
    if (go !== 'Save Anyway') return;
  }
  const { exePath } = simUi.simulatorPath(shared.runningPlatform);
  const src = pin.qboxSourceOf(exePath);
  const t0 = Date.now();
  let m;
  try {
    m = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Saving checkpoint ${name}` }, (progress) =>
      checkpoint.save(shared.agent, dir, p, {
        name, platformFile: shared.runningPlatform.fsPath, platformText: fs.readFileSync(shared.runningPlatform.fsPath, 'utf8'),
        qboxCommit: src ? pin.gitHead(src.source) : undefined, agentVersion: info.version,
      }, { onPhase: (what) => progress.report({ message: what }) }));
  } catch (e) {
    vscode.window.showErrorMessage(`The checkpoint was not saved: ${e.message}`);
    return;
  }
  const out = common.outputChannel();
  out.appendLine(`Checkpoint ${dir}: simulated ${m.time.text}, ${checkpoint.fmtSize(checkpoint.diskUsage(dir))}, saved in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const s of p.skipped) out.appendLine(`  not saved: ${s.instance} (${s.why})`);
  const pick = await vscode.window.showInformationMessage(
    `Saved checkpoint ${name} at ${simagent.formatTime(m.time.seconds)} (${checkpoint.fmtSize(checkpoint.diskUsage(dir))}).`, 'Reveal', 'Details');
  if (pick === 'Reveal') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(dir, checkpoint.MANIFEST)));
  else if (pick === 'Details') out.show(true);
}

async function cmdStartFromCheckpoint(arg) {
  const uri = await platformFiles.pickPlatform(arg);
  if (!uri) return;
  const found = checkpoint.list(checkpoint.rootFor(uri.fsPath), uri.fsPath);
  if (!found.length) {
    vscode.window.showInformationMessage(`No checkpoints of ${path.basename(uri.fsPath)} yet. Start the simulation, bring the guest to the point you want, and run "VP Studio: Save Checkpoint…".`);
    return;
  }
  const pick = await vscode.window.showQuickPick(found.map((c) => ({
    label: c.manifest.name,
    description: c.manifest.time ? `at ${simagent.formatTime(c.manifest.time.seconds)}` : '',
    detail: `saved ${new Date(c.manifest.created).toLocaleString()} · ${checkpoint.fmtSize(checkpoint.diskUsage(c.dir))}`,
    c,
  })), { title: `Start ${path.basename(uri.fsPath, common.SUFFIX)} from a checkpoint`, placeHolder: 'The guest goes on from where the checkpoint was saved; its disk images are copied first' });
  if (!pick) return;
  const how = await vscode.window.showQuickPick([
    { label: 'Start', debug: false },
    { label: 'Start with Target Debug Port', debug: true, description: 'to attach a debugger' },
  ], { title: `Start from ${pick.c.manifest.name}` });
  if (!how) return;
  await simUi.start(uri, how.debug, [], { restore: { dir: pick.c.dir, manifest: pick.c.manifest } });
}

exports.cmdSaveCheckpoint = cmdSaveCheckpoint;
exports.cmdStartFromCheckpoint = cmdStartFromCheckpoint;
