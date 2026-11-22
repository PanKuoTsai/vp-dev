'use strict';
// Modeling wizard: a peripheral described in <name>.model.json (registers,
// parameters, signal ports) becomes the C++ of a QBox module.
//   include/<name>_regs.h   generated every time: sockets, parameters, register
//                           storage, address decoding, access types, hooks
//   include/<name>.h        written once: the class you add behaviour to
//   src/<name>.cc           written once: registers the module type with QBox
//   test/<name>_selftest.cc generated every time: checks the generated decoding
//   CMakeLists.txt          written once: for building inside a QBox tree
// No VS Code dependency.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEXNUM = /^(0x[0-9A-Fa-f]+|\d+)$/;
const ACCESS = ['rw', 'ro', 'wo', 'w1c'];
const SIZES = [1, 2, 4, 8];
const PARAM_TYPES = { bool: 'bool', int32_t: 'int32_t', uint32_t: 'uint32_t', int64_t: 'int64_t', uint64_t: 'uint64_t', double: 'double', string: 'std::string' };
// Names a register, parameter or port cannot take: C++ keywords and names the generated class uses.
const RESERVED = new Set(('alignas alignof and asm auto bool break case catch char class const constexpr continue default delete do double else enum explicit ' +
  'export extern false float for friend goto if inline int long mutable namespace new noexcept not nullptr operator or private protected public ' +
  'register return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void ' +
  'volatile while xor target_socket access b_transport transport_dbg reset_registers name kind basename').split(' '));

const uintT = (size) => `uint${size * 8}_t`;
const big = (v) => (typeof v === 'number' ? BigInt(v) : BigInt(String(v)));
const hex = (n) => '0x' + n.toString(16);

/** Parse "7:4" or "3" into { msb, lsb }, or null. */
function bitsOf(s) {
  const m = /^\s*(\d+)\s*(?::\s*(\d+)\s*)?$/.exec(String(s));
  if (!m) return null;
  const msb = Number(m[1]);
  const lsb = m[2] === undefined ? msb : Number(m[2]);
  return msb >= lsb ? { msb, lsb } : null;
}

/**
 * Check a model description. Returns { problems: [{severity, message, path}], model }
 * where model has numbers resolved (BigInt offsets, sizes, reset values) for generation.
 */
