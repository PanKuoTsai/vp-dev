'use strict';
// Transaction tracing: which bus-mapped ports of a platform can be traced, the
// generator options that put a vp_tracer (tools/sim-agent) in front of each
// chosen one, and decoding of the records the agent returns.
// No VS Code dependency.

const core = require('./core');

/** Module type names of QBox's probes and debug_dap components (agent 0.14.0 and later). */
const TYPES = { tracer: 'tracer', signal: 'signal_tracer', dap: 'debug_dap' };
/** The same modules as agents up to 0.13.0 carried them in their own library. */
const AGENT_TYPES = { tracer: 'vp_tracer', signal: 'vp_signal_tracer', dap: 'vp_debug_dap' };

/**
 * Where the probes and the debug port come from, for an agent of this version:
 * { probes: dylib of the tracers, dap: dylib of the port (null: QBox finds it
 *   by its type name), types: { tracer, signal, dap } module type names,
 *   inQbox: whether they are QBox components, files: [libraries the QBox build must have] }.
 * Agent 0.14.0 and later: QBox's probes (build/probes.so, types tracer and
 * signal_tracer) and debug_dap (build/debug_dap.so, type debug_dap)
 * components. Older agents carry vp_tracer, vp_signal_tracer and
 * vp_debug_dap in their own library.
 */
function probeLibraries(agentVersion, agentLib, versionAtLeast) {
  if (versionAtLeast(agentVersion, '0.14.0')) return { probes: 'probes', dap: null, types: { ...TYPES }, inQbox: true, files: ['probes.so', 'debug_dap.so'] };
  return { probes: agentLib, dap: agentLib, types: { ...AGENT_TYPES }, inQbox: false, files: [] };
}
const catalogLib = require('./catalog');

/**
 * Ports that can be traced: a target socket of a module that is not
 * replicated, written without {i} or repeat, with an address, bound to a bus.
 * [{ id: "module.port", module, port, address (BigInt|null), size, bus, type, memory }]
 */
