#!/usr/bin/env node
'use strict';
// 工作区容器 -> 阅读渲染内核(M2-B 第一片)的接线门禁:静态、离线、不碰设备。
//
// 判据全是源码里可 grep 的形状,不执行页面、不起 jsdom、不发任何网络请求:
// 1 页面挂载两个内核产物(本地相对路径,且 reading.js 先于 workspace.js);
// 2 render 调用点的第一个参数必须是笔记正文变量 noteSource,不能是空串字面量;
// 3 applyPostProcessors 调用点的 ctx 必须带 sourcePath 与 frontmatter;
// 4 rerenderSection 调用点存在,且落在 refreshReading 体内(编辑后走节级增量);
// 5 不存在"每次刷新都整篇 render"的路径 —— 判据见该断言内的注释;
// 6 接线里写死的骨架选择器常量必须与内核产物一致;
// 7 插件后处理器桥:覆写 Plugin.prototype 并转进内核注册表,ctx 原样透传。
//
// 每条断言失败都打印 文件:行号 + 该行原文,便于照抄修。
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const RAW_DIR = path.join(repoRoot, 'entry', 'src', 'main', 'resources', 'rawfile');
const HTML_PATH = path.join(RAW_DIR, 'lexinote_workspace.html');
const PAGE_PATH = path.join(RAW_DIR, 'lexinote_workspace.js');
const KERNEL_PATH = path.join(RAW_DIR, 'lexinote_reading.js');
const CSS_PATH = path.join(RAW_DIR, 'lexinote_reading.css');

const EXPECTED_SKELETON = ['markdown-preview-view', 'markdown-preview-sizer', 'markdown-rendered', 'markdown-preview-section'];
const EXPECTED_ATTR = 'data-heading-level';

function load(p) {
  const text = fs.readFileSync(p, 'utf8');
  return { path: p, rel: path.relative(repoRoot, p).split(path.sep).join('/'), text: text, lines: text.split(/\r?\n/) };
}
function lineOf(text, index) { return text.slice(0, index).split('\n').length; }
function at(file, lineNo) { return file.rel + ':' + lineNo + ': ' + String(file.lines[lineNo - 1] || '').trim(); }
// 注释掉的调用点不算接线:纯注释行(// 与块注释续行 *)一律跳过,另行用 findCommentedLines 取证。
function findAll(file, re) {
  const out = [];
  file.lines.forEach(function (t, i) {
    if (/^\s*(\/\/|\*)/.test(t)) { return; }
    re.lastIndex = 0;
    if (re.test(t)) { out.push({ line: i + 1, text: t }); }
  });
  return out;
}
function findCommentedLines(file, re) {
  const out = [];
  file.lines.forEach(function (t, i) {
    if (!/^\s*(\/\/|\*)/.test(t)) { return; }
    re.lastIndex = 0;
    if (re.test(t)) { out.push({ line: i + 1, text: t }); }
  });
  return out;
}
function findInWindow(file, lineNo, span, re) {
  const from = Math.max(1, lineNo - 1);
  const to = Math.min(file.lines.length, lineNo + span);
  for (let i = from; i <= to; i++) {
    re.lastIndex = 0;
    if (re.test(file.lines[i - 1] || '')) { return { line: i, text: file.lines[i - 1] }; }
  }
  return null;
}
// 按大括号配对取一个具名函数的函数体:静态判"调用点在不在这个函数里"只能这么判。
function bodyOf(file, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(', 'g').exec(file.text);
  if (!m) { return null; }
  const open = file.text.indexOf('{', m.index);
  if (open < 0) { return null; }
  let depth = 0;
  let end = -1;
  for (let i = open; i < file.text.length; i++) {
    const ch = file.text.charAt(i);
    if (ch === '{') { depth += 1; }
    else if (ch === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) { return null; }
  return { text: file.text.slice(m.index, end), startLine: lineOf(file.text, m.index), endLine: lineOf(file.text, end) };
}

const results = [];
function fail(evidence, expected) {
  const err = new Error('assertion failed');
  err.evidence = evidence;
  err.expected = expected;
  throw err;
}
function check(name, fn) {
  try {
    const evidence = fn() || [];
    results.push({ name: name, ok: true, evidence: evidence });
  } catch (err) {
    results.push({ name: name, ok: false, evidence: (err && err.evidence) || [String((err && err.message) || err)], expected: err && err.expected });
  }
}
function parseStringArray(source) {
  const out = [];
  const re = /'([^']*)'|"([^"]*)"/g;
  let m;
  while ((m = re.exec(source))) { out.push(m[1] === undefined ? m[2] : m[1]); }
  return out;
}

