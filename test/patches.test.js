'use strict';
// Run with: node test/patches.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shipped } = require('./helpers');
const make = require('../patches/make-patches');

const root = path.join(__dirname, '..');
const lf = (s) => s.replace(/\r\n/g, '\n');

test('patches: the ones kept as source are what make-patches.js writes', () => {
  // patches/qbox/src/<name>/ is the source of patches/qbox/<name>.patch: after changing it,
  // node patches/make-patches.js and commit both.
  const made = make.check();
  assert.deepStrictEqual(made.map((m) => m.name), ['0002-vp-studio-probes-debug-dap', '0003-vp-studio-perf-models']);
  for (const m of made) assert.ok(m.current, `${path.basename(m.file)} is not what its source gives: run node patches/make-patches.js`);
  // They are the patches the pin names, in this order.
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'qbox.pin.json'), 'utf8'));
  const pinned = pin.qbox.patches.map((p) => path.basename(p, '.patch'));
  assert.deepStrictEqual(made.map((m) => m.name), pinned.filter((p) => made.some((m) => m.name === p)));
  // Every file a patch adds is in its source, with the content the patch's index line names.
  for (const m of made) {
    const text = lf(fs.readFileSync(m.file, 'utf8'));
    const adds = [...text.matchAll(/^diff --git a\/(\S+) b\/\S+\nnew file mode 100644\nindex 00000000\.\.([0-9a-f]{8})$/gm)];
    assert.ok(adds.length >= 4, m.name);
    for (const [, file, id] of adds) {
      const src = path.join(root, 'patches', 'qbox', 'src', m.name, 'tree', file);
      assert.strictEqual(make.blobId(lf(fs.readFileSync(src, 'utf8'))), id, file);
    }
  }
});

test('patches: a patch made from a source folder (message, changed files, added files by path)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-patches-'));
  const src = path.join(dir, 'g', 'src', '0001-x');
  fs.mkdirSync(path.join(src, 'tree', 'b', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'message.txt'), 'From: t\nSubject: [PATCH] x\n\nWhy.\n---\n');
  fs.writeFileSync(path.join(src, 'changes.diff'), 'diff --git a/b/CMakeLists.txt b/b/CMakeLists.txt\nindex 1..2 100644\n--- a/b/CMakeLists.txt\n+++ b/b/CMakeLists.txt\n@@ -1 +1,2 @@\n one\n+two\n');
  fs.writeFileSync(path.join(src, 'tree', 'b', 'sub', 'one.h'), 'x\r\n'); // a Windows checkout: the patch still has "\n"
  fs.writeFileSync(path.join(src, 'tree', 'a.txt'), 'hello\nworld\n');
  const text = make.generate(src);
  assert.ok(!text.includes('\r'));
  // By path, as git orders them: a.txt, b/CMakeLists.txt, b/sub/one.h.
  assert.deepStrictEqual([...text.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]), ['a.txt', 'b/CMakeLists.txt', 'b/sub/one.h']);
  assert.ok(text.startsWith('From: t\nSubject: [PATCH] x\n\nWhy.\n---\ndiff --git a/a.txt b/a.txt\nnew file mode 100644\nindex 00000000..'));
  // git's own name for the content: "hello\nworld\n" is blob 94954abd.
  assert.ok(text.includes('index 00000000..94954abd\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n'));
  assert.ok(text.endsWith('+++ b/b/sub/one.h\n@@ -0,0 +1 @@\n+x\n'));
  // Written, then up to date; a changed source is noticed.
  assert.deepStrictEqual(make.check(dir).map((m) => m.current), [false]);
  fs.writeFileSync(path.join(dir, 'g', '0001-x.patch'), text);
  assert.deepStrictEqual(make.check(dir).map((m) => m.current), [true]);
  fs.appendFileSync(path.join(src, 'tree', 'a.txt'), 'more\n');
  assert.deepStrictEqual(make.check(dir).map((m) => m.current), [false]);
  // What cannot be put in a patch this way is refused.
  fs.writeFileSync(path.join(src, 'tree', 'a.txt'), 'no line break at the end');
  assert.throws(() => make.generate(src), /must end with a line break/);
  fs.writeFileSync(path.join(src, 'tree', 'a.txt'), 'ok\n');
  fs.mkdirSync(path.join(src, 'tree', 'b'), { recursive: true });
  fs.writeFileSync(path.join(src, 'tree', 'b', 'CMakeLists.txt'), 'both\n');
  assert.throws(() => make.generate(src), /both added \(tree\) and changed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('patches: the patches are packaged, their source and the tool that writes them are not', () => {
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'qbox.pin.json'), 'utf8'));
  for (const p of pin.qbox.patches.concat(pin.libqemu.patches)) assert.ok(shipped(p), p);
  assert.ok(shipped('patches/qbox/README.md'));
  assert.ok(!shipped('patches/make-patches.js'));
  assert.ok(!shipped('patches/qbox/src/0003-vp-studio-perf-models/tree/systemc-components/perf/src/perf.cc'));
  assert.ok(!shipped('patches/qbox/src/0003-vp-studio-perf-models/message.txt'));
});

