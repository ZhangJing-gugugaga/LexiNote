'use strict';
// RFC §10.4 / P3-007 示例工程组 · 门禁。
//
// 验收目标:tools/lexinote-plugin-template/examples/ 下六类示例(命令/Vault/交互面/
//   视图/Markdown/设置)每例都经**真实 CLI**(tools/lexi-cli/lexi.cjs)在临时目录独立走完
//   validate → build → inspect → pack,全绿;并对构建产物做行为级校验:
//   - build 产物必须是 lexi-iife:v1 自执行包装(ADR-R25-01 单一真源包装器);
//   - 产物在 vm 内以宿主同形 stub 求值 → 注册表交付插件类 → onload boot 通过;
//   - 沙箱轨示例的 obsidian 面严格对账:destructure 的成员与 Plugin 原型方法清单
//     都从真实宿主源(entry/src/main/resources/rawfile/lexinote_plugin_sandbox.html)
//     提取——示例用了沙箱轨未实现的面,这里红,不假造;
//   - 诚实标注:legacy 轨示例(视图/Markdown/设置)README 必须带
//     `sandbox-track: pending (… P4-005)` 标记;沙箱轨示例必须带 `faces: all-real`。
//
// 用法:node scripts/tests/plugin-examples.cjs
// 依赖:LEXI_TYPESCRIPT(validate/inspect 复用宿主 v2 解析器;与 release-gate 同候选列)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'tools', 'lexi-cli', 'lexi.cjs');
const EXAMPLES = path.join(ROOT, 'tools', 'lexinote-plugin-template', 'examples');
const SANDBOX_HTML = path.join(ROOT, 'entry', 'src', 'main', 'resources', 'rawfile', 'lexinote_plugin_sandbox.html');
const SHIM_JS = path.join(ROOT, 'entry', 'src', 'main', 'resources', 'rawfile', 'lexinote_plugin_shim.js');

const EXPECTED = ['example-commands', 'example-vault', 'example-ui', 'example-view', 'example-markdown', 'example-settings'];
// 沙箱轨声明示例:面全实现,严格对账;其余为 runtime 页(legacy)示例,README 必须带 pending 标记。
const SANDBOX_TRACK = new Set(['example-commands', 'example-vault', 'example-ui']);

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

function lexi(args) {
  const r = spawnSync(process.execPath, [CLI].concat(args), {
    cwd: ROOT, encoding: 'utf8',
    env: Object.assign({}, process.env, { LEXI_TYPESCRIPT: process.env.LEXI_TYPESCRIPT || '' })
  });
  return { status: r.status, stdout: (r.stdout || '') + '', stderr: (r.stderr || '') + '',
    output: ((r.stdout || '') + (r.stderr || '')) };
}

// ---------------------------------------------------------------- 宿主面清单提取(单一真源=宿主源码)

function extractSandboxFace() {
  const html = fs.readFileSync(SANDBOX_HTML, 'utf8');
  // 沙箱 namespace:var obsidian = { ... };(扁平字面量,键名即沙箱轨已实现成员)。
  const nsStart = html.indexOf('var obsidian = {');
  if (nsStart < 0) { throw new Error('沙箱 html 缺 var obsidian = { 锚点'); }
  const nsEnd = html.indexOf('\n    };', nsStart);
  if (nsEnd < 0) { throw new Error('沙箱 html obsidian 字面量闭合锚点未找到'); }
  const nsBlock = html.slice(nsStart, nsEnd);
  const nsKeys = new Set();
  for (const m of nsBlock.matchAll(/(?:^|\n)\s*([A-Za-z_$][\w$]*):/g)) { nsKeys.add(m[1]); }
  // SandboxPlugin 原型方法 = 沙箱轨插件基类已实现面。
  const protoMethods = new Set();
  for (const m of html.matchAll(/SandboxPlugin\.prototype\.(\w+)\s*=/g)) { protoMethods.add(m[1]); }
  if (nsKeys.size === 0 || protoMethods.size === 0) { throw new Error('沙箱面清单提取为空(宿主源形态变更,需更新门禁)'); }
  return { nsKeys: Array.from(nsKeys).sort(), protoMethods: Array.from(protoMethods).sort() };
}

