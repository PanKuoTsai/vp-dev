'use strict';
// ESLint: npm run lint. The rules are ESLint's recommended set, which finds
// mistakes (a name that does not exist, a variable never used, an unreachable
// statement) and says nothing about formatting.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'theia/', '**/build/', 'catalog/', 'examples/', 'templates/', 'patches/', 'prebuilt/'] },
  js.configs.recommended,
  {
    // The extension, the command line, the libraries and the tests run in Node.js.
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: globals.node },
    rules: {
      // catch (e) { /* why it does not matter */ } is how this code ignores an error.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // An error caught and reported in the user's words is thrown without its cause on purpose.
      'preserve-caught-error': 'off',
      // Control characters are matched to remove them (console output in a JUnit report).
      'no-control-regex': 'off',
      // Tests match generated Lua with its indentation written out.
      'no-regex-spaces': 'off',
    },
  },
  {
    // The page scripts run in a webview.
    files: ['media/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, acquireVsCodeApi: 'readonly' } },
    // A page may name its own function like something a browser has (when).
    rules: { 'no-redeclare': ['error', { builtinGlobals: false }] },
  },
  {
    // lib/webview/view.js puts these four of its functions into the page when it makes it.
    files: ['media/platform.js'],
    languageOptions: { globals: { fmtAddr: 'readonly', parseAddress: 'readonly', lookupAddress: 'readonly', routeFor: 'readonly' } },
  },
];
