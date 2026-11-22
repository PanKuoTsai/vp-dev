'use strict';
// Delivery kits (G-09): one .tar.gz with a platform, every file it refers to,
// the pinned QBox version and the sources of the models it uses, so that
// someone else can open it and boot it. Export: plan() finds the files and
// where they go, exportKit() writes the archive. Import: importKit() unpacks
// and checks it, then omittedReport() says which left-out files are still
// missing. No VS Code dependency.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('../platform/core');
const images = require('../platform/images');
const tar = require('./tar');

const KIT_VERSION = 1;
const MANIFEST = 'kit.json';
const SUMS = 'SHA256SUMS';
const PLATFORM_DIR = 'platform';
const EXTERNAL_DIR = '_external';
/** How many folders above the platform's own a ${TOP} path may reach and keep its place. */
const MAX_UP = 3;
const ROLE_NAMES = {
  lua: 'Lua file', image: 'software image', disk: 'disk image', symbols: 'debug symbols', library: 'module library',
  devicetree: 'generated device tree', file: 'file', platform: 'platform', model: 'model source', qbox: 'QBox version',
};

const toPosix = (p) => p.split(path.sep).join('/');

/** Role of a string by where it sits in the platform document. */
function roleOf(jsonPath, key, token, whole) {
  const top = jsonPath[0];
  if (top === 'luaPrelude' || top === 'luaIncludes' || top === 'luaAppend') return 'lua';
  if (top === 'debug') return 'symbols';
  if (top === 'devicetree') return 'devicetree';
  if (key === 'bin_file' || key === 'elf_file') return 'image';
  if (key === 'dylib') return 'library';
  if (token !== whole && /(^|,)file=/.test(whole)) return 'disk';
  return 'file';
}

/** Path-like pieces of a string: the whole string, or the values of a "k=v,k=v" option list. */
function tokensOf(s) {
  return s.split(',').map((piece) => {
    const eq = piece.indexOf('=');
    return eq > 0 && /^[A-Za-z_][\w.-]*$/.test(piece.slice(0, eq)) ? piece.slice(eq + 1) : piece;
  }).map((t) => t.trim()).filter(Boolean);
}

/** Simple variables (string or number values) for expanding ${NAME}. */
function variableMap(doc) {
  return new Map((doc.variables || []).filter((v) => typeof v.value === 'string' || typeof v.value === 'number').map((v) => [v.name, String(v.value)]));
}

/** ${NAME} expanded with the simple variables, ${TOP} kept. null when something stays unknown. */
function expandVars(token, vars) {
  let s = token;
  for (let k = 0; k < 8 && /\$\{(?!TOP\})/.test(s); k++) {
    s = s.replace(/\$\{([A-Za-z_]\w*)\}/g, (m, n) => (n === 'TOP' ? m : vars.has(n) ? vars.get(n) : m));
  }
  return /\$\{(?!TOP\})/.test(s) ? null : s;
}

/**
 * Every place in the document that names a file: [{ jsonPath, key, token,
 * expanded, role }]. token is the text as written (what an export rewrites);
 * expanded has the simple variables filled in. Strings that only look like
 * paths through other variables are in `unknown`.
 */
function references(doc) {
  const vars = variableMap(doc);
  const refs = [];
  const unknown = [];
  const walk = (v, p, key) => {
    if (typeof v === 'string') {
      if (key === '$schema' || p[0] === 'description') return;
      for (const token of tokensOf(v)) {
        const expanded = expandVars(token, vars);
        if (expanded === null) {
          if (/\//.test(token)) unknown.push({ jsonPath: p, token });
          continue;
        }
        if (!/^\$\{TOP\}/.test(expanded) && !(expanded.startsWith('/') && expanded.split('/').filter(Boolean).length >= 2)) continue;
        if (expanded === '${TOP}' || /\$\{TOP\}.*\$\{TOP\}/.test(expanded)) continue;
        refs.push({ jsonPath: p, key, token, expanded, role: roleOf(p, key, token, v), viaVariable: expanded !== token });
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, p.concat(i), key));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'description') continue;
        walk(x, p.concat(k), k);
      }
    }
  };
  walk(doc, [], undefined);
  return { refs, unknown };
}

/** The *.model.json in a model folder, or undefined. */
function modelSpecIn(dir) {
  try {
    const f = fs.readdirSync(dir).find((n) => n.endsWith('.model.json'));
    return f && path.join(dir, f);
  } catch (e) { return undefined; }
}

