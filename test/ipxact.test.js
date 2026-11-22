'use strict';
// Run with: node test/ipxact.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

test('xml: elements, attributes, entities, CDATA, comments and errors', () => {
  const xml = require('../lib/xml');
  const r = xml.parse('﻿<?xml version="1.0"?>\n<!DOCTYPE a>\n<a:root xmlns:a="u" k=\'v &amp; w\'><!-- c --><b x="1"/>t&lt;<![CDATA[<raw>]]>&#x41;&#66;<c>  in  </c></a:root>');
  assert.strictEqual(xml.localName(r.name), 'root');
  assert.strictEqual(xml.attr(r, 'k'), 'v & w');
  assert.strictEqual(xml.kids(r).length, 2);
  assert.strictEqual(xml.attr(xml.kid(r, 'b'), 'x'), '1');
  assert.strictEqual(xml.childText(r, 'c'), 'in');
  assert.strictEqual(xml.textOf(r), 't<<raw>AB  in');
  assert.throws(() => xml.parse('<a><b></a>'), /does not match <b> \(line 1/);
  assert.throws(() => xml.parse('<a>\n<b>'), /<b> is not closed \(line 2/);
  assert.throws(() => xml.parse('<a x="1" x="2"/>'), /Duplicate attribute/);
  assert.throws(() => xml.parse('<a>&nbsp;</a>'), /Unknown entity/);
  assert.throws(() => xml.parse('<!DOCTYPE a [<!ENTITY e "x">]><a/>'), /internal subset/);
  assert.throws(() => xml.parse('<a/><b/>'), /More than one root/);
});

test('ipxact: numbers and expressions', () => {
  const ip = require('../lib/ipxact');
  const cases = { '42': 42n, '0x2A': 42n, "'h2A": 42n, "8'h2a": 42n, "'b101": 5n, "'d42": 42n, "'o52": 42n, '#2A': 42n, '4K': 4096n, '1M': 1n << 20n, "32'hFFFF_FFFF": 0xffffffffn };
  for (const [s, v] of Object.entries(cases)) assert.strictEqual(ip.literal(s), v, s);
  assert.strictEqual(ip.literal("4'bx01"), undefined);
  const P = { W: 32n, N: 3n };
  const ev = (s) => ip.evaluate(s, (n) => P[n]);
  assert.strictEqual(ev('W / 8 * N'), 12n);
  assert.strictEqual(ev('(1 << N) - 1'), 7n);
  assert.strictEqual(ev("'h100 + W*2"), 0x140n);
  assert.strictEqual(ev('N > 2 ? 16 : 8'), 16n);
  assert.strictEqual(ev('$clog2(W)'), 5n);
  assert.strictEqual(ev('2 ** 4 - -1'), 17n);
  assert.strictEqual(ev('~0 & 255'), 255n);
  assert.throws(() => ev('X + 1'), /unknown parameter X/);
  assert.throws(() => ev('4 /'), /incomplete/);
  assert.throws(() => ev('4 / 0'), /division by zero/);
  assert.strictEqual(ip.identOf('3rd reg'), 'r_3rd_reg');
  assert.strictEqual(ip.identOf('class'), 'class_');
  assert.strictEqual(ip.identOf('Rx-FIFO'), 'Rx_FIFO');
});

test('ipxact: the 2014 example becomes a model the wizard accepts', () => {
  const ip = require('../lib/ipxact');
  const modelgen = require('../lib/modelgen');
  const doc = ip.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'ipxact', 'simple_timer.xml'), 'utf8'));
  assert.strictEqual(doc.standard, 'IEEE 1685-2014');
  assert.strictEqual(doc.vlnv.name, 'simple_timer');
  assert.strictEqual(doc.blocks.length, 1);
  const b = doc.blocks[0];
  assert.strictEqual(b.key, 'regs.timer');
  assert.strictEqual(b.range, 0x1000n); // REG_SPACE = 'h40 * 4 * 16
  assert.deepStrictEqual(b.notes, []);
  const by = Object.fromEntries(b.registers.map((r) => [r.name, r]));
  assert.deepStrictEqual(b.registers.map((r) => r.name), ['CTRL', 'STATUS', 'CH_0_LOAD', 'CH_0_VALUE', 'CH_1_LOAD', 'CH_1_VALUE', 'ID']);
  assert.strictEqual(by.CTRL.reset, 0x30n); // field resets combined
  assert.strictEqual(by.STATUS.access, 'w1c');
  assert.deepStrictEqual(by.STATUS.fields.map((f) => [f.msb, f.lsb]), [[1, 0]]); // bitWidth = NUM_TIMERS
  assert.strictEqual(by.CH_1_VALUE.offset, 0x24n);
  assert.strictEqual(by.CH_1_VALUE.access, 'ro');
  assert.strictEqual(by.ID.offset, 0xffcn);
  assert.strictEqual(by.STATUS.description, 'Interrupt status & flags');
  const { spec, problems } = ip.toModel(doc, b);
  assert.deepStrictEqual(problems, []);
  assert.strictEqual(spec.name, 'simple_timer');
  assert.strictEqual(spec.regionSize, '0x1000');
  assert.deepStrictEqual(spec.registers[0], { name: 'CTRL', offset: '0x0', size: 4, access: 'rw', reset: '0x30', description: 'Control', fields: [{ name: 'ENABLE', bits: '0' }, { name: 'PRESCALE', bits: '7:4', description: 'Clock divider = 2^PRESCALE' }] });
  // The generated C++ includes every register.
  const files = modelgen.files(spec);
  const regs = files.find((f) => f.path.endsWith('_regs.h')).text;
  for (const r of spec.registers) assert.ok(regs.includes(r.name), r.name);
  // Updating an existing model keeps its parameters and ports.
  const existing = modelgen.template('simple_timer');
  const up = ip.toModel(doc, b, { existing }).spec;
  assert.deepStrictEqual(up.params, existing.params);
  assert.deepStrictEqual(up.outputs, existing.outputs);
  assert.strictEqual(up.registers.length, 7);
  // As a register description it expands as the shipped ones do.
  const registers = require('../lib/registers');
  const desc = ip.toDescription(doc, b, { types: ['simple_timer'] });
  assert.strictEqual(registers.expand(desc).length, 7);
});

