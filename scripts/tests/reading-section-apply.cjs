#!/usr/bin/env node
'use strict';
// Gate for "post-processors are applied per section" + "ctx.getSectionInfo(el) resolves the
// owning section from the DOM". The SHIPPED rawfile bundle runs inside jsdom; every assertion
// prints PASS/FAIL and any failure exits 1.
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const bundleDir = path.join(repoRoot, 'tools', 'reading-bundle');
const bundlePath = path.join(repoRoot, 'entry', 'src', 'main', 'resources', 'rawfile', 'lexinote_reading.js');
const { JSDOM } = require(require.resolve('jsdom', { paths: [bundleDir] }));

const FIXTURE = [
  '---',
  'title: Section Apply Gate',
  '---',
  '',
  'Intro paragraph.',
  '',
  '## One',
  '',
  '- [ ] alpha item',
  '',
  '## Two',
  '',
  '- [ ] beta item',
  ''
].join('\n');
const NOTE_PATH = 'notes/section-apply-gate.md';

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
function sameList(actual, expected) {
  if (actual.length !== expected.length) throw new AssertionError('length ' + expected.length, 'length ' + actual.length);
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i]) throw new AssertionError('same reference at index ' + i, 'different reference at index ' + i);
  }
}
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
  window.eval(bundleCode);
  const R = window.LexiReading;

  const out = R.render(FIXTURE, { sourcePath: NOTE_PATH });
  const view = out.containerEl;
  const sizer = view.firstElementChild;
  const rendered = sizer.firstElementChild;
  const sections = out.sections;
  const ctxBase = { sourcePath: NOTE_PATH, frontmatter: out.frontmatter };

  // --- harness: a recorder that captures el, ctx, and both getSectionInfo shapes -----------
  let sink = [];
  let offs = [];
  function record(name, sortOrder) {
    const off = R.registerPostProcessor(function (el, ctx) {
      sink.push({
        name: name,
        el: el,
        ctx: ctx,
        noArg: ctx.getSectionInfo(),
        byEl: ctx.getSectionInfo(el),
        seq: sink.length
      });
    }, sortOrder);
    offs.push(off);
    return off;
  }
  function clearRegistry() {
    for (const off of offs) off();
    offs = [];
    sink = [];
  }
  function namesOf(list) { return list.map(function (r) { return r.name; }); }
  function countByEl(list) {
    const map = new Map();
    for (const r of list) map.set(r.el, (map.get(r.el) || 0) + 1);
    return map;
  }

  check('01 三个 section 的骨架可用(preamble + h2 + h2), 容器与 section 都是真 DOM 元素', function () {
    eq(sections.length, 3);
    eq(rendered.childElementCount, 3);
    same(sections[1].el, rendered.children[1]);
  });

  // --- ordering: sortOrder ascending, ties in registration order ---------------------------
  record('late', 10);
  record('later', 10);
  record('early', -5);
  await R.applyPostProcessors(sections[1].el, ctxBase);
  check('02 同一 section 内按 sortOrder 升序, 同序按注册顺序', function () {
    eq(namesOf(sink), ['early', 'late', 'later']);
  });
  clearRegistry();

  // --- container input fans out to every section -------------------------------------------
  record('probe', 0);
  await R.applyPostProcessors(view, ctxBase);
  const fanout = sink.slice();
  check('03 容器输入 -> 三个 section 各调用一次(计数 3)', function () {
    eq(fanout.length, 3);
    sameList(fanout.map(function (r) { return r.el; }), sections.map(function (s) { return s.el; }));
  });
  check('04 容器本身从不作为 el 交给后处理器(容器不被当作第四个目标)', function () {
    eq(fanout.filter(function (r) { return r.el === view || r.el === sizer || r.el === rendered; }).length, 0);
  });
  check('05 一次调用里每个 section 恰好一次, 没有重复条目', function () {
    const counts = countByEl(fanout);
    eq(sections.map(function (s) { return counts.get(s.el); }), [1, 1, 1]);
  });

  // --- inner containers reach the same sections, once each --------------------------------
  sink = [];
  await R.applyPostProcessors(sizer, ctxBase);
  const viaSizer = sink.slice();
  sink = [];
  await R.applyPostProcessors(rendered, ctxBase);
  const viaRendered = sink.slice();
  check('06 内层容器(.markdown-preview-sizer / .markdown-rendered)同样对每个 section 各一次', function () {
    sameList(viaSizer.map(function (r) { return r.el; }), sections.map(function (s) { return s.el; }));
    sameList(viaRendered.map(function (r) { return r.el; }), sections.map(function (s) { return s.el; }));
  });

  // --- repeated container input: exactly one application per section per call --------------
  sink = [];
  await R.applyPostProcessors(view, ctxBase);
  const passOne = sink.length;
  await R.applyPostProcessors(view, ctxBase);
  const passTwo = sink.length - passOne;
  check('07 同一容器重复传入: 每次调用仍是每个 section 一次(不叠加、不因父容器多算)', function () {
    eq(passOne, 3);
    eq(passTwo, 3);
    eq(countByEl(sink).size, 3);
  });

  // --- section input: only that one section ------------------------------------------------
  sink = [];
  await R.applyPostProcessors(sections[2].el, ctxBase);
  check('08 section 输入 -> 只对该 section 调用一次', function () {
    eq(sink.length, 1);
    same(sink[0].el, sections[2].el);
  });

  // --- getSectionInfo(el) resolution -------------------------------------------------------
  const s1 = sections[1];
  sink = [];
  await R.applyPostProcessors(s1.el, ctxBase);
  const call = sink[0];
  check('09 getSectionInfo(sectionEl) 返回该 section 的 lineStart/lineEnd/text/el', function () {
    eq(call.byEl.lineStart, s1.lineStart);
    eq(call.byEl.lineEnd, s1.lineEnd);
    eq(call.byEl.text, s1.source);
    same(call.byEl.el, s1.el);
    ok(call.byEl.text.indexOf('alpha item') >= 0, call.byEl.text);
  });

  const li = s1.el.querySelector('li');
  const span = li ? li.querySelector('input') || li : null;
  const resolver = call.ctx.getSectionInfo;
  check('10 getSectionInfo(内部元素) 解析到所属 section(li 与更深的 input)', function () {
    ok(li, 'no li inside section 2');
    same(resolver(li).el, s1.el);
    ok(span, 'no deep element inside the list item');
    same(resolver(span).el, s1.el);
    eq(resolver(li).lineStart, s1.lineStart);
  });

  check('11 getSectionInfo(容器) 返回 null(容器 + sizer + rendered 都不兜底成第一个 section)', function () {
    eq(resolver(view), null);
    eq(resolver(sizer), null);
    eq(resolver(rendered), null);
  });

  check('12 getSectionInfo() 省略参数仍返回当前 section', function () {
    same(call.noArg.el, s1.el);
    eq(call.noArg.lineStart, s1.lineStart);
  });

  check('13 容器调用里每个 ctx 的省略参数形态各自是自己的 section', function () {
    sameList(fanout.map(function (r) { return r.noArg ? r.noArg.el : null; }), sections.map(function (s) { return s.el; }));
  });

  check('14 容器与 section 上都没有 __lexiSection 假标记(归属靠 DOM 结构解析)', function () {
    eq(view.__lexiSection, undefined);
    eq(sizer.__lexiSection, undefined);
    eq(rendered.__lexiSection, undefined);
    ok(sections[1].el.__lexiSection !== undefined, 'section element lost its own section marker');
  });

  check('15 同一 section 的 ctx 身份稳定:容器调用与 section 调用拿到同一个对象', function () {
    const fromFanout = fanout.filter(function (r) { return r.el === s1.el; })[0].ctx;
    same(fromFanout, call.ctx);
  });

  clearRegistry();

  // --- error isolation: one throwing processor cannot stop the rest -------------------------
  const beforeErrors = R.getComponentErrors().length;
  let healthy = 0;
  const offThrow = R.registerPostProcessor(function boom() { throw new Error('boom from post-processor'); }, 0);
  const offHealthy = R.registerPostProcessor(function healthyWorker() { healthy += 1; }, 1);
  const outcome = await R.applyPostProcessors(view, { sourcePath: NOTE_PATH, frontmatter: out.frontmatter, pluginId: 'gate-explicit' });
  check('16 单个后处理器抛错不中断其余: 容器调用里健康处理器仍对三个 section 各跑一次', function () {
    eq(healthy, 3);
  });
  check('17 抛错被收集(每个 section 一条), applyPostProcessors 本身不抛', function () {
    ok(Array.isArray(outcome.errors), typeof outcome.errors);
    eq(outcome.errors.length, 3);
    ok(outcome.errors.every(function (e) { return String(e && e.message).indexOf('boom from post-processor') >= 0; }), 'wrong error identity');
  });
  const logged = R.getComponentErrors().slice(beforeErrors);
  check('18 抛错按 pluginId 记录在 componentErrors 同构通道(phase/handler 名/message)', function () {
    eq(logged.length, 3);
    eq(logged.map(function (e) { return e.phase; }), ['post-processor', 'post-processor', 'post-processor']);
    eq(logged.map(function (e) { return e.pluginId; }), ['gate-explicit', 'gate-explicit', 'gate-explicit']);
    eq(logged[0].child, 'boom');
    ok(String(logged[0].message).indexOf('boom from post-processor') >= 0, logged[0].message);
  });
  offThrow();
  offHealthy();
  healthy = 0;
  const offAfter = R.registerPostProcessor(function afterWorker() { healthy += 1; });
  const afterOutcome = await R.applyPostProcessors(view, ctxBase);
  check('19 抛错后注册表仍可用: 摘掉抛错者, 后续容器调用恢复为全绿', function () {
    eq(healthy, 3);
    eq(afterOutcome.errors.length, 0);
  });
  offAfter();

  // --- ordinary element (not a section, not a container) keeps the single target -----------
  const scratch = window.document.createElement('div');
  window.document.body.appendChild(scratch);
  let scratchCalls = 0;
  const offScratch = R.registerPostProcessor(function (el, ctx) {
    scratchCalls += 1;
    same(el, scratch);
    eq(ctx.getSectionInfo(), null);
    eq(ctx.getSectionInfo(scratch), null);
  });
  await R.applyPostProcessors(scratch, ctxBase);
  check('20 非容器非 section 元素仍是单目标一次, getSectionInfo 对它返回 null', function () {
    eq(scratchCalls, 1);
  });
  offScratch();

  // --- rerenderSection比 keeps the per-section contract -----------------------------------
  sink = [];
  record('rerender', 0);
  await R.rerenderSection(1, '## One\n\n- [ ] gamma item');
  check('21 增量重渲染仍只对重绘的那一个 section 应用后处理器', function () {
    eq(sink.length, 1);
    same(sink[0].el, sections[1].el);
    ok(sink[0].byEl.text.indexOf('gamma item') >= 0, sink[0].byEl.text);
  });
  check('22 增量重渲染后 ctx 身份不变(同一 section 同一宿主)', function () {
    same(sink[0].ctx, call.ctx);
  });
  clearRegistry();

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
