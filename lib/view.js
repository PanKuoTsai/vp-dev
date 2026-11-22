'use strict';
// Builds the HTML of the platform view (a VS Code webview) from an analysis result.
// No VS Code dependency, so it can be rendered to a file in tests.
//
// Layout ("workbench"): a header with the platform's identity and main actions,
// a strip of key figures, then three columns: the modules by role on the left,
// the block diagram in the middle with the tables in tabs below it, and an
// inspector on the right for the selected module (parameters, connections).
// Colors follow the VS Code theme; each module role has its own accent color.

const { hex } = require('./core');
const theme = require('./webtheme');
const { ICON, BRAND } = theme;
const { hunks } = require('./dtcompare');
const { routeFor } = require('./dataflow');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtSize(n) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let u = 0;
  let v = n;
  while (v >= 1024n && v % 1024n === 0n && u < units.length - 1) { v /= 1024n; u++; }
  return `${v} ${units[u]}`;
}

function fmtApprox(n) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = Number(n);
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
}

/** A size for people: exact when it is a whole unit, else one decimal. */
const fmtSizeShort = (n) => {
  const exact = fmtSize(n);
  return /^\d{1,4} /.test(exact) ? exact : fmtApprox(n);
};

/** 0x80000000 -> 0x8000_0000, grouped by 4 hex digits for reading. */
function fmtAddr(n) {
  const h = BigInt(n).toString(16).toUpperCase();
  if (h.length <= 4) return '0x' + h;
  return '0x' + h.replace(/\B(?=([0-9A-F]{4})+$)/g, '_');
}

// ------------------------------------------------------------------ roles

const ROLE_LABEL = {
  compute: 'Compute', memory: 'Memory', irq: 'Interrupts', periph: 'Peripherals', pcie: 'PCIe',
  boot: 'Boot', bus: 'Buses', subsystem: 'Subsystems', infra: 'Infrastructure',
};
const ROLE_ORDER = ['compute', 'memory', 'irq', 'periph', 'pcie', 'boot', 'bus', 'subsystem', 'infra'];
const ROLE_GLYPH = { compute: 'C', memory: 'M', irq: 'I', periph: 'P', pcie: 'X', boot: 'B', bus: 'R', subsystem: 'S', infra: '·' };

/**
 * What a module is for, from its type and how it is attached.
 * g: a group from groups(), or { type, isBus, subsystem, target }.
 */
function roleOf(g) {
  const t = String(g.type || '');
  if (g.subsystem) return 'subsystem';
  if (g.isBus || /^router$|router/i.test(t)) return 'bus';
  if (/^cpu_|cpu/i.test(t)) return 'compute';
  if (/gic|plic|nvic|intc|interrupt|aplic|imsic/i.test(t)) return 'irq';
  if (/gpex|pci/i.test(t)) return 'pcie';
  if (/memory|ram|rom|flash|sram|dram/i.test(t)) return 'memory';
  if (/loader|initiator/i.test(t)) return 'boot';
  if (g.target) return 'periph';
  return 'infra';
}

/** cpu_arm_cortexA76 -> Cortex-A76, cpu_arm_neoverseN2 -> Neoverse N2. */
function cpuLabel(type) {
  const t = String(type);
  let m = /cortex[-_]?([amr])(\d+)/i.exec(t);
  if (m) return `Cortex-${m[1].toUpperCase()}${m[2]}`;
  m = /neoverse[-_]?([nve])(\d+)/i.exec(t);
  if (m) return `Neoverse ${m[1].toUpperCase()}${m[2]}`;
  return t.replace(/^cpu_/, '');
}

// ------------------------------------------------------------------ grouping

/**
 * The outermost collapsed subsystem a name is inside, or null.
 * collapsed: Set of container paths drawn as one block.
 */
function hiddenBy(name, collapsed) {
  let best = null;
  for (const c of collapsed) if (name.startsWith(c + '.') && (best === null || c.length < best.length)) best = c;
  return best;
}

/** Buses shown in the diagram: those not inside a collapsed subsystem. */
const visibleBuses = (analysis, collapsed) => analysis.buses.filter((b) => !hiddenBy(b, collapsed));

/**
 * One block per module (replicas together). A collapsed subsystem is one
 * block standing for everything inside it, attached to the outside buses its
 * contents use; an expanded one is a block of its own next to its contents.
 * Each group records, for each bus, how it is attached: on.get(bus) = { initiator, target }.
 */
function groups(analysis, collapsed = new Set()) {
  const bus = new Set(visibleBuses(analysis, collapsed));
  const map = new Map();
  for (const inst of analysis.instances) {
    const owner = hiddenBy(inst.name, collapsed);
    if (inst.isContainer && !owner) {
      map.set(inst.name, { base: inst.name, type: inst.type, count: 1, on: new Map(), isBus: false, subsystem: true, collapsed: collapsed.has(inst.name), members: 0, container: inst.container });
      continue;
    }
    const key = owner || inst.base;
    if (!map.has(key)) map.set(key, { base: key, type: inst.type, count: 0, on: new Map(), isBus: bus.has(inst.name), container: inst.container });
    const g = map.get(key);
    if (owner) { if (!inst.isContainer) g.members++; } else g.count++;
    for (const p of inst.ports) {
      if (!bus.has(p.peer)) continue;
      if (!g.on.has(p.peer)) g.on.set(p.peer, { initiator: false, target: false });
      if (p.raw.address !== undefined) g.on.get(p.peer).target = true; else g.on.get(p.peer).initiator = true;
    }
  }
  const out = [...map.values()];
  for (const g of out) {
    if (g.subsystem && g.collapsed) {
      // A collapsed subsystem is drawn as one block; say so with its own role.
      g.type = g.type || 'Container';
    }
    g.target = [...g.on.values()].some((o) => o.target);
    g.role = roleOf(g);
  }
  return out;
}

/** Interrupt lines into interrupt controllers, by sending module: base -> 'SPI 379' / 'SPI 541–544'. */
function interruptLabels(analysis) {
  const irqCtl = new Set(analysis.instances.filter((i) => roleOf({ type: i.type }) === 'irq').map((i) => i.name));
  const nums = new Map();
  for (const c of analysis.connections) {
    if (!irqCtl.has(c.to)) continue;
    const m = /^spi_in_(\d+)$/.exec(c.toPort);
    if (!m) continue;
    if (!nums.has(c.fromBase)) nums.set(c.fromBase, new Set());
    nums.get(c.fromBase).add(Number(m[1]));
  }
  const out = new Map();
  for (const [base, set] of nums) {
    const n = [...set].sort((a, b) => a - b);
    const contiguous = n.length > 1 && n[n.length - 1] - n[0] === n.length - 1;
    out.set(base, n.length === 1 ? `SPI ${n[0]}` : contiguous ? `SPI ${n[0]}–${n[n.length - 1]}` : `SPI ${n.slice(0, 3).join(', ')}${n.length > 3 ? '…' : ''}`);
  }
  return out;
}

/** Each interrupt line into an interrupt controller, by sending module: base -> ['gpex_0.irq_out_0 → gic_0.spi_in_541', …]. */
function interruptLines(analysis) {
  const irqCtl = new Set(analysis.instances.filter((i) => roleOf({ type: i.type }) === 'irq').map((i) => i.name));
  const out = new Map();
  for (const c of analysis.connections) {
    if (!irqCtl.has(c.to) || !/^spi_in_\d+$/.test(c.toPort)) continue;
    if (!out.has(c.fromBase)) out.set(c.fromBase, []);
    out.get(c.fromBase).push(`${c.from}.${c.fromPort} → ${c.to}.${c.toPort}`);
  }
  return out;
}

/**
 * Where an address goes: on each bus that maps it, the region that answers
 * (the lowest priority number wins) and the ones it shadows.
 * regions: [{ start, end, instance, base, port, bus, priority }] with BigInt bounds.
 * Returns [{ bus, hit: { …region, offset }, shadowed: [region…] }].
 * Self-contained: the webview runs its source text.
 */
function lookupAddress(regions, addr) {
  const byBus = new Map();
  for (const r of regions) {
    if (addr < r.start || addr > r.end) continue;
    if (!byBus.has(r.bus)) byBus.set(r.bus, []);
    byBus.get(r.bus).push(r);
  }
  const out = [];
  for (const [bus, list] of byBus) {
    list.sort((a, b) => a.priority - b.priority);
    out.push({ bus, hit: Object.assign({}, list[0], { offset: addr - list[0].start }), shadowed: list.slice(1) });
  }
  return out;
}

/** '0x1000_0010', '0x10000010', '268435472' -> BigInt; null when not an address. Self-contained. */
function parseAddress(text) {
  const t = String(text).trim().replace(/[_\s]/g, '');
  if (/^0x[0-9a-f]+$/i.test(t)) return BigInt(t);
  if (/^\d+$/.test(t)) return BigInt(t);
  return null;
}

// ------------------------------------------------------------------ signal layer

/** What a non-bus connection carries: an interrupt line, a byte stream, or another signal. */
function signalKind(c, irqCtl) {
  const ports = `${c.fromPort} ${c.toPort}`;
  if (/biflow|backend|chardev|serial_?socket/i.test(ports)) return 'stream';
  if (irqCtl.has(c.to) || irqCtl.has(c.from) || /(^|_)(irq|fiq|virq|vfiq|interrupt|spi_in|ppi_in)/i.test(ports)) return 'irq';
  return 'signal';
}

/**
 * The non-bus connections between the blocks of the diagram, one line per
 * pair of blocks and kind (32 GIC lines to 8 CPUs are one line "×32"), drawn
 * over the blocks. at: block base -> { x, y, w, h }. Lines show when one of
 * their blocks is hovered or selected (or all, faintly), in the webview.
 */
