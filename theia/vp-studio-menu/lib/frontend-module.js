'use strict';
// "VP Studio" in the menu bar of the standalone application, between Terminal
// and Help. The groups, commands and `when` clauses come from VP Studio's
// lib/menu.js and the labels from its package.json, as in VS Code's
// "VP Studio ▾" menu, the Actions view and the status bar menu. The commands
// are the VP Studio extension's; Theia hides an item while its `when` is false.

const { ContainerModule } = require('@theia/core/shared/inversify');
const { MenuContribution, MAIN_MENU_BAR } = require('@theia/core/lib/common/menu');
const menu = require('../../../lib/menu');
const pkg = require('../../../package.json');

const VP_MENU = [...MAIN_MENU_BAR, '8_vpstudio'];

function registerMenus(menus) {
  const titles = menu.titlesFrom(pkg);
  menus.registerSubmenu(VP_MENU, 'VP Studio');
  menu.GROUPS.forEach((g, gi) => {
    const groupPath = [...VP_MENU, '1_groups', `${gi + 1}_${g.id}`];
    menus.registerSubmenu(groupPath, g.label);
    g.sections.forEach((section, si) => section.forEach((item, k) => {
      const t = titles[item.command] || {};
      menus.registerMenuAction([...groupPath, `${si + 1}_section`], {
        commandId: item.command,
        label: t.title || item.command,
        order: String(k + 1).padStart(2, '0'),
        when: item.when,
      });
    }));
  });
}

exports.registerMenus = registerMenus;
exports.default = new ContainerModule((bind) => {
  bind(MenuContribution).toConstantValue({ registerMenus });
});
