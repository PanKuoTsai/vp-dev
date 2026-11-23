'use strict';
// Interrupt controller view: the state of every interrupt of an Arm GICv3
// (QBox's arm_gicv3) read through the sim agent's mem.read, with the device
// each one comes from (the platform's spi_in_N / ppi_in_cpu_K_N bindings) and
// why a wired interrupt does not reach a CPU. Only registers without read side
// effects are read (never IAR, never the CPU interface).
// No VS Code dependency.

const core = require('../platform/core');

const GICR_STRIDE = 0x20000; // RD_base + SGI_base frames of a GICv3 redistributor
const MAX_READ = 4096;       // mem.read limit

const hexs = (v) => '0x' + BigInt(v).toString(16);

/**
 * The GICv3 instances of a platform with where they are and what drives them:
 * [{ name, bus (router index), dist (BigInt), redist (BigInt), redistSize,
 *    sources: Map(intid -> [{module, port, cpu?}]) }].
 */
function layout(doc) {
  const a = core.analyze(doc);
  const out = [];
  for (const inst of a.instances.filter((x) => x.type === 'arm_gicv3')) {
    const port = (n) => inst.ports.find((p) => p.name === n);
    const d = port('dist_iface');
    const r = inst.ports.find((p) => /^redist_iface_\d+$/.test(p.name) && p.address !== undefined);
    if (!d || d.address === undefined || !r) continue;
    const bus = a.routers.indexOf(d.peer);
    const sources = new Map();
    const add = (intid, s) => { if (!sources.has(intid)) sources.set(intid, []); sources.get(intid).push(s); };
    for (const c of a.connections) {
      let mod, myPort, gicPort;
      if (c.to === inst.name) { mod = c.from; myPort = c.fromPort; gicPort = c.toPort; } else if (c.from === inst.name) { mod = c.to; myPort = c.toPort; gicPort = c.fromPort; } else continue;
      let m = /^spi_in_(\d+)$/.exec(gicPort);
      if (m) { add(32 + Number(m[1]), { module: mod, port: myPort }); continue; }
      m = /^ppi_in_cpu_(\d+)_(\d+)$/.exec(gicPort);
      if (m) add(Number(m[2]), { module: mod, port: myPort, cpu: Number(m[1]) });
    }
    out.push({ name: inst.name, bus: bus < 0 ? 0 : bus, dist: d.address, redist: r.address, redistSize: r.size || BigInt(GICR_STRIDE), sources });
  }
  return out;
}

/**
 * Split [address, length) into mem.read requests of at most MAX_READ bytes,
 * each made of `width`-byte register accesses (QEMU's GIC answers only 4 and
 * 8 byte accesses; mem.read's width parameter, agent 0.15.0).
 */
function chunks(key, address, length, width = 4) {
  const out = [];
  for (let off = 0; off < length; off += MAX_READ) out.push({ key, offset: off, address: BigInt(address) + BigInt(off), size: Math.min(MAX_READ, length - off), width });
  return out;
}

/**
 * The same reads for an agent without mem.read's width (before 0.15.0): one
 * request per register.
 */
function oneByOne(reads) {
  const out = [];
  for (const r of reads) for (let off = 0; off < r.size; off += r.width) out.push({ key: r.key, offset: r.offset + off, address: r.address + BigInt(off), size: r.width, width: r.width });
  return out;
}

/** First read: the distributor's CTLR, TYPER, IIDR, TYPER2. */
function probeReads(g) {
  return [{ key: 'dist.head', offset: 0, address: g.dist, size: 16, width: 4 }];
}

/** Redistributor i's first registers (CTLR, IIDR, TYPER, STATUSR, WAKER); read one after another until GICR_TYPER.Last. */
function redistHeadRead(g, i) {
  return { key: `rd${i}.head`, offset: 0, address: g.redist + BigInt(i * GICR_STRIDE), size: 24, width: 4 };
}

/** How many redistributor frames the region can hold. */
const redistFrames = (g) => Math.max(1, Math.min(256, Number(BigInt(g.redistSize) / BigInt(GICR_STRIDE))));

const u32 = (buf, off) => (off + 4 <= buf.length ? buf.readUInt32LE(off) : 0);
const u64 = (buf, off) => (off + 8 <= buf.length ? buf.readBigUInt64LE(off) : 0n);

/**
 * From the probe: { lines (INTIDs implemented, multiple of 32), ctlr, typer,
 * redists: [{index, cpu, affinity, last, waker}] } (stops after GICR_TYPER.Last).
 */
