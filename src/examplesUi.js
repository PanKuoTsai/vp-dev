'use strict';
// Create Example Platform and Create Performance Example.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const common = require('./common');
const tutorial = require('../lib/setup/tutorial');
const disklock = require('../lib/sim/disklock');

async function cmdCreateExample(context) {
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  if (!folder) { vscode.window.showWarningMessage('Open the QBox source folder first.'); return; }
  const def = vscode.Uri.joinPath(folder.uri, 'platforms', 'ubuntu', 'ubuntu-aarch64' + common.SUFFIX);
  const target = await vscode.window.showSaveDialog({ defaultUri: def, filters: { 'Platform description': ['json'] },
    title: 'Save next to the firmware folder the platform refers to' });
  if (!target) return;
  const src = path.join(context.extensionPath, 'templates', 'ubuntu-aarch64' + common.SUFFIX);
  const data = JSON.parse(await fs.promises.readFile(src, 'utf8'));
  delete data.$schema; // the extension associates the schema by file name
  await fs.promises.writeFile(target.fsPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  vscode.window.showTextDocument(target);
}

/** The performance examples (templates/perf), copied together; the first is opened. */
const PERF_EXAMPLES = ['ddr-contention.platform.json', 'cpu-outstanding.perfsweep.json', 'ddr-2ch.platform.json', 'ddr-2ch.perfsweep.json',
  'mau-2ddr.platform.json', 'mau-qos.perfsweep.json', 'mau-sysbus.platform.json', 'mau-sysbus.perfsweep.json'];

/** Copy the performance examples (platforms of perf models and their sweeps) into a folder of the workspace. */
async function cmdPerfCreateExample(context) {
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  const pick = await vscode.window.showOpenDialog({
    canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Put the Example Here',
    defaultUri: folder ? folder.uri : undefined, title: 'Folder for the performance examples (one DDR channel, two channels, two DDRs with QoS, a system bus) and their sweeps',
  });
  if (!pick || !pick.length) return;
  const dir = pick[0].fsPath;
  const src = path.join(context.extensionPath, 'templates', 'perf');
  const names = PERF_EXAMPLES;
  const there = names.filter((n) => fs.existsSync(path.join(dir, n)));
  if (there.length) {
    const ok = await vscode.window.showWarningMessage(`${there.join(', ')} ${there.length > 1 ? 'exist' : 'exists'} in ${dir}. Replace?`, { modal: true }, 'Replace');
    if (ok !== 'Replace') return;
  }
  for (const n of names) {
    const data = JSON.parse(await fs.promises.readFile(path.join(src, n), 'utf8'));
    delete data.$schema; // the extension associates the schema by file name
    await fs.promises.writeFile(path.join(dir, n), JSON.stringify(data, null, 2) + '\n', 'utf8');
  }
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, names[0])), { preview: false });
  vscode.window.showInformationMessage('Performance example created. Run it with "VP Studio: Run Performance Experiment", or its sweep with "Run Performance Sweep".');
}

/** The QBox folder for the tutorial: the workspace folder with the Ubuntu platform's files, else one the user picks. */
async function tutorialQbox() {
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const ready = folders.find((f) => tutorial.inspect(f).ok);
  if (ready) return ready;
  const pick = await vscode.window.showOpenDialog({
    canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Use This QBox',
    defaultUri: folders[0] ? vscode.Uri.file(folders[0]) : undefined,
    title: 'QBox folder with the Ubuntu AArch64 platform (platforms/ubuntu/fw/Artifacts)',
  });
  return pick && pick.length ? pick[0].fsPath : undefined;
}

/**
 * Create Tutorial Workspace: the vplogger tutorial next to the Ubuntu
 * platform of a QBox folder: its platform, the programs and their source, the
 * scripts, the architecture model, and TUTORIAL.md; the debugger's source
 * mapping for the programs; and, when the user agrees, the programs written
 * into the guest's disk image.
 */
