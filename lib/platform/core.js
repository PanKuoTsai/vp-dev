'use strict';
// Core logic with no VS Code dependency: expansion, analysis and Lua generation
// for platform descriptions (schema v0.1 and v0.2). Runs under plain Node for tests.
//
// Subsystems (v0.2): a module with "modules" is a container holding other
// modules. Everything outside this file sees one flat list (modulesOf), with
// nested modules named by their dotted path ("periph.uart_0"). References in a
// bind or args are resolved lexically: the first name is looked up in the
// module's own container, then in each enclosing one.

const qos = require('../analysis/qos');

const VARREF = /^\$\{([A-Za-z_]\w*)\}(?:\s*([+-])\s*(0x[0-9A-Fa-f]+|\d+))?$/;
const HEX = /^0x[0-9A-Fa-f]+$/;
const TOKEN = /\$\{([A-Za-z_]\w*)\}/g;

const isLua = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && '$lua' in v;
const subIdx = (s, i) => (i === null || i === undefined ? s : s.split('{i}').join(String(i)));
const hex = (n) => '0x' + n.toString(16);

/** Evaluate an integer-like schema value to a BigInt, or null if it is not constant. */
function evalInt(v, env) {
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v !== 'string') return null;
  if (HEX.test(v)) return BigInt(v);
  const m = VARREF.exec(v);
  if (!m || !(m[1] in env) || env[m[1]] === null) return null;
  const off = m[2] ? BigInt(m[3]) : 0n;
  return m[2] === '-' ? env[m[1]] - off : env[m[1]] + off;
}

function buildEnv(doc) {
  const env = {};
  for (const v of doc.variables || []) env[v.name] = evalInt(v.value, env);
  return env;
}

function countOf(n, env, what) {
  const r = evalInt(n, env);
  if (r === null || r < 0n || r > 4096n) {
    throw new Error(`${what} must resolve to a constant integer between 0 and 4096, got ${JSON.stringify(n)}`);
  }
  return Number(r);
}

// ---------------------------------------------------------------- subsystems

const isContainerDef = (mod) => !!mod && typeof mod === 'object' && mod.modules !== undefined && mod.modules !== null;
const parentOf = (p) => (p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '');
const join = (c, n) => (c ? `${c}.${n}` : n);
/** Split "a.b.port" into its module path and port (port names have no dots). */
function splitBind(bind) {
  const dot = String(bind).lastIndexOf('.');
  return dot < 0 ? { module: String(bind), port: '' } : { module: bind.slice(0, dot), port: bind.slice(dot + 1) };
}

/**
 * The platform's modules as one flat object: { modules: {path: def}, parent: {path: container},
 * containers: Set, order: [path], shadows: [{name, inner, outer}] }. Bind and
 * args references in the defs are rewritten to full paths; containers keep
 * their own entry (without "modules", with container: true).
 */
function flatten(doc) {
  const names = new Map(); // container path -> Set of child names
  const defs = new Map();
  const parent = {};
  const containers = new Set();
  const order = [];
  const walk = (mods, prefix) => {
    names.set(prefix, new Set(Object.keys(mods || {})));
    for (const [name, mod] of Object.entries(mods || {})) {
      const full = join(prefix, name);
      defs.set(full, mod);
      parent[full] = prefix;
      order.push(full);
      if (isContainerDef(mod)) { containers.add(full); walk(mod.modules, full); }
    }
  };
  walk(doc.modules, '');
  const has = (c, n) => {
    const set = names.get(c);
    if (!set) return false;
    if (set.has(n)) return true;
    const m = /^(.*)_(\d+|\{i\})$/.exec(n); // a replica: cpu_3, cpu_{i}
    return !!m && set.has(m[1]);
  };
  /** Full path of a module reference made from container scope, or the reference itself if nothing matches. */
  const resolve = (ref, scope) => {
    const first = String(ref).split('.')[0];
    for (let c = scope; ; c = parentOf(c)) {
      if (has(c, first)) return join(c, ref);
      if (c === '') return ref;
    }
  };
  const bindFull = (bind, scope) => {
    if (typeof bind !== 'string') return bind;
    const { module, port } = splitBind(bind);
    return port ? `${resolve(module, scope)}.${port}` : resolve(module, scope);
  };
  const portsFull = (ports, scope) => {
    if (!ports) return ports;
    const out = {};
    for (const [k, p] of Object.entries(ports)) out[k] = p && typeof p === 'object' && p.bind !== undefined ? { ...p, bind: bindFull(p.bind, scope) } : p;
    return out;
  };
  const modules = {};
  const shadows = [];
  for (const full of order) {
    const mod = defs.get(full);
    const scope = parent[full];
    const copy = { ...mod };
    if (scope) {
      // Only nested modules need rewriting; top-level references are already full.
      if (copy.ports) copy.ports = portsFull(copy.ports, scope);
      if (copy.perIndex) {
        copy.perIndex = Object.fromEntries(Object.entries(copy.perIndex).map(([k, ov]) => [k, ov && ov.ports ? { ...ov, ports: portsFull(ov.ports, scope) } : ov]));
      }
      if (Array.isArray(copy.args)) copy.args = copy.args.map((a) => (a && typeof a === 'object' && typeof a.ref === 'string' ? { ...a, ref: resolve(a.ref, scope) } : a));
      const name = full.slice(scope.length + 1);
      for (let c = parentOf(scope); ; c = parentOf(c)) {
        if (names.get(c) && names.get(c).has(name)) { shadows.push({ name, inner: full, outer: join(c, name) }); break; }
        if (c === '') break;
      }
    }
    if (containers.has(full)) { delete copy.modules; copy.container = true; }
    modules[full] = copy;
  }
  return { modules, parent, containers, order, shadows, resolve };
}

