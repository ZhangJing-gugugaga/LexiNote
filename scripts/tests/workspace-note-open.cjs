#!/usr/bin/env node
'use strict';
// 笔记正文装载/写回门禁(离线,不碰设备):宿主 file-open -> 读正文 -> note-open 事件 -> 编辑器;
// 编辑器改动 -> debounce -> workspace.note.write -> 宿主 vault.modify。
//
// 三类判据,每条都打印真实的 文件:行号 + 该行原文:
// A 产物/构建静态证据:产物里的通道段与 src 逐字节一致、reading-wiring 段仍在最后(build 顺序);
// B 宿主静态证据:bridge 读正文走 vault.read、写回只认会话身份且走 vault.modify;
// C 行为证据:在 jsdom 里按产物顺序 eval 通道段 + 接线段,派发 note-open / 编辑 / 空 path / 失败 payload,
//   断言编辑器内容、写回调用与日志。
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const NOTE_SRC_PATH = path.join(repoRoot, 'tools', 'workspace-bundle', 'src', 'workspace-note-open.js');
const WIRING_SRC_PATH = path.join(repoRoot, 'tools', 'workspace-bundle', 'src', 'reading-wiring.js');
const BUILD_PATH = path.join(repoRoot, 'tools', 'workspace-bundle', 'build.mjs');
const PRODUCT_PATH = path.join(repoRoot, 'entry', 'src', 'main', 'resources', 'rawfile', 'lexinote_workspace.js');
const BRIDGE_PATH = path.join(repoRoot, 'entry', 'src', 'main', 'ets', 'workspace', 'WorkspaceBridge.ets');
const PROTOCOL_PATH = path.join(repoRoot, 'entry', 'src', 'main', 'ets', 'workspace', 'WorkspaceProtocol.ets');
const JSDOM_BASE = path.join(repoRoot, 'tools', 'reading-bundle');
const { JSDOM } = require(require.resolve('jsdom', { paths: [JSDOM_BASE] }));

function load(p) {
  const text = fs.readFileSync(p, 'utf8');
  return { path: p, rel: path.relative(repoRoot, p).split(path.sep).join('/'), text: text, lines: text.split(/\r?\n/) };
}
function at(file, lineNo) { return file.rel + ':' + lineNo + ': ' + String(file.lines[lineNo - 1] || '').trim(); }
function isComment(text) { return /^\s*(\/\/|\*|\/\*)/.test(text); }
function codeLines(file, re) {
  const out = [];
  file.lines.forEach(function (t, i) {
    if (isComment(t)) { return; }
    re.lastIndex = 0;
    if (re.test(t)) { out.push({ line: i + 1, text: t, evidence: at(file, i + 1) }); }
  });
  return out;
}
function bodyOf(file, name) {
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
  return { start: m.index, end: end, text: file.text.slice(m.index, end) };
}
function bodyEvidence(file, body, re) {
  const out = [];
  body.text.split('\n').forEach(function (line) {
    re.lastIndex = 0;
    if (re.test(line)) {
      const idx = file.text.indexOf(body.text) + body.text.indexOf(line);
      out.push(at(file, file.text.slice(0, idx).split('\n').length));
    }
  });
  return out;
}
function fail(evidence, expected) {
  const err = new Error(typeof evidence === 'string' ? evidence : (evidence || []).join(' | '));
  err.evidence = Array.isArray(evidence) ? evidence : [evidence];
  err.expected = expected;
  throw err;
}
function ok(cond, evidence, expected) { if (!cond) { fail(evidence, expected); } }