/** Files of a model folder to ship: everything but build output and hidden folders. */
function modelFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'build' || e.name === 'node_modules') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) out.push(f);
    }
  };
  walk(dir);
  return out.sort();
}

function commonDir(dirs) {
  let parts = path.resolve(dirs[0]).split(path.sep);
  for (const d of dirs.slice(1)) {
    const q = path.resolve(d).split(path.sep);
    let i = 0;
    while (i < parts.length && i < q.length && parts[i] === q[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join(path.sep) || path.sep;
}

const isInside = (dir, f) => { const r = path.relative(dir, f); return r && !r.startsWith('..') && !path.isAbsolute(r); };
const upLevels = (from, to) => path.relative(from, to).split(path.sep).filter((x) => x === '..').length;

/**
 * What a kit of this platform holds and where. Nothing is written.
 * options: catalog (to find models the Lua gets its library for), pinFile
 * (qbox.pin.json of this VP Studio), bundledTypes (module types that come
 * with VP Studio).
 * Returns { name, platformPath, files: [{ source, path, role, size, refs }],
 *   models: [{ name, dir, path, spec }], bundled: [type], missing: [{ ref, file, role }],
 *   rewrites: [{ token, replacement }], notes: [string], pin }.
 * path is the place inside the kit, below the kit folder.
 */
function plan(doc, platformFile, options = {}) {
  const topDir = path.dirname(path.resolve(platformFile));
  const { refs, unknown } = references(doc);
  const notes = [];
  const missing = [];
  const modelDirs = new Map(); // dir -> { via: 'dylib'|'catalog', ref }
  const fileRefs = new Map(); // abs file -> { role, refs: [ref], absolute }
  const addFile = (abs, ref) => {
    const cur = fileRefs.get(abs) || { role: ref.role, refs: [], absolute: false };
    cur.refs.push(ref);
    if (!/^\$\{TOP\}/.test(ref.expanded)) cur.absolute = true;
    if (cur.role === 'file' && ref.role !== 'file') cur.role = ref.role;
    fileRefs.set(abs, cur);
  };

  for (const ref of refs) {
    const abs = images.resolveTemplate(ref.expanded, topDir);
    if (!abs) continue;
    if (ref.role === 'library') {
      let dir = path.dirname(abs);
      if (path.basename(dir) === 'build') dir = path.dirname(dir);
      const spec = modelSpecIn(dir);
      if (spec) {
        modelDirs.set(dir, { via: 'dylib', ref, absolute: !/^\$\{TOP\}/.test(ref.expanded) });
      } else if (fs.existsSync(abs + '.so')) {
        addFile(abs + '.so', ref);
        notes.push(`${toPosix(path.relative(topDir, abs))}.so is a built library: it only works with a QBox built the same way. Ship its source instead if you have it.`);
      } else {
        missing.push({ ref: ref.token, file: abs + '.so', role: ref.role });
      }
      continue;
    }
    let st;
    try { st = fs.statSync(abs); } catch (e) { st = null; }
    if (st && st.isDirectory()) {
      notes.push(`${ref.token} is a folder; only the files the platform names inside it are included.`);
      continue;
    }
    if (!st) {
      if (ref.role === 'devicetree') continue; // written by Start Simulation
      const gen = doc.devicetree && doc.devicetree.output && images.resolveTemplate(expandVars(doc.devicetree.output, variableMap(doc)) || '', topDir);
      if (gen && gen === abs) continue; // the loader loads the device tree generated at start
      missing.push({ ref: ref.token, file: abs, role: ref.role });
      continue;
    }
    if (ref.viaVariable && !/^\$\{TOP\}/.test(ref.expanded)) {
      notes.push(`${ref.token} is an absolute path through a variable; the variable's own value is what the kit changes.`);
    }
    addFile(abs, ref);
  }
  for (const u of unknown) notes.push(`${u.token} (at ${u.jsonPath.join('.')}) uses a variable VP Studio cannot work out; check that the file is in the kit.`);

  // Models that the extension supplies the library of (no dylib in the platform).
  const catalog = options.catalog;
  const bundledTypes = new Set(options.bundledTypes || []);
  const bundled = new Set();
  const types = new Set(Object.values(core.modulesOf(doc)).map((m) => m && m.type).filter(Boolean));
  for (const t of types) {
    const m = catalog && catalog.modules && catalog.modules[t];
    if (bundledTypes.has(t) || (m && m.model && m.model.bundled)) { bundled.add(t); continue; }
    if (m && m.model && m.model.dir && !Object.values(core.modulesOf(doc)).some((x) => x.type === t && x.dylib)) {
      if (![...modelDirs.keys()].includes(m.model.dir)) modelDirs.set(m.model.dir, { via: 'catalog', type: t, absolute: true });
    }
  }

  // The tree: the platform's folder and every ${TOP} file near it keep their places.
  const near = [...fileRefs.entries()].filter(([f, r]) => !r.absolute && upLevels(topDir, path.dirname(f)) <= MAX_UP);
  const nearModels = [...modelDirs.entries()].filter(([d, m]) => m.via === 'dylib' && !m.absolute && upLevels(topDir, d) <= MAX_UP);
  const root = commonDir([topDir, ...near.map(([f]) => path.dirname(f)), ...nearModels.map(([d]) => d)]);
  const inTree = (rel) => `${PLATFORM_DIR}/${toPosix(rel)}`;
  const platformPath = inTree(path.relative(root, path.resolve(platformFile)));
  const platformKitDir = path.posix.dirname(platformPath);

  const files = [];
  const used = new Set([platformPath]);
  const rewrites = [];
  const unique = (want) => {
    let p = want;
    for (let k = 2; used.has(p); k++) p = want.replace(/(\.[^./]*)?$/, (ext) => `-${k}${ext || ''}`);
    used.add(p);
    return p;
  };
  const topRef = (kitPath) => '${TOP}' + path.posix.relative(platformKitDir, kitPath);

  for (const [abs, r] of fileRefs) {
    const keep = !r.absolute && isInside(root, abs);
    const kitPath = keep ? inTree(path.relative(root, abs)) : unique(`${PLATFORM_DIR}/${EXTERNAL_DIR}/${path.basename(abs)}`);
    if (keep) used.add(kitPath);
    if (!keep) {
      for (const ref of r.refs) {
        if (!ref.viaVariable) rewrites.push({ token: ref.token, replacement: topRef(kitPath) });
      }
    }
    files.push({ source: abs, path: kitPath, role: r.role, size: fs.statSync(abs).size, refs: r.refs.map((x) => x.token) });
  }

  const models = [];
  for (const [dir, m] of modelDirs) {
    const spec = modelSpecIn(dir);
    let name;
    try { name = JSON.parse(fs.readFileSync(spec, 'utf8')).name; } catch (e) { name = path.basename(dir); }
    const keep = m.via === 'dylib' && !m.absolute && isInside(root, dir);
    const base = keep ? inTree(path.relative(root, dir))
      : m.via === 'dylib' ? `${PLATFORM_DIR}/${EXTERNAL_DIR}/${path.basename(dir)}` : `models/${path.basename(dir)}`;
    if (m.via === 'dylib' && !keep) {
      const lib = images.resolveTemplate(m.ref.expanded, topDir);
      rewrites.push({ token: m.ref.token, replacement: topRef(`${base}/${toPosix(path.relative(dir, lib))}`) });
    }
    for (const f of modelFiles(dir)) {
      const p = `${base}/${toPosix(path.relative(dir, f))}`;
      used.add(p);
      files.push({ source: f, path: p, role: 'model', size: fs.statSync(f).size, refs: [] });
    }
    models.push({ name, dir, path: base, spec: `${base}/${path.basename(spec)}` });
  }

  let pin = null;
  if (options.pinFile && fs.existsSync(options.pinFile)) {
    pin = JSON.parse(fs.readFileSync(options.pinFile, 'utf8'));
    const pinDir = path.dirname(options.pinFile);
    files.push({ source: options.pinFile, path: 'qbox/qbox.pin.json', role: 'qbox', size: fs.statSync(options.pinFile).size, refs: [] });
    for (const p of (pin.qbox && pin.qbox.patches) || []) {
      const f = path.join(pinDir, p);
      if (fs.existsSync(f)) files.push({ source: f, path: `qbox/${toPosix(p)}`, role: 'qbox', size: fs.statSync(f).size, refs: [] });
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    name: doc.name || path.basename(platformFile, '.platform.json'),
    description: doc.description || '',
    platformSource: path.resolve(platformFile), platformPath, root,
    files, models, bundled: [...bundled].sort(), missing, rewrites, notes: [...new Set(notes)], pin,
  };
}

/** The platform file's text with the rewritten paths (only inside JSON strings). */
function rewriteText(text, rewrites) {
  if (!rewrites.length) return text;
  const esc = (s) => JSON.stringify(s).slice(1, -1);
  return text.replace(/"(?:[^"\\]|\\.)*"/g, (lit) => {
    let s = lit;
    for (const r of rewrites) s = s.split(esc(r.token)).join(esc(r.replacement));
    return s;
  });
}

async function sha256File(file, onProgress) {
  const hash = crypto.createHash('sha256');
  let done = 0;
  for await (const c of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
    hash.update(c);
    done += c.length;
    if (onProgress) onProgress(done);
  }
  return hash.digest('hex');
}

const fmtSize = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GiB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);

