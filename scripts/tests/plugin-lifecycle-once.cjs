'use strict';
// RFC §14 T1.1 统一 Plugin Lifecycle · 门禁（对应 §4.1 状态机 / §4.5 生命周期约束）。
//
// 验收目标：同一 activation 只触发一次逻辑 onload/onunload；状态机迁移受控；
// 崩溃可隔离(quarantined)；停用即回收执行上下文。
//   L1 真实状态机（转译求值，非镜像）：迁移表合法/非法逐条断言。
//   L2 onload-once：running 中重复 start 不产生新 activation、不重复计 onload。
//   L3 onunload-once：disabled 中重复 stop 非法；stopping 未完成不得再 start。
//   L4 崩溃隔离：running → quarantined；quarantined 只能转 disabled。
//   L5 执行上下文：context 绑定 activation，closeContext 后不可复用；stop 前必须全关。
//   L6 接线锚点：LexiPluginManager.enablePlugin/disablePlugin 与 onload 回调接生命周期管理器。
//
// 用法：node scripts/tests/plugin-lifecycle-once.cjs
// 依赖：LEXI_TYPESCRIPT（转译 LexiPluginLifecycleManager.ets / LexiPluginActivation.ets / LexiPluginExecutionContext.ets）

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const CORE = path.join(ROOT, 'entry/src/main/ets/core/plugin');
const RUNTIME_ETS = path.join(CORE, 'LexiPluginRuntime.ets');
const FILES = {
  manager: path.join(CORE, 'LexiPluginLifecycleManager.ets'),
  activation: path.join(CORE, 'LexiPluginActivation.ets'),
  context: path.join(CORE, 'LexiPluginExecutionContext.ets')
};

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

// ---------------------------------------------------------------- 真模块装载
function stageModules() {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { throw new Error('需要 LEXI_TYPESCRIPT 指向 typescript 模块'); }
  const ts = require(tsPath);
  // 共享模块注册表:transpile 成 CommonJS 后在 vm 里按名解析相对导入(不落盘、不依赖 realpath)。
  const registry = new Map();
  const virtualRequire = (spec) => {
    const key = spec.replace(/^\.\/(LexiPluginActivation|LexiPluginExecutionContext)(\.js)?$/, '$1');
    if (!registry.has(key)) { throw new Error('lifecycle 模块未注册: ' + spec); }
    return registry.get(key);
  };
  const load = (key, file) => {
    const src = fs.readFileSync(file, 'utf8');
    const js = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
    }).outputText;
    const mod = { exports: {} };
    registry.set(key, mod.exports);
    vm.runInThisContext('(function(require,module,exports){' + js + '\n})',
      { filename: 'lexinote-lifecycle/' + key })(virtualRequire, mod, mod.exports);
    return mod.exports;
  };
  const activation = load('LexiPluginActivation', FILES.activation);
  const context = load('LexiPluginExecutionContext', FILES.context);
  const manager = load('manager', FILES.manager);
  return { activation, context, manager };
}

let mods = null;
try {
  mods = stageModules();
  ok('L0 三个生命周期模块可转译求值', !!mods.manager && !!mods.activation && !!mods.context);
} catch (error) {
  ok('L0 三个生命周期模块可转译求值', false, 'threw: ' + error.message);
}

const LifecycleManager = mods ? mods.manager.LexiPluginLifecycleManager : null;

function fresh() {
  const m = new LifecycleManager();
  // RFC §4.1:扫描发现的插件落 installed(免验证细化,后续 T4 接 PackageVerifier)
  m.markInstalled('plug-a', '1.0.0');
  return m;
}