function signalLayer(analysis, collapsed, at, irqLabels) {
  const irqCtl = new Set(analysis.instances.filter((i) => roleOf({ type: i.type }) === 'irq').map((i) => i.name));
  const buses = new Set(analysis.buses);
  const groupOf = new Map(analysis.instances.map((i) => [i.name, hiddenBy(i.name, collapsed) || i.base]));
  const edges = new Map();
  for (const c of analysis.connections) {
    if (buses.has(c.to) || buses.has(c.from)) continue;
    const a = groupOf.get(c.from), b = groupOf.get(c.to);
    if (!a || !b || a === b || !at.has(a) || !at.has(b)) continue;
    const kind = signalKind(c, irqCtl);
    // One line per pair of blocks and kind, whichever way the signals go.
    const [x, y] = a < b ? [a, b] : [b, a];
    const key = `${x}|${y}|${kind}`;
    if (!edges.has(key)) edges.set(key, { a, b, kind, lines: [], back: [] });
    const e = edges.get(key);
    (e.a === a ? e.lines : e.back).push(`${c.from}.${c.fromPort} → ${c.to}.${c.toPort}`);
  }
  const out = [];
  for (const e of edges.values()) {
    const p = at.get(e.a), q = at.get(e.b);
    const pc = { x: p.x + p.w / 2, y: p.y + p.h / 2 }, qc = { x: q.x + q.w / 2, y: q.y + q.h / 2 };
    // Leave from the side that faces the other block; curve so lines between neighbours do not lie on each other.
    let x1, y1, x2, y2, d;
    if (Math.abs(qc.y - pc.y) > (p.h + q.h) / 2) {
      const down = qc.y > pc.y;
      x1 = pc.x; y1 = down ? p.y + p.h : p.y; x2 = qc.x; y2 = down ? q.y : q.y + q.h;
      const my = (y1 + y2) / 2;
      d = `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
    } else {
      const right = qc.x > pc.x;
      x1 = right ? p.x + p.w : p.x; y1 = pc.y; x2 = right ? q.x : q.x + q.w; y2 = qc.y;
      const bend = Math.max(18, Math.abs(x2 - x1) / 4);
      d = `M${x1} ${y1} C${(x1 + x2) / 2} ${y1 - bend} ${(x1 + x2) / 2} ${y2 - bend} ${x2} ${y2}`;
    }
    const n = e.lines.length, m = e.back.length;
    // Interrupts into the controller already show their number on the sending block.
    const label = m ? `${e.kind} ×${n} ⇄ ×${m}`
      : e.kind === 'irq' && irqCtl.has(e.b) && irqLabels.has(e.a) ? ''
        : n > 1 ? `${e.kind} ×${n}` : e.lines[0].replace(/^[^.]+\./, '').replace(/ → [^.]+(\.[^.]+)*\./, ' → ');
    const all = e.lines.concat(e.back);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - (Math.abs(y2 - y1) < 1 ? 14 : 0);
    out.push(`<g class="sig sig-${e.kind}" data-a="${esc(e.a)}" data-b="${esc(e.b)}"><title>${esc(all.slice(0, 40).join('\n') + (all.length > 40 ? `\n… ${all.length - 40} more` : ''))}</title>` +
      `<path d="${d}"${m ? ` marker-start="url(#vp-arrow-${e.kind})"` : ''} marker-end="url(#vp-arrow-${e.kind})"/>` +
      (label ? `<text x="${mx.toFixed(1)}" y="${(my - 4).toFixed(1)}" text-anchor="middle">${esc(clip(label, 30))}</text>` : '') + '</g>');
  }
  return out.length ? `<g class="sig-layer" aria-hidden="true">${out.join('')}</g>` : '';
}

// ------------------------------------------------------------------ block diagram

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * Styles that depend on the data (a width, a position). The webview's content
 * security policy only allows the nonce'd <style> element, so style="…"
 * attributes are ignored: each such style becomes a generated class instead.
 * attr(classes, decl) gives the class attribute; css() the rules to put in <style>.
 * Without a sheet (a diagram rendered on its own) a style attribute is written.
 */
function makeSheet() {
  const rules = [];
  return {
    attr: (classes, decl) => { const c = `d${rules.length}`; rules.push(`.${c}{${decl}}`); return `class="${classes} ${c}"`; },
    css: () => rules.join('\n'),
  };
}
const inlineSheet = { attr: (classes, decl) => `class="${classes}" style="${decl}"`, css: () => '' };

/**
 * Block diagram, one section per bus (router): the modules that start
 * transactions in a row above its bar, the mapped ones below it in one
 * column per role (memory, interrupts, peripherals, PCIe...), each column
 * hanging from the bar. A module on several buses is drawn under the first.
 * Modules on no bus come last as small blocks.
 */
function diagram(analysis, collapsed = new Set(), sheet = inlineSheet) {
  const gs = groups(analysis, collapsed);
  const irq = interruptLabels(analysis);
  const irqLines = interruptLines(analysis);
  const X0 = 16, GAP = 18, BW = 190, CW = BW + 26, SW = 156, SH = 38, MAXROWS = 5;
  const baseOf = new Map(analysis.instances.map((i) => [i.name, i.base]));
  const buses = visibleBuses(analysis, collapsed);
  const firstBus = (g) => buses.find((b) => g.on.has(b));
  const regionsOf = (base, bus) => analysis.memoryMap.filter((m) => m.base === base && (!bus || m.bus === bus));

  // Width: enough for the widest row of any section.
  let cols = 4;
  const sections = buses.map((bus) => {
    const members = gs.filter((g) => !g.isBus && !(g.subsystem && !g.collapsed) && firstBus(g) === bus);
    const initiators = members.filter((g) => g.on.get(bus).initiator && !g.on.get(bus).target);
    const targets = members.filter((g) => g.on.get(bus).target);
    const columns = [];
    for (const role of ROLE_ORDER) {
      const list = targets.filter((g) => g.role === role);
      for (let i = 0; i < list.length; i += MAXROWS) columns.push({ role, items: list.slice(i, i + MAXROWS), cont: i > 0 });
    }
    cols = Math.max(cols, columns.length, Math.ceil(initiators.length));
    return { bus, members, initiators, targets, columns };
  });
  const W = Math.max(760, X0 * 2 + cols * CW);
  const perRow = Math.max(1, Math.floor((W - 2 * X0 + GAP) / (BW + GAP)));
  const parts = [];
  let y = 8;
  // A wire with a tooltip: the drawn line is thin, so a wider invisible path takes the pointer.
  // show: draw the line too (false when it is part of a shared spine drawn already).
  const linkWire = (d, title, cls, show = true) => parts.push(`<g class="bus-link"><title>${esc(title)}</title>` +
    (show ? `<path class="wire ${cls}" d="${d}"/>` : `<path class="wire ${cls} hover-only" d="${d}"/>`) + `<path class="hit" d="${d}"/></g>`);

  const label = (g) => {
    const local = g.container ? g.base.slice(g.container.length + 1) : g.base;
    if (g.subsystem) return local;
    return g.count > 1 ? `${local} ×${g.count}` : local;
  };
  const typeLine = (g) => {
    if (g.subsystem) return g.collapsed ? `subsystem · ${g.members} module${g.members === 1 ? '' : 's'}` : 'subsystem (expanded)';
    return g.container ? `${g.container} › ${g.type}` : g.type;
  };
  const open = (g, cls) =>
    `<g class="node role-${g.role} ${cls}${g.subsystem ? ' subsystem' : ''}" data-module="${esc(g.base)}" tabindex="0" role="button" aria-label="${esc(g.base)}${g.subsystem ? (g.collapsed ? ' (collapsed subsystem)' : ' (subsystem)') : ''}">` +
    `<title>${esc(g.base)} (${esc(typeLine(g))})</title>`;

  /** A full block: role swatch, name and badge, type, facts (or core tiles). */
  const at = new Map(); // group base -> { x, y, w, h } of its block, for the signal layer
  const block = (g, x, by, h, cls, bus) => {
    if (!at.has(g.base)) at.set(g.base, { x, y: by, w: BW, h });
    const regions = regionsOf(g.base, bus);
    let facts = '';
    if (regions.length === 1) facts = `${fmtAddr(regions[0].start)} · ${fmtSizeShort(regions[0].size)}`;
    else if (regions.length > 1) facts = `${fmtAddr(regions[0].start)} · ${regions.length} regions`;
    let badge = irq.get(g.base) || '';
    if (!badge && regions.length && regions.every((r) => r.priority > 0)) badge = 'background';
    badge = clip(badge, 13);
    const nameRoom = Math.floor((BW - 37 - (badge ? badge.length * 6.4 + 8 : 0) - (g.subsystem ? 24 : 0)) / 7.6);
    parts.push(open(g, cls) +
      `<rect class="box" x="${x}" y="${by}" width="${BW}" height="${h}" rx="7"/>` +
      `<rect class="swatch" x="${x + 12}" y="${by + 13}" width="8" height="8" rx="2"/>` +
      `<text class="name" x="${x + 27}" y="${by + 21}">${esc(clip(label(g), nameRoom))}</text>` +
      (badge ? `<text class="badge" x="${x + BW - 10}" y="${by + 21}" text-anchor="end">${irqLines.has(g.base) ? `<title>${esc(irqLines.get(g.base).join('\n'))}</title>` : ''}${esc(badge)}</text>` : '') +
      `<text class="type" x="${x + 12}" y="${by + 38}">${esc(clip(typeLine(g), 28))}</text>` +
      (g.subsystem ? toggle(g, x + BW - 26, by + 8) : ''));
    if (g.role === 'compute' && g.count > 1) {
      const n = Math.min(g.count, 16);
      const tw = (BW - 24 - (n - 1) * 3) / n;
      for (let i = 0; i < n; i++) {
        // Each tile is one instance: clicking it selects that one for editing (Applies to).
        parts.push(`<rect class="core" data-index="${i}" x="${(x + 12 + i * (tw + 3)).toFixed(1)}" y="${by + 47}" width="${tw.toFixed(1)}" height="12" rx="2"><title>${esc(g.base)}_${i}: click to edit this instance only</title></rect>`);
      }
    } else if (facts) {
      parts.push(`<text class="facts" x="${x + 12}" y="${by + 55}">${esc(clip(facts, 25))}</text>`);
    }
    parts.push('</g>');
  };

  /** The collapse / expand button at the top right of a subsystem's block. */
  const toggle = (g, x, y) => {
    const what = g.collapsed ? 'Expand' : 'Collapse';
    // Collapsed: a chevron pointing right (opens); expanded: pointing down (closes).
    const chevron = g.collapsed ? `M${x + 7.5} ${y + 5.5} L${x + 11} ${y + 9} L${x + 7.5} ${y + 12.5}` : `M${x + 5.5} ${y + 7.5} L${x + 9} ${y + 11} L${x + 12.5} ${y + 7.5}`;
    return `<g class="sub-toggle" data-module="${esc(g.base)}" tabindex="0" role="button" aria-label="${what} subsystem ${esc(g.base)}">` +
      `<title>${what} ${esc(g.base)}</title><rect x="${x}" y="${y}" width="18" height="18" rx="4"/><path d="${chevron}"/></g>`;
  };

  /** A small block, for modules on no bus. */
  const chip = (g, x, by) => {
    if (!at.has(g.base)) at.set(g.base, { x, y: by, w: SW, h: SH });
    parts.push(open(g, 'other') +
      `<rect class="box" x="${x}" y="${by}" width="${SW}" height="${SH}" rx="6"/>` +
      `<rect class="swatch" x="${x + 10}" y="${by + 9}" width="7" height="7" rx="2"/>` +
      `<text class="name small" x="${x + 23}" y="${by + 16}">${esc(clip(label(g), g.subsystem ? 14 : 17))}</text>` +
      `<text class="type" x="${x + 10}" y="${by + 30}">${esc(clip(typeLine(g), 23))}</text>` +
      (g.subsystem ? toggle(g, x + SW - 25, by + 10) : '') + '</g>');
  };

  const barY = new Map(); // bus -> y of its bar
  sections.forEach((s, k) => {
    if (k > 0) y += 28;
    // Initiators, wrapped in rows; rows further from the bar route their wire
    // through the gap left of their column, so no wire crosses a block.
    const ih = s.initiators.some((g) => g.role === 'compute' && g.count > 1) ? 66 : 50;
    const iRows = Math.ceil(s.initiators.length / perRow);
    if (s.initiators.length) parts.push(`<text class="caption" x="${X0}" y="${y + 10}">INITIATORS</text>`);
    const iy0 = y + (s.initiators.length ? 18 : 0);
    const busY = iy0 + iRows * (ih + GAP) + (s.initiators.length ? 0 : 0);
    barY.set(s.bus, busY);
    s.initiators.forEach((g, i) => {
      const r = Math.floor(i / perRow), c = i % perRow;
      const x = X0 + c * (BW + GAP);
      const by = iy0 + r * (ih + GAP);
      const wx = x + BW / 2;
      const ports = [...new Set(analysis.connections.filter((cn) => cn.fromBase === g.base && cn.to === s.bus).map((cn) => cn.fromPort))];
      const tip = `${label(g)}${ports.length === 1 ? '.' + ports[0] : ''} → ${s.bus}`;
      if (r === iRows - 1) linkWire(`M${wx} ${by + ih} L${wx} ${busY}`, tip, 'bus-wire');
      else {
        const jog = by + ih + GAP / 2, gx = x - GAP / 2;
        linkWire(`M${wx} ${by + ih} L${wx} ${jog} L${gx} ${jog} L${gx} ${busY}`, tip, 'bus-wire');
      }
      block(g, x, by, ih, 'initiator', s.bus);
    });
    // The bus bar, with the address range it decodes.
    const regs = analysis.memoryMap.filter((m) => m.bus === s.bus);
    const lo = regs.length ? regs.reduce((a, m) => (m.start < a ? m.start : a), regs[0].start) : null;
    const hi = regs.length ? regs.reduce((a, m) => (m.end > a ? m.end : a), regs[0].end) : null;
    const nInit = s.initiators.length + s.targets.filter((g) => g.on.get(s.bus).initiator).length;
    // A bus that is a target of another bus (a memory controller behind a system bus) is fed by it.
    const feeders = [...new Set(analysis.memoryMap.filter((m) => m.instance === s.bus && analysis.buses.includes(m.bus)).map((m) => m.bus))];
    const fedText = feeders.length ? `from ${feeders.join(', ')}${nInit ? ` + ${nInit} initiator${nInit === 1 ? '' : 's'}` : ''}` : `${nInit} initiator${nInit === 1 ? '' : 's'}`;
    const empty = s.members.length === 0 && !feeders.length;
    parts.push(`<g class="node bus" data-module="${esc(baseOf.get(s.bus) || s.bus)}" tabindex="0" role="button" aria-label="${esc(s.bus)} (bus)">` +
      `<title>${esc(s.bus)} (bus)</title><rect class="box" x="${X0 - 6}" y="${busY}" width="${W - 2 * X0 + 12}" height="30" rx="6"/>` +
      (empty
        ? `<text class="name" x="${X0 + 8}" y="${busY + 19}">${esc(s.bus)} (bus) — nothing connected yet</text>`
        : `<text class="name" x="${X0 + 8}" y="${busY + 19}">${esc(s.bus)}</text>` +
          `<text class="bus-info" x="${X0 + 8 + Math.max(60, s.bus.length * 8 + 14)}" y="${busY + 19}">bus · ${esc(fedText)} · ${regs.length} region${regs.length === 1 ? '' : 's'}</text>` +
          (regs.length ? `<text class="bus-info" x="${W - X0 - 2}" y="${busY + 19}" text-anchor="end">${fmtAddr(lo)} – ${fmtAddr(hi)}</text>` : '')) +
      '</g>');
    // Targets: one column per role, hanging from the bar.
    const ty = busY + 30 + 26;
    let bottom = busY + 30;
    s.columns.forEach((col, ci) => {
      const cx = X0 + ci * CW;
      const th = 64;
      if (!col.cont) parts.push(`<text class="caption role-${col.role}" x="${cx + 22}" y="${ty - 8}">${esc(ROLE_LABEL[col.role].toUpperCase())}</text>`);
      const lastMid = ty + 6 + (col.items.length - 1) * (th + 12) + th / 2;
      parts.push(`<path class="wire spine role-${col.role}" d="M${cx + 8} ${busY + 30} L${cx + 8} ${lastMid}"/>`);
      col.items.forEach((g, i) => {
        const by = ty + 6 + i * (th + 12);
        parts.push(`<path class="wire spine role-${col.role}" d="M${cx + 8} ${by + th / 2} L${cx + 22} ${by + th / 2}"/>`);
        // Its own stretch of the spine (from the block above, or the bar) and its stub take the pointer.
        const from = i === 0 ? busY + 30 : by - (th + 12) + th / 2; // the block above's middle
        const reg = regionsOf(g.base, s.bus)[0];
        const where = reg ? ` · ${fmtAddr(reg.start)} – ${fmtAddr(reg.end)}` : '';
        linkWire(`M${cx + 8} ${from} L${cx + 8} ${by + th / 2} L${cx + 22} ${by + th / 2}`, `${s.bus} → ${label(g)}${where}`, `spine role-${col.role}`, false);
        block(g, cx + 22, by, th, 'target', s.bus);
        bottom = Math.max(bottom, by + th);
      });
    });
    y = Math.max(bottom, busY + 30);
  });
  // A bus that is a target of another bus (a memory controller behind a system bus): a wire
  // down the left edge from the feeding bus's bar to its bar. Buses fed by the same bus share
  // the vertical wire; each takes the pointer on its own stretch, from the one above.
  const fedBy = new Map();
  for (const bus of buses) {
    for (const f of new Set(analysis.memoryMap.filter((m) => m.instance === bus && barY.has(m.bus)).map((m) => m.bus))) {
      if (!fedBy.has(f)) fedBy.set(f, []);
      fedBy.get(f).push(bus);
    }
  }
  const gx = X0 - 12;
  for (const [f, list] of fedBy) {
    const fy = barY.get(f) + 15;
    let prev = fy;
    for (const bus of list.sort((a, b) => barY.get(a) - barY.get(b))) {
      const ty = barY.get(bus) + 15;
      const d = `M${X0 - 6} ${fy} L${gx} ${fy} L${gx} ${ty} L${X0 - 6} ${ty}`;
      const own = prev === fy ? d : `M${gx} ${prev} L${gx} ${ty} L${X0 - 6} ${ty}`;
      parts.push(`<path class="wire bus-wire" d="${d}"/>`);
      parts.push(`<g class="bus-link"><title>${esc(f)} → ${esc(bus)}</title><path class="wire bus-wire hover-only" d="${d}"/><path class="hit" d="${own}"/></g>`);
      prev = ty;
    }
  }


  const chipsRow = (list, caption) => {
    if (!list.length) return;
    y += 26;
    parts.push(`<text class="caption" x="${X0}" y="${y + 10}">${esc(caption)}</text>`);
    y += 18;
    const per = Math.max(1, Math.floor((W - 2 * X0 + 12) / (SW + 12)));
    list.forEach((g, i) => chip(g, X0 + (i % per) * (SW + 12), y + Math.floor(i / per) * (SH + 10)));
    y += Math.ceil(list.length / per) * (SH + 10) - 10;
  };
  chipsRow(gs.filter((g) => !g.isBus && !(g.subsystem && !g.collapsed) && !firstBus(g)), buses.length ? 'NOT ON A BUS' : 'MODULES');
  chipsRow(gs.filter((g) => g.subsystem && !g.collapsed), 'SUBSYSTEMS · their modules are drawn above; ⌄ collapses one into a single block');
  const layer = signalLayer(analysis, collapsed, at, irq);
  return `<svg ${sheet.attr('diagram', `max-width:${W}px;min-width:${Math.round(W * 0.75)}px`)} viewBox="0 0 ${W} ${y + 12}" width="100%" role="img" aria-label="Platform block diagram">` +
    `<defs>${['irq', 'stream', 'signal', 'route'].map((k) => `<marker id="vp-arrow-${k}" class="arrow-${k}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z"/></marker>`).join('')}</defs>` +
    `${parts.join('')}${layer}</svg>`;
}

// ------------------------------------------------------------------ software images

const IMAGE_ROLES = ['boot', 'compute', 'periph', 'memory', 'irq', 'pcie'];

/**
 * Where the images land inside each memory region, drawn to scale: the window
 * starts at the region and covers the images (rounded up to a power of two,
 * at least 16 MiB). An arm64 kernel also shows the BSS it clears when it starts.
 */
function layoutCharts(img, memoryMap, sheet = inlineSheet) {
  const byRegion = new Map();
  for (const l of img.loaders) {
    for (const e of l.entries) {
      for (const r of e.ranges || []) {
        if (!r.region) continue;
        if (!byRegion.has(r.region)) byRegion.set(r.region, []);
        byRegion.get(r.region).push({ name: String(e.file).split('/').pop(), start: r.start, end: r.end, reserveEnd: r.reserveEnd });
      }
    }
  }
  return [...byRegion].map(([region, list]) => {
    const m = memoryMap.find((x) => `${x.instance}.${x.port}` === region);
    list.sort((a, b) => (a.start < b.start ? -1 : 1));
    const ws = m ? m.start : list[0].start;
    const used = list.reduce((hi, x) => { const e = x.reserveEnd || x.end; return e > hi ? e : hi; }, ws);
    let span = 1n << 24n;
    while (ws + span - 1n < used) span <<= 1n;
    const we = m && ws + span - 1n > m.end ? m.end : ws + span - 1n;
    const total = we - ws + 1n;
    const pct = (v) => Number(((v - ws) * 100000n) / total) / 1000;
    const top = (x) => x.reserveEnd || x.end;
    const segs = [], legend = [];
    list.forEach((x, k) => {
      const role = IMAGE_ROLES[k % IMAGE_ROLES.length];
      const clash = list.some((o) => o !== x && x.start <= top(o) && o.start <= top(x));
      const left = pct(x.start), width = Math.max(pct(x.end + 1n) - left, 0.35);
      const tip = `${x.name}: ${hex(x.start)} – ${hex(x.end)} (${fmtApprox(x.end - x.start + 1n)})`;
      segs.push(`<span ${sheet.attr(`lseg role-${role}${clash ? ' clash' : ''}`, `left:${left}%;width:${width}%`)} title="${esc(tip)}"></span>`);
      let bss = '';
      if (x.reserveEnd) {
        const l2 = pct(x.end + 1n), w2 = Math.max(pct(x.reserveEnd + 1n) - l2, 0.35);
        segs.push(`<span ${sheet.attr(`lseg bss role-${role}${clash ? ' clash' : ''}`, `left:${l2}%;width:${w2}%`)} title="${esc(`${x.name} BSS (cleared at start): up to ${hex(x.reserveEnd)}`)}"></span>`);
        bss = ` <span class="muted">+ BSS ${fmtApprox(x.reserveEnd - x.end)} to ${fmtAddr(x.reserveEnd)}</span>`;
      }
      legend.push(`<li class="role-${role}${clash ? ' clash' : ''}"><span class="swatch-dot" aria-hidden="true"></span><span class="mono">${esc(x.name)}</span>` +
        `<span class="mono muted">${fmtAddr(x.start)} – ${fmtAddr(x.end)}</span><span class="muted">${fmtApprox(x.end - x.start + 1n)}</span>${bss}${clash ? ' <span class="clash-note">overlaps</span>' : ''}</li>`);
    });
    const mid = ws + total / 2n;
    return `<div class="layout"><div class="layout-head"><span class="mono"><b>${esc(region)}</b></span>` +
      `<span class="muted">${fmtAddr(ws)} – ${fmtAddr(we)} shown${m ? ` of ${fmtSizeShort(m.size)}` : ''}</span></div>` +
      `<div class="lbar" role="img" aria-label="Images in ${esc(region)}">${segs.join('')}</div>` +
      `<div class="lticks mono"><span>${fmtAddr(ws)}</span><span>${fmtAddr(mid)}</span><span>${fmtAddr(we + 1n)}</span></div>` +
      `<ul class="llegend">${legend.join('')}</ul></div>`;
  }).join('');
}

function imagesSection(img, hasBus, memoryMap = [], sheet = inlineSheet) {
  if (!img) return '<p class="muted">No software images: the view was opened without them.</p>';
  const range = (r) => `${hex(r.start)} – ${hex(r.end)}`;
  const blocks = img.loaders.map((l) => {
    const rows = l.entries.map((e) => {
      const lands = e.ranges.length
        ? [...new Set(e.ranges.map((r) => (r.region ? r.region.split('.')[0] : 'unmapped')))].join(', ')
        : '';
      const where = e.ranges.length === 1 ? range(e.ranges[0]) : e.ranges.length > 1 ? `${e.ranges.length} segments from ${hex(e.ranges[0].start)}` : '';
      const status = e.kind === 'raw' ? '' : e.note ? e.note : e.exists === false ? 'file not found' : e.exists ? fmtApprox(e.size) : '';
      const elf = e.elf ? ` · ${esc(e.elf.machine)} ${e.elf.bits}-bit, entry ${hex(e.elf.entry)}` : '';
      if (e.kind === 'raw') {
        return `<tr class="img-row" data-orig="${e.index}" data-kind="raw"><td>inline</td>` +
          `<td colspan="2" class="muted">Defined in JSON (${esc(e.summary)}); edit it there.</td><td></td><td></td>` +
          `<td><button class="img-remove" aria-label="Remove entry ${e.index + 1}">Remove</button></td></tr>`;
      }
      const n = e.index + 1;
      return `<tr class="img-row" data-orig="${e.index}">` +
        `<td><select class="img-kind" aria-label="Type of image ${n}"><option value="bin"${e.kind === 'bin' ? ' selected' : ''}>Binary</option><option value="elf"${e.kind === 'elf' ? ' selected' : ''}>ELF</option></select></td>` +
        `<td><input class="img-file" type="text" spellcheck="false" value="${esc(e.file)}" aria-label="File of image ${n}"> <button class="img-browse" aria-label="Browse for image ${n}">Browse…</button></td>` +
        `<td><input class="img-addr" type="text" spellcheck="false" value="${esc(e.addressRaw === undefined ? '' : typeof e.addressRaw === 'object' ? '' : e.addressRaw)}" aria-label="Load address of image ${n}"${e.kind === 'elf' ? ' disabled placeholder="from ELF"' : ''}></td>` +
        `<td class="mono">${esc(where)}</td><td>${esc(lands)}<span class="muted">${lands && status ? ' · ' : ''}${esc(status)}${elf}</span></td>` +
        `<td><button class="img-remove" aria-label="Remove image ${n}">Remove</button></td></tr>`;
    }).join('');
    return `<div class="loader" data-loader="${esc(l.module)}"><p class="sub">Loader <b class="mono">${esc(l.module)}</b></p>` +
      `<div class="scroll"><table class="images"><thead><tr><th>Type</th><th>File</th><th>Load address</th><th>Occupies</th><th>Lands in</th><th></th></tr></thead>` +
      `<tbody>${rows || '<tr><td colspan="6" class="muted">Nothing is loaded yet.</td></tr>'}</tbody></table></div>` +
      `<p class="form-error" role="alert"></p><p><button class="img-add primary">Add image…</button></p></div>`;
  }).join('');
  const none = img.loaders.length === 0
    ? `<p class="muted">This platform has no loader module, so nothing is placed in memory at start.</p>` +
      (hasBus ? `<p><button class="add-loader primary">Add a loader</button></p>` : '')
    : '';
  const sym = img.symbols[0];
  const symLine = `<p class="symbols"><label for="sym">Symbol file for debugging</label> ` +
    `<input id="sym" class="img-file" type="text" readonly value="${esc(sym ? sym.file : '')}" placeholder="${img.symbolFiles.length ? 'using the loaded ELF image' : 'none (for example vmlinux)'}"> ` +
    `<button class="sym-browse">Browse…</button>${sym ? ' <button class="sym-clear">Clear</button>' : ''}</p>`;
  const charts = layoutCharts(img, memoryMap, sheet);
  return `${charts ? `<h3 class="dock-h">Memory layout at start</h3>${charts}<h3 class="dock-h">Loaders</h3>` : ''}${blocks}${none}${symLine}`;
}

// ------------------------------------------------------------------ inspector: parameters

function fmtDefault(v) {
  if (v === undefined) return '';
  if (typeof v === 'number' && Number.isInteger(v) && v >= 65536) return '0x' + v.toString(16);
  if (typeof v === 'string') return JSON.stringify(v);
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function paramInput(r) {
  const label = `aria-label="Value of ${esc(r.name)}"`;
  if (r.lua) {
    return `<input type="text" class="p-lua" readonly value="${esc('Lua: ' + r.value.$lua)}" title="${esc(r.value.$lua)}" ${label}>` +
      '<div class="muted p-note">computed in Lua; edit in JSON</div>';
  }
  const locked = r.locked ? ` disabled title="${esc(r.locked)}"` : '';
  if (r.kind === 'bool') {
    const opt = (v, text) => `<option value="${v}"${(r.set ? String(r.value) : '') === v ? ' selected' : ''}>${esc(text)}</option>`;
    return `<select class="p-input" data-kind="bool"${locked} ${label}>` + opt('', r.blankLabel) + opt('true', 'true') + opt('false', 'false') + '</select>';
  }
  const resolved = r.resolved ? `<span class="p-resolved mono">= ${esc(r.resolved)}</span>` : '';
  return `<input type="text" class="p-input${r.kind === 'json' ? ' mono' : ''}" data-kind="${r.kind}" spellcheck="false" value="${esc(r.input)}" placeholder="${esc(r.placeholder)}"${locked} ${label}>${resolved}`;
}

function paramRows(f, rows, perInstance) {
  return rows.map((r) => {
    const notes = [];
    if (r.unknown) notes.push(`<span class="warn">not a parameter of ${esc(f.type)}</span>`);
    if (r.overriddenIn.length) notes.push(`<span class="muted">overridden for ${esc(r.overriddenIn.join(', '))}</span>`);
    if (perInstance && !r.set && r.inheritedSet) notes.push('<span class="muted">same as all</span>');
    const fallback = perInstance
      ? (r.inheritedSet ? `the value for all instances (${fmtDefault(r.inherited)})` : r.hasDefault ? `the model default (${fmtDefault(r.default)})` : 'the model default')
      : (r.hasDefault ? `the model default (${fmtDefault(r.default)})` : 'the model default');
    const resetTip = `Remove ${r.name} from the JSON file; ${fallback} then applies`;
    const reset = r.set
      ? `<button class="p-reset" title="${esc(resetTip)}" aria-label="${esc(resetTip)}">${perInstance ? 'Remove override' : 'Use default'}</button>` : '';
    const meta = [r.type, r.hasDefault ? `default ${fmtDefault(r.default)}` : ''].filter(Boolean).join(' · ');
    return `<div class="p-row${r.set ? ' set' : ''}" data-name="${esc(r.name)}" data-filter="${esc((r.name + ' ' + r.description).toLowerCase())}">` +
      `<div class="p-line"><span class="p-mark" aria-hidden="true"></span><span class="mono pname">${esc(r.name)}</span>` +
      `<span class="p-meta mono" title="${esc(meta)}">${esc(meta)}</span>${reset}</div>` +
      `<div class="p-field">${paramInput(r)}</div>` +
      (notes.length ? `<div class="p-note">${notes.join(' · ')}</div>` : '') +
      (r.description ? `<div class="pdesc">${esc(r.description)}</div>` : '') +
      (r.locked ? `<div class="muted p-lock">${esc(r.locked)}</div>` : '') +
      '<div class="p-error" role="alert"></div></div>';
  }).join('');
}

function paramTable(f, rows, scope, perInstance, hidden) {
  const body = rows.length
    ? `<div class="params">${paramRows(f, rows, perInstance)}</div>`
    : '<p class="muted">No parameters.</p>';
  return `<div class="p-scope-body" data-scope="${esc(scope)}"${hidden ? ' hidden' : ''}>${body}</div>`;
}

const KIND_LABEL = { tlm_initiator: 'bus initiator', tlm_target: 'bus target', signal_out: 'signal out', signal_in: 'signal in', biflow: 'byte stream' };
// Direction of a port, as shown on its card: what flows and which way.
const DIR = {
  tlm_initiator: { cls: 'init', label: 'Initiator', glyph: '▼', tip: 'Sends bus transactions to the ports below' },
  tlm_target: { cls: 'targ', label: 'Target', glyph: '▲', tip: 'Receives bus transactions from the ports below' },
  signal_out: { cls: 'sout', label: 'Signal out', glyph: '→', tip: 'Drives the signal inputs below' },
  signal_in: { cls: 'sin', label: 'Signal in', glyph: '←', tip: 'Driven by the signal outputs below' },
  biflow: { cls: 'bidir', label: 'Stream', glyph: '⇄', tip: 'Byte stream in both directions' },
};
const dirOf = (kind) => DIR[kind] || { cls: 'other', label: kind || 'port', glyph: '·', tip: '' };

/**
 * The connections of one module, socket by socket (the Socket Inspector).
 * rows: from connect.portRows. regions: dataflow.regionsByPort (addresses of
 * bus target ports), used to show and sort the address of every peer.
 */
function connectionsList(base, rows, regions = new Map()) {
  if (!rows) return '<p class="muted">Connections are not available.</p>';
  if (!rows.length) return '<p class="muted">The component catalog does not list the ports of this type.</p>';
  const ds = (o) => `data-module="${esc(o.module)}" data-key="${esc(o.key)}" data-scope="${o.scope === null || o.scope === undefined ? '' : esc(o.scope)}"`;
  const regionOf = (inst, port) => regions.get(`${inst}.${port}`);
  const addrText = (r, raw) => {
    if (!r) return raw !== undefined ? `@ ${raw}` : '';
    const range = `${fmtAddr(r.start)} – ${fmtAddr(r.start + r.size - 1n)}`;
    return `${range} · ${fmtSizeShort(r.size)}${r.priority > 0 ? ' · background' : ''}`;
  };
  const card = (r) => {
    const d = dirOf(r.kind);
    const peers = [];
    for (const o of r.out) {
      const [pm] = String(o.bind).split('.');
      const reg = regionOf(base, o.key) || regionOf(`${base}_0`, o.key);
      const notes = [o.key !== r.name ? `as ${o.key}` : '', o.repeat !== undefined ? `×${o.repeat}` : '', o.scope !== null ? `${base}_${o.scope} only` : ''].filter(Boolean).join(' · ');
      peers.push({ sort: reg ? reg.start : null, html: `<li><span class="peer-glyph" aria-hidden="true">${d.glyph}</span><span class="peer"><a href="#" class="goto mono" data-module="${esc(pm.replace(/_\{i\}$/, ''))}">${esc(o.bind)}</a>` +
        (reg || o.address !== undefined ? `<span class="peer-addr mono" title="${esc(o.address !== undefined ? `address ${o.address}${o.size !== undefined ? `, size ${o.size}` : ''}` : '')}">${esc(addrText(reg, o.address))}</span>` : '') +
        (notes ? `<span class="muted peer-note">${esc(notes)}</span>` : '') + '</span>' +
        `<button class="unbind x" ${ds({ module: base, key: o.key, scope: o.scope })} title="Disconnect" aria-label="Disconnect ${esc(o.key)} from ${esc(o.bind)}">×</button></li>` });
    }
    for (const i of r.in) {
      const reg = regionOf(i.from, i.key) || regionOf(`${i.from}_0`, i.key);
      const notes = [i.port !== r.name ? `to ${i.port}` : '', i.repeat !== undefined ? `×${i.repeat}` : '', i.scope !== null ? `${i.from}_${i.scope} only` : ''].filter(Boolean).join(' · ');
      peers.push({ sort: reg ? reg.start : null, html: `<li><span class="peer-glyph" aria-hidden="true">${d.glyph}</span><span class="peer"><a href="#" class="goto mono" data-module="${esc(i.from)}">${esc(i.from)}.${esc(i.key)}</a>` +
        (reg ? `<span class="peer-addr mono">${esc(addrText(reg))}</span>` : '') +
        (notes ? `<span class="muted peer-note">${esc(notes)}</span>` : '') + '</span>' +
        `<button class="unbind x" ${ds({ module: i.from, key: i.key, scope: i.scope })} title="Disconnect" aria-label="Disconnect ${esc(i.from)}.${esc(i.key)}">×</button></li>` });
    }
    // A router's initiator socket lists its targets in address order: the decode table.
    if (peers.some((x) => x.sort !== null)) peers.sort((a, b) => (a.sort === null ? 1 : b.sort === null ? -1 : a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
    const head = `<div class="c-line"><span class="dir dir-${d.cls}" title="${esc(d.tip)}">${d.glyph} ${esc(d.label)}</span>` +
      `<span class="mono pname">${esc(r.name)}${r.vector ? '[ ]' : ''}</span>${r.unknown ? ' <span class="warn">not a port of this type</span>' : ''}` +
      (peers.length ? `<span class="c-count">${peers.length}</span>` : '') +
      `<button class="connect" data-module="${esc(base)}" data-port="${esc(r.name)}">Connect…</button></div>`;
    return `<div class="c-port${peers.length ? ' wired' : ''}" data-port="${esc(r.name)}">${head}` +
      (peers.length ? `<ul class="conns">${peers.map((x) => x.html).join('')}</ul>` : '') + '</div>';
  };
  const wired = rows.filter((r) => r.out.length || r.in.length);
  const free = rows.filter((r) => !r.out.length && !r.in.length);
  const groupsOf = [['Bus', (r) => /^tlm_/.test(r.kind)], ['Signals', (r) => /^signal_/.test(r.kind)], ['Other', () => true]];
  const used = new Set();
  let html = '';
  for (const [label, test] of groupsOf) {
    const list = wired.filter((r) => !used.has(r) && test(r));
    list.forEach((r) => used.add(r));
    if (list.length) html += `<div class="c-group"><div class="c-group-h">${esc(label)}</div>${list.map(card).join('')}</div>`;
  }
  if (!wired.length) html += '<p class="muted">No port of this module is connected yet.</p>';
  if (free.length) {
    html += `<details class="c-free"><summary>${free.length} unconnected port${free.length === 1 ? '' : 's'}</summary>${free.map(card).join('')}</details>`;
  }
  return html;
}

/** One target row of a decode table (Data flow). roles: Map(base -> role). */
function decodeRow(t, roles, via = {}) {
  const role = roles.get(t.base) || 'infra';
  const range = `${fmtAddr(t.start)} – ${fmtAddr(t.end)}`;
  // Hovering the row previews the route in the diagram; clicking it keeps it.
  const route = ` data-route-region="${esc(t.instance)}.${esc(t.port)}"${via.from ? ` data-route-from="${esc(via.from)}"` : ''}${via.bus ? ` data-route-bus="${esc(via.bus)}"` : ''}`;
  return `<tr class="routable${t.background ? ' bg' : ''}${t.depth ? ` d${Math.min(t.depth, 3)}` : ''}"${route} tabindex="0" title="Click to show the route in the diagram"><td class="mono" title="${esc(range)}">${esc(fmtAddr(t.start))}</td>` +
    `<td class="mono num">${esc(fmtSizeShort(t.size))}</td><td class="tgt" title="${esc(`${t.instance}.${t.port} · ${range}${t.background ? ' · background' : ''}${t.depth ? ` · via ${t.bus}` : ''}`)}"><span class="rdot role-${role}" aria-hidden="true"></span><a href="#" class="goto mono" data-module="${esc(t.base)}">${esc(t.instance)}.${esc(t.port)}</a>` +
    `${t.background ? ' <span class="muted">bg</span>' : ''}${t.depth ? ` <span class="muted">via ${esc(t.bus)}</span>` : ''}</td></tr>`;
}

const DECODE_HEAD = '<colgroup><col class="c-addr"><col class="c-size"><col></colgroup><thead><tr><th>Address</th><th class="num">Size</th><th>Target</th></tr></thead>';

/**
 * The Data flow tab: where this module's bus transactions go (an initiator),
 * who reaches it and at which address (a target), or both for a router.
 * a: core.analyze result; roles: Map(base -> role).
 */
function dataFlowPane(a, base, roles) {
  const df = require('./dataflow');
  const parts = [];
  const chip = (x, region) => `<a href="#" class="goto chip mono" data-module="${esc(x.base)}"${region ? ` data-route-region="${esc(region)}" data-route-from="${esc(x.base)}"` : ''}>${esc(x.base)}.${esc(x.port)}${x.count > 1 ? ` ×${x.count}` : ''}</a>`;
  if (a.buses.includes(base)) {
    const ini = df.busInitiators(a, base);
    const dec = df.decode(a, base);
    parts.push(`<div class="flow-block"><div class="flow-h">Initiators on ${esc(base)}</div>` +
      (ini.length ? `<div class="chips">${ini.map((x) => chip(x)).join('')}</div>` : '<p class="muted">No initiator drives this router.</p>') + '</div>');
    parts.push(`<div class="flow-block"><div class="flow-h">Address decode <span class="count">${dec.length}</span></div>` +
      (dec.length ? `<table class="decode">${DECODE_HEAD}<tbody>${dec.map((t) => decodeRow(t, roles, { bus: base })).join('')}</tbody></table>` : '<p class="muted">No target has an address on this router.</p>') +
      '<p class="muted flow-note">When ranges overlap, the lower priority number answers; background ranges answer only where nothing else does.</p></div>');
    return parts.join('');
  }
  for (const r of df.reachFrom(a, base)) {
    parts.push(`<div class="flow-block"><div class="flow-h"><span class="mono">${esc(r.port)}</span>${r.instances > 1 ? ` ×${r.instances}` : ''} <span class="flow-arrow">→</span> ` +
      `<a href="#" class="goto mono" data-module="${esc(r.bus)}">${esc(r.bus)}</a> <span class="muted">reaches</span> <span class="count">${r.targets.length}</span></div>` +
      (r.targets.length ? `<table class="decode">${DECODE_HEAD}<tbody>${r.targets.map((t) => decodeRow(t, roles, { from: base, bus: r.bus })).join('')}</tbody></table>` : '<p class="muted">Nothing has an address on this router.</p>') + '</div>');
  }
  const by = df.reachedBy(a, base);
  if (by.length) {
    parts.push('<div class="flow-block"><div class="flow-h">Reached from</div>' + by.map((r) =>
      `<div class="reach"><div class="reach-h routable" data-route-region="${esc(r.instance)}.${esc(r.port)}" data-route-bus="${esc(r.bus)}" tabindex="0" title="Click to show the route in the diagram"><span class="mono">${esc(r.instance)}.${esc(r.port)}</span> <span class="mono addr">${esc(fmtAddr(r.start))} – ${esc(fmtAddr(r.end))}</span>` +
      ` <span class="muted">via ${r.path.map((b) => `<a href="#" class="goto mono" data-module="${esc(b)}">${esc(b)}</a>`).join(' › ')}${r.priority > 0 ? ' · background' : ''}</span></div>` +
      `<div class="chips">${r.initiators.map((x) => chip(x, `${r.instance}.${r.port}`)).join('')}</div></div>`).join('') + '</div>');
  }
  if (!parts.length) return '<p class="muted">This module takes no part in bus transactions.</p>';
  return parts.join('');
}

/**
 * The inspector panels, one per module (hidden until selected).
 * subs: Map(container path -> { collapsed, contents: [module paths directly inside] }).
 * info: Map(base -> { role, facts: [[label, value]] }).
 */
function paramsSection(forms, conns, subs = new Map(), info = new Map(), flow = null) {
  if (!forms || forms.size === 0) return '';
  return [...forms.values()].map((f) => {
    const sub = subs.get(f.base);
    const about = info.get(f.base) || { role: sub ? 'subsystem' : roleOf({ type: f.type }), facts: [] };
    const role = about.role;
    const replicated = f.scopes.length > 0;
    const scopeSel = replicated
      ? `<label class="p-scope-label">Applies to <select class="p-scope" aria-label="Which instances of ${esc(f.base)} the values apply to">` +
        `<option value="all">all ${f.count} instances</option>` +
        f.scopes.map((s) => `<option value="${esc(s.index)}">${esc(s.name)} only</option>`).join('') + '</select></label>'
      : '';
    const scopeHelp = replicated
      ? '<p class="muted p-scope-help" data-for="one" hidden>Values set here apply to this instance only (perIndex in the JSON). An empty field uses the value for all instances.</p>'
      : '';
    const filter = f.rows.length > 8
      ? `<input type="search" class="p-filter" placeholder="Filter parameters" aria-label="Filter parameters of ${esc(f.base)}">` : '';
    const setCount = f.rows.filter((r) => r.set).length;
    const facts = about.facts.length
      ? `<div class="facts">${about.facts.map(([k, v, tip]) => `<div class="fact"><div class="fact-k">${esc(k)}</div><div class="fact-v mono" title="${esc(tip || v)}">${esc(v)}</div></div>`).join('')}</div>` : '';
    const nConn = conns && conns.get(f.base) ? conns.get(f.base).reduce((n, r) => n + r.out.length + r.in.length, 0) : 0;
    const tabs = sub ? '' :
      `<div class="itabs" role="tablist"><button class="itab" role="tab" data-tab="params">Parameters <span class="count">${f.rows.length}</span></button>` +
      `<button class="itab" role="tab" data-tab="conns">Connections <span class="count">${nConn}</span></button>` +
      (flow && flow.has(f.base) ? '<button class="itab" role="tab" data-tab="flow">Data flow</button>' : '') + '</div>';
    return `<section class="mod-panel" data-panel="${esc(f.base)}" hidden>` +
      `<div class="insp-head"><span class="insp-icon role-${role}" aria-hidden="true">${ROLE_GLYPH[role] || '·'}</span>` +
      `<div class="insp-title"><h2 class="mono">${esc(f.base)}</h2><div class="muted">${esc(f.type)} · ${esc(ROLE_LABEL[role] || role)}${replicated ? ` · ${f.count} instances` : ''}</div></div></div>` +
      facts + (scopeSel ? `<div class="insp-row">${scopeSel}</div>` : '') + scopeHelp +
      `<div class="insp-actions"><button class="show-json" data-module="${esc(f.base)}">Show in JSON</button>` +
      (sub ? `<button class="toggle-sub" data-module="${esc(f.base)}">${sub.collapsed ? 'Expand' : 'Collapse'}</button>` +
        `<button class="add-module" data-container="${esc(f.base)}">Add module here…</button>` : '') +
      (sub ? '' : `<button class="swap-module" data-module="${esc(f.base)}" title="Change the model type, keeping its connections where the new type has the same ports">Replace model…</button>`) +
      `<button class="delete-module danger" data-module="${esc(f.base)}">${sub ? 'Delete subsystem' : 'Delete module'}</button></div>` +
      (sub ? `<p class="insp-sub">Subsystem with ${sub.contents.length ? sub.contents.map((m) => `<a href="#" class="goto mono" data-module="${esc(m)}">${esc(m.slice(f.base.length + 1))}</a>`).join(', ') : 'no modules yet'}.</p>` : '') +
      tabs +
      `<div class="itab-body" data-tab="params">` +
      // A subsystem's own parameters belong to QBox's Container type and are rarely needed: folded away.
      (sub ? `<details class="advanced" data-panel="${esc(f.base)}"${setCount ? ' open' : ''}><summary>Advanced: Container settings <span class="count">${f.rows.length}</span>${setCount ? ` <span class="adv-set">${setCount} set</span>` : ''}</summary>` +
        '<p class="muted adv-note">These are settings of QBox\'s Container type itself, for ports the Container would offer to the outside. VP Studio connects the modules inside directly, so they normally keep their defaults; <span class="mono">moduletype</span> must stay "Container".</p>' : '') +
      `<div class="p-legend"><span><span class="p-mark on" aria-hidden="true"></span>set in this platform (${setCount})</span><span><span class="p-mark" aria-hidden="true"></span>model default</span>${filter}</div>` +
      (f.note ? `<p class="muted">${esc(f.note)}</p>` : '') +
      paramTable(f, f.rows, 'all', false, false) +
      f.scopes.map((s) => paramTable(f, s.rows, s.index, true, true)).join('') +
      '<p class="muted p-none" hidden>No parameter matches the filter.</p>' + (sub ? '</details>' : '') + '</div>' +
      (sub ? '' : `<div class="itab-body" data-tab="conns" hidden>${connectionsList(f.base, conns && conns.get(f.base), flow ? flow.regions : undefined)}</div>`) +
      (!sub && flow && flow.has(f.base) ? `<div class="itab-body" data-tab="flow" hidden>${flow.pane(f.base)}</div>` : '') +
      '</section>';
  }).join('');
}

/**
 * subsystems: Map(container path -> { collapsed, contents }).
 */
function subsystems(analysis, collapsed = new Set()) {
  const out = new Map();
  for (const i of analysis.instances) if (i.isContainer) out.set(i.name, { collapsed: collapsed.has(i.name), contents: [] });
  for (const i of analysis.instances) {
    if (i.container && out.has(i.container) && (i.index === null || i.index === 0)) out.get(i.container).contents.push(i.base);
  }
  return out;
}

// ------------------------------------------------------------------ summary and facts

/** Key figures for the strip under the header: [{ role, label, value, sub }]. */
function summary(doc, a, gs, img) {
  const out = [];
  const cpus = gs.filter((g) => g.role === 'compute' && !g.subsystem);
  if (cpus.length) {
    out.push({ role: 'compute', label: 'Compute', value: cpus.map((g) => `${g.count} × ${cpuLabel(g.type)}`).join(' + '), sub: [...new Set(cpus.map((g) => g.type))].join(', ') });
  }
  const roleByBase = new Map(gs.map((g) => [g.base, g.role]));
  const instRole = (base) => roleByBase.get(base) || roleOf({ type: (a.instances.find((i) => i.base === base) || {}).type });
  const ram = a.memoryMap.filter((m) => m.priority === 0 && instRole(m.base) === 'memory');
  if (ram.length) {
    const total = ram.reduce((n, m) => n + m.size, 0n);
    out.push({ role: 'memory', label: 'Memory', value: fmtSizeShort(total), sub: `@ ${fmtAddr(ram[0].start)}${ram.length > 1 ? ` · ${ram.length} regions` : ''}` });
  }
  if (a.memoryMap.length) {
    out.push({ role: 'bus', label: 'Address map', value: `${a.memoryMap.length} region${a.memoryMap.length === 1 ? '' : 's'}`, sub: `${a.buses.length} bus${a.buses.length === 1 ? '' : 'es'} · ${clip(a.buses.join(', '), 28)}` });
  }
  const irqs = gs.filter((g) => g.role === 'irq' && !g.subsystem);
  if (irqs.length) {
    const labels = interruptLabels(a);
    const inst = a.instances.find((i) => i.base === irqs[0].base);
    const spi = inst && inst.mod && inst.mod.params && typeof inst.mod.params.num_spi === 'number' ? ` · ${inst.mod.params.num_spi} SPI` : '';
    out.push({ role: 'irq', label: 'Interrupts', value: `${irqs[0].type}${spi}`, sub: `${labels.size} source${labels.size === 1 ? '' : 's'} wired` });
  }
  if (img) {
    const files = img.loaders.flatMap((l) => l.entries.filter((e) => e.kind !== 'raw'));
    if (files.length) out.push({ role: 'boot', label: 'Software', value: `${files.length} image${files.length === 1 ? '' : 's'}`, sub: clip(files.map((e) => String(e.file).split('/').pop()).join(' · '), 40) });
  }
  const ports = (doc.variables || []).filter((v) => v.hostPort);
  if (ports.length) {
    const name = (v) => v.name.replace(/^HOST_PORT_/, '').toLowerCase();
    out.push({ role: 'periph', label: 'Host ports', value: `${name(ports[0])} ${ports[0].value}`, sub: ports.slice(1, 3).map((v) => `${name(v)} ${v.value}`).join(' · ') + (ports.length > 3 ? ` · +${ports.length - 3} more` : '') });
  }
  return out;
}

/** Per module: its role and the facts shown at the top of the inspector. */
function moduleInfo(a, gs) {
  const irq = interruptLabels(a);
  const lines = interruptLines(a);
  const info = new Map();
  for (const g of gs) {
    const facts = [];
    const regions = a.memoryMap.filter((m) => m.base === g.base);
    if (regions.length === 1) {
      facts.push(['Address', fmtAddr(regions[0].start)], ['Size', fmtSizeShort(regions[0].size)]);
    } else if (regions.length > 1) {
      facts.push(['Address', fmtAddr(regions[0].start)], ['Regions', `${regions.length} · ${fmtSizeShort(regions.reduce((n, m) => n + m.size, 0n))}`]);
    }
    if (irq.has(g.base)) facts.push(['Interrupt', irq.get(g.base), lines.get(g.base).join('\n')]);
    if (g.count > 1) facts.push(['Instances', `${g.base}_0 … ${g.base}_${g.count - 1}`]);
    const buses = [...g.on.keys()];
    if (buses.length && !g.isBus) facts.push(['Bus', buses.join(', ')]);
    if (g.isBus) {
      const n = a.memoryMap.filter((m) => m.bus === g.base).length;
      facts.push(['Regions', String(n)]);
    }
    if (regions.length && regions.every((r) => r.priority > 0)) facts.push(['Priority', `${regions[0].priority} (background)`]);
    info.set(g.base, { role: g.role, facts: facts.slice(0, 6) });
  }
  return info;
}

/** The modules by role, for the outline on the left. */
function outline(gs) {
  const by = new Map();
  for (const g of gs) {
    if (!by.has(g.role)) by.set(g.role, []);
    by.get(g.role).push(g);
  }
  return ROLE_ORDER.filter((r) => by.has(r)).map((r) => {
    const list = by.get(r);
    const n = list.reduce((s, g) => s + (g.subsystem ? 1 : g.count), 0);
    const items = list.map((g) => {
      const local = g.container ? g.base.slice(g.container.length + 1) : g.base;
      const suffix = g.count > 1 ? `×${g.count}` : g.subsystem ? (g.collapsed ? 'collapsed' : 'open') : '';
      return `<button class="ol-item role-${r}" data-module="${esc(g.base)}" data-filter="${esc((g.base + ' ' + g.type).toLowerCase())}" title="${esc(g.base)} (${esc(g.type)})">` +
        `<span class="mono ol-name">${esc(g.container ? `${g.container} › ${local}` : local)}</span>${suffix ? `<span class="ol-suffix">${esc(suffix)}</span>` : ''}</button>`;
    }).join('');
    return `<div class="ol-group"><div class="ol-head role-${r}"><span class="swatch-dot" aria-hidden="true"></span>${esc(ROLE_LABEL[r])}<span class="ol-count">${n}</span></div>${items}</div>`;
  }).join('');
}

// ------------------------------------------------------------------ device tree tab

/**
 * The Device tree tab, sent by the extension when the tab opens or the choice changes.
 * r: { candidates: [{ id, label }], against, notes: [{ level, text }], text (the generated DTS),
 *      result?: { ops, normalized }, oldLabel?, error? }
 */
function deviceTreePane(r) {
  const opts = [{ id: 'none', label: 'Nothing: show the generated DTS' }].concat(r.candidates)
    .map((c) => `<option value="${esc(c.id)}"${c.id === r.against ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
  let stats = '';
  let body;
  if (r.error) {
    body = `<p class="dt-error">${esc(r.error)}</p>`;
  } else if (r.result) {
    const { ops, normalized } = r.result;
    const how = normalized
      ? 'Both sides compiled and decompiled with dtc, nodes and properties sorted; labels and comments are not compared.'
      : 'Compared as text.';
    if (!ops) {
      body = `<p class="muted">The two device trees are too different to compare line by line.</p>`;
    } else {
      const h = hunks(ops, 3);
      stats = h.added || h.removed ? `<span class="dt-add">+${h.added}</span> <span class="dt-del">−${h.removed}</span>` : '<span class="ok">no differences</span>';
      const rows = h.parts.map((p) => (p.skip
        ? `<tr class="skip"><td colspan="3">⋯ ${p.skip} unchanged line${p.skip === 1 ? '' : 's'}</td></tr>`
        : p.lines.map((l) => `<tr class="${l.op === '+' ? 'add' : l.op === '-' ? 'del' : 'same'}"><td class="ln">${l.a === null ? '' : l.a}</td><td class="ln">${l.b === null ? '' : l.b}</td>` +
          `<td class="src"><span class="sign">${l.op === ' ' ? '' : l.op === '-' ? '−' : '+'}</span>${esc(l.text)}</td></tr>`).join(''))).join('');
      body = `<p class="muted dt-legend"><span class="dt-del">−</span> ${esc(r.oldLabel || 'the file')} · <span class="dt-add">+</span> generated from this platform now. ${how}</p>` +
        (h.added || h.removed ? `<div class="dt-code"><table class="dt">${rows}</table></div>` : '<p class="ok">The platform generates the same device tree.</p>');
    }
  } else {
    const rows = String(r.text || '').replace(/\n$/, '').split('\n').map((t, k) => `<tr class="same"><td class="ln">${k + 1}</td><td class="src">${esc(t)}</td></tr>`).join('');
    body = `<div class="dt-code"><table class="dt">${rows}</table></div>`;
  }
  const notes = (r.notes || []).length
    ? `<ul class="dt-notes">${r.notes.map((n) => `<li class="${n.level === 'warning' ? 'warning' : 'info'}"><b>${n.level === 'warning' ? 'warning' : 'note'}</b> ${esc(n.text)}</li>`).join('')}</ul>` : '';
  return `<div class="dt-bar"><label>Compare with <select class="dt-against" aria-label="Device tree to compare with">${opts}</select></label>` +
    `<span class="dt-stats">${stats}</span><button class="dt-write" title="Write the generated DTS and compile it to the DTB (Generate Device Tree)">Write DTS and DTB</button></div>` +
    notes + body;
}

// ------------------------------------------------------------------ page



/**
 * opts.select: module to select once rendered (for example one just added).
 * opts.collapsed: Set of subsystems drawn as one block.
 * opts.connections: Map(base -> connect.portRows) for the inspector.
 * opts.route: { id, spec } a transaction route to show (from the trace panel);
 *   spec as dataflow.routeFor takes it, plus detail (a line of text).
 */
function render(doc, analysis, nonce, cspSource, img, forms, opts = {}) {
  const a = img ? Object.assign({}, analysis, { problems: analysis.problems.concat(img.problems) }) : analysis;
  const collapsed = opts.collapsed || new Set();
  const gs = groups(a, collapsed);
  const roleByBase = new Map(gs.map((g) => [g.base, g.role]));
  const roleFor = (base) => roleByBase.get(base) || 'infra';
  const sheet = makeSheet();
  const mm = a.memoryMap.map((m) =>
    `<tr data-module="${esc(m.base)}" data-region="${esc(m.instance)}.${esc(m.port)}"><td class="mono">${hex(m.start)}</td><td class="mono">${hex(m.end)}</td><td class="num mono">${fmtSize(m.size)}</td>` +
    `<td><span class="row-mod role-${roleFor(m.base)}"><span class="swatch-dot" aria-hidden="true"></span><span class="mono">${esc(m.instance)}</span></span></td><td class="mono muted">${esc(m.port)}</td><td class="mono muted">${esc(m.bus)}</td><td class="num">${m.priority}</td></tr>`).join('');
  // Address bar: the regions in address order, widths on a log scale so small devices stay visible.
  const sorted = [...a.memoryMap].filter((m) => m.priority === 0).sort((x, y) => (x.start < y.start ? -1 : 1));
  const bar = sorted.map((m) => {
    const w = Math.max(1, Math.log2(Number(m.size)) - 10);
    return `<span ${sheet.attr(`seg role-${roleFor(m.base)}`, `flex:${w.toFixed(2)}`)} data-module="${esc(m.base)}" title="${esc(m.instance)}.${esc(m.port)}: ${hex(m.start)} – ${hex(m.end)} (${fmtSize(m.size)})">${w >= 6 ? esc(clip(m.instance, Math.round(w * 1.6))) : ''}</span>`;
  }).join('');
  const regionsJson = JSON.stringify(a.memoryMap.map((m) => ({ start: hex(m.start), end: hex(m.end), instance: m.instance, base: m.base, port: m.port, bus: m.bus, priority: m.priority })))
    .replace(/</g, '\\u003c');
  const routesJson = JSON.stringify(require('./dataflow').routeTable(a)).replace(/</g, '\\u003c');
  const bus = new Set(a.buses);
  const sigList = a.connections.filter((c) => !bus.has(c.to));
  const sig = sigList.map((c) =>
    `<tr data-module="${esc(c.fromBase)}"><td class="mono">${esc(c.from)}</td><td class="mono muted">${esc(c.fromPort)}</td><td class="mono">${esc(c.to)}</td><td class="mono muted">${esc(c.toPort)}</td></tr>`).join('');
  const errors = a.problems.filter((p) => p.severity === 'error').length;
  const warnings = a.problems.filter((p) => p.severity === 'warning').length;
  const probs = a.problems.length
    ? '<ul class="problems">' + a.problems.map((p) => `<li class="${p.severity}" data-module="${esc(p.module || '')}"><b>${p.severity}</b> ${esc(p.message)}</li>`).join('') + '</ul>'
    : '<p class="ok">No problems found.</p>';
  const vars = (doc.variables || []).map((v) => {
    const n = a.env[v.name];
    const shown = typeof v.value === 'object' ? JSON.stringify(v.value) : String(v.value);
    return `<tr><td class="mono">${esc(v.name)}</td><td class="mono">${esc(shown)}</td><td class="mono muted">${n !== null && n !== undefined ? hex(n) : ''}</td>` +
      `<td class="muted">${v.hostPort ? 'host port' : v.overridable ? 'overridable' : v.global ? 'global' : 'local'}</td></tr>`;
  }).join('');
  const status = errors
    ? `<button class="status bad" data-dock-open="problems">${errors} error${errors === 1 ? '' : 's'}${warnings ? ` · ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}</button>`
    : warnings
      ? `<button class="status warn" data-dock-open="problems">${warnings} warning${warnings === 1 ? '' : 's'}</button>`
      : `<button class="status good" data-dock-open="problems"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2l2.3 2.3 4.7-5"/></svg>Valid · no problems</button>`;
  const stats = summary(doc, a, gs, img).map((s) =>
    `<div class="stat role-${s.role}"><div class="stat-label"><span class="swatch-dot" aria-hidden="true"></span>${esc(s.label)}</div>` +
    `<div class="stat-value">${esc(s.value)}</div><div class="stat-sub mono">${esc(s.sub)}</div></div>`).join('');
  const roles = new Map(gs.map((g) => [g.base, g.role]));
  const dfl = require('./dataflow');
  const flow = { regions: dfl.regionsByPort(a), has: (b) => dfl.hasDataFlow(a, b), pane: (b) => dataFlowPane(a, b, roles) };
  const panels = paramsSection(forms, opts.connections, subsystems(a, collapsed), moduleInfo(a, gs), flow);
  const dtab = (id, label, count, extra = '') => `<button class="dtab" role="tab" data-dock="${id}">${esc(label)}${count === '' ? '' : `<span class="count${extra}">${count}</span>`}</button>`;
  const nImages = img ? img.loaders.reduce((n, l) => n + l.entries.length, 0) : 0;
  const diagramHtml = diagram(a, collapsed, sheet);
  const imagesHtml = imagesSection(img, a.buses.length > 0, a.memoryMap, sheet);

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.name)}</title>
<style nonce="${nonce}">
${theme.css}
tr[data-module]{cursor:pointer}tr[data-module]:hover td{background:var(--vscode-list-hoverBackground)}

/* ---- layout */
.app{display:grid;grid-template-columns:212px minmax(0,1fr) 352px;grid-template-areas:"head head head" "stats stats stats" "nav main insp";min-height:100vh}
.head{grid-area:head}.stats{grid-area:stats}.outline{grid-area:nav}.main{grid-area:main}.inspector{grid-area:insp}

/* ---- outline */
.outline{border-right:1px solid var(--vp-border);background:var(--vp-panel);padding:12px 10px;position:sticky;top:0;align-self:start;max-height:100vh;overflow:auto;display:flex;flex-direction:column;gap:12px}
.ol-filter{width:100%}
.ol-group{display:flex;flex-direction:column;gap:1px}
.ol-head{display:flex;align-items:center;gap:8px;font-size:11.5px;font-weight:600;padding:0 6px 4px;color:var(--vscode-foreground)}
.ol-count{margin-left:auto;color:var(--vp-muted);font-weight:500}
.ol-item{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%;height:26px;padding:0 8px 0 22px;border:0;border-radius:5px;text-align:left}
.ol-name{font-size:12px;overflow:hidden;text-overflow:ellipsis}.ol-suffix{color:var(--vp-muted);font-size:11px}
.ol-item.selected{background:var(--vscode-list-activeSelectionBackground,var(--vscode-list-hoverBackground));color:var(--vscode-list-activeSelectionForeground,inherit)}

/* ---- main: diagram and dock */
.main{min-width:0;display:flex;flex-direction:column}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:8px 20px;border-bottom:1px solid var(--vp-border)}
.toolbar h2{font-size:13px}.hint{color:var(--vp-muted);font-size:12px;margin-left:auto;line-height:22px}
.canvas{padding:16px 20px 18px;overflow-x:auto}
svg.diagram{display:block}
.node{cursor:pointer}.node:focus{outline:none}
.node rect.box{fill:var(--vp-card);stroke:var(--vp-border);stroke-width:1}
.node:hover rect.box{stroke:var(--rc,var(--vscode-focusBorder))}
.node:focus-visible rect.box{stroke:var(--vscode-focusBorder);stroke-width:2}
.node.selected rect.box{stroke:var(--rc,var(--vscode-focusBorder));stroke-width:2.2;fill:color-mix(in srgb,var(--rc,var(--vp-accent)) 9%,var(--vp-card))}
.node.drop rect.box{stroke:var(--vscode-focusBorder);stroke-width:3}
.node rect.swatch{fill:var(--rc,var(--vp-infra))}
.node rect.core{fill:color-mix(in srgb,var(--rc) 22%,transparent);stroke:color-mix(in srgb,var(--rc) 65%,transparent);stroke-width:1}
.node.subsystem rect.box{stroke-dasharray:6 3;stroke-width:1.4}
.node.other rect.box{fill:transparent;stroke-dasharray:4 3}
.node.bus rect.box{fill:color-mix(in srgb,var(--vp-bus) 14%,transparent);stroke:color-mix(in srgb,var(--vp-bus) 55%,transparent)}
.node.bus.selected rect.box{stroke:var(--vp-bus)}
.node.bus text.name{fill:var(--vp-bus);font-family:var(--vp-mono)}
text{fill:var(--vscode-foreground);font-size:12px}
text.name{font-weight:600;font-family:var(--vp-mono);font-size:12.5px}text.name.small{font-size:11.5px}
text.type{fill:var(--vp-muted);font-size:11px}
text.facts{font-family:var(--vp-mono);font-size:11px;fill:var(--vp-muted)}
text.badge{font-family:var(--vp-mono);font-size:10.5px;fill:var(--rc,var(--vp-muted))}
text.bus-info{fill:var(--vp-bus);font-size:11.5px;opacity:.85;font-family:var(--vp-mono)}
text.caption{fill:var(--vp-muted);font-size:10.5px;letter-spacing:.09em}
text.caption[class*=role-]{fill:var(--rc)}
.wire{fill:none;stroke:var(--vp-muted);stroke-width:1.5;opacity:.7}
.wire.bus-wire{stroke:var(--vp-bus);opacity:.55}
.bus-link .hit{fill:none;stroke:transparent;stroke-width:12;pointer-events:stroke;cursor:default}.bus-link:hover .wire{opacity:1;stroke-width:2.5}
.bus-link .wire.hover-only{opacity:0}.bus-link:hover .wire.hover-only{opacity:1}
.wire.spine{stroke:var(--rc);opacity:.55;stroke-width:2}
.sub-toggle{cursor:pointer}.sub-toggle rect{fill:color-mix(in srgb,var(--vp-subsystem) 16%,var(--vp-card));stroke:color-mix(in srgb,var(--vp-subsystem) 60%,transparent);stroke-width:1}
.sub-toggle path{fill:none;stroke:var(--vscode-foreground);stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.sub-toggle:hover rect,.sub-toggle:focus-visible rect{fill:color-mix(in srgb,var(--vp-accent) 25%,var(--vp-card));stroke:var(--vp-accent)}.sub-toggle:focus{outline:none}
.sig path{fill:none;stroke-width:1.7}.sig text{font-family:var(--vp-mono);font-size:10.5px;paint-order:stroke;stroke:var(--vp-bg);stroke-width:3px;stroke-linejoin:round}
.sig{opacity:0;pointer-events:none;transition:opacity .12s}.sig-irq path{stroke:var(--vp-irq)}.sig-irq text{fill:var(--vp-irq)}
.sig-stream path{stroke:var(--vp-accent);stroke-dasharray:5 3}.sig-stream text{fill:var(--vp-accent)}.sig-signal path{stroke:var(--vp-muted)}.sig-signal text{fill:var(--vp-muted)}
marker.arrow-irq path{fill:var(--vp-irq)}marker.arrow-stream path{fill:var(--vp-accent)}marker.arrow-signal path{fill:var(--vp-muted)}
body.sig-all .sig{opacity:.3}body.sig-all .sig text{opacity:0}.sig.on{opacity:1!important}.sig.on text{opacity:1!important}body.sig-off .sig{opacity:0!important}
.sig-mode{display:inline-flex;align-items:center;gap:0;border:1px solid var(--vp-border);border-radius:6px;overflow:hidden;margin-left:8px}
.sig-mode-label{font-size:11.5px;color:var(--vp-muted);padding:0 8px}.sig-btn{border:0;border-left:1px solid var(--vp-border);border-radius:0;height:24px;font-size:11.5px;padding:0 9px;color:var(--vp-muted)}
.sig-btn[aria-pressed=true]{background:color-mix(in srgb,var(--vp-accent) 16%,transparent);color:var(--vscode-foreground)}
.sig-legend{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--vp-muted)}.lg{display:inline-block;width:16px;height:0;border-top:2px solid;margin-left:6px}
.lg-irq{border-color:var(--vp-irq)}.lg-stream{border-color:var(--vp-accent);border-top-style:dashed}.lg-signal{border-color:var(--vp-muted)}
.drag-line{stroke:var(--vscode-focusBorder);stroke-width:2;stroke-dasharray:5 3;pointer-events:none}
.add-row{padding:0 20px 14px}

