'use strict';
// RFC §14 T2.2 Permission Storage · 门禁（对应 §8.2 迁移原则 / §9.5 权限变化展示 / §16.2 用户侧授权撤销）。
//
// 验收目标：插件版本权限变化时必须重新授权。
//   P1 真实存储（转译求值）：
//      - 首次启用 = 用户显式启用即授权（记录版本+能力指纹）；
//      - 同能力升版本 → 自动延续授权（指纹未变不折腾用户）;
//      - 新增/变化权限 → regrant-required（RFC §9.5:升级新增权限必须再次授权）;
//      - 撤销后 → revoked,启用被拒直到再次授权;
//      - 能力指纹与键序无关;diff 给出 added/removed;
//      - 序列化往返(持久化形状)。
//   P2 接线锚点：enablePlugin 启用前查 decisionFor;grant/revoke API 存在;
//      权限拒绝原因落 errorState(既有 error-visible 面展示);指纹来自 v2 细粒度能力视图。
//
// 用法：node scripts/tests/plugin-permission-store.cjs
// 依赖：LEXI_TYPESCRIPT

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const STORE_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPermissionStore.ets');
const RUNTIME_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginRuntime.ets');
const V2_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginManifestV2.ets');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

function loadStore() {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { throw new Error('需要 LEXI_TYPESCRIPT 指向 typescript 模块'); }
  const ts = require(tsPath);
  const js = ts.transpileModule(fs.readFileSync(STORE_ETS, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: 'LexiPermissionStore.ets' })(
    () => { throw new Error('PermissionStore 必须零依赖'); }, mod, mod.exports);
  return mod.exports;
}

let storeMod = null;
try {
  storeMod = loadStore();
  ok('P0 PermissionStore 可转译求值', !!storeMod.LexiPermissionStore);
} catch (error) {
  ok('P0 PermissionStore 可转译求值', false, 'threw: ' + error.message);
}

const GRANTED = 'granted';
const REGRANT = 'regrant-required';
const NOT_GRANTED = 'not-granted';
const REVOKED = 'revoked';

if (storeMod) {
  const Store = storeMod.LexiPermissionStore;
  const fresh = () => new Store();

  section('P1 授权生命周期');
  {
    const s = fresh();
    ok('P1.1 首次查询 = not-granted', s.decisionFor('plug-a', '1.0.0', 'fp-1') === NOT_GRANTED);
    s.grant('plug-a', '1.0.0', 'fp-1');
    ok('P1.2 grant 后同版本同指纹 = granted', s.decisionFor('plug-a', '1.0.0', 'fp-1') === GRANTED);
    ok('P1.3 同指纹升版本 = granted(能力未变不折腾用户)', s.decisionFor('plug-a', '1.1.0', 'fp-1') === GRANTED);
    ok('P1.4 指纹变化 = regrant-required(§9.5 新增权限必须再次授权)', s.decisionFor('plug-a', '1.2.0', 'fp-2') === REGRANT);
    const diff = s.diffCapabilities('fp-1', 'fp-2');
    ok('P1.5 diff 给出 added/removed', diff.changed === true && diff.added.length + diff.removed.length > 0);
  }
  {
    const s = fresh();
    s.grant('plug-a', '1.0.0', 'fp-1');
    s.revoke('plug-a');
    ok('P1.6 撤销后 = revoked', s.decisionFor('plug-a', '1.0.0', 'fp-1') === REVOKED);
    ok('P1.7 撤销后重新授权恢复 granted', s.grant('plug-a', '1.0.0', 'fp-1') === true &&
      s.decisionFor('plug-a', '1.0.0', 'fp-1') === GRANTED);
  }
  {
    const s = fresh();
    s.grant('plug-a', '1.0.0', 'fp-1');
    ok('P1.8 撤销不误伤其他插件', s.grant('plug-b', '1.0.0', 'fp-b') === true && s.revoke('plug-a') === true &&
      s.decisionFor('plug-b', '1.0.0', 'fp-b') === GRANTED);
  }

  section('P2 能力指纹');
  {
    const s = fresh();
    const fp1 = s.fingerprintOf(['fs', 'network:api.example.com']);
    const fp2 = s.fingerprintOf(['network:api.example.com', 'fs']);
    ok('P2.1 指纹与键序无关', fp1 === fp2 && fp1.length > 0);
    ok('P2.2 不同能力集指纹不同', s.fingerprintOf(['fs']) !== s.fingerprintOf(['fs', 'clipboard']));
    ok('P2.3 空能力集指纹稳定', s.fingerprintOf([]) === s.fingerprintOf([]));
  }

  section('P3 持久化往返');
  {
    const s = fresh();
    s.grant('plug-a', '1.0.0', 'fp-1');
    s.grant('plug-b', '2.0.0', 'fp-2');
    s.revoke('plug-b');
    const restored = new Store();
    const loaded = restored.load(s.serialize());
    ok('P3.1 序列化→载入成功', loaded === true);
    ok('P3.2 授权状态跨持久化保留', restored.decisionFor('plug-a', '1.0.0', 'fp-1') === GRANTED);
    ok('P3.3 撤销状态跨持久化保留', restored.decisionFor('plug-b', '2.0.0', 'fp-2') === REVOKED);
    ok('P3.4 损坏载荷 fail-closed(按空存储载入)', new Store().load('not-json{') === false);
    ok('P3.5 schemaVersion 标记', s.serialize().indexOf('schemaVersion') >= 0);
  }
}