/** README.md of a kit, from its manifest. */
function readme(m) {
  const L = [];
  L.push(`# ${m.name}: VP Studio kit`, '');
  if (m.description) L.push(m.description, '');
  L.push(`Made with VP Studio ${m.vpStudio || '?'} on ${m.created.slice(0, 10)}.`, '');
  L.push('## Open it', '',
    'In VP Studio: **VP Studio: Open Kit…** and choose this archive. It unpacks the kit, checks every file against `SHA256SUMS` and opens the platform.', '',
    'Without VP Studio:', '', '```', `tar xzf <this archive>`, `cd ${m.name}-kit && sha256sum -c ${SUMS}`, '```', '');
  L.push('## QBox', '');
  if (m.qbox && m.qbox.commit) {
    L.push(`The platform was tested with QBox commit \`${m.qbox.commit}\`${m.qbox.patches && m.qbox.patches.length ? ` with ${m.qbox.patches.map((p) => `\`qbox/${p}\``).join(', ')}` : ''}. \`qbox/qbox.pin.json\` has the details; VP Studio's \`tools/qbox-pin/build-qbox.sh\` builds exactly this version.`, '');
    if (m.qbox.used && m.qbox.used.commit && m.qbox.used.commit !== m.qbox.commit) {
      L.push(`The kit was made on a machine with QBox \`${m.qbox.used.commit}\`${m.qbox.used.dirty ? ' (with local changes)' : ''}.`, '');
    }
  }
  L.push('The kit does not contain QBox itself.', '');
  L.push('## Boot', '', 'From the kit folder:', '', '```', `vp-run --qbox <your qbox folder> ${m.platform} --expect 'login:'`, '```', '',
    'or open the platform file in VP Studio and run **VP Studio: Start Simulation**.', '');
  if (m.bundled && m.bundled.length) {
    L.push('## Modules that come with VP Studio', '', `The platform uses ${m.bundled.map((t) => `\`${t}\``).join(', ')}. Build ${m.bundled.length > 1 ? 'them' : 'it'} once on your machine with the matching VP Studio build command.`, '');
  }
  if (m.models && m.models.length) {
    L.push('## Models', '', 'The kit has the sources of these models; build each one on your machine with **VP Studio: Build Model** (or `tools/model-build/build.sh`) before starting:', '');
    for (const x of m.models) L.push(`- \`${x.name}\`: \`${x.spec}\``);
    L.push('');
  }
  if (m.omitted && m.omitted.length) {
    L.push('## Files you need to add', '', 'These files were left out of the kit. Put each one at its place before starting:', '');
    for (const o of m.omitted) {
      L.push(`- \`${o.path}\` (${ROLE_NAMES[o.role] || o.role}, ${fmtSize(o.size)})`, `  sha256 \`${o.sha256}\``);
      if (o.url) L.push(`  from ${o.url}`);
    }
    L.push('');
  }
  L.push('## Contents', '', '| File | What | Size |', '|---|---|---|');
  for (const f of m.files) L.push(`| \`${f.path}\` | ${ROLE_NAMES[f.role] || f.role} | ${fmtSize(f.size)} |`);
  L.push('');
  if (m.notes && m.notes.length) {
    L.push('## Notes', '');
    for (const n of m.notes) L.push(`- ${n}`);
    L.push('');
  }
  return L.join('\n');
}

