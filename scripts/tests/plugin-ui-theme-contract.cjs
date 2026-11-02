'use strict';
// RFC §14 T3.3 UI API + T3.4 Theme Contract · 门禁（§7.7 UI 原语 / §7.8 主题规范）。
//
//   U1 UI 原语公开面：Modal/Menu/SuggestModal/FuzzySuggestModal(shim);
//      Setting builders(view shim: setName/setDesc/addText/addToggle/addDropdown/addSlider…);
//      声明式设置通道(settings.register → 宿主 ArkUI 表单)锚点。
//   U2 Modal 生命周期：open/close/onOpen/onClose;Menu addItem/addSeparator。
//   T1 主题 token：--lexi-* 统一 token(浅/深,§7.8) + Obsidian 变量映射兼容层;
//      theme-light/theme-dark 双态;主题启停可恢复(catalog 锚点)。
//
// 用法：node scripts/tests/plugin-ui-theme-contract.cjs

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SHIM = path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_plugin_shim.js');
const VIEW_SHIM = path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_plugin_view_shim.js');
const THEME_CSS = path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_theme.css');
const WORKSPACE_HTML = path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_workspace.html');
const CATALOG = path.join(ROOT, 'entry/src/main/ets/workspace/WorkspaceThemeCatalog.ets');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

const shimSrc = fs.readFileSync(SHIM, 'utf8');
const viewShimSrc = fs.readFileSync(VIEW_SHIM, 'utf8');
const themeCss = fs.readFileSync(THEME_CSS, 'utf8');
const workspaceHtml = fs.readFileSync(WORKSPACE_HTML, 'utf8');
const catalogSrc = fs.readFileSync(CATALOG, 'utf8');

section('U1 UI 原语公开面');
for (const primitive of ['function Modal(', 'function Menu(', 'function SuggestModalShim(', 'function FuzzySuggestModal(']) {
  ok('U1.1 shim ' + primitive.replace(/[^A-Za-z]/g, ''), shimSrc.indexOf(primitive) >= 0, primitive + ' 必须在 shim 公开命名空间');
}
{
  const builders = ['setName', 'setDesc', 'setHeading', 'addText', 'addTextArea', 'addToggle',
    'addDropdown', 'addSlider', 'addButton', 'addExtraButton'];
  for (const builder of builders) {
    ok('U1.2 Setting builder ' + builder, viewShimSrc.indexOf(builder) >= 0,
      'Setting.' + builder + ' 必须可用(view 沙箱)');
  }
}
ok('U1.3 声明式设置通道(settings.register → 宿主表单)',
  /registerHandler\('settings\.register'/.test(fs.readFileSync(path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginRuntime.ets'), 'utf8')) &&
  /parseSettingDefinitions/.test(fs.readFileSync(path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginSettingModel.ets'), 'utf8')));
ok('U1.4 Obsidian 面导出 Modal/Menu/Setting', /Modal:|Menu:|Setting:/.test(shimSrc) || /Modal/.test(viewShimSrc));

section('U2 Modal/Menu 生命周期');
ok('U2.1 Modal open/close/onOpen/onClose', /Modal\.prototype\.open/.test(shimSrc) &&
  /Modal\.prototype\.close/.test(shimSrc) && /onOpen/.test(shimSrc) && /onClose/.test(shimSrc));
ok('U2.2 Menu addItem', /Menu\.prototype\.addItem/.test(shimSrc));
ok('U2.3 SuggestModal 选择回调', /onChooseSuggestion/.test(shimSrc) && /getSuggestions/.test(shimSrc));

section('T1 主题契约(§7.8)');
{
  for (const token of ['--lexi-background-primary', '--lexi-text-primary']) {
    const light = new RegExp('theme-light[^{]*\\{[^}]*' + token.replace(/-/g, '\\-')).test(workspaceHtml) ||
      new RegExp(token.replace(/-/g, '\\-')).test(themeCss) ||
      new RegExp(token.replace(/-/g, '\\-')).test(workspaceHtml);
    ok('T1.1 token ' + token + ' 已定义', light, token + ' 必须进入统一 token 层(§7.8)');
  }
  ok('T1.2 浅/深双态', /theme-light/.test(workspaceHtml) && (/theme-dark/.test(workspaceHtml) ||
    /theme-dark/.test(themeCss) || /theme-dark/.test(shimSrc)), 'theme-light/theme-dark 双态必须存在');
  ok('T1.3 Obsidian 变量映射兼容层', /--background-primary/.test(themeCss),
    'Obsidian 主题变量经映射兼容(§7.8 不假设两边 DOM 同构)');
  ok('T1.4 主题启停可恢复(catalog)', /setActive|uninstall|remove/.test(catalogSrc) &&
    /load\(/.test(catalogSrc));
  // 主题动态注入/撤销在 lexinote_theme.js:<style id="lexinote-theme"> 后追加,移除走 removeChild+restore。
  const themeJs = fs.readFileSync(path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_theme.js'), 'utf8');
  ok('T1.5 主题注入可撤销(后追加 style 可移除)', /lexinote-theme/.test(themeJs) &&
    /removeChild/.test(themeJs) && /restore/.test(themeJs),
    '主题动态 style 必须有移除/恢复路径(启停可恢复)');
}

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-ui-theme-contract: PASS'
  : 'plugin-ui-theme-contract: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
