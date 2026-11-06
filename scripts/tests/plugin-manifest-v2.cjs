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
const INSTALLER_ETS = path.join(CORE, 'LexiPluginInstaller.ets');

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
ok('V4.4 P2-001 细粒度视图穿透到执行面', /v2:\s*LexiManifestV2Caps/.test(manifestSrc) &&
  /manifest\.v2\s*=\s*v2\.v2/.test(manifestSrc),
  'LexiPluginManifest 必须携带 v2 细粒度视图并在 manifestFromV2 里透传,否则 paths/quota/notifications 在执行面不可见(P0-03 根因)');
ok('V4.5 P2-002 能力标签唯一正典接线(宿主双副本归一)',
  /capabilityTagsOfV2Caps\(manifest\.v2\)/.test(runtimeSrc) &&
  /capabilityTagsOfV2Caps\(manifest\.v2\)/.test(fs.readFileSync(INSTALLER_ETS, 'utf8')),
  'runtime 与 installer 的 capabilityTagsOf 必须在 v2 分支调用同一正典函数,禁止再各自维护副本');

// --- V5 P2-001/P2-002 行为断言(真转译,不是文本正则) ----------------------
section('V5 细粒度视图与标签正典(真跑)');
const tsPath5 = process.env.LEXI_TYPESCRIPT;
if (!tsPath5) { throw new Error('需要 LEXI_TYPESCRIPT'); }
{
  const ts5 = require(tsPath5);
  const load = (file, requireShim) => {
    const js = ts5.transpileModule(fs.readFileSync(file, 'utf8'),
      { compilerOptions: { module: ts5.ModuleKind.CommonJS, target: ts5.ScriptTarget.ES2021 } }).outputText;
    const mod = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: file })(requireShim, mod, mod.exports);
    return mod.exports;
  };
  const v2mod = load(V2_ETS, () => { throw new Error('V2 模型必须零依赖'); });
  const manifestMod = load(MANIFEST_ETS, (spec) => {
    if (String(spec).indexOf('LexiPluginManifestV2') >= 0) { return v2mod; }
    throw new Error('意外依赖: ' + spec);
  });

  const V2_WITH_FINE = {
    manifestVersion: 2, id: 'fine-plugin', name: 'Fine', version: '1.0.0', author: 't',
    capabilities: {
      vault: { read: { enabled: true, paths: ['notes/**/*.md'] }, write: { enabled: true, paths: ['notes/draft/'] }, delete: true },
      editor: { readActive: true, writeSelection: false, writeDocument: true, extensions: 'none' },
      workspace: { commands: true, views: false },
      network: { origins: ['api.example.com'], methods: ['GET'], maxRequestBytes: 65536, maxResponseBytes: 1048576 },
      clipboard: { read: false, write: true },
      storage: { quotaBytes: 2097152 },
      notifications: true
    }
  };
  const fine = manifestMod.parsePluginManifest(JSON.stringify(V2_WITH_FINE));
  ok('V5.1 v2 细粒度视图穿透(manifest.v2 可读)', fine.manifestVersion === 2 &&
    fine.v2.editor.writeDocument === true && fine.v2.storage.quotaBytes === 2097152 &&
    fine.v2.vault.write.paths.length === 1 && fine.v2.vault.write.paths[0] === 'notes/draft/',
    'manifest.v2 必须携带 editor/storage/paths 细节(P2-001)');
  ok('V5.2 v1 清单不继承细粒度能力(默认全关)', (() => {
    const v1 = manifestMod.parsePluginManifest(JSON.stringify({ id: 'old-plugin', name: 'Old', version: '1.0.0', author: 't' }));
    return v1.manifestVersion === 1 && v1.v2.editor.writeDocument === false &&
      v1.v2.storage.quotaBytes === 1048576 && v1.v2.vault.write.enabled === false;
  })(), '旧清单的 v2 视图必须是默认全关(旧权限不自动细粒度化,§8.2)');

  const tagsOf = v2mod.capabilityTagsOfV2Caps;
  const baseTags = tagsOf(fine.v2);
  ok('V5.3 正典标签逐维产出', baseTags.indexOf('vault.read:notes/**/*.md') >= 0 &&
    baseTags.indexOf('vault.write:notes/draft/') >= 0 && baseTags.indexOf('vault.delete') >= 0 &&
    baseTags.indexOf('editor.writeDocument') >= 0 && baseTags.indexOf('workspace.commands') >= 0 &&
    baseTags.indexOf('network:api.example.com') >= 0 && baseTags.indexOf('netmethod:GET') >= 0 &&
    baseTags.indexOf('netreq:65536') >= 0 && baseTags.indexOf('clipboard.write') >= 0 &&
    baseTags.indexOf('storage.quota:2097152') >= 0 && baseTags.indexOf('notifications') >= 0,
    '标签集必须覆盖 §4.4 全部维度(含数字上限)');
  const grown = JSON.parse(JSON.stringify(fine.v2));
  grown.editor.writeDocument = false; grown.editor.writeSelection = true; // 同级替换
  grown.storage.quotaBytes = 4194304; grown.network.methods = ['GET', 'POST'];
  const grownTags = tagsOf(grown);
  ok('V5.4 权限扩张必然改变标签集(指纹敏感)', (() => {
    const sortJoin = (a) => a.slice().sort().join('|');
    return sortJoin(baseTags) !== sortJoin(grownTags) && grownTags.indexOf('editor.writeSelection') >= 0 &&
      grownTags.indexOf('storage.quota:4194304') >= 0 && grownTags.indexOf('netmethod:POST') >= 0;
  })(), '范围/配额/方法扩张必须可被指纹捕获,否则新增权限静默继承(P0-03)');
  const shrink = tagsOf(fine.v2).length;
  const noneAll = tagsOf(v2mod.LexiManifestV2Caps ? new v2mod.LexiManifestV2Caps() : (() => { throw new Error('x'); })());
  ok('V5.5 全默认视图只产出恒定上限标签', noneAll.length < shrink && noneAll.indexOf('editor.writeDocument') < 0 &&
    noneAll.indexOf('netreq:65536') >= 0, '未声明能力=没有能力;默认上限标签恒定(基线指纹稳定)');

  // --- V5b P2-004 路径级白名单(真跑) -------------------------------------
  const pathAllowed = manifestMod.vaultPathAllowed;
  ok('V5.6 前缀与精确命中', pathAllowed('notes/draft/a.md', true, ['notes/draft/']) &&
    pathAllowed('notes/a.md', true, ['notes/a.md']) && !pathAllowed('notes/other.md', true, ['notes/draft/']),
    '目录前缀(尾 /)与精确路径两种形态');
  ok('V5.7 单段通配不跨段', pathAllowed('notes/2024.md', true, ['notes/' + String.fromCharCode(42) + '.md']) &&
    !pathAllowed('notes/sub/2024.md', true, ['notes/' + String.fromCharCode(42) + '.md']),
    '星号不跨 / (SEC-009 路径穿越防线的一部分)');
  ok('V5.8 跨段通配含零段', pathAllowed('notes/2024.md', true, ['notes/' + String.fromCharCode(42, 42) + '.md']) &&
    pathAllowed('notes/sub/deep/2024.md', true, ['notes/' + String.fromCharCode(42, 42) + '.md']) &&
    !pathAllowed('vault/other.md', true, ['notes/' + String.fromCharCode(42, 42) + '.md']),
    '双星匹配任意深度含零段');
  ok('V5.9 disabled 一律拒绝 / 空 patterns 全库', !pathAllowed('any.md', false, ['**']) &&
    pathAllowed('any/deep/file.md', true, []),
    'enabled=false 优先;空白名单=全库(与旧 fs 布尔语义一致)');

  // --- V5c R27 P2-005 editor 分级档位:readActive/writeSelection/writeDocument 三档标签 ---
  // 三档是独立授权单元:声明↔标签一一对应(未声明不产出),任何一档扩张都改变指纹(regrant)。
  ok('V5.10 editor 三档标签逐档产出(声明才入标签,未声明=没有能力)', (() => {
    const mk = (flags) => {
      const caps = new v2mod.LexiManifestV2Caps();
      caps.editor.readActive = flags.readActive === true;
      caps.editor.writeSelection = flags.writeSelection === true;
      caps.editor.writeDocument = flags.writeDocument === true;
      return tagsOf(caps);
    };
    const none = mk({});
    const all = mk({ readActive: true, writeSelection: true, writeDocument: true });
    return none.indexOf('editor.readActive') < 0 && none.indexOf('editor.writeSelection') < 0 &&
      none.indexOf('editor.writeDocument') < 0 &&
      all.indexOf('editor.readActive') >= 0 && all.indexOf('editor.writeSelection') >= 0 &&
      all.indexOf('editor.writeDocument') >= 0;
  })(), 'P2-005:editor 档位标签缺失/错档都会让授权面板与指纹失真');
  ok('V5.11 editor 单档扩张改变标签集(writeSelection ↔ writeDocument 同级替换可对账)', (() => {
    const sortJoin = (a) => a.slice().sort().join('|');
    const mk = (readActive, writeSelection, writeDocument) => {
      const caps = new v2mod.LexiManifestV2Caps();
      caps.editor.readActive = readActive;
      caps.editor.writeSelection = writeSelection;
      caps.editor.writeDocument = writeDocument;
      return tagsOf(caps);
    };
    return sortJoin(mk(true, false, true)) !== sortJoin(mk(true, true, false));
  })(), '档位互换必须可被授权指纹捕获(升级新增写档位 ⇒ regrant-required)');

  // --- V6 P5-004 分级呈现(RFC §4.5 必需/可选/高风险,真跑) ------------------
  const classify = v2mod.classifyCapabilityTags;
  const fineView = classify(baseTags);
  ok('V6.1 高风险档 = 笔记读改删/敏感读取/网络外联', fineView.risky.indexOf('vault.delete') >= 0 &&
    fineView.risky.indexOf('vault.write:notes/draft/') >= 0 && fineView.risky.indexOf('vault.read:notes/**/*.md') >= 0 &&
    fineView.risky.indexOf('editor.writeDocument') >= 0 && fineView.risky.indexOf('editor.readActive') >= 0 &&
    fineView.risky.indexOf('network:api.example.com') >= 0,
    '§4.5 披露面(修改笔记/剪贴板/网络)必须落入高风险档');
  ok('V6.2 可选档 = 纯增量体验面', fineView.optional.indexOf('clipboard.write') >= 0 &&
    fineView.optional.indexOf('notifications') >= 0 && fineView.optional.indexOf('netmethod:GET') >= 0,
    '通知/剪贴板写/方法收紧归可选档');
  ok('V6.3 必需档 = 基础交互面与配额基线', fineView.required.indexOf('workspace.commands') >= 0 &&
    fineView.required.indexOf('netreq:65536') >= 0 && fineView.required.indexOf('storage.quota:2097152') >= 0,
    '基线配额标签恒入必需档(披露性,不代表危险能力)');
  ok('V6.4 分档是全集划分(纯展示,不吞标签)', (() => {
    const union = fineView.risky.concat(fineView.optional, fineView.required).sort().join('|');
    return union === baseTags.slice().sort().join('|');
  })(), '三档并集必须等于正典标签全集;指纹与授权仍以全集为准');
  ok('V6.5 空标签集产出空视图', (() => {
    const emptyView = classify([]);
    return emptyView.risky.length === 0 && emptyView.optional.length === 0 && emptyView.required.length === 0;
  })(), '未声明能力的插件授权面板显示"未声明能力"而不是编造条目');
}

