'use strict';
// Look shared by VP Studio's webviews (platform view, transaction trace,
// profile): colors as --vp-* tokens over the VS Code theme (one set for dark
// themes, one for light), buttons, inputs, tables, the header and the strip of
// key figures. Pages put `css` in their nonce'd <style>. No VS Code dependency.

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

const css = `:root{
  --vp-accent:#38BDF8;--vp-on-accent:#04121B;
  --vp-compute:#818CF8;--vp-memory:#F5A524;--vp-irq:#C084FC;--vp-periph:#34D399;--vp-pcie:#2DD4BF;--vp-boot:#F472B6;--vp-bus:#38BDF8;--vp-subsystem:#94A3B8;--vp-infra:#8B93A1;
  --vp-good:#6EE7B7;--vp-route:#FACC15;
  --vp-bg:var(--vscode-editor-background);
  --vp-panel:var(--vscode-sideBar-background,var(--vscode-editorWidget-background));
  --vp-card:var(--vscode-editorWidget-background,var(--vscode-editor-background));
  --vp-border:var(--vscode-widget-border,var(--vscode-panel-border,rgba(128,128,128,.32)));
  --vp-muted:var(--vscode-descriptionForeground);
  --vp-mono:var(--vscode-editor-font-family,ui-monospace,monospace);
}
body.vscode-light{
  --vp-accent:#0369A1;--vp-on-accent:#FFFFFF;
  --vp-compute:#4F46E5;--vp-memory:#B45309;--vp-irq:#9333EA;--vp-periph:#047857;--vp-pcie:#0F766E;--vp-boot:#BE185D;--vp-bus:#0369A1;--vp-subsystem:#64748B;--vp-infra:#6B7280;
  --vp-good:#047857;--vp-route:#A16207;
}
.role-compute{--rc:var(--vp-compute)}.role-memory{--rc:var(--vp-memory)}.role-irq{--rc:var(--vp-irq)}.role-periph{--rc:var(--vp-periph)}
.role-pcie{--rc:var(--vp-pcie)}.role-boot{--rc:var(--vp-boot)}.role-bus{--rc:var(--vp-bus)}.role-subsystem{--rc:var(--vp-subsystem)}.role-infra{--rc:var(--vp-infra)}
*{box-sizing:border-box}
body{margin:0;padding:0;font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vp-bg)}
.mono{font-family:var(--vp-mono)}.muted{color:var(--vp-muted)}
h1,h2,h3{margin:0;font-weight:600}
button{font-family:inherit;font-size:12.5px;color:var(--vscode-foreground);background:transparent;border:1px solid var(--vp-border);padding:0 11px;height:28px;border-radius:5px;cursor:pointer;white-space:nowrap}
button:hover{background:var(--vscode-toolbar-hoverBackground,var(--vscode-list-hoverBackground))}
button.primary{background:var(--vp-accent);color:var(--vp-on-accent);border-color:transparent;font-weight:600}
button.primary:hover{background:var(--vp-accent);filter:brightness(1.08)}
button.danger{color:var(--vscode-errorForeground)}
button.link{border:0;height:auto;padding:0 4px;color:var(--vscode-textLink-foreground);font-size:12px}
input[type=text],input[type=search],select{font-family:var(--vp-mono);font-size:12.5px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vp-border));padding:0 8px;height:28px;border-radius:5px}
input[type=search]{font-family:inherit}
input:focus,select:focus,button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
input:disabled,select:disabled{opacity:.55}
a{color:var(--vscode-textLink-foreground)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th,td{text-align:left;padding:5px 14px 5px 0;border-bottom:1px solid var(--vp-border);white-space:nowrap}
th{color:var(--vp-muted);font-weight:500;font-size:12px}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.swatch-dot{display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--rc,var(--vp-infra));flex:none}
/* ---- header */
.head{display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px;padding:14px 20px;border-bottom:1px solid var(--vp-border);background:var(--vp-panel)}
.brand rect:first-child{fill:color-mix(in srgb,var(--vp-accent) 14%,transparent);stroke:var(--vp-accent);stroke-width:1.5}
.brand .die{fill:none;stroke:var(--vp-accent);stroke-width:1.5}.brand .pins{stroke:var(--vp-accent);stroke-width:1.5;stroke-linecap:round}
.ident{display:flex;align-items:center;gap:12px;flex:1 1 360px;min-width:0}
.ident-text{min-width:0}.title-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px 10px}
.title-row h1{font-size:17px;letter-spacing:-.01em}
.tag{font-size:11px;color:var(--vp-muted);border:1px solid var(--vp-border);border-radius:4px;padding:1px 6px}
.status{height:22px;border-radius:999px;font-size:12px;padding:0 10px;display:inline-flex;align-items:center;gap:6px}
.status svg path{fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.status.good{color:var(--vp-good);border-color:color-mix(in srgb,var(--vp-good) 45%,transparent);background:color-mix(in srgb,var(--vp-good) 10%,transparent)}
.status.warn{color:var(--vscode-editorWarning-foreground);border-color:currentColor}
.status.bad{color:var(--vscode-errorForeground);border-color:currentColor}
.desc{margin:3px 0 0;color:var(--vp-muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.actions{display:flex;flex-wrap:wrap;gap:8px}.actions button{height:32px;padding:0 14px;display:inline-flex;align-items:center;gap:7px}
.ico{flex:none}.ico path{fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.ico path.fill{fill:currentColor;stroke:none}
button.tinted{background:color-mix(in srgb,var(--vp-accent) 22%,var(--vp-panel));border-color:color-mix(in srgb,var(--vp-accent) 70%,transparent);color:var(--vscode-foreground);font-weight:500}
button.tinted .ico{color:var(--vp-accent)}
body:not(.vscode-light) button.tinted{background:color-mix(in srgb,var(--vp-accent) 34%,var(--vp-panel));border-color:var(--vp-accent);color:#fff}
body:not(.vscode-light) button.tinted .ico{color:#BAE6FD}
body:not(.vscode-light) button.tinted:hover{background:color-mix(in srgb,var(--vp-accent) 46%,var(--vp-panel))}
button.tinted:hover{background:color-mix(in srgb,var(--vp-accent) 32%,var(--vp-panel))}

/* ---- summary strip */
/* Each figure draws its own dividers into the 1px gaps, so the empty end of a
   wrapped last row shows the panel, not a block of border color (a bright
   block in high-contrast themes, whose border color is vivid). */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--vp-panel);border-bottom:1px solid var(--vp-border)}
.stat{background:var(--vp-panel);padding:10px 18px 11px;display:flex;flex-direction:column;gap:2px;min-width:0;box-shadow:1px 0 0 var(--vp-border),0 1px 0 var(--vp-border)}
.stat-label{display:flex;align-items:center;gap:7px;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--vp-muted)}
.stat-value{font-size:16px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stat-sub{font-size:11.5px;color:var(--vp-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.count{font-size:11px;padding:0 6px;border-radius:999px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.count.good{background:color-mix(in srgb,var(--vp-good) 18%,transparent);color:var(--vp-good)}
.count.bad{background:var(--vscode-inputValidation-errorBackground,#5a1d1d);color:var(--vscode-errorForeground)}

.ico circle.fill,.ico rect.fill{fill:currentColor;stroke:none}
.brand path.pins{fill:none}
.status.live{color:var(--vp-good);border:1px solid color-mix(in srgb,var(--vp-good) 45%,transparent);background:color-mix(in srgb,var(--vp-good) 10%,transparent)}
.status.idle{color:var(--vp-muted);border:1px solid var(--vp-border)}
.status .dot{width:7px;height:7px;border-radius:50%;background:currentColor}
.status.live .dot{animation:vp-pulse 1.4s ease-in-out infinite}
@keyframes vp-pulse{0%,100%{opacity:1}50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.status.live .dot{animation:none}}
button[aria-pressed=true].toggle{background:var(--vp-accent);color:var(--vp-on-accent);border-color:transparent;font-weight:600}
.card{background:var(--vp-panel);border:1px solid var(--vp-border);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.card-h{display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--vp-muted);font-weight:600}
.card-h .grow{flex:1}
.field{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--vp-muted)}
.field input,.field select{width:100%}
.row2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.chips{display:flex;flex-wrap:wrap;gap:5px}
.chip{font-family:var(--vp-mono);font-size:11.5px;border:1px solid var(--vp-border);border-radius:5px;padding:2px 2px 2px 7px;display:inline-flex;align-items:center;gap:5px;background:var(--vp-bg)}
.chip .kind{color:var(--vp-muted);font-family:var(--vscode-font-family);font-size:10.5px}
.chip button{height:18px;padding:0 5px;border:0;color:var(--vp-muted)}.chip button:hover{color:var(--vscode-errorForeground)}
.chip.off{opacity:.6}
.pill{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;font-family:var(--vscode-font-family)}
.banner{display:flex;align-items:center;gap:12px;padding:9px 14px;border-radius:7px;border:1px solid;font-size:12.5px}
.banner span{flex:1}.banner[hidden]{display:none}
.banner.stop{border-color:var(--vscode-errorForeground);background:color-mix(in srgb,var(--vscode-errorForeground) 10%,transparent)}
.banner.warn{border-color:var(--vscode-editorWarning-foreground);background:color-mix(in srgb,var(--vscode-editorWarning-foreground) 10%,transparent)}
.err-text{color:var(--vscode-errorForeground);font-size:12px}.err-text:empty{display:none}
`;

module.exports = { css, ICON, BRAND, esc };
