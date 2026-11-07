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
  // R27(P1-003b 编辑器切片):沙箱 editor 执行面 = editorCallback 进共用命令表,Editor 写
  // 通道只有宿主 RPC 一条(editor.replace/selection/applyChanges,档位门禁在宿主)。
  ok('S30 沙箱 editor 面:editorCallback 进命令表且写通道走宿主 RPC',
    /editorCallback: command\.editorCallback/.test(sandbox) &&
    /function SandboxEditor\(/.test(sandbox) &&
    /'editor\.replace'/.test(sandbox) && /'editor\.selection'/.test(sandbox) &&
    /'editor\.applyChanges'/.test(sandbox),
    '编辑器命令回调必须经命令表+既有 request 链路由;缺失任一写通道即编辑器切片回退');
  ok('S30b 沙箱页不引用宿主编辑器桥(无本地 CM6 面,写只能经端口 RPC)',
    !/__lexiEditor|CodeMirror/.test(sandbox),
    'opaque origin iframe 不存在 window.__lexiEditor/CM6——Editor 必须快照读+RPC 写');
  ok('S30c 编辑器命令回推不带身份字段(身份永不进 iframe)',
    !/pluginId|activationId|token/.test(
      (sandbox.match(/type: 'sandbox\.command'[\s\S]{0,200}/) || [''])[0]) &&
    /data\.editor/.test(sandbox),
    'sandbox.command 帧只允许 fullId/editor;pluginId 等身份字段必须留在容器/宿主侧');
  // P1-003d(R28,ADR-R25-01 收口):沙箱轨 require 管线——CLI-wrapped 产物(lexi-iife:v1)
  // 经 bootPlugin 按字节原样装载,一次性 require 上下文对齐宿主 shim 纪律(取用即烧毁)。
  ok('S31 沙箱轨 require 管线在案(IIFE 直载+一次性上下文)',
    /sandboxRequireContextsById = new Map\(\)/.test(sandbox) &&
    /window\.lexiRuntime = \{/.test(sandbox) &&
    /__lexiAcquireRequire/.test(sandbox) &&
    /function isIifeWrappedSource\(/.test(sandbox) &&
    /lexi-iife:v1/.test(sandbox) &&
    /__lexiPluginRegistry/.test(sandbox) &&
    /require 上下文不可用\(已消费或不存在\)/.test(sandbox),
    '缺失任一形状即 CLI-wrapped 产物回退为不可载(ADR-R25-01 遗留项未收口)');
  ok('S31b 沙箱 require 只服务 obsidian 命名空间,凭据不进 iframe',
    !/token/.test((sandbox.match(/__lexiAcquireRequire[\s\S]{0,600}function \(name\)/) || [''])[0]),
    '沙箱 acquire 面不得绑定任何令牌/凭据;身份归属只在宿主 contextRegistry(contextId→容器网关)');
  // P1-003d(R28):lexi-sample 真实业务代码求值期依赖的 obsidian 最小面(类定义期就要
  // 基类存在);视图/设置宿主执行面仍属 P4-005,这里只保证求值成立。
  ok('S32 沙箱 obsidian 面含 ItemView/PluginSettingTab 最小基类',
    /function SandboxItemView\(/.test(sandbox) && /function SandboxPluginSettingTab\(/.test(sandbox) &&
    /ItemView: SandboxItemView/.test(sandbox) && /PluginSettingTab: SandboxPluginSettingTab/.test(sandbox),
    '真实业务代码 `class X extends ItemView` 在沙箱轨求值即 TypeError(lexi-sample 迁移阻塞)');
  ok('S32b 沙箱 vault 补 on 订阅面与 process 组合面(读→改写两段门禁 RPC)',
    /on: function \(_event, _callback\) \{ return \{ unregister/.test(sandbox) &&
    /process: function \(pathOrFile, fn\)/.test(sandbox) &&
    /'vault\.read'[\s\S]{0,200}'vault\.modify'/.test(
      (sandbox.match(/process: function \(pathOrFile, fn\)[\s\S]{0,600}/) || [''])[0]),
    'vault.on 缺失=onload 抛 ReferenceError;vault.process 必须组合既有门禁 RPC,不得新增宿主处理器');
  ok('S33 沙箱 workspace 叶面显式失败桩(不留 undefined)',
    /getRightLeaf: function \(\)/.test(sandbox) &&
    /叶面未接入沙箱轨/.test(sandbox),
    'workspace 叶面缺失面(P4-005)必须 fail-visible,裸 TypeError 会被误读成插件代码 bug');
  // R37(P4-001):Modal/Menu/Setting Builder 交互面——描述符经既有 request 链出站
  // (ui.modal.open / ui.menu.show / settings.register),结果经容器 sandbox.ui 回推帧
  // 回流;iframe 零 DOM 挂载(端口链纪律,ADR-R18-01)。
  ok('S34 沙箱 Modal/Menu/Setting 交互面在案(描述符经 request 链,宿主原生渲染)',
    /function SandboxModal\(/.test(sandbox) &&
    /'ui\.modal\.open'/.test(sandbox) && /'ui\.modal\.close'/.test(sandbox) &&
    /function SandboxMenu\(/.test(sandbox) &&
    /'ui\.menu\.show'/.test(sandbox) && /'ui\.menu\.hide'/.test(sandbox) &&
    /function SandboxSetting\(/.test(sandbox) && /'settings\.register'/.test(sandbox) &&
    /Modal: SandboxModal/.test(sandbox) && /Menu: SandboxMenu/.test(sandbox) &&
    /Setting: SandboxSetting/.test(sandbox),
    '交互面缺失任一形状即 P4-001 回退为 no-op 桩(不只类型声明)');
  ok('S34b 沙箱交互面零 DOM 句柄(Modal/Menu/Setting 区域不触 document/parent)',
    (() => {
      const start = sandbox.indexOf('function settleSandboxUiSurface');
      const end = sandbox.indexOf('function parentRequest');
      const faces = start >= 0 && end > start ? sandbox.slice(start, end) : '';
      return faces.length > 0 && !/document\./.test(faces) && !/window\.parent/.test(faces) &&
        !/createElement/.test(faces);
    })(),
    'iframe 交互面必须是纯内容描述符;DOM 面孔=宿主 UI 泄漏进沙箱(端口链纪律)');
  ok('S34c sandbox.ui 回推帧 port/window 两 listener 接线且共用 runSandboxUiEvent',
    (sandbox.match(/data\.type === 'sandbox\.ui'/g) || []).length >= 2 &&
    (sandbox.match(/runSandboxUiEvent\(/g) || []).length >= 3,
    '回推处理缺失任一通道 = 对应轨的交互面结果蒸发(port 轨 / 容器 window 轨)');
  ok('S34d Setting Builder 收集窗口与 key 寻址在案(缺 key 不进定义)',
    /settingCollecting = \[\]/.test(sandbox) &&
    /definitionsOf = function/.test(sandbox) &&
    /控件缺 key,声明式定义跳过/.test(sandbox),
    '收集窗口缺失 = Setting Builder 不落账;缺 key 静默入定义 = 宿主写值不可寻址');
  // R41(P4-002):EditorSuggest 建议浮层——描述符经 ui.suggest.* 出站,点选回推按 index
  // 回取原值(建议值不出 iframe);触发走显式 open(editor)(宿主无编辑器事件流)。
  ok('S35 沙箱 EditorSuggest 交互面在案(基类形状 + ui.suggest.* 出站 + 回推分支)',
    /function SandboxEditorSuggest\(/.test(sandbox) &&
    /prototype\.onTrigger/.test(sandbox) && /prototype\.getSuggestions/.test(sandbox) &&
    /prototype\.selectSuggestion/.test(sandbox) &&
    /'ui\.suggest\.show'/.test(sandbox) && /'ui\.suggest\.hide'/.test(sandbox) &&
    /EditorSuggest: SandboxEditorSuggest/.test(sandbox) &&
    /kind === 'suggest'/.test(sandbox) && /'suggest#'/.test(sandbox),
    '建议浮面缺失任一形状即 P4-002 回退为 no-op 桩(不只类型声明)');
  ok('S35b Suggest 显示投影在案(宿主只收 index/title/detail/icon,value 按 index 回取)',
    /_displayOf = function/.test(sandbox) &&
    /prototype\.setSuggestions[\s\S]{0,900}pool\.slice\(0, cap\)/.test(sandbox) &&
    /self\.selectSuggestion\(value, null\)/.test(sandbox) &&
    /suggest 点选越界/.test(sandbox),
    '投影缺失 = 值对象整包越链(端口链纪律);越界 index 无守卫 = 回取错值静默发生');
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
  // P1-003d(R28):业务链探针夹具(经 bootPlugin 装载)必须携带同一组向量——设备验收与
  // 本门禁共用同一探针源,防"门禁探针 ≠ 设备探针"的漂移。夹具按仓约定是 gitignore 的
  // 本地暂存物(sandbox-* 同批):在场时全量断言,缺席时显式打印跳过行(非隐形跳过)。
  const secFixturePath = path.join(RAWFILE, 'plugins', 'sandbox-sec-probe', 'main.js');
  const secManifestPath = path.join(RAWFILE, 'plugins', 'sandbox-sec-probe', 'manifest.json');
  if (fs.existsSync(secFixturePath) && fs.existsSync(secManifestPath)) {
    const secFixture = fs.readFileSync(secFixturePath, 'utf8');
    let missing = [];
    for (const vector of ['parent-dom', 'parent-globals', 'sibling-iframe', 'window-opener',
      'opaque-storage', 'network-fetch', 'network-xhr', 'remote-import', 'function-escape', 'credential-hunt']) {
      if (secFixture.indexOf("'" + vector + "'") < 0 && secFixture.indexOf('"' + vector + '"') < 0) { missing.push(vector); }
    }
    ok('S19b 业务链探针向量与 PoC 探针对齐(10/10)', missing.length === 0,
      '夹具缺少向量: ' + missing.join(','));
    const secManifest = JSON.parse(fs.readFileSync(secManifestPath, 'utf8'));
    ok('S19b 业务链探针声明沙箱轨入口(bootPlugin 业务链)',
      secManifest.manifestVersion === 2 && secManifest.entrypoints && secManifest.entrypoints.service === 'sandbox:',
      'SEC 探针必须走业务装载链(entrypoints.service="sandbox:"),不得走 PoC 通道');
  } else {
    console.log('  [skip] S19b/E3 业务链探针: plugins/sandbox-sec-probe 未暂存(夹具环境约定;设备验收前必须就位)');
  }
}

// ------------------------------------------------- S40 P1-005 身份纯端口化(R30,验收行:插件侧报文不含任何身份字段)
console.log('== S40 P1-005 身份纯端口化(端口↔身份绑定,报文零身份字段) ==');
{
  // 沙箱链(端口化主路径)逐跳载荷捕获:iframe init / iframe→容器 request / 容器→宿主
  // 网关帧,任何一跳都不得出现凭据/身份字段 —— 身份只在宿主 contextRegistry 反查。
  const containerSrc = fs.readFileSync(path.join(RAWFILE, 'lexinote_sandbox_container.js'), 'utf8');
  const sandboxSrc = fs.readFileSync(SANDBOX_HTML, 'utf8');
  ok('S40a 容器→iframe init 载荷零凭据字段',
    !/token|activationId|credential/.test((containerSrc.match(/type: 'sandbox\.init'[\s\S]{0,220}/) || ['x']) [0]) &&
    /contextId: contextId,\s*plugin: \{ code: boot\.code, manifestJson: boot\.manifestJson \}/.test(containerSrc),
    'init 帧只允许 contextId+装载物;凭据绝不进 iframe(ADR-R18-01 定案2)');
  ok('S40b 容器→宿主网关帧只带 contextId+协议字段',
    /dispatchToHost\(matched, \{\s*v: 1, type: 'request',\s*id: String\(data\.requestId \|\| ''\),\s*method: String\(data\.method \|\| ''\),\s*payload: \(data\.params === undefined \? \{\} : data\.params\)\s*\}\)/.test(containerSrc) &&
    !/token|credential|pluginId/.test((containerSrc.match(/->arkts[\s\S]{0,400}?\}\);/) || ['x'])[0]),
    '容器覆写 contextId(event.source 反查),帧构造不得混入任何身份/凭据字段');
  ok('S40c 沙箱 iframe 请求帧零身份字段',
    !/token|credential|pluginId/.test((sandboxSrc.match(/function request\(method, params\) \{[\s\S]{0,600}parentRequest\(method, params\)/) || ['x'])[0]) &&
    /\{ type: 'sandbox\.request', requestId: requestId, method: method, params: params \|\| \{\}\s*\}/.test(sandboxSrc),
    '插件侧请求帧只有 requestId/method/params;身份由宿主端口表反查');
  const runtimeSrc = fs.readFileSync(path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginRuntime.ets'), 'utf8');
  const portFrameBody = (runtimeSrc.match(/handleContextPortFrame\(data: string\): void \{[\s\S]*?\n  \}/) || [''])[0];
  const sandboxProxyBody = (runtimeSrc.match(/handleSandboxProxyCall\(frameJson: string\): void \{[\s\S]*?\n  \}/) || [''])[0];
  ok('S40d 宿主端口链调用点零凭据表达式(callFromPort 裁决)',
    portFrameBody.indexOf('callFromPort(') >= 0 && sandboxProxyBody.indexOf('callFromPort(') >= 0 &&
    portFrameBody.indexOf('tokenForPlugin(') < 0 && sandboxProxyBody.indexOf('tokenForPlugin(') < 0,
    '身份 = contextRegistry 记录反查;凭据只在 callFromPort 宿主内部补铸,不经过页面');
  ok('S40e 沙箱轨 boot 载荷零凭据字段(与 legacy 轨分流)',
    !/'token'/.test((runtimeSrc.match(/const sandboxBoot: Record<string, Object> = \{[\s\S]*?\};/) || ['x'])[0]),
    'dispatchSandboxBoot 载荷只有 contextId/pluginId/code/manifestJson,无任何凭据');
  // legacy 轨(ADR-R28-01 过渡保留)的 credential 第 4 参经页面形态必须死在轨道门后:
  // TRACK_REFUSED 分支先于 load.plugin 载荷构建 —— 开关关闭时该形态整体消失。
  const refusedAt = runtimeSrc.indexOf('track === TRACK_REFUSED');
  const tokenPayloadAt = runtimeSrc.indexOf("'token': token as Object");
  ok('S40f legacy 凭据形态受轨道门约束(TRACK_REFUSED 先于载荷下发)',
    refusedAt >= 0 && tokenPayloadAt > refusedAt,
    'load.plugin 的 token 字段只允许存在于 legacy 轨分支(开关 false 时整体不派发,形态退役)');
}

// ------------------------------------------------- S41 P1-008 销毁闭环(R32,SEC-013)
// 验收行:卸载后旧通道 RPC 一律拒绝。容器侧销毁面 + 宿主五步尾序(行为级负例在
// context-registry D 组:context_revoked/unknown_method)。
console.log('== S41 P1-008 销毁闭环(容器 iframe 销毁面 + 宿主接线顺序) ==');
{
  const containerSrc = fs.readFileSync(path.join(RAWFILE, 'lexinote_sandbox_container.js'), 'utf8');
  const runtimeSrc = fs.readFileSync(path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginRuntime.ets'), 'utf8');
  const disableBody = runtimeSrc.indexOf('async disablePlugin(') > 0
    ? runtimeSrc.slice(runtimeSrc.indexOf('async disablePlugin('), runtimeSrc.indexOf('private async persistEnabled('))
    : '';
  ok('S41a 容器销毁面在案:lexiContainerTeardown 移除 per-plugin iframe 并清 pendingContexts',
    /window\.lexiContainerTeardown = function/.test(containerSrc) &&
    /removeChild\(context\.iframe\)/.test(containerSrc) &&
    /pendingContexts\.delete\(cid\)/.test(containerSrc),
    'SEC-013:容器侧 iframe 残留 = opaque origin 求值面未销毁(卸载残留)');
  ok('S41b 容器销毁面幂等:缺 id fail-visible / 无匹配 no-op(宿主重复调用安全)',
    /teardown 缺少插件 id\(fail-visible\)/.test(containerSrc) &&
    /teardown 无匹配上下文\(幂等 no-op\)/.test(containerSrc));
  ok('S41c 宿主五步尾序有序:吊销端口身份 → 容器 iframe 销毁 → 吊销凭据 → 清 pending',
    (() => {
      const atRevoke = disableBody.indexOf('contextRegistry.revokePlugin(pluginId)');
      const atTeardown = disableBody.indexOf('lexiContainerTeardown');
      const atTokens = disableBody.indexOf('revokePluginTokens(pluginId)');
      const atPending = disableBody.indexOf('failPendingLifecycleWaits(pluginId');
      return atRevoke > 0 && atTeardown > atRevoke && atTokens > atTeardown && atPending > atTokens;
    })(),
    'P1-008 顺序即防线:旧通道帧先被拒(context_revoked),再拆求值面,再断凭据,再清在途等待');
  ok('S41d 宿主调用带存在性守卫(旧容器页/页丢失 fail-safe,不抛)',
    /window\.lexiContainerTeardown && window\.lexiContainerTeardown\(/.test(disableBody));
}

// ------------------------------------------------- S42 P4-001 交互面回推链(R37)
// 验收行:Modal/Menu/Setting 三面的宿主执行端——容器 ui 事件路由(身份不进帧)、
// 宿主 handler/capability 映射、原生渲染组件接线、设置值回推、销毁回收。
console.log('== S42 P4-001 交互面回推链(容器路由 + 宿主接线) ==');
{
  const containerSrc = fs.readFileSync(path.join(RAWFILE, 'lexinote_sandbox_container.js'), 'utf8');
  const runtimeSrc = fs.readFileSync(path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginRuntime.ets'), 'utf8');
  const surfaceHostPath = path.join(ROOT, 'entry/src/main/ets/components/plugin/LexiPluginSurfaceHost.ets');
  const surfaceHost = fs.existsSync(surfaceHostPath) ? fs.readFileSync(surfaceHostPath, 'utf8') : '';
  const indexSrc = fs.readFileSync(path.join(ROOT, 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const uiFrameZone = (containerSrc.match(/type: 'sandbox\.ui'[\s\S]{0,260}/) || [''])[0];
  ok('S42a 容器 ui 事件回推按 pluginId 路由且帧本体零身份字段',
    /window\.lexiSandboxUiEvent = function/.test(containerSrc) &&
    /context\.pluginId === pluginId/.test(containerSrc) &&
    uiFrameZone.length > 0 && !/pluginId|token|activationId/.test(uiFrameZone),
    '容器路由用 pluginId(身份只在本页路由),frame 只允许 kind/id/event/itemId/values(与命令回推同一纪律)');
  ok('S42b 宿主 Modal/Menu handler 在案且 capability 映射 notifications(与 Notice 同域)',
    /registerHandler\('ui\.modal\.open'/.test(runtimeSrc) &&
    /registerHandler\('ui\.modal\.close'/.test(runtimeSrc) &&
    /registerHandler\('ui\.menu\.show'/.test(runtimeSrc) &&
    /registerHandler\('ui\.menu\.hide'/.test(runtimeSrc) &&
    /'ui\.modal\.open' \|\| method === 'ui\.modal\.close'/.test(runtimeSrc) &&
    /return caps\.notifications; \}/.test(runtimeSrc),
    'handler 缺失 = 描述符出站 unknown_method;capability 映射缺失 = 未声明 notifications 的插件可弹 UI');
  ok('S42c 交互面宿主渲染组件在案并嵌入主页面(观察修订号,用户操作回流 manager)',
    /struct LexiPluginSurfaceHost/.test(surfaceHost) &&
    /lexiPluginRevision/.test(surfaceHost) &&
    /dismissPluginModal|choosePluginMenuItem/.test(surfaceHost) &&
    /LexiPluginSurfaceHost\(\)/.test(indexSrc),
    '渲染组件缺失 = 描述符出站后无宿主面(弹层/菜单不出现)');
  ok('S42d 设置值沙箱回推接线(writePluginData → sandbox.ui;legacy dispatch 保持)',
    /notifySandboxUiEvent\(pluginId, 'settings', 'values', 'changed', -1, values\)/.test(runtimeSrc) &&
    /dispatch\('settings\.values'/.test(runtimeSrc) &&
    /private notifySandboxUiEvent\(/.test(runtimeSrc),
    'R36 调查的"运行中值回推无通道"缺口:沙箱轨收口在 sandbox.ui,legacy 轨等价通道不得移除');
  ok('S42e 交互面随插件销毁回收(disable 尾序 dropPluginSurfaces)',
    /dropPluginSurfaces\(pluginId\)/.test(runtimeSrc),
    '在途弹层/菜单残留 = 插件销毁后宿主仍渲染其 UI(销毁闭环缺口)');
  // R41(P4-002):Suggest 宿主执行端——handler/capability 映射与 Modal/Menu 同款。
  ok('S42f 宿主 Suggest handler 在案且 capability 映射 notifications(与 Modal/Menu 同域)',
    /registerHandler\('ui\.suggest\.show'/.test(runtimeSrc) &&
    /registerHandler\('ui\.suggest\.hide'/.test(runtimeSrc) &&
    /method === 'ui\.suggest\.show' \|\| method === 'ui\.suggest\.hide'\) \{ return caps\.notifications; \}/.test(runtimeSrc) &&
    /suggestSurfaces\.set\(identity \+ '#' \+ suggestId, surface\)/.test(runtimeSrc),
    'handler 缺失 = 建议描述符出站 unknown_method;capability 映射缺失 = 未声明 notifications 可弹建议浮层');
  ok('S42g 宿主渲染组件 Suggest 层在案(点选/点外回流 manager,回推 item/closed)',
    /choosePluginSuggestion\(/.test(surfaceHost) && /dismissPluginSuggest\(/.test(surfaceHost) &&
    /pluginSuggestSurfaces\(\): LexiPluginSuggestSurface\[\]/.test(runtimeSrc) &&
    /choosePluginSuggestion\(pluginId: string, suggestId: string, itemId: number\)/.test(runtimeSrc),
    '渲染层缺失 = 描述符出站后无宿主面(建议浮层不出现/点选无回流)');
  ok('S42h Suggest 在途面随插件销毁回收(dropPluginSurfaces 覆盖 suggestSurfaces)',
    (() => {
      const at = runtimeSrc.indexOf('dropPluginSurfaces(pluginId: string): void {');
      const body = at >= 0 ? runtimeSrc.slice(at, at + 900) : '';
      return body.indexOf('suggestSurfaces') >= 0;
    })(),
    '在途建议浮层残留 = 插件销毁后宿主仍渲染其 UI(销毁闭环缺口)');
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

// ------------------------------------------------------- E3 业务链探针(P1-003d/R28)
//
// RFC §3.6:「安全 PoC 测试通过不等于业务运行时已经安全;最终必须在真实业务加载路径中验证」。
// E1/E2 用的是手工模拟环境 + PoC 通道探针;E3 把沙箱表面代码(lexinote_plugin_sandbox.html
// 的真实引导脚本)放进 vm,再让业务链探针夹具(plugins/sandbox-sec-probe/main.js,与设备
// 验收同一份源码)经 bootPlugin 业务装载链(CJS/IIFE 双分支)装载执行:逃逸向量逐条必须
// blocked,业务 RPC(data.save 报告落盘/plugin.onload.done)必须经受控请求帧完成。
const SEC_FIXTURE_DIR = path.join(RAWFILE, 'plugins', 'sandbox-sec-probe');
const SEC_FIXTURE_MAIN = path.join(SEC_FIXTURE_DIR, 'main.js');
const SEC_PLUGIN_ID = 'sandbox-sec-probe';
// R37(P4-001)交互面探针夹具:与设备验收同一份源码(与 E3 同纪律,gitignore 本地暂存物)。
const UI_FIXTURE_DIR = path.join(RAWFILE, 'plugins', 'sandbox-ui-min');
const UI_FIXTURE_MAIN = path.join(UI_FIXTURE_DIR, 'main.js');
const UI_PLUGIN_ID = 'sandbox-ui-min';

/** 提取沙箱页内联引导脚本(文档本体唯一脚本,与真机同源)。 */
function sandboxPageScript() {
  const html = fs.readFileSync(SANDBOX_HTML, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) { throw new Error('lexinote_plugin_sandbox.html 内联引导缺失(S20 同型的外置不变量在此页按设计豁免:沙箱 iframe 才是求值边界)'); }
  return m[1];
}

/**
 * 容器轨 vm 环境:opaque-origin iframe(env)+ 容器父窗口(parentWin)。
 * 父窗口对 iframe 只暴露 postMessage(规范允许的跨源合法通道);document/globals/frames
 * 一律 SecurityError(容器页与宿主页同为跨源)。sandbox.request 帧自动应答(容器网关的
 * vm 等价物),业务 RPC 全程走这条受控帧链。
 */
function makeBusinessSandboxEnv() {
  const frames = [];
  const handlers = [];
  const securityError = () => {
    throw new Error('SecurityError: Blocked a frame with origin "null" from accessing a cross-origin frame.');
  };
  const respond = (msg) => {
    if (!msg || msg.type !== 'sandbox.request' || !msg.requestId) { return; }
    Promise.resolve().then(() => {
      env.__deliver({ __lexiSandbox: true, type: 'sandbox.response',
        requestId: msg.requestId, ok: true, result: null });
    });
  };
  const parentWin = {
    // 容器页(lexinote_sandbox_container.js)对 iframe 暴露的唯一面。
    postMessage: (msg) => { frames.push(msg); respond(msg); }
  };
  Object.defineProperty(parentWin, 'document', { get() { securityError(); } });
  Object.defineProperty(parentWin, 'LexiObsidian', { get() { securityError(); } });
  Object.defineProperty(parentWin, 'window', { get() { securityError(); } });
  Object.defineProperty(parentWin, 'frames', { get() { securityError(); } });
  const env = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    setInterval: () => { return 0; },
    clearInterval: () => {},
    Promise: Promise,
    JSON: JSON,
    Math: Math,
    Date: Date,
    Map: Map,
    __frames: frames
  };
  env.window = env;
  env.self = env;
  env.parent = parentWin;
  env.top = parentWin;
  Object.defineProperty(env.window, 'opener', { value: null });
  Object.defineProperty(env, 'localStorage', {
    get() { throw new Error('SecurityError: The document is sandboxed and lacks the allow-same-origin flag.'); }
  });
  env.document = { get cookie() { return ''; } };
  env.fetch = () => Promise.reject(new TypeError("Failed to fetch: Refused to connect because 'connect-src none' violates CSP"));
  env.XMLHttpRequest = function () {
    this.open = function () {};
    this.send = function () { setTimeout(() => { this.onerror && this.onerror(new Error('NetworkError')); }, 0); };
  };
  env.addEventListener = (type, fn) => { if (type === 'message') { handlers.push(fn); } };
  env.removeEventListener = () => {};
  env.location = { pathname: 'lexinote_plugin_sandbox.html' };
  // 容器 → iframe 帧投递(event.source=父窗口;容器轨无 port 转移,window 通道)。
  env.__deliver = (data) => {
    const event = { source: parentWin, data: data, ports: [] };
    for (const h of handlers.slice()) { h(event); }
  };
  vm.createContext(env);
  return env;
}

/** 宿主 shim 的单一真源包装器(vm 复用,与 lexi-cli build 同一技术)。 */
function wrapViaShim(code, pluginId) {
  const shimSource = fs.readFileSync(path.join(RAWFILE, 'lexinote_plugin_shim.js'), 'utf8');
  const sb = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    Promise: Promise, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set,
    document: { createElement: () => ({ style: {}, classList: { add: () => {} } }) },
    location: { href: 'about:blank' }
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(shimSource, sb, { filename: 'lexinote_plugin_shim.js' });
  const wrap = sb.window.lexiRuntime && sb.window.lexiRuntime.__lexiWrapPluginSource;
  if (typeof wrap !== 'function') { throw new Error('宿主 shim 未发布 __lexiWrapPluginSource'); }
  return wrap(code, pluginId);
}

/** 把探针夹具经业务装载链(bootPlugin)装入 vm 沙箱并驱动 onload。 */
async function runBusinessProbe(mode) {
  const env = makeBusinessSandboxEnv();
  vm.runInContext(sandboxPageScript(), env, { filename: 'lexinote_plugin_sandbox.html#inline' });
  const code = fs.readFileSync(SEC_FIXTURE_MAIN, 'utf8');
  const pluginCode = mode === 'iife' ? wrapViaShim(code, SEC_PLUGIN_ID) : code;
  if (mode === 'iife' && !/^\s*\/\*\s*lexi-iife:v1\s*\*\//.test(pluginCode)) {
    throw new Error('shim 包装产物缺 lexi-iife:v1 标记');
  }
  env.__deliver({
    __lexiSandbox: true, type: 'sandbox.init', contextId: 'sec-ctx',
    plugin: {
      code: pluginCode,
      manifestJson: JSON.stringify({ id: SEC_PLUGIN_ID, name: '沙箱安全探针(业务链)', version: '1.0.0' })
    }
  });
  // 排空事件轮询直到业务报告落位(data.save 请求帧出现)或超时。
  for (let i = 0; i < 400; i++) {
    const done = env.__frames.some((f) => f.type === 'sandbox.request' && f.method === 'plugin.onload.done');
    if (done) { break; }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return env;
}

function businessReportOf(env) {
  const frame = env.__frames.find((f) => f.type === 'sandbox.request' && f.method === 'data.save');
  if (!frame) { return null; }
  try { return JSON.parse(frame.params.dataJson).sec; } catch { return null; }
}

async function assertBusinessProbe(label, mode) {
  let env = null;
  let bootError = '';
  try {
    env = await runBusinessProbe(mode);
  } catch (error) {
    bootError = error.message;
  }
  ok(label + ' a 业务装载链完成 boot(sandbox.init 已消费)', !!env && bootError === '' &&
    env.window.lexiSandbox && env.window.lexiSandbox.contextReady === true,
    bootError || '沙箱表面代码未消费 init(容器轨 boot 记账走请求帧,非 boot 帧——port 缺失时 boot 帧按 B-009b 留痕丢弃)');
  if (!env) { return; }
  const report = businessReportOf(env);
  ok(label + ' b 探针经业务链产出报告(data.save 帧在案)', !!report && Array.isArray(report.vectors),
    '探针 onload 未走通业务数据通道');
  if (!report) { return; }
  const unblocked = (report.vectors || []).filter((v) => !v.blocked);
  ok(label + ' c 全部逃逸向量在业务链中被阻断', unblocked.length === 0,
    '未被阻断: ' + unblocked.map((v) => v.id + '(' + String(v.detail).slice(0, 60) + ')').join(', '));
  ok(label + ' d 报告 passed(向量齐备≥10 且凭据零命中)', report.passed === true,
    'passed=' + report.passed + ' total=' + report.total + ' credentialHits=' + report.credentialHits);
  ok(label + ' e 业务链收尾帧(plugin.onload.done)在案',
    env.__frames.some((f) => f.type === 'sandbox.request' && f.method === 'plugin.onload.done'),
    'onload 未完成——业务链中途断裂');
  const leakyIdentity = env.__frames.filter((f) => f && (f.pluginId !== undefined || f.token !== undefined ||
    f.activationId !== undefined || (f.params && (f.params.pluginId !== undefined || f.params.token !== undefined))));
  ok(label + ' f iframe 发出的帧不带身份字段(身份只在宿主侧)', leakyIdentity.length === 0,
    '身份泄漏帧: ' + leakyIdentity.map((f) => f.method || f.type).join(','));
}

/**
 * E4 交互面业务链探针(P4-001/R37 + P4-002/R41):与 E3 同一容器轨 vm 环境(真实沙箱页脚本),
 * 装载 sandbox-ui-min 夹具,Modal/Menu/Setting/Suggest 四面全链行为级——
 *   出站:命令回推驱动 Modal/Menu 描述符帧(ui.modal.open/ui.menu.show)、编辑器命令帧
 *         (带快照)驱动 EditorSuggest 触发链(ui.suggest.show 只带显示描述符)、
 *         addSettingTab 驱动 Setting Builder 定义帧(settings.register);
 *   回流:宿主侧以 sandbox.ui 帧回推(用户关闭/点选/建议点选/设置值变更),插件回调
 *         (onClose/onClick/onHide/selectSuggestion/控件 onChange/onSettingsChanged)
 *         经 data.save 落账对账。
 * 宿主 ArkTS 渲染端的行为级验收归设备批次(本探针证明 iframe 侧全链 + 帧协议两端形状)。
 */
async function assertUiProbe(label, mode) {
  const env = makeBusinessSandboxEnv();
  vm.runInContext(sandboxPageScript(), env, { filename: 'lexinote_plugin_sandbox.html#inline' });
  const code = fs.readFileSync(UI_FIXTURE_MAIN, 'utf8');
  const pluginCode = mode === 'iife' ? wrapViaShim(code, UI_PLUGIN_ID) : code;
  env.__deliver({
    __lexiSandbox: true, type: 'sandbox.init', contextId: 'ui-ctx',
    plugin: {
      code: pluginCode,
      manifestJson: JSON.stringify({ id: UI_PLUGIN_ID, name: '沙箱交互面夹具(R37)', version: '1.0.0' })
    }
  });
  const until = async (condition, what) => {
    for (let i = 0; i < 400; i++) {
      if (condition()) { return true; }
      await new Promise((resolve) => setImmediate(resolve));
    }
    return false;
  };
  const requestFrames = (method) => env.__frames.filter((f) => f.type === 'sandbox.request' && f.method === method);
  const lastSaveJson = () => {
    const saves = requestFrames('data.save');
    return saves.length > 0 ? JSON.stringify(saves[saves.length - 1].params) : '';
  };
  // 1. 设置面:display() 收集窗口 → settings.register 定义出站。
  await until(() => requestFrames('settings.register').length > 0, 'settings.register');
  const regFrame = requestFrames('settings.register')[0];
  let defs = [];
  try { defs = JSON.parse(regFrame.params.definitionsJson); } catch (err) { defs = []; }
  const defOf = (key) => defs.find((def) => def.key === key) || null;
  ok(label + ' a 设置面:Setting Builder 定义出站(toggle/dropdown/slider 全键位)', !!regFrame &&
    !!defOf('showBadge') && defOf('showBadge').type === 'toggle' &&
    !!defOf('uiLevel') && defOf('uiLevel').type === 'dropdown' &&
    defOf('uiLevel').options && defOf('uiLevel').options.simple === '简洁' &&
    !!defOf('maxItems') && defOf('maxItems').type === 'slider' &&
    defOf('maxItems').min === 1 && defOf('maxItems').max === 50,
    'defs=' + JSON.stringify(defs).slice(0, 160));
  // 2. Modal:命令回推 → 描述符出站;宿主关闭回推 → onClose 落账。
  env.__deliver({ __lexiSandbox: true, type: 'sandbox.command', fullId: UI_PLUGIN_ID + ':ui-modal' });
  await until(() => requestFrames('ui.modal.open').length > 0, 'ui.modal.open');
  const modalFrame = requestFrames('ui.modal.open')[0];
  ok(label + ' b Modal 描述符出站(modalId/title/content 经 ui.modal.open)', !!modalFrame &&
    typeof modalFrame.params.modalId === 'string' && modalFrame.params.modalId.length > 0 &&
    modalFrame.params.title === '沙箱交互面' &&
    typeof modalFrame.params.content === 'string' && modalFrame.params.content.length > 0,
    'params=' + JSON.stringify(modalFrame && modalFrame.params).slice(0, 160));
  env.__deliver({ __lexiSandbox: true, type: 'sandbox.ui', kind: 'modal', id: modalFrame.params.modalId, event: 'closed' });
  await until(() => lastSaveJson().indexOf('modalClosedAt') >= 0, 'modal onClose data.save');
  ok(label + ' c Modal 关闭回推兑现 onClose(onClose 落账 modalClosedAt)', lastSaveJson().indexOf('modalClosedAt') >= 0,
    '最后一次 data.save=' + lastSaveJson().slice(0, 160));
  // 3. Menu:条目表出站(2 数据项 + 1 分隔线);宿主点选回推 → onClick + onHide 落账。
  env.__deliver({ __lexiSandbox: true, type: 'sandbox.command', fullId: UI_PLUGIN_ID + ':ui-menu' });
  await until(() => requestFrames('ui.menu.show').length > 0, 'ui.menu.show');
  const menuFrame = requestFrames('ui.menu.show')[0];
  ok(label + ' d Menu 条目表出站(2 数据项 + 1 分隔线,声明式字段)', !!menuFrame &&
    Array.isArray(menuFrame.params.items) && menuFrame.params.items.length === 3 &&
    menuFrame.params.items.filter((item) => item.separator === true).length === 1 &&
    menuFrame.params.items.some((item) => item.title === '标记为重要') &&
    typeof menuFrame.params.menuId === 'string',
    'items=' + JSON.stringify(menuFrame && menuFrame.params.items).slice(0, 160));
  env.__deliver({ __lexiSandbox: true, type: 'sandbox.ui', kind: 'menu', id: menuFrame.params.menuId, event: 'item', itemId: 0 });
  // needle 用裸词 star:JSON.stringify 会转义 dataJson 内层引,\"star\" 不含 "star" 子串。
  await until(() => lastSaveJson().indexOf('menuClosedAt') >= 0 && lastSaveJson().indexOf('star') >= 0,
    'menu onClick/onHide data.save');
  ok(label + ' e Menu 点选回推兑现 onClick 与 onHide(menuPick=star + menuClosedAt)',
    lastSaveJson().indexOf('star') >= 0 && lastSaveJson().indexOf('menuClosedAt') >= 0,
    '最后一次 data.save=' + lastSaveJson().slice(0, 160));
  // 4. 设置值回推:控件 onChange 与 tab.onSettingsChanged 双路径兑现。
  env.__deliver({ __lexiSandbox: true, type: 'sandbox.ui', kind: 'settings', values: { showBadge: false, uiLevel: 'pro' } });
  await until(() => lastSaveJson().indexOf('lastChanged') >= 0, 'settings.values data.save');
  let lastSave = {};
  try { lastSave = JSON.parse(requestFrames('data.save').slice(-1)[0].params.dataJson); } catch (err) { lastSave = {}; }
  ok(label + ' f 设置值回推兑现控件 onChange 与 onSettingsChanged 双路径',
    lastSave.controlFired >= 1 && lastSave.changes >= 1 && lastSave.lastChanged &&
    lastSave.lastChanged.uiLevel === 'pro' && lastSave.lastChanged.showBadge === false,
    'state=' + JSON.stringify(lastSave).slice(0, 200));
  // 5. Suggest(P4-002):编辑器命令帧带快照(readActive 档,同宿主 invokeEditorCommand 形状)
  //    → onTrigger 派生 query → ui.suggest.show 只带显示描述符;点选回推 → selectSuggestion
  //    (按 index 回取原值)落账;点外关闭回推 → Promise 兑现落账。
  env.__deliver({ __lexiSandbox: true, type: 'sandbox.command', fullId: UI_PLUGIN_ID + ':ui-suggest',
    editor: { text: 'note le alpha', selection: { start: 7, end: 7 } } });
  await until(() => requestFrames('ui.suggest.show').length > 0, 'ui.suggest.show');
  const suggestFrame = requestFrames('ui.suggest.show')[0];
  const suggestItems = suggestFrame && Array.isArray(suggestFrame.params.items) ? suggestFrame.params.items : [];
  ok(label + ' i Suggest 触发链出站(query 从快照光标派生,描述符只带显示字段)',
    !!suggestFrame && typeof suggestFrame.params.suggestId === 'string' &&
    suggestFrame.params.suggestId.length > 0 && suggestFrame.params.query === 'le' &&
    suggestItems.length === 2 && suggestItems[0].title === 'legal note' &&
    suggestItems[1].title === 'letter count' &&
    suggestItems.every((item) => item.id === undefined),
    'params=' + JSON.stringify(suggestFrame && suggestFrame.params).slice(0, 200));
  env.__deliver({ __lexiSandbox: true, type: 'sandbox.ui', kind: 'suggest',
    id: suggestFrame.params.suggestId, event: 'item', itemId: 1 });
  await until(() => lastSaveJson().indexOf('suggestPick') >= 0, 'suggest selectSuggestion data.save');
  ok(label + ' j Suggest 点选回推兑现 selectSuggestion(index 回取原值 suggestPick=letter)',
    lastSaveJson().indexOf('letter') >= 0, '最后一次 data.save=' + lastSaveJson().slice(0, 160));
  // 点外关闭:第二次打开后 closed 回推 → open() Promise 兑现(closedBy=host 落账);
  // 已 settle 的在途面重复回推按"无在途面"留痕 no-op(幂等,不抛)。
  env.__deliver({ __lexiSandbox: true, type: 'sandbox.command', fullId: UI_PLUGIN_ID + ':ui-suggest',
    editor: { text: 'note le alpha', selection: { start: 7, end: 7 } } });
  await until(() => requestFrames('ui.suggest.show').length >= 2, 'ui.suggest.show #2');
  env.__deliver({ __lexiSandbox: true, type: 'sandbox.ui', kind: 'suggest',
    id: requestFrames('ui.suggest.show')[1].params.suggestId, event: 'closed' });
  await until(() => lastSaveJson().indexOf('suggestClosedAt') >= 0, 'suggest closed data.save');
  env.__deliver({ __lexiSandbox: true, type: 'sandbox.ui', kind: 'suggest',
    id: requestFrames('ui.suggest.show')[1].params.suggestId, event: 'closed' });
  await new Promise((resolve) => setImmediate(resolve));
  let suggestSave = {};
  try { suggestSave = JSON.parse(requestFrames('data.save').slice(-1)[0].params.dataJson); } catch (err) { suggestSave = {}; }
  ok(label + ' k Suggest 点外关闭兑现 Promise + 重复回推幂等(settle 一次即焚)',
    suggestSave.suggestClosedAt > 0 && suggestSave.suggestSettled === 'host' &&
    suggestSave.suggests === 2 && suggestSave.suggestPick === 'letter',
    'state=' + JSON.stringify(suggestSave).slice(0, 200));
  // 6. 身份纪律 + boot 收尾(与 E3 同判)。
  const leakyIdentity = env.__frames.filter((f) => f && (f.pluginId !== undefined || f.token !== undefined ||
    f.activationId !== undefined || (f.params && (f.params.pluginId !== undefined || f.params.token !== undefined))));
  ok(label + ' g 交互全链 iframe 帧零身份字段(身份只在宿主侧)', leakyIdentity.length === 0,
    '身份泄漏帧: ' + leakyIdentity.map((f) => f.method || f.type).join(','));
  ok(label + ' h 业务链收尾帧(plugin.onload.done)在案',
    requestFrames('plugin.onload.done').length > 0,
    'onload 未完成——交互面探针的装载链中途断裂');
}

async function main() {
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
  console.log('== E3 业务链探针(P1-003d:沙箱表面代码×业务装载链) ==');
  if (!fs.existsSync(SEC_FIXTURE_MAIN)) {
    console.log('  [skip] E3/E3b: SEC 探针夹具未暂存(plugins/sandbox-sec-probe,夹具环境约定)');
  } else {
    // CJS 分支:夹具原样经 bootPlugin 工厂管线(设备验收主路径)。
    await assertBusinessProbe('E3', 'cjs');
    // IIFE 分支:同一份夹具经宿主 shim 单一真源包装器包装后,按字节原样经 bootPlugin
    // 新 require 管线装载(ADR-R25-01 遗留项收口的行为级证明)。
    await assertBusinessProbe('E3b', 'iife');
  }
  console.log('== E4 交互面业务链探针(P4-001/R37 + P4-002/R41:Modal/Menu/Setting/Suggest 四面全链) ==');
  if (!fs.existsSync(UI_FIXTURE_MAIN)) {
    console.log('  [skip] E4/E4b: 交互面夹具未暂存(plugins/sandbox-ui-min,夹具环境约定)');
  } else {
    await assertUiProbe('E4', 'cjs');
    await assertUiProbe('E4b', 'iife');
  }
}

main().then(() => {
  // ---------------------------------------------------------------- 汇总
  console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
  for (const f of failures) { console.log('  ✗ ' + f); }
  console.log(failures.length === 0
    ? 'plugin-context-isolation: PASS'
    : 'plugin-context-isolation: FAIL (' + failures.length + ')');
  process.exit(failures.length === 0 ? 0 : 1);
}, (error) => {
  console.log('plugin-context-isolation: 主流程异常 — ' + ((error && error.stack) || error));
  process.exit(1);
});
