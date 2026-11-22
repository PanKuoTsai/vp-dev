'use strict';
// Models made with the modeling wizard, on disk: writing the generated files,
// finding a built model's catalog entry, and merging those entries into the
// QBox component catalog so platforms can use the model like any QBox
// module. No VS Code dependency.

const fs = require('fs');
const path = require('path');
const modelgen = require('./modelgen');

/**
 * Write the files for the model described in specFile (its folder is the
 * model folder). Files marked "once" are kept when they exist.
 * Returns { written: [rel], kept: [rel] }.
 */
function writeFiles(specFile, spec) {
  const dir = path.dirname(specFile);
  const written = [];
  const kept = [];
  for (const f of modelgen.files(spec)) {
    const target = path.join(dir, f.path);
    if (f.once && fs.existsSync(target)) { kept.push(f.path); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Leave an unchanged file alone, so builds do not redo work for nothing.
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === f.text) { kept.push(f.path); continue; }
    fs.writeFileSync(target, f.text, 'utf8');
    written.push(f.path);
  }
  return { written, kept };
}

/** Where tools/model-build puts a model's catalog entry. */
const catalogFileFor = (specFile, name) => path.join(path.dirname(specFile), 'build', `${name}.catalog.json`);

/**
 * The catalog entries of a built model, with the library as an absolute
 * path and the model folder recorded: { modules } or null when not built.
 */
function loadModelCatalog(file, opts = {}) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  const buildDir = path.dirname(file);
  const modules = {};
  for (const [type, m] of Object.entries(data.modules || {})) {
    modules[type] = Object.assign({}, m, {
      library: path.join(buildDir, m.library || `${type}.so`),
      model: { dir: path.dirname(buildDir), catalog: file, bundled: !!opts.bundled },
    });
  }
  return { modules, qbox: data.qbox };
}

/**
 * The QBox catalog with model entries added: { catalog, clashes: [type] }.
 * A model with the name of a QBox type is left out (QBox would load its own).
 * unbuilt: [{ type, hint }] for module libraries that come with VP Studio but
 * have not been built yet; they are listed so the check can say how to build them.
 */
function merge(base, models, unbuilt = []) {
  if (!base) return { catalog: base, clashes: [] };
  const modules = Object.assign({}, base.modules);
  const clashes = [];
  for (const m of models) {
    if (!m) continue;
    for (const [type, info] of Object.entries(m.modules)) {
      if (base.modules && base.modules[type]) { clashes.push(type); continue; }
      modules[type] = info;
    }
  }
  for (const u of unbuilt) if (!modules[u.type]) modules[u.type] = { unbuilt: u.hint };
  return { catalog: Object.assign({}, base, { modules }), clashes };
}

/**
 * The "dylib" a platform writes for a model type: ${TOP}-relative (so the
 * platform and the model can move together, in a shared repository), or null
 * when the library is not near the platform. Then the platform does not name
 * the library at all and the extension supplies it when it generates the Lua
 * (libraries()), so no machine-specific path ends up in the platform file.
 */
function dylibFor(info, topDir) {
  if (!topDir || (info.model && info.model.bundled)) return null;
  const lib = String(info.library).replace(/\.so$/, '');
  const rel = path.relative(topDir, lib);
  if (path.isAbsolute(rel) || rel.split(path.sep).filter((p) => p === '..').length > 3) return null;
  return '${TOP}' + rel.split(path.sep).join('/');
}

/**
 * Libraries of the types built outside QBox, for core.generate's
 * options.libraries: { type: library path without .so }.
 */
function libraries(catalog) {
  const out = {};
  for (const [type, m] of Object.entries((catalog && catalog.modules) || {})) {
    if (m && m.model && m.library) out[type] = String(m.library).replace(/\.so$/, '');
  }
  return out;
}

module.exports = { writeFiles, catalogFileFor, loadModelCatalog, merge, dylibFor, libraries };