/**
 * Write the kit. p: a plan(). options: omit (Set of kit paths to leave out),
 * urls ({ kitPath: download location }), vpStudio (version), qboxUsed
 * ({ commit, dirty }), onProgress({ phase, done, total }), signal, level (gzip).
 * Resolves the manifest. Throws when p.missing is not empty, unless allowMissing.
 */
async function exportKit(p, outFile, options = {}) {
  if (p.missing.length && !options.allowMissing) {
    throw new Error(`files not found: ${p.missing.map((m) => m.ref).join(', ')}`);
  }
  const omit = options.omit || new Set();
  const urls = options.urls || {};
  const progress = options.onProgress || (() => {});
  const top = `${p.name}-kit`;
  const included = p.files.filter((f) => !omit.has(f.path));
  const omitted = [];
  for (const f of p.files.filter((x) => omit.has(x.path))) {
    if (options.signal && options.signal.aborted) throw new Error('cancelled');
    const sha256 = await sha256File(f.source, (done) => progress({ phase: `checksum of ${path.basename(f.source)}`, done, total: f.size }));
    omitted.push({ path: f.path, role: f.role, size: f.size, sha256, url: urls[f.path] || undefined });
  }
  const platformText = rewriteText(fs.readFileSync(p.platformSource, 'utf8'), p.rewrites);
  const manifest = {
    kit: KIT_VERSION,
    name: p.name,
    description: p.description || undefined,
    created: new Date().toISOString(),
    vpStudio: options.vpStudio,
    platform: p.platformPath,
    qbox: p.pin ? {
      repository: p.pin.qbox && p.pin.qbox.repository,
      commit: p.pin.qbox && p.pin.qbox.commit,
      patches: (p.pin.qbox && p.pin.qbox.patches) || [],
      pin: 'qbox/qbox.pin.json',
      used: options.qboxUsed || undefined,
    } : undefined,
    bundled: p.bundled,
    models: p.models.map((m) => ({ name: m.name, path: m.path, spec: m.spec })),
    files: [{ path: p.platformPath, role: 'platform', size: Buffer.byteLength(platformText) }]
      .concat(included.map((f) => ({ path: f.path, role: f.role, size: f.size }))),
    omitted,
    rewritten: p.rewrites.length ? p.rewrites : undefined,
    notes: p.notes.length ? p.notes : undefined,
  };
  const entries = [
    { path: `${top}/${MANIFEST}`, data: JSON.stringify(manifest, null, 2) + '\n' },
    { path: `${top}/README.md`, data: readme(manifest) },
    { path: `${top}/${p.platformPath}`, data: platformText },
    ...included.map((f) => ({ path: `${top}/${f.path}`, file: f.source, mode: f.source.endsWith('.sh') ? 0o755 : 0o644 })),
  ];
  const total = entries.reduce((a, e) => a + (e.file ? fs.statSync(e.file).size : 0), 0);
  const level = options.level !== undefined ? options.level : total > 512 * (1 << 20) ? 1 : 6;
  // SHA256SUMS goes last, with the checksums taken while the files were written.
  entries.push({ path: `${top}/${SUMS}`, data: (written) => written.map((f) => `${f.sha256}  ${f.path.slice(top.length + 1)}`).join('\n') + '\n' });
  const res = await tar.write(outFile, entries, {
    level, signal: options.signal,
    onProgress: (done, t) => progress({ phase: 'writing', done, total: t }),
  });
  manifest.archive = { file: outFile, size: fs.statSync(outFile).size, files: res.files.length };
  return manifest;
}