/** All modules, nested ones under their dotted path, with references made full. */
const modulesOf = (doc) => flatten(doc).modules;

/** JSON path of a module: "periph.uart_0" is ["modules", "periph", "modules", "uart_0"]. */
const jsonPath = (base) => String(base).split('.').flatMap((n) => ['modules', n]);

/**
 * The reference to write in fromBase's container to reach targetPath (a module
 * path): the shortest one that resolves back to it. Throws when a nearer
 * module of the same name hides it.
 */
function refFor(doc, fromBase, targetPath) {
  const fl = flatten(doc);
  const scope = fl.parent[fromBase] !== undefined ? fl.parent[fromBase] : parentOf(fromBase);
  // Relative to each enclosing container the target is in; the shortest that resolves wins.
  const tries = [];
  for (let c = scope; ; c = parentOf(c)) {
    if (!c) { tries.push(targetPath); break; }
    if (targetPath.startsWith(c + '.')) tries.push(targetPath.slice(c.length + 1));
  }
  tries.sort((x, y) => x.length - y.length);
  for (const t of tries) if (fl.resolve(t, scope) === targetPath) return t;
  throw new Error(`${targetPath} cannot be named from ${scope || 'the top level'}: a nearer module with the same name hides it`);
}

/** Expand count / repeat / perIndex into concrete instances. */
function expand(doc) {
  const env = buildEnv(doc);
  const instances = [];
  const fl = flatten(doc);
  for (const [base, mod] of Object.entries(fl.modules)) {
    const replicated = mod.count !== undefined;
    const n = replicated ? countOf(mod.count, env, `modules.${base}.count`) : 1;
    for (let k = 0; k < n; k++) {
      const idx = replicated ? k : null;
      const ov = (replicated && mod.perIndex && mod.perIndex[String(k)]) || {};
      const params = Object.assign({}, mod.params, ov.params);
      const rawPorts = Object.assign({}, mod.ports, ov.ports);
      const ports = [];
      for (const [pname, p] of Object.entries(rawPorts)) {
        const reps = p.repeat !== undefined ? countOf(p.repeat, env, `modules.${base}.ports.${pname}.repeat`) : null;
        const idxs = reps === null ? [idx] : Array.from({ length: reps }, (_, r) => r);
        for (const r of idxs) {
          const bind = subIdx(p.bind, r);
          const dot = bind.lastIndexOf('.');
          ports.push({
            name: subIdx(pname, r),
            bind,
            peer: bind.slice(0, dot),
            peerPort: bind.slice(dot + 1),
            raw: p,
            address: p.address !== undefined ? evalInt(p.address, env) : undefined,
            size: p.size !== undefined ? evalInt(p.size, env) : undefined,
            priority: p.priority || 0,
            relative: p.relative_addresses !== false,
          });
        }
      }
      instances.push({
        name: replicated ? `${base}_${k}` : base,
        base,
        index: idx,
        type: mod.type,
        mod,
        container: fl.parent[base],
        isContainer: !!mod.container,
        params,
        ports,
        args: (mod.args || []).map((a) => (typeof a === 'string' ? a : { ref: subIdx(a.ref, idx) })),
      });
    }
  }
  return { env, instances };
}

