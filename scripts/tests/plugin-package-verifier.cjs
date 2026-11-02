'use strict';
// RFC §14 T4.1 PackageVerifier · 门禁（对应 §8.4 安装包验证 / P1-05 安全校验不足）。
//
// 验收目标：路径穿越、ZIP Bomb、签名错误均被拒绝；安装链接入结构校验。
//   A1 归档结构（真实判定器,转译求值）：穿越变体/绝对路径/反斜杠/NUL/符号链接/重复路径/
//      预算超限(§8.4 初始预算)/压缩炸弹/文件数/单文件体积/扩展名黑白名单。
//   A2 完整性与签名：ERR_HASH_MISMATCH / ERR_SIGNATURE_INVALID(RFC §12.3)语义;
//      本地安装(expectedSha256 为空)沿用跳过 hash 但结构校验不豁免。
//   A3 接线：安装链解压后走 verifyExtractedTree;io seam 有 fileSize(预算前置);
//      违规即清场(不残留半装状态——既有事务语义保留)。
//
// 用法：node scripts/tests/plugin-package-verifier.cjs
// 依赖：LEXI_TYPESCRIPT

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const VERIFIER_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPackageVerifier.ets');
const INSTALLER_ETS = path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPluginInstaller.ets');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

function loadVerifier() {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { throw new Error('需要 LEXI_TYPESCRIPT 指向 typescript 模块'); }
  const ts = require(tsPath);
  const js = ts.transpileModule(fs.readFileSync(VERIFIER_ETS, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: 'LexiPackageVerifier.ets' })(
    () => { throw new Error('PackageVerifier 必须零依赖'); }, mod, mod.exports);
  return mod.exports;
}

let pv = null;
try {
  pv = loadVerifier();
  ok('A0 PackageVerifier 可转译求值', !!pv.LexiPackageVerifier);
} catch (error) {
  ok('A0 PackageVerifier 可转译求值', false, 'threw: ' + error.message);
}

function entry(name, size, compressedSize, isSymlink) {
  const e = new pv.LexiArchiveEntry();
  e.name = name;
  e.size = size === undefined ? 100 : size;
  e.compressedSize = compressedSize === undefined ? 50 : compressedSize;
  e.isSymlink = isSymlink === true;
  return e;
}

const VERIFIER_INSTANCE = new pv.LexiPackageVerifier();
function inspect(entries, zipBytes) { return VERIFIER_INSTANCE.inspectArchive(entries, zipBytes); }

