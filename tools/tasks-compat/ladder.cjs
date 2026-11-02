#!/usr/bin/env node
'use strict';
// HARNESS-ONLY gap ladder for obsidian-tasks 8.6.0.
//
// Each level closes one hole that the SHIPPED rawfile shim really has. The stubs are
// injected into the live jsdom namespace copy by tools/tasks-compat/ladder-stubs.cjs;
// nothing under entry/src/main/resources/rawfile is edited, so on a real device every
// hole in this table is still open. 'harness 已补' never means '产品已实现'.
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, '.fixtures-out', 'tasks-compat');
const { LEVELS } = require(path.join(__dirname, 'ladder-stubs.cjs'));
const harness = require(path.join(__dirname, 'harness.cjs'));

const HARNESS_ONLY = 'HARNESS-ONLY: stub 只活在 jsdom harness 里，rawfile 一个字节没改，真实(设备)上这一条仍是缺的';
const FENCE = String.fromCharCode(96, 96, 96); // markdown code fence
const FIXTURE_PREFIX = 'tools/plugins-fixtures/local/obsidian-tasks/';

// A rejection that lands after a harness window closed would kill the gate by
// accident; park it so the ladder stays deterministic and still reports it.
const lateRejections = [];
process.on('unhandledRejection', (e) => lateRejections.push(String((e && e.message) || e)));

const NOT_PROVEN = [
  '每级 stub 都遮蔽了一条真实缺口：3 条（EditorSuggest / getLanguage / app.scope）在设备上仍是缺的，表里"harness 已补"不能读成"产品已实现"。',
  '结论只在 jsdom 成立：window.lexiHost 是桩（只回一条固定 markdown），没有真实 vault/workspace/编辑器；布局、getClientRects、flatpickr 日历、CodeMirror 输入这些路径在 jsdom 里根本没跑。',
  'plugin.onload.done 只证明我们的 loader 把 onload 调完并回来了，不证明插件在应用里可用（命令面板、设置页、编辑期实时更新都没验）。',
  '页面上那 2 个 checkbox 是 markdown 渲染器自带的，不是插件产物；点击不回写源码。插件自己的 checkbox 交互一次都没证明过。',
  'L5 的"插件自有 DOM"用元素总数增量度量：只改 class/属性、净增 0 个元素的 post-processor 会被判成没产出（本 fixture 增量非 0）。',
  '缺口之后的缺口数未知：最内层失败已推进到 MarkdownRenderer.render（rawfile 里是桩，lexinote_plugin_shim.js:2126），其后仍残留被插件自己吞掉的错误（main.js:599 sanitizeHTMLToDom、metadataCache.getAllProperties），按边界没有继续爬。',
  '原型挂载只在 jsdom 里验过：真机 ArkWeb 上 Element.prototype 与 jsdom 是否同构、扩充是否有宿主侧副作用，本轮都没有证明。'
];

function describe(res) {
  if (res.onloadAnchor) {
    const tail = res.firstError
      ? '（仍剩被插件自己吞掉的非致命错误 ' + res.firstError.message + ' @ main.js:' + res.firstError.fixtureLine + '）'
      : '';
    return 'none — plugin.onload.done reached' + tail;
  }
  const e = res.firstError;
  if (!e) return 'no fixture error captured, and plugin.onload.done never appeared';
  return e.message + ' @ main.js:' + (e.fixtureLine === null || e.fixtureLine === undefined ? '?' : e.fixtureLine);
}

function pluginCalls(res) {
  return (res.load.hostMethods || []).filter((m) => m.indexOf('plugin.') === 0);
}

// Red-light only: pull the shipped reader's prototype helpers back out of the jsdom
// window, so the ladder runs on the pre-fix world (helpers reaching only the nodes the
// kernel happened to patch by hand) without touching a single product byte.
const DOM_HELPER_NAMES = [
  'find', 'findAll', 'createEl', 'createDiv', 'createSpan', 'empty',
  'addClass', 'removeClass', 'hasClass', 'setAttr', 'getAttr', 'appendText'
];

