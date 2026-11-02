#!/usr/bin/env node
// Minimal 主题里"命令面板/通知/弹窗"这三类规则的同名类命中审计（静态口径）。
//
// 口径说明（写进报告必须一起给）：
//   1. "规则总数"来自主题 CSS 的静态解析：把 CSS 文本按 <selector>{ 切块，
//      只看选择器文本里出现 .prompt / .notice / .modal / .suggestion / .menu / .tooltip 的块。
//      at-rule（@media 等）内部规则同样被计入，所以分母比"顶层规则"大。
//   2. "能否命中"= 该选择器要求的每个类名是否都出现在宿主 DOM 里。
//      DOM 类名集合 = 页面 HTML 的 class 属性 + bundle 运行时生成的类（RUNTIME_CLASSES，
//      逐个都来自门禁实测的 theme.classes / theme.ui，不猜）。
//      选择器里的 :hover/:not()/元素名/属性选择器不做求值，只看类名这一层——
//      所以这里给的是"结构性可命中/不可命中"的上界与下界，精确命中数看门禁 C13（CSSOM 实测）。
//   3. 本脚本只读文件，不连设备、不改任何东西。
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const CSS = path.join(REPO, '.fixtures-out', 'theme-minimal', 'styles.css');
const HTML = path.join(REPO, 'entry', 'src', 'main', 'resources', 'rawfile', 'lexinote_workspace.html');

// bundle 在运行时生成的类（来自门禁实测，不是猜测）
const RUNTIME_CLASSES = [
  'cm-editor', 'cm-scroller', 'cm-content', 'cm-line', 'cm-gutters', 'cm-activeLine',
  'suggestion-item', 'notice', 'notice-out', 'is-selected', 'mod-active', 'theme-dark', 'theme-light',
  'minimal-default-dark', 'minimal-default-light', 'outliner-plugin-better-lists', 'clickable-icon',
  'workspace-leaf', 'workspace-leaf-content', 'view-content', 'view-body', 'markdown-source-view'
];

const FAMILIES = [
  { name: 'prompt', re: /\.prompt/ },
  { name: 'modal', re: /\.modal/ },
  { name: 'notice', re: /\.notice/ },
  { name: 'suggestion', re: /\.suggestion/ },
  { name: 'menu', re: /\.menu/ },
  { name: 'tooltip', re: /\.tooltip/ }
];

function domClasses() {
  const html = fs.readFileSync(HTML, 'utf8');
  const set = new Set(RUNTIME_CLASSES);
  const re = /class="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    String(m[1]).split(/\s+/).forEach((c) => { if (c) { set.add(c); } });
  }
  return set;
}

function cssRules() {
  const text = fs.readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const re = /([^{}]+)\{/g;
  let m;
  while ((m = re.exec(text))) {
    const sel = String(m[1]).replace(/\s+/g, ' ').trim();
    if (!sel || sel.charAt(0) === '@') { continue; }
    out.push(sel);
  }
  return out;
}

function classTokens(sel) {
  const set = new Set();
  const re = /\.([A-Za-z_][A-Za-z0-9_-]*)/g;
  let m;
  while ((m = re.exec(sel))) { set.add(String(m[1])); }
  return set;
}

const have = domClasses();
const rules = cssRules();
console.log('宿主 DOM 类名集合: ' + have.size + ' 个（HTML class 属性 + bundle 运行时生成）');
console.log('主题规则块: ' + rules.length + ' 个（含 @media 内部）');
console.log('');

let grand = { total: 0, possible: 0, impossible: 0 };
FAMILIES.forEach((fam) => {
  const sel = rules.filter((s) => fam.re.test(s));
  let possible = 0;
  const missing = new Map();
  sel.forEach((s) => {
    const need = [...classTokens(s)];
    const lack = need.filter((c) => !have.has(c));
    if (lack.length === 0) { possible++; } else { lack.forEach((c) => { missing.set(c, (missing.get(c) || 0) + 1); }); }
  });
  const top = [...missing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([c, n]) => '.' + c + ' x' + n).join(', ');
  console.log('[' + fam.name + '] 规则 ' + sel.length + ' 个 | 类名齐备(可命中) ' + possible + ' | 缺类名(结构上不可能命中) ' + (sel.length - possible));
  if (top) { console.log('    缺得最多的类名: ' + top); }
  grand.total += sel.length; grand.possible += possible; grand.impossible += sel.length - possible;
});
console.log('');
console.log('合计: 规则 ' + grand.total + ' | 类名齐备 ' + grand.possible + ' | 缺类名 ' + grand.impossible);
console.log('注: 类名齐备 != 一定命中（还要看层级、元素名、:hover）；精确命中数见门禁 C13 theme.rules 的 CSSOM 实测。');
