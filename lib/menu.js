'use strict';
// The VP Studio menu: the commands in groups, shared by every place that shows
// them: the "VP Studio ▾" menu in the editor title bar (its submenus in
// package.json must equal contributions(); a test checks), the Actions view,
// the status bar menu, and the menu bar of the standalone application
// (theia/vp-studio-menu). Labels are the commands' titles in
// package.json. No VS Code dependency.
//
// `when` uses the context keys the extension sets: vpStudio.running,
// vpStudio.agentConnected, vpStudio.paused, vpStudio.guestDebug, and
// vpStudio.localSim (QBox can run on this machine: not VS Code on Windows,
// which always uses a simulation host), vpStudio.passwordLogin (remote.auth is "password").

const NOT_RUNNING = '!vpStudio.running';
const CONNECTED = 'vpStudio.agentConnected';
const LOCAL = 'vpStudio.localSim';

/** Groups, each a list of sections (a separator between sections). */
const GROUPS = [
  {
    id: 'simulation', label: 'Simulation', icon: 'play',
    sections: [
      [
        { command: 'vpStudio.start', when: NOT_RUNNING },
        { command: 'vpStudio.startDebug', when: NOT_RUNNING },
        { command: 'vpStudio.startTrace', when: NOT_RUNNING },
        { command: 'vpStudio.startProfile', when: NOT_RUNNING },
        { command: 'vpStudio.startFtrace', when: NOT_RUNNING },
        { command: 'vpStudio.startOpenOcd', when: `${NOT_RUNNING} && ${LOCAL}` },
        { command: 'vpStudio.startFromCheckpoint', when: `${NOT_RUNNING} && ${LOCAL}` },
      ],
      [
        { command: 'vpStudio.pause', when: 'vpStudio.agentConnected && !vpStudio.paused' },
        { command: 'vpStudio.continue', when: 'vpStudio.paused' },
        { command: 'vpStudio.runFor', when: CONNECTED },
        { command: 'vpStudio.runUntil', when: CONNECTED },
        { command: 'vpStudio.stop', when: 'vpStudio.running' },
      ],
      [
        { command: 'vpStudio.saveCheckpoint', when: `${CONNECTED} && ${LOCAL}` },
        { command: 'vpStudio.connectAgent', when: '!vpStudio.agentConnected' },
      ],
    ],
  },
  {
    id: 'analysis', label: 'Analysis', icon: 'graph',
    sections: [
      [
        { command: 'vpStudio.showTrace' },
        { command: 'vpStudio.chooseProbes', when: CONNECTED },
      ],
      [
        { command: 'vpStudio.showProfile' },
      ],
      [
        { command: 'vpStudio.ftrace.record', when: CONNECTED },
        { command: 'vpStudio.ftrace.save', when: CONNECTED },
        { command: 'vpStudio.ftrace.convert' },
      ],
      [
        { command: 'vpStudio.showKernelLog', when: 'vpStudio.guestDebug' },
      ],
      [
        { command: 'vpStudio.perf.run', when: LOCAL },
        { command: 'vpStudio.perf.sweep', when: LOCAL },
        { command: 'vpStudio.perf.newSweep' },
        { command: 'vpStudio.perf.open' },
        { command: 'vpStudio.perf.createExample' },
      ],
    ],
  },
  {
    id: 'debug', label: 'Debug', icon: 'debug-alt',
    sections: [
      [
        { command: 'vpStudio.addDebugConfigurations' },
        { command: 'vpStudio.thirdPartyDebuggers' },
      ],
      [
        { command: 'vpStudio.showCpuRegisters' },
        { command: 'vpStudio.mapSources', when: 'vpStudio.guestDebug' },
      ],
    ],
  },
  {
    id: 'platform', label: 'Platform', icon: 'type-hierarchy',
    sections: [
      [
        { command: 'vpStudio.showPlatform' },
        { command: 'vpStudio.addModule' },
      ],
      [
        { command: 'vpStudio.generate' },
        { command: 'vpStudio.generateDeviceTree' },
      ],
      [
        { command: 'vpStudio.createExample' },
        { command: 'vpStudio.exportKit' },
        { command: 'vpStudio.openKit' },
      ],
    ],
  },
  {
    id: 'models', label: 'Models', icon: 'symbol-class',
    sections: [
      [
        { command: 'vpStudio.newModel' },
        { command: 'vpStudio.importIpxact' },
      ],
      [
        { command: 'vpStudio.generateModel' },
        { command: 'vpStudio.buildModel' },
        { command: 'vpStudio.remote.buildModel' },
      ],
    ],
  },
  {
    id: 'setup', label: 'Setup', icon: 'tools',
    sections: [
      [
        { command: 'vpStudio.buildQbox', when: LOCAL },
        { command: 'vpStudio.buildSimAgent', when: LOCAL },
        { command: 'vpStudio.checkQBox', when: LOCAL },
      ],
      [
        { command: 'vpStudio.remote.selectHost' },
        { command: 'vpStudio.remote.check' },
        { command: 'vpStudio.remote.buildSimAgent' },
        { command: 'vpStudio.remote.forgetPassword', when: 'vpStudio.passwordLogin' },
      ],
    ],
  },
];

