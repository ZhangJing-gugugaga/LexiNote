'use strict';
// RFC §14 T5.3 + P3-006 Plugin Inspector · 门禁（对应 §10.3 观察面/隐私边界 + §12 七问）。
//
// 验收目标：插件运行观察(生命周期/扩展/授权/RPC 审计)且不泄露敏感数据;Inspector 能回答
// RFC §12 七问(启动失败/请求权限/RPC 拒绝/超时/资源占用/卸载清理/隔离原因)。
//   I1 观察面（真实判定器,转译求值）：报告含生命周期态/激活/扩展数/授权态/错误态/能力标签/RPC 审计。
//   I2 隐私边界(§10.3)：报告不包含 session token、用户笔记内容、其他插件私有数据;
//      输入里的多余字段不得抄进报告(结构性收敛)。
//   Q  七问应答(§12)：真实 manager 状态面(转译 LifecycleManager+PermissionStore,
//      P2-009 permission-pending/quarantined/revoked 全在案)逐问断言报告字段与应答行。
//   R  脱敏红线：凭据形状(短前缀-长十六进制)只许尾迹(tokenTail 纪律)——
//      宿主误把凭据塞进 errorState/journal/隔离原因/超时标签,报告一律只剩尾 6 位。
//   I3 接线：宿主暴露 inspectPlugin;审计计数来源(authz.denied/identity.anonymous);
//      P3-006 数据面锚点(拒绝账目/超时记账/只读盘点/存储占用/兼容线)。
//
// 用法：node scripts/tests/plugin-inspector.cjs
// 依赖：LEXI_TYPESCRIPT

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const CORE = path.join(ROOT, 'entry/src/main/ets/core/plugin');
const INSPECTOR_ETS = path.join(CORE, 'LexiPluginInspector.ets');
const RUNTIME_ETS = path.join(CORE, 'LexiPluginRuntime.ets');
const CONTEXT_REGISTRY_ETS = path.join(CORE, 'LexiContextRegistry.ets');
const VIEW_SESSION_ETS = path.join(CORE, 'LexiViewSessionState.ets');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

// ---------------------------------------------------------------- 真模块装载
function transpile(file) {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { throw new Error('需要 LEXI_TYPESCRIPT 指向 typescript 模块'); }
  const ts = require(tsPath);
  return ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
}

function loadInspector() {
  const js = transpile(INSPECTOR_ETS);
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: 'LexiPluginInspector.ets' })(
    () => { throw new Error('Inspector 必须零依赖'); }, mod, mod.exports);
  return mod.exports;
}

// 七问面用真实 LifecycleManager(与 plugin-lifecycle-once 同一转译通道)+ PermissionStore。
function stageManagerAndStore() {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  const ts = require(tsPath);
  const registry = new Map();
  const virtualRequire = (spec) => {
    const key = spec.replace(/^\.\/(LexiPluginActivation|LexiPluginExecutionContext)(\.js)?$/, '$1');
    if (!registry.has(key)) { throw new Error('lifecycle 模块未注册: ' + spec); }
    return registry.get(key);
  };
  const load = (key, file) => {
    const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
    }).outputText;
    const mod = { exports: {} };
    registry.set(key, mod.exports);
    vm.runInThisContext('(function(require,module,exports){' + js + '\n})',
      { filename: 'lexinote-inspector/' + key })(virtualRequire, mod, mod.exports);
    return mod.exports;
  };
  load('LexiPluginActivation', path.join(CORE, 'LexiPluginActivation.ets'));
  load('LexiPluginExecutionContext', path.join(CORE, 'LexiPluginExecutionContext.ets'));
  const manager = load('LexiPluginLifecycleManager', path.join(CORE, 'LexiPluginLifecycleManager.ets'));
  const store = load('LexiPermissionStore', path.join(CORE, 'LexiPermissionStore.ets'));
  return { manager, store };
}

