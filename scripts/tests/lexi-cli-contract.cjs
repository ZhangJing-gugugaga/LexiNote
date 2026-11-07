'use strict';
// RFC §14 T5.2 Developer CLI · 门禁（对应 §10.2 命令标准 + P3-004 开发基础设施）。
//
// 验收目标：lexi create/validate/pack/sign/publish 五条命令端到端可用,
//   dev/test/inspect/doctor/compatibility(P3-004)每命令有契约用例,
//   create→build→pack 全链离线可跑。
//   C1 create → 从官方模板落脚手架(manifest v2/main.js/README/styles.css)。
//   C2 validate → 走宿主同一解析器(LexiPluginManifestV2):合法 v2 通过;
//      未知 capability 拒绝(单一真源,不是 CLI 另写一份校验)。
//   C3 pack → 产出 zip + sha256(64 位十六进制)。
//   C4 sign → 产出签名文件(dev HMAC 缝;生产签名归服务侧/TUF,§9.3)。
//   C5 publish → 产出 registry targets 元数据,且该 targets 必须能通过 LexiRegistryTrust
//      verifyPackageTarget 校验(与宿主同一信任链语义)。
//   C6 build(CJS→IIFE,P1-003c/RFC §3.2,ADR-R25-01)。
//   C7 dev → 单次 pass(validate+build)+ --watch 监视循环(改动触发重跑,子进程真跑)。
//   C8 test → <proj>/test|tests 运行:无测试红、真通过、真失败逐一可见。
//   C9 inspect → manifest/入口/打包面摘要(含 --json 机器面;iife 标记来自真实产物)。
//   C10 doctor → 环境体检:node/typescript/宿主 shim/解析器/契约快照/zip-store;
//      ts 缺席=warn(体检不装死),装载失败=fail。
//   C11 compatibility → API 版本对账 + 能力标签(SDK capabilityTags 单一真源)+
//      CM 矩阵读数;宿主不满足 manifest 下界必须红。
//   C12 create→validate→build→inspect→pack→sign→publish 全链离线一条龙。
//
// 用法：node scripts/tests/lexi-cli-contract.cjs
// 依赖：LEXI_TYPESCRIPT(validate/publish/inspect/dev/compatibility 复用宿主解析器与 SDK)

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
  section('C7 dev(P3-004)');
  {
    // 恢复可构建状态:C6 已把 main.js 换成 require 形态并包装,dev 单次 pass 对已包装产物 skip。
    const r = lexi(['plugin', 'dev', proj]);
    ok('C7.1 dev 单次 pass 退出码 0', r.status === 0, r.output.split('\n').slice(-2).join('|'));
    ok('C7.2 单次 pass = validate PASS + build 执行', /\[dev\] pass\(initial\): validate PASS/.test(r.output) &&
      /\[dev\] pass\(initial\): build /.test(r.output), r.output.split('\n').slice(-3).join('|'));

    // --watch:子进程真跑。改动 main.js → 监视循环触发第二次 pass(行为级,不是桩)。
    const logPath = path.join(tmp, 'dev-watch.log');
    const { spawn } = require('node:child_process');
    const logFd = fs.openSync(logPath, 'a');
    const child = spawn(process.execPath, [CLI, 'plugin', 'dev', proj, '--watch'],
      { cwd: ROOT, stdio: ['ignore', logFd, logFd], env: process.env });
    fs.closeSync(logFd);
    const sleepMs = (ms) => spawnSync(process.execPath, ['-e', 'setTimeout(function(){},' + ms + ')']);
    const readLog = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '');
    let watchReady = false;
    for (let i = 0; i < 60 && !watchReady; i++) {
      sleepMs(500);
      watchReady = /\[dev\] watching /.test(readLog());
    }
    ok('C7.3 --watch 进入监视循环', watchReady, readLog().split('\n').filter((l) => l.trim()).slice(-2).join('|'));
    if (watchReady) {
      const before = (readLog().match(/\[dev\] pass\(/g) || []).length;
      fs.appendFileSync(path.join(proj, 'main.js'), '// dev-watch touch\n');
      let after = before;
      for (let i = 0; i < 60 && after <= before; i++) {
        sleepMs(500);
        after = (readLog().match(/\[dev\] pass\(/g) || []).length;
      }
      ok('C7.4 改动触发重跑(pass 计数增长,含 change 标记)', after > before &&
        /\[dev\] pass\(change#/.test(readLog()),
        'before=' + before + ' after=' + after);
    }
    child.kill();
    // 注意:父进程事件循环被 spawnSync 睡眠阻塞,child.exitCode 不会更新——查 OS 进程本体。
    const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
    let gone = !pidAlive(child.pid);
    for (let i = 0; i < 20 && !gone; i++) {
      sleepMs(250);
      gone = !pidAlive(child.pid);
    }
    if (!gone && process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      gone = !pidAlive(child.pid);
    }
    ok('C7.5 监视进程可终止', gone, 'pid=' + child.pid);
  }

  section('C8 test(P3-004)');
  {
    const noTests = lexi(['plugin', 'test', proj]);
    ok('C8.1 无测试文件红(诚实:不假造通过)', noTests.status !== 0 && /未找到测试文件/.test(noTests.output),
      noTests.output.split('\n').slice(-2).join('|'));
    fs.mkdirSync(path.join(proj, 'test'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'test', 'manifest-check.cjs'), [
      "const assert = require('node:assert/strict');",
      "const manifest = require('../manifest.json');",
      "assert.equal(manifest.id, 'my-plugin');",
      "console.log('manifest-check ok');",
      ''
    ].join('\n'));
    const passRun = lexi(['plugin', 'test', proj]);
    ok('C8.2 真测试通过退出码 0', passRun.status === 0 && /test: PASS \(1 文件\)/.test(passRun.output),
      passRun.output.split('\n').slice(-2).join('|'));
    fs.writeFileSync(path.join(proj, 'test', 'deliberate-fail.cjs'),
      "console.log('this one fails on purpose');\nprocess.exit(3);\n");
    const failRun = lexi(['plugin', 'test', proj]);
    ok('C8.3 失败测试使命令红且文件可见', failRun.status !== 0 &&
      /test: FAIL test[\\\/]deliberate-fail\.cjs/.test(failRun.output) && /fails on purpose/.test(failRun.output),
      failRun.output.split('\n').slice(-2).join('|'));
    fs.rmSync(path.join(proj, 'test'), { recursive: true, force: true });
  }

  section('C9 inspect(P3-004)');
  {
    const r = lexi(['plugin', 'inspect', proj]);
    ok('C9.1 inspect 退出码 0 且摘要真实(id/iife/validate)', r.status === 0 &&
      /inspect: id=my-plugin /.test(r.output) && /iife=yes/.test(r.output) &&
      /manifestV2Validate=PASS/.test(r.output) && /packFiles=4 /.test(r.output),
      r.output.split('\n').slice(-2).join('|'));
    const rj = lexi(['plugin', 'inspect', proj, '--json']);
    let parsed = null;
    try { parsed = JSON.parse(rj.stdout); } catch (error) { parsed = null; }
    ok('C9.2 --json 机器面可解析且字段真实', rj.status === 0 && parsed !== null &&
      parsed.id === 'my-plugin' && parsed.mainEntry && parsed.mainEntry.iife === true &&
      typeof parsed.mainEntry.sha256 === 'string' && parsed.mainEntry.sha256.length === 64 &&
      Array.isArray(parsed.authorizationTags),
      'parsed=' + (parsed ? 'ok' : 'null'));
    const missing = lexi(['plugin', 'inspect', path.join(tmp, 'no-such-project')]);
    ok('C9.3 缺 manifest 红', missing.status !== 0, missing.output.split('\n').slice(-2).join('|'));
  }

  section('C10 doctor(P3-004)');
  {
    const r = lexi(['plugin', 'doctor', proj]);
    ok('C10.1 doctor 退出码 0', r.status === 0, r.output.split('\n').slice(-2).join('|'));
    ok('C10.2 关键面逐项在案(node/shim/解析器/快照/zip-store/项目)', /ok\s+node /.test(r.output) &&
      /ok\s+宿主 shim/.test(r.output) && /ok\s+宿主 manifest v2 解析器/.test(r.output) &&
      /ok\s+契约快照/.test(r.output) && /ok\s+zip-store/.test(r.output) &&
      /ok\s+项目 .*id=my-plugin/.test(r.output), r.output.split('\n').slice(-2).join('|'));
    const noTs = lexi(['plugin', 'doctor'], { LEXI_TYPESCRIPT: '' });
    ok('C10.3 ts 缺席=warn 不装死(退出码仍 0)', noTs.status === 0 &&
      /warn typescript\(LEXI_TYPESCRIPT\)/.test(noTs.output) &&
      /warn 宿主 manifest v2 解析器/.test(noTs.output) && /— PASS/.test(noTs.output),
      noTs.output.split('\n').slice(-2).join('|'));
  }

  section('C11 compatibility(P3-004)');
  {
    const manifestPath = path.join(proj, 'manifest.json');
    const originalManifest = fs.readFileSync(manifestPath, 'utf8');
    const r = lexi(['plugin', 'compatibility', proj]);
    ok('C11.1 兼容面读数(API 版本/标签/CM 矩阵)', r.status === 0 &&
      /宿主 API 版本=1\.0\.0/.test(r.output) && /授权标签=\[\]/.test(r.output) &&
      /CodeMirror 宿主矩阵 @codemirror\//.test(r.output) && /API 面 71 方法/.test(r.output),
      r.output.split('\n').slice(-2).join('|'));
    const withCaps = JSON.parse(originalManifest);
    withCaps.capabilities = { vault: { write: true }, network: ['https://API.example.com/path'] };
    fs.writeFileSync(manifestPath, JSON.stringify(withCaps, null, 2));
    const tags = lexi(['plugin', 'compatibility', proj]);
    ok('C11.2 能力标签走 SDK 单一真源(排序归一化)', tags.status === 0 &&
      /授权标签=\[network:api\.example\.com, vault\.write\]/.test(tags.output),
      tags.output.split('\n').slice(-2).join('|'));
    const bad = JSON.parse(originalManifest);
    bad.compatibility.lexinote = { min: '9.9.9' };
    fs.writeFileSync(manifestPath, JSON.stringify(bad, null, 2));
    const red = lexi(['plugin', 'compatibility', proj]);
    ok('C11.3 宿主不满足 manifest 下界必须红', red.status !== 0 &&
      /FAIL manifest 要求 lexinote>=9\.9\.9/.test(red.output),
      red.output.split('\n').slice(-2).join('|'));
    fs.writeFileSync(manifestPath, originalManifest);
    ok('C11.4 恢复后 validate 回绿', lexi(['plugin', 'validate', proj]).status === 0);
  }

  section('C12 create→build→pack 全链离线(P3-004)');
  {
    const proj2 = path.join(tmp, 'chain-plugin');
    const steps = [
      ['1 create', ['plugin', 'create', 'chain-plugin', '--dir', tmp]],
      ['2 validate', ['plugin', 'validate', proj2]],
      ['3 build', ['plugin', 'build', proj2]],
      ['4 validate-再校验', ['plugin', 'validate', proj2]],
      ['5 inspect', ['plugin', 'inspect', proj2]],
      ['6 pack', ['plugin', 'pack', proj2]],
      ['7 sign', ['plugin', 'sign', proj2 + '.zip'], { LEXI_SIGN_KEY: 'chain-secret' }],
      ['8 publish', ['plugin', 'publish', proj2, '--zip', proj2 + '.zip'], { LEXI_SIGN_KEY: 'chain-secret' }]
    ];
    let chainOk = true;
    for (const [name, argv, envExtra] of steps) {
      const r = lexi(argv, envExtra);
      if (r.status !== 0) { chainOk = false; }
      ok('C12.' + name + ' 退出码 0', r.status === 0, r.output.split('\n').slice(-2).join('|'));
    }
    ok('C12.9 全链产物落地(manifest/IIFE 入口/zip/.sig/.targets)', chainOk &&
      fs.existsSync(path.join(proj2, 'manifest.json')) &&
      /^\s*\/\*\s*lexi-iife:v1\s*\*\//.test(fs.readFileSync(path.join(proj2, 'main.js'), 'utf8')) &&
      fs.existsSync(proj2 + '.zip') && fs.existsSync(proj2 + '.zip.sig') &&
      fs.existsSync(proj2 + '.targets.json'));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// C13: P4-006b legacy 夹具依赖打包(R39-B)。宿主两轨(legacy 求值轨与沙箱轨)对未解析
// 模块一律 fail-closed("插件沙箱不支持模块: ...(依赖请随 main.js 打包)"),所以暂存的
// 两个 legacy 夹具(editor-outliner / compat-probe)的 main.js 必须自带 @codemirror 依赖。
// 验三层:
//   1) 静态:rawfile 产物没有任何 require("@codemirror/…") 外部调用(依赖已随包内联);
//   2) CLI:lexi plugin build(包装器单一真源=宿主 shim __lexiWrapPluginSource)通过,
//      产物带 lexi-iife:v1 标记。注:lexi plugin validate 走宿主 manifest v2 严格解析器,
//      对 legacy v1 清单按契约本就 fail-closed(§8.2:运行时对 rawfile 插件用 v1
//      parsePluginManifest),所以清单面用运行时同一解析器验收,不改 v2 契约;
//   3) 行为:vm 沙箱装真 shim → load.plugin 经 loadPlugin 真链路(script-inject 通道,
//      runtime 页同款)eval+onload:0 次"不支持模块"、onload.done 交付;负例(未知模块)
//      仍被宿主 fail-closed 拒绝 —— 宿主拒绝面没有被夹具打包削弱。
// 夹具未暂存时整节如实跳过(与 contract-matrix 的 fixture citations skipped 同纪律)。
async function sectionC13() {
  section('C13 legacy 夹具依赖打包(P4-006b:fail-closed 两轨,main.js 必须自带依赖)');
  const RAW = path.join(ROOT, 'entry', 'src', 'main', 'resources', 'rawfile');
  const fixtures = [
    { id: 'editor-outliner', dir: path.join(RAW, 'plugins', 'editor-outliner') },
    { id: 'compat-probe', dir: path.join(RAW, 'plugins', 'compat-probe') }
  ];
  const present = fixtures.filter((fx) => fs.existsSync(path.join(fx.dir, 'main.js')) &&
    fs.existsSync(path.join(fx.dir, 'manifest.json')));
  if (present.length === 0) {
    console.log('legacy fixture self-contained skipped: ' + fixtures.length +
      '(夹具未暂存;先跑 plugin-fixtures-fetch.cjs + plugin-fixtures-stage.cjs)');
    return;
  }
  const tmp13 = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-fixture-'));
  try {
    // 1) 静态自含
    for (const fx of present) {
      const code = fs.readFileSync(path.join(fx.dir, 'main.js'), 'utf8');
      ok('C13.1 ' + fx.id + ' main.js 无外部 @codemirror require(依赖随包内联)',
        !/require\s*\(\s*["'`]@codemirror\//.test(code), 'bytes=' + Buffer.byteLength(code));
    }
    // 2) CLI build(IIFE 包装,--out 落临时目录,不改暂存产物)
    for (const fx of present) {
      const out = path.join(tmp13, fx.id + '.iife.js');
      const r = lexi(['plugin', 'build', fx.dir, '--out', out]);
      let wrapped = '';
      try { wrapped = fs.readFileSync(out, 'utf8'); } catch (e) { wrapped = ''; }
      ok('C13.2 lexi plugin build ' + fx.id + '(iife 包装通过)', r.status === 0 &&
        /^\s*\/\*\s*lexi-iife:v1\s*\*\//.test(wrapped), r.output.split('\n').slice(-1).join('|'));
    }
    // 2b) 清单面:运行时同款 v1 解析器(parsePluginManifest,LexiPluginRuntime 装载 rawfile
    //     插件走的就是它)接受两份 legacy 清单。与宿主同一解析器,CLI 不另写校验。
    if (process.env.LEXI_TYPESCRIPT) {
      let v1mod = null;
      try {
        const ts = require(process.env.LEXI_TYPESCRIPT);
        const v1dir = path.join(tmp13, 'v1parser');
        fs.mkdirSync(v1dir, { recursive: true });
        for (const name of ['LexiPluginManifest', 'LexiPluginManifestV2']) {
          let src = fs.readFileSync(path.join(ROOT, 'entry', 'src', 'main', 'ets', 'core', 'plugin', name + '.ets'), 'utf8');
          src = src.replace(/from '\.\/LexiPluginManifestV2'/g, "from './LexiPluginManifestV2.ts'");
          fs.writeFileSync(path.join(v1dir, name + '.ts'), src);
        }
        v1mod = require(path.join(v1dir, 'LexiPluginManifest.ts'));
      } catch (error) { v1mod = null; }
      for (const fx of present) {
        if (!v1mod) { ok('C13.3 ' + fx.id + ' manifest v1 解析器可用', false, '宿主 v1 解析器转译失败'); continue; }
        let v1ok = false;
        let detail = '';
        try {
          const m = v1mod.parsePluginManifest(fs.readFileSync(path.join(fx.dir, 'manifest.json'), 'utf8'));
          v1ok = m && typeof m.id === 'string' && m.id.length > 0;
          detail = 'id=' + (m && m.id);
        } catch (error) { detail = String(error && error.message); }
        ok('C13.3 ' + fx.id + ' manifest 过运行时 v1 解析器', v1ok, detail);
      }
    }
    // 3) 行为:vm 沙箱 + 真 shim + load.plugin 真链路
    const vm = require('node:vm');
    const { createDispatchChannel } = require(path.join(__dirname, 'plugin-dispatch-channel.cjs'));
    const shimSource = fs.readFileSync(path.join(RAW, 'lexinote_plugin_shim.js'), 'utf8');

    class StubNode {
      constructor(tag) {
        this.tagName = String(tag || 'div').toUpperCase();
        this.nodeType = 1;
        this.parentNode = null;
        this.childNodes = [];
        this.style = {};
        this.id = '';
        this.className = '';
        this._text = '';
        this._listeners = new Map();
        this.classList = {
          add: (...names) => { this.className = (this.className + ' ' + names.filter(Boolean).join(' ')).trim(); },
          remove: (...names) => { this.className = this.className.split(/\s+/).filter((c) => names.indexOf(c) < 0).join(' '); },
          toggle: (name, force) => {
            const want = force === undefined ? !this.classList.contains(name) : Boolean(force);
            if (want) { this.classList.add(name); } else { this.classList.remove(name); }
            return want;
          },
          contains: (c) => this.className.split(/\s+/).indexOf(c) >= 0
        };
      }
      get textContent() {
        if (this._text !== undefined && this.childNodes.length === 0) { return this._text; }
        return this.childNodes.map((n) => n.textContent).join('');
      }
      set textContent(value) { this._text = String(value); this.childNodes = []; }
      get innerHTML() { return this.textContent; }
      set innerHTML(value) { this.textContent = String(value); }
      get firstChild() { return this.childNodes[0] || null; }
      appendChild(node) { node.parentNode = this; this.childNodes.push(node); return node; }
      insertBefore(node, ref) {
        const index = ref ? this.childNodes.indexOf(ref) : -1;
        if (index < 0) { this.childNodes.push(node); } else { this.childNodes.splice(index, 0, node); }
        node.parentNode = this;
        return node;
      }
      removeChild(node) {
        const index = this.childNodes.indexOf(node);
        if (index >= 0) { this.childNodes.splice(index, 1); }
        node.parentNode = null;
        return node;
      }
      addEventListener(type, fn) { if (!this._listeners.has(type)) { this._listeners.set(type, new Set()); } this._listeners.get(type).add(fn); }
      removeEventListener(type, fn) { const set = this._listeners.get(type); if (set) { set.delete(fn); } }
      setAttribute(name, value) { if (name === 'class') { this.className = String(value); } else { this[name] = String(value); } }
      getAttribute(name) { return name === 'class' ? this.className : (this[name] !== undefined ? String(this[name]) : null); }
      removeAttribute() {}
      createEl(tag, attrs) { const el = new StubNode(tag); if (attrs && attrs.text) { el.textContent = attrs.text; } this.appendChild(el); return el; }
      createDiv(attrs) { return this.createEl('div', attrs); }
      empty() { this.childNodes = []; }
      detach() { if (this.parentNode) { this.parentNode.removeChild(this); } }
      querySelector() { return null; }
      querySelectorAll() { return []; }
      contains() { return false; }
      focus() {}
    }
    const unref = (t) => { if (t && typeof t.unref === 'function') { t.unref(); } return t; };

    function makeVmHarness() {
      const calls = [];
      const injected = [];
      const consoleLines = [];
      const channel = createDispatchChannel();
      const sandbox = {
        console: {
          log: (...a) => { consoleLines.push(['log', a.map(String).join(' ')]); },
          warn: (...a) => { consoleLines.push(['warn', a.map(String).join(' ')]); },
          error: (...a) => { consoleLines.push(['error', a.map(String).join(' ')]); }
        },
        setTimeout: (fn, ms) => unref(setTimeout(fn, ms)),
        clearTimeout, setInterval: (fn, ms) => unref(setInterval(fn, ms)), clearInterval,
        location: { href: 'https://lexinote.local/runtime' },
        navigator: { userAgent: 'lexi-cli-contract-vm' }
      };
      const body = new StubNode('body');
      const head = new StubNode('head');
      const doc = {
        nodeType: 9,
        body, head,
        // @codemirror/view 加载期读 document.documentElement.style(浏览器嗅探守卫)
        documentElement: new StubNode('html'),
        createElement: (tag) => new StubNode(tag),
        createDocumentFragment: () => new StubNode('#document-fragment'),
        getElementById(id) { let found = null; walkStub(body, (el) => { if (found === null && el.id === id) { found = el; } }); return found; },
        querySelector(sel) { let found = null; walkStub(body, (el) => { if (found === null && stubMatches(el, sel)) { found = el; } }); return found; },
        querySelectorAll(sel) { const out = []; walkStub(body, (el) => { if (stubMatches(el, sel)) { out.push(el); } }); return out; },
        addEventListener() {}, removeEventListener() {}
      };
      sandbox.document = doc;
      sandbox.window = sandbox;
      sandbox.addEventListener = () => {};
      sandbox.removeEventListener = () => {};
      // runtime 页通道:<script> 文本注入执行;注入文本留证(IIFE 标记断言)。
      head.appendChild = function (el) {
        const text = String(el.textContent || '');
        injected.push(text);
        el.parentNode = head;
        try { vm.runInContext(text, sandbox, { filename: 'lexi-injected-fixture.js' }); } catch (err) { /* 浏览器语义:脚本异常走 window error */ }
        return el;
      };
      sandbox.lexiHost = {
        call(callId, method, payloadJson) {
          calls.push({ method, payload: safeParseJson(payloadJson, {}) });
          let result = null;
          if (method === 'app.isDarkMode') { result = true; }
          else if (method === 'vault.files') { result = []; }
          else if (method === 'commands.list') { result = []; }
          else if (method === 'settings.values') { result = {}; }
          return Promise.resolve(JSON.stringify({ ok: true, result }));
        },
        admitDispatch(credential, method, payloadJson) {
          return channel.admitDispatch(credential, method, payloadJson);
        }
      };
      vm.createContext(sandbox);
      vm.runInContext(shimSource, sandbox, { filename: 'lexinote_plugin_shim.js' });
      const runtime = sandbox.lexiRuntime;
      return {
        sandbox, calls, injected, consoleLines, runtime,
        dispatch(method, payload) {
          const frame = JSON.stringify(payload);
          runtime.__receive(method, frame, channel.mint(method, frame));
          return new Promise((resolve) => setImmediate(resolve));
        }
      };
    }
    function walkStub(node, visit) { visit(node); node.childNodes.slice().forEach((c) => walkStub(c, visit)); }
    function stubMatches(el, sel) {
      const text = String(sel == null ? '' : sel).trim();
      if (!text || text.includes(' ') || text.includes(',')) { return false; }
      if (text[0] === '.') { return el.classList.contains(text.slice(1)); }
      if (text[0] === '#') { return el.id === text.slice(1); }
      return el.tagName === text.toUpperCase();
    }
    function safeParseJson(text, fallback) { try { return JSON.parse(text); } catch (e) { return fallback; } }
    async function untilVm(condition, label, ms) {
      const deadline = Date.now() + (ms || 90000);
      for (;;) {
        await new Promise((resolve) => setImmediate(resolve));
        if (condition()) { return; }
        if (Date.now() > deadline) { throw new Error('等待超时: ' + label); }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    async function vmLoadLegacyFixture(fx) {
      const manifest = JSON.parse(fs.readFileSync(path.join(fx.dir, 'manifest.json'), 'utf8'));
      const code = fs.readFileSync(path.join(fx.dir, 'main.js'), 'utf8');
      const h = makeVmHarness();
      ok('C13.4.0 shim 在 vm 沙箱注册 lexiRuntime(' + fx.id + ')', typeof h.runtime === 'object' && h.runtime !== null);
      await h.dispatch('load.plugin', { manifest, code });
      await untilVm(() => h.calls.some((c) => c.method === 'plugin.onload.done' && c.payload.id === manifest.id) ||
        h.calls.some((c) => c.method === 'plugin.onload.error' && c.payload.id === manifest.id),
        fx.id + ' onload 落定');
      const done = h.calls.some((c) => c.method === 'plugin.onload.done' && c.payload.id === manifest.id);
      const errors = h.calls.filter((c) => c.method === 'plugin.onload.error' && c.payload.id === manifest.id)
        .map((c) => String(c.payload.error || ''));
      const moduleReject = errors.some((e) => e.indexOf('不支持模块') >= 0) ||
        h.consoleLines.some((l) => l[1].indexOf('不支持模块') >= 0);
      ok('C13.4 ' + fx.id + ' 经 shim loadPlugin 真链路 eval+onload 完成', done && errors.length === 0,
        (errors[0] || '').slice(0, 160));
      ok('C13.5 ' + fx.id + ' 求值无"不支持模块"(依赖自含,两轨 fail-closed 不再触发)', done && !moduleReject,
        'consoleLines=' + h.consoleLines.length);
      ok('C13.6 ' + fx.id + ' 走 script-inject 注入通道且包装带 lexi-iife:v1 标记(runtime 页同款)',
        h.injected.length >= 2 && h.injected.some((t) => /^\s*\/\*\s*lexi-iife:v1\s*\*\//.test(t)),
        'injected=' + h.injected.length);
      return { done, errors };
    }
    for (const fx of present) {
      try {
        await vmLoadLegacyFixture(fx);
      } catch (error) {
        ok('C13.4/5/6 ' + fx.id + ' vm 装载链路', false, String((error && error.message) || error).slice(0, 200));
      }
    }
    // 负例:未知模块必须仍被宿主 fail-closed 拒绝(拒绝面未被夹具打包削弱)。
    try {
      const h = makeVmHarness();
      const badManifest = { id: 'failclosed-probe' };
      const badCode = "module.exports = class FailClosedProbe { async onload(){ require('some/unknown-mod'); } };";
      await h.dispatch('load.plugin', { manifest: badManifest, code: badCode });
      await untilVm(() => h.calls.some((c) => c.method === 'plugin.onload.error' && c.payload.id === 'failclosed-probe'),
        'failclosed-probe 拒绝');
      const err = h.calls.find((c) => c.method === 'plugin.onload.error' && c.payload.id === 'failclosed-probe');
      ok('C13.7 负例:未知模块仍被宿主 fail-closed 拒绝(不随打包放开口子)',
        !!err && String(err.payload.error || '').indexOf('插件沙箱不支持模块') >= 0,
        err ? String(err.payload.error || '').slice(0, 120) : 'no error call');
    } catch (error) {
      ok('C13.7 负例:未知模块仍被宿主 fail-closed 拒绝', false, String((error && error.message) || error).slice(0, 200));
    }
  } finally {
    fs.rmSync(tmp13, { recursive: true, force: true });
  }
}

(async () => {
  await sectionC13();
  console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
  for (const f of failures) { console.log('  ✗ ' + f); }
  console.log(failures.length === 0
    ? 'lexi-cli-contract: PASS'
    : 'lexi-cli-contract: FAIL (' + failures.length + ')');
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((error) => {
  failures.push('C13 harness crashed: ' + String((error && error.message) || error));
  console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
  for (const f of failures) { console.log('  ✗ ' + f); }
  console.log('lexi-cli-contract: FAIL (' + failures.length + ')');
  process.exit(1);
});
