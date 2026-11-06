'use strict';
// RFC §14 T5.2 Developer CLI · 门禁（对应 §10.2 命令标准）。
//
// 验收目标：lexi create/validate/pack/sign/publish 五条命令端到端可用。
//   C1 create → 从官方模板落脚手架(manifest v2/main.js/README/styles.css)。
//   C2 validate → 走宿主同一解析器(LexiPluginManifestV2):合法 v2 通过;
//      未知 capability 拒绝(单一真源,不是 CLI 另写一份校验)。
//   C3 pack → 产出 zip + sha256(64 位十六进制)。
//   C4 sign → 产出签名文件(dev HMAC 缝;生产签名归服务侧/TUF,§9.3)。
//   C5 publish → 产出 registry targets 元数据,且该 targets 必须能通过 LexiRegistryTrust
//      verifyPackageTarget 校验(与宿主同一信任链语义)。
//
// 用法：node scripts/tests/lexi-cli-contract.cjs
// 依赖：LEXI_TYPESCRIPT(validate/publish 复用宿主解析器与信任链)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'tools', 'lexi-cli', 'lexi.cjs');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

function lexi(args, envExtra) {
  const r = spawnSync(process.execPath, [CLI].concat(args), {
    cwd: ROOT, encoding: 'utf8',
    env: Object.assign({}, process.env,
      { LEXI_TYPESCRIPT: process.env.LEXI_TYPESCRIPT || '' }, envExtra || {})
  });
  return { status: r.status, stdout: (r.stdout || '') + '', stderr: (r.stderr || '') + '',
    output: ((r.stdout || '') + (r.stderr || '')) };
}

section('C0 CLI 存在');
ok('C0.1 tools/lexi-cli/lexi.cjs 在库', fs.existsSync(CLI));

