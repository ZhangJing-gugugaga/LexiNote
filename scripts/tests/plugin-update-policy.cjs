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
const RUNTIME_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginRuntime.ets');
const REGISTRY_TRUST_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiRegistryTrust.ets');
const SHEET_ETS = path.join(ROOT, 'entry/src/main/ets/components/plugin/LexiPluginMarketSheet.ets');

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
  // ------------------------------------------------- P5-010 同版本拒绝语义对称化
  section('U2 同版本拒绝语义对称(P5-010,Round 7 不对称修正)');
  {
    const d = Policy.decide({ installedVersion: '1.0.0', installedSha256: 'h1', incomingVersion: '1.0.0',
      incomingSha256: 'h1', oldCaps: [], newCaps: [], revoked: [], permissionDiff: diff([], []) });
    ok('U2.1 同版本同包哈希(记录=声明)幂等放行——安装/更新两向一致', d.ok === true, d.reason);
  }
  {
    const d = Policy.decide({ installedVersion: '1.0.0', installedSha256: 'h1', incomingVersion: '1.0.0',
      incomingSha256: 'h2', oldCaps: [], newCaps: [], revoked: [], permissionDiff: diff([], []) });
    ok('U2.2 同版本包哈希不同 → ERR_PACKAGE_INVALID(真·字节替换证据)', d.ok === false && d.code === 'ERR_PACKAGE_INVALID',
      d.reason);
  }
  {
    const d = Policy.decide({ installedVersion: '1.0.0', installedSha256: 'h1', incomingVersion: '1.0.0',
      incomingSha256: '', oldCaps: [], newCaps: [], revoked: [], permissionDiff: diff([], []) });
    ok('U2.3 侧载(未声明哈希)同版本拒绝,理由如实=「无法证明一致」而非「不同字节」',
      d.ok === false && d.code === 'ERR_PACKAGE_INVALID' && d.reason.indexOf('无法证明') >= 0
      && d.reason.indexOf('不同字节') < 0, d.reason);
  }
  {
    const d = Policy.decide({ installedVersion: '1.0.0', installedSha256: '', incomingVersion: '1.0.0',
      incomingSha256: 'h2', oldCaps: [], newCaps: [], revoked: [], permissionDiff: diff([], []) });
    ok('U2.4 已装版本缺包哈希记录时声明哈希不可比 → 如实拒绝',
      d.ok === false && d.code === 'ERR_PACKAGE_INVALID' && d.reason.indexOf('缺少包哈希记录') >= 0, d.reason);
  }
  {
    const d = Policy.decide({ installedVersion: '1.0.0', installedSha256: '', incomingVersion: '1.1.0',
      incomingSha256: '', oldCaps: ['vault.write'], newCaps: ['vault.write'],
      revoked: [], permissionDiff: diff(['vault.write'], ['vault.write']) });
    ok('U2.5 升级路径不依赖哈希证据(缺记录照常放行,不对称只收敛在同版本口)', d.ok === true, d.reason);
  }
}

