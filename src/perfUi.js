'use strict';
// Performance experiments (architecture exploration): the panel, one run, sweeps.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const models = require('../lib/generate/models');
const perf = require('../lib/analysis/perf');
const perfview = require('../lib/webview/perfview');
const shared = require('./shared');
const common = require('./common');
const catalogUi = require('./catalogUi');
const platformFiles = require('./platformFiles');
const simUi = require('./simUi');

function showPerfPanel(title) {
  if (shared.perfPanel) {
    shared.perfPanel.title = title;
    shared.perfPanel.reveal(undefined, false);
    return;
  }
  shared.perfPanel = vscode.window.createWebviewPanel('vpStudio.perf', title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  const nonce = crypto.randomBytes(16).toString('hex');
  shared.perfPanel.webview.html = perfview.render(nonce, shared.perfPanel.webview.cspSource, title);
  shared.perfPanel.onDidDispose(() => { shared.perfPanel = undefined; });
  shared.perfPanel.webview.onDidReceiveMessage((m) => perfMessage(m).catch((e) => vscode.window.showErrorMessage(`Performance: ${e.message}`)));
}

const postPerf = (m) => { if (shared.perfPanel) shared.perfPanel.webview.postMessage(m); };

function perfStatus(kind, text, running, warn) {
  perfStatus.last = { type: 'status', kind, text, running: !!running, warn: warn === undefined ? '' : warn };
  postPerf(perfStatus.last);
}

async function perfMessage(m) {
  if (m.type === 'ready') {
    if (perfStatus.last) postPerf(perfStatus.last);
    if (shared.perfShown) postPerf(shared.perfShown);
    return;
  }
  if (m.type !== 'command') return;
  if (m.command === 'stop' && shared.perfAbort) {
    shared.perfAbort.aborted = true;
    if (shared.perfAbort.onAbort) shared.perfAbort.onAbort();
  } else if (m.command === 'rerun' && shared.perfLast) {
    if (shared.perfLast.kind === 'run') await cmdPerfRun(shared.perfLast.uri);
    else await cmdPerfSweep(vscode.Uri.file(shared.perfLast.file));
  } else if (m.command === 'reveal' && shared.perfDir) {
    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(shared.perfDir));
  } else if (m.command === 'csv' && shared.perfShown) {
    const isSweep = shared.perfShown.type === 'sweep';
    const name = isSweep ? 'results.csv' : `${path.basename(shared.perfShown.file || 'run', '.json')}.csv`;
    const to = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(shared.perfDir || os.homedir(), name)), filters: { CSV: ['csv'] } });
    if (!to) return;
    await fs.promises.writeFile(to.fsPath, isSweep ? perf.resultsCsv(shared.perfShown.results) : perf.runCsv(shared.perfShown.stats));
    vscode.window.showInformationMessage(`Wrote ${to.fsPath}`);
  }
}

/** The simulator for a performance run, or undefined after saying why not (local QBox with perf.so). */
function perfSimulator(uri) {
  if (common.IS_WINDOWS) { vscode.window.showErrorMessage('Performance experiments run QBox on this machine; VS Code on Windows has no local QBox. Use the vp-run command line on the simulation host (vp-run --perf).'); return undefined; }
  const { cwd, exePath } = simUi.simulatorPath(uri);
  if (!fs.existsSync(exePath)) {
    vscode.window.showErrorMessage(`Simulator executable not found: ${exePath}. Build QBox first, or set "vpStudio.executable".`, 'Build QBox')
      .then((x) => x && vscode.commands.executeCommand('vpStudio.buildQbox'));
    return undefined;
  }
  if (!fs.existsSync(path.join(path.dirname(exePath), `${perf.LIBRARY}.so`))) {
    vscode.window.showErrorMessage(`QBox's build (${path.dirname(exePath)}) has no ${perf.LIBRARY}.so, the performance models. They come with VP Studio's QBox patch 0003: run "VP Studio: Build QBox" with the patches applied.`, 'Build QBox')
      .then((x) => x && vscode.commands.executeCommand('vpStudio.buildQbox'));
    return undefined;
  }
  return { cwd, exePath };
}

/** The platform, checked, for a performance run: {data} or undefined. */
async function perfPlatform(uri) {
  const loaded = await platformFiles.load(uri);
  if (!loaded) return undefined;
  if (!perf.isPerfPlatform(loaded.data)) {
    vscode.window.showErrorMessage(`${path.basename(uri.fsPath)} has no performance models (traffic_gen, at_bus, dram_ctrl, perf_stats). See templates/perf in VP Studio, or "VP Studio: Create Performance Example".`);
    return undefined;
  }
  const errors = catalogUi.analyzeWithCatalog(loaded.data).problems.filter((p) => p.severity === 'error');
  if (errors.length) {
    platformFiles.refreshDiagnostics(loaded.textDoc);
    vscode.window.showErrorMessage(`${path.basename(uri.fsPath)} has ${errors.length} error(s). First: ${errors[0].message}`);
    return undefined;
  }
  return loaded;
}

