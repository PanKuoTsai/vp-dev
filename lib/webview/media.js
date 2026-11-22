'use strict';
// The style sheets and page scripts of the webview pages are files in media/
// (theme.css for all of them, <page>.css and <page>.js for each). The pages
// allow only a nonce'd <style> and <script> (content security policy), so the
// files are not linked: their text is put into those elements when the page
// is made. No VS Code dependency.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'media');
const cache = new Map();

/**
 * The text of media/<name>, without the line break at its end and with "\n"
 * line breaks (a Windows checkout may have "\r\n"). Read once: a changed file
 * shows after the window is reloaded, like any other source file.
 */
function read(name) {
  let text = cache.get(name);
  if (text === undefined) {
    text = fs.readFileSync(path.join(DIR, name), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
    cache.set(name, text);
  }
  return text;
}

module.exports = { read, DIR };