async function cmdCreateTutorial(context) {
  const qbox = await tutorialQbox();
  if (!qbox) return;
  const st = tutorial.inspect(qbox);
  if (!st.ok) {
    vscode.window.showErrorMessage(`The tutorial runs on the Ubuntu AArch64 platform, but ${st.dir} lacks ${st.missing.join(', ')}. Unpack the Ubuntu images into platforms/ubuntu/fw (INSTALL.md, section 6), then try again.`);
    return;
  }
  const there = tutorial.existing(qbox);
  if (there.length) {
    const ok = await vscode.window.showWarningMessage(`The tutorial exists in ${st.dir}. Replace its files?`, { modal: true, detail: `${there.map((p) => path.basename(p)).join(' and ')} are written again; files you added to the folder are kept.` }, 'Replace');
    if (ok !== 'Replace') return;
  }
  const template = JSON.parse(await fs.promises.readFile(path.join(context.extensionPath, 'templates', 'ubuntu-aarch64' + common.SUFFIX), 'utf8'));
  const made = tutorial.create(path.join(context.extensionPath, 'templates', 'tutorial'), template, qbox, { vmlinux: st.vmlinux });
  // The programs' debug information names /vplogger/vplogger.c: map it to the copy here.
  const c = vscode.workspace.getConfiguration('vpStudio');
  const map = Object.assign({}, c.get('debug.sourceMap') || {}, tutorial.sourceMap(made.folder));
  const target = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await c.update('debug.sourceMap', map, target);
  await common.showMarkdown(path.join(made.folder, 'TUTORIAL.md'));
  await vscode.window.showTextDocument(vscode.Uri.file(made.platformFile), { preview: false, viewColumn: vscode.ViewColumn.Beside });
  const notes = [st.vmlinux ? `kernel symbols: ${path.basename(st.vmlinux)}` : 'no vmlinux in fw/Artifacts: the kernel is debugged without symbols'];
  const install = await vscode.window.showInformationMessage(
    `Tutorial created: ${path.relative(qbox, made.platformFile)} and ${path.relative(qbox, made.folder)}/ (${notes.join('; ')}). Put the tutorial programs into the guest's disk image now?`,
    { modal: true, detail: `Writes /opt/vplogger (three programs and a README) into ${path.relative(qbox, st.image)} with debugfs, without booting it; nothing else in the image changes. Remove them later with install-vplogger.sh --uninstall. The simulation must not be running.` },
    'Install', 'Later');
  if (install === 'Install') await installTutorialPrograms(made, st);
}

/** Run install-vplogger.sh as a task, unless a simulation holds the image. */
async function installTutorialPrograms(made, st) {
  let locked = [];
  try {
    const doc = JSON.parse(fs.readFileSync(made.platformFile, 'utf8'));
    locked = disklock.lockedImages(doc, path.dirname(made.platformFile));
  } catch (e) { /* checked again by the script */ }
  if (locked.length) {
    vscode.window.showErrorMessage(`${path.basename(st.image)} is in use by a simulation. Stop it, then run: bash ${path.join(made.folder, 'install-vplogger.sh')} ${st.image}`);
    return;
  }
  const script = path.join(made.folder, 'install-vplogger.sh');
  const task = new vscode.Task({ type: 'shell', tool: 'vplogger' }, vscode.TaskScope.Workspace, 'Install tutorial programs', 'VP Studio',
    new vscode.ShellExecution('bash', [script, st.image], { cwd: common.taskCwd(made.folder) }), []);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
  const exec = await vscode.tasks.executeTask(task);
  const code = await new Promise((resolve) => {
    const sub = vscode.tasks.onDidEndTaskProcess((e) => { if (e.execution === exec) { sub.dispose(); resolve(e.exitCode); } });
  });
  if (code === 0) vscode.window.showInformationMessage('The tutorial programs are in /opt/vplogger of the guest. Start with act 0 of TUTORIAL.md.');
  else vscode.window.showErrorMessage(`Installing the tutorial programs failed (exit code ${code}); see the terminal.`);
}

exports.cmdCreateExample = cmdCreateExample;
exports.cmdPerfCreateExample = cmdPerfCreateExample;
exports.cmdCreateTutorial = cmdCreateTutorial;