/**
 * Evaluate a `when` clause over context values: identifiers, !, && and ||
 * (&& binds tighter), as VS Code reads them. An empty clause is true.
 */
function evaluate(when, ctx) {
  if (!when) return true;
  return String(when).split('||').some((alt) => alt.split('&&').every((term) => {
    const t = term.trim();
    if (!/^!?[A-Za-z_][\w.]*$/.test(t)) throw new Error(`unsupported when clause "${when}"`);
    return t.startsWith('!') ? !ctx[t.slice(1)] : !!ctx[t];
  }));
}

/** Every command in the menu, in order. */
const commands = () => GROUPS.flatMap((g) => g.sections.flat().map((i) => i.command));

/**
 * The menu for the current context: [{id, label, icon, items: [{command, label, icon, separatorBefore}]}],
 * without groups left empty. titles: command id -> {title, icon} (package.json).
 */
function visible(ctx, titles) {
  const out = [];
  for (const g of GROUPS) {
    const items = [];
    for (const section of g.sections) {
      let first = true;
      for (const i of section) {
        if (!evaluate(i.when, ctx)) continue;
        const t = titles[i.command] || {};
        items.push({ command: i.command, label: t.title || i.command, icon: t.icon, separatorBefore: first && items.length > 0 });
        first = false;
      }
    }
    if (items.length) out.push({ id: g.id, label: g.label, icon: g.icon, items });
  }
  return out;
}

/** command id -> {title, icon (codicon name without $( ))} from a package.json. */
function titlesFrom(pkg) {
  const out = {};
  for (const c of (pkg.contributes && pkg.contributes.commands) || []) {
    const m = /^\$\(([\w-]+)\)$/.exec(c.icon || '');
    out[c.command] = { title: c.title, icon: m ? m[1] : undefined };
  }
  return out;
}

const MENU_ID = 'vpStudio.menu';
const PLATFORM_FILE = 'resourceFilename =~ /\\.platform\\.json$/';

/** The package.json pieces for the "VP Studio ▾" menu: { submenus, menus }. */
function contributions() {
  const submenus = [{ id: MENU_ID, label: 'VP Studio', icon: '$(circuit-board)' }];
  const menus = { [MENU_ID]: [] };
  GROUPS.forEach((g, gi) => {
    const id = `${MENU_ID}.${g.id}`;
    submenus.push({ id, label: g.label });
    menus[MENU_ID].push({ submenu: id, group: `1_groups@${gi + 1}` });
    menus[id] = [];
    g.sections.forEach((section, si) => section.forEach((i, k) => {
      const entry = { command: i.command };
      if (i.when) entry.when = i.when;
      entry.group = `${si + 1}_section@${k + 1}`;
      menus[id].push(entry);
    }));
  });
  return { submenus, menus, editorTitle: { submenu: MENU_ID, when: PLATFORM_FILE, group: 'navigation@0' } };
}

module.exports = { GROUPS, evaluate, commands, visible, titlesFrom, contributions, MENU_ID, PLATFORM_FILE };
