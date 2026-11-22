'use strict';
// Device tree source generated from a platform description, so the addresses
// and interrupt numbers the software sees are the ones the platform wires.
// Known QBox module types become nodes (CPUs, GICv2/v3, memory, PL011,
// PL031, virtio-mmio, the generic PCIe host); others can be described with a
// module's "devicetree" property, or are listed in the notes. No VS Code
// dependency.

const fs = require('fs');
const path = require('path');
const core = require('../platform/core');
const luaexpr = require('../platform/luaexpr');
const images = require('../platform/images');

const LEVEL_HIGH = 4;

// ------------------------------------------------------------------ values

/** Variable values for Lua expressions: integers as numbers, other values as they are. */
function luaEnv(doc, analysis) {
  const env = {};
  for (const v of doc.variables || []) {
    const n = analysis.env[v.name];
    env[v.name] = n !== null && n !== undefined ? Number(n) : v.value;
  }
  return env;
}

/** A parameter value as a JS value: integers resolved, Lua evaluated (with i), or undefined. */
function paramValue(inst, name, ctx) {
  const v = inst.params[name];
  if (v === undefined) return undefined;
  if (v && typeof v === 'object' && v.$lua !== undefined) {
    try {
      return luaexpr.evaluate(v.$lua, { ...ctx.lua, i: inst.index === null ? 0 : inst.index });
    } catch (e) {
      ctx.note('warning', `${inst.name}.${name} is the Lua expression ${v.$lua}, which the generator cannot evaluate (${e.message})`, inst.base);
      return undefined;
    }
  }
  const n = core.evalInt(v, ctx.analysis.env);
  if (n !== null) return Number(n);
  if (typeof v === 'string') {
    const m = /^\$\{(\w+)\}$/.exec(v);
    if (m && m[1] in ctx.lua) return ctx.lua[m[1]];
  }
  return v;
}

// ------------------------------------------------------------------ tree model

const node = (name, unit, label) => ({ name, unit, label, props: [], children: [] });
const cells = (...v) => ({ cells: v });
const u64 = (v) => [BigInt(v) >> 32n, BigInt(v) & 0xffffffffn];
const hexc = (v) => (typeof v === 'string' ? v : '0x' + BigInt(v).toString(16));

function renderValue(v) {
  if (v === true) return null;
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return v.map((s) => JSON.stringify(String(s))).join(', ');
  if (v.cells) return '<' + v.cells.map(hexc).join(' ') + '>';
  if (v.cellRows) return v.cellRows.map((r) => '<' + r.map(hexc).join(' ') + '>').join(',\n\t\t');
  if (v.raw) return v.raw;
  throw new Error('bad property value');
}

function renderNode(n, depth) {
  const ind = '\t'.repeat(depth);
  const head = `${n.label ? n.label + ': ' : ''}${n.name}${n.unit !== undefined ? '@' + n.unit : ''}`;
  const lines = [`${ind}${head} {`];
  for (const [k, v] of n.props) {
    const r = renderValue(v);
    lines.push(`${ind}\t${k}${r === null ? '' : ' = ' + r.replace(/\n\t\t/g, '\n' + ind + '\t\t')};`);
  }
  for (const c of n.children) {
    lines.push('');
    lines.push(renderNode(c, depth + 1));
  }
  lines.push(`${ind}};`);
  return lines.join('\n');
}

const unitOf = (addr) => BigInt(addr).toString(16);
const labelOf = (name) => name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
const regCells = (regions) => ({ cellRows: regions.map((r) => [...u64(r.address), ...u64(r.size)]) });

// ------------------------------------------------------------------ module types

const CPU = /^cpu_arm_(cortex|neoverse)([A-Z])(\d+)$/;
const cpuCompatible = (type) => {
  const m = CPU.exec(type);
  return m ? `arm,${m[1]}-${m[2].toLowerCase()}${m[3]}` : null;
};
const VIRTIO = /^virtio_mmio_/;
const UART = new Set(['Pl011', 'qemu_pl011']);