/**
 * Structural analysis used by diagnostics, the tree view and the platform view.
 * options.catalog: a QBox component catalog (tools/qbox-catalog); when given,
 * module types, ports and parameters are checked against it as well.
 */
/** Module types drawn and analysed as buses (address decoders). */
const BUS_TYPES = new Set(['router', 'at_bus']);
/** Module types that can be bound to an at_bus (they use nb_transport). */
const AT_INITIATORS = new Set(['traffic_gen']);

function analyze(doc, options = {}) {
  const problems = [];
  const add = (severity, message, module, port) => problems.push({ severity, message, module, port });
  let ex;
  try {
    ex = expand(doc);
  } catch (e) {
    add('error', e.message);
    return { instances: [], memoryMap: [], connections: [], buses: [], routers: [], problems, env: {} };
  }
  const { instances, env } = ex;
  const fl = flatten(doc);
  for (const c of fl.containers) {
    const m = fl.modules[c];
    if (m.count !== undefined) add('error', `${c}: a container cannot be replicated with count; repeat the modules inside it instead`, c);
    if (m.ports && Object.keys(m.ports).length) add('error', `${c}: a container has no ports of its own; bind the modules inside it`, c);
  }
  for (const sh of fl.shadows) {
    add('info', `${sh.inner} hides ${sh.outer}: inside ${parentOf(sh.inner)}, "${sh.name}" means ${sh.inner}`, sh.inner);
  }
  const byName = new Map();
  for (const inst of instances) {
    if (byName.has(inst.name)) add('error', `Duplicate instance name ${inst.name}`, inst.base);
    byName.set(inst.name, inst);
  }
  // Buses: QBox's router (blocking, LT) and VP Studio's at_bus (approximately
  // timed). The sim agent and the probes use LT, so they go on routers only.
  const buses = instances.filter((i) => BUS_TYPES.has(i.type)).map((i) => i.name);
  const routers = instances.filter((i) => i.type === 'router').map((i) => i.name);
  const memoryMap = [];
  const connections = [];
  for (const inst of instances) {
    for (const a of inst.args) {
      if (typeof a === 'object' && !byName.has(a.ref)) add('error', `${inst.name}: args reference unknown instance ${a.ref}`, inst.base);
    }
    for (const p of inst.ports) {
      if (!byName.has(p.peer)) {
        add('error', `${inst.name}.${p.name} binds to unknown instance ${p.peer}`, inst.base, p.name);
        continue;
      }
      if (p.raw.address !== undefined) {
        if (p.address === null || p.size === null) {
          add('info', `${inst.name}.${p.name}: address or size is not a constant, skipped in the memory map`, inst.base, p.name);
        } else {
          if (p.size === 0n) add('warning', `${inst.name}.${p.name} has size 0`, inst.base, p.name);
          memoryMap.push({
            instance: inst.name, base: inst.base, port: p.name, bus: p.peer,
            start: p.address, size: p.size, end: p.address + p.size - 1n, priority: p.priority, relative: p.relative,
          });
        }
      } else {
        connections.push({ from: inst.name, fromBase: inst.base, fromPort: p.name, to: p.peer, toPort: p.peerPort });
      }
    }
  }
  memoryMap.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  for (let i = 0; i < memoryMap.length; i++) {
    for (let j = i + 1; j < memoryMap.length; j++) {
      const a = memoryMap[i];
      const b = memoryMap[j];
      if (b.start > a.end) break;
      if (a.bus === b.bus && a.priority === b.priority) {
        add('warning',
          `Address overlap on ${a.bus}: ${a.instance}.${a.port} [${hex(a.start)}..${hex(a.end)}] and ` +
          `${b.instance}.${b.port} [${hex(b.start)}..${hex(b.end)}] have the same priority`, b.base, b.port);
      }
    }
  }
  // A QEMU instance has a single gdb server, which already shows every CPU of
  // that instance. QBox starts it for each CPU whose gdb_port is not 0, so a
  // second CPU asking for it makes the simulator exit at start.
  const gdbByQemu = new Map();
  for (const inst of instances) {
    if (!String(inst.type).startsWith('cpu_') || !('gdb_port' in inst.params)) continue;
    if (evalInt(inst.params.gdb_port, env) === 0n) continue;
    const q = inst.args.find((a) => typeof a === 'object');
    const key = q ? q.ref : '';
    if (!gdbByQemu.has(key)) gdbByQemu.set(key, []);
    gdbByQemu.get(key).push(inst);
  }
  for (const [qemu, list] of gdbByQemu) {
    if (list.length < 2) continue;
    const names = list.length > 3 ? `${list[0].name}, ${list[1].name} … ${list[list.length - 1].name}` : list.map((i) => i.name).join(', ');
    add('error',
      `${names} all set gdb_port, but ${qemu || 'the QEMU instance'} has a single gdb server that shows every CPU; ` +
      'the simulator would exit at start ("could not open gdbserver"). Set gdb_port on one CPU only, for example under ' +
      `perIndex "0", or use "Start Simulation with Target Debug Port".`, list[1].base);
  }
  if (options.catalog) problems.push(...require('./catalog').check(instances, env, options.catalog));
  // A generated device tree is only used if something loads it.
  const dtOut = doc.devicetree && doc.devicetree.output;
  if (dtOut) {
    const loaded = Object.values(doc.modules || {}).some((m) => m.type === 'loader' && Array.isArray(m.entries) && m.entries.some((e) => e.bin_file === dtOut));
    if (!loaded) add('warning', `devicetree.output ${dtOut} is not loaded by any loader entry, so the simulation will not use the generated device tree. Add a loader entry with "bin_file": ${JSON.stringify(dtOut)}.`);
  }
  // at_bus takes approximately-timed initiators only (traffic_gen); QEMU CPUs and
  // the like use b_transport and would get an error on every access.
  const atBuses = new Set(instances.filter((i) => i.type === 'at_bus').map((i) => i.name));
  for (const c of connections) {
    if (!atBuses.has(c.to)) continue;
    const from = byName.get(c.from);
    if (from && !AT_INITIATORS.has(from.type)) {
      add('warning', `${c.from}.${c.fromPort} is bound to ${c.to}, an at_bus, which takes approximately-timed initiators only (traffic_gen); accesses from ${from.type} would fail`, c.fromBase, c.fromPort);
    }
  }
  // at_bus QoS per master (the masters parameter; perf.so stops on the same errors).
  for (const bus of instances.filter((i) => i.type === 'at_bus' && typeof i.params.masters === 'string')) {
    const { entries, errors } = qos.parseMasters(bus.params.masters);
    for (const e of errors) add('error', `${bus.name}.masters: ${e}`, bus.base);
    // The traffic_gens bound to this bus, or to a bus in front of it (a MAU behind a system bus).
    const gensOf = (name, seen) => {
      if (seen.has(name)) return [];
      seen.add(name);
      const direct = connections.filter((c) => c.to === name).map((c) => byName.get(c.from)).filter((g) => g && g.type === 'traffic_gen');
      const up = memoryMap.filter((r) => r.instance === name && atBuses.has(r.bus)).flatMap((r) => gensOf(r.bus, seen));
      return [...direct, ...up];
    };
    const gens = [...new Set(gensOf(bus.name, new Set()))];
    const label = (g) => (typeof g.params.label === 'string' && g.params.label) || g.name.split('.').pop();
    for (const e of entries) {
      const hit = gens.filter((g) => qos.matches(e.name, g.name, label(g)));
      if (!hit.length) {
        add('warning', `${bus.name}.masters: ${e.name} is not a traffic_gen whose accesses reach ${bus.name} (${gens.map((g) => g.name).join(', ') || 'none do'}); its settings are not used`, bus.base);
      }
      if ('priority' in e.settings && bus.params.arbitration !== 'priority') {
        add('warning', `${bus.name}.masters: ${e.name} has a priority, which is used only with "arbitration": "priority"`, bus.base);
      }
    }
    for (const g of gens) {
      const own = entries.filter((e) => qos.matches(e.name, g.name, label(g)));
      if (own.length > 1) add('warning', `${bus.name}.masters: ${g.name} matches ${own.map((e) => e.name).join(' and ')}; only the first is used`, bus.base);
    }
  }
  return { instances, memoryMap, connections, buses, routers, problems, env };
}