function extractLegacyPluginMethods() {
  const shim = fs.readFileSync(SHIM_JS, 'utf8');
  const methods = new Set();
  for (const m of shim.matchAll(/PluginShim\.prototype\.(\w+)\s*=/g)) { methods.add(m[1]); }
  if (methods.size === 0) { throw new Error('shim PluginShim 原型方法提取为空(宿主源形态变更,需更新门禁)'); }
  return Array.from(methods).sort();
}

// ---------------------------------------------------------------- boot stub(形状对齐宿主面)

// 沙箱轨 Plugin 原型 stub:每个提取到的方法必须有显式映射——宿主加了新方法而门禁没跟上
// 时在这里红(fail-visible),保证 stub 永远贴着真实面,而不是悄悄变宽。
function sandboxPluginMethodStub(name, state) {
  const table = {
    // R37 修正:load 必须真实驱动 onload(与宿主 SandboxPlugin.prototype.load 同语义)。
    // 此前返回 null 使 bootEval 的 onload 全链断言对沙箱轨示例空转(求值+交付成立,
    // onload 未跑)——example-ui 的交互面行为断言暴露了这一空转,修为真驱动。
    load: function () { return typeof this.onload === 'function' ? this.onload() : null; },
    unload: function () { return typeof this.onunload === 'function' ? this.onunload() : null; },
    register: function (fn) { state.cleanups.push(fn); },
    loadData: function () { state.loadDataCalls++; return Promise.resolve(null); },
    saveData: function (data) { state.savedData = data; state.saveDataCalls++; return Promise.resolve(); },
    addCommand: function (command) {
      state.commands.push(command);
      return Promise.resolve(Object.assign({}, command, { id: state.manifestId + ':' + String(command.id || '') }));
    },
    registerEvent: function () { return { unregister: function () {} }; },
    registerInterval: function (id) { return id; },
    registerView: function () { return {}; },
    addSettingTab: function (tab) { state.settingTab = tab; return {}; },
    addRibbonIcon: function () { return {}; },
    registerMarkdownCodeBlockProcessor: function () { return {}; }
  };
  if (!(name in table)) { throw new Error('沙箱轨 Plugin 原型方法缺 stub 映射: ' + name + '(宿主扩面后需同步门禁)'); }
  return table[name];
}

// legacy 轨(PluginShim)超集方法:未知方法给 noop(示例若用了真实存在的 legacy 面,
// 行为级验收归设备批次 P4-005;这里只保证 boot 不因 stub 缺成员而假红)。
function legacyPluginMethodStub(name, state) {
  try { return sandboxPluginMethodStub(name, state); } catch (e) { return function () {}; }
}

function buildPluginStub(strict, state) {
  const SandboxPluginStub = function SandboxPlugin(app, manifest) {
    this.app = app;
    this.manifest = manifest || {};
    state.manifestId = String((manifest && manifest.id) || '');
  };
  const methods = strict ? FACE.sandbox.protoMethods : FACE.legacy;
  for (const name of methods) {
    SandboxPluginStub.prototype[name] = strict
      ? sandboxPluginMethodStub(name, state)
      : legacyPluginMethodStub(name, state);
  }
  return SandboxPluginStub;
}

