'use strict';
// RFC §14 T0.2 Sandbox PoC 宿主侧引导逻辑。
//
// 真机事实修正（Round 8/9, B-008）：本页逻辑此前内联在 lexinote_sandbox_poc.html，
// 而宿主页 CSP 为 `script-src 'self'`（按 RFC §3.2 宿主面禁 eval/禁宽松内联）——
// 标准 CSP 下内联脚本一律被拦杀，导致 ArkWeb API 26 真机上 PoC 完全静默
// （页面能加载、脚本不执行、iframe 从未创建、探针零输出）。
// 修复：引导逻辑外置为本文件（'self' 允许），iframe 文档加载由 CSP 的
// child-src/frame-src 'self' 放行。逻辑本身与内联时期逐行等值。
//
// 设计约束不变：
//   - 每插件上下文独立 sandbox="allow-scripts" iframe（无 allow-same-origin → opaque origin）；
//   - 每上下文专属 MessageChannel，port2 转移进 iframe；身份绑定只存宿主侧端口表；
//   - 恶意探针（lexinote_sandbox_probe.js 提供源码）在上下文内穷举逃逸路径。
(function () {
  var PROTOCOL_VERSION = 1;
  var pendingContexts = new Map();   // contextId → { iframe, port, pluginId, activationId, bound }
  var reports = [];

  function log(line) {
    // hilog 出口：LexiSandboxHost 转发带 [lexinote][sandbox] 前缀的 console 行。
    try { console.log('[lexinote][sandbox] ' + line); } catch (err) { /* console 缺失不影响 PoC */ }
  }

  function summarize() {
    var passCount = 0;
    for (var i = 0; i < reports.length; i++) { if (reports[i].passed) { passCount++; } }
    var lines = [];
    for (var j = 0; j < reports.length; j++) {
      var report = reports[j];
      lines.push(report.contextId + ': passed=' + report.passed +
        ' vectors=' + report.total + '/' + report.blockedCount + ' blocked' +
        ' credentialHits=' + report.credentialHits);
      for (var k = 0; k < report.vectors.length; k++) {
        var vector = report.vectors[k];
        lines.push('  ' + (vector.blocked ? 'BLOCKED' : 'LEAKED!!') + ' ' + vector.id +
          ' — ' + String(vector.detail).slice(0, 120));
      }
    }
    var allPass = reports.length >= 2 && passCount === reports.length;
    log('PoC verdict: ' + (allPass ? 'PASS' : 'FAIL') + ' contexts=' + reports.length + '/' + passCount + ' passed');
    for (var m = 0; m < lines.length; m++) { log(lines[m]); }
    var summary = document.getElementById('lexi-sandbox-poc-summary');
    if (summary) {
      summary.textContent = 'sandbox PoC ' + (allPass ? 'PASS' : 'FAIL') +
        ' (' + passCount + '/' + reports.length + ' contexts clean)';
    }
    return allPass;
  }

  // 每个插件上下文：独立 iframe + 独立 MessageChannel。身份(宿主侧)只进端口表。
  function createSandboxContext(contextId, pluginId) {
    var iframe = document.createElement('iframe');
    // RFC §3.2:只授脚本执行权。无 allow-same-origin → opaque origin;
    // 无 allow-top-navigation → 顶层导航被浏览器策略拒绝。
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('src', 'lexinote_plugin_sandbox.html');
    iframe.style.width = '0px';
    iframe.style.height = '0px';
    iframe.style.border = '0';
    var context = {
      iframe: iframe,
      port: null,
      // 身份绑定在宿主侧,只存这里,不进任何 iframe 消息。
      pluginId: pluginId,
      activationId: 'act-' + contextId,
      bound: false
    };
    pendingContexts.set(contextId, context);
    iframe.addEventListener('load', function () {
      wireChannel(contextId, context);
    });
    document.body.appendChild(iframe);
    return context;
  }

  function wireChannel(contextId, context) {
    var channel = new MessageChannel();
    var port = channel.port1;
    context.port = port;
    // 单通道注册:MessagePort 转移后 onmessage 即激活(poc5 双注册见证过双重投递)。
    port.onmessage = function (event) {
      onSandboxMessage(contextId, context, event.data || {});
    };
    var win = context.iframe.contentWindow;
    if (!win) { log('context ' + contextId + ' contentWindow missing'); return; }
    // init 载荷只有协议标记 + contextId;身份凭据绝不进 iframe(门禁 S8 钉死)。
    win.postMessage({ __lexiSandbox: true, type: 'sandbox.init', contextId: contextId }, '*', [channel.port2]);
    // P1-001a 真机验收保留项：ping/pong 是"端口双向通路"的最小见证，每次冷启仅两行日志，
    // 让 CI/巡检能从 hilog 直接区分"载体失效"与"协议失效"（2026-11-03 定位战教训）。
    try { port.postMessage({ __lexiSandbox: true, type: 'sandbox.ping' }); }
    catch (err) { log('port ping threw: ' + String((err && err.message) || err)); }
    context.bound = true;
    log('context bound: ' + contextId + ' (identity kept host-side: ' + context.pluginId + ')');
  }

  function onSandboxMessage(contextId, context, data) {
    if (data.__lexiSandbox !== true) { return; }
    if (data.type === 'sandbox.boot') {
      var selfCheck = data.selfCheck || {};
      var leaks = (selfCheck.checks || []).filter(function (c) { return !c.isolated; });
      log('context ' + contextId + ' boot: checks=' + (selfCheck.checks || []).length +
        ' leaks=' + leaks.length);
      // 装载逃逸探针:探针源码在本页 script-src 'self' 加载,经端口送入沙箱求值。
      if (context.port && typeof window.LEXI_SANDBOX_PROBE_SOURCE === 'string') {
        context.port.postMessage({
          __lexiSandbox: true, type: 'sandbox.run',
          source: window.LEXI_SANDBOX_PROBE_SOURCE, sourceKind: 'escape-probe'
        });
      }
      return;
    }
    if (data.type === 'sandbox.evalError') {
      log('context ' + contextId + ' eval error: ' + data.message);
      return;
    }
    if (data.type === 'sandbox.request') {
      // 沙箱内插件代码的宿主请求:身份 = 宿主端口表里的 pluginId(不信任载荷)。
      // PoC 只实现 log.event 一个方法,证明"端口在、宿主应答、身份不暴露"即可。
      var result = null;
      if (data.method === 'log.event') {
        result = { accepted: true };
        if (data.params && data.params.report) { collectReport(contextId, data.params.report); }
      }
      context.port && context.port.postMessage({
        __lexiSandbox: true, type: 'sandbox.response', requestId: data.requestId,
        ok: result !== null,
        result: result,
        error: result === null ? { code: 'ERR_PERMISSION_DENIED', message: 'PoC 未授权该方法' } : null,
        protocolVersion: PROTOCOL_VERSION
      });
      return;
    }
    if (data.type === 'sandbox.ran' && data.sourceKind === 'escape-probe') {
      // 探针把报告放进自身 window;这里再要一次:让沙箱把报告发回来。
      context.port && context.port.postMessage({
        __lexiSandbox: true, type: 'sandbox.run',
        source: 'window.lexiSandbox.request("log.event", { report: window.__lexiProbeReport || null });',
        sourceKind: 'report-pull'
      });
      return;
    }
  }

  // 探针报告回传:沙箱经 log.event 携带报告,宿主在此收集。收集器留在闭包内,不进全局。
  function collectReport(contextId, report) {
    if (!report || !Array.isArray(report.vectors)) { return; }
    report.contextId = contextId;
    reports.push(report);
    if (reports.length >= 2) { summarize(); }
  }

  function boot() {
    log('PoC boot: probe source=' +
      (typeof window.LEXI_SANDBOX_PROBE_SOURCE === 'string' ? window.LEXI_SANDBOX_PROBE_SOURCE.length + ' bytes' : 'MISSING'));
    // P1-001a 插桩：子上下文第一句话走 window 消息（sandbox.ready），见证跨 frame 通道方向性。
    window.addEventListener('message', function (event) {
      var d = event.data || {};
      if (d.__lexiSandbox === true) {
        log('host window message: type=' + String(d.type) + ' origin=' + String(event.origin));
      }
    });
    createSandboxContext('sandbox-a', 'sandbox-escape-probe');
    createSandboxContext('sandbox-b', 'sandbox-escape-probe');
    setTimeout(function () {
      if (reports.length < 2) {
        log('PoC timeout: reports=' + reports.length + ' (sandbox iframe 未回传报告)');
        summarize();
      }
    }, 8000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
