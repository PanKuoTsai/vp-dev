const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
const post = (m) => { if (vscode) vscode.postMessage(m); };
const $ = (id) => document.getElementById(id);
let S = null; // the last state from the extension
let form = null;
const short = (c) => (c ? String(c).slice(0, 12) : '–');
const when = (t) => (t ? new Date(t).toLocaleString() : '');
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function fact(k, v, cls, tip) { const f = el('div', 'fact' + (cls ? ' ' + cls : '')); f.append(el('div', 'k', k)); const vv = el('div', 'v', v); if (tip) vv.title = tip; f.append(vv); return f; }
function stat(label, value, sub, cls) { const s = el('div', 'stat'); s.append(el('div', 'stat-label', label)); s.append(el('div', 'stat-value' + (cls ? ' ' + cls : ''), value)); s.append(el('div', 'stat-sub', sub || '')); return s; }
function send() { post({ type: 'set', form }); }
function draw() {
  const st = S.status, ch = S.check || { errors: [], warnings: [], changes: [] };
  const running = !!S.running;
  const ready = st.kind === 'qbox' && st.cache && st.cache.configured;
  const state = $('state');
  state.className = 'status ' + (running ? 'live' : S.last && S.last.code !== 0 && S.last.code !== undefined ? 'bad' : ready && st.products[0].exists ? 'good' : 'idle');
  $('state-t').textContent = running ? 'Building…' : S.last && S.last.code !== 0 && S.last.code !== undefined ? 'Last build failed' : !form.src ? 'No QBox folder' : st.kind === 'empty' ? 'Not cloned yet' : !ready ? 'Not configured' : st.products[0].exists ? 'Built' : 'Configured, not built';
  $('desc').textContent = form.src ? form.src : 'Choose the QBox folder VP Studio runs.';
  // Figures
  const stats = $('stats'); stats.textContent = '';
  stats.append(stat('QBox commit', st.head ? short(st.head) : st.kind === 'empty' ? 'to clone' : '–', st.atPin ? 'the pinned commit' : st.head ? 'pinned ' + short(st.pinned) : '', st.head && !st.atPin ? 'warn' : ''));
  stats.append(stat('Build directory', st.cache && st.cache.configured ? (st.cache.preset + (st.cache.targets ? ' · ' + st.cache.targets.join(', ') : '')) : 'not configured', st.cache && st.cache.configured ? (st.cache.cpm ? 'cache ' + st.cache.cpm : 'no package cache') : ''));
  const ap = st.patches.filter((p) => p.applied === true).length;
  stats.append(stat('Patches', st.patches.length ? ap + ' / ' + st.patches.length : '–', 'applied', st.patches.length && ap < st.patches.length ? 'warn' : ''));
  const pv = st.products[0];
  stats.append(stat('Simulator', pv.exists ? 'built' : 'missing', pv.exists ? when(pv.mtime) : 'build/platforms-vp', pv.exists ? '' : 'warn'));
  const pr = st.products.slice(1).filter((p) => p.exists).length;
  const want = st.products.length - 1;
  stats.append(stat('VP Studio components', pr + ' / ' + want, st.products.slice(1).map((p) => p.file).join(', '), pr < want ? 'warn' : ''));
  const dp = S.deps;
  stats.append(stat('Host packages', !dp ? 'checking…' : dp.missing.length ? dp.missing.length + ' missing' : 'all present', !dp ? '' : dp.missing.length ? 'see Build' : 'tools and libraries QBox needs', dp && dp.missing.length ? 'warn' : ''));
  stats.append(stat('Sim agent', st.agent && st.agent.exists ? (st.agent.version || 'built') : 'not built', st.agent && st.agent.older ? 'older than probes.so: rebuild' : '', st.agent && st.agent.older ? 'warn' : ''));
  // 1 QBox folder
  if (document.activeElement !== $('src')) $('src').value = form.src || '';
  $('src-kind').textContent = { qbox: 'QBox source', empty: 'empty: cloned at the pinned commit', other: 'not a QBox source folder' }[st.kind] || '';
  const sf = $('src-facts'); sf.textContent = '';
  if (st.kind === 'qbox') {
    sf.append(fact('Commit', short(st.head), st.atPin ? 'good' : 'warn', st.head || ''));
    sf.append(fact('Pinned', short(st.pinned), '', st.pinned || ''));
    sf.append(fact('Local changes', st.dirty === null ? 'unknown' : st.dirty ? 'yes' : 'none', st.dirty ? 'warn' : ''));
  }
  $('checkout-box').hidden = !(st.kind === 'qbox' && st.head && !st.atPin);
  $('checkout').checked = !!form.checkout;
  $('checkout-d').textContent = st.dirty ? 'The folder has local changes to tracked files: commit or stash them first.' : 'Off: builds the folder at its current commit.';
  // 2 settings
  const pre = $('preset'); pre.textContent = '';
  for (const p of S.choices.presets) { const o = el('option', '', p.label + (st.cache && st.cache.configured && p.name === st.cache.preset ? '  (configured)' : '')); o.value = p.name; pre.append(o); }
  pre.value = form.preset;
  $('cfg-was').textContent = st.cache && st.cache.configured ? 'configured: ' + st.cache.compiler + ', ' + (st.cache.buildType || '?') : '';
  const tg = $('targets'); tg.textContent = '';
  for (const t of S.choices.targets) {
    const on = form.targets.includes(t);
    const b = el('label', 'tgt' + (on ? ' on' : ''));
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = on; cb.dataset.target = t;
    b.append(cb, document.createTextNode(t));
    if (st.cache && st.cache.targets && st.cache.targets.includes(t)) b.append(el('span', 'was', 'built'));
    tg.append(b);
  }
  if (document.activeElement !== $('jobs')) $('jobs').value = form.jobs;
  // 3 cache
  const ca = $('cache'); ca.textContent = '';
  for (const c of S.choices.cache) {
    const on = form.cache.mode === c.id || (c.id === 'choose' && form.cache.mode === 'custom');
    const o = el('label', 'opt' + (on ? ' on' : ''));
    const r = el('input'); r.type = 'radio'; r.name = 'cache'; r.checked = on; r.dataset.id = c.id; if (c.dir) r.dataset.dir = c.dir;
    const t = el('div'); t.append(el('div', 't' + (c.dir ? ' mono' : ''), c.id === 'choose' ? 'Another folder' : c.label)); t.append(el('div', 'd', c.detail));
    o.append(r, t); ca.append(o);
  }
  const custom = form.cache.mode === 'custom';
  $('cache-custom').hidden = !custom;
  if (document.activeElement !== $('cache-dir')) $('cache-dir').value = custom ? form.cache.dir || '' : '';
  // 4 patches
  $('patches').checked = form.patches !== false;
  const pl = $('plist'); pl.textContent = '';
  for (const p of st.patches) {
    const li = el('li');
    li.append(el('span', 'st ' + (p.applied === true ? 'yes' : 'no'), p.applied === true ? 'applied' : p.applied === false ? 'not applied' : 'unknown'));
    li.append(el('span', 'mono', p.target));
    const t = el('span', 'ttl', p.title || p.file); t.title = p.file; li.append(t);
    pl.append(li);
  }
  if (!st.patches.length) pl.append(el('li', 'muted', st.kind === 'empty' ? 'Applied after the clone.' : 'No patch information.'));
  // 5 after
  $('agent').checked = !!form.agent;
  $('useForSim').checked = !!form.useForSim;
  $('use-d').textContent = S.simulator === S.built ? 'VP Studio already uses ' + S.built + '.' : 'Sets vpStudio.executable to ' + S.built + ' (now ' + S.simulator + ').';
  // Build
  const msgs = $('msgs'); msgs.textContent = '';
  const missing = dp && dp.missing.length ? dp.missing : null;
  for (const e of ch.errors) {
    if (missing && /^This host lacks/.test(e)) {
      // The same error, with the list and the command to copy.
      const box = el('div', 'msg err deps');
      box.append(el('div', '', 'This host lacks what QBox\'s build needs:'));
      const ul = el('ul', 'dlist');
      for (const i of missing) {
        const li = el('li');
        li.append(el('span', 'mono', i.what));
        li.append(el('span', 'd', i.state === 'old' ? i.note : 'package ' + i.pkg + (i.note ? ' · ' + i.note : '')));
        ul.append(li);
      }
      box.append(ul);
      if (dp.install) { box.append(el('div', '', 'Install them in a terminal on this host:')); box.append(el('pre', 'cmd', dp.install)); }
      else box.append(el('div', '', 'Install them with your distribution\'s package manager (the names are Ubuntu\'s), or see QBox\'s scripts/install_dependencies.sh.'));
      msgs.append(box);
    } else msgs.append(el('div', 'msg err', e));
  }
  for (const w of ch.warnings) msgs.append(el('div', 'msg warn', w));
  for (const c of ch.changes) msgs.append(el('div', 'msg chg', 'Changes ' + c + '.'));
  if (!ch.errors.length && !ch.warnings.length && !ch.changes.length) msgs.append(el('div', 'msg', ready ? 'Same settings as the build directory: builds what changed.' : st.kind === 'empty' ? 'First build: clones QBox and downloads its dependencies (network; about 20 minutes or more).' : 'First build of this QBox: configures and builds it (about 20 minutes or more).'));
  $('cmd').textContent = S.command || '';
  $('build').disabled = running || ch.errors.length > 0;
  $('move').hidden = !(S.compilerChange && !running);
  $('deps-actions').hidden = !missing;
  $('deps-copy').hidden = !(missing && dp.install);
  // Build Anyway only when the packages are the only reason Build is off.
  $('deps-skip').hidden = !(missing && ch.errors.length === 1) || running;
  $('cmt-off').hidden = !(st.cmakeTools && st.cmakeTools.auto.length);
  for (const b of document.querySelectorAll('button.run')) b.disabled = running;
  const last = $('last');
  last.className = 'last' + (S.last ? (S.last.code === 0 ? ' ok' : ' bad') : '');
  last.textContent = S.last ? (S.last.code === 0 ? 'Built ' : 'Failed (exit code ' + S.last.code + ') ') + when(S.last.at) + (S.last.text ? ' · ' + S.last.text : '') : '';
}
window.addEventListener('message', (ev) => {
  const m = ev.data || {};
  if (m.type === 'state') { S = m; form = JSON.parse(JSON.stringify(m.form)); draw(); }
});
$('src').addEventListener('change', () => { form.src = $('src').value.trim(); send(); });
$('src-browse').addEventListener('click', () => post({ type: 'browse', field: 'src' }));
$('checkout').addEventListener('change', () => { form.checkout = $('checkout').checked; send(); });
$('preset').addEventListener('change', () => { form.preset = $('preset').value; send(); });
$('targets').addEventListener('change', (e) => {
  const t = e.target.dataset.target; if (!t) return;
  form.targets = S.choices.targets.filter((x) => (x === t ? e.target.checked : form.targets.includes(x)));
  send();
});
$('jobs').addEventListener('change', () => { const n = Math.max(1, Math.min(256, Number($('jobs').value) || 1)); form.jobs = n; send(); });
$('cache').addEventListener('change', (e) => {
  const id = e.target.dataset.id; if (!id) return;
  if (id === 'choose') { form.cache = { mode: 'custom', dir: form.cache.mode === 'custom' ? form.cache.dir : '' }; send(); if (!form.cache.dir) post({ type: 'browse', field: 'cache' }); return; }
  form.cache = id === 'none' ? { mode: 'none', dir: null } : { mode: id, dir: e.target.dataset.dir };
  send();
});
$('cache-dir').addEventListener('change', () => { form.cache = { mode: 'custom', dir: $('cache-dir').value.trim() }; send(); });
$('cache-browse').addEventListener('click', () => post({ type: 'browse', field: 'cache' }));
$('patches').addEventListener('change', () => { form.patches = $('patches').checked; send(); });
$('agent').addEventListener('change', () => { form.agent = $('agent').checked; send(); });
$('useForSim').addEventListener('change', () => { form.useForSim = $('useForSim').checked; send(); });
$('build').addEventListener('click', () => post({ type: 'build' }));
$('move').addEventListener('click', () => post({ type: 'moveBuild' }));
$('deps-copy').addEventListener('click', () => post({ type: 'copyDeps' }));
$('deps-again').addEventListener('click', () => post({ type: 'depsAgain' }));
$('deps-skip').addEventListener('click', () => post({ type: 'build', skipDeps: true }));
$('cmt-off').addEventListener('click', () => post({ type: 'cmakeToolsOff' }));
for (const b of document.querySelectorAll('button.run')) b.addEventListener('click', () => post({ type: 'command', name: b.dataset.name }));
post({ type: 'ready' });