let insp = null;
try {
  insp = loadInspector();
  ok('I0 Inspector 可转译求值', !!insp.LexiPluginInspector);
} catch (error) {
  ok('I0 Inspector 可转译求值', false, 'threw: ' + error.message);
}

let realMods = null;
try {
  realMods = stageManagerAndStore();
  ok('I0.1 LifecycleManager+PermissionStore 可转译求值(七问真实状态面)',
    !!(realMods && realMods.manager && realMods.store));
} catch (error) {
  ok('I0.1 LifecycleManager+PermissionStore 可转译求值(七问真实状态面)', false, 'threw: ' + error.message);
}

// ---------------------------------------------------------------- 组装器
// 与宿主 LexiPluginManager.inspectPlugin 同一映射(数据源→字段;见 Inspector 头注表)。
// 宿主侧接线由 I3 锚点钉住;这里用真实 manager/store 输出驱动同一映射。
function assembleFrom(ins, lifecycle, pluginId, overrides) {
  const input = new ins.LexiInspectorInput();
  input.pluginId = pluginId;
  input.lifecycleState = lifecycle ? lifecycle.stateOf(pluginId) : 'discovered';
  if (overrides) { Object.assign(input, overrides); }
  return input;
}

function inputOf(ins, overrides) {
  return assembleFrom(ins, null, 'plug-a', Object.assign({
    lifecycleState: 'running',
    activationId: 'act-1-plug-a',
    extensionCount: 3,
    permissionState: 'granted',
    capabilityTags: ['vault.write', 'network:api.example.com'],
    errorState: '',
    rpcDeniedCount: 2,
    rpcAnonymousCount: 1
  }, overrides || {}));
}