.dock{border-top:1px solid var(--vp-border);background:var(--vp-panel);margin-top:auto}
.dtabs,.itabs{display:flex;flex-wrap:wrap;gap:2px;padding:0 14px;border-bottom:1px solid var(--vp-border)}
.dtab,.itab{height:36px;border:0;border-bottom:2px solid transparent;border-radius:0;padding:0 10px;color:var(--vp-muted);display:inline-flex;align-items:center;gap:6px}
.dtab:hover,.itab:hover{background:transparent;color:var(--vscode-foreground)}
.dtab.on,.itab.on{color:var(--vscode-foreground);border-bottom-color:var(--vp-accent)}
.dock-body{padding:14px 20px 20px}
.addrbar{display:flex;height:26px;border-radius:5px;overflow:hidden;border:1px solid var(--vp-border);margin-bottom:12px}
.seg{min-width:4px;display:block;text-align:center;line-height:24px;text-overflow:ellipsis;font-family:var(--vp-mono);font-size:10.5px;font-weight:600;white-space:nowrap;overflow:hidden;color:var(--vp-bg);background:var(--rc);border-right:1px solid var(--vp-bg);cursor:pointer;padding:0 3px}
.seg:last-child{border-right:0}
.row-mod{display:inline-flex;align-items:center;gap:7px}
.problems{padding-left:18px;margin:0}.problems li{margin:4px 0;cursor:pointer}
.error b{color:var(--vscode-errorForeground)}.warning b{color:var(--vscode-editorWarning-foreground)}.info b{color:var(--vscode-editorInfo-foreground)}
.ok{color:var(--vp-good);margin:0}
.sub{color:var(--vp-muted);margin:0 0 8px}
table.images td{padding:5px 8px 5px 0;vertical-align:middle}
input.img-file{width:230px}input.img-addr{width:170px}table.images td:nth-child(5){white-space:normal;min-width:110px}
.loader{margin-bottom:12px}.form-error{color:var(--vscode-errorForeground);margin:4px 0}.form-error:empty{display:none}
.symbols{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:8px 0 0}.symbols input{width:300px}

