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

  var API_VERSION = '1.0.0';

  function safeParse(text, fallback) {
    try { return JSON.parse(text); } catch (err) { return fallback; }
  }

  function settle(callId, raw) {
    var entry = pendingCalls.get(callId);
    if (!entry) { return; }
    pendingCalls.delete(callId);
    var message = safeParse(raw, null);
    if (!message) { entry.reject(new Error('插件桥返回了无效数据')); return; }
    if (message.ok) { entry.resolve(message.result); } else { entry.reject(new Error(message.error || '插件桥调用失败')); }
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

  function hostCall(method, payload) {
    return new Promise(function (resolve, reject) {
      var callId = 'c' + (++callSeq);
      pendingCalls.set(callId, { resolve: resolve, reject: reject });
      var dispatch = function () {
        try {
          var raw = JSON.stringify(payload === undefined || payload === null ? {} : payload);
          var outcome = window.lexiHost.call(callId, method, raw);
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
  LocalEmitter.prototype.trigger = function (name, payload) {
    var bucket = this.handlers.get(name);
    if (!bucket) { return; }
    var snapshot = bucket.slice();
    for (var i = 0; i < snapshot.length; i++) {
      try { snapshot[i](payload); } catch (err) { console.warn('[lexinote] listener error', err); }
    }
  };

  function dispatchHostEvent(message) {
    var topic = message.topic;
    var name = message.name;
    var payload = message.payload;
    if (topic === 'vault') {
      payload = rehydrateFileEvent(payload);
    }
    if (topic === 'host-ref') {
      var entry = hostEventTable.get(payload && payload.refId);
      if (entry) { entry.callback(payload.payload); }
      return;
    }
    var bucket = topicBuckets.get(topic);
    if (bucket) { bucket.trigger(name, payload); }
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

  function subscribeTopic(topic, name, callback) {
    // Obsidian returns an EventRef synchronously; the host subscription is reconciled async.
    var bucket = topicFor(topic);
    var wrapper = function (payload) { callback(payload); };
    bucket.on(name, wrapper);
    var refId = ++hostEventSeq;
    var entry = { refId: refId, topic: topic, name: name, callback: callback, wrapper: wrapper };
    hostEventTable.set(refId, entry);
    hostCall('events.on', { refId: refId, topic: topic, name: name }).catch(function () {});
    return makeHostRef(entry);
  }

  function makeHostRef(entry) {
    var ref = { __hostRef: entry.refId };
    ref.off = function () {
      hostEventTable.delete(entry.refId);
      var bucket = topicBuckets.get(entry.topic);
      if (bucket) { bucket.off(entry.name, entry.wrapper); }
      hostCall('events.off', { refId: entry.refId }).catch(function () {});
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

  // ---------------------------------------------------------------- API objects

  var Platform = {
    isDesktop: false, isMobile: true, isDesktopApp: false, isMobileApp: true,
    isIosApp: false, isAndroidApp: false, isPhone: true, isTablet: false,
    isMacOS: false, isWin: false, isLinux: false, isSafari: false, resourcePathPrefix: ''
  };

  var vault = {
    on: function (name, callback) { return subscribeTopic('vault', name, callback); },
    off: function (name, callback) { topicFor('vault').off(name, callback); },
    getAbstractFileByPath: function (path) {
      return hostCall('vault.getByPath', { path: normalizePath(path) }).then(fileFromJson);
    },
    getFileByPath: function (path) { return vault.getAbstractFileByPath(path); },
    getFolderByPath: function (path) {
      return hostCall('vault.getByPath', { path: normalizePath(path) }).then(function (json) {
        return json && json.kind === 'folder' ? fileFromJson(json) : null;
      });
    },
    getMarkdownFiles: function () {
      return hostCall('vault.files', {}).then(function (list) { return (list || []).map(fileFromJson); });
    },
    getFiles: function () { return vault.getMarkdownFiles(); },
    getRoot: function () {
      var root = new TFolder(); root.path = '/'; root.name = '';
      return root;
    },
    read: function (file) { return hostCall('vault.read', { path: file.path }); },
    cachedRead: function (file) { return vault.read(file); },
    modify: function (file, data) { return hostCall('vault.modify', { path: file.path, data: data }); },
    create: function (path, data) {
      return hostCall('vault.create', { path: normalizePath(path), data: data }).then(fileFromJson);
    },
    createBinary: function () { return Promise.reject(new Error('二进制文件将在后续版本提供')); },
    delete: function (file, force) { return hostCall('vault.delete', { path: file.path, force: !!force }); },
    trash: function (file, system) { return vault.delete(file, false); },
    rename: function (file, newPath) { return hostCall('vault.rename', { path: file.path, newPath: normalizePath(newPath) }); },
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

  var metadataCache = {
    on: function (name, callback) { return subscribeTopic('metadata', name, callback); },
    off: function (name, callback) { topicFor('metadata').off(name, callback); },
    getFileCache: function (file) { return hostCall('metadata.get', { path: file.path }); },
    getCache: function (path) { return hostCall('metadata.get', { path: normalizePath(path) }); },
    getFirstLinkpathDest: function (linkpath, sourcePath) {
      return hostCall('metadata.firstLink', { linkpath: linkpath, sourcePath: sourcePath }).then(fileFromJson);
    },
    fileToLinktext: function (file) { return file.basename; },
    resolvedLinks: function () { return hostCall('metadata.resolved', {}); }
  };

  var workspace = {
    on: function (name, callback) { return subscribeTopic('workspace', name, callback); },
    off: function (name, callback) { topicFor('workspace').off(name, callback); },
    get activeEditor() {
      if (!lastEditorState || lastEditorState.active === false) { return null; }
      return { app: app, file: null, editor: new EditorProxy(lastEditorState) };
    },
    getActiveFile: function () { return Promise.resolve(null); },
    getActiveViewOfType: function () { return Promise.resolve(null); },
    getLeavesOfType: function () { return Promise.resolve([]); },
    openLinkText: function (linktext, sourcePath) {
      return hostCall('workspace.openLinkText', { linktext: linktext, sourcePath: sourcePath || '' });
    },
    onLayoutReady: function (callback) {
      return hostCall('workspace.onLayoutReady', {}).then(function () { callback(); }).catch(function () { callback(); });
    }
  };

  var commands = {
    executeCommandById: function (id) { return hostCall('commands.execute', { id: id }); },
    listCommands: function () { return hostCall('commands.list', {}); },
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
    hostCall('ui.placeholder', { kind: 'ribbon', pluginId: self.manifest.id, icon: icon, title: title }).catch(function () {});
    self.register(function () { hostCall('ui.placeholder', { kind: 'ribbon.remove', pluginId: self.manifest.id, title: title }).catch(function () {}); });
    return null;
  };
  PluginShim.prototype.addStatusBarItem = function () {
    var self = this;
    hostCall('ui.placeholder', { kind: 'statusbar', pluginId: self.manifest.id }).catch(function () {});
    return { setText: function () {}, createEl: function () { return { appendChild: function () {}, setText: function () {} }; } };
  };
  PluginShim.prototype.addSettingTab = function (tab) {
    var self = this;
    hostCall('ui.placeholder', { kind: 'settingTab', pluginId: self.manifest.id }).catch(function () {});
    self.register(function () { hostCall('ui.placeholder', { kind: 'settingTab.remove', pluginId: self.manifest.id }).catch(function () {}); });
  };
  PluginShim.prototype.registerView = function (type, creator) {
    console.warn('[lexinote] registerView 视图槽将在后续版本生效:', type);
  };
  PluginShim.prototype.registerExtensions = function () {};
  PluginShim.prototype.registerMarkdownPostProcessor = function (processor) {
    console.warn('[lexinote] registerMarkdownPostProcessor 将在后续版本生效');
    return processor;
  };
  PluginShim.prototype.registerMarkdownCodeBlockProcessor = function (language) {
    console.warn('[lexinote] registerMarkdownCodeBlockProcessor 将在后续版本生效:', language);
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

  function EditorProxy(state) {
    this._text = state && typeof state.text === 'string' ? state.text : '';
    var selection = (state && state.selection) || { start: 0, end: 0 };
    this._selection = {
      start: Math.max(0, selection.start || 0),
      end: Math.max(0, typeof selection.end === 'number' ? selection.end : (selection.start || 0))
    };
    this._noteId = (state && state.noteId) || '';
  }
  EditorProxy.prototype._apply = function (method, payload) {
    var self = this;
    return hostCall(method, payload).then(function (state) {
      acceptEditorState(state);
      if (state && typeof state.text === 'string') { self._text = state.text; }
      if (state && state.selection) { self._selection = { start: state.selection.start, end: state.selection.end }; }
      return state;
    });
  };
  EditorProxy.prototype.getValue = function () { return this._text; };
  EditorProxy.prototype.setValue = function (content) {
    return this._apply('editor.replace', { start: 0, end: this._text.length, text: String(content) });
  };
  EditorProxy.prototype.getSelection = function () {
    return this._text.substring(this._selection.start, this._selection.end);
  };
  EditorProxy.prototype.somethingSelected = function () { return this._selection.end > this._selection.start; };
  EditorProxy.prototype.replaceSelection = function (replacement) {
    return this._apply('editor.replace', { start: this._selection.start, end: this._selection.end, text: String(replacement) });
  };
  EditorProxy.prototype.replaceRange = function (replacement, from, to) {
    var start = posToOffset(this._text, from);
    var end = to ? posToOffset(this._text, to) : start;
    return this._apply('editor.replace', { start: start, end: Math.max(start, end), text: String(replacement) });
  };
  EditorProxy.prototype.getRange = function (from, to) {
    return this._text.substring(posToOffset(this._text, from), posToOffset(this._text, to));
  };
  EditorProxy.prototype.getLine = function (line) {
    var lines = this._text.split('\n');
    return line >= 0 && line < lines.length ? lines[line] : '';
  };
  EditorProxy.prototype.lineCount = function () { return this._text.split('\n').length; };
  EditorProxy.prototype.lastLine = function () { return this.lineCount() - 1; };
  EditorProxy.prototype.getCursor = function (side) {
    var offset = side === 'from' || side === 'anchor' ? this._selection.start : this._selection.end;
    return offsetToPos(this._text, offset);
  };
  EditorProxy.prototype.setCursor = function (pos, ch) {
    var offset = posToOffset(this._text, typeof pos === 'number' ? { line: pos, ch: ch || 0 } : pos);
    return this._apply('editor.selection', { start: offset, end: offset });
  };
  EditorProxy.prototype.setSelection = function (anchor, head) {
    var a = posToOffset(this._text, anchor);
    var b = head ? posToOffset(this._text, head) : a;
    return this._apply('editor.selection', { start: Math.min(a, b), end: Math.max(a, b) });
  };
  EditorProxy.prototype.setSelections = function (ranges) {
    if (!ranges || ranges.length === 0) { return Promise.resolve(); }
    return this.setSelection(ranges[0].anchor, ranges[0].head);
  };
  EditorProxy.prototype.listSelections = function () {
    return [{ anchor: offsetToPos(this._text, this._selection.start), head: offsetToPos(this._text, this._selection.end) }];
  };
  EditorProxy.prototype.posToOffset = function (pos) { return posToOffset(this._text, pos); };
  EditorProxy.prototype.offsetToPos = function (offset) { return offsetToPos(this._text, offset); };
  EditorProxy.prototype.focus = function () {};
  EditorProxy.prototype.blur = function () {};
  EditorProxy.prototype.hasFocus = function () { return true; };
  EditorProxy.prototype.getScrollInfo = function () { return { top: 0, left: 0 }; };
  EditorProxy.prototype.scrollTo = function () {};
  EditorProxy.prototype.scrollIntoView = function () {};
  EditorProxy.prototype.undo = function () { console.warn('[lexinote] Editor.undo 暂未支持'); };
  EditorProxy.prototype.redo = function () { console.warn('[lexinote] Editor.redo 暂未支持'); };
  EditorProxy.prototype.exec = function () { console.warn('[lexinote] Editor.exec 暂未支持'); };
  EditorProxy.prototype.transaction = function () { console.warn('[lexinote] Editor.transaction 暂未支持'); };
  EditorProxy.prototype.wordAt = function () { return null; };
  EditorProxy.prototype.processLines = function () { console.warn('[lexinote] Editor.processLines 暂未支持'); };

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
    hostCall('ui.placeholder', { kind: 'modal', title: self.titleText || '' }).catch(function () {});
    self.onOpen && self.onOpen();
  };
  Modal.prototype.close = function () { this.onClose && this.onClose(); };
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
    render: function () { return Promise.reject(new Error('MarkdownRenderer 将在视图槽实现后提供')); },
    renderMarkdown: function () { return Promise.reject(new Error('MarkdownRenderer 将在视图槽实现后提供')); }
  };

  function requestUrl(param) {
    var spec = typeof param === 'string' ? { url: param } : (param || {});
    var requestPromise = hostCall('net.requestUrl', {
      url: spec.url, method: spec.method || 'GET',
      headers: spec.headers || {}, body: typeof spec.body === 'string' ? spec.body : ''
    });
    var wrapped = requestPromise.then(function (response) {
      var text = response && typeof response.text === 'string' ? response.text : '';
      return {
        status: response ? response.status : 0,
        headers: response ? response.headers : {},
        text: text,
        json: safeParse(text, null),
        arrayBuffer: Promise.reject(new Error('arrayBuffer 将在后续版本提供'))
      };
    });
    wrapped.text = requestPromise.then(function (response) { return response && response.text ? response.text : ''; });
    wrapped.json = requestPromise.then(function (response) {
      var text = response && response.text ? response.text : '';
      return safeParse(text, null);
    });
    return wrapped;
  }

  function requireShim(name) {
    if (name === 'obsidian' || name === 'lexinote') { return obsidianNamespace; }
    throw new Error('插件沙箱不支持模块: ' + name + '(依赖请随 main.js 打包)');
  }

  // ---------------------------------------------------------------- plugin loading

  async function loadPlugin(message) {
    var manifest = message.manifest;
    var code = message.code;
    if (!manifest || typeof code !== 'string') { throw new Error('插件装载参数不完整'); }
    if (plugins.has(manifest.id)) { throw new Error('插件已加载: ' + manifest.id); }
    var moduleObj = { exports: {} };
    var factory = new Function('require', 'module', 'exports',
      code + '\n//# sourceURL=lexinote-plugin-' + manifest.id + '.js');
    factory(requireShim, moduleObj, moduleObj.exports);
    var exported = moduleObj.exports;
    var Ctor = typeof exported === 'function' ? exported : (exported && typeof exported.default === 'function' ? exported.default : null);
    if (!Ctor) { throw new Error('main.js 必须导出插件类(default)'); }
    var instance = new Ctor(app, manifest);
    if (!(instance instanceof ComponentShim)) {
      // Plugin classes may extend their own base; attach shim lifecycle when missing.
      ComponentShim.call(instance);
      Object.getOwnPropertyNames(ComponentShim.prototype).forEach(function (key) {
        if (key !== 'constructor' && instance[key] === undefined) { instance[key] = ComponentShim.prototype[key]; }
      });
      instance._children = []; instance._cleanups = []; instance._intervals = []; instance._loaded = false;
    }
    plugins.set(manifest.id, instance);
    await instance.load();
    await hostCall('plugin.onload.done', { id: manifest.id });
  }

  async function unloadPlugin(pluginId) {
    var instance = plugins.get(pluginId);
    plugins.delete(pluginId);
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
          Promise.resolve().then(function () {
            if (command.checkCallback && !command.checkCallback(false)) { return; }
            if (command.callback) { return command.callback(); }
          }).catch(function (err) { console.warn('[lexinote] 命令执行失败', err); });
        }
        return;
      }
      if (method === 'invoke.editorCommand') {
        acceptEditorState(message.editor);
        var editorCommand = commandTable.get(message.fullId);
        if (editorCommand && typeof editorCommand.editorCallback === 'function') {
          var editor = new EditorProxy(message.editor || {});
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
      if (method === 'unload.plugin') {
        unloadPlugin(message.id).catch(function (err) {
          hostCall('plugin.unload.done', { id: message.id, error: String(err) }).catch(function () {});
        });
        return;
      }
    }
  };

  var obsidianNamespace = {
    apiVersion: API_VERSION,
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
    MarkdownRenderChild: ComponentShim,
    Events: LocalEmitter,
    Scope: function Scope() {},
    Keymap: { isModifier: function () { return false; } },
    ItemView: ComponentShim,
    View: ComponentShim,
    addIcon: function () {},
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
        var args = Array.prototype.slice.call(arguments);
        if (timer !== null) { clearTimeout(timer); }
        timer = setTimeout(function () { timer = null; cb.apply(null, args); }, timeout || 0);
      };
      debounced.cancel = function () { if (timer !== null) { clearTimeout(timer); timer = null; } };
      debounced.run = function () {};
      return debounced;
    },
    sleep: function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  };

  hostCall('runtime.ready', {}).catch(function () { /* retried via host queue once lexiHost appears */ });
  whenHostReady();
})();
