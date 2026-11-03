'use strict';
// RFC §14 T0.3 · API Handler 授权门禁。
//
// 验收目标：每个 handler 都有授权测试。
//   M1 矩阵覆盖：LexiPluginRuntime.ets 的全部 registerHandler 方法 + WorkspaceBridge
//      的全部桥面方法，必须逐条登记在真实 LexiPermissionBroker 矩阵里（默认拒绝是
//      兜底，不是登记）。
//   M2 伪造场景（真实 broker 转译求值，非镜像）：匿名/会话/插件三种角色对敏感方法
//      的放行与拒绝逐条断言，含跨插件资源删除、控制面越权、fs 写能力、editor 写、
//      未知方法默认拒绝。
//   M3 接线：call() 必须先过 broker；所有权敏感 handler 必须带 resource 复查；
//      WorkspaceBridge dispatch 必须接 broker。
//
// 用法：node scripts/tests/plugin-authz-matrix.cjs
// 依赖：LEXI_TYPESCRIPT（转译 LexiPermissionBroker.ets）

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginRuntime.ets');
const BRIDGE_ETS = path.join(ROOT, 'entry/src/main/ets/workspace/WorkspaceBridge.ets');
const BROKER_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPermissionBroker.ets');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

// ---------------------------------------------------------------- M1 矩阵覆盖
section('M1 矩阵覆盖');

const runtimeSrc = fs.existsSync(RUNTIME_ETS) ? fs.readFileSync(RUNTIME_ETS, 'utf8') : '';
const bridgeSrc = fs.existsSync(BRIDGE_ETS) ? fs.readFileSync(BRIDGE_ETS, 'utf8') : '';

function extractHandlers(src) {
  const set = new Set();
  const re = /registerHandler\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) { set.add(m[1]); }
  return set;
}

function extractBridgeMethods(src) {
  const set = new Set();
  const re = /method === '([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (['WORKSPACE_METHOD_NOTE_WRITE'].indexOf(m[1]) >= 0) { continue; }
    set.add(m[1]);
  }
  // theme.* 是一组合并分支
  if (/theme\.config' \|\| method === 'theme\.list'/.test(src) || /'theme\.config'/.test(src)) {
    for (const t of ['theme.config', 'theme.list', 'theme.load', 'theme.install', 'theme.setActive']) {
      if (src.indexOf("'" + t + "'") >= 0) { set.add(t); }
    }
  }
  return set;
}

