'use strict';
// RFC §14 T1.3 API Contract v1 · 三方一致门禁。
//
// 验收目标（RFC：类型声明、宿主处理器和测试三方一致）：
//   C1 版本三方锚点：api-version.json == 宿主 PLUGIN_API_VERSION == shim API_VERSION
//      （门禁重新从源码推导，不信任快照）。
//   C2 方法全集对账：api-surface.json 的 methods == 实时推导(registerHandler ∪ 桥面方法)
//      == broker 授权矩阵 keys。任一漂移=红；刷新走 generators/sync-contract.cjs。
//   C3 能力映射对账：capability-map.json 每条 kind == 真实 broker.kindOf(method)。
//   C4 类型声明面：模板 d.ts 必须引用契约目录锚点，且其声明的关键 API 在契约里有条目
//      （loadData/saveData→data.*、addCommand→commands.*、requestUrl→net.*、Notice→ui.*）。
//   C5 状态语义：stable 方法必须有宿主处理器（不允类型声明稳定而宿主缺失）。
//
// 用法：node scripts/tests/plugin-contract-tripod.cjs
// 依赖：LEXI_TYPESCRIPT

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const CONTRACT = path.join(ROOT, 'tools', 'plugin-contract');
const RUNTIME = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginRuntime.ets');
const BRIDGE = path.join(ROOT, 'entry/src/main/ets/workspace/WorkspaceBridge.ets');
const MANIFEST = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginManifest.ets');
const SHIM = path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_plugin_shim.js');
const TEMPLATE_DTS = path.join(ROOT, 'tools/lexinote-plugin-template/lexinote.d.ts');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

