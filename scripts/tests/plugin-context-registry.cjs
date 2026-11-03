'use strict';
// RFC §3.3/§3.4 P1-003a · contextRegistry + 端口 RPC 网关门禁。
//
// 真跑三件套：真实 LexiContextRegistry + 真实 LexiPermissionBroker + 真实 handler 表，
// 验证 ADR-R18-01 定案 2/3 的行为：
//   R1 未注册 contextId → fail-closed（context_unregistered）；
//   R2 吊销后（revoke/revokePlugin）一切帧被拒——撤销立即生效的载体级形态（P2-010 联动）；
//   R3 身份来自记录反查：载荷自证 pluginId 被剥离且不影响判定（冒名邻居 → broker 按
//      记录身份拒绝 owner 不符）；
//   R4 响应帧符合 §3.4（ok/data/error{code,message,retryable}）；
//   R5 协议版本/非请求帧/缺 method 拒绝（context_bad_frame）；
//   R6 与既有矩阵协同：fs-write 走 fsAuthorizer、capability gate 拒未声明域。
// 用法：node scripts/tests/plugin-context-registry.cjs   （依赖 LEXI_TYPESCRIPT）

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const CORE = path.join(ROOT, 'entry/src/main/ets/core/plugin');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

function loadEts(file, requireShim) {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { throw new Error('需要 LEXI_TYPESCRIPT'); }
  const ts = require(tsPath);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: file })(requireShim, mod, mod.exports);
  return mod.exports;
}

let brokerMod = null;
let registryMod = null;
try {
  brokerMod = loadEts(path.join(CORE, 'LexiPermissionBroker.ets'), () => { throw new Error('broker 零依赖'); });
  registryMod = loadEts(path.join(CORE, 'LexiContextRegistry.ets'), (spec) => {
    if (String(spec).indexOf('LexiPermissionBroker') >= 0) { return brokerMod; }
    throw new Error('意外依赖: ' + spec);
  });
  ok('R0 模块可转译求值', !!registryMod.LexiContextRegistry && !!brokerMod.LexiPermissionBroker);
} catch (error) {
  ok('R0 模块可转译求值', false, 'threw: ' + error.message);
}

