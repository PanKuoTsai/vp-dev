'use strict';
// Restructuring a platform description: replace a module's model (its type)
// keeping its place on the buses, and group modules into a subsystem. Each is
// a plan first (what is kept, renamed or lost) and then one minimal text edit,
// so the rest of the file keeps its formatting. No VS Code dependency.

const core = require('./core');
const jsonedit = require('./jsonedit');
const catalogLib = require('./catalog');
const connect = require('./connect');
const modules = require('./modules');

const asTemplate = (s) => String(s).replace(/\{i\}/g, '0');
const parentOf = (p) => (p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '');
const localOf = (p) => p.slice(p.lastIndexOf('.') + 1);
const join = (c, n) => (c ? `${c}.${n}` : n);

/** The module as written in the JSON (references not made full). */
function rawModule(doc, base) {
  let mods = doc.modules || {};
  const parts = base.split('.');
  for (let k = 0; k < parts.length - 1; k++) mods = (mods[parts[k]] || {}).modules || {};
  return mods[parts[parts.length - 1]];
}

// ------------------------------------------------------------------ replace the model

/** The connected ports of module base, by catalog port: connect.portRows rows with a connection. */
const usedPorts = (doc, catalog, base) => connect.portRows(doc, catalog, base).filter((r) => r.out.length || r.in.length);

/**
 * How the connected ports (rows from usedPorts) carry over to a type (catalog info):
 * { keep: [name], rename: [{ from, to, kind }], lost: [{ port, kind, connections, choices }] }.
 * Unknown ports (a type the catalog could not look into) are all kept.
 */
function portMapping(rows, info) {
  const known = catalogLib.introspected(info);
  const newPorts = known ? info.introspection.ports : [];
  const keep = [], rename = [], lost = [], pending = [];
  const taken = new Set();
  for (const r of rows) {
    const p = known ? catalogLib.findPort(info, asTemplate(r.name)) : null;
    if (!known || (p && (!r.kind || !p.kind || r.kind === p.kind))) { keep.push(r.name); if (p) taken.add(p.name); } else pending.push(r);
  }
  for (const r of pending) {
    const same = newPorts.filter((p) => r.kind && p.kind === r.kind && !taken.has(p.name) && !!p.vector === !!r.vector);
    if (same.length === 1) { rename.push({ from: r.name, to: same[0].name, kind: r.kind }); taken.add(same[0].name); }
    else lost.push({ port: r.name, kind: r.kind, connections: r.out.length + r.in.length, choices: same.map((p) => p.name) });
  }
  return { keep, rename, lost };
}

/**
 * Types module base could be replaced with, best fits first:
 * [{ type, summary, keep, rename, lost (connections lost) }].
 */
function swapChoices(doc, catalog, base) {
  const mod = core.modulesOf(doc)[base];
  const rows = usedPorts(doc, catalog, base);
  const { roleOf } = require('../webview/view');
  const target = rows.some((r) => r.kind === 'tlm_target');
  const role = roleOf({ type: mod.type, target });
  const family = String(mod.type).replace(/[A-Z0-9][A-Za-z0-9]*$/, '');
  // Types the catalog could look into first (the others cannot be checked), then
  // fewest connections lost, the same role (CPU for a CPU), the same family of names.
  return modules.typeChoices(catalog).filter((c) => c.type !== mod.type).map((c) => {
    const info = catalogLib.moduleInfo(catalog, c.type);
    const m = portMapping(rows, info);
    const ports = catalogLib.introspected(info) ? info.introspection.ports : [];
    return Object.assign({}, c, {
      checked: catalogLib.introspected(info), keep: m.keep.length, rename: m.rename.length, lost: m.lost.reduce((n, l) => n + l.connections, 0),
      sameRole: roleOf({ type: c.type, target: ports.some((p) => p.kind === 'tlm_target') }) === role, family: !!family && c.type.startsWith(family),
    });
  }).sort((a, b) => (b.checked - a.checked) || a.lost - b.lost || (b.sameRole - a.sameRole) || (b.family - a.family) || a.type.localeCompare(b.type, 'en', { sensitivity: 'base' }));
}

/**
 * What replacing module base's type with newType keeps and loses.
 * ports: each connected port of the old type is kept when the new type has a
 *   port of that name and kind; renamed when it does not, but has exactly one
 *   free port of the same kind (target_socket -> mem); lost otherwise.
 * params: the ones the new type does not have are dropped.
 * args: kept when they fit; otherwise filled from the only candidate, or
 *   listed in ask for the user to choose.
 */
