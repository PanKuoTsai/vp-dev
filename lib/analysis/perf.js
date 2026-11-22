'use strict';
// Architecture exploration (performance experiments) with QBox's perf models
// (traffic_gen, at_bus, dram_ctrl, perf_stats; library perf.so, from VP
// Studio's QBox patch 0003): run a platform once or over a parameter sweep,
// read the statistics the models write (format "vp-perf-stats"), pick metrics,
// check limits for CI. Shared by the extension and vp-run. No VS Code dependency.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const core = require('../platform/core');
const qos = require('./qos');

const LIBRARY = 'perf';
const TYPES = ['traffic_gen', 'at_bus', 'dram_ctrl', 'perf_stats'];
const SWEEP_SUFFIX = '.perfsweep.json';
const STATS_FORMAT = 'vp-perf-stats';

/** True when the platform has a perf model (it can be run as an experiment). */
function isPerfPlatform(doc) {
  return Object.values(core.modulesOf(doc)).some((m) => m && TYPES.includes(m.type));
}

/** Instance name of the platform's perf_stats module, or null. */
function statsInstance(doc) {
  const e = Object.entries(core.modulesOf(doc)).find(([, m]) => m && m.type === 'perf_stats');
  return e ? e[0] : null;
}

/** Statistics from the text of a stats file; throws when it is not one. */
function parseStats(text) {
  const s = JSON.parse(text);
  if (!s || s.format !== STATS_FORMAT) throw new Error('not a VP Studio perf statistics file');
  for (const k of ['initiators', 'buses', 'memories']) if (!Array.isArray(s[k])) s[k] = [];
  return s;
}

const SECTIONS = { initiators: 'initiators', initiator: 'initiators', buses: 'buses', bus: 'buses', memories: 'memories', memory: 'memories' };
const lastPart = (n) => String(n).split('.').pop();

/** The entry of a section that a name means: its label, its full name or its last part. */
function entry(stats, section, name) {
  const list = stats[SECTIONS[section]] || [];
  return list.find((e) => e.label === name) || list.find((e) => e.name === name) || list.find((e) => lastPart(e.name) === name) ||
    list.find((e) => e.name.endsWith('.' + name));
}

/**
 * A number from the statistics. path: "<section>.<name>.<field>[.<field>…]",
 * section initiators|buses|memories (or initiator|bus|memory), name the label
 * or module name, e.g. "initiators.gen_cpu.latencyNs.p99",
 * "memories.dram.rowHitRate", "buses.bus.waitNs.gen_cpu.p99". Also "simTimeNs".
 * Returns undefined when it is not there.
 */
