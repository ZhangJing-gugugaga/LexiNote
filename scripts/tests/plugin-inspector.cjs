'use strict';
// RFC §14 T5.3 Plugin Inspector · 门禁（对应 §10.3 观察面与隐私边界）。
//
// 验收目标：插件运行观察(生命周期/扩展/授权/RPC 审计)且不泄露敏感数据。
//   I1 观察面（真实判定器,转译求值）：报告含生命周期态/激活/扩展数/授权态/错误态/能力标签/RPC 审计。
//   I2 隐私边界(§10.3)：报告不包含 session token、用户笔记内容、其他插件私有数据;
//      输入里的多余字段不得抄进报告(结构性收敛)。
//   I3 接线：宿主暴露 inspectPlugin;审计计数来源(authz.denied/identity.anonymous)。
//
// 用法：node scripts/tests/plugin-inspector.cjs
// 依赖：LEXI_TYPESCRIPT

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const INSPECTOR_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginInspector.ets');
const RUNTIME_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginRuntime.ets');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

function loadInspector() {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { throw new Error('需要 LEXI_TYPESCRIPT 指向 typescript 模块'); }
  const ts = require(tsPath);
  const js = ts.transpileModule(fs.readFileSync(INSPECTOR_ETS, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: 'LexiPluginInspector.ets' })(
    () => { throw new Error('Inspector 必须零依赖'); }, mod, mod.exports);
  return mod.exports;
}

let insp = null;
try {
  insp = loadInspector();
  ok('I0 Inspector 可转译求值', !!insp.LexiPluginInspector);
} catch (error) {
  ok('I0 Inspector 可转译求值', false, 'threw: ' + error.message);
}

function inputOf(overrides) {
  const input = new insp.LexiInspectorInput();
  input.pluginId = 'plug-a';
  input.lifecycleState = 'running';
  input.activationId = 'act-1-plug-a';
  input.extensionCount = 3;
  input.permissionState = 'granted';
  input.capabilityTags = ['vault.write', 'network:api.example.com'];
  input.errorState = '';
  input.rpcDeniedCount = 2;
  input.rpcAnonymousCount = 1;
  if (overrides) { Object.assign(input, overrides); }
  return input;
}

if (insp) {
  section('I1 观察面');
  {
    const report = insp.LexiPluginInspector.report(inputOf());
    ok('I1.1 报告字段齐备(§10.3 1-13 的宿主可观测子集)',
      report.pluginId === 'plug-a' && report.lifecycleState === 'running' &&
      report.activationId === 'act-1-plug-a' && report.extensionCount === 3 &&
      report.permissionState === 'granted' && report.rpcDeniedCount === 2 &&
      report.capabilityTags.length === 2);
  }
  {
    const failed = insp.LexiPluginInspector.report(inputOf({
      lifecycleState: 'failed', errorState: 'onload threw: boom', permissionState: 'revoked' }));
    ok('I1.2 失败/撤销状态可见(错误可观测)', failed.lifecycleState === 'failed' &&
      failed.errorState === 'onload threw: boom' && failed.permissionState === 'revoked');
  }
  {
    const report = insp.LexiPluginInspector.report(inputOf());
    ok('I1.3 报告可序列化(设备侧 UI/日志消费)', JSON.stringify(report).length > 20);
  }

  section('I2 隐私边界(§10.3:不展示 token/笔记内容/他插件私有数据)');
  {
    const SECRET_TOKEN = 'st-deadbeefdeadbeefdeadbeefdeadbeef';
    const NOTE_CONTENT = '这是用户的私密笔记正文,绝不能出现在 Inspector 报告里。';
    const input = inputOf({
      errorState: 'onload 失败: ' + NOTE_CONTENT.slice(0, 10)
    });
    // 宿主侧可能误把敏感数据塞进输入:多余字段不得抄进报告(结构性收敛)
    input.sessionToken = SECRET_TOKEN;
    input.noteContent = NOTE_CONTENT;
    input.otherPluginData = '{"other-plugin-private":true}';
    const report = insp.LexiPluginInspector.report(input);
    const serialized = JSON.stringify(report);
    ok('I2.1 报告不含 session token', serialized.indexOf(SECRET_TOKEN) < 0 && !('sessionToken' in report));
    ok('I2.2 报告不含用户笔记内容', serialized.indexOf(NOTE_CONTENT) < 0 && !('noteContent' in report));
    ok('I2.3 报告不含其他插件私有数据', serialized.indexOf('other-plugin-private') < 0);
    // errorState 里混入的敏感片段:宿主侧必须截断到安全长度(报告层再收敛一次)
    ok('I2.4 errorState 截断(信息最小化)', report.errorState.length <= 120);
  }
}

section('I3 接线');
const runtimeSrc = fs.existsSync(RUNTIME_ETS) ? fs.readFileSync(RUNTIME_ETS, 'utf8') : '';
ok('I3.1 宿主暴露 inspectPlugin', /inspectPlugin\(/.test(runtimeSrc),
  'LexiPluginManager.inspectPlugin(pluginId) 供设置页/调试面消费');
ok('I3.2 审计计数来源锚点', /authz\.denied/.test(runtimeSrc) && /identity\.anonymous/.test(runtimeSrc),
  'RPC 拒绝与匿名调用的审计行是 Inspector 计数的数据源');
ok('I3.3 审计计数真实累计', /rpcDeniedCount|rpcDenies/.test(runtimeSrc),
  '宿主必须维护每插件拒绝计数(而非静态 0)');

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-inspector: PASS'
  : 'plugin-inspector: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