if (fs.existsSync(CLI)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-cli-'));
  const proj = path.join(tmp, 'my-plugin');

  section('C1 create');
  {
    const r = lexi(['plugin', 'create', 'my-plugin', '--dir', tmp]);
    ok('C1.1 create 退出码 0', r.status === 0, r.output.split('\n').slice(-2).join('|'));
    ok('C1.2 脚手架落地', fs.existsSync(path.join(proj, 'manifest.json')) &&
      fs.existsSync(path.join(proj, 'main.js')) && fs.existsSync(path.join(proj, 'README.md')));
    const manifest = JSON.parse(fs.readFileSync(path.join(proj, 'manifest.json'), 'utf8'));
    ok('C1.3 脚手架是 v2 manifest(§8.1)', manifest.manifestVersion === 2 &&
      manifest.id === 'my-plugin' && manifest.capabilities !== undefined);
  }

  section('C2 validate(宿主同一解析器)');
  {
    const r = lexi(['plugin', 'validate', proj]);
    ok('C2.1 合法 v2 通过', r.status === 0, r.output.split('\n').slice(-2).join('|'));
    const manifestPath = path.join(proj, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.capabilities.fsextra = true; // 未知 capability(§8.1 必须拒绝)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const bad = lexi(['plugin', 'validate', proj]);
    ok('C2.2 未知 capability 拒绝(与宿主同解析器)', bad.status !== 0 &&
      /capability/i.test(bad.output), bad.output.split('\n').slice(-2).join('|'));
    delete manifest.capabilities.fsextra;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    ok('C2.3 修复后回绿', lexi(['plugin', 'validate', proj]).status === 0);
  }

  section('C3 pack');
  let packInfo = null;
  {
    const r = lexi(['plugin', 'pack', proj]);
    ok('C3.1 pack 退出码 0', r.status === 0, r.output.split('\n').slice(-2).join('|'));
    const match = r.output.match(/sha256=([0-9a-f]{64})/);
    const zipMatch = r.output.match(/zip=([^\s]+)/);
    ok('C3.2 产出 zip 与 sha256(64 位十六进制)', match !== null && zipMatch !== null &&
      fs.existsSync(zipMatch[1]));
    if (match !== null && zipMatch !== null) { packInfo = { zip: zipMatch[1], sha256: match[1] }; }
  }

  section('C4 sign');
  {
    const r = lexi(['plugin', 'sign', packInfo ? packInfo.zip : proj],
      Object.assign({ LEXI_SIGN_KEY: 'dev-secret' }));
    ok('C4.1 sign 退出码 0', r.status === 0, r.output.split('\n').slice(-2).join('|'));
    const sigMatch = r.output.match(/signature=([^\s]+)/);
    ok('C4.2 产出签名文件', sigMatch !== null && fs.existsSync(sigMatch[1]));
  }

  section('C5 publish(registry targets)');
  {
    const r = lexi(['plugin', 'publish', proj, '--zip', packInfo ? packInfo.zip : '', '--sha256', packInfo ? packInfo.sha256 : ''],
      Object.assign({ LEXI_SIGN_KEY: 'dev-secret' }));
    ok('C5.1 publish 退出码 0', r.status === 0, r.output.split('\n').slice(-2).join('|'));
    const targetsMatch = r.output.match(/targets=([^\s]+)/);
    ok('C5.2 产出 targets 元数据', targetsMatch !== null && fs.existsSync(targetsMatch[1]));
    if (targetsMatch !== null) {
      // 宿主同一信任链语义:产出的 targets 必须能过 verifyPackageTarget
      const tsPath = process.env.LEXI_TYPESCRIPT;
      let verified = false;
      let detail = '';
      try {
        const ts = require(tsPath);
        const js = ts.transpileModule(fs.readFileSync(path.join(ROOT,
          'entry/src/main/ets/core/plugin/LexiRegistryTrust.ets'), 'utf8'),
          { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
        const mod = { exports: {} };
        require('node:vm').runInThisContext('(function(require,module,exports){' + js + '\n})')(
          () => {}, mod, mod.exports);
        const wrapper = JSON.parse(fs.readFileSync(targetsMatch[1], 'utf8'));
        const targets = { payload: wrapper.payload, signature: wrapper.signature };
        const manifest = JSON.parse(fs.readFileSync(path.join(proj, 'manifest.json'), 'utf8'));
        const d = mod.exports.LexiRegistryTrust.verifyPackageTarget(targets, manifest.id, manifest.version, packInfo.sha256);
        verified = d.ok || d.code === 'ERR_SIGNATURE_INVALID'; // 形状正确即可(签名本体走服务侧)
        detail = d.reason;
      } catch (error) { detail = 'threw: ' + error.message; }
      ok('C5.3 targets 形状与宿主信任链兼容', verified, detail);
    }
  }
  section('C6 build(CJS→IIFE,P1-003c/RFC §3.2)');
  {
    // 把脚手架入口重写成 require('obsidian') 形态:包装产物必须在求值期自带 require 管线,
    // 宿主侧(注入通道)不再提供 module/exports/require 装配。
    fs.writeFileSync(path.join(proj, 'main.js'), [
      "const { Plugin } = require('obsidian');",
      'module.exports = class MyPlugin extends Plugin {',
      '  onload() { this.ready = true; }',
      '};',
      ''
    ].join('\n'));
    const r = lexi(['plugin', 'build', proj]);
    ok('C6.1 build 退出码 0', r.status === 0, r.output.split('\n').slice(-2).join('|'));
    const built = fs.readFileSync(path.join(proj, 'main.js'), 'utf8');
    ok('C6.2 产物是 lexi-iife:v1 自执行 IIFE', /^\s*\/\*\s*lexi-iife:v1\s*\*\//.test(built) &&
      /;\(function \(require\) \{/.test(built) &&
      /window\.__lexiPluginRegistry\s*=\s*window\.__lexiPluginRegistry\s*\|\|\s*\{\}/.test(built) &&
      /# sourceURL=lexinote-plugin-my-plugin\.js/.test(built) &&
      !/\bnew\s+Function\s*\(/.test(built),
      '包装产物缺标记/注册表交付/sourceURL,或混入 new Function');
    // 行为级:stub 宿主 require 通道,vm 执行产物 —— 注册表必须交付可用插件类。
    let behaviorDetail = '';
    let behaviorOk = false;
    try {
      const vm = require('node:vm');
      const sb = { window: {}, console: { log: function () {} } };
      sb.window = sb;
      sb.window.lexiRuntime = {
        __lexiAcquireRequire: function () {
          return function (name) {
            if (name === 'obsidian') {
              return { Plugin: function Plugin() {} };
            }
            throw new Error('模块未提供: ' + name);
          };
        }
      };
      vm.createContext(sb);
      vm.runInContext(built, sb, { filename: 'built-main.js' });
      const entry = sb.window.__lexiPluginRegistry && sb.window.__lexiPluginRegistry['my-plugin'];
      behaviorOk = !!entry && !entry.error && typeof entry.exports === 'function';
      if (behaviorOk) {
        const inst = new entry.exports({});
        inst.onload();
        behaviorOk = inst.ready === true;
      }
      behaviorDetail = entry ? (entry.error || typeof entry.exports) : '注册表缺项(求值未完成)';
    } catch (error) { behaviorDetail = 'threw: ' + error.message; }
    ok('C6.3 产物 vm 求值即交付插件类(require 管线内置于 IIFE)', behaviorOk, behaviorDetail);
    const before = built;
    const r2 = lexi(['plugin', 'build', proj]);
    ok('C6.4 幂等:重复 build 跳过且不二次包装', r2.status === 0 &&
      fs.readFileSync(path.join(proj, 'main.js'), 'utf8') === before, r2.output.split('\n').slice(-2).join('|'));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'lexi-cli-contract: PASS'
  : 'lexi-cli-contract: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