function metric(stats, p) {
  if (p === 'simTimeNs') return stats.simTimeNs;
  const parts = String(p).split('.');
  if (parts.length < 3 || !SECTIONS[parts[0]]) return undefined;
  // A module name may hold dots (a subsystem): try the longest name first.
  for (let k = parts.length - 1; k >= 2; k--) {
    const e = entry(stats, parts[0], parts.slice(1, k).join('.'));
    if (!e) continue;
    let v = e;
    for (const f of parts.slice(k)) v = v === undefined || v === null ? undefined : v[f];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

/** Every metric path with a number in these statistics (for pickers). */
function listMetrics(stats) {
  const out = [];
  const walk = (prefix, v, depth) => {
    if (typeof v === 'number') { out.push(prefix); return; }
    if (!v || typeof v !== 'object' || Array.isArray(v) || depth > 3) return;
    for (const [k, x] of Object.entries(v)) if (k !== 'histogram' && k !== 'name' && k !== 'label') walk(`${prefix}.${k}`, x, depth + 1);
  };
  for (const sec of ['initiators', 'buses', 'memories']) {
    for (const e of stats[sec] || []) walk(`${sec}.${e.label || lastPart(e.name)}`, e, 0);
  }
  return out;
}

/**
 * Initiators whose accesses failed (perf 1.2.0 counts them apart): a message
 * for each, or [] when every access was answered.
 */
function failures(stats) {
  return (stats.initiators || []).filter((g) => g.errors > 0).map((g) =>
    `${g.label || lastPart(g.name)}: ${g.errors} of ${g.errors + g.reads + g.writes} accesses failed (${g.firstError || 'error response'})`);
}

const FAILURE_HINT = 'An address error means no target answers that address: check the masters\' address and size, the targets\' ranges, and relative_addresses on a bus behind another bus.';

/** The headline numbers of one run, for tables. */
function summary(stats) {
  return {
    simTimeNs: stats.simTimeNs,
    complete: !!stats.complete,
    initiators: (stats.initiators || []).map((g) => ({
      label: g.label || lastPart(g.name), name: g.name, reads: g.reads, writes: g.writes, bytes: g.bytes, errors: g.errors || 0,
      bandwidthMBps: g.bandwidthMBps, mean: g.latencyNs.mean, p50: g.latencyNs.p50, p99: g.latencyNs.p99, max: g.latencyNs.max,
      histogram: g.latencyNs.histogram || null,
    })),
    buses: (stats.buses || []).map((b) => ({
      label: lastPart(b.name), name: b.name, requestUtilization: b.requestUtilization, responseUtilization: b.responseUtilization, waitNs: b.waitNs || {},
      // perf 1.2.0: shared or crossbar, and the use of each channel ("to <target>", "to <initiator>").
      topology: b.topology || 'shared', channels: { request: (b.channels || {}).request || {}, response: (b.channels || {}).response || {} },
      // Per master (perf 1.1.0): bandwidth through this bus, QoS settings and their effect.
      masters: Object.entries(b.masters || {}).map(([who, m]) => ({
        label: who, qos: m.qos || '', bandwidthMBps: m.bandwidthMBps, grants: m.grants, urgentGrants: m.urgentGrants, limitedGrants: m.limitedGrants,
        limitWaitNs: m.limitWaitNs, waitP99: ((b.waitNs || {})[who] || {}).p99, responseWaitP99: (m.responseWaitNs || {}).p99,
      })),
    })),
    memories: (stats.memories || []).map((m) => ({
      label: lastPart(m.name), name: m.name, bandwidthMBps: m.bandwidthMBps, dataBusUtilization: m.dataBusUtilization, rowHitRate: m.rowHitRate,
      rowHits: m.rowHits, rowMisses: m.rowMisses, rowConflicts: m.rowConflicts, refreshes: m.refreshes, serviceMean: m.serviceNs.mean, serviceP99: m.serviceNs.p99,
    })),
  };
}

// ------------------------------------------------------------------ sweeps

/** "gen_cpu.max_outstanding" -> {instance: "gen_cpu", param: "max_outstanding"} (the last dot splits). */
function splitParam(key) {
  const i = String(key).lastIndexOf('.');
  if (i <= 0 || i === key.length - 1) throw new Error(`${key}: write <module>.<parameter>, e.g. gen_cpu.max_outstanding`);
  return { instance: key.slice(0, i), param: key.slice(i + 1) };
}

/**
 * Problems of a sweep file (strings), against the platform when given.
 * {platform, sweep: [{param, values: [...]}], metrics?: [paths], checks?: [{metric, min?, max?, where?}],
 *  jobs?, timeoutSeconds?}
 */
function checkSweep(spec, doc) {
  const out = [];
  if (!spec || typeof spec !== 'object') return ['the sweep file is not a JSON object'];
  if (!Array.isArray(spec.sweep) || !spec.sweep.length) out.push('"sweep" must list at least one parameter: [{"param": "gen_cpu.max_outstanding", "values": [1, 2, 4]}]');
  const mods = doc ? core.modulesOf(doc) : null;
  for (const [i, s] of (spec.sweep || []).entries()) {
    if (!s || typeof s.param !== 'string') { out.push(`sweep[${i}]: "param" is missing`); continue; }
    const q = qos.qosPath(s.param);
    if (q) {
      if (mods && !mods[q.instance]) out.push(`sweep[${i}]: the platform has no module ${q.instance}`);
      else if (mods && mods[q.instance].type !== 'at_bus') out.push(`sweep[${i}]: ${q.instance} is a ${mods[q.instance].type}; QoS settings (masters) belong to an at_bus`);
    } else {
      try {
        const { instance } = splitParam(s.param);
        if (mods && !mods[instance]) out.push(`sweep[${i}]: the platform has no module ${instance}`);
      } catch (e) { out.push(`sweep[${i}]: ${e.message}`); }
    }
    if (!Array.isArray(s.values) || !s.values.length) out.push(`sweep[${i}] (${s.param}): "values" must be a non-empty list`);
  }
  const keys = new Set((spec.sweep || []).map((s) => s && s.param));
  for (const [i, c] of (spec.checks || []).entries()) {
    if (!c || typeof c.metric !== 'string') out.push(`checks[${i}]: "metric" is missing`);
    else if (c.min === undefined && c.max === undefined) out.push(`checks[${i}] (${c.metric}): give "min", "max" or both`);
    for (const k of Object.keys((c && c.where) || {})) if (!keys.has(k)) out.push(`checks[${i}]: "where" names ${k}, which the sweep does not vary`);
  }
  const n = runCount(spec);
  if (n > 1000) out.push(`the sweep has ${n} runs; split it (at most 1000)`);
  return out;
}

const runCount = (spec) => (spec.sweep || []).reduce((n, s) => n * (Array.isArray(s && s.values) ? Math.max(1, s.values.length) : 1), 1);

/** Every combination: [{index, values: {param: value}, overrides: [{instance, param, value}]}], the first parameter slowest. */
function expandSweep(spec) {
  let runs = [{}];
  for (const s of spec.sweep || []) {
    const next = [];
    for (const r of runs) for (const v of s.values) next.push(Object.assign({}, r, { [s.param]: v }));
    runs = next;
  }
  return runs.map((values, index) => ({
    index, values,
    overrides: Object.entries(values).map(([k, value]) => Object.assign(splitParam(k), { value })),
  }));
}

/** "gen_cpu.max_outstanding=4, bus.arbitration=priority" */
const runLabel = (values) => Object.entries(values).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ') || 'default';

// ------------------------------------------------------------------ running

/**
 * Overrides with the QoS ones ("mau0.masters.display.min_mbps" = 6000, from a
 * sweep or vp-run --param) folded into one "masters" text per at_bus, starting
 * from the platform's own text (or an earlier plain override of it).
 */
function foldQos(doc, overrides) {
  const mods = core.modulesOf(doc);
  const out = [];
  const texts = new Map(); // instance -> override object in out
  for (const o of overrides) {
    const q = qos.qosPath(`${o.instance}.${o.param}`);
    if (q && mods[q.instance] && mods[q.instance].type === 'at_bus') {
      let t = texts.get(q.instance);
      if (!t) {
        const own = (mods[q.instance].params || {}).masters;
        t = { instance: q.instance, param: 'masters', value: typeof own === 'string' ? own : '' };
        texts.set(q.instance, t);
        out.push(t);
      }
      t.value = qos.setMaster(t.value, q.master, q.key, o.value);
      continue;
    }
    if (o.param === 'masters' && texts.has(o.instance)) { texts.get(o.instance).value = String(o.value); continue; }
    if (o.param === 'masters' && mods[o.instance] && mods[o.instance].type === 'at_bus') {
      const t = Object.assign({}, o, { value: String(o.value) });
      texts.set(o.instance, t);
      out.push(t);
      continue;
    }
    out.push(o);
  }
  return out;
}

/**
 * Generate the Lua for one run: the platform with the overrides, and the
 * statistics written to outFile (a perf_stats module is added when the
 * platform has none). generateOptions: what the caller passes to
 * core.generate anyway (libraries, variableValues).
 */
function runLua(doc, { overrides = [], outFile, generateOptions = {} }) {
  const options = Object.assign({}, generateOptions);
  const stats = statsInstance(doc);
  const extra = [...(options.extraModules || [])];
  const ov = [...(options.overrides || []), ...overrides];
  if (stats) {
    ov.push({ instance: stats, param: 'output', value: outFile }, { instance: stats, param: 'stop_when_done', value: true });
  } else {
    extra.push({ name: 'perf_stats', type: 'perf_stats', dylib: LIBRARY, params: { output: outFile, stop_when_done: true } });
  }
  options.extraModules = extra;
  options.overrides = foldQos(doc, ov);
  return core.generate(doc, options);
}

/**
 * Run the simulator once. Resolves {code, signal, output, timedOut, seconds}.
 * The output keeps the last 64 KiB.
 */
function runSim({ exe, cwd, luaFile, timeoutMs = 600000, onOutput, signal }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let timedOut = false;
    let p;
    try {
      p = cp.spawn(exe, ['-l', luaFile], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, signal: null, output: e.message, timedOut: false, seconds: 0, error: e.message });
      return;
    }
    const add = (b) => {
      const s = b.toString('utf8');
      output = (output + s).slice(-65536);
      if (onOutput) onOutput(s);
    };
    p.stdout.on('data', add);
    p.stderr.on('data', add);
    const stop = () => { if (p.exitCode === null) { p.kill('SIGHUP'); setTimeout(() => p.exitCode === null && p.kill('SIGKILL'), 5000); } };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    if (signal) signal.onAbort = stop;
    let error;
    p.on('error', (e) => { error = e.message; });
    p.on('close', (code, sig) => {
      clearTimeout(timer);
      resolve({ code, signal: sig, output, timedOut, seconds: (Date.now() - started) / 1000, error });
    });
  });
}

