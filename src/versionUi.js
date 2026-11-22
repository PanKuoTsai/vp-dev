'use strict';
// QBox version: the pin compared with the simulator, the catalog and the sim agent.
const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const pin = require('../lib/setup/pin');
const shared = require('./shared');
const common = require('./common');
const catalogUi = require('./catalogUi');
const simUi = require('./simUi');
const agentUi = require('./agentUi');

function versionReport(exePath) {
  let p;
  try { p = pin.readPin(path.join(common.ROOT, 'qbox.pin.json')); } catch (e) { p = undefined; }
  const lib = agentUi.simAgentLibrary({ quiet: true });
  return pin.versionReport({ pin: p, exePath, catalog: catalogUi.catalog(), agentLib: lib && lib + '.so', studioDir: common.ROOT });
}

/**
 * Warn (without blocking the start) when the simulator, the catalog and the
 * sim agent do not come from the tested QBox commit. "Don't Show Again"
 * silences that exact set of mismatches.
 */
function warnVersions(exePath) {
  let r;
  try { r = versionReport(exePath); } catch (e) { return; }
  const warnings = r.problems.filter((x) => x.level === 'warning');
  if (!warnings.length) return;
  const key = crypto.createHash('sha1').update(warnings.map((w) => w.text).join('\n')).digest('hex');
  const dismissed = shared.extContext ? shared.extContext.globalState.get('vpStudio.versionWarningsDismissed', []) : [];
  if (dismissed.includes(key)) return;
  const more = warnings.length > 1 ? ` (and ${warnings.length - 1} more)` : '';
  vscode.window.showWarningMessage(`VP Studio: ${warnings[0].text}${more}`, 'Details', "Don't Show Again").then((pick) => {
    if (pick === 'Details') showVersionReport(r);
    else if (pick === "Don't Show Again" && shared.extContext) shared.extContext.globalState.update('vpStudio.versionWarningsDismissed', [...dismissed, key].slice(-20));
  });
}

function showVersionReport(r) {
  common.outputChannel().clear();
  shared.versionOutput.appendLine(pin.formatReport(r));
  shared.versionOutput.appendLine('');
  shared.versionOutput.appendLine('To build the tested QBox with a matching sim agent and catalog: tools/qbox-pin/build-qbox.sh <dir>');
  shared.versionOutput.show(true);
}

function cmdCheckQBox() {
  const ed = vscode.window.activeTextEditor;
  const { exePath } = simUi.simulatorPath(ed && common.isPlatform(ed.document) ? ed.document.uri : undefined);
  const r = versionReport(exePath);
  showVersionReport(r);
  const w = r.problems.filter((x) => x.level === 'warning').length;
  vscode.window.showInformationMessage(w ? `QBox version check: ${w} mismatch${w > 1 ? 'es' : ''}; see the VP Studio output.` : `QBox version check: the simulator, catalog and sim agent match${r.pinned && r.simulator && r.simulator.commit === r.pinned ? ' the tested QBox ' + pin.short(r.pinned) : ''}.`);
}

exports.warnVersions = warnVersions;
exports.cmdCheckQBox = cmdCheckQBox;
