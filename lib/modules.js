'use strict';
// Adding and deleting modules of a platform description: type choices from
// the component catalog, names, constructor arguments, what a deletion
// breaks, and the JSON edits. No VS Code dependency.

const catalogLib = require('./catalog');
const jsonedit = require('./jsonedit');
const core = require('./core');

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Constructor argument classes whose module type has another name.
const CLASS_TO_TYPE = { LibLoader: 'QemuInstanceManager' };

// Generic containers: not something to add from a list of components.
const HIDDEN_TYPES = new Set(['Container', 'ContainerDeferModulesConstruct', 'ContainerWithArgs']);

/** Module types to offer, with a one-line summary each, sorted by name. */
function typeChoices(catalog) {
  const out = [];
  for (const [type, m] of Object.entries((catalog && catalog.modules) || {})) {
    if (HIDDEN_TYPES.has(type) || (m && m.unbuilt)) continue;
    const intro = m.introspection && m.introspection.status === 'ok' ? m.introspection : null;
    const parts = [];
    if (intro) parts.push(`${(intro.ports || []).length} ports`, `${(intro.params || []).length} params`);
    else parts.push('ports and parameters unknown');
    if (m.args && m.args.length) parts.push(`needs ${m.args.map((a) => a.expects || a.decl).join(', ')}`);
    out.push({ type, summary: parts.join(' · '), source: m.source || '' });
  }
  return out.sort((a, b) => a.type.localeCompare(b.type, 'en', { sensitivity: 'base' }));
}

/** Every instance name the platform defines (expanded replicas included), as full paths. */
function takenNames(doc, analysis) {
  const s = new Set(Object.keys(core.modulesOf(doc)));
  for (const i of analysis.instances) s.add(i.name);
  return s;
}

const localName = (full) => full.slice(full.lastIndexOf('.') + 1);
const containerOf = (full) => (full.includes('.') ? full.slice(0, full.lastIndexOf('.')) : '');

/**
 * Why name cannot be used for a new module in container (a container path,
 * '' for the top level), or null. A name that would hide, or be hidden by, a
 * module of an enclosing container is refused too, since references resolve
 * to the nearest one.
 */
function nameProblem(doc, analysis, name, container = '') {
  if (!NAME.test(name)) return 'Use letters, digits and _, not starting with a digit.';
  const full = container ? `${container}.${name}` : name;
  if (takenNames(doc, analysis).has(full)) return `${name} is already used ${container ? 'in ' + container : 'in this platform'}.`;
  const mods = core.modulesOf(doc);
  for (const [base, mod] of Object.entries(mods)) {
    // A replicated module "x" makes instances x_0, x_1...; a new "x_3" would collide later.
    if (mod && mod.count !== undefined && containerOf(base) === container && new RegExp(`^${localName(base)}_\\d+$`).test(name)) return `${name} looks like an instance of ${base}.`;
  }
  for (const base of Object.keys(mods)) {
    if (localName(base) !== name) continue;
    const c = containerOf(base);
    if (container.startsWith(c ? c + '.' : '') || (container === '' && c === '')) return `${name} would hide ${base}, which modules here could then no longer name.`;
    if (c.startsWith(container ? container + '.' : '')) return `${name} would be hidden inside ${c} by ${base}.`;
  }
  return null;
}

/** A free name derived from the type, e.g. "Pl011" -> "pl011_0". */
function suggestName(doc, analysis, type, container = '') {
  const stem = type.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1').toLowerCase();
  for (let n = 0; ; n++) {
    const name = `${stem}_${n}`;
    if (!nameProblem(doc, analysis, name, container)) return name;
  }
}

/** Containers a module can be added to: [''] for the top level, then each container path. */
function containerChoices(doc) {
  return [''].concat([...core.flatten(doc).containers]);
}

/** Constructor arguments a type needs: [{ ref: bool, expects, decl, label }]. */
function argSpecs(catalog, type) {
  const m = catalogLib.moduleInfo(catalog, type);
  return ((m && m.args) || []).map((a, i) => ({
    ref: a.kind === 'object',
    expects: (a.expects && CLASS_TO_TYPE[a.expects]) || a.expects || a.decl,
    decl: a.decl,
    label: `argument ${i + 1} of ${type} (${a.expects || a.decl})`,
  }));
}

