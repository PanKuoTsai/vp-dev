'use strict';
// The at_bus "masters" parameter: QoS settings per master, written as
//   "display: priority=3 min_mbps=6000; cpu: max_mbps=8000 outstanding=8"
// (entries separated by ";" or new lines, settings by spaces or commas).
// perf.so parses the same text (systemc-components/perf/src/perf.cc,
// at_bus::parse_masters); keep the two in step.

const KEYS = {
  priority: 'replaces the traffic_gen qos on this bus (arbitration "priority"; higher wins)',
  max_mbps: 'bandwidth limit in MB/s',
  min_mbps: 'reserved bandwidth in MB/s: within it the master goes before everyone else',
  outstanding: 'most accesses of the master in flight through this bus',
  window_ns: 'averaging window of max_mbps and min_mbps in ns (default 1000)',
};

/** {entries: [{name, settings: {key: number}}], errors: [string]} */
function parseMasters(text) {
  const entries = [];
  const errors = [];
  for (const raw of String(text || '').split(/[;\n]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const colon = entry.indexOf(':');
    const name = (colon < 0 ? entry : entry.slice(0, colon)).replace(/\s+/g, '');
    if (colon < 0 || !name) { errors.push(`"${entry}" is not <master>: key=value ...`); continue; }
    const settings = {};
    for (const pair of entry.slice(colon + 1).split(/[\s,]+/).filter(Boolean)) {
      const eq = pair.indexOf('=');
      if (eq < 0) { errors.push(`${name}: "${pair}" is not key=value`); continue; }
      const k = pair.slice(0, eq);
      const v = pair.slice(eq + 1);
      if (!(k in KEYS)) { errors.push(`${name}: unknown key ${k} (${Object.keys(KEYS).join(', ')})`); continue; }
      const n = Number(v);
      if (v.trim() === '' || !Number.isFinite(n)) { errors.push(`${name}: ${k} needs a number, got "${v}"`); continue; }
      if (n < 0) { errors.push(`${name}: ${k} cannot be negative`); continue; }
      settings[k] = n;
    }
    entries.push({ name, settings });
  }
  return { entries, errors };
}

/** The text for entries, in their order: "a: priority=3; b: max_mbps=8000". */
function formatMasters(entries) {
  return entries.map((e) => {
    const s = Object.entries(e.settings).map(([k, v]) => `${k}=${v}`).join(' ');
    return s ? `${e.name}: ${s}` : `${e.name}:`;
  }).join('; ');
}

/** text with one setting of one master changed (the master is added when missing). Throws on a bad key. */
function setMaster(text, master, key, value) {
  if (!(key in KEYS)) throw new Error(`unknown QoS key ${key} (${Object.keys(KEYS).join(', ')})`);
  const { entries } = parseMasters(text);
  let e = entries.find((x) => x.name === master);
  if (!e) entries.push(e = { name: master, settings: {} });
  e.settings[key] = Number(value);
  return formatMasters(entries);
}

/** A master as the bus matches it: its label, its full name, or a dotted tail of the full name. */
function matches(entryName, fullName, label) {
  if (entryName === label || entryName === fullName) return true;
  return fullName.endsWith('.' + entryName);
}

/**
 * A sweep or --param key that sets one QoS value: "mau0.masters.display.min_mbps"
 * -> {instance: "mau0", master: "display", key: "min_mbps"}, else null.
 * The master is written without dots (its label or the last part of its name).
 */
function qosPath(key) {
  const m = /^(.+)\.masters\.([^.]+)\.([a-z_]+)$/.exec(String(key));
  return m && m[3] in KEYS ? { instance: m[1], master: m[2], key: m[3] } : null;
}

module.exports = { KEYS, parseMasters, formatMasters, setMaster, matches, qosPath };
