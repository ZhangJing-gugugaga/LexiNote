'use strict';
// RFC §14 T2.1 Manifest v2 · 门禁（对应 §8.1 包规范 / §8.2 旧版本迁移）。
//
// 验收目标：manifestVersion=2 严格校验；未知 capability 拒绝（不得静默忽略）；
// 未声明能力=没有能力；v1→v2 迁移逐字段对账；旧权限不自动继承为 Native 权限
// （legacy profile 标记）；v2 清单不得携带自身 ZIP 指纹（sha256 归签名 Registry Target）。
//   V1 真实解析器（转译求值）：合法 v2 / 非法版本 / 未知能力 / 畸形版本号 / 入口声明。
//   V2 schema：manifest-v2.schema.json 存在且与解析器的已知能力键完全一致（单一真源对账）。
//   V3 迁移：§8.2 映射表逐字段；迁移产物带 legacyProfile 标记。
//   V4 接线：宿主 scanPluginDir 对 v2 清单走严格解析（未知 capability 即插件拒绝）。
//
// 用法：node scripts/tests/plugin-manifest-v2.cjs
// 依赖：LEXI_TYPESCRIPT

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const CORE = path.join(ROOT, 'entry/src/main/ets/core/plugin');
const V2_ETS = path.join(CORE, 'LexiPluginManifestV2.ets');
const SCHEMA = path.join(ROOT, 'tools/plugin-contract/schema/manifest-v2.schema.json');
const RUNTIME_ETS = path.join(CORE, 'LexiPluginRuntime.ets');
const MANIFEST_ETS = path.join(CORE, 'LexiPluginManifest.ets');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

function loadV2() {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { throw new Error('需要 LEXI_TYPESCRIPT 指向 typescript 模块'); }
  const ts = require(tsPath);
  const js = ts.transpileModule(fs.readFileSync(V2_ETS, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: 'LexiPluginManifestV2.ets' })(
    () => { throw new Error('ManifestV2 模块必须零依赖'); }, mod, mod.exports);
  return mod.exports;
}

function v2Base(overrides) {
  return Object.assign({
    manifestVersion: 2,
    id: 'plug-v2',
    name: 'V2 Plugin',
    version: '1.0.0',
    author: 't',
    license: 'MIT'
  }, overrides || {});
}

let v2 = null;
try {
  v2 = loadV2();
  ok('V0 ManifestV2 模块可转译求值', !!v2.parseManifestV2);
} catch (error) {
  ok('V0 ManifestV2 模块可转译求值', false, 'threw: ' + error.message);
}