/** Bus-mapped target ports of an instance, in declaration order: [{port, address, size}]. */
function regions(inst, buses) {
  return inst.ports
    .filter((p) => p.address !== undefined && p.address !== null && p.size !== undefined && p.size !== null && buses.has(p.peer))
    .map((p) => ({ port: p.name, address: p.address, size: p.size }));
}

/**
 * Interrupts wired from an instance to an interrupt controller, as
 * { gic, kind: 'spi' | 'ppi', number, port } (SPI numbers as the controller's
 * spi_in index, PPIs as INTID - 16), whichever end declared the binding.
 */
function interruptsOf(inst, ctx) {
  const out = [];
  for (const c of ctx.analysis.connections) {
    let mine, gicName, gicPort;
    if (c.from === inst.name && ctx.gics.has(c.to)) { mine = c.fromPort; gicName = c.to; gicPort = c.toPort; }
    else if (c.to === inst.name && ctx.gics.has(c.from)) { mine = c.toPort; gicName = c.from; gicPort = c.fromPort; }
    else continue;
    let m = /^spi_in_(\d+)$/.exec(gicPort);
    if (m) { out.push({ gic: gicName, kind: 'spi', number: Number(m[1]), port: mine }); continue; }
    m = /^ppi_in_cpu_(\d+)_(\d+)$/.exec(gicPort);
    if (m) out.push({ gic: gicName, kind: 'ppi', cpu: Number(m[1]), number: Number(m[2]) - 16, port: mine });
  }
  return out;
}

function irqCells(irqs, ctx) {
  const list = [];
  for (const q of irqs) {
    const g = ctx.gics.get(q.gic);
    const flags = q.kind === 'ppi' && g.v2 ? (((1 << Math.min(ctx.cpuCount, 8)) - 1) << 8) | LEVEL_HIGH : LEVEL_HIGH;
    list.push(q.kind === 'spi' ? 0 : 1, q.number, flags);
  }
  return cells(...list);
}

// ------------------------------------------------------------------ generator

/**
 * Generate device tree source for a platform.
 * options: { topDir (directory ${TOP} stands for), fileSize(path) -> bytes | null }
 * Returns { dts, notes: [{level: 'warning' | 'info', text, module}], nodes: count }.
 */