/** Parse "<sha256>  <path>" lines. */
function parseSums(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/** The manifest of a kit archive, without unpacking it. */
async function readManifest(archive) {
  let found;
  const chunks = [];
  const { Writable } = require('stream');
  const reading = tar.read(archive, (e) => {
    if (found !== undefined) return tar.STOP;
    if (e.type !== 'file' || !/^[^/]+\/kit\.json$/.test(e.path)) {
      if (e.type === 'file') throw new Error(`${path.basename(archive)} is not a VP Studio kit (it does not start with ${MANIFEST})`);
      return undefined;
    }
    return new Writable({ write(c, enc, cb) { chunks.push(Buffer.from(c)); cb(); }, final(cb) { found = e.path.split('/')[0]; cb(); } });
  });
  try {
    await reading;
  } catch (e) {
    if (/not a VP Studio kit/.test(e.message)) throw e;
    throw new Error(`${path.basename(archive)} is not a VP Studio kit: ${/incorrect header|unexpected end|not a tar/.test(e.message) ? 'not a .tar.gz archive' : e.message}`);
  }
  if (found === undefined) throw new Error(`${path.basename(archive)} is not a VP Studio kit (no ${MANIFEST})`);
  const m = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (m.kit !== KIT_VERSION) throw new Error(`kit format ${m.kit} is not supported by this VP Studio (it reads format ${KIT_VERSION})`);
  return { manifest: m, top: found };
}

/**
 * Unpack a kit into destDir/<name>-kit and check it. Refuses a folder that
 * exists and is not empty, unless overwrite. Resolves { dir, manifest,
 * platform (absolute), bad: [path] (checksum or size wrong), extra: [path] }.
 */
async function importKit(archive, destDir, options = {}) {
  const { manifest, top } = await readManifest(archive);
  const dir = path.join(path.resolve(destDir), top);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length && !options.overwrite) {
    const e = new Error(`${dir} already exists and is not empty`);
    e.code = 'EEXIST';
    throw e;
  }
  const got = await tar.read(archive, (e) => {
    const rel = tar.cleanPath(e.path);
    if (rel.split('/')[0] !== top) throw new Error(`unexpected entry outside the kit folder: ${e.path}`);
    const target = path.join(path.resolve(destDir), ...rel.split('/'));
    if (!isInside(path.resolve(destDir), target)) throw new Error(`unsafe path in archive: ${e.path}`);
    if (e.type === 'dir') { fs.mkdirSync(target, { recursive: true }); return undefined; }
    if (e.type !== 'file') return undefined;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return fs.createWriteStream(target);
  }, { onProgress: options.onProgress && ((done, total) => options.onProgress({ phase: 'unpacking', done, total })) });
  const sumsFile = path.join(dir, SUMS);
  const sums = fs.existsSync(sumsFile) ? parseSums(fs.readFileSync(sumsFile, 'utf8')) : new Map();
  const bad = [];
  const seen = new Set();
  for (const f of got) {
    if (f.type !== 'file') continue;
    const rel = f.path.slice(top.length + 1);
    seen.add(rel);
    if (rel === SUMS) continue;
    if (sums.has(rel) && sums.get(rel) !== f.sha256) bad.push(rel);
  }
  for (const f of manifest.files || []) {
    if (!seen.has(f.path)) bad.push(f.path);
    else if (f.size !== undefined && fs.statSync(path.join(dir, f.path)).size !== f.size) bad.push(f.path);
  }
  const extra = [...seen].filter((r) => r !== MANIFEST && r !== 'README.md' && r !== SUMS && !(manifest.files || []).some((f) => f.path === r));
  return { dir, manifest, platform: path.join(dir, ...manifest.platform.split('/')), bad: [...new Set(bad)], extra };
}