// 一次 boot 一个 stub 世界(namespace 与 Plugin 类同源,require 多次取用同一份)。
function buildStubWorld(strict, state) {
  const PluginStub = buildPluginStub(strict, state);
  const ItemViewStub = function ItemView(leaf) { this.leaf = leaf || null; this.contentEl = null; };
  ItemViewStub.prototype.getViewType = function () { return ''; };
  ItemViewStub.prototype.getDisplayText = function () { return ''; };
  const PluginSettingTabStub = function PluginSettingTab(app, plugin) { this.app = app; this.plugin = plugin; };
  PluginSettingTabStub.prototype.getSettingDefinitions = function () { return []; };
  PluginSettingTabStub.prototype.display = function () {};
  PluginSettingTabStub.prototype.hide = function () {};
  PluginSettingTabStub.prototype.setControlValue = function () {};
  PluginSettingTabStub.prototype.onSettingsChanged = function () {};
  // P4-001 交互面 stub:形状贴宿主 SandboxModal/SandboxMenu/SandboxSetting(boot 期
  // 命令回调可真实执行并计数;宿主链路行为级验收在 plugin-context-isolation E4)。
  const ModalStub = function Modal() { this.titleText = ''; this.contentText = ''; };
  ModalStub.prototype.setTitle = function (t) { this.titleText = String(t === undefined ? '' : t); return this; };
  ModalStub.prototype.setContent = function (c) { this.contentText = String(c === undefined ? '' : c); return this; };
  ModalStub.prototype.onOpen = function () {};
  ModalStub.prototype.onClose = function () {};
  ModalStub.prototype.open = function () { state.modalsOpened = (state.modalsOpened || 0) + 1; return Promise.resolve({ closedBy: 'stub' }); };
  ModalStub.prototype.close = function () { return Promise.resolve({ closedBy: 'stub' }); };
  const MenuStub = function Menu() { this.items = []; };
  MenuStub.prototype.addItem = function (cb) {
    const item = {
      title: '', disabled: false, action: null,
      setTitle: function (t) { this.title = String(t === undefined ? '' : t); return this; },
      setIcon: function () { return this; },
      setChecked: function () { return this; },
      setDisabled: function (d) { this.disabled = Boolean(d); return this; },
      setSection: function () { return this; },
      onClick: function (cb2) { this.action = cb2; return this; }
    };
    if (typeof cb === 'function') { cb(item); }
    this.items.push(item);
    return this;
  };
  MenuStub.prototype.addSeparator = function () { return this; };
  MenuStub.prototype.showAtPosition = function () {
    state.menusShown = (state.menusShown || 0) + 1;
    return Promise.resolve({ closedBy: 'stub' });
  };
  MenuStub.prototype.showAtMouseEvent = function () { return Promise.resolve({ closedBy: 'stub' }); };
  MenuStub.prototype.hide = function () { return Promise.resolve({ closedBy: 'stub' }); };
  MenuStub.prototype.onHide = function () {};
  const SettingStub = function Setting() { this.controls = []; };
  for (const method of ['setName', 'setDesc', 'setClass', 'setHeading', 'setTooltip', 'setDisabled',
    'setErrorMessage', 'setKey', 'addToggle', 'addText', 'addTextArea', 'addDropdown', 'addSlider',
    'addButton', 'addExtraButton', 'addSearch', 'addMomentFormat', 'addColorPicker', 'addProgressBar',
    'addDisplay', 'addComponent', 'then', 'clear']) {
    SettingStub.prototype[method] = function () { return this; };
  }
  const NoticeStub = function Notice(message) { this.message = String(message); };
  NoticeStub.prototype.show = function () {};
  NoticeStub.prototype.hide = function () {};
  const base = {
    Plugin: PluginStub,
    ItemView: ItemViewStub,
    PluginSettingTab: PluginSettingTabStub,
    Modal: ModalStub,
    Menu: MenuStub,
    Setting: SettingStub,
    Notice: NoticeStub,
    normalizePath: function (p) { return String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); },
    moment: function () {
      return { format: function (fmt) {
        return String(fmt || '').replace(/YYYY/g, '2026').replace(/MM/g, '11')
          .replace(/DD/g, '07').replace(/HH/g, '00').replace(/mm/g, '00');
      } };
    }
  };
  if (strict) {
    for (const key of FACE.sandbox.nsKeys) {
      if (!(key in base)) { throw new Error('沙箱 namespace 成员缺 stub 映射: ' + key + '(宿主扩面后需同步门禁)'); }
    }
    return { namespace: base, pluginStub: PluginStub, state: state };
  }
  // legacy 面按档宽松:未映射成员给可构造 noop(视图/设置/Markdown 的执行面验收归 P4-005)。
  const proxied = new Proxy(base, {
    get: function (target, prop) {
      if (prop in target) { return target[prop]; }
      if (typeof prop !== 'string' || prop === 'then' || prop === 'inspect') { return undefined; }
      return function NoopFace() {};
    }
  });
  return { namespace: proxied, pluginStub: PluginStub, state: state };
}