// --- V7 P1-003d(R28) 内置沙箱轨夹具清单对账(真解析,不是文本正则) ----------------
section('V7 内置沙箱轨夹具清单(真跑)');
{
  const ts7 = require(process.env.LEXI_TYPESCRIPT);
  const load7 = (file, requireShim) => {
    const js = ts7.transpileModule(fs.readFileSync(file, 'utf8'),
      { compilerOptions: { module: ts7.ModuleKind.CommonJS, target: ts7.ScriptTarget.ES2021 } }).outputText;
    const mod = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: file })(requireShim, mod, mod.exports);
    return mod.exports;
  };
  const v2mod7 = load7(V2_ETS, () => { throw new Error('V2 模型必须零依赖'); });
  const manifestMod7 = load7(MANIFEST_ETS, (spec) => {
    if (String(spec).indexOf('LexiPluginManifestV2') >= 0) { return v2mod7; }
    throw new Error('意外依赖: ' + spec);
  });
  const fixtureIds = ['lexi-sample-plugin', 'sandbox-probe', 'sandbox-sample-min',
    'sandbox-editor-min', 'sandbox-sec-probe'];
  for (const fixtureId of fixtureIds) {
    const manifestPath = path.join(ROOT, 'entry', 'src', 'main', 'resources', 'rawfile', 'plugins',
      fixtureId, 'manifest.json');
    if (!fs.existsSync(manifestPath)) { continue; }
    try {
      const normalized = manifestMod7.parsePluginManifest(fs.readFileSync(manifestPath, 'utf8'));
      ok('V7.' + fixtureId + ' 内置夹具清单严格解析通过且声明沙箱轨', normalized.manifestVersion === 2 &&
        normalized.sandboxService === true && normalized.id === fixtureId,
        '内置沙箱轨夹具必须 v2 严格清单 + entrypoints.service="sandbox:"(声明式 opt-in)');
    } catch (error) {
      ok('V7.' + fixtureId + ' 内置夹具清单严格解析通过且声明沙箱轨', false,
        'parsePluginManifest threw: ' + error.message);
    }
  }
}

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-manifest-v2: PASS'
  : 'plugin-manifest-v2: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
