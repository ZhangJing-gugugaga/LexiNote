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

  // -------------------------------------------------- L7/L8 P2-009 状态机补全(R32)
  section('L7 P2-009 迁移表逐格对账(verified/permission-pending/degraded/quarantined/revoked 可达)');
  {
    // 宿主迁移表唯一真源逐格对账(防表漂移无测试覆盖;与 LexiPluginLifecycleManager.buildTransitions 同步)。
    const expected = {
      'discovered': ['verified', 'installed', 'removed'],
      'installed': ['verified', 'disabled', 'permission-pending', 'starting', 'quarantined', 'revoked', 'uninstalling', 'removed'],
      'verified': ['permission-pending', 'starting', 'failed', 'quarantined', 'revoked', 'uninstalling', 'removed'],
      'permission-pending': ['starting', 'disabled', 'quarantined', 'revoked', 'uninstalling', 'removed'],
      'disabled': ['starting', 'quarantined', 'revoked', 'uninstalling', 'removed'],
      'starting': ['running', 'failed', 'disabled', 'permission-pending'],
      'running': ['stopping', 'quarantined', 'degraded'],
      'degraded': ['stopping', 'starting', 'disabled', 'quarantined', 'uninstalling', 'removed'],
      'stopping': ['disabled', 'quarantined'],
      'failed': ['starting', 'disabled', 'uninstalling'],
      'quarantined': ['stopping', 'disabled', 'uninstalling'],
      'revoked': ['permission-pending', 'uninstalling', 'removed'],
      'uninstalling': ['removed', 'disabled'],
      'removed': []
    };
    const states = Object.keys(expected);
    let tableOk = true;
    let tableBad = '';
    for (const from of states) {
      for (const to of states) {
        const want = expected[from].indexOf(to) >= 0;
        const got = LifecycleManager.canTransitStatic(from, to);
        if (want !== got) { tableOk = false; tableBad = from + '→' + to + ' 期望 ' + want + ' 实得 ' + got; }
      }
    }
    ok('L7.0 迁移表逐格与真源一致(13 状态 × 13 状态)', tableOk, tableBad);
  }
  {
    // verified 可达且有转出:discovered/installed → verified → starting/quarantined。
    const m = new LifecycleManager();
    ok('L7.1 markVerified: discovered → verified(安装面验证通过)', m.markVerified('plug-v', 'scan-manifest-ok').ok === true &&
      m.stateOf('plug-v') === 'verified');
    ok('L7.3 markVerified 幂等(已 verified 保持)', m.markVerified('plug-v', 'again').ok === true);
    ok('L7.2 verified → starting 放行(verified = enabled-ok 前置面)', m.beginStartIfNotRunning('plug-v', '1.0.0').ok === true);
    ok('L7.4 verified 迁移原因落账(from/to/reason/at)', (() => {
      const history = m.historyOf('plug-v');
      return history.length >= 2 && history[0].from === 'discovered' && history[0].to === 'verified' &&
        history[0].reason.indexOf('scan-manifest-ok') >= 0 && history[0].at > 0;
    })());
  }
  {
    // permission-pending 可达且有转出:安装未授权(R26)→ 同意(starting)/撤销/卸载。
    const m = new LifecycleManager();
    m.markInstalled('plug-p', '1.0.0');
    ok('L7.5 installed → permission-pending(P5-004 首装待授权面)',
      m.markPermissionPending('plug-p', 'P5-004: 已安装未授权').ok === true &&
      m.stateOf('plug-p') === 'permission-pending');
    ok('L7.6 permission-pending → starting(用户同意 = consentEnablePlugin)',
      m.beginStartIfNotRunning('plug-p', '1.0.0').ok === true);
    ok('L7.7 starting → permission-pending(启用撞授权前置,不卡死 starting)',
      m.markPendingFromStart(m.currentActivationIdOf('plug-p'), 'not-granted').ok === true &&
      m.stateOf('plug-p') === 'permission-pending');
    ok('L7.8 permission-pending → revoked(撤销链)且 revoked 拒绝 starting',
      m.markRevoked('plug-p', 'user-revoke').ok === true && m.stateOf('plug-p') === 'revoked' &&
      m.beginStartIfNotRunning('plug-p', '1.0.0').ok === false);
    ok('L7.9 revoked → permission-pending(重新落账 lift)后可再启用',
      m.liftRevocation('plug-p', 're-consent').ok === true &&
      m.stateOf('plug-p') === 'permission-pending' &&
      m.beginStartIfNotRunning('plug-p', '1.0.0').ok === true);
  }
  {
    // degraded 可达且有转出:running 中能力收缩升级(T4.4 只减不增放行)→ 降级运行面。
    const m = new LifecycleManager();
    m.markInstalled('plug-d', '1.0.0');
    const act = m.beginStartIfNotRunning('plug-d', '1.0.0');
    m.markRunning(act.activation.activationId);
    ok('L7.10 running → degraded(capability-shrink)',
      m.markDegraded('plug-d', 'capability-shrink: 升级移除 network').ok === true &&
      m.stateOf('plug-d') === 'degraded');
    ok('L7.11 degraded → starting(重试启用)→ running → stopping → disabled(转出齐全)',
      m.beginStartIfNotRunning('plug-d', '1.0.1').ok === true &&
      m.stateOf('plug-d') === 'starting');
  }
  {
    // quarantined 可达:安全事件(升级包 integrity_mismatch)在安装/验证面即触发;
    // 不得启用;宿主侧唯一用户出口 = 卸载(markRemoved)。
    const m = new LifecycleManager();
    m.markInstalled('plug-q', '1.0.0');
    m.markVerified('plug-q', 'scan-manifest-ok');
    ok('L7.12 verified → quarantined(安全事件: integrity_mismatch)',
      m.markQuarantined('plug-q', 'integrity_mismatch: 升级包完整性校验失败').ok === true &&
      m.stateOf('plug-q') === 'quarantined');
    ok('L7.13 quarantined 不得启用', m.beginStartIfNotRunning('plug-q', '1.0.0').ok === false);
    ok('L7.14 markQuarantined 幂等(重复安全事件不迁移两次)', m.markQuarantined('plug-q', 'again').ok === true);
    ok('L7.15 quarantined → removed(卸载 = 文档化唯一用户出口)',
      m.markRemoved('plug-q').ok === true && m.stateOf('plug-q') === 'removed');
  }
  {
    // markRemoved 允许面扩展(P2-009 新状态可卸载);运行面仍拒绝。
    const m = new LifecycleManager();
    m.markInstalled('plug-x1', '1.0.0');
    m.markVerified('plug-x1', 'scan');
    ok('L7.16 verified 面可直接卸载落账', m.markRemoved('plug-x1').ok === true);
    m.markInstalled('plug-x2', '1.0.0');
    m.markPermissionPending('plug-x2', 'awaiting');
    m.markRevoked('plug-x2', 'user-revoke');
    ok('L7.17 revoked 面可卸载(撤销后卸载通路)', m.markRemoved('plug-x2').ok === true);
    m.markInstalled('plug-x3', '1.0.0');
    const act = m.beginStartIfNotRunning('plug-x3', '1.0.0');
    m.markRunning(act.activation.activationId);
    ok('L7.18 running 面仍拒绝直接卸载(先停用)', m.markRemoved('plug-x3').ok === false);
  }
  {
    // 原因账目:每一次迁移都留痕(P2-009 验收行"可达且有转出原因")。
    const m = new LifecycleManager();
    m.markInstalled('plug-h', '1.0.0');
    m.markVerified('plug-h', 'scan');
    m.markPermissionPending('plug-h', 'awaiting-consent');
    const act = m.beginStartIfNotRunning('plug-h', '1.0.0');
    m.markRunning(act.activation.activationId);
    m.markDegraded('plug-h', 'capability-shrink');
    m.quarantine(act.activation.activationId, 'security-event');
    const history = m.historyOf('plug-h');
    const trail = history.map((event) => event.from + '→' + event.to).join(',');
    ok('L7.19 全程迁移账目可回放(verified→pending→starting→running→degraded→quarantined)',
      trail.indexOf('discovered→installed') === 0 &&
      trail.indexOf('verified→permission-pending') > 0 &&
      trail.indexOf('permission-pending→starting') > 0 &&
      trail.indexOf('starting→running') > 0 &&
      trail.indexOf('running→degraded') > 0 &&
      trail.indexOf('degraded→quarantined') > 0, trail);
    ok('L7.20 账目每行带原因与非空时间戳',
      history.every((event) => event.reason.length > 0 && event.at > 0));
    ok('L7.21 其他插件的历史不串账', m.historyOf('ghost').length === 0);
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
// P5-004:授权前置进入状态机语义——未授权 = 不进入 starting(停在 installed 面)。
ok('L6.8 P5-004 enablePlugin 授权前置:未授权声明型清单拒绝启用', /插件权限尚未授权/.test(runtimeSrc) &&
  /decision !== PERMISSION_GRANTED[\s\S]{0,600}插件权限尚未授权/.test(runtimeSrc),
  'P5-004 后 enablePlugin 必须拒绝未授权的声明型清单(安装链不再自动 enable)');
ok('L6.9 P5-004 同意通道存在:consentEnablePlugin = grant→enable', /async consentEnablePlugin\(/.test(runtimeSrc) &&
  /permissionStateOf\(pluginId: string\)/.test(runtimeSrc),
  '授权面板同意入口与授权状态查询必须接在 manager 上');

// ---------------------------------------------------------------- L9 P1-008 销毁闭环接线
// 验收行:卸载后旧通道 RPC 一律拒绝(SEC-009/013 自动化;行为级负例在 context-registry D 组)。
// 本节钉宿主销毁顺序与容器销毁面,防五步闭环被后续改动拆散。
section('L9 P1-008 销毁闭环接线(停用→吊销端口身份→销毁 iframe→吊销凭据→清 pending)');
{
  const containerPath = path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_sandbox_container.js');
  const containerSrc = fs.existsSync(containerPath) ? fs.readFileSync(containerPath, 'utf8') : '';
  const disableBody = runtimeSrc.indexOf('async disablePlugin(') > 0
    ? runtimeSrc.slice(runtimeSrc.indexOf('async disablePlugin('), runtimeSrc.indexOf('private async persistEnabled('))
    : '';
  const atRevoke = disableBody.indexOf('contextRegistry.revokePlugin(pluginId)');
  const atTeardown = disableBody.indexOf('lexiContainerTeardown');
  const atTokens = disableBody.indexOf('revokePluginTokens(pluginId)');
  const atPending = disableBody.indexOf('failPendingLifecycleWaits(pluginId');
  ok('L9.1 disablePlugin 五步尾序存在且有序:吊销端口身份 → 容器 iframe 销毁 → 吊销凭据 → 清 pending',
    atRevoke > 0 && atTeardown > atRevoke && atTokens > atTeardown && atPending > atTokens,
    'revoke@' + atRevoke + ' teardown@' + atTeardown + ' tokens@' + atTokens + ' pending@' + atPending);
  ok('L9.2 容器页 lexiContainerTeardown 在案:iframe 移除 + pendingContexts 清账 + 幂等 no-op',
    /window\.lexiContainerTeardown = function \(pluginId\) \{/.test(containerSrc) &&
    /pendingContexts\.delete\(cid\)/.test(containerSrc) &&
    /removeChild\(context\.iframe\)/.test(containerSrc) &&
    /teardown 无匹配上下文\(幂等 no-op\)/.test(containerSrc),
    'P1-008:容器侧 per-plugin iframe 销毁面缺失 = 沙箱求值面残留(SEC-013 卸载残留)');
  ok('L9.3 宿主调用带存在性守卫(旧容器页 fail-safe)且经 sandboxController',
    /window\.lexiContainerTeardown && window\.lexiContainerTeardown\(/.test(disableBody) &&
    /this\.sandboxController !== null/.test(disableBody),
    '宿主必须守卫容器页函数存在性(容器页未更新/丢失时 catch 记录,不抛)');
  ok('L9.4 清 pending 双通道在案(pendingOnloadFail/pendingUnloadFail + failPendingLifecycleWaits)',
    /pendingOnloadFail: Map<string, \(reason: string\) => void>/.test(runtimeSrc) &&
    /pendingUnloadFail: Map<string, \(reason: string\) => void>/.test(runtimeSrc) &&
    /private failPendingLifecycleWaits\(pluginId: string, reason: string\): void/.test(runtimeSrc),
    'P1-008:销毁后必须拒绝在途装载/卸载等待(快速失败,不等 LOAD_TIMEOUT)');
  ok('L9.5 生命周期回执 handler 双表同清(onload.done/onload.error/unload.done)',
    (runtimeSrc.match(/manager\.pendingOnloadFail\.delete\(id\)/g) || []).length === 2 &&
    /manager\.pendingUnloadFail\.delete\(id\)/.test(runtimeSrc),
    '正常回执路径只清 resolve 不清 fail 表 = 泄漏 + 误拒绝');
  ok('L9.6 quarantinePlugin 在案:先落隔离标记 → disablePlugin 销毁闭环 → 状态机落账',
    /async quarantinePlugin\(pluginId: string, reason: string\): Promise<boolean> \{[\s\S]{0,400}record\.quarantineReason = reason;[\s\S]{0,200}await this\.disablePlugin\(pluginId\);[\s\S]{0,200}this\.lifecycle\.markQuarantined\(pluginId, reason\);/.test(runtimeSrc),
    'P2-009:安全事件隔离入口必须按 标记→销毁→落账 顺序(销毁途中并发 enable 一并被隔离门拒绝)');
  ok('L9.7 installZip 完整性失败接线:targetPluginId + integrity_mismatch → quarantinePlugin',
    /targetPluginId = typeof claimed === 'string' \? claimed as string : '';/.test(runtimeSrc) &&
    /message\.indexOf\(ERROR_INTEGRITY_MISMATCH \+ ':'\) === 0/.test(runtimeSrc) &&
    /quarantinePlugin\(targetPluginId, 'integrity_mismatch: 升级包完整性校验失败\(§9\.2\/§6\.4\)'\)/.test(runtimeSrc),
    'P5-001 完整性事件必须可达 quarantine(P2-009 验收:quarantine 由安全事件触发)');
  ok('L9.8 enablePlugin 隔离门:quarantined 拒绝启用,解除方式 = 卸载',
    /record\.quarantineReason\.length > 0[\s\S]{0,240}插件处于安全隔离\([\s\S]{0,120}解除方式: 卸载后重装/.test(runtimeSrc),
    '隔离中的插件不得启用(唯一出口 = 卸载)');
  ok('L9.9 撤销链落账:revokePluginPermissions → markRevoked(P2-010 → P2-009 状态机)',
    /await this\.disablePlugin\(pluginId\);[\s\S]{0,200}this\.lifecycle\.markRevoked\(pluginId, 'user-revoke/.test(runtimeSrc),
    '撤销必须落 revoked 记账(出口=卸载/重新落账 lift)');
  ok('L9.10 授权拒绝落 permission-pending(rejectToPending)且启用前置于状态机 starting',
    /private rejectToPending\(pluginId: string, record: LexiInstalledPlugin, message: string, reason: string\): void/.test(runtimeSrc) &&
    (runtimeSrc.match(/this\.rejectToPending\(pluginId, record, /g) || []).length === 2,
    'not-granted/regrant 拒绝必须落 permission-pending(不再卡死 starting)');
  ok('L9.11 首装默认路径落 permission-pending + 能力收缩落 degraded',
    /markPermissionPending\(manifest\.id, 'P5-004: 已安装未授权\(等待用户同意\)'\)/.test(runtimeSrc) &&
    /markDegradedIfShrunk\(manifest\.id, removedCaps\)/.test(runtimeSrc),
    'R26 安装未授权面 = permission-pending;T4.4 收缩升级 = degraded(降级运行记账)');
  ok('L9.12 扫描链 verified 可达(markInstalled 后 markVerified)',
    /this\.lifecycle\.markInstalled\(manifest\.id, manifest\.version\);[\s\S]{0,220}this\.lifecycle\.markVerified\(manifest\.id,/,
    'verified = 安装面验证通过(扫描清单解析成功)');
}

// ---------------------------------------------------------------- 汇总
console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-lifecycle-once: PASS'
  : 'plugin-lifecycle-once: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