if (registryMod && brokerMod) {
  const registry = new registryMod.LexiContextRegistry();
  // 两个插件:cap-a 声明 fs 与 vault.read/editor 域;cap-b 无任何能力。
  const broker = new brokerMod.LexiPermissionBroker(
    (pluginId) => pluginId === 'cap-a',
    (pluginId, method) => pluginId === 'cap-a' &&
      (method === 'vault.read' || method === 'vault.modify' || method === 'editor.replace'));

  function frame(method, payload, id, version) {
    return JSON.stringify(Object.assign({ v: version || 1, type: 'request', id: id || 'r1', method }, payload === undefined ? {} : { payload }));
  }
  function authorizeViaGateway(record, frameJson) {
    const decision = registry.adjudicate(record.contextId, frameJson);
    if (!decision.ok) { return decision; }
    const ctx = registry.contextOf(record);
    const authz = broker.authorize(ctx, decision.method, null);
    if (!authz.allowed) {
      const deniedDecision = new registryMod.LexiContextGatewayDecision();
      deniedDecision.code = authz.code;
      deniedDecision.error = authz.reason;
      return deniedDecision;
    }
    return decision;
  }

  section('R1/R2 上下文生命周期');
  const recA = registry.create('cap-a', 'act-1', 'service');
  ok('R1.1 contextId 宿主铸造且含插件名', recA.contextId.indexOf('cap-a') > 0 && recA.contextId.indexOf('ctx-') === 0);
  ok('R1.2 未注册 contextId 拒绝', (() => {
    const d = registry.adjudicate('ctx-nonexistent', frame('vault.read'));
    return !d.ok && d.code === registryMod.CONTEXT_ERROR_UNREGISTERED;
  })());
  ok('R2.1 revoke 后该上下文拒绝', (() => {
    const temp = registry.create('cap-a', 'act-2', 'view');
    registry.revoke(temp.contextId);
    const d = registry.adjudicate(temp.contextId, frame('vault.read'));
    return !d.ok && d.code === registryMod.CONTEXT_ERROR_REVOKED;
  })());
  ok('R2.2 revokePlugin 吊销其全部上下文(停用/卸载链语义)', (() => {
    const t1 = registry.create('cap-b', 'act-3', 'service');
    const t2 = registry.create('cap-b', 'act-4', 'view');
    const count = registry.revokePlugin('cap-b');
    const d1 = registry.adjudicate(t1.contextId, frame('data.load'));
    const d2 = registry.adjudicate(t2.contextId, frame('data.load'));
    return count === 2 && !d1.ok && !d2.ok && d1.code === registryMod.CONTEXT_ERROR_REVOKED;
  })());

  section('R3/R4/R5 帧裁决');
  ok('R3.1 身份来自记录反查:自报邻居 pluginId 被剥离且不影响放行', (() => {
    const d = authorizeViaGateway(recA, frame('vault.read', { pluginId: 'cap-b', path: 'notes/a.md' }));
    return d.ok && d.identity === 'cap-a' && JSON.parse(d.payloadJson).pluginId === undefined &&
      d.method === 'vault.read';
  })());
  ok('R3.2 owner 域:记录身份判归属(冒名者删他人资源被拒)', (() => {
    // cap-a 的上下文试图删 cap-b 的命令 → plugin-owned 归属不符 → 拒。
    const d = authorizeViaGateway(recA, frame('commands.remove'));
    return !d.ok && d.code === 'ERR_PERMISSION_DENIED';
  })());
  ok('R3.3 fs-write 走 fsAuthorizer:cap-a 放行', (() => {
    const d = authorizeViaGateway(recA, frame('vault.modify'));
    return d.ok;
  })());
  ok('R3.4 capability gate:未声明域拒绝(ui.notice)', (() => {
    const d = authorizeViaGateway(recA, frame('ui.notice'));
    return !d.ok && d.code === 'ERR_PERMISSION_DENIED' && d.error.indexOf('capability:') === 0;
  })());
  ok('R4.1 响应帧符合 §3.4(成功)', (() => {
    const f = JSON.parse(registry.buildResponseFrame('r9', true, '{"answer":42}', '', ''));
    return f.v === 1 && f.type === 'response' && f.id === 'r9' && f.ok === true && f.data.answer === 42;
  })());
  ok('R4.2 错误帧带 code/message/retryable', (() => {
    const f = JSON.parse(registry.buildResponseFrame('r9', false, '', 'capability_denied', '未声明'));
    return f.ok === false && f.error.code === 'capability_denied' && f.error.retryable === false;
  })());
  ok('R5.1 协议版本不符拒绝', (() => {
    const d = registry.adjudicate(recA.contextId, frame('vault.read', {}, 'r1', 2));
    return !d.ok && d.code === registryMod.CONTEXT_ERROR_BAD_FRAME;
  })());
  ok('R5.2 非请求帧/坏 JSON 拒绝', (() => {
    const d1 = registry.adjudicate(recA.contextId, JSON.stringify({ v: 1, type: 'response', id: 'x' }));
    const d2 = registry.adjudicate(recA.contextId, '{not-json');
    return !d1.ok && !d2.ok && d1.code === registryMod.CONTEXT_ERROR_BAD_FRAME;
  })());
  ok('R5.3 缺 method/id 拒绝', (() => {
    const d = registry.adjudicate(recA.contextId, JSON.stringify({ v: 1, type: 'request', id: 'x' }));
    return !d.ok && d.code === registryMod.CONTEXT_ERROR_BAD_FRAME;
  })());
  ok('R6 存活计数(Inspector/生命周期审计用)', (() => {
    registry.create('cap-a', 'act-5', 'service');
    // recA + act-5 存活;cap-b 的两条已在 R2.2 吊销。
    return registry.aliveCount() === 2;
  })(), 'alive=' + registry.aliveCount());
}

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-context-registry: PASS'
  : 'plugin-context-registry: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