function tracePoints(doc) {
  const analysis = core.analyze(doc);
  const buses = new Set(analysis.routers);
  const out = [];
  for (const inst of analysis.instances) {
    if (inst.index !== null) continue;
    for (const p of inst.ports) {
      if (p.raw.address === undefined || p.raw.repeat !== undefined || /\{i\}/.test(p.name) || !buses.has(p.peer)) continue;
      out.push({
        id: `${inst.base}.${p.name}`, module: inst.base, port: p.name, address: p.address, size: p.size,
        bus: p.peer, type: inst.type, memory: /memory/i.test(inst.type),
      });
    }
  }
  return out.sort((a, b) => (a.address === null ? 1 : b.address === null ? -1 : a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}

/**
 * Signal connections that can be traced (G-07): one end a signal output, the
 * other a signal input, as the catalog says. The id is the source port
 * ("pl011_uart_0.irq"); a vp_signal_tracer goes between the two ends.
 *
 * Connections between two QEMU sockets are left out. QBox sets such a GPIO
 * inside QEMU directly; with a SystemC module in between, every change waits
 * for the SystemC thread instead. On the GIC's lines to the CPUs that stopped
 * Linux from booting (2026-11-15), so they are not offered at all.
 * [{ id, kind: 'signal', source, sourcePort, dest, destPort, declaredBy: 'source'|'dest', type }]
 */
function signalPoints(doc, catalog) {
  if (!catalog) return [];
  const analysis = core.analyze(doc);
  const byName = new Map(analysis.instances.map((i) => [i.name, i]));
  const portOf = (instName, port) => {
    const inst = byName.get(instName);
    const info = inst && catalogLib.moduleInfo(catalog, inst.type);
    if (!catalogLib.introspected(info)) return undefined;
    return catalogLib.findPort(info, port) || undefined;
  };
  const qemu = (p) => /QemuInitiatorSignalSocket|QemuTargetSignalSocket/.test(p.cppType || '');
  const out = [];
  const seen = new Set();
  for (const c of analysis.connections) {
    const pa = portOf(c.from, c.fromPort);
    const pb = portOf(c.to, c.toPort);
    if (!pa || !pb || (qemu(pa) && qemu(pb))) continue;
    const a = pa.kind;
    const b = pb.kind;
    let p;
    if (a === 'signal_out' && b === 'signal_in') p = { source: c.from, sourcePort: c.fromPort, dest: c.to, destPort: c.toPort, declaredBy: 'source' };
    else if (a === 'signal_in' && b === 'signal_out') p = { source: c.to, sourcePort: c.toPort, dest: c.from, destPort: c.fromPort, declaredBy: 'dest' };
    else continue;
    p.id = `${p.source}.${p.sourcePort}`;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    p.kind = 'signal';
    p.type = byName.get(p.source).type;
    out.push(p);
  }
  return out.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/**
 * Every place a probe can go (G-12): the bus-mapped ports of tracePoints and
 * the signals of signalPoints.
 * [{ id, kind: 'bus'|'memory'|'signal', description }]
 */
function probeList(doc, catalog) {
  const bus = tracePoints(doc).map((p) => ({
    id: p.id, kind: p.memory ? 'memory' : 'bus',
    description: `${p.address === null ? '?' : core.hex(p.address)}${p.size !== null && p.size !== undefined ? ` (${core.hex(p.size)})` : ''} · ${p.type}`,
  }));
  const sig = signalPoints(doc, catalog).map((s) => ({ id: s.id, kind: 'signal', description: `→ ${s.dest}.${s.destPort} · signal` }));
  return bus.concat(sig);
}

/**
 * Generator options that trace the chosen points (ids "module.port"):
 * { extraModules, portOverrides }. Each tracer takes over the port's address,
 * size, priority and bus binding; the port is rebound to the tracer.
 * opts.recording: the ids that record from the start (each tracer gets its
 * `record` parameter, agent 0.9.0 and later); without it every tracer records.
 * opts.router: give each bus tracer the router in front of it (its `router`
 * parameter, agent 0.12.0 and later), so records name the initiator.
 * opts.types: { tracer, signal } module type names (probeLibraries(…).types;
 * default: QBox's tracer and signal_tracer).
 */
function traceOptions(doc, ids, dylib, catalog, opts = {}) {
  const rec = opts.recording ? new Set(opts.recording) : null;
  const types = Object.assign({}, TYPES, opts.types || {});
  const withRecord = (params, id) => (rec ? { ...params, record: rec.has(id) } : params);
  const points = new Map(tracePoints(doc).map((p) => [p.id, p]));
  const signals = new Map(signalPoints(doc, catalog).map((p) => [p.id, p]));
  const extraModules = [];
  const portOverrides = [];
  const taken = new Set(Object.keys(core.modulesOf(doc)));
  ids.forEach((id) => {
    const sig = !points.has(id) && signals.get(id);
    if (sig) {
      let name = `trace_sig_${sig.source}_${sig.sourcePort}`.replace(/[^A-Za-z0-9_]/g, '_');
      while (taken.has(name)) name += '_';
      taken.add(name);
      // The tracer takes the place of the end that does not declare the binding,
      // so the platform's own port keeps declaring it, now towards the tracer.
      if (sig.declaredBy === 'source') {
        extraModules.push({ name, type: types.signal, dylib, params: withRecord({ label: id }, id), ports: { out: { bind: `${sig.dest}.${sig.destPort}` } } });
        portOverrides.push({ instance: sig.source, port: sig.sourcePort, value: { bind: `${name}.in` } });
      } else {
        extraModules.push({ name, type: types.signal, dylib, params: withRecord({ label: id }, id), ports: { in: { bind: `${sig.source}.${sig.sourcePort}` } } });
        portOverrides.push({ instance: sig.dest, port: sig.destPort, value: { bind: `${name}.out` } });
      }
      return;
    }
    const p = points.get(id);
    if (!p) throw new Error(`${id} cannot be traced (it must be a bus-mapped port of a module that is not replicated)`);
    const raw = core.modulesOf(doc)[p.module].ports[p.port];
    let name = `trace_${p.module}_${p.port}`.replace(/[^A-Za-z0-9_]/g, '_');
    while (taken.has(name)) name += '_';
    taken.add(name);
    const tport = { address: raw.address, size: raw.size, bind: raw.bind };
    if (raw.priority !== undefined) tport.priority = raw.priority;
    // A memory traced without DMI would slow every CPU access; devices are traced fully.
    extraModules.push({ name, type: types.tracer, dylib, params: withRecord({ label: id, allow_dmi: p.memory, ...(opts.router ? { router: p.bus } : {}) }, id), ports: { target_socket: tport } });
    // The port's own address and size stay: some modules read them (gs_memory
    // takes its size from target_socket.size). The bus sees only the tracer.
    const keep = { address: raw.address, size: raw.size, bind: `${name}.initiator_socket` };
    portOverrides.push({ instance: p.module, port: p.port, value: keep });
  });
  return { extraModules, portOverrides };
}

const STATUS = { 1: 'OK', 0: 'INCOMPLETE', '-1': 'GENERIC_ERROR', '-2': 'ADDRESS_ERROR', '-3': 'COMMAND_ERROR', '-4': 'BURST_ERROR', '-5': 'BYTE_ENABLE_ERROR' };

/** Little-endian value of the first bytes, as hex, for accesses of 1 to 8 bytes. */
function leValue(hex, length) {
  if (!(length >= 1 && length <= 8) || hex.length < 2 * length) return null;
  let v = '';
  for (let i = length - 1; i >= 0; i--) v += hex.slice(2 * i, 2 * i + 2);
  return '0x' + v.replace(/^0+(?=.)/, '');
}

/**
 * Decode trace.read records ([seq, time_s, point, "R"|"W", address, length,
 * data_hex, status, initiator]) into objects, with the point's name and a
 * little-endian value. initiator ("cpu_3.mem", agent 0.12.0) is '' when unknown.
 */
function decodeRecords(res) {
  const points = res.points || [];
  return (res.records || []).map(([seq, time, point, dir, address, length, data, status, initiator]) => ({
    seq, time, point: points[point] !== undefined ? points[point] : String(point), dir, address: dir === 'S' ? '' : address, length, data,
    value: dir === 'S' ? (data === '01' ? '1' : '0') : leValue(data, length), status: STATUS[status] || String(status),
    initiator: initiator || '',
  }));
}

/**
 * A VCD file (IEEE 1364 value change dump) of the signal changes among the
 * records, one 1-bit wire per trace point, timescale 1 ps. initial: the value
 * before the first change ('0', or 'x' when older records were dropped).
 */
function toVcd(records, { initial = '0', date = new Date().toISOString() } = {}) {
  const sig = records.filter((r) => r.dir === 'S');
  const names = [...new Set(sig.map((r) => r.point))].sort();
  const code = (i) => {
    let s = '';
    do { s += String.fromCharCode(33 + (i % 94)); i = Math.floor(i / 94) - 1; } while (i >= 0);
    return s;
  };
  const ids = new Map(names.map((n, i) => [n, code(i)]));
  const out = [
    `$date ${date} $end`, '$version VP Studio $end', '$timescale 1ps $end', '$scope module vp $end',
    ...names.map((n) => `$var wire 1 ${ids.get(n)} ${n.replace(/[^A-Za-z0-9_.[\]]/g, '_')} $end`),
    '$upscope $end', '$enddefinitions $end', '#0', '$dumpvars', ...names.map((n) => `${initial}${ids.get(n)}`), '$end',
  ];
  // By time; changes made on different threads can reach the store slightly out of order.
  const sorted = sig.map((r, i) => ({ r, i, ps: BigInt(Math.round(r.time * 1e12)) }))
    .sort((a, b) => (a.ps < b.ps ? -1 : a.ps > b.ps ? 1 : a.i - b.i));
  let at = null;
  for (const { r, ps } of sorted) {
    if (at === null || ps !== at) { out.push(`#${ps}`); at = ps; }
    out.push(`${r.value === '1' ? '1' : '0'}${ids.get(r.point)}`);
  }
  return out.join('\n') + '\n';
}

/** CSV of decoded records. */
function toCsv(records) {
  const q = (s) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  const rows = [['seq', 'time_s', 'point', 'dir', 'address', 'length', 'value', 'data', 'status', 'initiator']];
  for (const r of records) rows.push([r.seq, r.time, r.point, r.dir, r.address, r.length, r.value || '', r.data, r.status, r.initiator || '']);
  return rows.map((r) => r.map(q).join(',')).join('\n') + '\n';
}

// ------------------------------------------------------------------ bus breakpoints

const U64_MAX = (1n << 64n) - 1n;

/** "0x10", "16" -> BigInt, or undefined when it is not a number in 0..2^64-1. */
function parseU64(text) {
  const t = String(text).trim();
  if (!/^(0x[0-9a-f]+|\d+)$/i.test(t)) return undefined;
  const v = BigInt(t);
  return v <= U64_MAX ? v : undefined;
}
const hex64 = (v) => '0x' + v.toString(16);

/**
 * A breakpoint typed in the trace panel, as the sim agent's break.set wants it.
 * input: { point ('' for any), access ('r'|'w'|'rw'), address ('0x1000' or
 * '0x1000-0x1fff'), value ('' or '0x0a'), mask ('' or '0xff': the bits of the data
 * compared; empty compares all of them) }.
 * Returns the agent's object (numbers as hex strings), or throws Error with a
 * message for the panel.
 */
function parseBreakInput(input) {
  const out = {};
  if (input.point) out.point = String(input.point);
  const access = input.access || 'rw';
  if (!['r', 'w', 'rw'].includes(access)) throw new Error('Access must be read, write or any');
  out.access = access;
  const addr = String(input.address || '').trim();
  if (addr) {
    const m = /^([^-\s]+)\s*(?:-\s*([^-\s]+))?$/.exec(addr);
    const lo = m && parseU64(m[1]);
    const hi = m && (m[2] === undefined ? lo : parseU64(m[2]));
    if (lo === undefined || hi === undefined) throw new Error('Address: enter 0x1000, or a range such as 0x1000-0x1fff');
    if (hi < lo) throw new Error('Address: the end of the range is below its start');
    out.from = hex64(lo);
    out.to = hex64(hi);
  } else if (!input.point) {
    throw new Error('Fill in the Address of the breakpoint (in the Break on row; the Address above only filters the table), or choose a trace point');
  }
  const val = String(input.value || '').trim();
  const maskText = String(input.mask || '').trim();
  if (val) {
    const v = parseU64(val);
    if (v === undefined) throw new Error('Value: enter a number such as 0x0a');
    let mask = U64_MAX;
    if (maskText) {
      mask = parseU64(maskText);
      if (mask === undefined) throw new Error('Mask: enter a number such as 0xff, or leave it empty to compare the whole value');
      if (mask === 0n) throw new Error('Mask: 0 would compare no bit at all; leave it empty to compare the whole value');
    }
    out.value = hex64(v);
    out.mask = hex64(mask);
  } else if (maskText) {
    throw new Error('Mask: give a Value too (the mask selects which bits of the value are compared)');
  }
  return out;
}

/** One line for a breakpoint: "#2 pl011_uart_0.target_socket write 0x10000000 value 0xa mask 0xff". */
function breakLabel(b) {
  const access = { r: 'read', w: 'write', rw: 'access' }[b.access] || b.access;
  const where = b.from === undefined ? 'anywhere' : b.from === b.to ? b.from : `${b.from}-${b.to}`;
  const value = b.value === undefined ? '' : ` value ${b.value}${b.mask && BigInt(b.mask) !== U64_MAX ? ' mask ' + b.mask : ''}`;
  return `#${b.id} ${b.point || 'any point'} ${access} ${where}${value}`;
}

/** What stopped the simulation, from a status's breakpointHit. */
function describeHit(hit) {
  const r = hit.record;
  const value = leValue(r.data, r.length);
  const what = `${r.rw === 'W' ? 'write' : 'read'} ${r.address}${value ? ` ${r.rw === 'W' ? '=' : '→'} ${value}` : ''} on ${r.point}${r.initiator ? ` by ${r.initiator}` : ''}`;
  let more = '';
  if (hit.accessesAfter) {
    more = ` The CPUs made ${hit.accessesAfter} more traced access${hit.accessesAfter > 1 ? 'es' : ''} before the pause took hold` +
      (hit.matchesAfter ? `; ${hit.matchesAfter} of them matched a breakpoint too and did not stop it.` : '.');
  }
  return `Breakpoint #${hit.breakpoint}: ${what}.${more}`;
}

module.exports = { TYPES, AGENT_TYPES, probeLibraries, tracePoints, signalPoints, probeList, toVcd, traceOptions, decodeRecords, leValue, toCsv, parseBreakInput, breakLabel, describeHit };