section('P4 宿主接线');
const runtimeSrc = fs.existsSync(RUNTIME_ETS) ? fs.readFileSync(RUNTIME_ETS, 'utf8') : '';
const v2Src = fs.existsSync(V2_ETS) ? fs.readFileSync(V2_ETS, 'utf8') : '';
ok('P4.1 宿主持有权限存储', /new LexiPermissionStore\(/.test(runtimeSrc));
ok('P4.2 enablePlugin 启用前查授权决定', /decisionFor\(/.test(runtimeSrc),
  'enablePlugin 必须先查 decisionFor:regrant-required/revoked 不得启用');
ok('P4.3 拒绝原因落 errorState(用户可见)', /权限/.test(runtimeSrc) && /errorState\s*=/.test(runtimeSrc),
  '重授权/撤销拒绝必须写 errorState(error-visible 面展示)');
ok('P4.4 grant/revoke API 存在(授权与撤销双通道)', /grantPluginPermissions\(/.test(runtimeSrc) &&
  /revokePluginPermissions\(/.test(runtimeSrc));
ok('P4.5 指纹来自能力声明(清单驱动)', /capabilitiesFingerprint|fingerprintOf\(/.test(runtimeSrc) ||
  /capabilitiesDeclared/.test(runtimeSrc),
  '指纹必须从 manifest 能力推导,不是硬编码');
ok('P4.6 持久化落盘', /plugin-permissions\.json/.test(runtimeSrc), '权限授予必须可持久化(重启保留)');
ok('P4.7 v2 能力视图存在(细粒度基础)', /v2\.vault|manifestVersion/.test(v2Src));

// --- P5 指纹级行为闭环(P2-002):真实正典标签 → fingerprintOf → decisionFor -------
// 此前本门禁指纹输入是字面量('fp-1' 等),证明不了"权限扩张必然重问"。现在把宿主
// 同款正典函数 capabilityTagsOfV2Caps 真跑进指纹链路(V2 模型零依赖,可直接转译)。
section('P5 能力扩张 ⇒ 指纹变化 ⇒ regrant-required(真跑)');
{
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) {
    ok('P5.0 LEXI_TYPESCRIPT 已配置', false, '环境变量缺失,P5 行为断言跳过即失败');
  } else {
  const ts = require(tsPath);
  const js = ts.transpileModule(fs.readFileSync(V2_ETS, 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  const v2mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: 'LexiPluginManifestV2.ets' })(
    () => { throw new Error('V2 模型必须零依赖'); }, v2mod, v2mod.exports);
  const tagsOf = v2mod.exports.capabilityTagsOfV2Caps;
  // fingerprintOf 是实例方法:借临时 store 实例做纯指纹计算。
  const decisionFor = storeMod.LexiPermissionStore;
  const fingerprintOf = (tags) => new decisionFor().fingerprintOf(tags);

  const baseCaps = new v2mod.exports.LexiManifestV2Caps();
  baseCaps.vault.write.enabled = true;
  baseCaps.network.origins = ['api.example.com'];

  const store = new decisionFor();
  const oldFp = fingerprintOf(tagsOf(baseCaps));
  store.grant('grow-plugin', '1.0.0', oldFp);
  ok('P5.1 同能力同版本 = granted(自动延续)',
    store.decisionFor('grow-plugin', '1.0.1', fingerprintOf(tagsOf(baseCaps))) === storeMod.PERMISSION_GRANTED,
    '能力未变不折腾用户(RFC §9.5)');

  const grownCaps = new v2mod.exports.LexiManifestV2Caps();
  grownCaps.vault.write.enabled = true;
  grownCaps.network.origins = ['api.example.com'];
  grownCaps.editor.writeDocument = true; // 升级新增编辑器写权限
  ok('P5.2 权限扩张 ⇒ regrant-required',
    store.decisionFor('grow-plugin', '1.1.0', fingerprintOf(tagsOf(grownCaps))) === storeMod.PERMISSION_REGRANT_REQUIRED,
    '新增 editor.writeDocument 必须改变指纹并触发重授权(旧粗标签下它曾静默继承,P0-03)');
  const store2 = new decisionFor();
  store2.grant('q-plugin', '1.0.0', fingerprintOf(tagsOf(baseCaps)));
  const quotaCaps = new v2mod.exports.LexiManifestV2Caps();
  quotaCaps.vault.write.enabled = true;
  quotaCaps.network.origins = ['api.example.com'];
  quotaCaps.storage.quotaBytes = 104857600; // 配额 1MiB → 100MiB
  ok('P5.3 配额扩大 ⇒ 指纹变化 ⇒ regrant-required',
    store2.decisionFor('q-plugin', '1.1.0', fingerprintOf(tagsOf(quotaCaps))) === storeMod.PERMISSION_REGRANT_REQUIRED,
    '数字上限恒入标签:配额扩张必须被指纹捕获');
  const revokeStore = new decisionFor();
  revokeStore.grant('rv-plugin', '1.0.0', oldFp);
  revokeStore.revoke('rv-plugin');
  ok('P5.4 撤销后即使能力未变也拒绝(直到再授权)',
    revokeStore.decisionFor('rv-plugin', '1.0.0', oldFp) === storeMod.PERMISSION_REVOKED,
    '撤销立即生效(§16.2)');
  }
}

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-permission-store: PASS'
  : 'plugin-permission-store: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