function check(spec) {
  const problems = [];
  const add = (severity, message, path = '') => problems.push({ severity, message, path });
  if (!spec || typeof spec !== 'object') { add('error', 'The model description must be a JSON object.'); return { problems }; }
  if (spec.modelVersion !== 1) add('error', 'modelVersion must be 1.', 'modelVersion');
  if (!IDENT.test(spec.name || '')) add('error', 'name must be a C++ identifier (letters, digits, _), used as the module type and class name.', 'name');
  else if (RESERVED.has(spec.name)) add('error', `${spec.name} cannot be used as a name.`, 'name');
  let region = 0x1000n;
  if (spec.regionSize !== undefined) {
    if (!HEXNUM.test(String(spec.regionSize)) || big(spec.regionSize) === 0n) add('error', 'regionSize must be a positive number, e.g. "0x1000".', 'regionSize');
    else region = big(spec.regionSize);
  }
  if (spec.unmapped !== undefined && !['ignore', 'error'].includes(spec.unmapped)) add('error', 'unmapped must be "ignore" or "error".', 'unmapped');

  const names = new Map(); // every C++ member name -> where it was defined
  const claim = (n, where) => {
    if (!IDENT.test(n || '')) { add('error', `${where}: "${n}" is not a C++ identifier.`, where); return false; }
    if (RESERVED.has(n)) { add('error', `${where}: "${n}" is reserved.`, where); return false; }
    if (names.has(n)) { add('error', `${where}: "${n}" is already used by ${names.get(n)}.`, where); return false; }
    names.set(n, where);
    return true;
  };

  const registers = [];
  (spec.registers || []).forEach((r, k) => {
    const where = `registers[${k}]`;
    if (!r || typeof r !== 'object') { add('error', `${where} must be an object.`, where); return; }
    claim(r.name, `${where}.name`);
    const size = r.size === undefined ? 4 : r.size;
    if (!SIZES.includes(size)) add('error', `${r.name}: size must be 1, 2, 4 or 8 bytes.`, `${where}.size`);
    if (!HEXNUM.test(String(r.offset))) { add('error', `${r.name}: offset must be a number, e.g. "0x10".`, `${where}.offset`); return; }
    const offset = big(r.offset);
    const access = r.access === undefined ? 'rw' : r.access;
    if (!ACCESS.includes(access)) add('error', `${r.name}: access must be one of ${ACCESS.join(', ')}.`, `${where}.access`);
    let reset = 0n;
    if (r.reset !== undefined) {
      if (!HEXNUM.test(String(r.reset))) add('error', `${r.name}: reset must be a number.`, `${where}.reset`);
      else reset = big(r.reset);
    }
    if (SIZES.includes(size) && reset >= (1n << BigInt(size * 8))) add('error', `${r.name}: reset value ${hex(reset)} does not fit in ${size} bytes.`, `${where}.reset`);
    if (SIZES.includes(size) && offset % BigInt(size) !== 0n) add('warning', `${r.name}: offset ${hex(offset)} is not aligned to its size (${size}).`, `${where}.offset`);
    if (offset + BigInt(size) > region) add('error', `${r.name}: ends at ${hex(offset + BigInt(size))}, beyond regionSize ${hex(region)}.`, `${where}.offset`);
    const fields = [];
    let used = 0n;
    (r.fields || []).forEach((f, j) => {
      const fw = `${where}.fields[${j}]`;
      if (!IDENT.test(f.name || '')) { add('error', `${fw}: "${f.name}" is not a C++ identifier.`, fw); return; }
      const b = bitsOf(f.bits);
      if (!b) { add('error', `${r.name}.${f.name}: bits must be "msb:lsb" or one bit number, e.g. "7:4".`, `${fw}.bits`); return; }
      if (b.msb >= size * 8) { add('error', `${r.name}.${f.name}: bit ${b.msb} is beyond a ${size}-byte register.`, `${fw}.bits`); return; }
      const mask = ((1n << BigInt(b.msb - b.lsb + 1)) - 1n) << BigInt(b.lsb);
      if (used & mask) add('error', `${r.name}.${f.name}: overlaps another field.`, `${fw}.bits`);
      used |= mask;
      if (fields.some((x) => x.name === f.name)) add('error', `${r.name}.${f.name}: duplicate field name.`, fw);
      fields.push({ name: f.name, lsb: b.lsb, width: b.msb - b.lsb + 1, mask, description: f.description || '' });
    });
    registers.push({ name: r.name, offset, size, access, reset, description: r.description || '', fields });
  });
  const sorted = registers.slice().sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (a.offset + BigInt(a.size) > b.offset) add('error', `${a.name} and ${b.name} overlap.`, 'registers');
  }

  const params = [];
  (spec.params || []).forEach((p, k) => {
    const where = `params[${k}]`;
    if (!claim(p.name, `${where}.name`)) return;
    if (!PARAM_TYPES[p.type]) { add('error', `${p.name}: type must be one of ${Object.keys(PARAM_TYPES).join(', ')}.`, `${where}.type`); return; }
    let def = p.default;
    const kind = p.type === 'bool' ? 'boolean' : p.type === 'string' ? 'string' : 'number';
    if (def === undefined) def = kind === 'boolean' ? false : kind === 'string' ? '' : 0;
    if (kind === 'number' && typeof def === 'string' && HEXNUM.test(def)) def = Number(big(def));
    if (typeof def !== kind) add('error', `${p.name}: default must be a ${kind}.`, `${where}.default`);
    if (kind === 'number' && p.type !== 'double' && !Number.isInteger(def)) add('error', `${p.name}: default must be a whole number.`, `${where}.default`);
    if (kind === 'number' && p.type.startsWith('uint') && def < 0) add('error', `${p.name}: default cannot be negative.`, `${where}.default`);
    params.push({ name: p.name, type: p.type, cpp: PARAM_TYPES[p.type], default: def, description: p.description || '' });
  });
  const outputs = [];
  (spec.outputs || []).forEach((o, k) => { if (claim(o.name, `outputs[${k}].name`)) outputs.push({ name: o.name, description: o.description || '' }); });
  const inputs = [];
  (spec.inputs || []).forEach((o, k) => { if (claim(o.name, `inputs[${k}].name`)) inputs.push({ name: o.name, description: o.description || '' }); });
  if (!registers.length) add('warning', 'The model has no registers; every access will be unmapped.', 'registers');
  return {
    problems,
    model: { name: spec.name, description: spec.description || '', region, unmapped: spec.unmapped || 'ignore', registers: sorted, params, outputs, inputs },
  };
}

