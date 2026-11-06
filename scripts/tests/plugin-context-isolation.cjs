'use strict';
// RFC §14 T0.2 Sandbox PoC · 安全门禁（对应 P0-02 / P0-03 / §3.2 / §3.9）。
//
// 验收目标：恶意探针无法访问宿主对象和其他插件上下文。
// 三层证据：
//   S* 静态结构：sandbox 属性、CSP、fileAccess(false)、per-plugin MessageChannel、
//      身份不进 iframe 初始化载荷。
//   E1 vm 求值恶意探针：在模拟沙箱环境（父页面访问抛 SecurityError、fetch 被拒、
//      localStorage 抛错）里真跑探针源码 → 全部向量 blocked，报告 passed。
//   E2 探针诚实性：把同一份探针放进"漏风"环境 → 至少一个向量必须报告未阻断。
//      （防探针写死 blocked=true 的自欺。）
//
// 纯静态 + vm 求值。不连设备、不构建。真机 PoC 结论见 docs 账本。
// 用法：node scripts/tests/plugin-context-isolation.cjs

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const RAWFILE = path.join(ROOT, 'entry/src/main/resources/rawfile');
const POC_HTML = path.join(RAWFILE, 'lexinote_sandbox_poc.html');
const POC_JS = path.join(RAWFILE, 'lexinote_sandbox_poc.js');
const SANDBOX_HTML = path.join(RAWFILE, 'lexinote_plugin_sandbox.html');
const PROBE_JS = path.join(RAWFILE, 'lexinote_sandbox_probe.js');
const HOSTS = [
  path.join(ROOT, 'entry/src/main/ets/components/plugin/LexiPluginRuntimeHost.ets'),
  path.join(ROOT, 'entry/src/main/ets/components/plugin/LexiPluginViewSlot.ets'),
  path.join(ROOT, 'entry/src/main/ets/components/plugin/LexiPluginCodeBlockSlot.ets')
];

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}

// ---------------------------------------------------------------- S* 静态结构
console.log('== S* 静态结构 ==');
ok('S1 PoC 页存在', fs.existsSync(POC_HTML), '缺少 lexinote_sandbox_poc.html');
ok('S2 沙箱 iframe 页存在', fs.existsSync(SANDBOX_HTML), '缺少 lexinote_plugin_sandbox.html');
ok('S3 逃逸探针存在', fs.existsSync(PROBE_JS), '缺少 lexinote_sandbox_probe.js');

