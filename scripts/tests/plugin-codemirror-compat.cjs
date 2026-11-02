'use strict';
// RFC §14 T3.2 CodeMirror Integration · 门禁（对应 §7.4 CM6 受信扩展 / P1-03 兼容矩阵）。
//
// 验收目标：宿主统一持有 CodeMirror;外置模块经宿主注册表获取(插件不得自带第二份);
// CM6 版本兼容矩阵单一真源;扩展按插件归属注册与释放。
//   C1 模块注册表:bundle 注入 __lexiCmModules 三核心模块;shim requireShim 只从注册表取。
//   C2 版本矩阵:tools/plugin-contract/codemirror-versions.json == package-lock 实锁版本
//     (重新推导,diff 即红)。
//   C3 扩展所有权:editorExtensionsByPlugin 归属、releaseEditorExtensions 释放、identity 断言面。
//
// 用法：node scripts/tests/plugin-codemirror-compat.cjs

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SHIM = path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_plugin_shim.js');
const BUNDLE_SRC = path.join(ROOT, 'tools/workspace-bundle/src/main.ts');
const BUNDLE_PKG = path.join(ROOT, 'tools/workspace-bundle/package.json');
const BUNDLE_LOCK = path.join(ROOT, 'tools/workspace-bundle/package-lock.json');
const MATRIX = path.join(ROOT, 'tools/plugin-contract/codemirror-versions.json');
const WORKSPACE_JS = path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_workspace.js');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

const shimSrc = fs.readFileSync(SHIM, 'utf8');
const bundleSrc = fs.readFileSync(BUNDLE_SRC, 'utf8');
const workspaceJs = fs.readFileSync(WORKSPACE_JS, 'utf8');

section('C1 模块注册表');
ok('C1.1 bundle 注入 __lexiCmModules', /__lexiCmModules/.test(bundleSrc) && /__lexiCmModules/.test(workspaceJs),
  '宿主 bundle 必须把 @codemirror/* 注入 window.__lexiCmModules');
for (const mod of ['@codemirror/state', '@codemirror/view', '@codemirror/language']) {
  ok('C1.2 bundle 注册 ' + mod, bundleSrc.indexOf("'" + mod + "'") >= 0 || bundleSrc.indexOf('"' + mod + '"') >= 0,
    mod + ' 必须随宿主注册表提供');
}
ok('C1.3 shim requireShim 只从注册表取 CM 模块', /requireShim/.test(shimSrc) &&
  /__lexiCmModules/.test(shimSrc) && /插件沙箱不支持模块/.test(shimSrc),
  '插件不得自带第二份 @codemirror/*(§7.4)');
ok('C1.4 CM 扩展必须在真实 EditorView Realm 执行(ADR-003 锚点)',
  /__lexiEditor/.test(workspaceJs) && /editorIdentity|editorExtensionCount/.test(shimSrc),
  '扩展对象不能经 JSON RPC 跨 Realm 传递');

section('C2 版本兼容矩阵(单一真源)');
ok('C2.1 矩阵文件存在', fs.existsSync(MATRIX));
let lock = null;
try { lock = JSON.parse(fs.readFileSync(BUNDLE_LOCK, 'utf8')); } catch (e) { lock = null; }
ok('C2.2 package-lock 可解析', lock !== null);
if (lock !== null) {
  const locked = {};
  const packages = (lock.packages || {});
  for (const key of Object.keys(packages)) {
    const name = key.replace(/^node_modules\//, '');
    if (['@codemirror/state', '@codemirror/view', '@codemirror/language'].indexOf(name) >= 0) {
      locked[name] = packages[key].version || '';
    }
  }
  ok('C2.3 lock 含三核心模块实锁版本', Object.keys(locked).length === 3, JSON.stringify(locked));
  if (fs.existsSync(MATRIX) && Object.keys(locked).length === 3) {
    let matrix = null;
    try { matrix = JSON.parse(fs.readFileSync(MATRIX, 'utf8')); } catch (e) { matrix = null; }
    ok('C2.4 矩阵可解析且含来源锚点', matrix !== null && matrix.source !== undefined);
    let drifted = [];
    if (matrix !== null && matrix.modules) {
      for (const name of Object.keys(locked)) {
        if (matrix.modules[name] !== locked[name]) { drifted.push(name + '(' + matrix.modules[name] + '≠' + locked[name] + ')'); }
      }
    } else {
      drifted.push('matrix.modules 缺失');
    }
    ok('C2.5 矩阵 == 实锁版本(宿主升级 CM 必须重测 Outliner)', drifted.length === 0, drifted.join(', '));
  }
}

section('C3 扩展所有权');
ok('C3.1 扩展按插件归属登记', /editorExtensionsByPlugin/.test(shimSrc) &&
  /registerExtensions/.test(workspaceJs), '扩展注册必须带 pluginId 归属');
ok('C3.2 释放按插件归属', /releaseEditorExtensions/.test(shimSrc) && /releaseExtensions/.test(workspaceJs));
ok('C3.3 恒等断言面保留(live State/View ctor 校验)', /liveStateCtorSame|liveViewCtorSame/.test(workspaceJs),
  '插件 require 的 CM 必须与编辑器同一实例(两份副本静默失效)');

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-codemirror-compat: PASS'
  : 'plugin-codemirror-compat: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