// ---------------------------------------------------------------- Lua generation

const luaStr = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

function template(s, idx) {
  s = subIdx(s, idx);
  const parts = [];
  let pos = 0;
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(s)) !== null) {
    if (m.index > pos) parts.push(luaStr(s.slice(pos, m.index)));
    parts.push(m[1] === 'TOP' ? 'top()' : `tostring(${m[1]})`);
    pos = m.index + m[0].length;
  }
  if (pos < s.length || parts.length === 0) parts.push(luaStr(s.slice(pos)));
  return parts.join('..');
}

function value(v, idx) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return '{' + v.map((x) => value(x, idx)).join(', ') + '}';
  if (isLua(v)) return `(${v.$lua})`;
  const m = VARREF.exec(v);
  if (m) return m[2] ? `${m[1]} ${m[2]} ${m[3]}` : m[1];
  if (HEX.test(v)) return v;
  return template(v, idx);
}

/**
 * A bind as written in the Lua of a module in container: relative when the
 * target is inside that container, otherwise absolute from the platform.
 * Top-level modules keep the plain relative form.
 */
function luaBind(bind, container) {
  if (!container) return `&${bind}`;
  if (bind.startsWith(container + '.')) return `&${bind.slice(container.length + 1)}`;
  return `&platform.${bind}`;
}
/** Lua expression for a module's table: platform["periph"]["uart_0"]. */
const luaPath = (name) => 'platform' + String(name).split('.').map((n) => `[${luaStr(n)}]`).join('');

