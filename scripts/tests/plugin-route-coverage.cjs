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
// 调用方来源之二：视图 shim（与 plugin-channel-audit.cjs:23 的 shimFiles 同口径）。
// 它是活代码：lexinote_plugin_view.html:7 挂载，由 LexiPluginViewSlot.ets:19 与
// LexiPluginCodeBlockSlot.ets:20 的 Web($rawfile('lexinote_plugin_view.html')) 加载。
// 此前本门禁只扫插件 shim，唯一调用点落在视图 shim 里的处理器（vault.getByPath @ view_shim:339）
// 被误判成孤儿——孤儿判据是"没有任何调用方"，不是"插件 shim 里没有调用方"。
const VIEW_SHIM_PATH = path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_plugin_view_shim.js');
const VIEW_SHIM = readText(VIEW_SHIM_PATH);
const VIEW_SHIM_SHORT = 'viewShim';

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
// —— 视图 shim 的 hostCall 字面量调用点并入 perHandler（同一"多条调用点取最弱"规则）——
// 视图 shim 的 hostCall(method, payload, token)（view_shim:50）与插件 shim 同契入：
// 第三参省略/undefined 时不带第 4 个实参，宿主按"无身份"处理（view_shim:57 注释原文：
// "不带令牌时保持原样(宿主按"无身份"处理)，带了就作为第 4 个实参交给宿主反查归属。"）。
function splitTopArgs(text, start) {
  // start 指向 hostCall( 的 '(' 后一位；depth 从 1（调用括号本身）起算，顶层逗号才切分。
  const args = [];
  let depth = 1; let quote = ''; let cur = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += text[i + 1] || ''; i++; continue; }
      if (ch === quote) { quote = ''; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue; }
    if (ch === ')' && depth === 1) { args.push(cur.trim()); return { args, ok: true }; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; cur += ch; continue; }
    if (ch === ',' && depth === 1) { args.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  return { args: [], ok: false };
}

function parseViewShimCalls() {
  const calls = [];
  const re = /hostCall\(/g;
  let m;
  while ((m = re.exec(VIEW_SHIM)) !== null) {
    const line = VIEW_SHIM.slice(0, m.index).split('\n').length;
    const open = m.index + 'hostCall'.length;
    if (VIEW_SHIM[open] !== '(') { continue; }
    const { args, ok } = splitTopArgs(VIEW_SHIM, open + 1);
    if (!ok) { continue; }
    const literal = (args[0] || '').trim().match(/^'([^']*)'$/);
    if (!literal) { continue; } // 动态方法名与定义行自然不匹配；动态分派由 plugin-channel-audit 提示
    calls.push({
      line,
      method: literal[1],
      tokenExpr: args.length >= 3 ? (args[2] || '').trim() : null
    });
  }
  return calls;
}