function swapPlan(doc, catalog, base, newType, topDir) {
  const mods = core.modulesOf(doc);
  const mod = mods[base];
  if (!mod) throw new Error(`module ${base} no longer exists`);
  if (mod.container) throw new Error(`${base} is a subsystem; replace the modules inside it instead`);
  if (mod.type === newType) throw new Error(`${base} is already a ${newType}`);
  const info = catalogLib.moduleInfo(catalog, newType);
  if (!info) throw new Error(`${newType} is not in the component catalog`);
  const known = catalogLib.introspected(info);
  const { keep, rename, lost } = portMapping(usedPorts(doc, catalog, base), info);

  const raw = rawModule(doc, base);
  const dropParams = [];
  if (known) {
    const names = new Set((info.introspection.params || []).map((p) => p.name).concat([...catalogLib.UNIVERSAL_PARAMS]));
    for (const k of Object.keys(raw.params || {})) if (!names.has(k)) dropParams.push({ name: k, scope: null });
    for (const [i, over] of Object.entries(raw.perIndex || {})) {
      for (const k of Object.keys((over && over.params) || {})) if (!names.has(k)) dropParams.push({ name: k, scope: i });
    }
  }

  // Constructor arguments, as full paths for references.
  const analysis = core.analyze(doc);
  const typeOf = new Map(analysis.instances.map((i) => [i.name, i.type]));
  const specs = modules.argSpecs(catalog, newType);
  const oldArgs = Array.isArray(mod.args) ? mod.args : [];
  const args = [];
  const ask = [];
  specs.forEach((s, i) => {
    const old = oldArgs[i];
    if (s.ref) {
      const fits = old && typeof old === 'object' && typeof old.ref === 'string' && (typeOf.get(old.ref) === s.expects || !analysis.instances.some((x) => x.type === s.expects));
      if (fits) { args.push({ ref: old.ref }); return; }
      const c = modules.argCandidates(analysis, s.expects);
      if (c.exact && c.names.length === 1) args.push({ ref: c.names[0] });
      else { args.push(null); ask.push({ index: i, spec: s, candidates: c }); }
    } else if (typeof old === 'string') args.push(old);
    else {
      const v = modules.existingArg(doc, newType, i);
      if (v !== '') args.push(v); else { args.push(null); ask.push({ index: i, spec: s, candidates: null }); }
    }
  });
  const sameArgs = JSON.stringify(args) === JSON.stringify(oldArgs.length ? oldArgs : []);
  const def = modules.moduleDef(catalog, newType, null, topDir);
  return {
    base, oldType: mod.type, newType, unchecked: !known, keep, rename, lost, dropParams,
    args: { old: oldArgs, now: args, changed: !sameArgs, ask },
    dylib: { old: raw.dylib, now: def.dylib },
  };
}

/** Does a port key (maybe "irq_out_{i}", "irq_out_3") belong to catalog port name? */
const keyIs = (key, name) => key === name || key.startsWith(name + '_');
const renamedKey = (key, from, to) => to + key.slice(from.length);

/**
 * The whole text after applying a swap plan. args: the constructor arguments
 * to write (plan.args.now with the asked ones filled in), full paths for references.
 */
