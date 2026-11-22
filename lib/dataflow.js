'use strict';
// Data flow of a platform: which address ranges an initiator (CPU, loader,
// PCIe master) reaches through the routers, and which initiators reach a
// target. Computed from core.analyze's connections and memory map, without
// running the simulation. No VS Code dependency.
//
// A router decodes an access to the target whose range holds the address; when
// ranges overlap, the lower priority number answers (priority > 0 is a
// background region such as a fallback memory). A router that is itself a
// target of another router sees addresses relative to its window (QBox's
// router: relative_addresses, default true), so its targets appear at
// window start + their own address; with relative_addresses false the
// addresses go on unchanged and the targets appear at their own address.

const MAX_DEPTH = 4;

/** Initiator ports bound to bus: [{ base, port, instances: [names], count }], one per module and port. */
function busInitiators(analysis, bus) {
  const by = new Map();
  for (const c of analysis.connections) {
    if (c.to !== bus || analysis.buses.includes(c.fromBase)) continue;
    const key = `${c.fromBase}.${c.fromPort}`;
    if (!by.has(key)) by.set(key, { base: c.fromBase, port: c.fromPort, instances: [] });
    by.get(key).instances.push(c.from);
  }
  return [...by.values()].map((x) => ({ ...x, count: x.instances.length }));
}

/**
 * What bus decodes to, sorted by address: [{ base, instance, port, start, end,
 * size, priority, background, bus, depth }] with start/end as seen by an
 * initiator of the top bus (BigInt). A nested router is listed, then its own
 * targets at depth + 1.
 */
function decode(analysis, bus, offset = 0n, depth = 0, seen = new Set()) {
  if (seen.has(bus) || depth > MAX_DEPTH) return [];
  const inner = new Set(seen).add(bus);
  const out = [];
  for (const m of analysis.memoryMap.filter((r) => r.bus === bus).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.priority - b.priority))) {
    const start = offset + m.start;
    out.push({ base: m.base, instance: m.instance, port: m.port, start, end: start + m.size - 1n, size: m.size, priority: m.priority || 0, background: (m.priority || 0) > 0, bus, depth });
    if (analysis.buses.includes(m.instance)) out.push(...decode(analysis, m.instance, m.relative === false ? 0n : start, depth + 1, inner));
  }
  return out;
}

/**
 * Where module base's initiator ports lead: [{ port, bus, instances: count,
 * targets: decode(bus) }], one per port and bus (the replicas of a CPU share
 * one entry). Empty for a module that drives no bus.
 */
function reachFrom(analysis, base) {
  const by = new Map();
  for (const c of analysis.connections) {
    if (c.fromBase !== base || !analysis.buses.includes(c.to)) continue;
    const key = `${c.fromPort}\u0000${c.to}`;
    if (!by.has(key)) by.set(key, { port: c.fromPort, bus: c.to, instances: 0 });
    by.get(key).instances++;
  }
  return [...by.values()].map((r) => ({ ...r, targets: decode(analysis, r.bus) }));
}

/**
 * Who reaches module base's target ports: [{ port, bus, start, end, size,
 * priority, path: [buses from the outermost router in], initiators:
 * [{ base, port, count }] }]. start/end are the addresses the initiators use.
 */
function reachedBy(analysis, base) {
  const out = [];
  // Climb from a region to every router above it, adding window offsets.
  const climb = (bus, start, path, depth) => {
    const here = busInitiators(analysis, bus);
    const res = [{ bus, start, path: [bus, ...path], initiators: here }];
    if (depth >= MAX_DEPTH) return res;
    for (const w of analysis.memoryMap.filter((r) => r.instance === bus)) {
      if (path.includes(w.bus) || w.bus === bus) continue;
      res.push(...climb(w.bus, w.relative === false ? start : w.start + start, [bus, ...path], depth + 1));
    }
    return res;
  };
  for (const m of analysis.memoryMap.filter((r) => r.base === base)) {
    for (const v of climb(m.bus, m.start, [], 0)) {
      if (!v.initiators.length) continue;
      out.push({ port: m.port, instance: m.instance, bus: v.bus, path: v.path, start: v.start, end: v.start + m.size - 1n, size: m.size, priority: m.priority || 0, initiators: v.initiators });
    }
  }
  return out;
}

/** Region of each bus target port, keyed "instance.port": { start, size, bus } (for the socket list). */
function regionsByPort(analysis) {
  const out = new Map();
  for (const m of analysis.memoryMap) {
    const k = `${m.instance}.${m.port}`;
    if (!out.has(k)) out.set(k, { start: m.start, size: m.size, bus: m.bus, priority: m.priority || 0 });
  }
  return out;
}

/** Whether base takes part in any bus traffic (drives a bus, is decoded by one, or is a bus). */
function hasDataFlow(analysis, base) {
  return analysis.buses.includes(base) || analysis.connections.some((c) => c.fromBase === base && analysis.buses.includes(c.to)) ||
    analysis.memoryMap.some((m) => m.base === base);
}

/**
 * What the platform view needs to draw a transaction's route, as plain JSON:
 * { inst: { instance name: [base, replica index or null] },
 *   regions: { "instance.port": { base, ways: [{ path: [buses, outermost first], initiators: [bases] }] } } }.
 */
function routeTable(analysis) {
  const inst = {};
  for (const i of analysis.instances) inst[i.name] = [i.base, i.index === undefined ? null : i.index];
  const regions = {};
  const bases = [...new Set(analysis.memoryMap.map((m) => m.base))];
  for (const base of bases) {
    for (const r of reachedBy(analysis, base)) {
      const k = `${r.instance}.${r.port}`;
      if (!regions[k]) regions[k] = { base, ways: [] };
      regions[k].ways.push({ path: r.path, initiators: [...new Set(r.initiators.map((x) => x.base))] });
    }
  }
  for (const m of analysis.memoryMap) {
    const k = `${m.instance}.${m.port}`;
    if (!regions[k]) regions[k] = { base: m.base, ways: [{ path: [m.bus], initiators: [] }] };
  }
  return { inst, regions };
}

/**
 * The route of one transaction, or null when the region is unknown.
 * spec: { region: "instance.port" of the target, initiator: "cpu_3.mem" (as
 * the trace names it) or from: base (with index), bus: a bus the route must
 * use (a router's own decode table) }.
 * Returns { from: base|null, index: replica|null, port, buses: [outermost first], target: base, region }.
 * Self-contained: the platform view embeds it with toString().
 */
function routeFor(table, spec) {
  const reg = table.regions[spec.region];
  if (!reg) return null;
  let from = spec.from || null, index = spec.index === undefined ? null : spec.index, port = spec.port || null;
  if (spec.initiator) {
    const dot = spec.initiator.lastIndexOf('.');
    const name = dot < 0 ? spec.initiator : spec.initiator.slice(0, dot);
    port = dot < 0 ? null : spec.initiator.slice(dot + 1);
    const hit = table.inst[name];
    if (hit) { from = hit[0]; index = hit[1]; }
  }
  const ways = reg.ways;
  const way = (from && ways.find((w) => w.initiators.includes(from))) ||
    (spec.bus && ways.find((w) => w.path.includes(spec.bus))) || ways[0];
  return { from, index, port, buses: way ? way.path.slice() : [], target: reg.base, region: spec.region };
}

module.exports = { busInitiators, decode, reachFrom, reachedBy, regionsByPort, hasDataFlow, routeTable, routeFor };