function emitInstance(inst, depth = 1, libs = {}) {
  const ind = '    '.repeat(depth);
  const ind1 = '    ';
  const idx = inst.index;
  const localName = inst.container ? inst.name.slice(inst.container.length + 1) : inst.name;
  const lines = [`moduletype = "${inst.type}";`];
  if (inst.mod.args) {
    lines.push('args = {' + inst.args.map((a) => (typeof a === 'string' ? luaStr(a) : `"&platform.${a.ref}"`)).join(', ') + '};');
  }
  // dylib may use ${TOP} (a model library next to the platform); a plain name is emitted as before.
  if (inst.mod.dylib !== undefined) lines.push(`dylib_path = ${template(inst.mod.dylib, null)};`);
  // A type built outside QBox that the platform does not locate: the launcher's path.
  else if (libs[inst.type]) lines.push(`dylib_path = ${luaStr(libs[inst.type])};`);
  for (const [k, v] of Object.entries(inst.params)) lines.push(`${k} = ${value(v, idx)};`);
  for (const p of inst.ports) {
    const f = [];
    if (p.raw.address !== undefined) f.push(`address = ${value(p.raw.address, idx)}`);
    if (p.raw.size !== undefined) f.push(`size = ${value(p.raw.size, idx)}`);
    if (p.raw.priority !== undefined) f.push(`priority = ${p.raw.priority}`);
    if (p.raw.relative_addresses !== undefined) f.push(`relative_addresses = ${p.raw.relative_addresses ? 'true' : 'false'}`);
    f.push(`bind = "${luaBind(p.bind, inst.container)}"`);
    lines.push(`${p.name} = {${f.join(', ')}};`);
  }
  for (const e of inst.mod.entries || []) {
    lines.push('{ ' + Object.entries(e).map(([k, v]) => `${k} = ${value(v, idx)}`).join(', ') + ' };');
  }
  const body = lines.map((l) => ind + ind1 + l);
  // Raw Lua inside a replica may use i: wrap in a function call so i is in scope.
  if (idx !== null && JSON.stringify(inst.mod).includes('$lua')) {
    return [`${ind}${localName} = (function() local i = ${idx}; return {`, ...body, `${ind}} end)();`, ''];
  }
  return [`${ind}${localName} = {`, ...body, `${ind}};`, ''];
}

/** Lua of the modules of one container, in description order; nested containers become nested tables. */
function emitModules(mods, prefix, depth, byBase, libs = {}) {
  const out = [];
  for (const [name, mod] of Object.entries(mods || {})) {
    const full = join(prefix, name);
    if (isContainerDef(mod)) {
      const ind = '    '.repeat(depth);
      out.push(`${ind}${name} = {`, `${ind}    moduletype = "${mod.type || 'Container'}";`);
      if (mod.dylib !== undefined) out.push(`${ind}    dylib_path = ${template(mod.dylib, null)};`);
      for (const [k, v] of Object.entries(mod.params || {})) out.push(`${ind}    ${k} = ${value(v, null)};`);
      out.push('');
      out.push(...emitModules(mod.modules, full, depth + 1, byBase, libs));
      out.push(`${ind}};`, '');
    } else {
      for (const inst of byBase.get(full) || []) out.push(...emitInstance(inst, depth, libs));
    }
  }
  return out;
}

