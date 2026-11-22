'use strict';
// What several test files share: the example platform, the bundled catalog, and files built for a test.
const fs = require('fs');
const path = require('path');
const os = require('os');

const load = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'ubuntu-aarch64.platform.json'), 'utf8'));

const examplePath = path.join(__dirname, '..', 'examples', 'ubuntu-aarch64.platform.json');

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-'));
  fs.mkdirSync(path.join(dir, 'fw', 'Artifacts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fw', 'Artifacts', 'Image.bin'), Buffer.alloc(4096));
  fs.writeFileSync(path.join(dir, 'fw', 'Artifacts', 'ubuntu.dtb'), Buffer.alloc(512));
  fs.writeFileSync(path.join(dir, 'fw', 'Artifacts', 'image_ext4_initrd.img'), Buffer.alloc(1024));
  return dir;
}

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));

const exampleText = () => fs.readFileSync(path.join(__dirname, '..', 'examples', 'ubuntu-aarch64.platform.json'), 'utf8');

module.exports = { load, examplePath, workspace, catalog, exampleText };
