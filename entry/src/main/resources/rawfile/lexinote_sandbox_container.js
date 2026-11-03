'use strict';
// P1-003b 第一切片(ADR-R18-01/Round 20)·runtime 页沙箱容器。
//
// 职责(本文件是宿主页代码,可信面):
//   1) 接收宿主转移的 lexiContextPort(帧收发到 LexiContextRegistry 网关);
//   2) 为每个 load.plugin 创建 per-plugin iframe(sandbox="allow-scripts", opaque origin,
//      文档 = lexinote_plugin_sandbox.html,复用 PoC 已真机验证的通道引导);
//   3) 帧路由:iframe 的请求帧经本容器【覆写 contextId 后】包装成 {contextId, frame}
//      转发宿主端口——iframe 永远不能自报身份(宿主按 port↔contextId 绑定覆写);
//      宿主响应帧(同包装)按 contextId 路由回对应 iframe 的 port2。
// Round 21 切片定位:本文件只承载"通道+路由+装载";沙箱内 API 面由 lexinote_plugin_sandbox.html
// 的 bootPlugin 提供(逐步扩面直至完整 obsidian namespace,见 EXECUTION_PLAN P1-003b)。
(function () {
  var PROTOCOL_VERSION = 1;
  var pendingContexts = new Map();   // contextId → { iframe, port }
  var contextPort = null;            // 宿主端口(lexiContextPort)
  var seq = 0;

  function log(line) {
    try { console.log('[lexinote][container] ' + line); } catch (err) { /* console 缺失不影响 */ }
  }

  // ---- 宿主端口接收与帧收发 ------------------------------------------------
  window.addEventListener('message', function (event) {
    if (event.data === 'lexi-context-port' && event.ports && event.ports[0]) {
      contextPort = event.ports[0];
      contextPort.onmessage = function (portEvent) {
        routeHostFrame(String(portEvent.data || ''));
      };
      log('context port attached (container)');
    }
  });

  function sendToHost(contextId, frame) {
    log('->host ' + contextId + ' ' + String(frame.method || '?'));
    if (!contextPort) {
      log('宿主端口未就绪,丢弃 ' + String(frame.method || '?'));
      return;
    }
    contextPort.postMessage(JSON.stringify({ contextId: contextId, frame: frame }));
  }

  function routeHostFrame(text) {
    // 宿主响应帧包装:{contextId, frame:{v,type:'response',id,ok,data|error}}。
    let wrapped = null;
    try { wrapped = JSON.parse(text); } catch (err) { return; }
    if (!wrapped || typeof wrapped !== 'object' || typeof wrapped.contextId !== 'string') { return; }
    const context = pendingContexts.get(wrapped.contextId);
    if (!context) { log('响应找不到上下文: ' + wrapped.contextId); return; }
    log('<-host ' + wrapped.contextId + ' id=' + String(wrapped.frame && wrapped.frame.id));
    // 重组为沙箱内 request() 期望的 sandbox.response(window 通道;event.source=parent 校验在子侧)。
    const frame = wrapped.frame || {};
    const reply = {
      __lexiSandbox: true, type: 'sandbox.response',
      requestId: String(frame.id || ''),
      ok: frame.ok === true,
      result: frame.ok === true ? (frame.data === undefined ? null : frame.data) : null,
      error: frame.ok === true ? null : (frame.error || { code: 'unknown', message: 'net error' })
    };
    try { context.win.postMessage(reply, '*'); } catch (err) { log('响应回传失败: ' + String(err)); }
  }

  // ---- per-plugin iframe 上下文 -------------------------------------------
  /** 宿主(host dispatch)通知容器装载插件:contextId 由 RuntimeHost 网关分配。 */
  window.lexiContainerBoot = function (boot) {
    if (!boot || typeof boot.contextId !== 'string' || typeof boot.code !== 'string') {
      log('boot 载荷不完整');
      return;
    }
    seq += 1;
    const contextId = boot.contextId;
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');           // 无 allow-same-origin → opaque origin
    iframe.setAttribute('src', 'lexinote_plugin_sandbox.html');
    iframe.style.width = '0px';
    iframe.style.height = '0px';
    iframe.style.border = '0';
    pendingContexts.set(contextId, { iframe: iframe, win: iframe.contentWindow });
    iframe.addEventListener('load', function () {
      wireChannel(contextId, boot);
    });
    document.body.appendChild(iframe);
    log('sandbox context created: ' + contextId);
  };

  function wireChannel(contextId, boot) {
    const context = pendingContexts.get(contextId);
    if (!context) { return; }
    const channel = new MessageChannel();
    context.port = channel.port1;
    // iframe 的请求帧:统一经容器覆写路由;插件帧里任何 contextId 自报都会被这里的
    // 绑定覆写(身份=宿主网关分配的 contextId,插件不可更改)。
    context.port.onmessage = function (event) {
      let frame = null;
      try { frame = JSON.parse(String(event.data || '{}')); } catch (err) { return; }
      if (!frame || frame.type !== 'request') { return; }
      sendToHost(contextId, frame);
    };
    const win = context.iframe.contentWindow;
    if (!win) { log('contentWindow missing: ' + contextId); return; }
    // init 载荷:协议标记 + contextId + 插件装载物;身份凭据绝不进 iframe。
    win.postMessage({
      __lexiSandbox: true, type: 'sandbox.init', contextId: contextId,
      protocolVersion: PROTOCOL_VERSION,
      plugin: { code: boot.code, manifestJson: boot.manifestJson }
    }, '*', [channel.port2]);
    log('context wired: ' + contextId);
  }
})();
