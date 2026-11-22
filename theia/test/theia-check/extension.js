'use strict';
// Test only. Inside Theia: activate VP Studio, list its commands, open the
// platform named by VPS_CHECK_PLATFORM, read its diagnostics, open the
// platform view, run Check QBox Version, and write the findings as JSON to
// VPS_CHECK_OUT.
const vscode = require('vscode');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
exports.activate = async () => {
  const out = process.env.VPS_CHECK_OUT;
  const platform = process.env.VPS_CHECK_PLATFORM;
  if (!out || !platform) return;
  const r = { steps: [] };
  const step = (name, data) => { r.steps.push(Object.assign({ name }, data)); fs.writeFileSync(out, JSON.stringify(r, null, 2)); };
  try {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'vp-studio');
    step('extension found', { id: ext && ext.id, version: ext && ext.packageJSON.version });
    await ext.activate();
    step('activated', { isActive: ext.isActive });
    const cmds = (await vscode.commands.getCommands(true)).filter((c) => c.startsWith('vpStudio.')).sort();
    step('commands', { count: cmds.length, commands: cmds });
    const uri = vscode.Uri.file(platform);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    await sleep(4000);
    const diags = vscode.languages.getDiagnostics(uri).map((d) => `${['error', 'warning', 'info', 'hint'][d.severity]}: ${d.message} [${d.source}]`);
    step('diagnostics', { count: diags.length, diags });
    await vscode.commands.executeCommand('vpStudio.showPlatform', uri);
    await sleep(3000);
    step('platform view', { tabs: vscode.window.tabGroups ? vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label)) : 'n/a' });
    await vscode.commands.executeCommand('vpStudio.checkQBox');
    step('check qbox version', {});
    const debugTypes = vscode.extensions.all.filter((e) => (e.packageJSON.contributes || {}).debuggers).map((e) => `${e.id}: ${e.packageJSON.contributes.debuggers.map((d) => d.type).join(',')}`);
    step('debuggers', { debugTypes });
    if (process.env.VPS_CHECK_BUILD) {
      // Build Sim Agent from inside the application: it must write to the
      // user data folder, since the application folder may be read-only.
      const t0 = Date.now();
      await vscode.commands.executeCommand('vpStudio.buildSimAgent');
      step('build sim agent', { seconds: Math.round((Date.now() - t0) / 1000) });
    }
    if (process.env.VPS_CHECK_PERF) {
      // A performance run and sweep (VPS_CHECK_PERF: the sweep file; the platform is VPS_CHECK_PLATFORM).
      const t0 = Date.now();
      await vscode.commands.executeCommand('vpStudio.perf.run', uri);
      const tabs = () => (vscode.window.tabGroups ? vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label)) : []);
      step('perf run', { seconds: (Date.now() - t0) / 1000, tabs: tabs() });
      const t1 = Date.now();
      await vscode.commands.executeCommand('vpStudio.perf.sweep', vscode.Uri.file(process.env.VPS_CHECK_PERF));
      step('perf sweep', { seconds: (Date.now() - t1) / 1000, tabs: tabs() });
    }
    step('done', {});
  } catch (e) {
    step('error', { message: String(e && e.stack || e) });
  }
};
