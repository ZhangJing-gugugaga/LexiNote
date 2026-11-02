/*
 * 笔记正文装载/写回通道。
 *
 * 宿主→页面:note-open 事件复用 v1 事件帧 {v,type:'event',topic:'workspace',payload},
 *   payload = { name:'note-open', path, content, error }。error 非空表示宿主侧装载失败(如文件不存在)。
 * 页面→宿主:workspace.note.write 方法复用 hostCall 请求-应答,payload = { path, content }。
 *
 * 写回时机:编辑器正文变化后 debounce 一次写回;装载自身触发的 docChanged 因为正文等于基线不会写回。
 * 边界:path 为空不动正文;宿主装载失败不动正文;同一 path 重复装载且本地有改动时保留本地;
 *   切到别的 path 之前先把旧 path 的未保存正文写回,避免丢编辑。
 */
(function () {
  'use strict';

  if (window.__lexiNoteOpenChannel === true) { return; }
  window.__lexiNoteOpenChannel = true;

  var NOTE_TOPIC = 'workspace';
  var NOTE_OPEN = 'note-open';
  var NOTE_WRITE = 'workspace.note.write';
  var WRITE_DEBOUNCE_MS = 400;
  var WIRE_RETRY_MS = 50;
  var WIRE_RETRY_MAX = 40;

  var workingPath = '';
  var baseline = '';
  var writeTimer = null;
  var writing = false;
  var hookedDispatch = false;
  var hookedEdits = false;
  var pendingOpen = null;
  var wireCount = 0;

  function message(err) {
    if (!err) { return 'unknown'; }
    return typeof err.message === 'string' ? err.message : String(err);
  }

  function log(topic, detail) {
    var line = '{}';
    try { line = JSON.stringify(detail); } catch (err) { line = '{}'; }
    try { console.log('[workspace-note] ' + topic + ' ' + line); } catch (err) { /* 无控制台时只走宿主日志 */ }
    var shim = window.LexiPluginShim;
    if (!shim || typeof shim.call !== 'function') { return; }
    try {
      var pending = shim.call('log.event', { topic: topic, detail: line });
      if (pending && typeof pending.then === 'function') { pending.then(function () {}, function () {}); }
    } catch (err) { /* 日志失败不影响通道 */ }
  }

  function field(payload, key) {
    if (!payload || typeof payload !== 'object') { return ''; }
    var value = payload[key];
    return typeof value === 'string' ? value : '';
  }

  function editorBridge() {
    return window.__lexiEditor || null;
  }

  function currentText() {
    var bridge = editorBridge();
    if (!bridge || typeof bridge.getValue !== 'function') { return ''; }
    var text = bridge.getValue();
    return typeof text === 'string' ? text : '';
  }

  function sendWrite(targetPath, text, reason) {
    var shim = window.LexiPluginShim;
    if (!shim || typeof shim.call !== 'function') {
      log('note.write.skip', { reason: 'shim_missing' });
      return false;
    }
    writing = true;
    var payload = { path: targetPath, content: text };
    var pending;
    try {
      pending = shim.call(NOTE_WRITE, payload);
    } catch (err) {
      writing = false;
      log('note.write.failed', { path: targetPath, error: message(err) });
      return false;
    }
    if (!pending || typeof pending.then !== 'function') { writing = false; return false; }
    pending.then(function () {
      writing = false;
      if (targetPath === workingPath && currentText() === text) {
        baseline = text;
        log('note.write.saved', { path: targetPath, chars: text.length, reason: reason });
        return;
      }
      scheduleWrite();
    }, function (err) {
      writing = false;
      log('note.write.failed', { path: targetPath, error: message(err) });
    });
    return true;
  }

  function flushWrite(reason) {
    if (writeTimer !== null) { window.clearTimeout(writeTimer); writeTimer = null; }
    if (workingPath.length === 0) { return false; }
    if (writing) { return false; }
    var text = currentText();
    if (text === baseline) { return false; }
    return sendWrite(workingPath, text, reason);
  }

  function scheduleWrite() {
    if (writeTimer !== null) { window.clearTimeout(writeTimer); }
    writeTimer = window.setTimeout(function () {
      writeTimer = null;
      flushWrite('edit');
    }, WRITE_DEBOUNCE_MS);
  }

  function applyNoteOpen(payload) {
    var targetPath = field(payload, 'path');
    if (targetPath.length === 0) {
      log('note.open.skip', { reason: 'empty_path' });
      return;
    }
    var error = field(payload, 'error');
    if (error.length > 0) {
      log('note.open.failed', { path: targetPath, error: error });
      return;
    }
    var bridge = editorBridge();
    if (!bridge || typeof bridge.setValue !== 'function') {
      pendingOpen = payload;
      log('note.open.pending', { path: targetPath, reason: 'editor_not_ready' });
      return;
    }
    if (targetPath === workingPath && currentText() !== baseline) {
      log('note.open.conflict', { path: targetPath, kept: 'local' });
      scheduleWrite();
      return;
    }
    if (targetPath !== workingPath && workingPath.length > 0) {
      flushWrite('switch');
    }
    workingPath = targetPath;
    bridge.setValue(field(payload, 'content'));
    baseline = currentText();
    log('note.open.loaded', { path: targetPath, chars: baseline.length });
  }

  function inspectEvent(event) {
    if (!event || event.topic !== NOTE_TOPIC) { return; }
    if (event.name === 'file-open') {
      log('note.open.source', { path: field(event.payload && event.payload.file, 'path') });
      return;
    }
    if (event.name === NOTE_OPEN) { applyNoteOpen(event.payload); }
  }

  function hookDispatch() {
    if (hookedDispatch) { return true; }
    var api = window.LexiObsidian;
    if (!api || typeof api.dispatchEvent !== 'function') { return false; }
    var original = api.dispatchEvent;
    api.dispatchEvent = function (event) {
      var result = original.apply(this, arguments);
      try { inspectEvent(event); } catch (err) { log('note.open.error', { error: message(err) }); }
      return result;
    };
    hookedDispatch = true;
    return true;
  }

  /** 监听编辑:用 bundle 自己那份 @codemirror 挂 updateListener,与阅读接线同一种做法。 */
  function watchEdits() {
    if (hookedEdits) { return true; }
    var bridge = editorBridge();
    var modules = window.LexiCmModules || window.__lexiCmModules;
    if (!bridge || !modules || typeof bridge.cm !== 'function') { return false; }
    var view = bridge.cm();
    var cmState = modules['@codemirror/state'];
    var cmView = modules['@codemirror/view'];
    if (!view || !cmState || !cmView) { return false; }
    view.dispatch({
      effects: cmState.StateEffect.appendConfig.of(cmView.EditorView.updateListener.of(function (update) {
        if (update.docChanged) { scheduleWrite(); }
      }))
    });
    hookedEdits = true;
    return true;
  }

  function wire() {
    var hooked = hookDispatch() && watchEdits();
    if (pendingOpen !== null) {
      var waiting = pendingOpen;
      pendingOpen = null;
      applyNoteOpen(waiting);
    }
    if (hooked) { return; }
    wireCount += 1;
    if (wireCount > WIRE_RETRY_MAX) {
      log('note.channel.timeout', { dispatch: hookedDispatch, edits: hookedEdits });
      return;
    }
    window.setTimeout(wire, WIRE_RETRY_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
