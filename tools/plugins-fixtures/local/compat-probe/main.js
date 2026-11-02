var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// tools/plugins-fixtures/local/compat-probe/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => CompatProbePlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var cmState = __toESM(require("@codemirror/state"));
var cmView = __toESM(require("@codemirror/view"));
var VIEW_TYPE = "compat-probe-view";
var COMPAT_DIR = "compat-probe/";
var NOTE_PATH = "compat-probe/probe-note.md";
var LINK_SOURCE_PATH = "compat-probe/links-source.md";
var LINK_TARGET_PATH = "compat-probe/links-target.md";
var LINK_EMBED_PATH = "compat-probe/links-embed.md";
var RENAMED_PATH = "compat-probe/links-target-renamed.md";
var LINK_SOURCE_BODY = [
  "---",
  "tags: [probe-frontmatter, graph]",
  "---",
  "# \u94FE\u63A5\u63A2\u9488",
  "",
  "\u4E00 [[probe-note]]",
  "\u4E8C [[links-missing-note]]",
  "\u4E09 [[links-target|\u522B\u540D]]",
  "",
  "![[links-embed]]",
  ""
].join("\n");
var DEFAULT_SETTINGS = { tag: "compat" };
function probeLog(topic, detail) {
  console.log("[lexi] probe." + topic + " " + JSON.stringify(detail));
}
function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
async function waitForCount(selector, attempts) {
  let found = 0;
  for (let i = 0; i < attempts; i += 1) {
    found = document.querySelectorAll(selector).length;
    if (found > 0) {
      return found;
    }
    await wait(100);
  }
  return found;
}
var ProbeView = class extends import_obsidian.ItemView {
  constructor(leaf) {
    super(leaf);
  }
  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "\u517C\u5BB9\u63A2\u9488";
  }
  getIcon() {
    return "flask";
  }
  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "compat-probe" });
    contentEl.createEl("p", { text: "\u89C6\u56FE\u7531 registerView + getLeaf().setViewState() \u6253\u5F00" });
    probeLog("view.open", { viewType: this.getViewType() });
  }
  async onClose() {
    this.contentEl.empty();
  }
};
var ProbeSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    __publicField(this, "probe");
    this.probe = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("\u63A2\u9488\u6807\u7B7E").setDesc("compat-probe \u5199\u5165\u7B14\u8BB0\u65F6\u4F7F\u7528\u7684\u6807\u7B7E").addText(
      (text) => text.setValue(this.probe.settings.tag).onChange(async (value) => {
        this.probe.settings.tag = value;
        await this.probe.saveSettings();
      })
    );
  }
};
var ProbeModal = class extends import_obsidian.Modal {
  onOpen() {
    this.titleEl.setText("compat-probe modal");
    this.contentEl.createEl("p", { text: "ui.placeholder \u7684\u771F\u5B9E DOM \u5360\u4F4D" });
  }
};
var CompatProbePlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    __publicField(this, "settings", { ...DEFAULT_SETTINGS });
    __publicField(this, "echoCount", 0);
    /** 事件全量推送的负面要求:改名一份被双链引用的笔记,rename + changed + resolved 三者都要到。 */
    __publicField(this, "graphEvents", { rename: 0, changed: 0, resolved: 0, "modify": 0 });
  }
  async onload() {
    const stored = await this.loadData();
    if (stored && typeof stored === "object") {
      this.settings = { ...DEFAULT_SETTINGS, ...stored };
    }
    this.addRibbonIcon("flask", "compat-probe:\u8FD0\u884C\u517C\u5BB9\u63A2\u9488", () => {
      void this.runProbe("ribbon");
    });
    this.addCommand({
      id: "run-probe",
      name: "compat-probe:\u8FD0\u884C\u517C\u5BB9\u63A2\u9488",
      callback: () => {
        void this.runProbe("command");
      }
    });
    this.addCommand({
      id: "probe-echo",
      name: "compat-probe:\u56DE\u58F0\u547D\u4EE4(\u9A8C\u8BC1 commands.execute \u540C\u9875\u6267\u884C)",
      callback: () => {
        this.echoCount += 1;
        probeLog("command.echo", { count: this.echoCount });
      }
    });
    this.registerView(VIEW_TYPE, (leaf) => new ProbeView(leaf));
    this.addSettingTab(new ProbeSettingTab(this.app, this));
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        probeLog("workspace.file-open", { path: file ? file.path : "" });
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        probeLog("workspace.layout-change", {});
      })
    );
    this.registerGraphEvents();
    this.app.workspace.onLayoutReady(() => {
      probeLog("calendar.scan.start", { leaves: this.app.workspace.getLeavesOfType("calendar").length });
      void this.probeCalendarLeaf();
      this.probeOutliner();
      this.probeLeafKeys();
    });
    probeLog("plugin.onload", { viewType: VIEW_TYPE, tag: this.settings.tag });
    await this.runChannelProbe();
    await this.openProbeView();
    await this.runProbe("onload");
    await this.runLinkGraphProbe();
    this.probeCmIdentity();
    await this.probeExtensionLifecycle();
    const editor = this.acquireEditor();
    if (editor) {
      await this.probeEditorOps(editor);
    } else {
      probeLog("editor.missing", { route: "getActiveViewOfType(MarkdownView)" });
    }
  }
  /** C2-③:CM6 必须是同一份实例。两份副本时 ViewPlugin/StateField 静默失效,所以只认构造器/模块对象恒等。 */
  probeCmIdentity() {
    const registry = window.__lexiCmModules || {};
    const live = window.LexiObsidian.editorIdentity();
    const regState = registry["@codemirror/state"] || {};
    const regView = registry["@codemirror/view"] || {};
    const editor = this.acquireEditor();
    const cm = editor && editor.cm ? editor.cm : null;
    let fieldReadable = false;
    try {
      fieldReadable = !!(cm && cm.state.field(import_obsidian.editorInfoField));
    } catch (err) {
      fieldReadable = false;
    }
    probeLog("editor.identity", {
      ctorSame: regState.EditorState === cmState.EditorState && regView.EditorView === cmView.EditorView,
      liveSame: live.stateCtor === cmState.EditorState && live.viewCtor === cmView.EditorView,
      liveCtorSame: live.liveStateCtorSame === true && live.liveViewCtorSame === true,
      fieldReadable,
      hasCm: !!cm
    });
  }
  /** outliner 唯一的取编辑器入口就是这一条,探针走同一条路。 */
  acquireEditor() {
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    return view && view.editor ? view.editor : null;
  }
  /** C2-②:扩展装进活 EditorView(DOM 变了才算装),撤掉后 DOM 必须消失。 */
  async probeExtensionLifecycle() {
    const probeExt = cmView.ViewPlugin.fromClass(
      class {
        constructor(view) {
          __publicField(this, "view");
          this.view = view;
          view.dom.setAttribute("data-lexi-probe-ext", "on");
        }
        update() {
        }
        destroy() {
          this.view.dom.removeAttribute("data-lexi-probe-ext");
        }
      }
    );
    let installError = "";
    try {
      this.registerEditorExtension(probeExt);
    } catch (error) {
      installError = String(error);
    }
    const selector = '.cm-editor[data-lexi-probe-ext="on"]';
    const mounts = await waitForCount(selector, 20);
    probeLog("editor.ext.install", {
      installed: mounts > 0,
      mounts,
      error: installError,
      count: window.LexiObsidian.editorExtensionCount("compat-probe")
    });
    window.LexiObsidian.releaseEditorExtensions("compat-probe");
    await wait(150);
    const remaining = document.querySelectorAll(selector).length;
    probeLog("editor.ext.release", {
      removed: remaining === 0,
      remaining,
      count: window.LexiObsidian.editorExtensionCount("compat-probe")
    });
  }
  /** C2-③:undo/redo 落到 CM6 history,exec/processLines 落到 transaction。 */
  async probeEditorOps(editor) {
    await editor.setValue("alpha");
    await wait(700);
    editor.replaceRange("beta", { line: 0, ch: 5 });
    const edited = editor.getValue();
    editor.undo();
    const undone = editor.getValue();
    editor.redo();
    const redone = editor.getValue();
    probeLog("editor.undo", {
      editedOk: edited === "alphabeta",
      undoneOk: undone === "alpha",
      redoneOk: redone === "alphabeta"
    });
    await editor.setValue("one\ntwo\nthree");
    const ran = editor.exec("selectAll") === true;
    const selected = editor.getSelection();
    probeLog("editor.exec", { ran, selLen: selected.length });
    editor.processLines((line, index) => index === 0 ? line.toUpperCase() : line);
    const processed = editor.getValue();
    probeLog("editor.processLines", { ok: processed === "ONE\ntwo\nthree" });
  }
  /** C2-⑦:重启后同一 (type, 去 active 的 state) 的 leaf 数必须 ≤1。 */
  probeLeafKeys() {
    const keys = window.LexiObsidian.layoutKeys();
    const seen = {};
    let duplicates = 0;
    keys.forEach((key) => {
      if (seen[key]) {
        duplicates += 1;
      }
      seen[key] = (seen[key] || 0) + 1;
    });
    probeLog("editor.leaves", { leaves: keys.length, unique: Object.keys(seen).length, duplicates });
  }
  /** C2-④:outliner 零改动装载后,它的扩展要在活编辑器的 DOM 上留下痕迹。 */
  probeOutliner() {
    const extCount = window.LexiObsidian.editorExtensionCount("obsidian-outliner");
    probeLog("editor.outliner", {
      extCount,
      markers: document.querySelectorAll('.cm-editor [class*="outliner-plugin-"]').length,
      bodyClass: document.body.classList.contains("outliner-plugin-better-lists")
    });
  }
  /** 日历是第三方零改动的验收物:它自己的 initLeaf 挂在 layout-ready 上,所以等它落完再断言。 */
  async probeCalendarLeaf() {
    let leaves = [];
    let el = null;
    let rendered = false;
    let attempts = 0;
    for (attempts = 0; attempts < 60; attempts += 1) {
      leaves = this.app.workspace.getLeavesOfType("calendar");
      if (leaves.length > 0) {
        const view2 = leaves[0].view;
        el = view2 && view2.contentEl ? view2.contentEl : null;
        rendered = !!(el && el.querySelector(".calendar"));
        if (rendered) {
          break;
        }
      }
      await new Promise((resolve) => {
        window.setTimeout(resolve, 250);
      });
    }
    const view = leaves.length > 0 ? leaves[0].view : null;
    probeLog("calendar.leaf", {
      viewType: view && view.getViewType ? view.getViewType() : "",
      leaves: leaves.length,
      rendered,
      attempts,
      domNodes: el ? el.childElementCount : 0,
      connected: !!(el && el.isConnected),
      className: el ? el.className : "",
      htmlLength: el ? el.innerHTML.length : 0,
      active: leaves.length > 0 && this.app.workspace.activeLeaf === leaves[0]
    });
  }
  registerGraphEvents() {
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.graphEvents.rename += 1;
        probeLog("event.vault.rename", { path: file.path, oldPath });
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        this.graphEvents.modify += 1;
        probeLog("event.vault.modify", { path: file.path, count: this.graphEvents.modify });
      })
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        this.graphEvents.changed += 1;
        probeLog("event.metadata.changed", { path: file.path, count: this.graphEvents.changed });
      })
    );
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        this.graphEvents.resolved += 1;
        probeLog("event.metadata.resolved", { count: this.graphEvents.resolved });
      })
    );
  }
  async runLinkGraphProbe() {
    try {
      const stale = this.app.vault.getMarkdownFiles().filter((file) => file.path.indexOf(COMPAT_DIR) === 0);
      for (const file of stale) {
        await this.app.vault.delete(file, true);
      }
      probeLog("metadata.links.cleanup", { deleted: stale.length });
      await this.app.vault.create(LINK_TARGET_PATH, "# \u94FE\u63A5\u76EE\u6807\n\n\u88AB\u53CC\u94FE\u5F15\u7528\n");
      await this.app.vault.create(NOTE_PATH, "# \u63A2\u9488\u7B14\u8BB0\n\n\u53EA\u4F5C\u4E3A\u53CC\u94FE\u76EE\u6807\n");
      await this.app.vault.create(LINK_EMBED_PATH, "# \u5D4C\u5165\u76EE\u6807\n\n\u88AB embed\n");
      const source = await this.ensureFile(LINK_SOURCE_PATH, LINK_SOURCE_BODY);
      const cache = await this.awaitFileCache(source);
      for (let attempt = 0; attempt < 30; attempt++) {
        const probe = this.app.metadataCache.resolvedLinks[source.path] || {};
        if (Object.keys(probe).length >= 3) {
          break;
        }
        await new Promise((resolve) => {
          window.setTimeout(resolve, 100);
        });
      }
      const probeFiles = this.app.vault.getMarkdownFiles().map((file) => file.path).filter((path) => path.indexOf("compat-probe/") === 0);
      probeLog("metadata.links.files", { source: source.path, files: probeFiles.join("|") });
      const resolvedForSource = this.app.metadataCache.resolvedLinks[source.path] || {};
      const unresolvedForSource = this.app.metadataCache.unresolvedLinks[source.path] || {};
      const frontmatter = cache && cache.frontmatter ? cache.frontmatter : null;
      const frontmatterTags = frontmatter && Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
      probeLog("metadata.links", {
        ready: cache !== null,
        links: cache && cache.links ? cache.links.length : -1,
        embeds: cache && cache.embeds ? cache.embeds.length : -1,
        headings: cache && cache.headings ? cache.headings.length : -1,
        tags: cache && cache.tags ? cache.tags.length : -1,
        frontmatterTags: frontmatterTags.length,
        resolved: Object.keys(resolvedForSource).length,
        unresolved: Object.keys(unresolvedForSource).length,
        firstLinkDest: this.app.metadataCache.getFirstLinkpathDest("links-target", source.path) !== null,
        missingDest: this.app.metadataCache.getFirstLinkpathDest("links-missing-note", source.path) !== null
      });
      probeLog("metadata.links.unresolved", { keys: Object.keys(unresolvedForSource).join(",") });
      probeLog("metadata.links.keys", { resolved: Object.keys(resolvedForSource).join(",") });
      const before = this.graphEvents.rename + this.graphEvents.changed + this.graphEvents.resolved;
      const moveTarget = this.app.vault.getAbstractFileByPath(LINK_TARGET_PATH);
      if (!(moveTarget instanceof import_obsidian.TFile)) {
        probeLog("metadata.links.rename.skip", { reason: "target missing" });
        return;
      }
      this.graphEvents.rename = 0;
      this.graphEvents.changed = 0;
      this.graphEvents.resolved = 0;
      await this.app.vault.rename(moveTarget, RENAMED_PATH);
      await this.waitGraphEvents();
      probeLog("metadata.links.rename", {
        eventsBefore: before,
        rename: this.graphEvents.rename,
        changed: this.graphEvents.changed,
        resolved: this.graphEvents.resolved,
        allArrived: this.graphEvents.rename > 0 && this.graphEvents.changed > 0 && this.graphEvents.resolved > 0,
        afterResolved: Object.keys(this.app.metadataCache.resolvedLinks[source.path] || {}).length,
        afterUnresolved: Object.keys(this.app.metadataCache.unresolvedLinks[source.path] || {}).length,
        oldLinkGone: this.app.metadataCache.getFirstLinkpathDest("links-target", source.path) === null,
        newLinkLive: this.app.metadataCache.getFirstLinkpathDest("links-target-renamed", source.path) !== null
      });
      probeLog("metadata.links.rename.diag", {
        oldDest: (this.app.metadataCache.getFirstLinkpathDest("links-target", source.path) || { path: "" }).path,
        oldByPath: this.app.vault.getAbstractFileByPath(LINK_TARGET_PATH) !== null,
        keys: Object.keys(this.app.metadataCache.resolvedLinks[source.path] || {}).join(";")
      });
      probeLog("metadata.links.done", {});
    } catch (error) {
      probeLog("metadata.links.error", { error: String(error) });
    }
  }
  async waitGraphEvents() {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (this.graphEvents.rename > 0 && this.graphEvents.changed > 0 && this.graphEvents.resolved > 0) {
        return;
      }
      await new Promise((resolve) => {
        window.setTimeout(resolve, 100);
      });
    }
  }
  async ensureFile(path, body) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof import_obsidian.TFile) {
      return existing;
    }
    return this.app.vault.create(path, body);
  }
  onunload() {
    probeLog("plugin.onunload", { viewType: VIEW_TYPE });
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  /** 逐条跑通曾经没有 handler 的通道:每条一行打点,缺一条 M1-B 就不算过。 */
  async runChannelProbe() {
    try {
      const previous = await this.app.loadLocalStorage("compat-probe:launch");
      const launches = (typeof previous === "number" ? previous : 0) + 1;
      await this.app.saveLocalStorage("compat-probe:launch", launches);
      await this.app.saveLocalStorage("compat-probe:stamp", { at: Date.now(), tag: this.settings.tag });
      const stored = await this.app.loadLocalStorage("compat-probe:stamp");
      probeLog("channel.localStorage", {
        roundTrip: stored !== null && stored !== void 0,
        tag: stored && typeof stored === "object" ? String(stored.tag || "") : "",
        launches
      });
    } catch (error) {
      probeLog("channel.localStorage.error", { error: String(error) });
    }
    this.app.workspace.onLayoutReady(() => {
      probeLog("channel.onLayoutReady", { fired: true });
    });
    try {
      const listed = await this.app.commands.listCommands();
      const echoed = await this.app.commands.executeCommandById("compat-probe:probe-echo");
      probeLog("channel.commands", {
        listed: listed ? listed.length : -1,
        echoed: echoed === true,
        echoCount: this.echoCount
      });
    } catch (error) {
      probeLog("channel.commands.error", { error: String(error) });
    }
    try {
      const hostOnly = await this.app.commands.executeCommandById("lexinote:no-such-command");
      probeLog("channel.commandsHost", { hostFallback: true, executed: hostOnly === true, rejected: false });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      probeLog("channel.commandsHost", {
        hostFallback: true,
        executed: false,
        rejected: reason.indexOf("\u547D\u4EE4\u4E0D\u5B58\u5728") >= 0,
        message: reason
      });
    }
    try {
      const selfcheck = await this.app.commands.executeCommandById("lexinote:host-only-selfcheck");
      probeLog("channel.commandsHostOnly", { executed: selfcheck === true, rejected: false });
    } catch (error) {
      probeLog("channel.commandsHostOnly", { executed: false, rejected: true, message: String(error) });
    }
    try {
      const statusbar = this.addStatusBarItem();
      statusbar.setText("compat-probe");
      const modal = new ProbeModal(this.app);
      modal.open();
      probeLog("channel.placeholder", {
        statusbar: document.querySelectorAll(".status-bar-item.plugin-status-bar-item").length,
        modals: document.querySelectorAll(".modal-container .modal").length,
        title: document.querySelectorAll(".modal-container .modal-title").length
      });
      modal.close();
    } catch (error) {
      probeLog("channel.placeholder.error", { error: String(error) });
    }
    try {
      const opened = await this.app.workspace.openLinkText("probe-note", NOTE_PATH, false);
      probeLog("channel.openLinkText", { resolved: opened !== null && opened !== void 0 });
    } catch (error) {
      probeLog("channel.openLinkText.error", { error: String(error) });
    }
  }
  async openProbeView() {
    try {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
      probeLog("view.setViewState", { leaves: leaves.length, viewType: VIEW_TYPE });
    } catch (error) {
      probeLog("view.setViewState.error", { error: String(error) });
    }
  }
  async runProbe(source) {
    try {
      const target = await this.ensureNote();
      const before = await this.app.vault.read(target);
      const stamp = (/* @__PURE__ */ new Date()).toISOString();
      await this.app.vault.modify(target, before + "\n- " + stamp + " \u63A2\u9488\u5199\u5165 (" + source + ")\n");
      probeLog("vault.modify", { path: target.path, bytesBefore: before.length });
      const cache = await this.awaitFileCache(target);
      probeLog("metadata.getFileCache", {
        ready: cache !== null,
        headings: cache && cache.headings ? cache.headings.length : -1,
        links: cache && cache.links ? cache.links.length : -1
      });
      new import_obsidian.Notice("compat-probe \u5B8C\u6210:" + (cache ? "metadata \u5C31\u7EEA" : "metadata \u672A\u5C31\u7EEA"));
      probeLog("probe.done", { source });
    } catch (error) {
      probeLog("probe.error", { error: String(error) });
    }
  }
  async ensureNote() {
    const files = await this.app.vault.getMarkdownFiles();
    for (const candidate of files) {
      if (candidate.path === NOTE_PATH) {
        return candidate;
      }
    }
    const created = await this.app.vault.create(NOTE_PATH, "# \u517C\u5BB9\u63A2\u9488\n\n\u521D\u59CB\u5185\u5BB9\n");
    probeLog("vault.create", { path: created.path });
    return created;
  }
  async awaitFileCache(file) {
    for (let attempt = 0; attempt < 15; attempt++) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache) {
        return cache;
      }
      await new Promise((resolve) => {
        window.setTimeout(resolve, 200);
      });
    }
    return null;
  }
};
