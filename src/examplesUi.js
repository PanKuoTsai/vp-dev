'use strict';
// Create Example Platform and Create Performance Example.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const common = require('./common');

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

exports.cmdCreateExample = cmdCreateExample;
exports.cmdPerfCreateExample = cmdPerfCreateExample;