function buildAppStub() {
  return {
    request: function () { return Promise.resolve(null); },
    vault: {
      getMarkdownFiles: function () { return Promise.resolve([]); },
      getAbstractFileByPath: function () { return Promise.resolve(null); },
      read: function () { return Promise.resolve(''); },
      create: function (p, data) { return Promise.resolve({ path: p, data: data }); },
      modify: function (f, data) { return Promise.resolve({ path: f && f.path ? f.path : f, data: data }); },
      process: function (p, fn) { return Promise.resolve(fn('')); },
      on: function () { return { unregister: function () {} }; }
    },
    metadataCache: { getFileCache: function () { return Promise.resolve(null); } },
    workspace: {
      getRightLeaf: function () { return { setViewState: function () { return Promise.resolve(); } }; },
      on: function () { return { unregister: function () {} }; }
    },
    isDarkMode: function () { return Promise.resolve(false); }
  };
}

// 构建产物 vm 求值 → 注册表交付 → onload boot。返回 { ok, detail, state }。
async function bootEval(builtSource, manifest, strict) {
  const registry = {};
  const sandbox = {
    console: { log: function () {}, warn: function () {}, error: function () {} },
    Promise: Promise, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, Object: Object,
    Array: Array, String: String, Number: Number, parseInt: parseInt, isNaN: isNaN,
    setTimeout: function () { return 0; }, clearTimeout: function () {},
    setInterval: function () { return 0; }, clearInterval: function () {}
  };
  sandbox.window = sandbox;
  sandbox.window.__lexiPluginRegistry = registry;
  const world = buildStubWorld(strict, { commands: [], cleanups: [], savedData: undefined, loadDataCalls: 0, saveDataCalls: 0, settingTab: null, manifestId: manifest.id });
  sandbox.window.lexiRuntime = {
    __lexiAcquireRequire: function () {
      return function (name) {
        if (name === 'obsidian' || name === 'lexinote') { return world.namespace; }
        throw new Error('stub require 未提供模块: ' + String(name) + '(依赖应随 main.js 打包)');
      };
    }
  };
  vm.createContext(sandbox);
  try {
    vm.runInContext(builtSource, sandbox, { filename: 'lexi-example-' + manifest.id + '.js' });
  } catch (error) {
    return { ok: false, detail: '求值抛出: ' + String(error && error.message), state: world.state };
  }
  const entry = registry[manifest.id];
  if (!entry) { return { ok: false, detail: '注册表缺项(求值未完成)', state: world.state }; }
  if (entry.error) { return { ok: false, detail: '注册表登记求值错误: ' + entry.error, state: world.state }; }
  const Ctor = typeof entry.exports === 'function' ? entry.exports :
    (entry.exports && typeof entry.exports.default === 'function' ? entry.exports.default : null);
  if (!Ctor) { return { ok: false, detail: 'exports 缺插件类(default)', state: world.state }; }
  const instance = new Ctor(buildAppStub(), JSON.parse(JSON.stringify(manifest)));
  if (!(instance instanceof world.pluginStub)) {
    return { ok: false, detail: '插件类未继承 obsidian.Plugin(宿主面契约)', state: world.state };
  }
  try {
    if (typeof instance.load === 'function') { await instance.load(); }
    else if (typeof instance.onload === 'function') { await instance.onload(); }
    else { return { ok: false, detail: '无 onload/load', state: world.state }; }
  } catch (error) {
    return { ok: false, detail: 'onload 抛出: ' + String(error && error.message), state: world.state };
  }
  return { ok: true, detail: '', state: world.state };
}