// ---------------------------------------------------------------- M2 真实 broker 求值
function stageBroker() {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { throw new Error('需要 LEXI_TYPESCRIPT 指向 typescript 模块'); }
  const ts = require(tsPath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexinote-broker-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const out = ts.transpileModule(fs.readFileSync(BROKER_ETS, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  fs.writeFileSync(path.join(dir, 'LexiPermissionBroker.js'), out);
  return require(path.join(dir, 'LexiPermissionBroker.js'));
}

let brokerMod = null;
let broker = null;
try {
  brokerMod = stageBroker();
  broker = new brokerMod.LexiPermissionBroker((pluginId, method) => pluginId === 'fs-plugin' || pluginId === 'legacy-plugin');
  ok('M2.0 broker 可转译求值', !!broker);
} catch (error) {
  ok('M2.0 broker 可转译求值', false, 'threw: ' + error.message);
}

function ctxOf(role, pluginId) {
  const ctx = new brokerMod.LexiCallerContext();
  ctx.role = role;
  ctx.pluginId = pluginId || '';
  return ctx;
}

function res(owner) {
  const r = new brokerMod.LexiAuthzResource();
  r.owner = owner || '';
  r.fullId = owner ? owner + ':cmd' : '';
  return r;
}

function verdict(role, pluginId, method, resource) {
  return broker.authorize(ctxOf(role, pluginId), method, resource === undefined ? null : resource);
}

if (broker) {
  ok('M1.1 broker 矩阵非空', broker.matrixKeys().length >= 40, 'keys=' + broker.matrixKeys().length);

  const runtimeMethods = extractHandlers(runtimeSrc);
  const bridgeMethods = extractBridgeMethods(bridgeSrc);
  const all = new Set([...runtimeMethods, ...bridgeMethods]);
  const unmapped = [...all].filter((m) => broker.kindOf(m) === '');
  ok('M1.2 每个 registerHandler 都有矩阵条目', runtimeMethods.size > 0 && unmapped.length === 0,
    'handlers=' + runtimeMethods.size + ' bridge=' + bridgeMethods.size + ' 未登记: ' + unmapped.join(', '));
  const bridgeUnmapped = [...bridgeMethods].filter((m) => broker.kindOf(m) === '');
  ok('M1.3 每个桥面方法都有矩阵条目', bridgeMethods.size >= 8 && bridgeUnmapped.length === 0,
    '未登记: ' + bridgeUnmapped.join(', '));

  section('M2 伪造场景（真实 broker）');
  // 匿名：只有 public 放行
  ok('M2.1 匿名+runtime.ready 放行（public）', verdict('anonymous', '', 'runtime.ready').allowed);
  ok('M2.2 匿名+vault.read 拒绝', !verdict('anonymous', '', 'vault.read').allowed);
  ok('M2.3 匿名+editor.state 拒绝', !verdict('anonymous', '', 'editor.state').allowed);
  ok('M2.4 匿名+ui.notice 拒绝', !verdict('anonymous', '', 'ui.notice').allowed);
  ok('M2.5 匿名+data.load 拒绝', !verdict('anonymous', '', 'data.load').allowed);
  // 控制面：仅会话
  ok('M2.6 会话+plugin.load 放行', verdict('session', '', 'plugin.load').allowed);
  ok('M2.7 插件角色+plugin.load 拒绝（控制面）', !verdict('plugin', 'plug-a', 'plugin.load').allowed);
  ok('M2.8 插件角色+plugin.unload 拒绝', !verdict('plugin', 'plug-a', 'plugin.unload').allowed);
  ok('M2.9 插件角色+theme.install 拒绝', !verdict('plugin', 'plug-a', 'theme.install').allowed);
  ok('M2.10 会话+theme.install 放行', verdict('session', '', 'theme.install').allowed);
  ok('M2.11 会话+note.write 放行', verdict('session', '', 'note.write').allowed);
  ok('M2.12 插件角色+note.write 拒绝', !verdict('plugin', 'plug-a', 'note.write').allowed);
  ok('M2.13 插件角色+workspace.saveLayout 拒绝', !verdict('plugin', 'plug-a', 'workspace.saveLayout').allowed);
  // 跨插件资源删除（RFC §4.5：一个插件不得删除另一插件的资源）
  ok('M2.14 插件A 删插件B 的命令 拒绝', !verdict('plugin', 'plug-a', 'commands.remove', res('plug-b')).allowed);
  ok('M2.15 插件A 删自己的命令 放行', verdict('plugin', 'plug-a', 'commands.remove', res('plug-a')).allowed);
  ok('M2.16 插件A 删无主资源 拒绝', !verdict('plugin', 'plug-a', 'views.remove', res('')).allowed);
  ok('M2.17 会话代管删除 放行', verdict('session', '', 'commands.remove', res('plug-b')).allowed);
  ok('M2.18 匿名+commands.remove 拒绝', !verdict('anonymous', '', 'commands.remove', res('plug-b')).allowed);
  ok('M2.19 插件A 注销插件B 的 codeblock 拒绝', !verdict('plugin', 'plug-a', 'codeblocks.unregister', res('plug-b')).allowed);
  ok('M2.20 插件A 关插件B 的视图 拒绝', !verdict('plugin', 'plug-a', 'workspace.closeView', res('plug-b')).allowed);
  ok('M2.21 插件A 关自己的视图 放行', verdict('plugin', 'plug-a', 'workspace.closeView', res('plug-a')).allowed);
  // fs 写能力
  ok('M2.22 fs插件+vault.modify 放行', verdict('plugin', 'fs-plugin', 'vault.modify').allowed);
  ok('M2.23 无fs插件+vault.modify 拒绝', !verdict('plugin', 'plug-a', 'vault.modify').allowed &&
    verdict('plugin', 'plug-a', 'vault.modify').code === 'ERR_PERMISSION_DENIED');
  ok('M2.24 会话+vault.modify 拒绝（写走 note.write）', !verdict('session', '', 'vault.modify').allowed);
  // editor 写：仅插件
  ok('M2.25 插件+editor.replace 放行', verdict('plugin', 'plug-a', 'editor.replace').allowed);
  ok('M2.26 会话+editor.replace 拒绝', !verdict('session', '', 'editor.replace').allowed);
  ok('M2.27 匿名+editor.applyChanges 拒绝', !verdict('anonymous', '', 'editor.applyChanges').allowed);
  // 读域
  ok('M2.28 会话+vault.files 放行（容器列文件）', verdict('session', '', 'vault.files').allowed);
  ok('M2.29 插件+metadata.get 放行', verdict('plugin', 'plug-a', 'metadata.get').allowed);
  // net / storage / source
  ok('M2.30 插件+net.requestUrl 放行（域白名单在 probe 二次把关）', verdict('plugin', 'plug-a', 'net.requestUrl').allowed);
  ok('M2.31 会话+net.requestUrl 拒绝', !verdict('session', '', 'net.requestUrl').allowed);
  ok('M2.32 插件+data.load 放行', verdict('plugin', 'plug-a', 'data.load').allowed);
  ok('M2.33 会话+data.save 拒绝', !verdict('session', '', 'data.save').allowed);
  ok('M2.34 会话+plugin.sourceChunk 拒绝', !verdict('session', '', 'plugin.sourceChunk').allowed);

  // --- M2b P2-003 capability gate seam(第二 broker 实例,注入 gate) ----------------
  // 主 broker 未注入 gate(M2.25 等)→ 既有行为保持;注入后插件角色按 manifest.v2 域判定。
  section('M2b capability gate(P2-003 seam)');
  const gatedBroker = new brokerMod.LexiPermissionBroker(
    (pluginId, method) => pluginId === 'fs-plugin',
    (pluginId, method) => pluginId === 'cap-ok' ||
      (pluginId === 'cap-partial' && (method === 'vault.read' || method === 'editor.replace')));
  const gverdict = (pluginId, method) => gatedBroker.authorize(ctxOf('plugin', pluginId), method);
  ok('M2.40 gate 放行 → fs-read 通过', gverdict('cap-ok', 'vault.read').allowed);
  ok('M2.41 gate 拒绝 → ERR_PERMISSION_DENIED 且原因点明 capability',
    !gverdict('cap-no', 'vault.read').allowed &&
    gverdict('cap-no', 'vault.read').code === 'ERR_PERMISSION_DENIED' &&
    gverdict('cap-no', 'vault.read').reason.indexOf('capability:') === 0,
    gverdict('cap-no', 'vault.read').reason);
  ok('M2.42 gate 按方法区分(vault.read 过,editor.state 拒)',
    gverdict('cap-partial', 'vault.read').allowed && !gverdict('cap-partial', 'editor.state').allowed);
  ok('M2.43 gate 拒绝 ui.notice(notifications 域)', !gverdict('cap-no', 'ui.notice').allowed);
  ok('M2.44 gate 拒绝 register(commands.add)', !gverdict('cap-no', 'commands.add').allowed);
  ok('M2.45 gate 拒绝 plugin-storage(data.save)', !gverdict('cap-no', 'data.save').allowed);
  ok('M2.46 会话不受 gate 影响(容器全权)',
    gatedBroker.authorize(ctxOf('session', ''), 'vault.read').allowed &&
    gatedBroker.authorize(ctxOf('session', ''), 'ui.notice').allowed);
  ok('M2.47 gate 未注入 → 既有纯角色行为保持(M2.25 同例)', verdict('plugin', 'plug-a', 'editor.replace').allowed);
  ok('M2.48 fs-write 仍走 fsAuthorizer(与 capabilityGate 两个 seam 互不干扰)',
    gverdict('fs-plugin', 'vault.modify').allowed && !gverdict('cap-ok', 'vault.modify').allowed);
  // 注册域：仅插件
  ok('M2.35 插件+commands.add 放行', verdict('plugin', 'plug-a', 'commands.add').allowed);
  ok('M2.36 会话+commands.add 拒绝', !verdict('session', '', 'commands.add').allowed);
  // 默认拒绝
  const unknown = verdict('plugin', 'plug-a', 'not.a.method');
  ok('M2.37 未知方法默认拒绝', !unknown.allowed && unknown.code === 'ERR_PERMISSION_DENIED' &&
    unknown.kind === 'unmapped');
  // 错误码区分
  ok('M2.38 角色错误=ERR_UNAUTHORIZED', verdict('plugin', 'plug-a', 'plugin.load').code === 'ERR_UNAUTHORIZED');
  ok('M2.39 归属错误=ERR_PERMISSION_DENIED', verdict('plugin', 'plug-a', 'commands.remove', res('plug-b')).code === 'ERR_PERMISSION_DENIED');
}

// ---------------------------------------------------------------- M3 接线
section('M3 接线');
ok('M3.1 call() 先过 broker', /broker\.authorize\(/.test(runtimeSrc) &&
  /private\s+async\s+call\(|async call\(/.test(runtimeSrc) &&
  (runtimeSrc.match(/broker\.authorize\(/g) || []).length >= 1,
  'LexiWebRuntime.call 必须经 broker.authorize 预检');
ok('M3.2 运行时持有 broker 实例', /new LexiPermissionBroker\(/.test(runtimeSrc), '缺少 broker 构造');
// 所有权敏感 handler 必须带 resource 复查（owner 查表 → authorize）
const ownershipSites = [
  ['commands.remove', /registerHandler\('commands\.remove'[\s\S]{0,600}?(?:authorize|authzFor)\(/],
  ['views.remove', /registerHandler\('views\.remove'[\s\S]{0,600}?(?:authorize|authzFor)\(/],
  ['events.off', /registerHandler\('events\.off'[\s\S]{0,600}?(?:authorize|authzFor)\(/],
  ['workspace.closeView', /registerHandler\('workspace\.closeView'[\s\S]{0,600}?(?:authorize|authzFor)\(/],
  ['codeblocks.unregister', /registerHandler\('codeblocks\.unregister'[\s\S]{0,600}?(?:authorize|authzFor)\(/]
];
for (const [method, re] of ownershipSites) {
  ok('M3.3 ' + method + ' 所有权复查', re.test(runtimeSrc), method + ' handler 必须带 resource 调 broker.authorize');
}
ok('M3.4 ui.addIcon 归属登记', /iconOwners/.test(runtimeSrc), '图标必须登记归属（防跨插件覆盖）');
ok('M3.5 events.on 登记订阅归属', /ownerPluginId|subscriptionOwner|owner:/.test(runtimeSrc) &&
  /registerHandler\('events\.on'[\s\S]{0,400}?(identity|owner)/.test(runtimeSrc),
  '订阅必须归属到调用插件，events.off 才有归属可查');
ok('M3.6 桥面 dispatch 接 broker', /broker\.authorize\(/.test(bridgeSrc) && /new LexiPermissionBroker\(/.test(bridgeSrc),
  'WorkspaceBridge 桥面方法必须经 broker');
ok('M3.7 fsGate 语义保留（v1 legacy + fail-closed）', /manifestFor\(/.test(runtimeSrc) &&
  /fail-closed|fail_closed/.test(runtimeSrc),
  'fs 判定的既有语义必须保留（broker 经 fsAuthorizer 注入）');

// ---------------------------------------------------------------- 汇总
console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-authz-matrix: PASS'
  : 'plugin-authz-matrix: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
