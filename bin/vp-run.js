#!/usr/bin/env node
'use strict';
// vp-run: start a VP Studio platform without the IDE, check its console output,
// and report pass or fail with the exit code. For CI jobs and test scripts.
// See README.md ("Command line and CI") and tools/vp-py for the Python client.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const core = require('../lib/platform/core');
const hostports = require('../lib/sim/hostports');
const simagent = require('../lib/sim/simagent');
const launch = require('../lib/sim/launch');
const kit = require('../lib/setup/kit');
const pin = require('../lib/setup/pin');
const checkpoint = require('../lib/sim/checkpoint');
const registers = require('../lib/analysis/registers');

const ROOT = path.join(__dirname, '..');
/** "module: message", unless the message already starts with the module. */
const where = (p) => (p.module && !String(p.message).startsWith(p.module + ':') ? `${p.module}: ${p.message}` : p.message);
const EXIT = { PASS: 0, FAIL: 1, SIM: 2, SETUP: 3 };
const BUNDLED = []; // module libraries that come with VP Studio: none in this version

const USAGE = `usage: vp-run [options] <platform.json>
       vp-run --export-kit OUT.tar.gz [kit options] <platform.json>
       vp-run --import-kit KIT.tar.gz [--into DIR] [--overwrite]
       vp-run --perf [--out FILE] <platform.json>
       vp-run --perf-sweep SWEEP.perfsweep.json [--out DIR] [--jobs N] [--junit FILE]

Starts the platform, follows its console (UART) and stops it again.
Steps run in the order given:
  --expect REGEX       wait until the console output matches REGEX (JavaScript syntax)
  --send TEXT          type TEXT and Enter on the console
  --send-env NAME      type the value of environment variable NAME and Enter (for passwords:
                       the report and the log show "$NAME", not the value)
Options:
  --qbox DIR           QBox folder, the simulator's working directory (default: .)
  --exe PATH           simulator, relative to --qbox (default: build/platforms-vp)
  --timeout SEC        limit for the whole run, in seconds of real time (default: 600)
  --sim-timeout TIME   fail once simulated time reaches TIME, e.g. "30 s" (needs the sim agent)
  --wait-exit          after the steps, wait for the simulator to end by itself
                       (for example after --send poweroff) instead of stopping it
  --exec CMD           after the steps, run CMD (with sh -c); its exit code decides the result.
                       It gets VP_AGENT_HOST, VP_AGENT_PORT and the platform's host ports
                       (VP_HOST_PORT_SSH for HOST_PORT_SSH, and so on) in its environment
  --snapshot           open the disk images with snapshot=on: the guest's changes are dropped
  --save-checkpoint DIR  after the steps, save a checkpoint of the simulation to DIR (needs the
                       sim agent 0.10.0 and the libqemu patch); --exec and --wait-exit come after it
  --restore DIR        start from the checkpoint in DIR instead of booting. The disk images are
                       copied to DIR/run first; with --snapshot the checkpoint's own are opened
                       with snapshot=on instead (nothing copied, nothing kept)
  --param INST.NAME=VALUE  set a module parameter for this run (VALUE as JSON, or a string)
  --agent PATH|none    sim agent library (default: $VP_SIM_AGENT, then VP Studio's build folders)
  --agent-port N       port for the sim agent (default: a free one)
  --dtc PATH           device tree compiler, when the platform sets devicetree.output (default: dtc)
  --log FILE           also write the console output to FILE
  --junit FILE         write a JUnit XML report to FILE
  --quiet              do not copy the console output to stdout
  -h, --help           show this help
Kits (a platform with its files, for someone else to boot):
  --export-kit FILE    write the platform, every file it names, the QBox pin and model sources to FILE
  --omit PATH          leave out a file (its path in the kit or its name); repeatable. Its size and
                       sha256 go in the kit's README, so the receiver can add it
  --omit-larger MB     leave out every file of at least MB megabytes (for example disk images)
  --url PATH=URL       where to get a left-out file, for the README
  --allow-missing      export even when files the platform names do not exist
  --import-kit FILE    unpack a kit into --into DIR (default: .) and check it against its SHA256SUMS
  --overwrite          unpack even when the kit's folder exists already
Performance experiments (platforms of traffic_gen, at_bus, dram_ctrl, perf_stats; QBox with perf.so):
  --perf               run the platform until every traffic_gen is done, print the figures and
                       write the statistics (JSON) to --out (default: perf-results/<name>.perf.json
                       next to the platform)
  --perf-sweep FILE    run the platform of a sweep file for every combination of its values;
                       results.json, results.csv and run-<n>.json go to --out DIR (default:
                       perf-results/<sweep>-<time> next to the sweep file). With --junit, each
                       check of the sweep is a test case; a failed check or run exits with 1
  --jobs N             runs of a sweep at the same time (default: the sweep's jobs, else half the CPUs)
                       --param BUS.masters.MASTER.KEY=VALUE changes one QoS setting of an at_bus,
                       e.g. --param mau0.masters.display.min_mbps=6000
Exit codes: 0 passed, 1 a step failed or timed out, 2 the simulator failed, 3 setup error.`;

class UsageError extends Error {}

