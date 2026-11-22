'use strict';
// Connections of a platform description: which ports a module has (from the
// component catalog), what each is bound to in either direction, which ports
// of another module fit, which end writes the binding, and the JSON edits.
// No VS Code dependency.

const catalogLib = require('./catalog');
const jsonedit = require('./jsonedit');
const { refersTo } = require('./modules');
const core = require('./core');

const ADDR = /^(0x[0-9A-Fa-f]+|\d+|\$\{[A-Za-z_]\w*\}(\s*[+-]\s*(0x[0-9A-Fa-f]+|\d+))?)$/;
const INDEX = /^(\d+|\{i\})$/;
const checkable = (k) => !!k && k !== 'sc_port' && k !== 'sc_export' && k !== 'tlm_socket';
const asTemplate = (s) => String(s).replace(/\{i\}/g, '0');

function infoOf(catalog, type) {
  const info = catalogLib.moduleInfo(catalog, type);
  return catalogLib.introspected(info) ? info : null;
}

/** Catalog port a configured port name (maybe with _N or {i}) refers to, or null. */
function portOf(catalog, type, name) {
  const info = infoOf(catalog, type);
  return info ? catalogLib.findPort(info, asTemplate(name)) : null;
}

const portsPath = (base, scope) => (scope === null || scope === undefined
  ? [...core.jsonPath(base), 'ports'] : [...core.jsonPath(base), 'perIndex', String(scope), 'ports']);

/**
 * Bindings module base writes itself: [{ key, bind, address, size, repeat, scope, path }].
 * bind is the full path of the other end ("periph.uart_0.irq"), however the platform wrote it.
 */
function declared(doc, base) {
  const mod = core.modulesOf(doc)[base] || {};
  const out = [];
  const take = (ports, scope) => {
    for (const [key, p] of Object.entries(ports || {})) {
      if (p && typeof p.bind === 'string') out.push({ key, bind: p.bind, address: p.address, size: p.size, repeat: p.repeat, scope, path: portsPath(base, scope) });
    }
  };
  take(mod.ports, null);
  for (const [k, over] of Object.entries(mod.perIndex || {})) take(over && over.ports, k);
  return out;
}

/** Bindings other modules write to base: [{ from, key, bind, port (of base), scope, path }]. */
function incoming(doc, base) {
  const mods = core.modulesOf(doc);
  const target = mods[base];
  const out = [];
  for (const name of Object.keys(mods)) {
    if (name === base) continue;
    for (const d of declared(doc, name)) {
      const dot = d.bind.lastIndexOf('.');
      if (dot > 0 && refersTo(d.bind.slice(0, dot), base, target)) out.push(Object.assign({ from: name, port: d.bind.slice(dot + 1) }, d));
    }
  }
  return out;
}

/**
 * Port rows for the Connections table of module base, in catalog order, then
 * any configured port the catalog does not know.
 * row: { name, kind, vector, unknown, out: declared[], in: incoming[] }
 */
function portRows(doc, catalog, base) {
  const mod = core.modulesOf(doc)[base] || {};
  const info = infoOf(catalog, mod.type);
  const rows = [];
  const byName = new Map();
  for (const p of (info && info.introspection.ports) || []) {
    const r = { name: p.name, kind: p.kind, vector: !!p.vector, unknown: false, out: [], in: [] };
    rows.push(r);
    byName.set(p.name, r);
  }
  const rowFor = (portName) => {
    const p = info ? catalogLib.findPort(info, asTemplate(portName)) : null;
    const key = p ? p.name : portName;
    if (!byName.has(key)) {
      const r = { name: key, kind: p ? p.kind : '', vector: p ? !!p.vector : false, unknown: !!info && !p, out: [], in: [] };
      rows.push(r);
      byName.set(key, r);
    }
    return byName.get(key);
  };
  for (const d of declared(doc, base)) rowFor(d.key).out.push(d);
  for (const i of incoming(doc, base)) rowFor(i.port).in.push(i);
  return rows;
}

/** Ports of type that can be bound to a port of kind, in catalog order (all when kinds are unknown). */
function compatiblePorts(catalog, type, kind) {
  const info = infoOf(catalog, type);
  if (!info) return [];
  return info.introspection.ports.filter((p) => !checkable(kind) || !checkable(p.kind) || catalogLib.pairOk(kind, p.kind));
}

