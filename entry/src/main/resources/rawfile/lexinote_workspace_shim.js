/*
 * LexiNote workspace plugin facade — web side of bridge protocol v1.
 *
 * Loaded before the built runtime bundle (lexinote_workspace.js). The bundle owns the
 * ArkWeb WebMessagePort channel and hands this module a single transport function, so
 * no business call ever goes through javaScriptProxy.
 *
 * Single-instance container (spec section 3): a plugin factory is evaluated exactly once
 * per <id>@<version>; views and code blocks only ever receive render(el, ctx) and never
 * re-evaluate plugin source.
 */
(function () {
  'use strict';

  var PROTOCOL_VERSION = 1;
  var CALL_TIMEOUT_MS = 20000;
  var MAX_BATCH = 64;

  var transport = null;
  var callSeq = 0;
  var sessionToken = '';      // channel.auth 之后由容器写入:未显式带 token 的容器调用继承页面身份
  var pending = new Map();       // frame id -> { resolve, reject, timer }
  var instances = new Map();     // "<id>@<version>" -> instance record
  var commandTable = new Map();  // "<pluginId>::<commandId>" -> command record
  var viewRenderers = new Map(); // "<pluginId>::<viewType>" -> render(el, ctx)
  var ui = {
    notice: function () {},
    getValue: function () { return ''; },
    insertText: function () {},
    log: function () {}
  };

  function attach(postFn) { transport = postFn; }

  function setup(hooks) {
    for (var key in hooks) {
      if (Object.prototype.hasOwnProperty.call(hooks, key) && hooks[key]) { ui[key] = hooks[key]; }
    }
  }

  // Container-level telemetry: a normal request frame whose reply we deliberately ignore.
  function containerLog(topic, detail) {
    if (!transport) { return; }
    try {
      transport(JSON.stringify({
        v: PROTOCOL_VERSION,
        id: nextId(),
        token: '',
        method: 'log.event',
        payload: { topic: topic, detail: detail || {} }
      }));
    } catch (e) { /* channel gone */ }
  }

  function nextId() { callSeq += 1; return 'q' + callSeq; }

  function send(method, payload, token) {
    if (!transport) { return Promise.reject(new Error('插件桥通道尚未就绪')); }
    var id = nextId();
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        pending.delete(id);
        var err = new Error('插件桥调用超时 20s: ' + method);
        err.code = 'timeout';
        reject(err);
      }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      try {
        transport(JSON.stringify({
          v: PROTOCOL_VERSION,
          id: id,
          token: token || sessionToken,
          method: method,
          payload: payload === undefined ? {} : payload
        }));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // Batch frame per spec: one frame carries up to 64 calls, host replies per id in order.
  function sendBatch(calls, token) {
    if (!transport) { return Promise.reject(new Error('插件桥通道尚未就绪')); }
    if (!calls || calls.length === 0) { return Promise.resolve([]); }
    if (calls.length > MAX_BATCH) { return Promise.reject(new Error('单批上限 ' + MAX_BATCH)); }
    var entries = calls.map(function (call) {
      var id = nextId();
      var entry = { id: id, method: call.method, payload: call.payload === undefined ? {} : call.payload };
      return entry;
    });
    var payloads = entries.map(function (entry) {
      return new Promise(function (resolve, reject) {
        var id = entry.id;
        var timer = setTimeout(function () {
          pending.delete(id);
          var err = new Error('插件桥调用超时 20s: ' + entry.method);
          err.code = 'timeout';
          reject(err);
        }, CALL_TIMEOUT_MS);
        pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      });
    });
    try {
      transport(JSON.stringify({
        v: PROTOCOL_VERSION,
        token: token || sessionToken,
        calls: entries.map(function (entry) { return { id: entry.id, method: entry.method, payload: entry.payload }; })
      }));
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.all(payloads);
  }

  function settleEntry(id, frame) {
    var entry = pending.get(id);
    if (!entry) { return; }
    pending.delete(id);
    clearTimeout(entry.timer);
    if (frame.ok) { entry.resolve(frame.data); return; }
    var info = frame.error || {};
    var err = new Error(info.message || '插件桥调用失败');
    err.code = info.code || 'error';
    entry.reject(err);
  }

  /**
   * R2 裁定:会话身份必须真的落到 JS,不能只落在宿主 tokens 表里。
   * channel.auth 的成功响应带回 sessionToken,容器此前没接——插件 shim 与所有会话作用域调用
   * (fsGate/metadata)就会以空身份发出,被 fail-closed 掉。只认 channel.auth 的形状,别把别的回包当令牌。
   */
  function adoptSessionToken(token) {
    if (typeof token !== 'string' || token.length === 0 || token === sessionToken) { return; }
    sessionToken = token;
    try {
      if (window.LexiObsidian && typeof window.LexiObsidian.setSessionToken === 'function') {
        window.LexiObsidian.setSessionToken(sessionToken);
      }
    } catch (err) { /* 观测点失败不影响主链路 */ }
  }

  function handleFrame(raw) {
    var frame = null;
    try { frame = JSON.parse(raw); } catch (err) { return; }
    if (!frame || frame.v !== PROTOCOL_VERSION) { return; }
    if (frame.ok && frame.data && frame.data.authed === true && typeof frame.data.channelId === 'string') {
      adoptSessionToken(frame.data.token);
    }
    if (frame.type === 'event') {
      // 事件帧是宿主→页面的单向下推:交给页面(obsidian 兼容层)分发,容器只兜底记日志。
      if (typeof ui.event === 'function') { ui.event(frame); } else { ui.log('channel.event', { topic: frame.topic }); }
      return;
    }
    if (frame.id !== undefined && frame.id !== null) { settleEntry(frame.id, frame); return; }
    if (Array.isArray(frame.calls)) {
      for (var i = 0; i < frame.calls.length; i++) { settleEntry(frame.calls[i].id, frame.calls[i]); }
    }
  }

  function pluginApi(token, owner) {
    var api = {
      // Informational only — the host resolves the plugin from the token and ignores this.
      pluginId: owner.id,
      host: {
        call: function (method, payload) { return send(method, payload, token); }
      },
      log: function (topic, detail) {
        containerLog(topic, detail);
        return send('log.event', { topic: topic, detail: detail || {} }, token);
      },
      editor: {
        getValue: function () { return ui.getValue(); },
        insertText: function (text) { ui.insertText(String(text)); }
      },
      workspace: {
        notice: function (message) { ui.notice(String(message)); }
      },
      commands: {
        addCommand: function (command) {
          if (!command || !command.id) { return; }
          commandTable.set(owner.id + '::' + command.id, {
            pluginId: owner.id,
            id: command.id,
            name: command.name || command.id,
            callback: command.callback
          });
        }
      },
      views: {
        register: function (type, renderer) { viewRenderers.set(owner.id + '::' + type, renderer); }
      }
    };
    return api;
  }

  function loadPlugin(descriptor) {
    var key = descriptor.id + '@' + descriptor.version;
    var existing = instances.get(key);
    if (existing) {
      existing.reuseCount += 1;
      containerLog('plugin.instance.reuse', {
        key: key, instanceCount: instances.size, reuseCount: existing.reuseCount
      });
      return existing.broken
        ? Promise.reject(new Error(existing.broken))
        : Promise.resolve({ key: key, pluginId: descriptor.id, reused: true });
    }
    var record = {
      key: key,
      descriptor: descriptor,
      created: 0,
      broken: '',
      reuseCount: 0,
      viewCount: 0,
      plugin: null
    };
    instances.set(key, record);
    var api = pluginApi(descriptor.token, descriptor);
    var moduleObject = { exports: {} };
    try {
      var runner = new Function(
        'module', 'exports', 'require',
        descriptor.code + '\n//# sourceURL=lexi-plugin-' + descriptor.id + '.js'
      );
      runner(moduleObject, moduleObject.exports, function (name) {
        throw new Error('插件源码中不允许 require: ' + name);
      });
      var exported = moduleObject.exports;
      record.plugin = (typeof exported === 'function') ? exported(api) : exported;
      record.created += 1;
      containerLog('plugin.instance.create', {
        key: key, instanceCount: instances.size, createCalls: record.created
      });
    } catch (err) {
      record.broken = '插件装载失败: ' + (err && err.message ? err.message : String(err));
      containerLog('plugin.instance.broken', { key: key, message: record.broken });
      return Promise.reject(new Error(record.broken));
    }
    var plugin = record.plugin;
    var loaded = (plugin && typeof plugin.onload === 'function') ? plugin.onload.call(plugin) : null;
    return Promise.resolve(loaded).then(function () {
      containerLog('plugin.instance.ready', { key: key, instanceCount: instances.size });
      return { key: key, pluginId: descriptor.id, reused: false };
    }, function (err) {
      record.broken = '插件 onload 失败: ' + (err && err.message ? err.message : String(err));
      containerLog('plugin.instance.broken', { key: key, message: record.broken });
      throw new Error(record.broken);
    });
  }

  function findRecord(pluginId) {
    var found = null;
    instances.forEach(function (record) {
      if (!found && record.descriptor.id === pluginId) { found = record; }
    });
    return found;
  }

  // Views render into a host-provided element with a per-view context object.
  function mountView(pluginId, viewType, element, viewId) {
    var renderer = viewRenderers.get(pluginId + '::' + viewType);
    if (!renderer) { return Promise.reject(new Error('未注册的视图类型: ' + viewType)); }
    var record = findRecord(pluginId);
    if (record) { record.viewCount += 1; }
    var ctx = {
      viewId: viewId,
      pluginId: pluginId,
      instanceKey: record ? record.key : '',
      instanceCreated: record ? record.created : 0
    };
    element.textContent = '';
    try {
      renderer(element, ctx);
    } catch (err) {
      element.textContent = '视图渲染失败: ' + (err && err.message ? err.message : String(err));
    }
    containerLog('plugin.view.render', {
      viewId: viewId,
      viewType: viewType,
      instanceCount: instances.size,
      instanceKey: ctx.instanceKey,
      createCalls: ctx.instanceCreated,
      viewCount: record ? record.viewCount : 0
    });
    return Promise.resolve(ctx);
  }

  function commands() {
    var list = [];
    commandTable.forEach(function (command) {
      list.push({ id: command.pluginId + '::' + command.id, name: command.name, pluginId: command.pluginId });
    });
    return list;
  }

  function runCommand(fullId) {
    var command = commandTable.get(fullId);
    if (!command) { return Promise.reject(new Error('未知命令: ' + fullId)); }
    var record = findRecord(command.pluginId);
    containerLog('command.invoke', {
      command: fullId, name: command.name,
      instanceCount: instances.size,
      createCalls: record ? record.created : 0
    });
    return Promise.resolve()
      .then(function () { return command.callback ? command.callback() : null; })
      .then(function () {
        containerLog('command.done', { command: fullId });
      });
  }

  function stats() {
    var detail = [];
    instances.forEach(function (record) {
      detail.push({
        key: record.key,
        createCalls: record.created,
        reuseCount: record.reuseCount,
        viewCount: record.viewCount,
        broken: record.broken
      });
    });
    return { instanceCount: instances.size, commands: commandTable.size, views: viewRenderers.size, instances: detail };
  }

  window.LexiPluginShim = {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    attach: attach,
    setup: setup,
    handleFrame: handleFrame,
    call: function (method, payload, token) { return send(method, payload, token); },
    setSessionToken: function (token) {
      sessionToken = typeof token === 'string' ? token : '';
      try {
        if (window.LexiObsidian && typeof window.LexiObsidian.setSessionToken === 'function') {
          window.LexiObsidian.setSessionToken(sessionToken);
        }
      } catch (err) { /* 同上 */ }
    },
    callBatch: sendBatch,
    loadPlugin: loadPlugin,
    mountView: mountView,
    commands: commands,
    runCommand: runCommand,
    stats: stats
  };
})();