function stripDomHelpers(w, names) {
  const proto = w.Element.prototype;
  const removed = [];
  for (const name of (Array.isArray(names) ? names : DOM_HELPER_NAMES)) {
    if (typeof proto[name] !== 'function') continue;
    delete proto[name];
    removed.push(name);
  }
  return { removed };
}

async function climb(levels, opts) {
  const strip = opts && opts.stripDomHelpers;
  return harness.run({
    prepare: (w) => {
      const ns = w.LexiObsidian.namespace;
      const applied = levels.map((level) => level.apply(ns));
      if (strip) return { applied, domHelpers: stripDomHelpers(w, strip === true ? null : strip) };
      return { applied };
    }
  });
}

// L5 used to pass on "no synchronous throw". An async post-processor can never produce
// one: the plugin's register wrapper returns undefined, so await entry.handler resolves
// immediately and the real failure only ever surfaces as an unhandledRejection. Judge
// the render window by evidence instead:
//   PASS    -- nothing escaped AND the plugin left DOM of its own on the page;
//   FAIL    -- a rejection whose top frame is the plugin's OWN bundle escaped: the
//              plugin's code aborted, so the host surface it was handed is wrong or
//              missing (this is the pre-fix 'v.getAttr is not a function' shape);
//   PENDING -- everything else: the plugin left DOM and a host-side/unattributable
//              rejection surfaced (e.g. a rawfile stub this track does not own), so the
//              post-processor is not proven complete either.
const PLUGIN_FRAME = /lexinote-plugin-/;
function postProcessorVerdict(final) {
  const render = final.render || null;
  if (!render || !render.ran) {
    return { state: 'PENDING', domDelta: null, rejections: [], detail: '没有渲染窗口证据：onload 未达成，post-processor 一次都没跑' };
  }
  const raw = render.rejections || [];
  const rejections = raw.map((r) => r.message);
  const domDelta = typeof render.pluginDomDelta === 'number' ? render.pluginDomDelta : null;
  const where = '（DOM ' + render.nativeElementCount + ' -> ' + render.elementCount + '，插件自有 ' + domDelta + '）';
  const tail = rejections.length ? '；逃逸的 rejection: ' + rejections.join(' | ') : '；无 rejection 逃逸';
  const pluginSide = raw.filter((r) => PLUGIN_FRAME.test(String((r.stackTop3 || [])[0] || '')));
  if (pluginSide.length) {
    return {
      state: 'FAIL', domDelta, rejections,
      detail: '插件自己的代码在渲染窗口里中止（栈顶落在插件 bundle 内）' + where + '：' +
        pluginSide.map((r) => r.message + ' <- ' + String((r.stackTop3 || [])[0] || '?')).join(' | ')
    };
  }
  if (!rejections.length && domDelta > 0) {
    return { state: 'PASS', domDelta, rejections, detail: 'post-processor 跑完并留下 ' + domDelta + ' 个自有元素' + where + tail };
  }
  if (rejections.length) {
    return { state: 'PENDING', domDelta, rejections, detail: 'post-processor 留下 ' + domDelta + ' 个自有元素' + where + '后，宿主侧（非插件 bundle）的 rejection 逃逸' + tail };
  }
  return { state: 'PENDING', domDelta, rejections, detail: 'post-processor 没有留下插件自有 DOM，也没有 rejection 逃逸' + where };
}

function ppRegistrations(res) {
  return ((res.load && res.load.logsAll) || [])
    .filter((l) => String(l).indexOf('reading.postProcessor.register') >= 0)
    .map((l) => String(l));
}