test('ipxact: 2009 register resets, dim arrays, mixed access and skipped parts', () => {
  const ip = require('../lib/ipxact');
  const x = `<spirit:component xmlns:spirit="http://www.spiritconsortium.org/XMLSchema/SPIRIT/1685-2009">
    <spirit:vendor>v</spirit:vendor><spirit:library>l</spirit:library><spirit:name>uart</spirit:name><spirit:version>1</spirit:version>
    <spirit:memoryMaps><spirit:memoryMap><spirit:name>mm</spirit:name>
      <spirit:bank spirit:bankAlignment="serial"><spirit:name>b0</spirit:name></spirit:bank>
      <spirit:addressBlock><spirit:name>regs</spirit:name><spirit:baseAddress>0x1000</spirit:baseAddress><spirit:range>4K</spirit:range><spirit:width>32</spirit:width>
        <spirit:register><spirit:name>DATA</spirit:name><spirit:dim>4</spirit:dim><spirit:addressOffset>0x0</spirit:addressOffset><spirit:size>8</spirit:size>
          <spirit:reset><spirit:value>0xA5</spirit:value></spirit:reset>
          <spirit:field><spirit:name>D</spirit:name><spirit:bitOffset>0</spirit:bitOffset><spirit:bitWidth>8</spirit:bitWidth><spirit:readAction>clear</spirit:readAction></spirit:field></spirit:register>
        <spirit:register><spirit:name>SR</spirit:name><spirit:addressOffset>0x8</spirit:addressOffset><spirit:size>32</spirit:size>
          <spirit:field><spirit:name>BUSY</spirit:name><spirit:bitOffset>0</spirit:bitOffset><spirit:bitWidth>1</spirit:bitWidth><spirit:access>read-only</spirit:access></spirit:field>
          <spirit:field><spirit:name>EN</spirit:name><spirit:bitOffset>1</spirit:bitOffset><spirit:bitWidth>1</spirit:bitWidth><spirit:access>read-write</spirit:access></spirit:field>
          <spirit:field><spirit:name>BAD</spirit:name><spirit:bitOffset>31</spirit:bitOffset><spirit:bitWidth>2</spirit:bitWidth></spirit:field></spirit:register>
        <spirit:register><spirit:name>ODD</spirit:name><spirit:addressOffset>0xc</spirit:addressOffset><spirit:size>24</spirit:size></spirit:register>
        <spirit:register><spirit:name>WO</spirit:name><spirit:addressOffset>0x10</spirit:addressOffset><spirit:size>16</spirit:size><spirit:access>write-only</spirit:access></spirit:register>
      </spirit:addressBlock></spirit:memoryMap></spirit:memoryMaps></spirit:component>`;
  const doc = ip.parse(x);
  assert.strictEqual(doc.standard, 'IEEE 1685-2009');
  assert.match(doc.notes.join('\n'), /bank b0 is not read/);
  const b = doc.blocks[0];
  assert.strictEqual(b.baseAddress, 0x1000n);
  assert.strictEqual(b.range, 4096n);
  assert.deepStrictEqual(b.registers.map((r) => [r.name, Number(r.offset), r.size, r.access]),
    [['DATA_0', 0, 1, 'rw'], ['DATA_1', 1, 1, 'rw'], ['DATA_2', 2, 1, 'rw'], ['DATA_3', 3, 1, 'rw'], ['SR', 8, 4, 'rw'], ['WO', 16, 2, 'wo']]);
  assert.strictEqual(b.registers[0].reset, 0xa5n);
  assert.strictEqual(b.registers[0].readSideEffect, true);
  const notes = b.notes.join('\n');
  assert.match(notes, /SR\.BAD: bits 32:31 are outside/);
  assert.match(notes, /SR: fields of different access \(ro, rw\)/);
  assert.match(notes, /ODD: 24-bit registers are not supported/);
  const { spec, problems } = ip.toModel(doc, b);
  assert.deepStrictEqual(problems.filter((p) => p.severity === 'error'), []);
  assert.match(spec.registers[0].description, /read hook/);
  assert.strictEqual(ip.toDescription(doc, b, { types: ['uart'] }).registers[0].readSideEffect, true);
  assert.throws(() => ip.parse('<design/>'), /a design/);
  assert.throws(() => ip.parse('<component><memoryMaps>'), /not closed/);
});
