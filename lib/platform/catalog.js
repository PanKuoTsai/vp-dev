'use strict';
// Checks a platform against a QBox component catalog produced by
// tools/qbox-catalog: module types, constructor argument counts, port names
// and kinds, parameter names and value types. No VS Code dependency.

// Parameters every QBox module accepts without declaring them itself:
// log_level is read by the SCP logger of whichever module logs.
const UNIVERSAL_PARAMS = new Set(['log_level']);

// Binding ends that belong together. QBox lets either end declare the bind.
const PAIRS = [
  ['tlm_initiator', 'tlm_target'],
  ['signal_out', 'signal_in'],
  ['biflow', 'biflow'],
];

const HEX = /^0x[0-9A-Fa-f]+$/;
const VARREF = /^\$\{([A-Za-z_]\w*)\}(?:\s*([+-])\s*(0x[0-9A-Fa-f]+|\d+))?$/;
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Look a module type up; returns undefined when it is not registered. */
function moduleInfo(catalog, type) {
  return catalog && catalog.modules ? catalog.modules[type] : undefined;
}

/** Whether the catalog could introspect this module (ports and params are known). */
function introspected(info) {
  return !!(info && info.introspection && info.introspection.status === 'ok');
}

/**
 * Find the catalog port a configured port name refers to. A vector port
 * "spi_in" matches "spi_in_541"; a nested vector "ppi_in_cpu" matches
 * "ppi_in_cpu_0_30".
 */
function findPort(info, name) {
  for (const p of info.introspection.ports || []) {
    if (p.name === name) return p;
  }
  for (const p of info.introspection.ports || []) {
    if (p.vector && new RegExp(`^${reEscape(p.name)}(_\\d+)+$`).test(name)) return p;
  }
  return null;
}