const perfTimeoutMs = () => Math.max(10, Number(common.cfg().get('perf.timeoutSeconds')) || 600) * 1000;

async function cmdPerfRun(arg) {
  if (shared.perfAbort) { vscode.window.showWarningMessage('A performance run is going on; stop it in the Performance panel first.'); return; }
  const uri = await platformFiles.pickPlatform(arg);
  if (!uri) return;
  const sim = perfSimulator(uri);
  if (!sim) return;
  const loaded = await perfPlatform(uri);
  if (!loaded) return;
  const name = path.basename(uri.fsPath, common.SUFFIX);
  const outDir = path.join(path.dirname(uri.fsPath), 'perf-results');
  const outFile = path.join(outDir, `${name}.perf.json`);
  shared.perfLast = { kind: 'run', uri };
  shared.perfDir = outDir;
  showPerfPanel(`Performance: ${name}`);
  perfStatus('live', 'Running', true);
  const ch = common.outputChannel();
  ch.appendLine(`\n=== Performance run of ${name} (${new Date().toLocaleString()})`);
  shared.perfAbort = { aborted: false };
  let r;
  try {
    r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Performance run: ${name}`, cancellable: true }, (progress, token) => {
      token.onCancellationRequested(() => { shared.perfAbort.aborted = true; if (shared.perfAbort.onAbort) shared.perfAbort.onAbort(); });
      return perf.runExperiment({
        doc: loaded.data, platformFile: uri.fsPath, exe: sim.exePath, cwd: sim.cwd, outFile, timeoutMs: perfTimeoutMs(), signal: shared.perfAbort,
        generateOptions: { libraries: models.libraries(catalogUi.catalog()) }, onOutput: (t) => ch.append(t),
      });
    });
  } finally {
    const aborted = shared.perfAbort.aborted;
    shared.perfAbort = undefined;
    // eslint-disable-next-line no-unsafe-finally -- a stopped run ends here, whatever the simulator reported when it was stopped
    if (aborted) { perfStatus('idle', 'Stopped', false); return; }
  }
  if (r.stats) {
    shared.perfShown = { type: 'run', summary: perf.summary(r.stats), stats: r.stats, platform: path.basename(uri.fsPath), file: outFile };
    postPerf(shared.perfShown);
  }
  if (r.ok) {
    perfStatus('good', `Done in ${r.seconds.toFixed(1)} s`, false);
  } else {
    perfStatus('bad', 'Failed', false, r.error);
    vscode.window.showErrorMessage(`Performance run failed: ${r.error}`, 'Show Output').then((x) => x && ch.show(true));
  }
}

/** The sweep file to run: the argument, the active editor, or one picked from the workspace. */
async function pickSweep(arg) {
  if (arg instanceof vscode.Uri && arg.fsPath.endsWith(perf.SWEEP_SUFFIX)) return arg;
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.fsPath.endsWith(perf.SWEEP_SUFFIX)) {
    if (ed.document.isDirty) await ed.document.save();
    return ed.document.uri;
  }
  const found = await vscode.workspace.findFiles('**/*' + perf.SWEEP_SUFFIX, '**/node_modules/**', 100);
  if (!found.length) {
    const x = await vscode.window.showWarningMessage(`No *${perf.SWEEP_SUFFIX} file in this workspace.`, 'New Performance Sweep…');
    if (x) vscode.commands.executeCommand('vpStudio.perf.newSweep');
    return undefined;
  }
  if (found.length === 1) return found[0];
  const pick = await vscode.window.showQuickPick(found.map((u) => ({ label: path.basename(u.fsPath), description: vscode.workspace.asRelativePath(u), uri: u })), { placeHolder: 'Select a performance sweep' });
  return pick && pick.uri;
}

async function cmdPerfSweep(arg) {
  if (shared.perfAbort) { vscode.window.showWarningMessage('A performance run is going on; stop it in the Performance panel first.'); return; }
  const file = await pickSweep(arg);
  if (!file) return;
  let spec, platformFile, doc;
  try {
    ({ spec, platformFile, doc } = perf.loadSweep(file.fsPath));
  } catch (e) {
    vscode.window.showErrorMessage(`Cannot read the sweep: ${e.message}`);
    return;
  }
  const problems = perf.checkSweep(spec, doc);
  if (problems.length) { vscode.window.showErrorMessage(`${path.basename(file.fsPath)}: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`); return; }
  const puri = vscode.Uri.file(platformFile);
  const sim = perfSimulator(puri);
  if (!sim) return;
  const loaded = await perfPlatform(puri);
  if (!loaded) return;
  const total = perf.runCount(spec);
  const outDir = perf.resultsDir(file.fsPath);
  shared.perfLast = { kind: 'sweep', file: file.fsPath };
  shared.perfDir = outDir;
  const name = path.basename(file.fsPath, perf.SWEEP_SUFFIX);
  showPerfPanel(`Performance: ${name}`);
  perfStatus('live', `Running 0 of ${total}`, true);
  const ch = common.outputChannel();
  ch.appendLine(`\n=== Performance sweep ${name}: ${total} runs into ${outDir}`);
  shared.perfAbort = { aborted: false };
  let results;
  try {
    results = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Performance sweep: ${name}`, cancellable: true }, (progress, token) => {
      token.onCancellationRequested(() => { shared.perfAbort.aborted = true; if (shared.perfAbort.onAbort) shared.perfAbort.onAbort(); });
      return perf.runSweep({
        spec, doc: loaded.data, platformFile, exe: sim.exePath, cwd: sim.cwd, outDir, specFile: file.fsPath, signal: shared.perfAbort,
        jobs: Number(common.cfg().get('perf.jobs')) || undefined,
        timeoutMs: perfTimeoutMs(),
        generateOptions: { libraries: models.libraries(catalogUi.catalog()) },
        onProgress: ({ done, run }) => {
          progress.report({ increment: 100 / total, message: `${done} of ${total}` });
          perfStatus('live', `Running ${done} of ${total}`, true);
          ch.appendLine(`run ${run.index} (${run.label}): ${run.ok ? `ok, ${run.seconds.toFixed(1)} s` : run.error}`);
        },
      });
    });
  } finally {
    shared.perfAbort = undefined;
  }
  shared.perfShown = { type: 'sweep', results };
  postPerf(shared.perfShown);
  const failedRuns = results.runs.filter((r) => !r.ok).length;
  const failedChecks = results.checkResults.filter((c) => !c.ok).length;
  const warn = [failedRuns ? `${failedRuns} run(s) failed (see the table and the VP Studio output)` : '', failedChecks ? `${failedChecks} check(s) failed` : ''].filter(Boolean).join('; ');
  perfStatus(results.cancelled ? 'idle' : warn ? 'warn' : 'good', results.cancelled ? `Stopped after ${results.runs.length} of ${total}` : `${results.runs.length} runs done`, false, warn);
}

