#!/usr/bin/env node
'use strict';
// Offline gate for the LexiNote reading-view kernel.
// Loads the SHIPPED rawfile bundle inside jsdom, renders real Markdown, drives a
// tasks-style post-processor, and asserts section-level incremental rerender.
// Prints one PASS/FAIL line per assertion and exits 1 if any assertion fails.
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const bundleDir = path.join(repoRoot, 'tools', 'reading-bundle');
const bundlePath = path.join(repoRoot, 'entry', 'src', 'main', 'resources', 'rawfile', 'lexinote_reading.js');
const { JSDOM } = require(require.resolve('jsdom', { paths: [bundleDir] }));

const results = [];
class AssertionError extends Error {
  constructor(expected, actual) { super('assertion failed'); this.expected = expected; this.actual = actual; }
}
function eq(actual, expected) {
  var a = JSON.stringify(actual);
  var e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(e, a);
}
function ok(cond, actual) { if (!cond) throw new AssertionError('true', String(actual)); }
function same(actual, expected) { if (actual !== expected) throw new AssertionError('same node reference', 'different node reference'); }
function includes(haystack, needle) {
  if (String(haystack).indexOf(needle) < 0) throw new AssertionError('contains ' + JSON.stringify(needle), JSON.stringify(String(haystack).slice(0, 200)));
}
function notIncludes(haystack, needle) {
  if (String(haystack).indexOf(needle) >= 0) throw new AssertionError('does not contain ' + JSON.stringify(needle), 'HTML still contains it');
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

var BT = String.fromCharCode(96);
var FENCE = BT + BT + BT;
var FIXTURE = [
  '---',
  'title: Reading Gate Demo',
  'tags:',
  '  - alpha',
  '  - beta',
  'draft: false',
  'count: 3',
  '---',
  '',
  'Preamble paragraph before any heading.',
  '',
  '## Section Two',
  '',
  '- alpha item',
  '- beta item',
  '',
  'A paragraph separating the two lists.',
  '',
  '- [ ] Write gate',
  '- [x] Ship bundle',
  '',
  '### Section Three',
  '',
  '1. first step',
  '2. second step',
  '',
  FENCE + 'js',
  'const x = 1;',
  FENCE,
  '',
  '| Column A | Column B |',
  '| --- | --- |',
  '| a1 | b1 |',
  '',
  'A [link](https://example.com/docs) and ' + BT + 'inline code' + BT + ' plus **bold** and *italic*.',
  '',
  '> quoted line',
  '',
  'Footnote ref[^1].',
  '',
  '[^1]: The footnote body.',
  ''
].join('\n');

async function main() {
  const bundleCode = fs.readFileSync(bundlePath, 'utf8');
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { runScripts: 'outside-only', url: 'https://lexinote.local/' });
  const window = dom.window;
  window.eval(bundleCode);
  const R = window.LexiReading;

  check('01 bundle exposes window.LexiReading with render/applyPostProcessors/rerenderSection/registerPostProcessor', function () {
    ok(R && typeof R.render === 'function' && typeof R.applyPostProcessors === 'function' && typeof R.rerenderSection === 'function' && typeof R.registerPostProcessor === 'function', 'missing API on window.LexiReading');
  });

  // tasks-style post-processor: locate .task-list-item, inject a checkbox whose click
  // callback receives the source line that has to be written back.
  const writes = [];
  const calls = [];
  R.registerPostProcessor(function (sectionEl, ctx) {
    const info = ctx.getSectionInfo();
    const items = sectionEl.findAll('.task-list-item');
    calls.push({ el: sectionEl, sourcePath: ctx.sourcePath, title: ctx.frontmatter && ctx.frontmatter.title, itemCount: items.length, lineStart: info ? info.lineStart : null });
    for (const li of items) {
      const label = li.textContent.trim();
      const sourceLine = info ? info.text.split('\n').find(function (line) { return line.indexOf(label) >= 0; }) : '';
      const box = sectionEl.createEl('input', { cls: 'lexi-task-checkbox', attr: { type: 'checkbox' } });
      box.addEventListener('click', function () { writes.push(sourceLine); });
      li.appendChild(box);
    }
  });

  const out = R.render(FIXTURE, { sourcePath: 'notes/gate-demo.md' });
  const view = out.containerEl;
  const sizer = view.firstElementChild;
  const rendered = sizer.firstElementChild;
  const sections = out.sections;

  check('02 frontmatter parsed into an object (title)', function () { eq(out.frontmatter && out.frontmatter.title, 'Reading Gate Demo'); });
  check('03 frontmatter list/boolean/number typed', function () { eq(out.frontmatter.tags, ['alpha', 'beta']); eq(out.frontmatter.draft, false); eq(out.frontmatter.count, 3); });
  check('04 frontmatter stripped from HTML body', function () { notIncludes(out.html, 'draft: false'); notIncludes(out.html, 'tags:'); notIncludes(out.html, 'title: Reading Gate Demo'); });
  check('05 section count is 3 (preamble + h2 + h3)', function () { eq(sections.length, 3); eq(rendered.children.length, 3); });
  check('06 skeleton view > sizer > rendered as strict direct children', function () {
    eq(view.className, 'markdown-preview-view');
    eq(view.childElementCount, 1);
    eq(sizer.className, 'markdown-preview-sizer');
    eq(sizer.childElementCount, 1);
    eq(rendered.className, 'markdown-rendered');
  });
  check('07 every section is a direct .markdown-preview-section child of .markdown-rendered', function () {
    eq(rendered.childElementCount, 3);
    for (var i = 0; i < rendered.children.length; i++) eq(rendered.children[i].className, 'markdown-preview-section');
    for (var j = 0; j < sections.length; j++) same(sections[j].el, rendered.children[j]);
  });
  check('08 data-heading-level per section is [0,2,3]', function () { eq(sections.map(function (s) { return s.el.getAttribute('data-heading-level'); }), ['0', '2', '3']); });
  check('09 heading tag/text: h2 Section Two, h3 Section Three', function () {
    eq(sections[1].el.querySelector('h2').textContent, 'Section Two');
    eq(sections[2].el.querySelector('h3').textContent, 'Section Three');
  });
  check('10 unordered list items (alpha/beta)', function () {
    var list = sections[1].el.querySelector('ul');
    eq(list.querySelectorAll('li').length, 2);
    includes(list.textContent, 'alpha item');
    includes(list.textContent, 'beta item');
  });
  check('11 ordered list items (first/second)', function () {
    var list = sections[2].el.querySelector('ol');
    var direct = Array.prototype.filter.call(list.children, function (c) { return c.tagName === 'LI'; });
    eq(direct.length, 2);
    includes(list.textContent, 'first step');
    includes(list.textContent, 'second step');
  });
  check('12 task list: 2 .task-list-item each with a native checkbox', function () {
    eq(sections[1].el.findAll('.task-list-item').length, 2);
    eq(sections[1].el.querySelectorAll('input.task-list-item-checkbox[type="checkbox"]').length, 2);
  });
  check('13 fenced code keeps language class + content', function () {
    var code = sections[2].el.querySelector('pre > code');
    ok(code, 'no pre>code found');
    includes(code.className, 'language-js');
    includes(code.textContent, 'const x = 1;');
  });
  check('14 table structure: 2 header cells + 2 body cells', function () {
    eq(sections[2].el.querySelectorAll('table thead th').length, 2);
    eq(sections[2].el.querySelectorAll('table tbody td').length, 2);
  });
  check('15 external link preserved with href', function () {
    var a = sections[2].el.querySelector('a[href="https://example.com/docs"]');
    ok(a, 'link not found');
    includes(a.textContent, 'link');
  });
  check('16 inline code rendered outside pre', function () {
    var codes = Array.prototype.slice.call(sections[2].el.querySelectorAll('code'));
    var inline = codes.filter(function (c) { return c.parentElement.tagName !== 'PRE' && c.textContent === 'inline code'; });
    eq(inline.length, 1);
  });
  check('17 bold and italic', function () {
    eq(sections[2].el.querySelector('strong').textContent, 'bold');
    eq(sections[2].el.querySelector('em').textContent, 'italic');
  });
  check('18 blockquote', function () { includes(sections[2].el.querySelector('blockquote').textContent, 'quoted line'); });
  check('19 returned html string contains strict skeleton opening', function () {
    ok(typeof out.html === 'string' && out.html.length > 0, 'empty html');
    includes(out.html, '<div class="markdown-preview-view">');
    includes(out.html, '<div class="markdown-preview-sizer">');
    includes(out.html, '<div class="markdown-rendered">');
  });

  // --- post-processor assertions -------------------------------------------------
  for (const section of sections) {
    await R.applyPostProcessors(section.el, { sourcePath: 'notes/gate-demo.md', frontmatter: out.frontmatter });
  }
  check('20 post-processor called once per section with ctx.sourcePath/frontmatter', function () {
    eq(calls.length, 3);
    eq(calls.map(function (c) { return c.sourcePath; }), ['notes/gate-demo.md', 'notes/gate-demo.md', 'notes/gate-demo.md']);
    eq(calls.map(function (c) { return c.title; }), ['Reading Gate Demo', 'Reading Gate Demo', 'Reading Gate Demo']);
  });
  check('21 tasks post-processor injected 2 checkboxes into the task section', function () {
    eq(sections[1].el.findAll('.lexi-task-checkbox').length, 2);
    eq(sections[1].el.findAll('.task-list-item').length, 2);
    eq(calls[1].itemCount, 2);
  });
  check('22 injected checkbox click callback receives the source line to write back', function () {
    eq(writes.length, 0);
    var boxes = sections[1].el.findAll('.lexi-task-checkbox');
    boxes[0].dispatchEvent(new window.Event('click'));
    eq(writes, ['- [ ] Write gate']);
  });

  // --- section-level incremental rerender -----------------------------------------
  var firstEl = sections[0].el;
  var secondEl = sections[1].el;
  var thirdEl = sections[2].el;
  var firstCountBefore = sections[0].renderCount;
  var secondCountBefore = sections[1].renderCount;
  var thirdCountBefore = sections[2].renderCount;
  var firstCallsBefore = calls.filter(function (c) { return c.el === firstEl; }).length;
  var secondCallsBefore = calls.filter(function (c) { return c.el === secondEl; }).length;

  var rerenderError = null;
  try {
    await R.rerenderSection(1, '## Section Two\n\n- gamma item only');
  } catch (err) {
    rerenderError = err;
  }

  check('23 rerenderSection(1, source) resolves without throwing', function () {
    ok(!rerenderError, rerenderError && rerenderError.message);
  });
  check('24 rerender section 2: section 1 render count unchanged, same node', function () {
    eq(sections[0].renderCount, firstCountBefore);
    same(sections[0].el, firstEl);
  });
  check('25 rerender section 2: section 2 render count +1, content replaced', function () {
    eq(sections[1].renderCount, secondCountBefore + 1);
    same(sections[1].el, secondEl);
    includes(sections[1].el.textContent, 'gamma item only');
    ok(sections[1].el.textContent.indexOf('alpha item') < 0, 'stale "alpha item" still present');
  });
  check('26 rerender section 2: section 3 untouched (count unchanged, same node)', function () {
    eq(sections[2].renderCount, thirdCountBefore);
    same(sections[2].el, thirdEl);
  });
  check('27 rerender only re-ran the post-processor for the changed section', function () {
    eq(calls.filter(function (c) { return c.el === firstEl; }).length, firstCallsBefore);
    eq(calls.filter(function (c) { return c.el === secondEl; }).length, secondCallsBefore + 1);
  });

  // --- report ---------------------------------------------------------------------
  var failed = 0;
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
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
