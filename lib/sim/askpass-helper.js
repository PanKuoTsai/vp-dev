'use strict';
// The SSH_ASKPASS program of VP Studio (see askpass.js): ssh runs it with the
// prompt as its only argument and reads the answer from its standard output.
// It asks the VP Studio window over 127.0.0.1 (port and token from the
// environment ssh passes on). Exit code 1 when there is no answer, so ssh gives up.

const net = require('net');

const port = Number(process.env.VP_ASKPASS_PORT);
const token = process.env.VP_ASKPASS_TOKEN || '';
const prompt = process.argv.slice(2).join(' ');

if (!port || !token) {
  process.stderr.write('VP Studio askpass: no VP Studio window to ask\n');
  process.exit(1);
}

const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
  socket.write(JSON.stringify({ token, host: process.env.VP_ASKPASS_HOST || '', prompt }) + '\n');
});
let buf = '';
socket.setEncoding('utf8');
socket.on('data', (d) => { buf += d; });
socket.on('error', (e) => { process.stderr.write(`VP Studio askpass: ${e.message}\n`); process.exit(1); });
socket.on('end', () => {
  let r;
  try { r = JSON.parse(buf.trim()); } catch (e) { process.exit(1); }
  if (typeof r.answer !== 'string') {
    if (r.error && r.error !== 'no answer') process.stderr.write(`VP Studio askpass: ${r.error}\n`);
    process.exit(1);
  }
  process.stdout.write(r.answer + '\n', () => process.exit(0));
});
