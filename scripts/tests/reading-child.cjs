#!/usr/bin/env node
'use strict';
// Gate for the post-processor ctx component host: ctx.addChild / ctx.removeChild /
// MarkdownRenderChild lifecycle across section repaints.
//
// Offline: the SHIPPED rawfile bundle runs inside jsdom, children are counter probes.
// Every assertion prints PASS/FAIL; any failure exits 1.
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const bundleDir = path.join(repoRoot, 'tools', 'reading-bundle');
const bundlePath = path.join(repoRoot, 'entry', 'src', 'main', 'resources', 'rawfile', 'lexinote_reading.js');
const { JSDOM } = require(require.resolve('jsdom', { paths: [bundleDir] }));

const FIXTURE = ['## One', '', '- alpha item', '', '## Two', '', '- beta item', ''].join('\n');
const NOTE_PATH = 'notes/child-gate.md';

const results = [];
class AssertionError extends Error {
  constructor(expected, actual) { super('assertion failed'); this.expected = expected; this.actual = actual; }
}
function eq(actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(e, a);
}
function ok(cond, actual) { if (!cond) throw new AssertionError('true', String(actual)); }
function same(actual, expected) { if (actual !== expected) throw new AssertionError('same reference', 'different reference'); }
function isFn(value) { if (typeof value !== 'function') throw new AssertionError('function', typeof value); }
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (err) {
    if (err instanceof AssertionError) {
      results.push({ name: name, ok: false, expected: err.expected, actual: err.actual });
    } else {
      results.push({ name: name, ok: false, expected: 'no exception', actual: String(err && err.stack ? err.stack.split('\n')[0] : err) });
    }
  }
}