function main() {
  const html = load(HTML_PATH);
  const page = load(PAGE_PATH);
  const kernel = load(KERNEL_PATH);
  const css = load(CSS_PATH);

  check('1 页面装载 lexinote_reading.css 与 lexinote_reading.js(本地相对路径,js 先于 workspace.js)', function () {
    const cssTags = findAll(html, /<link[^>]+href=["']lexinote_reading\.css["']/);
    const jsTags = findAll(html, /<script[^>]+src=["']lexinote_reading\.js["']/);
    if (cssTags.length !== 1 || jsTags.length !== 1) {
      fail(cssTags.map(function (h) { return at(html, h.line); }).concat(jsTags.map(function (h) { return at(html, h.line); })), 'html 里各恰好一处 link href=lexinote_reading.css 与 script src=lexinote_reading.js');
    }
    if (findAll(html, /(https?:|file:)\/\/\S*lexinote_reading/).length > 0) {
      fail(findAll(html, /(https?:|file:)\/\/\S*lexinote_reading/).map(function (h) { return at(html, h.line); }), '内核资源必须本地相对路径,不许网络请求');
    }
    const pageTags = findAll(html, /<script[^>]+src=["']lexinote_workspace\.js["']/);
    if (pageTags.length !== 1) { fail([], 'html 里应恰好一处 script src=lexinote_workspace.js'); }
    if (!(jsTags[0].line < pageTags[0].line)) {
      fail([at(html, jsTags[0].line), at(html, pageTags[0].line)], 'lexinote_reading.js 必须先于 lexinote_workspace.js');
    }
    if (!/<div[^>]+id=["']reading-root["']/.test(html.text)) { fail([], 'html 缺少 #reading-root 挂载点'); }
    return [at(html, cssTags[0].line), at(html, jsTags[0].line), at(html, pageTags[0].line)];
  });

  check('2 存在 render 调用点,第一个参数是笔记正文变量 noteSource(不是空串字面量)', function () {
    const calls = findAll(page, /window\.LexiReading\.render\s*\(/);
    if (calls.length === 0) { fail([], '未找到 window.LexiReading.render( 调用点'); }
    const bad = calls.filter(function (h) { return !/window\.LexiReading\.render\s*\(\s*noteSource\s*,/.test(h.text); });
    if (bad.length > 0) {
      fail(bad.map(function (h) { return at(page, h.line); }), '第一个参数必须是笔记正文变量 noteSource');
    }
    const feed = findAll(page, /noteSource\s*=\s*[^;]*getValue\s*\(/);
    if (feed.length === 0) { fail([], 'noteSource 未由编辑器活文档(getValue)赋值,正文可能为空'); }
    return calls.map(function (h) { return at(page, h.line); }).concat([at(page, feed[0].line)]);
  });

  check('3 存在 applyPostProcessors 调用点,ctx 带 sourcePath 与 frontmatter', function () {
    const calls = findAll(page, /window\.LexiReading\.applyPostProcessors\s*\(/);
    if (calls.length === 0) { fail([], '未找到 window.LexiReading.applyPostProcessors( 调用点'); }
    const evidence = [];
    calls.forEach(function (h) {
      const sourcePath = findInWindow(page, h.line, 4, /sourcePath\s*:/);
      const frontmatter = findInWindow(page, h.line, 4, /frontmatter\s*:/);
      if (!sourcePath || !frontmatter) {
        fail([at(page, h.line)], 'applyPostProcessors 的 ctx 必须写 sourcePath 与 frontmatter 两个键');
      }
      evidence.push(at(page, h.line), at(page, sourcePath.line), at(page, frontmatter.line));
    });
    return evidence;
  });

  check('4 存在 rerenderSection 调用点,且落在 refreshReading 体内(编辑后节级增量)', function () {
    const body = bodyOf(page, 'refreshReading');
    if (!body) { fail([], '未找到 function refreshReading( 编辑器刷新入口'); }
    const calls = findAll(page, /window\.LexiReading\.rerenderSection\s*\(/);
    const inside = calls.filter(function (h) { return h.line >= body.startLine && h.line <= body.endLine; });
    if (inside.length === 0) {
      const evidence = findCommentedLines(page, /LexiReading\.rerenderSection\s*\(/).map(function (h) { return '被注释掉的调用点: ' + at(page, h.line); });
      evidence.push('refreshReading 起始行: ' + at(page, body.startLine));
      fail(evidence, 'rerenderSection 必须在 refreshReading(第 ' + body.startLine + '-' + body.endLine + ' 行)体内被调用,且不得被注释掉');
    }
    return [at(page, body.startLine), at(page, inside[0].line)];
  });

  // 5 判据(全部为源码形状,不执行页面):
  //   a) 全文件 window.LexiReading.render( 只允许出现 1 次 —— 多一处就意味着存在第二条整篇重建路径;
  //   b) 这唯一一次必须落在 mountReading 体内(首次装载);
  //   c) mountReading 必须在 render 之前就有已装载短路 if (reading) { return true; };
  //   d) refreshReading 体内不允许出现 window.LexiReading.render(。
  check('5 不存在每次刷新都整篇 render 的路径(整篇 render 仅首次装载)', function () {
    const calls = findAll(page, /window\.LexiReading\.render\s*\(/);
    if (calls.length !== 1) {
      fail(calls.map(function (h) { return at(page, h.line); }), 'window.LexiReading.render( 全文件只允许 1 处(首次装载)');
    }
    const mount = bodyOf(page, 'mountReading');
    if (!mount) { fail([], '未找到 function mountReading('); }
    if (!(calls[0].line >= mount.startLine && calls[0].line <= mount.endLine)) {
      fail([at(page, calls[0].line)], '唯一的 render 调用必须在 mountReading(第 ' + mount.startLine + '-' + mount.endLine + ' 行)体内');
    }
    const guard = findInWindow(page, mount.startLine, mount.endLine - mount.startLine, /if\s*\(\s*reading\s*\)\s*\{\s*return\s+true\s*;?\s*\}/);
    if (!guard || guard.line > calls[0].line) {
      fail([at(page, mount.startLine)], 'mountReading 必须在 render 之前短路已装载(if (reading) { return true; })');
    }
    const refresh = bodyOf(page, 'refreshReading');
    if (!refresh) { fail([], '未找到 function refreshReading('); }
    if (/window\.LexiReading\.render\s*\(/.test(refresh.text)) {
      fail([at(page, refresh.startLine)], 'refreshReading 体内不许整篇 render');
    }
    return [at(page, calls[0].line), at(page, guard.line), at(page, refresh.startLine)];
  });

  check('6 骨架选择器常量与内核一致(markdown-preview-view>sizer>rendered>section[data-heading-level])', function () {
    const decl = /var\s+SKELETON_SELECTORS\s*=\s*\[([\s\S]*?)\]/.exec(page.text);
    if (!decl) { fail([], 'page 里未声明 SKELETON_SELECTORS 常量数组'); }
    const actual = parseStringArray(decl[1]);
    const declLine = lineOf(page.text, decl.index);
    if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_SKELETON)) {
      fail([at(page, declLine)], 'SKELETON_SELECTORS = ' + JSON.stringify(EXPECTED_SKELETON));
    }
    const evidence = [at(page, declLine)];
    EXPECTED_SKELETON.forEach(function (cls) {
      if (kernel.text.indexOf('"' + cls + '"') < 0) {
        fail(evidence.concat([kernel.rel + ': 全文']), '内核产物里找不到类名 ' + cls + ',接线常量与内核不一致');
      }
    });
    if (kernel.text.indexOf('"' + EXPECTED_ATTR + '"') < 0) {
      fail(evidence, '内核产物里找不到 ' + EXPECTED_ATTR + ' 属性写入');
    }
    const attrDecl = findAll(page, new RegExp('var\\s+SECTION_LEVEL_ATTR\\s*=\\s*[\'"]' + EXPECTED_ATTR + '[\'"]'));
    if (attrDecl.length === 0) { fail(evidence, 'page 里未声明 SECTION_LEVEL_ATTR = ' + EXPECTED_ATTR); }
    if (!/SKELETON_SELECTORS\.join\(\s*' > \.'\s*\)/.test(page.text)) {
      fail(evidence, '挂载后未用常量拼骨架选择器自查(missingSkeleton)');
    }
    return evidence.concat([at(page, attrDecl[0].line)]);
  });

  check('7 插件 registerMarkdownPostProcessor 桥到 LexiReading.registerPostProcessor,ctx 原样透传', function () {
    const patch = findAll(page, /Plugin\.prototype\.registerMarkdownPostProcessor\s*=\s*function/);
    if (patch.length === 0) { fail([], 'page 里未覆写 Plugin.prototype.registerMarkdownPostProcessor'); }
    const register = findAll(page, /window\.LexiReading\.registerPostProcessor\s*\(/);
    if (register.length === 0) { fail([at(page, patch[0].line)], '未找到 window.LexiReading.registerPostProcessor( 调用点'); }
    const forward = findAll(page, /processor\s*\(\s*el\s*,\s*ctx\s*\)/);
    if (forward.length === 0) { fail([at(page, register[0].line)], '后处理器必须原样转交 (el, ctx)'); }
    if (findAll(page, /__lexiReadingBridge/).length === 0) { fail([at(page, patch[0].line)], '覆写缺幂等标记 __lexiReadingBridge'); }
    return [at(page, patch[0].line), at(page, register[0].line), at(page, forward[0].line)];
  });

  let failed = 0;
  results.forEach(function (r) {
    if (r.ok) {
      console.log('PASS  ' + r.name);
      (r.evidence || []).slice(0, 4).forEach(function (line) { console.log('      -> ' + line); });
    } else {
      failed += 1;
      console.log('FAIL  ' + r.name);
      if (r.expected) { console.log('      expected: ' + r.expected); }
      (r.evidence || []).forEach(function (line) { console.log('      ' + line); });
    }
  });
  console.log('');
  console.log('html:   ' + html.rel);
  console.log('page:   ' + page.rel);
  console.log('kernel: ' + kernel.rel + ', ' + css.rel);
  console.log('assertions: ' + results.length + ', passed: ' + (results.length - failed) + ', failed: ' + failed);
  if (failed > 0) { process.exitCode = 1; }
}

try {
  main();
} catch (err) {
  console.error('gate crashed: ' + ((err && err.stack) || err));
  process.exitCode = 1;
}