function swapText(text, doc, plan, args) {
  const jp = core.jsonPath(plan.base);
  let t = text;
  const doEdit = (e) => { if (e) t = jsonedit.apply(t, e); };
  doEdit(jsonedit.setProperty(t, jp, 'type', () => JSON.stringify(plan.newType)));
  if (plan.dylib.now !== plan.dylib.old) {
    if (plan.dylib.now) doEdit(jsonedit.setProperty(t, jp, 'dylib', () => JSON.stringify(plan.dylib.now)));
    else doEdit(jsonedit.removeProperty(t, jp, 'dylib'));
  }
  if (plan.args.changed || args.some((a, i) => JSON.stringify(a) !== JSON.stringify(plan.args.now[i]))) {
    if (args.length === 0) doEdit(jsonedit.removeProperty(t, jp, 'args'));
    else {
      const written = args.map((a) => (a && typeof a === 'object' ? { ref: core.refFor(doc, plan.base, a.ref) } : a));
      doEdit(jsonedit.setProperty(t, jp, 'args', () => '[' + written.map((a) => (a && typeof a === 'object' ? `{ "ref": ${JSON.stringify(a.ref)} }` : JSON.stringify(a))).join(', ') + ']'));
    }
  }
  for (const p of plan.dropParams) doEdit(jsonedit.removeProperty(t, p.scope === null ? [...jp, 'params'] : [...jp, 'perIndex', p.scope, 'params'], p.name));
  // This module's own port declarations: rename or drop.
  const lostNames = plan.lost.map((l) => l.port);
  for (const d of connect.declared(doc, plan.base)) {
    const r = plan.rename.find((x) => keyIs(d.key, x.from));
    if (r) {
      const node = jsonedit.find(jsonedit.scan(t), [...d.path, d.key]);
      const value = t.slice(node.start, node.end);
      doEdit(jsonedit.removeProperty(t, d.path, d.key));
      doEdit(jsonedit.setPropertyDeep(t, d.path, renamedKey(d.key, r.from, r.to), () => value, jp.length));
    } else if (lostNames.some((n) => keyIs(d.key, n))) doEdit(jsonedit.removeProperty(t, d.path, d.key));
  }
  // Other modules' bindings to it: rewrite the port, or drop the binding.
  for (const i of connect.incoming(doc, plan.base)) {
    const r = plan.rename.find((x) => keyIs(i.port, x.from));
    if (r) {
      const node = jsonedit.find(jsonedit.scan(t), [...i.path, i.key, 'bind']);
      const written = node.value;
      const dot = written.lastIndexOf('.');
      doEdit(jsonedit.setProperty(t, [...i.path, i.key], 'bind', () => JSON.stringify(written.slice(0, dot + 1) + renamedKey(i.port, r.from, r.to))));
    } else if (lostNames.some((n) => keyIs(i.port, n))) doEdit(jsonedit.removeProperty(t, i.path, i.key));
  }
  return t;
}

// ------------------------------------------------------------------ group into a subsystem

/** Every reference a module writes: [{ kind: 'bind'|'arg', path (JSON path to the string or arg), full }]. */
function referencesOf(flat, base) {
  const mod = flat.modules[base];
  const jp = core.jsonPath(base);
  const out = [];
  const ports = (ps, path) => {
    for (const [k, p] of Object.entries(ps || {})) {
      if (p && typeof p.bind === 'string') out.push({ kind: 'bind', path: [...path, k, 'bind'], full: p.bind });
    }
  };
  ports(mod.ports, [...jp, 'ports']);
  for (const [i, over] of Object.entries(mod.perIndex || {})) ports(over && over.ports, [...jp, 'perIndex', i, 'ports']);
  (mod.args || []).forEach((a, i) => { if (a && typeof a === 'object' && typeof a.ref === 'string') out.push({ kind: 'arg', path: [...jp, 'args', i], full: a.ref }); });
  return out;
}

/** The module a reference names: "uart_0.irq" -> "uart_0"; an argument names a module itself. */
const targetOf = (r) => (r.kind === 'bind' ? r.full.slice(0, r.full.lastIndexOf('.')) : r.full);

/**
 * Group modules (all in the same container) into a new subsystem name there.
 * Returns { container, name, path, moved, rewrites: [{ module, path, from, to }] }:
 * the references from outside that must now name the moved modules through it.
 */
