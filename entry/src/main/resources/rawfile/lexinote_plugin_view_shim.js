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
    'font-family:inherit;font-size:14px;}\n' +
    'body.lexinote-code-slot{padding:0;background:transparent;font-size:13px;}' +
    '.lexinote-code-root{padding:10px 12px;}' +
    '.lexinote-code-badge{display:inline-block;font-size:10px;font-weight:600;color:var(--interactive-accent);' +
    'background:var(--background-primary-alt);border-radius:6px;padding:2px 8px;margin-bottom:6px;}' +
    '.lexinote-code-content{white-space:pre-wrap;word-break:break-word;color:var(--text-normal);' +
    'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.5;}\n';

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
    this._codeBlockHandlers = new Map();
  }
  PluginViewShim.prototype = Object.create(ComponentShim.prototype);
  PluginViewShim.prototype.constructor = PluginViewShim;
  PluginViewShim.prototype.registerView = function (type, creator) { this._viewCreators.set(type, creator); };
  PluginViewShim.prototype.addCommand = function () { return null; };
  PluginViewShim.prototype.addRibbonIcon = function () { return null; };
  PluginViewShim.prototype.addStatusBarItem = function () { return { setText: function () {} }; };
  PluginViewShim.prototype.addSettingTab = function () {};
  PluginViewShim.prototype.registerMarkdownPostProcessor = function () {};
  PluginViewShim.prototype.registerMarkdownCodeBlockProcessor = function (language, handler) {
    this._codeBlockHandlers.set(String(language || '').toLowerCase(), handler);
  };
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
    getActiveFile: function () { return null; },
    getActiveViewOfType: function () { return null; },
    getLeavesOfType: function () { return []; },
    getRightLeaf: function () { return null; },
    getLeaf: function () { return null; },
    getMostRecentLeaf: function () { return null; },
    iterateAllLeaves: function () {},
    iterateRootLeaves: function () {},
    detachLeavesOfType: function () { return Promise.resolve(); },
    revealLeaf: function () { return Promise.resolve(); },
    onLayoutReady: function (cb) { if (typeof cb === 'function') { setTimeout(function () { cb(); }, 0); } return Promise.resolve(); },
    getLastOpenFiles: function () { return []; },
    layoutReady: true
  };
  var appRef = {
    vault: viewVault,
    metadataCache: viewMetadata,
    workspace: viewWorkspace,
    isDarkMode: function () { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }
  };

  function PluginSettingTabStub(appValue, plugin) {
    this.app = appValue;
    this.plugin = plugin;
    this.containerEl = document.createElement('div');
  }
  PluginSettingTabStub.prototype.display = function () {};
  PluginSettingTabStub.prototype.hide = function () {};
  PluginSettingTabStub.prototype.getSettingDefinitions = function () { return []; };
  PluginSettingTabStub.prototype.getControlValue = function () { return undefined; };
  PluginSettingTabStub.prototype.setControlValue = function () {};
  PluginSettingTabStub.prototype.onSettingsChanged = function () {};

  function ModalStub(appValue) {
    this.app = appValue;
    this.scope = null;
    this.shouldRestoreSelection = false;
    this.containerEl = document.createElement('div');
    this.modalEl = document.createElement('div');
    this.titleEl = document.createElement('div');
    this.contentEl = document.createElement('div');
    this.modalEl.appendChild(this.titleEl);
    this.modalEl.appendChild(this.contentEl);
    this.containerEl.appendChild(this.modalEl);
  }
  ModalStub.prototype.open = function () { document.body.appendChild(this.containerEl); if (this.onOpen) { this.onOpen(); } };
  ModalStub.prototype.close = function () { this.containerEl.detach(); if (this.onClose) { this.onClose(); } };
  ModalStub.prototype.onOpen = function () {};
  ModalStub.prototype.onClose = function () {};
  ModalStub.prototype.setTitle = function (title) { this.titleEl.setText(String(title)); return this; };
  ModalStub.prototype.setContent = function (content) { this.contentEl.setText(typeof content === 'string' ? content : ''); return this; };
  ModalStub.prototype.setCloseCallback = function () { return this; };

  function SuggestModalStub(appValue) {
    ModalStub.call(this, appValue);
    this.limit = 50;
    this.inputEl = document.createElement('input');
    this.resultContainerEl = document.createElement('div');
    this.contentEl.appendChild(this.inputEl);
    this.contentEl.appendChild(this.resultContainerEl);
  }
  SuggestModalStub.prototype = Object.create(ModalStub.prototype);
  SuggestModalStub.prototype.constructor = SuggestModalStub;
  SuggestModalStub.prototype.setPlaceholder = function (text) { this.inputEl.setAttribute('placeholder', String(text)); };
  SuggestModalStub.prototype.setInstructions = function () {};
  SuggestModalStub.prototype.getSuggestions = function () { return []; };
  SuggestModalStub.prototype.renderSuggestion = function () {};
  SuggestModalStub.prototype.onChooseSuggestion = function () {};

  function SettingStub() {
    this.containerEl = document.createElement('div');
    this.components = [];
  }
  ['setName', 'setDesc', 'setClass', 'setHeading', 'setTooltip', 'setDisabled', 'setErrorMessage', 'clear', 'then'].forEach(function (method) {
    SettingStub.prototype[method] = function () { return this; };
  });
  ['addButton', 'addExtraButton', 'addToggle', 'addText', 'addTextArea', 'addDropdown', 'addSlider',
    'addSearch', 'addMomentFormat', 'addColorPicker', 'addProgressBar', 'addDisplayValue'].forEach(function (method) {
    SettingStub.prototype[method] = function (cb) {
      var component = {
        setValue: function () { return this; }, getValue: function () { return ''; },
        onChange: function () { return this; }, setDisabled: function () { return this; },
        setPlaceholder: function () { return this; }, addOption: function () { return this; },
        addOptions: function () { return this; }, setLimits: function () { return this; },
        setButtonText: function () { return this; }, setIcon: function () { return this; },
        setCta: function () { return this; }, removeCta: function () { return this; },
        onClick: function () { return this; }, setTooltip: function () { return this; },
        setDynamicTooltip: function () { return this; }, setInstant: function () { return this; },
        setDisplayFormat: function () { return this; }
      };
      if (typeof cb === 'function') { cb(component); }
      return this;
    };
  });
  SettingStub.prototype.addComponent = function (cb) { if (typeof cb === 'function') { cb({}); } return this; };

  function MenuStub() { this.items = []; }
  MenuStub.prototype.addItem = function (cb) {
    var item = { setTitle: function () { return this; }, setIcon: function () { return this; },
      setChecked: function () { return this; }, setDisabled: function () { return this; },
      setWarning: function () { return this; }, setIsLabel: function () { return this; },
      onClick: function () { return this; }, setSection: function () { return this; } };
    if (typeof cb === 'function') { cb(item); }
    return this;
  };
  MenuStub.prototype.addSeparator = function () { return this; };
  MenuStub.prototype.showAtMouseEvent = function () { return this; };
  MenuStub.prototype.showAtPosition = function () { return this; };
  MenuStub.prototype.hide = function () { return this; };
  MenuStub.prototype.close = function () {};
  MenuStub.prototype.onHide = function () {};

  function MarkdownRenderChildStub(containerEl) {
    ComponentShim.call(this);
    this.containerEl = containerEl || document.createElement('div');
  }
  MarkdownRenderChildStub.prototype = Object.create(ComponentShim.prototype);
  MarkdownRenderChildStub.prototype.constructor = MarkdownRenderChildStub;

  // ------------------------------------------------------------ mini YAML subset (parseYaml)
  // 覆盖常见插件代码块配置:嵌套映射、序列("- " 或 "- key: value")、内联数组、引号/布尔/数字。

  function parseInlineValue(raw) {
    var text = String(raw).trim();
    if (text.length === 0) { return ''; }
    if (text === 'true') { return true; }
    if (text === 'false') { return false; }
    if (text === 'null' || text === '~') { return null; }
    if (/^-?\d+(\.\d+)?$/.test(text)) { return Number(text); }
    if (text.startsWith('[') && text.endsWith(']')) {
      return splitInline(text.slice(1, -1)).map(function (part) { return parseInlineValue(part); });
    }
    if (text.startsWith('{') && text.endsWith('}')) {
      var obj = {};
      splitInline(text.slice(1, -1)).forEach(function (part) {
        var colon = part.indexOf(':');
        if (colon > 0) { obj[part.slice(0, colon).trim()] = parseInlineValue(part.slice(colon + 1)); }
      });
      return obj;
    }
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      return text.slice(1, -1);
    }
    return text;
  }

  function splitInline(text) {
    var parts = [];
    var current = '';
    var depth = 0;
    var quote = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (quote) {
        current += ch;
        if (ch === quote && text.charAt(i - 1) !== '\\') { quote = ''; }
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
      if (ch === '[' || ch === '{') { depth++; current += ch; continue; }
      if (ch === ']' || ch === '}') { depth--; current += ch; continue; }
      if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    if (current.trim().length > 0) { parts.push(current.trim()); }
    return parts.filter(function (part) { return part.length > 0; });
  }

  function stripYamlComment(line) {
    var quote = '';
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if ((ch === '"' || ch === "'") && line.charAt(i - 1) !== '\\') {
        if (!quote) { quote = ch; } else if (quote === ch) { quote = ''; }
      } else if (ch === '#' && !quote && (i === 0 || /\s/.test(line.charAt(i - 1)))) {
        return line.slice(0, i);
      }
    }
    return line;
  }

  function parseYaml(text) {
    var lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
    var root = null;
    var stack = []; // {indent, value}
    var pendingKey = null; // {parent, key, indent}

    function assign(parent, key, value) {
      if (Array.isArray(parent)) { parent.push(value); return; }
      if (parent && typeof parent === 'object') { parent[key] = value; }
    }

    for (var i = 0; i < lines.length; i++) {
      var rawLine = stripYamlComment(lines[i]);
      if (rawLine.trim().length === 0) { continue; }
      var indent = rawLine.length - rawLine.replace(/^\s+/, '').length;
      var content = rawLine.trim();

      while (stack.length > 0 && indent < stack[stack.length - 1].indent) { stack.pop(); }
      var parent = stack.length > 0 ? stack[stack.length - 1].value : root;

      if (content.charAt(0) === '-') {
        var rest = content.slice(1).trim();
        if (parent === null) { root = []; parent = root; stack.push({ indent: indent, value: root }); }
        else if (stack.length === 0) { root = []; parent = root; stack.push({ indent: indent, value: root }); }
        if (rest.length === 0) {
          var child = {};
          parent.push(child);
          stack.push({ indent: indent, value: child });
          continue;
        }
        var entryObj = {};
        var colonIndex = rest.indexOf(':');
        if (colonIndex > 0) {
          var key = rest.slice(0, colonIndex).trim();
          var valueText = rest.slice(colonIndex + 1).trim();
          entryObj[key] = valueText.length > 0 ? parseInlineValue(valueText) : null;
          parent.push(entryObj);
          stack.push({ indent: indent, value: entryObj });
        } else {
          parent.push(parseInlineValue(rest));
        }
        continue;
      }

      var colon = content.indexOf(':');
      if (colon <= 0) { continue; }
      var fieldKey = content.slice(0, colon).trim();
      var fieldValue = content.slice(colon + 1).trim();
      if (root === null) { root = {}; parent = root; stack.push({ indent: indent, value: root }); }
      if (fieldValue.length > 0) {
        assign(parent, fieldKey, parseInlineValue(fieldValue));
      } else {
        // 下一行定类型:缩进的 "- " 是数组,否则是对象
        var nextLine = '';
        for (var j = i + 1; j < lines.length; j++) {
          var candidate = stripYamlComment(lines[j]);
          if (candidate.trim().length === 0) { continue; }
          nextLine = candidate;
          break;
        }
        var isArray = nextLine && nextLine.trim().charAt(0) === '-' &&
          (nextLine.length - nextLine.replace(/^\s+/, '').length) > indent;
        var container = isArray ? [] : {};
        assign(parent, fieldKey, container);
        stack.push({ indent: indent, value: container });
      }
    }
    return root === null ? null : root;
  }

  // ------------------------------------------------------------ slot utilities (moment/icons/network)

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function pad2(value, size) {
    var text = String(Math.abs(value));
    while (text.length < size) { text = '0' + text; }
    return value < 0 ? '-' + text : text;
  }
  function MiniMoment(input) {
    if (input instanceof MiniMoment) { this._d = new Date(input._d.getTime()); }
    else if (input instanceof Date) { this._d = new Date(input.getTime()); }
    else if (typeof input === 'number') { this._d = new Date(input); }
    else if (typeof input === 'string') { var parsed = new Date(input); this._d = Number.isNaN(parsed.getTime()) ? new Date() : parsed; }
    else { this._d = new Date(); }
  }
  MiniMoment.prototype.format = function (pattern) {
    var d = this._d;
    var text = (pattern === undefined || pattern === null) ? 'YYYY-MM-DD HH:mm' : String(pattern);
    return text.replace(/YYYY|YY|MMMM|MMM|MM|M|DD|Do|dddd|ddd|dd|HH|H|hh|mm|ss|SSS|A|a/g, function (token) {
      switch (token) {
        case 'YYYY': return pad2(d.getFullYear(), 4);
        case 'YY': return pad2(d.getFullYear() % 100, 2);
        case 'MMMM': return MONTHS[d.getMonth()];
        case 'MMM': return MONTHS[d.getMonth()].slice(0, 3);
        case 'MM': return pad2(d.getMonth() + 1, 2);
        case 'M': return String(d.getMonth() + 1);
        case 'DD': return pad2(d.getDate(), 2);
        case 'Do': return String(d.getDate()) + '日';
        case 'dddd': return WEEKDAYS[d.getDay()];
        case 'ddd': return WEEKDAYS[d.getDay()].slice(0, 3);
        case 'dd': return WEEKDAYS[d.getDay()].slice(0, 2);
        case 'HH': return pad2(d.getHours(), 2);
        case 'H': return String(d.getHours());
        case 'hh': return pad2(d.getHours() % 12 === 0 ? 12 : d.getHours() % 12, 2);
        case 'mm': return pad2(d.getMinutes(), 2);
        case 'ss': return pad2(d.getSeconds(), 2);
        case 'SSS': return pad2(d.getMilliseconds(), 3);
        case 'A': return d.getHours() < 12 ? 'AM' : 'PM';
        case 'a': return d.getHours() < 12 ? 'am' : 'pm';
        default: return token;
      }
    });
  };
  function shiftViewMoment(self, amount, unit, sign) {
    var d = new Date(self._d.getTime());
    var key = String(unit || '').toLowerCase();
    var addMonthsClamped = function (months) {
      var day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + months);
      var days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, days));
    };
    if (key.startsWith('y')) { d.setFullYear(d.getFullYear() + sign * amount); }
    else if (key.startsWith('month')) { addMonthsClamped(sign * amount); }
    else if (key.startsWith('week') || key === 'w') { d.setDate(d.getDate() + sign * amount * 7); }
    else if (key.startsWith('day') || key === 'd' || key === 'date') { d.setDate(d.getDate() + sign * amount); }
    else if (key.startsWith('hour') || key === 'h') { d.setHours(d.getHours() + sign * amount); }
    else if (key.startsWith('minute') || key === 'm') { d.setMinutes(d.getMinutes() + sign * amount); }
    else if (key.startsWith('second') || key === 's') { d.setSeconds(d.getSeconds() + sign * amount); }
    else { addMonthsClamped(sign * amount); }
    return new MiniMoment(d);
  }
  MiniMoment.prototype.add = function (amount, unit) { return shiftViewMoment(this, amount, unit, 1); };
  MiniMoment.prototype.subtract = function (amount, unit) { return shiftViewMoment(this, amount, unit, -1); };
  MiniMoment.prototype.startOf = function (unit) {
    var d = new Date(this._d.getTime());
    var key = String(unit || '').toLowerCase();
    if (key.charAt(0) === 'd') { d.setHours(0, 0, 0, 0); }
    else if (key === 'week' || key === 'isoWeek') { d.setDate(d.getDate() - d.getDay()); d.setHours(0, 0, 0, 0); }
    else if (key.startsWith('month')) { d.setDate(1); d.setHours(0, 0, 0, 0); }
    else if (key.startsWith('year')) { d.setMonth(0, 1); d.setHours(0, 0, 0, 0); }
    else if (key.startsWith('hour')) { d.setMinutes(0, 0, 0); }
    return new MiniMoment(d);
  };
  MiniMoment.prototype.endOf = function (unit) {
    var key = String(unit || '').toLowerCase();
    var next = this.startOf(key);
    if (key.charAt(0) === 'd') { return next.add(1, 'day').subtract(1, 'millisecond'); }
    if (key === 'week' || key === 'isoWeek') { return next.add(1, 'week').subtract(1, 'millisecond'); }
    if (key.startsWith('month')) { return next.add(1, 'month').subtract(1, 'millisecond'); }
    return next.add(1, 'year').subtract(1, 'millisecond');
  };
  MiniMoment.prototype.diff = function (other, unit) {
    var delta = this._d.getTime() - (other && other._d ? other._d.getTime() : new Date(other).getTime());
    var key = String(unit || 'ms').toLowerCase();
    if (key.startsWith('day') || key === 'd') { return Math.round(delta / 86400000); }
    if (key.startsWith('hour') || key === 'h') { return Math.round(delta / 3600000); }
    if (key.startsWith('minute') || key === 'm') { return Math.round(delta / 60000); }
    if (key.startsWith('second') || key === 's') { return Math.round(delta / 1000); }
    return delta;
  };
  MiniMoment.prototype.isSame = function (other, unit) {
    var key = String(unit || '').toLowerCase();
    if (key.length === 0) { return this.valueOf() === (other && other._d ? other._d.getTime() : new Date(other).getTime()); }
    return this.startOf(key).valueOf() === new MiniMoment(other).startOf(key).valueOf();
  };
  MiniMoment.prototype.isBefore = function (other) { return this.valueOf() < (other && other._d ? other._d.getTime() : new Date(other).getTime()); };
  MiniMoment.prototype.isAfter = function (other) { return this.valueOf() > (other && other._d ? other._d.getTime() : new Date(other).getTime()); };
  MiniMoment.prototype.isBetween = function (start, end) { return this.isAfter(start) && this.isBefore(end); };
  MiniMoment.prototype.valueOf = function () { return this._d.getTime(); };
  MiniMoment.prototype.unix = function () { return Math.floor(this._d.getTime() / 1000); };
  MiniMoment.prototype.toDate = function () { return new Date(this._d.getTime()); };
  MiniMoment.prototype.toISOString = function () { return this._d.toISOString(); };
  MiniMoment.prototype.toArray = function () { return [this._d.getFullYear(), this._d.getMonth(), this._d.getDate(), this._d.getHours(), this._d.getMinutes(), this._d.getSeconds(), this._d.getMilliseconds()]; };
  MiniMoment.prototype.clone = function () { return new MiniMoment(new Date(this._d.getTime())); };
  MiniMoment.prototype.day = function () { return this._d.getDay(); };
  MiniMoment.prototype.date = function () { return this._d.getDate(); };
  MiniMoment.prototype.month = function () { return this._d.getMonth(); };
  MiniMoment.prototype.year = function () { return this._d.getFullYear(); };
  MiniMoment.prototype.week = function () {
    var start = new Date(this._d.getTime());
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - start.getDay());
    var jan1 = new Date(start.getFullYear(), 0, 1);
    return Math.ceil(((start - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  };
  MiniMoment.prototype.isValid = function () { return !Number.isNaN(this._d.getTime()); };
  function viewMoment(input) {
    if (input instanceof MiniMoment) { return input.clone(); }
    if (Array.isArray(input)) {
      return new MiniMoment(new Date(input[0], input[1] || 0, input[2] || 1));
    }
    return new MiniMoment(input);
  }
  viewMoment.locale = function () { return 'zh-cn'; };
  viewMoment.utc = function (input) { return viewMoment(input); };
  viewMoment.unix = function (seconds) { return new MiniMoment(new Date(seconds * 1000)); };
  viewMoment.now = function () { return Date.now(); };
  viewMoment.isMoment = function (value) { return value instanceof MiniMoment; };

  function viewNormalizePath(path) {
    var text = String(path == null ? '' : path).trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    while (text.charAt(0) === '/') { text = text.slice(1); }
    while (text.length > 0 && text.charAt(text.length - 1) === '/') { text = text.slice(0, -1); }
    return text;
  }

  function viewRequestUrl(param) {
    var spec = typeof param === 'string' ? { url: param } : (param || {});
    return hostCall('net.requestUrl', {
      url: spec.url, method: spec.method || 'GET',
      headers: spec.headers || {}, body: typeof spec.body === 'string' ? spec.body : ''
    }).then(function (response) {
      var text = response && typeof response.text === 'string' ? response.text : '';
      var parsed = null;
      try { parsed = JSON.parse(text); } catch (err) { parsed = null; }
      return {
        status: response ? response.status : 0,
        headers: response ? response.headers : {},
        text: text,
        json: parsed,
        arrayBuffer: Promise.reject(new Error('arrayBuffer 暂未支持'))
      };
    });
  }

  function viewDebounce(cb, timeout) {
    var timer = null;
    var debounced = function () {
      var args = Array.prototype.slice.call(arguments);
      if (timer !== null) { clearTimeout(timer); }
      timer = setTimeout(function () { timer = null; cb.apply(null, args); }, timeout || 0);
    };
    debounced.cancel = function () { if (timer !== null) { clearTimeout(timer); timer = null; } };
    debounced.run = function () {};
    return debounced;
  }

  var viewNamespace = {
    Platform: { isMobile: true, isPhone: true, isDesktop: false, isMobileApp: true },
    Component: ComponentShim,
    Plugin: PluginViewShim,
    ItemView: ItemViewShim,
    View: ItemViewShim,
    Notice: Notice,
    Modal: ModalStub,
    SuggestModal: SuggestModalStub,
    FuzzySuggestModal: SuggestModalStub,
    Menu: MenuStub,
    MenuItem: function () {},
    Setting: SettingStub,
    PluginSettingTab: PluginSettingTabStub,
    MarkdownView: function () {},
    WorkspaceLeaf: function () {},
    MarkdownRenderer: { render: function () { return Promise.resolve(); }, renderMarkdown: function () { return Promise.resolve(); } },
    MarkdownRenderChild: MarkdownRenderChildStub,
    parseYaml: parseYaml,
    moment: viewMoment,
    normalizePath: viewNormalizePath,
    requestUrl: viewRequestUrl,
    debounce: viewDebounce,
    sleep: function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); },
    getLanguage: function () { return 'zh'; },
    addIcon: function () {}, removeIcon: function () {}, setIcon: function () {},
    getIcon: function () { return null; }, getIconIds: function () { return []; },
    apiVersion: '1.1.0',
    Platform: { isMobile: true, isPhone: true, isDesktop: false, isMobileApp: true },
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

  async function fetchPluginCode(pluginId) {
    var collected = '';
    var offset = 0;
    while (true) {
      var chunk = await hostCall('plugin.sourceChunk', {
        pluginId: pluginId, offset: offset, length: 48 * 1024
      });
      if (typeof chunk !== 'string' || chunk.length === 0) { break; }
      collected += chunk;
      offset += chunk.length;
      if (chunk.length < 48 * 1024) { break; }
    }
    return collected;
  }

  function evaluatePlugin(code, manifest) {
    var moduleObj = { exports: {} };
    var factory = new Function('require', 'module', 'exports',
      code + '\n//# sourceURL=lexinote-slot-' + manifest.id + '.js');
    factory(requireShim, moduleObj, moduleObj.exports);
    var exported = moduleObj.exports;
    var Ctor = typeof exported === 'function' ? exported : (exported && typeof exported.default === 'function' ? exported.default : null);
    if (!Ctor) { throw new Error('main.js 必须导出插件类'); }
    return new Ctor(appRef, manifest);
  }

  window.lexinoteView = {
    boot: function (payloadJson) {
      if (booted) { return; }
      booted = true;
      var payload = null;
      try { payload = JSON.parse(payloadJson); } catch (err) { payload = null; }
      if (!payload || (!payload.code && !payload.pluginId)) {
        document.body.textContent = '插件视图启动参数缺失';
        return;
      }
      var manifest = null;
      try { manifest = JSON.parse(payload.manifestJson); } catch (err) { manifest = { id: 'unknown', name: 'Plugin' }; }
      applyStyles(payload.stylesCss || '');
      installDomHelpers();
      (async function () {
        try {
          var code = typeof payload.code === 'string' && payload.code.length > 0 ? payload.code : await fetchPluginCode(payload.pluginId);
          if (!code) { throw new Error('插件源码读取失败: ' + payload.pluginId); }
          var plugin = evaluatePlugin(code, manifest);
          await Promise.resolve(plugin.load ? plugin.load() : plugin.onload && plugin.onload());
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
        } catch (err) {
          document.body.textContent = '插件视图启动失败: ' + (err && err.message ? err.message : String(err));
          console.warn('[lexinote] view boot error', err);
        }
      })();
    },

    bootCodeBlock: function (payloadJson) {
      var payload = null;
      try { payload = JSON.parse(payloadJson); } catch (err) { payload = null; }
      if (!payload || (!payload.code && !payload.pluginId)) {
        document.body.textContent = '插件代码块参数缺失';
        return;
      }
      var manifest = null;
      try { manifest = JSON.parse(payload.manifestJson); } catch (err) { manifest = { id: 'unknown', name: 'Plugin' }; }
      applyStyles(payload.stylesCss || '');
      installDomHelpers();
      document.body.classList.add('lexinote-code-slot');
      (async function () {
        try {
          var code = typeof payload.code === 'string' && payload.code.length > 0 ? payload.code : await fetchPluginCode(payload.pluginId);
          if (!code) { throw new Error('插件源码读取失败: ' + payload.pluginId); }
          var plugin = evaluatePlugin(code, manifest);
          await Promise.resolve(plugin.load ? plugin.load() : plugin.onload && plugin.onload());
          var handler = plugin._codeBlockHandlers.get(String(payload.language || '').toLowerCase());
          if (!handler) { throw new Error('插件未注册该语言的代码块处理器: ' + payload.language); }
          var root = document.createElement('div');
          root.className = 'lexinote-code-root';
          root.createEl('div', { cls: 'lexinote-code-badge', text: '插件渲染 · ' + payload.language });
          var content = root.createDiv({ cls: 'lexinote-code-content' });
          document.body.appendChild(root);
          var ctx = {
            docId: '', sourcePath: '', frontmatter: null,
            addChild: function () {},
            getSectionInfo: function () { return null; }
          };
          await Promise.resolve(handler(String(payload.source || ''), content, ctx));
        } catch (err) {
          document.body.textContent = '插件代码块渲染失败: ' + (err && err.message ? err.message : String(err));
          console.warn('[lexinote] codeblock error', err);
        }
      })();
    }
  };

  whenHostReady();
})();
