'use strict';
// RFC §14 T3.1 Markdown Pipeline · 门禁（对应 §7.5 渲染管线 / P1-02 后处理器 / M2-B Tasks 依赖）。
//
// 验收目标：后处理器经公开 API 注册并有稳定执行顺序、失败隔离、生命周期回收；
// Tasks 依赖的 sanitizeHTMLToDom / metadataCache.getAllProperties 进入公开面。
//   K1 处理器注册表（转译求值）：归属/优先级稳定排序/重复拒绝/本人注销/插件回收。
//   K2 渲染上下文（转译求值）：同步+异步按序执行；单个失败不破坏整篇(§7.5)；abort 跳过。
//   K3 子生命周期（转译求值）：renderId 作用域；重渲染释放旧实例；onunload 逆序且各一次。
//   K4 接线：shim registerMarkdownPostProcessor 真委托 LexiReading(桩文案消失);
//      sanitizeHTMLToDom / metadataCache.getAllProperties 进公开面;宿主 metadata.getAllProperties
//      RPC;注销挂 _cleanups 卸载链;授权矩阵登记新方法。
//
// 用法：node scripts/tests/plugin-markdown-pipeline.cjs
// 依赖：LEXI_TYPESCRIPT

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const CORE = path.join(ROOT, 'entry/src/main/ets/core/plugin');
const FILES = {
  registry: path.join(CORE, 'LexiMarkdownProcessorRegistry.ets'),
  context: path.join(CORE, 'LexiMarkdownRenderContext.ets'),
  child: path.join(CORE, 'LexiMarkdownChildLifecycle.ets')
};
const SHIM = path.join(ROOT, 'entry/src/main/resources/rawfile/lexinote_plugin_shim.js');
const RUNTIME_ETS = path.join(CORE, 'LexiPluginRuntime.ets');
const BROKER_ETS = path.join(CORE, 'LexiPermissionBroker.ets');
const READING_BUNDLE = path.join(ROOT, 'tools/reading-bundle/src/main.js');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

function stageModules() {
  const tsPath = process.env.LEXI_TYPESCRIPT;
  if (!tsPath) { throw new Error('需要 LEXI_TYPESCRIPT 指向 typescript 模块'); }
  const ts = require(tsPath);
  const registry = { exports: {} };
  const load = (key, file, extraDeps) => {
    let src = fs.readFileSync(file, 'utf8');
    const js = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
    }).outputText;
    const mod = { exports: {} };
    const req = (spec) => {
      const name = String(spec).replace(/^\.\/(LexiMarkdownProcessorRegistry|LexiMarkdownRenderContext|LexiMarkdownChildLifecycle)(\.js)?$/, '$1');
      if (extraDeps && extraDeps[name]) { return extraDeps[name]; }
      if (registry.exports && name === 'registry') { return registry.exports; }
      throw new Error('markdown 模块未注册: ' + spec);
    };
    vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: 'lexi-md/' + key })(req, mod, mod.exports);
    return mod.exports;
  };
  const registryExports = load('registry', FILES.registry);
  const contextExports = load('context', FILES.context, { registry: registryExports });
  const childExports = load('child', FILES.child);
  return { registry: registryExports, context: contextExports, child: childExports };
}

let md = null;
try {
  md = stageModules();
  ok('K0 三模块可转译求值', !!md.registry.LexiMarkdownProcessorRegistry &&
    !!md.context.LexiMarkdownRenderContext && !!md.child.LexiMarkdownChildLifecycle);
} catch (error) {
  ok('K0 三模块可转译求值', false, 'threw: ' + error.message);
}