/**
 * The left-out files of an unpacked kit: [{ path, file, size, sha256, url,
 * state: 'missing'|'size'|'present' }]. 'size' means a file is there with the
 * wrong size. Checksums are not computed here (see checkOmitted).
 */
function omittedReport(dir, manifest) {
  return (manifest.omitted || []).map((o) => {
    const file = path.join(dir, ...o.path.split('/'));
    let st = null;
    try { st = fs.statSync(file); } catch (e) { /* missing */ }
    return Object.assign({}, o, { file, state: !st ? 'missing' : st.size !== o.size ? 'size' : 'present' });
  });
}

/** Whether a file has the checksum a left-out entry gives. */
async function checkOmitted(entry, file, onProgress) {
  return (await sha256File(file, onProgress)) === entry.sha256;
}

/** The unpacked kit a file is in (the folder with kit.json above it), or undefined. */
function findKitRoot(file) {
  let d = path.dirname(path.resolve(file));
  for (;;) {
    if (fs.existsSync(path.join(d, MANIFEST)) && fs.existsSync(path.join(d, SUMS))) return d;
    const up = path.dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

/** Files at least `bytes` large, for leaving them out by default. */
const largeFiles = (p, bytes = 1 << 30) => p.files.filter((f) => f.size >= bytes).map((f) => f.path);

/**
 * The file name to write a kit to, from what a save dialog returned. A dialog
 * may append the filter's extension to a name that already has it
 * (VS Code's own dialog writes "x.tar.gz.tar.gz": the extension of "x.tar.gz"
 * is ".gz", not the filter's "tar.gz"); a name without an extension gets one.
 */
function kitFileName(file) {
  const m = /^(.*?)((?:\.tar\.gz|\.tgz|\.gz)+)$/i.exec(file);
  if (!m) return file + '.tar.gz';
  const first = /^\.tgz/i.test(m[2]) ? '.tgz' : /^\.tar\.gz/i.test(m[2]) ? '.tar.gz' : '.tar.gz';
  return m[1] + first;
}

module.exports = {
  KIT_VERSION, MANIFEST, SUMS, ROLE_NAMES,
  references, tokensOf, expandVars, plan, rewriteText, readme, exportKit, readManifest, importKit,
  omittedReport, checkOmitted, sha256File, parseSums, findKitRoot, largeFiles, fmtSize, kitFileName,
};
