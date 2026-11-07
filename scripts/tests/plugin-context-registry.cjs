'use strict';
// RFC §3.3/§3.4 P1-003a · contextRegistry + 端口 RPC 网关门禁。
//
// 真跑三件套：真实 LexiContextRegistry + 真实 LexiPermissionBroker + 真实 handler 表，
// 验证 ADR-R18-01 定案 2/3 的行为：
//   R1 未注册 contextId → fail-closed（context_unregistered）；
//   R2 吊销后（revoke/revokePlugin）一切帧被拒——撤销立即生效的载体级形态（P2-010 联动）；
//   R3 身份来自记录反查：载荷自证 pluginId 被剥离且不影响判定（冒名邻居 → broker 按
//      记录身份拒绝 owner 不符;R3.1b 把同一纪律对到存储面 data.load,SEC-006）;
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
  // 两个插件:cap-a 声明 fs 与 vault.read/editor/data 域;cap-b 无任何能力。
  const broker = new brokerMod.LexiPermissionBroker(
    (pluginId) => pluginId === 'cap-a',
    (pluginId, method) => pluginId === 'cap-a' &&
      (method === 'vault.read' || method === 'vault.modify' || method === 'editor.replace' ||
        method === 'data.load'));
  // P1-008/R32:D 组需要 Gateway 入口双闸(unknown_method)作分层拒绝对账。
  let gatewayMod = null;
  try {
    gatewayMod = loadEts(path.join(CORE, 'LexiRpcGateway.ets'), (spec) => {
      if (String(spec).indexOf('LexiPermissionBroker') >= 0) { return brokerMod; }
      throw new Error('意外依赖: ' + spec);
    });
  } catch (error) {
    ok('D0 Gateway 模块可转译求值', false, 'threw: ' + error.message);
  }

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
  ok('R3.1b 存储面同轨:data.load 帧自报他插件 id 被剥离,宿主按记录身份归属私有存储(SEC-006 跨插件存储读取面)', (() => {
    const d = authorizeViaGateway(recA, frame('data.load', { pluginId: 'cap-b' }));
    return d.ok && d.identity === 'cap-a' && JSON.parse(d.payloadJson).pluginId === undefined &&
      d.method === 'data.load';
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

  // ------------------------------------- D P1-008/R32 销毁闭环(SEC-013 自动化)
  // 验收行:卸载后旧通道 RPC 一律拒绝。D 组在真实 registry(+broker/gateway)上重演完整
  // 销毁序:enable(两上下文)→ 销毁(revokePlugin)→ 旧通道帧逐条必须拒,且吊销先于
  // 身份剥离/路径白名单等一切后续判定(fail-closed 顺序即防线)。
  section('D P1-008 销毁闭环(SEC-013 旧通道一律拒;SEC-009×013 交叠:吊销先于路径判定)');
  {
    const destroyedRegistry = new registryMod.LexiContextRegistry();
    const dSvc = destroyedRegistry.create('cap-a', 'act-d1', 'service');
    const dView = destroyedRegistry.create('cap-a', 'act-d2', 'view');
    ok('D1 对照:销毁前旧通道真实可用(装载面反查身份)', (() => {
      const d = destroyedRegistry.adjudicate(dSvc.contextId, frame('data.load'));
      return d.ok && d.identity === 'cap-a';
    })());
    const destroyed = destroyedRegistry.revokePlugin('cap-a');
    const dSvcFrame = destroyedRegistry.adjudicate(dSvc.contextId, frame('data.load'));
    const dViewFrame = destroyedRegistry.adjudicate(dView.contextId, frame('vault.read', { path: 'notes/a.md' }));
    ok('D2 销毁后全部旧通道帧拒绝(context_revoked,SEC-013 卸载残留)',
      destroyed === 2 && !dSvcFrame.ok && dSvcFrame.code === registryMod.CONTEXT_ERROR_REVOKED &&
      !dViewFrame.ok && dViewFrame.code === registryMod.CONTEXT_ERROR_REVOKED);
    ok('D3 吊销先于载荷判定:伪造他人身份+穿越路径的旧帧同样 context_revoked(不进身份/fs 层)',
      (() => {
        const forged = destroyedRegistry.adjudicate(dSvc.contextId,
          frame('vault.read', { pluginId: 'cap-b', path: '../../../etc/passwd' }));
        return !forged.ok && forged.code === registryMod.CONTEXT_ERROR_REVOKED;
      })());
    ok('D4 重复销毁幂等(无僵尸复活):返回 0 且旧通道仍拒',
      destroyedRegistry.revokePlugin('cap-a') === 0 &&
      destroyedRegistry.adjudicate(dSvc.contextId, frame('data.load')).code === registryMod.CONTEXT_ERROR_REVOKED);
    ok('D5 未注册通道独立拒绝;销毁保留记录本体(审计可对账 revoked=true)',
      (() => {
        const ghost = destroyedRegistry.adjudicate('ctx-ghost', frame('data.load'));
        const record = destroyedRegistry.recordOf(dSvc.contextId);
        return !ghost.ok && ghost.code === registryMod.CONTEXT_ERROR_UNREGISTERED &&
          record !== null && record.revoked === true;
      })());
    ok('D6 新 contextId 不受旧销毁影响(重装重启用全新通道)',
      (() => {
        const fresh = destroyedRegistry.create('cap-a', 'act-d3', 'service');
        return destroyedRegistry.adjudicate(fresh.contextId, frame('data.load')).ok;
      })());
    if (gatewayMod) {
      // 双码分层:Gateway 入口层拒未登记方法(unknown_method);已登记方法放行后,
      // 已吊销通道仍在 registry 层被拒(context_revoked)——销毁后的旧通道撞哪层都是显式拒绝。
      const gateway = new gatewayMod.LexiRpcGateway();
      gateway.registerHandler('data.load', async () => '{\"ok\":true}');
      const entryReject = gateway.entryReject('lexinote.destroyed.channel', '{}');
      const entryParsed = JSON.parse(entryReject);
      ok('D7 Gateway 入口双闸:未登记方法显式 unknown_method(销毁后旧方法面同样显式拒)',
        entryParsed.ok === false && entryParsed.code === 'unknown_method');
      ok('D8 分层拒绝顺序:方法已登记(Gateway 方法面放行)但已吊销通道仍在 registry 层先拒',
        gateway.entryReject('data.load', '{}').length === 0 &&
        (() => {
          const decision = destroyedRegistry.adjudicate(dSvc.contextId, frame('data.load'));
          return !decision.ok && decision.code === registryMod.CONTEXT_ERROR_REVOKED;
        })());
    }
  }
}

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-context-registry: PASS'
  : 'plugin-context-registry: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
