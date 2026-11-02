'use strict';
// RFC §14 T4.3 Marketplace 规模回归 + T4.4 Update/Rollback 策略 · 门禁。
//
// T4.3（§9.5）：20 条规模索引解析/查询/安装映射——"已安装 8/20 时远端仍可滚动、可搜索、可安装"
// 的离线模型级验收（设备滚动 UI 归设备批次）。
// T4.4（§9.4/§12.3）：更新策略纯判定——同版本换字节拒绝(不可变)/降级拒绝/权限变化重授权/撤销命中拒绝。
//
// 用法：node scripts/tests/plugin-update-policy.cjs
// 依赖：LEXI_TYPESCRIPT

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const MARKET_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginMarketModel.ets');
const POLICY_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiUpdatePolicy.ets');
const INSTALLER_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginInstaller.ets');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

function stage(file) {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { throw new Error('需要 LEXI_TYPESCRIPT 指向 typescript 模块'); }
  const ts = require(tsPath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexinote-upd-'));
  let src = fs.readFileSync(file, 'utf8');
  src = src.replace(/from '\.\/LexiPluginManifest'/g, "from './LexiPluginManifest.ts'");
  const outDir = path.join(dir, 'mod');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, path.basename(file).replace(/\.ets$/, '.ts')), src);
  // manifest 依赖一并携带(市场模型引用其错误码;T2.1 起 manifest 引 LexiPluginManifestV2)
  const copyAndPatch = (name) => {
    let dep = fs.readFileSync(path.join(ROOT, 'entry/src/main/ets/core/plugin', name + '.ets'), 'utf8');
    dep = dep.replace(/from '\.\/LexiPluginManifestV2'/g, "from './LexiPluginManifestV2.ts'");
    fs.writeFileSync(path.join(outDir, name + '.ts'), dep);
  };
  copyAndPatch('LexiPluginManifest');
  copyAndPatch('LexiPluginManifestV2');
  return path.join(outDir, path.basename(file).replace(/\.ets$/, '.ts'));
}

let marketMod = null;
let policyMod = null;
try {
  marketMod = require(stage(MARKET_ETS));
  ok('M0 市场模型可转译求值', !!marketMod.parseMarketIndexResult);
} catch (error) {
  ok('M0 市场模型可转译求值', false, 'threw: ' + error.message);
}
try {
  policyMod = require(stage(POLICY_ETS));
  ok('U0 更新策略可转译求值', !!policyMod.LexiUpdatePolicy);
} catch (error) {
  ok('U0 更新策略可转译求值', false, 'threw: ' + error.message);
}

// ------------------------------------------------- T4.3 市场规模
if (marketMod) {
  section('M1 20 条规模索引');
  const fakeSha = (seed) => {
    // 确定性 64 位小写十六进制(模型校验 sha256 格式)
    let hex = '';
    let x = seed;
    for (let i = 0; i < 64; i++) { x = (x * 1103515245 + 12345) % 2147483648; hex += (x % 16).toString(16); }
    return hex;
  };
  const entries = [];
  for (let i = 1; i <= 20; i++) {
    const id = (i < 10 ? 'scale-plugin-0' : 'scale-plugin-') + i;
    entries.push({
      id, name: '规模插件 ' + i, version: '1.' + i + '.0', author: 'scale',
      description: '规模回归条目 ' + i, zipUrl: 'https://market.example.com/' + id + '.zip',
      sha256: fakeSha(i)
    });
  }
  const index = JSON.stringify({ schemaVersion: 1, updatedAt: '2026-11-03', plugins: entries });
  const result = marketMod.parseMarketIndexResult(index);
  ok('M1.1 20 条索引解析成功', result.ok === true && result.entries.length === 20,
    result.ok ? '' : result.message);
  if (result.ok) {
    const byId = new Map(result.entries.map((e) => [e.id, e]));
    ok('M1.2 第 8/20 条可寻址(规模定位)', byId.has('scale-plugin-08') && byId.has('scale-plugin-20'));
    const eighth = byId.get('scale-plugin-08');
    ok('M1.3 安装映射完整(zipUrl+sha256)', eighth !== undefined &&
      eighth.zipUrl.indexOf('https://') === 0 && /^[0-9a-f]{64}$/.test(eighth.sha256));
    const searched = result.entries.filter((e) => e.name.indexOf('规模插件 1') === 0);
    ok('M1.4 查询过滤可用(1 与 10-19 命中)', searched.length === 11);
  }
  const dup = JSON.stringify({ schemaVersion: 1, plugins: [
    { id: 'dup', name: 'A', version: '1.0.0', author: 't' },
    { id: 'dup', name: 'B', version: '1.0.0', author: 't' }
  ] });
  const dupResult = marketMod.parseMarketIndexResult(dup);
  ok('M1.5 重复 id 拒绝(安装映射唯一)', dupResult.ok === false || dupResult.entries.length === 1);
}

