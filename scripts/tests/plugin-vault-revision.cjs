'use strict';
// RFC §14 T2.3 Vault/Metadata 一致性 · 门禁（对应 §7.1 revision 乐观锁 / 并发写入保护）。
//
// 验收目标：并发修改可检出、乐观锁端到端(宿主判定→RPC 形状→shim 携带)、写路径全部推进 revision。
//   R1 真实守卫（转译求值）：bump/compare/conflict/rename/forget。
//   R2 端到端接线：facade modify 带 expectedRevision 形状;RPC 解析 expectedRevision;
//      fileToJson 下发 stat.revision;shim vault.modify 自动携带;全部写路径 bump。
//
// 用法：node scripts/tests/plugin-vault-revision.cjs
// 依赖：LEXI_TYPESCRIPT

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const GUARD_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiVaultRevisionGuard.ets');
const FACADE_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiVaultFacade.ets');
const RUNTIME_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginRuntime.ets');
const SHIM = path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_plugin_shim.js');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

function loadGuard() {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { throw new Error('需要 LEXI_TYPESCRIPT 指向 typescript 模块'); }
  const ts = require(tsPath);
  const js = ts.transpileModule(fs.readFileSync(GUARD_ETS, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: 'LexiVaultRevisionGuard.ets' })(
    () => { throw new Error('RevisionGuard 必须零依赖'); }, mod, mod.exports);
  return mod.exports;
}

let guardMod = null;
try {
  guardMod = loadGuard();
  ok('R0 RevisionGuard 可转译求值', !!guardMod.LexiVaultRevisionGuard);
} catch (error) {
  ok('R0 RevisionGuard 可转译求值', false, 'threw: ' + error.message);
}

if (guardMod) {
  const Guard = guardMod.LexiVaultRevisionGuard;
  const fresh = () => new Guard();

  section('R1 乐观锁语义');
  {
    const g = fresh();
    ok('R1.1 新路径 revision 从 0 起(未写状态)', g.revisionOf('/a.md') === 0);
    const blind = g.checkAndBump('/a.md', -1);
    ok('R1.2 盲写(expectedRevision=-1)放行并推进', blind.ok === true && g.revisionOf('/a.md') === 1);
    const withCheck = g.checkAndBump('/a.md', 1);
    ok('R1.3 持预期 revision 写入放行(1→2)', withCheck.ok === true && g.revisionOf('/a.md') === 2);
    const stale = g.checkAndBump('/a.md', 1);
    ok('R1.4 过期预期写入检出冲突(ERR 语义)', stale.ok === false && stale.currentRevision === 2,
      'current=' + stale.currentRevision);
    ok('R1.5 冲突不推进 revision', g.revisionOf('/a.md') === 2);
  }
  {
    const g = fresh();
    g.checkAndBump('/a.md', -1);
    g.checkAndBump('/a.md', 1);
    g.rename('/a.md', '/b.md');
    ok('R1.6 rename 迁移 revision 计数', g.revisionOf('/b.md') === 2 && g.revisionOf('/a.md') === 0);
    g.forget('/b.md');
    ok('R1.7 delete 清账', g.revisionOf('/b.md') === 0);
  }
  {
    const g = fresh();
    g.checkAndBump('/x.md', -1);
    g.checkAndBump('/y.md', -1);
    ok('R1.8 路径各自独立计数', g.revisionOf('/x.md') === 1 && g.revisionOf('/y.md') === 1);
  }
}

section('R2 端到端接线');
const facadeSrc = fs.existsSync(FACADE_ETS) ? fs.readFileSync(FACADE_ETS, 'utf8') : '';
const runtimeSrc = fs.existsSync(RUNTIME_ETS) ? fs.readFileSync(RUNTIME_ETS, 'utf8') : '';
const shimSrc = fs.existsSync(SHIM) ? fs.readFileSync(SHIM, 'utf8') : '';
ok('R2.1 facade 持有守卫', /new LexiVaultRevisionGuard\(/.test(facadeSrc));
ok('R2.2 modify 支持预期 revision(乐观锁形状)', /modify\s*\(\s*file:\s*LexiTFile\s*,\s*data:\s*string\s*(,\s*expectedRevision)?/.test(facadeSrc) &&
  /checkAndBump\(/.test(facadeSrc), 'modify 必须带 expectedRevision 并走 checkAndBump');
ok('R2.3 冲突抛 vault_conflict(机器可读)', /vault_conflict/.test(facadeSrc));
ok('R2.4 写路径全部推进(create/delete/rename/append)', (facadeSrc.match(/revisions\.|revisionGuard\.|bumpOnWrite|checkAndBump\(/g) || []).length >= 4,
  'create/delete/rename/append 必须各自推进或清账');
ok('R2.5 RPC vault.modify 解析 expectedRevision', /registerHandler\('vault\.modify'[\s\S]{0,600}?expectedRevision/.test(runtimeSrc));
ok('R2.6 fileToJson 下发 stat.revision', /'revision':/.test(runtimeSrc),
  '插件侧 TFile.stat.revision 是乐观锁的读取通道');
ok('R2.7 shim vault.modify 自动携带 expectedRevision', /expectedRevision/.test(shimSrc),
  '插件拿到过文件对象时,modify 必须自动带预期 revision');
ok('R2.8 冲突错误码区分既有 capability_denied', /vault_conflict/.test(runtimeSrc) || /vault_conflict/.test(facadeSrc));

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-vault-revision: PASS'
  : 'plugin-vault-revision: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
