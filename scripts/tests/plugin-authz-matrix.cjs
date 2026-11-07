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
const GATEWAY_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiRpcGateway.ets');

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
let stagedDir = '';
function stageBroker() {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { throw new Error('需要 LEXI_TYPESCRIPT 指向 typescript 模块'); }
  const ts = require(tsPath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexinote-broker-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const options = { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } };
  fs.writeFileSync(path.join(dir, 'LexiPermissionBroker.js'),
    ts.transpileModule(fs.readFileSync(BROKER_ETS, 'utf8'), options).outputText);
  // P1-007:Gateway 与 broker 同目录落盘(相对 require('./LexiPermissionBroker') 可解析)。
  if (fs.existsSync(GATEWAY_ETS)) {
    fs.writeFileSync(path.join(dir, 'LexiRpcGateway.js'),
      ts.transpileModule(fs.readFileSync(GATEWAY_ETS, 'utf8'), options).outputText);
  }
  stagedDir = dir;
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

  // --- M2b-2 P2-005 editor 分级档位(readActive/writeSelection/writeDocument)逐档对账 ----
  // tag→tier→broker seam:editor.state→readActive;editor.selection→writeSelection;
  // editor.applyChanges→writeDocument;editor.replace→任一写档位(选区等值精判在宿主
  // handler 的 editorReplaceGate,broker 层只见方法——该精判的接线由 dist-regression 钉)。
  section('M2b-2 editor 分级档位(P2-005)');
  const tierBroker = new brokerMod.LexiPermissionBroker(
    (pluginId, method) => pluginId === 'fs-plugin',
    (pluginId, method) => {
      const tiers = {
        'ed-none': {},
        'ed-read': { 'editor.state': true },
        'ed-sel': { 'editor.state': true, 'editor.selection': true, 'editor.replace': true },
        'ed-doc': { 'editor.state': true, 'editor.replace': true, 'editor.applyChanges': true }
      };
      return !!(tiers[pluginId] && tiers[pluginId][method]);
    });
  const tverdict = (pluginId, method) => tierBroker.authorize(ctxOf('plugin', pluginId), method);
  ok('M2.50 未声明任何 editor 档 → editor.* 四方法全拒',
    !tverdict('ed-none', 'editor.state').allowed && !tverdict('ed-none', 'editor.replace').allowed &&
    !tverdict('ed-none', 'editor.selection').allowed && !tverdict('ed-none', 'editor.applyChanges').allowed);
  ok('M2.51 仅 readActive → editor.state 过,三写通道全拒(未声明 editor.write* 不能改文档)',
    tverdict('ed-read', 'editor.state').allowed && !tverdict('ed-read', 'editor.replace').allowed &&
    !tverdict('ed-read', 'editor.selection').allowed && !tverdict('ed-read', 'editor.applyChanges').allowed);
  ok('M2.52 writeSelection-only → replace/selection 域级过,applyChanges 拒',
    tverdict('ed-sel', 'editor.replace').allowed && tverdict('ed-sel', 'editor.selection').allowed &&
    !tverdict('ed-sel', 'editor.applyChanges').allowed);
  ok('M2.53 writeDocument-only → replace/applyChanges 过,selection 拒',
    tverdict('ed-doc', 'editor.replace').allowed && tverdict('ed-doc', 'editor.applyChanges').allowed &&
    !tverdict('ed-doc', 'editor.selection').allowed);
  ok('M2.54 editor 档位拒绝码=ERR_PERMISSION_DENIED 且原因点明 capability',
    !tverdict('ed-read', 'editor.replace').allowed &&
    tverdict('ed-read', 'editor.replace').code === 'ERR_PERMISSION_DENIED' &&
    tverdict('ed-read', 'editor.replace').reason.indexOf('capability:') === 0,
    tverdict('ed-read', 'editor.replace').reason);

  // --- M2c P2-011:全方法×全角色矩阵扫描(行为级 100% 对账,RFC §17.1) -------------
  // 不再逐条手写场景:对每个登记方法 × 角色真跑 authorize,结果必须符合 kind 语义表。
  // capability gate 未注入(既有 broker)——插件角色按纯角色语义判定(fs-write 见特例)。
  section('M2c 全矩阵扫描(P2-011:每方法×每角色)');
  const kindExpectation = {
    'public': ['anonymous', 'session', 'plugin', 'owner'],
    'control-plane': ['session'],
    'ui-domain': ['session', 'plugin', 'owner'],
    'fs-read': ['session', 'plugin', 'owner'],
    'fs-write': ['owner'],
    'editor-write': ['plugin', 'owner'],
    'register': ['plugin', 'owner'],
    'plugin-owned': ['session', 'owner'],
    'plugin-storage': ['plugin', 'owner'],
    'plugin-source': ['plugin', 'owner'],
    'net': ['plugin', 'owner'],
    'demo-plugin': ['plugin', 'owner']
  };
  const scanRoles = ['anonymous', 'session', 'plugin', 'owner'];
  let matrixCells = 0;
  const matrixBad = [];
  broker.matrixKeys().forEach((method) => {
    const kind = broker.kindOf(method);
    const allowedRoles = kindExpectation[kind];
    if (!allowedRoles) { matrixBad.push(method + '(未知 kind ' + kind + ')'); return; }
    for (const role of scanRoles) {
      let ctxRole = role;
      let pluginId = '';
      let resource = null;
      let expectAllowed = allowedRoles.indexOf(role) >= 0;
      if (role === 'plugin') { ctxRole = 'plugin'; pluginId = 'other-b'; }
      if (role === 'owner') { ctxRole = 'plugin'; pluginId = 'owner-a'; }
      if (kind === 'plugin-owned') {
        // plugin-owned 语义:调用方持有该资源才可删——统一拿"owner-a 的"资源:
        // owner 格(pluginId=owner-a)应放,plugin 格(other-b)应拒,session 代管应放。
        resource = res('owner-a');
      }
      if (kind === 'fs-write' && (role === 'plugin' || role === 'owner')) {
        // fs-write 由 fsAuthorizer 判定(仅 fs-plugin/legacy-plugin):两种插件身份都要对表。
        for (const candidate of ['other-b', 'fs-plugin']) {
          const decision = broker.authorize(ctxOf('plugin', candidate), method, resource);
          matrixCells += 1;
          const expectFs = candidate === 'fs-plugin';
          if (decision.allowed !== expectFs) {
            matrixBad.push(method + '[plugin:' + candidate + ']=' + decision.allowed);
          }
        }
        continue;
      }
      const decision = broker.authorize(ctxOf(ctxRole, pluginId), method, resource);
      matrixCells += 1;
      if (decision.allowed !== expectAllowed) {
        matrixBad.push(method + '[' + role + ']=' + decision.allowed + '(' + decision.code + ')');
      }
    }
  });
  ok('M2c.1 全矩阵行为对账(' + broker.matrixKeys().length + ' 方法 × 角色 = ' + matrixCells + ' 格)',
    matrixBad.length === 0, matrixBad.slice(0, 8).join('; '));
  ok('M2c.2 矩阵规模(§17.1 100% 对账基础)', broker.matrixKeys().length >= 40 && matrixCells >= 160,
    'methods=' + broker.matrixKeys().length + ' cells=' + matrixCells);
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

  // --- M2d P2-015 入口预检(entryAuthorize):plugin-owned 的归属判定必须在处理器层 ----
  // LexiWebRuntime.call 的预检拿不到 resource(资源键在载荷里,handler 查表后才有):
  // 预检 resource=null 直判会把插件身份的全部清理类调用误杀成"资源归属不明"
  // (设备证据 P4-005 cal_off:calendar 卸载 events.off/workspace.closeView 以合法身份
  // 被拒)。entryAuthorize 语义:plugin+plugin-owned → 放行进处理器(处理器 authzFor
  // 带 resource 复查,归属校验本身不放宽);anonymous → 照旧入口 fail-closed;
  // session → 照旧可代管;其余 kind 与 authorize(...,null) 逐格一致。
  section('M2d 入口预检 entryAuthorize(P2-015:清理类调用的身份链修复)');
  const entryVerdict = (role, pluginId, method) => broker.entryAuthorize(ctxOf(role, pluginId), method);
  ok('M2d.1 插件+commands.remove 入口放行(归属复查后置到处理器 authzFor)',
    entryVerdict('plugin', 'plug-a', 'commands.remove').allowed &&
    entryVerdict('plugin', 'plug-a', 'commands.remove').kind === 'plugin-owned');
  ok('M2d.2 插件+workspace.closeView 入口放行(同上)',
    entryVerdict('plugin', 'plug-a', 'workspace.closeView').allowed);
  ok('M2d.3 匿名+plugin-owned 入口照旧拒绝(fail-closed 不放宽)',
    !entryVerdict('anonymous', '', 'views.remove').allowed &&
    entryVerdict('anonymous', '', 'views.remove').code === 'ERR_UNAUTHORIZED');
  ok('M2d.4 会话+plugin-owned 入口照旧放行(代管语义不变)',
    entryVerdict('session', '', 'commands.remove').allowed);
  ok('M2d.5 插件+控制面入口照旧拒绝(预检不因 entryAuthorize 松动)',
    !entryVerdict('plugin', 'plug-a', 'plugin.load').allowed &&
    !entryVerdict('plugin', 'plug-a', 'plugin.unload').allowed);
  ok('M2d.6 未知方法入口照旧默认拒绝', !entryVerdict('plugin', 'plug-a', 'not.a.method').allowed);
  ok('M2d.7 匿名+敏感域入口照旧拒绝(ui.notice/vault.read)',
    !entryVerdict('anonymous', '', 'ui.notice').allowed &&
    !entryVerdict('anonymous', '', 'vault.read').allowed);
  ok('M2d.8 非 plugin-owned 方法:entryAuthorize 与 authorize(...,null) 全矩阵逐格一致', (() => {
    let cells = 0;
    const bad = [];
    for (const method of broker.matrixKeys()) {
      if (broker.kindOf(method) === 'plugin-owned') { continue; }
      for (const role of ['anonymous', 'session', 'plugin']) {
        const pluginId = role === 'plugin' ? 'plug-a' : '';
        const entry = broker.entryAuthorize(ctxOf(role, pluginId), method);
        const direct = broker.authorize(ctxOf(role, pluginId), method, null);
        cells += 1;
        if (entry.allowed !== direct.allowed || entry.code !== direct.code) {
          bad.push(method + '[' + role + ']');
        }
      }
    }
    return cells >= 100 && bad.length === 0;
  })());
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
ok('M3.6 桥面 dispatch 接单一 Gateway(P1-007 归一:桥内第二 broker 实例删除)',
  /LexiRpcGateway\.shared/.test(bridgeSrc) && !/new LexiPermissionBroker\(/.test(bridgeSrc) &&
  /rpcGateway\.authorize\(ctx, method, null\)/.test(bridgeSrc),
  'WorkspaceBridge 桥面方法必须经 LexiRpcGateway.shared(全应用唯一 broker 实例)');
ok('M3.7 fsGate 语义保留（v1 legacy + fail-closed）', /manifestFor\(/.test(runtimeSrc) &&
  /fail-closed|fail_closed/.test(runtimeSrc),
  'fs 判定的既有语义必须保留（broker 经 fsAuthorizer 注入）');

// ------------------------------------------------- M4 RPC 入口归一(P1-007 单一 Gateway)
// 验收行:「100% RPC 经同一入口;契约测试对账」。三类前门(lexiHost.call / 沙箱容器页+
// 端口帧 / 桥 delegate)全部收敛到单一 Gateway;未知方法与敏感家族 payload schema 在
// 入口双闸显式拒绝;授权判定全应用只此一份 broker 实例(runtime+bridge 两实例合并)。
section('M4 RPC 入口归一(P1-007:单一 Gateway = 授权+分发唯一收口)');
const gatewaySrc = fs.existsSync(GATEWAY_ETS) ? fs.readFileSync(GATEWAY_ETS, 'utf8') : '';
ok('M4.0a Gateway 模块存在(纯逻辑,零 @kit 依赖)', gatewaySrc.length > 0 && !/from '@kit/.test(gatewaySrc),
  'LexiRpcGateway.ets 必须存在且可在 Node 转译求值');
let gw = null;
let gwMod = null;
try {
  gwMod = require(path.join(stagedDir, 'LexiRpcGateway.js'));
  gw = gwMod.LexiRpcGateway.shared;
  ok('M4.0b Gateway 可转译求值且单例可用', !!gw && gw === gwMod.LexiRpcGateway.shared);
} catch (error) {
  ok('M4.0b Gateway 可转译求值且单例可用', false, 'threw: ' + error.message);
}
if (gw) {
  // --- 行为级:入口双闸(真实 Gateway 求值) ---
  ok('M4.1 未知方法显式拒绝(unknown_method,不再静默 undefined)', (() => {
    const reply = gw.entryReject('not.a.method', '{}');
    let parsed = {};
    try { parsed = JSON.parse(reply); } catch (e) { return false; }
    return parsed.ok === false && parsed.code === 'unknown_method' &&
      String(parsed.error).indexOf('not.a.method') >= 0;
  })());
  // 与真实 runtime 一致:schema 覆盖的每个方法都是已登记 handler——先登记再验双闸。
  const schemaMethods = ['vault.getByPath', 'vault.read', 'vault.modify', 'vault.create', 'vault.delete',
    'vault.rename', 'vault.append', 'metadata.get', 'editor.replace', 'editor.selection',
    'editor.applyChanges', 'net.requestUrl', 'commands.add', 'commands.remove', 'commands.execute',
    'data.save'];
  for (const method of schemaMethods) { gw.registerHandler(method, async () => '{}'); }
  gw.registerHandler('runtime.ready', async () => '{}');
  ok('M4.2 已登记方法+合法载荷放行(entryReject 回空串)',
    gw.entryReject('vault.read', JSON.stringify({ path: 'notes/a.md' })) === '' &&
    gw.entryReject('runtime.ready', '{}') === '');
  // schema 负例族:每个敏感家族至少一条(缺必需字段/类型不符/非对象载荷)。
  const schemaNegative = (method, payloadJson) => {
    const reply = gw.entryReject(method, payloadJson);
    let parsed = {};
    try { parsed = JSON.parse(reply); } catch (e) { return null; }
    return parsed;
  };
  ok('M4.3 fs/vault 负例:vault.modify 缺 data / vault.rename 缺 newPath',
    schemaNegative('vault.modify', JSON.stringify({ path: 'a.md' })).code === 'bad_request' &&
    schemaNegative('vault.rename', JSON.stringify({ path: 'a.md' })).code === 'bad_request');
  ok('M4.4 editor 负例:editor.replace 缺 text / editor.applyChanges changes 非数组',
    schemaNegative('editor.replace', JSON.stringify({ start: 0, end: 1 })).code === 'bad_request' &&
    schemaNegative('editor.applyChanges', JSON.stringify({ changes: 'x' })).code === 'bad_request');
  ok('M4.5 network 负例:net.requestUrl 缺 url',
    schemaNegative('net.requestUrl', '{}').code === 'bad_request');
  ok('M4.6 commands 负例:commands.execute 缺 id / commands.add 缺 command / commands.remove 缺 fullId',
    schemaNegative('commands.execute', '{}').code === 'bad_request' &&
    schemaNegative('commands.add', '{}').code === 'bad_request' &&
    schemaNegative('commands.remove', '{}').code === 'bad_request');
  ok('M4.7 data 负例:data.save 缺 dataJson',
    schemaNegative('data.save', '{}').code === 'bad_request');
  ok('M4.8 类型违例:vault.read path 非字符串 / 非对象载荷',
    schemaNegative('vault.read', JSON.stringify({ path: 42 })).code === 'bad_request' &&
    schemaNegative('vault.read', '[1]').code === 'bad_request' &&
    schemaNegative('vault.read', '{not-json').code === 'bad_request');
  ok('M4.9 schema 正例(各家族合法载荷零拦截)', (() => {
    gw.registerHandler('vault.modify', async () => '{}');
    gw.registerHandler('vault.rename', async () => '{}');
    gw.registerHandler('editor.replace', async () => '{}');
    gw.registerHandler('editor.applyChanges', async () => '{}');
    gw.registerHandler('net.requestUrl', async () => '{}');
    gw.registerHandler('commands.execute', async () => '{}');
    gw.registerHandler('commands.add', async () => '{}');
    gw.registerHandler('data.save', async () => '{}');
    return gw.entryReject('vault.modify', JSON.stringify({ path: 'a.md', data: 'x' })) === '' &&
      gw.entryReject('vault.rename', JSON.stringify({ path: 'a.md', newPath: 'b.md' })) === '' &&
      gw.entryReject('editor.replace', JSON.stringify({ start: 0, end: 1, text: 'x' })) === '' &&
      gw.entryReject('editor.applyChanges', JSON.stringify({ changes: [] })) === '' &&
      gw.entryReject('net.requestUrl', JSON.stringify({ url: 'https://a' })) === '' &&
      gw.entryReject('commands.execute', JSON.stringify({ id: 'x' })) === '' &&
      gw.entryReject('commands.add', JSON.stringify({ command: { id: 'x' } })) === '' &&
      gw.entryReject('data.save', JSON.stringify({ dataJson: '{}' })) === '';
  })());
  ok('M4.10 双闸先于身份解析(伪造身份同样先撞入口闸)', (() => {
    // entryReject 不接收任何身份实参——签名即证据:入口校验在凭据解析之前。
    return gw.entryReject.length === 2 && gw.entryReject('ghost.method', '{}').indexOf('unknown_method') > 0;
  })());
  ok('M4.11 authorize 单一收口(Gateway 持有的 broker 与直连判定逐格一致)', (() => {
    gw.attachBroker(broker);
    const viaGateway = gw.authorize(ctxOf('plugin', 'plug-a'), 'plugin.load');
    const direct = broker.authorize(ctxOf('plugin', 'plug-a'), 'plugin.load');
    return !viaGateway.allowed && !direct.allowed &&
      viaGateway.code === direct.code && gw.broker() === broker;
  })());
  ok('M4.12 dispatch 面归一(host→页只许投递已登记页侧方法)',
    gw.dispatchSurfaceReject('event') === '' &&
    gw.dispatchSurfaceReject('invoke.command') === '' &&
    gw.dispatchSurfaceReject('load.plugin') === '' &&
    gw.dispatchSurfaceReject('bogus.push').length > 0);
  ok('M4.13 handler 表归 Gateway(handlerOf/hasHandler/计数)',
    gw.hasHandler('vault.read') && gw.handlerOf('ghost') === null &&
    typeof gw.handlerOf('vault.read') === 'function' && gw.handlerCount() >= 2);
  // --- 静态收敛:前门 → Gateway 的接线 ---
  const componentSources = {};
  for (const comp of ['LexiPluginRuntimeHost', 'LexiPluginViewSlot', 'LexiPluginCodeBlockSlot', 'LexiSandboxContainerHost']) {
    const compPath = path.join(ROOT, 'entry/src/main/ets/components/plugin', comp + '.ets');
    componentSources[comp] = fs.existsSync(compPath) ? fs.readFileSync(compPath, 'utf8') : '';
  }
  ok('M4.14 三类 javaScriptProxy 面全绑 runtime/sandboxProxy(无旁路对象)',
    /object: this\.manager\.runtime/.test(componentSources.LexiPluginRuntimeHost) &&
    /'call', 'admitDispatch'/.test(componentSources.LexiPluginRuntimeHost) &&
    /object: LexiPluginManager\.shared!\.runtime/.test(componentSources.LexiPluginViewSlot) &&
    /object: LexiPluginManager\.shared!\.runtime/.test(componentSources.LexiPluginCodeBlockSlot) &&
    /object: this\.manager\.sandboxProxy/.test(componentSources.LexiSandboxContainerHost));
  ok('M4.15 端口帧/沙箱容器页经 callFromPort→call 同一漏斗',
    /callFromPort\('sbx-' \+ gateway\.requestId/.test(runtimeSrc) &&
    /callFromPort\('ctxport-' \+ gateway\.requestId/.test(runtimeSrc));
  ok('M4.16 runtime 持有 shared Gateway 且 broker 字段降级为转发访问器',
    /readonly rpcGateway: LexiRpcGateway = LexiRpcGateway\.shared/.test(runtimeSrc) &&
    /get broker\(\): LexiPermissionBroker \{ return this\.rpcGateway\.broker\(\); \}/.test(runtimeSrc) &&
    /set broker\(replacement: LexiPermissionBroker\) \{ this\.rpcGateway\.attachBroker\(replacement\); \}/.test(runtimeSrc) &&
    !/broker: LexiPermissionBroker = new LexiPermissionBroker/.test(runtimeSrc));
  ok('M4.17 call() 入口双闸接线(unknown/schema 先于身份解析)',
    /const entryReject: string = this\.rpcGateway\.entryReject\(method, payloadJson\);/.test(runtimeSrc) &&
    /const handler = this\.rpcGateway\.handlerOf\(method\);/.test(runtimeSrc) &&
    /rpcGateway\.registerHandler\(method, handler/.test(runtimeSrc));
  ok('M4.18 dispatch 面接线(host→页未知方法显式抛错)',
    /const surfaceReject: string = this\.rpcGateway\.dispatchSurfaceReject\(method\);/.test(runtimeSrc));
  ok('M4.19 全应用 broker 构造点对账(bridge 0 / runtime 1=init 注入 / gateway 1=默认)',
    (bridgeSrc.match(/new LexiPermissionBroker\(/g) || []).length === 0 &&
    (runtimeSrc.match(/new LexiPermissionBroker\(/g) || []).length === 1 &&
    (gatewaySrc.match(/new LexiPermissionBroker\(/g) || []).length === 1);
  ok('M4.20 init 注入仍落 Gateway(唯一实例换血,不另立实例)',
    /this\.runtime\.broker = new LexiPermissionBroker\(/.test(runtimeSrc));
  ok('M4.21 委托路径收敛(WorkspaceBridge delegate→runtime.call→Gateway)',
    /manager\.runtime\.call\('', method, JSON\.stringify\(forwarded\), credential\)/.test(bridgeSrc));
}

// ---------------------------------------------------------------- 汇总
console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-authz-matrix: PASS'
  : 'plugin-authz-matrix: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