function buildGap(final) {
  const rejections = final.unhandledRejections || [];
  const hit = rejections.find((r) => /addChild/.test(r.message));
  if (!hit) return null;
  return {
    where: 'entry/src/main/resources/rawfile/lexinote_reading.js (post-processor 上下文构造函数 An，只给 el/sourcePath/frontmatter/getSectionInfo)',
    symbol: 'ctx.addChild',
    error: hit.message,
    stackTop3: hit.stackTop3,
    why: '插件 post-processor 第一步就 new MarkdownRenderChild(el) 再 e.addChild(child)，而宿主给的 ctx 没有 addChild；ComponentShim.prototype.addChild 其实存在（lexinote_plugin_shim.js:1532 / lexinote_plugin_view_shim.js:261），缺的是把 ctx 接到组件生命周期上的那一层。',
    productFix: '在 lexinote_reading.js 的 An 上下文里补 addChild(child)（把 child 挂到应用内 MarkdownRenderChild 的 load/unload 生命周期并收集，元素卸载时 unload），再把 MarkdownRenderChild 的 addChild/removeChild 语义落实。harness 不能补：伪造 addChild 等于替插件伪造组件归属。',
    blastRadius: '所有在 post-processor 里 ctx.addChild 的插件（tasks 的 checkbox 交互、任何 MarkdownRenderChild 使用者）都会在第一步死掉；reading 页看到的仍是未加工 markdown，checkbox 是渲染器自带的、点了不回写源码。'
  };
}

async function run(opts) {
  opts = opts || {};
  const redlight = Number(opts.redlight || 0);
  const result = { generatedAt: new Date().toISOString(), harnessOnly: HARNESS_ONLY, rows: [], runs: [], outcome: null, render: null, click: null, redlight: null, lateRejections };

  if (redlight) {
    const kept = LEVELS.filter((l) => l.id !== redlight);
    const dropped = LEVELS.find((l) => l.id === redlight);
    const res = await climb(kept);
    const hit = dropped ? (res.loggedErrors || []).find((e) => e.message === dropped.observedError) : null;
    const bite = !!hit;
    result.redlight = {
      level: redlight,
      symbol: dropped ? dropped.missingSymbol : '(unknown level)',
      ok: bite,
      observed: hit ? hit.message + ' @ main.js:' + hit.fixtureLine : describe(res),
      expected: dropped ? dropped.observedError : null,
      detail: bite
        ? 'level ' + redlight + ' (' + dropped.missingSymbol + ') 是承重的：注释掉后门禁红在 ' + hit.message + ' @ main.js:' + hit.fixtureLine
        : 'level ' + redlight + ' 注释掉后门禁没有红在该级台阶上：' + describe(res)
    };
    result.runs.push({ applied: kept.map((l) => l.missingSymbol), error: describe(res), onloadAnchor: res.onloadAnchor, hostPluginCalls: pluginCalls(res) });
    result.outcome = { levelsClimbed: kept.length, onloadAnchor: res.onloadAnchor, stoppedAt: res.onloadAnchor ? null : 'level ' + redlight + ' missing', architectureGap: null };
    return result;
  }

  const runs = [];
  for (let k = 0; k <= LEVELS.length; k++) runs.push(await climb(LEVELS.slice(0, k), opts));
  result.runs = runs.map((r) => ({ applied: (r.stubs && r.stubs.applied) || [], error: describe(r), onloadAnchor: r.onloadAnchor, hostPluginCalls: pluginCalls(r) }));

  for (let i = 0; i < LEVELS.length; i++) {
    const level = LEVELS[i];
    const without = runs[i];
    const withIt = runs[i + 1];
    const hit = (without.loggedErrors || []).find((e) => e.message === level.observedError) || null;
    result.rows.push({
      level: level.id,
      crashPoint: hit && hit.fixtureLine ? FIXTURE_PREFIX + 'main.js:' + hit.fixtureLine : level.crashPoint,
      crashPointDeclared: level.crashPoint,
      missingSymbol: level.missingSymbol,
      harnessStub: level.harnessStub,
      nextError: describe(withIt),
      observedError: hit ? hit.message : (without.firstError ? without.firstError.message : null),
      matchesAuthored: !!hit,
      stackTop3: hit ? hit.stackTop3 : [],
      withoutEvidence: { onloadAnchor: without.onloadAnchor, hostPluginCalls: pluginCalls(without) },
      snippet: level.snippet,
      note: HARNESS_ONLY
    });
  }

  const final = runs[runs.length - 1];
  const gap = buildGap(final);
  const pp = postProcessorVerdict(final);
  result.outcome = {
    levelsClimbed: LEVELS.length,
    onloadAnchor: final.onloadAnchor,
    hostPluginCalls: pluginCalls(final),
    hostMethods: final.load.hostMethods,
    postProcessorRegistrations: ppRegistrations(final),
    postProcessorsRegistered: final.postProcessors ? final.postProcessors.registered : 0,
    architectureGap: gap,
    postProcessor: pp
  };
  if (opts.stripDomHelpers) {
    result.domHelpersRedlight = {
      ok: pp.state === 'FAIL',
      state: pp.state,
      stripped: (final.stubs && final.stubs.domHelpers) || null,
      detail: (pp.state === 'FAIL'
        ? '挂掉挂载后 L5 变红（FAIL）：判据承重。'
        : '挂掉挂载后 L5 仍是 ' + pp.state + '：判据不承重。') + pp.detail
    };
  }
  result.render = final.render || null;
  result.renderRejections = final.unhandledRejections || [];
  result.click = final.click || null;
  return result;
}