/** Command line to options. Steps keep their order. Throws UsageError. */
function parseArgs(argv) {
  const o = {
    platform: undefined, qbox: '.', exe: 'build/platforms-vp', steps: [], timeout: 600, simTimeout: undefined,
    waitExit: false, exec: undefined, snapshot: false, params: [], agent: undefined, agentPort: undefined,
    dtc: 'dtc', log: undefined, junit: undefined, quiet: false, help: false,
    exportKit: undefined, omit: [], omitLarger: undefined, urls: {}, allowMissing: false,
    importKit: undefined, into: '.', overwrite: false, saveCheckpoint: undefined, restore: undefined,
    perf: false, perfSweep: undefined, out: undefined, jobs: undefined,
  };
  const need = (i, name) => {
    if (i + 1 >= argv.length) throw new UsageError(`${name} needs a value`);
    return argv[i + 1];
  };
  const seconds = (v, name) => {
    const n = Number(v);
    if (!(n > 0) || !isFinite(n)) throw new UsageError(`${name} must be a number of seconds greater than 0`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '--expect': {
        const v = need(i++, a);
        try { o.steps.push({ expect: new RegExp(v, 'm'), source: v }); } catch (e) { throw new UsageError(`--expect ${v}: ${e.message}`); }
        break;
      }
      case '--send': o.steps.push({ send: need(i++, a) }); break;
      case '--send-env': {
        const name = need(i++, a);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new UsageError(`--send-env ${name}: not an environment variable name`);
        o.steps.push({ sendEnv: name });
        break;
      }
      case '--qbox': o.qbox = need(i++, a); break;
      case '--exe': o.exe = need(i++, a); break;
      case '--timeout': o.timeout = seconds(need(i++, a), a); break;
      case '--sim-timeout':
        try { o.simTimeout = simagent.parseSimTime(need(i++, a)); } catch (e) { throw new UsageError(`--sim-timeout: ${e.message}`); }
        if (!(o.simTimeout.seconds > 0)) throw new UsageError('--sim-timeout must be greater than 0');
        break;
      case '--wait-exit': o.waitExit = true; break;
      case '--exec': o.exec = need(i++, a); break;
      case '--snapshot': o.snapshot = true; break;
      case '--save-checkpoint': o.saveCheckpoint = need(i++, a); break;
      case '--restore': o.restore = need(i++, a); break;
      case '--param': {
        const v = need(i++, a);
        const m = /^([^=]+)\.([^.=]+)=(.*)$/s.exec(v); // the value may hold dots and "="
        if (!m) throw new UsageError(`--param ${v}: write INSTANCE.NAME=VALUE, e.g. cpu_0.gdb_port=1234`);
        let value = m[3];
        try { value = JSON.parse(m[3]); } catch (e) { /* a plain string */ }
        o.params.push({ instance: m[1], param: m[2], value });
        break;
      }
      case '--agent': o.agent = need(i++, a); break;
      case '--agent-port': {
        const n = Number(need(i++, a));
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UsageError('--agent-port must be a port number');
        o.agentPort = n;
        break;
      }
      case '--dtc': o.dtc = need(i++, a); break;
      case '--log': o.log = need(i++, a); break;
      case '--junit': o.junit = need(i++, a); break;
      case '--quiet': o.quiet = true; break;
      case '--export-kit': o.exportKit = need(i++, a); break;
      case '--omit': o.omit.push(need(i++, a)); break;
      case '--omit-larger': {
        const n = Number(need(i++, a));
        if (!(n > 0)) throw new UsageError('--omit-larger must be a number of megabytes greater than 0');
        o.omitLarger = n;
        break;
      }
      case '--url': {
        const v = need(i++, a);
        const eq = v.indexOf('=');
        if (eq <= 0) throw new UsageError(`--url ${v}: write PATH=URL`);
        o.urls[v.slice(0, eq)] = v.slice(eq + 1);
        break;
      }
      case '--allow-missing': o.allowMissing = true; break;
      case '--import-kit': o.importKit = need(i++, a); break;
      case '--into': o.into = need(i++, a); break;
      case '--overwrite': o.overwrite = true; break;
      case '--perf': o.perf = true; break;
      case '--perf-sweep': o.perfSweep = need(i++, a); break;
      case '--out': o.out = need(i++, a); break;
      case '--jobs': {
        const n = Number(need(i++, a));
        if (!Number.isInteger(n) || n < 1) throw new UsageError('--jobs must be a whole number of at least 1');
        o.jobs = n;
        break;
      }
      default:
        if (a.startsWith('-')) throw new UsageError(`unknown option ${a}`);
        if (o.platform) throw new UsageError(`only one platform file, not also ${a}`);
        o.platform = a;
    }
  }
  if (o.importKit) {
    if (o.platform) throw new UsageError('--import-kit takes no platform file');
    if (o.exportKit) throw new UsageError('--import-kit and --export-kit cannot be used together');
    return o;
  }
  if (o.perfSweep) {
    if (o.platform) throw new UsageError('--perf-sweep takes the platform from the sweep file; give no platform file');
    if (o.perf || o.exportKit) throw new UsageError('--perf-sweep cannot be used with --perf or --export-kit');
    return o;
  }
  if (!o.help && !o.platform) throw new UsageError('no platform file given');
  if (o.perf && (o.steps.length || o.exec || o.exportKit || o.restore || o.saveCheckpoint)) throw new UsageError('--perf runs until the traffic generators are done; it takes no steps, --exec, kits or checkpoints');
  for (const st of o.steps) {
    if (st.sendEnv !== undefined && process.env[st.sendEnv] === undefined) throw new UsageError(`--send-env ${st.sendEnv}: the variable is not set`);
  }
  if (o.waitExit && o.exec) throw new UsageError('--wait-exit and --exec cannot be used together');
  if (o.saveCheckpoint && o.restore && path.resolve(o.saveCheckpoint) === path.resolve(o.restore)) throw new UsageError('--save-checkpoint must not overwrite the checkpoint given to --restore');
  return o;
}

