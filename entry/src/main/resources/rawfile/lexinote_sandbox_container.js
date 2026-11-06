'use strict';
// P1-003b 方案 B(ADR-R21-02)·沙箱容器页脚本(独立 Web 组件形态,Round 22)。
//
// 与 Round 21 runtime 页版本的关键差异:与 ArkTS 的通信不再经 MessagePort/页面 window
// 跨帧通道(B-009:两者在 runtime 宿主页静默丢帧),改用本组件两条久经验证机制:
//   - 请求帧:iframe → 本页(window 通道,页内已验证) → javaScriptProxy 'sandboxHost'.call
//     (同步进 ArkTS 网关 = LexiContextRegistry.adjudicate → broker → handler);
//   - 响应帧:ArkTS 网关 → runJavaScript 'window.sandboxHostInbox(frame)' → 本页路由回 iframe。
// 身份语义不变:contextId 由宿主网关分配并经 init 载荷告知本页;iframe 请求帧由本页按
// event.source 反查绑定并覆写 contextId——插件侧永远无法自报身份。
(function () {
  var pendingContexts = new Map();   // contextId → { iframe, win, pluginId }
  var proxyReady = false;

  function log(line) {
    try { console.log('[lexinote][sandbox-host] ' + line); } catch (err) { /* console 缺失不影响 */ }
  }

  // ---- ArkTS → 页:响应帧回推(runJavaScript 直调 sandboxHostInbox) ----------------
  window.sandboxHostInbox = function (wrappedJson) {
    let wrapped = null;
    try { wrapped = JSON.parse(String(wrappedJson || '{}')); } catch (err) { log('inbox 帧解析失败'); return; }
    if (!wrapped || typeof wrapped.contextId !== 'string') { log('inbox 帧缺 contextId'); return; }
    const context = pendingContexts.get(wrapped.contextId);
    if (!context) { log('inbox 响应找不到上下文: ' + wrapped.contextId); return; }
    const frame = wrapped.frame || {};
    log('<-arkts ' + wrapped.contextId + ' id=' + String(frame.id || '') + ' ok=' + String(frame.ok));
    const reply = {
      __lexiSandbox: true, type: 'sandbox.response',
      requestId: String(frame.id || ''),
      ok: frame.ok === true,
      result: frame.ok === true ? (frame.data === undefined ? null : frame.data) : null,
      error: frame.ok === true ? null : (frame.error || { code: 'unknown', message: 'gateway error' })
    };
    try { context.win.postMessage(reply, '*'); } catch (err) { log('响应回 iframe 失败: ' + String(err)); }
  };

  // ---- iframe → 本页:请求帧(window 通道;event.source 反查绑定) --------------------
  window.addEventListener('message', function (event) {
    const data = event.data || {};
    if (data.__lexiSandbox !== true || data.type !== 'sandbox.request') { return; }
    let matched = '';
    pendingContexts.forEach((context, cid) => {
      if (!matched && context.win === event.source) { matched = cid; }
    });
    if (!matched) { log('请求帧无归属上下文(丢弃)'); return; }
    log('->arkts ' + matched + ' ' + String(data.method || '?'));
    dispatchToHost(matched, {
      v: 1, type: 'request',
      id: String(data.requestId || ''),
      method: String(data.method || ''),
      payload: (data.params === undefined ? {} : data.params)
    });
  });

  /** 经 javaScriptProxy 同步递交网关(响应异步回 inbox)。 */
  function dispatchToHost(contextId, frame) {
    if (!proxyReady) {
      log('proxy 未就绪,丢弃 ' + String(frame.method || '?'));
      return;
    }
    try {
      // frame 必须以字符串形态过 proxy——ArkTS 网关约定 adjudicate(contextId, frameJson 字符串)。
      const wrapped = JSON.stringify({ contextId: contextId, frame: JSON.stringify(frame) });
      window.sandboxHost.call(wrapped);
    } catch (err) {
      log('proxy 调用失败: ' + String(err));
    }
  }

  // ---- per-plugin iframe 装载(宿主 runJavaScript 调 lexiContainerBoot) -------------
  window.lexiContainerBoot = function (boot) {
    if (!boot || typeof boot.contextId !== 'string' || typeof boot.code !== 'string') {
      log('boot 载荷不完整');
      return;
    }
    const contextId = boot.contextId;
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');           // 无 allow-same-origin → opaque origin
    iframe.setAttribute('src', 'lexinote_plugin_sandbox.html');
    iframe.style.width = '0px';
    iframe.style.height = '0px';
    iframe.style.border = '0';
    pendingContexts.set(contextId, { iframe: iframe, win: iframe.contentWindow, pluginId: String(boot.pluginId || '') });
    iframe.addEventListener('load', function () {
      wireChannel(contextId, boot);
    });
    document.body.appendChild(iframe);
    log('sandbox context created: ' + contextId);
  };

  function wireChannel(contextId, boot) {
    const context = pendingContexts.get(contextId);
    if (!context) { return; }
    // appendChild 前取的 contentWindow 是 null——load 触发后必须重取(Round 22 真机定位)。
    context.win = context.iframe.contentWindow;
    const win = context.win;
    if (!win) { log('contentWindow missing: ' + contextId); return; }
    // 页内 window 通道(PoC Round 9 verdict 已验证的双向形态):init 载荷带协议标记 +
    // contextId + 插件装载物;身份凭据绝不进 iframe。
    try {
      win.postMessage({
        __lexiSandbox: true, type: 'sandbox.init', contextId: contextId,
        plugin: { code: boot.code, manifestJson: boot.manifestJson }
      }, '*');
      log('context wired: ' + contextId);
    } catch (err) {
      log('init 发送失败: ' + String(err));
    }
  }

  // proxy 就绪探测:javaScriptProxy 注入早于页脚本;宿主 onPageEnd 的 ready ping 兜底置位。
  try {
    if (window.sandboxHost && typeof window.sandboxHost.call === 'function') {
      proxyReady = true;
      log('sandboxHost proxy ready');
    }
  } catch (err) { /* 由 ping 兜底 */ }

  // P1-003b:宿主命令执行回推(容器按 pluginId 路由进对应 iframe 的 window 通道)。
  // R27 编辑器切片:编辑器命令帧额外携带 editor 快照(宿主 invokeEditorCommand 已按清单
  // 档位脱敏);只透传 editor 字段,pluginId 等身份字段仍绝不进 iframe(身份语义不变)。
  window.lexiSandboxCommand = function (bodyJson) {
    let body = null;
    try { body = JSON.parse(String(bodyJson || '{}')); } catch (err) { log('命令帧解析失败'); return; }
    const pluginId = String(body.pluginId || '');
    let targetContextId = '';
    let target = null;
    pendingContexts.forEach((context, cid) => {
      if (!target && context.pluginId === pluginId) { target = context; targetContextId = cid; }
    });
    if (!target) { log('命令回推找不到上下文: ' + pluginId); return; }
    const frame = {
      __lexiSandbox: true, type: 'sandbox.command', fullId: String(body.fullId || '')
    };
    if (body.editor && typeof body.editor === 'object') { frame.editor = body.editor; }
    try {
      target.win.postMessage(frame, '*');
      log('命令已回推沙箱: ' + String(body.fullId || ''));
    } catch (err) { log('命令回推失败: ' + String(err)); }
  };
})();