/* ---- inspector */
.inspector{border-left:1px solid var(--vp-border);background:var(--vp-panel);position:sticky;top:0;align-self:start;max-height:100vh;overflow:auto}
.multi-list{list-style:none;margin:0;padding:0 18px 12px;font-size:12.5px;display:flex;flex-direction:column;gap:3px}
.node.multi rect.box{stroke:var(--vp-accent);stroke-width:2;stroke-dasharray:5 3}.ol-item.multi{outline:1px dashed var(--vp-accent);outline-offset:-1px}
.insp-empty{padding:22px 20px;color:var(--vp-muted);line-height:1.5}
.insp-empty h2{font-size:13px;color:var(--vscode-foreground);margin-bottom:6px}
.insp-head{display:flex;align-items:center;gap:10px;padding:16px 18px 10px}
.insp-icon{width:34px;height:34px;flex:none;border-radius:8px;display:flex;align-items:center;justify-content:center;font-family:var(--vp-mono);font-weight:600;font-size:14px;color:var(--rc);background:color-mix(in srgb,var(--rc) 13%,transparent);border:1px solid color-mix(in srgb,var(--rc) 45%,transparent)}
.insp-title{min-width:0}.insp-title h2{font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.insp-title .muted{font-size:12px}
.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;padding:0 18px 10px}
.fact{background:var(--vp-bg);border:1px solid var(--vp-border);border-radius:6px;padding:6px 9px;min-width:0}
.fact-k{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--vp-muted)}
.fact-v{font-size:12px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.insp-row{padding:0 18px 10px}.p-scope-label{display:flex;align-items:center;gap:10px;color:var(--vp-muted);font-size:12px}.p-scope{flex:1}
.p-scope-help{padding:0 18px;margin:0 0 10px;font-size:12px}
.insp-actions{display:flex;flex-wrap:wrap;gap:6px;padding:0 18px 12px}
.insp-sub{padding:0 18px;margin:0 0 12px}
.itab-body{padding:10px 12px 16px}
details.advanced{border:1px solid var(--vp-border);border-radius:6px;background:var(--vp-bg);padding:0 4px}
details.advanced>summary{cursor:pointer;padding:8px 6px;font-size:12px;color:var(--vp-muted);display:flex;align-items:center;gap:8px;list-style:none}
details.advanced[open]>summary{border-bottom:1px solid var(--vp-border);margin-bottom:8px}
details.advanced>summary::-webkit-details-marker{display:none}details.advanced>summary::before{content:'▸';color:var(--vp-muted);width:10px}details.advanced[open]>summary::before{content:'▾'}details.advanced>summary:hover{color:var(--vscode-foreground)}
.adv-set{color:var(--vp-accent);font-size:11.5px}.adv-note{font-size:11.5px;line-height:1.45;margin:0 6px 10px}
.p-legend{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;padding:0 6px 8px;font-size:11.5px;color:var(--vp-muted)}
.p-legend>span{display:inline-flex;align-items:center;gap:6px}.p-filter{margin-left:auto;width:150px;height:26px}
.p-mark{width:7px;height:7px;border-radius:50%;flex:none;border:1px solid var(--vp-muted);display:inline-block}
.p-mark.on,.p-row.set .p-mark{background:var(--vp-accent);border-color:var(--vp-accent)}
.p-row{padding:8px 8px 9px;border-radius:6px;display:flex;flex-direction:column;gap:5px}
.p-row.set{background:color-mix(in srgb,var(--vp-accent) 7%,transparent)}
.p-line{display:flex;align-items:center;gap:8px;min-width:0}
.pname{font-size:12px;color:var(--vp-muted)}.p-row.set .pname,.c-port .pname{font-weight:600;color:var(--vscode-foreground)}
.p-meta{margin-left:auto;font-size:10.5px;color:var(--vp-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.p-reset{height:22px;padding:0 7px;font-size:11px;flex:none}
.p-field{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}.p-field .p-note{flex-basis:100%}
.p-field input,.p-field select{flex:1;min-width:0;width:100%}.p-row.set .p-input{border-color:color-mix(in srgb,var(--vp-accent) 55%,var(--vp-border))}
.p-resolved{font-size:11.5px;color:var(--vp-muted);white-space:nowrap}
input.p-lua{opacity:.8}
.pdesc,.p-note,.p-lock{font-size:11.5px;color:var(--vp-muted);line-height:1.4}
.p-error{color:var(--vscode-errorForeground);font-size:12px}.p-error:empty{display:none}
.warn{color:var(--vscode-editorWarning-foreground);font-size:12px}
input.invalid{border-color:var(--vscode-inputValidation-errorBorder,red)}
.c-port{border:1px solid var(--vp-border);border-radius:6px;padding:8px 10px;margin-bottom:8px;background:var(--vp-bg)}
.c-group{margin-bottom:10px}.c-group-h,.flow-h{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--vp-muted);margin:2px 0 6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.flow-h{text-transform:none;letter-spacing:0;font-size:12px;color:var(--vscode-foreground)}
.dir{font-size:10.5px;border-radius:4px;padding:1px 6px;border:1px solid var(--vp-border);white-space:nowrap;color:var(--vp-muted)}
.dir-init{border-color:var(--vp-compute);color:var(--vp-compute)}.dir-targ{border-color:var(--vp-memory);color:var(--vp-memory)}
.dir-sout,.dir-sin{border-color:var(--vp-irq);color:var(--vp-irq)}.dir-bidir{border-color:var(--vp-accent);color:var(--vp-accent)}
.c-count{font-size:11px;color:var(--vp-muted)}
.peer-glyph{color:var(--vp-muted);width:12px;display:inline-block;text-align:center}.peer-addr{font-size:11.5px;color:var(--vp-muted)}.peer-note{font-size:11.5px}
.peer{display:flex;flex-direction:column;min-width:0}.peer>a{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
ul.conns li .x{height:20px;width:22px;padding:0;border:0;background:transparent;color:var(--vp-muted);font-size:14px;line-height:1}
ul.conns li .x:hover{color:var(--vscode-errorForeground)}
details.c-free{margin-top:6px}details.c-free>summary{cursor:pointer;font-size:12px;color:var(--vp-muted);padding:4px 0}
details.c-free .c-port{opacity:.85}
.flow-block{margin-bottom:14px}.flow-arrow{color:var(--vp-muted)}.flow-note{font-size:11.5px;margin:6px 0 0}
table.decode{width:100%;font-size:12px;border-collapse:collapse;table-layout:fixed}table.decode col.c-addr{width:118px}table.decode col.c-size{width:64px}table.decode td.tgt{overflow:hidden;text-overflow:ellipsis}table.decode th{font-size:10.5px;text-align:left;color:var(--vp-muted);font-weight:500;padding:3px 6px;border-bottom:1px solid var(--vp-border)}
table.decode td{padding:3px 6px;border-bottom:1px solid color-mix(in srgb,var(--vp-border) 55%,transparent);white-space:nowrap}
table.decode .num{text-align:right}table.decode tr.bg td{opacity:.6}
table.decode tr.d1 td:last-child{padding-left:18px}table.decode tr.d2 td:last-child{padding-left:30px}table.decode tr.d3 td:last-child{padding-left:42px}
.rdot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:var(--rc,var(--vp-muted))}
.chips{display:flex;flex-wrap:wrap;gap:4px;min-width:0}.chip{display:inline-block;max-width:100%;box-sizing:border-box;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;border:1px solid var(--vp-border);border-radius:10px;padding:1px 8px;text-decoration:none;color:var(--vscode-foreground)}
.itab-body a.goto{color:var(--vscode-foreground);text-decoration:none}.itab-body a.goto:hover{text-decoration:underline;color:var(--vscode-textLink-foreground,var(--vp-accent))}
.reach{margin-bottom:8px}.reach-h{font-size:12px;overflow-wrap:anywhere;margin-bottom:4px;display:flex;flex-wrap:wrap;gap:6px;align-items:baseline}.reach-h .addr{color:var(--vp-muted)}
.c-line{display:flex;align-items:center;gap:6px 8px;flex-wrap:wrap}.c-line .connect{margin-left:auto}.c-line .pname{overflow-wrap:anywhere}.c-kind{margin-left:auto;font-size:11px;color:var(--vp-muted)}
.c-line .connect{height:24px;padding:0 8px;font-size:11.5px}
ul.conns{list-style:none;margin:6px 0 0;padding:0;font-size:12px}ul.conns li{margin:4px 0}
ul.conns li{display:grid;grid-template-columns:14px minmax(0,1fr) auto;align-items:start;gap:2px 4px}
.arrow{color:var(--vp-muted)}.c-none{font-size:12px;margin-top:4px}
.lookup{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-bottom:12px}.lookup label{color:var(--vp-muted);font-size:12px}
.addr-find{width:210px}.addr-result{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:12.5px}
.addr-result .goto-mod{height:24px;padding:0 8px;font-family:var(--vp-mono);border-color:color-mix(in srgb,var(--vp-accent) 55%,var(--vp-border));color:var(--vscode-foreground)}
.addr-result .bad{color:var(--vscode-errorForeground)}
tr.hit td{background:color-mix(in srgb,var(--vp-accent) 15%,transparent)}
.node.hit rect.box{stroke:var(--vp-accent);stroke-width:2.4;stroke-dasharray:none}
/* Transaction route: initiator -> bus(es) -> target, the rest dimmed. */
body.routing .diagram .node:not(.route){opacity:.38}body.routing .diagram .wire{opacity:.25}body.routing .diagram .sig{opacity:.12!important}
.node.route rect.box{stroke:var(--vp-route);stroke-width:2.4;stroke-dasharray:none}
.node.bus.route rect.box{fill:color-mix(in srgb,var(--vp-route) 16%,var(--vp-card))}
rect.core.route{fill:var(--vp-route)!important;opacity:1}
.route-line{fill:none;stroke:var(--vp-route);stroke-width:3;stroke-linecap:round;stroke-linejoin:round;pointer-events:none;stroke-dasharray:9 6;animation:route-flow 0.9s linear infinite}
.arrow-route path{fill:var(--vp-route)}
@keyframes route-flow{to{stroke-dashoffset:-15}}
@media (prefers-reduced-motion:reduce){.route-line{animation:none;stroke-dasharray:none}}
.route-bar{display:flex;flex-wrap:nowrap;align-items:center;gap:10px;margin-left:auto;min-width:0;max-width:100%;height:22px;overflow:hidden;padding:0 2px 0 10px;border:1px solid color-mix(in srgb,var(--vp-route) 55%,var(--vp-border));border-radius:6px;background:color-mix(in srgb,var(--vp-route) 9%,var(--vp-card))}
.route-bar[hidden]{display:none}body.route-pinned .hint{display:none}
.route-k{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--vp-route)}
.route-text{font-size:12px;white-space:nowrap;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}.route-detail{font-size:11.5px;white-space:nowrap;flex:0 100 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.route-clear{margin-left:auto;flex:none;border:0;background:transparent;font-size:15px;line-height:1;height:20px;padding:0 6px;color:var(--vp-muted)}.route-clear:hover{color:var(--vscode-foreground)}
.routable{cursor:pointer}tr.routable:hover td,tr.routable.pinned td{background:color-mix(in srgb,var(--vp-route) 10%,transparent)}
.reach-h.routable:hover,.reach-h.routable.pinned{color:var(--vp-route)}
.addr-result .route-pin{margin-left:4px}
/* Transactions tab: the running simulation's bus accesses. */
.tx-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:2px 0 8px}
.tx-opt{display:inline-flex;align-items:center;gap:5px;font-size:12px}.tx-shown{font-size:12px}
.tx-actions{margin-left:auto;display:inline-flex;gap:6px}
button.tx-follow[aria-pressed=true]{background:color-mix(in srgb,var(--vp-accent) 18%,transparent);border-color:color-mix(in srgb,var(--vp-accent) 60%,transparent)}
.tx-empty{padding:10px 0}.tx-empty:empty{display:none}.tx-empty .run-cmd{margin-left:8px}
.tx-scroll{max-height:340px;overflow:auto}
table.tx{font-family:var(--vp-mono);font-size:12px}table.tx th{position:sticky;top:0;background:var(--vp-bg);font-family:var(--vscode-font-family)}
table.tx td{white-space:nowrap}table.tx td.ini{color:var(--vp-muted)}table.tx tr.err td{color:var(--vscode-errorForeground)}
.pill.R{color:var(--vp-bus);background:color-mix(in srgb,var(--vp-bus) 14%,transparent)}
.pill.W{color:var(--vp-memory);background:color-mix(in srgb,var(--vp-memory) 16%,transparent)}
.pill.S{color:var(--vp-irq);background:color-mix(in srgb,var(--vp-irq) 15%,transparent)}
.tx-note{font-size:11.5px;margin:6px 0 0}
.node rect.core{cursor:pointer}.node rect.core:hover,.node rect.core.on{fill:var(--rc)}
.dock-h{font-size:12px;color:var(--vp-muted);font-weight:600;margin:4px 0 8px;letter-spacing:.02em}
.layout{margin-bottom:16px}.layout-head{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;margin-bottom:6px;font-size:12.5px}
.lbar{position:relative;height:30px;border:1px solid var(--vp-border);border-radius:5px;background:var(--vp-bg)}
.lseg{position:absolute;top:4px;bottom:4px;background:var(--rc);border-radius:3px;min-width:3px}
.lseg.bss{background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--rc) 75%,transparent) 0 3px,transparent 3px 7px);border:1px solid var(--rc)}
.lseg.clash{outline:2px solid var(--vscode-errorForeground);outline-offset:1px}
.lticks{display:flex;justify-content:space-between;font-size:10.5px;color:var(--vp-muted);margin:3px 0 6px}
.llegend{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;font-size:12px}
.dt-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin-bottom:10px}.dt-bar label{display:flex;align-items:center;gap:8px;color:var(--vp-muted);font-size:12px}
.dt-bar select{max-width:420px;font-family:inherit}.dt-stats{font-family:var(--vp-mono);font-size:12.5px}.dt-write{margin-left:auto}
.dt-add{color:var(--vp-good);font-weight:600}.dt-del{color:var(--vscode-errorForeground);font-weight:600}.dt-error{color:var(--vscode-errorForeground)}
.dt-legend{font-size:12px;margin:0 0 8px}
.dt-notes{list-style:none;margin:0 0 10px;padding:0;font-size:12px}.dt-notes li{margin:2px 0}
.dt-code{max-height:520px;overflow:auto;border:1px solid var(--vp-border);border-radius:6px;background:var(--vp-bg)}
table.dt{font-family:var(--vp-mono);font-size:12px;width:auto;min-width:100%}
table.dt td{border:0;padding:0 10px 0 0;white-space:pre;line-height:1.55}
table.dt td.ln{color:var(--vp-muted);text-align:right;padding:0 8px;user-select:none;min-width:36px;opacity:.75}
table.dt .sign{display:inline-block;width:14px;color:var(--vp-muted)}
table.dt tr.add td.src{background:color-mix(in srgb,var(--vp-good) 14%,transparent)}table.dt tr.add .sign{color:var(--vp-good)}
table.dt tr.del td.src{background:color-mix(in srgb,var(--vscode-errorForeground) 14%,transparent)}table.dt tr.del .sign{color:var(--vscode-errorForeground)}
table.dt tr.skip td{color:var(--vp-muted);padding:3px 12px;background:var(--vp-panel);font-family:var(--vscode-font-family)}
.llegend li{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px}.clash-note{color:var(--vscode-errorForeground);font-weight:600}
/* ---- narrower panels: the outline goes first, then the inspector moves under the diagram */
@media (max-width:1180px){.app{grid-template-columns:minmax(0,1fr) 310px;grid-template-areas:"head head" "stats stats" "main insp"}.outline{display:none}}
@media (max-width:660px){.app{grid-template-columns:minmax(0,1fr);grid-template-areas:"head" "stats" "main" "insp"}.inspector{position:static;max-height:none;border-left:0;border-top:1px solid var(--vp-border)}}
${sheet.css()}
</style></head><body data-default-address="${esc(img ? img.defaultAddress : '0x0')}"${opts.select ? ` data-select="${esc(opts.select)}"` : ''}${opts.route ? ` data-route="${esc(JSON.stringify(opts.route))}"` : ''}>
<div class="app">
<header class="head">
  <div class="ident">${BRAND}<div class="ident-text">
    <div class="title-row"><h1>${esc(doc.name)}</h1><span class="tag">schema ${esc(doc.schemaVersion || '')}</span>${status}</div>
    <p class="desc" title="${esc(doc.description || '')}">${esc(doc.description || '')} ${a.instances.length} instances · ${a.memoryMap.length} mapped regions · ${a.connections.length} connections</p>
  </div></div>
  <div class="actions"><button class="run-cmd tinted" data-command="generate">${ICON.code}Generate Lua</button>${forms ? `<button class="add-module tinted">${ICON.add}Add module…</button>` : ''}<button class="run-cmd primary" data-command="start">${ICON.play}Start Simulation</button></div>