function parseProbe(g, data) {
  const head = data.get('dist.head') || Buffer.alloc(16);
  const typer = u32(head, 4);
  const lines = Math.min(1020, 32 * ((typer & 0x1f) + 1));
  const redists = [];
  for (let i = 0; data.has(`rd${i}.head`); i++) {
    const b = data.get(`rd${i}.head`);
    const t = u64(b, 8);
    redists.push({ index: i, cpu: Number((t >> 8n) & 0xffffn), affinity: Number(t >> 32n), last: !!(t & 0x10n), waker: u32(b, 0x14) });
    if (t & 0x10n) break;
  }
  return { lines, ctlr: u32(head, 0), typer, iidr: u32(head, 8), redists };
}

/** The reads for the whole state, after parseProbe. */
function stateReads(g, probe) {
  const n = probe.lines;
  const d = g.dist;
  const bits = n / 8;
  const reads = [
    ...chunks('IGROUPR', d + 0x80n, bits), ...chunks('ISENABLER', d + 0x100n, bits), ...chunks('ISPENDR', d + 0x200n, bits),
    ...chunks('ISACTIVER', d + 0x300n, bits), ...chunks('IPRIORITYR', d + 0x400n, n), ...chunks('ICFGR', d + 0xc00n, n / 4),
    ...chunks('IGRPMODR', d + 0xd00n, bits),
  ];
  if (n > 32) reads.push(...chunks('IROUTER', d + 0x6000n + 8n * 32n, (n - 32) * 8, 8));
  for (const r of probe.redists) {
    const sgi = g.redist + BigInt(r.index * GICR_STRIDE) + 0x10000n;
    for (const [k, off, size] of [['IGROUPR0', 0x80, 4], ['ISENABLER0', 0x100, 4], ['ISPENDR0', 0x200, 4], ['ISACTIVER0', 0x300, 4], ['IPRIORITYR', 0x400, 32], ['ICFGR', 0xc00, 8], ['IGRPMODR0', 0xd00, 4]]) {
      reads.push({ key: `rd${r.index}.${k}`, offset: 0, address: sgi + BigInt(off), size, width: 4 });
    }
  }
  return reads;
}

/** Join the chunks of each key into one Buffer. results: [{read, data (hex string)}]. */
function gather(results) {
  const parts = new Map();
  for (const { read, data } of results) {
    if (!parts.has(read.key)) parts.set(read.key, []);
    parts.get(read.key).push({ offset: read.offset, buf: Buffer.from(String(data || ''), 'hex') });
  }
  const out = new Map();
  for (const [k, list] of parts) out.set(k, Buffer.concat(list.sort((x, y) => x.offset - y.offset).map((p) => p.buf)));
  return out;
}

const bit = (buf, i) => !!(buf && i >> 3 < buf.length && (buf[i >> 3] >> (i & 7)) & 1);

/** GICD_CTLR in words. DS (bit 6) set: one security state. */
function ctlrInfo(ctlr) {
  const ds = !!(ctlr & 0x40);
  return ds
    ? { ds, grp0: !!(ctlr & 1), grp1: !!(ctlr & 2), are: !!(ctlr & 0x10) }
    : { ds, grp0: !!(ctlr & 1), grp1: !!(ctlr & 2), grp1s: !!(ctlr & 4), are: !!(ctlr & 0x30) };
}

const affText = (aff) => `${(aff >>> 24) & 0xff}.${(aff >> 16) & 0xff}.${(aff >> 8) & 0xff}.${aff & 0xff}`;

/**
 * Every interrupt's state, with problems:
 * { dist: {...ctlrInfo, lines}, cpus: [{cpu, affinity, asleep}], rows: [{intid, kind, cpu?,
 *   sources, enabled, pending, active, priority, edge, group, route, problems: [{level, text}]}] }.
 * PPIs and SGIs come once per CPU (cpu set).
 */
