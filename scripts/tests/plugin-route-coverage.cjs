'use strict';
// 两条挂载路由的身份覆盖差异报告（静态、不连设备）。
//
// 为什么按"方式"分类而不是按数量：两个页面挂的是同一份 shim、同一个 LexiWebRuntime.call，
// 处理器数量完全相同；真正的差异在"令牌从哪来"。所以本报告对每个处理器只回答一件事：
//   它的宿主调用凭据是【宿主注入】（bindApiToken / withToken / 显式 message.token）、
//   还是【无】（fail-closed，运行时归属不到插件）、还是【payload 自称】（必须为 0）。
// 然后把两种路由各自能提供的铸造/下发点列成清单——这份清单就是 M2 切路由的施工单。
//
// 路由：
//   A 容器路由：entry/src/main/ets/pages/LexiWorkspacePage.ets:8 → rawfile/lexinote_workspace.html:88 → lexinote_plugin_shim.js
//     宿主侧 WorkspaceBridge 在 channel.auth 时铸造会话令牌（WorkspaceBridge.ets:250-251）。
//   B 旧路由：entry/src/main/ets/components/plugin/LexiPluginRuntimeHost.ets:30 → rawfile/lexinote_plugin_runtime.html:6 → 同一份 shim
//     宿主侧 javaScriptProxy({object: manager.runtime, name:'lexiHost', methodList:['call']})，本文件内无任何铸造点。
//
// exit 1 条件：出现 payload 自称身份的处理器，或某路由上的 load.plugin 断链（分片/装载无令牌下发）。

const fs = require('fs');
const path = require('path');
const { PATHS, ROOT, loadContext, handlerBodies, classifyTokenSite, dispatchTokenGaps, short } = require('./plugin-identity-model.cjs');

