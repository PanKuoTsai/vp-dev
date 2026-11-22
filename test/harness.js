'use strict';
// The test functions every test file uses. A failed test throws and ends the
// run with exit code 1. Works for one file (node test/core.test.js) and for
// all of them loaded into one process (node test/run.js, which is npm test).
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok   ' + name); };
// Async tests run in order after all synchronous ones of every loaded file.
const asyncTests = [];
const testAsync = (name, fn) => asyncTests.push([name, fn]);

setImmediate(() => (async () => {
  for (const [name, fn] of asyncTests) {
    await fn();
    passed++;
    console.log('ok   ' + name);
  }
  console.log(`\n${passed} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); }));

module.exports = { test, testAsync };