if (insp) {
  section('I1 观察面');
  {
    const report = insp.LexiPluginInspector.report(inputOf(insp));
    ok('I1.1 报告字段齐备(§10.3 1-13 的宿主可观测子集)',
      report.pluginId === 'plug-a' && report.lifecycleState === 'running' &&
      report.activationId === 'act-1-plug-a' && report.extensionCount === 3 &&
      report.permissionState === 'granted' && report.rpcDeniedCount === 2 &&
      report.capabilityTags.length === 2);
  }
  {
    const failed = insp.LexiPluginInspector.report(inputOf(insp, {
      lifecycleState: 'failed', errorState: 'onload threw: boom', permissionState: 'revoked' }));
    ok('I1.2 失败/撤销状态可见(错误可观测)', failed.lifecycleState === 'failed' &&
      failed.errorState === 'onload threw: boom' && failed.permissionState === 'revoked');
  }
  {
    const report = insp.LexiPluginInspector.report(inputOf(insp));
    ok('I1.3 报告可序列化(设备侧 UI/日志消费)', JSON.stringify(report).length > 20);
  }
  {
    // §12 目标报告字段面:version/七问字段全部在报告上且可序列化。
    const report = insp.LexiPluginInspector.report(inputOf(insp, { version: '1.2.0', timeoutCount: 1 }));
    ok('I1.4 §12 目标字段面齐备(version/七问/兼容性/资源/清理)',
      report.version === '1.2.0' && 'failReason' in report && 'lastFailureAt' in report &&
      'permissionFingerprint' in report && 'rpcDeniedRecent' in report &&
      'timeoutCount' in report && 'storageUsageBytes' in report &&
      'cleanupComplete' in report && 'quarantineReason' in report &&
      'compatOk' in report && 'minApiVersion' in report && 'apiCompatLine' in report);
  }

  section('I2 隐私边界(§10.3:不展示 token/笔记内容/他插件私有数据)');
  {
    const SECRET_TOKEN = 'st-deadbeefdeadbeefdeadbeefdeadbeef';
    const NOTE_CONTENT = '这是用户的私密笔记正文,绝不能出现在 Inspector 报告里。';
    const input = inputOf(insp, {
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
    ok('I2.4 errorState 截断(信息最小化)', report.errorState.length <= 121,
      'len=' + report.errorState.length);
  }

  section('R 脱敏红线(§12:凭据全值不进报告,尾迹/旗标才可)');
  {
    // 宿主铸造形状:mintCredential(prefix) = prefix + '-' + 64 位十六进制。
    // tokenTail 纪律:报告里只许出现 尾 6 位(可对账、不可复用)。
    const PLUGIN_TOKEN = 'tk-' + '9f'.repeat(32);
    const SESSION_TOKEN = 'st-' + 'a1b2c3d4'.repeat(8);
    const CHANNEL_TOKEN = 'dc-' + '0e'.repeat(32);
    const TAIL = (s) => s.substring(s.length - 6);
    const plant = insp.LexiInspectorInput ? new insp.LexiInspectorInput() : null;
    plant.pluginId = 'plug-a';
    plant.lifecycleState = 'failed';
    plant.errorState = 'onload threw: credential=' + PLUGIN_TOKEN;
    plant.failReason = 'identity 校验失败 session=' + SESSION_TOKEN + ' channel=' + CHANNEL_TOKEN;
    plant.quarantineReason = '安全事件: token=' + PLUGIN_TOKEN + ' 泄漏尝试';
    plant.lastTimeoutLabel = 'onload(等待凭据 ' + SESSION_TOKEN + ' 超时)';
    const row = new insp.LexiInspectorJournalRow();
    row.at = 1; row.from = 'starting'; row.to = 'failed';
    row.reason = 'failed: authz.denied credential=' + PLUGIN_TOKEN + ' code=capability_denied';
    plant.journal.push(row);
    const report = insp.LexiPluginInspector.report(plant);
    const serialized = JSON.stringify(report);
    const answers = insp.LexiPluginInspector.answersOf(report);
    const answersText = answers.join('\n');
    ok('R.1 插件令牌全值不进报告(含 journal reason/errorState/隔离原因)',
      serialized.indexOf(PLUGIN_TOKEN) < 0);
    ok('R.2 会话令牌全值不进报告(含 failReason/超时标签)',
      serialized.indexOf(SESSION_TOKEN) < 0);
    ok('R.3 通道凭据全值不进报告', serialized.indexOf(CHANNEL_TOKEN) < 0);
    ok('R.4 应答行同样不含凭据全值(answersOf 只由已脱敏字段拼装)',
      answersText.indexOf(PLUGIN_TOKEN) < 0 && answersText.indexOf(SESSION_TOKEN) < 0);
    ok('R.5 凭据以尾迹出现(tokenTail 同纪律: 尾 6 位可对账)',
      serialized.indexOf('tk-…' + TAIL(PLUGIN_TOKEN)) >= 0 &&
      serialized.indexOf('st-…' + TAIL(SESSION_TOKEN)) >= 0 &&
      serialized.indexOf('dc-…' + TAIL(CHANNEL_TOKEN)) >= 0);
    ok('R.6 journal reason 脱敏后机器码保留(可对账不丢信息)',
      report.journal.length === 1 && report.journal[0].reason.indexOf('capability_denied') >= 0 &&
      report.journal[0].reason.indexOf(PLUGIN_TOKEN) < 0);
    // 非凭据形状不受影响:普通错误文本/版本号/时间戳原样保留。
    const plain = insp.LexiPluginInspector.report(inputOf(insp, { errorState: 'onload threw: boom v1.0.0-rc.1' }));
    ok('R.7 非凭据文本零误伤(错误信息/版本号原样)',
      plain.errorState.indexOf('onload threw: boom v1.0.0-rc.1') === 0);
    // RPC 拒绝行:多余字段(载荷/凭据)不得抄进报告。
    const denyRow = new insp.LexiInspectorRpcDeny();
    denyRow.at = 7; denyRow.method = 'vault.read'; denyRow.code = 'capability_denied';
    denyRow.payloadJson = '{"path":"秘密笔记.md"}';
    denyRow.credential = PLUGIN_TOKEN;
    plant.rpcDeniedRecent.push(denyRow);
    const report2 = insp.LexiPluginInspector.report(plant);
    const s2 = JSON.stringify(report2);
    ok('R.8 RPC 拒绝行只带 method/code/at(载荷与凭据字段结构性丢弃)',
      report2.rpcDeniedRecent.length === 1 && report2.rpcDeniedRecent[0].method === 'vault.read' &&
      !('payloadJson' in report2.rpcDeniedRecent[0]) && !('credential' in report2.rpcDeniedRecent[0]) &&
      s2.indexOf('秘密笔记') < 0 && s2.indexOf(PLUGIN_TOKEN) < 0);
    // journal 环形截尾(防长会话报告膨胀)。
    const many = inputOf(insp);
    for (let i = 0; i < 40; i++) {
      const r = new insp.LexiInspectorJournalRow();
      r.at = i; r.from = 'installed'; r.to = 'verified'; r.reason = 'row-' + i;
      many.journal.push(r);
    }
    ok('R.9 journal 报告截尾 32 行(环形上限)', insp.LexiPluginInspector.report(many).journal.length === 32);
  }

  section('Q RFC §12 七问应答(真实 manager 状态: P2-009 全状态在案)');
  if (realMods) {
    const LifecycleManager = realMods.manager.LexiPluginLifecycleManager;
    const PermissionStore = realMods.store.LexiPermissionStore;
    const lifecycle = new LifecycleManager();
    const store = new PermissionStore();

    // ---- 真实状态机驱动(P2-009 全状态) ----
    lifecycle.markInstalled('plug-fail', '1.0.0');
    const actFail = lifecycle.beginStartIfNotRunning('plug-fail', '1.0.0');
    lifecycle.markFailed(actFail.activation.activationId, '插件操作超时: onload');
    // 超时标记(问 4 与问 1 同源:宿主 catch 点记账)
    lifecycle.markInstalled('plug-timeout', '1.0.0');
    const actTimeout = lifecycle.beginStartIfNotRunning('plug-timeout', '1.0.0');
    lifecycle.markFailed(actTimeout.activation.activationId, '插件操作超时: onload');

    lifecycle.markInstalled('plug-pending', '1.0.0');
    lifecycle.markPermissionPending('plug-pending', 'P5-004: 已安装未授权(等待用户同意)');

    lifecycle.markInstalled('plug-quarantined', '1.0.0');
    lifecycle.markVerified('plug-quarantined', 'scan-manifest-ok');
    lifecycle.markQuarantined('plug-quarantined', 'integrity_mismatch: 升级包完整性校验失败(§9.2/§6.4)');

    lifecycle.markInstalled('plug-revoked', '1.0.0');
    lifecycle.markPermissionPending('plug-revoked', 'P5-004: 已安装未授权(等待用户同意)');
    lifecycle.markRevoked('plug-revoked', 'user-revoke: 用户撤销授权(P2-010 链)');
    store.grant('plug-revoked', '1.0.0', 'fp:vault.write|');
    store.revoke('plug-revoked');

    lifecycle.markInstalled('plug-clean', '1.0.0');
    const actClean = lifecycle.beginStartIfNotRunning('plug-clean', '1.0.0');
    lifecycle.markRunning(actClean.activation.activationId);
    const svcCtx = lifecycle.createContext(actClean.activation.activationId, 'service');
    const viewCtx = lifecycle.createContext(actClean.activation.activationId, 'view');
    // 先释放后停(§4.3):宿主 disablePlugin 先关全部上下文再 beginStop。
    lifecycle.closeContext(svcCtx.contextId);
    lifecycle.closeContext(viewCtx.contextId);
    lifecycle.beginStop(actClean.activation.activationId, 'user-disable');
    lifecycle.markStopped(actClean.activation.activationId);

    lifecycle.markInstalled('plug-leftover', '1.0.0');
    const actLeft = lifecycle.beginStartIfNotRunning('plug-leftover', '1.0.0');
    lifecycle.markRunning(actLeft.activation.activationId);
    const leftCtx = lifecycle.createContext(actLeft.activation.activationId, 'service');
    lifecycle.closeContext(leftCtx.contextId);
    lifecycle.beginStop(actLeft.activation.activationId, 'user-disable');
    lifecycle.markStopped(actLeft.activation.activationId);

    const granted = store.grant('plug-clean', '1.0.0', store.fingerprintOf(['vault.write']));
    ok('Q0.1 授权面真实落账', granted === true && store.grantOf('plug-clean') !== null);

    // ---- 映射器(与宿主 inspectPlugin 同一变换;宿主接线由 I3 锚点钉住) ----
    const assemble = (pluginId, overrides) => {
      const input = new insp.LexiInspectorInput();
      input.pluginId = pluginId;
      input.lifecycleState = lifecycle.stateOf(pluginId);
      input.extensionCount = overrides && overrides.extensionCount !== undefined ? overrides.extensionCount : 0;
      const g = store.grantOf(pluginId);
      input.permissionState = g !== null ? g.state : 'not-granted';
      if (g !== null) {
        input.permissionFingerprint = g.fingerprint;
        input.permissionGrantedAt = g.grantedAt;
        input.permissionRevokedAt = g.revokedAt;
        input.permissionVersion = g.version;
      }
      lifecycle.historyOf(pluginId).forEach((event) => {
        const row = new insp.LexiInspectorJournalRow();
        row.at = event.at; row.from = event.from; row.to = event.to; row.reason = event.reason;
        input.journal.push(row);
        if (event.to === 'failed') {
          input.failReason = event.reason.indexOf('failed: ') === 0
            ? event.reason.substring('failed: '.length) : event.reason;
          input.lastFailureAt = event.at;
        }
      });
      if (overrides) { Object.assign(input, overrides); }
      return insp.LexiPluginInspector.report(input);
    };

    // 问 1:插件为什么启动失败?
    {
      const report = assemble('plug-fail');
      const answers = insp.LexiPluginInspector.answersOf(report);
      ok('Q1.1 启动失败原因可答(账目 failed 行 → failReason/lastFailureAt)',
        report.failReason === '插件操作超时: onload' && report.lastFailureAt > 0);
      ok('Q1.2 应答行可读且带原因', answers.length === 7 &&
        answers[0].indexOf('启动失败: 插件操作超时: onload') === 0, answers[0]);
      ok('Q1.3 生命周期账目可回放(运行日志面: from/to/reason/at)',
        report.journal.some((r) => r.from === 'starting' && r.to === 'failed' && r.reason.length > 0 && r.at > 0));
    }
    // 问 2:插件请求了什么权限?
    {
      const pending = assemble('plug-pending', { capabilityTags: ['vault.write', 'network:api.example.com'] });
      const okPlugin = assemble('plug-clean', { capabilityTags: ['vault.write'] });
      const revoked = assemble('plug-revoked', { capabilityTags: ['vault.write'] });
      ok('Q2.1 未授权面如实(permission-pending × not-granted)',
        pending.lifecycleState === 'permission-pending' && pending.permissionState === 'not-granted');
      ok('Q2.2 已授权面带指纹/版本/时间(授权记录全貌)',
        okPlugin.permissionState === 'granted' &&
        okPlugin.permissionFingerprint.indexOf('fp:') === 0 &&
        okPlugin.permissionFingerprint.indexOf('vault.write') >= 0 &&
        okPlugin.permissionGrantedAt > 0 && okPlugin.permissionVersion === '1.0.0');
      ok('Q2.3 撤销面如实(revoked × revokedAt)', revoked.permissionState === 'revoked' &&
        revoked.permissionRevokedAt > 0);
      const answersPending = insp.LexiPluginInspector.answersOf(pending);
      ok('Q2.4 应答行列权限清单', answersPending[1].indexOf('not-granted') >= 0 &&
        answersPending[1].indexOf('vault.write') >= 0 && answersPending[1].indexOf('network:api.example.com') >= 0,
        answersPending[1]);
    }
    // 问 3:哪个 RPC 被拒绝?
    {
      const rows = [];
      const mk = (at, method, code) => {
        const r = new insp.LexiInspectorRpcDeny();
        r.at = at; r.method = method; r.code = code;
        rows.push(r);
        return r;
      };
      mk(11, 'vault.read', 'capability_denied');
      mk(12, 'net.requestUrl', 'capability_denied');
      mk(13, 'vault.delete', 'capability_denied');
      const report = assemble('plug-fail', {
        rpcDeniedCount: 3, rpcAnonymousCount: 1, rpcDeniedRecent: rows });
      const answers = insp.LexiPluginInspector.answersOf(report);
      ok('Q3.1 拒绝方法与机器码逐条可答', report.rpcDeniedCount === 3 &&
        report.rpcDeniedRecent.length === 3 &&
        report.rpcDeniedRecent[0].method === 'vault.read' &&
        report.rpcDeniedRecent[2].code === 'capability_denied');
      ok('Q3.2 应答行点名最近被拒 RPC', answers[2].indexOf('RPC 拒绝 3 次') === 0 &&
        answers[2].indexOf('vault.read/capability_denied') >= 0 &&
        answers[2].indexOf('net.requestUrl/capability_denied') >= 0, answers[2]);
      const clean = assemble('plug-clean');
      ok('Q3.3 无拒绝时如实说无', insp.LexiPluginInspector.answersOf(clean)[2] === 'RPC 拒绝: 无拒绝记录');
    }
    // 问 4:插件是否超时?
    {
      const report = assemble('plug-timeout', { timeoutCount: 2, lastTimeoutLabel: 'onload', lastTimeoutAt: 99 });
      const answers = insp.LexiPluginInspector.answersOf(report);
      ok('Q4.1 超时计数/标签/时间可答', report.timeoutCount === 2 &&
        report.lastTimeoutLabel === 'onload' && report.lastTimeoutAt === 99);
      ok('Q4.2 应答行带次数与最近标签', answers[3].indexOf('超时 2 次') === 0 &&
        answers[3].indexOf('onload') >= 0, answers[3]);
      const clean = assemble('plug-clean');
      ok('Q4.3 无超时时如实说无', insp.LexiPluginInspector.answersOf(clean)[3] === '超时: 无超时记录');
      // 账目面交叉证据:journal 的 failed 行带超时原因(宿主 markFailed 落账)。
      ok('Q4.4 账目交叉证据(超时失败在 journal 可对账)',
        report.journal.some((r) => r.to === 'failed' && r.reason.indexOf('超时') >= 0));
    }
    // 问 5:插件占用了多少资源?
    {
      const report = assemble('plug-clean', {
        contextsAlive: 2, extensionCount: 3, activationCount: 1,
        storageUsageBytes: 1024, storageQuotaBytes: 4096 });
      const answers = insp.LexiPluginInspector.answersOf(report);
      ok('Q5.1 资源面四项可答(上下文/扩展/激活/存储)', report.contextsAlive === 2 &&
        report.extensionCount === 3 && report.activationCount === 1 &&
        report.storageUsageBytes === 1024 && report.storageQuotaBytes === 4096);
      ok('Q5.2 应答行带全部数值', answers[4].indexOf('存活上下文 2') >= 0 &&
        answers[4].indexOf('扩展 3') >= 0 && answers[4].indexOf('激活 1 次') >= 0 &&
        answers[4].indexOf('存储 1024B') >= 0 && answers[4].indexOf('配额 4096B') >= 0, answers[4]);
    }
    // 问 6:插件卸载时是否清理完整?
    {
      const clean = assemble('plug-clean', { contextsAlive: 0, extensionCount: 0,
        cleanupComplete: true, cleanupLeftovers: [] });
      const leftover = assemble('plug-leftover', { contextsAlive: 0, extensionCount: 2,
        cleanupComplete: false, cleanupLeftovers: ['扩展注册残留 2 条'] });
      ok('Q6.1 清理完整旗标可答(无残骸=true)', clean.cleanupComplete === true);
      ok('Q6.2 残留清单可答(扩展残留点名)', leftover.cleanupComplete === false &&
        leftover.cleanupLeftovers.length === 1 &&
        leftover.cleanupLeftovers[0].indexOf('扩展注册残留') === 0);
      const answersClean = insp.LexiPluginInspector.answersOf(clean);
      const answersLeft = insp.LexiPluginInspector.answersOf(leftover);
      ok('Q6.3 应答行:完整/残留两态可读', answersClean[5] === '清理: 完整(无残骸)' &&
        answersLeft[5].indexOf('残留') >= 0 && answersLeft[5].indexOf('扩展注册残留 2 条') >= 0,
        answersLeft[5]);
      ok('Q6.4 账目交叉证据(onunload-complete 在 journal 可对账)',
        clean.journal.some((r) => r.to === 'disabled' && r.reason === 'onunload-complete'));
    }
    // 问 7:插件为什么被隔离?
    {
      const report = assemble('plug-quarantined', { quarantined: true,
        quarantineReason: 'integrity_mismatch: 升级包完整性校验失败(§9.2/§6.4)' });
      const answers = insp.LexiPluginInspector.answersOf(report);
      ok('Q7.1 隔离原因可答(record.quarantineReason)', report.quarantined === true &&
        report.quarantineReason.indexOf('integrity_mismatch') === 0);
      ok('Q7.2 应答行带隔离原因', answers[6].indexOf('隔离: integrity_mismatch') === 0, answers[6]);
      ok('Q7.3 账目交叉证据(quarantined 行在 journal 可对账)',
        report.journal.some((r) => r.to === 'quarantined' && r.reason.indexOf('integrity_mismatch') >= 0));
      const clean = assemble('plug-clean');
      ok('Q7.4 未隔离如实', insp.LexiPluginInspector.answersOf(clean)[6] === '隔离: 未被隔离');
      const pending = assemble('plug-pending');
      ok('Q7.5 P2-009 permission-pending 状态在真实状态机面在案',
        pending.lifecycleState === 'permission-pending');
      const revoked = assemble('plug-revoked');
      ok('Q7.6 P2-009 revoked 状态在真实状态机面在案', revoked.lifecycleState === 'revoked');
    }
    // 七问应答完整性:任一状态下都恰好 7 行应答。
    {
      let allSeven = true;
      for (const pid of ['plug-fail', 'plug-pending', 'plug-quarantined', 'plug-revoked', 'plug-clean']) {
        const answers = insp.LexiPluginInspector.answersOf(assemble(pid));
        if (answers.length !== 7 || answers.some((a) => a.length === 0)) { allSeven = false; }
      }
      ok('Q8 七问应答行恒为 7 行且非空(五状态×七问)', allSeven);
    }
  }

  section('R2 只读伴生模块(问 5/6 的盘点真源)');
  {
    try {
      const ctxJs = transpile(CONTEXT_REGISTRY_ETS);
      const ctxMod = { exports: {} };
      const brokerStub = { LexiCallerContext: class {}, LexiAuthzDecision: class {} };
      vm.runInThisContext('(function(require,module,exports){' + ctxJs + '\n})', { filename: 'LexiContextRegistry.ets' })(
        () => brokerStub, ctxMod, ctxMod.exports);
      const registry = new ctxMod.exports.LexiContextRegistry();
      const a = registry.create('plug-a', 'act-1', 'service');
      registry.create('plug-a', 'act-1', 'view');
      registry.create('plug-b', 'act-2', 'service');
      registry.revoke(a.contextId);
      ok('R2.1 contextRegistry.aliveCountOf 单插件只读盘点(吊销不计)',
        registry.aliveCountOf('plug-a') === 1 && registry.aliveCountOf('plug-b') === 1 &&
        registry.aliveCountOf('ghost') === 0);
    } catch (error) {
      ok('R2.1 contextRegistry.aliveCountOf 单插件只读盘点(吊销不计)', false, 'threw: ' + error.message);
    }
    try {
      const vsJs = transpile(VIEW_SESSION_ETS);
      const vsMod = { exports: {} };
      vm.runInThisContext('(function(require,module,exports){' + vsJs + '\n})', { filename: 'LexiViewSessionState.ets' })(
        () => { throw new Error('零依赖'); }, vsMod, vsMod.exports);
      const table = new vsMod.exports.LexiViewSessionTable();
      table.open('calendar', 'plug-a', 'ctx-1');
      table.open('agenda', 'plug-a', 'ctx-2');
      table.open('other', 'plug-b', 'ctx-3');
      ok('R2.2 viewSessions.openCountOf 单插件只读盘点',
        table.openCountOf('plug-a') === 2 && table.openCountOf('plug-b') === 1);
      table.close('calendar', null);
      ok('R2.3 close 后 open 计数如实下降', table.openCountOf('plug-a') === 1);
    } catch (error) {
      ok('R2.2/2.3 viewSessions.openCountOf 单插件只读盘点', false, 'threw: ' + error.message);
    }
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
ok('I3.4 P3-006 拒绝账目接线(问 3: method+code 落 rpcDenyJournal)',
  /rpcDenyJournal/.test(runtimeSrc) && /row\.method = method/.test(runtimeSrc) &&
  /row\.code = authz\.code/.test(runtimeSrc),
  '拒绝账目与 rpcDenies 同点追加,带方法名与机器码');
ok('I3.5 P3-006 超时记账接线(问 4: 既有失败出口 notePluginTimeout)',
  /notePluginTimeout\(pluginId, 'onload'\)/.test(runtimeSrc) &&
  /notePluginTimeout\(pluginId, 'onunload'\)/.test(runtimeSrc) &&
  /notePluginTimeout\(pluginId, label\)/.test(runtimeSrc),
  'onload/onunload/invoke.* 三类超时出口全部入账');
ok('I3.6 P3-006 只读盘点接线(问 5/6: aliveCountOf/openCountOf/storageUsageOf)',
  /aliveCountOf\(pluginId\)/.test(runtimeSrc) && /openCountOf\(pluginId\)/.test(runtimeSrc) &&
  /storageUsageOf\(pluginId\)/.test(runtimeSrc) && /statSync\(path\)\.size/.test(runtimeSrc));
ok('I3.7 P3-006 兼容性报告接线(§12: manifestCompatible+OBSIDIAN_API_COMPAT)',
  /manifestCompatible\(record\.manifest\)/.test(runtimeSrc) &&
  /OBSIDIAN_API_COMPAT/.test(runtimeSrc));
ok('I3.8 P3-006 生命周期账目接线(问 1/6/7: historyOf 进报告)',
  /historyOf\(pluginId\)/.test(runtimeSrc) && /quarantineReason/.test(runtimeSrc));
ok('I3.9 P3-006 权限记录接线(问 2: grantOf 全貌进报告)',
  /permissionFingerprint = grant\.fingerprint/.test(runtimeSrc) &&
  /permissionGrantedAt = grant\.grantedAt/.test(runtimeSrc));
ok('I3.10 P3-006 清理盘点接线(问 6: cleanupLeftovers/cleanupComplete 组装)',
  /cleanupLeftovers = leftovers/.test(runtimeSrc) &&
  /cleanupComplete = input\.activationCount > 0/.test(runtimeSrc));

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-inspector: PASS'
  : 'plugin-inspector: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