</header>
${stats ? `<section class="stats" aria-label="Platform summary">${stats}</section>` : ''}
<nav class="outline" aria-label="Modules"><input type="search" class="ol-filter" placeholder="Filter modules" aria-label="Filter modules">${outline(gs)}</nav>
<main class="main">
  <div class="toolbar"><h2>Block diagram</h2><span class="sig-mode" role="group" aria-label="Signal lines"><span class="sig-mode-label">Signals</span>${['selected', 'all', 'off'].map((m) => `<button class="sig-btn" data-sig="${m}" aria-pressed="false">${m === 'selected' ? 'Selected' : m === 'all' ? 'All' : 'Off'}</button>`).join('')}</span>
    <span class="sig-legend"><span class="lg lg-irq"></span>interrupt<span class="lg lg-stream"></span>byte stream<span class="lg lg-signal"></span>other</span>
    <span class="hint">Click a block to inspect it · Ctrl+click to select several · drag to connect · double-click opens the JSON</span>
    <div class="route-bar" role="status" aria-live="polite" hidden><span class="route-k">Route</span><span class="route-text mono"></span><span class="route-detail muted"></span><button class="route-clear" title="Clear the route (Esc)" aria-label="Clear the route">×</button></div></div>
  <div class="canvas">${diagramHtml}</div>
  <script type="application/json" id="vp-routes">${routesJson}</script>
  <section class="dock" aria-label="Tables">
    <div class="dtabs" role="tablist">${dtab('map', 'Memory map', a.memoryMap.length)}${dtab('images', 'Software images', nImages)}${dtab('problems', 'Problems', a.problems.length, errors ? ' bad' : a.problems.length ? '' : ' good')}${dtab('signals', 'Signals and other connections', sigList.length)}${dtab('vars', 'Variables', (doc.variables || []).length)}${dtab('dt', 'Device tree', '')}${dtab('tx', 'Transactions', '–', ' tx-count')}</div>
    <div class="dock-body" data-dock="map"><div class="lookup"><label for="addr-find">Find address</label><input id="addr-find" class="addr-find" type="text" spellcheck="false" placeholder="for example 0x1000_0010"><span class="addr-result" aria-live="polite"></span></div>
    <script type="application/json" id="vp-regions">${regionsJson}</script>${bar ? `<div class="addrbar" aria-hidden="true">${bar}</div>` : ''}<div class="scroll"><table><thead><tr><th>Start</th><th>End</th><th class="num">Size</th><th>Instance</th><th>Port</th><th>Bus</th><th class="num">Priority</th></tr></thead><tbody>${mm}</tbody></table></div></div>
    <div class="dock-body" data-dock="images" hidden>${imagesHtml}</div>
    <div class="dock-body" data-dock="problems" hidden>${probs}</div>
    <div class="dock-body" data-dock="signals" hidden><div class="scroll"><table><thead><tr><th>From</th><th>Port</th><th>To</th><th>Port</th></tr></thead><tbody>${sig}</tbody></table></div></div>
    <div class="dock-body" data-dock="dt" hidden><div class="dt-pane"><p class="muted">Generating the device tree from the platform…</p></div></div>
    <div class="dock-body" data-dock="tx" hidden>
      <div class="tx-bar"><span class="status idle tx-status"><span class="dot"></span><span class="tx-state">Waiting…</span></span>
        <label class="tx-opt"><input type="checkbox" class="tx-sel"> Selected module only</label>
        <select class="tx-dir" aria-label="Kind of access"><option value="">All accesses</option><option value="R">Reads</option><option value="W">Writes</option><option value="S">Signals</option></select>
        <button class="tx-follow" aria-pressed="true" title="Show new accesses as they come; off keeps the table still">Follow</button>
        <span class="tx-shown muted"></span>
        <span class="tx-actions"><button class="run-cmd" data-command="probes">Choose probes…</button><button class="run-cmd" data-command="trace">Open Trace panel</button></span></div>
      <div class="tx-empty muted"></div>
      <div class="scroll tx-scroll"><table class="tx"><thead><tr><th class="num">Time (s)</th><th>Initiator</th><th>Target</th><th>Access</th><th>Address</th><th>Value</th></tr></thead><tbody class="tx-rows"></tbody></table></div>
      <p class="muted tx-note">Hover an access to see its route in the diagram, click to keep it. Breakpoints, export and the full history are in the Trace panel.</p>
    </div>
    <div class="dock-body" data-dock="vars" hidden><div class="scroll"><table><thead><tr><th>Name</th><th>Value</th><th>Resolved</th><th>Scope</th></tr></thead><tbody>${vars}</tbody></table></div></div>
  </section>