const readText = (p) => fs.readFileSync(p, 'utf8');
const SHIM = readText(PATHS.shim);
const BRIDGE = readText(path.join(ROOT, 'entry/src/main/ets/workspace/WorkspaceBridge.ets'));
const HOST = readText(path.join(ROOT, 'entry/src/main/ets/components/plugin/LexiPluginRuntimeHost.ets'));
const RUNTIME_ETS = readText(PATHS.ets);
const PLUGIN_HTML = readText(path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_plugin_runtime.html'));
const WORKSPACE_HTML = readText(path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_workspace.html'));
const WORKSPACE_SHIM = readText(path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_workspace_shim.js'));

const ctx = loadContext();
const bodies = handlerBodies();
const identityMethods = ctx.identityHandlers.map((h) => h.method);
const identitySet = new Set(identityMethods);

// —— 每个处理器唯一的身份取得方式（多条调用点取最弱：出现 none 就算 none）——
const order = { 'payload-claim': 0, none: 1, 'unknown-token': 1, explicit: 2, wrapper: 2, 'api-root': 2 };
const perHandler = new Map();
for (const call of ctx.calls) {
  if (!identitySet.has(call.method)) { continue; }
  const cls = classifyTokenSite(call, ctx);
  const prev = perHandler.get(call.method);
  const rank = order[cls.kind] === undefined ? 1 : order[cls.kind];
  if (!prev || rank < prev.rank) {
    perHandler.set(call.method, { kind: cls.kind, site: short(PATHS.shim) + ':' + call.line, detail: cls.detail, rank });
  }
}
const claims = [];
for (const method of identityMethods) {
  const body = bodies.get(method);
  if (body && /rpcString\(request,\s*'pluginId'\)|payload\.pluginId/.test(body.text)) {
    claims.push(method);
    perHandler.set(method, { kind: 'payload-claim', site: short(PATHS.ets) + ':' + body.startLine, detail: '读 payload.pluginId 自报身份', rank: 0 });
  }
}

// orphan-retained = 处理器存在但没有任何调用方(plugin-channel-audit 早把它列为 orphan)。
// 它既不是"需要令牌的缺口"，也不是"已安全"，放进缺口统计会把真实比例说歪——单列一类并写明回潮条件。
const ORPHAN_RETAINED = 'orphan-retained';

// 受祝福的孤儿集合：只许手工增删，禁止按"当前没有调用方"自动扩容。
// 理由：orphan-retained 的判据就是"没有调用方"，若自动收编，任何人删掉一个带令牌的调用点，
// 该处理器就会静默降级成"保留能力、不计入缺口"——门禁照绿，而那条 API 已经死了。
// 所以集合必须钉死：多出成员 = 疑似调用点被删（红），成员消失 = 它被接线了（红，必须改身份并更新常量）。
const BLESSED_ORPHANS = [
  { method: 'plugin.sourceSize', why: '宿主侧统计插件源码体积（LexiPluginRuntime.ets:934），shim 从不调用；保留给未来的体积预检' },
];
const labelOf = (kind) => (kind === 'payload-claim' ? 'payload 自称'
  : kind === ORPHAN_RETAINED ? '无调用方（保留能力）'
  : (kind === 'none' || kind === 'unknown-token') ? '无（fail-closed）'
  : '宿主注入');

// —— 铸造点与下发点清单（按路由归属）——
const mintFunctions = [];
for (const line of RUNTIME_ETS.split('\n')) {
  const m = line.match(/^\s{2}(mintPluginToken|pluginIdForToken|revokePluginTokens)\(/);
  if (m) { mintFunctions.push(m[1]); }
}
const bridgeSessionMint = /this\.mint\('st'\)/.test(BRIDGE) && /this\.tokens\.set\(sessionToken,\s*SESSION_PLUGIN_ID\)/.test(BRIDGE);
const legacyMintSites = (HOST.match(/mintPluginToken|this\.mint\(/g) || []).length;
const shimSessionSetterCallers = (SHIM + WORKSPACE_SHIM).split('\n').filter((l) => /setSessionToken\s*\(/.test(l) && !/setSessionToken:\s*function/.test(l)).length;
const pluginShimHasSession = /var sessionToken = '';/.test(SHIM) && /setSessionToken: function/.test(SHIM);

function pad(t, w) {
  let n = 0;
  for (const ch of String(t)) { n += ch.charCodeAt(0) > 127 ? 2 : 1; }
  return n >= w ? String(t) : String(t) + ' '.repeat(w - n);
}

console.log('== 两条挂载路由 ==');
console.log('  A 容器路由: LexiWorkspacePage.ets:8 → rawfile/lexinote_workspace.html' + (WORKSPACE_HTML.indexOf('lexinote_plugin_shim.js') >= 0 ? ':88 → lexinote_plugin_shim.js' : '（未挂 shim）'));
console.log('  B 旧路由   : LexiPluginRuntimeHost.ets:30 → rawfile/lexinote_plugin_runtime.html' + (PLUGIN_HTML.indexOf('lexinote_plugin_shim.js') >= 0 ? ':6 → lexinote_plugin_shim.js' : '（未挂 shim）'));
console.log('  两路由共用同一个 LexiWebRuntime.call（abi: call(callId, method, payloadJson, identity)）与同一份 shim：处理器集合完全相同，差异只在令牌下发点。');

console.log('\n== ① 处理器身份来源分类（按方式，不按数量）==');
console.log('  ' + pad('处理器', 26) + pad('身份来源', 16) + pad('取值点', 16) + 'A 容器路由 / B 旧路由');
const sorted = identityMethods.slice().sort();
const weak = [];
for (const method of sorted) {
  const info = perHandler.get(method) || { kind: 'none', site: '-', detail: '无调用点' };
  // 回写到 perHandler（否则 fallback 对象只存在于本轮循环，summary 统计看不到）
  if (info.kind === 'none' && info.detail === '无调用点') { info.kind = ORPHAN_RETAINED; perHandler.set(method, info); }
  const provenance = labelOf(info.kind);
  // 插件作用域的令牌只由 load.plugin 的 message.token 进入页面（两个路由共用同一 runtime 实例），
  // 因此只要 load.plugin 有下发点，宿主注入类在两条路由上等价可用；"无"类在两条路由上都 fail-closed。
  const reach = provenance === '宿主注入' ? '可用 / 可用'
    : info.kind === ORPHAN_RETAINED ? '无调用方 / 无调用方'
    : 'fail-closed / fail-closed';
  if (provenance !== '宿主注入') { weak.push(method); }
  console.log('  ' + pad(method, 26) + pad(provenance, 16) + pad(info.site, 16) + reach);
}

console.log('\n== ② 令牌铸造点清单（谁是可信身份的出生地）==');
console.log('  LexiWebRuntime（commonjs 运行时，两路由共用）: ' + (mintFunctions.length ? mintFunctions.join(' / ') + ' @ ' + short(PATHS.ets) : '无'));
console.log('  插件令牌实际铸造调用点: ' + short(PATHS.ets) + ':1535 mintPluginToken(pluginId)（load.plugin 装载流程内，两路由都经此路径）');
console.log('  容器路由会话令牌: ' + (bridgeSessionMint ? 'WorkspaceBridge.ets:250-251 mint("st") → tokens.set(sessionToken, SESSION_PLUGIN_ID)' : '缺失'));
console.log('  旧路由令牌铸造点: ' + legacyMintSites + ' 处（LexiPluginRuntimeHost.ets 内）' + (legacyMintSites === 0 ? ' ← 旧路由自身没有任何铸造点，插件令牌只能来自 load.plugin 装载流程' : ''));
console.log('  → 结论：插件作用域的身份在两条路由上同源（load.plugin 令牌）；差异集中在"页面会话身份"这一层。');

console.log('\n== ③ 会话身份通道差异（切路由施工单的第一项）==');
console.log('  插件 shim 有 session 变量与 setSessionToken: ' + (pluginShimHasSession ? '是（lexinote_plugin_shim.js:30 / :2508）' : '否'));
console.log('  setSessionToken 的调用者数量（两份 shim 合计，排除定义行）: ' + shimSessionSetterCallers +
  (shimSessionSetterCallers === 0 ? ' ← 插件 shim 的会话令牌永远为空串：会话作用域调用一律回落 currentToken()=""' : ''));
console.log('  容器路由: channel.auth.ok 的 token 由 workspace_shim 的 adoptSessionToken 落值并转发 window.LexiObsidian.setSessionToken（静态已接；运行时锚点 [lexinote] session.token tail=… 待设备轮）');
console.log('  旧路由: 没有 channel.auth，因此没有会话身份——只有 load.plugin 的插件作用域令牌');
console.log('  → 两路由的"插件作用域身份"同源（load.plugin 令牌）；"页面会话身份"只有容器路由有，且依赖 channel.auth.ok 的回包。');

console.log('\n== ④ 装载链路（load.plugin）身份下发 ==');
const dispatch = dispatchTokenGaps();
const loadGap = dispatch.find((g) => g.method === 'load.plugin');
console.log('  ' + (loadGap ? (loadGap.hasTokenKey ? 'OK   ' : 'FAIL ') : 'N/A  ') + (loadGap ? loadGap.detail : 'dispatch 未找到 load.plugin'));
console.log('  ' + short(PATHS.shim) + ':2174 sourceToken ← message.token；:2176 hostCall("plugin.sourceChunk", …, sourceToken)（分片路径显式携带，不得省略第三参）');

const weakNoCall = weak.filter((m) => (perHandler.get(m) || {}).kind === ORPHAN_RETAINED);
const weakFailClosed = weak.filter((m) => weakNoCall.indexOf(m) < 0);
const blessedNames = BLESSED_ORPHANS.map((e) => e.method);
const handlerLine = (method) => {
  const body = bodies.get(method);
  return body ? 'LexiPluginRuntime.ets:' + body.startLine : 'LexiPluginRuntime.ets:?';
};
// 多出成员：调用点被删了（能力静默失效）——不是"保留能力"。
const unregisteredOrphans = weakNoCall.filter((m) => blessedNames.indexOf(m) < 0);
// 成员消失：它被接线了，现在有调用方；必须带令牌并把它从 BLESSED_ORPHANS 里删掉。
const vanishedBlessed = BLESSED_ORPHANS.filter((e) => weakNoCall.indexOf(e.method) < 0).map((e) => e.method);
console.log('\n[summary] 处理器 ' + identityMethods.length + '：宿主注入 ' + (identityMethods.length - weak.length) +
  ' / 无(fail-closed) ' + weakFailClosed.length + ' / orphan-retained: ' + weakNoCall.length + ' (blessed: ' + blessedNames.length + ')' +
  ' / payload 自称 ' + claims.length);
if (weakFailClosed.length) { console.log('  非宿主注入清单（= M2 收口 + 会话通道施工单）: ' + weakFailClosed.join(', ')); }
for (const e of BLESSED_ORPHANS) {
  console.log('  ' + (weakNoCall.indexOf(e.method) >= 0 ? 'OK   ' : 'FAIL ') + 'blessed orphan ' + e.method + ' @ ' + handlerLine(e.method) + ' — ' + e.why);
}
for (const m of unregisteredOrphans) {
  console.log('  FAIL 未登记的孤儿（疑似调用点被删 → 能力静默失效）: ' + m + ' @ ' + handlerLine(m) + ' ← 若确实要停用该能力，请显式登记并写明理由；若调用点是被误删的，把它恢复');
}
for (const m of vanishedBlessed) {
  console.log('  FAIL 受祝福孤儿已接线（成员消失）: ' + m + ' @ ' + handlerLine(m) + ' ← 它现在有调用方，必须带令牌，并从 BLESSED_ORPHANS 删除');
}
const fail = claims.length > 0 || (loadGap !== undefined && !loadGap.hasTokenKey) ||
  unregisteredOrphans.length > 0 || vanishedBlessed.length > 0;
console.log(fail ? 'plugin-route-coverage: FAIL' : 'plugin-route-coverage: PASS（报告型，差异已列清单）');
process.exit(fail ? 1 : 0);