/**
 * One experiment: write the Lua next to the platform (so ${TOP} paths hold),
 * run it, read the statistics. Resolves {ok, stats?, error?, file, output, seconds}.
 * The Lua file is removed afterwards.
 */
async function runExperiment({ doc, platformFile, exe, cwd, outFile, overrides = [], generateOptions, timeoutMs, onOutput, signal, tag = 'run' }) {
  const luaFile = path.join(path.dirname(platformFile), `.${path.basename(platformFile, '.platform.json')}.perf-${tag}-${process.pid}.lua`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  try { fs.unlinkSync(outFile); } catch (e) { /* none yet */ }
  let r;
  try {
    fs.writeFileSync(luaFile, runLua(doc, { overrides, outFile, generateOptions }));
    r = await runSim({ exe, cwd, luaFile, timeoutMs, onOutput, signal });
  } catch (e) {
    return { ok: false, error: e.message, file: outFile, output: '', seconds: 0 };
  } finally {
    try { fs.unlinkSync(luaFile); } catch (e) { /* gone */ }
  }
  let stats;
  try { stats = parseStats(fs.readFileSync(outFile, 'utf8')); } catch (e) { /* below */ }
  const base = { file: outFile, output: r.output, seconds: r.seconds, exit: { code: r.code, signal: r.signal } };
  if (r.error) return Object.assign(base, { ok: false, error: `cannot start ${exe}: ${r.error}` });
  if (r.timedOut) return Object.assign(base, { ok: false, stats, error: `timed out after ${Math.round(timeoutMs / 1000)} s` });
  if (!stats) {
    const last = r.output.trim().split('\n').slice(-3).join(' | ');
    return Object.assign(base, { ok: false, error: `no statistics were written (exit ${r.signal || r.code})${last ? ': ' + last : ''}` });
  }
  if (!stats.complete) return Object.assign(base, { ok: false, stats, error: 'the simulation ended before every traffic_gen was done' });
  if (r.code !== 0) return Object.assign(base, { ok: false, stats, error: `the simulator ended with ${r.signal || 'exit code ' + r.code}` });
  const failed = failures(stats);
  if (failed.length) return Object.assign(base, { ok: false, stats, error: `${failed.join('; ')}. ${FAILURE_HINT}` });
  return Object.assign(base, { ok: true, stats });
}

/** Parallel runs: QBox runs one SystemC thread per process, so about half the CPUs. */
const defaultJobs = () => Math.max(1, Math.floor(os.cpus().length / 2));

/**
 * Run every combination of a sweep. outDir gets run-<n>.json per run and
 * results.json. onProgress({done, total, run}) after each run. Resolves the
 * results object (see writeResults). signal: {aborted, onAbort} to cancel.
 */
async function runSweep({ spec, doc, platformFile, exe, cwd, outDir, generateOptions, jobs, onProgress, signal, specFile, timeoutMs: fallbackMs }) {
  const runs = expandSweep(spec);
  const timeoutMs = spec.timeoutSeconds ? spec.timeoutSeconds * 1000 : fallbackMs || 600000;
  const n = Math.max(1, Math.min(jobs || spec.jobs || defaultJobs(), runs.length));
  fs.mkdirSync(outDir, { recursive: true });
  const results = new Array(runs.length);
  let next = 0;
  let done = 0;
  const aborters = new Set();
  if (signal) signal.onAbort = () => { for (const a of aborters) if (a.onAbort) a.onAbort(); };
  const worker = async () => {
    while (next < runs.length && !(signal && signal.aborted)) {
      const run = runs[next++];
      const sig = { onAbort: null };
      aborters.add(sig);
      const r = await runExperiment({
        doc, platformFile, exe, cwd, generateOptions, timeoutMs, signal: sig, tag: String(run.index),
        outFile: path.join(outDir, `run-${run.index}.json`), overrides: run.overrides,
      });
      aborters.delete(sig);
      results[run.index] = { index: run.index, values: run.values, label: runLabel(run.values), ok: r.ok, error: r.error, file: path.basename(r.file), seconds: r.seconds, stats: r.stats, output: r.ok ? undefined : r.output.slice(-4000) };
      done++;
      if (onProgress) onProgress({ done, total: runs.length, run: results[run.index] });
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
  const out = {
    format: 'vp-perf-sweep', version: 1, created: new Date().toISOString(),
    platform: path.basename(platformFile), sweep: spec.sweep, metrics: spec.metrics || [], checks: spec.checks || [],
    specFile: specFile ? path.basename(specFile) : undefined, cancelled: !!(signal && signal.aborted),
    runs: results.filter(Boolean).map((r) => Object.assign({}, r, { stats: undefined, metrics: r.stats ? metricsOf(r.stats, spec.metrics, (spec.checks || []).map((c) => c.metric)) : {} })),
  };
  out.checkResults = evaluateChecks(out, spec.checks || []);
  writeResults(outDir, out);
  return out;
}

/** The metrics of one run: the listed paths, or every initiator's bandwidth and latency and every memory's. */
function metricsOf(stats, paths, also = []) {
  const list = [...new Set([...(paths && paths.length ? paths : defaultMetrics(stats)), ...also.filter((x) => typeof x === 'string')])];
  const m = {};
  for (const p of list) m[p] = metric(stats, p);
  return m;
}

function defaultMetrics(stats) {
  const out = [];
  for (const g of stats.initiators || []) {
    const n = g.label || lastPart(g.name);
    out.push(`initiators.${n}.bandwidthMBps`, `initiators.${n}.latencyNs.mean`, `initiators.${n}.latencyNs.p99`);
  }
  for (const mm of stats.memories || []) out.push(`memories.${lastPart(mm.name)}.bandwidthMBps`, `memories.${lastPart(mm.name)}.rowHitRate`);
  return out;
}

/** The metric names over every run, in order of first appearance. */
const metricNames = (results) => {
  const seen = new Set();
  for (const r of results.runs) for (const k of Object.keys(r.metrics || {})) seen.add(k);
  return [...seen];
};

/** CSV: one row per run, the swept parameters then the metrics. */
function resultsCsv(results) {
  const params = (results.sweep || []).map((s) => s.param);
  const metrics = metricNames(results);
  const q = (v) => {
    const s = v === undefined || v === null ? '' : typeof v === 'string' ? v : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['run', ...params, 'ok', ...metrics, 'error'].map(q).join(',')];
  for (const r of results.runs) {
    lines.push([r.index, ...params.map((p) => r.values[p]), r.ok, ...metrics.map((m) => r.metrics[m]), r.error || ''].map(q).join(','));
  }
  return lines.join('\n') + '\n';
}

/** CSV of one run: a row per initiator, then a row per memory. */
function runCsv(stats) {
  const s = summary(stats);
  const lines = ['kind,name,reads,writes,bytes,bandwidth_MBps,latency_mean_ns,latency_p50_ns,latency_p99_ns,latency_max_ns,row_hit_rate,data_bus_utilization'];
  const q = (v) => (v === undefined || v === null ? '' : String(v));
  for (const g of s.initiators) lines.push(['initiator', g.label, g.reads, g.writes, g.bytes, g.bandwidthMBps, g.mean, g.p50, g.p99, g.max, '', ''].map(q).join(','));
  for (const m of s.memories) lines.push(['memory', m.label, '', '', '', m.bandwidthMBps, m.serviceMean, '', m.serviceP99, '', m.rowHitRate, m.dataBusUtilization].map(q).join(','));
  return lines.join('\n') + '\n';
}

function writeResults(outDir, results) {
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'results.csv'), resultsCsv(results));
}

/**
 * The checks of a sweep, on each run they apply to (where: {param: value}):
 * [{name, ok, message}]. A run that failed fails every check on it.
 */
function evaluateChecks(results, checks) {
  const out = [];
  for (const c of checks) {
    for (const r of results.runs) {
      if (c.where && Object.entries(c.where).some(([k, v]) => JSON.stringify(r.values[k]) !== JSON.stringify(v))) continue;
      const name = `${c.metric} (${r.label})`;
      if (!r.ok) { out.push({ name, ok: false, message: `run failed: ${r.error}` }); continue; }
      const v = r.metrics[c.metric];
      if (typeof v !== 'number') { out.push({ name, ok: false, message: `${c.metric} is not in the statistics` }); continue; }
      const low = c.min !== undefined && v < c.min;
      const high = c.max !== undefined && v > c.max;
      const bound = [c.min !== undefined ? `>= ${c.min}` : '', c.max !== undefined ? `<= ${c.max}` : ''].filter(Boolean).join(' and ');
      out.push({ name, ok: !low && !high, value: v, message: `${fmt(v)} (expected ${bound})` });
    }
  }
  return out;
}

/** A metric value for display: integers as they are, others to 4 significant digits. */
function fmt(v) {
  if (typeof v !== 'number' || !isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  return a >= 1000 ? v.toFixed(0) : a >= 1 ? Number(v.toPrecision(4)).toString() : Number(v.toPrecision(3)).toString();
}

/** Where a sweep's results go: <sweep folder>/perf-results/<sweep name>-<time>. */
function resultsDir(specFile, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  return path.join(path.dirname(specFile), 'perf-results', `${path.basename(specFile, SWEEP_SUFFIX)}-${stamp}`);
}

/** Read a sweep file and the platform it names (relative to the sweep file). */
function loadSweep(specFile) {
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  if (!spec.platform || typeof spec.platform !== 'string') throw new Error(`${path.basename(specFile)}: "platform" (the platform file) is missing`);
  const platformFile = path.resolve(path.dirname(specFile), spec.platform);
  const doc = JSON.parse(fs.readFileSync(platformFile, 'utf8'));
  return { spec, platformFile, doc };
}

/** A starting sweep file for a platform: its generators' max_outstanding, its buses' arbitration. */
function sweepTemplate(doc, platformRel) {
  const mods = core.modulesOf(doc);
  const gens = Object.entries(mods).filter(([, m]) => m && m.type === 'traffic_gen').map(([n]) => n);
  const buses = Object.entries(mods).filter(([, m]) => m && m.type === 'at_bus').map(([n]) => n);
  const sweep = [];
  if (gens.length) sweep.push({ param: `${gens[gens.length - 1]}.max_outstanding`, values: [1, 2, 4, 8, 16] });
  if (buses.length) sweep.push({ param: `${buses[0]}.arbitration`, values: ['round_robin', 'priority'] });
  const metrics = [];
  for (const g of gens) metrics.push(`initiators.${lastPart(g)}.bandwidthMBps`, `initiators.${lastPart(g)}.latencyNs.p99`);
  const mems = Object.entries(mods).filter(([, m]) => m && m.type === 'dram_ctrl').map(([n]) => n);
  for (const m of mems) metrics.push(`memories.${lastPart(m)}.dataBusUtilization`, `memories.${lastPart(m)}.rowHitRate`);
  return { platform: platformRel, sweep, metrics, checks: [] };
}

module.exports = {
  foldQos, failures,
  LIBRARY, TYPES, SWEEP_SUFFIX, STATS_FORMAT,
  isPerfPlatform, statsInstance, parseStats, metric, listMetrics, summary, splitParam, checkSweep, runCount, expandSweep, runLabel,
  runLua, runSim, runExperiment, runSweep, metricsOf, defaultMetrics, metricNames, resultsCsv, runCsv, writeResults, evaluateChecks, fmt,
  resultsDir, loadSweep, sweepTemplate, defaultJobs,
};