// 视图面令牌来源（比插件 shim 多认 payload.token：lexinoteView.boot 的注入形参）。
const VIEW_TOKEN_SOURCES = /message\.token|payload\.token|objectToken\(|__lexiToken|tokenForPluginId\(|\bentry\.token\b|\bpluginToken\b|\bloadToken\b/;

function traceViewShimToken(ident) {
  // 追 `IDENT = ...` 的全部声明/赋值点（声明行同样命中该模式）。任一 RHS 命中令牌来源 →
  // explicit（带行号证据）；全部赋值都是空串/null → none；否则 unknown-token。
  const lines = VIEW_SHIM.split('\n');
  const assign = new RegExp('(?:^|[^\\w$.])' + ident + '\\s*=\\s*([^;\\n]+)');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(assign);
    if (m) { hits.push({ line: i + 1, rhs: m[1].trim() }); }
  }
  if (!hits.length) {
    return { kind: 'unknown-token', detail: '第三参 ' + ident + '（视图面内无赋值点）' };
  }
  const injected = hits.filter((h) => VIEW_TOKEN_SOURCES.test(h.rhs));
  if (injected.length) {
    return { kind: 'explicit', detail: '第三参 ' + ident + ' ← view_shim:' + injected[0].line + ' ' + injected[0].rhs + '（boot payload 注入）' };
  }
  if (hits.every((h) => /^(?:''|""|null|undefined)$/.test(h.rhs))) {
    return { kind: 'none', detail: '第三参 ' + ident + ' 恒为空串（view_shim:' + hits.map((h) => h.line).join('/') + '，无注入点）→ 宿主按无身份处理' };
  }
  return { kind: 'unknown-token', detail: '第三参 ' + ident + ' ← view_shim:' + hits[0].line + ' ' + hits[0].rhs + '（无法静态判源）' };
}

function classifyViewShimCall(call) {
  const t = call.tokenExpr;
  if (t === null || /^(undefined|null|''|""|currentToken\(\))$/.test(t)) {
    return { kind: 'none', detail: '视图 shim 第三参省略 → hostCall 不带令牌，宿主按无身份处理（view_shim:50/:57）' };
  }
  if (VIEW_TOKEN_SOURCES.test(t)) {
    return { kind: 'explicit', detail: '视图 shim 第三参 ' + t };
  }
  const ident = t.match(/^([A-Za-z_$][\w$]*)$/);
  if (ident) { return traceViewShimToken(ident[1]); }
  return { kind: 'unknown-token', detail: '视图 shim 第三参 ' + t + '（无法静态判源）' };
}

// 视图面调用点按方法归并（同方法多调用点取最弱，与 perHandler 同规则）。
// 注意：这份映射【不】参与 A/B 路由列的取最弱——① 表的"身份来源"与"可用/fail-closed"
// 回答的是两条挂载路由（都挂插件 shim）上的事实；视图面是第三块挂载面，单列成注记，
// 否则 data.load 这类"路由上宿主注入、视图面上无令牌"的处理器会被整体降级，报表失真。
const viewShimCalls = new Map();
for (const call of parseViewShimCalls()) {
  if (!identitySet.has(call.method)) { continue; }
  const cls = classifyViewShimCall(call);
  const prev = viewShimCalls.get(call.method);
  const rank = order[cls.kind] === undefined ? 1 : order[cls.kind];
  if (!prev || rank < prev.rank) {
    viewShimCalls.set(call.method, { line: call.line, kind: cls.kind, detail: cls.detail });
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
  const shimInfo = perHandler.get(method);
  const viewInfo = viewShimCalls.get(method) || null;
  // 孤儿判据 = 两个调用方来源（插件 shim + 视图 shim）都没有调用点；只有视图面调用的
  // 处理器不是孤儿，按其视图面取值点归类（当前全部第三参省略 → fail-closed）。
  const info = shimInfo || (viewInfo
    ? { kind: viewInfo.kind, site: VIEW_SHIM_SHORT + ':' + viewInfo.line, detail: viewInfo.detail + '（插件 shim 无调用点，调用方仅视图面）' }
    : { kind: 'none', site: '-', detail: '无调用点' });
  // 回写到 perHandler（否则 fallback 对象只存在于本轮循环，summary 统计看不到）
  if (!shimInfo) { perHandler.set(method, info); }
  if (info.kind === 'none' && info.detail === '无调用点') { info.kind = ORPHAN_RETAINED; }
  const provenance = labelOf(info.kind);
  // 插件作用域的令牌只由 load.plugin 的 message.token 进入页面（两个路由共用同一 runtime 实例），
  // 因此只要 load.plugin 有下发点，宿主注入类在两条路由上等价可用；"无"类在两条路由上都 fail-closed。
  // 仅视图面调用的处理器在 A/B 两路由上没有调用点，路由列如实标注"仅视图面"。
  const reach = (!shimInfo && viewInfo) ? '仅视图面 / 仅视图面'
    : provenance === '宿主注入' ? '可用 / 可用'
    : info.kind === ORPHAN_RETAINED ? '无调用方 / 无调用方'
    : 'fail-closed / fail-closed';
  if (provenance !== '宿主注入') { weak.push(method); }
  console.log('  ' + pad(method, 26) + pad(provenance, 16) + pad(info.site, 16) + reach);
}
const viewEntries = Array.from(viewShimCalls.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
if (viewEntries.length) {
  const viewNone = viewEntries.filter((e) => e[1].kind === 'none').length;
  console.log('  视图面注记: lexinote_plugin_view_shim.js（经 LexiPluginViewSlot.ets:19 / LexiPluginCodeBlockSlot.ets:20 挂载，view_shim:379 暴露 vault 桥）调用身份处理器 ' +
    viewEntries.length + ' 条: ' + viewEntries.map((e) => e[0] + '@' + VIEW_SHIM_SHORT + ':' + e[1].line).join(', '));
  console.log('  视图面 hostCall 契约: 第三参省略 → 不带第 4 实参，宿主按无身份处理（view_shim:50/:57）；当前 ' + viewNone + '/' + viewEntries.length + ' 条 fail-closed' +
    (function () {
      const credentialed = viewEntries.filter((e) => e[1].kind !== 'none');
      return credentialed.length ? '；带凭据路径: ' + credentialed.map((e) => e[0] + '（' + e[1].detail + '）').join('; ') : '';
    })());
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
