'use strict';
// Run with: node test/schemas.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const SCHEMAS = fs.readdirSync(path.join(root, 'schemas')).filter((f) => f.endsWith('.schema.json')).sort();
const DRAFT = 'http://json-schema.org/draft-07/schema#';

test('schemas: all are JSON Schema draft-07, and package.json names each of them', () => {
  // One draft for all four: VS Code's JSON support and every validator read draft-07, and a tool
  // that checks platforms and sweeps together needs one validator, not two.
  assert.deepStrictEqual(SCHEMAS, ['qbox-model.schema.json', 'qbox-platform.schema.json', 'qbox-registers.schema.json', 'vp-perfsweep.schema.json']);
  const later = ['$defs', 'dependentRequired', 'dependentSchemas', 'prefixItems', 'unevaluatedProperties', 'unevaluatedItems', '$anchor', '$dynamicRef', '$recursiveRef', 'minContains', 'maxContains'];
  for (const f of SCHEMAS) {
    const s = read('schemas/' + f);
    assert.strictEqual(s.$schema, DRAFT, f);
    // One form of name for all: the publisher's domain, then the file's name. A name, not an address:
    // nothing fetches it, and VS Code finds the schemas through package.json.
    assert.strictEqual(s.$id, 'https://novatek.com.tw/vp-studio/schemas/' + f, f);
    const found = [];
    (function walk(v, inProperties) {
      if (Array.isArray(v)) v.forEach((x) => walk(x, false));
      else if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) {
          if (!inProperties && later.includes(k)) found.push(k); // a document's own property may have any name
          walk(v[k], k === 'properties' || k === 'patternProperties');
        }
      }
    })(s, false);
    assert.deepStrictEqual(found, [], `${f} uses keywords of a later draft`);
    // References point at definitions that exist.
    for (const ref of JSON.stringify(s).match(/"\$ref":"#[^"]*"/g) || []) {
      let at = s;
      for (const part of ref.slice(9, -1).split('/').filter(Boolean)) at = at && at[part];
      assert.ok(at, `${f}: ${ref}`);
    }
  }
  const matched = require('../package.json').contributes.jsonValidation.map((v) => path.basename(v.url)).sort();
  assert.deepStrictEqual(matched, SCHEMAS);
});

test('schemas: the templates and the bundled register descriptions are valid', () => {
  // Needs ajv, which is a development dependency: run after npm install. CI's lint job does.
  let Ajv;
  try { Ajv = require('ajv'); } catch (e) { return; }
  const check = (schemaFile, files) => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(read('schemas/' + schemaFile));
    assert.ok(files.length, schemaFile);
    for (const f of files) assert.ok(validate(read(f)), `${f}: ${JSON.stringify(validate.errors)}`);
    return validate;
  };
  const perf = fs.readdirSync(path.join(root, 'templates', 'perf'));
  const platform = check('qbox-platform.schema.json', ['templates/ubuntu-aarch64.platform.json', ...perf.filter((f) => f.endsWith('.platform.json')).map((f) => 'templates/perf/' + f)]);
  check('vp-perfsweep.schema.json', perf.filter((f) => f.endsWith('.perfsweep.json')).map((f) => 'templates/perf/' + f));
  check('qbox-registers.schema.json', fs.readdirSync(path.join(root, 'registers')).map((f) => 'registers/' + f));
  // The model schema: what New Model starts from.
  const modelgen = require('../lib/generate/modelgen');
  const model = new Ajv({ allErrors: true, strict: false }).compile(read('schemas/qbox-model.schema.json'));
  assert.ok(model(modelgen.template('timer0')), JSON.stringify(model.errors));
  // What the platform schema must refuse: the rules that were written with dependentRequired.
  const d = read('templates/ubuntu-aarch64.platform.json');
  const port = Object.values(d.modules).map((m) => m.ports && Object.values(m.ports).find((p) => p && p.address !== undefined && p.size !== undefined)).find(Boolean);
  assert.ok(port && platform(d));
  const size = port.size;
  delete port.size;
  assert.ok(!platform(d), 'an address without a size');
  port.size = size;
  assert.ok(platform(d));
});

test('schemas: a template names its schema by a path that holds here, and loses it when it is copied', () => {
  // In templates/ the "$schema" line is a relative path, so an editor without VP Studio also finds
  // the schema. It is only right where the template is: Create Example removes it from the copy
  // (in a workspace, VP Studio gives the schema by the file's name).
  const files = ['templates/ubuntu-aarch64.platform.json', ...fs.readdirSync(path.join(root, 'templates', 'perf')).map((f) => 'templates/perf/' + f),
    ...fs.readdirSync(path.join(root, 'templates', 'tutorial', 'perf')).filter((f) => f.endsWith('.json')).map((f) => 'templates/tutorial/perf/' + f)];
  const byName = require('../package.json').contributes.jsonValidation.map((v) => [v.fileMatch.replace(/^\*/, ''), path.join(root, v.url)]);
  let named = 0;
  for (const f of files) {
    const doc = read(f);
    const expected = byName.find(([suffix]) => f.endsWith(suffix));
    assert.ok(expected, `${f}: no schema for a file of this name`);
    if (doc.$schema === undefined) continue;
    named++;
    assert.strictEqual(path.resolve(root, path.dirname(f), doc.$schema), path.resolve(expected[1]), f);
  }
  assert.ok(named >= 5);
  // Both example commands read a template, drop "$schema" and write the rest; Create Tutorial
  // Workspace reads the Ubuntu template too and lib/setup/tutorial.js drops it (from its JSON files too).
  const ui = fs.readFileSync(path.join(root, 'src', 'examplesUi.js'), 'utf8');
  assert.strictEqual((ui.match(/JSON\.parse\(await fs\.promises\.readFile\(/g) || []).length, 3);
  const tut = fs.readFileSync(path.join(root, 'lib', 'setup', 'tutorial.js'), 'utf8');
  assert.strictEqual((tut.match(/delete (d|data)\.\$schema;/g) || []).length, 2);
  assert.strictEqual((ui.match(/delete data\.\$schema;/g) || []).length, 2);
  assert.ok(!/copyFile|fs\.cp\b|cpSync/.test(ui), 'a template copied as a file would keep its "$schema"');
});
