/*
 * LexiNote plugin VIEW runtime (one instance per plugin view tab).
 * Runs inside a visible ArkWeb slot: real DOM, plugin styles.css, Obsidian-style
 * DOM helpers, ItemView lifecycle. Core data APIs are proxied over the same
 * lexiHost RPC protocol used by the headless kernel.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------ bridge (host RPC)

  var callSeq = 0;
  var pendingCalls = new Map();
  var hostQueue = [];

  function settle(callId, raw) {
    var entry = pendingCalls.get(callId);
    if (!entry) { return; }
    pendingCalls.delete(callId);
    var message = null;
    try { message = JSON.parse(raw); } catch (err) { message = null; }
    if (!message) { entry.reject(new Error('插件视图桥返回了无效数据')); return; }
    if (message.ok) { entry.resolve(message.result); } else { entry.reject(new Error(message.error || '插件视图桥调用失败')); }
  }

  function flushHost() {
    var queue = hostQueue; hostQueue = [];
    for (var i = 0; i < queue.length; i++) { queue[i](); }
  }

  function whenHostReady() {
    if (window.lexiHost) { flushHost(); return; }
    var timer = setInterval(function () {
      if (window.lexiHost) { clearInterval(timer); flushHost(); }
    }, 40);
  }

  function hostCall(method, payload) {
    return new Promise(function (resolve, reject) {
      var callId = 'v' + (++callSeq);
      pendingCalls.set(callId, { resolve: resolve, reject: reject });
      var dispatch = function () {
        try {
          var raw = JSON.stringify(payload === undefined || payload === null ? {} : payload);
          var outcome = window.lexiHost.call(callId, method, raw);
          if (outcome && typeof outcome.then === 'function') {
            outcome.then(function (result) { settle(callId, result); }, function (err) { pendingCalls.delete(callId); reject(err); });
          }
        } catch (err) { pendingCalls.delete(callId); reject(err); }
      };
      if (window.lexiHost) { dispatch(); } else { hostQueue.push(dispatch); }
    });
  }

  // ------------------------------------------------------------ theme + Obsidian DOM helpers

  var THEME_CSS = ':root{' +
    '--background-primary:#F6F4FB;--background-primary-alt:#F1EEFA;' +
    '--background-secondary:#FFFFFF;--background-modifier-border:#E4DFF2;' +
    '--text-normal:#231B36;--text-muted:#6F6880;--text-faint:#9A94A8;' +
    '--interactive-accent:#6D4AFF;--interactive-accent-hover:#5B3AE6;' +
    '--text-on-accent:#FFFFFF;--radius-s:6px;--radius-m:10px;--radius-l:14px;' +
    '--font-text:system-ui,-apple-system,"HarmonyOS Sans",sans-serif;' +
    '}' +
    '@media (prefers-color-scheme: dark){:root{' +
    '--background-primary:#12131B;--background-primary-alt:#191A24;' +
    '--background-secondary:#1D1E2A;--background-modifier-border:#2B2C3B;' +
    '--text-normal:#F5F3FB;--text-muted:#A9A3B8;--text-faint:#7C7690;' +
    '--interactive-accent:#8B6BFF;--interactive-accent-hover:#9C80FF;--text-on-accent:#FFFFFF;}}' +
    'body{margin:0;padding:0;background:var(--background-primary);color:var(--text-normal);' +
    'font-family:var(--font-text);font-size:15px;line-height:1.55;-webkit-user-select:text;}' +
    '.lexinote-view-container{box-sizing:border-box;height:100vh;padding:20px 24px;overflow:auto;}' +
    '.lexinote-view-content{max-width:980px;margin:0 auto;}' +
    '.lexinote-view-content h1,.lexinote-view-content h2,.lexinote-view-content h3{font-weight:600;margin:0 0 12px;}' +
    '.lexinote-view-content button,.lexinote-view-content input,.lexinote-view-content select{' +
    'font-family:inherit;font-size:14px;}\n';

  function applyStyles(pluginCss) {
    var style = document.createElement('style');
    style.setAttribute('data-lexinote', 'theme');
    style.textContent = THEME_CSS + (pluginCss || '');
    document.head.appendChild(style);
  }

  function installDomHelpers() {
    var NodeProto = Node.prototype;
    var ElementProto = Element.prototype;
    var HTMLElementProto = HTMLElement.prototype;

    function applyInfo(el, o) {
      if (!o) { return; }
      if (typeof o === 'string') { el.className = o; return; }
      if (o.cls) { el.className = Array.isArray(o.cls) ? o.cls.join(' ') : String(o.cls); }
      if (o.text !== undefined && o.text !== null) { el.textContent = String(o.text); }
      if (o.title) { el.setAttribute('title', String(o.title)); }
      if (o.placeholder) { el.setAttribute('placeholder', String(o.placeholder)); }
      if (o.href) { el.setAttribute('href', String(o.href)); }
      if (o.value !== undefined) { el.setAttribute('value', String(o.value)); }
      if (o.attr) {
        Object.keys(o.attr).forEach(function (key) { el.setAttribute(key, String(o.attr[key])); });
      }
    }

    NodeProto.createEl = function (tag, o, cb) {
      var el = document.createElement(tag);
      applyInfo(el, o);
      if (this.appendChild) { this.appendChild(el); }
      if (typeof cb === 'function') { cb(el); }
      return el;
    };
    NodeProto.createDiv = function (o, cb) { return this.createEl('div', o, cb); };
    NodeProto.createSpan = function (o, cb) { return this.createEl('span', o, cb); };
    NodeProto.appendText = function (text) {
      this.appendChild(document.createTextNode(String(text)));
    };
    NodeProto.detach = function () { if (this.parentNode) { this.parentNode.removeChild(this); } };
    NodeProto.empty = function () { while (this.firstChild) { this.removeChild(this.firstChild); } };
    NodeProto.setChildrenInPlace = function (children) {
      this.empty();
      for (var i = 0; i < children.length; i++) { this.appendChild(children[i]); }
    };

    ElementProto.getText = function () { return this.textContent || ''; };
    ElementProto.setText = function (value) { this.textContent = String(value); };
    ElementProto.addClass = function () {
      var classes = Array.prototype.slice.call(arguments);
      this.classList.add.apply(this.classList, classes);
    };
    ElementProto.addClasses = function (classes) {
      this.classList.add.apply(this.classList, classes);
    };
    ElementProto.removeClass = function () {
      var classes = Array.prototype.slice.call(arguments);
      this.classList.remove.apply(this.classList, classes);
    };
    ElementProto.removeClasses = function (classes) {
      this.classList.remove.apply(this.classList, classes);
    };
    ElementProto.toggleClass = function (classes, value) {
      var list = Array.isArray(classes) ? classes : [classes];
      for (var i = 0; i < list.length; i++) { this.classList.toggle(list[i], value); }
    };
    ElementProto.hasClass = function (cls) { return this.classList.contains(cls); };
    ElementProto.setAttr = function (name, value) {
      if (value === null || value === undefined) { this.removeAttribute(name); }
      else { this.setAttribute(name, String(value)); }
    };
    ElementProto.setAttrs = function (attrs) {
      var self = this;
      Object.keys(attrs).forEach(function (key) { self.setAttr(key, attrs[key]); });
    };
    ElementProto.getAttr = function (name) { return this.getAttribute(name); };

    HTMLElementProto.show = function () { this.style.display = ''; };
    HTMLElementProto.hide = function () { this.style.display = 'none'; };
    HTMLElementProto.toggle = function (show) { this.style.display = show ? '' : 'none'; };
    HTMLElementProto.setCssStyles = function (styles) {
      var self = this;
      Object.keys(styles).forEach(function (key) { self.style[key] = styles[key]; });
    };
    HTMLElementProto.setCssProps = function (props) {
      var self = this;
      Object.keys(props).forEach(function (key) { self.style.setProperty(key, props[key]); });
    };
    HTMLElementProto.onClickEvent = function (listener) {
      this.addEventListener('click', listener);
      return this;
    };

    function delegatedOn(type, selector, listener) {
      var self = this;
      var handler = function (event) {
        var target = event.target;
        while (target && target !== self) {
          if (target.matches && target.matches(selector)) { listener.call(self, event, target); return; }
          target = target.parentElement;
        }
      };
      self.addEventListener(type, handler);
      self.__delegated = self.__delegated || [];
      self.__delegated.push({ type: type, handler: handler });
    }
    HTMLElementProto.on = function (type, selector, listener) { delegatedOn.call(this, type, selector, listener); };
    HTMLElementProto.trigger = function (type) { this.dispatchEvent(new Event(type)); };

    // Obsidian global helpers
    window.createEl = function (tag, o, cb) { return document.body.createEl(tag, o, cb); };
    window.createDiv = function (o, cb) { return document.body.createDiv(o, cb); };
    window.createSpan = function (o, cb) { return document.body.createSpan(o, cb); };
    window.createFragment = function (cb) {
      var fragment = document.createDocumentFragment();
      if (typeof cb === 'function') { cb(fragment); }
      return fragment;
    };
    window.fish = function (selector) { return document.querySelector(selector); };
    window.fishAll = function (selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); };
    window.activeDocument = document;
    window.activeWindow = window;
  }

  // ------------------------------------------------------------ minimal API surface

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
  ComponentShim.prototype.register = function (cleanup) { this._cleanups.push(cleanup); };
  ComponentShim.prototype.registerEvent = function (ref) {
    if (ref && typeof ref.off === 'function') { this._cleanups.push(function () { ref.off(); }); }
  };
  ComponentShim.prototype.registerDomEvent = function (el, type, callback, options) {
    if (el && el.addEventListener) {
      el.addEventListener(type, callback, options);
      this._cleanups.push(function () { el.removeEventListener(type, callback, options); });
    }
  };
  ComponentShim.prototype.registerInterval = function (id) { this._intervals.push(id); return id; };
  ComponentShim.prototype.addChild = function (child) {
    this._children.push(child);
    if (this._loaded) { child.load(); }
    return child;
  };

  function ItemViewShim(leaf) {
    ComponentShim.call(this);
    this.leaf = leaf || {};
    this.app = appRef;
    this.containerEl = document.createElement('div');
    this.containerEl.className = 'lexinote-view-container';
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'lexinote-view-content';
    this.containerEl.appendChild(this.contentEl);
  }
  ItemViewShim.prototype = Object.create(ComponentShim.prototype);
  ItemViewShim.prototype.constructor = ItemViewShim;
  ItemViewShim.prototype.getViewType = function () { return ''; };
  ItemViewShim.prototype.getDisplayText = function () { return '插件视图'; };
  ItemViewShim.prototype.getIcon = function () { return ''; };
  ItemViewShim.prototype.onOpen = function () {};
  ItemViewShim.prototype.onClose = function () {};

  function PluginViewShim(appValue, manifest) {
    ComponentShim.call(this);
    this.app = appValue;
    this.manifest = manifest;
    this._viewCreators = new Map();
  }
  PluginViewShim.prototype = Object.create(ComponentShim.prototype);
  PluginViewShim.prototype.constructor = PluginViewShim;
  PluginViewShim.prototype.registerView = function (type, creator) { this._viewCreators.set(type, creator); };
  PluginViewShim.prototype.addCommand = function () { return null; };
  PluginViewShim.prototype.addRibbonIcon = function () { return null; };
  PluginViewShim.prototype.addStatusBarItem = function () { return { setText: function () {} }; };
  PluginViewShim.prototype.addSettingTab = function () {};
  PluginViewShim.prototype.registerMarkdownPostProcessor = function () {};
  PluginViewShim.prototype.registerMarkdownCodeBlockProcessor = function () {};
  PluginViewShim.prototype.registerEditorSuggest = function () {};
  PluginViewShim.prototype.loadData = function () { return hostCall('data.load', { pluginId: this.manifest.id }).then(function (raw) { try { return raw === null ? null : JSON.parse(raw); } catch (e) { return null; } }); };
  PluginViewShim.prototype.saveData = function (data) { return hostCall('data.save', { pluginId: this.manifest.id, dataJson: JSON.stringify(data) }); };

  function Notice(message) {
    hostCall('ui.notice', { message: typeof message === 'string' ? message : String(message) }).catch(function () {});
  }
  Notice.prototype.setMessage = function () { return this; };
  Notice.prototype.hide = function () {};

  function makeLocalEmitter() {
    var handlers = new Map();
    return {
      on: function (name, cb) {
        var bucket = handlers.get(name);
        if (!bucket) { bucket = []; handlers.set(name, bucket); }
        bucket.push(cb);
        return { off: function () { var i = bucket.indexOf(cb); if (i >= 0) { bucket.splice(i, 1); } } };
      },
      off: function (name, cb) {
        var bucket = handlers.get(name);
        if (bucket) { var i = bucket.indexOf(cb); if (i >= 0) { bucket.splice(i, 1); } }
      },
      trigger: function (name, payload) {
        var bucket = handlers.get(name);
        if (bucket) { bucket.slice().forEach(function (cb) { cb(payload); }); }
      }
    };
  }

  // vault/metadata proxies: views may read data; events stay local to the slot
  var viewVaultEvents = makeLocalEmitter();
  var viewVault = {
    on: function (name, cb) { return viewVaultEvents.on(name, cb); },
    off: function (name, cb) { viewVaultEvents.off(name, cb); },
    getMarkdownFiles: function () { return hostCall('vault.files', {}); },
    getAbstractFileByPath: function (path) { return hostCall('vault.getByPath', { path: path }); },
    read: function (file) { return hostCall('vault.read', { path: file.path }); },
    cachedRead: function (file) { return viewVault.read(file); },
    modify: function (file, data) { return hostCall('vault.modify', { path: file.path, data: data }); },
    create: function (path, data) { return hostCall('vault.create', { path: path, data: data }); },
    append: function (file, data) { return hostCall('vault.append', { path: file.path, data: data }); },
    process: function (file, fn) {
      return viewVault.read(file).then(function (content) {
        var next = fn(content);
        if (next === content) { return next; }
        return viewVault.modify(file, next).then(function () { return next; });
      });
    },
    delete: function (file, force) { return hostCall('vault.delete', { path: file.path, force: !!force }); }
  };
  var viewMetadata = {
    on: function () { return { off: function () {} }; },
    off: function () {},
    getFileCache: function (file) { return hostCall('metadata.get', { path: file.path }); },
    getCache: function (path) { return hostCall('metadata.get', { path: path }); },
    getFirstLinkpathDest: function (linkpath, sourcePath) { return hostCall('metadata.firstLink', { linkpath: linkpath, sourcePath: sourcePath }); }
  };
  var viewWorkspace = {
    on: function (name, cb) { return makeLocalEmitter().on(name, cb); },
    off: function () {},
    getActiveFile: function () { return Promise.resolve(null); },
    getLeavesOfType: function () { return Promise.resolve([]); },
    detachLeavesOfType: function () { return Promise.resolve(); }
  };
  var appRef = {
    vault: viewVault,
    metadataCache: viewMetadata,
    workspace: viewWorkspace,
    isDarkMode: function () { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }
  };

  var viewNamespace = {
    Platform: { isMobile: true, isPhone: true, isDesktop: false, isMobileApp: true },
    Component: ComponentShim,
    Plugin: PluginViewShim,
    ItemView: ItemViewShim,
    View: ItemViewShim,
    Notice: Notice,
    PluginManifest: function () {},
    TAbstractFile: function () {},
    TFile: function () {},
    TFolder: function () {},
    Events: function () {},
    Setting: function () { return this; },
    MarkdownRenderer: { render: function () { return Promise.resolve(); }, renderMarkdown: function () { return Promise.resolve(); } }
  };
  viewNamespace.Setting.prototype.setName = function () { return this; };
  viewNamespace.Setting.prototype.setDesc = function () { return this; };
  viewNamespace.Setting.prototype.addButton = function (cb) { cb({ setButtonText: function () { return this; }, onClick: function () { return this; } }); return this; };

  function requireShim(name) {
    if (name === 'obsidian' || name === 'lexinote') { return viewNamespace; }
    throw new Error('插件视图沙箱不支持模块: ' + name);
  }

  // ------------------------------------------------------------ boot

  var booted = false;

  window.lexinoteView = {
    boot: function (payloadJson) {
      if (booted) { return; }
      booted = true;
      var payload = null;
      try { payload = JSON.parse(payloadJson); } catch (err) { payload = null; }
      if (!payload || !payload.code) {
        document.body.textContent = '插件视图启动参数缺失';
        return;
      }
      var manifest = null;
      try { manifest = JSON.parse(payload.manifestJson); } catch (err) { manifest = { id: 'unknown', name: 'Plugin' }; }
      applyStyles(payload.stylesCss || '');
      installDomHelpers();
      try {
        var moduleObj = { exports: {} };
        var factory = new Function('require', 'module', 'exports',
          payload.code + '\n//# sourceURL=lexinote-view-' + manifest.id + '.js');
        factory(requireShim, moduleObj, moduleObj.exports);
        var exported = moduleObj.exports;
        var Ctor = typeof exported === 'function' ? exported : (exported && typeof exported.default === 'function' ? exported.default : null);
        if (!Ctor) { throw new Error('main.js 必须导出插件类'); }
        var plugin = new Ctor(appRef, manifest);
        Promise.resolve(plugin.load ? plugin.load() : plugin.onload && plugin.onload()).then(function () {
          var creator = plugin._viewCreators.get(payload.viewType);
          if (!creator) { throw new Error('插件未注册视图: ' + payload.viewType); }
          var leaf = { view: null, getViewState: function () { return { type: payload.viewType }; } };
          var view = creator(leaf);
          if (!view || !view.containerEl) { throw new Error('视图创建器必须返回 ItemView'); }
          var root = document.createElement('div');
          root.className = 'lexinote-view-root';
          root.appendChild(view.containerEl);
          document.body.appendChild(root);
          if (view.load) { view.load(); }
          if (view.onOpen) { view.onOpen(); }
        }).catch(function (err) {
          document.body.textContent = '插件视图启动失败: ' + (err && err.message ? err.message : String(err));
          console.warn('[lexinote] view boot error', err);
        });
      } catch (err) {
        document.body.textContent = '插件视图脚本错误: ' + (err && err.message ? err.message : String(err));
        console.warn('[lexinote] view eval error', err);
      }
    }
  };

  whenHostReady();
})();