/** Sim agent library, without ".so", or undefined. explicit: --agent value. */
function agentLibrary(explicit, env = process.env) {
  const pick = explicit !== undefined ? explicit : env.VP_SIM_AGENT;
  if (pick === 'none') return { lib: undefined, why: 'disabled with --agent none' };
  if (pick) {
    const f = pick.endsWith('.so') ? pick : pick + '.so';
    if (!fs.existsSync(f)) throw new UsageError(`sim agent library not found: ${f}`);
    return { lib: path.resolve(f).slice(0, -3) };
  }
  const f = launch.findBuilt(launch.buildDirs(ROOT), 'sim-agent', 'sim_agent.so') || launch.findBuilt(launch.buildDirs(ROOT), 'sim-agent', 'vp_sim_agent.so');
  return f ? { lib: f.slice(0, -3) } : { lib: undefined, why: 'not built (run "VP Studio: Build Sim Agent", or tools/sim-agent/build.sh <qbox>/build)' };
}

/** Environment variable name for a host port variable: HOST_PORT_SSH -> VP_HOST_PORT_SSH. */
const envName = (v) => 'VP_' + v.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();

const xmlEscape = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c])
  // XML 1.0 has no place for most control characters, which console output is full of.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** JUnit XML for one run: cases [{name, seconds, failure?}], console text. */
function junitXml(suite, cases, consoleText) {
  const failures = cases.filter((c) => c.failure).length;
  const total = cases.reduce((s, c) => s + c.seconds, 0);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${xmlEscape(suite)}" tests="${cases.length}" failures="${failures}" errors="0" time="${total.toFixed(3)}">`,
  ];
  for (const c of cases) {
    const head = `  <testcase classname="${xmlEscape(suite)}" name="${xmlEscape(c.name)}" time="${c.seconds.toFixed(3)}"`;
    if (!c.failure) { lines.push(head + '/>'); continue; }
    lines.push(head + '>', `    <failure message="${xmlEscape(c.failure)}"/>`, '  </testcase>');
  }
  lines.push(`  <system-out>${xmlEscape(consoleText)}</system-out>`, '</testsuite>');
  return lines.join('\n') + '\n';
}

/** Model specs under the QBox folder and, for a platform in an unpacked kit, in the kit. */
function modelSpecsFor(qbox, platformFile) {
  const kitRoot = kit.findKitRoot(platformFile);
  return [...new Set(launch.findModelSpecs(qbox).concat(kitRoot ? launch.findModelSpecs(kitRoot) : []))];
}

const mib = (n) => `${(n / (1 << 20)).toFixed(1)} MiB`;

/** Progress on stderr, at most every 10 s. */
function progressLogger(log) {
  let last = 0;
  return ({ phase, done, total }) => {
    if (Date.now() - last < 10000) return;
    last = Date.now();
    log(`${phase} ${total ? Math.floor((done / total) * 100) : 0}%`);
  };
}