/** Modules (base names) other than base with at least one port that fits kind. */
function compatibleModules(doc, catalog, base, kind) {
  return Object.entries(core.modulesOf(doc))
    .filter(([name, m]) => name !== base && m && !m.container && compatiblePorts(catalog, m.type, kind).length > 0)
    .map(([name]) => name);
}

const isBus = (doc, base) => { const m = core.modulesOf(doc)[base]; return !!m && core.BUS_TYPES.has(m.type); };

/**
 * Which end writes the binding: the end that is not a bus (QBox puts the
 * address of a mapped socket on the device side), else the end the user
 * started from. Returns 'a' or 'b'.
 */
function declaringEnd(doc, a, b) {
  if (isBus(doc, b)) return 'a';
  if (isBus(doc, a)) return 'b';
  return 'a';
}

/** A mapped target socket bound to a bus needs an address and a size. */
const needsAddress = (doc, declKind, otherBase) => declKind === 'tlm_target' && isBus(doc, otherBase);

/**
 * Instance names to bind to on module peer, as seen from module decl. A
 * replicated decl may bind each replica to the peer instance with the same
 * number ("peer_{i}").
 */
function peerInstances(doc, analysis, decl, peer) {
  const mods = core.modulesOf(doc);
  const names = analysis.instances.filter((i) => i.base === peer).map((i) => i.name);
  if (!(mods[peer] && mods[peer].count !== undefined)) return names;
  const both = mods[decl] && mods[decl].count !== undefined;
  return both ? [`${peer}_{i}`].concat(names) : names;
}

/** First vector index of portName on module base that no binding uses yet. */
function nextIndex(doc, base, portName) {
  const re = new RegExp(`^${portName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d+)$`);
  let max = -1;
  for (const d of declared(doc, base)) { const m = re.exec(d.key); if (m) max = Math.max(max, Number(m[1])); }
  for (const i of incoming(doc, base)) { const m = re.exec(i.port); if (m) max = Math.max(max, Number(m[1])); }
  return max + 1;
}

/** Why an address or size text is not usable, or null. */
function addressProblem(v) {
  return ADDR.test(String(v).trim()) ? null : 'Use hex such as 0x9000000, a decimal number, or ${NAME} with an optional +offset.';
}

/** Why a vector index is not usable, or null. {i} needs a replicated declaring module. */
function indexProblem(v, allowTemplate) {
  const s = String(v).trim();
  if (!INDEX.test(s)) return allowTemplate ? 'Use a number, or {i} for the number of each instance.' : 'Use a number.';
  if (s === '{i}' && !allowTemplate) return '{i} only works when the module writing the binding is replicated.';
  return null;
}

/** One-line JSON of a binding, keys in the order the platform files use. */
function renderEntry(entry) {
  const parts = [];
  for (const k of ['address', 'size', 'priority', 'bind']) if (entry[k] !== undefined) parts.push(`${JSON.stringify(k)}: ${JSON.stringify(entry[k])}`);
  return `{ ${parts.join(', ')} }`;
}

/**
 * Edit that writes ports[key] = entry on module base (creating "ports" as needed).
 * entry.bind is the full path of the other end; it is written as the shortest
 * name that reaches it from base's container.
 */
function bindEdit(text, base, key, entry, scope = null) {
  const mod = jsonedit.find(jsonedit.scan(text), core.jsonPath(base));
  if (!mod || mod.type !== 'object') throw new Error(`module ${base} no longer exists`);
  if (typeof entry.bind === 'string' && base.includes('.')) {
    const { module, port } = core.splitBind(entry.bind);
    entry = Object.assign({}, entry, { bind: `${core.refFor(JSON.parse(text), base, module)}.${port}` });
  }
  return jsonedit.setPropertyDeep(text, portsPath(base, scope), key, () => renderEntry(entry), 2);
}

/** Edit that removes a binding found by declared() or incoming(). */
function unbindEdit(text, item) {
  return jsonedit.removeProperty(text, item.path, item.key);
}

module.exports = {
  portOf, declared, incoming, portRows, compatiblePorts, compatibleModules, declaringEnd, needsAddress,
  peerInstances, nextIndex, addressProblem, indexProblem, renderEntry, bindEdit, unbindEdit, isBus,
};