</main>
<aside class="inspector" aria-label="Inspector">
  <section class="multi-panel" hidden><div class="insp-head"><span class="insp-icon role-subsystem" aria-hidden="true">S</span><div class="insp-title"><h2 class="multi-count"></h2><div class="muted">Ctrl+click (⌘+click) blocks or modules to add or remove them</div></div></div>
    <ul class="multi-list mono"></ul>
    <div class="insp-actions"><button class="group-modules primary">Group into subsystem…</button><button class="multi-clear">Clear selection</button></div>
    <p class="muted insp-sub">The modules move into a new subsystem (a Container) in the JSON; connections from other modules are rewritten to reach them, so the platform stays the same.</p></section>
  <div class="insp-empty"><h2>Inspector</h2>${forms ? 'Select a block in the diagram or a module on the left to see and change its parameters and connections. Empty a value to go back to the model default.' : 'Parameters are not available in this view.'}</div>
  ${panels}
</aside>
</div>
<script nonce="${nonce}">
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
function reveal(el){const t=el.closest('[data-module]');if(t&&t.dataset.module&&vscode)vscode.postMessage({type:'reveal',module:t.dataset.module});}
const post=m=>{if(vscode)vscode.postMessage(m);};
const ADDR=/^(0x[0-9A-Fa-f]+|\\d+|\\$\\{[A-Za-z_]\\w*\\}(\\s*[+-]\\s*(0x[0-9A-Fa-f]+|\\d+))?)$/;
function rowsOf(box,skip){const out=[];for(const tr of box.querySelectorAll('tr.img-row')){if(tr===skip)continue;const orig=Number(tr.dataset.orig);
  if(tr.dataset.kind==='raw'){out.push({orig,kind:'raw'});continue;}
  out.push({orig,kind:tr.querySelector('.img-kind').value,file:tr.querySelector('.img-file').value.trim(),address:tr.querySelector('.img-addr').value.trim()});}return out;}
