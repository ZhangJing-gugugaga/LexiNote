'use strict';
// RFC §14 T0.1 身份系统修复 · 安全门禁（对应 P0-01 / §3.4）。
//
// 五条硬规则，全部针对"宿主侧身份面"，违反任何一条 exit 1：
//   R1 call() 禁止 raw identity 信任：身份凭据必须先过本运行时凭据表解析，
//      解析不出角色（anonymous）就必须 fail-closed，不得把调用方字符串当身份下传。
//   R2 身份凭据必须 CSPRNG：铸造路径用 cryptoFramework 安全随机（≥256bit），
//      Math.random / Date.now 拼凭据一律红。
//   R3 桥侧委托必须凭据化：WorkspaceBridge → runtime.call 的身份实参必须是运行时铸造的
//      凭据（会话凭据 / 插件凭据），不得再传裸 pluginId 字符串。
//   R4 plugin.list / plugin.load 只允许页面会话角色：插件令牌（非会话身份）调用必须拒绝。
//   R5 插件执行面不得读会话令牌：shim 公共面不暴露 getSessionToken / setPluginToken，
//      会话令牌只能单向注入（setSessionToken），不允许代码读回原值。
//
// 纯静态 + 一个 shim vm 求值。不连设备、不构建。
// 用法：node scripts/tests/plugin-bridge-security.cjs

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDispatchChannel } = require('./plugin-dispatch-channel.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginRuntime.ets');
const BRIDGE_ETS = path.join(ROOT, 'entry/src/main/ets/workspace/WorkspaceBridge.ets');
const CREDENTIAL_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiCredentialFactory.ets');
const SHIM = path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_plugin_shim.js');
const PROBE = path.join(ROOT, 'entry/src/main/resources/rawfile/plugins/cap-probe-unauth/main.js');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}

const runtimeSrc = fs.readFileSync(RUNTIME_ETS, 'utf8');
const bridgeSrc = fs.readFileSync(BRIDGE_ETS, 'utf8');
const shimSrc = fs.readFileSync(SHIM, 'utf8');
const hasCredentialFactory = fs.existsSync(CREDENTIAL_ETS);
const credentialSrc = hasCredentialFactory ? fs.readFileSync(CREDENTIAL_ETS, 'utf8') : '';
const probeSrc = fs.readFileSync(PROBE, 'utf8');

// ---------------------------------------------------------------- R1 raw identity 信任必须移除
console.log('== R1 call() fail-closed 身份解析 ==');
ok('R1a 禁止 owned→raw 回落表达式', !/\?\s*owned\s*:\s*raw/.test(runtimeSrc),
  'LexiPluginRuntime.ets 仍含 "owned : raw" 回落（解析不出凭据就把调用方字符串当身份）');
ok('R1b 存在凭据→角色解析（anonymous 兜底）', /roleOfCredential\s*\(/.test(runtimeSrc) &&
  /'anonymous'/.test(runtimeSrc),
  '需要 roleOfCredential()，未知凭据一律归入 anonymous 角色');
ok('R1c anonymous 调用落审计并 fail-closed', /identity\.anonymous/.test(runtimeSrc) &&
  /ERROR_IDENTITY_UNTRUSTED/.test(runtimeSrc),
  '未知凭据必须落 identity.anonymous 审计行且不得静默放行');
ok('R1d trusted 身份只来自凭据表', !/trusted[^;\n]*=\s*raw\s*;/.test(runtimeSrc),
  'trusted 身份不允许直接取调用方原串');
ok('R1e 源码通道保持令牌硬门', /plugin\.sourceChunk/.test(runtimeSrc) &&
  /fail-closed|fail_closed/.test(runtimeSrc),
  'plugin.sourceChunk 的 fail-closed 分支不得随重构消失');

// ---------------------------------------------------------------- R2 CSPRNG
console.log('== R2 身份凭据 CSPRNG ==');
ok('R2a 凭据工厂存在', hasCredentialFactory, '缺少 LexiCredentialFactory.ets');
if (hasCredentialFactory) {
  ok('R2b 使用 cryptoFramework 安全随机', /cryptoFramework/.test(credentialSrc) &&
    /generateRandomSync/.test(credentialSrc),
    '必须用 cryptoFramework.generateRandomSync（系统 CSPRNG）');
  ok('R2c 熵 ≥ 256bit（32 字节）', /secureRandomHex\s*\(\s*32\s*\)|generateRandomSync\s*\(\s*32\s*\)/.test(credentialSrc) ||
    /32\s*\)/.test(credentialSrc),
    '铸造必须取 32 字节（256bit）随机数');
  ok('R2d 工厂禁用 Math.random', !/Math\.random/.test(credentialSrc), '凭据工厂不得用 Math.random');
}
ok('R2e 运行时铸造不用 Math.random', !/Math\.random/.test(runtimeSrc),
  'LexiPluginRuntime.ets 不得出现 Math.random（含令牌铸造路径）');