/**
 * Instances that can be passed for an argument expecting a class.
 * exact: instances of that very type; when there are none, every instance is
 * offered (the class may be a base class such as QemuDevice).
 */
function argCandidates(analysis, expects) {
  const exact = analysis.instances.filter((i) => i.type === expects).map((i) => i.name);
  return { exact: exact.length > 0, names: exact.length ? exact : analysis.instances.map((i) => i.name) };
}

/**
 * The new module's JSON value: { type, dylib?, args? }. A wizard model's
 * library is written as a path, ${TOP}-relative when topDir is given.
 */
function moduleDef(catalog, type, args, topDir) {
  const m = catalogLib.moduleInfo(catalog, type);
  const def = { type };
  const lib = m && m.library ? String(m.library).split('/').pop().replace(/\.so$/, '') : '';
  if (m && m.model) {
    // Near the platform: a ${TOP}-relative path; otherwise none, and the
    // extension supplies the library when it generates the Lua.
    const d = require('./models').dylibFor(m, topDir);
    if (d) def.dylib = d;
  }
  else if (lib && lib !== type) def.dylib = lib;
  if (args && args.length) def.args = args;
  return def;
}

function stepOf(text) {
  const unit = /\n(\t| +)\S/.exec(text);
  return unit ? (unit[1] === '\t' ? '\t' : unit[1]) : '  ';
}

/** One property per line; values on one line, objects in arrays as { "ref": "x" }. */
function renderDef(def, ind, step) {
  const val = (v) => (Array.isArray(v)
    ? '[' + v.map((x) => (x && typeof x === 'object' ? '{ ' + Object.entries(x).map(([k, y]) => `${JSON.stringify(k)}: ${JSON.stringify(y)}`).join(', ') + ' }' : JSON.stringify(x))).join(', ') + ']'
    : JSON.stringify(v));
  return '{\n' + Object.entries(def).map(([k, v]) => `${ind}${step}${JSON.stringify(k)}: ${val(v)}`).join(',\n') + `\n${ind}}`;
}

/**
 * Edit that appends name = def to the modules of container ('' for the top
 * level). Argument references (full paths) are written as the shortest name
 * that reaches them from there.
 */
function addModuleEdit(text, name, def, container = '') {
  const step = stepOf(text);
  if (container && Array.isArray(def.args)) {
    const doc = JSON.parse(text);
    def = Object.assign({}, def, { args: def.args.map((a) => (a && typeof a === 'object' && a.ref ? { ref: core.refFor(doc, `${container}.${name}`, a.ref) } : a)) });
  }
  const at = container ? [...core.jsonPath(container), 'modules'] : ['modules'];
  if (container && !jsonedit.find(jsonedit.scan(text), at)) {
    return jsonedit.setPropertyDeep(text, core.jsonPath(container), 'modules', (ind) => `{\n${ind}${step}${JSON.stringify(name)}: ${renderDef(def, ind + step, step)}\n${ind}}`, 2);
  }
  return jsonedit.setProperty(text, at, name, (ind) => renderDef(def, ind, step));
}

/** Does an instance name (or a {i} template) belong to module base? */
function refersTo(target, base, mod) {
  if (target === base) return true;
  if (mod && mod.count !== undefined) return target === `${base}_{i}` || new RegExp(`^${base}_\\d+$`).test(target);
  return false;
}

/**
 * What deleting module base would break.
 * blockers: other modules that take it as a constructor argument; a deletion
 *   with blockers is refused, as those modules could not be built.
 * bindings: ports of other modules bound to it; they are removed with it.
 *   Each is { module, path (object holding the port), port, bind }.
 */