const read = (p) => fs.readFileSync(p, 'utf8');
const runtimeSrc = read(RUNTIME);
const bridgeSrc = read(BRIDGE);
const manifestSrc = read(MANIFEST);
const shimSrc = read(SHIM);

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
  while ((m = re.exec(src)) !== null) { set.add(m[1]); }
  for (const t of ['theme.config', 'theme.list', 'theme.load', 'theme.install', 'theme.setActive']) {
    if (src.indexOf("'" + t + "'") >= 0) { set.add(t); }
  }
  return set;
}
function loadBroker() {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { throw new Error('需要 LEXI_TYPESCRIPT 指向 typescript 模块'); }
  const ts = require(tsPath);
  const js = ts.transpileModule(read(path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPermissionBroker.ets')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: 'LexiPermissionBroker.ets' })(
    () => { throw new Error('broker 必须零依赖'); }, mod, mod.exports);
  return new mod.exports.LexiPermissionBroker(() => false);
}

const hostMethods = extractHandlers(runtimeSrc);
const bridgeMethods = extractBridgeMethods(bridgeSrc);
const derivedMethods = new Set([...hostMethods, ...bridgeMethods]);

let broker = null;
try {
  broker = loadBroker();
  ok('C0 broker 可转译求值', !!broker);
} catch (error) {
  ok('C0 broker 可转译求值', false, 'threw: ' + error.message);
}

section('C1 版本三方锚点');
let apiVersion = null;
let surface = null;
let capabilityMap = null;
try {
  apiVersion = JSON.parse(read(path.join(CONTRACT, 'api-version.json')));
  surface = JSON.parse(read(path.join(CONTRACT, 'api-surface.json')));
  capabilityMap = JSON.parse(read(path.join(CONTRACT, 'capability-map.json')));
  ok('C1.0 三份契约快照存在', true);
} catch (error) {
  ok('C1.0 三份契约快照存在', false, 'threw: ' + error.message);
}
{
  const manifestVer = (manifestSrc.match(/PLUGIN_API_VERSION:\s*string\s*=\s*'([^']+)'/) || [])[1] || '';
  const shimVer = (shimSrc.match(/var API_VERSION = '([^']+)'/) || [])[1] || '';
  ok('C1.1 宿主/垫片版本常量一致', manifestVer.length > 0 && manifestVer === shimVer,
    'manifest=' + manifestVer + ' shim=' + shimVer);
  ok('C1.2 api-version.json 与源码常量一致', apiVersion !== null && apiVersion.apiVersion === manifestVer &&
    apiVersion.parity && apiVersion.parity.manifestConstant === manifestVer && apiVersion.parity.shimConstant === shimVer);
}

section('C2 方法全集对账');
if (surface && broker) {
  const snapMethods = new Set(surface.methods.map((m) => m.method));
  const brokerKeys = new Set(broker.matrixKeys());
  const missingInSnap = [...derivedMethods].filter((m) => !snapMethods.has(m));
  const extraInSnap = [...snapMethods].filter((m) => !derivedMethods.has(m));
  ok('C2.1 快照 == 实时推导(无缺无多)', missingInSnap.length === 0 && extraInSnap.length === 0,
    '缺: ' + missingInSnap.join(', ') + ' | 多: ' + extraInSnap.join(', '));
  const missingInBroker = [...derivedMethods].filter((m) => broker.kindOf(m) === '');
  ok('C2.2 broker 矩阵覆盖全部方法(默认拒绝是兜底不是登记)', missingInBroker.length === 0,
    '未登记: ' + missingInBroker.join(', '));
  const surfaceVsBroker = [...snapMethods].filter((m) => !brokerKeys.has(m));
  ok('C2.3 快照与 broker 矩阵同集', surfaceVsBroker.length === 0,
    '快照多出: ' + surfaceVsBroker.join(', '));
  ok('C2.4 宿主处理器逐条在快照中', hostMethods.size > 0 &&
    [...hostMethods].every((m) => snapMethods.has(m)));
}

section('C3 能力映射对账');
if (capabilityMap && broker) {
  const capMap = new Map(capabilityMap.capabilities.map((c) => [c.method, c.kind]));
  const brokerKeys = broker.matrixKeys();
  let mismatched = [];
  let missing = [];
  for (const method of brokerKeys) {
    if (!capMap.has(method)) { missing.push(method); continue; }
    if (capMap.get(method) !== broker.kindOf(method)) { mismatched.push(method + '(' + capMap.get(method) + '≠' + broker.kindOf(method) + ')'); }
  }
  ok('C3.1 capability-map 与真实 broker 逐条一致', missing.length === 0 && mismatched.length === 0,
    '缺: ' + missing.join(', ') + ' | 漂移: ' + mismatched.join(', '));
  ok('C3.2 capability-map 无多余条目', capMap.size === brokerKeys.length,
    'map=' + capMap.size + ' broker=' + brokerKeys.length);
}

section('C4 类型声明面(模板 d.ts)');
{
  ok('C4.0 模板 d.ts 存在', fs.existsSync(TEMPLATE_DTS));
  const dts = fs.existsSync(TEMPLATE_DTS) ? read(TEMPLATE_DTS) : '';
  ok('C4.1 d.ts 引用契约目录锚点', dts.indexOf('tools/plugin-contract') >= 0 &&
    dts.indexOf('api-version.json') >= 0);
  const spotChecks = [
    ['loadData', 'data.load'], ['saveData', 'data.save'], ['addCommand', 'commands.add'],
    ['requestUrl', 'net.requestUrl'], ['Notice', 'ui.notice']
  ];
  for (const [dtsName, method] of spotChecks) {
    ok('C4.2 d.ts 声明 ' + dtsName + ' 且契约有 ' + method,
      dts.indexOf(dtsName) >= 0 && surface !== null &&
      surface.methods.some((m) => m.method === method));
  }
}

section('C5 状态语义');
if (surface) {
  const stableWithoutHandler = surface.methods.filter((m) => m.status === 'stable' && !m.hostHandler && !m.bridge);
  ok('C5.1 stable 方法必有宿主处理器或桥面实现', stableWithoutHandler.length === 0,
    stableWithoutHandler.map((m) => m.method).join(', '));
  const domains = new Set(surface.methods.map((m) => m.domain));
  ok('C5.2 域分布覆盖 RFC §6.2 核心模块', ['vault', 'metadata', 'workspace', 'editor', 'commands', 'storage', 'ui', 'network']
    .every((d) => domains.has(d)), '实际域: ' + [...domains].sort().join(', '));
}

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-contract-tripod: PASS'
  : 'plugin-contract-tripod: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