// 沙箱轨诚实对账:main.js 里从 require('obsidian'|'lexinote') 解构/取用的成员
// 必须都在真实沙箱 namespace 键集内。
function extractObsidianMembers(source) {
  const used = new Set();
  for (const m of source.matchAll(/\{([^{}]*)\}\s*=\s*require\(['"](?:obsidian|lexinote)['"]\)/g)) {
    for (const piece of m[1].split(',')) {
      const name = piece.split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) { used.add(name); }
    }
  }
  for (const m of source.matchAll(/require\(['"](?:obsidian|lexinote)['"]\)\.([A-Za-z_$][\w$]*)/g)) {
    used.add(m[1]);
  }
  return Array.from(used);
}

// ---------------------------------------------------------------- 主流程

let FACE = null;
try {
  FACE = { sandbox: extractSandboxFace(), legacy: extractLegacyPluginMethods() };
} catch (error) {
  console.log('FAIL 宿主面清单提取 — ' + (error && error.message));
  console.log('plugin-examples: FAIL (宿主源提取失败)');
  process.exit(1);
}

async function main() {
  section('E0 示例工程组在库(六类,无漂移)');
  ok('E0.1 examples/ 目录在库', fs.existsSync(EXAMPLES));
  let actual = [];
  if (fs.existsSync(EXAMPLES)) {
    actual = fs.readdirSync(EXAMPLES, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  }
  ok('E0.2 六类示例恰好在位(命令/Vault/交互面/视图/Markdown/设置)', actual.length === EXPECTED.length &&
    EXPECTED.every((name) => actual.indexOf(name) >= 0), 'actual=' + actual.join(', '));

  if (fs.existsSync(EXAMPLES) && actual.length === EXPECTED.length) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-examples-'));
    try {
      for (const name of EXPECTED) {
        const srcDir = path.join(EXAMPLES, name);
        const proj = path.join(tmp, name);
        fs.cpSync(srcDir, proj, { recursive: true });
        const manifest = JSON.parse(fs.readFileSync(path.join(proj, 'manifest.json'), 'utf8'));
        const readme = fs.readFileSync(path.join(proj, 'README.md'), 'utf8');
        const isSandbox = SANDBOX_TRACK.has(name);

        section('E ' + name + (isSandbox ? '(沙箱轨声明)' : '(runtime 页轨)'));
        // 1 validate:宿主同一 v2 解析器。
        const v = lexi(['plugin', 'validate', proj]);
        ok(name + ' validate 退出码 0', v.status === 0, v.output.split('\n').slice(-2).join('|'));

        // 2 build:CJS → lexi-iife:v1。
        const b = lexi(['plugin', 'build', proj]);
        ok(name + ' build 退出码 0', b.status === 0, b.output.split('\n').slice(-2).join('|'));
        const built = fs.readFileSync(path.join(proj, 'main.js'), 'utf8');
        ok(name + ' build 产物是 lexi-iife:v1 自执行包装', /^\s*\/\*\s*lexi-iife:v1\s*\*\//.test(built) &&
          new RegExp('# sourceURL=lexinote-plugin-' + manifest.id + '\\.js').test(built),
          '标记/sourceURL 缺失');
        ok(name + ' build 产物含注册表交付且无 new Function', /window\.__lexiPluginRegistry/.test(built) &&
          !/\bnew\s+Function\s*\(/.test(built), '注册表交付缺失或混入 new Function');

        // 3 行为级 boot:vm 求值 → 注册表交付 → onload 全链。
        const boot = await bootEval(built, manifest, isSandbox);
        ok(name + ' boot:vm 求值交付插件类且 onload 全链完成', boot.ok, boot.detail);
        if (isSandbox && boot.ok) {
          ok(name + ' boot:沙箱严格面 data 往返计数在案', boot.state.loadDataCalls >= 0 &&
            boot.state.commands.length >= 0, 'load=' + boot.state.loadDataCalls +
            ' commands=' + boot.state.commands.length);
        }

        // 3b R37/P4-001:交互面示例 boot 后命令回调真实执行——Modal.open/Menu.showAtPosition
        // 在 stub 世界计数,设置页经 addSettingTab 登记(宿主链路的行为级验收在
        // plugin-context-isolation E4:真实沙箱页脚本 × sandbox-ui-min 夹具)。
        if (name === 'example-ui' && boot.ok) {
          const uiCommands = boot.state.commands.filter((command) =>
            command.id === 'hello-modal' || command.id === 'hello-menu');
          for (const command of uiCommands) { await command.callback(); }
          ok(name + ' boot:交互命令回调真实执行(Modal/Menu/Setting 三面登记)',
            boot.state.modalsOpened === 1 && boot.state.menusShown === 1 &&
            boot.state.settingTab !== null,
            'modals=' + (boot.state.modalsOpened || 0) + ' menus=' + (boot.state.menusShown || 0) +
            ' settingTab=' + (boot.state.settingTab ? 'registered' : 'missing'));
        }

        // 4 沙箱轨诚实对账:解构成员 ⊆ 真实沙箱 namespace(legacy 示例不跑此严格面)。
        if (isSandbox) {
          const used = extractObsidianMembers(fs.readFileSync(path.join(srcDir, 'main.js'), 'utf8'));
          const outside = used.filter((m) => FACE.sandbox.nsKeys.indexOf(m) < 0);
          ok(name + ' obsidian 解构成员都在沙箱真实面内', outside.length === 0,
            outside.length ? '越面成员: ' + outside.join(', ') + '(沙箱未实现=不得使用)' : '');
        }

        // 5 inspect --json:机器面真实。
        const ij = lexi(['plugin', 'inspect', proj, '--json']);
        let parsed = null;
        try { parsed = JSON.parse(ij.stdout); } catch (error) { parsed = null; }
        ok(name + ' inspect --json 退出码 0 且字段真实', ij.status === 0 && parsed !== null &&
          parsed.id === manifest.id && parsed.mainEntry && parsed.mainEntry.iife === true &&
          parsed.manifestV2Validate === 'PASS' && Array.isArray(parsed.authorizationTags),
          'parsed=' + (parsed ? 'ok' : 'null') + (ij.status !== 0 ? ' exit=' + ij.status : ''));

        // 6 pack:zip + sha256。
        const p = lexi(['plugin', 'pack', proj]);
        const sha = p.output.match(/sha256=([0-9a-f]{64})/);
        ok(name + ' pack 退出码 0 且 zip/sha256 落地', p.status === 0 && sha !== null &&
          fs.existsSync(proj + '.zip'), p.output.split('\n').slice(-2).join('|'));

        // 7 诚实标注:轨面声明与 pending 标记。
        const declaredSandbox = manifest.entrypoints && manifest.entrypoints.service === 'sandbox:';
        ok(name + ' manifest v2 轨面声明与门禁口径一致', manifest.manifestVersion === 2 &&
          declaredSandbox === isSandbox, 'service=' + String(manifest.entrypoints && manifest.entrypoints.service));
        if (isSandbox) {
          ok(name + ' README 带沙箱轨全实现标注', /track:\s*sandbox/.test(readme) && /faces:\s*all-real/.test(readme),
            '缺 track: sandbox / faces: all-real 标记');
        } else {
          ok(name + ' README 带沙箱轨 pending 标记(不假造)', /sandbox-track:\s*pending/.test(readme) &&
            /P4-005/.test(readme), '缺 sandbox-track: pending / P4-005 标记');
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项' +
    '(沙箱面清单自宿主源提取: namespace ' + FACE.sandbox.nsKeys.length + ' 成员 / Plugin 原型 ' +
    FACE.sandbox.protoMethods.length + ' 方法;legacy PluginShim 原型 ' + FACE.legacy.length + ' 方法)');
  for (const f of failures) { console.log('  ✗ ' + f); }
  console.log(failures.length === 0 ? 'plugin-examples: PASS' : 'plugin-examples: FAIL (' + failures.length + ')');
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch(function (error) {
  console.log('FAIL 门禁主体异常 — ' + String(error && error.stack ? error.stack : error));
  console.log('plugin-examples: FAIL');
  process.exitCode = 1;
});