function submit(box,skip){const err=box.querySelector('.form-error');err.textContent='';const rows=rowsOf(box,skip);
  for(const r of rows){if(r.kind==='bin'&&!ADDR.test(r.address)){err.textContent='"'+r.address+'" is not a valid load address. Use hex such as 0x80000000, a decimal number, or \${NAME} with an optional +offset.';return;}}
  post({type:'setImages',module:box.dataset.loader,rows});}
// The view is re-rendered after every edit, so the selection, tabs, filters,
// scroll position and focused field are kept in the webview state.
const S=Object.assign({module:null,filters:{},scopes:{},scroll:0,focus:null,dock:'map',itab:'params',ol:''},(vscode&&vscode.getState())||{});
S.scopes=S.scopes||{};S.filters=S.filters||{};S.adv=S.adv||{};
const save=()=>{if(vscode)vscode.setState(S);};
const narrow=()=>window.matchMedia('(max-width:660px)').matches;
const panelOf=m=>document.querySelector('.mod-panel[data-panel="'+CSS.escape(m)+'"]');
const scopeOf=p=>{const s=p.querySelector('.p-scope');return s?s.value:'all';};
const bodyOf=(p,scope)=>p.querySelector('.p-scope-body[data-scope="'+CSS.escape(scope)+'"]');
const indexOf=el=>{const b=el.closest('.p-scope-body');return b&&b.dataset.scope!=='all'?b.dataset.scope:null;};
function setItab(p,tab){const has=p.querySelector('.itab-body[data-tab="'+tab+'"]');if(!has)tab='params';
  p.querySelectorAll('.itab').forEach(b=>b.classList.toggle('on',b.dataset.tab===tab));
  p.querySelectorAll('.itab-body').forEach(b=>{b.hidden=b.dataset.tab!==tab;});}
let dtAsked=false;
function askDeviceTree(against){const p=document.querySelector('.dt-pane');if(p&&dtAsked){const s=p.querySelector('.dt-stats');if(s)s.textContent='working…';}
  dtAsked=true;post({type:'deviceTree',against:against||S.dt||'auto'});}
function setDock(id){if(!document.querySelector('.dock-body[data-dock="'+id+'"]'))id='map';
  if(id==='dt'&&!dtAsked)askDeviceTree();
  document.querySelectorAll('.dtab').forEach(b=>b.classList.toggle('on',b.dataset.dock===id));
  document.querySelectorAll('.dock-body').forEach(b=>{b.hidden=b.dataset.dock!==id;});S.dock=id;save();
  if(typeof txWatch==='function'){txWatch(id==='tx');if(id==='tx')txDraw(true);}}
S.multi=Array.isArray(S.multi)?S.multi:[];
function showMulti(){const many=S.multi.length>=2;const mp=document.querySelector('.multi-panel');
  document.querySelectorAll('.node,.ol-item').forEach(n=>n.classList.toggle('multi',S.multi.includes(n.dataset.module)));
  if(!mp)return;mp.hidden=!many;
  if(many){document.querySelectorAll('.mod-panel').forEach(x=>{x.hidden=true;});document.querySelectorAll('.node.selected,.ol-item.selected').forEach(n=>n.classList.remove('selected'));const h=document.querySelector('.insp-empty');if(h)h.hidden=true;
    mp.querySelector('.multi-count').textContent=S.multi.length+' modules selected';const ul=mp.querySelector('.multi-list');ul.textContent='';
    for(const m of S.multi){const li=document.createElement('li');li.textContent=m;ul.append(li);}}
  else if(S.module&&panelOf(S.module)){panelOf(S.module).hidden=false;document.querySelectorAll('.node,.ol-item').forEach(n=>n.classList.toggle('selected',n.dataset.module===S.module));}else{const h=document.querySelector('.insp-empty');if(h)h.hidden=false;}}
function toggleMulti(m){if(!S.multi.length&&S.module&&S.module!==m)S.multi.push(S.module);
  const k=S.multi.indexOf(m);if(k>=0)S.multi.splice(k,1);else S.multi.push(m);save();showMulti();}
S.sig=S.sig||'selected';
function setHot(m){document.querySelectorAll('.sig').forEach(l=>l.classList.toggle('on',!!m&&(l.dataset.a===m||l.dataset.b===m)));}
function setSig(mode){S.sig=mode;save();document.body.classList.toggle('sig-all',mode==='all');document.body.classList.toggle('sig-off',mode==='off');
  document.querySelectorAll('.sig-btn').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.sig===mode)));}
document.addEventListener('pointerover',e=>{const n=e.target.closest&&e.target.closest('.node');if(n&&!drag)setHot(n.dataset.module);});
document.addEventListener('pointerout',e=>{const n=e.target.closest&&e.target.closest('.node');if(n&&!(e.relatedTarget&&n.contains(e.relatedTarget)))setHot(S.module);});
function select(m,scroll){const p=panelOf(m);if(!p)return false;
  setHot(m);
  if(S.multi.length){S.multi=[];showMulti();}
  document.querySelectorAll('.mod-panel').forEach(x=>{x.hidden=x!==p;});
  document.querySelectorAll('.node').forEach(n=>n.classList.toggle('selected',n.dataset.module===m));
  document.querySelectorAll('.ol-item').forEach(n=>n.classList.toggle('selected',n.dataset.module===m));
  const h=document.querySelector('.insp-empty');if(h)h.hidden=true;
  setItab(p,S.itab);
  S.module=m;save();if(scroll&&narrow())p.scrollIntoView({block:'nearest'});if(S.dock==='tx'&&typeof txDraw==='function')txDraw();return true;}
function applyFilter(p){const f=p.querySelector('.p-filter');const q=f?f.value.trim().toLowerCase():'';let n=0;
  p.querySelectorAll('.p-scope-body').forEach(b=>b.querySelectorAll('.p-row').forEach(r=>{const show=!q||r.dataset.filter.includes(q);r.hidden=!show;if(show&&!b.hidden)n++;}));
  p.querySelector('.p-none').hidden=n>0||!q;}
function setScope(p,scope){const sel=p.querySelector('.p-scope');if(!sel||!bodyOf(p,scope))return;sel.value=scope;
  p.querySelectorAll('.p-scope-body').forEach(b=>{b.hidden=b.dataset.scope!==scope;});
  const help=p.querySelector('.p-scope-help');if(help)help.hidden=scope==='all';
  document.querySelectorAll('.node[data-module="'+CSS.escape(p.dataset.panel)+'"] rect.core').forEach(r=>r.classList.toggle('on',r.dataset.index===scope));
  S.scopes[p.dataset.panel]=scope;save();applyFilter(p);}
function rowInput(m,name,index){const p=panelOf(m);const b=p&&bodyOf(p,index===null||index===undefined?'all':String(index));
  return b&&b.querySelector('.p-row[data-name="'+CSS.escape(name)+'"] .p-input');}
${fmtAddr.toString()}
${parseAddress.toString()}
${lookupAddress.toString()}
${routeFor.toString()}
const ROUTES=JSON.parse((document.getElementById('vp-routes')||{textContent:'{"inst":{},"regions":{}}'}).textContent);
// The block that shows a module: its own, else the collapsed subsystem it is in.
function visNode(base){let b=base;while(b){const n=document.querySelector('.diagram .node:not(.bus)[data-module="'+CSS.escape(b)+'"]');if(n)return n;const i=b.lastIndexOf('.');if(i<0)break;b=b.slice(0,i);}return null;}
const busNode=b=>document.querySelector('.diagram .node.bus[data-module="'+CSS.escape(b)+'"]');
const boxOf=n=>{const r=n.querySelector('rect.box');return{x:+r.getAttribute('x'),y:+r.getAttribute('y'),w:+r.getAttribute('width'),h:+r.getAttribute('height')};};
function clearRoute(){document.querySelectorAll('.diagram .route').forEach(x=>x.classList.remove('route'));document.querySelectorAll('.route-line').forEach(x=>x.remove());document.body.classList.remove('routing');}
// Light up initiator -> bus(es) -> target and draw a line along the wires. Returns the route, or null.
function drawRoute(spec){clearRoute();const r=spec&&routeFor(ROUTES,spec);if(!r)return null;
  const t=visNode(r.target);if(!t)return r;const f=r.from?visNode(r.from):null;const bars=r.buses.map(busNode).filter(Boolean);
  [t,f,...bars].forEach(n=>{if(n)n.classList.add('route');});
  let tile=null;if(f&&r.index!==null&&r.index!==undefined){tile=f.querySelector('rect.core[data-index="'+r.index+'"]');if(tile)tile.classList.add('route');}
  document.body.classList.add('routing');
  const tb=boxOf(t);const ys=bars.map(b=>{const x=boxOf(b);return x.y+x.h/2;});const pts=[];
  // Below a bar, a block hangs from the spine 14 px to its left.
  const hang=(b,y)=>b.y>y;
  if(f&&f!==t){const fb=boxOf(f);
    if(ys.length&&hang(fb,ys[0])){pts.push([fb.x,fb.y+fb.h/2],[fb.x-14,fb.y+fb.h/2],[fb.x-14,ys[0]]);}
    else{const fx=tile?+tile.getAttribute('x')+(+tile.getAttribute('width'))/2:fb.x+fb.w/2;pts.push([fx,tile?+tile.getAttribute('y')+12:fb.y+fb.h]);if(ys.length)pts.push([fx,ys[0]]);}}
  const last=ys.length?ys[ys.length-1]:null;
  const sx=last!==null&&hang(tb,last)?tb.x-14:tb.x+tb.w/2;
  if(!pts.length&&ys.length)pts.push([Math.min(sx,tb.x+tb.w/2)-40,ys[0]]);
  ys.forEach(y=>pts.push([sx,y]));
  if(last!==null&&hang(tb,last))pts.push([sx,tb.y+tb.h/2],[tb.x,tb.y+tb.h/2]);else pts.push([sx,last!==null&&tb.y+tb.h<last?tb.y+tb.h:tb.y]);
  const clean=pts.filter((p,i)=>!i||p[0]!==pts[i-1][0]||p[1]!==pts[i-1][1]);
  if(clean.length>1){const svg=t.ownerSVGElement;const line=document.createElementNS('http://www.w3.org/2000/svg','path');line.setAttribute('class','route-line');
    line.setAttribute('d','M'+clean.map(p=>p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' L'));line.setAttribute('marker-end','url(#vp-arrow-route)');svg.appendChild(line);}
  return r;}
const specOf=el=>({region:el.dataset.routeRegion,from:el.dataset.routeFrom||null,bus:el.dataset.routeBus||null});
const routeName=(r,spec)=>(spec.initiator||(r.from?r.from+(r.index!==null&&r.index!==undefined?'_'+r.index:'')+(r.port?'.'+r.port:''):'any initiator'))+' → '+r.buses.join(' › ')+(r.buses.length?' → ':'')+r.region;
// The route kept on screen (S.route), shown again after every render.
function pinRoute(spec,scroll){S.route=spec||null;save();if(typeof TX!=='undefined'&&TX.pinned){TX.pinned=0;document.querySelectorAll('tr.tx-row.pinned').forEach(x=>x.classList.remove('pinned'));}const bar=document.querySelector('.route-bar');
  document.querySelectorAll('.routable.pinned').forEach(x=>x.classList.remove('pinned'));
  const r=drawRoute(spec);
  document.body.classList.toggle('route-pinned',!!r);
  if(bar){bar.hidden=!r;if(r){bar.querySelector('.route-text').textContent=routeName(r,spec);bar.querySelector('.route-detail').textContent=spec.detail||'';bar.title=routeName(r,spec)+(spec.detail?'\\n'+spec.detail:'');}}
  if(!r){if(spec){S.route=null;save();}return;}
  document.querySelectorAll('.routable').forEach(x=>{const o=specOf(x);if(o.region===r.region&&(o.from||null)===(r.from||null))x.classList.add('pinned');});
  if(scroll){const t=visNode(r.target);if(t)t.scrollIntoView({block:'nearest',inline:'nearest'});}}
const previewRoute=el=>drawRoute(specOf(el));
const restoreRoute=()=>{if(S.route)drawRoute(S.route);else clearRoute();};
document.addEventListener('pointerover',e=>{const el=e.target.closest&&e.target.closest('[data-route-region]');if(el)previewRoute(el);});
document.addEventListener('pointerout',e=>{const el=e.target.closest&&e.target.closest('[data-route-region]');if(el&&!(e.relatedTarget&&el.contains(e.relatedTarget)))restoreRoute();});
document.addEventListener('focusin',e=>{const el=e.target.closest&&e.target.closest('[data-route-region]');if(el)previewRoute(el);});
document.addEventListener('focusout',e=>{const el=e.target.closest&&e.target.closest('[data-route-region]');if(el)restoreRoute();});
// The Transactions tab: the running simulation's accesses, polled by the extension while the tab is open.
const TX={all:[],frozen:null,follow:true,state:null,watching:false,pinned:0};
const TXKEEP=5000,TXSHOW=400;
const txModule=point=>{const i=point.lastIndexOf('.');return i<0?point:point.slice(0,i);};
const txIniBase=name=>{const i=name.lastIndexOf('.');const n=i<0?name:name.slice(0,i);const hit=ROUTES.inst[n];return hit?hit[0]:n;};
const under=(b,m)=>b===m||b.startsWith(m+'.');
function txWatch(on){if(TX.watching===on)return;TX.watching=on;post({type:'txWatch',on});}
function txSpec(r){return{region:r.point,initiator:r.initiator||undefined,detail:(r.dir==='W'?'write ':'read ')+r.address+(r.length?' · '+r.length+' byte'+(r.length===1?'':'s'):'')+(r.value?' · '+r.value:'')+' · '+Number(r.time).toFixed(6)+' s · #'+r.seq+(r.initiator?'':' · initiator unknown')};}
function txDraw(arrived){const body=document.querySelector('.tx-rows');if(!body)return;
  const st=TX.state;const empty=document.querySelector('.tx-empty');const status=document.querySelector('.tx-status');
  const live=!!(st&&st.connected);status.className='status tx-status '+(live&&st.recordingProbes?'live':'idle');
  document.querySelector('.tx-state').textContent=!st?'Waiting…':st.connected?(st.recordingProbes?st.recordingProbes+' of '+st.probes+' probes recording':st.probes?'No probe recording':'No probes'):st.mine?'Not connected':'Not running';
  const cnt=document.querySelector('.dtab[data-dock="tx"] .count');if(cnt)cnt.textContent=TX.all.length?String(TX.all.length):'–';
  empty.textContent='';const btn=(cmd,label)=>{const b=document.createElement('button');b.className='run-cmd';b.dataset.command=cmd;b.textContent=label;return b;};
  if(st&&st.other){empty.append('The running simulation is '+st.other+', not this platform.');}
  else if(st&&!st.connected&&!TX.all.length){empty.append('No simulation of this platform is running. Start it with tracing to see its bus accesses here.');empty.append(btn('startTrace','Start Simulation with Tracing…'));}
  else if(st&&st.connected&&!st.recordingProbes&&!TX.all.length){empty.append(st.probes?'No probe is recording yet.':'This simulation has no probes.');if(st.probes)empty.append(btn('probes','Choose probes…'));}
  else if(st&&st.connected&&!TX.all.length){empty.append('No accesses yet.');}
  const sel=document.querySelector('.tx-sel').checked&&S.module;const dir=document.querySelector('.tx-dir').value;
  const src=TX.frozen||TX.all;const rows=[];
  for(let i=src.length-1;i>=0&&rows.length<TXSHOW;i--){const r=src[i];if(dir&&r.dir!==dir)continue;
    if(sel&&!under(txModule(r.point),S.module)&&!(r.initiator&&under(txIniBase(r.initiator),S.module)))continue;rows.push(r);}
  rows.reverse();
  document.querySelector('.tx-shown').textContent=src.length?(rows.length===TXSHOW?'newest '+TXSHOW+' shown':rows.length+' shown')+' of '+src.length+(TX.frozen?' · Follow off':''):'';
  body.textContent='';const frag=document.createDocumentFragment();
  for(const r of rows){const tr=document.createElement('tr');tr.dataset.seq=r.seq;tr.className=(r.status!=='OK'&&r.dir!=='S'?'err ':'')+(r.dir!=='S'?'tx-row routable':'')+(r.seq===TX.pinned?' pinned':'');
    if(r.dir!=='S'){tr.tabIndex=0;tr.title='Hover to see the route, click to keep it';}
    const cell=(t,c)=>{const td=document.createElement('td');if(c)td.className=c;td.textContent=t;tr.append(td);return td;};
    cell(Number(r.time).toFixed(9),'num');cell(r.dir==='S'?'':r.initiator||'–','ini');cell(r.point,'');
    const pill=document.createElement('span');pill.className='pill '+r.dir;pill.textContent=r.dir==='S'?(r.value==='1'?'signal ↑':'signal ↓'):r.dir==='W'?'write':'read';cell('','').append(pill);
    cell(r.address,'');cell(r.value||'','');frag.append(tr);}
  body.append(frag);
  if(arrived&&TX.follow&&!TX.frozen){const sc=document.querySelector('.tx-scroll');sc.scrollTop=sc.scrollHeight;}}
