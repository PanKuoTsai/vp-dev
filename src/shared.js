'use strict';
// What the extension remembers while it runs: the views and panels it made, the running simulation and
// the sim agent connection. One object, so every file sees the same values.
module.exports = {
  // the extension as a whole
  diagnostics: undefined,
  terminal: undefined,
  statusItem: undefined,
  menuItem: undefined, // "VP Studio" in the status bar: the menu
  routeSeq: 0,
  extContext: undefined,
  runningPlatform: undefined, // uri of the platform the current simulation was started from
  simRunning: false, // a simulation started from VP Studio is running (setRunning)
  agentClosing: false, // VP Studio itself is closing the agent connection (disconnectAgent)
  runningDoc: undefined, // its description as started
  runningBuses: [], // the routers the agent's bus_N sockets are bound to
  runningRemote: undefined, // {host, ...} while the running simulation is on a remote host (F-03)
  runningOverrides: [], // parameter overrides of the running simulation (its disk images, for checkpoints)
  restoreReported: false, // a failed restore was shown
  versionOutput: undefined,

  // catalogUi
  catalogCache: { file: null, mtime: 0, data: undefined, warned: null },
  // Models built with the modeling wizard join the catalog, so platforms can
  // use them like QBox's own modules. The list of their catalog files is kept
  // up to date by refreshModelCatalogs (file watchers), so catalog() stays sync.
  modelCatalogFiles: [],
  mergedCache: null, // { base, key, catalog }
  clashWarned: new Set(),
  modelSpecs: [], // [{file, spec}] of the workspace's models, for the register view
  workspaceRegisterFiles: [], // the workspace's *.registers.json, for the register view

  // modelUi
  modelDiagnostics: undefined,

  // qboxUi
  qboxPanel: undefined,
  qboxForm: null,
  qboxDirty: { src: null, value: null },

  // askpassUi
  askpassServer: undefined, // { port, token, close } once started
  askpassStarting: undefined,
  askpassLauncher: undefined,
  askpassError: undefined, // why it could not start (shown instead of "try again")

  // agentUi
  agent: undefined, // connected SimAgentClient
  agentAttempt: 0, // bumped to cancel a pending connection attempt
  agentStatus: undefined, // last sim.getStatus result
  agentMethods: [], // methods the connected agent offers (agent.getInfo)
  agentPoll: undefined,
  agentItem: undefined,
  agentLibWarned: false,
  paramTree: undefined,

  // traceUi
  tracePanel: undefined,
  traceTitle: 'Transaction Trace',
  traceSince: 0,
  traceTimer: undefined,
  traceRecords: [], // kept for CSV export, newest last
  tracePoints: [],
  traceProbes: [], // [{name, kind, recording}] of the running simulation (agent 0.9.0)
  traceDropped: 0, // records the simulator discarded before they were read
  // Bus breakpoints, kept for the workspace so they apply again to the next run.
  // Each: the break.set object plus its id. Only those on a traced point (or on
  // any point) are sent to the agent.
  traceBreaks: undefined,
  oldAgentWarned: undefined, // the agent connection already told it is too old

  // ftraceUi
  ftraceStatusMessage: undefined, // the status bar message while recording

  // profileUi
  profilePanel: undefined,
  profileTimer: undefined,
  profileState: {}, // { uri, offset (KASLR, BigInt), offsetAt }
  profileCpu: '',
  profileSymbols: undefined, // { file, mtime, symbols } | { file, error }

  // registersUi
  registerTree: undefined,

  // linuxUi
  guestTree: undefined,

  // debugUi
  cpuRegsView: undefined,

  // perfUi
  perfPanel: undefined,
  perfLast: undefined, // {kind: 'run', uri} or {kind: 'sweep', file}: what Run Again repeats
  perfShown: undefined, // the message the panel shows, re-sent when it reloads
  perfDir: undefined, // folder of the results shown (Results button)
  perfAbort: undefined, // {aborted, onAbort} of the running experiment or sweep

  // menuUi
  actionsTree: undefined,
  commandTitles: undefined,
};