test('patches: build-qbox.sh applies a patch, leaves an applied one, and updates an earlier version of one', () => {
  // tools/qbox-pin/apply-patch.sh, with git, on a stand-in for QBox's repository. When VP Studio is
  // updated and a patch changed, the QBox that has the earlier version must still build.
  const { spawnSync } = require('child_process');
  const sh = (script, env) => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
  if (sh('git --version').status !== 0) return; // no bash or no git on this machine
  const unix = (p) => p.split(path.sep).join('/');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-apply-'));
  // A patch like VP Studio's: two lines in a file QBox has, and two files it adds.
  const write = (name, readme) => {
    const src = path.join(dir, name, 'src', '0001-x');
    fs.mkdirSync(path.join(src, 'tree', 'comp', 'mine'), { recursive: true });
    fs.writeFileSync(path.join(src, 'message.txt'), 'From: t\nSubject: [PATCH] x\n---\n');
    fs.writeFileSync(path.join(src, 'changes.diff'), 'diff --git a/comp/CMakeLists.txt b/comp/CMakeLists.txt\n--- a/comp/CMakeLists.txt\n+++ b/comp/CMakeLists.txt\n@@ -1,3 +1,4 @@\n one\n two\n+add_subdirectory(mine)\n three\n');
    fs.writeFileSync(path.join(src, 'tree', 'comp', 'mine', 'README.md'), readme);
    fs.writeFileSync(path.join(src, 'tree', 'comp', 'mine', 'mine.cc'), 'int mine;\n');
    const file = path.join(dir, name + '.patch');
    fs.writeFileSync(file, make.generate(src));
    return unix(file);
  };
  const earlier = write('earlier', 'See lib/x.js.\n');
  const current = write('current', 'See lib/dir/x.js.\n');
  const env = { TREE: unix(path.join(dir, 'qbox')), SCRIPT: unix(path.join(root, 'tools', 'qbox-pin', 'apply-patch.sh')), EARLIER: earlier, CURRENT: current };
  const fresh = 'rm -rf "$TREE" && mkdir -p "$TREE/comp" && printf "one\\ntwo\\nthree\\n" > "$TREE/comp/CMakeLists.txt" && git -C "$TREE" init -q && git -C "$TREE" config core.autocrlf false'
    + ' && git -C "$TREE" add -A && git -C "$TREE" -c user.name=t -c user.email=t@example.com commit -q -m base && . "$SCRIPT"';
  const readme = () => fs.readFileSync(path.join(dir, 'qbox', 'comp', 'mine', 'README.md'), 'utf8');
  // Not applied, then applied already.
  let r = sh(`${fresh} && vp_apply_patch "$TREE" "$CURRENT" p && vp_apply_patch "$TREE" "$CURRENT" p`, env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(r.stdout.trim().split('\n'), ['== applying p', '== patch already applied: p']);
  assert.strictEqual(readme(), 'See lib/dir/x.js.\n');
  // The earlier version applied: only the file that differs is replaced, and the old one is kept.
  r = sh(`${fresh} && git -C "$TREE" apply "$EARLIER" && vp_apply_patch "$TREE" "$CURRENT" p && git -C "$TREE" apply --reverse --check "$CURRENT"`, env);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^== updating p \(an earlier version of it is applied\)\n {3}replaced comp\/mine\/README\.md \(the earlier one is kept as build\/vp-studio-replaced\/comp\/mine\/README\.md\)\n$/);
  assert.strictEqual(readme(), 'See lib/dir/x.js.\n');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'qbox', 'build', 'vp-studio-replaced', 'comp', 'mine', 'README.md'), 'utf8'), 'See lib/x.js.\n');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'qbox', 'comp', 'CMakeLists.txt'), 'utf8'), 'one\ntwo\nadd_subdirectory(mine)\nthree\n');
  // A file of QBox's own where the patch adds one: refused, nothing changed.
  r = sh(`${fresh} && mkdir -p "$TREE/comp/mine" && echo own > "$TREE/comp/mine/mine.cc" && git -C "$TREE" add -A && git -C "$TREE" -c user.name=t -c user.email=t@example.com commit -q -m own`
    + ' && { vp_apply_patch "$TREE" "$CURRENT" p; echo "returned $?"; } && git -C "$TREE" status --porcelain', env);
  assert.match(r.stdout, /^returned 1\n$/);
  assert.match(r.stderr, /== cannot apply p\nIt does not apply to comp\/mine\/mine\.cc/);
  assert.ok(!fs.existsSync(path.join(dir, 'qbox', 'comp', 'mine', 'README.md')));
  // build-qbox.sh uses it for QBox's and for libqemu's patches.
  const build = fs.readFileSync(path.join(root, 'tools', 'qbox-pin', 'build-qbox.sh'), 'utf8');
  assert.ok(build.includes('. "$here/apply-patch.sh"') && build.includes('vp_apply_patch "$dest" "$studio/$p" "$p"') && build.includes('vp_apply_patch "$lq" "$f" "$p (libqemu)"'));
  assert.ok(shipped('tools/qbox-pin/apply-patch.sh'));
  fs.rmSync(dir, { recursive: true, force: true });
});
