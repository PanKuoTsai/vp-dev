'use strict';
// A transaction trace as a traffic_gen replay file (the perf models of
// QBox's systemc-components/perf): one line per access, time_ns,R|W,address,
// length. It carries the timing of a real run into an architecture model.
// No VS Code dependency.
//
// Two ways to turn a traced access into a replayed one:
// - as it is: the same direction and length, its address moved into the
//   model's range (base + the offset from the lowest traced address, wrapped
//   at span);
// - as a request (bytes set): every traced access stands for a transfer of
//   `bytes` that the trace does not show. For a device, its doorbell write
//   (virtio's QueueNotify) marks a request whose DMA happens in QEMU, out of
//   the trace's sight. The transfers go to consecutive addresses from base,
//   wrapped at span, in the direction chosen (`as`).

/** Records (trace.decodeRecords) the choice keeps: point, direction, address, time window. */
function select(records, { point = null, dir = null, address = null, from = null, to = null } = {}) {
  const addr = address === null || address === undefined || address === '' ? null : BigInt(address);
  return records.filter((r) => r.dir !== 'S'
    && (!point || r.point === point)
    && (!dir || r.dir === dir)
    && (addr === null || BigInt(r.address) === addr)
    && (from === null || r.time >= from)
    && (to === null || r.time <= to));
}

/**
 * The replay file for the chosen records.
 * opts: select()'s options, and
 *   bytes      null: replay each access as it is; a number: each access stands
 *              for a transfer of that many bytes (a request)
 *   totalBytes instead of bytes: the bytes the requests moved in all (a
 *              device's own counters, e.g. sectors written x 512), spread
 *              evenly over them (rounded up to a multiple of burst)
 *   burst      split each request into accesses of at most this many bytes
 *              at the same time, as a DMA engine does (default: none)
 *   window     keep only the first `window` seconds after the first chosen
 *              access (applied after from/to)
 *   as         'R' or 'W': the direction of those transfers (default 'W')
 *   base, span where the replayed addresses go (BigInt or number; span 0: no wrap)
 *   timeScale  times are multiplied by it (0.001: 1000 times faster); default 1
 *   title      a line for the header
 * Returns { text, count (requests), lines (accesses written), requestBytes, spanNs, bytes (total), first (s), last (s) }.
 * Throws when nothing matches.
 */
function toReplay(records, opts = {}) {
  let picked = select(records, opts).slice().sort((a, b) => a.time - b.time || a.seq - b.seq);
  if (!picked.length) throw new Error('no access in the trace matches the choice');
  const all = picked.length;
  if (opts.window !== undefined && opts.window !== null && opts.window !== '') {
    const w = Number(opts.window);
    if (!(w > 0)) throw new Error('window must be a number of seconds above 0');
    picked = picked.filter((r) => r.time - picked[0].time <= w);
  }
  const burst = opts.burst === undefined || opts.burst === null || opts.burst === '' ? null : Number(opts.burst);
  if (burst !== null && !(Number.isInteger(burst) && burst > 0)) throw new Error('burst must be a whole number above 0');
  if (opts.totalBytes !== undefined && opts.totalBytes !== null && opts.totalBytes !== '') {
    const tb = Number(opts.totalBytes);
    if (!(tb > 0)) throw new Error('totalBytes must be a number above 0');
    const unit = burst || 64;
    opts = Object.assign({}, opts, { bytes: Math.max(unit, Math.ceil(tb / all / unit) * unit) });
  }
  const scale = Number(opts.timeScale === undefined ? 1 : opts.timeScale);
  if (!(scale > 0)) throw new Error('timeScale must be greater than 0');
  const base = BigInt(opts.base || 0);
  const span = BigInt(opts.span || 0);
  const bytes = opts.bytes === null || opts.bytes === undefined || opts.bytes === '' ? null : Number(opts.bytes);
  if (bytes !== null && !(Number.isInteger(bytes) && bytes > 0)) throw new Error('bytes must be a whole number above 0');
  if (span && bytes !== null && BigInt(bytes) > span) throw new Error('the span is smaller than one transfer');
  const as = opts.as === 'R' ? 'R' : 'W';
  const t0 = picked[0].time;
  const low = picked.reduce((m, r) => (BigInt(r.address) < m ? BigInt(r.address) : m), BigInt(picked[0].address));
  const lines = [];
  let total = 0;
  let next = 0n;
  for (const r of picked) {
    const ns = (r.time - t0) * 1e9 * scale;
    let addr;
    let len;
    let rw;
    if (bytes === null) {
      len = r.length;
      rw = r.dir;
      const off = BigInt(r.address) - low;
      addr = base + (span ? off % span : off);
    } else {
      len = bytes;
      rw = as;
      if (span && next + BigInt(bytes) > span) next = 0n;
      addr = base + next;
      next += BigInt(bytes);
    }
    total += len;
    const t = ns.toFixed(1);
    if (burst && len > burst) {
      for (let off = 0; off < len; off += burst) lines.push(`${t},${rw},0x${(addr + BigInt(off)).toString(16)},${Math.min(burst, len - off)}`);
    } else lines.push(`${t},${rw},0x${addr.toString(16)},${len}`);
  }
  const first = picked[0].time;
  const last = picked[picked.length - 1].time;
  const spanNs = (last - first) * 1e9 * scale;
  const what = (bytes === null ? 'each traced access as it is' : `each traced access as a ${bytes}-byte ${as === 'R' ? 'read' : 'write'} (a request)`)
    + (burst ? ` in bursts of ${burst} bytes` : '');
  const header = [
    `# traffic_gen replay file: time_ns,R|W,address,length${opts.title ? ` — ${opts.title}` : ''}`,
    `# from ${picked.length} traced accesses${opts.point ? ` at ${opts.point}` : ''}${opts.dir ? ` (${opts.dir === 'R' ? 'reads' : 'writes'})` : ''}${opts.address ? ` to ${opts.address}` : ''}, ${what}`,
    `# trace time ${first.toFixed(6)} s to ${last.toFixed(6)} s; replay times from 0${scale !== 1 ? `, scaled by ${scale}` : ''}; addresses from 0x${base.toString(16)}${span ? ` within 0x${span.toString(16)} bytes` : ''}`,
  ];
  return { text: header.concat(lines).join('\n') + '\n', count: picked.length, lines: lines.length, requestBytes: bytes, spanNs, bytes: total, first, last };
}

/**
 * The (point, direction, address) groups of the records, most frequent first,
 * for choosing what to replay: [{ point, dir, address, count }].
 */
function groups(records, limit = 30) {
  const m = new Map();
  for (const r of records) {
    if (r.dir === 'S') continue;
    const k = `${r.point}\u0000${r.dir}\u0000${r.address}`;
    const g = m.get(k) || { point: r.point, dir: r.dir, address: r.address, count: 0 };
    g.count++;
    m.set(k, g);
  }
  // Equal counts: writes first (a device's doorbell, which marks a request, is a write).
  return [...m.values()].sort((a, b) => b.count - a.count || (a.dir === b.dir ? 0 : a.dir === 'W' ? -1 : 1)).slice(0, limit);
}

module.exports = { select, toReplay, groups };