function generate(doc, options = {}) {
  const topDir = options.topDir || '.';
  const fileSize = options.fileSize || ((f) => { try { return fs.statSync(f).size; } catch (e) { return null; } });
  const analysis = core.analyze(doc);
  const notes = [];
  const note = (level, text, module) => notes.push({ level, text, module });
  const dt = doc.devicetree || {};
  const overrides = (inst) => (inst.mod.devicetree === undefined ? {} : inst.mod.devicetree);
  const included = (inst) => inst.mod.devicetree !== false;
  const buses = new Set(analysis.buses);
  const ctx = { analysis, note, gics: new Map(), lua: luaEnv(doc, analysis), cpuCount: 0 };

  const root = node('/', undefined);
  const insts = analysis.instances.filter(included);
  const cpus = insts.filter((x) => CPU.test(x.type));
  ctx.cpuCount = cpus.length;
  const devices = [];
  const handled = new Set();

  // Interrupt controllers first: other nodes refer to them.
  for (const inst of insts.filter((x) => x.type === 'arm_gicv3' || x.type === 'arm_gicv2')) {
    const v2 = inst.type === 'arm_gicv2';
    const label = labelOf(inst.name);
    ctx.gics.set(inst.name, { label, v2 });
    handled.add(inst.name);
    const regs = regions(inst, buses);
    const dist = regs.find((r) => r.port === 'dist_iface');
    if (!dist) { note('warning', `${inst.name}: dist_iface is not mapped on a bus, so the interrupt controller has no address`, inst.base); continue; }
    const n = node('interrupt-controller', unitOf(dist.address), label);
    if (v2) {
      const cpuIf = regs.find((r) => r.port === 'cpu_iface');
      n.props.push(['compatible', 'arm,cortex-a15-gic'], ['reg', regCells([dist, ...(cpuIf ? [cpuIf] : [])])]);
      if (!cpuIf) note('warning', `${inst.name}: cpu_iface is not mapped, so the GICv2 CPU interface is missing from the device tree`, inst.base);
    } else {
      const redist = regs.filter((r) => /^redist_iface_\d+$/.test(r.port)).sort((a, b) => Number(a.port.split('_').pop()) - Number(b.port.split('_').pop()));
      if (!redist.length) note('warning', `${inst.name}: no redist_iface_N is mapped, so Linux will find no redistributors`, inst.base);
      const rev = paramValue(inst, 'revision', ctx);
      n.props.push(['compatible', 'arm,gic-v3'], ['reg', regCells([dist, ...redist])],
        ['#redistributor-regions', cells(redist.length)], ['redistributor-stride', cells(...u64(rev === 4 ? 0x40000 : 0x20000))]);
    }
    n.props.push(['#interrupt-cells', cells(3)], ['interrupt-controller', true], ['#address-cells', cells(2)], ['#size-cells', cells(2)]);
    n.address = dist.address;
    devices.push({ n, inst });
  }
  const firstGic = [...ctx.gics.values()][0];
  if (!firstGic) note('warning', 'No arm_gicv3 or arm_gicv2 in the platform, so no node has interrupts.');

  // CPUs, PSCI, timer, PMU.
  if (cpus.length) {
    const cn = node('cpus');
    cn.props.push(['#address-cells', cells(1)], ['#size-cells', cells(0)]);
    const conduits = new Set();
    const regs = new Set();
    for (const c of cpus) {
      handled.add(c.name);
      const k = c.index === null ? 0 : c.index;
      let mpidr = paramValue(c, 'mp_affinity', ctx);
      if (mpidr === undefined || mpidr === 0) mpidr = (Math.floor(k / 8) << 8) | (k % 8); // QEMU's default for Arm
      if (regs.has(mpidr)) note('warning', `${c.name}: mp_affinity 0x${mpidr.toString(16)} is used by another CPU`, c.base);
      regs.add(mpidr);
      const conduit = paramValue(c, 'psci_conduit', ctx);
      if (typeof conduit === 'string' && conduit !== 'disabled') conduits.add(conduit);
      const n = node('cpu', unitOf(mpidr), labelOf(c.name));
      n.props.push(['device_type', 'cpu'], ['compatible', cpuCompatible(c.type)], ['reg', cells(mpidr)]);
      if (conduit && conduit !== 'disabled') n.props.push(['enable-method', 'psci']);
      cn.children.push(n);
    }
    if (conduits.size > 1) note('warning', `CPUs use different PSCI conduits (${[...conduits].join(', ')})`);
    if (conduits.size) {
      const method = [...conduits][0];
      const ps = node('psci');
      ps.props.push(['compatible', ['arm,psci-1.0', 'arm,psci-0.2', 'arm,psci']], ['method', method]);
      root.children.push(ps);
    } else if (cpus.length > 1) {
      note('warning', 'psci_conduit is not set on the CPUs, so the device tree gives secondary CPUs no way to start (enable-method)');
    }
    root.children.push(cn);

    // Per-CPU interrupts, taken from the first CPU.
    const c0 = cpus[0];
    const ppis = interruptsOf(c0, ctx).filter((q) => q.kind === 'ppi');
    const byPort = new Map(ppis.map((q) => [q.port, q]));
    const timerPorts = ['irq_timer_sec_out', 'irq_timer_phys_out', 'irq_timer_virt_out', 'irq_timer_hyp_out'];
    const timer = timerPorts.map((p) => byPort.get(p));
    if (timer.every(Boolean)) {
      const t = node('timer');
      t.props.push(['compatible', ['arm,armv8-timer', 'arm,armv7-timer']], ['interrupts', irqCells(timer, ctx)], ['always-on', true]);
      root.children.push(t);
    } else if (firstGic) {
      note('warning', `${c0.name}: the generic timer outputs (${timerPorts.filter((p, i) => !timer[i]).join(', ')}) are not wired to a PPI, so there is no timer node`, c0.base);
    }
    if (byPort.get('pmu_interrupt')) {
      const p = node('pmu');
      p.props.push(['compatible', 'arm,armv8-pmuv3'], ['interrupts', irqCells([byPort.get('pmu_interrupt')], ctx)]);
      root.children.push(p);
    }
    const maint = byPort.get('gicv3_maintenance_interrupt');
    if (maint) {
      const g = devices.find((d) => d.inst.name === maint.gic);
      if (g) g.n.props.push(['interrupts', irqCells([maint], ctx)]);
    }
  }

  // Memory, devices, PCIe.
  let clock = false;
  const uarts = [];
  for (const inst of insts) {
    if (handled.has(inst.name)) continue;
    const ov = overrides(inst);
    const regs = regions(inst, buses);
    const irqs = interruptsOf(inst, ctx).filter((q) => q.kind === 'spi');
    const withIrqs = (n) => { if (irqs.length) n.props.push(['interrupts', irqCells(irqs, ctx)]); return n; };
    let n;
    if (ov.compatible) {
      if (!regs.length) { note('warning', `${inst.name}: has a devicetree compatible but no port mapped on a bus`, inst.base); continue; }
      n = withIrqs(node(ov.name || 'device', unitOf(regs[0].address), labelOf(inst.name)));
      n.props.unshift(['compatible', [].concat(ov.compatible)], ['reg', regCells(regs)]);
    } else if (inst.type === 'gs_memory') {
      if (!regs.length) continue;
      const fallback = inst.ports.some((p) => p.priority > 0);
      if (fallback) { note('info', `${inst.name}: a background memory (priority ${inst.ports.find((p) => p.priority > 0).priority}) is not described as RAM`, inst.base); continue; }
      n = node('memory', unitOf(regs[0].address));
      n.props.push(['device_type', 'memory'], ['reg', regCells(regs)]);
    } else if (UART.has(inst.type)) {
      if (!regs.length) { note('warning', `${inst.name}: not mapped on a bus`, inst.base); continue; }
      n = withIrqs(node('serial', unitOf(regs[0].address), labelOf(inst.name)));
      n.props.unshift(['compatible', ['arm,pl011', 'arm,primecell']], ['reg', regCells(regs.slice(0, 1))]);
      n.props.push(['clocks', cells('&apb_pclk', '&apb_pclk')], ['clock-names', ['uartclk', 'apb_pclk']]);
      clock = true;
      uarts.push(n);
    } else if (inst.type === 'pl031') {
      if (!regs.length) continue;
      n = withIrqs(node('rtc', unitOf(regs[0].address), labelOf(inst.name)));
      n.props.unshift(['compatible', ['arm,pl031', 'arm,primecell']], ['reg', regCells(regs.slice(0, 1))]);
      n.props.push(['clocks', cells('&apb_pclk')], ['clock-names', 'apb_pclk']);
      clock = true;
    } else if (VIRTIO.test(inst.type)) {
      if (!regs.length) { note('warning', `${inst.name}: not mapped on a bus`, inst.base); continue; }
      n = withIrqs(node('virtio_mmio', unitOf(regs[0].address), labelOf(inst.name)));
      n.props.unshift(['compatible', 'virtio,mmio'], ['reg', regCells(regs.slice(0, 1))]);
      n.props.push(['dma-coherent', true]);
    } else if (inst.type === 'qemu_gpex') {
      n = pcieNode(inst, regs, ctx);
      if (!n) continue;
    } else {
      if (regs.length && !buses.has(inst.name)) {
        note('info', `${inst.name} (${inst.type}) at 0x${regs[0].address.toString(16)} is not described; give it "devicetree": {"compatible": …} to add a node, or false to silence this`, inst.base);
      }
      continue;
    }
    if (n.unit !== undefined && regs.length) n.address = regs[0].address;
    for (const [k, v] of Object.entries(ov.properties || {})) n.props.push([k, propFromJson(v)]);
    if (ov.status) n.props.push(['status', ov.status]);
    devices.push({ n, inst });
  }

  if (clock) {
    const c = node('apb-pclk', undefined, 'apb_pclk');
    c.props.push(['compatible', 'fixed-clock'], ['#clock-cells', cells(0)], ['clock-frequency', cells(24000000)], ['clock-output-names', 'clk24mhz']);
    root.children.push(c);
  }
  devices.sort((a, b) => (a.n.address === undefined ? 1 : b.n.address === undefined ? -1 : a.n.address < b.n.address ? -1 : a.n.address > b.n.address ? 1 : 0));
  root.children.push(...devices.map((d) => d.n));

  // Root properties, aliases, chosen.
  root.props.push(['#address-cells', cells(2)], ['#size-cells', cells(2)],
    ['model', dt.model || doc.name || 'qbox'], ['compatible', [].concat(dt.compatible || 'linux,dummy-virt')]);
  if (firstGic) root.props.push(['interrupt-parent', cells('&' + firstGic.label)]);
  let stdout = uarts[0];
  if (dt.stdout) {
    const want = labelOf(dt.stdout);
    stdout = uarts.find((u) => u.label === want);
    if (!stdout) note('warning', `devicetree.stdout: ${dt.stdout} is not a UART in the device tree`);
  }
  if (uarts.length) {
    const al = node('aliases');
    const ordered = stdout ? [stdout, ...uarts.filter((u) => u !== stdout)] : uarts;
    ordered.forEach((u, k) => al.props.push([`serial${k}`, `/${u.name}@${u.unit}`]));
    root.children.push(al);
  }
  const ch = node('chosen');
  if (dt.bootargs !== undefined) ch.props.push(['bootargs', dt.bootargs]);
  // Without a command line Linux has no root= (2026-11-15: a DTB generated before bootargs
  // was set stopped the Ubuntu platform in emergency mode at "Failed to start Switch Root").
  else note('warning', 'devicetree.bootargs is not set, so the kernel gets no command line (no root=, no console options). Linux usually cannot mount its root file system without it; set "bootargs" under "devicetree" in the platform.');
  if (stdout) ch.props.push(['stdout-path', `/${stdout.name}@${stdout.unit}`]);
  const initrd = initrdRange(doc, analysis, dt, topDir, fileSize, note);
  if (initrd) ch.props.push(['linux,initrd-start', cells(...u64(initrd.start))], ['linux,initrd-end', cells(...u64(initrd.end))]);
  root.children.push(ch);

  let text = renderNode(root, 0);
  if (dt.extra) text = text.replace(/\n};$/, `\n\n\t/* devicetree.extra */\n${String(dt.extra).replace(/^/gm, '\t')}\n};`);
  const header = `/dts-v1/;\n\n/*\n * Generated by VP Studio from ${doc.name || 'the platform description'}. Do not edit:\n * change the platform description (devicetree, modules) and generate again.\n */\n\n`;
  return { dts: header + text + '\n', notes, nodes: devices.length };
}

