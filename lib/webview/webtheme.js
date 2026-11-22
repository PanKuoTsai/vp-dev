'use strict';
// Look shared by VP Studio's webviews (platform view, transaction trace,
// profile): colors as --vp-* tokens over the VS Code theme (one set for dark
// themes, one for light), buttons, inputs, tables, the header and the strip of
// key figures (media/theme.css). Pages put `css` in their nonce'd <style>. No VS Code dependency.

const media = require('./media');

// Button icons, drawn in the button's text color.
const ICON = {
  play: '<svg class="ico" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path class="fill" d="M4.5 2.8v10.4L13 8z"/></svg>',
  add: '<svg class="ico" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
  code: '<svg class="ico" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3 7 13"/></svg>',
  record: '<svg class="ico" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle class="fill" cx="8" cy="8" r="4.5"/></svg>',
  stop: '<svg class="ico" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect class="fill" x="4" y="4" width="8" height="8" rx="1.5"/></svg>',
  clear: '<svg class="ico" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/></svg>',
  download: '<svg class="ico" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/></svg>',
  follow: '<svg class="ico" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3.5 13.5h9"/></svg>',
  reset: '<svg class="ico" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.5-3.5M3 3v3h3"/></svg>',
  list: '<svg class="ico" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.5M2.5 8h.5M2.5 12h.5"/></svg>',
  file: '<svg class="ico" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h5l3 3v9H4zM9 2v3h3"/></svg>',
  pulse: '<svg class="brand" width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7"/><path class="pins" d="M6 17h5l2.5-6 4 11 2.5-5H26"/></svg>',
  flame: '<svg class="brand" width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7"/><path class="pins" d="M16 6c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-4.5 2-7 2 1 3 2.5 3 4 1.5-1.5 1-5 1-9z"/></svg>',
};

const BRAND = '<svg class="brand" width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7"/>' +
  '<rect class="die" x="10" y="10" width="12" height="12" rx="2"/><path class="pins" d="M13 6v4M19 6v4M13 22v4M19 22v4M6 13h4M6 19h4M22 13h4M22 19h4"/></svg>';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const css = media.read('theme.css') + '\n';

module.exports = { css, ICON, BRAND, esc };