// ------------------------------------------------- RFC §9.2 十五步对账(P5-010)
// 每步一条断言:行为级(转译真跑)优先,宿主接线用源锚。S3 是诚实项——发布者身份
// 验证(TUF)接线归 P5-002,本轮只证"接缝在位 + UI 如实披露自述哈希≠来源"。
(function reconcileFifteenSteps() {
  section('U3 RFC §9.2 十五步对账(更新与回滚闭环)');
  const Policy = policyMod ? policyMod.LexiUpdatePolicy : null;
  const diff = (oldTags, newTags) => {
    const added = newTags.filter((t) => oldTags.indexOf(t) < 0);
    const removed = oldTags.filter((t) => newTags.indexOf(t) < 0);
    return { changed: added.length + removed.length > 0, added, removed };
  };
  const runtimeSrc = fs.existsSync(RUNTIME_ETS) ? fs.readFileSync(RUNTIME_ETS, 'utf8') : '';
  const installerSrc = fs.existsSync(INSTALLER_ETS) ? fs.readFileSync(INSTALLER_ETS, 'utf8') : '';
  const sheetSrc = fs.existsSync(SHEET_ETS) ? fs.readFileSync(SHEET_ETS, 'utf8') : '';
  const trustSrc = fs.existsSync(REGISTRY_TRUST_ETS) ? fs.readFileSync(REGISTRY_TRUST_ETS, 'utf8') : '';
  const installBody = (() => {
    const start = installerSrc.indexOf('async installExtracted(');
    const end = installerSrc.indexOf('private tryRestore(');
    return start >= 0 && end > start ? installerSrc.slice(start, end) : installerSrc;
  })();
  const fromUrlBody = (() => {
    const start = runtimeSrc.indexOf('async installFromUrl(');
    const end = runtimeSrc.indexOf('async uninstallPlugin(');
    return start >= 0 && end > start ? runtimeSrc.slice(start, end) : runtimeSrc;
  })();
  const installZipBody = (() => {
    const start = runtimeSrc.indexOf('async installZip(');
    const end = runtimeSrc.indexOf('async quarantinePlugin(');
    return start >= 0 && end > start ? runtimeSrc.slice(start, end) : runtimeSrc;
  })();
  const enableBody = (() => {
    const start = runtimeSrc.indexOf('async enablePlugin(');
    const end = runtimeSrc.indexOf('async disablePlugin(');
    return start >= 0 && end > start ? runtimeSrc.slice(start, end) : runtimeSrc;
  })();
  const rollbackBody = (() => {
    const start = installerSrc.indexOf('async rollbackPlugin(');
    const end = installerSrc.indexOf('// --- uninstall');
    return start >= 0 && end > start ? installerSrc.slice(start, end) : installerSrc;
  })();

  // S1 可信更新元数据
  if (marketMod) {
    const v1 = JSON.stringify({ schemaVersion: 1, plugins: [{
      id: 's1', name: 'S1', version: '1.0.0', author: 't',
      zipUrl: 'https://market.example.com/s1.zip', sha256: 'a'.repeat(64) }] });
    const parsed = marketMod.parseMarketIndexResult(v1);
    ok('§9.2-S1 可信更新元数据: schemaVersion=1 索引解析 + 条目哈希受信任',
      parsed.ok === true && parsed.entries.length === 1
      && marketMod.isTrustedInstallHash(parsed.entries[0].sha256));
  } else {
    ok('§9.2-S1 可信更新元数据', false, '市场模型未装载');
  }
  ok('§9.2-S1b 索引获取走 parseMarketIndexResult(拒绝原因不丢)', /parseMarketIndexResult/.test(runtimeSrc));

  // S2 检查版本是否允许更新
  if (Policy) {
    const d = Policy.decide({ installedVersion: '2.0.0', installedSha256: '', incomingVersion: '1.0.0',
      incomingSha256: '', oldCaps: [], newCaps: [], revoked: [], permissionDiff: diff([], []) });
    ok('§9.2-S2 版本闸: 降级拒绝', d.ok === false && d.code === 'ERR_DOWNGRADE_BLOCKED');
    const e = Policy.decide({ installedVersion: '1.0.0', installedSha256: 'h1', incomingVersion: '1.0.0',
      incomingSha256: 'h2', oldCaps: [], newCaps: [], revoked: [], permissionDiff: diff([], []) });
    ok('§9.2-S2b 版本闸: 同版本异哈希拒绝(§9.4 不可变)', e.ok === false && e.code === 'ERR_PACKAGE_INVALID');
  } else {
    ok('§9.2-S2 版本闸', false, '更新策略未装载');
  }

  // S3 检查发布者身份(P5-002 接缝;本轮对账=接缝在位 + 自述哈希如实披露)
  ok('§9.2-S3 发布者身份: LexiRegistryTrust verifyChain/verifyPackageTarget 接缝在位(接线=P5-002,本轮不宣称闭环)',
    /verifyChain/.test(trustSrc) && /verifyPackageTarget/.test(trustSrc));
  ok('§9.2-S3b UI 如实披露: 哈希已校验≠来源可信,侧载明示无远端比对',
    sheetSrc.indexOf('签名状态：包哈希已校验') >= 0 && sheetSrc.indexOf('本地侧载（无远端哈希比对）') >= 0);

  // S4 下载并验证新包
  ok('§9.2-S4 下载前双闸有序: https 强制 → 信任哈希 → 才发起下载',
    fromUrlBody.indexOf('isProductionBlockedSource(') >= 0
    && fromUrlBody.indexOf('isProductionBlockedSource(') < fromUrlBody.indexOf('isTrustedInstallHash(')
    && fromUrlBody.indexOf('isTrustedInstallHash(') < fromUrlBody.indexOf('client.request('));
  ok('§9.2-S4b 完整性失败 → 已装版本隔离(§6.4/§9.2 零带病运行)', /quarantinePlugin\(targetPluginId/.test(runtimeSrc));

  // S5 比较权限变化
  ok('§9.2-S5 安装口构造能力差异(diff.added/removed)', /LexiCapabilityDiffLite/.test(installerSrc)
    && /diff\.added/.test(installBody) && /diff\.removed/.test(installBody));

  // S6 权限增加要求重新授权
  if (Policy) {
    const d = Policy.decide({ installedVersion: '1.0.0', installedSha256: '', incomingVersion: '1.1.0',
      incomingSha256: '', oldCaps: ['vault.write'], newCaps: ['vault.write', 'network:api.example.com'],
      revoked: [], permissionDiff: diff(['vault.write'], ['vault.write', 'network:api.example.com']) });
    ok('§9.2-S6 新权限 → ERR_PERMISSION_REGRANT_REQUIRED', d.ok === false
      && d.code === 'ERR_PERMISSION_REGRANT_REQUIRED');
  } else {
    ok('§9.2-S6 新权限重授权', false, '更新策略未装载');
  }
  ok('§9.2-S6b 重授权通道: grantApproved 放行 + 确认后按新清单落账',
    /grantApproved/.test(installBody) && /permissionStore\.grant\(manifest\.id/.test(runtimeSrc));

  // S7 暂停当前插件(实现映射: 旧执行上下文随 scanPluginDir 重建销毁,更新窗口内不可达)
  {
    const scanPos = installZipBody.indexOf('await this.scanPluginDir()');
    const wasPos = installZipBody.indexOf('const wasEnabled = this.enabledIds.has(manifest.id)');
    ok('§9.2-S7 更新窗口: 上下文随 scanPluginDir 重建(旧记录销毁,wasEnabled 先取)',
      wasPos > 0 && scanPos > wasPos);
  }

  // S8 备份必要数据
  ok('§9.2-S8 数据备份: data.json 不进版本目录 + 旧投影先快照',
    /copyTreeExcept\(root, staging, DATA_FILE\)/.test(installBody)
    && /Snapshot the currently projected version/.test(installBody));

  // S9 安装到新版本目录
  ok('§9.2-S9 新代码进 .versions/<新版本>(staging → 版本目录)',
    installBody.indexOf('const target = this.versionDir(id, manifest.version)') >= 0
    && /copyTree\(staging, target\)/.test(installBody));

  // S10 原子切换版本指针(P5-010: 包哈希记录随版本落账)
  {
    const swapPos = installBody.indexOf('await this.project(id, manifest.version)');
    const pointerPos = installBody.indexOf('this.writePointer(id, manifest.version,');
    const recordPos = installBody.indexOf('PACKAGE_HASH_FILE, declaredSha256)');
    ok('§9.2-S10 投影成功后才切指针,顺序不可倒置', swapPos >= 0 && pointerPos > swapPos);
    ok('§9.2-S10b 包哈希记录随安装落账(幂等重装保留真实上一版本)',
      recordPos > pointerPos && /pointerBefore\.previousVersion/.test(installBody));
  }

  // S11 创建新执行上下文
  ok('§9.2-S11 新执行上下文: enablePlugin 经 contextRegistry.ensureService 重建',
    /contextRegistry\.ensureService\(/.test(enableBody));

  // S12 执行 onload
  ok('§9.2-S12 onload 派发: load.plugin 通道 + onload.done 回执', /dispatchWithTimeout\('load\.plugin'/.test(runtimeSrc)
    && /plugin\.onload\.done/.test(runtimeSrc));

  // S13 健康检查
  ok('§9.2-S13 健康检查: onload 失败落 failed 且 fail-visible(等待点被唤醒)',
    /plugin\.onload\.error/.test(runtimeSrc) && /markFailed\(/.test(runtimeSrc)
    && /pendingOnloadFail/.test(runtimeSrc));

  // S14 成功则完成更新
  ok('§9.2-S14 成功路径: 升级重启经 enablePlugin(权限不变沿用授权)',
    /this\.enablePlugin\(manifest\.id\)/.test(runtimeSrc) && /markRunning\(/.test(runtimeSrc));

  // S15 失败则恢复旧版本指针
  ok('§9.2-S15 失败恢复: tryRestore 回写旧指针 + rolledBack 记账',
    /private tryRestore\(/.test(installerSrc) && /outcome\.rolledBack = restored/.test(installerSrc));
  ok('§9.2-S15b 显式回滚: 指针切回上一版本(§9.4 只回滚代码,data.json 不动)',
    rollbackBody.indexOf('await this.project(id, target)') >= 0
    && /writePointer\(id, target, pointer\.version\)/.test(rollbackBody));
})();

section('W1 接线');
const installerSrc = fs.existsSync(INSTALLER_ETS) ? fs.readFileSync(INSTALLER_ETS, 'utf8') : '';
const runtimeSrcW = fs.existsSync(RUNTIME_ETS) ? fs.readFileSync(RUNTIME_ETS, 'utf8') : '';
ok('W1.1 安装器已有降级防护(既有语义)', /ERROR_DOWNGRADE_BLOCKED/.test(installerSrc));
ok('W1.2 安装器接入更新策略', /LexiUpdatePolicy/.test(installerSrc),
  'installExtracted/升级入口必须过 Policy.decide');
ok('W1.3 策略输入走包哈希记录(installedPackageSha256Of),不再混用主文件哈希域(P5-010)',
  /installedPackageSha256Of\(id, previous\)/.test(installerSrc)
  && !/installedSha256Of\(/.test(installerSrc),
  '旧 installedSha256Of(main.js 域)必须移除,防止两条哈希域再次混比');
ok('W1.4 包哈希记录随安装落账且不进投影(P5-010)',
  /PACKAGE_HASH_FILE, declaredSha256\)/.test(installerSrc)
  && /copyTreeExcept\(this\.versionDir\(id, version\), this\.pluginDir\(id\), DATA_FILE, PACKAGE_HASH_FILE\)/.test(installerSrc));
ok('W1.5 生产 https 强制接线: installFromUrl 与 fetchMarketIndex 双口都过 isProductionBlockedSource(P5-005)',
  (runtimeSrcW.match(/isProductionBlockedSource\(/g) || []).length === 2,
  '两个网络入口(下载/索引)都必须先过源闸');
ok('W1.6 调试判定 fail-closed: bundleManager 查询失败按生产构建处理(http 被拒)',
  /getBundleInfoForSelfSync/.test(runtimeSrcW) && /catch \{\s*\r?\n\s*this\.debugBuildFlag = false;/.test(runtimeSrcW));

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-update-policy: PASS'
  : 'plugin-update-policy: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