if (LifecycleManager) {
  section('L1 状态机迁移表');
  {
    const m = fresh();
    ok('L1.1 installed 是宿主扫描后的落点', m.stateOf('plug-a') === 'installed');
    ok('L1.2 未知插件状态=discovered', m.stateOf('ghost') === 'discovered');
    const outcome = m.beginStartIfNotRunning('plug-a', '1.0.0');
    ok('L1.3 installed → starting 放行', outcome.ok === true && outcome.alreadyRunning === false &&
      m.stateOf('plug-a') === 'starting');
  }
  {
    // 非法迁移逐条
    const m = new LifecycleManager();
    m.markInstalled('x', '1.0.0');
    const ghost = m.beginStartIfNotRunning('ghost', '1.0.0');
    ok('L1.4 discovered 不得直接 starting(须先 installed)', ghost.ok === false);
    m.markStopped(m.beginStartIfNotRunning('x', '1.0.0').activation.activationId, 'test');
    const again = m.beginStop(m.currentActivationIdOf('x'), 'test');
    ok('L1.5 disabled 不得重复 stop', again.ok === false);
  }
  {
    const m = fresh();
    const act = m.beginStartIfNotRunning('plug-a', '1.0.0');
    m.markRunning(act.activation.activationId);
    const dup = m.beginStartIfNotRunning('plug-a', '1.0.0');
    ok('L1.6 running 中 beginStart 报 alreadyRunning', dup.ok === false && dup.alreadyRunning === true);
    ok('L1.7 重复 start 不产生新 activation', m.activationCountOf('plug-a') === 1);
  }

  section('L2 onload-once / onunload-once');
  {
    const m = fresh();
    const act = m.beginStartIfNotRunning('plug-a', '1.0.0');
    ok('L2.1 starting 时 onload 尚未计数', act.activation.onloadCount === 0);
    m.markRunning(act.activation.activationId);
    ok('L2.2 markRunning 只计一次 onload', m.activationOf(act.activation.activationId).onloadCount === 1);
    m.markRunning(act.activation.activationId);
    ok('L2.3 重复 markRunning 不再累计', m.activationOf(act.activation.activationId).onloadCount === 1);
  }
  {
    const m = fresh();
    const act = m.beginStartIfNotRunning('plug-a', '1.0.0');
    m.markRunning(act.activation.activationId);
    const stop = m.beginStop(act.activation.activationId, 'user-disable');
    ok('L2.4 running → stopping', stop.ok === true && m.stateOf('plug-a') === 'stopping');
    ok('L2.5 stopping 中不得 beginStart', m.beginStartIfNotRunning('plug-a', '1.0.0').ok === false);
    m.markStopped(act.activation.activationId);
    const rec = m.activationOf(act.activation.activationId);
    ok('L2.6 stopping → disabled 且 onunload 恰一次', m.stateOf('plug-a') === 'disabled' && rec.onunloadCount === 1);
    m.markStopped(act.activation.activationId);
    ok('L2.7 重复 markStopped 不再累计', m.activationOf(act.activation.activationId).onunloadCount === 1);
    const next = m.beginStartIfNotRunning('plug-a', '1.0.0');
    ok('L2.8 disabled 可再次 start(新 activation)', next.ok === true && next.activation.activationId !== act.activation.activationId);
  }

  section('L3 失败与崩溃隔离');
  {
    const m = fresh();
    const act = m.beginStartIfNotRunning('plug-a', '1.0.0');
    m.markFailed(act.activation.activationId, 'onload threw');
    ok('L3.1 starting → failed', m.stateOf('plug-a') === 'failed');
    ok('L3.2 failed 可重试 start', m.beginStartIfNotRunning('plug-a', '1.0.0').ok === true);
  }
  {
    const m = fresh();
    const act = m.beginStartIfNotRunning('plug-a', '1.0.0');
    m.markRunning(act.activation.activationId);
    m.quarantine(act.activation.activationId, 'RPC handler crash');
    ok('L3.3 running → quarantined', m.stateOf('plug-a') === 'quarantined');
    ok('L3.4 quarantined 不得直接 start', m.beginStartIfNotRunning('plug-a', '1.0.0').ok === false);
    const stop = m.beginStop(m.currentActivationIdOf('plug-a'), 'quarantine-release');
    ok('L3.5 quarantined → stopping 放行(释放残骸)', stop.ok === true);
    m.markStopped(m.currentActivationIdOf('plug-a'));
    ok('L3.6 quarantined 经 stopping 落 disabled', m.stateOf('plug-a') === 'disabled');
  }

  section('L4 执行上下文(RFC §3.3 端口身份绑定)');
  {
    const ctxMod = mods.context;
    const m = fresh();
    const act = m.beginStartIfNotRunning('plug-a', '1.0.0');
    m.markRunning(act.activation.activationId);
    const svc = m.createContext(act.activation.activationId, 'service');
    const view = m.createContext(act.activation.activationId, 'view');
    ok('L4.1 context 绑定 activation', svc.contextId.length > 0 && view.contextId !== svc.contextId);
    ok('L4.2 activation 持有 context 清单', m.contextsOf(act.activation.activationId).length === 2);
    const rec = ctxMod.LexiPluginExecutionContext;
    ok('L4.3 context 记录身份四元组', rec !== null);
    ok('L4.4 closeContext 关闭并移出 activation', m.closeContext(svc.contextId) === true &&
      m.contextsOf(act.activation.activationId).length === 1);
    const stop = m.beginStop(act.activation.activationId, 'user-disable');
    ok('L4.5 尚有未关 context 时 stop 拒绝(先释放后停)', stop.ok === false);
    m.closeContext(view.contextId);
    ok('L4.6 context 全关后 stop 放行', m.beginStop(act.activation.activationId, 'user-disable').ok === true);
  }
}

// ---------------------------------------------------------------- L6 接线锚点
section('L6 宿主接线');
const runtimeSrc = fs.existsSync(RUNTIME_ETS) ? fs.readFileSync(RUNTIME_ETS, 'utf8') : '';
ok('L6.1 宿主持有 lifecycle 管理器', /new LexiPluginLifecycleManager\(/.test(runtimeSrc));
ok('L6.2 enablePlugin 走 beginStart 且 running 早退', /beginStartIfNotRunning|beginStart\(/.test(runtimeSrc) &&
  /alreadyRunning/.test(runtimeSrc), 'enablePlugin 必须查询 alreadyRunning 早退,防重复 onload');
ok('L6.3 onload 回调 markRunning', /markRunning\(/.test(runtimeSrc),
  'plugin.onload.done 处理器必须把 activation 推到 running');
ok('L6.4 onload 失败/超时 markFailed', /markFailed\(/.test(runtimeSrc),
  '装载失败必须落 failed,不得停在 starting');
ok('L6.5 disablePlugin 走 beginStop/markStopped', /beginStop\(/.test(runtimeSrc) && /markStopped\(/.test(runtimeSrc));
ok('L6.6 停用即吊销凭据(既有语义保留)', /revokePluginTokens\(/.test(runtimeSrc));
ok('L6.7 装载超时落 failed(强制回收语义)', /withTimeout\(done, LOAD_TIMEOUT_MS, 'onload'\)/.test(runtimeSrc));

// ---------------------------------------------------------------- 汇总
console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-lifecycle-once: PASS'
  : 'plugin-lifecycle-once: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
