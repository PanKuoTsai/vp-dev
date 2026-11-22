'use strict';
// Parameter form of the platform view: which parameters a module has (from
// the component catalog), what the platform sets, for all replicas or for one
// (perIndex), how typed text becomes a schema value, and the JSON edit that
// writes it back. No VS Code dependency.

const catalogLib = require('./catalog');
const jsonedit = require('./jsonedit');
const core = require('./core');

const HEX = /^0x[0-9A-Fa-f]+$/;
const DEC = /^-?\d+$/;
const VARREF = /^\$\{[A-Za-z_]\w*\}(\s*[+-]\s*(0x[0-9A-Fa-f]+|\d+))?$/;
const isLua = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && '$lua' in v;
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

// How a value is typed in the form, from the catalog's coarse class.
// 'json' is the fallback for lists, sc_time and anything unknown.
const INPUT_KIND = { bool: 'bool', int: 'int', uint: 'uint', float: 'float', string: 'string', array: 'json' };

// Parameters that must be set on one replica only, keyed by name, with a test
// on the module type and the reason shown in the form.
const ONE_REPLICA_ONLY = {
  gdb_port: {
    applies: (type) => type.startsWith('cpu_'),
    why: 'A QEMU instance has one gdb server, which shows every CPU. Choose one CPU under "Applies to" to set it.',
  },
};

/** Short type label for the form, e.g. "uint", "string", "list of uint", "sc_time". */
function typeLabel(cppType) {
  if (!cppType) return '';
  const t = cppType.replace(/\s+/g, ' ').trim();
  const cls = catalogLib.paramClass(t);
  if (cls === 'array') {
    const inner = /^std::vector<([^,>]+)/.exec(t);
    const ic = inner ? catalogLib.paramClass(inner[1]) : null;
    return `list of ${ic || (inner ? inner[1] : '?')}`;
  }
  if (cls) return cls;
  return t.replace(/^sc_core::/, '');
}

