'use strict';
// Entry point of the VP Studio application: tells Theia where its extensions
// are, then starts Theia's own Electron main process.
const path = require('path');
const os = require('os');

// Extensions that come with the application (VP Studio, CDT GDB, JSON), next to it.
if (!process.env.THEIA_DEFAULT_PLUGINS) {
  process.env.THEIA_DEFAULT_PLUGINS = `local-dir:${path.resolve(__dirname, '..', 'plugins')}`;
}
// Extensions the user installs (from Open VSX or a .vsix), kept in the home folder.
if (!process.env.THEIA_PLUGINS) {
  process.env.THEIA_PLUGINS = `local-dir:${path.join(os.homedir(), '.vp-studio', 'plugins')}`;
}

require('../lib/backend/electron-main');
