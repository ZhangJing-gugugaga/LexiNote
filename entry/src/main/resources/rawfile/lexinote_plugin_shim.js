/*
 * LexiNote plugin runtime shim.
 * Mirrors the Obsidian plugin API surface over the ArkWeb bridge (window.lexiHost).
 * P0: Component/Plugin lifecycle, commands, vault, metadataCache, workspace events,
 *     Notice, data.json, requestUrl, moment (compact), normalizePath.
 * P1: Modal/Menu/Setting native appliers, registerView slots, editor bridge.
 */
(function () {
  'use strict';

  var callSeq = 0;
  var pendingCalls = new Map();
  var hostReadyQueue = [];
  var commandTable = new Map(); // fullId -> command descriptor (callbacks stay plugin-side)
  var hostEventTable = new Map(); // refId -> callback (payload already rehydrated)
  var hostEventSeq = 0;
  var plugins = new Map(); // pluginId -> instance
  var fileCache = new Map(); // path -> TFile instance
  var lastEditorState = null; // latest {active, noteId, text, selection} snapshot
  var viewCreators = new Map(); // view type -> creator(leaf) (spawned inside the view slot)
var editorExtensionsByPlugin = new Map(); // pluginId -> Extension[] (real CM6 mount, removable on unload)
  var codeBlockTable = new Map(); // language -> handler (rendered inside code-block slots)
  var ribbonTable = new Map(); // pluginId:title -> click callback

  var API_VERSION = '1.0.0';

  // ---------------------------------------------------------------- identity
  // 宿主签发的令牌:页面会话令牌 + 每插件令牌。令牌只活在闭包里,插件读不到也改不了。
  // 每次 hostCall 都带当前令牌,宿主靠令牌反查 pluginId,payload 里的 pluginId 一律不可信。
  var sessionToken = '';
  var tokenScope = [];
  // RFC P1-006(LEXI-RFC-PLUGIN-001 §3.5):实例归属令牌从"对象属性"迁到闭包 WeakMap。
  // 此前 instance.__lexiToken 挂在插件实例/leaf/EditorProxy 上——同 realm 的插件 A
  // 可经 app.plugins.getPlugin('b').__lexiToken 盗读 B 的凭据再冒用。属性删除后,
  // 令牌只存在闭包映射里,插件代码既读不到也枚举不到。
  var objectIdentityTokens = new WeakMap();
  function setObjectToken(obj, token) {
    if (obj && typeof token === 'string' && token.length > 0) { objectIdentityTokens.set(obj, token); }
  }
  function objectToken(obj) {
    var t = obj ? objectIdentityTokens.get(obj) : undefined;
    return typeof t === 'string' ? t : '';
  }
  var metadataByPath = new Map();
  var metadataPending = new Set();
  var openLeaves = [];
  var activeLeafRef = null;
  var lastActiveFile = null;
  // onLayoutReady 必须真等布局:排队,等宿主回报就绪或第一帧 layout-change 事件再放行。
  // 条目形如 { cb, token }:注册时记下令牌,回调执行时恢复,否则布局就绪回调里的 vault 调用没有身份。
  var layoutReadyCallbacks = [];
  var layoutReadyFlushed = false;

  function flushLayoutReady(source) {
    if (layoutReadyFlushed) { return; }
    layoutReadyFlushed = true;
    var queue = layoutReadyCallbacks;
    layoutReadyCallbacks = [];
    console.log('[lexinote] workspace.onLayoutReady flushed=' + queue.length + ' source=' + source);
    for (var i = 0; i < queue.length; i++) {
      (function (entry) {
        try { withToken(entry.token, entry.cb); } catch (err) { console.warn('[lexinote] onLayoutReady 回调出错', err); }
      })(queue[i]);
    }
  }

  function currentToken() {
    // P1-006:栈空不再回落会话令牌。兜底 sessionToken 曾把"插件裸异步里排的 setTimeout/
    // 未包代理的原始调用"升格成页面会话身份(control-plane 可达,§7.3 违例);现在统一
    // 空串 → hostCall 传匿名 → 宿主 fail-closed。宿主页自身的受控调用一律显式带 sessionToken。
    return tokenScope.length > 0 ? tokenScope[tokenScope.length - 1] : '';
  }

  function withToken(token, fn) {
    tokenScope.push(token || '');
    try { return fn(); } finally { tokenScope.pop(); }
  }

  function tokenForPluginId(pluginId) {
    var instance = plugins.get(pluginId);
    return objectToken(instance);
  }

  // 令牌作用域是一个同步栈:插件在 await / setTimeout / 事件回调之后再次发起宿主调用时,栈早就弹空了。
  // 身份不能跟着"当前栈深度"走,只能跟着"是谁的 API 面"走:插件拿到的 app 及其子对象按插件令牌包一层,
  // 任何一个 API 方法被调用时同步把令牌压栈,hostCall 在同一个同步栈里读令牌 → 身份不再因为异步丢失。
  // 'adapter' 是 vault 上的对象值(不是根),不加进来 vault.adapter.exists/read 会拿到未包令牌的原对象;
  // fsGate 已 fail-closed,漏掉它就等于真实插件的 adapter 通路全部被拒。
  var API_BIND_ROOTS = ['vault', 'adapter', 'metadataCache', 'workspace', 'fileManager', 'commands', 'plugins', 'internalPlugins', 'setting'];
  var boundApiCache = new WeakMap();

  function bindApiToken(token, target, depth) {
    var level = typeof depth === 'number' ? depth : 0;
    if (!token || !target || typeof target !== 'object' || level > 2 || typeof Proxy === 'undefined') { return target; }
    var cache = boundApiCache.get(target);
    if (!cache) { cache = new Map(); boundApiCache.set(target, cache); }
    var hit = cache.get(token);
    if (hit) { return hit; }
    var proxy = new Proxy(target, {
      get: function (obj, prop) {
        var value = obj[prop];
        if (typeof value === 'function') {
          return function () {
            var args = arguments;
            return withToken(token, function () { return value.apply(obj, args); });
          };
        }
        if (value && typeof value === 'object' && level < 2 && API_BIND_ROOTS.indexOf(prop) >= 0) {
          return bindApiToken(token, value, level + 1);
        }
        return value;
      },
      set: function (obj, prop, value) { obj[prop] = value; return true; }
    });
    cache.set(token, proxy);
    return proxy;
  }

  // 定时器回调同样是"插件代码的入口":排程时的令牌要跟着回调一起走,
  // 否则 setTimeout 里发起的 vault/网络调用会退化成无身份(fail-closed,功能静默失效)。
  function installTokenAwareTimers() {
    if (window.__lexiTimerTokenBound) { return; }
    window.__lexiTimerTokenBound = true;
    var rawSetTimeout = window.setTimeout;
    var rawSetInterval = window.setInterval;
    var bindHandler = function (handler) {
      if (typeof handler !== 'function') { return handler; }
      var token = currentToken();
      return function () {
        var args = arguments;
        return withToken(token, function () { return handler.apply(window, args); });
      };
    };
    var wrap = function (raw) {
      return function (handler, delay) {
        var rest = Array.prototype.slice.call(arguments, 2);
        return raw.apply(window, [bindHandler(handler), delay].concat(rest));
      };
    };
    window.setTimeout = wrap(rawSetTimeout);
    window.setInterval = wrap(rawSetInterval);
  }

  // ---------------------------------------------------------------- DOM helpers
  // Obsidian 扩展了 Node/HTMLElement 原型(createEl/createDiv/setText/addClass/empty…),插件直接用。
  function installDomHelpers() {
    if (typeof HTMLElement === 'undefined' || HTMLElement.prototype.__lexiHelpers) { return; }
    var nodeProto = Node.prototype;
    var elementProto = Element.prototype;
    var htmlProto = HTMLElement.prototype;
    nodeProto.createEl = function (tag, options, callback) {
      var el = document.createElement(tag);
      if (typeof options === 'string') { el.className = options; }
      var opts = options && typeof options === 'object' ? options : {};
      if (opts.cls) { el.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : String(opts.cls); }
      if (opts.text !== undefined) { el.textContent = String(opts.text); }
      if (opts.attr) { Object.keys(opts.attr).forEach(function (key) { el.setAttribute(key, String(opts.attr[key])); }); }
      if (opts.title) { el.title = String(opts.title); }
      if (opts.type && 'type' in el) { el.type = String(opts.type); }
      if (opts.value !== undefined && 'value' in el) { el.value = opts.value; }
      if (opts.href) { el.setAttribute('href', String(opts.href)); }
      if (opts.placeholder) { el.setAttribute('placeholder', String(opts.placeholder)); }
      this.appendChild(el);
      if (typeof callback === 'function') { callback(el); }
      return el;
    };
    nodeProto.createDiv = function (options, callback) { return this.createEl('div', options, callback); };
    nodeProto.createSpan = function (options, callback) { return this.createEl('span', options, callback); };
    nodeProto.empty = function () { while (this.firstChild) { this.removeChild(this.firstChild); } };
    elementProto.setText = function (value) { this.textContent = String(value); };
    elementProto.addClass = function () { for (var i = 0; i < arguments.length; i++) { this.classList.add(arguments[i]); } };
    elementProto.removeClass = function () { for (var i = 0; i < arguments.length; i++) { this.classList.remove(arguments[i]); } };
    elementProto.toggleClass = function (cls, value) { this.classList.toggle(cls, value); };
    elementProto.hasClass = function (cls) { return this.classList.contains(cls); };
    elementProto.empty = nodeProto.empty;
    htmlProto.show = function () { this.style.display = ''; };
    htmlProto.hide = function () { this.style.display = 'none'; };
    htmlProto.detach = function () { if (this.parentNode) { this.parentNode.removeChild(this); } };
    htmlProto.__lexiHelpers = true;
  }
  installDomHelpers();
  installTokenAwareTimers();

  function safeParse(text, fallback) {
    try { return JSON.parse(text); } catch (err) { return fallback; }
  }

  function settle(callId, raw) {
    var entry = pendingCalls.get(callId);
    if (!entry) { return; }
    pendingCalls.delete(callId);
    var message = safeParse(raw, null);
    if (!message) { entry.reject(new Error('插件桥返回了无效数据')); return; }
    if (message.ok) { entry.resolve(message.result); } else {
      var failure = new Error(message.error || '插件桥调用失败');
      // 帧协议 v1 的错误码要能到达插件侧(err.code),timeout/batch_overflow 才有意义。
      if (message.code) { failure.code = message.code; }
      entry.reject(failure);
    }
  }

  function flushHostQueue() {
    var queue = hostReadyQueue;
    hostReadyQueue = [];
    for (var i = 0; i < queue.length; i++) { queue[i](); }
  }

  function whenHostReady() {
    if (window.lexiHost) { flushHostQueue(); return; }
    var timer = setInterval(function () {
      if (window.lexiHost) { clearInterval(timer); flushHostQueue(); }
    }, 40);
  }

  function hostCall(method, payload, token) {
    return new Promise(function (resolve, reject) {
      var callId = 'c' + (++callSeq);
      pendingCalls.set(callId, { resolve: resolve, reject: reject });
      var dispatch = function () {
        try {
          var raw = JSON.stringify(payload === undefined || payload === null ? {} : payload);
          var outcome = window.lexiHost.call(callId, method, raw, token === undefined ? currentToken() : token);
          if (outcome && typeof outcome.then === 'function') {
            outcome.then(function (result) { settle(callId, result); }, function (err) {
              pendingCalls.delete(callId);
              reject(err instanceof Error ? err : new Error(String(err)));
            });
          }
        } catch (err) {
          pendingCalls.delete(callId);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      if (window.lexiHost) { dispatch(); } else { hostReadyQueue.push(dispatch); }
    });
  }

  // ---------------------------------------------------------------- events

  var missingPluginIds = new Set();
  var metadataFileMissLogged = new Set();

  function LocalEmitter() {
    this.handlers = new Map();
  }
  LocalEmitter.prototype.on = function (name, callback) {
    var bucket = this.handlers.get(name);
    if (!bucket) { bucket = []; this.handlers.set(name, bucket); }
    bucket.push(callback);
    var self = this;
    return { __local: true, off: function () { self.off(name, callback); } };
  };
  LocalEmitter.prototype.off = function (name, callback) {
    var bucket = this.handlers.get(name);
    if (!bucket) { return; }
    var index = bucket.indexOf(callback);
    if (index >= 0) { bucket.splice(index, 1); }
  };
  LocalEmitter.prototype.trigger = function (name) {
    var bucket = this.handlers.get(name);
    if (!bucket) { return; }
    var args = Array.prototype.slice.call(arguments, 1);
    var snapshot = bucket.slice();
    for (var i = 0; i < snapshot.length; i++) {
      try { snapshot[i].apply(null, args); } catch (err) { console.warn('[lexinote] listener error', name, err && err.message, (err && err.stack ? String(err.stack).split('\n').slice(1, 3).join(' | ') : '')); }
    }
  };

  // Obsidian 的事件回调是位置参数:on('rename', (file, oldPath)),on('changed', (file, data, cache))。
  // 事件帧只有一个 payload,这里按 topic+name 还原成官方回调签名。
  function eventArgs(topic, name, payload) {
    if (topic === 'vault') {
      if (name === 'rename') { return [payload ? payload.file : null, payload ? payload.oldPath : '']; }
      return [payload && payload.file ? payload.file : null];
    }
    if (topic === 'metadata') {
      if (name === 'changed') {
        var file = payload && payload.file ? payload.file : null;
        return [file, payload ? payload.data : null, payload ? payload.cache : null];
      }
      return [];
    }
    if (topic === 'workspace') {
      if (name === 'file-open') { return [payload && payload.file ? payload.file : null]; }
      if (name === 'quick-preview') { return [payload && payload.file ? payload.file : null, payload ? payload.data : '']; }
      return [];
    }
    return [payload];
  }

  function dispatchHostEvent(message) {
    var topic = message.topic;
    var name = message.name;
    var payload = message.payload;
    if (topic === 'vault') {
      var rawFile = payload && payload.file ? payload.file : null;
      payload = rehydrateFileEvent(payload);
      // 同步路径索引跟着 vault 事件走:getAbstractFileByPath 不能在事件之后读到过期结果。
      if (rawFile && rawFile.path) {
        if (name === 'delete') {
          knownFiles.delete(rawFile.path);
        } else if (name === 'rename') {
          if (payload && payload.oldPath) { knownFiles.delete(payload.oldPath); }
          if (payload && payload.file) { knownFiles.set(payload.file.path, payload.file); }
          knownFiles.delete(rawFile.path);
        } else if (payload && payload.file) {
          knownFiles.set(payload.file.path, payload.file);
        }
      }
    }
    if (topic === 'workspace' && name === 'layout-change') {
      flushLayoutReady('layout-change');
      topicFor('workspace').trigger('layout-ready', payload);
    }
    if (topic === 'workspace' && name === 'file-open') {
      lastActiveFile = payload && payload.file ? payload.file : null;
      if (lastActiveFile && lastActiveFile.path) { fileCache.set(lastActiveFile.path, lastActiveFile); }
    }
    if (topic === 'metadata') {
      if (payload && payload.path) {
        metadataByPath.delete(payload.path);
        metadataPending.delete(payload.path);
        if (!payload.file) { payload.file = fileAtPath(payload.path); }
      }
      if (payload && !payload.file && payload.noteId) {
        payload.file = fileByNoteId(payload.noteId);
      }
      // 宿主把解析图和事件放在同一帧里:同步换成新图,插件在回调里立刻读到的就是新值。
      // 帧里没带图(旧宿主)才退回异步 RPC。这一步必须在下发前无条件执行:解析图与「能不能解析出 TFile」无关,
      // 事件被推迟时若把图一起跳过,插件读到的就是上一版(甚至空)图。
      if (payload && payload.graph) { applyLinkGraph(payload.graph); } else { refreshMetadataGraph(); }
      if (payload && !payload.file && payload.name === 'changed') {
        // Obsidian 的 changed 回调第一个参数永远是 TFile。宿主这一版只能给 noteId,
        // 本地索引里也没有(刚建/刚删的笔记)时先刷新索引再下发,仍没有就不下发 —— 不能给插件递 null。
        var deferredChange = payload;
        refreshVaultFiles().then(function () {
          var found = fileByNoteId(deferredChange.noteId);
          if (found) {
            deferredChange.file = found;
            var retryBucket = topicBuckets.get('metadata');
            if (retryBucket) { retryBucket.trigger.apply(retryBucket, ['changed'].concat(eventArgs('metadata', 'changed', deferredChange))); }
            return;
          }
          if (!metadataFileMissLogged.has('changed')) {
            metadataFileMissLogged.add('changed');
            console.warn('[lexinote] metadata.changed 缺文件,已跳过下推 noteId=' + deferredChange.noteId);
          }
        });
        return;
      }
    }
    if (topic === 'host-ref') {
      var entry = hostEventTable.get(payload && payload.refId);
      if (entry) { entry.callback(payload.payload); }
      return;
    }
    var bucket = topicBuckets.get(topic);
    if (bucket) { bucket.trigger.apply(bucket, [name].concat(eventArgs(topic, name, payload))); }
  }

  var topicBuckets = new Map();
  function topicFor(name) {
    var bucket = topicBuckets.get(name);
    if (!bucket) { bucket = new LocalEmitter(); topicBuckets.set(name, bucket); }
    return bucket;
  }

  function rehydrateFileEvent(payload) {
    if (!payload) { return payload; }
    var next = Object.assign({}, payload);
    if (payload.file) { next.file = fileFromJson(payload.file); }
    return next;
  }

  function subscribeTopic(topic, name, callback, ctx) {
    // Obsidian returns an EventRef synchronously; the host subscription is reconciled async.
    // events.on(name, callback, ctx) 的第 3 参是回调的接收者:插件普遍写 vault.on('modify', this.onFileModified, this),
    // 丢 this 会让 this.store / this.settings 读成 null(calendar-beta 的真实崩溃点)。
    var bucket = topicFor(topic);
    var listenerToken = currentToken();
    var wrapper = function () {
      var args = arguments;
      return withToken(listenerToken, function () { return callback.apply(ctx === undefined ? null : ctx, args); });
    };
    bucket.on(name, wrapper);
    var refId = ++hostEventSeq;
    // 订阅令牌随 entry 保存:events.off 必须以"订阅者"的身份注销,而不是以"调用 off 的人"。
    var entry = { refId: refId, topic: topic, name: name, callback: callback, wrapper: wrapper, token: listenerToken };
    hostEventTable.set(refId, entry);
    hostCall('events.on', { refId: refId, topic: topic, name: name }, listenerToken).catch(function () {});
    return makeHostRef(entry);
  }

  function makeHostRef(entry) {
    var ref = { __hostRef: entry.refId };
    ref.off = function () {
      hostEventTable.delete(entry.refId);
      var bucket = topicBuckets.get(entry.topic);
      if (bucket) { bucket.off(entry.name, entry.wrapper); }
      hostCall('events.off', { refId: entry.refId }, entry.token).catch(function () {});
    };
    return ref;
  }

  // ---------------------------------------------------------------- files

  function LexiFileData() {}
  function TFile() { this.path = ''; this.name = ''; this.basename = ''; this.extension = 'md'; this.vault = null; this.stat = { ctime: 0, mtime: 0, size: 0 }; this.noteId = ''; }
  function TFolder() { this.path = ''; this.name = ''; this.children = []; }
  TFile.prototype = Object.create(LexiFileData.prototype);
  TFolder.prototype = Object.create(LexiFileData.prototype);

  function fileFromJson(json) {
    if (!json) { return null; }
    if (json.kind === 'folder') {
      var folder = new TFolder();
      folder.path = json.path; folder.name = json.name;
      return folder;
    }
    var file = fileCache.get(json.path);
    if (!file) {
      file = new TFile();
      file.path = json.path;
      file.name = json.name;
      file.basename = json.basename;
      file.extension = json.extension;
      file.noteId = json.noteId;
      file.vaultId = json.vaultId;
      fileCache.set(json.path, file);
    }
    file.stat = json.stat || file.stat;
    return file;
  }

  // ---------------------------------------------------------------- utils

  function normalizePath(path) {
    path = String(path == null ? '' : path).trim().replace(/\\/g, '/');
    path = path.replace(/\/{2,}/g, '/');
    while (path.charAt(0) === '/') { path = path.slice(1); }
    while (path.length > 0 && path.charAt(path.length - 1) === '/') { path = path.slice(0, path.length - 1); }
    return path;
  }

  // ArkWeb 下 rawfile 是 opaque origin,window.localStorage 可能直接是 null
  // (实测 calendar 读 localStorage.getItem('language') 抛 Cannot read properties of null)。
  // 兜一个 Storage 语义的内存实现:同步 API 不变,写操作额外异步落到宿主偏好存储。
  function memoryStorage(scope) {
    var data = {};
    function persist(key, value) {
      hostCall('app.localStorage.set', { key: scope + ':' + key, data: value }).catch(function () { return null; });
    }
    return {
      getItem: function (key) {
        var name = String(key);
        return Object.prototype.hasOwnProperty.call(data, name) ? data[name] : null;
      },
      setItem: function (key, value) {
        var name = String(key);
        data[name] = String(value);
        persist(name, data[name]);
      },
      removeItem: function (key) {
        var name = String(key);
        delete data[name];
        persist(name, null);
      },
      clear: function () { data = {}; },
      key: function (index) {
        var names = Object.keys(data);
        return index >= 0 && index < names.length ? names[index] : null;
      },
      get length() { return Object.keys(data).length; }
    };
  }
  function ensureStorage(name, scope) {
    var current = null;
    try { current = window[name]; } catch (err) { current = null; }
    if (current) { return; }
    var store = memoryStorage(scope);
    try { window[name] = store; } catch (err) { store = null; }
    if (!store || !window[name]) {
      try { Object.defineProperty(window, name, { value: store || memoryStorage(scope), configurable: true, writable: true }); } catch (err) { /* 极端只读环境 */ }
    }
  }
  ensureStorage('localStorage', 'web.localStorage');
  ensureStorage('sessionStorage', 'web.sessionStorage');
  // compact moment-compatible surface (format/add/subtract/diff/startOf/unix)
  var DAY_MS = 86400000;
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function pad(value, size) {
    var text = String(Math.abs(value));
    while (text.length < size) { text = '0' + text; }
    return value < 0 ? '-' + text : text;
  }
  function MiniMoment(date) {
    this._d = date instanceof Date ? date : new Date();
  }
  MiniMoment.prototype.format = function (pattern) {
    var self = this;
    var text = (pattern === undefined || pattern === null) ? 'YYYY-MM-DD HH:mm' : String(pattern);
    var d = self._d;
    return text.replace(/YYYY|YY|MMMM|MMM|MM|DD|dddd|ddd|dd|HH|H|hh|mm|ss|SSS|A|a|M|D|Do/g, function (token) {
      switch (token) {
        case 'YYYY': return pad(d.getFullYear(), 4);
        case 'YY': return pad(d.getFullYear() % 100, 2);
        case 'MMMM': return MONTHS[d.getMonth()];
        case 'MMM': return MONTHS[d.getMonth()].slice(0, 3);
        case 'MM': return pad(d.getMonth() + 1, 2);
        case 'M': return String(d.getMonth() + 1);
        case 'DD': return pad(d.getDate(), 2);
        case 'D': return String(d.getDate());
        case 'Do': return String(d.getDate()) + '日';
        case 'dddd': return WEEKDAYS[d.getDay()];
        case 'ddd': return WEEKDAYS[d.getDay()].slice(0, 3);
        case 'dd': return WEEKDAYS[d.getDay()].slice(0, 2);
        case 'HH': return pad(d.getHours(), 2);
        case 'H': return String(d.getHours());
        case 'hh': return pad(d.getHours() % 12 === 0 ? 12 : d.getHours() % 12, 2);
        case 'mm': return pad(d.getMinutes(), 2);
        case 'ss': return pad(d.getSeconds(), 2);
        case 'SSS': return pad(d.getMilliseconds(), 3);
        case 'A': return d.getHours() < 12 ? 'AM' : 'PM';
        case 'a': return d.getHours() < 12 ? 'am' : 'pm';
        default: return token;
      }
    });
  };
  MiniMoment.prototype.add = function (amount, unit) { return shiftMoment(this, amount, unit, 1); };
  MiniMoment.prototype.subtract = function (amount, unit) { return shiftMoment(this, amount, unit, -1); };
  function shiftMoment(self, amount, unit, sign) {
    var d = new Date(self._d.getTime());
    var key = String(unit || '').toLowerCase();
    var addMonthsClamped = function (months) {
      var day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + months);
      var daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, daysInMonth));
    };
    if (key.startsWith('y')) {
      var yearDay = d.getDate();
      d.setFullYear(d.getFullYear() + sign * amount);
      var yearDays = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(yearDay, yearDays));
    }
    else if (key.startsWith('quarter')) { addMonthsClamped(sign * amount * 3); }
    else if (key.startsWith('month')) { addMonthsClamped(sign * amount); }
    else if (key.startsWith('week') || key === 'w') { d.setDate(d.getDate() + sign * amount * 7); }
    else if (key.startsWith('day') || key === 'd' || key === 'date') { d.setDate(d.getDate() + sign * amount); }
    else if (key.startsWith('hour') || key === 'h') { d.setHours(d.getHours() + sign * amount); }
    else if (key.startsWith('minute') || key === 'm') { d.setMinutes(d.getMinutes() + sign * amount); }
    else if (key.startsWith('second') || key === 's') { d.setSeconds(d.getSeconds() + sign * amount); }
    else { addMonthsClamped(sign * amount); }
    return new MiniMoment(d);
  }
  MiniMoment.prototype.startOf = function (unit) {
    var d = new Date(this._d.getTime());
    var key = String(unit || '').toLowerCase();
    if (key.charAt(0) === 'd' || key === 'date') { d.setHours(0, 0, 0, 0); }
    else if (key === 'week' || key === 'isoWeek') { d.setDate(d.getDate() - d.getDay()); d.setHours(0, 0, 0, 0); }
    else if (key.charAt(0) === 'm') { d.setDate(1); d.setHours(0, 0, 0, 0); }
    else if (key.charAt(0) === 'y') { d.setMonth(0, 1); d.setHours(0, 0, 0, 0); }
    else if (key.charAt(0) === 'h') { d.setMinutes(0, 0, 0); }
    else if (key.charAt(0) === 'm') { d.setSeconds(0, 0); }
    return new MiniMoment(d);
  };
  MiniMoment.prototype.diff = function (other, unit) {
    var delta = this._d.getTime() - (other && other._d ? other._d.getTime() : new Date(other).getTime());
    var key = String(unit || 'ms').toLowerCase();
    if (key.charAt(0) === 'd') { return Math.round(delta / DAY_MS); }
    if (key.charAt(0) === 'h') { return Math.round(delta / 3600000); }
    if (key.charAt(0) === 'm') { return Math.round(delta / 60000); }
    if (key.charAt(0) === 's') { return Math.round(delta / 1000); }
    return delta;
  };
  MiniMoment.prototype.valueOf = function () { return this._d.getTime(); };
  MiniMoment.prototype.unix = function () { return Math.floor(this._d.getTime() / 1000); };
  MiniMoment.prototype.toDate = function () { return new Date(this._d.getTime()); };
  MiniMoment.prototype.toISOString = function () { return this._d.toISOString(); };
  MiniMoment.prototype.isBefore = function (other) { return this.valueOf() < momentValue(other); };
  MiniMoment.prototype.isAfter = function (other) { return this.valueOf() > momentValue(other); };
  MiniMoment.prototype.clone = function () { return new MiniMoment(new Date(this._d.getTime())); };
  function momentValue(other) { return other && other._d ? other._d.getTime() : new Date(other).getTime(); }
  function moment(input) {
    if (input instanceof MiniMoment) { return input.clone(); }
    if (input instanceof Date) { return new MiniMoment(new Date(input.getTime())); }
    if (typeof input === 'number') { return new MiniMoment(new Date(input)); }
    if (typeof input === 'string') {
      var parsed = new Date(input);
      return new MiniMoment(Number.isNaN(parsed.getTime()) ? new Date() : parsed);
    }
    if (Array.isArray(input)) {
      var parts = input.slice();
      while (parts.length < 3) { parts.push(parts.length === 2 ? 1 : 0); }
      return new MiniMoment(new Date(parts[0], parts[1], parts[2]));
    }
    return new MiniMoment(new Date());
  }
  moment.isMoment = function (value) { return value instanceof MiniMoment; };
  moment.utc = function (input) { return moment(input); };
  moment.unix = function (seconds) { return new MiniMoment(new Date(seconds * 1000)); };
  moment.now = function () { return Date.now(); };
  moment.locale = function (locale) { return locale === undefined ? 'zh-cn' : 'zh-cn'; };
  // calendar 会在 onOpen 里调 moment.updateLocale 覆盖周起始日,并大量使用 localeData()._week / 月份名;
  // 缺任何一项整个视图都渲染不出来(实测:onOpen error ctx[9].localeData is not a function)。
  var momentLocaleConfig = { weekStart: 0 };
  function makeLocaleData() {
    var weekStart = momentLocaleConfig.weekStart;
    return {
      _abbr: 'zh-cn',
      _week: { dow: weekStart, doy: 6 },
      firstDayOfWeek: function () { return weekStart; },
      months: function () { return MONTHS.slice(); },
      monthsShort: function () { return MONTHS.map(function (name) { return name.slice(0, 3); }); },
      weekdays: function () { return WEEKDAYS.slice(); },
      weekdaysShort: function () { return WEEKDAYS.map(function (name) { return name.slice(0, 3); }); },
      weekdaysMin: function () { return WEEKDAYS.map(function (name) { return name.slice(0, 2); }); },
      longDateFormat: function (key) { return key === 'LT' ? 'HH:mm' : 'YYYY-MM-DD'; },
      ordinal: function (value) { return String(value); }
    };
  }
  moment.localeData = function () { return makeLocaleData(); };
  moment.updateLocale = function (locale, config) {
    if (config && config.week && typeof config.week.dow === 'number') { momentLocaleConfig.weekStart = config.week.dow; }
    return makeLocaleData();
  };
  moment.defineLocale = function (locale, config) { return moment.updateLocale(locale, config); };
  moment.locales = function () { return ['zh-cn', 'en', 'en-gb']; };
  // moment 对象自身也暴露 locale 名字助手(实测 calendar main.js:1078 直接调 window.moment.weekdaysShort())。
  function localeNameHelper(pick) {
    return function (value) {
      var list = pick();
      if (typeof value === 'number') { return list[((value % list.length) + list.length) % list.length]; }
      if (typeof value === 'string') { return list.indexOf(value); }
      return list.slice();
    };
  }
  moment.months = localeNameHelper(function () { return makeLocaleData().months(); });
  moment.monthsShort = localeNameHelper(function () { return makeLocaleData().monthsShort(); });
  moment.weekdays = localeNameHelper(function () { return makeLocaleData().weekdays(); });
  moment.weekdaysShort = localeNameHelper(function () { return makeLocaleData().weekdaysShort(); });
  moment.weekdaysMin = localeNameHelper(function () { return makeLocaleData().weekdaysMin(); });
  // 实例上也有 localeData/locale:calendar 把 today(moment 实例)传进 Svelte 后就是 ctx[9].localeData()。
  MiniMoment.prototype.localeData = function () { return makeLocaleData(); };
  // moment().calendar() 返回『今天/昨天/日期』这类相对文案;插件只用它做显示,给稳定的格式兜底。
  MiniMoment.prototype.calendar = function () { return this.format('YYYY-MM-DD'); };
  // moment 的取值/设值链(calendar 用 displayedMonth.clone().locale().date() 读日期,还有 weekday/isoWeekday)。
  // 语义按 moment 来:无参返回数值,带参原地改并返回 this。
  var MOMENT_FIELDS = [
    ['year', 'FullYear'], ['month', 'Month'], ['date', 'Date'], ['hours', 'Hours'],
    ['minutes', 'Minutes'], ['seconds', 'Seconds'], ['milliseconds', 'Milliseconds']
  ];
  MOMENT_FIELDS.forEach(function (pair) {
    MiniMoment.prototype[pair[0]] = function (value) {
      if (value === undefined || value === null) { return this._d['get' + pair[1]](); }
      this._d['set' + pair[1]](value);
      return this;
    };
  });
  MiniMoment.prototype.day = function (value) {
    if (value === undefined || value === null) { return this._d.getDay(); }
    return this.add(Number(value) - this._d.getDay(), 'day');
  };
  MiniMoment.prototype.weekday = function (value) {
    var start = momentLocaleConfig.weekStart;
    var current = (this._d.getDay() - start + 7) % 7;
    if (value === undefined || value === null) { return current; }
    return this.add(Number(value) - current, 'day');
  };
  MiniMoment.prototype.isoWeekday = function (value) {
    var current = this._d.getDay() === 0 ? 7 : this._d.getDay();
    if (value === undefined || value === null) { return current; }
    return this.add(Number(value) - current, 'day');
  };
  MiniMoment.prototype.week = function (value) {
    var start = momentLocaleConfig.weekStart;
    var jan1 = new Date(this._d.getFullYear(), 0, 1);
    var offset = (jan1.getDay() - start + 7) % 7;
    var current = Math.floor((this.dayOfYear() + offset - 1) / 7) + 1;
    if (value === undefined || value === null) { return current; }
    return this.add((Number(value) - current) * 7, 'day');
  };
  MiniMoment.prototype.dayOfYear = function () {
    var start = new Date(this._d.getFullYear(), 0, 0);
    return Math.floor((this._d.getTime() - start.getTime()) / 86400000);
  };
  MiniMoment.prototype.daysInMonth = function () {
    return new Date(this._d.getFullYear(), this._d.getMonth() + 1, 0).getDate();
  };
  MiniMoment.prototype.isValid = function () { return !isNaN(this._d.getTime()); };
  MiniMoment.prototype.toObject = function () {
    return {
      years: this._d.getFullYear(), months: this._d.getMonth(), date: this._d.getDate(),
      hours: this._d.getHours(), minutes: this._d.getMinutes(), seconds: this._d.getSeconds(),
      milliseconds: this._d.getMilliseconds()
    };
  };
  MiniMoment.prototype.endOf = function (unit) {
    var next = shiftMoment(this, 1, unit);
    return next.startOf(unit).subtract(1, unit === 'day' ? 'day' : unit);
  };
  MiniMoment.prototype.isSame = function (other, unit) {
    var a = this.toDate();
    var b = new Date(momentValue(other));
    if (!unit) { return a.getTime() === b.getTime(); }
    if (unit === 'day' || unit === 'date') {
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    }
    if (unit === 'month') { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth(); }
    if (unit === 'year') { return a.getFullYear() === b.getFullYear(); }
    return a.getTime() === b.getTime();
  };
  MiniMoment.prototype.isSameOrBefore = function (other, unit) { return this.isSame(other, unit) || this.isBefore(other); };
  MiniMoment.prototype.isSameOrAfter = function (other, unit) { return this.isSame(other, unit) || this.isAfter(other); };
  MiniMoment.prototype.utc = function () { return this; };
  MiniMoment.prototype.local = function () { return this; };
  // moment.locale('x') 是 setter 返回 this,无参才是读当前 locale(实测 calendar 用 .clone().locale(l).date())。
  MiniMoment.prototype.locale = function (name) { return name === undefined ? 'zh-cn' : this; };

  // ---------------------------------------------------------------- API objects

  var Platform = {
    isDesktop: false, isMobile: true, isDesktopApp: false, isMobileApp: true,
    isIosApp: false, isAndroidApp: false, isPhone: true, isTablet: false,
    isMacOS: false, isWin: false, isLinux: false, isSafari: false, resourcePathPrefix: ''
  };

  // DataAdapter:真实插件(obsidian-text-format 等)在 onload 里就用它探目录、读旁路配置。
  // 宿主 vault 模型只有路径(没有空目录),所以目录存在性 = 是否有文件以 "<dir>/" 开头。
  function adapterPaths() {
    return hostCall('vault.files', {}).then(function (list) {
      return (list || []).map(function (json) { return String((json && json.path) || ''); });
    });
  }

  var adapter = {
    getName: function () { return 'lexinote-vault'; },
    getBasePath: function () { return ''; },
    getResourcePath: function (path) { return String(path || ''); },
    exists: function (path) {
      var target = normalizePath(path);
      if (target.length === 0) { return Promise.resolve(true); }
      return adapterPaths().then(function (paths) {
        if (paths.indexOf(target) >= 0) { return true; }
        var prefix = target + '/';
        return paths.some(function (each) { return each.indexOf(prefix) === 0; });
      });
    },
    read: function (path) { return hostCall('vault.read', { path: normalizePath(path) }); },
    readBinary: function () { return Promise.reject(new Error('二进制读取将在后续版本提供')); },
    write: function (path, data) {
      var target = normalizePath(path);
      // .then 里的 hostCall 已经出了 bindApiToken 的同步令牌栈,必须在这里先把令牌取出来带上,
      // 否则写路径的身份是空 → 宿主 fsGate fail-closed(vault.create/modify 一律 capability_denied)。
      var token = currentToken();
      return adapterPaths().then(function (paths) {
        if (paths.indexOf(target) >= 0) { return hostCall('vault.modify', { path: target, data: data }, token); }
        return hostCall('vault.create', { path: target, data: data }, token);
      });
    },
    append: function (path, data) {
      var token = currentToken();
      return adapterPaths().then(function () {
        return hostCall('vault.append', { path: normalizePath(path), data: data }, token);
      });
    },
    process: function (path, fn) {
      return adapter.read(path).then(function (content) {
        var next = fn(content);
        if (next === content) { return next; }
        return adapter.write(path, next).then(function () { return next; });
      });
    },
    mkdir: function () { return Promise.resolve(); },
    rmdir: function () { return Promise.resolve(); },
    remove: function (path) {
      return hostCall('vault.delete', { path: normalizePath(path), force: true });
    },
    rename: function (path, newPath) {
      return hostCall('vault.rename', { path: normalizePath(path), newPath: normalizePath(newPath) });
    },
    copy: function () { return Promise.reject(new Error('copy 将在后续版本提供')); },
    list: function (path) {
      var dir = normalizePath(path);
      var prefix = dir.length === 0 ? '' : dir + '/';
      return adapterPaths().then(function (paths) {
        var folders = {};
        var files = [];
        paths.forEach(function (each) {
          if (each.indexOf(prefix) !== 0) { return; }
          var rest = each.substring(prefix.length);
          if (rest.length === 0) { return; }
          var slash = rest.indexOf('/');
          if (slash < 0) { files.push(each); }
          else { folders[prefix + rest.substring(0, slash)] = true; }
        });
        return { files: files, folders: Object.keys(folders) };
      });
    },
    // 宿主 vault 只暴露路径,没有 size/mtime:这里如实返回 0,不编造时间戳。
    stat: function (path) {
      var target = normalizePath(path);
      return adapter.exists(target).then(function (found) {
        if (!found) { return null; }
        return adapterPaths().then(function (paths) {
          var isFile = paths.indexOf(target) >= 0;
          return { type: isFile ? 'file' : 'folder', ctime: 0, mtime: 0, size: 0 };
        });
      });
    }
  };

  // Obsidian 的 getAbstractFileByPath / getMarkdownFiles 是同步 API:容器自己维持一份
  // 路径索引(启动拉一次 vault.files,vault 事件增量维护),不把 hostCall 的 Promise 当返回值。
  var knownFiles = new Map(); // path -> TFile 实例
  var vaultFilesPending = null;

  function rememberFile(json) {
    var file = json ? fileFromJson(json) : null;
    if (file && file.path) { knownFiles.set(file.path, file); }
    return file;
  }

  function refreshVaultFiles() {
    if (vaultFilesPending) { return vaultFilesPending; }
    vaultFilesPending = hostCall('vault.files', {}).then(function (list) {
      vaultFilesPending = null;
      knownFiles.clear();
      (list || []).forEach(rememberFile);
      return list || [];
    }, function (err) {
      vaultFilesPending = null;
      console.warn('[lexinote] 文件索引拉取失败', err);
      return [];
    });
    return vaultFilesPending;
  }

  function knownMarkdownFiles() {
    if (knownFiles.size === 0) { refreshVaultFiles(); }
    var files = [];
    knownFiles.forEach(function (file) { files.push(file); });
    return files.sort(function (a, b) { return a.path.localeCompare(b.path); });
  }

  // 目录在宿主里不是实体:按"有笔记落在该前缀下"合成 TFolder,插件遍历目录才拿不到 null。
  function rootFolder() {
    var folder = new TFolder();
    folder.path = '/';
    folder.name = '';
    var children = [];
    knownMarkdownFiles().forEach(function (file) {
      if (file.path.indexOf('/') < 0) { children.push(file); }
    });
    folder.children = children;
    return folder;
  }

  function knownAbstractFile(path) {
    var target = normalizePath(path);
    // normalizePath('') 得到 '/',Obsidian 里那就是 vault 根文件夹(calendar 用 getAbstractFileByPath('') 找日记目录)。
    if (target === '/' || target === '') { return rootFolder(); }
    var known = knownFiles.get(target);
    if (known) { return known; }
    var prefix = target === '/' ? '' : target + '/';
    var children = [];
    knownFiles.forEach(function (file, key) {
      if (key.indexOf(prefix) === 0) {
        var rest = key.slice(prefix.length);
        if (rest.indexOf('/') < 0) { children.push(file); }
      }
    });
    if (children.length === 0) { return null; }
    var folder = new TFolder();
    folder.path = target;
    folder.name = target.slice(target.lastIndexOf('/') + 1);
    folder.children = children;
    return folder;
  }

  var vault = {
    adapter: adapter,
    on: function (name, callback, ctx) { return subscribeTopic('vault', name, callback, ctx); },
    off: function (name, callback) { topicFor('vault').off(name, callback); },
    getAbstractFileByPath: function (path) { return knownAbstractFile(path); },
    getFileByPath: function (path) {
      var node = knownAbstractFile(path);
      return node instanceof TFile ? node : null;
    },
    getFolderByPath: function (path) {
      var node = knownAbstractFile(path);
      return node instanceof TFolder ? node : null;
    },
    getMarkdownFiles: function () { return knownMarkdownFiles(); },
    getFiles: function () { return knownMarkdownFiles(); },
    getAllLoadedFiles: function () { return knownMarkdownFiles(); },
    getRoot: function () {
      var root = new TFolder(); root.path = '/'; root.name = '';
      return root;
    },
    read: function (file) { return hostCall('vault.read', { path: file.path }); },
    cachedRead: function (file) { return vault.read(file); },
    modify: function (file, data) {
      // 乐观锁(T2.3):调用方持有读取时的文件对象(stat.revision)即自动携带预期 revision;
      // 无 revision(适配器路径/旧代码)退化为盲写,宿主行为不变。
      var expectedRevision = (file && file.stat && typeof file.stat.revision === 'number' && file.stat.revision > 0)
        ? file.stat.revision : -1;
      return hostCall('vault.modify', { path: file.path, data: data, expectedRevision: expectedRevision });
    },
    create: function (path, data) {
      return hostCall('vault.create', { path: normalizePath(path), data: data }).then(function (json) {
        var file = rememberFile(json);
        if (!file) { throw new Error('创建失败: ' + path); }
        return file;
      });
    },
    createBinary: function () { return Promise.reject(new Error('二进制文件将在后续版本提供')); },
    delete: function (file, force) {
      return hostCall('vault.delete', { path: file.path, force: !!force }).then(function () {
        knownFiles.delete(file.path);
        fileCache.delete(file.path);
      });
    },
    trash: function (file, system) { return vault.delete(file, false); },
    rename: function (file, newPath) {
      var target = normalizePath(newPath);
      return hostCall('vault.rename', { path: file.path, newPath: target }).then(function () {
        // Obsidian 的 rename 解析成改名后的同一个 TFile:路径就地更新,索引跟着搬家。
        knownFiles.delete(file.path);
        fileCache.delete(file.path);
        file.path = target;
        file.name = target.slice(target.lastIndexOf('/') + 1);
        file.basename = file.name.replace(/\.md$/i, '');
        knownFiles.set(target, file);
        fileCache.set(target, file);
        return file;
      });
    },
    append: function (file, data) { return hostCall('vault.append', { path: file.path, data: data }); },
    process: function (file, fn) {
      return vault.read(file).then(function (content) {
        var next = fn(content);
        if (next === content) { return next; }
        return vault.modify(file, next).then(function () { return next; });
      });
    },
    getResourcePath: function (path) { return ''; },
    getAllLoadedFiles: function () { return vault.getMarkdownFiles(); }
  };

  function requestMetadata(path) {
    if (typeof path !== 'string' || path.length === 0) { return null; }
    var key = normalizePath(path);
    if (metadataByPath.has(key)) { return metadataByPath.get(key); }
    if (!metadataPending.has(key)) {
      metadataPending.add(key);
      hostCall('metadata.get', { path: key }).then(function (cache) {
        metadataPending.delete(key);
        metadataByPath.set(key, cache || null);
      }, function () { metadataPending.delete(key); });
    }
    return null;
  }

  // 宿主一次 metadata.graph 给出整套解析结果(resolved/unresolved/每条链接的目标)。
  // resolvedLinks/unresolvedLinks 在 Obsidian 里是属性,getFirstLinkpathDest 是同步函数,
  // 二者都必须读这份缓存——同一个 linkpath 只能有一个答案。
  var linkGraph = { resolved: {}, unresolved: {}, links: [] };
  var linkGraphPending = false;
  var linkGraphLoaded = false;

  function applyLinkGraph(graph) {
    linkGraphLoaded = true;
    linkGraph.resolved = (graph && graph.resolved) || {};
    linkGraph.unresolved = (graph && graph.unresolved) || {};
    linkGraph.links = (graph && Array.isArray(graph.links)) ? graph.links : [];
    graphIndex = null;
  }

  function refreshMetadataGraph() {
    if (linkGraphPending) { return; }
    linkGraphPending = true;
    hostCall('metadata.graph', {}).then(function (graph) {
      linkGraphPending = false;
      applyLinkGraph(graph);
    }, function (err) {
      linkGraphPending = false;
      console.warn('[lexinote] 链接图拉取失败', err);
    });
  }

  // 容器只在这一处定义"linkpath 怎么算同一个键",两边都用它,宿主只回原始链接文本。
  function linkKey(linkpath) {
    var raw = String(linkpath == null ? '' : linkpath).trim();
    var pipe = raw.indexOf('|');
    if (pipe >= 0) { raw = raw.slice(0, pipe); }
    var hash = raw.indexOf('#');
    if (hash >= 0) { raw = raw.slice(0, hash); }
    raw = normalizePath(raw);
    if (/\.md$/i.test(raw)) { raw = raw.slice(0, raw.length - 3); }
    return raw.toLowerCase();
  }

  var graphIndex = null;
  function linkTargets() {
    if (graphIndex) { return graphIndex; }
    graphIndex = new Map();
    for (var i = 0; i < linkGraph.links.length; i++) {
      var entry = linkGraph.links[i];
      if (!entry || !entry.target) { continue; }
      graphIndex.set(normalizePath(entry.source) + '\u0000' + linkKey(entry.link), entry.target);
    }
    return graphIndex;
  }

  function fileByNoteId(noteId) {
    if (!noteId) { return null; }
    var found = null;
    knownFiles.forEach(function (file) {
      if (found === null && file && file.noteId === noteId) { found = file; }
    });
    return found;
  }

  function fileAtPath(path) {
    var cached = fileCache.get(path);
    if (cached) { return cached; }
    var name = String(path).split('/').pop();
    return fileFromJson({
      path: path, name: name, basename: name.replace(/\.[^.]+$/, ''),
      extension: (name.indexOf('.') >= 0 ? name.split('.').pop() : ''), stat: { ctime: 0, mtime: 0, size: 0 }
    });
  }

  function resolveLinkpath(linkpath, sourcePath) {
    var key = linkKey(linkpath);
    if (key.length === 0) { return null; }
    // Obsidian 的解析顺序:先相对来源笔记所在目录,再 vault 绝对路径,最后按 basename 唯一命中。
    // 这条路径只看文件是否存在,与 resolvedLinks(看已有链接文本)刻意分开,两者口径一致地回落到同一个 TFile。
    var source = normalizePath(sourcePath || '');
    var slash = source.lastIndexOf('/');
    var sourceDir = slash >= 0 ? source.slice(0, slash) : '';
    var candidates = [];
    if (sourceDir.length > 0) { candidates.push(sourceDir + '/' + key + '.md'); }
    candidates.push(key + '.md');
    for (var i = 0; i < candidates.length; i++) {
      var direct = knownAbstractFile(candidates[i]);
      if (direct && direct instanceof TFile) { return direct; }
    }
    var base = key.indexOf('/') >= 0 ? key.slice(key.lastIndexOf('/') + 1) : key;
    var byBase = knownMarkdownFiles().filter(function (file) { return file.basename.toLowerCase() === base; });
    return byBase.length > 0 ? byBase[0] : null;
  }

  function firstLinkDest(linkpath, sourcePath) {
    var source = normalizePath(sourcePath || '');
    var byFile = resolveLinkpath(linkpath, source);
    if (byFile) { return byFile; }
    // 文件存在性判不出来时,回落到宿主解析图:它对别名/noteId 这类容器看不到的写法有最终解释权。
    if (!linkGraphLoaded) { refreshMetadataGraph(); return null; }
    var key = linkKey(linkpath);
    if (key.length === 0) { return null; }
    var index = linkTargets();
    var direct = index.get(source + '\u0000' + key);
    if (direct) { return fileAtPath(direct); }
    var suffix = '\u0000' + key;
    var fallback = null;
    index.forEach(function (target, compound) {
      if (fallback || compound.slice(-suffix.length) !== suffix || !target) { return; }
      fallback = target;
    });
    return fallback ? fileAtPath(fallback) : null;
  }


  var metadataCache = {
    on: function (name, callback, ctx) { return subscribeTopic('metadata', name, callback, ctx); },
    off: function (name, callback) { topicFor('metadata').off(name, callback); },
    // Obsidian 的 getFileCache/getCache 是同步返回(缓存未就绪时为 null),这里保持同一语义:
    // 命中直接返回缓存,未命中触发一次异步拉取并返回 null,由调用方决定是否重试。
    getFileCache: function (file) { return requestMetadata(file && file.path); },
    getCache: function (path) { return requestMetadata(path); },
    // M2-B(Tasks 依赖):frontmatter 投影(Obsidian 语义为同步读,这里沿用 requestMetadata 通道)
    getAllProperties: function (path) {
      return requestMetadata(path).then(function (cache) {
        return (cache && cache.frontmatter) ? cache.frontmatter : {};
      });
    },
    getFirstLinkpathDest: function (linkpath, sourcePath) { return firstLinkDest(linkpath, sourcePath); },
    fileToLinktext: function (file) { return file.basename; },
    // Obsidian 语义:属性 getter,同步返回全量图。
    get resolvedLinks() { if (!linkGraphLoaded) { refreshMetadataGraph(); } return linkGraph.resolved; },
    get unresolvedLinks() { if (!linkGraphLoaded) { refreshMetadataGraph(); } return linkGraph.unresolved; }
  };

  function viewHostEl() {
    var host = document.getElementById('views') || document.getElementById('plugin-view-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'plugin-view-host';
      document.body.appendChild(host);
    }
    return host;
  }

  // Obsidian 的标签栏:每个 leaf 一个 .workspace-tab-header,点击即激活。
  function tabHeaderEl() {
    var headers = document.getElementById('views-tab-headers');
    if (headers) { return headers; }
    var host = viewHostEl();
    headers = document.createElement('div');
    headers.id = 'views-tab-headers';
    headers.className = 'workspace-tab-header-container';
    if (host.parentNode) { host.parentNode.insertBefore(headers, host); }
    return headers;
  }

  function revealActiveLeaf(leaf) {
    // 主编辑区叶永远在页面上:它成为 active 时不隐藏其它插件叶(Obsidian 里主编辑器同样不吞侧栏)。
    var keepOthers = leaf && leaf.__isMainEditor === true;
    for (var i = 0; i < openLeaves.length; i++) {
      var other = openLeaves[i];
      var isActive = other === leaf;
      if (other.__leafEl) {
        other.__leafEl.classList.toggle('is-active', isActive);
        if (!keepOthers) { other.__leafEl.style.display = isActive ? '' : 'none'; }
      }
      if (other.__tabEl) { other.__tabEl.classList.toggle('is-active', isActive); }
    }
  }

  var mainEditorLeaf = null;
  function mainEditorLeafRef() {
    if (!mainEditorLeaf) {
      mainEditorLeaf = createMarkdownLeaf();
      if (openLeaves.indexOf(mainEditorLeaf) < 0) { openLeaves.unshift(mainEditorLeaf); }
      if (!activeLeafRef) { activeLeafRef = mainEditorLeaf; }
    }
    return mainEditorLeaf;
  }
  function activateMainEditor() {
    var leaf = mainEditorLeafRef();
    if (activeLeafRef !== leaf) { activateLeaf(leaf); }
    return leaf;
  }
  function wireEditorActivation() {
    var editorEl = document.getElementById('editor');
    if (!editorEl || editorEl.__lexiWired === true) { return; }
    editorEl.__lexiWired = true;
    var onFocus = function () { activateMainEditor(); };
    editorEl.addEventListener('focusin', onFocus, true);
    editorEl.addEventListener('mousedown', onFocus, true);
  }

  function activateLeaf(leaf) {
    if (openLeaves.indexOf(leaf) < 0) { openLeaves.push(leaf); }
    var changed = activeLeafRef !== leaf;
    activeLeafRef = leaf;
    revealActiveLeaf(leaf);
    if (changed) {
      topicFor('workspace').trigger('active-leaf-change', leaf);
      schedulePersistLayout();
    }
    return changed;
  }

  // 视图身份键:type + 视图状态,不含 active/pinned/group 这类易变的布局属性。
  function layoutStateKey(type, state) {
    var copy = {};
    if (state && typeof state === 'object') {
      Object.keys(state).forEach(function (key) {
        if (key === 'active' || key === 'pinned' || key === 'group') { return; }
        copy[key] = state[key];
      });
    }
    return String(type) + '|' + JSON.stringify(copy);
  }

  // 布局快照:容器自己记谁开着、谁是 active,宿主只负责落盘(重启后由 restoreLayout 回放)。
  function layoutSnapshot() {
    var leaves = [];
    var activeIndex = -1;
    for (var i = 0; i < openLeaves.length; i++) {
      var leaf = openLeaves[i];
      var type = leaf.__viewType || '';
      if (type.length === 0) { continue; }
      // 主编辑器由容器自己每次都在,不进布局文件(否则回放时把自己再开一遍)。
      if (leaf.__isMainEditor === true) { continue; }
      leaves.push({ type: type, state: leaf.__viewState || { type: type } });
      if (leaf === activeLeafRef) { activeIndex = leaves.length - 1; }
    }
    return { leaves: leaves, activeIndex: activeIndex };
  }

  var persistTimer = null;
  // 恢复完成前禁止落盘:否则本会话第一个 leaf(演示视图)会把上次退出时的布局截成 1 个,
  // 紧接着 restoreLayout 读到的就是被自己踩掉的文件(实测月历永远恢复不回来)。
  var layoutPersistEnabled = false;
  function persistLayout() {
    if (!layoutPersistEnabled) { return; }
    if (!sessionToken && tokenScope.length === 0) { return; }
    // 布局落盘是宿主页自身的控制面调用:显式带会话凭据,不再借 currentToken 兜底(P1-006)。
    hostCall('workspace.saveLayout', { layout: layoutSnapshot() }, sessionToken).catch(function (err) {
      console.warn('[lexinote] 布局保存失败', err);
    });
  }

  function schedulePersistLayout() {
    if (persistTimer !== null) { clearTimeout(persistTimer); }
    persistTimer = setTimeout(function () {
      persistTimer = null;
      persistLayout();
    }, 120);
  }

  function notifyLayoutChange() {
    var snapshot = layoutSnapshot();
    topicFor('workspace').trigger('layout-change', snapshot);
    schedulePersistLayout();
    return snapshot;
  }

  function ensureLeafDom(leaf) {
    if (leaf.__leafEl) { return leaf.__leafEl; }
    var leafEl = document.createElement('div');
    leafEl.className = 'workspace-leaf';
    leafEl.style.display = 'none';
    var bodyEl = document.createElement('div');
    bodyEl.className = 'workspace-leaf-content';
    leafEl.appendChild(bodyEl);
    leaf.__leafEl = leafEl;
    leaf.__leafBodyEl = bodyEl;
    viewHostEl().appendChild(leafEl);
    var tab = document.createElement('div');
    tab.className = 'workspace-tab-header';
    tab.textContent = leaf.__viewType || '插件视图';
    tab.addEventListener('click', function () { activateLeaf(leaf); });
    leaf.__tabEl = tab;
    tabHeaderEl().appendChild(tab);
    return leafEl;
  }

  // 最小可用的 WorkspaceLeaf:setViewState 真的把 registerView 注册的 creator 实例化并挂进 DOM。
  function makePluginLeaf(viewType) {
    var leaf = {
      __viewType: viewType || '',
      // 归属令牌改经 WeakMap(P1-006):创建时同步栈身份——插件开视图=插件令牌;
      // 容器恢复布局=会话凭据(restoreLayout 显式改写)。
      __viewState: null,
      view: null,
      app: app,
      getViewState: function () { return leaf.__viewState || { type: leaf.__viewType }; },
      setViewState: function (state, focus) {
        var type = state && state.type ? state.type : leaf.__viewType;
        leaf.__viewType = type;
        leaf.__viewState = state ? Object.assign({}, state, { type: type }) : { type: type };
        var creator = viewCreators.get(type);
        ensureLeafDom(leaf);
        if (creator && !leaf.view) {
          var mountEl = leaf.__leafBodyEl;
          // 视图创建/onOpen 全链带 leaf 归属身份执行(P1-006):creator 里插件常调
          // vault/编辑器 API,而 leaf 是原始对象不在 bindApiToken 覆盖面内。
          withToken(objectToken(leaf) || currentToken(), function () {
            try { leaf.view = creator(leaf); } catch (err) { console.warn('[lexinote] 视图创建失败', err); }
            if (leaf.view) {
              if (!leaf.view.leaf) { leaf.view.leaf = leaf; }
              if (!leaf.view.containerEl) { leaf.view.containerEl = document.createElement('div'); }
              // 顺序对齐 Obsidian:先挂 DOM,再 setState → load → onOpen(calendar 在 onOpen 里建 Svelte 组件)。
              if (!leaf.view.containerEl.parentNode) { mountEl.appendChild(leaf.view.containerEl); }
              if (typeof leaf.view.setState === 'function' && state) {
                try { leaf.view.setState(state, true); } catch (err) { console.warn('[lexinote] view.setState error', err); }
              }
              if (leaf.view instanceof ComponentShim) {
                try { leaf.view.load(); } catch (err) { console.warn('[lexinote] 视图 load 失败', err); }
              }
              if (typeof leaf.view.onOpen === 'function') {
                try {
                  var opened = leaf.view.onOpen();
                  if (opened && typeof opened.catch === 'function') { opened.catch(function (err) { console.warn('[lexinote] onOpen error', err); }); }
                } catch (err) { console.warn('[lexinote] onOpen error', err); }
              }
            }
          });
        }
        if (openLeaves.indexOf(leaf) < 0) { openLeaves.push(leaf); }
        if (leaf.__tabEl) {
          var title = (leaf.view && typeof leaf.view.getDisplayText === 'function') ? leaf.view.getDisplayText() : type;
          leaf.__tabEl.textContent = title || type;
        }
        if (!state || state.active !== false || focus === true) {
          activateLeaf(leaf);
        } else {
          revealActiveLeaf(activeLeafRef);
        }
        notifyLayoutChange();
        return hostCall('workspace.openView', { type: type }, objectToken(leaf) || undefined).catch(function () { return null; });
      },
      openFile: function (file) {
        if (file && file.path) { return workspace.openLinkText(file.path, ''); }
        return Promise.reject(new Error('插件视图不支持打开文件'));
      },
      detach: function () {
        var index = openLeaves.indexOf(leaf);
        if (index >= 0) { openLeaves.splice(index, 1); }
        if (leaf.view && typeof leaf.view.onClose === 'function') {
          try { leaf.view.onClose(); } catch (err) { /* view already detached */ }
        }
        if (leaf.view && leaf.view.containerEl && leaf.view.containerEl.parentNode) {
          leaf.view.containerEl.parentNode.removeChild(leaf.view.containerEl);
        }
        if (leaf.__tabEl && leaf.__tabEl.parentNode) { leaf.__tabEl.parentNode.removeChild(leaf.__tabEl); }
        if (leaf.__leafEl && leaf.__leafEl.parentNode) { leaf.__leafEl.parentNode.removeChild(leaf.__leafEl); }
        leaf.view = null;
        leaf.__tabEl = null;
        leaf.__leafEl = null;
        if (activeLeafRef === leaf) {
          activeLeafRef = openLeaves.length > 0 ? openLeaves[openLeaves.length - 1] : null;
          revealActiveLeaf(activeLeafRef);
        }
        notifyLayoutChange();
        // 视图关闭必须以"打开该视图的身份"发出:leaf 归属令牌在 WeakMap(P1-006),优先于现场栈。
        return hostCall('workspace.closeView', { type: leaf.__viewType }, objectToken(leaf) || currentToken()).catch(function () { return null; });
      },
      getDisplayText: function () {
        return (leaf.view && typeof leaf.view.getDisplayText === 'function') ? leaf.view.getDisplayText() : leaf.__viewType;
      },
      getIcon: function () { return (leaf.view && typeof leaf.view.getIcon === 'function') ? leaf.view.getIcon() : ''; }
    };
    setObjectToken(leaf, currentToken());
    return leaf;
  }

  var workspace = {
    on: function (name, callback, ctx) { return subscribeTopic('workspace', name, callback, ctx); },
    off: function (name, callback) { topicFor('workspace').off(name, callback); },
    // Obsidian 的 Workspace 自带 Events:trigger 只打本地监听,不发给宿主。
    trigger: function (name) {
      var bucket = topicBuckets.get('workspace');
      if (!bucket) { return; }
      var handlers = bucket.handlers.get(name);
      if (!handlers) { return; }
      var args = Array.prototype.slice.call(arguments, 1);
      var snapshot = handlers.slice();
      for (var i = 0; i < snapshot.length; i++) {
        try { snapshot[i].apply(null, args); } catch (err) { console.warn('[lexinote] workspace listener error', err); }
      }
    },
    get layoutReady() { return layoutReadyFlushed; },
    get activeEditor() {
      if (!lastEditorState || lastEditorState.active === false) { return null; }
      return { app: app, file: null, editor: new EditorProxy(lastEditorState, currentToken()) };
    },
    // 以下四者在 Obsidian 里都是同步 API,容器必须同样同步返回。
    getActiveFile: function () { return lastActiveFile; },
    // Obsidian 的签名是 getActiveViewOfType(ViewClass)(GetViewType 是类,不是字符串):
    // MarkdownView/FileView 映射到 markdown,其余按 instanceof 命中插件自己注册的视图类。
    getActiveViewOfType: function (type) {
      var wantedType = '';
      var wantedClass = null;
      if (!type) {
        wantedType = '';
      } else if (typeof type === 'string') {
        wantedType = type;
      } else if (type === MarkdownViewShim || type === FileViewShim) {
        wantedType = 'markdown';
      } else if (typeof type === 'function') {
        wantedClass = type;
      }
      var matches = function (view) {
        if (!view) { return false; }
        if (wantedType.length > 0) {
          return typeof view.getViewType === 'function' && view.getViewType() === wantedType;
        }
        if (wantedClass !== null) { return view instanceof wantedClass; }
        return true;
      };
      var active = activeLeafRef && activeLeafRef.view ? activeLeafRef.view : null;
      if (matches(active)) { return active; }
      var leaves = openLeaves.filter(function (leaf) { return matches(leaf.view); });
      if (leaves.length > 0) { return leaves[0].view; }
      // 主编辑器常开:active 停在插件叶上时仍应能取到 markdown 视图(否则一次性插件拿不到编辑器)。
      var main = mainEditorLeafRef();
      return matches(main.view) ? main.view : null;
    },
    getLeavesOfType: function (type) {
      return openLeaves.filter(function (leaf) { return leaf.__viewType === type; });
    },
    // 事件回调里遍历叶子是插件最常用的写法(obsidian-pangu 就在 layout-change 里调),
    // Obsidian 里是同步 API,这里同样同步遍历容器内已打开的叶子。
    iterateAllLeaves: function (callback) {
      if (typeof callback !== 'function') { return; }
      var snapshot = openLeaves.slice();
      for (var i = 0; i < snapshot.length; i++) { callback(snapshot[i]); }
    },
    iterateRootLeaves: function (callback) { workspace.iterateAllLeaves(callback); },
    getMostRecentLeaf: function () { return openLeaves.length > 0 ? openLeaves[openLeaves.length - 1] : null; },
    get activeLeaf() { return activeLeafRef || mainEditorLeafRef(); },
    get mainEditorLeaf() { return mainEditorLeafRef(); },
    setActiveLeaf: function (leaf) { activateLeaf(leaf); return Promise.resolve(); },
    getRightLeaf: function (_split) { return makePluginLeaf(''); },
    getLeaf: function (mode) {
      if (mode === false) { return workspace.activeLeaf || makePluginLeaf(''); }
      return makePluginLeaf('');
    },
    detachLeavesOfType: function (type) {
      var leaves = openLeaves.filter(function (leaf) { return leaf.__viewType === type; });
      for (var i = 0; i < leaves.length; i++) { leaves[i].detach(); }
      schedulePersistLayout();
      return hostCall('workspace.closeView', { type: type }).catch(function () { return null; });
    },
    revealLeaf: function (leaf) {
      if (leaf) { activateLeaf(leaf); }
      return Promise.resolve(leaf);
    },
    openLinkText: function (linktext, sourcePath) {
      return hostCall('workspace.openLinkText', { linktext: linktext, sourcePath: sourcePath || '' });
    },
    onLayoutReady: function (callback) {
      if (typeof callback !== 'function') { return; }
      var entry = { cb: callback, token: currentToken() };
      if (layoutReadyFlushed) { withToken(entry.token, function () { callback(); }); return; }
      layoutReadyCallbacks.push(entry);
      hostCall('workspace.onLayoutReady', {}).then(function () { flushLayoutReady('host'); }, function () {});
    }
  };

  /** 同页命令直接在本页执行(Obsidian 语义),未注册才回落宿主(可执行别的插件/内核命令)。 */
  function runLocalCommand(fullId) {
    var command = commandTable.get(fullId);
    if (!command) { return null; }
    var commandToken = tokenForPluginId(String(fullId).split(':')[0]);
    return withToken(commandToken, function () {
      if (command.checkCallback && !command.checkCallback(false)) { return false; }
      if (command.callback) { return command.callback(); }
      return true;
    });
  }

  var commands = {
    executeCommandById: function (id) {
      var outcome = runLocalCommand(id);
      if (outcome !== null) {
        return Promise.resolve(outcome).then(function () { return true; }, function (err) {
          console.warn('[lexinote] 命令执行失败', err);
          return false;
        });
      }
      return hostCall('commands.execute', { id: id }).then(function (result) {
        return result && result.executed !== undefined ? result.executed : true;
      });
    },
    listCommands: function () {
      var local = [];
      var seen = {};
      commandTable.forEach(function (command, fullId) {
        seen[fullId] = true;
        local.push({ id: fullId, name: command.name, icon: command.icon || '' });
      });
      return hostCall('commands.list', {}).then(function (list) {
        var merged = local.slice();
        var host = Array.isArray(list) ? list : [];
        for (var i = 0; i < host.length; i++) {
          if (host[i] && host[i].id && !seen[host[i].id]) { merged.push(host[i]); }
        }
        return merged;
      }, function () { return local; });
    },
    editorActions: [],
    registry: null
  };

  var app = {
    vault: vault,
    metadataCache: metadataCache,
    workspace: workspace,
    commands: commands,
    fileManager: {
      generateMarkdownLink: function (file) { return '[[' + file.basename + ']]'; },
      processFrontMatter: function () { return Promise.reject(new Error('processFrontMatter 将在后续版本提供')); },
      renameFile: function (file, newPath) { return vault.rename(file, newPath); }
    },
    lastEvent: null,
    isDarkMode: function () { return hostCall('app.isDarkMode', {}); },
    loadLocalStorage: function (key) { return hostCall('app.localStorage.get', { key: key }); },
    saveLocalStorage: function (key, data) { return hostCall('app.localStorage.set', { key: key, data: data === undefined ? null : data }); },
    appRowEl: null, containerEl: null, keymap: null, scope: null
  };

  // 第三方插件会读别的插件实例(calendar 读 daily-notes/periodic-notes 设置,obsidian 的
  // app.plugins.getPlugin 缺省返回 null 而不是 undefined)。数据源就是容器已装载的插件表。
  function pluginInstanceMap() {
    var out = {};
    plugins.forEach(function (instance, id) { out[id] = instance; });
    return out;
  }
  // Obsidian 的核心插件注册表(daily-notes 等)。LexiNote 没有核心插件,按官方语义返回 undefined 由调用方 ?. 兜底。
  app.internalPlugins = {
    plugins: {},
    getPluginById: function () { return undefined; },
    getEnabledPluginById: function () { return undefined; },
    enablePlugin: function () { return Promise.resolve(); },
    disablePlugin: function () { return Promise.resolve(); }
  };
  app.plugins = {
    get plugins() { return pluginInstanceMap(); },
    get manifests() {
      var out = {};
      plugins.forEach(function (instance, id) { out[id] = instance.manifest; });
      return out;
    },
    get enabledPlugins() {
      var out = new Set();
      plugins.forEach(function (instance, id) { out.add(id); });
      return out;
    },
    getPlugin: function (id) {
      if (plugins.has(id)) { return plugins.get(id); }
      // 目录键是安装 id,插件自己注册的 manifest.id 可能不同(calendar-beta 的内部 id 就是 calendar),
      // 插件读自己的设置走 getPlugin(manifest.id),不认目录键就会拿到 null。
      var byManifest = null;
      plugins.forEach(function (instance) {
        if (byManifest === null && instance && instance.manifest && instance.manifest.id === id) { byManifest = instance; }
      });
      if (byManifest !== null) { return byManifest; }
      if (!missingPluginIds.has(id)) { missingPluginIds.add(id); console.warn('[lexinote] plugins.getPlugin 未命中: ' + id + ' 已装载=' + Array.from(plugins.keys()).join(',')); }
      return null;
    },
    getEnabledPluginById: function (id) { return app.plugins.getPlugin(id); },
    getEnabledPlugins: pluginInstanceMap,
    enablePlugin: function () { return Promise.resolve(); },
    disablePlugin: function () { return Promise.resolve(); },
    enablePluginAndSave: function () { return Promise.resolve(); },
    disablePluginAndSave: function () { return Promise.resolve(); }
  };
  // 老插件直接读 window.app / window.moment(calendar 就是这样),缺了会静默挂掉。
  window.app = app;
  window.moment = moment;

  // ---------------------------------------------------------------- lifecycle classes

  function ComponentShim() {
    this._children = [];
    this._cleanups = [];
    this._intervals = [];
    this._loaded = false;
  }
  ComponentShim.prototype.load = function () {
    if (this._loaded) { return Promise.resolve(); }
    this._loaded = true;
    var result = this.onload ? this.onload() : undefined;
    for (var i = 0; i < this._children.length; i++) { this._children[i].load(); }
    return Promise.resolve(result);
  };
  ComponentShim.prototype.unload = function () {
    if (!this._loaded) { return; }
    this._loaded = false;
    for (var i = 0; i < this._children.length; i++) { this._children[i].unload(); }
    this._children = [];
    for (var j = 0; j < this._intervals.length; j++) { clearInterval(this._intervals[j]); }
    this._intervals = [];
    for (var k = 0; k < this._cleanups.length; k++) {
      try { this._cleanups[k](); } catch (err) { console.warn('[lexinote] cleanup error', err); }
    }
    this._cleanups = [];
    if (this.onunload) { this.onunload(); }
  };
  ComponentShim.prototype.addChild = function (child) {
    this._children.push(child);
    if (this._loaded) { child.load(); }
    return child;
  };
  ComponentShim.prototype.removeChild = function (child) {
    var index = this._children.indexOf(child);
    if (index >= 0) { this._children.splice(index, 1); }
    child.unload();
    return child;
  };
  ComponentShim.prototype.register = function (cleanup) { this._cleanups.push(cleanup); };
  ComponentShim.prototype.registerEvent = function (ref) {
    if (!ref) { return; }
    this._cleanups.push(function () { if (ref.off) { ref.off(); } });
  };
  ComponentShim.prototype.registerDomEvent = function (el, type, callback) {
    if (el && typeof el.addEventListener === 'function') {
      el.addEventListener(type, callback);
      this._cleanups.push(function () { el.removeEventListener(type, callback); });
    } else {
      console.warn('[lexinote] registerDomEvent 在内核上下文不可用,将在视图槽内生效');
    }
  };
  ComponentShim.prototype.registerInterval = function (id) {
    this._intervals.push(id);
    return id;
  };

  function PluginShim(appRef, manifest) {
    ComponentShim.call(this);
    this.app = appRef;
    this.manifest = manifest;
    // 归属令牌不在属性上(P1-006):loadPlugin 时经 setObjectToken 记入闭包 WeakMap。
  }
  PluginShim.prototype = Object.create(ComponentShim.prototype);
  PluginShim.prototype.constructor = PluginShim;
  PluginShim.prototype.addCommand = function (command) {
    var self = this;
    var fullId = self.manifest.id + ':' + command.id;
    commandTable.set(fullId, command);
    hostCall('commands.add', {
      pluginId: self.manifest.id,
      command: {
        id: command.id, name: command.name, icon: command.icon || '', hotkeys: command.hotkeys || [],
        editorOnly: typeof command.editorCallback === 'function'
      }
    }).catch(function (err) { console.warn('[lexinote] 命令注册失败', err); });
    self.register(function () {
      commandTable.delete(fullId);
      hostCall('commands.remove', { fullId: fullId }).catch(function () {});
    });
    return Object.assign({}, command, { id: fullId });
  };
  PluginShim.prototype.removeCommand = function (commandId) {
    var fullId = commandId.indexOf(':') >= 0 ? commandId : this.manifest.id + ':' + commandId;
    commandTable.delete(fullId);
    hostCall('commands.remove', { fullId: fullId }).catch(function () {});
  };
  PluginShim.prototype.addRibbonIcon = function (icon, title, callback) {
    var self = this;
    var key = self.manifest.id + ':' + title;
    if (typeof callback === 'function') { ribbonTable.set(key, callback); }
    hostCall('ui.addRibbon', {
      pluginId: self.manifest.id, title: String(title), icon: String(icon || '')
    }).catch(function (err) { console.warn('[lexinote] Ribbon 注册失败', err); });
    self.register(function () {
      ribbonTable.delete(key);
      hostCall('ui.removeRibbon', { pluginId: self.manifest.id, title: String(title) }).catch(function () {});
    });
    return null;
  };
  PluginShim.prototype.addStatusBarItem = function () {
    var self = this;
    hostCall('ui.placeholder', { kind: 'statusbar', pluginId: self.manifest.id }).catch(function () {});
    var el = mountStatusBarItem(self.manifest.id, '');
    var item = {
      el: el,
      setText: function (text) {
        el.textContent = String(text === undefined || text === null ? '' : text);
        return item;
      },
      setAttribute: function (name, value) { el.setAttribute(String(name), String(value)); return item; },
      createEl: function (tag, options) { return el.createEl(tag, options); },
      addClass: function (cls) { el.addClass(cls); return item; },
      remove: function () { if (el.parentNode) { el.parentNode.removeChild(el); } }
    };
    return item;
  };
  PluginShim.prototype.addSettingTab = function (tab) {
    var self = this;
    self._settingTab = tab;
    var definitions = [];
    try {
      definitions = tab && typeof tab.getSettingDefinitions === 'function' ? tab.getSettingDefinitions() : [];
    } catch (err) { console.warn('[lexinote] 设置定义读取失败', err); }
    hostCall('settings.register', {
      pluginId: self.manifest.id,
      definitionsJson: JSON.stringify(definitions || [])
    }).catch(function (err) { console.warn('[lexinote] 设置注册失败', err); });
    self.register(function () {
      hostCall('settings.unregister', { pluginId: self.manifest.id }).catch(function () {});
    });
  };
  PluginShim.prototype.registerView = function (type, creator) {
    var self = this;
    viewCreators.set(type, creator);
    hostCall('views.add', {
      pluginId: self.manifest.id, type: type, displayName: String(type), icon: ''
    }).catch(function (err) { console.warn('[lexinote] 视图注册失败', err); });
    self.register(function () {
      viewCreators.delete(type);
      hostCall('views.remove', { type: type }).catch(function () {});
    });
  };
  PluginShim.prototype.registerExtensions = function () {};
  // Obsidian 的 registerEditorExtension 必须真的装进活的 EditorView。
  // 装不进去不会抛错(ViewPlugin 会静默不生效),所以只能走同页编辑器桥并在卸载时撤销。
  PluginShim.prototype.registerEditorExtension = function (extension) {
    var pluginId = this.manifest.id;
    var list = editorExtensionsByPlugin.get(pluginId) || [];
    list.push(extension);
    editorExtensionsByPlugin.set(pluginId, list);
    var api = editorApi();
    if (api) {
      api.registerExtensions(pluginId, [extension]);
    } else {
      console.warn('[lexinote] registerEditorExtension 没有同页编辑器可安装: ' + pluginId);
    }
    return extension;
  };
  PluginShim.prototype.registerEditorExtensions = function (extensions) {
    var list = extensions && extensions.length ? extensions : [];
    for (var i = 0; i < list.length; i++) { this.registerEditorExtension(list[i]); }
  };
  PluginShim.prototype.registerMarkdownPostProcessor = function (processor, priority) {
    // RFC T3.1(P1-02 收口):真委托 LexiReading 注册表——稳定顺序与失败隔离在内核侧(§7.5)。
    // 返回注销函数语义挂到 _cleanups 卸载链:插件 onunload 时反注册自己的后处理器。
    var self = this;
    if (typeof processor !== 'function') { return processor; }
    var sortOrder = typeof priority === 'number' && isFinite(priority) ? priority : 0;
    var reading = typeof window !== 'undefined' ? window.LexiReading : null;
    if (reading && typeof reading.registerPostProcessor === 'function') {
      var deregister = reading.registerPostProcessor(function (el, context) {
        return withToken(objectToken(self) || currentToken(), function () { return processor(el, context); });
      }, sortOrder);
      if (self._cleanups) {
        self._cleanups.push(function () { if (typeof deregister === 'function') { deregister(); } });
      }
    } else {
      console.warn('[lexinote] LexiReading 注册表不可用,后处理器未挂载');
    }
    return processor;
  };
  PluginShim.prototype.registerMarkdownCodeBlockProcessor = function (language, handler) {
    var self = this;
    var key = String(language || '').toLowerCase();
    if (!key) { return; }
    codeBlockTable.set(key, handler);
    hostCall('codeblocks.register', { pluginId: self.manifest.id, language: key }).catch(function (err) {
      console.warn('[lexinote] 代码块处理器注册失败', err);
    });
    self.register(function () {
      codeBlockTable.delete(key);
      hostCall('codeblocks.unregister', { pluginId: self.manifest.id, language: key }).catch(function () {});
    });
  };
  PluginShim.prototype.registerEditorSuggest = function () {};
  PluginShim.prototype.registerObsidianProtocolHandler = function () {};
  PluginShim.prototype.loadData = function () {
    var self = this;
    return hostCall('data.load', { pluginId: self.manifest.id }).then(function (raw) {
      if (raw === null || raw === undefined) { return null; }
      return safeParse(raw, null);
    });
  };
  PluginShim.prototype.saveData = function (data) {
    var self = this;
    return hostCall('data.save', { pluginId: self.manifest.id, dataJson: JSON.stringify(data === undefined ? null : data) });
  };
  PluginShim.prototype.onUserEnable = function () {};

  // 插件注册/数据类调用必须带插件身份令牌(宿主靠令牌反查 pluginId,payload.pluginId 不可信)。
  // hostCall 在调用点同步读取当前令牌,因此这里用一个同步作用域包住每个注册方法即可。
  ['addCommand', 'removeCommand', 'addRibbonIcon', 'addStatusBarItem', 'addSettingTab', 'registerView',
    'registerMarkdownCodeBlockProcessor', 'loadData', 'saveData'].forEach(function (name) {
    var original = PluginShim.prototype[name];
    PluginShim.prototype[name] = function () {
      var self = this;
      var args = arguments;
      return withToken(objectToken(self) || currentToken(), function () { return original.apply(self, args); });
    };
  });

  // ---------------------------------------------------------------- UI primitives

  // ---------------------------------------------------------------- editor proxy

  function lineOffsets(text) {
    var offsets = [0];
    for (var i = 0; i < text.length; i++) {
      if (text.charAt(i) === '\n') { offsets.push(i + 1); }
    }
    return offsets;
  }

  function offsetToPos(text, offset) {
    var safe = Math.max(0, Math.min(text.length, offset));
    var offsets = lineOffsets(text);
    var line = 0;
    while (line + 1 < offsets.length && offsets[line + 1] <= safe) { line++; }
    return { line: line, ch: safe - offsets[line] };
  }

  function posToOffset(text, pos) {
    if (typeof pos === 'number') { return Math.max(0, Math.min(text.length, pos)); }
    var offsets = lineOffsets(text);
    var line = Math.max(0, Math.min(offsets.length - 1, Math.floor(pos && pos.line ? pos.line : 0)));
    var lineStart = offsets[line];
    var lineEnd = line + 1 < offsets.length ? offsets[line + 1] - 1 : text.length;
    var ch = Math.max(0, Math.min(pos && typeof pos.ch === 'number' ? pos.ch : 0, lineEnd - lineStart));
    return lineStart + ch;
  }

  function acceptEditorState(state) {
    if (!state || state.active === false) { return; }
    lastEditorState = state;
  }

  // 同页编辑器桥(bundle 侧的 window.__lexiEditor):容器里只有一套真文档,
  // 编辑操作必须落到活的 CM6 EditorView;没有这座桥时(原生 slot 面)才回落宿主 RPC。
  function editorApi() {
    return typeof window !== 'undefined' && window.__lexiEditor ? window.__lexiEditor : null;
  }

  function EditorProxy(state, ownerToken) {
    this._text = state && typeof state.text === 'string' ? state.text : '';
    var selection = (state && state.selection) || { start: 0, end: 0 };
    this._selection = {
      start: Math.max(0, selection.start || 0),
      end: Math.max(0, typeof selection.end === 'number' ? selection.end : (selection.start || 0))
    };
    this._noteId = (state && state.noteId) || '';
    // RFC T0.3+P1-006:编辑器代理的归属令牌存闭包 WeakMap(属性形态会被同 realm 插件盗读)。
    setObjectToken(this, typeof ownerToken === 'string' ? ownerToken : '');
  }
  // Obsidian 的 Editor.cm 就是 CM6 的 EditorView:obsidian-outliner 直接拿它调 view/state API。
  try {
    Object.defineProperty(EditorProxy.prototype, 'cm', {
      configurable: true,
      get: function () {
        var api = this._local();
        return api ? api.cm() : null;
      }
    });
  } catch (err) { console.warn('[lexinote] Editor.cm 挂载失败', err); }
  EditorProxy.prototype._local = function () { return editorApi(); };
  EditorProxy.prototype._snapshot = function () {
    return {
      text: this._text,
      selection: { start: this._selection.start, end: this._selection.end },
      noteId: this._noteId
    };
  };
  // Obsidian 的 Editor 是同步 API:本地路径把真文档读回来,宿主动路径靠 RPC 回包更新。
  EditorProxy.prototype._sync = function () {
    var api = this._local();
    if (!api) { return false; }
    try {
      this._text = String(api.getValue());
      var selection = api.getSelection();
      this._selection = { start: selection.anchor, end: selection.head };
    } catch (err) { console.warn('[lexinote] 编辑器读取失败', err); return false; }
    return true;
  };
  EditorProxy.prototype._mutate = function (run) {
    var api = this._local();
    if (!api) { return null; }
    try { run(api); } catch (err) { console.warn('[lexinote] 编辑器操作失败', err); return null; }
    this._sync();
    return Promise.resolve(this._snapshot());
  };
  EditorProxy.prototype._apply = function (method, payload) {
    var self = this;
    // 显式带归属令牌:异步栈上 currentToken() 已弹空,会退化成匿名被授权矩阵拒绝(fail-closed)。
    return hostCall(method, payload, objectToken(this) || currentToken()).then(function (state) {
      acceptEditorState(state);
      if (state && typeof state.text === 'string') { self._text = state.text; }
      if (state && state.selection) { self._selection = { start: state.selection.start, end: state.selection.end }; }
      return state;
    });
  };
  EditorProxy.prototype.getValue = function () { this._sync(); return this._text; };
  EditorProxy.prototype.setValue = function (content) {
    var text = String(content === undefined ? '' : content);
    var applied = this._mutate(function (api) { api.setValue(text); });
    if (applied) { return applied; }
    return this._apply('editor.replace', { start: 0, end: this._text.length, text: text });
  };
  EditorProxy.prototype.getSelection = function () {
    this._sync();
    return this._text.substring(this._selection.start, this._selection.end);
  };
  EditorProxy.prototype.somethingSelected = function () { this._sync(); return this._selection.end > this._selection.start; };
  EditorProxy.prototype.replaceSelection = function (replacement) {
    this._sync();
    var text = String(replacement === undefined ? '' : replacement);
    var start = this._selection.start;
    var end = this._selection.end;
    var applied = this._mutate(function (api) { api.replace(start, end, text); });
    if (applied) { return applied; }
    return this._apply('editor.replace', { start: start, end: end, text: text });
  };
  EditorProxy.prototype.replaceRange = function (replacement, from, to) {
    this._sync();
    var start = posToOffset(this._text, from);
    var end = to ? posToOffset(this._text, to) : start;
    var text = String(replacement === undefined ? '' : replacement);
    var applied = this._mutate(function (api) { api.replace(start, Math.max(start, end), text); });
    if (applied) { return applied; }
    return this._apply('editor.replace', { start: start, end: Math.max(start, end), text: text });
  };
  EditorProxy.prototype.getRange = function (from, to) {
    this._sync();
    return this._text.substring(posToOffset(this._text, from), posToOffset(this._text, to));
  };
  EditorProxy.prototype.getLine = function (line) {
    this._sync();
    var lines = this._text.split('\n');
    return line >= 0 && line < lines.length ? lines[line] : '';
  };
  EditorProxy.prototype.lineCount = function () { this._sync(); return this._text.split('\n').length; };
  EditorProxy.prototype.lastLine = function () { return this.lineCount() - 1; };
  EditorProxy.prototype.getCursor = function (side) {
    this._sync();
    var offset = side === 'from' || side === 'anchor' ? this._selection.start : this._selection.end;
    return offsetToPos(this._text, offset);
  };
  EditorProxy.prototype.setCursor = function (pos, ch) {
    this._sync();
    var offset = posToOffset(this._text, typeof pos === 'number' ? { line: pos, ch: ch || 0 } : pos);
    var applied = this._mutate(function (api) { api.setSelection(offset, offset); });
    if (applied) { return applied; }
    return this._apply('editor.selection', { start: offset, end: offset });
  };
  EditorProxy.prototype.setSelection = function (anchor, head) {
    this._sync();
    var a = posToOffset(this._text, anchor);
    var b = head ? posToOffset(this._text, head) : a;
    var applied = this._mutate(function (api) { api.setSelection(a, b); });
    if (applied) { return applied; }
    return this._apply('editor.selection', { start: Math.min(a, b), end: Math.max(a, b) });
  };
  EditorProxy.prototype.setSelections = function (ranges) {
    if (!ranges || ranges.length === 0) { return Promise.resolve(); }
    return this.setSelection(ranges[0].anchor, ranges[0].head);
  };
  EditorProxy.prototype.listSelections = function () {
    this._sync();
    return [{ anchor: offsetToPos(this._text, this._selection.start), head: offsetToPos(this._text, this._selection.end) }];
  };
  EditorProxy.prototype.posToOffset = function (pos) { this._sync(); return posToOffset(this._text, pos); };
  EditorProxy.prototype.offsetToPos = function (offset) { this._sync(); return offsetToPos(this._text, offset); };
  EditorProxy.prototype.focus = function () {
    var api = this._local();
    if (api) { api.focus(); }
  };
  EditorProxy.prototype.blur = function () {
    var api = this._local();
    if (api) { api.blur(); }
  };
  EditorProxy.prototype.hasFocus = function () {
    var api = this._local();
    if (!api) { return true; }
    var cm = api.cm();
    return !!(cm && cm.hasFocus);
  };
  EditorProxy.prototype.getScrollInfo = function () {
    var api = this._local();
    var cm = api ? api.cm() : null;
    var scroller = cm ? cm.scrollDOM : null;
    if (!scroller) { return { top: 0, left: 0 }; }
    return { top: scroller.scrollTop, left: scroller.scrollLeft };
  };
  EditorProxy.prototype.scrollTo = function (left, top) {
    var api = this._local();
    var cm = api ? api.cm() : null;
    var scroller = cm ? cm.scrollDOM : null;
    if (!scroller) { return; }
    if (typeof left === 'number') { scroller.scrollLeft = left; }
    if (typeof top === 'number') { scroller.scrollTop = top; }
  };
  EditorProxy.prototype.scrollIntoView = function (range) {
    var api = this._local();
    if (!api) { return; }
    this._sync();
    var offset = range && typeof range.from !== 'undefined' ? posToOffset(this._text, range.from) : this._selection.start;
    api.scrollIntoView(offset);
  };
  // undo/redo/exec/processLines 落到 CM6 的真实现(history 扩展与 transaction),不是空壳。
  EditorProxy.prototype.undo = function () {
    var api = this._local();
    if (!api) { throw new Error('editor.undo 需要同页编辑器(容器未就绪)'); }
    var done = api.undo();
    this._sync();
    return done;
  };
  EditorProxy.prototype.redo = function () {
    var api = this._local();
    if (!api) { throw new Error('editor.redo 需要同页编辑器(容器未就绪)'); }
    var done = api.redo();
    this._sync();
    return done;
  };
  EditorProxy.prototype.exec = function (command) {
    var api = this._local();
    if (!api) { throw new Error('editor.exec 需要同页编辑器(容器未就绪)'); }
    var done = api.exec(command);
    this._sync();
    return done;
  };
  EditorProxy.prototype.transaction = function (transaction) {
    if (!transaction) { return Promise.resolve(); }
    var changes = (transaction.changes || []).map(function (change) {
      return {
        from: change.from,
        to: change.to || change.from,
        text: String(change.text === undefined ? '' : change.text)
      };
    });
    var rawSelections = transaction.selections || (transaction.selection ? [transaction.selection] : []);
    var selections = rawSelections.map(function (selection) {
      var anchor = selection.anchor || selection.from;
      var head = selection.head || selection.to || anchor;
      return { anchor: anchor, head: head };
    });
    var applied = this._mutate(function (api) { api.applyChanges(changes, selections); });
    if (applied) { return applied; }
    return this._apply('editor.applyChanges', { changes: changes, selections: selections });
  };
  EditorProxy.prototype.wordAt = function (pos) {
    var api = this._local();
    if (!api) { return null; }
    this._sync();
    var offset = posToOffset(this._text, pos);
    var range = api.wordAt(offset);
    if (!range) { return null; }
    return { from: offsetToPos(this._text, range.from), to: offsetToPos(this._text, range.to) };
  };
  EditorProxy.prototype.processLines = function (process) {
    var api = this._local();
    if (!api) { throw new Error('editor.processLines 需要同页编辑器(容器未就绪)'); }
    var changed = api.processLines(process);
    this._sync();
    return changed;
  };

  // ui.placeholder 的真实落点:statusbar 是一枚 .status-bar-item,modal 是一层 .modal-container。
  function placeholderHost() {
    return document.querySelector('.workspace') || document.body;
  }

  function mountStatusBarItem(pluginId, title) {
    var bar = document.querySelector('.status-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'status-bar';
      placeholderHost().appendChild(bar);
    }
    var el = document.createElement('span');
    el.className = 'status-bar-item plugin-status-bar-item';
    el.setAttribute('data-plugin', String(pluginId || ''));
    el.textContent = String(title || '');
    bar.appendChild(el);
    return el;
  }

  function mountModalPlaceholder(modal) {
    var container = document.createElement('div');
    container.className = 'modal-container mod-dim';
    var modalEl = document.createElement('div');
    modalEl.className = 'modal mod-sandbox';
    var closeButton = document.createElement('div');
    closeButton.className = 'modal-close-button';
    closeButton.textContent = '×';
    var titleEl = document.createElement('div');
    titleEl.className = 'modal-title';
    titleEl.textContent = String(modal.titleText || '');
    var contentEl = document.createElement('div');
    contentEl.className = 'modal-content';
    modalEl.appendChild(closeButton);
    modalEl.appendChild(titleEl);
    modalEl.appendChild(contentEl);
    container.appendChild(modalEl);
    closeButton.addEventListener('click', function () { modal.close(); });
    placeholderHost().appendChild(container);
    modal.containerEl = container;
    modal.modalEl = modalEl;
    modal.titleEl = titleEl;
    modal.contentEl = contentEl;
    return container;
  }

  function Notice(message, duration) {
    this.message = typeof message === 'string' ? message : (message && message.textContent) || String(message || '');
    this.duration = typeof duration === 'number' ? duration : 0;
    hostCall('ui.notice', { message: this.message, duration: this.duration }).catch(function () {});
  }
  Notice.prototype.setMessage = function (message) { this.message = String(message); return this; };
  Notice.prototype.hide = function () {};

  function Modal(appRef) {
    this.app = appRef;
    this.titleEl = null; this.contentEl = null; this.modalEl = null; this.containerEl = null;
    this.scope = null;
  }
  Modal.prototype.open = function () {
    var self = this;
    // 宿主登记保留(可见行为不变),同时真的把 DOM 挂上去,onOpen 里的 createEl 才有地方落。
    hostCall('ui.placeholder', { kind: 'modal', title: self.titleText || '' }).catch(function () {});
    mountModalPlaceholder(self);
    self.onOpen && self.onOpen();
  };
  Modal.prototype.close = function () {
    this.onClose && this.onClose();
    if (this.containerEl && this.containerEl.parentNode) { this.containerEl.parentNode.removeChild(this.containerEl); }
    this.containerEl = null;
    this.modalEl = null;
    this.titleEl = null;
    this.contentEl = null;
  };
  Modal.prototype.onOpen = function () {};
  Modal.prototype.onClose = function () {};
  Modal.prototype.setTitle = function (title) { this.titleText = String(title); return this; };
  Modal.prototype.setContent = function (content) { this.contentText = typeof content === 'string' ? content : ''; return this; };

  function Menu() { this.items = []; }
  Menu.prototype.addItem = function (cb) {
    var item = {
      setTitle: function (t) { this.title = t; return this; },
      setIcon: function () { return this; },
      setChecked: function () { return this; },
      setDisabled: function () { return this; },
      setWarning: function () { return this; },
      setIsLabel: function () { return this; },
      onClick: function (cb2) { this.action = cb2; return this; },
      setSection: function () { return this; }
    };
    cb(item);
    this.items.push(item);
    return this;
  };
  Menu.prototype.addSeparator = function () { return this; };
  Menu.prototype.showAtMouseEvent = function () { console.warn('[lexinote] 原生菜单渲染将在后续版本生效'); return this; };
  Menu.prototype.showAtPosition = function () { return this; };
  Menu.prototype.hide = function () { return this; };
  Menu.prototype.close = function () {};
  Menu.prototype.onHide = function () {};

  function ValueStub() { return this; }
  ValueStub.prototype.setValue = function () { return this; };
  ValueStub.prototype.getValue = function () { return ''; };
  ValueStub.prototype.onChange = function () { return this; };

  function Setting(containerEl) { this.containerEl = containerEl; this.components = []; }
  Setting.prototype.setName = function () { return this; };
  Setting.prototype.setDesc = function () { return this; };
  Setting.prototype.setClass = function () { return this; };
  Setting.prototype.setHeading = function () { return this; };
  Setting.prototype.setTooltip = function () { return this; };
  Setting.prototype.setDisabled = function () { return this; };
  Setting.prototype.setErrorMessage = function () { return this; };
  Setting.prototype.addButton = function (cb) { cb(new ValueStub()); this.components.push('button'); return this; };
  Setting.prototype.addExtraButton = function (cb) { cb(new ValueStub()); this.components.push('extra'); return this; };
  Setting.prototype.addToggle = function (cb) { cb(new ValueStub()); this.components.push('toggle'); return this; };
  Setting.prototype.addText = function (cb) { cb(new ValueStub()); this.components.push('text'); return this; };
  Setting.prototype.addTextArea = function (cb) { cb(new ValueStub()); this.components.push('textarea'); return this; };
  Setting.prototype.addDropdown = function (cb) { cb(new ValueStub()); this.components.push('dropdown'); return this; };
  Setting.prototype.addSlider = function (cb) { cb(new ValueStub()); this.components.push('slider'); return this; };
  Setting.prototype.addSearch = function (cb) { cb(new ValueStub()); this.components.push('search'); return this; };
  Setting.prototype.addMomentFormat = function (cb) { cb(new ValueStub()); this.components.push('momentformat'); return this; };
  Setting.prototype.addColorPicker = function (cb) { cb(new ValueStub()); this.components.push('color'); return this; };
  Setting.prototype.addProgressBar = function (cb) { cb(new ValueStub()); this.components.push('progress'); return this; };
  Setting.prototype.addDisplayValue = function (cb) { cb(new ValueStub()); this.components.push('display'); return this; };
  Setting.prototype.addComponent = function (cb) { cb({}); return this; };
  Setting.prototype.then = function (cb) { cb(this); return this; };
  Setting.prototype.clear = function () { this.components = []; return this; };

  function PluginSettingTab(appRef, plugin) {
    this.app = appRef;
    this.plugin = plugin;
    this.containerEl = { createEl: function () { return { appendChild: function () {}, createEl: function () { return {}; } }; }, empty: function () {} };
  }
  PluginSettingTab.prototype.display = function () {};
  PluginSettingTab.prototype.hide = function () {};
  PluginSettingTab.prototype.getSettingDefinitions = function () { return []; };
  PluginSettingTab.prototype.getControlValue = function () { return undefined; };
  PluginSettingTab.prototype.setControlValue = function () {};
  PluginSettingTab.prototype.onSettingsChanged = function () {};

  function SuggestModalShim(appRef) { Modal.call(this, appRef); }
  SuggestModalShim.prototype = Object.create(Modal.prototype);
  function FuzzySuggestModal(appRef) { SuggestModalShim.call(this, appRef); }
  FuzzySuggestModal.prototype = Object.create(SuggestModalShim.prototype);
  FuzzySuggestModal.prototype.getSuggestions = function (query) { return []; };
  FuzzySuggestModal.prototype.renderSuggestion = function () {};
  FuzzySuggestModal.prototype.onChooseSuggestion = function () {};
  FuzzySuggestModal.prototype.getItems = function () { return []; };
  FuzzySuggestModal.prototype.getItemText = function () { return ''; };
  FuzzySuggestModal.prototype.onChooseItem = function () {};

  var MarkdownRenderer = {
    // Obsidian 签名 render(app, markdown, el, sourcePath, component):渲染进 el,resolve 为 undefined。
    render: function (app, markdown, el, sourcePath, component) {
      return renderMarkdownInto(el, markdown, sourcePath);
    },
    // 旧签名 renderMarkdown(markdown, el, sourcePath, component):渲染进 el,resolve 为渲染后的 HTML。
    renderMarkdown: function (markdown, el, sourcePath, component) {
      return renderMarkdownInto(el, markdown, sourcePath).then(function () { return el.innerHTML; });
    }
  };

  // 渲染内核与 shim 同页加载(lexinote_plugin_render.js 是工作区 lexinote_reading.js 的同一份
  // 构建产物),所以这里直接用内核自己的 window.LexiReading:插件页与工作区页是两个 document,
  // 同名不会互相覆盖。惰性取用 —— 顶层不 require,内核缺席时要如实失败而不是启动即炸。
  // 函数声明会被提升,所以渲染方法可以写在它们前面。
  function readingKernel() {
    var kernel = typeof window !== 'undefined' ? window.LexiReading : null;
    if (!kernel || typeof kernel.render !== 'function' || typeof kernel.applyPostProcessors !== 'function') { return null; }
    return kernel;
  }

  // 离屏渲染 -> 按 section fan-out 跑后处理器(与工作区页同一套语义) -> 成品节点搬进 el。
  // 内核造的是游离容器:渲染或后处理器失败时 el 保持原样,不留半截内容。
  function renderMarkdownInto(el, markdown, sourcePath) {
    var kernel = readingKernel();
    if (!kernel) { return Promise.reject(new Error('MarkdownRenderer 需要渲染内核: lexinote_plugin_render.js 未随页面加载')); }
    if (!el || typeof el.appendChild !== 'function') { return Promise.reject(new Error('MarkdownRenderer 的目标元素不可用')); }
    return Promise.resolve().then(function () {
      var rendered = kernel.render(markdown, { sourcePath: sourcePath });
      return Promise.resolve(kernel.applyPostProcessors(rendered.containerEl, {
        sourcePath: sourcePath,
        frontmatter: rendered.frontmatter
      })).then(function () {
        while (el.firstChild) { el.removeChild(el.firstChild); }
        el.appendChild(rendered.containerEl);
      });
    });
  }

  // net.requestUrl 的身份必须显式带上:第三参是"这个 requestUrl 属于哪个插件"的令牌。
  // 不再靠 currentToken() 兜底 —— 异步回调里执行栈早已为空,兜底会退化成会话身份,宿主据此 fail-closed。
  function requestUrlFor(pluginToken) {
    return function requestUrl(param) {
      var spec = typeof param === 'string' ? { url: param } : (param || {});
      var requestPromise = hostCall('net.requestUrl', {
        url: spec.url, method: spec.method || 'GET',
        headers: spec.headers || {}, body: typeof spec.body === 'string' ? spec.body : ''
      }, pluginToken);
      // 恒 reject 的占位 promise 与派生的 .text/.json:失败时插件通常只 await 主体,
      // 这些分支没人接就会变成 unhandledrejection(设备上只留噪音,查不出是谁丢的)。
      var arrayBuffer = Promise.reject(new Error('arrayBuffer 将在后续版本提供'));
      arrayBuffer.catch(function () {});
      var wrapped = requestPromise.then(function (response) {
        var text = response && typeof response.text === 'string' ? response.text : '';
        return {
          status: response ? response.status : 0,
          headers: response ? response.headers : {},
          text: text,
          json: safeParse(text, null),
          arrayBuffer: arrayBuffer
        };
      });
      wrapped.text = requestPromise.then(function (response) { return response && response.text ? response.text : ''; });
      wrapped.text.catch(function () {});
      wrapped.json = requestPromise.then(function (response) {
        var text = response && response.text ? response.text : '';
        return safeParse(text, null);
      });
      wrapped.json.catch(function () {});
      return wrapped;
    };
  }

  // 命名空间上的默认挂载(game 之外的老调用点):没有插件令牌可用,沿用当前执行栈令牌。
  function requestUrl(param) { return requestUrlFor(currentToken())(param); }

  // 插件 require('@codemirror/*') 必须拿到与编辑器同一份实例(两份副本不会报错,
  // 只会让 ViewPlugin/StateField 静默失效),所以按名字从 bundle 注册表取,而不是另起一份。
  function requireShim(name) {
    if (name === 'obsidian' || name === 'lexinote') { return obsidianNamespace; }
    var registry = typeof window !== 'undefined' ? window.__lexiCmModules : null;
    if (registry && Object.prototype.hasOwnProperty.call(registry, name)) { return registry[name]; }
    throw new Error('插件沙箱不支持模块: ' + name + '(依赖请随 main.js 打包)');
  }

  // ---------------------------------------------------------------- plugin loading

  async function loadPlugin(message) {
    var manifest = message.manifest;
    var code = message.code;
    if (!manifest) { throw new Error('插件装载参数不完整'); }
    // 主编辑器叶必须在插件 onload 之前就存在:插件常在这里取 workspace.activeLeaf/MarkdownView。
    mainEditorLeafRef();
    wireEditorActivation();
    if (plugins.has(manifest.id)) { throw new Error('插件已加载: ' + manifest.id); }
    if (typeof code !== 'string' || code.length === 0) {
      // 分片拉取源码:大体积脚本走 runJavaScript 直传会静默挂起
      var size = typeof message.size === 'number' ? message.size : -1;
      var collected = '';
      var offset = 0;
      // 源码分片也只认令牌身份:装载期 currentToken 还是会话令牌,必须显式带本次装载的插件令牌。
      // payload 不再自报 pluginId(宿主会剥掉它并落一行 identity.ignored 审计)。
      var sourceToken = (typeof message.token === 'string' && message.token.length > 0) ? message.token : undefined;
      while (size < 0 || offset < size) {
        var chunk = await hostCall('plugin.sourceChunk', {
          offset: offset, length: 48 * 1024
        }, sourceToken);
        if (typeof chunk !== 'string' || chunk.length === 0) { break; }
        collected += chunk;
        offset += chunk.length;
      }
      code = collected;
      if (!code) { throw new Error('插件源码读取失败: ' + manifest.id); }
      console.log('[lexinote] 插件源码分片加载完成: ' + manifest.id + ' ' + code.length + ' 字符');
    }
    var moduleObj = { exports: {} };
    var factory = new Function('require', 'module', 'exports',
      code + '\n//# sourceURL=lexinote-plugin-' + manifest.id + '.js');
    // 这个插件的 require('obsidian'/'lexinote') 拿到的是同一命名空间的视图,但 requestUrl
    // 绑定到它自己的令牌(原型链,不动命名空间里的 class,也不走 bindApiToken 的 Proxy)。
    var pluginToken = typeof message.token === 'string' ? message.token : '';
    var boundNamespace = null;
    var requireForPlugin = function (name) {
      if ((name === 'obsidian' || name === 'lexinote') && pluginToken.length > 0) {
        if (!boundNamespace) {
          boundNamespace = Object.create(obsidianNamespace);
          boundNamespace.requestUrl = requestUrlFor(pluginToken);
        }
        return boundNamespace;
      }
      return requireShim(name);
    };
    factory(requireForPlugin, moduleObj, moduleObj.exports);
    var exported = moduleObj.exports;
    var Ctor = typeof exported === 'function' ? exported : (exported && typeof exported.default === 'function' ? exported.default : null);
    if (!Ctor) { throw new Error('main.js 必须导出插件类(default)'); }
    // 插件拿到的 app 面按本次装载的令牌包一层,插件里的 app.vault/app.workspace… 调用自带身份。
    var boundApp = bindApiToken(typeof message.token === 'string' ? message.token : '', app);
    var instance = new Ctor(boundApp, manifest);
    if (!(instance instanceof ComponentShim)) {
      // Plugin classes may extend their own base; attach shim lifecycle when missing.
      ComponentShim.call(instance);
      Object.getOwnPropertyNames(ComponentShim.prototype).forEach(function (key) {
        if (key !== 'constructor' && instance[key] === undefined) { instance[key] = ComponentShim.prototype[key]; }
      });
      instance._children = []; instance._cleanups = []; instance._intervals = []; instance._loaded = false;
    }
    // 归属令牌进闭包 WeakMap(P1-006):实例属性形态 = 插件间凭据盗读通道,永久删除。
    setObjectToken(instance, pluginToken);
    // 有的插件在构造函数里自己覆盖 this.app,这里统一覆盖回带身份的 API 面。
    if (boundApp !== app) { instance.app = boundApp; }
    plugins.set(manifest.id, instance);
    await withToken(pluginToken, function () { return instance.load(); });
    await withToken(pluginToken, function () {
      return hostCall('plugin.onload.done', { id: manifest.id });
    });
  }

  async function unloadPlugin(pluginId) {
    var instance = plugins.get(pluginId);
    plugins.delete(pluginId);
    // 扩展卸载必须真撤销:否则插件卸载后它的 ViewPlugin/StateField 还挂在编辑器上。
    editorExtensionsByPlugin.delete(pluginId);
    var unloadApi = editorApi();
    if (unloadApi) { unloadApi.releaseExtensions(pluginId); }
    if (instance) {
      try { instance.unload(); } catch (err) { console.warn('[lexinote] onunload error', err); }
    }
    commandTable.forEach(function (_command, fullId) {
      if (fullId.indexOf(pluginId + ':') === 0) { commandTable.delete(fullId); }
    });
    await hostCall('plugin.unload.done', { id: pluginId });
  }

  window.lexiRuntime = {
    __receive: function (method, payloadJson) {
      var message = safeParse(payloadJson || '{}', {});
      if (method === 'event') { dispatchHostEvent(message); return; }
      if (method === 'invoke.command') {
        var command = commandTable.get(message.fullId);
        if (command) {
          var commandToken = tokenForPluginId(String(message.fullId || '').split(':')[0]);
          Promise.resolve().then(function () {
            return withToken(commandToken, function () {
              if (command.checkCallback && !command.checkCallback(false)) { return; }
              if (command.callback) { return command.callback(); }
            });
          }).catch(function (err) {
            console.warn('[lexinote] 命令执行失败', err);
            hostCall('ui.notice', { message: '插件命令出错: ' + (err && err.message ? err.message : String(err)) }).catch(function () {});
          });
        }
        return;
      }
      if (method === 'invoke.editorCommand') {
        acceptEditorState(message.editor);
        var editorCommand = commandTable.get(message.fullId);
        if (editorCommand && typeof editorCommand.editorCallback === 'function') {
          var editor = new EditorProxy(message.editor || {}, commandToken);
          var ctx = { app: app, file: null, editor: editor };
          Promise.resolve().then(function () {
            return editorCommand.editorCallback(editor, ctx);
          }).catch(function (err) { console.warn('[lexinote] 编辑器命令执行失败', err); });
        }
        return;
      }
      if (method === 'load.plugin') {
        loadPlugin(message).catch(function (err) {
          console.warn('[lexinote] onload error', err);
          hostCall('plugin.onload.error', { id: message.manifest ? message.manifest.id : '', error: String(err) }).catch(function () {});
        });
        return;
      }
      if (method === 'invoke.ribbon') {
        var ribbon = ribbonTable.get(message.pluginId + ':' + message.title);
        if (typeof ribbon === 'function') {
          Promise.resolve().then(function () { return ribbon(new MouseEvent('click')); }).catch(function (err) {
            console.warn('[lexinote] Ribbon 回调失败', err);
          });
        }
        return;
      }
      if (method === 'settings.values') {
        var pluginInstance = plugins.get(message.pluginId);
        var tab = pluginInstance && pluginInstance._settingTab;
        if (tab && message.values && typeof message.values === 'object') {
          try {
            Object.keys(message.values).forEach(function (key) {
              if (typeof tab.setControlValue === 'function') { tab.setControlValue(key, message.values[key]); }
            });
            if (typeof tab.onSettingsChanged === 'function') { tab.onSettingsChanged(message.values); }
          } catch (err) { console.warn('[lexinote] 设置回写失败', err); }
        }
        return;
      }
      if (method === 'unload.plugin') {
        unloadPlugin(message.id).catch(function (err) {
          hostCall('plugin.unload.done', { id: message.id, error: String(err) }).catch(function () {});
        });
        return;
      }
    }
  };

  // Obsidian 的 View/ItemView 是真 DOM 组件:registerView 的 creator 返回的就是它们,
  // 由 WorkspaceLeaf.setViewState 挂进容器 DOM。
  function ViewShim(leaf) {
    ComponentShim.call(this);
    this.app = app;
    this.leaf = leaf || null;
    this.containerEl = document.createElement('div');
    this.containerEl.className = 'view-content';
    this.scope = null;
    this.navigation = false;
    this.actions = [];
  }
  ViewShim.prototype = Object.create(ComponentShim.prototype);
  ViewShim.prototype.constructor = ViewShim;
  ViewShim.prototype.getViewType = function () { return ''; };
  ViewShim.prototype.getDisplayText = function () { return this.getViewType() || '插件视图'; };
  ViewShim.prototype.getIcon = function () { return ''; };
  ViewShim.prototype.onOpen = function () { return Promise.resolve(); };
  ViewShim.prototype.onClose = function () { return Promise.resolve(); };
  ViewShim.prototype.addAction = function (icon, title, callback) {
    var action = { icon: icon, title: title, callback: callback };
    this.actions.push(action);
    return action;
  };

  function ItemViewShim(leaf) {
    ViewShim.call(this, leaf);
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'view-body markdown-preview-view markdown-rendered';
    this.containerEl.appendChild(this.contentEl);
  }
  ItemViewShim.prototype = Object.create(ViewShim.prototype);
  ItemViewShim.prototype.constructor = ItemViewShim;

  // 插件大量使用 `x instanceof Y` 做类型判定;Y 是 undefined 会直接抛
  // "Right-hand side of 'instanceof' is not an object"(obsidian-pangu 就是这样挂的)。
  // 这里给官方 d.ts 里被 instanceof 的类各一个真构造函数。
  function stubClass(name) {
    var stub = function () {};
    try { Object.defineProperty(stub, 'name', { value: name }); } catch (err) { /* ES5 环境忽略 */ }
    return stub;
  }

  function FileViewShim(leaf) { ViewShim.call(this, leaf); this.file = null; }
  FileViewShim.prototype = Object.create(ViewShim.prototype);
  FileViewShim.prototype.constructor = FileViewShim;

  function MarkdownViewShim(leaf) { FileViewShim.call(this, leaf); this.editor = null; this.previewMode = null; }
  // CM6 主编辑器在容器里就是一个 markdown 视图:插件(obsidian-outliner 等)通过
  // app.workspace.getActiveViewOfType(MarkdownView).editor 取编辑器,这条路径必须是真的。
  function markdownViewFor(leaf) {
    var view = new MarkdownViewShim(leaf);
    view.editor = new EditorProxy({}, currentToken());
    view.getViewType = function () { return 'markdown'; };
    view.getDisplayText = function () { return '编辑'; };
    return view;
  }

  // 主编辑区叶:不参与 revealActiveLeaf 的显隐切换(它永远在页面上),但参与 activeLeaf 语义。
  function createMarkdownLeaf() {
    var leaf = {
      __viewType: 'markdown',
      __viewState: { type: 'markdown' },
      __isMainEditor: true,
      view: null,
      app: null,
      getViewState: function () { return leaf.__viewState; },
      setViewState: function (state) { leaf.__viewState = state || { type: 'markdown' }; return Promise.resolve(); },
      openFile: function (file) { return workspace.openLinkText(file && file.path ? file.path : '', ''); },
      detach: function () { return Promise.resolve(); },
      getDisplayText: function () { return '编辑'; },
      getIcon: function () { return 'pencil'; }
    };
    leaf.app = app;
    leaf.view = markdownViewFor(leaf);
    return leaf;
  }
  MarkdownViewShim.prototype = Object.create(FileViewShim.prototype);
  MarkdownViewShim.prototype.constructor = MarkdownViewShim;

  // Obsidian 导出 Vault.recurseChildren 这个静态助手,插件直接 obsidian.Vault.recurseChildren(root, cb) 递归遍历。
  function recurseChildren(root, callback) {
    var walk = function (node) {
      if (!node) { return; }
      var children = node.children || [];
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child instanceof TFolder) {
          if (callback(child) === false) { return; }
          walk(child);
        } else if (callback(child) === false) {
          return;
        }
      }
    };
    walk(root);
  }

  // 静态助手挂在命名空间的 Vault 类上:plugin 写 obsidian.Vault.recurseChildren(root, cb)。
  function vaultNamespaceClass() {
    var klass = stubClass('Vault');
    klass.recurseChildren = recurseChildren;
    return klass;
  }

  var obsidianNamespace = {
    apiVersion: API_VERSION,
    // Obsidian 的 editorInfoField 由页面 bundle 创建(同一个 @codemirror/state 实例);取不到时给 undefined。
    get editorInfoField() { return window.__lexiEditorInfoField || undefined; },
    MarkdownView: MarkdownViewShim,
    FileView: FileViewShim,
    Editor: EditorProxy,
    Workspace: stubClass('Workspace'),
    WorkspaceLeaf: stubClass('WorkspaceLeaf'),
    WorkspaceSplit: stubClass('WorkspaceSplit'),
    WorkspaceItem: stubClass('WorkspaceItem'),
    WorkspaceTabs: stubClass('WorkspaceTabs'),
    WorkspaceRibbon: stubClass('WorkspaceRibbon'),
    Vault: vaultNamespaceClass(),
    MetadataCache: stubClass('MetadataCache'),
    FileManager: stubClass('FileManager'),
    DataAdapter: stubClass('DataAdapter'),
    ButtonComponent: stubClass('ButtonComponent'),
    TextComponent: stubClass('TextComponent'),
    TextAreaComponent: stubClass('TextAreaComponent'),
    ToggleComponent: stubClass('ToggleComponent'),
    DropdownComponent: stubClass('DropdownComponent'),
    ColorComponent: stubClass('ColorComponent'),
    SliderComponent: stubClass('SliderComponent'),
    ExtraButtonComponent: stubClass('ExtraButtonComponent'),
    SearchComponent: stubClass('SearchComponent'),
    ProgressBarComponent: stubClass('ProgressBarComponent'),
    HoverPopover: stubClass('HoverPopover'),
    PopoverSuggest: stubClass('PopoverSuggest'),
    MarkdownEditView: stubClass('MarkdownEditView'),
    MarkdownPreviewView: stubClass('MarkdownPreviewView'),
    FileSystemAdapter: stubClass('FileSystemAdapter'),
    SecretStorage: stubClass('SecretStorage'),
    Platform: Platform,
    moment: moment,
    normalizePath: normalizePath,
    requestUrl: requestUrl,
    requestUrlPrompt: null,
    App: function App() {},
    Component: ComponentShim,
    Plugin: PluginShim,
    PluginManifest: function PluginManifest() {},
    TAbstractFile: LexiFileData,
    TFile: TFile,
    TFolder: TFolder,
    Notice: Notice,
    Modal: Modal,
    Menu: Menu,
    MenuItem: function MenuItem() {},
    Setting: Setting,
    PluginSettingTab: PluginSettingTab,
    SettingTab: function SettingTab() {},
    SuggestModal: SuggestModalShim,
    FuzzySuggestModal: FuzzySuggestModal,
    AbstractInputSuggest: SuggestModalShim,
    MarkdownRenderer: MarkdownRenderer,
    sanitizeHTMLToDom: function (html) {
      // M2-B(Tasks 依赖):页面侧 DOM 解析注入文档片段;不取远程资源,由 CSP connect-src none 兜底。
      var doc = new DOMParser().parseFromString(String(html === undefined ? '' : html), 'text/html');
      var fragment = document.createDocumentFragment();
      while (doc.body && doc.body.firstChild) { fragment.appendChild(doc.body.firstChild); }
      return fragment;
    },
    MarkdownRenderChild: ComponentShim,
    Events: LocalEmitter,
    Scope: function Scope() {},
    Keymap: { isModifier: function () { return false; } },
    ItemView: ItemViewShim,
    View: ViewShim,
    addIcon: function (iconId, svgContent) {
      // 同步栈捕获调用方令牌:归属登记(ui.addIcon 防跨插件覆盖)只认真实身份。
      var addIconToken = currentToken();
      hostCall('ui.addIcon', { iconId: String(iconId), svgContent: String(svgContent) }, addIconToken).catch(function (err) {
        console.warn('[lexinote] 图标注册失败', err);
      });
    },
    setIcon: function () {},
    prepareFuzzySearch: function (query) {
      var needle = String(query).toLowerCase();
      return function (text) {
        var haystack = String(text).toLowerCase();
        var index = haystack.indexOf(needle);
        if (index < 0) { return null; }
        return { score: index, matches: [[index, index + needle.length]] };
      };
    },
    prepareSimpleSearch: function (query) {
      return obsidianNamespace.prepareFuzzySearch(query);
    },
    debounce: function (cb, timeout) {
      var timer = null;
      var debounced = function () {
        // 接收者必须跟着回调走:obsidian.debounce(fn) 等价于 fn.apply(调用时的 this, args)。
        // 插件写 obsidian.debounce(this.updateSettings, 500)(不 bind),丢 this 就是 "reading 'settings' of null"。
        var self = this;
        var args = Array.prototype.slice.call(arguments);
        if (timer !== null) { clearTimeout(timer); }
        timer = setTimeout(function () { timer = null; cb.apply(self, args); }, timeout || 0);
      };
      debounced.cancel = function () { if (timer !== null) { clearTimeout(timer); timer = null; } };
      debounced.run = function () {};
      return debounced;
    },
    sleep: function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  };

  // 工作区容器与旧插件视图页共用这一个入口:容器先把端口传输接成 window.lexiHost,
  // 之后只通过 LexiObsidian 装载/驱动真正的 obsidian 插件。
  window.LexiObsidian = {
    apiVersion: API_VERSION,
    namespace: obsidianNamespace,
    setSessionToken: function (token) {
      sessionToken = typeof token === 'string' ? token : '';
      // 门禁锚点:插件 shim 这才是会话身份的落点,只打尾部 6 位(可对账,不足以被复用)。
      console.log('[lexinote] session.token tail=' + (sessionToken.length > 0 ? sessionToken.slice(-6) : 'none'));
    },
    // 会话令牌只进不出(RFC §3.4):容器经 setSessionToken 单向注入,页面内代码
    // (含插件)没有读回通道。P1-006 收口:currentToken/withToken/hostCall 三个别名
    // 已从本面删除(容器 bundle 实测零消费,见 plugin-bridge-security R6)——
    // 此前插件可借这三者读裸会话令牌、手工压栈、直调控制面方法(如 note.write)。
    // 插件身份通道 = bindApiToken 包裹的 app API 面,不再有任何手工入口。
    loadPlugin: loadPlugin,
    unloadPlugin: unloadPlugin,
    hasPlugin: function (pluginId) { return plugins.has(pluginId); },
    commands: function () {
      var list = [];
      commandTable.forEach(function (command, fullId) {
        list.push({ fullId: fullId, id: command.id, name: command.name || command.id, pluginId: String(fullId).split(':')[0] });
      });
      return list;
    },
    runCommand: function (fullId) {
      var command = commandTable.get(fullId);
      if (!command) { return Promise.reject(new Error('未知命令: ' + fullId)); }
      return withToken(tokenForPluginId(String(fullId).split(':')[0]), function () {
        if (command.checkCallback && !command.checkCallback(false)) { return false; }
        if (command.callback) { return command.callback(); }
        return true;
      });
    },
    refreshMetadataGraph: refreshMetadataGraph,
    // 编辑器面(容器内唯一执行面):扩展能装能撤,恒等断言给门禁用。
    editorIdentity: function () { var api = editorApi(); return api ? api.identity() : null; },
  // editorInfoField 的值需要当前 Editor:主编辑器常开,取它的 editor 代理。
  currentEditor: function () { return mainEditorLeafRef().view.editor; },
    editorExtensionCount: function (pluginId) { var api = editorApi(); return api ? api.extensionCount(pluginId) : 0; },
    releaseEditorExtensions: function (pluginId) {
      editorExtensionsByPlugin.delete(pluginId);
      var api = editorApi();
      return api ? api.releaseExtensions(pluginId) : 0;
    },
    markdownLeaf: function () { return mainEditorLeafRef(); },
    activateMainEditor: function () { return activateMainEditor(); },
    // 布局键(去掉 active/pinned/group):门禁据此断言同一视图不重复。
    layoutKeys: function () {
      var keys = [];
      for (var i = 0; i < openLeaves.length; i++) {
        var leaf = openLeaves[i];
        if (!leaf || !leaf.__viewType) { continue; }
        keys.push(layoutStateKey(leaf.__viewType, leaf.__viewState || {}));
      }
      return keys;
    },
    refreshVaultFiles: refreshVaultFiles,
    // 重启后回放布局:凡是本页注册过 creator 的视图类型都按上次的 state 重新打开。
    restoreLayout: function () {
      // 容器管理面:显式会话凭据,不靠 currentToken 兜底(P1-006)。
      return hostCall('workspace.loadLayout', {}, sessionToken).then(function (layout) {
        var leaves = layout && Array.isArray(layout.leaves) ? layout.leaves : [];
        var restored = 0;
        // 同一个 (type, 非 active 的 state) 只恢复一次:否则每启动一次就多出一份重复 leaf,
        // 布局文件无限膨胀(实测 1→3→4 个 leaf 逐轮递增)。多 tab 只要 state 不同仍各自恢复。
        var seenLayout = {};
        // 已经开着的叶也算占位:插件 onload 里自己打开的视图若不占位,恢复时会再开一份同视图。
        var openLeavesNow = openLeaves.slice();
        for (var k = 0; k < openLeavesNow.length; k++) {
          var openLeaf = openLeavesNow[k];
          if (!openLeaf || !openLeaf.__viewType || openLeaf.__isMainEditor === true) { continue; }
          seenLayout[layoutStateKey(openLeaf.__viewType, openLeaf.__viewState || {})] = true;
        }
        for (var i = 0; i < leaves.length; i++) {
          var entry = leaves[i];
          if (!entry || !entry.type || !viewCreators.has(entry.type)) { continue; }
          // 去重键只用视图状态:active/pinned/group 是布局属性(每次都会变),
          // 把它们算进去会让同一视图每重启一次多出一份(实测 1→3→4 逐轮膨胀)。
          var stateKey = layoutStateKey(entry.type, entry.state);
          if (seenLayout[stateKey] === true) { continue; }
          seenLayout[stateKey] = true;
          var leaf = makePluginLeaf(entry.type);
          // P1-006:恢复路径是容器管理动作——leaf 归属令牌显式记会话凭据
          //(makePluginLeaf 现场捕获此时为空栈,若不覆写则 openView/closeView 匿名 fail-closed)。
          setObjectToken(leaf, sessionToken);
          leaf.setViewState(Object.assign({}, entry.state || {}, {
            type: entry.type,
            active: i === (layout.activeIndex === undefined ? -1 : layout.activeIndex)
          }));
          restored += 1;
        }
        if (restored > 0) { console.log('[lexinote] 布局恢复: leaves=' + restored + ' source=' + JSON.stringify(layout)); }
        // 恢复结束后才允许落盘(两条分支都要开,否则首次启动永远存不下布局)。
        layoutPersistEnabled = true;
        if (restored > 0) { schedulePersistLayout(); }
        return restored;
      }, function () { layoutPersistEnabled = true; return 0; });
    },
    saveLayout: function () { return hostCall('workspace.saveLayout', { layout: layoutSnapshot() }, sessionToken); },
    layout: layoutSnapshot,
    markLayoutReady: function () { return hostCall('workspace.layoutReady', {}, sessionToken); },
    dispatchEvent: dispatchHostEvent,
    leavesOfType: function (type) {
      return openLeaves.filter(function (leaf) { return leaf.__viewType === type; });
    },
    viewTypes: function () { return Array.from(viewCreators.keys()); },
    metadataCache: function (path) { return requestMetadata(path); },
    stats: function () {
      return {
        pluginCount: plugins.size,
        commandCount: commandTable.size,
        viewTypes: Array.from(viewCreators.keys()),
        leaves: openLeaves.length,
        sessionTokenTail: sessionToken.slice(-6)
      };
    }
  };

  // 门禁锚点:同一个 shim 被两条挂载路由共用,只有 location 能证明"当前是哪条路由在服务"。
  console.log('[lexinote] runtime.page ' + (typeof location !== 'undefined' && location ? location.href : 'unknown'));
  console.log('[lexinote] session.token tail=' + (sessionToken.length > 0 ? sessionToken.slice(-6) : 'none'));
  hostCall('runtime.ready', {}).catch(function () { /* retried via host queue once lexiHost appears */ });
  whenHostReady();
})();