/** --export-kit: resolves the exit code. */
async function exportKitCmd(o, log) {
  const platformFile = path.resolve(o.platform);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(platformFile, 'utf8'));
  } catch (e) {
    log(`cannot read ${o.platform}: ${e.message}`);
    return EXIT.SETUP;
  }
  let catalog;
  try {
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'qbox-catalog.json'), 'utf8'));
    catalog = launch.catalogWithLocal(base, { bundled: BUNDLED, dirs: launch.buildDirs(ROOT), modelSpecs: modelSpecsFor(path.resolve(o.qbox), platformFile) }).catalog;
  } catch (e) { /* models are then found through dylib only */ }
  const p = kit.plan(doc, platformFile, { catalog, pinFile: path.join(ROOT, 'qbox.pin.json'), bundledTypes: BUNDLED.map((b) => b.type) });
  for (const m of p.missing) log(`${o.allowMissing ? 'warning: ' : ''}not found: ${m.ref} (${m.file})`);
  if (p.missing.length && !o.allowMissing) {
    log('add the files, or export without them with --allow-missing');
    return EXIT.SETUP;
  }
  const omit = new Set();
  for (const want of o.omit) {
    const hits = p.files.filter((f) => f.path === want || path.posix.basename(f.path) === want || f.refs.includes(want));
    if (!hits.length) { log(`--omit ${want}: no such file in the kit`); return EXIT.SETUP; }
    hits.forEach((f) => omit.add(f.path));
  }
  if (o.omitLarger) kit.largeFiles(p, o.omitLarger * (1 << 20)).forEach((f) => omit.add(f));
  const urls = {};
  for (const [k, v] of Object.entries(o.urls)) {
    const f = p.files.find((x) => x.path === k || path.posix.basename(x.path) === k);
    if (!f) { log(`--url ${k}: no such file in the kit`); return EXIT.SETUP; }
    if (!omit.has(f.path)) log(`warning: --url ${k}: the file is in the kit, the URL is not used`);
    urls[f.path] = v;
  }
  let version;
  try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch (e) { /* unknown */ }
  const used = pin.gitHead(path.resolve(o.qbox));
  const t0 = Date.now();
  const m = await kit.exportKit(p, o.exportKit, {
    omit, urls, allowMissing: o.allowMissing, vpStudio: version, qboxUsed: used ? { commit: used } : undefined,
    onProgress: progressLogger(log),
  });
  for (const n of p.notes) log(`note: ${n}`);
  for (const x of m.omitted) log(`left out: ${x.path} (${mib(x.size)}, sha256 ${x.sha256})`);
  log(`wrote ${o.exportKit}: ${m.files.length} files, ${mib(m.archive.size)}, in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return EXIT.PASS;
}

/** --import-kit: resolves the exit code (1 when a file is damaged or a left-out file is missing). */
async function importKitCmd(o, log) {
  let r;
  try {
    r = await kit.importKit(o.importKit, o.into, { overwrite: o.overwrite, onProgress: progressLogger(log) });
  } catch (e) {
    log(e.code === 'EEXIST' ? `${e.message} (use --overwrite)` : `${o.importKit}: ${e.message}`);
    return EXIT.SETUP;
  }
  let code = EXIT.PASS;
  for (const b of r.bad) { log(`damaged: ${b}`); code = EXIT.FAIL; }
  for (const x of kit.omittedReport(r.dir, r.manifest)) {
    if (x.state === 'present') continue;
    log(`${x.state === 'missing' ? 'add' : 'wrong size'}: ${x.path} (${mib(x.size)}, sha256 ${x.sha256}${x.url ? `, from ${x.url}` : ''})`);
    code = EXIT.FAIL;
  }
  const local = pin.readPin(path.join(ROOT, 'qbox.pin.json'));
  const want = r.manifest.qbox && r.manifest.qbox.commit;
  if (want && local && local.qbox && local.qbox.commit !== want) log(`note: the kit was tested with QBox ${pin.short(want)}; this VP Studio pins ${pin.short(local.qbox.commit)}`);
  for (const t of r.manifest.bundled || []) log(`note: the platform uses ${t}, which you build with VP Studio`);
  for (const mdl of r.manifest.models || []) log(`note: build the model ${mdl.name} (${mdl.spec}) before starting`);
  log(`unpacked to ${r.dir}; platform: ${r.platform}`);
  return code;
}

/** Simulator, catalog-checked platform and generate options for a performance run, or an exit code. */
function perfSetup(o, platformFile, log) {
  const perf = require('../lib/analysis/perf');
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(platformFile, 'utf8'));
  } catch (e) {
    log(`cannot read ${platformFile}: ${e.message}`);
    return EXIT.SETUP;
  }
  if (!perf.isPerfPlatform(doc)) {
    log(`${path.basename(platformFile)} has no performance models (traffic_gen, at_bus, dram_ctrl, perf_stats)`);
    return EXIT.SETUP;
  }
  const qbox = path.resolve(o.qbox);
  const exe = path.isAbsolute(o.exe) ? o.exe : path.join(qbox, o.exe);
  if (!fs.existsSync(exe)) {
    log(`simulator not found: ${exe} (set --qbox to the QBox folder, or --exe)`);
    return EXIT.SETUP;
  }
  if (!fs.existsSync(path.join(path.dirname(exe), `${perf.LIBRARY}.so`))) {
    log(`${path.dirname(exe)} has no ${perf.LIBRARY}.so: build QBox with VP Studio's patch 0003 (tools/qbox-pin/build-qbox.sh)`);
    return EXIT.SETUP;
  }
  let catalog;
  try {
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'qbox-catalog.json'), 'utf8'));
    catalog = launch.catalogWithLocal(base, { bundled: BUNDLED, dirs: launch.buildDirs(ROOT), modelSpecs: modelSpecsFor(qbox, platformFile) }).catalog;
  } catch (e) {
    log(`warning: no component catalog (${e.message}); module types are not checked`);
  }
  const analysis = core.analyze(doc, { catalog });
  for (const p of analysis.problems.filter((x) => x.severity === 'warning')) log(`warning: ${where(p)}`);
  const errors = analysis.problems.filter((p) => p.severity === 'error');
  if (errors.length) {
    for (const p of errors) log(`error: ${where(p)}`);
    return EXIT.SETUP;
  }
  // --param applies to every run; a swept value of the same parameter comes later in the Lua and wins.
  return { doc, exe, qbox, generateOptions: { libraries: require('../lib/generate/models').libraries(catalog || {}), overrides: [...o.params] } };
}