function propFromJson(v) {
  if (v === true) return true;
  if (typeof v === 'number') return cells(v);
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'number' || /^0x[0-9a-f]+$/i.test(String(x)))) return cells(...v.map((x) => (typeof x === 'number' ? x : BigInt(x))));
  if (Array.isArray(v)) return v.map(String);
  throw new Error(`devicetree property value ${JSON.stringify(v)} is not supported`);
}

/** The generic PCIe host (qemu_gpex): ECAM, windows, and INTx swizzled over four slots. */
function pcieNode(inst, regs, ctx) {
  const by = new Map(regs.map((r) => [r.port, r]));
  const ecam = by.get('ecam_iface');
  if (!ecam) { ctx.note('warning', `${inst.name}: ecam_iface is not mapped, so there is no PCIe node`, inst.base); return null; }
  const n = node('pcie', unitOf(ecam.address), labelOf(inst.name));
  const buses = Number(ecam.size >> 20n);
  n.props.push(['compatible', 'pci-host-ecam-generic'], ['device_type', 'pci'], ['reg', regCells([ecam])],
    ['bus-range', cells(0, Math.max(0, Math.min(buses, 256) - 1))], ['linux,pci-domain', cells(0)],
    ['#address-cells', cells(3)], ['#size-cells', cells(2)], ['dma-coherent', true]);
  const ranges = [];
  // Windows mapped 1:1, as in QBox's Ubuntu platform.
  for (const [port, space] of [['pio_iface', 0x01000000], ['mmio_iface', 0x02000000], ['mmio_iface_high', 0x03000000]]) {
    const r = by.get(port);
    if (r) ranges.push([space, ...u64(r.address), ...u64(r.address), ...u64(r.size)]);
  }
  if (ranges.length) n.props.push(['ranges', { cellRows: ranges }]);
  const irqs = interruptsOf(inst, ctx).filter((q) => q.kind === 'spi');
  const intx = [0, 1, 2, 3].map((k) => irqs.find((q) => q.port === `irq_out_${k}`));
  if (intx.every(Boolean)) {
    const g = ctx.gics.get(intx[0].gic);
    const rows = [];
    for (let slot = 0; slot < 4; slot++) {
      for (let pin = 1; pin <= 4; pin++) rows.push([slot << 11, 0, 0, pin, '&' + g.label, 0, 0, 0, intx[(slot + pin - 1) % 4].number, LEVEL_HIGH]);
    }
    n.props.push(['#interrupt-cells', cells(1)], ['interrupt-map-mask', cells(0x1800, 0, 0, 7)], ['interrupt-map', { cellRows: rows }]);
  } else {
    ctx.note('warning', `${inst.name}: irq_out_0 to irq_out_3 are not all wired to SPIs, so PCI devices get no legacy interrupts`, inst.base);
  }
  return n;
}

