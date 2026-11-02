#!/usr/bin/env node
'use strict';
// 阅读视图 sourcePath 门禁(离线,不碰设备):宿主 file-open 的 path -> 接线 noteSourcePath -> ctx.sourcePath。
//
// 判据分三类,每类都打印真实 文件:行号 + 该行原文:
// A 宿主侧静态证据:file-open 的 payload 里确实有 path(不是注释行,且落在 fileToJson 体内);
// B 接线侧静态证据:消费 file-open 的 path -> 赋给 sourcePath -> 传给 applyPostProcessors,三步各自可定位;
// C 行为证据:在 jsdom 里 eval 产物尾部那段接线,派发一次带 path / 一次不带 path 的 file-open,
//   断言后处理器收到的 ctx.sourcePath。
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const SRC_PATH = path.join(repoRoot, 'tools', 'workspace-bundle', 'src', 'reading-wiring.js');
const PRODUCT_PATH = path.join(repoRoot, 'entry', 'src', 'main', 'resources', 'rawfile', 'lexinote_workspace.js');
const BRIDGE_PATH = path.join(repoRoot, 'entry', 'src', 'main', 'ets', 'workspace', 'WorkspaceBridge.ets');
const RUNTIME_PATH = path.join(repoRoot, 'entry', 'src', 'main', 'ets', 'core', 'plugin', 'LexiPluginRuntime.ets');
const SHIM_PATH = path.join(repoRoot, 'entry', 'src', 'main', 'resources', 'rawfile', 'lexinote_plugin_shim.js');
const JSDOM_BASE = path.join(repoRoot, 'tools', 'reading-bundle');
const { JSDOM } = require(require.resolve('jsdom', { paths: [JSDOM_BASE] }));