function groupPlan(doc, bases, name) {
  if (!bases.length) throw new Error('Select the modules to group first');
  const flat = core.flatten(doc);
  for (const b of bases) if (!flat.modules[b]) throw new Error(`module ${b} no longer exists`);
  const container = flat.parent[bases[0]];
  if (bases.some((b) => flat.parent[b] !== container)) throw new Error('The modules to group must be in the same subsystem (or all at the top level)');
  const problem = modules.nameProblem(doc, core.analyze(doc), name, container);
  if (problem) throw new Error(problem);
  const path = join(container, name);
  const movedSet = new Set(bases);
  const isMoved = (p) => [...movedSet].some((b) => p === b || p.startsWith(b + '.') || modules.refersTo(p, b, flat.modules[b]));
  const moveTo = (p) => {
    const b = [...movedSet].find((x) => p === x || p.startsWith(x + '.') || modules.refersTo(p, x, flat.modules[x]));
    return b === undefined ? p : join(path, p.slice(container ? container.length + 1 : 0));
  };
  // The document after the move, to work out the references and check them.
  const after = JSON.parse(JSON.stringify(doc));
  const holder = container ? rawModule(after, container).modules : after.modules;
  const group = { type: 'Container', modules: {} };
  for (const k of Object.keys(holder)) if (movedSet.has(join(container, k))) { group.modules[k] = holder[k]; delete holder[k]; }
  holder[name] = group;
  const rewrites = [];
  for (const m of flat.order) {
    if (isMoved(m) || flat.containers.has(m)) continue;
    for (const r of referencesOf(flat, m)) {
      const target = targetOf(r);
      if (!isMoved(target)) continue;
      const newTarget = moveTo(target);
      const ref = core.refFor(after, m, newTarget);
      const to = r.kind === 'bind' ? `${ref}${r.full.slice(target.length)}` : ref;
      const was = getAt(doc, r.path);
      rewrites.push({ module: m, kind: r.kind, path: r.path, from: r.kind === 'arg' ? was && was.ref : was, to });
    }
  }
  // Apply the rewrites to the moved-document too, then check that every reference still names the same module.
  for (const w of rewrites) setAt(after, w.path, w.kind === 'arg' ? { ref: w.to } : w.to);
  const flat2 = core.flatten(after);
  for (const m of flat.order) {
    if (flat.containers.has(m)) continue;
    const before = referencesOf(flat, m).map((r) => (r.kind === 'bind' ? moveTo(targetOf(r)) + r.full.slice(targetOf(r).length) : moveTo(r.full)));
    const now = referencesOf(flat2, moveTo(m)).map((r) => r.full);
    if (JSON.stringify(before) !== JSON.stringify(now)) {
      throw new Error(`grouping would change what ${m} connects to (${before.find((x, i) => x !== now[i]) || 'a reference'}); rename the modules involved first`);
    }
  }
  return { container, name, path, moved: bases.slice(), rewrites };
}

const getAt = (obj, path) => path.reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);

/** Set a value at a JSON path in a parsed document (args entries are objects { ref }). */
function setAt(obj, path, value) {
  let o = obj;
  for (let k = 0; k < path.length - 1; k++) o = o[path[k]];
  const last = path[path.length - 1];
  if (value && typeof value === 'object' && o[last] && typeof o[last] === 'object') Object.assign(o[last], value);
  else o[last] = value;
}

/** Re-indent a block of JSON text that moves `by` deeper (its first line stays put). */
const deeper = (block, by) => block.replace(/\n/g, '\n' + by);

/**
 * The whole text after a group plan: outside references rewritten, the moved
 * modules cut out with their own formatting and put in the new subsystem,
 * which takes the place of the first of them.
 */
function groupText(text, plan) {
  let t = text;
  for (const w of plan.rewrites) {
    const path = w.kind === 'arg' ? w.path : w.path.slice(0, -1);
    const key = w.kind === 'arg' ? 'ref' : 'bind';
    t = jsonedit.apply(t, jsonedit.setProperty(t, path, key, () => JSON.stringify(w.to)));
  }
  const step = jsonedit.stepOf(t);
  const holderPath = plan.container ? [...core.jsonPath(plan.container), 'modules'] : ['modules'];
  const holder = jsonedit.find(jsonedit.scan(t), holderPath);
  const picked = holder.props.filter((p) => plan.moved.includes(join(plan.container, p.key)));
  const ind = jsonedit.indentAt(t, picked[0].keyStart);
  const inner = picked.map((p) => `${ind}${step}${step}${JSON.stringify(p.key)}: ${deeper(t.slice(p.value.start, p.value.end), step + step)}`).join(',\n');
  const block = `{\n${ind}${step}"type": "Container",\n${ind}${step}"modules": {\n${inner}\n${ind}${step}}\n${ind}}`;
  // Replace the first moved module by the subsystem, then remove the others.
  const first = picked[0];
  t = t.slice(0, first.keyStart) + `${JSON.stringify(plan.name)}: ${block}` + t.slice(first.value.end);
  for (const p of picked.slice(1)) t = jsonedit.apply(t, jsonedit.removeProperty(t, holderPath, p.key));
  return t;
}

module.exports = { swapPlan, swapText, swapChoices, portMapping, groupPlan, groupText, rawModule };