/** 提取 html 里 Content-Security-Policy meta 的 content 值（只测真实 CSP，不测注释）。 */
function cspOf(html) {
  const m = html.match(/Content-Security-Policy"\s+content="([^"]*)"/);
  return m ? m[1] : '';
}

if (fs.existsSync(POC_HTML)) {
  const pocHtml = fs.readFileSync(POC_HTML, 'utf8');
  // B-008 根因固化(2026-11-03 真机):宿主页 CSP script-src 'self' 拦杀内联脚本,
  // 引导逻辑必须外置;此前所有结构断言只扫 html,逻辑内联时恰好"全绿却静默失效"。
  ok('S20 宿主页不含内联可执行脚本(真机 B-008 根因一)', !((pocHtml.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi) || [])
    .some((tag) => tag.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim().length > 0)),
    'script-src \'self\' 下内联脚本必被 CSP 拦杀——引导逻辑必须放 lexinote_sandbox_poc.js');
  {
    const jsExists = fs.existsSync(POC_JS);
    ok('S20b 引导逻辑外置文件存在', jsExists, '缺少 lexinote_sandbox_poc.js');
    const cspForFrame = cspOf(pocHtml);
    ok('S21 宿主页 CSP 放行 iframe 文档(真机 B-008 根因二)',
      /child-src[^;]*'self'/.test(cspForFrame) || /frame-src[^;]*'self'/.test(cspForFrame),
      'default-src none 下无 child-src/frame-src 则沙箱文档根本不会被请求');
    var poc = pocHtml + (jsExists ? '\n' + fs.readFileSync(POC_JS, 'utf8') : '');
  }
  const sandboxAttrs = [...poc.matchAll(/setAttribute\(\s*'sandbox'\s*,\s*'([^']*)'\s*\)/g)].map((m) => m[1]);
  ok('S4 iframe 必须带 sandbox=allow-scripts', sandboxAttrs.length >= 1 &&
    sandboxAttrs.every((a) => a === 'allow-scripts'),
    '每个插件 iframe 必须显式 setAttribute("sandbox","allow-scripts")，实际: ' + JSON.stringify(sandboxAttrs));
  ok('S5 禁止 allow-same-origin', sandboxAttrs.every((a) => a.indexOf('allow-same-origin') < 0),
    'allow-same-origin 会让 iframe 退回父页面 origin，沙箱失效');
  ok('S6 禁止 allow-top-navigation', sandboxAttrs.every((a) => a.indexOf('allow-top-navigation') < 0),
    '沙箱 iframe 不得获得顶层导航权');
  ok('S7 per-plugin 独立 MessageChannel', /new MessageChannel\(\)/.test(poc) && /\[channel\.port2\]/.test(poc),
    '每个插件上下文必须有专属 MessageChannel 且 port2 转移进 iframe');
  ok('S8 身份不进 iframe 初始化载荷', !/pluginId|token|activationId/.test(
    (poc.match(/sandbox\.init[\s\S]{0,160}/) || [''])[0]),
    'sandbox.init 载荷只能有 __lexiSandbox/type/contextId，身份必须留在宿主侧端口表');
  const pocCsp = cspOf(poc);
  ok('S9 PoC 页 CSP 存在且禁远程', pocCsp.length > 0 && /connect-src\s+'none'/.test(pocCsp) &&
    /default-src\s+'none'/.test(pocCsp), '宿主 PoC 页必须自带严格 CSP（connect-src none）');
  ok('S10 PoC 页脚本只允许 self（宿主面禁 eval）', /script-src[^;]*'self'/.test(pocCsp) &&
    !/unsafe-eval/.test(pocCsp),
    '宿主 PoC 页不需要也不允许 eval；unsafe-eval 只属于沙箱 iframe 内部');
  ok('S11 每插件独立 iframe（至少两个上下文证明跨上下文隔离）', (poc.match(/createSandboxContext\(/g) || []).length >= 2,
    'PoC 必须建两个以上沙箱上下文才能证明"其他插件上下文不可达"');
}
if (fs.existsSync(SANDBOX_HTML)) {
  const sandbox = fs.readFileSync(SANDBOX_HTML, 'utf8');
  const sandboxCsp = cspOf(sandbox);
  ok('S12 沙箱页 CSP: 默认全禁', /default-src\s+'none'/.test(sandboxCsp), '必须 default-src none');
  ok('S13 沙箱页 CSP: connect-src none（网络全断）', /connect-src\s+'none'/.test(sandboxCsp),
    '插件 iframe 一律经宿主端口出网，页面自身不得有网络');
  ok('S14 沙箱页不含宿主全局引用', !/LexiObsidian|lexiHost\b/.test(sandbox),
    '沙箱页是全新上下文，不允许引用宿主 shim 的全局对象');
  ok('S15 沙箱页有自检函数', /__lexiSandboxSelfCheck/.test(sandbox),
    '启动自检必须存在（供设备 PoC 与本门禁共用）');
  ok('S22 沙箱→宿主端口消息必须带协议标记（真机 B-008 根因二）',
    /function postToHost[\s\S]{0,300}__lexiSandbox\s*=\s*true/.test(sandbox),
    '宿主 onSandboxMessage 按 __lexiSandbox 标记过滤,postToHost 缺赋值则 boot/request 全被静默丢弃(真机 reports=0)');
  ok('S23 沙箱请求无 port 必须回落 window 通道（真机 B-009b 复盘）',
    /function request\(method, params\) \{[\s\S]{0,120}if \(!port\) \{[\s\S]{0,400}return parentRequest\(method, params\)/.test(sandbox),
    '容器轨 init 不转移 port:回落缺失则 loadData/saveData/addCommand 静默蒸发,插件 onload 永久挂起(误诊为多 iframe 丢帧)');
  ok('S24 port 路丢弃必须留痕', /if \(!port\) \{[\s\S]{0,300}slog\('port 缺失,丢弃 /.test(sandbox),
    'port 缺失静默 return 曾把"API 面接错通道"伪装成"平台丢帧"(B-009b 误诊的直接成因)');
  ok('S25 沙箱命令表两通道共用且 window listener 可执行命令',
    /var sandboxCommands = new Map\(\);/.test(sandbox) &&
    /function runSandboxCommand\(/.test(sandbox) &&
    (sandbox.match(/runSandboxCommand\(/g) || []).length >= 3,
    '命令表若置于 bootPlugin 作用域内,port/window 两路 listener 跨作用域引用必 ReferenceError;window listener 缺 sandbox.command 分支则容器轨命令回环不工作');
  // P1-003c:宿主 runtime 页已移除 unsafe-eval(S26);沙箱 iframe 的 unsafe-eval 是按设计
  // 保留的过渡形态 —— opaque origin 沙箱才是插件求值的真实隔离边界(ADR-R18-01 定案4),
  // 注释在案,后续切片(IIFE 直载)收口。
  ok('S29 沙箱页按设计保留 unsafe-eval(P1-003c/ADR-R18-01 定案4)', /unsafe-eval/.test(sandboxCsp) &&
    /P1-003c/.test(sandbox),
    'unsafe-eval 只属于沙箱 iframe 内部;宿主页面一律不得开放(S10/S26);删沙箱保留必须连同 ADR 一起复审');
}
{
  const runtimeHtml = fs.readFileSync(path.join(RAWFILE, 'lexinote_plugin_runtime.html'), 'utf8');
  const runtimeCsp = cspOf(runtimeHtml);
  ok('S16 运行时页补 CSP', runtimeCsp.length > 0 && /connect-src\s+'none'/.test(runtimeCsp),
    'lexinote_plugin_runtime.html 此前无任何 CSP（RFC P0-03）');
  ok('S16b 运行时页 CSP 放行沙箱 iframe(真机 Round 21 教训)',
    /child-src[^;]*'self'/.test(runtimeCsp) || /frame-src[^;]*'self'/.test(runtimeCsp),
    'default-src none 下无 child-src/frame-src 则 per-plugin iframe 文档被 CSP 拦杀(P1-003b)');
  // P1-003c(ADR-R25-01):runtime 页 eval 面清零。CSP 不再放行 unsafe-eval(RFC §3.2
  // "不允许为了兼容插件而在宿主运行页面开放 unsafe-eval"),插件求值改为 shim 装载期的
  // 脚本文本注入;'unsafe-inline' 仅为放行该注入通道存在(真机授权形态见 sandbox.html
  // 内联引导,Round 9 起见证)。
  ok('S26 运行时页 CSP 移除 unsafe-eval(P1-003c/RFC §3.2)', runtimeCsp.length > 0 && !/unsafe-eval/.test(runtimeCsp),
    '宿主运行页不得为插件兼容开放 eval;eval 在此页即使被调用也会被 CSP 拒为 EvalError');
  ok('S27 运行时页不含内联可执行脚本(S20 同型)', !((runtimeHtml.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi) || [])
    .some((tag) => tag.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim().length > 0)),
    '文档本体保持零内联脚本(引导逻辑外置);动态求值只发生在 shim 装载期注入');
}
{
  // P1-003c:runtime 页脚本动态求值对账。注释剔除后扫描,防"把 eval 写进注释躲门禁"
  // (与 bridge-security R7a 同法)。shim 的 new Function 是显式登记的过渡通道(工作区页
  // P1-004 收敛前 + 离线门禁 vm),必须恰好 1 处且被 scriptInjectionAvailable 能力探测
  // 门控 —— runtime 页 CSP(S26)保证该分支在宿主页不可能生效。
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const globalEvalPattern = /(^|[^.\w$])eval\s*\(/;
  const newFunctionPattern = /\bnew\s+Function\s*\(/;
  for (const name of ['lexinote_plugin_render.js', 'lexinote_sandbox_container.js']) {
    const file = path.join(RAWFILE, name);
    if (!fs.existsSync(file)) { ok('S28 ' + name + ' 在库', false, '缺少 runtime 页脚本'); continue; }
    const body = stripComments(fs.readFileSync(file, 'utf8'));
    ok('S28 ' + name + ' 零动态求值(eval/new Function)', !globalEvalPattern.test(body) && !newFunctionPattern.test(body),
      'runtime 页脚本不得求值运行时字符串(RFC §3.2/P1-003c)');
  }
  const shimFile = path.join(RAWFILE, 'lexinote_plugin_shim.js');
  if (fs.existsSync(shimFile)) {
    const shimBody = stripComments(fs.readFileSync(shimFile, 'utf8'));
    const newFunctionSites = shimBody.match(newFunctionPattern) || [];
    ok('S28 lexinote_plugin_shim.js 全局 eval 清零', !globalEvalPattern.test(shimBody),
      'shim 不得求值运行时字符串(全局 eval 形态)');
    ok('S28 shim new Function 仅剩过渡通道(恰好 1 处且能力探测门控)', newFunctionSites.length === 1 &&
      /scriptInjectionAvailable/.test(shimBody),
      'new Function 只允许存在于 scriptInjectionAvailable=false 分支(工作区页过渡/离线门禁);' +
      'runtime 页由 S26 的 CSP 保证该分支不生效;P1-004 收敛后应删至 0');
    ok('S28b shim 注入通道在案(脚本文本求值机制)', /createElement\('script'\)/.test(shimBody) &&
      /textContent\s*=\s*scriptText/.test(shimBody) && /__lexiScriptInjectOk/.test(shimBody) &&
      /__lexiPluginRegistry/.test(shimBody) && /__lexiAcquireRequire/.test(shimBody),
      'runtime 页插件求值 = IIFE 包装 + <script> 注入(能力探测+注册表交付);缺失即退回 eval,不得删');
  }
}
{
  for (const host of HOSTS) {
    const src = fs.readFileSync(host, 'utf8');
    const name = path.basename(host);
    ok('S17 ' + name + ' fileAccess(false)', /\.fileAccess\(false\)/.test(src) && !/\.fileAccess\(true\)/.test(src),
      '不可信插件运行页面必须 fileAccess(false)（RFC §3.9）');
    ok('S18 ' + name + ' DOM Storage 关闭', !/\.domStorageAccess\(true\)/.test(src),
      '插件页面默认关闭 DOM Storage（插件数据走 data.load/save 私有存储）');
  }
}
if (fs.existsSync(PROBE_JS)) {
  const probe = fs.readFileSync(PROBE_JS, 'utf8');
  for (const vector of ['parent-dom', 'parent-globals', 'sibling-iframe', 'window-opener',
    'opaque-storage', 'network-fetch', 'network-xhr', 'remote-import', 'function-escape', 'credential-hunt']) {
    ok('S19 探针向量 ' + vector, probe.indexOf("'" + vector + "'") >= 0 || probe.indexOf('"' + vector + '"') >= 0,
      '探针缺少逃逸向量 ' + vector);
  }
}

// ---------------------------------------------------------------- E1/E2 vm 求值探针
console.log('== E* vm 求值恶意探针 ==');
function probeSource() {
  const outer = fs.readFileSync(PROBE_JS, 'utf8');
  const sb = { window: {}, console: { log: () => {} } };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(outer, sb, { filename: 'lexinote_sandbox_probe.js' });
  const source = sb.window.LEXI_SANDBOX_PROBE_SOURCE || sb.LEXI_SANDBOX_PROBE_SOURCE;
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('探针文件必须以字符串形式导出 LEXI_SANDBOX_PROBE_SOURCE');
  }
  return source;
}

/** 模拟沙箱 iframe 环境。hostile=false 时移除全部浏览器隔离（漏风环境，测探针诚实性）。 */
function makeSandboxEnv(hostile) {
  const messages = [];
  const securityError = function () { throw new Error('SecurityError: Blocked a frame with origin "null" from accessing a cross-origin frame.'); };
  const parentWindow = hostile ? { get document() { securityError(); }, get LexiObsidian() { securityError(); } }
    : { document: { title: 'HOST-DOM-LEAK' }, LexiObsidian: { apiVersion: 'leak' } };
  const env = {
    console: { log: () => {} },
    setTimeout: (fn, _ms) => { fn(); return 0; },
    clearTimeout: () => {},
    Promise: Promise,
    Math: Math,
    JSON: JSON,
    Date: Date,
    __messages: messages
  };
  env.window = env;
  env.self = env;
  // parent / top：hostile 时按浏览器行为抛 SecurityError
  env.parent = parentWindow;
  env.top = hostile ? parentWindow : parentWindow;
  Object.defineProperty(env.window, 'opener', { value: hostile ? null : parentWindow });
  // frames：沙箱里 length 可读（规范允许），但 frames[i] 的成员访问必须被隔离
  env.frames = hostile ? { length: 2 } : { length: 2, 0: parentWindow, 1: parentWindow };
  // localStorage / document.cookie：opaque origin 下访问受限
  if (hostile) {
    Object.defineProperty(env, 'localStorage', { get() { throw new Error('SecurityError: The document is sandboxed and lacks the allow-same-origin flag.'); } });
    env.document = { get cookie() { return ''; } };
    env.fetch = (_url) => Promise.reject(new TypeError("Failed to fetch: Refused to connect because 'connect-src none' violates CSP"));
    env.XMLHttpRequest = function () {
      this.open = function (_m, _u) { this.__opened = true; };
      this.send = function () { setTimeout(() => { this.onerror && this.onerror(new Error('NetworkError')); }, 0); };
    };
    // 动态 import 在沙箱 CSP 下直接失败
    env.__import = hostile ? () => Promise.reject(new TypeError('Refused to load module because it violates CSP')) : undefined;
  } else {
    env.localStorage = { getItem: () => 'host-secret' };
    env.document = { cookie: 'session=host' };
    env.fetch = (_url) => Promise.resolve({ ok: true, text: () => Promise.resolve('EXFILTRATED') });
    env.XMLHttpRequest = function () {
      this.open = function () {};
      this.send = function () { setTimeout(() => { this.onload && this.onload(); }, 0); };
    };
  }
  vm.createContext(env);
  return env;
}

async function runProbe(hostile) {
  const source = probeSource();
  const env = makeSandboxEnv(hostile);
  vm.runInContext(source, env, { filename: hostile ? 'probe@hostile-sandbox' : 'probe@leaky-env' });
  // 探针是异步的(fetch/XHR 走微任务):排空事件轮询直到报告落位或超时。
  for (let i = 0; i < 200; i++) {
    if (env.window.__lexiProbeReport || env.__lexiProbeReport) { break; }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return env.window.__lexiProbeReport || env.__lexiProbeReport;
}

(async () => {
try {
  const report = await runProbe(true);
  ok('E1a 探针在沙箱环境产出报告', !!report && Array.isArray(report.vectors), '缺少 __lexiProbeReport.vectors');
  if (report && Array.isArray(report.vectors)) {
    ok('E1b 探针向量齐备(≥10)', report.vectors.length >= 10, 'vectors=' + report.vectors.length);
    const unblocked = report.vectors.filter((v) => !v.blocked);
    ok('E1c 沙箱环境全部向量被阻断', unblocked.length === 0,
      '未被阻断: ' + unblocked.map((v) => v.id + '(' + String(v.detail).slice(0, 60) + ')').join(', '));
    ok('E1d 报告 passed 为真', report.passed === true, 'passed=' + report.passed);
    ok('E1e 报告不在 window 外留宿主凭据', report.credentialHits === 0,
      '凭据扫描命中 ' + report.credentialHits);
  }
} catch (error) {
  ok('E1a 探针在沙箱环境产出报告', false, 'threw: ' + error.message);
}
try {
  const leaky = await runProbe(false);
  const leaked = (leaky && leaky.vectors || []).filter((v) => !v.blocked);
  ok('E2 探针诚实性：漏风环境必须报出未阻断向量', leaked.length >= 3,
    '漏风环境只报出 ' + leaked.length + ' 个未阻断向量（探针可能在写死 blocked=true）');
} catch (error) {
  ok('E2 探针诚实性：漏风环境必须报出未阻断向量', false, 'threw: ' + error.message);
}
})();

// ---------------------------------------------------------------- 汇总
console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-context-isolation: PASS'
  : 'plugin-context-isolation: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