function load(p) {
  const text = fs.readFileSync(p, 'utf8');
  return { path: p, rel: path.relative(repoRoot, p).split(path.sep).join('/'), text: text, lines: text.split(/\r?\n/) };
}
function lineOf(text, index) { return text.slice(0, index).split('\n').length; }
function at(file, lineNo) { return file.rel + ':' + lineNo + ': ' + String(file.lines[lineNo - 1] || '').trim(); }
function isComment(text) { return /^\s*(\/\/|\*|\/\*)/.test(text); }
// 只认代码行:注释行一律不算证据(本门禁的存在意义之一就是别读到注释里那行)。
function codeLines(file, re) {
  const out = [];
  file.lines.forEach(function (t, i) {
    if (isComment(t)) { return; }
    re.lastIndex = 0;
    if (re.test(t)) { out.push({ line: i + 1, text: t }); }
  });
  return out;
}
function commentLines(file, re) {
  const out = [];
  file.lines.forEach(function (t, i) {
    if (!isComment(t)) { return; }
    re.lastIndex = 0;
    if (re.test(t)) { out.push({ line: i + 1, text: t }); }
  });
  return out;
}
function bodyOf(file, name) {
  // 两种声明形态都要认:JS 的 "function f(" 与 ArkTS 的 "private f(x: T): void {"。
  // 方法声明必须带修饰符锚在行首,否则会先命中 this.f(...) 这种调用点。
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(file.text)
    || new RegExp('^[ \\t]*(?:private|public|protected|static|async|export)[ \\t]+(?:async[ \\t]+)?' + name + '\\s*\\(', 'm').exec(file.text);
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
function inBody(file, body, re) {
  const out = [];
  for (let n = body.startLine; n <= body.endLine; n++) {
    const t = file.lines[n - 1] || '';
    if (isComment(t)) { continue; }
    re.lastIndex = 0;
    if (re.test(t)) { out.push({ line: n, text: t }); }
  }
  return out;
}
function findNear(file, lineNo, span, re) {
  for (let n = Math.max(1, lineNo - 1); n <= Math.min(file.lines.length, lineNo + span); n++) {
    const t = file.lines[n - 1] || '';
    if (isComment(t)) { continue; }
    re.lastIndex = 0;
    if (re.test(t)) { return { line: n, text: t }; }
  }
  return null;
}

const results = [];
function fail(evidence, expected) {
  const err = new Error('assertion failed');
  err.evidence = Array.isArray(evidence) ? evidence : [String(evidence)];
  err.expected = expected;
  throw err;
}
function eq(actual, expected, evidence) {
  if (actual !== expected) {
    fail((evidence || []).concat(['actual: ' + JSON.stringify(actual)]), 'equals ' + JSON.stringify(expected));
  }
}
let behavioral = 0;
function check(name, fn, opts) {
  try {
    const evidence = fn() || [];
    results.push({ name: name, ok: true, evidence: evidence, behavioral: !!(opts && opts.behavioral) });
    if (opts && opts.behavioral) { behavioral += 1; }
  } catch (err) {
    results.push({ name: name, ok: false, evidence: (err && err.evidence) || [String((err && err.message) || err)], expected: err && err.expected, behavioral: !!(opts && opts.behavioral) });
    if (opts && opts.behavioral) { behavioral += 1; }
  }
}

// ---- 页面桩:只搭接线用到的那几个全局,内核用记录版替身 ----------------
function makePage(wiringText) {
  const dom = new JSDOM('<!doctype html><html><body><div id="reading-root"></div></body></html>', {
    runScripts: 'outside-only',
    url: 'https://lexinote.local/'
  });
  const window = dom.window;
  const record = { rendered: [], postProcessors: [], listeners: {}, logs: [] };
  window.console = {
    log: function () { record.logs.push(Array.prototype.slice.call(arguments).join(' ')); },
    warn: function () { record.logs.push(Array.prototype.slice.call(arguments).join(' ')); },
    error: function () { record.logs.push(Array.prototype.slice.call(arguments).join(' ')); }
  };
  window.LexiReading = {
    render: function (text, ctx) {
      const containerEl = window.document.createElement('div');
      containerEl.className = 'markdown-preview-view';
      record.rendered.push({ ctx: ctx || null });
      return {
        containerEl: containerEl,
        sections: [{ el: containerEl, source: String(text), getSectionInfo: function () { return { lineStart: 0, lineEnd: 0, text: String(text) }; } }],
        source: String(text),
        frontmatter: ctx ? ctx.frontmatter : undefined,
        sourcePath: ctx ? ctx.sourcePath : undefined
      };
    },
    applyPostProcessors: function (el, ctx) {
      record.postProcessors.push({ sourcePath: ctx ? ctx.sourcePath : undefined, frontmatter: ctx ? ctx.frontmatter : undefined });
      return Promise.resolve({ errors: [] });
    },
    rerenderSection: function () { return Promise.resolve(); },
    registerPostProcessor: function () { return function () {}; }
  };
  window.__lexiEditor = { getValue: function () { return '# 桩标题\n\n桩正文'; } };
  window.LexiObsidian = { namespace: { Plugin: function Plugin() {} } };
  // 兼容层(lexinote_plugin_shim.js)在 bundle 之前建立 window.app.workspace.on;
  // 这里按同样的注册面取监听器,派发时按 Obsidian 位置参数传 TFile。
  window.app = {
    workspace: {
      on: function (name, callback) {
        if (!record.listeners[name]) { record.listeners[name] = []; }
        record.listeners[name].push(callback);
        return { name: name };
      }
    }
  };
  window.eval(wiringText);
  record.emit = function (name, arg) {
    const list = record.listeners[name] || [];
    list.forEach(function (fn) { fn(arg); });
    return list.length;
  };
  return record;
}

function main() {
  const src = load(SRC_PATH);
  const product = load(PRODUCT_PATH);
  const bridge = load(BRIDGE_PATH);
  const runtime = load(RUNTIME_PATH);

  // 产物尾部就是接线原文(build.mjs: bundles/workspace.js + '\n' + src/reading-wiring.js)。
  const MARK = '/*\n * 阅读渲染接线';
  let wiringText = '';
  let productMarkLine = 0;

  check('A1 宿主 fileToJson 的返回对象里有 path 字段,且是 file.path(非注释行)', function () {
    const body = bodyOf(runtime, 'fileToJson');
    if (!body) { fail([runtime.rel + ': 全文'], '未找到 function fileToJson('); }
    const hits = inBody(runtime, body, /['"]path['"]\s*:\s*file\.path/);
    if (hits.length === 0) {
      const commented = commentLines(runtime, /['"]path['"]\s*:/).map(function (h) { return '注释行不算: ' + at(runtime, h.line); });
      fail(commented.concat([at(runtime, body.startLine)]), 'fileToJson(第 ' + body.startLine + '-' + body.endLine + ' 行)体内必须有代码行 \'path\': file.path');
    }
    return [at(runtime, hits[0].line), 'fileToJson 体: ' + runtime.rel + ':' + body.startLine + '-' + body.endLine];
  });

  check('A2 file-open 触发点的 payload 就是 fileToJson(target),不是空对象', function () {
    const triggers = codeLines(runtime, /workspaceEvents\.trigger\(\s*'file-open'\s*,/);
    if (triggers.length === 0) { fail([], '未找到 workspaceEvents.trigger(\'file-open\', ...) 调用点'); }
    const arg = /workspaceEvents\.trigger\(\s*'file-open'\s*,\s*([A-Za-z_$][\w$]*)\s*\)/.exec(triggers[0].text);
    if (!arg) { fail([at(runtime, triggers[0].line)], 'trigger 的载荷必须是具名变量,门禁才能追到来源'); }
    const name = arg[1];
    const from = codeLines(runtime, new RegExp('(var|const|let)\\s+' + name + '\\s*(?::[^=]*)?=\\s*fileToJson\\s*\\('));
    if (from.length === 0) {
      fail([at(runtime, triggers[0].line)], 'payload 变量 ' + name + ' 必须由 fileToJson(...) 赋值,否则帧里没有 path');
    }
    if (!(from[0].line < triggers[0].line)) {
      fail([at(runtime, from[0].line), at(runtime, triggers[0].line)], name + ' 必须在 trigger 之前由 fileToJson 赋值');
    }
    return [at(runtime, from[0].line), at(runtime, triggers[0].line)];
  });

  check('A3 WorkspaceBridge 把带 path 的 payload 原样放进 workspace 帧的 file 键', function () {
    const subs = codeLines(bridge, /workspaceEvents\.on\(\s*'file-open'/);
    if (subs.length === 0) { fail([], '未找到 workspaceEvents.on(\'file-open\', ...) 订阅点'); }
    const push = bodyOf(bridge, 'pushWorkspace');
    if (!push) { fail([at(bridge, subs[0].line)], '未找到 function pushWorkspace('); }
    const guard = inBody(bridge, push, /record\[['"]path['"]\]\s*!==\s*undefined/);
    const assign = inBody(bridge, push, /frame\[['"]file['"]\]\s*=\s*payload/);
    if (guard.length === 0 || assign.length === 0) {
      fail([at(bridge, push.startLine)], 'pushWorkspace 必须按 path 存在与否把关,并把 payload 放进 frame[\'file\']');
    }
    return [at(bridge, subs[0].line), at(bridge, guard[0].line), at(bridge, assign[0].line)];
  });

  // 帧到回调的那一跳在兼容层里:本门禁不改它,只断言它确实把 file-open 的 file 当第一个位置参数
  // 交给 workspace 主题桶 —— 否则接线订阅的是个永远不会有人 trigger 的名字。
  check('A4 兼容层把 workspace/file-open 的 payload.file 交给订阅者(接线订阅的名字真的有人 trigger)', function () {
    const shim = load(SHIM_PATH);
    const args = codeLines(shim, /if\s*\(\s*name\s*===\s*'file-open'\s*\)\s*\{\s*return\s*\[\s*payload\s*&&\s*payload\.file/);
    if (args.length === 0) { fail([shim.rel + ': 全文'], '兼容层 eventArgs 未把 workspace/file-open 的 payload.file 作为回调第一个参数'); }
    const dispatch = codeLines(shim, /topicBuckets\.get\(\s*topic\s*\)|bucket\.trigger\.apply\(\s*bucket\s*,\s*\[\s*name\s*\]\.concat\(\s*eventArgs/);
    if (dispatch.length === 0) { fail([at(shim, args[0].line)], '兼容层 dispatchHostEvent 未把事件按 topic 桶派发'); }
    const sub = codeLines(shim, /on:\s*function\s*\(\s*name\s*,\s*callback[^)]*\)\s*\{\s*return\s*subscribeTopic\(\s*'workspace'/);
    if (sub.length === 0) { fail([at(shim, args[0].line)], '兼容层 workspace.on 未接到 workspace 主题桶'); }
    return [at(shim, args[0].line), at(shim, dispatch[dispatch.length - 1].line), at(shim, sub[0].line)];
  });

  check('B0 产物尾部与 reading-wiring.js 逐字节一致(产物没有过期)', function () {
    const idx = product.text.indexOf(MARK);
    if (idx < 0) { fail([product.rel + ': 全文'], '产物尾部找不到接线段的起始注释(/* 阅读渲染接线)'); }
    wiringText = product.text.slice(idx);
    productMarkLine = lineOf(product.text, idx);
    if (wiringText !== src.text) {
      fail([product.rel + ':' + productMarkLine, src.rel + ':1'], '产物里的接线段与 src/reading-wiring.js 不一致,先跑 cd tools/workspace-bundle && node build.mjs');
    }
    return [product.rel + ':' + productMarkLine + '(接线段起点,与 ' + src.rel + ' 逐字节相同)', '产物 ' + product.text.length + ' 字符 / 接线 ' + wiringText.length + ' 字符'];
  });

  check('B1 接线消费 file-open:订阅点把事件里的 file 交给 applySourcePath(filePathOf(...))', function () {
    const subs = codeLines(src, /workspace\.on\(\s*'file-open'\s*,/);
    if (subs.length === 0) { fail([], '接线里未订阅 file-open(window.app.workspace.on)'); }
    const forwarded = subs.filter(function (h) { return /applySourcePath\s*\(\s*filePathOf\s*\(/.test(h.text); });
    if (forwarded.length === 0) {
      fail([at(src, subs[0].line)], 'file-open 回调必须把 file 的 path 交给 applySourcePath');
    }
    const reader = bodyOf(src, 'filePathOf');
    if (!reader) { fail([at(src, subs[0].line)], '未找到 function filePathOf('); }
    if (inBody(src, reader, /typeof\s+p\s*===\s*'string'/).length === 0) {
      fail([at(src, reader.startLine)], 'filePathOf 必须对 path 做字符串校验,类型不对回落空串');
    }
    return [at(src, subs[0].line), at(src, reader.startLine)];
  });

  check('B2 挂上订阅的函数在 wire() 里被调用(不是定义了不用)', function () {
    const wire = bodyOf(src, 'wire');
    if (!wire) { fail([], '未找到 function wire('); }
    const calls = inBody(src, wire, /watchSourcePath\s*\(\s*\)/);
    if (calls.length === 0) { fail([at(src, wire.startLine)], 'wire() 必须调用 watchSourcePath()'); }
    return [at(src, calls[0].line)];
  });

  check('B3 事件路径被赋给当前 sourcePath(applySourcePath 体内 noteSourcePath = next)', function () {
    const body = bodyOf(src, 'applySourcePath');
    if (!body) { fail([], '未找到 function applySourcePath('); }
    const assign = inBody(src, body, /noteSourcePath\s*=\s*next\s*;/);
    if (assign.length === 0) { fail([at(src, body.startLine)], 'applySourcePath 必须把 next 赋给 noteSourcePath'); }
    return [at(src, body.startLine), at(src, assign[0].line)];
  });

  check('B4 该值被传给 applyPostProcessors 的 ctx.sourcePath(sourcePath: noteSourcePath)', function () {
    const calls = codeLines(src, /window\.LexiReading\.applyPostProcessors\s*\(/);
    if (calls.length === 0) { fail([], '未找到 applyPostProcessors 调用点'); }
    const evidence = [];
    calls.forEach(function (h) {
      const key = findNear(src, h.line, 4, /sourcePath\s*:\s*noteSourcePath\s*[,}]/);
      if (!key) {
        fail([at(src, h.line)], 'applyPostProcessors 的 ctx.sourcePath 必须是变量 noteSourcePath,不能是空串字面量');
      }
      evidence.push(at(src, h.line), at(src, key.line));
    });
    return evidence;
  });

  check('C1 行为:带 path 的 file-open 之后,后处理器收到的 ctx.sourcePath 等于该 path', function () {
    const page = makePage(wiringText);
    if (page.rendered.length !== 1) { fail(['render 调用次数: ' + page.rendered.length], '接线应只整篇 render 一次'); }
    const before = page.postProcessors.length;
    if (before < 1) { fail([], '首屏应补跑一次后处理器'); }
    if (page.postProcessors[0].sourcePath !== '') {
      fail(['首屏 ctx.sourcePath = ' + JSON.stringify(page.postProcessors[0].sourcePath)], '未收到事件前 ctx.sourcePath 必须是空串');
    }
    const NOTE = 'notes/reading-gate-demo.md';
    const delivered = page.emit('file-open', { path: NOTE, name: 'reading-gate-demo.md', kind: 'file' });
    if (delivered < 1) { fail([], '接线没有订阅 file-open,事件无人接手'); }
    const last = page.postProcessors[page.postProcessors.length - 1];
    eq(last.sourcePath, NOTE, ['派发 path=' + NOTE + ' 后,后处理器次数 ' + page.postProcessors.length]);
    return ['case 带 path: emit file-open {path:"' + NOTE + '"} -> ctx.sourcePath = ' + JSON.stringify(last.sourcePath) + ' (订阅者 ' + delivered + ' 个)'];
  }, { behavioral: true });

  check('C2 行为:不带 path 的 file-open 不会把 ctx.sourcePath 变成 undefined/null,仍是空串且不抛错', function () {
    const page = makePage(wiringText);
    let thrown = null;
    try {
      page.emit('file-open', null);
      page.emit('file-open', { name: 'no-path' });
      page.emit('file-open', { path: 42 });
      page.emit('file-open', { path: '' });
    } catch (err) {
      thrown = String((err && err.message) || err);
    }
    if (thrown !== null) { fail(['抛错: ' + thrown], '没有 path 的事件不得抛错'); }
    const all = page.postProcessors;
    if (all.length < 1) { fail([], '首屏应至少跑过一次后处理器'); }
    const bad = all.filter(function (p) { return p.sourcePath !== ''; });
    if (bad.length > 0) {
      fail(bad.map(function (p) { return 'ctx.sourcePath = ' + JSON.stringify(p.sourcePath); }), '每个 ctx.sourcePath 都必须是 ""(不是 undefined/null)');
    }
    const types = all.map(function (p) { return typeof p.sourcePath; });
    if (types.some(function (t) { return t !== 'string'; })) {
      fail(['typeof 序列: ' + JSON.stringify(types)], 'ctx.sourcePath 必须是字符串');
    }
    return ['case 不带 path: 4 次无 path 事件无异常,后处理器 ' + all.length + ' 次,ctx.sourcePath 全为 "" (typeof string)'];
  }, { behavioral: true });

  let failed = 0;
  results.forEach(function (r) {
    console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name);
    if (r.expected) { console.log('      expected: ' + r.expected); }
    (r.evidence || []).slice(0, 5).forEach(function (line) { console.log('      -> ' + line); });
  });
  results.forEach(function (r) { if (!r.ok) { failed += 1; } });
  console.log('');
  console.log('host:    ' + runtime.rel + ', ' + bridge.rel);
  console.log('wiring:  ' + src.rel);
  console.log('product: ' + product.rel);
  console.log('assertions: ' + results.length + ', behavioral: ' + behavioral + ', passed: ' + (results.length - failed) + ', failed: ' + failed);
  if (failed > 0) { process.exitCode = 1; }
}

try {
  main();
} catch (err) {
  console.error('gate crashed: ' + ((err && err.stack) || err));
  process.exitCode = 1;
}