ok('R2f 桥侧铸造不用 Math.random', !/Math\.random/.test(bridgeSrc),
  'WorkspaceBridge.ets 不得出现 Math.random（含会话令牌/nonce 铸造路径）');
ok('R2g 运行时接入凭据工厂', /mintCredential\s*\(/.test(runtimeSrc),
  'mintPluginToken/sessionCredential 必须经 mintCredential() 铸造');
ok('R2h 桥侧接入凭据工厂', /mintCredential\s*\(/.test(bridgeSrc) || /secureRandomHex\s*\(/.test(bridgeSrc),
  'WorkspaceBridge.mint 必须改用 CSPRNG 工厂');

// ---------------------------------------------------------------- R3 桥侧委托凭据化
console.log('== R3 WorkspaceBridge → runtime.call 凭据化 ==');
ok('R3a 禁止裸 pluginId 作身份实参', !/runtime\.call\([^)]*JSON\.stringify\(forwarded\)\s*,\s*pluginId\s*\)/.test(bridgeSrc),
  'delegate 不得再把 token 表解析出的 pluginId 字符串直接当身份传给 runtime.call');
ok('R3b 存在运行时凭据解析', /runtimeCredentialFor\s*\(/.test(bridgeSrc) ||
  (/sessionCredential\s*\(/.test(bridgeSrc) && /tokenForPlugin\s*\(/.test(bridgeSrc)),
  'delegate 必须把桥侧身份翻译成运行时铸造的凭据（会话凭据 / tokenForPlugin）');

// ---------------------------------------------------------------- R4 控制面角色门
console.log('== R4 plugin.list / plugin.load 只允许会话角色 ==');
const dispatchRegion = (bridgeSrc.match(/private async dispatch\([\s\S]*?\n  \}/) || [''])[0];
ok('R4a dispatch 内存在非会话角色拒绝', /SESSION_PLUGIN_ID/.test(dispatchRegion),
  'dispatch 必须解析令牌归属并对非会话身份拒绝（SESSION_PLUGIN_ID 校验）');
ok('R4b 拒绝原因点明控制面', /控制面/.test(bridgeSrc),
  '拒绝消息必须说明"插件控制面只允许页面会话调用"');

// ---------------------------------------------------------------- R5 shim 公共面收敛
console.log('== R5 插件执行面不得读会话令牌 ==');
ok('R5a 移除 getSessionToken', !/getSessionToken\s*:/.test(shimSrc),
  'window.LexiObsidian.getSessionToken 把会话令牌原值交给页面内任意代码');
ok('R5b 移除 setPluginToken', !/setPluginToken\s*:/.test(shimSrc),
  'window.LexiObsidian.setPluginToken 允许覆盖任意插件实例的令牌（跨插件身份劫持）');
ok('R5c setSessionToken 单向注入保留', /setSessionToken\s*:\s*function\s*\(/.test(shimSrc),
  '容器向 shim 注入会话身份的通道必须保留（RULE F 交付链）');
ok('R5d 探针不再读会话令牌原值', !/getSessionToken/.test(probeSrc),
  'cap-probe-unauth 应改用无凭据调用（宿主按 anonymous fail-closed），不再索取令牌原值');
ok('R5e stats 只暴露令牌尾号', !/sessionToken(?!\.slice\(-6\)|\.length)[^;\n]*slice\(-6\)\s*;?\s*$/.test(shimSrc) ||
  /sessionTokenTail:\s*sessionToken\.slice\(-6\)/.test(shimSrc),
  '诊断面只允许尾号 6 位');

// ---------------------------------------------------------------- R6 shim vm 求值（真实公共面）
console.log('== R6 shim 公共面 vm 求值 ==');
function evalShim() {
  const sandbox = {
    window: {},
    console: { log: function () {}, warn: function () {}, error: function () {} },
    setTimeout: function (fn) { return 0; },
    clearTimeout: function () {},
    setInterval: function () { return 0; },
    clearInterval: function () {},
    Promise: Promise,
    JSON: JSON,
    Math: Math,
    Date: Date,
    Map: Map,
    Set: Set,
    document: { createElement: function () { return { style: {}, classList: { add: function () {} } }; } },
    location: { href: 'about:blank' }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSrc, sandbox, { filename: 'lexinote_plugin_shim.js' });
  return sandbox;
}
try {
  const sb = evalShim();
  const surface = sb.window.LexiObsidian || sb.LexiObsidian;
  ok('R6a shim 可在无宿主环境求值', !!surface, 'shim 求值失败或未注册 LexiObsidian');
  if (surface) {
    ok('R6b 公共面无 getSessionToken', typeof surface.getSessionToken === 'undefined',
      'getSessionToken 仍在公共面');
    ok('R6c 公共面无 setPluginToken', typeof surface.setPluginToken === 'undefined',
      'setPluginToken 仍在公共面');
    ok('R6d setSessionToken 仍可注入', typeof surface.setSessionToken === 'function',
      '容器注入通道丢失');
    ok('R6e 注入后不可读回', surface.setSessionToken('st-unit-test-abcdef') ||
      typeof surface.getSessionToken === 'undefined',
      '注入成功即可，不得提供读回通道');
    // R6f-h: P1-006 三层收口的行为级负断言(vm 求值后的真实对象面上做 typeof,静态文本骗不过这里)。
    ok('R6f 公共面无 currentToken 读回', typeof surface.currentToken === 'undefined',
      'currentToken 别名 = 裸会话令牌读回通道(真机审计 Round 7 确认的泄露面),不得回归');
    ok('R6g 公共面无 withToken/hostCall 手工入口', typeof surface.withToken === 'undefined' &&
      typeof surface.hostCall === 'undefined',
      '手工 RPC/压栈入口允许插件携带任意令牌调控制面;插件身份通道只允许 bindApiToken 包裹的 app API 面');
    ok('R6h 装载口仍在(容器 bundle 实测消费)', typeof surface.loadPlugin === 'function' &&
      typeof surface.unloadPlugin === 'function', 'loadPlugin/unloadPlugin 是容器装载口,误删即回归');
  }
} catch (error) {
  ok('R6a shim 可在无宿主环境求值', false, 'threw: ' + error.message);
}

// ---------------------------------------------------------------- R7 身份闭包化(P1-006)
console.log('== R7 令牌只活闭包 ==');
{
  // 去掉块注释与行注释后扫描代码体,防止"把泄漏写进注释躲门禁"。
  const codeBody = shimSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  ok('R7a 代码体无 __lexiToken 属性形态', !/__lexiToken/.test(codeBody),
    '实例/leaf/EditorProxy 的 __lexiToken 属性 = 同 realm 插件 A 经 getPlugin(B) 盗读 B 凭据的通道;' +
    '归属令牌必须存闭包 WeakMap(objectIdentityTokens)');
  ok('R7b currentToken 无会话兜底', !/return\s+tokenScope[\s\S]{0,120}:\s*sessionToken\s*;/.test(codeBody),
    '栈空必须返回空串 fail-closed 匿名;兜底 sessionToken 会把裸异步/定时器路径升格为页面会话身份');
  ok('R7c 布局控制面显式会话凭据', /hostCall\('workspace\.loadLayout'[\s\S]{0,80}sessionToken/.test(codeBody) &&
    /hostCall\('workspace\.saveLayout'[\s\S]{0,120}sessionToken/.test(codeBody),
    'restoreLayout/saveLayout/persistLayout 属宿主页自身管理面:必须显式携带闭包内 sessionToken,不得借道兜底');
  ok('R7d WeakMap 归属表存在', /objectIdentityTokens\s*=\s*new WeakMap/.test(codeBody) &&
    /function\s+setObjectToken\(/.test(codeBody), 'P1-006 的闭包令牌表结构锚点');
}

// ---------------------------------------------------------------- R8 dispatch 通道鉴权 + 会话作用域(P1-006b)
console.log('== R8 dispatch 通道鉴权 + setSessionToken 作用域(P1-006b,SEC-007 负例进门禁) ==');
// R8a:宿主每次派发铸造一次性通道凭据,作为第 3 实参进 __receive 门卫。
ok('R8a dispatch 铸造一次性通道凭据并随帧下发', /mintChannelCredential\(/.test(runtimeSrc) &&
  /__receive\(\$\{JSON\.stringify\(method\)\}, \$\{JSON\.stringify\(payloadJson\)\}, \$\{JSON\.stringify\(channelCredential\)\}\)/.test(runtimeSrc),
  'LexiWebRuntime.dispatch 必须铸造 credential(dc 前缀,method+payload 绑定)并把第 3 实参传给 __receive');
// R8b:核销口单次有效 + 双绑定 + fail-closed 审计码。
ok('R8b admitDispatch 单次核销 + method/payload 绑定 + fail-closed 码',
  /admitDispatch\(credential: string, method: string, payloadJson: string\): boolean/.test(runtimeSrc) &&
  /channelCredentials\.delete\(/.test(runtimeSrc) &&
  /ERROR_DISPATCH_CHANNEL_UNTRUSTED/.test(runtimeSrc),
  'admitDispatch 必须先烧毁再核对(重放 fail-closed),绑定不符落 dispatch_channel_untrusted');
// R8c(P1-005):端口链两个调用点只传端口解析身份,不再出现任何凭据表达式。
const portFrameBody = (runtimeSrc.match(/handleContextPortFrame\(data: string\): void \{[\s\S]*?\n  \}/) || [''])[0];
const sandboxProxyBody = (runtimeSrc.match(/handleSandboxProxyCall\(frameJson: string\): void \{[\s\S]*?\n  \}/) || [''])[0];
ok('R8c 端口链调用点凭据清零(callFromPort,身份纯端口化)',
  portFrameBody.indexOf('callFromPort(') >= 0 && sandboxProxyBody.indexOf('callFromPort(') >= 0 &&
  portFrameBody.indexOf('tokenForPlugin(') < 0 && sandboxProxyBody.indexOf('tokenForPlugin(') < 0 &&
  portFrameBody.indexOf('runtime.call(') < 0 && sandboxProxyBody.indexOf('runtime.call(') < 0,
  'handleContextPortFrame/handleSandboxProxyCall 必须只传 contextRegistry 反查身份,凭据在宿主内部补铸');
// R8d:callFromPort 身份缺失 fail-closed(与页面凭据路径同码)。
const callFromPortBody = (runtimeSrc.match(/async callFromPort\([\s\S]*?\n  \}/) || [''])[0];
ok('R8d callFromPort 空身份 fail-closed', callFromPortBody.indexOf('ERROR_IDENTITY_UNTRUSTED') >= 0 &&
  callFromPortBody.indexOf('identity.port') >= 0,
  '端口身份缺失必须 fail-closed(identity_untrusted),不得回落会话/匿名继续走');
// R8e:shim __receive 门卫 —— 回调执行前必须核销成功;通道凭据不得落任何可读面。
const shimCodeBody = shimSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok('R8e __receive 门卫先核销后执行,凭据不落可读面',
  /window\.lexiHost\.admitDispatch\(channelCredential, method, payloadJson\) === true/.test(shimCodeBody) &&
  /dispatch\.admit denied/.test(shimCodeBody) &&
  !/\bchannelCredential\s*=[^=]/.test(shimCodeBody),
  '__receive 必须先经 admitDispatch 核销(失败即 return),通道凭据不得赋值存任何变量/属性');
// R8f:setSessionToken 作用域写一次定死(跨上下文异值后写拒绝)。
ok('R8f setSessionToken 作用域守卫(写一次定死)', /sessionTokenBound/.test(shimCodeBody) &&
  /session\.token write-denied/.test(shimCodeBody),
  '绑定后的异值后写(同 realm 插件乱写/清空)必须 fail-closed 拒绝,P1-006b②');

// R8g/R8h 行为级:vm 求值真实 shim,宿主桩带铸造+核销对(与 .ets 协议面同语义)。
(async () => {
  const tick = () => new Promise((r) => setImmediate(r));
  const until = async (cond, label) => {
    for (let i = 0; i < 500; i++) { await tick(); if (cond()) { return; } }
    throw new Error('等待超时: ' + label);
  };
  const domElement = () => ({ style: {}, textContent: '', setAttribute() {}, appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn) => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    Promise, JSON, Math, Date, Map, Set, WeakMap,
    location: { href: 'https://lexinote.local/runtime' }
  };
  const domBase = {
    createElement: domElement, createTextNode: (text) => ({ text }), createDocumentFragment: () => ({ appendChild() {} }),
    head: { appendChild() {} }, body: domElement(), documentElement: domElement(),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}
  };
  sandbox.document = new Proxy(domBase, { get(target, key) { return (key in target) ? target[key] : () => null; } });
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__sec7Runs = 0;
  const channel = createDispatchChannel();
  const hostCalls = [];
  sandbox.window.lexiHost = {
    call(callId, method, payloadJson, token) {
      hostCalls.push({ method, token: typeof token === 'string' ? token : '' });
      return Promise.resolve(JSON.stringify({ ok: true, result: method === 'events.on' ? 1 : null }));
    },
    admitDispatch(credential, method, payloadJson) { return channel.admitDispatch(credential, method, payloadJson); }
  };
  try {
    vm.createContext(sandbox);
    vm.runInContext(shimSrc, sandbox, { filename: 'lexinote_plugin_shim.js' });
    const runtime = sandbox.window.lexiRuntime;
    ok('R8g.0 vm 求值后 lexiRuntime 在场', !!runtime, 'shim 求值失败');
    if (runtime) {
      const probe = "module.exports = class extends require('obsidian').Plugin {" +
        " async onload(){ this.addCommand({ id:'sec7', name:'sec7', callback: () => { __sec7Runs += 1; } }); } };";
      const loadFrame = JSON.stringify({ manifest: { id: 'sec7-probe' }, code: probe });
      runtime.__receive('load.plugin', loadFrame, channel.mint('load.plugin', loadFrame));
      await until(() => hostCalls.some((c) => c.method === 'commands.add'), 'commands.add');
      const cmdFrame = JSON.stringify({ fullId: 'sec7-probe:sec7' });
      // SEC-007 负例族①:同 realm 插件裸调 __receive(无凭据)触发他插件命令回调 —— 必须拒。
      runtime.__receive('invoke.command', cmdFrame);
      await tick(); await tick();
      ok('R8g.1 裸调 __receive(无凭据)不执行任何命令回调', sandbox.__sec7Runs === 0,
        'runs=' + sandbox.__sec7Runs + '(ADR-R10-01 残余风险①的历史攻击面)');
      // SEC-007 负例族②:非宿主铸造的伪凭据 —— 必须拒。
      runtime.__receive('invoke.command', cmdFrame, 'dc-forged-not-host-minted');
      await tick(); await tick();
      ok('R8g.2 伪凭据 fail-closed', sandbox.__sec7Runs === 0, 'runs=' + sandbox.__sec7Runs);
      // 正例:宿主铸造的一次性凭据走通一次。
      const legit = channel.mint('invoke.command', cmdFrame);
      runtime.__receive('invoke.command', cmdFrame, legit);
      await until(() => sandbox.__sec7Runs === 1, '合法派发执行');
      // SEC-007 负例族③:重放(单次有效,核销即烧毁)—— 必须拒。
      runtime.__receive('invoke.command', cmdFrame, legit);
      await tick(); await tick();
      ok('R8g.3 已核销凭据重放 fail-closed(单次有效)', sandbox.__sec7Runs === 1, 'runs=' + sandbox.__sec7Runs);
      // SEC-007 负例族④:换方法盗用(绑定不符)—— 必须拒且即烧毁。
      const eventFrame = JSON.stringify({ topic: 'vault', name: 'x', payload: null });
      const misbound = channel.mint('event', eventFrame);
      runtime.__receive('invoke.command', cmdFrame, misbound);
      await tick(); await tick();
      ok('R8g.4 换方法盗用凭据 fail-closed(绑定不符)', sandbox.__sec7Runs === 1, 'runs=' + sandbox.__sec7Runs);
      runtime.__receive('event', eventFrame, misbound);
      await tick(); await tick();
      ok('R8g.5 盗用即烧毁:回正确方法也不得再通过', sandbox.__sec7Runs === 1, 'runs=' + sandbox.__sec7Runs);
    }
  } catch (error) {
    ok('R8g dispatch 通道行为级负例', false, 'threw: ' + error.message);
  }
  // R8h:setSessionToken 作用域(P1-006b②)行为级 —— 与 shim-regression 同断言,双门禁钉死。
  try {
    const surface = sandbox.window.LexiObsidian || sandbox.LexiObsidian;
    ok('R8h.1 首次注入放行', !!surface && surface.setSessionToken('st-unit-abcdef12') === true, '容器引导链是首个写入者');
    ok('R8h.2 绑定后异值后写拒绝(DoS 会话的面关闭)',
      !!surface && surface.setSessionToken('st-evil-000000') === false, '跨上下文写入必须 fail-closed');
    ok('R8h.3 拒绝后原会话凭据保持(尾部 6 位对账)',
      !!surface && surface.stats().sessionTokenTail === 'cdef12',
      'got=' + (surface ? surface.stats().sessionTokenTail : '(no surface)'));
    ok('R8h.4 同值幂等重放放行', !!surface && surface.setSessionToken('st-unit-abcdef12') === true,
      '容器引导链重复 adopt 不受伤');
  } catch (error) {
    ok('R8h setSessionToken 作用域行为级', false, 'threw: ' + error.message);
  }

  // ---------------------------------------------------------------- 汇总
  console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
  for (const f of failures) { console.log('  ✗ ' + f); }
  console.log(failures.length === 0
    ? 'plugin-bridge-security: PASS'
    : 'plugin-bridge-security: FAIL (' + failures.length + ')');
  process.exit(failures.length === 0 ? 0 : 1);
})();