function pairOk(a, b) {
  return PAIRS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

/** Coarse class of a C++ parameter type as the catalog spells it. */
function paramClass(cppType) {
  const t = cppType.replace(/\s+/g, ' ').trim();
  if (t === 'bool') return 'bool';
  if (/basic_string|^std::string$/.test(t)) return 'string';
  if (/^std::vector</.test(t)) return 'array';
  if (/^(float|double|long double)$/.test(t)) return 'float';
  if (/^(unsigned |signed )?(char|short|int|long|long long)( int)?$|^(unsigned|signed)$|^u?int(8|16|32|64)_t$|^size_t$/.test(t)) {
    return /^unsigned|^uint|^size_t/.test(t) ? 'uint' : 'int';
  }
  return null; // something we do not check
}

/** Class of a schema value, or null when it is only known at Lua run time. */
function valueClass(v, env) {
  if (typeof v === 'boolean') return { cls: 'bool' };
  if (typeof v === 'number') return { cls: Number.isInteger(v) ? 'int' : 'float', num: v };
  if (Array.isArray(v)) return { cls: 'array' };
  if (v !== null && typeof v === 'object') return null; // { $lua }
  if (typeof v !== 'string') return null;
  if (HEX.test(v)) return { cls: 'int', num: Number(BigInt(v)) };
  const m = VARREF.exec(v);
  if (m) {
    const r = env[m[1]];
    if (r === null || r === undefined) return null;
    const off = m[2] ? BigInt(m[3]) : 0n;
    const n = m[2] === '-' ? r - off : r + off;
    return { cls: 'int', num: Number(n) };
  }
  if (v.includes('${')) return { cls: 'string' };
  return { cls: 'string' };
}

/** Problem (or null) for setting a parameter of class pc to value v. */
function checkValue(pc, v, env) {
  const vc = valueClass(v, env);
  if (!pc || !vc) return null;
  const isNum = vc.cls === 'int' || vc.cls === 'float';
  switch (pc) {
  case 'bool':
    return vc.cls === 'bool' ? null : 'expects true or false';
  case 'int':
  case 'uint':
    if (vc.cls !== 'int') return 'expects an integer';
    if (pc === 'uint' && vc.num < 0) return 'expects a non-negative integer';
    return null;
  case 'float':
    return isNum ? null : 'expects a number';
  case 'string':
    return vc.cls === 'string' ? null : 'expects a string';
  case 'array':
    return vc.cls === 'array' ? null : 'expects a list';
  default:
    return null;
  }
}

/** Closest registered type names, for "did you mean". */
function suggest(catalog, type) {
  const names = Object.keys(catalog.modules || {});
  const dist = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[a.length][b.length];
  };
  const lower = type.toLowerCase();
  return names
    .map((n) => ({ n, d: dist(lower, n.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(3, Math.floor(type.length / 4)))
    .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))
    .slice(0, 3)
    .map((x) => x.n);
}

/**
 * Check expanded instances against the catalog.
 * Returns problems in the same shape as core.analyze.
 */
function check(instances, env, catalog) {
  const problems = [];
  const add = (severity, message, module, port) => problems.push({ severity, message, module, port });
  const byName = new Map(instances.map((i) => [i.name, i]));
  const reported = new Set(); // per base module, so replicas do not repeat a message
  const once = (key, fn) => { if (!reported.has(key)) { reported.add(key); fn(); } };
  const commit = catalog.qbox && catalog.qbox.commit ? ` ${catalog.qbox.commit.slice(0, 8)}` : '';

  for (const inst of instances) {
    const info = moduleInfo(catalog, inst.type);
    if (!info) {
      once(`type:${inst.base}`, () => {
        const s = suggest(catalog, inst.type);
        add('error',
          `${inst.base}: module type ${inst.type} is not registered in QBox${commit}` +
          (s.length ? `. Did you mean ${s.join(', ')}?` : ''), inst.base);
      });
      continue;
    }
    if (Array.isArray(info.args) && inst.mod.args !== undefined && info.args.length !== inst.args.length) {
      once(`args:${inst.base}`, () => add('error',
        `${inst.base}: ${inst.type} takes ${info.args.length} constructor argument(s), ${inst.args.length} given`, inst.base));
    }
    if (Array.isArray(info.args) && info.args.length && inst.mod.args === undefined) {
      once(`args:${inst.base}`, () => add('error',
        `${inst.base}: ${inst.type} takes ${info.args.length} constructor argument(s) (${info.args.map((a) => a.expects || a.decl).join(', ')}), none given`,
        inst.base));
    }
    // A library that comes with VP Studio but is not built for this QBox yet.
    if (info.unbuilt) {
      once(`unbuilt:${inst.base}`, () => add('error', `${inst.base}: ${info.unbuilt}`, inst.base));
      continue;
    }
    if (!introspected(info)) {
      once(`intro:${inst.type}`, () => add('info',
        `${inst.base}: ports and parameters of ${inst.type} are not checked (the catalog could not introspect it)`, inst.base));
      continue;
    }

    // Parameters
    const params = new Map((info.introspection.params || []).map((p) => [p.name, p]));
    for (const [name, v] of Object.entries(inst.params)) {
      if (UNIVERSAL_PARAMS.has(name)) continue;
      const p = params.get(name);
      if (!p) {
        once(`param:${inst.base}.${name}`, () => add('warning', `${inst.base}: ${inst.type} has no parameter ${name}`, inst.base));
        continue;
      }
      const why = checkValue(paramClass(p.type), v, env);
      if (why) {
        once(`ptype:${inst.base}.${name}`, () => add('error',
          `${inst.base}.${name}: ${why} (${p.type}), got ${JSON.stringify(v)}`, inst.base));
      }
    }
    for (const req of info.requiredParams || []) {
      if (!(req in inst.params) && !inst.ports.some((p) => req.startsWith(p.name + '.'))) {
        once(`req:${inst.base}.${req}`, () => add('warning',
          `${inst.base}: ${inst.type} will not start without parameter ${req}`, inst.base));
      }
    }

    // Ports, checked from the declaring end
    for (const p of inst.ports) {
      const own = findPort(info, p.name);
      if (!own) {
        once(`port:${inst.base}.${p.name}`, () => add('error', `${inst.base}: ${inst.type} has no port ${p.name}`, inst.base, p.name));
        continue;
      }
      const peer = byName.get(p.peer);
      if (!peer) continue; // reported by core.analyze
      const pinfo = moduleInfo(catalog, peer.type);
      if (!introspected(pinfo)) continue;
      const other = findPort(pinfo, p.peerPort);
      if (!other) {
        once(`peer:${inst.base}.${p.name}`, () => add('error',
          `${inst.base}.${p.name} binds to ${p.bind}, but ${peer.type} has no port ${p.peerPort}`, inst.base, p.name));
        continue;
      }
      const checkable = (k) => k !== 'sc_port' && k !== 'sc_export' && k !== 'tlm_socket';
      if (checkable(own.kind) && checkable(other.kind) && !pairOk(own.kind, other.kind)) {
        once(`kind:${inst.base}.${p.name}`, () => add('warning',
          `${inst.base}.${p.name} (${own.kind}) is bound to ${p.bind} (${other.kind}); these do not normally connect`,
          inst.base, p.name));
      }
    }
  }
  return problems;
}

/** Registered module types whose name contains text (case-insensitive), sorted. */
function listTypes(catalog, text = '') {
  const t = text.toLowerCase();
  return Object.keys(catalog.modules || {}).filter((n) => n.toLowerCase().includes(t)).sort();
}

module.exports = { check, findPort, pairOk, paramClass, valueClass, suggest, listTypes, moduleInfo, introspected, UNIVERSAL_PARAMS };