// ------------------------------------------------------------------ C++

const cstr = (s) => JSON.stringify(String(s)); // a JSON string is a valid C++ string literal for these texts
const comment = (s) => String(s).replace(/\*\//g, '* /').replace(/\n/g, ' ');

function paramInit(p) {
  if (p.type === 'string') return `${cstr(p.default)}`;
  if (p.type === 'bool') return p.default ? 'true' : 'false';
  if (p.type === 'double') return Number.isInteger(p.default) ? `${p.default}.0` : String(p.default);
  return `${p.default}${p.type.startsWith('uint') ? 'u' : ''}${p.type.endsWith('64_t') ? 'll' : ''}`;
}

const HEADER = (name, what) => `// Generated by VP Studio from ${name}.model.json${what}`;

/** include/<name>_regs.h: everything that follows from the description. */
function regsHeader(m) {
  const C = `${m.name}_regs`;
  const L = [];
  L.push(HEADER(m.name, '. Do not edit: run "VP Studio: Generate Model Code"'),
    `// after changing the description. Add behaviour in ${m.name}.h instead.`, '');
  L.push('#pragma once', '');
  for (const h of ['cstdint', 'cstring', 'string', 'systemc', 'tlm', 'tlm_utils/simple_target_socket.h', 'cci_configuration',
    'scp/report.h', 'ports/initiator-signal-socket.h', 'ports/target-signal-socket.h', 'module_factory_registery.h', 'tlm_sockets_buswidth.h']) {
    L.push(`#include <${h}>`);
  }
  L.push('');
  if (m.description) L.push(`/** ${comment(m.description)} */`);
  L.push(`class ${C} : public sc_core::sc_module`, '{', 'public:', '    SCP_LOGGER();', '');
  L.push(`    tlm_utils::simple_target_socket<${C}, DEFAULT_TLM_BUSWIDTH> target_socket;`);
  for (const o of m.outputs) L.push(`    InitiatorSignalSocket<bool> ${o.name};${o.description ? ' // ' + comment(o.description) : ''}`);
  for (const i of m.inputs) L.push(`    TargetSignalSocket<bool> ${i.name};${i.description ? ' // ' + comment(i.description) : ''}`);
  for (const p of m.params) L.push(`    cci::cci_param<${p.cpp}> p_${p.name};${p.description ? ' // ' + comment(p.description) : ''}`);
  L.push('', '    // Register map.', `    static constexpr uint64_t REGION_SIZE = ${hex(m.region)};`);
  for (const r of m.registers) {
    L.push(`    static constexpr uint64_t ${r.name}_OFFSET = ${hex(r.offset)};${r.description ? ' // ' + comment(r.description) : ''}`);
    for (const f of r.fields) {
      L.push(`    static constexpr ${uintT(r.size)} ${r.name}_${f.name}_SHIFT = ${f.lsb};`,
        `    static constexpr ${uintT(r.size)} ${r.name}_${f.name}_MASK = ${hex(f.mask)}${r.size === 8 ? 'ull' : 'u'};${f.description ? ' // ' + comment(f.description) : ''}`);
    }
  }
  L.push('', `    explicit ${C}(sc_core::sc_module_name name)`);
  const init = ['target_socket("target_socket")']
    .concat(m.outputs.map((o) => `${o.name}("${o.name}")`), m.inputs.map((i) => `${i.name}("${i.name}")`),
      m.params.map((p) => `p_${p.name}("${p.name}", ${paramInit(p)}, ${cstr(p.description)})`));
  L.push(`        : ${init.join('\n        , ')}`, '    {');
  L.push(`        target_socket.register_b_transport(this, &${C}::b_transport);`,
    `        target_socket.register_transport_dbg(this, &${C}::transport_dbg);`);
  for (const i of m.inputs) L.push(`        ${i.name}.register_value_changed_cb([this](bool value) { on_${i.name}(value); });`);
  L.push('        reset_registers();', '    }', '');
  L.push('    /** Put every register back to its reset value. */', '    void reset_registers()', '    {');
  for (const r of m.registers) L.push(`        r_${r.name} = ${hex(r.reset)}${r.size === 8 ? 'ull' : 'u'};`);
  L.push('    }', '');
  for (const r of m.registers) L.push(`    ${uintT(r.size)} reg_${r.name}() const { return r_${r.name}; }`);
  for (const o of m.outputs) L.push(`    /** Drive ${o.name} (does nothing while it is not connected). */`, `    void set_${o.name}(bool value) { if (${o.name}.size()) ${o.name}->write(value); }`);
  L.push('', 'protected:');
  for (const r of m.registers) L.push(`    ${uintT(r.size)} r_${r.name};`);
  L.push('', '    // Hooks: override them in the derived class to add behaviour.');
  for (const r of m.registers) {
    const t = uintT(r.size);
    if (r.access !== 'wo') L.push(`    /** ${r.name} is about to be read by the bus; return the value to give. */`, `    virtual ${t} read_${r.name}(${t} value) { return value; }`);
    if (r.access !== 'ro') L.push(`    /** ${r.name} was written by the bus (after the access type was applied). */`, `    virtual void after_write_${r.name}(${t} old_value, ${t} value) {}`);
  }
  for (const i of m.inputs) {
    L.push(`    /** ${i.name} changed. */`);
    if (i.name === 'reset') L.push('    virtual void on_reset(bool value) { if (value) reset_registers(); }');
    else L.push(`    virtual void on_${i.name}(bool value) {}`);
  }
  // Access path shared by b_transport (with hooks) and transport_dbg (without).
  L.push('', 'private:', '    void b_transport(tlm::tlm_generic_payload& txn, sc_core::sc_time& delay) { access(txn, false); }',
    '    unsigned int transport_dbg(tlm::tlm_generic_payload& txn) { access(txn, true); return txn.get_data_length(); }', '');
  L.push('    template <typename T>', '    static void copy_out(T value, uint64_t reg_off, unsigned size, uint64_t addr, unsigned len, unsigned char* ptr)', '    {',
    '        // Bytes of the register inside [addr, addr + len), little endian.',
    '        for (unsigned b = 0; b < size; b++) {', '            uint64_t a = reg_off + b;',
    '            if (a >= addr && a < addr + len) ptr[a - addr] = (unsigned char)(value >> (8 * b));', '        }', '    }', '');
  L.push('    template <typename T>', '    static T merge_in(T old, uint64_t reg_off, unsigned size, uint64_t addr, unsigned len, const unsigned char* ptr, T& written)', '    {',
    '        T value = old;', '        written = 0;',
    '        for (unsigned b = 0; b < size; b++) {', '            uint64_t a = reg_off + b;',
    '            if (a >= addr && a < addr + len) {', '                T mask = (T)((T)0xff << (8 * b));',
    '                value = (T)((value & ~mask) | ((T)ptr[a - addr] << (8 * b)));', '                written = (T)(written | mask);', '            }', '        }',
    '        return value;', '    }', '');
  L.push('    void access(tlm::tlm_generic_payload& txn, bool debug)', '    {',
    '        const uint64_t addr = txn.get_address();', '        const unsigned len = txn.get_data_length();',
    '        unsigned char* ptr = txn.get_data_ptr();', '        const bool write = txn.is_write();',
    '        if (txn.get_byte_enable_ptr() || txn.get_streaming_width() < len) {',
    '            txn.set_response_status(tlm::TLM_BYTE_ENABLE_ERROR_RESPONSE);', '            return;', '        }',
    '        if (addr >= REGION_SIZE || len > REGION_SIZE - addr) {',
    '            SCP_WARN(()) << "access outside the region at 0x" << std::hex << addr;',
    '            txn.set_response_status(tlm::TLM_ADDRESS_ERROR_RESPONSE);', '            return;', '        }',
    '        // Bytes no register covers.', '        unsigned covered = 0;');
  for (const r of m.registers) {
    L.push(`        if (addr < ${r.name}_OFFSET + ${r.size} && ${r.name}_OFFSET < addr + len)`,
      `            covered += (unsigned)(std::min<uint64_t>(addr + len, ${r.name}_OFFSET + ${r.size}) - std::max<uint64_t>(addr, ${r.name}_OFFSET));`);
  }
  L.push('        if (covered < len) {');
  if (m.unmapped === 'error') {
    L.push('            SCP_WARN(()) << "unmapped access at 0x" << std::hex << addr;', '            txn.set_response_status(tlm::TLM_ADDRESS_ERROR_RESPONSE);', '            return;');
  } else {
    L.push('            SCP_DEBUG(()) << "unmapped bytes in access at 0x" << std::hex << addr << " (read as 0, writes ignored)";');
  }
  L.push('        }', '        if (!write) std::memset(ptr, 0, len);');
  for (const r of m.registers) {
    const t = uintT(r.size);
    L.push(`        if (addr < ${r.name}_OFFSET + ${r.size} && ${r.name}_OFFSET < addr + len) {`);
    L.push('            if (!write) {');
    if (r.access === 'wo') L.push(`                ${t} v = debug ? r_${r.name} : 0; // write-only: reads as 0`);
    else L.push(`                ${t} v = debug ? r_${r.name} : read_${r.name}(r_${r.name});`);
    L.push(`                copy_out<${t}>(v, ${r.name}_OFFSET, ${r.size}, addr, len, ptr);`, '            } else {');
    L.push(`                ${t} written;`, `                ${t} merged = merge_in<${t}>(r_${r.name}, ${r.name}_OFFSET, ${r.size}, addr, len, ptr, written);`);
    L.push(`                if (debug) {`, `                    r_${r.name} = merged;`, '                } else {');
    if (r.access === 'ro') {
      L.push(`                    SCP_DEBUG(()) << "write to read-only ${r.name} ignored";`);
    } else {
      L.push(`                    ${t} old = r_${r.name};`);
      if (r.access === 'w1c') L.push(`                    r_${r.name} = (${t})(old & ~(merged & written)); // write 1 to clear`);
      else L.push(`                    r_${r.name} = merged;`);
      L.push(`                    after_write_${r.name}(old, r_${r.name});`);
    }
    L.push('                }', '            }', '        }');
  }
  L.push('        txn.set_dmi_allowed(false);', '        txn.set_response_status(tlm::TLM_OK_RESPONSE);', '    }', '};', '');
  return L.join('\n');
}

/** include/<name>.h, written once. */
function userHeader(m) {
  const ex = m.registers.find((r) => r.access !== 'ro');
  const L = [
    HEADER(m.name, ' once. This file is yours: VP Studio does not'),
    `// overwrite it. The register map and decoding are in ${m.name}_regs.h.`, '',
    '#pragma once', '', `#include "${m.name}_regs.h"`, '',
    `class ${m.name} : public ${m.name}_regs`, '{', 'public:',
    `    explicit ${m.name}(sc_core::sc_module_name name): ${m.name}_regs(name) {}`, '',
    'protected:',
    '    // Override the hooks of the generated base class here. For example:',
  ];
  if (ex) {
    const t = uintT(ex.size);
    L.push(`    //`, `    // void after_write_${ex.name}(${t} old_value, ${t} value) override`, '    // {',
      `    //     SCP_INFO(()) << "${ex.name} = 0x" << std::hex << value;`);
    if (m.outputs[0]) L.push(`    //     set_${m.outputs[0].name}(value != 0);`);
    L.push('    // }');
  }
  if (m.params[0]) L.push('    //', `    // Parameters are members too: p_${m.params[0].name}.get_value()`);
  L.push('};', '', 'extern "C" void module_register();', '');
  return L.join('\n');
}

/** src/<name>.cc, written once. */
function userSource(m) {
  return [HEADER(m.name, ' once. This file is yours.'), '', '#include <systemc>', '', `#include "${m.name}.h"`, '',
    `void module_register() { GSC_MODULE_REGISTER_C(${m.name}); }`, ''].join('\n');
}

/** CMakeLists.txt for building inside a QBox tree (systemc-components/<name>), written once. */
function cmakeLists(m) {
  return [`# Generated by VP Studio once. To build inside QBox, copy this folder to`,
    `# systemc-components/${m.name} and add_subdirectory(${m.name}) there.`, `gs_create_dymod(${m.name})`, ''].join('\n');
}

/** test/<name>_selftest.cc: checks reset values, access types and decoding of the generated base class. */
function selfTest(m) {
  const C = `${m.name}_regs`;
  const L = [HEADER(m.name, '. Do not edit; it is regenerated.'),
    '// Checks the generated decoding of every register (reset value, access type,',
    `// byte access) on ${C}, without the behaviour added in ${m.name}.h.`, '',
    '#include <cstdio>', '#include <cciutils.h>', '#include <tlm_utils/simple_initiator_socket.h>', '', `#include "${m.name}_regs.h"`, '',
    'struct tester : sc_core::sc_module', '{',
    '    tlm_utils::simple_initiator_socket<tester, DEFAULT_TLM_BUSWIDTH> socket;', '    int passed = 0, failed = 0;', '',
    '    SC_HAS_PROCESS(tester);', '    tester(sc_core::sc_module_name n): socket("socket") { SC_THREAD(run); }', '',
    '    tlm::tlm_response_status go(bool write, uint64_t addr, uint64_t& v, unsigned len, bool debug = false)', '    {',
    '        unsigned char buf[8] = {};', '        if (write) for (unsigned b = 0; b < len; b++) buf[b] = (unsigned char)(v >> (8 * b));',
    '        tlm::tlm_generic_payload t;', '        t.set_command(write ? tlm::TLM_WRITE_COMMAND : tlm::TLM_READ_COMMAND);',
    '        t.set_address(addr);', '        t.set_data_ptr(buf);', '        t.set_data_length(len);', '        t.set_streaming_width(len);',
    '        t.set_response_status(tlm::TLM_INCOMPLETE_RESPONSE);', '        sc_core::sc_time d = sc_core::SC_ZERO_TIME;',
    '        if (debug) socket->transport_dbg(t); else socket->b_transport(t, d);',
    '        if (!write) { v = 0; for (unsigned b = 0; b < len; b++) v |= (uint64_t)buf[b] << (8 * b); }',
    '        return t.get_response_status();', '    }',
    '    uint64_t rd(uint64_t a, unsigned len, bool dbg = false) { uint64_t v = 0; go(false, a, v, len, dbg); return v; }',
    '    void wr(uint64_t a, uint64_t v, unsigned len, bool dbg = false) { go(true, a, v, len, dbg); }',
    '    void expect(const char* what, uint64_t got, uint64_t want)', '    {',
    '        if (got == want) { passed++; return; }', '        failed++;',
    '        std::printf("FAIL %s: got 0x%llx, expected 0x%llx\\n", what, (unsigned long long)got, (unsigned long long)want);', '    }', '',
    '    void run()', '    {'];
  for (const r of m.registers) {
    const all = (1n << BigInt(r.size * 8)) - 1n;
    const o = hex(r.offset);
    const n = r.name;
    L.push(`        // ${n} @ ${o}, ${r.size} bytes, ${r.access}`);
    L.push(`        expect("${n} reset value", rd(${o}, ${r.size}), ${r.access === 'wo' ? '0' : hex(r.reset)}ull);`);
    if (r.access === 'rw') {
      const pat = 0xa5a5a5a5a5a5a5a5n & all;
      L.push(`        wr(${o}, ${hex(pat)}ull, ${r.size});`, `        expect("${n} reads back what was written", rd(${o}, ${r.size}), ${hex(pat)}ull);`);
      if (r.size > 1) {
        L.push(`        wr(${o} + 1, 0x3c, 1);`, `        expect("${n} byte write changes one byte", rd(${o}, ${r.size}), ${hex((pat & ~0xff00n) | 0x3c00n)}ull);`,
          `        expect("${n} byte read", rd(${o} + 1, 1), 0x3cull);`);
      }
      L.push(`        wr(${o}, ${hex(r.reset)}ull, ${r.size});`);
    } else if (r.access === 'ro') {
      L.push(`        wr(${o}, ${hex(~r.reset & all)}ull, ${r.size});`, `        expect("${n} ignores writes", rd(${o}, ${r.size}), ${hex(r.reset)}ull);`);
    } else if (r.access === 'wo') {
      L.push(`        wr(${o}, ${hex(0x5an & all)}ull, ${r.size});`, `        expect("${n} reads as 0", rd(${o}, ${r.size}), 0ull);`,
        `        expect("${n} holds the written value (debug read)", rd(${o}, ${r.size}, true), ${hex(0x5an & all)}ull);`);
    } else if (r.access === 'w1c') {
      L.push(`        wr(${o}, ${hex(all)}ull, ${r.size}, true);`, `        wr(${o}, 0x1, ${r.size});`,
        `        expect("${n} write 1 clears that bit only", rd(${o}, ${r.size}), ${hex(all & ~1n)}ull);`,
        `        wr(${o}, 0x0, ${r.size});`, `        expect("${n} write 0 changes nothing", rd(${o}, ${r.size}), ${hex(all & ~1n)}ull);`,
        `        wr(${o}, ${hex(r.reset)}ull, ${r.size}, true);`);
    }
  }
  // An offset no register covers, if any.
  let gap = null;
  let at = 0n;
  for (const r of m.registers) { if (r.offset > at) { gap = at; break; } at = r.offset + BigInt(r.size); }
  if (gap === null && at < m.region) gap = at;
  if (gap !== null) {
    L.push(`        // Unmapped offset ${hex(gap)}.`, '        {', '            uint64_t v = 0;',
      `            tlm::tlm_response_status s = go(false, ${hex(gap)}, v, 1);`);
    if (m.unmapped === 'error') L.push('            expect("unmapped access is an address error", s, tlm::TLM_ADDRESS_ERROR_RESPONSE);');
    else L.push('            expect("unmapped access is accepted", s, tlm::TLM_OK_RESPONSE);', '            expect("unmapped read is 0", v, 0);');
    L.push('        }');
  }
  L.push('        {', '            uint64_t v = 0;', `            expect("access beyond the region is an address error", go(false, ${hex(m.region)}, v, 1), tlm::TLM_ADDRESS_ERROR_RESPONSE);`, '        }');
  L.push('        std::printf("%d checks passed, %d failed\\n", passed, failed);', '    }', '};', '',
    'int sc_main(int, char*[])', '{', '    gs::ConfigurableBroker broker{};',
    `    ${C} dut("dut");`, '    tester t("tester");', '    t.socket.bind(dut.target_socket);', '    sc_core::sc_start();',
    '    return t.failed || !t.passed ? 1 : 0;', '}', '');
  return L.join('\n');
}

/**
 * Files for a model: [{ path (relative to the model folder), text, once }].
 * once: written only when the file does not exist yet.
 */
function files(spec) {
  const { problems, model } = check(spec);
  const errors = problems.filter((p) => p.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.message).join('\n'));
  const n = model.name;
  return [
    { path: `include/${n}_regs.h`, text: regsHeader(model), once: false },
    { path: `test/${n}_selftest.cc`, text: selfTest(model), once: false },
    { path: `include/${n}.h`, text: userHeader(model), once: true },
    { path: `src/${n}.cc`, text: userSource(model), once: true },
    { path: 'CMakeLists.txt', text: cmakeLists(model), once: true },
  ];
}

/** A starting description: a small timer-like peripheral to edit. */
function template(name) {
  return {
    modelVersion: 1,
    name,
    description: `${name}: describe what the peripheral does.`,
    regionSize: '0x1000',
    unmapped: 'ignore',
    registers: [
      { name: 'CTRL', offset: '0x0', size: 4, access: 'rw', reset: '0x0', description: 'Control', fields: [{ name: 'ENABLE', bits: '0' }, { name: 'IRQ_EN', bits: '1' }] },
      { name: 'STATUS', offset: '0x4', size: 4, access: 'w1c', reset: '0x0', description: 'Interrupt status; write 1 to clear' },
      { name: 'ID', offset: '0xfc', size: 4, access: 'ro', reset: '0x00010001', description: 'Identification' },
    ],
    params: [{ name: 'clock_hz', type: 'uint64_t', default: 1000000, description: 'Input clock frequency in Hz' }],
    outputs: [{ name: 'irq', description: 'Interrupt request' }],
    inputs: [],
  };
}

module.exports = { check, files, template, regsHeader, selfTest, bitsOf, RESERVED };