/**
 * The initrd's load range: the loader entry named by devicetree.initrd
 * ({module, entry}), or the one whose file name says initrd or initramfs.
 */
function initrdRange(doc, analysis, dt, topDir, fileSize, note) {
  if (dt.initrd === false) return null;
  let found;
  for (const [base, mod] of Object.entries(core.modulesOf(doc))) {
    if (mod.type !== 'loader' || !Array.isArray(mod.entries)) continue;
    mod.entries.forEach((e, k) => {
      const file = e.bin_file;
      if (!file) return;
      const want = dt.initrd ? dt.initrd.module === base && dt.initrd.entry === k : /initrd|initramfs/i.test(path.basename(file));
      if (want && !found) found = { base, k, e, file };
    });
  }
  if (!found) {
    if (dt.initrd) note('warning', `devicetree.initrd: ${dt.initrd.module} has no bin_file entry ${dt.initrd.entry}`);
    return null;
  }
  const start = core.evalInt(found.e.address, analysis.env);
  const file = images.resolveTemplate(found.file, topDir);
  const size = file === null ? null : fileSize(file);
  if (start === null) { note('warning', `${found.base}.entries[${found.k}]: the initrd address is not a constant`, found.base); return null; }
  if (size === null) { note('warning', `${found.base}.entries[${found.k}]: cannot read ${file || found.file}, so the initrd range is left out`, found.base); return null; }
  return { start, end: start + BigInt(size), entry: `${found.base}.entries[${found.k}]` };
}

/**
 * Where the device tree files of a platform go: { dts, dtb }.
 * With devicetree.output, the DTS sits next to that DTB with the same name
 * (generated.dtb -> generated.dts), so the pair is easy to tell apart;
 * without it, both go next to the platform as <name>.generated.dts/.dtb.
 * Throws when output uses variables other than ${TOP}.
 */
function outputPaths(doc, platformFile) {
  const topDir = path.dirname(platformFile);
  const out = doc.devicetree && doc.devicetree.output;
  if (!out) {
    const base = doc.name || path.basename(platformFile).replace(/\.platform\.json$/, '');
    return { dts: path.join(topDir, `${base}.generated.dts`), dtb: path.join(topDir, `${base}.generated.dtb`) };
  }
  const dtb = images.resolveTemplate(out, topDir);
  if (!dtb) throw new Error(`devicetree.output ${out} uses variables other than \${TOP}`);
  return { dts: /\.dtb$/i.test(dtb) ? dtb.replace(/\.dtb$/i, '.dts') : dtb + '.dts', dtb };
}

module.exports = { generate, cpuCompatible, outputPaths };