/** vp-run --perf: one experiment. */
async function perfCmd(o, log) {
  const perf = require('../lib/analysis/perf');
  const platformFile = path.resolve(o.platform);
  const set = perfSetup(o, platformFile, log);
  if (typeof set === 'number') return set;
  const outFile = path.resolve(o.out || path.join(path.dirname(platformFile), 'perf-results', `${path.basename(platformFile, launch.SUFFIX)}.perf.json`));
  const sig = { aborted: false, onAbort: null };
  const onSignal = () => { sig.aborted = true; if (sig.onAbort) sig.onAbort(); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const r = await perf.runExperiment({
    doc: set.doc, platformFile, exe: set.exe, cwd: set.qbox, outFile, generateOptions: set.generateOptions,
    timeoutMs: o.timeout * 1000, signal: sig, onOutput: o.quiet ? undefined : (t) => process.stdout.write(t),
  });
  if (!r.ok) { log(r.error); return r.stats ? EXIT.FAIL : EXIT.SIM; }
  log(`statistics: ${outFile} (${r.seconds.toFixed(1)} s)`);
  return EXIT.PASS;
}

/** vp-run --perf-sweep: every combination of a sweep file, with its checks. */
async function perfSweepCmd(o, log) {
  const perf = require('../lib/analysis/perf');
  const specFile = path.resolve(o.perfSweep);
  let loaded;
  try {
    loaded = perf.loadSweep(specFile);
  } catch (e) {
    log(`cannot read ${o.perfSweep}: ${e.message}`);
    return EXIT.SETUP;
  }
  const problems = perf.checkSweep(loaded.spec, loaded.doc);
  if (problems.length) {
    for (const p of problems) log(`${path.basename(specFile)}: ${p}`);
    return EXIT.SETUP;
  }
  const set = perfSetup(o, loaded.platformFile, log);
  if (typeof set === 'number') return set;
  const outDir = path.resolve(o.out || perf.resultsDir(specFile));
  const total = perf.runCount(loaded.spec);
  log(`${total} runs of ${path.basename(loaded.platformFile)} into ${outDir}`);
  const sig = { aborted: false, onAbort: null };
  const onSignal = () => { sig.aborted = true; if (sig.onAbort) sig.onAbort(); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const results = await perf.runSweep({
    spec: loaded.spec, doc: set.doc, platformFile: loaded.platformFile, exe: set.exe, cwd: set.qbox, outDir, specFile,
    generateOptions: set.generateOptions, jobs: o.jobs, signal: sig, timeoutMs: o.timeout * 1000,
    onProgress: ({ done, run }) => log(`[${done}/${total}] ${run.label}: ${run.ok ? `ok (${run.seconds.toFixed(1)} s)` : run.error}`),
  });
  const metrics = perf.metricNames(results);
  if (!o.quiet) {
    const params = results.sweep.map((x) => x.param);
    process.stdout.write([['run', ...params, ...metrics].join('\t'), ...results.runs.map((r) => [r.index, ...params.map((p) => r.values[p]), ...metrics.map((m) => (r.ok ? perf.fmt(r.metrics[m]) : 'failed'))].join('\t'))].join('\n') + '\n');
  }
  for (const c of results.checkResults) log(`${c.ok ? 'pass' : 'FAIL'}: ${c.name}: ${c.message}`);
  const failedRuns = results.runs.filter((r) => !r.ok);
  if (o.junit) {
    const cases = results.checkResults.map((c) => ({ name: c.name, seconds: 0, failure: c.ok ? undefined : c.message }));
    for (const r of failedRuns) cases.push({ name: `run ${r.index} (${r.label})`, seconds: r.seconds || 0, failure: r.error });
    if (!cases.length) for (const r of results.runs) cases.push({ name: `run ${r.index} (${r.label})`, seconds: r.seconds || 0 });
    fs.writeFileSync(o.junit, junitXml(path.basename(specFile, perf.SWEEP_SUFFIX), cases, ''));
  }
  log(`results: ${path.join(outDir, 'results.json')}`);
  if (results.cancelled) return EXIT.FAIL;
  return failedRuns.length || results.checkResults.some((c) => !c.ok) ? EXIT.FAIL : EXIT.PASS;
}

const KEEP_CONSOLE = 1 << 20; // console text kept for matching and the report

async function run(o, log = (s) => process.stderr.write(`vp-run: ${s}\n`)) {
  const platformFile = path.resolve(o.platform);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(platformFile, 'utf8'));
  } catch (e) {
    log(`cannot read ${o.platform}: ${e.message}`);
    return EXIT.SETUP;
  }
  const topDir = path.dirname(platformFile);
  const qbox = path.resolve(o.qbox);
  const exe = path.isAbsolute(o.exe) ? o.exe : path.join(qbox, o.exe);
  if (!fs.existsSync(exe)) {
    log(`simulator not found: ${exe} (set --qbox to the QBox folder, or --exe)`);
    return EXIT.SETUP;
  }

  // Check the platform with the catalog, as the editor does.
  let catalog;
  try {
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'qbox-catalog.json'), 'utf8'));
    catalog = launch.catalogWithLocal(base, { bundled: BUNDLED, dirs: launch.buildDirs(ROOT), modelSpecs: modelSpecsFor(qbox, platformFile) }).catalog;
  } catch (e) {
    log(`warning: no component catalog (${e.message}); module types are not checked`);
  }
  let analysis;
  try {
    analysis = core.analyze(doc, { catalog });
  } catch (e) {
    log(`${o.platform}: ${e.message}`);
    return EXIT.SETUP;
  }
  const errors = analysis.problems.filter((p) => p.severity === 'error');
  for (const p of analysis.problems.filter((x) => x.severity === 'warning')) log(`warning: ${where(p)}`);
  if (errors.length) {
    for (const p of errors) log(`error: ${where(p)}`);
    return EXIT.SETUP;
  }

  if (doc.devicetree && doc.devicetree.output) {
    try {
      const dt = await launch.writeDeviceTree(doc, platformFile, o.dtc);
      log(`device tree: ${path.relative(process.cwd(), dt.dtb)}`);
    } catch (e) {
      log(`device tree: ${e.message}`);
      return EXIT.SETUP;
    }
  }
  // From a checkpoint, the simulation runs on copies of the disk images.
  const pre = o.restore ? Object.assign(launch.preflight(doc, topDir), { locked: [], low: [] }) : launch.preflight(doc, topDir);
  if (pre.missing.length) {
    for (const m of pre.missing) log(`error: ${m.module}[${m.index}]: ${m.file} does not exist`);
    return EXIT.SETUP;
  }
  if (pre.locked.length) {
    for (const l of pre.locked) {
      const who = l.holders.length ? ` by ${l.holders.map((h) => `${path.basename((h.cmd || '?').split(' ')[0])} (pid ${h.pid})`).join(', ')}` : '';
      log(`error: the disk image of ${l.module} is in use${who}: ${l.file}`);
    }
    return EXIT.SETUP;
  }
  for (const l of pre.low) log(`warning: the disk image of ${l.module} has only ${require('../lib/sim/diskspace').fmtBytes(l.available)} free; guest services may fail`);

  let agent;
  try {
    agent = agentLibrary(o.agent);
  } catch (e) {
    log(e.message);
    return EXIT.SETUP;
  }
  const needs = o.simTimeout ? '--sim-timeout' : o.exec ? '--exec' : o.saveCheckpoint ? '--save-checkpoint' : o.restore ? '--restore' : null;
  if (!agent.lib && needs) {
    log(`the sim agent is needed for ${needs}, but it is ${agent.why}`);
    return EXIT.SETUP;
  }
  if ((o.saveCheckpoint || o.restore) && !pin.versionAtLeast(pin.agentVersion(agent.lib + '.so'), checkpoint.MIN_AGENT)) {
    log(`checkpoints need sim agent ${checkpoint.MIN_AGENT} or later; rebuild it (tools/sim-agent/build.sh <qbox>/build)`);
    return EXIT.SETUP;
  }
  if (!agent.lib) log(`running without the sim agent: ${agent.why}`);

  const options = { libraries: require('../lib/generate/models').libraries(catalog || {}), overrides: [...o.params] };
  let restorePlan;
  if (o.restore) {
    try {
      const manifest = checkpoint.readManifest(o.restore);
      restorePlan = checkpoint.restorePlan(manifest, o.restore, doc, { snapshot: o.snapshot, platformText: fs.readFileSync(platformFile, 'utf8') });
      for (const p of restorePlan.problems) log(`${p.level}: ${p.text}`);
      if (restorePlan.problems.some((p) => p.level === 'error')) return EXIT.SETUP;
      await checkpoint.prepare(restorePlan, (what) => log(what));
      log(`starting from checkpoint ${manifest.name} (saved at simulated ${manifest.time && manifest.time.text})`);
    } catch (e) {
      log(`--restore ${o.restore}: ${e.message}`);
      return EXIT.SETUP;
    }
    options.overrides.unshift(...restorePlan.overrides);
  } else if (o.snapshot) options.overrides.unshift(...launch.snapshotOverrides(doc));
  let hostPorts = {};
  try {
    const chosen = await hostports.choosePorts(hostports.hostPortVariables(doc));
    hostPorts = chosen.values;
    if (Object.keys(hostPorts).length) options.variableValues = hostPorts;
    for (const m of chosen.moved) log(`host port ${m.name} ${m.from} is taken; using ${m.to}`);
  } catch (e) {
    log(`warning: could not check host ports (${e.message})`);
  }
  const agentPort = agent.lib ? (o.agentPort || await simagent.freePort()) : undefined;
  const buses = analysis.routers;
  if (agent.lib) options.extraModules = [launch.agentModule(agent.lib, agentPort, buses, restorePlan ? restorePlan.agentParams : {})];
  let lua;
  try {
    lua = core.generate(doc, options);
  } catch (e) {
    log(`generation failed: ${e.message}`);
    return EXIT.SETUP;
  }
  const luaFile = launch.luaPathFor(platformFile, doc);
  fs.writeFileSync(luaFile, lua);

  // ---- run
  const started = Date.now();
  const logFile = o.log ? fs.openSync(o.log, 'w') : undefined;
  const sim = cp.spawn(exe, ['-l', luaFile], { cwd: qbox, stdio: ['pipe', 'pipe', 'pipe'] });
  let consoleText = '';
  let searchFrom = 0;
  let exited = null; // {code, signal}
  let waiters = [];
  const onOutput = (b) => {
    const s = b.toString('utf8');
    if (!o.quiet) process.stdout.write(s);
    if (logFile !== undefined) fs.writeSync(logFile, s);
    consoleText += s;
    if (consoleText.length > KEEP_CONSOLE) {
      const cut = consoleText.length - KEEP_CONSOLE;
      consoleText = consoleText.slice(cut);
      searchFrom = Math.max(0, searchFrom - cut);
    }
    waiters.forEach((w) => w());
  };
  sim.stdout.on('data', onOutput);
  sim.stderr.on('data', onOutput);
  sim.stdin.on('error', () => {}); // the simulator may be gone already
  const exitPromise = new Promise((resolve) => sim.on('exit', (code, signal) => { exited = { code, signal }; waiters.forEach((w) => w()); resolve(exited); }));
  sim.on('error', (e) => { log(`cannot start ${exe}: ${e.message}`); });

  let client;
  let simLimitHit = false;
  const stopSim = async () => {
    if (exited) return;
    sim.kill('SIGHUP'); // ends QBox cleanly; Ctrl-C would go to the guest
    const t = setTimeout(() => { if (!exited) sim.kill('SIGKILL'); }, 10000);
    await exitPromise;
    clearTimeout(t);
  };
  let interrupted = false;
  const onSignal = () => { interrupted = true; waiters.forEach((w) => w()); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const deadline = started + o.timeout * 1000;
  /** Wait until test() is true. Resolves 'ok', 'timeout', 'exited', 'interrupted' or 'simlimit'. */
  const waitFor = (test) => new Promise((resolve) => {
    let timer;
    const check = () => {
      let r;
      if (test()) r = 'ok';
      else if (interrupted) r = 'interrupted';
      else if (simLimitHit) r = 'simlimit';
      else if (exited) r = 'exited';
      else if (Date.now() >= deadline) r = 'timeout';
      if (!r) return;
      clearTimeout(timer);
      waiters = waiters.filter((w) => w !== check);
      resolve(r);
    };
    waiters.push(check);
    timer = setTimeout(check, Math.max(0, deadline - Date.now()) + 5);
    check();
  });

  const cases = [];
  let result = EXIT.PASS;
  const why = (r, what) => ({
    timeout: `timed out after ${o.timeout} s ${what}`,
    exited: `the simulator ended (${exited && (exited.signal || 'exit code ' + exited.code)}) ${what}`,
    interrupted: `interrupted ${what}`,
    simlimit: `simulated time reached ${o.simTimeout && o.simTimeout.text} ${what}`,
  })[r];
  const fail = (r) => (r === 'exited' ? EXIT.SIM : EXIT.FAIL);

  if (agent.lib) {
    client = await simagent.connectWithRetry({ port: agentPort, totalMs: Math.min(120000, o.timeout * 1000), shouldStop: () => !!exited || interrupted });
    if (!client) {
      log(`could not connect to the sim agent on port ${agentPort}${exited ? ': the simulator ended' : ''}`);
      if (o.simTimeout || o.exec) {
        await stopSim();
        return exited ? EXIT.SIM : EXIT.SETUP;
      }
    } else {
      client.on('notification', (m, p) => {
        if (m === 'sim.stateChanged' && p && p.reason === 'time') { simLimitHit = true; waiters.forEach((w) => w()); }
      });
      client.on('close', () => { client = undefined; });
      if (o.simTimeout) {
        try {
          await client.request('sim.runUntil', { time: o.simTimeout.text });
        } catch (e) {
          log(`cannot set the simulated time limit: ${e.message}${/method not found/.test(e.message) ? ' (rebuild the sim agent: it needs 0.4.0 or later)' : ''}`);
          await stopSim();
          return EXIT.SETUP;
        }
      }
    }
  }

  if (restorePlan) {
    // The agent loads the checkpoint before it answers; a failed load leaves
    // the simulation paused, so stop here instead of waiting for the steps.
    let st;
    try { st = client && await client.request('sim.getStatus', undefined, { timeoutMs: 300000 }); } catch (e) { st = undefined; }
    const state = st && st.restore ? st.restore.state : 'unknown';
    if (state !== 'restored') {
      log(`restoring the checkpoint failed: ${st && st.restore && st.restore.error ? st.restore.error : `the agent reports "${state}"`}`);
      if (client) client.close();
      await stopSim();
      return EXIT.SETUP;
    }
  }

  for (const step of o.steps) {
    const t0 = Date.now();
    if (step.send !== undefined || step.sendEnv !== undefined) {
      const text = step.send !== undefined ? step.send : process.env[step.sendEnv];
      if (!exited) sim.stdin.write(text + '\n');
      cases.push({ name: step.send !== undefined ? `send ${step.send}` : `send $${step.sendEnv}`, seconds: 0 });
      continue;
    }
    let matchEnd = -1;
    const r = await waitFor(() => {
      const m = step.expect.exec(consoleText.slice(searchFrom));
      if (m) matchEnd = searchFrom + m.index + m[0].length;
      return !!m;
    });
    const seconds = (Date.now() - t0) / 1000;
    if (r === 'ok') {
      searchFrom = matchEnd;
      log(`matched /${step.source}/ after ${((Date.now() - started) / 1000).toFixed(1)} s`);
      cases.push({ name: `expect /${step.source}/`, seconds });
      continue;
    }
    const msg = why(r, `waiting for /${step.source}/`);
    log(msg);
    cases.push({ name: `expect /${step.source}/`, seconds, failure: msg });
    result = fail(r);
    break;
  }

  if (result === EXIT.PASS && o.saveCheckpoint) {
    const t0 = Date.now();
    if (!client) {
      log('cannot save a checkpoint: no connection to the sim agent');
      result = EXIT.SETUP;
    } else {
      try {
        const p = checkpoint.plan(doc, { catalog, descs: registers.loadDir(path.join(ROOT, 'catalog', 'registers')).descs, buses, topDir, overrides: options.overrides });
        for (const u of p.unsaved) log(`warning: the state of ${u.instance} (${u.type}) is not saved`);
        const src = pin.qboxSourceOf(exe);
        const m = await checkpoint.save(client, path.resolve(o.saveCheckpoint), p, {
          name: path.basename(path.resolve(o.saveCheckpoint)), platformFile, platformText: fs.readFileSync(platformFile, 'utf8'),
          qboxCommit: src ? pin.gitHead(src.source) : undefined, agentVersion: pin.agentVersion(agent.lib + '.so'),
        }, { onPhase: (what) => log(what) });
        const secs = (Date.now() - t0) / 1000;
        log(`checkpoint saved to ${o.saveCheckpoint} at simulated ${m.time.text} in ${secs.toFixed(1)} s (${checkpoint.fmtSize(checkpoint.diskUsage(path.resolve(o.saveCheckpoint)))})`);
        cases.push({ name: `save checkpoint ${o.saveCheckpoint}`, seconds: secs });
      } catch (e) {
        log(`saving the checkpoint failed: ${e.message}`);
        cases.push({ name: `save checkpoint ${o.saveCheckpoint}`, seconds: (Date.now() - t0) / 1000, failure: e.message });
        result = EXIT.SETUP;
      }
    }
  }

  if (result === EXIT.PASS && o.exec) {
    const env = Object.assign({}, process.env, { VP_AGENT_HOST: '127.0.0.1', VP_AGENT_PORT: String(agentPort), VP_PLATFORM: platformFile });
    for (const [k, v] of Object.entries(hostPorts)) env[envName(k)] = String(v);
    const t0 = Date.now();
    log(`running: ${o.exec}`);
    const child = cp.spawn('sh', ['-c', o.exec], { stdio: ['ignore', 'inherit', 'inherit'], env });
    const code = await new Promise((resolve) => {
      const kill = setTimeout(() => child.kill('SIGTERM'), Math.max(0, deadline - Date.now()));
      child.on('exit', (c, s) => { clearTimeout(kill); resolve(s ? 128 : c); });
    });
    const seconds = (Date.now() - t0) / 1000;
    if (code === 0) {
      cases.push({ name: `exec ${o.exec}`, seconds });
    } else {
      const msg = Date.now() >= deadline ? `timed out after ${o.timeout} s running ${o.exec}` : `${o.exec} exited with ${code}`;
      log(msg);
      cases.push({ name: `exec ${o.exec}`, seconds, failure: msg });
      result = EXIT.FAIL;
    }
  }

  // With nothing to check, the run is the simulator's own result.
  const waitForEnd = o.waitExit || (!o.steps.length && !o.exec);
  if (result === EXIT.PASS && waitForEnd) {
    const t0 = Date.now();
    const r = await waitFor(() => !!exited);
    const seconds = (Date.now() - t0) / 1000;
    if (r === 'ok' && exited.code === 0) {
      cases.push({ name: 'simulator ends', seconds });
    } else {
      const msg = r === 'ok' ? `the simulator ended with ${exited.signal || 'exit code ' + exited.code}` : why(r, 'waiting for the simulator to end');
      log(msg);
      cases.push({ name: 'simulator ends', seconds, failure: msg });
      result = r === 'ok' ? EXIT.SIM : EXIT.FAIL;
    }
  }

  if (client) client.close();
  await stopSim();
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  if (logFile !== undefined) fs.closeSync(logFile);
  if (interrupted) result = EXIT.FAIL;
  if (o.junit) fs.writeFileSync(o.junit, junitXml(doc.name || path.basename(platformFile, launch.SUFFIX), cases, consoleText.slice(-65536)));
  log(`${result === EXIT.PASS ? 'passed' : 'FAILED'} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return result;
}

if (require.main === module) {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`vp-run: ${e.message}\n\n${USAGE}\n`);
    process.exit(EXIT.SETUP);
  }
  if (o.help) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }
  const log = (s) => process.stderr.write(`vp-run: ${s}\n`);
  const main = o.importKit ? importKitCmd(o, log) : o.exportKit ? exportKitCmd(o, log) : o.perfSweep ? perfSweepCmd(o, log) : o.perf ? perfCmd(o, log) : run(o);
  main.then((code) => process.exit(code), (e) => {
    process.stderr.write(`vp-run: ${e.stack || e.message}\n`);
    process.exit(EXIT.SETUP);
  });
}

module.exports = { parseArgs, junitXml, agentLibrary, envName, run, exportKitCmd, importKitCmd, perfCmd, perfSweepCmd, EXIT, UsageError };