function interpret(g, probe, data) {
  const dist = Object.assign({ lines: probe.lines }, ctlrInfo(probe.ctlr));
  const cpus = probe.redists.map((r) => ({ cpu: r.cpu, index: r.index, affinity: affText(r.affinity), affinityRaw: r.affinity, asleep: !!(r.waker & 4), sleepRequested: !!(r.waker & 2) }));
  const byAff = new Map(cpus.map((c) => [c.affinityRaw, c]));
  const groupOf = (g1, mod) => (!g1 ? (mod && !dist.ds ? 'G1S' : 'G0') : 'G1');
  const groupOn = (grp) => (grp === 'G0' ? dist.grp0 : grp === 'G1' ? dist.grp1 : !!dist.grp1s);
  const rows = [];
  const common = (r) => {
    const p = r.problems;
    const wired = r.sources.length > 0;
    // Often on purpose (an unused timer, a PCIe line without a device), so not a warning.
    if (wired && !r.enabled) p.push({ level: 'info', text: 'disabled: software has not enabled it (GICD_ISENABLER / GICR_ISENABLER0)' });
    if (r.enabled && !groupOn(r.group)) p.push({ level: 'error', text: `${r.group === 'G0' ? 'group 0' : 'group 1'} is disabled in GICD_CTLR, so it is never forwarded` });
    if (r.enabled && r.priority === 0xff) p.push({ level: 'warning', text: 'priority 0xFF is never higher than a CPU\'s priority mask, so it is never signalled' });
    if (r.enabled && !wired && r.kind === 'SPI') p.push({ level: 'info', text: 'enabled, but nothing in the platform drives this line' });
    if (r.pending && r.enabled && !p.some((x) => x.level === 'error')) p.push({ level: 'info', text: r.active ? 'active and pending again' : 'pending: waiting for its CPU (masked by PSTATE.I or ICC_PMR_EL1, or a higher priority is active)' });
  };
  const ig = data.get('IGROUPR');
  const en = data.get('ISENABLER');
  const pe = data.get('ISPENDR');
  const ac = data.get('ISACTIVER');
  const pr = data.get('IPRIORITYR');
  const cf = data.get('ICFGR');
  const gm = data.get('IGRPMODR');
  const ro = data.get('IROUTER');
  for (let id = 32; id < probe.lines; id++) {
    const r = {
      intid: id, kind: 'SPI', sources: g.sources.get(id) || [], enabled: bit(en, id), pending: bit(pe, id), active: bit(ac, id),
      priority: pr && id < pr.length ? pr[id] : 0, edge: bit(cf, 2 * id + 1), group: groupOf(bit(ig, id), bit(gm, id)), problems: [],
    };
    if (dist.are && ro) {
      const v = u64(ro, (id - 32) * 8);
      if (v & 0x80000000n) r.route = { any: true, text: 'any CPU (1 of N)' };
      else {
        const aff = Number(((v >> 32n) & 0xffn) << 24n | (v & 0xffffffn));
        const c = byAff.get(aff);
        r.route = { aff: affText(aff), cpu: c ? c.cpu : undefined, text: c ? `CPU ${c.cpu}` : `affinity ${affText(aff)}` };
        if (r.enabled && !c) r.problems.push({ level: 'error', text: `routed to affinity ${affText(aff)}, which no CPU has (GICD_IROUTER)` });
        else if (r.enabled && c.asleep) r.problems.push({ level: 'error', text: `routed to CPU ${c.cpu}, whose redistributor is asleep (GICR_WAKER.ChildrenAsleep)` });
      }
    }
    common(r);
    rows.push(r);
  }
  for (const c of probe.redists) {
    const k = (n) => data.get(`rd${c.index}.${n}`);
    for (let id = 0; id < 32; id++) {
      const r = {
        intid: id, kind: id < 16 ? 'SGI' : 'PPI', cpu: c.cpu,
        sources: (g.sources.get(id) || []).filter((s) => s.cpu === undefined || s.cpu === c.cpu),
        enabled: bit(k('ISENABLER0'), id), pending: bit(k('ISPENDR0'), id), active: bit(k('ISACTIVER0'), id),
        priority: k('IPRIORITYR') ? k('IPRIORITYR')[id] : 0, edge: id < 16 ? true : bit(k('ICFGR'), 2 * id + 1),
        group: groupOf(bit(k('IGROUPR0'), id), bit(k('IGRPMODR0'), id)), route: { cpu: c.cpu, text: `CPU ${c.cpu}` }, problems: [],
      };
      if (r.enabled && (c.waker & 4)) r.problems.push({ level: 'error', text: `CPU ${c.cpu}'s redistributor is asleep (GICR_WAKER.ChildrenAsleep)` });
      common(r);
      rows.push(r);
    }
  }
  return { gic: g.name, dist, cpus, rows };
}

/** Rows worth showing by default: wired, enabled, pending or active (per-CPU PPIs and SGIs only if so). */
function interesting(r) {
  return r.sources.length > 0 || r.enabled || r.pending || r.active;
}

/** Counts for the summary strip. */
function summary(state) {
  const rows = state.rows;
  return {
    wired: rows.filter((r) => r.sources.length).length,
    enabled: rows.filter((r) => r.enabled).length,
    pending: rows.filter((r) => r.pending).length,
    active: rows.filter((r) => r.active).length,
    problems: rows.filter((r) => r.problems.some((p) => p.level !== 'info')).length,
  };
}

module.exports = { GICR_STRIDE, layout, probeReads, redistHeadRead, redistFrames, oneByOne, parseProbe, stateReads, gather, ctlrInfo, interpret, interesting, summary, hexs };