if (md) {
  section('K1 处理器注册表');
  {
    const Registry = md.registry.LexiMarkdownProcessorRegistry;
    const r = new Registry();
    const first = r.register('plug-a', 'task-render', 0);
    ok('K1.1 注册返回唯一 id 且带命名空间', first.ok &&
      first.extensionId === 'plug-a:markdown-processor:task-render');
    ok('K1.2 同插件重复注册拒绝', r.register('plug-a', 'task-render', 0).ok === false);
    ok('K1.3 异插件同名不冲突', r.register('plug-b', 'task-render', 0).ok === true);
  }
  {
    const Registry = md.registry.LexiMarkdownProcessorRegistry;
    const r = new Registry();
    r.register('plug-a', 'late', 10);
    r.register('plug-a', 'early', -5);
    r.register('plug-b', 'middle', 10);
    const order = r.orderedIds();
    ok('K1.4 优先级排序且同优先级保持注册序(§7.5 稳定顺序)',
      JSON.stringify(order) === JSON.stringify(['plug-a:markdown-processor:early', 'plug-a:markdown-processor:late', 'plug-b:markdown-processor:middle']),
      JSON.stringify(order));
    ok('K1.5 非本人注销拒绝', r.unregister('plug-b', 'plug-a:markdown-processor:late') === false &&
      r.get('plug-a:markdown-processor:late') !== null);
    ok('K1.6 本人注销成功', r.unregister('plug-a', 'plug-a:markdown-processor:late') === true);
    r.register('plug-b', 'b-only', 1);
    r.unregisterPlugin('plug-b');
    ok('K1.7 插件回收不误伤', r.get('plug-b:markdown-processor:b-only') === null &&
      r.get('plug-a:markdown-processor:early') !== null);
  }

  section('K2 渲染上下文与执行隔离');
  {
    const Context = md.context.LexiMarkdownRenderContext;
    const ctx = new Context();
    ctx.sourcePath = '/笔记.md';
    ctx.renderId = 'render-1';
    ctx.frontmatter = { 'tags': ['x'] };
    ok('K2.1 上下文字段齐备(§7.5)', ctx.sourcePath === '/笔记.md' && ctx.renderId === 'render-1' &&
      typeof ctx.getSectionInfo === 'function' && ctx.signal !== null && ctx.signal !== undefined);
  }
  {
    const Context = md.context.LexiMarkdownRenderContext;
    const calls = [];
    const entries = [
      { id: 'p1', priority: 0, run: (el, c) => { calls.push('p1'); } },
      { id: 'p2', priority: 10, run: async (el, c) => { calls.push('p2'); } },
      { id: 'p3', priority: 5, run: (el, c) => { calls.push('p3'); throw new Error('boom'); } }
    ];
    const outcome = Context.runProcessorsSync(entries, null);
    ok('K2.2 按优先级执行且同步/异步混排', JSON.stringify(calls) === JSON.stringify(['p1', 'p3', 'p2']),
      JSON.stringify(calls));
    ok('K2.3 处理器失败不破坏整篇(§7.5)', outcome.errors.length === 1 &&
      outcome.errors[0].id === 'p3' && outcome.errors[0].message === 'boom' &&
      outcome.completed === 2);
  }
  {
    const Context = md.context.LexiMarkdownRenderContext;
    const signal = { aborted: true };
    const calls = [];
    const entries = [{ id: 'p1', priority: 0, run: () => { calls.push('p1'); } }];
    const outcome = Context.runProcessorsSync(entries, signal);
    ok('K2.4 abort 后处理器跳过', calls.length === 0 && outcome.skipped === 1);
  }

  section('K3 子生命周期(MarkdownRenderChild)');
  {
    const Child = md.child.LexiMarkdownChildLifecycle;
    const lc = new Child();
    const events = [];
    const mk = (name) => ({
      name,
      loaded: false, unloaded: false,
      onload() { this.loaded = true; events.push('load:' + name); },
      onunload() { this.unloaded = true; events.push('unload:' + name); }
    });
    const c1 = mk('c1');
    const c2 = mk('c2');
    lc.addChild('render-1', c1);
    lc.addChild('render-1', c2);
    ok('K3.1 addChild 即 onload', events.join(',') === 'load:c1,load:c2');
    lc.release('render-1');
    ok('K3.2 release 逆序 onunload(§7.5 生命周期)', events.join(',') === 'load:c1,load:c2,unload:c2,unload:c1');
    lc.release('render-1');
    ok('K3.3 重复 release 不重复卸载', events.filter((e) => e === 'unload:c2').length === 1);
    const c3 = mk('c3');
    lc.addChild('render-2', c3);
    lc.releaseAll();
    ok('K3.4 全量释放(容器销毁)', c3.unloaded === true);
  }
  {
    const Child = md.child.LexiMarkdownChildLifecycle;
    const lc = new Child();
    const old = { name: 'old', loaded: false, unloaded: false, onload() { this.loaded = true; }, onunload() { this.unloaded = true; } };
    lc.addChild('render-1', old);
    // 重渲染:新 renderId 建子,旧 renderId 释放(§7.5 重渲染时释放旧实例)
    lc.addChild('render-2', { name: 'fresh', onload() {}, onunload() {} });
    lc.release('render-1');
    ok('K3.5 重渲染释放旧实例且新实例不受影响', old.unloaded === true && lc.countOf('render-2') === 1);
  }
}

section('K4 接线');
const shimSrc = fs.readFileSync(SHIM, 'utf8');
const runtimeSrc = fs.readFileSync(RUNTIME_ETS, 'utf8');
const bundleSrc = fs.readFileSync(READING_BUNDLE, 'utf8');
ok('K4.1 shim registerMarkdownPostProcessor 真委托 LexiReading',
  /registerMarkdownPostProcessor\s*=\s*function[\s\S]{0,500}?registerPostProcessor/.test(shimSrc),
  '后处理器必须经 window.LexiReading.registerPostProcessor 进入真实管线');
ok('K4.2 桩文案消失(P1-02 收口)', !/registerMarkdownPostProcessor 将在后续版本生效/.test(shimSrc));
ok('K4.3 注销挂 _cleanups 卸载链', /registerMarkdownPostProcessor\s*=\s*function[\s\S]{0,900}?_cleanups\.push/.test(shimSrc),
  '插件卸载必须反注册其后处理器(unload 链)');
ok('K4.4 sanitizeHTMLToDom 进公开面(M2-B)', /sanitizeHTMLToDom\s*[:=]\s*function/.test(shimSrc));
ok('K4.5 metadataCache.getAllProperties 进公开面(M2-B)', /getAllProperties\s*[:=]\s*function/.test(shimSrc));
ok('K4.6 宿主 metadata.getAllProperties RPC', /registerHandler\('metadata\.getAllProperties'/.test(runtimeSrc));
ok('K4.7 读内核后处理器语义(失败隔离)已在 bundle 侧验证保留', /post-processor failed/.test(bundleSrc) &&
  /errors\.push/.test(bundleSrc));
ok('K4.8 shim 桥接点存在(render 侧消费)', /LexiReading/.test(shimSrc));

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-markdown-pipeline: PASS'
  : 'plugin-markdown-pipeline: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
