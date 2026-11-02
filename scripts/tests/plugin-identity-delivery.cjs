'use strict';
// 静态门禁 ①：凡 registerHandler 回调带 identity 第二参的处理器，其调用方必须有可信令牌下发点。
// 抓两类真断点：
//   (a) "签名收紧了、调用方没同步"——处理器要身份，但没有任何调用点带上令牌；
//   (b) "省掉第三参后静默回落"——hostCall(m, payload) 省略第三参 → hostCall:205 回落到 currentToken()，
//       在装载期/回调期那是会话令牌 ''（M1-D 真实故障形态：plugin.sourceChunk 的 sourceToken）。
// 纯静态：不连设备、不构建。用法：node scripts/tests/plugin-identity-delivery.cjs [--strict]
//
// 站点判定口径（互斥，逐个 hostCall 站点归类）：
//   explicit   第三参存在，且能追到令牌铸造点（message.token / __lexiToken / tokenForPluginId() / entry.token / pluginToken）；
//              允许经一层标识符转手（例 sourceToken ← message.token）。
//   wrapper    第三参省略，但所在方法被 withToken(self.__lexiToken) 同步包装（shim 的 wrap 列表，hostCall 在同栈读令牌）。
//   api-root   第三参省略，但所在对象是 app 的 API 根（API_BIND_ROOTS），且 loadPlugin 对该根套了 bindApiToken(message.token) 代理。
//   captured   第三参是标识符 <name>，同一方法体内有 `var|let|const <name> = currentToken();` 且该行早于该方法的第一个
//              `.then(` 边界，而本 hostCall 站点在该边界之后 —— 即"进异步之前把同步栈上的令牌取出来再带进去"。
//              出现的真实原因：adapter.write/append 的 hostCall 只能在 adapterPaths().then(...) 回调里发，那时
//              withToken/bindApiToken 的同步令牌栈已经弹空，现场 currentToken() 只剩会话令牌 ''（宿主 fsGate fail-closed）。
//              **本类只覆盖"同一方法体内、捕获早于异步边界、原样以形参名传入"这一种形态**，下列写法仍判缺口（必须红）：
//              捕获挪到 .then 回调内部（栈已空，取到空令牌 = 原 bug 形状）；跨方法捕获（别处取、这里只转手）；
//              捕获结果存进对象字段/闭包变量再取出；捕获之后同名变量被重新赋值。
//   none / unknown-token  以上都不成立 → 身份在运行时是"看调用栈运气"，一律记为缺口。
//
// 缺口处置：缺口必须逐条登记在 KNOWN_GAPS（锚定代码片段 + 根因 + 修法 + 归属），每次运行都会重印；
//   --strict 时缺口也判失败（M2 收口后 CI 应改用 --strict）。
//   登记项若再也匹配不到任何站点，说明缺口已消失 → 打 STALE 警告，提醒删除登记（不判失败，因为性质上已满足）。
//
// RULE D：宿主 dispatch 的某条消息，若 shim 侧读 message.token 做身份，则宿主 payload 必须带 token 键。
// RULE E：处理器不许回头读 payload 里的 pluginId 自报身份（M1-D 已清除，这里防回潮）。

const fs = require('node:fs');

const { loadContext, handlerBodies, classifyTokenSite, dispatchTokenGaps, rel, short, PATHS } = require('./plugin-identity-model.cjs');

const STRICT = process.argv.indexOf('--strict') >= 0;

const indentOf = (line) => (line.match(/^\s*/) || [''])[0].length;

