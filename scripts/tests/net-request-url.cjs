#!/usr/bin/env node
/*
 * 离线门禁：net.requestUrl 端到端身份化。
 *
 * 哪一层是假的（唯一）：LexiNetTransport.send —— 只桩网络 IO 的那一层。
 * 真的跑：真实 LexiNetProbe.executeNetRequest、真实 checkNetworkCapability/parsePluginManifest、
 *        真实插件 shim（vm 求值 rawfile/lexinote_plugin_shim.js）、真实视图 shim、真令牌反查。
 * 宿主 ArkTS 侧无法在 Node 里求值（@kit.* import），所以 RpcResponse 序列化那两行在下面被镜像，
 * 并用源码锚点断言钉住宿主真的这样写（段落 ④）。镜像 ≠ 证明，报告里单独列出。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const PLUGIN_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin');
const RAWFILE = path.join(ROOT, 'entry/src/main/resources/rawfile');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
async function step(name, work) {
  console.log('· ' + name);
  try { await work(); } catch (error) { failures.push(name + ' — threw: ' + (error && error.message)); }
}

// --------------------------------------------------------------- 真模块装载

function stageProbeModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexinote-net-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.copyFileSync(path.join(PLUGIN_ETS, 'LexiPluginManifest.ets'), path.join(dir, 'LexiPluginManifest.ts'));
  // T2.1 起 manifest 严格路径依赖 LexiPluginManifestV2(零依赖),staging 一并携带
  fs.copyFileSync(path.join(PLUGIN_ETS, 'LexiPluginManifestV2.ets'), path.join(dir, 'LexiPluginManifestV2.ts'));
  const manifestStaged = fs.readFileSync(path.join(dir, 'LexiPluginManifest.ts'), 'utf8')
    .replace(/from '\.\/LexiPluginManifestV2'/g, "from './LexiPluginManifestV2.ts'");
  fs.writeFileSync(path.join(dir, 'LexiPluginManifest.ts'), manifestStaged);
  const probe = fs.readFileSync(path.join(PLUGIN_ETS, 'LexiNetProbe.ets'), 'utf8')
    .replace(/from '\.\/LexiPluginManifest'/g, "from './LexiPluginManifest.ts'");
  fs.writeFileSync(path.join(dir, 'LexiNetProbe.ts'), probe);
  return dir;
}

function manifest(json) {
  return manifestMod.parsePluginManifest(JSON.stringify(Object.assign({
    id: 'plug-a', name: 'A', version: '1.0.0', author: 't'
  }, json)));
}

function makeTransport(responder) {
  const calls = [];
  return {
    calls,
    send(method, url, headers, body, timeoutMs) {
      calls.push({ method, url, headers, body, timeoutMs });
      return responder(method, url, headers, body, timeoutMs);
    }
  };
}

function makeLog() {
  return { info: [], error: [] };
}

// owners: Map<token, pluginId>；manifests: Map<pluginId, manifest|null>
function makeDeps(owners, manifests, transport, log, timeoutMs) {
  return new probeMod.LexiNetDeps(
    (token) => owners.get(token) || '',
    (pluginId) => (manifests.has(pluginId) ? manifests.get(pluginId) : null),
    transport,
    (message) => log.info.push(message),
    (message) => log.error.push(message),
    timeoutMs === undefined ? 15000 : timeoutMs
  );
}

function outcomeOf(result) {
  return JSON.stringify(result);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition, label) {
  for (let i = 0; i < 500; i++) { await tick(); if (condition()) { return; } }
  throw new Error('等待超时: ' + label);
}

// 宿主净室的镜像：handler 拿 (payloadJson, identity, token)，成功后包成 RpcResponse。
// identity 与宿主 call() 同口径：令牌命中就换成归属 pluginId，否则空串(fail-closed)。
function makeHostBridge(owners, manifests, transport, log) {
  const calls = [];
  const bridge = {
    calls,
    call(callId, method, payloadJson, token) {
      const rawToken = typeof token === 'string' ? token : '';
      calls.push({ method, token: rawToken, identity: owners.get(rawToken) || '' });
      if (method !== 'net.requestUrl') { return Promise.resolve(JSON.stringify({ ok: true, result: null })); }
      const identity = owners.get(rawToken) || '';
      return probeMod.executeNetRequest(payloadJson, identity, rawToken, makeDeps(owners, manifests, transport, log))
        .then((outcome) => (outcome.ok
          ? JSON.stringify({ ok: true, result: { status: outcome.status, headers: outcome.headers, text: outcome.text } })
          : JSON.stringify({ ok: false, error: outcome.error, code: outcome.code })));
    }
  };
  return bridge;
}

let probeMod;
let manifestMod;

async function main() {
  const staged = stageProbeModules();
  probeMod = await import(pathToFileURL(path.join(staged, 'LexiNetProbe.ts')).href);
  manifestMod = await import(pathToFileURL(path.join(staged, 'LexiPluginManifest.ts')).href);

  console.log('== ① 真实管线 executeNetRequest（假传输 = 唯一假层）==');

  const declared = manifest({ capabilities: { network: ['api.example.com'] } });
  const otherHost = manifest({ capabilities: { network: ['other.example.com'] } });
  const undeclared = manifest({});

  await step('未声明 capabilities（v1 清单）→ capability_denied，且一次都没发', async () => {
    const transport = makeTransport(() => Promise.resolve(new probeMod.LexiNetResponse(200, {}, 'x')));
    const log = makeLog();
    const deps = makeDeps(new Map([['tk-a', 'plug-a']]), new Map([['plug-a', undeclared]]), transport, log);
    const outcome = await probeMod.executeNetRequest(JSON.stringify({ url: 'https://api.example.com/x' }), 'plug-a', 'tk-a', deps);
    ok('1.1 未声明 → ok=false', outcome.ok === false);
    ok('1.2 未声明 → code=capability_denied', outcome.code === 'capability_denied', String(outcome.code));
    ok('1.3 未声明 → 传输 0 次（不留半发）', transport.calls.length === 0, String(transport.calls.length));
    ok('1.4 未声明 → 落拒绝日志能力锚点', log.error.some((m) => m.indexOf('capability.net') >= 0 && m.indexOf('allowed=false') >= 0) === true);
  });

  await step('host 不在声明列表 → capability_denied（点名 host）', async () => {
    const transport = makeTransport(() => Promise.resolve(new probeMod.LexiNetResponse(200, {}, 'x')));
    const log = makeLog();
    const deps = makeDeps(new Map([['tk-a', 'plug-a']]), new Map([['plug-a', otherHost]]), transport, log);
    const outcome = await probeMod.executeNetRequest(JSON.stringify({ url: 'https://api.example.com/x' }), 'plug-a', 'tk-a', deps);
    ok('2.1 → capability_denied', outcome.code === 'capability_denied');
    ok('2.2 错误文案点名未声明 host', String(outcome.error).indexOf('api.example.com') >= 0, String(outcome.error));
    ok('2.3 传输 0 次', transport.calls.length === 0);
  });

  await step('未安装插件（manifest=null）→ capability_denied', async () => {
    const transport = makeTransport(() => Promise.resolve(new probeMod.LexiNetResponse(200, {}, 'x')));
    const log = makeLog();
    const deps = makeDeps(new Map([['tk-ghost', 'ghost']]), new Map(), transport, log);
    const outcome = await probeMod.executeNetRequest(JSON.stringify({ url: 'https://api.example.com/x' }), 'ghost', 'tk-ghost', deps);
    ok('3.1 → capability_denied', outcome.code === 'capability_denied');
    ok('3.2 传输 0 次', transport.calls.length === 0);
  });

  await step('无 token → identity_untrusted，且传输 0 次', async () => {
    const transport = makeTransport(() => Promise.resolve(new probeMod.LexiNetResponse(200, {}, 'x')));
    const log = makeLog();
    const deps = makeDeps(new Map([['tk-a', 'plug-a']]), new Map([['plug-a', declared]]), transport, log);
    const outcome = await probeMod.executeNetRequest(JSON.stringify({ url: 'https://api.example.com/x' }), 'plug-a', '', deps);
    ok('4.1 无 token → ok=false', outcome.ok === false);
    ok('4.2 无 token → code=identity_untrusted', outcome.code === 'identity_untrusted', String(outcome.code));
    ok('4.3 无 token → 传输 0 次', transport.calls.length === 0);
    ok('4.4 无 token → 落身份日志（fail_closed=true）', log.error.some((m) => m.indexOf('identity.net') >= 0 && m.indexOf('fail_closed=true') >= 0) === true);
  });

  await step('token 属于别的插件 → identity_untrusted（令牌归属必须与身份一致）', async () => {
    const transport = makeTransport(() => Promise.resolve(new probeMod.LexiNetResponse(200, {}, 'x')));
    const log = makeLog();
    const owners = new Map([['tk-b', 'plug-b'], ['tk-a', 'plug-a']]);
    const deps = makeDeps(owners, new Map([['plug-a', declared], ['plug-b', declared]]), transport, log);
    const outcome = await probeMod.executeNetRequest(JSON.stringify({ url: 'https://api.example.com/x' }), 'plug-a', 'tk-b', deps);
    ok('5.1 令牌错配 → code=identity_untrusted', outcome.code === 'identity_untrusted');
    ok('5.2 日志点名真实归属插件', log.error.some((m) => m.indexOf('owner=plug-b') >= 0) === true);
    ok('5.3 传输 0 次', transport.calls.length === 0);
  });

  await step('非 http(s) 目标 → capability_denied（传输 0 次）', async () => {
    const transport = makeTransport(() => Promise.resolve(new probeMod.LexiNetResponse(200, {}, 'x')));
    const deps = makeDeps(new Map([['tk-a', 'plug-a']]), new Map([['plug-a', declared]]), transport, makeLog());
    const outcome = await probeMod.executeNetRequest(JSON.stringify({ url: 'file:///etc/passwd' }), 'plug-a', 'tk-a', deps);
    ok('6.1 → capability_denied', outcome.code === 'capability_denied');
    ok('6.2 传输 0 次', transport.calls.length === 0);
  });

  await step('声明 + 令牌正确 → GET 真发出并回包', async () => {
    const transport = makeTransport((method, url) => Promise.resolve(
      new probeMod.LexiNetResponse(200, { 'content-type': 'application/json' }, '{"hello":"world"}')
    ));
    const log = makeLog();
    const deps = makeDeps(new Map([['tk-a', 'plug-a']]), new Map([['plug-a', declared]]), transport, log);
    const outcome = await probeMod.executeNetRequest(JSON.stringify({ url: 'https://api.example.com/x' }), 'plug-a', 'tk-a', deps);
    ok('7.1 放行 → ok=true', outcome.ok === true, String(outcome.error));
    ok('7.2 传输恰好 1 次', transport.calls.length === 1, String(transport.calls.length));
    ok('7.3 method=GET', transport.calls[0].method === 'GET');
    ok('7.4 url 原样透传', transport.calls[0].url === 'https://api.example.com/x');
    ok('7.5 timeout 来自 NET_TIMEOUT_MS=15000', transport.calls[0].timeoutMs === probeMod.NET_TIMEOUT_MS && probeMod.NET_TIMEOUT_MS === 15000);
    ok('7.6 回包 status/headers/text 完整', outcome.status === 200 && outcome.headers['content-type'] === 'application/json' && outcome.text === '{"hello":"world"}');
    ok('7.7 放行日志能力锚点', log.info.some((m) => m.indexOf('capability.net') >= 0 && m.indexOf('allowed=true') >= 0 && m.indexOf('host=api.example.com') >= 0) === true);
    ok('7.8 放行日志请求锚点带 status', log.info.some((m) => m.indexOf('net.requestUrl') >= 0 && m.indexOf('ok=true') >= 0 && m.indexOf('status=200') >= 0) === true);
  });

  await step('声明 + 令牌正确 → POST body/headers 透传', async () => {
    const transport = makeTransport(() => Promise.resolve(new probeMod.LexiNetResponse(201, {}, 'created')));
    const deps = makeDeps(new Map([['tk-a', 'plug-a']]), new Map([['plug-a', declared]]), transport, makeLog());
    const outcome = await probeMod.executeNetRequest(JSON.stringify({
      url: 'https://api.example.com/x', method: 'POST',
      headers: { 'x-token': 'v1', 'content-type': 'application/json' }, body: '{"n":1}'
    }), 'plug-a', 'tk-a', deps);
    ok('8.1 POST → ok=true status=201', outcome.ok === true && outcome.status === 201, String(outcome.error));
    ok('8.2 method=POST 透传', transport.calls[0].method === 'POST');
    ok('8.3 headers 透传', transport.calls[0].headers['x-token'] === 'v1' && transport.calls[0].headers['content-type'] === 'application/json');
    ok('8.4 body 透传', transport.calls[0].body === '{"n":1}');
  });

  await step('非 2xx 原样回传（不吞状态码、不当异常）', async () => {
    const transport = makeTransport(() => Promise.resolve(
      new probeMod.LexiNetResponse(503, { 'retry-after': '5' }, 'busy')
    ));
    const log = makeLog();
    const deps = makeDeps(new Map([['tk-a', 'plug-a']]), new Map([['plug-a', declared]]), transport, log);
    const outcome = await probeMod.executeNetRequest(JSON.stringify({ url: 'https://api.example.com/x' }), 'plug-a', 'tk-a', deps);
    ok('9.1 503 → ok=true（HTTP 层错误不算通道失败）', outcome.ok === true);
    ok('9.2 status=503 原样', outcome.status === 503);
    ok('9.3 body 原样', outcome.text === 'busy');
    ok('9.4 响应头原样', outcome.headers['retry-after'] === '5');
  });

  await step('超时 → net_timeout（且传输确实被调用过 1 次）', async () => {
    const transport = makeTransport(() => new Promise(() => {}));
    const log = makeLog();
    const deps = makeDeps(new Map([['tk-a', 'plug-a']]), new Map([['plug-a', declared]]), transport, log, 40);
    const outcome = await probeMod.executeNetRequest(JSON.stringify({ url: 'https://api.example.com/x' }), 'plug-a', 'tk-a', deps);
    ok('10.1 超时 → ok=false', outcome.ok === false);
    ok('10.2 超时 → code=net_timeout', outcome.code === 'net_timeout', String(outcome.code) + '/' + String(outcome.error));
    ok('10.3 超时 → 传输 1 次', transport.calls.length === 1);
    ok('10.4 超时 → 落失败日志', log.error.some((m) => m.indexOf('code=net_timeout') >= 0) === true);
  });

  await step('传输异常 → net_transport_failed（与超时可区分）', async () => {
    const transport = makeTransport(() => Promise.reject(new Error('ECONNREFUSED')));
    const log = makeLog();
    const deps = makeDeps(new Map([['tk-a', 'plug-a']]), new Map([['plug-a', declared]]), transport, log);
    const outcome = await probeMod.executeNetRequest(JSON.stringify({ url: 'https://api.example.com/x' }), 'plug-a', 'tk-a', deps);
    ok('11.1 → code=net_transport_failed', outcome.code === 'net_transport_failed', String(outcome.code));
    ok('11.2 日志带原始异常文本', log.error.some((m) => m.indexOf('ECONNREFUSED') >= 0) === true);
  });

  await step('payload 不是 JSON / 缺 url → invalid_request（传输 0 次）', async () => {
    const transport = makeTransport(() => Promise.resolve(new probeMod.LexiNetResponse(200, {}, 'x')));
    const deps = makeDeps(new Map([['tk-a', 'plug-a']]), new Map([['plug-a', declared]]), transport, makeLog());
    const bad = await probeMod.executeNetRequest('{not json', 'plug-a', 'tk-a', deps);
    const empty = await probeMod.executeNetRequest(JSON.stringify({ method: 'GET' }), 'plug-a', 'tk-a', deps);
    ok('12.1 坏 JSON → invalid_request', bad.code === 'invalid_request', String(bad.code));
    ok('12.2 缺 url → invalid_request', empty.code === 'invalid_request', String(empty.code));
    ok('12.3 传输 0 次', transport.calls.length === 0);
  });

  // ------------------------------------------------------------ ② 真实插件 shim

  console.log('== ② 真实插件 shim（rawfile/lexinote_plugin_shim.js，vm 求值）==');
  const shimSource = fs.readFileSync(path.join(RAWFILE, 'lexinote_plugin_shim.js'), 'utf8');
  const domElement = () => ({ style: {}, textContent: '', setAttribute() {}, appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
  // 只桩 DOM：未知查询一律返回 null，net 路径不经过任何 DOM 分支。
  const domBase = {
    createElement: domElement, createTextNode: (text) => ({ text }), createDocumentFragment: () => ({ appendChild() {} }),
    head: { appendChild() {} }, body: domElement(), documentElement: domElement(),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}
  };
  global.document = new Proxy(domBase, {
    get(target, key) { return (key in target) ? target[key] : () => null; }
  });
  global.window = global;
  vm.runInThisContext(shimSource, { filename: 'lexinote_plugin_shim.js' });
  const shimRuntime = global.window.lexiRuntime;
  ok('13.1 shim 注册了 window.lexiRuntime', !!shimRuntime);

  const shimOwners = new Map([['tk-plugin', 'net-probe'], ['tk-other', 'plug-b']]);
  const shimManifests = new Map([['net-probe', declared], ['plug-b', declared]]);
  const shimTransport = makeTransport(() => Promise.resolve(new probeMod.LexiNetResponse(200, {}, '{"from":"shim"}')));
  const shimLog = makeLog();
  const shimBridge = makeHostBridge(shimOwners, shimManifests, shimTransport, shimLog);
  global.window.lexiHost = shimBridge;

  const shimResult = { value: null, error: null };
  async function loadAndCall(token) {
    shimResult.value = null; shimResult.error = null;
    const pluginId = token === 'tk-other' ? 'net-probe' : 'net-probe';
    const code = "module.exports = class extends require('obsidian').Plugin {" +
      " async onload() { const { requestUrl } = require('obsidian');" +
      " try { var value = await requestUrl({ url: 'https://api.example.com/shim' });" +
      " if (value && value.arrayBuffer) { value.arrayBuffer.catch(function () {}); }" +
      " global.__netCapture({ ok: true, value: value }); }" +
      " catch (error) { global.__netCapture({ ok: false, message: String(error && error.message), code: String(error && error.code) }); } } };";
    global.__netCapture = (payload) => { shimResult.value = payload; };
    const message = { manifest: JSON.parse(JSON.stringify({ id: 'net-probe', name: 'n', version: '1.0.0', author: 't', capabilities: { network: ['api.example.com'] } })), code: code };
    if (token !== undefined) { message.token = token; }
    shimRuntime.__receive('load.plugin', JSON.stringify(message));
    await until(() => shimResult.value !== null, 'shim net.requestUrl');
    await shimRuntime.__receive('unload.plugin', JSON.stringify({ id: 'net-probe' }));
    return pluginId;
  }

  await step('插件加载时拿到令牌 → require("obsidian").requestUrl 带令牌发出并回包', async () => {
    const before = shimTransport.calls.length;
    const hostBefore = shimBridge.calls.filter((c) => c.method === 'net.requestUrl').length;
    await loadAndCall('tk-plugin');
    const hostCalls = shimBridge.calls.filter((c) => c.method === 'net.requestUrl');
    ok('14.1 shim 侧请求成功', shimResult.value && shimResult.value.ok === true, JSON.stringify(shimResult.value));
    ok('14.2 宿主收到 1 次 net.requestUrl', hostCalls.length - hostBefore === 1, String(hostCalls.length - hostBefore));
    ok('14.3 第 4 个实参 = 装载下发的插件令牌', hostCalls[hostCalls.length - 1].token === 'tk-plugin', hostCalls[hostCalls.length - 1].token);
    ok('14.4 身份由令牌反查（不是插件自报）', hostCalls[hostCalls.length - 1].identity === 'net-probe');
    ok('14.5 假传输被真实调用 1 次', shimTransport.calls.length - before === 1);
    ok('14.6 回包 text 到插件侧', shimResult.value && shimResult.value.value && shimResult.value.value.text === '{"from":"shim"}', JSON.stringify(shimResult.value && shimResult.value.value));
  });

  await step('插件没拿到令牌 → requestUrl 被拒（identity_untrusted），传输 0 次', async () => {
    const before = shimTransport.calls.length;
    await loadAndCall(undefined);
    ok('15.1 插件侧看到失败', shimResult.value && shimResult.value.ok === false, JSON.stringify(shimResult.value));
    ok('15.2 失败码=identity_untrusted', shimResult.value && shimResult.value.code === 'identity_untrusted', String(shimResult.value && shimResult.value.code));
    ok('15.3 传输 0 次', shimTransport.calls.length === before);
  });

  // ------------------------------------------------------------ ③ 真实视图 shim

  console.log('== ③ 真实视图 shim（rawfile/lexinote_plugin_view_shim.js，独立 vm 上下文）==');
  const viewSource = fs.readFileSync(path.join(RAWFILE, 'lexinote_plugin_view_shim.js'), 'utf8');

  function bootViewShim(payload) {
    const sandbox = { console: { warn() {}, log() {} } };
    sandbox.window = sandbox;
    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = clearTimeout;
    sandbox.setInterval = () => 0;
    sandbox.clearInterval = () => {};
    const element = () => ({ style: {}, textContent: '', setAttribute() {}, appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
    sandbox.document = {
      createElement: element, createTextNode: (text) => ({ text }), createDocumentFragment: () => ({ appendChild() {} }),
      head: { appendChild() {} }, body: element(),
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {}
    };
    const owners = new Map([['tk-view', 'plug-view']]);
    const manifests = new Map([['plug-view', declared]]);
    const transport = makeTransport(() => Promise.resolve(new probeMod.LexiNetResponse(200, {}, '{"from":"view"}')));
    const log = makeLog();
    sandbox.window.lexiHost = makeHostBridge(owners, manifests, transport, log);
    vm.createContext(sandbox);
    vm.runInContext(viewSource, sandbox, { filename: 'lexinote_plugin_view_shim.js' });
    sandbox.window.lexinoteView.boot(JSON.stringify(payload));
    return { sandbox, transport, log };
  }

  await step('boot 下发令牌 → window.LexiObsidian.requestUrl 带令牌发出', async () => {
    const env = bootViewShim({ pluginId: 'plug-view', token: 'tk-view' });
    ok('16.1 视图命名空间已发布（此前定义了却从未挂到 window）', !!(env.sandbox.window.LexiObsidian && env.sandbox.window.LexiObsidian.requestUrl));
    const response = await env.sandbox.window.LexiObsidian.requestUrl({ url: 'https://api.example.com/view' });
    // arrayBuffer 是恒 reject 的占位 promise（契约里写明的 partial）；这里只是防止它变成未处理拒绝。
    response.arrayBuffer.catch(() => {});
    ok('16.2 回包 status=200', response.status === 200, JSON.stringify(response));
    ok('16.3 回包 json 已解析', response.json && response.json.from === 'view');
    ok('16.4 传输 1 次', env.transport.calls.length === 1);
    ok('16.5 令牌确实被带到宿主（第 4 实参）', env.sandbox.window.lexiHost.calls.some((c) => c.method === 'net.requestUrl' && c.token === 'tk-view') === true);
    ok('16.6 身份=令牌归属插件', env.sandbox.window.lexiHost.calls.filter((c) => c.method === 'net.requestUrl')[0].identity === 'plug-view');
  });

  await step('boot 没带令牌 → 视图侧 requestUrl 被拒（identity_untrusted），传输 0 次', async () => {
    const env = bootViewShim({ pluginId: 'plug-view' });
    let message = '';
    let code = '';
    try { await env.sandbox.window.LexiObsidian.requestUrl({ url: 'https://api.example.com/view' }); } catch (error) { message = String(error && error.message); code = String(error && error.code); }
    ok('17.1 视图侧请求被拒', message.length > 0, '未抛错');
    ok('17.2 失败码=identity_untrusted', code === 'identity_untrusted', code || message);
    ok('17.3 传输 0 次', env.transport.calls.length === 0);
  });

  // ------------------------------------------------------------ ④ 宿主源码锚点

  console.log('== ④ 宿主源码锚点（ArkTS 无法在 Node 求值，改用结构钉死）==');
  const runtimeSource = fs.readFileSync(path.join(PLUGIN_ETS, 'LexiPluginRuntime.ets'), 'utf8');
  const probeSource = fs.readFileSync(path.join(PLUGIN_ETS, 'LexiNetProbe.ets'), 'utf8');

  await step('宿主真的把令牌交给 net 处理器，并真的走同一段管线', async () => {
    ok('18.1 call() 把原始令牌作为第 4 实参传给 handler',
      /handler\(stripClaimedIdentity\(payloadJson, trusted, method\), trusted, credential\)/.test(runtimeSource));
    ok('18.2 registerHandler 签名带 token 形参',
      /registerHandler\(method: string,\s*handler: \(payloadJson: string, identity: string, token: string\) => Promise<string>\): void/.test(runtimeSource));
    ok('18.3 net 处理器把 token 传下去',
      /registerHandler\('net\.requestUrl'[\s\S]{0,220}?performRequest\(payload, identity, token\)/.test(runtimeSource));
    ok('18.4 performRequest 真调用 executeNetRequest',
      /executeNetRequest\(payloadJson, identity, token,/.test(runtimeSource),
      '宿主必须走 probe 管线（而不是自己另写一份判定）');
    ok('18.5 deps 的身份反查来自运行时令牌表',
      /pluginIdForToken\(/.test(runtimeSource) && /new LexiNetDeps\(/.test(runtimeSource));
    ok('18.6 真实网络边界单独成类（唯一接触 @kit.NetworkKit 的 net 实现）',
      /class LexiHttpTransport implements LexiNetTransport/.test(runtimeSource));
    ok('18.7 视图 boot payload 下发令牌',
      /'token': this\.runtime\.tokenForPlugin\(pluginId\) as Object/.test(runtimeSource));
    ok('18.8 判定入口真的调 checkNetworkCapability', /checkNetworkCapability\(deps\.manifestFor\(identity\), url\)/.test(probeSource));
    const execBody = probeSource.slice(probeSource.indexOf('export async function executeNetRequest'));
    ok('18.9 拒绝先判断后发送（判定与 deny 分支都在 sendWithTimeout 之前）',
      execBody.indexOf('checkNetworkCapability(') < execBody.indexOf('sendWithTimeout(') &&
      execBody.indexOf('if (!decision.allowed)') < execBody.indexOf('sendWithTimeout('));
  });

  await step('页面 shim 只剩一个 net.requestUrl 站点，且第三参就是插件令牌', async () => {
    const sites = shimSource.match(/hostCall\('net\.requestUrl'/g) || [];
    ok('19.1 站点数 = 1', sites.length === 1, String(sites.length));
    ok('19.2 第三参是 pluginToken 闭包变量', /hostCall\('net\.requestUrl', \{[\s\S]{0,220}?\}, pluginToken\)/.test(shimSource));
    ok('19.3 装载时按插件令牌构造 require 出口', /boundNamespace\.requestUrl = requestUrlFor\(pluginToken\)/.test(shimSource));
    ok('19.4 视图 shim 第三参是 viewToken', /hostCall\('net\.requestUrl', \{[\s\S]{0,220}?\}, viewToken\)/.test(viewSource));
    ok('19.5 视图 shim boot 落令牌', /payload\.token === 'string'\) \{ viewToken = payload\.token/.test(viewSource));
  });

  console.log('');
  const total = passed + failures.length;
  if (failures.length) {
    console.log('net-request-url: FAIL (' + failures.length + '/' + total + ' 条断言未通过)');
    for (const item of failures) { console.log('  · ' + item); }
    process.exit(1);
  }
  console.log('net-request-url: PASS (' + passed + ' 条断言，覆盖 未声明/无令牌/令牌错配/放行/非2xx/超时/传输异常/视图侧)');
  process.exit(0);
}

main().catch((error) => {
  console.log('net-request-url: FAIL (未捕获异常)');
  console.log(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
