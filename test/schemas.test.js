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