function deletePlan(doc, base) {
  const mods = core.modulesOf(doc);
  const target = mods[base];
  if (!target) throw new Error(`module ${base} no longer exists`);
  // Deleting a container deletes everything inside it.
  const inside = (name) => name === base || name.startsWith(base + '.');
  const hits = (ref) => (target.container ? inside(ref) || Object.keys(mods).some((m) => m.startsWith(base + '.') && refersTo(ref, m, mods[m])) : refersTo(ref, base, target));
  const blockers = [];
  const bindings = [];
  for (const [name, mod] of Object.entries(mods)) {
    if (inside(name) || !mod || typeof mod !== 'object') continue;
    for (const a of mod.args || []) {
      if (a && typeof a === 'object' && hits(String(a.ref))) blockers.push({ module: name, ref: a.ref });
    }
    const scan = (ports, path) => {
      for (const [port, p] of Object.entries(ports || {})) {
        if (!p || typeof p.bind !== 'string') continue;
        const peer = p.bind.slice(0, p.bind.lastIndexOf('.'));
        if (hits(peer)) bindings.push({ module: name, path, port, bind: p.bind });
      }
    };
    scan(mod.ports, [...core.jsonPath(name), 'ports']);
    for (const [k, over] of Object.entries(mod.perIndex || {})) scan(over && over.ports, [...core.jsonPath(name), 'perIndex', k, 'ports']);
  }
  return { blockers, bindings, contents: Object.keys(mods).filter((n) => n !== base && inside(n)) };
}

/** The whole text after deleting module base and the bindings in plan. */
function deleteModuleText(text, base, plan) {
  let t = text;
  // Later edits are computed on the text already changed, so offsets stay right.
  for (const b of plan.bindings) {
    const e = jsonedit.removeProperty(t, b.path, b.port);
    if (e) t = jsonedit.apply(t, e);
  }
  const c = containerOf(base);
  const e = jsonedit.removeProperty(t, c ? [...core.jsonPath(c), 'modules'] : ['modules'], localName(base));
  if (!e) throw new Error(`module ${base} no longer exists`);
  return jsonedit.apply(t, e);
}

/** One edit turning a into b: the span between their common prefix and suffix. */
function minimalEdit(a, b) {
  let s = 0;
  const max = Math.min(a.length, b.length);
  while (s < max && a[s] === b[s]) s++;
  let e = 0;
  while (e < max - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return { start: s, end: a.length - e, text: b.slice(s, b.length - e) };
}

/** A constructor argument value already used by another module of this type, as a default. */
function existingArg(doc, type, index) {
  for (const mod of Object.values(core.modulesOf(doc))) {
    if (mod && mod.type === type && Array.isArray(mod.args) && typeof mod.args[index] === 'string') return mod.args[index];
  }
  return '';
}

/** Offset of a module's key (or of one of its ports) in the JSON, or null. Nested modules too. */
function definitionOffset(text, moduleName, portName) {
  let root;
  try { root = jsonedit.scan(text); } catch (e) { return null; }
  const keyAt = (node, key) => {
    const p = node && node.type === 'object' ? node.props.find((x) => x.key === key) : null;
    return p ? p : null;
  };
  let mpath = core.jsonPath(moduleName);
  let mod = jsonedit.find(root, mpath);
  if (!mod && /_\d+$/.test(moduleName)) { mpath = core.jsonPath(moduleName.replace(/_\d+$/, '')); mod = jsonedit.find(root, mpath); }
  if (!mod) return null;
  const own = keyAt(jsonedit.find(root, mpath.slice(0, -1)), mpath[mpath.length - 1]);
  if (!portName) return own ? own.keyStart : null;
  // A port may be written with {i} (irq_out_{i}) or under perIndex.
  const fits = (k) => k === portName || new RegExp('^' + k.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{i\\?\}|\{i\}/g, '\\d+') + '$').test(portName);
  const holders = [jsonedit.find(mod, ['ports'])];
  const per = jsonedit.find(mod, ['perIndex']);
  if (per && per.type === 'object') for (const p of per.props) holders.push(jsonedit.find(p.value, ['ports']));
  for (const h of holders) {
    const hit = h && h.type === 'object' ? h.props.find((x) => fits(x.key)) : null;
    if (hit) return hit.keyStart;
  }
  return own ? own.keyStart : null;
}

module.exports = {
  typeChoices, nameProblem, suggestName, containerChoices, argSpecs, argCandidates, moduleDef, addModuleEdit,
  deletePlan, deleteModuleText, minimalEdit, definitionOffset, existingArg, refersTo, CLASS_TO_TYPE,
};