if (pv) {
  section('A1 归档结构安全');
  {
    const d = inspect([entry('manifest.json'), entry('main.js')], 10 * 1024);
    ok('A1.1 正常包放行', d.ok === true, JSON.stringify(d.violations));
  }
  {
    const variants = ['../evil.js', 'a/../../evil.js', '/abs.js', 'C:/abs.js', 'a\\..\\..\\evil.js', '..',
      'bad\u0000name.js', 'a/b/../../../evil.js'];
    let caught = 0;
    const details = [];
    for (const name of variants) {
      const d = inspect([entry(name)], 10 * 1024);
      if (!d.ok) { caught++; } else { details.push(name); }
    }
    ok('A1.2 路径穿越/绝对路径/反斜杠/NUL 全部拒绝(§8.4)', caught === variants.length,
      '漏网: ' + details.join(', '));
    ok('A1.3 拒绝理由可读(含违规项)', inspect([entry('../x.js')], 1024).violations.length >= 1);
  }
  {
    const d = inspect([entry('link', 10, 5, true)], 1024);
    ok('A1.4 符号链接条目拒绝(逃逸)', d.ok === false);
  }
  {
    const d = inspect([entry('a.js'), entry('a.js')], 1024);
    ok('A1.5 重复路径拒绝', d.ok === false);
  }
  {
    const d = inspect([entry('manifest.json'), entry('main.js')], 21 * 1024 * 1024);
    ok('A1.6 ZIP 体积超预算拒绝(§8.4 初始 20MB)', d.ok === false && /budget|超/.test(d.reason));
    const many = [];
    for (let i = 0; i < 2001; i++) { many.push(entry('f' + i + '.js')); }
    ok('A1.7 文件数超预算拒绝(2000)', inspect(many, 1024).ok === false);
    ok('A1.8 单文件超限拒绝(10MB)', inspect([entry('big.js', 10 * 1024 * 1024 + 1)], 1024).ok === false);
  }
  {
    // 压缩炸弹:>1MB 内容、压缩比 >100
    const bomb = entry('bomb.js', 200 * 1024 * 1024, 1024);
    const d = inspect([bomb], 10 * 1024);
    ok('A1.9 压缩炸弹拒绝(比例+体量双条件)', d.ok === false);
    ok('A1.10 高压缩小文件不误报', inspect([entry('packed.js', 512 * 1024, 1024)], 1024).ok === true);
  }
  {
    const d = inspect([entry('payload.exe'), entry('run.sh'), entry('native.node')], 1024);
    ok('A1.11 可执行/二进制扩展拒绝(§8.4 非预期二进制)', d.ok === false);
    ok('A1.12 未知扩展拒绝(白名单制)', inspect([entry('weird.xyz')], 1024).ok === false);
    ok('A1.13 常见资源放行', inspect([entry('styles.css'), entry('assets/icon.svg'),
      entry('README.md'), entry('i18n/en.json'), entry('font.woff2')], 1024).ok === true);
  }
  {
    const entries = [];
    for (let i = 0; i < 50; i++) { entries.push(entry('f' + i + '.js', 3 * 1024 * 1024)); }
    ok('A1.14 展开总体积超预算拒绝(100MB)', inspect(entries, 1024).ok === false);
  }

  section('A2 完整性与签名');
  {
    const mismatch = pv.LexiPackageVerifier.verifyHash('expected-digest', 'actual-digest');
    ok('A2.1 hash 不符 → ERR_HASH_MISMATCH', mismatch.ok === false && mismatch.code === 'ERR_HASH_MISMATCH');
    const match = pv.LexiPackageVerifier.verifyHash('same', 'same');
    ok('A2.2 hash 一致放行', match.ok === true);
    ok('A2.3 空声明跳过(本地安装语义保留)', pv.LexiPackageVerifier.verifyHash('', 'anything').ok === true);
  }
  {
    const bad = pv.LexiPackageVerifier.verifyPublisherSignature(
      (sig, expected) => sig === 'good-signature', 'expected-payload', 'forged');
    ok('A2.4 伪造签名 → ERR_SIGNATURE_INVALID', bad.ok === false && bad.code === 'ERR_SIGNATURE_INVALID');
    const good = pv.LexiPackageVerifier.verifyPublisherSignature(
      (sig, expected) => sig === 'good-signature', 'expected-payload', 'good-signature');
    ok('A2.5 有效签名放行', good.ok === true);
    const missing = pv.LexiPackageVerifier.verifyPublisherSignature(
      (sig) => true, 'expected-payload', '');
    ok('A2.6 应签未签拒绝(不能静默放过)', missing.ok === false && missing.code === 'ERR_SIGNATURE_INVALID');
  }
}

section('A3 安装链接入');
const installerSrc = fs.existsSync(INSTALLER_ETS) ? fs.readFileSync(INSTALLER_ETS, 'utf8') : '';
ok('A3.1 安装器引用 PackageVerifier', /LexiPackageVerifier/.test(installerSrc));
ok('A3.2 installZip 解压后走 verifyExtractedTree', /verifyExtractedTree\(/.test(installerSrc),
  '解压后必须先过结构校验再落版本库(不得只依赖解压库默认行为)');
ok('A3.3 违规清场(半装状态不残留)', /removeTree\(/.test(installerSrc),
  '既有事务语义:校验失败移除工作目录');
ok('A3.4 io seam 有 fileSize(预算前置)', /fileSize\(/.test(installerSrc),
  '解压前必须先量 ZIP 体积(§8.4 预算)');
ok('A3.5 错误码走 §12.3 语义', /zipBudget\.code|safety\.code/.test(installerSrc) &&
  /ERR_PACKAGE_INVALID/.test(fs.readFileSync(path.join(ROOT, 'entry/src/main/ets/core/plugin/LexiPackageVerifier.ets'), 'utf8')),
  '安装链必须透传 verifier 决策码(ERR_PACKAGE_INVALID/ERR_RESOURCE_LIMIT),hash/签名码在 verifier 模块承载');

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-package-verifier: PASS'
  : 'plugin-package-verifier: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