// ------------------------------------------------- T4.4 更新策略
if (policyMod) {
  section('U1 更新策略');
  const Policy = policyMod.LexiUpdatePolicy;
  const diff = (oldTags, newTags) => {
    const added = newTags.filter((t) => oldTags.indexOf(t) < 0);
    const removed = oldTags.filter((t) => newTags.indexOf(t) < 0);
    return { changed: added.length + removed.length > 0, added, removed };
  };
  {
    const d = Policy.decide({ installedVersion: '1.0.0', installedSha256: 'h1', incomingVersion: '1.0.0',
      incomingSha256: 'h2', oldCaps: ['vault.write'], newCaps: ['vault.write'],
      revoked: [], permissionDiff: diff(['vault.write'], ['vault.write']) });
    ok('U1.1 同版本换字节拒绝(§9.4 不可变)', d.ok === false && d.code === 'ERR_PACKAGE_INVALID', d.reason);
  }
  {
    const d = Policy.decide({ installedVersion: '1.0.0', installedSha256: 'h1', incomingVersion: '1.0.0',
      incomingSha256: 'h1', oldCaps: [], newCaps: [], revoked: [], permissionDiff: diff([], []) });
    ok('U1.2 同版本同字节幂等放行', d.ok === true);
  }
  {
    const d = Policy.decide({ installedVersion: '2.0.0', installedSha256: 'h1', incomingVersion: '1.0.0',
      incomingSha256: 'h2', oldCaps: [], newCaps: [], revoked: [], permissionDiff: diff([], []) });
    ok('U1.3 降级拒绝(ERR_DOWNGRADE_BLOCKED 语义)', d.ok === false && d.code === 'ERR_DOWNGRADE_BLOCKED');
  }
  {
    const d = Policy.decide({ installedVersion: '1.0.0', installedSha256: 'h1', incomingVersion: '1.1.0',
      incomingSha256: 'h2', oldCaps: ['vault.write'], newCaps: ['vault.write', 'network:api.example.com'],
      revoked: [], permissionDiff: diff(['vault.write'], ['vault.write', 'network:api.example.com']) });
    ok('U1.4 升级新增权限 → regrant-required(§9.5/T2.2)', d.ok === false && d.code === 'ERR_PERMISSION_REGRANT_REQUIRED',
      d.reason);
  }
  {
    const d = Policy.decide({ installedVersion: '1.0.0', installedSha256: 'h1', incomingVersion: '1.1.0',
      incomingSha256: 'h2', oldCaps: ['vault.write'], newCaps: ['vault.write'],
      revoked: [], permissionDiff: diff(['vault.write'], ['vault.write']) });
    ok('U1.5 升级权限未变 → 放行', d.ok === true);
  }
  {
    const d = Policy.decide({ installedVersion: '', installedSha256: '', incomingVersion: '1.0.0',
      incomingSha256: 'h1', oldCaps: [], newCaps: ['vault.write'],
      revoked: [], permissionDiff: diff([], ['vault.write']) });
    ok('U1.6 首次安装走启用即授权(T2.2),不被策略拦', d.ok === true);
  }
  {
    const d = Policy.decide({ installedVersion: '1.0.0', installedSha256: 'h1', incomingVersion: '1.1.0',
      incomingSha256: 'h2', oldCaps: [], newCaps: [], revoked: ['plug-a@1.1.0', 'plug-a@*'],
      pluginId: 'plug-a', permissionDiff: diff([], []) });
    ok('U1.7 撤销列表命中拒绝(§9.2 恶意版本下架)', d.ok === false && d.code === 'ERR_SIGNATURE_INVALID', d.reason);
  }
}

section('W1 接线');
const installerSrc = fs.existsSync(INSTALLER_ETS) ? fs.readFileSync(INSTALLER_ETS, 'utf8') : '';
ok('W1.1 安装器已有降级防护(既有语义)', /ERROR_DOWNGRADE_BLOCKED/.test(installerSrc));
ok('W1.2 安装器接入更新策略', /LexiUpdatePolicy/.test(installerSrc),
  'installExtracted/升级入口必须过 Policy.decide');

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-update-policy: PASS'
  : 'plugin-update-policy: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