/**
 * Generate the Lua configuration.
 * options.overrides: [{instance, param, value}] appended after the platform table
 * (used by the launcher, for example to open a gdb port, without touching the JSON).
 * options.extraModules: [{name, type, dylib?, params?}] added to the platform the same
 * way (used by the launcher to add the sim agent).
 * options.extraModules[].ports: {port: {address?, size?, priority?, bind}} for those modules.
 * options.portOverrides: [{instance, port, value: {address?, size?, priority?, bind}}]
 * replace a port of a platform module (used to put a tracer in front of it).
 * options.libraries: {type: path without .so} for types built outside QBox (VP Studio's
 * own modules, wizard models) used without a "dylib" in the platform: the path on this machine.
 * options.variableValues: {NAME: value} set before the platform's variables;
 * only overridable (or hostPort) variables keep them.
 */
/** Lua table of a port binding: {address = .., size = .., priority = .., bind = "&peer.port"}. */
function portTable(p, container = '') {
  const f = [];
  if (p.address !== undefined) f.push(`address = ${value(p.address, null)}`);
  if (p.size !== undefined) f.push(`size = ${value(p.size, null)}`);
  if (p.priority !== undefined) f.push(`priority = ${p.priority}`);
  if (p.relative_addresses !== undefined) f.push(`relative_addresses = ${p.relative_addresses ? 'true' : 'false'}`);
  if (p.bind !== undefined) f.push(`bind = "${luaBind(p.bind, container)}"`);
  return `{${f.join(', ')}}`;
}

function generate(doc, options = {}) {
  const { instances } = expand(doc);
  const out = [`-- Generated from ${doc.name} (schema ${doc.schemaVersion}). Do not edit.`, ''];
  out.push('function top()', '    local str = debug.getinfo(2, "S").source:sub(2)', '    return str:match("(.*/)") or "./"', 'end', '');
  for (const f of doc.luaPrelude || []) out.push(`dofile(${template(f, null)});`);
  // Values the launcher chose (free host ports, for example) come before the
  // platform's own "if NAME == nil" defaults, so they win.
  for (const [k, v] of Object.entries(options.variableValues || {})) out.push(`${k} = ${value(v, null)}`);
  for (const v of doc.variables || []) {
    if (v.overridable || v.hostPort) out.push(`if ${v.name} == nil then ${v.name} = ${value(v.value, null)} end`);
    else out.push(`${v.global ? '' : 'local '}${v.name} = ${value(v.value, null)}`);
  }
  out.push('');
  for (const f of doc.luaIncludes || []) out.push(`dofile(${template(f, null)});`);
  const plat = doc.platform || {};
  out.push('', 'platform = {', `    moduletype = "${plat.moduletype || 'Container'}";`);
  for (const [k, v] of Object.entries(plat.params || {})) out.push(`    ${k} = ${value(v, null)};`);
  out.push('');
  const byBase = new Map();
  for (const inst of instances) {
    if (inst.isContainer) continue;
    if (!byBase.has(inst.base)) byBase.set(inst.base, []);
    byBase.get(inst.base).push(inst);
  }
  out.push(...emitModules(doc.modules, '', 1, byBase, options.libraries || {}));
  out.push('};');
  for (const f of doc.luaAppend || []) out.push(`dofile(${template(f, null)});`);
  for (const m of options.extraModules || []) {
    if (doc.modules && Object.prototype.hasOwnProperty.call(doc.modules, m.name)) {
      throw new Error(`cannot add module ${m.name}: the platform already has a module with that name`);
    }
    const f = [`moduletype = ${luaStr(m.type)}`];
    if (m.dylib !== undefined) f.push(`dylib_path = ${luaStr(m.dylib)}`);
    for (const [k, v] of Object.entries(m.params || {})) f.push(`${k} = ${value(v, null)}`);
    for (const [k, p] of Object.entries(m.ports || {})) f.push(`${k} = ${portTable(p)}`);
    out.push(`platform[${luaStr(m.name)}] = { ${f.join('; ')} }`);
  }
  for (const o of options.portOverrides || []) {
    out.push(`${luaPath(o.instance)}[${luaStr(o.port)}] = ${portTable(o.value, parentOf(o.instance))}`);
  }
  for (const o of options.overrides || []) {
    out.push(`${luaPath(o.instance)}[${luaStr(o.param)}] = ${value(o.value, null)}`);
  }
  return out.join('\n') + '\n';
}

module.exports = { expand, analyze, generate, evalInt, buildEnv, hex, flatten, modulesOf, jsonPath, refFor, splitBind, isContainerDef, BUS_TYPES, AT_INITIATORS };
