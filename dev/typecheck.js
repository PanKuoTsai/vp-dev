#!/usr/bin/env node
'use strict';
// Type checks the JavaScript sources with TypeScript (dev/tsconfig.json) and
// compares what it finds with dev/typecheck-baseline.txt.
//
//   npm run typecheck              fails when there is a finding the baseline does not have
//   npm run typecheck -- --update  rewrites the baseline from what is found now
//   npm run typecheck -- --all     prints every finding, with its place
//
// The sources have few type annotations, so the checker reports many things
// that are not mistakes (it takes "{ a = 1 } = {}" for "an object with only
// a", a BigInt read from JSON for a number, ...). Those are in the baseline:
// one line each, "<file> TS<code> <message>", without the line number so that
// editing a file does not change them. What the check is for is the next
// mistake: a function of another file that does not exist, a wrong argument to
// a VS Code or Node.js call. A finding that is new is either fixed or, when it
// is not a mistake, added with --update. A finding that is gone is reported
// too, so the baseline can be made shorter.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = path.join(__dirname, '..');
const baselineFile = path.join(__dirname, 'typecheck-baseline.txt');
const posix = (p) => p.split(path.sep).join('/');

/** tsc's findings: [{ file, line, code, message, key }]. key is what the baseline holds. */
function findings() {
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) throw new Error('TypeScript is not installed: run npm install first');
  const r = cp.spawnSync(process.execPath, [tsc, '-p', path.join(__dirname, 'tsconfig.json'), '--pretty', 'false'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  const here = [posix(root) + '/', root + path.sep, root.replace(/\\/g, '\\\\') + '\\\\'];
  const out = [];
  for (const raw of (r.stdout + r.stderr).split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),\d+\): error TS(\d+): (.*)$/.exec(raw);
    if (!m) {
      if (/error TS\d+/.test(raw)) throw new Error('tsc: ' + raw); // a problem with the configuration, not with a file
      continue;
    }
    let message = m[4];
    for (const h of here) message = message.split(h).join(''); // types are named with the path of their file
    const file = posix(path.relative(root, path.resolve(root, m[1])));
    out.push({ file, line: Number(m[2]), code: m[3], message, key: `${file} TS${m[3]} ${message}` });
  }
  return out;
}

const count = (keys) => { const c = new Map(); for (const k of keys) c.set(k, (c.get(k) || 0) + 1); return c; };

function main(args) {
  const found = findings();
  if (args.includes('--all')) {
    for (const f of found) console.log(`${f.file}:${f.line} TS${f.code} ${f.message}`);
    console.log(`${found.length} findings`);
    return 0;
  }
  const keys = found.map((f) => f.key).sort();
  if (args.includes('--update')) {
    fs.writeFileSync(baselineFile, keys.join('\n') + (keys.length ? '\n' : ''));
    console.log(`dev/typecheck-baseline.txt: ${keys.length} findings`);
    return 0;
  }
  const base = fs.existsSync(baselineFile) ? fs.readFileSync(baselineFile, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  const have = count(base);
  const now = count(keys);
  const fresh = [];
  const seen = new Map();
  for (const f of found) { // a finding is new when there are more of it than the baseline has
    const n = (seen.get(f.key) || 0) + 1;
    seen.set(f.key, n);
    if (n > (have.get(f.key) || 0)) fresh.push(f);
  }
  const gone = [...have].filter(([k, n]) => (now.get(k) || 0) < n).map(([k, n]) => `${k}${n - (now.get(k) || 0) > 1 ? ` (${n - (now.get(k) || 0)} times)` : ''}`);
  for (const f of fresh) console.log(`${f.file}:${f.line} TS${f.code} ${f.message}`);
  if (fresh.length) {
    console.log(`\n${fresh.length} new finding${fresh.length > 1 ? 's' : ''} (${found.length} in all, ${base.length} in the baseline).`);
    console.log('Fix them, or, for one that is not a mistake: npm run typecheck -- --update');
    return 1;
  }
  if (gone.length) {
    console.log(`${gone.length} finding${gone.length > 1 ? 's are' : ' is'} in the baseline and no longer found:`);
    for (const g of gone) console.log('  ' + g);
    console.log('Make the baseline shorter: npm run typecheck -- --update');
    return 1;
  }
  console.log(`type check: no new findings (${found.length}, all in the baseline)`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { findings, main };