function parse(json) {
  try {
    const result = v2.parseManifestV2(JSON.stringify(json));
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

if (v2) {
  section('V1 严格解析');
  {
    const r = parse(v2Base());
    ok('V1.1 最小合法 v2 解析成功', r.ok === true && r.result !== null);
    if (r.ok) {
      ok('V1.2 归一化:未声明能力=没有能力', r.result.capabilities.fs === false &&
        r.result.capabilities.network.length === 0 && r.result.capabilities.clipboard === false);
    }
  }
  {
    const r = parse({ id: 'x', name: 'x', version: '1.0.0', author: 't', license: 'MIT' });
    ok('V1.3 缺 manifestVersion ≠ v2(按 v1 处理或明确拒绝,不得当 v2)', r.ok === false || r.result.manifestVersion === 1);
  }
  {
    const r = parse(v2Base({ manifestVersion: 3 }));
    ok('V1.4 未来版本号拒绝(fail-closed)', r.ok === false);
  }
  {
    const r = parse(v2Base({ capabilities: { fsextra: true } }));
    ok('V1.5 未知顶层 capability 拒绝(RFC §8.1 不得静默忽略)', r.ok === false &&
      /capability/i.test(r.error), r.error || '');
  }
  {
    const r = parse(v2Base({ capabilities: { vault: { read: { enabled: true }, unknownKey: true } } }));
    ok('V1.6 未知嵌套 capability 键拒绝', r.ok === false && /capability/i.test(r.error), r.error || '');
  }
  {
    const r = parse(v2Base({ version: '1.x' }));
    ok('V1.7 畸形版本号拒绝', r.ok === false);
  }
  {
    const r = parse(v2Base({ id: 'Bad_Id' }));
    ok('V1.8 非法 id 拒绝(与 v1 同一 id 规则)', r.ok === false);
  }
  {
    const r = parse(v2Base({ sha256: 'abc123' }));
    ok('V1.9 v2 清单携带自身 sha256 拒绝(§8.1: hash 归签名 Registry Target)', r.ok === false &&
      /sha256/i.test(r.error), r.error || '');
  }
  {
    const r = parse(v2Base({
      capabilities: {
        vault: { write: { enabled: true, paths: ['项目/**'] } },
        network: { origins: ['https://api.example.com'], methods: ['GET', 'POST'] }
      }
    }));
    ok('V1.10 v2 能力归一化进既有模型', r.ok === true && r.result.capabilities.fs === true &&
      r.result.capabilities.network.indexOf('api.example.com') >= 0);
    if (r.ok) {
      ok('V1.11 v2 细粒度能力保留在 v2 视图', r.result.v2 !== null &&
        r.result.v2.vault.write.enabled === true && r.result.v2.vault.write.paths.length === 1);
    }
  }
  {
    const r = parse(v2Base({
      entrypoints: { service: 'main.js' },
      platforms: ['harmonyos-phone'],
      compatibility: { obsidianApiLevel: '1.14.4' }
    }));
    ok('V1.12 entrypoints/platforms/compatibility 可选声明', r.ok === true);
  }
  {
    const r = parse(v2Base({ platforms: ['win32-desktop'] }));
    ok('V1.13 未知 platform 拒绝', r.ok === false && /platform/i.test(r.error), r.error || '');
  }

  section('V2 schema 对账');
  ok('V2.1 manifest-v2.schema.json 存在', fs.existsSync(SCHEMA));
  if (fs.existsSync(SCHEMA)) {
    let schema = null;
    try { schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8')); } catch (e) { schema = null; }
    ok('V2.2 schema 可解析且为 draft-07', schema !== null && schema.$schema && schema.$schema.indexOf('draft-07') >= 0);
    const caps = schema && schema.properties && schema.properties.capabilities;
    ok('V2.3 schema capabilities additionalProperties=false',
      caps !== undefined && caps.additionalProperties === false,
      '未知 capability 必须在 schema 层也拒绝');
    const known = typeof v2.knownCapabilityKeys === 'function' ? v2.knownCapabilityKeys() : [];
    ok('V2.4 schema 能力键 == 解析器已知键(单一真源)', known.length > 0 && caps && caps.properties &&
      JSON.stringify(Object.keys(caps.properties).sort()) === JSON.stringify(known.sort()));
    const vaultSchema = caps && caps.properties && caps.properties.vault;
    ok('V2.5 schema 嵌套对象同样封口', vaultSchema !== undefined && vaultSchema.additionalProperties === false);
  }

  section('V3 v1→v2 迁移(RFC §8.2)');
  {
    const v1 = {
      id: 'legacy-plugin', name: 'Legacy', version: '0.9.0', author: 't',
      minAppVersion: '1.10.0',
      capabilities: { fs: true, network: ['https://old.example.com'], clipboard: true }
    };
    const m = v2.migrateManifestV1(JSON.stringify(v1));
    ok('V3.1 迁移产出 v2 形状', m !== null && m.manifestVersion === 2);
    ok('V3.2 minAppVersion → compatibility.obsidianApiLevel', m.compatibility.obsidianApiLevel === '1.10.0');
    ok('V3.3 capabilities.fs → vault.write.enabled', m.capabilities.vault.write.enabled === true);
    ok('V3.4 capabilities.network → network.origins', m.capabilities.network.origins.indexOf('https://old.example.com') >= 0);
    ok('V3.5 capabilities.clipboard → clipboard(读或写)', m.capabilities.clipboard.read === true || m.capabilities.clipboard.write === true);
    ok('V3.6 迁移产物带 legacyProfile 标记(旧权限不自动继承为 Native 权限)', m.legacyProfile === true);
    const parsed = parse(m);
    ok('V3.7 迁移产物可通过 v2 严格解析', parsed.ok === true, parsed.error || '');
    if (parsed.ok) {
      ok('V3.8 解析视图保留 legacy 标记', parsed.result.legacyProfile === true);
    }
  }
  {
    const v1 = { id: 'plain', name: 'Plain', version: '1.0.0', author: 't', isDesktopOnly: true };
    const m = v2.migrateManifestV1(JSON.stringify(v1));
    ok('V3.9 isDesktopOnly → platforms 桌面标记', Array.isArray(m.platforms) && m.platforms.length > 0);
    ok('V3.10 无 capabilities 的 v1 迁移后无任何能力', m.capabilities.vault.write.enabled === false &&
      m.capabilities.network.origins.length === 0);
  }
}

section('V4 宿主接线');
const runtimeSrc = fs.existsSync(RUNTIME_ETS) ? fs.readFileSync(RUNTIME_ETS, 'utf8') : '';
const manifestSrc = fs.existsSync(MANIFEST_ETS) ? fs.readFileSync(MANIFEST_ETS, 'utf8') : '';
ok('V4.1 宿主清单解析接入 v2 严格路径', /parseManifestV2|manifestVersion\s*===\s*2/.test(manifestSrc) &&
  /from\s+'\.\/LexiPluginManifestV2'/.test(manifestSrc),
  'parsePluginManifest 必须对 manifestVersion=2 走严格解析(未知 capability=插件拒绝)');
ok('V4.2 v1 legacy 语义保留', /legacy-v1|legacy-unattributed/.test(manifestSrc),
  'checkFsCapability 的 v1 legacy 分支必须保留(存量四夹具兼容)');
ok('V4.3 扫描拒绝落 errorState(既有行为)', /broken:/.test(runtimeSrc),
  'scanPluginDir 对解析失败的插件维持 broken: 记录');

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-manifest-v2: PASS'
  : 'plugin-manifest-v2: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
