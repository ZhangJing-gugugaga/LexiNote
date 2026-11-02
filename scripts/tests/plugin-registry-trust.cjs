'use strict';
// RFC §14 T4.2 Registry v2 · 门禁（对应 §9.1 分发架构 / §9.2 签名体系 / §9.3 TUF）。
//
// 验收目标：客户端能够验证完整元数据链。
//   T1 信任链（真实判定器,转译求值,简化 TUF 四角色）：
//     root(信任锚+自签) → snapshot(签名+一致性) → targets(签名+版本 hash) → timestamp(签名+新鲜度)。
//   T2 攻击面：篡改 targets / 过期 timestamp / 版本回滚 / 撤销 key / 签名错配 全部拒绝(§9.2)。
//   T3 发布流：角色目录(metadata/schemas/scripts/signatures)与 schema 快照在库。
//
// 用法：node scripts/tests/plugin-registry-trust.cjs
// 依赖：LEXI_TYPESCRIPT

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const TRUST_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiRegistryTrust.ets');
const RELEASES = path.join(ROOT, 'tools/lexinote-releases');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

function loadTrust() {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { throw new Error('需要 LEXI_TYPESCRIPT 指向 typescript 模块'); }
  const ts = require(tsPath);
  const js = ts.transpileModule(fs.readFileSync(TRUST_ETS, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: 'LexiRegistryTrust.ets' })(
    () => { throw new Error('RegistryTrust 必须零依赖'); }, mod, mod.exports);
  return mod.exports;
}

let trust = null;
try {
  trust = loadTrust();
  ok('T0 RegistryTrust 可转译求值', !!trust.LexiRegistryTrust);
} catch (error) {
  ok('T0 RegistryTrust 可转义求值', false, 'threw: ' + error.message);
}

// 确定性"签名"函数:测试用 HMAC 替身(真实设备侧走 cryptoFramework 签名)
function sign(key, payload) { return 'sig(' + key + '|' + payload + ')'; }

function chainFixture(overrides) {
  const o = overrides || {};
  const keys = {
    root: o.rootKey || 'root-key',
    snapshot: o.snapshotKey || 'snapshot-key',
    targets: o.targetsKey || 'targets-key',
    timestamp: o.timestampKey || 'timestamp-key'
  };
  const targetsPayload = o.targetsPayload || JSON.stringify({
    plugins: { 'plug-a': { '1.0.0': { sha256: 'hash-a-1' } } }, version: 3
  });
  const snapshotPayload = o.snapshotPayload || JSON.stringify({ targetsHash: 'hash:' + targetsPayload });
  const timestampPayload = o.timestampPayload || JSON.stringify({ snapshotHash: 'hash:' + snapshotPayload, expires: '2099-01-01' });
  const rootPayload = o.rootPayload || JSON.stringify({
    keys: keys, expires: o.rootExpires || '2099-01-01', roles: {
      snapshot: 'snapshot-key', targets: 'targets-key', timestamp: 'timestamp-key'
    }
  });
  return {
    root: { payload: rootPayload, signature: sign(keys.root, rootPayload) },
    snapshot: { payload: snapshotPayload, signature: sign(keys.snapshot, snapshotPayload) },
    targets: { payload: targetsPayload, signature: sign(keys.targets, targetsPayload) },
    timestamp: { payload: timestampPayload, signature: sign(keys.timestamp, timestampPayload) },
    now: o.now || '2026-11-03'
  };
}

if (trust) {
  const Trust = trust.LexiRegistryTrust;
  const verify = (fixture, lastSeen) => Trust.verifyChain(fixture.root, fixture.snapshot, fixture.targets,
    fixture.timestamp, fixture.now, (sig, payload, key) => sig === sign(key, payload), '',
    lastSeen === undefined ? -1 : lastSeen);

  section('T1 信任链正向');
  {
    const d = verify(chainFixture());
    ok('T1.1 完整链放行(四角色+一致性+新鲜度)', d.ok === true, d.reason);
  }
  {
    const f = chainFixture();
    f.targets.payload = JSON.stringify({ plugins: { 'plug-a': { '1.0.0': { sha256: 'EVIL' } } }, version: 4 });
    const d = verify(f);
    ok('T1.2 snapshot 一致性:targets 被改后 hash 不匹配拒绝(§9.2)', d.ok === false, d.reason);
  }

  section('T2 攻击面');
  {
    const f = chainFixture({ timestampPayload: JSON.stringify({ snapshotHash: 'hash:tampered' }) });
    ok('T2.1 snapshot hash 错配拒绝', verify(f).ok === false);
  }
  {
    const f = chainFixture();
    f.timestamp.payload = JSON.stringify({ snapshotHash: 'hash:' + f.snapshot.payload, expires: '2020-01-01' });
    f.timestamp.signature = sign('timestamp-key', f.timestamp.payload);
    ok('T2.2 过期 timestamp 拒绝(新鲜度,§9.2)', verify(f).ok === false);
  }
  {
    const f = chainFixture({ targetsPayload: JSON.stringify({
      plugins: { 'plug-a': { '1.0.0': { sha256: 'hash-a-1' } } }, version: 2 }) });
    const d = verify(f, 3);
    ok('T2.3 targets 版本回滚拒绝(version 2 < lastSeen 3)', d.ok === false, d.reason);
  }
  {
    {
      // 攻击模型:root payload 仍声明 root-key(客户端本地 pin 的信任锚),但攻击者用自己的 key 签名。
      const f = chainFixture();
      f.root.signature = sign('attacker-key', f.root.payload);
      ok('T2.4 root 信任锚外的 key 签名拒绝', verify(f).ok === false);
    }
  }
  {
    const f = chainFixture();
    f.snapshot.signature = sign('targets-key', f.snapshot.payload);
    ok('T2.5 角色签名错配拒绝(用错角色的 key)', verify(f).ok === false);
  }
  {
    const d = Trust.verifyChain(chainFixture().root, chainFixture().snapshot, chainFixture().targets,
      chainFixture().timestamp, '2026-11-03',
      (sig, payload, key) => sig === sign(key, payload), 'revoked-keys:targets-key');
    ok('T2.6 撤销列表命中拒绝(§9.2 发布者撤销)', d.ok === false, d.reason);
  }
  {
    const f = chainFixture();
    const d = Trust.verifyPackageTarget(f.targets, 'plug-a', '1.0.0', 'hash-a-1');
    ok('T2.7 targets 内版本 hash 比对(下载前校验入口)', d.ok === true);
    const d2 = Trust.verifyPackageTarget(f.targets, 'plug-a', '1.0.0', 'WRONG');
    ok('T2.8 hash 错配拒绝(ERR_HASH_MISMATCH 语义)', d2.ok === false && d2.code === 'ERR_HASH_MISMATCH');
  }
}

section('T3 发布目录与 schema 快照');
ok('T3.1 tools/lexinote-releases 目录在库', fs.existsSync(path.join(RELEASES, 'metadata')) &&
  fs.existsSync(path.join(RELEASES, 'schemas')) && fs.existsSync(path.join(RELEASES, 'signatures')),
  '§9.1 分发架构的 metadata/schemas/signatures 三目录');
ok('T3.2 root schema 快照在库', fs.existsSync(path.join(RELEASES, 'schemas', 'root-v1.schema.json')));
ok('T3.3 元数据样例在库(root)', fs.existsSync(path.join(RELEASES, 'metadata', 'root.json')));

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-registry-trust: PASS'
  : 'plugin-registry-trust: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
