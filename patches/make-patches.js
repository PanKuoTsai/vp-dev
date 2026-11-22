#!/usr/bin/env node
'use strict';
// Writes the patches whose content is VP Studio's own source.
//
//   node patches/make-patches.js           write the patch files
//   node patches/make-patches.js --check   only say whether they are up to date (exit code 1 if not)
//
// A patch that adds whole components to QBox is kept as those files, so they
// can be read, edited and reviewed as source:
//
//   patches/<group>/src/<name>/message.txt   the head of the patch: From, Subject, description
//   patches/<group>/src/<name>/changes.diff  its changes to files QBox already has
//   patches/<group>/src/<name>/tree/...      the files it adds, at their path in QBox
//
// and patches/<group>/<name>.patch is made from them. The patch is committed
// too, because it is what tools/qbox-pin/build-qbox.sh applies and what
// qbox.pin.json names: after changing the source, run this and commit both.
// test/patches.test.js fails when they differ.
//
// A patch without a src folder (a fix to QBox's or libqemu's own code) is
// written by hand and not touched here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const lf = (s) => s.replace(/\r\n/g, '\n'); // a Windows checkout may have CRLF; a patch never does

/** The patches that have a source folder: [{ name, group, dir, file }]. */
function sources(root = ROOT) {
  const out = [];
  for (const group of fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const src = path.join(root, group, 'src');
    if (!fs.existsSync(src)) continue;
    for (const name of fs.readdirSync(src, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      out.push({ name, group, dir: path.join(src, name), file: path.join(root, group, name + '.patch') });
    }
  }
  return out;
}

/** The files below dir, as paths with "/". */
function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else out.push(r);
  }
  return out;
}

/** The first 8 characters of git's name for a file with this content, as in the patch's index line. */
const blobId = (text) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex').slice(0, 8);

/** The part of a patch that adds one file. */
function added(file, text) {
  if (text === '' || !text.endsWith('\n')) throw new Error(`${file}: a file a patch adds must end with a line break and not be empty`);
  const lines = text.slice(0, -1).split('\n');
  return [
    `diff --git a/${file} b/${file}`, 'new file mode 100644', `index 00000000..${blobId(text)}`, '--- /dev/null', `+++ b/${file}`,
    `@@ -0,0 +1${lines.length === 1 ? '' : ',' + lines.length} @@`, ...lines.map((l) => '+' + l), '',
  ].join('\n');
}

/** The text of the patch made from a source folder. */
function generate(dir) {
  const message = lf(fs.readFileSync(path.join(dir, 'message.txt'), 'utf8'));
  const parts = []; // { file, text }, in the order git writes them: by path
  const changesFile = path.join(dir, 'changes.diff');
  if (fs.existsSync(changesFile)) {
    for (const section of lf(fs.readFileSync(changesFile, 'utf8')).split(/^(?=diff --git )/m).filter(Boolean)) {
      const m = /^diff --git a\/(\S+) b\/\1\n/.exec(section);
      if (!m) throw new Error(`${changesFile}: a part does not start with "diff --git a/<file> b/<file>"`);
      parts.push({ file: m[1], text: section });
    }
  }
  const tree = path.join(dir, 'tree');
  for (const file of fs.existsSync(tree) ? walk(tree) : []) {
    if (parts.some((p) => p.file === file)) throw new Error(`${file} is both added (tree) and changed (changes.diff)`);
    parts.push({ file, text: added(file, lf(fs.readFileSync(path.join(tree, file), 'utf8'))) });
  }
  if (!parts.length) throw new Error(`${dir}: nothing to put in the patch`);
  parts.sort((a, b) => Buffer.compare(Buffer.from(a.file), Buffer.from(b.file)));
  return message + parts.map((p) => p.text).join('');
}

/** For each patch with a source folder: { name, file, current (whether the file is what generate gives) }. */
function check(root = ROOT) {
  return sources(root).map((s) => {
    const text = generate(s.dir);
    const current = fs.existsSync(s.file) && lf(fs.readFileSync(s.file, 'utf8')) === text;
    return { name: s.name, file: s.file, text, current };
  });
}

if (require.main === module) {
  const onlyCheck = process.argv.includes('--check');
  let stale = 0;
  for (const r of check()) {
    const rel = path.relative(path.join(ROOT, '..'), r.file).split(path.sep).join('/');
    if (r.current) console.log(`up to date  ${rel}`);
    else if (onlyCheck) { stale++; console.log(`differs     ${rel} (run node patches/make-patches.js)`); }
    else { fs.writeFileSync(r.file, r.text); console.log(`written     ${rel}`); }
  }
  process.exit(stale ? 1 : 0);
}

module.exports = { sources, generate, check, added, blobId };