/** Value text shown in an input. */
function toInput(v) {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Value text for defaults and inherited values: large integers in hex, strings quoted. */
function fmtValue(v) {
  if (v === undefined) return '';
  if (isLua(v)) return `Lua: ${v.$lua}`;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 65536) return '0x' + v.toString(16);
  if (typeof v === 'string') return JSON.stringify(v);
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/**
 * Turn the text typed for a parameter into a schema value.
 * Empty text means "not set here" and returns { reset: true }.
 * Returns { value } or { error }.
 */
function parseInput(text, kind) {
  const s = String(text).trim();
  if (s === '') return { reset: true };
  switch (kind) {
  case 'bool':
    if (s === 'true') return { value: true };
    if (s === 'false') return { value: false };
    return { error: 'Use true or false.' };
  case 'int':
  case 'uint':
    if (HEX.test(s) || VARREF.test(s)) return { value: s };
    if (DEC.test(s)) {
      const n = BigInt(s);
      if (kind === 'uint' && n < 0n) return { error: 'Must not be negative.' };
      // Keep large values exact: JSON numbers lose precision above 2^53.
      if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) {
        return n < 0n ? { error: 'Too large; write it in hex.' } : { value: '0x' + n.toString(16) };
      }
      return { value: Number(n) };
    }
    return { error: 'Use a whole number: decimal, hex such as 0x1000, or ${NAME} with an optional +offset.' };
  case 'float': {
    if (VARREF.test(s)) return { value: s };
    const n = Number(s);
    if (Number.isFinite(n) && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return { value: n };
    return { error: 'Use a number, for example 1.5 or 2e-3.' };
  }
  case 'string':
    return { value: String(text) };
  default: // json
    try {
      const v = JSON.parse(s);
      if (v === null) return { error: 'null is not a parameter value.' };
      if (isLua(v)) return { error: 'Lua expressions are edited in the JSON file.' };
      return { value: v };
    } catch (e) {
      return { error: 'Not valid JSON. Strings need quotes, for example "text" or [10, "ns"].' };
    }
  }
}

/**
 * The parameter form of every module (one per base name).
 * Returns Map base -> { base, type, count, instances, status, note, rows, scopes }.
 * status: 'ok' (catalog knows the parameters), 'unknown' (type not in the
 * catalog), 'opaque' (catalog could not introspect it), 'nocatalog'.
 * rows: the parameters as set for all replicas (modules[base].params).
 * scopes: for a replicated module, one { index, name, rows } per replica,
 * where rows edit modules[base].perIndex[index].params and inherit the rest.
 * Each row: { name, kind, type, default, hasDefault, description, set, value,
 *   input, lua, unknown, resolved, placeholder, blankLabel, inherited,
 *   inheritedSet, overriddenIn, locked }.
 */
function moduleForms(doc, analysis, catalog) {
  const out = new Map();
  const groups = new Map();
  for (const inst of analysis.instances) {
    if (!groups.has(inst.base)) groups.set(inst.base, { type: inst.type, names: [] });
    groups.get(inst.base).names.push(inst.name);
  }
  const env = analysis.env || {};
  for (const [base, { type, names }] of groups) {
    const mod = core.modulesOf(doc)[base] || {};
    const common = mod.params && typeof mod.params === 'object' ? mod.params : {};
    const perIndex = mod.perIndex && typeof mod.perIndex === 'object' ? mod.perIndex : {};
    const replicated = mod.count !== undefined;
    const info = catalog ? catalogLib.moduleInfo(catalog, type) : undefined;
    const status = !catalog ? 'nocatalog' : !info ? 'unknown' : info.introspection && info.introspection.status === 'ok' ? 'ok' : 'opaque';
    const known = status === 'ok' ? info.introspection.params || [] : [];
    const byName = new Map(known.map((p) => [p.name, p]));
    const ownOf = (idx) => {
      const o = perIndex[idx];
      return o && typeof o === 'object' && o.params && typeof o.params === 'object' ? o.params : {};
    };

    /** Row of one parameter. own: object the row edits; inherit: values it falls back to (or null). */
    const row = (name, own, inherit) => {
      const cat = byName.get(name);
      const universal = !cat && catalogLib.UNIVERSAL_PARAMS.has(name);
      const isSet = has(own, name);
      const v = isSet ? own[name] : undefined;
      const inhSet = !!inherit && has(inherit, name);
      const inh = inhSet ? inherit[name] : undefined;
      let kind = cat ? INPUT_KIND[catalogLib.paramClass(cat.type)] || 'json' : universal ? 'int' : 'json';
      // A boolean set to something else (a ${VAR}, say) is edited as JSON so it is not lost.
      if (kind === 'bool' && isSet && typeof v !== 'boolean' && !isLua(v)) kind = 'json';
      const hasDefault = !!cat && cat.default !== undefined;
      const fallback = inhSet ? `all: ${fmtValue(inh)}` : hasDefault ? `default ${fmtValue(cat.default)}` : '';
      const r = {
        name,
        kind,
        type: cat ? typeLabel(cat.type) : universal ? 'int' : '',
        hasDefault,
        default: cat ? cat.default : undefined,
        description: cat ? cat.description || '' : universal ? 'Log level of this module (SCP logger)' : '',
        set: isSet,
        value: v,
        lua: isSet && isLua(v),
        unknown: !cat && !universal && status === 'ok',
        input: isSet && !isLua(v) ? (kind === 'json' ? JSON.stringify(v) : toInput(v)) : '',
        inherited: inh,
        inheritedSet: inhSet,
        placeholder: fallback,
        blankLabel: inhSet ? `same as all (${fmtValue(inh)})` : hasDefault ? `default (${fmtValue(cat.default)})` : 'default',
        overriddenIn: [],
        locked: '',
      };
      const shown = isSet ? v : inh;
      if (typeof shown === 'string' && (kind === 'int' || kind === 'uint') && !HEX.test(shown)) {
        const vc = catalogLib.valueClass(shown, env);
        if (vc && vc.num !== undefined) r.resolved = '0x' + BigInt(Math.trunc(vc.num)).toString(16);
      }
      const only = ONE_REPLICA_ONLY[name];
      if (!inherit && replicated && names.length > 1 && only && only.applies(type) && !isSet) r.locked = only.why;
      return r;
    };

    /** Rows for one scope: set here first, then inherited, then the rest by name. */
    const rowsFor = (own, inherit) => {
      const names2 = new Set([...Object.keys(own), ...Object.keys(inherit || {}), ...known.map((p) => p.name)]);
      const rows = [...names2].map((n) => row(n, own, inherit));
      const rank = (r) => (r.set ? 0 : r.inheritedSet ? 1 : 2);
      const order = new Map(Object.keys(own).concat(Object.keys(inherit || {})).map((n, i) => [n, i]));
      return rows.sort((a, b) => rank(a) - rank(b) ||
        (rank(a) < 2 ? order.get(a.name) - order.get(b.name) : a.name.localeCompare(b.name)));
    };

    const rows = rowsFor(common, null);
    let scopes = [];
    if (replicated) {
      scopes = names.map((n, k) => ({ index: String(k), name: n, rows: rowsFor(ownOf(String(k)), common) }));
      for (const r of rows) r.overriddenIn = scopes.filter((s) => has(ownOf(s.index), r.name)).map((s) => s.name);
    }
    const note = {
      ok: '',
      unknown: `${type} is not in the component catalog, so only the parameters set here are shown.`,
      opaque: `The component catalog could not introspect ${type}, so only the parameters set here are shown.`,
      nocatalog: 'The component catalog is turned off ("vpStudio.catalog"), so only the parameters set here are shown.',
    }[status];
    out.set(base, { base, type, count: names.length, instances: names, status, note, rows, scopes });
  }
  return out;
}

/** The form row for one parameter (index null: all replicas), or undefined. */
function findRow(forms, base, name, index = null) {
  const f = forms.get(base);
  if (!f) return undefined;
  const rows = index === null || index === undefined ? f.rows : ((f.scopes.find((s) => s.index === String(index)) || {}).rows || []);
  return rows.find((r) => r.name === name);
}

const paramsPath = (base, index) =>
  (index === null || index === undefined ? [...core.jsonPath(base), 'params'] : [...core.jsonPath(base), 'perIndex', String(index), 'params']);

/**
 * Edit that sets the parameter for all replicas (index null) or for one
 * (perIndex[index]), creating "params", "perIndex" and the index entry as
 * needed. Returns {start, end, text}.
 */
function setParamEdit(text, base, name, value, index = null) {
  const mod = jsonedit.find(jsonedit.scan(text), core.jsonPath(base));
  if (!mod || mod.type !== 'object') throw new Error(`module ${base} no longer exists`);
  const json = JSON.stringify(value);
  return jsonedit.setPropertyDeep(text, paramsPath(base, index), name, () => json, 2);
}

/** Edit that removes the parameter from that scope, or undefined when it is not set there. */
function resetParamEdit(text, base, name, index = null) {
  return jsonedit.removeProperty(text, paramsPath(base, index), name);
}

/**
 * Where a running simulation's parameter ("platform.cpu_3.gdb_port") lives in
 * the platform description: { base, index, name, instance }, index being null
 * for a module that is not replicated. The first part is the top container,
 * the second the instance; the rest is the parameter. Undefined when the
 * instance is not in the platform or the name has no parameter part.
 */
function runtimeTarget(doc, analysis, fullName) {
  const parts = String(fullName).split('.');
  // A parameter of the top container itself ("platform.gdb_port"): platform.params in the JSON.
  if (parts.length === 2 && parts[0] === 'platform') return { platform: true, name: parts[1] };
  if (parts.length < 3) return undefined;
  // The longest instance path after the top container: platform.periph.uart_0.baud.
  for (let k = parts.length - 1; k >= 2; k--) {
    const inst = analysis.instances.find((i) => i.name === parts.slice(1, k).join('.'));
    if (inst && !inst.isContainer && core.modulesOf(doc)[inst.base]) {
      return { base: inst.base, index: inst.index === null ? null : String(inst.index), name: parts.slice(k).join('.'), instance: inst.name };
    }
  }
  return undefined;
}

/** Edit that sets a parameter of the top container (platform.params), creating "platform" and "params" as needed. */
function setPlatformParamEdit(text, name, value) {
  const json = JSON.stringify(value);
  return jsonedit.setPropertyDeep(text, ['platform', 'params'], name, () => json, 0);
}

/** A parameter value read from a simulation as a platform value: integers beyond 2^53 as hex text. */
function schemaValue(v) {
  if (typeof v === 'bigint') {
    if (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
    return v > 0n ? '0x' + v.toString(16) : Number(v);
  }
  return v;
}

module.exports = { moduleForms, findRow, parseInput, typeLabel, toInput, fmtValue, setParamEdit, resetParamEdit, runtimeTarget, setPlatformParamEdit, schemaValue, ONE_REPLICA_ONLY };