const results = [];
let behavioral = 0;
function check(name, fn, opts) {
  try {
    const evidence = fn() || [];
    results.push({ name: name, ok: true, evidence: evidence });
    if (opts && opts.behavioral) { behavioral += 1; }
  } catch (err) {
    results.push({ name: name, ok: false, evidence: (err && err.evidence) || [String((err && err.message) || err)], expected: err && err.expected });
    if (opts && opts.behavioral) { behavioral += 1; }
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- 页面桩:按产物顺序先跑通道段,再跑阅读接线段 ----
function makePage(noteText, wiringText) {
  const dom = new JSDOM('<!doctype html><html><body><div id="reading-root"></div></body></html>', {
    runScripts: 'outside-only',
    url: 'https://lexinote.local/'
  });
  const window = dom.window;
  const record = { logs: [], writes: [], otherCalls: [], listeners: {}, rendered: 0, contexts: [] };
  const push = function () { record.logs.push(Array.prototype.slice.call(arguments).join(' ')); };
  window.console = { log: push, warn: push, error: push };

  const editor = { text: '# 桩笔记\n\n桩正文', updateListeners: [] };
  window.__lexiEditor = {
    getValue: function () { return editor.text; },
    setValue: function (text) {
      editor.text = String(text);
      editor.updateListeners.slice().forEach(function (fn) { fn({ docChanged: true }); });
      return editor.text.length;
    },
    cm: function () {
      return {
        dispatch: function (spec) {
          if (spec && typeof spec.effects === 'function') { editor.updateListeners.push(spec.effects); }
        }
      };
    }
  };
  window.LexiCmModules = {
    '@codemirror/state': { StateEffect: { appendConfig: { of: function (ext) { return ext; } } } },
    '@codemirror/view': { EditorView: { updateListener: { of: function (fn) { return fn; } } } }
  };
  window.LexiPluginShim = {
    call: function (method, payload) {
      if (method === 'log.event') { return Promise.resolve({ ok: true }); }
      if (method === 'workspace.note.write') {
        record.writes.push({ path: payload.path, content: payload.content });
        return Promise.resolve({ path: payload.path, chars: String(payload.content).length });
      }
      record.otherCalls.push({ method: method, payload: payload });
      return Promise.resolve(null);
    }
  };
  window.LexiReading = {
    render: function (text) {
      record.rendered += 1;
      const el = window.document.createElement('div');
      return {
        containerEl: el,
        sections: [{ el: el, source: String(text), getSectionInfo: function () { return { lineStart: 0, lineEnd: 0, text: String(text) }; } }],
        source: String(text)
      };
    },
    applyPostProcessors: function (el, ctx) {
      record.contexts.push({ sourcePath: ctx ? ctx.sourcePath : undefined, frontmatter: ctx ? ctx.frontmatter : undefined });
      return Promise.resolve({ errors: [] });
    },
    rerenderSection: function () { return Promise.resolve(); },
    registerPostProcessor: function () { return function () {}; }
  };
  window.LexiObsidian = {
    namespace: { Plugin: function Plugin() {} },
    dispatchEvent: function (event) { record.lastEvent = event; return true; }
  };
  window.app = {
    workspace: {
      on: function (name, callback) {
        if (!record.listeners[name]) { record.listeners[name] = []; }
        record.listeners[name].push(callback);
        return { name: name };
      }
    }
  };
  window.eval(noteText);
  window.eval(wiringText);

  record.window = window;
  record.editor = editor;
  record.text = function () { return editor.text; };
  record.type = function (text) {
    editor.text = String(text);
    editor.updateListeners.slice().forEach(function (fn) { fn({ docChanged: true }); });
  };
  record.emitFileOpen = function (p) {
    const list = record.listeners['file-open'] || [];
    list.forEach(function (fn) { fn({ path: p }); });
    window.LexiObsidian.dispatchEvent({ topic: 'workspace', name: 'file-open', payload: { file: { path: p } } });
  };
  record.noteOpen = function (payload) {
    window.LexiObsidian.dispatchEvent({ topic: 'workspace', name: 'note-open', payload: payload });
  };
  record.logsWith = function (topic) { return record.logs.filter(function (line) { return line.indexOf(topic) >= 0; }); };
  return record;
}

async function newPage(noteSrc, wiringSrc) {
  const page = makePage(noteSrc.text, wiringSrc.text);
  await sleep(120);
  return page;
}

async function main() {
  const noteSrc = load(NOTE_SRC_PATH);
  const wiringSrc = load(WIRING_SRC_PATH);
  const build = load(BUILD_PATH);
  const product = load(PRODUCT_PATH);
  const bridge = load(BRIDGE_PATH);
  const protocol = load(PROTOCOL_PATH);

  // ---- A 产物/构建 ----
  check('A1 产物里通道段与 src/workspace-note-open.js 逐字节一致,且其后紧接 [换行 + reading-wiring 原文]', function () {
    const idx = product.text.indexOf(noteSrc.text);
    ok(idx >= 0, ['产物中找不到通道段原文', product.rel + ': 全文', noteSrc.rel + ': 全文'], '产物包含通道段');
    const tail = product.text.slice(idx + noteSrc.text.length);
    ok(tail === '\n' + wiringSrc.text,
      ['通道段之后不是 [换行 + 接线原文]', '产物尾部前 80 字: ' + JSON.stringify(tail.slice(0, 80))],
      'text.slice(idx + len) === "\\n" + src/reading-wiring.js');
    return [noteSrc.rel + ': 全段 (' + noteSrc.lines.length + ' 行) 出现在产物偏移 ' + idx,
      '接线段仍在文件最末(reading-source-path.cjs B0 依赖此顺序)'];
  });

  check('A2 build.mjs 按 [通道段, 接线段] 顺序追加,缺文件/空文件都 exit(1)', function () {
    const order = codeLines(build, /const\s+APPENDED_SOURCES\s*=\s*\[/)[0];
    ok(order, [build.rel + ': 全文'], 'APPENDED_SOURCES 常量');
    ok(order.text.indexOf('src/workspace-note-open.js') > 0 && order.text.indexOf('src/workspace-note-open.js') < order.text.indexOf('src/reading-wiring.js'),
      [order.evidence], '通道段排在接线段之前');
    const loop = codeLines(build, /catch\s*\(error\)|process\.exit\(1\)/);
    ok(loop.length >= 2, [build.rel + ': 全文'], '缺文件/空文件走 exit(1)');
    const appendLoop = codeLines(build, /product \+= '\\n' \+ entry\.text/)[0];
    ok(appendLoop, [build.rel + ': 全文'], "product += '\\n' + entry.text");
    return [order.evidence, appendLoop.evidence, loop[0].evidence];
  });

  // ---- B 宿主静态 ----
  check('B1 宿主装载:file-open 订阅里调 openNoteOf,pumpNote 用 manager.vault.read(file) 取正文并下推 note-open', function () {
    const sub = codeLines(bridge, /workspaceEvents\.on\('file-open'/)[0];
    ok(sub, [bridge.rel + ': 全文'], "workspaceEvents.on('file-open'");
    const call = codeLines(bridge, /this\.openNoteOf\(payload\)/)[0];
    ok(call, [bridge.rel + ': 全文'], 'this.openNoteOf(payload)');
    const pump = bodyOf(bridge, 'pumpNote');
    ok(pump, [bridge.rel + ': 全文'], 'private pumpNote(');
    const read = bodyEvidence(bridge, pump, /manager\.vault\.read\(file\)/);
    ok(read.length === 1, [bridge.rel + ': pumpNote'], '一次 vault.read(file)');
    const push = bodyOf(bridge, 'pushNoteOpen');
    ok(push, [bridge.rel + ': 全文'], 'private pushNoteOpen(');
    ok(/WORKSPACE_EVENT_NOTE_OPEN as Object/.test(push.text), [bridge.rel + ': pushNoteOpen'], 'name=WORKSPACE_EVENT_NOTE_OPEN');
    ok(/'content': content as Object/.test(push.text) && /'path': path as Object/.test(push.text), [bridge.rel + ': pushNoteOpen'], 'payload 含 path/content');
    ok(/this\.pushEvent\('workspace', payload\)/.test(push.text), [bridge.rel + ': pushNoteOpen'], "pushEvent('workspace', payload)");
    ok(!/readTextFile|writeTextFile|@ohos\.file\.fs/.test(pump.text), [bridge.rel + ': pumpNote'], '不经 fs 直读');
    return [sub.evidence, call.evidence, read[0], at(bridge, bridge.lines.findIndex(function (t) { return /'content': content as Object/.test(t); }) + 1)];
  });

  check('B2 宿主写回:dispatch 认 workspace.note.write,onNoteWrite 只放会话身份,缺 path/content 拒绝,写入走 vault.modify', function () {
    const br = codeLines(bridge, /method === WORKSPACE_METHOD_NOTE_WRITE/)[0];
    ok(br, [bridge.rel + ': 全文'], 'dispatch 分支');
    const body = bodyOf(bridge, 'onNoteWrite');
    ok(body, [bridge.rel + ': 全文'], 'private async onNoteWrite(');
    ok(/pluginId !== SESSION_PLUGIN_ID/.test(body.text), [bridge.rel + ': onNoteWrite'], '身份只认 SESSION_PLUGIN_ID');
    ok(/ERR_BAD_REQUEST, '缺少 path'/.test(body.text) && /ERR_BAD_REQUEST, '缺少 content'/.test(body.text),
      [bridge.rel + ': onNoteWrite'], 'path/content 都有 bad_request 守卫');
    const modify = bodyEvidence(bridge, body, /await manager\.vault\.modify\(file, data\)/);
    ok(modify.length === 1, [bridge.rel + ': onNoteWrite'], 'await manager.vault.modify(file, data)');
    ok(/ERR_NOTE_NOT_FOUND/.test(body.text), [bridge.rel + ': onNoteWrite'], '文件不存在单独错误码');
    return [br.evidence, modify[0], at(bridge, bridge.lines.findIndex(function (t) { return /pluginId !== SESSION_PLUGIN_ID/.test(t); }) + 1)];
  });

  check('B3 协议常量:note-open 事件名与 workspace.note.write 方法名定义在 WorkspaceProtocol.ets', function () {
    const ev = codeLines(protocol, /WORKSPACE_EVENT_NOTE_OPEN: string = 'note-open'/)[0];
    const method = codeLines(protocol, /WORKSPACE_METHOD_NOTE_WRITE: string = 'workspace\.note\.write'/)[0];
    ok(ev, [protocol.rel + ': 全文'], "WORKSPACE_EVENT_NOTE_OPEN = 'note-open'");
    ok(method, [protocol.rel + ': 全文'], "WORKSPACE_METHOD_NOTE_WRITE = 'workspace.note.write'");
    return [ev.evidence, method.evidence];
  });

  // ---- C 行为 ----
  const page = await newPage(noteSrc, wiringSrc);
  const notePath = 'notes/真笔记.md';
  const loaded = '# 真笔记\n\n正文一';
  const edited = '# 真笔记\n\n正文一 已编辑';

  page.emitFileOpen(notePath);
  await sleep(400);
  check('C1 file-open 后接线的 sourcePath 仍是该 path(applyPostProcessors 的 ctx.sourcePath),通道侧记录同一 path', function () {
    const last = page.contexts[page.contexts.length - 1];
    ok(page.contexts.length >= 1, page.logs.slice(-6), 'applyPostProcessors 至少一次');
    ok(last.sourcePath === notePath, ['ctx.sourcePath=' + JSON.stringify(last.sourcePath)], 'ctx.sourcePath === ' + notePath);
    const channelLog = page.logsWith('note.open.source');
    ok(channelLog.length >= 1 && channelLog[channelLog.length - 1].indexOf(notePath) >= 0, channelLog, 'note.open.source 带 path');
    return ['ctx.sourcePath=' + JSON.stringify(last.sourcePath), channelLog[channelLog.length - 1]];
  }, { behavioral: true });

  page.noteOpen({ name: 'note-open', path: notePath, content: loaded, error: '' });
  check('C2 note-open 后编辑器正文等于 payload.content', function () {
    ok(page.text() === loaded, ['实际正文: ' + JSON.stringify(page.text())], 'note-open 的 content');
    ok(page.logsWith('note.open.loaded').length === 1, page.logs.slice(-4), 'note.open.loaded 日志');
    return [page.logsWith('note.open.loaded')[0]];
  }, { behavioral: true });

  await sleep(600);
  check('C3 装载本身不产生写回(装载触发的 docChanged 等于基线)', function () {
    ok(page.writes.length === 0, ['写回调用: ' + JSON.stringify(page.writes)], '0 次 workspace.note.write');
    return ['writes=' + page.writes.length];
  }, { behavioral: true });

  page.type(edited);
  await sleep(600);
  check('C4 编辑后 debounce 产生一次写回,path/content 与编辑器一致', function () {
    ok(page.writes.length === 1, ['写回调用: ' + JSON.stringify(page.writes)], '1 次写回');
    ok(page.writes[0].path === notePath, [JSON.stringify(page.writes[0])], 'path = ' + notePath);
    ok(page.writes[0].content === edited, [JSON.stringify(page.writes[0].content.slice(0, 40))], 'content = 编辑器正文');
    return ['call=workspace.note.write payload=' + JSON.stringify({ path: page.writes[0].path, chars: page.writes[0].content.length })];
  }, { behavioral: true });

  page.noteOpen({ name: 'note-open', path: '', content: '不该出现', error: '' });
  await sleep(600);
  check('C5 path 为空不动正文、不新增写回,并留下 note.open.skip', function () {
    ok(page.text() === edited, ['实际正文: ' + JSON.stringify(page.text())], '正文保持 ' + JSON.stringify(edited));
    ok(page.writes.length === 1, ['写回调用: ' + JSON.stringify(page.writes)], '写回次数不变');
    ok(page.logsWith('note.open.skip').length >= 1, page.logs.slice(-4), 'note.open.skip 日志');
    return [page.logsWith('note.open.skip')[0], 'writes=' + page.writes.length];
  }, { behavioral: true });

  let threw = false;
  try {
    page.noteOpen({ name: 'note-open', path: notePath, content: '', error: 'not_found' });
  } catch (err) {
    threw = true;
  }
  await sleep(600);
  check('C6 文件不存在(error=not_found):不崩、不动正文、不写回,留下 note.open.failed', function () {
    ok(!threw, ['派发 note-open 时抛异常'], '不抛异常');
    ok(page.text() === edited, ['实际正文: ' + JSON.stringify(page.text())], '正文不变');
    ok(page.writes.length === 1, ['写回调用: ' + JSON.stringify(page.writes)], '写回次数不变');
    const failed = page.logsWith('note.open.failed');
    ok(failed.length === 1 && failed[0].indexOf('not_found') >= 0, page.logs.slice(-4), 'note.open.failed 带 error');
    return [failed[0]];
  }, { behavioral: true });

  // 同一 path 重复装载 + 本地有改动:保留本地
  const conflict = await newPage(noteSrc, wiringSrc);
  conflict.noteOpen({ name: 'note-open', path: notePath, content: loaded, error: '' });
  conflict.type(edited);
  conflict.noteOpen({ name: 'note-open', path: notePath, content: '# 宿主另一份\n\n内容二', error: '' });
  await sleep(600);
  check('C7 同一 path 重复装载且本地有未保存编辑:保留本地、报 conflict、把本地正文写回', function () {
    ok(conflict.text() === edited, ['实际正文: ' + JSON.stringify(conflict.text())], '保留本地正文');
    ok(conflict.logsWith('note.open.conflict').length === 1, conflict.logs.slice(-5), 'note.open.conflict 日志');
    ok(conflict.writes.length >= 1 && conflict.writes[conflict.writes.length - 1].content === edited,
      ['写回调用: ' + JSON.stringify(conflict.writes)], '写回本地正文');
    return [conflict.logsWith('note.open.conflict')[0], 'writes=' + conflict.writes.length];
  }, { behavioral: true });

  // 换 path:先把旧 path 的未保存正文写回,再装载新正文
  const switching = await newPage(noteSrc, wiringSrc);
  switching.noteOpen({ name: 'note-open', path: notePath, content: loaded, error: '' });
  switching.type(edited);
  const otherPath = 'notes/别的笔记.md';
  const otherText = '# 别的\n\n正文二';
  switching.noteOpen({ name: 'note-open', path: otherPath, content: otherText, error: '' });
  await sleep(600);
  check('C8 换 path 且旧正文未保存:先写回旧 path 的正文,再装载新 path 的正文', function () {
    ok(switching.writes.length === 1, ['写回调用: ' + JSON.stringify(switching.writes)], '1 次写回(旧 path)');
    ok(switching.writes[0].path === notePath && switching.writes[0].content === edited,
      [JSON.stringify({ path: switching.writes[0].path, content: switching.writes[0].content })], '旧 path + 旧正文');
    ok(switching.text() === otherText, ['实际正文: ' + JSON.stringify(switching.text())], '新 path 的正文');
    return ['writes=' + JSON.stringify(switching.writes.map(function (w) { return w.path; })), 'text=' + JSON.stringify(switching.text())];
  }, { behavioral: true });

  check('C9 通道段不碰阅读渲染(不调 LexiReading.render,不写 reading.* 日志)', function () {
    const calls = codeLines(noteSrc, /LexiReading\.render\s*\(/);
    ok(calls.length === 0, [noteSrc.rel + ': 全文'], '0 次 LexiReading.render(');
    const readingLog = codeLines(noteSrc, /reading\.(sourcePath|refresh)/);
    ok(readingLog.length === 0, [noteSrc.rel + ': 全文'], '不伪造 reading.* 日志');
    return ['reading-wiring.cjs 的「全产物只有一处 LexiReading.render(」仍成立'];
  });

  // ---- 输出 ----
  let failed = 0;
  const lines = [];
  for (const item of results) {
    const tag = item.ok ? 'PASS' : 'FAIL';
    if (!item.ok) { failed += 1; }
    lines.push('[' + tag + '] ' + item.name);
    item.evidence.forEach(function (line) { lines.push('       ' + line); });
    if (!item.ok && item.expected) { lines.push('       期望: ' + item.expected); }
  }
  process.stdout.write(lines.join('\n') + '\n');
  process.stdout.write('\n断言 ' + results.length + ' 条,行为 ' + behavioral + ' 条,' +
    (failed === 0 ? '全部通过' : '失败 ' + failed + ' 条') + ',exit=' + (failed === 0 ? 0 : 1) + '\n');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(function (err) {
  process.stderr.write('[workspace-note-open] 未捕获失败: ' + ((err && err.stack) || err) + '\n');
  process.exit(1);
});