async function cmdPerfNewSweep(arg) {
  const uri = await platformFiles.pickPlatform(arg);
  if (!uri) return;
  const loaded = await platformFiles.load(uri);
  if (!loaded) return;
  if (!perf.isPerfPlatform(loaded.data)) { vscode.window.showErrorMessage(`${path.basename(uri.fsPath)} has no performance models (traffic_gen, at_bus, dram_ctrl).`); return; }
  const base = path.basename(uri.fsPath, common.SUFFIX);
  let file = path.join(path.dirname(uri.fsPath), `${base}${perf.SWEEP_SUFFIX}`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(path.dirname(uri.fsPath), `${base}-${n}${perf.SWEEP_SUFFIX}`);
  const spec = perf.sweepTemplate(loaded.data, path.basename(uri.fsPath));
  await fs.promises.writeFile(file, JSON.stringify(spec, null, 2) + '\n');
  await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
  vscode.window.showInformationMessage('Edit the parameters and values to sweep, the metrics to plot and any checks, then run "VP Studio: Run Performance Sweep".');
}

async function cmdPerfOpen(arg) {
  let file = arg instanceof vscode.Uri ? arg.fsPath : undefined;
  if (!file) {
    const pick = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Performance results': ['json'] }, openLabel: 'Open Results' });
    if (!pick || !pick.length) return;
    file = pick[0].fsPath;
  }
  const j = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  shared.perfDir = path.dirname(file);
  if (j && j.format === 'vp-perf-sweep') {
    shared.perfLast = undefined;
    showPerfPanel(`Performance: ${path.basename(path.dirname(file))}`);
    shared.perfShown = { type: 'sweep', results: j };
    perfStatus('idle', 'Saved results', false);
  } else {
    const stats = perf.parseStats(JSON.stringify(j));
    shared.perfLast = undefined;
    showPerfPanel(`Performance: ${path.basename(file, '.json')}`);
    shared.perfShown = { type: 'run', summary: perf.summary(stats), stats, file };
    perfStatus('idle', 'Saved results', false);
  }
  postPerf(shared.perfShown);
}

Object.assign(exports, { cmdPerfRun, cmdPerfSweep, cmdPerfNewSweep, cmdPerfOpen });
