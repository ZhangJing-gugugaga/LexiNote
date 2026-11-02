'use strict';
// RFC §14 T1.2 Extension Registry · 门禁（对应 §5 统一扩展注册中心 / §4.4 资源所有权）。
//
// 验收目标：多插件同名资源不冲突、跨插件删除被拒、卸载全回收、重复 extensionId 拒绝。
//   E1 真实注册表（转译求值）：命名空间/冲突/所有权/全回收逐条断言。
//   E2 接线锚点：宿主注册点登记进注册表；停用走 unregisterPlugin 全回收；
//      注册记录绑定 activation（资源所有权随激活实例）。
//
// 用法：node scripts/tests/plugin-extension-ownership.cjs
// 依赖：LEXI_TYPESCRIPT

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiExtensionRegistry.ets');
const RUNTIME_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginRuntime.ets');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

function loadRegistry() {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { throw new Error('需要 LEXI_TYPESCRIPT 指向 typescript 模块'); }
  const ts = require(tsPath);
  const js = ts.transpileModule(fs.readFileSync(REGISTRY_ETS, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: 'LexiExtensionRegistry.ets' })(
    () => { throw new Error('注册表必须零依赖'); }, mod, mod.exports);
  return mod.exports;
}

let registryMod = null;
try {
  registryMod = loadRegistry();
  ok('E0 注册表可转译求值(零依赖)', !!registryMod.LexiExtensionRegistry);
} catch (error) {
  ok('E0 注册表可转译求值(零依赖)', false, 'threw: ' + error.message);
}

if (registryMod) {
  const Registry = registryMod.LexiExtensionRegistry;
  const Record = registryMod.LexiExtensionRecord;

  section('E1 命名空间与冲突');
  {
    const r = new Registry();
    const a = r.register('plug-a', 'command', 'open-panel', 'act-1');
    const b = r.register('plug-b', 'command', 'open-panel', 'act-2');
    ok('E1.1 多插件同名局部名都注册成功', a.ok === true && b.ok === true);
    ok('E1.2 extensionId 按插件命名空间隔离', a.extensionId !== b.extensionId &&
      a.extensionId === 'plug-a:command:open-panel' && b.extensionId === 'plug-b:command:open-panel');
    const dup = r.register('plug-a', 'command', 'open-panel', 'act-1');
    ok('E1.3 同插件重复注册拒绝(RFC §5.4)', dup.ok === false && dup.extensionId === '');
    const view = r.register('plug-a', 'view', 'open-panel', 'act-1');
    ok('E1.4 同名不同类型不冲突', view.ok === true && view.extensionId === 'plug-a:view:open-panel');
  }

  section('E2 所有权');
  {
    const r = new Registry();
    const a = r.register('plug-a', 'command', 'cmd-1', 'act-1');
    ok('E2.1 插件A 不能注销插件B 的资源',
      r.unregister('plug-b', a.extensionId) === false && r.get(a.extensionId) !== null);
    ok('E2.2 插件A 注销自己的资源成功', r.unregister('plug-a', a.extensionId) === true &&
      r.get(a.extensionId) === null);
    ok('E2.3 会话代管(空 pluginId)不可注销他人资源',
      r.register('plug-a', 'view', 'v1', 'act-1').ok === true &&
      r.unregister('', 'plug-a:view:v1') === false);
  }

  section('E3 卸载全回收');
  {
    const r = new Registry();
    r.register('plug-a', 'command', 'c1', 'act-1');
    r.register('plug-a', 'view', 'v1', 'act-1');
    r.register('plug-a', 'codeblock-processor', 'chart', 'act-1');
    r.register('plug-b', 'command', 'c1', 'act-2');
    const removed = r.unregisterPlugin('plug-a');
    ok('E3.1 一次性回收该插件全部资源', removed === 3);
    ok('E3.2 不误伤其他插件', r.get('plug-b:command:c1') !== null && r.list().length === 1);
    ok('E3.3 回收后 list 为空(该插件)', r.list('plug-a').length === 0);
  }

  section('E4 记录结构(RFC §4.4 ExtensionRecord 四元组)');
  {
    const r = new Registry();
    const rec = r.get(r.register('plug-a', 'ribbon', 'my-icon', 'act-9').extensionId);
    ok('E4.1 记录含 pluginId/type/localName/activationId', rec !== null &&
      rec.pluginId === 'plug-a' && rec.type === 'ribbon' && rec.localName === 'my-icon' &&
      rec.activationId === 'act-9' && rec.createdAt > 0);
    ok('E4.2 list 支持按插件过滤', r.list('plug-a').length === 1 && r.list('ghost').length === 0);
    ok('E4.3 记录类型可实例化(ArkTS 侧复用)', typeof Record === 'function');
  }
}

section('E5 宿主接线');
const runtimeSrc = fs.existsSync(RUNTIME_ETS) ? fs.readFileSync(RUNTIME_ETS, 'utf8') : '';
ok('E5.1 宿主持有注册表', /new LexiExtensionRegistry\(/.test(runtimeSrc));
ok('E5.2 注册点登记(commands.add)', /registerHandler\('commands\.add'[\s\S]{0,900}?extensionRegistry\.register\(/.test(runtimeSrc),
  'commands.add 必须把命令登记进统一注册表');
ok('E5.3 注册点登记(views.add)', /registerHandler\('views\.add'[\s\S]{0,900}?extensionRegistry\.register\(/.test(runtimeSrc));
ok('E5.4 注册点登记(codeblocks.register)', /registerHandler\('codeblocks\.register'[\s\S]{0,900}?extensionRegistry\.register\(/.test(runtimeSrc));
ok('E5.5 注册点登记(ui.addRibbon)', /registerHandler\('ui\.addRibbon'[\s\S]{0,900}?extensionRegistry\.register\(/.test(runtimeSrc));
ok('E5.6 注册点登记(settings.register)', /registerHandler\('settings\.register'[\s\S]{0,900}?extensionRegistry\.register\(/.test(runtimeSrc));
ok('E5.7 停用即全回收(unregisterPlugin)', /disablePlugin[\s\S]{0,2200}?extensionRegistry\.unregisterPlugin\(/.test(runtimeSrc),
  'disablePlugin 必须调用 extensionRegistry.unregisterPlugin 一次性回收');
ok('E5.8 注册记录绑定 activation', /currentActivationIdOf\(/.test(runtimeSrc),
  '注册点的 activationId 来自生命周期管理器(资源所有权随激活实例)');

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-extension-ownership: PASS'
  : 'plugin-extension-ownership: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
