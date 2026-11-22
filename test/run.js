'use strict';
// Runs every test file (test/*.test.js) in one process: node test/run.js
// Names given on the command line run only those: node test/run.js core view
const fs = require('fs');
const path = require('path');

const all = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
const wanted = process.argv.slice(2).map((n) => path.basename(n).replace(/(\.test)?\.js$/, '') + '.test.js');
const missing = wanted.filter((f) => !all.includes(f));
if (missing.length) {
  console.error('no such test file: ' + missing.join(', '));
  process.exit(2);
}
for (const f of wanted.length ? wanted : all) {
  console.log('# ' + f);
  require(path.join(__dirname, f));
}