async function main() {
  const bundleCode = fs.readFileSync(bundlePath, 'utf8');
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { runScripts: 'outside-only', url: 'https://lexinote.local/' });
  const window = dom.window;
  const document = window.document;
  window.eval(bundleCode);
  const R = window.LexiReading;

  // A third-party-shaped child: our kernel knows nothing about this class.
  class ProbeChild {
    constructor(label, opts) {
      opts = opts || {};
      this.label = label;
      this.loads = 0;
      this.unloads = 0;
      this.throwOnLoad = opts.throwOnLoad || null;
      if (opts.container !== false) {
        this.containerEl = document.createElement('div');
        this.containerEl.className = 'probe-child';
        this.containerEl.setAttribute('data-probe', label);
      }
    }
    load() { this.loads += 1; if (this.throwOnLoad) throw new Error(this.throwOnLoad); }
    unload() { this.unloads += 1; }
  }
  class ExplodingChild {
    constructor() { this.loads = 0; this.unloads = 0; this.containerEl = document.createElement('div'); }
    load() { this.loads += 1; throw new Error('boom from load'); }
    unload() { this.unloads += 1; }
  }

  let plan = null;
  const seen = [];
  R.registerPostProcessor(function (el, ctx) {
    seen.push({ el: el, ctx: ctx });
    if (typeof plan === 'function') plan(el, ctx);
  });

  const out = R.render(FIXTURE, { sourcePath: NOTE_PATH });
  const s0 = out.sections[0].el;
  const s1 = out.sections[1].el;
  const ctxBase = { sourcePath: NOTE_PATH, frontmatter: out.frontmatter };

  // --- ctx shape ---------------------------------------------------------------
  await R.applyPostProcessors(s0, ctxBase);
  const ctx0 = seen[seen.length - 1].ctx;

  check('01 ctx 暴露 addChild/removeChild 函数', function () {
    isFn(ctx0.addChild);
    isFn(ctx0.removeChild);
  });
  check('02 未挂任何 child 时 ctx.children 是空数组(可枚举)', function () {
    ok(Array.isArray(ctx0.children), typeof ctx0.children);
    eq(ctx0.children.length, 0);
  });

  // --- addChild ----------------------------------------------------------------
  const childA = new ProbeChild('a');
  plan = function (el, ctx) { ctx.addChild(childA); };
  await R.applyPostProcessors(s0, ctxBase);

  check('03 addChild 调 child.load() 恰好一次', function () { eq(childA.loads, 1); });
  check('04 child.containerEl 真的进到 ctx.el(父节点就是 section el)', function () {
    same(childA.containerEl.parentNode, s0);
    ok(s0.contains(childA.containerEl), 'section el does not contain the child container');
  });
  check('05 同一 section 的第二次后处理拿到同一个 ctx 对象(身份稳定)', function () {
    same(seen[seen.length - 1].ctx, ctx0);
  });
  check('06 ctx.children 枚举到已挂 child', function () {
    eq(ctx0.children.length, 1);
    same(ctx0.children[0], childA);
  });

  const childB = new ProbeChild('b');
  plan = function (el, ctx) { ctx.addChild(childB); };
  await R.applyPostProcessors(s0, ctxBase);
  check('07 同一 ctx 上再次 addChild 累加到同一列表(2 个)', function () {
    eq(ctx0.children.length, 2);
    eq(childB.loads, 1);
  });

  // --- removeChild -------------------------------------------------------------
  ctx0.removeChild(childA);
  check('08 removeChild 调 child.unload() 一次', function () { eq(childA.unloads, 1); });
  check('09 removeChild 把 containerEl 从父节点摘掉', function () {
    eq(childA.containerEl.parentNode, null);
    ok(!s0.contains(childA.containerEl), 'container still inside section el');
  });
  ctx0.removeChild(childA);
  check('10 重复 removeChild 不再 unload(幂等空操作),其余 child 不受影响', function () {
    eq(childA.unloads, 1);
    eq(ctx0.children.length, 1);
    same(ctx0.children[0], childB);
    eq(childB.unloads, 0);
  });

  const stranger = new ProbeChild('never-added');
  ctx0.removeChild(stranger);
  check('11 未经 addChild 的 child 不会被 removeChild unload', function () { eq(stranger.unloads, 0); });

  // --- 只按鸭子类型接住第三方 child(没有 containerEl 也照样 load) --------------
  const bare = { loads: 0, unloads: 0, load: function () { this.loads += 1; }, unload: function () { this.unloads += 1; } };
  plan = function (el, ctx) { ctx.addChild(bare); };
  await R.applyPostProcessors(s0, ctxBase);
  check('12 鸭子类型:无 containerEl、非本内核类实例的 child 仍被接住并 load 一次', function () {
    eq(bare.loads, 1);
    eq(ctx0.children.length, 2);
  });
  ctx0.removeChild(bare);
  check('13 该鸭子类型 child 被 removeChild 后 unload 一次', function () { eq(bare.unloads, 1); });

  // --- section 增量重渲染:旧 child 先 unload 再丢弃,别的 section 不受影响 ------
  const childC = new ProbeChild('c');
  plan = function (el, ctx) { if (el === s1) { ctx.addChild(childC); } };
  await R.applyPostProcessors(s1, ctxBase);
  const ctx1 = seen[seen.length - 1].ctx;
  check('14 section2 的 child 已挂上(load 一次,容器在 DOM 里)', function () {
    eq(childC.loads, 1);
    same(childC.containerEl.parentNode, s1);
  });

  const childD = new ProbeChild('d');
  plan = function (el, ctx) { if (el === s1) { ctx.addChild(childD); } };
  await R.rerenderSection(1, '## Two\n\n- gamma item only');
  check('15 section 重渲染时旧 child 先 unload(恰好一次)再丢弃', function () { eq(childC.unloads, 1); });
  check('16 重渲染后的新 child 被 load(后处理器重跑一次)', function () { eq(childD.loads, 1); });
  check('17 重渲染 section2 不影响 section1 的 child(未 unload,仍在列表里)', function () {
    eq(childB.unloads, 0);
    ok(ctx0.children.length === 1 && ctx0.children[0] === childB, 'section1 children changed by a section2 repaint');
    same(childB.containerEl.parentNode, s0);
  });
  check('18 同一 section 重渲染后 ctx 身份不变(仍是同一个组件宿主)', function () {
    same(seen[seen.length - 1].ctx, ctx1);
    eq(ctx1.children.length, 1);
    same(ctx1.children[0], childD);
  });

  plan = function (el, ctx) { if (el === s1) { ctx.addChild(new ProbeChild('noise')); } };
  await R.rerenderSection(1, '## Two\n\n- delta item only');
  check('19 连续两次重渲染:被换下的 child 只在第一次卸载,不重复 unload', function () {
    eq(childC.unloads, 1);
    eq(childD.unloads, 1);
  });

  // --- 异常隔离 ----------------------------------------------------------------
  const before = R.getComponentErrors().length;
  const exploding = new ExplodingChild();
  const healthy = new ProbeChild('healthy');
  plan = function (el, ctx) { if (el === s1) { ctx.addChild(exploding); ctx.addChild(healthy); } };
  await R.rerenderSection(1, '## Two\n\n- epsilon item only');
  const errors = R.getComponentErrors();

  check('20 单个 child.load() 抛错不中断其余 child(后来的 healthy 仍被 load)', function () { eq(healthy.loads, 1); });
  check('21 load 抛错被记成一条可报告的日志(pluginId + child 构造名 + phase)', function () {
    eq(errors.length, before + 1);
    const entry = errors[errors.length - 1];
    eq(entry.phase, 'child.load');
    eq(entry.child, 'ExplodingChild');
    ok(typeof entry.pluginId === 'string' && entry.pluginId.length > 0, 'pluginId missing from the log entry');
    ok(String(entry.message).indexOf('boom from load') >= 0, entry.message);
  });
  check('22 抛错后后处理器本身不抛(applyPostProcessors/rerenderSection 仍正常返回)', function () {
    eq(out.sections[1].el.querySelectorAll('li').length, 1);
  });

  // --- pluginId 归因:调用栈里的 lexinote-plugin-<id>.js 帧 -----------------------
  const scratch = document.createElement('div');
  document.body.appendChild(scratch);
  const scratchCtxs = [];
  const previousPlan = plan;
  plan = function (el, ctx) { scratchCtxs.push(ctx); };
  await R.applyPostProcessors(scratch, ctxBase);
  const scratchCtx = scratchCtxs[scratchCtxs.length - 1];
  window.__gateCtx = scratchCtx;
  window.eval('window.__gateAddChild = function (child) { return window.__gateCtx.addChild(child); };\n//# sourceURL=lexinote-plugin-gate-probe.js');
  plan = previousPlan;

  const attributed = new ExplodingChild();
  const beforeAttr = R.getComponentErrors().length;
  window.__gateAddChild(attributed);
  check('23 日志里的 pluginId 从插件包的 lexinote-plugin-<id>.js 帧认领', function () {
    const errors2 = R.getComponentErrors();
    eq(errors2.length, beforeAttr + 1);
    eq(errors2[errors2.length - 1].pluginId, 'gate-probe');
  });

  // --- 显式 pluginId 优先于栈归因 ----------------------------------------------
  const scratch2 = document.createElement('div');
  document.body.appendChild(scratch2);
  plan = function (el, ctx) { scratchCtxs.push(ctx); };
  await R.applyPostProcessors(scratch2, { sourcePath: NOTE_PATH, pluginId: 'explicit-plugin' });
  const ctxExplicit = scratchCtxs[scratchCtxs.length - 1];
  const beforeExplicit = R.getComponentErrors().length;
  ctxExplicit.addChild(new ExplodingChild());
  check('24 ctx 上显式 pluginId 优先于栈归因', function () {
    const errors3 = R.getComponentErrors();
    eq(errors3.length, beforeExplicit + 1);
    eq(errors3[errors3.length - 1].pluginId, 'explicit-plugin');
  });

  // --- 同一 child 实例重复 addChild 不重复 load ---------------------------------
  const repeat = new ProbeChild('repeat');
  const ctxRepeatSeen = [];
  plan = function (el, ctx) { ctxRepeatSeen.push(ctx); ctx.addChild(repeat); ctx.addChild(repeat); };
  await R.applyPostProcessors(scratch2, { sourcePath: NOTE_PATH, pluginId: 'explicit-plugin' });
  check('25 同一 ctx 上同一 child 实例重复 addChild 只 load 一次、只记一次', function () {
    eq(repeat.loads, 1);
    const ctxRepeat = ctxRepeatSeen[ctxRepeatSeen.length - 1];
    eq(ctxRepeat.children.filter(function (c) { return c === repeat; }).length, 1);
  });

  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      console.log('PASS  ' + r.name);
    } else {
      failed += 1;
      console.log('FAIL  ' + r.name);
      console.log('        expected: ' + r.expected);
      console.log('        actual:   ' + r.actual);
    }
  }
  console.log('');
  console.log('bundle: ' + path.relative(repoRoot, bundlePath));
  console.log('assertions: ' + results.length + ', passed: ' + (results.length - failed) + ', failed: ' + failed);
  if (failed > 0) process.exitCode = 1;
}

main().catch(function (err) {
  console.error('gate crashed: ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