// 方法体范围：从站点向上找最近的具名函数声明（对象属性 / function 声明 / 赋值形态），到同缩进的 '},' 为止。
// 只用来切"同一方法体内"这个作用域，不解析 AST。（匿名 .then 回调不算方法边界 —— 那正是要判红的形状。）
function methodSpan(lines, siteIndex) {
  const DECL = /^\s*(?:([A-Za-z0-9_$]+)\s*:\s*function\s*\(|function\s+([A-Za-z0-9_$]+)\s*\(|([A-Za-z0-9_$.]+)\s*=\s*function\s*\()/;
  for (let i = siteIndex; i >= 0; i--) {
    const m = lines[i].match(DECL);
    if (!m) { continue; }
    const baseIndent = indentOf(lines[i]);
    let end = lines.length - 1;
    for (let j = i + 1; j < lines.length; j++) {
      if (indentOf(lines[j]) <= baseIndent && /^\},?\s*$/.test(lines[j].trim())) { end = j; break; }
    }
    return { start: i, end, name: (m[1] || m[2] || m[3] || '').split('.').pop() };
  }
  return null;
}

// 同一方法体内、站点之前最近的一行 `.then(`（-1 = 站点还在同步栈上）。
function thenBoundaryBefore(lines, span, siteIndex) {
  for (let i = span.start + 1; i < siteIndex; i++) {
    if (/\.then\s*\(/.test(lines[i])) { return i; }
  }
  return -1;
}

// captured 判定（结构性，无行号/方法名白名单）。两类形态放行：
//   (a) 跨异步边界：捕获早于方法内站点之前的 .then 边界（原判据）；
//   (b) 同步栈捕获：方法内从捕获到站点没有任何 .then 边界 —— 整段同一同步栈，
//       捕获值与站点现场 currentToken() 必然一致（wrapper/api-root 依据的是同一个保证）。
// 反作弊三条对两类同等适用（捕获后不得重赋值、不得是回调形参名）。
function capturedTokenSite(call, ctx) {
  if (call.tokenExpr === null) { return null; }
  const ident = call.tokenExpr.match(/^([A-Za-z_$][\w$]*)$/);
  if (!ident) { return null; }
  const name = ident[1];
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = ctx.shimLines;
  const site = call.line - 1;
  const span = methodSpan(lines, site);
  if (!span) { return null; }
  let captureAt = -1;
  for (let i = span.start + 1; i <= span.end; i++) {
    if (new RegExp('^\\s*(?:var|let|const)\\s+' + esc + '\\s*=\\s*currentToken\\(\\s*\\)\\s*;').test(lines[i])) { captureAt = i; break; }
  }
  if (captureAt < 0 || captureAt > site) { return null; }
  const boundary = thenBoundaryBefore(lines, span, site);
  if (boundary >= 0 && captureAt >= boundary) { return null; }
  // 反作弊：捕获之后同名变量被重新赋值（形如 token = currentToken() 挪进回调），或回调形参就叫这个名
  // （实际用的是形参、不是捕获值）—— 两种都是"事后取令牌"换了件衣服，不认。
  for (let i = captureAt + 1; i <= span.end; i++) {
    if (new RegExp('(?:^|[^\\w$.])' + esc + '\\s*=(?!=)').test(lines[i])) { return null; }
  }
  if (boundary >= 0) {
    for (let i = boundary; i <= site; i++) {
      const params = lines[i].match(/function\s*\(([^)]*)\)|\(([^)]*)\)\s*=>/);
      if (!params) { continue; }
      const names = (params[1] || params[2] || '').split(',').map((s) => s.trim().split(/[\s=:]/)[0]);
      if (names.indexOf(name) >= 0) { return null; }
    }
  }
  return {
    kind: 'captured',
    detail: name + ' ← ' + short(PATHS.shim) + ':' + (captureAt + 1) + ' ' + lines[captureAt].trim() +
      (boundary >= 0
        ? '（早于方法 ' + span.name + ' 的 .then 边界 ' + short(PATHS.shim) + ':' + (boundary + 1) + '，跨异步带入本站点）'
        : '（方法 ' + span.name + ' 内捕获到站点之间无 .then 边界，同一同步栈，捕获值=现场令牌）')
  };
}

// 已登记的缺口（= M2 身份面施工单）。anchor 必须是站点源码里的唯一片段，代码一改就会失配并报 STALE。
// 2026-11-02 清空：最后一条 net.requestUrl 已收口（per-plugin require 闭包带 pluginToken），
// 该站点现在被判 explicit；再有缺口必须先登记再用，不许直接判绿。
const KNOWN_GAPS = [];

const ctx = loadContext();
const bodies = handlerBodies();
const identityMethods = ctx.identityHandlers.map((h) => h.method);
const identitySet = new Set(identityMethods);

const rows = [];
for (const call of ctx.calls) {
  if (!call.method || !identitySet.has(call.method)) { continue; }
  let cls = classifyTokenSite(call, ctx);
  if (cls.kind === 'wrapper' || cls.kind === 'api-root') {
    // wrapper / api-root 都靠"同步令牌栈还在"成立：withToken 在调用期间压栈、bindApiToken 在代理入口压栈。
    // 站点落进 .then 回调后栈已弹空，这两类推理不再成立 —— 否则省掉第三参会被 api-root 悄悄接住（静默回落）。
    const span = methodSpan(ctx.shimLines, call.line - 1);
    const boundary = span ? thenBoundaryBefore(ctx.shimLines, span, call.line - 1) : -1;
    if (boundary >= 0) {
      cls = {
        kind: 'none',
        detail: '站点在 .then 回调内（' + short(PATHS.shim) + ':' + (boundary + 1) + '），同步令牌栈已弹空 → ' +
          cls.kind + ' 的同步代理不成立；第三参省略即回落 currentToken()'
      };
    }
  }
  if (cls.kind !== 'explicit' && cls.kind !== 'wrapper' && cls.kind !== 'api-root') {
    cls = capturedTokenSite(call, ctx) || cls;
  }
  const traced = cls.kind === 'explicit' || cls.kind === 'wrapper' || cls.kind === 'api-root' || cls.kind === 'captured';
  const gap = traced ? null : KNOWN_GAPS.find((g) => call.source.indexOf(g.anchor) >= 0);
  rows.push({
    method: call.method,
    site: short(PATHS.shim) + ':' + call.line,
    kind: traced ? cls.kind : (gap ? 'known-gap' : cls.kind),
    detail: cls.detail,
    gap,
    ok: traced
  });
}

const matchedAnchors = new Set(rows.filter((r) => r.gap).map((r) => r.gap.anchor));
const staleGaps = KNOWN_GAPS.filter((g) => !matchedAnchors.has(g.anchor));
const covered = new Set(rows.map((r) => r.method));
const noCallSite = identityMethods.filter((m) => !covered.has(m));
const unregistered = rows.filter((r) => !r.ok && !r.gap);
const knownGaps = rows.filter((r) => r.gap);

const selfClaims = [];
for (const method of identityMethods) {
  const body = bodies.get(method);
  if (!body) { continue; }
  if (/rpcString\(request,\s*'pluginId'\)|fieldOf\(payload,\s*'pluginId'\)|payload\.pluginId/.test(body.text)) {
    selfClaims.push({ method, line: body.startLine });
  }
}

const dispatch = dispatchTokenGaps();

function pad(text, width) {
  const s = String(text);
  let w = 0;
  for (const ch of s) { w += ch.charCodeAt(0) > 127 ? 2 : 1; }
  return w >= width ? s : s + ' '.repeat(width - w);
}

console.log('== ① 处理器 → 应有令牌来源 对照表（' + identityMethods.length + ' 个带 identity 的处理器 / ' + rows.length + ' 个调用点）==');
console.log(pad('处理器', 26) + pad('调用点', 16) + pad('身份来源', 12) + '状态');
for (const r of rows) {
  console.log(pad(r.method, 26) + pad(r.site, 16) + pad(r.kind, 12) + (r.ok ? 'OK' : (r.gap ? 'GAP(登记)' : 'FAIL')));
}
console.log('');
for (const r of rows) { console.log('  · ' + r.method + ' @ ' + r.site + ' → ' + r.detail); }
if (noCallSite.length) {
  console.log('\n  无调用点的身份处理器（通道在、下发点不存在，M2 前需真实调用者）: ' + noCallSite.join(', '));
}

console.log('\n== ② 缺口登记（M2 身份面施工单，每次运行重印）==');
if (!knownGaps.length) { console.log('  无'); }
for (const r of knownGaps) {
  console.log('  · ' + r.method + ' @ ' + r.site);
  console.log('      根因: ' + r.gap.rootCause);
  console.log('      修法: ' + r.gap.fix);
  console.log('      归属: ' + r.gap.owner);
}
for (const g of staleGaps) {
  console.log('  STALE ' + g.method + '：锚点已失配（缺口可能已修复），请从 KNOWN_GAPS 删除该登记');
}

console.log('\n== ③ RULE D：dispatch 侧身份下发 ==');
if (!dispatch.length) { console.log('  无 dispatch 消息依赖 message.token'); }
for (const g of dispatch) {
  console.log('  ' + (g.hasTokenKey ? 'OK   ' : 'FAIL ') + g.method + ' @ ' + short(PATHS.ets) + ':' + g.dispatchLine + '  ' + g.detail);
}

console.log('\n== ④ RULE E：处理器读 payload 自报身份（必须 0）==');
if (!selfClaims.length) { console.log('  0 处'); }
for (const s of selfClaims) { console.log('  FAIL ' + s.method + ' @ ' + short(PATHS.ets) + ':' + s.line); }

// RULE F：会话令牌交付链。宿主在 channel.auth 的成功响应里一直回 token（WorkspaceBridge.ets:258-266），
// 插件 shim 也一直有 setSessionToken，中间那一步"谁来落值"从来没人接——这就是 §16 那类病：两端各实现一遍、
// 中间没有对接，而门禁只验一端。静态钉住三件事，删任何一步都会红：
//   1) 容器 shim 只在 channel.auth 的响应形状上落令牌（不认形状会把别处的 token 误当会话令牌）；
//   2) adoptSessionToken 的出口必须真的调到 window.LexiObsidian.setSessionToken；
//   3) 插件 shim 的 setSessionToken 必须打 tail 锚点，否则设备侧只看到 tail=none 却查不出是谁没接。
console.log('\n== ⑤ RULE F：会话令牌交付链 ==');
const wsShimText = fs.readFileSync(PATHS.wsShim, 'utf8');
const pluginShimText = fs.readFileSync(PATHS.shim, 'utf8');
const sessionChecks = [
  {
    id: 'channel.auth 形状判定',
    ok: wsShimText.indexOf("frame.data.authed === true && typeof frame.data.channelId === 'string'") >= 0,
    detail: '容器 shim 必须按 channel.auth 的响应形状落令牌'
  },
  {
    id: 'adoptSessionToken → LexiObsidian.setSessionToken',
    ok: /function adoptSessionToken\(token\)[\s\S]{0,600}?window\.LexiObsidian\.setSessionToken\(sessionToken\)/.test(wsShimText),
    detail: 'adoptSessionToken 里必须转发到插件 shim（删掉转发 → 设备侧 tail=none 无从解释）'
  },
  {
    id: '插件 shim setSessionToken 打 tail',
    ok: /setSessionToken: function \(token\) \{[\s\S]{0,400}?session\.token tail=/.test(pluginShimText),
    detail: 'setSessionToken 内必须打 [lexinote] session.token tail=…'
  }
];
let sessionFails = 0;
for (const c of sessionChecks) {
  console.log('  ' + (c.ok ? 'OK   ' : 'FAIL ') + c.id + (c.ok ? '' : '  ' + c.detail));
  if (!c.ok) { sessionFails++; }
}

// 固定行(R3)：缺口可以是流程属性，但不能是隐形的——默认模式每次都要把它顶到输出里，
// release-gate --ci 转发这一行；M2 验收要求 --strict 下这里为 0。
console.log('\nknown gaps: ' + knownGaps.length + ' (must be 0 before M2)' + (staleGaps.length ? ' / stale ' + staleGaps.length : ''));

const dispatchFails = dispatch.filter((g) => !g.hasTokenKey).length;
const blocking = unregistered.length + dispatchFails + selfClaims.length + sessionFails + (STRICT ? knownGaps.length : 0);
console.log('\n[summary] 调用点 ' + rows.length + '：traced ' + rows.filter((r) => r.ok).length +
  '（explicit ' + rows.filter((r) => r.kind === 'explicit').length +
  ' / wrapper ' + rows.filter((r) => r.kind === 'wrapper').length +
  ' / api-root ' + rows.filter((r) => r.kind === 'api-root').length +
  ' / captured ' + rows.filter((r) => r.kind === 'captured').length + '）' +
  '  已登记缺口 ' + knownGaps.length + '  未登记缺口 ' + unregistered.length +
  '  dispatch 缺口 ' + dispatchFails + '  payload 自证 ' + selfClaims.length +
  '  会话交付缺口 ' + sessionFails + (STRICT ? '  [strict]' : ''));
for (const r of unregistered) { console.log('  FAIL(未登记) ' + r.method + ' @ ' + r.site + ' → ' + r.detail); }
console.log(blocking === 0
  ? 'plugin-identity-delivery: PASS' + (knownGaps.length ? '（有 ' + knownGaps.length + ' 条已登记缺口，--strict 会判失败）' : '')
  : 'plugin-identity-delivery: FAIL (' + blocking + ')');
process.exit(blocking === 0 ? 0 : 1);
