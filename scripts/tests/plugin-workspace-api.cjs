'use strict';
// RFC §14 T2.4 Workspace API · 门禁（对应 §7.3 Workspace / §3.3 视图上下文 / T1.1 遗留项）。
//
// 验收目标：View 创建、关闭、重开、状态恢复正常；视图打开/关闭绑定生命周期执行上下文。
//   W1 真实视图会话表（转译求值）：open/close/reopen/状态保持/幂等/插件回收。
//   W2 接线锚点：openView 建 view 执行上下文并登记会话;closeView 关上下文并留状态;
//      视图注册绑定 activation(所有权);shim 侧布局恢复锚点保留。
//
// 用法：node scripts/tests/plugin-workspace-api.cjs
// 依赖：LEXI_TYPESCRIPT

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SESSION_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiViewSessionState.ets');
const RUNTIME_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginRuntime.ets');
const SHIM = path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_plugin_shim.js');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

function loadSessions() {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { throw new Error('需要 LEXI_TYPESCRIPT 指向 typescript 模块'); }
  const ts = require(tsPath);
  const js = ts.transpileModule(fs.readFileSync(SESSION_ETS, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: 'LexiViewSessionState.ets' })(
    () => { throw new Error('ViewSessionState 必须零依赖'); }, mod, mod.exports);
  return mod.exports;
}

let sessionMod = null;
try {
  sessionMod = loadSessions();
  ok('W0 视图会话表可转译求值', !!sessionMod.LexiViewSessionTable);
} catch (error) {
  ok('W0 视图会话表可转译求值', false, 'threw: ' + error.message);
}

if (sessionMod) {
  const Table = sessionMod.LexiViewSessionTable;
  const fresh = () => new Table();

  section('W1 视图会话生命周期');
  {
    const t = fresh();
    ok('W1.1 创建视图(未开过)', t.open('calendar-view', 'plug-a', 'ctx-1') === true);
    const s = t.sessionOf('calendar-view');
    ok('W1.2 会话记录 open=true + 上下文绑定', s !== null && s.open === true && s.contextId === 'ctx-1');
    ok('W1.3 重复 open 同视图拒绝(防重复挂载)', t.open('calendar-view', 'plug-a', 'ctx-2') === false);
  }
  {
    const t = fresh();
    t.open('v1', 'plug-a', 'ctx-1');
    const state = { 'month': '2026-11' };
    ok('W1.4 关闭视图(带状态)', t.close('v1', state) === true);
    const s = t.sessionOf('v1');
    ok('W1.5 关闭后 open=false 且状态保留', s.open === false && s.lastState === state);
    ok('W1.6 关闭未开的视图拒绝', t.close('ghost', null) === false);
    ok('W1.7 重开视图', t.open('v1', 'plug-a', 'ctx-9') === true);
    const s2 = t.sessionOf('v1');
    ok('W1.8 重开后状态恢复正常(RFC T2.4 验收)', s2.open === true && s2.lastState === state &&
      s2.contextId === 'ctx-9');
    ok('W1.9 open/close 计数正确', s2.openCount === 2 && s2.closeCount === 1);
  }
  {
    const t = fresh();
    t.open('v1', 'plug-a', 'ctx-1');
    t.open('v2', 'plug-b', 'ctx-2');
    t.dropPlugin('plug-a');
    ok('W1.10 插件停用回收其会话,不误伤他人', t.sessionOf('v1') === null && t.sessionOf('v2') !== null);
  }
}

section('W2 宿主接线');
const runtimeSrc = fs.existsSync(RUNTIME_ETS) ? fs.readFileSync(RUNTIME_ETS, 'utf8') : '';
const shimSrc = fs.existsSync(SHIM) ? fs.readFileSync(SHIM, 'utf8') : '';
ok('W2.1 宿主持有视图会话表', /new LexiViewSessionTable\(/.test(runtimeSrc));
ok('W2.2 openView 建 view 执行上下文 + 登记会话',
  /registerHandler\('workspace\.openView'[\s\S]{0,900}?createContext\([\s\S]{0,200}'view'\)/.test(runtimeSrc) &&
  /registerHandler\('workspace\.openView'[\s\S]{0,1200}?viewSessions\.open\(/.test(runtimeSrc),
  'openView 必须 createContext(kind=view) 并 viewSessions.open(视图↔上下文绑定)');
ok('W2.3 closeView 关上下文 + 留状态',
  /registerHandler\('workspace\.closeView'[\s\S]{0,900}?viewSessions\.close\(/.test(runtimeSrc) &&
  /registerHandler\('workspace\.closeView'[\s\S]{0,1200}?closeContext\(/.test(runtimeSrc),
  'closeView 必须 viewSessions.close + closeContext(先释放后停语义)');
ok('W2.4 停用插件回收视图会话', /viewSessions\.dropPlugin\(/.test(runtimeSrc));
ok('W2.5 shim 布局恢复锚点保留(RFC 重开状态恢复的页面侧)', /restoreLayout/.test(shimSrc));
ok('W2.6 视图注册绑定 activation(T1.2 所有权)', /extensionRegistry\.register\([\s\S]{0,120}'view'/.test(runtimeSrc));

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-workspace-api: PASS'
  : 'plugin-workspace-api: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
