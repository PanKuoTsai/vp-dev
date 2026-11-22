'use strict';
// Run with: node test/jsonedit.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const jsonedit = require('../lib/jsonedit');
const { examplePath } = require('./helpers');

test('jsonedit: replacing entries changes only that array', () => {
  const text = fs.readFileSync(examplePath, 'utf8');
  const entries = [{ elf_file: '${TOP}fw/app.elf' }];
  const edit = jsonedit.setProperty(text, ['modules', 'load'], 'entries', (ind) => jsonedit.renderRows(entries, ind));
  const out = jsonedit.apply(text, edit);
  const parsed = JSON.parse(out);
  assert.deepStrictEqual(parsed.modules.load.entries, entries);
  const before = JSON.parse(text);
  before.modules.load.entries = entries;
  assert.deepStrictEqual(parsed, before);
  assert.strictEqual(out.slice(0, edit.start), text.slice(0, edit.start));
  assert.ok(out.endsWith(text.slice(edit.end)));
});

test('jsonedit: adds and removes properties, including on empty objects', () => {
  const text = fs.readFileSync(examplePath, 'utf8');
  const added = jsonedit.apply(text, jsonedit.setProperty(text, [], 'debug', () => '{ "symbols": ["${TOP}vmlinux"] }'));
  assert.deepStrictEqual(JSON.parse(added).debug, { symbols: ['${TOP}vmlinux'] });
  const removed = jsonedit.apply(added, jsonedit.removeProperty(added, [], 'debug'));
  assert.deepStrictEqual(JSON.parse(removed), JSON.parse(text));
  const mgr = jsonedit.apply(text, jsonedit.setProperty(text, ['modules', 'qemu_inst_mgr'], 'entries', () => '[]'));
  assert.deepStrictEqual(JSON.parse(mgr).modules.qemu_inst_mgr, { type: 'QemuInstanceManager', entries: [] });
  const empty = '{\n  "a": {}\n}';
  assert.deepStrictEqual(JSON.parse(jsonedit.apply(empty, jsonedit.setProperty(empty, ['a'], 'k', () => '1'))), { a: { k: 1 } });
  const tricky = '{"s": "br{ace\\" ]", "n": -1.5e3, "t": [true, null, {"x": []}]}';
  assert.deepStrictEqual(JSON.parse(jsonedit.apply(tricky, jsonedit.setProperty(tricky, ['t', 2], 'x', () => '[1]'))).t[2].x, [1]);
  assert.strictEqual(JSON.parse(jsonedit.apply(tricky, jsonedit.removeProperty(tricky, [], 's'))).s, undefined);
});