function table(rows) {
  const head = '| level | crashPoint(file:line) | missingSymbol | harnessStub | nextError |';
  const sep = '|---|---|---|---|---|';
  return [head, sep].concat(rows.map((r) =>
    '| ' + r.level + ' | ' + String(r.crashPoint).replace(FIXTURE_PREFIX, '') + ' | ' + r.missingSymbol + ' | ' +
    String(r.harnessStub).replace(/\|/g, '\\|') + ' | ' + String(r.nextError).replace(/\|/g, '\\|') + ' |'));
}

function markdown(result) {
  const gap = result.outcome.architectureGap;
  const n = result.rows.length;
  const head = gap
    ? '阶梯止于第 ' + n + ' 级，原因：onload 已经真被执行（host 收到 plugin.onload.done），但首次渲染撞上架构级缺口 ' + gap.symbol + ' —— ' + gap.error + '。这一条 harness 不补，因为它等于替插件伪造宿主能力。'
    : '阶梯走到第 ' + n + ' 级后 plugin.onload.done 出现，onload 真被调用，渲染阶段也没有撞到架构级缺口。';
  const lines = ['# obsidian-tasks 8.6.0 failure ladder (harness-only)', '', head, '',
    '> 本表每一级都是 **HARNESS-ONLY** 补丁：注入点是 jsdom 里的 `window.LexiObsidian.namespace`，`entry/src/main/resources/rawfile/**` 一个字节都没改。',
    '> 因此表里"harness 已补"不等于"产品已实现"——这些缺口在真实设备上一条都还在。', '',
    '## 阶梯表', ''].concat(table(result.rows)).concat(['', '## 每级明细', '']);
  for (const r of result.rows) {
    lines.push('### level ' + r.level + ' — ' + r.missingSymbol + ' (' + String(r.crashPoint).replace(FIXTURE_PREFIX, '') + ')');
    lines.push('', '- 摘掉这一级时观察到：`' + r.observedError + '`（与立项签名一致：' + (r.matchesAuthored ? 'yes' : 'NO') + '）');
    lines.push('- 摘掉这一级时的 host 侧形态：plugin.* 调用 = ' + JSON.stringify(r.withoutEvidence.hostPluginCalls) + '，onloadAnchor = ' + r.withoutEvidence.onloadAnchor);
    lines.push('- 栈顶三行：', FENCE);
    for (const f of r.stackTop3) lines.push(f);
    lines.push(FENCE);
    lines.push('- harness 补了什么（≤10 行）：', FENCE + 'js');
    for (const s of String(r.snippet).split('\n')) lines.push(s);
    lines.push(FENCE);
    lines.push('- ' + r.note);
    lines.push('- 补完之后的下一条错误：`' + r.nextError + '`');
    lines.push('');
  }
  lines.push('## onload 之后', '');
  lines.push('- host 收到的 plugin.* 调用：' + JSON.stringify(result.outcome.hostPluginCalls));
  lines.push('- 后处理器注册：observed hook = ' + result.outcome.postProcessorsRegistered + '；页面日志 = ' + JSON.stringify(result.outcome.postProcessorRegistrations));
  const pp = result.outcome.postProcessor;
  if (result.render) {
    lines.push('- 首次渲染：' + JSON.stringify({ nodeCount: result.render.nodeCount, checkboxCount: result.render.checkboxCount, nativeElementCount: result.render.nativeElementCount, elementCount: result.render.elementCount, pluginDomDelta: result.render.pluginDomDelta, postProcessorErrors: result.render.postProcessorErrors }));
    lines.push('- 插件自有 DOM 增量：' + result.render.pluginDomDelta + ' 个元素（' + result.render.nativeElementCount + ' -> ' + result.render.elementCount + '，同一棵树、post-processor 应用前/后各数一次）');
    if (result.render.pluginDomDelta > 0) {
      lines.push('- 注意：页面上这 ' + result.render.checkboxCount + ' 个 checkbox 本身仍是 **markdown 渲染器自带**的；插件增量只说明它确实动了 DOM，不代表 checkbox 交互可用。');
    } else {
      lines.push('- 注意：这 ' + result.render.checkboxCount + ' 个 checkbox 是 **markdown 渲染器自带**的，不是插件产物——post-processor 没有留下任何自有元素。');
    }
  } else lines.push('- 首次渲染：没有跑（onload 未达成）');
  if (pp) {
    lines.push('- L5 判据（post-processor 是否跑完）：' + pp.state + ' — ' + pp.detail);
    lines.push('- 判据口径：PASS = 无 rejection 逃逸且留下插件自有 DOM；FAIL = 有 rejection 逃逸且插件自有 DOM 为 0（在干活前就中止）；PENDING = 留下了 DOM 但撞到本轨不拥有的桩。unhandledRejection 是唯一能看到 async 后处理器失败的地方——注册包装返回 undefined，await handler 等不到内部 promise。');
  }
  lines.push('- 在渲染窗口里逃逸的 rejection：' + JSON.stringify(result.renderRejections.map((r) => r.message)));
  lines.push('- checkbox 回写：' + (result.click ? '点击后 sourceBefore == sourceAfter ? ' + (result.click.sourceBefore === result.click.sourceAfter) + '；writes=' + JSON.stringify(result.click.writes) : '没有 checkbox 可点'));
  if (gap) {
    lines.push('', '## 架构级缺口（产品侧要改什么）', '');
    lines.push('- 位置：`' + gap.where + '`');
    lines.push('- 缺的符号：`' + gap.symbol + '`，现状错误 `' + gap.error + '`');
    lines.push('- 栈顶三行：', FENCE);
    for (const f of gap.stackTop3) lines.push(f);
    lines.push(FENCE);
    lines.push('- 为什么会缺：' + gap.why);
    lines.push('- 产品侧要改什么：' + gap.productFix);
    lines.push('- 预计影响面：' + gap.blastRadius);
  }
  if (result.redlight) lines.push('', '## 红灯自证', '', '- 摘掉 level ' + result.redlight.level + '：' + result.redlight.detail);
  lines.push('', '## 没有证明的东西（这张表不说明的事）', '');
  for (const line of NOT_PROVEN) lines.push('- ' + line);
  return lines.join('\n') + '\n';
}

function write(result, outDir) {
  const dir = outDir || OUT;
  fs.mkdirSync(dir, { recursive: true });
  // A red-light run is evidence about the gate, not the ladder; it must never
  // overwrite the green report that the ladder table lives in.
  if (result.redlight) {
    const rlPath = path.join(dir, 'redlight-level' + result.redlight.level + '.json');
    fs.writeFileSync(rlPath, JSON.stringify(result, null, 2));
    return { jsonPath: rlPath, mdPath: null };
  }
  if (result.domHelpersRedlight) {
    const rlPath = path.join(dir, 'redlight-dom-helpers.json');
    fs.writeFileSync(rlPath, JSON.stringify(result, null, 2));
    return { jsonPath: rlPath, mdPath: null };
  }
  const jsonPath = path.join(dir, 'gap-ladder.json');
  const mdPath = path.join(dir, 'gap-ladder.md');
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  fs.writeFileSync(mdPath, markdown(result));
  return { jsonPath, mdPath };
}

module.exports = { run, write, table, markdown, LEVELS };