let txPending=false,txArrived=false;const txSchedule=(arrived)=>{txArrived=txArrived||!!arrived;if(!txPending){txPending=true;requestAnimationFrame(()=>{txPending=false;const a=txArrived;txArrived=false;txDraw(a);});}};
const txRecord=tr=>{const seq=Number(tr.dataset.seq);const src=TX.frozen||TX.all;for(let i=src.length-1;i>=0;i--)if(src[i].seq===seq)return src[i];return null;};
document.addEventListener('pointerover',e=>{const tr=e.target.closest&&e.target.closest('tr.tx-row');if(tr){const r=txRecord(tr);if(r)drawRoute(txSpec(r));}});
document.addEventListener('pointerout',e=>{const tr=e.target.closest&&e.target.closest('tr.tx-row');if(tr&&!(e.relatedTarget&&tr.contains(e.relatedTarget)))restoreRoute();});
function txPin(tr){const r=txRecord(tr);if(!r)return;if(TX.pinned===r.seq)pinRoute(null);else{pinRoute(txSpec(r));TX.pinned=r.seq;tr.classList.add('pinned');}}
document.addEventListener('click',e=>{const tr=e.target.closest&&e.target.closest('tr.tx-row');if(tr){txPin(tr);return;}
  if(e.target.closest&&e.target.closest('.tx-follow')){TX.follow=!TX.follow;TX.frozen=TX.follow?null:TX.all.slice();e.target.closest('.tx-follow').setAttribute('aria-pressed',String(TX.follow));txDraw(TX.follow);}});
document.addEventListener('keydown',e=>{const tr=e.target.closest&&e.target.closest('tr.tx-row');if(tr&&(e.key==='Enter'||e.key===' ')){e.preventDefault();e.stopPropagation();txPin(tr);}},true);
document.addEventListener('change',e=>{if(e.target.matches('.tx-sel,.tx-dir')){S.tx={sel:document.querySelector('.tx-sel').checked,dir:document.querySelector('.tx-dir').value};save();txDraw();}});
window.addEventListener('message',ev=>{const m=ev.data;if(!m)return;
  if(m.type==='txState'){TX.state=m;txSchedule();}
  else if(m.type==='tx'){if(m.reset){TX.all=[];TX.frozen=TX.follow?null:[];}TX.all.push(...(m.records||[]));if(TX.all.length>TXKEEP)TX.all=TX.all.slice(TX.all.length-TXKEEP);txSchedule(true);}});
const REGIONS=JSON.parse((document.getElementById('vp-regions')||{textContent:'[]'}).textContent).map(r=>Object.assign(r,{start:BigInt(r.start),end:BigInt(r.end)}));
function findAddress(text){const out=document.querySelector('.addr-result');if(!out)return;out.textContent='';
  document.querySelectorAll('tr.hit,.node.hit').forEach(x=>x.classList.remove('hit'));
  if(!text.trim())return;const a=parseAddress(text);const span=(cls,t)=>{const s=document.createElement('span');if(cls)s.className=cls;s.textContent=t;return s;};
  if(a===null){out.append(span('bad','Not an address: use hex such as 0x1000_0010, or decimal.'));return;}
  const res=lookupAddress(REGIONS,a);
  if(!res.length){out.append(span('bad',fmtAddr(a)+' is not mapped on any bus.'));return;}
  for(const r of res){const b=document.createElement('button');b.className='goto-mod';b.dataset.module=r.hit.base;b.textContent=r.hit.instance+'.'+r.hit.port;
    const rb=document.createElement('button');rb.className='route-pin';rb.dataset.region=r.hit.instance+'.'+r.hit.port;rb.dataset.bus=r.bus;rb.textContent='Route';rb.title='Show the route to it in the diagram';
    out.append(span('mono',fmtAddr(a)+' →'),b,rb,span('muted','offset '+fmtAddr(r.hit.offset)+' · on '+r.bus+(r.shadowed.length?' · shadows '+r.shadowed.map(x=>x.instance+' (priority '+x.priority+')').join(', '):'')));
    document.querySelectorAll('tr[data-region="'+CSS.escape(r.hit.instance+'.'+r.hit.port)+'"]').forEach(x=>x.classList.add('hit'));
    document.querySelectorAll('.node[data-module="'+CSS.escape(r.hit.base)+'"]').forEach(x=>x.classList.add('hit'));}}
function filterOutline(q){q=q.trim().toLowerCase();document.querySelectorAll('.ol-group').forEach(g=>{let n=0;
  g.querySelectorAll('.ol-item').forEach(i=>{const show=!q||i.dataset.filter.includes(q);i.hidden=!show;if(show)n++;});g.hidden=n===0;});}
document.addEventListener('input',e=>{
  if(e.target.matches('.p-filter')){const p=e.target.closest('.mod-panel');S.filters[p.dataset.panel]=e.target.value;save();applyFilter(p);}
  if(e.target.matches('.ol-filter')){S.ol=e.target.value;save();filterOutline(e.target.value);}
  if(e.target.matches('.addr-find')){S.find=e.target.value;save();findAddress(e.target.value);}});
document.addEventListener('focusin',e=>{const p=e.target.closest('.mod-panel');
  S.focus=p&&e.target.matches('.p-input,.p-filter')?{panel:p.dataset.panel,index:e.target.matches('.p-filter')?null:indexOf(e.target),name:e.target.matches('.p-filter')?null:e.target.closest('.p-row').dataset.name}:null;save();});
window.addEventListener('scroll',()=>{S.scroll=window.scrollY;save();},{passive:true});
window.addEventListener('message',ev=>{const m=ev.data;
  if(m&&m.type==='route'){pinRoute(m.spec,true);return;}
  if(m&&m.type==='deviceTree'){const p=document.querySelector('.dt-pane');if(p)p.innerHTML=m.html;S.dt=m.against;save();return;}
  if(!m||m.type!=='paramError')return;const el=rowInput(m.module,m.name,m.index);if(!el)return;
  select(m.module,false);S.itab='params';setItab(panelOf(m.module),'params');setScope(panelOf(m.module),m.index===null||m.index===undefined?'all':String(m.index));
  const adv=el.closest('details');if(adv)adv.open=true;
  el.closest('.p-row').querySelector('.p-error').textContent=m.message;el.classList.add('invalid');el.focus();});
document.addEventListener('change',e=>{
  if(e.target.matches('.p-scope'))return setScope(e.target.closest('.mod-panel'),e.target.value);
  if(e.target.matches('.dt-against'))return askDeviceTree(e.target.value);
  if(!e.target.matches('.p-input'))return;const row=e.target.closest('.p-row');const p=e.target.closest('.mod-panel');
  row.querySelector('.p-error').textContent='';e.target.classList.remove('invalid');
  post({type:'setParam',module:p.dataset.panel,index:indexOf(e.target),name:row.dataset.name,kind:e.target.dataset.kind,input:e.target.value});});
// Drag from one block to another to connect them.
let drag=null,dragged=false;
const svgPoint=(svg,e)=>{const p=svg.createSVGPoint();p.x=e.clientX;p.y=e.clientY;return p.matrixTransform(svg.getScreenCTM().inverse());};
const nodeAt=e=>{const el=document.elementFromPoint(e.clientX,e.clientY);return el&&el.closest('.node');};
document.addEventListener('pointerdown',e=>{dragged=false;const n=e.target.closest('.node');if(!n||e.button!==0)return;const svg=n.ownerSVGElement;const r=n.querySelector('rect');
  drag={from:n,svg,x0:e.clientX,y0:e.clientY,cx:+r.getAttribute('x')+(+r.getAttribute('width'))/2,cy:+r.getAttribute('y')+(+r.getAttribute('height'))/2,line:null,over:null};});
document.addEventListener('pointermove',e=>{if(!drag)return;if(!drag.line){if(Math.hypot(e.clientX-drag.x0,e.clientY-drag.y0)<6)return;
    drag.line=document.createElementNS('http://www.w3.org/2000/svg','line');drag.line.setAttribute('class','drag-line');drag.line.setAttribute('x1',drag.cx);drag.line.setAttribute('y1',drag.cy);drag.svg.appendChild(drag.line);}
  const p=svgPoint(drag.svg,e);drag.line.setAttribute('x2',p.x);drag.line.setAttribute('y2',p.y);
  const over=nodeAt(e);const target=over&&over!==drag.from?over:null;if(drag.over&&drag.over!==target)drag.over.classList.remove('drop');if(target)target.classList.add('drop');drag.over=target;});
document.addEventListener('pointerup',e=>{if(!drag)return;const d=drag;drag=null;if(!d.line)return;d.line.remove();dragged=true;
  if(d.over){d.over.classList.remove('drop');select(d.from.dataset.module,false);post({type:'connect',module:d.from.dataset.module,peer:d.over.dataset.module});}});
document.addEventListener('dblclick',e=>{if(e.target.closest('.sub-toggle'))return;const n=e.target.closest('.node,.ol-item');if(n)reveal(n);});
document.addEventListener('click',e=>{const t=e.target.closest('button,a,.node,.seg,tr[data-module],li[data-module]')||e.target;
  if(t.matches('.p-reset'))return post({type:'resetParam',module:t.closest('.mod-panel').dataset.panel,index:indexOf(t),name:t.closest('.p-row').dataset.name});
  if(t.matches('.show-json'))return post({type:'reveal',module:t.dataset.module});
  if(t.matches('.delete-module'))return post({type:'deleteModule',module:t.dataset.module});
  if(t.matches('.connect'))return post({type:'connect',module:t.dataset.module,port:t.dataset.port});
  if(t.matches('.unbind'))return post({type:'disconnect',module:t.dataset.module,key:t.dataset.key,scope:t.dataset.scope===''?null:t.dataset.scope});
  if(t.matches('.run-cmd'))return post({type:'command',command:t.dataset.command});
  const tg=e.target.closest&&e.target.closest('.sub-toggle');if(tg){e.stopPropagation();return post({type:'toggleSubsystem',module:tg.dataset.module});}
  if(t.matches('.dt-write')){const s=document.querySelector('.dt-stats');if(s)s.textContent='writing…';return post({type:'deviceTreeWrite',against:S.dt||'auto'});}
  if(t.matches('.itab')){S.itab=t.dataset.tab;save();return setItab(t.closest('.mod-panel'),t.dataset.tab);}
  if(t.matches('.dtab'))return setDock(t.dataset.dock);
  if(t.matches('.sig-btn'))return setSig(t.dataset.sig);
  if(t.matches('[data-dock-open]')){setDock(t.dataset.dockOpen);document.querySelector('.dock').scrollIntoView({block:'nearest'});return;}
  if(dragged){dragged=false;if(t.closest('.node')){e.stopPropagation();return;}}
  if(t.matches('.add-module'))return post({type:'addModule',container:t.dataset.container||''});
  if(t.matches('.toggle-sub'))return post({type:'toggleSubsystem',module:t.dataset.module});
  if(t.matches('.route-clear'))return pinRoute(null);
  if(t.matches('.route-pin'))return pinRoute({region:t.dataset.region,bus:t.dataset.bus,detail:'any initiator on '+t.dataset.bus},true);
  if(t.matches('.goto')){e.preventDefault();select(t.dataset.module,true);return;}
  {const rt=e.target.closest&&e.target.closest('.routable[data-route-region]');if(rt&&!e.target.closest('a,button')){const o=specOf(rt);const same=S.route&&S.route.region===o.region&&(S.route.from||null)===o.from&&!S.route.initiator;return pinRoute(same?null:o);}}
  const many=e.ctrlKey||e.metaKey||e.shiftKey;
  if(many&&(t.matches('.ol-item')||t.closest('.node'))){const m=(t.matches('.ol-item')?t:t.closest('.node')).dataset.module;if(m){e.preventDefault();toggleMulti(m);}return;}
  if(t.matches('.group-modules')){const ms=S.multi.slice();S.multi=[];save();return post({type:'groupModules',modules:ms});}
  if(t.matches('.multi-clear')){S.multi=[];save();return showMulti();}
  if(t.matches('.swap-module'))return post({type:'swapModule',module:t.dataset.module});
  if(t.matches('.ol-item')||t.matches('.goto-mod')){select(t.dataset.module,true);return;}
  // A core tile: that one instance, with Applies to set to it.
  const core=e.target.closest&&e.target.closest('rect.core');
  if(core){const m=core.closest('.node').dataset.module;select(m,true);const p=panelOf(m);if(p)setScope(p,core.dataset.index);return;}
  const n=t.closest('.node');if(n){select(n.dataset.module,true);return;}
  if(t.closest('.mod-panel'))return;
  const r=t.closest('tr[data-module],li[data-module],.seg[data-module]');if(r&&r.dataset.module)select(r.dataset.module,false);},true);
if(S.tx){const c=document.querySelector('.tx-sel');if(c)c.checked=!!S.tx.sel;const d=document.querySelector('.tx-dir');if(d)d.value=S.tx.dir||'';}
setDock(S.dock);
setSig(S.sig);
{const given=document.body.dataset.route?JSON.parse(document.body.dataset.route):null;
  // A route sent while the view was hidden arrives in the page; one already shown stays in the state.
  if(given&&given.id!==S.routeId){S.routeId=given.id;S.route=given.spec;}
  if(S.route)pinRoute(S.route,!!given&&given.spec===S.route);}
document.querySelectorAll('details.advanced').forEach(d=>{const v=S.adv[d.dataset.panel];if(v!==undefined)d.open=v;});
document.addEventListener('toggle',e=>{if(e.target.matches&&e.target.matches('details.advanced')){S.adv[e.target.dataset.panel]=e.target.open;save();}},true);
const olf=document.querySelector('.ol-filter');if(olf&&S.ol){olf.value=S.ol;filterOutline(S.ol);}
const af=document.querySelector('.addr-find');if(af&&S.find){af.value=S.find;findAddress(S.find);}
const justAdded=!!document.body.dataset.select&&select(document.body.dataset.select,false);
if(justAdded)S.focus=null;
else if(S.module&&!select(S.module,false))S.module=null;
document.querySelectorAll('.mod-panel').forEach(p=>{const f=p.querySelector('.p-filter');const v=S.filters[p.dataset.panel];if(f&&v)f.value=v;
  const sc=S.scopes[p.dataset.panel];if(sc&&sc!=='all')setScope(p,sc);else applyFilter(p);});
if(S.multi.length)showMulti();
if(S.focus){const p=panelOf(S.focus.panel);const el=p&&!p.hidden&&(S.focus.name?rowInput(S.focus.panel,S.focus.name,S.focus.index):p.querySelector('.p-filter'));if(el)el.focus({preventScroll:true});}
if(justAdded){const n=document.querySelector('.node[data-module="'+CSS.escape(document.body.dataset.select)+'"]');if(n)n.scrollIntoView({block:'nearest'});}else window.scrollTo(0,S.scroll||0);
document.addEventListener('change',e=>{const box=e.target.closest('.loader');if(box&&e.target.matches('.img-kind,.img-file,.img-addr')){
  if(e.target.matches('.img-kind')){const a=e.target.closest('tr').querySelector('.img-addr');if(e.target.value==='bin'&&!a.value)a.value=document.body.dataset.defaultAddress;}
  submit(box);}});
document.addEventListener('click',e=>{const t=e.target;const box=t.closest('.loader');
  if(t.matches('.img-browse'))return post({type:'browseImage',module:box.dataset.loader,index:Number(t.closest('tr').dataset.orig)});
  if(t.matches('.img-remove'))return submit(box,t.closest('tr'));
  if(t.matches('.img-add'))return post({type:'addImage',module:box.dataset.loader});
  if(t.matches('.add-loader'))return post({type:'addLoader'});
  if(t.matches('.sym-browse'))return post({type:'browseSymbols'});
  if(t.matches('.sym-clear'))return post({type:'clearSymbols'});
  if(t.closest('input,select,button,label,.loader,.symbols,.mod-panel,.node,.outline,.dtabs,.head,.stats'))return;
  reveal(t);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&S.route&&!e.target.closest('input,select,textarea')){pinRoute(null);return;}
  const rt=e.target.closest('.routable[data-route-region]');if(rt&&!e.target.closest('a,button')&&(e.key==='Enter'||e.key===' ')){e.preventDefault();pinRoute(specOf(rt));return;}
  const tg=e.target.closest('.sub-toggle');if(tg&&(e.key==='Enter'||e.key===' ')){e.preventDefault();e.stopPropagation();post({type:'toggleSubsystem',module:tg.dataset.module});return;}
  const n=e.target.closest('.node');if(n&&(e.key==='Enter'||e.key===' ')){e.preventDefault();select(n.dataset.module,true);}});
</script></body></html>`;
}

module.exports = { render, diagram, groups, paramsSection, subsystems, roleOf, cpuLabel, fmtAddr, summary, lookupAddress, parseAddress, interruptLines, deviceTreePane, ROLE_LABEL, ROLE_ORDER };
