import {
  App,
  CachedMetadata,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownView,
  TFile,
  WorkspaceLeaf,
  editorInfoField,
} from 'obsidian';
import * as cmState from '@codemirror/state';
import * as cmView from '@codemirror/view';

// compat-probe 只使用官方 obsidian.d.ts 里的签名与语义。
// 任何一处跑不通,都要在兼容层里修,不许在这里绕。

// P4-006b(R39-B):宿主两轨(runtime/legacy 与沙箱)都按 fail-closed 拒绝外部模块,
// 所以 @codemirror/* 必须随 main.js 打包(esbuild bundle,不再 external)。
// 但 CM6 双副本不会报错、只会让 ViewPlugin/StateField 静默失效,而 workspace 页经
// window.__lexiCmModules 注入的正是与编辑器同一份实例 —— 所以注册表里有就优先取宿主
// 那份,打包副本只做注册表缺席(runtime 轨)时的兜底。两条轨都不需要外部模块。
function preferSharedCm<T>(name: string, bundled: T): T {
  const registry = (window as unknown as { __lexiCmModules?: Record<string, unknown> }).__lexiCmModules;
  if (registry && Object.prototype.hasOwnProperty.call(registry, name) && registry[name]) {
    return registry[name] as T;
  }
  return bundled;
}
const cmStateApi = preferSharedCm('@codemirror/state', cmState);
const cmViewApi = preferSharedCm('@codemirror/view', cmView);

const VIEW_TYPE = 'compat-probe-view';
// vault 内的路径一律相对 vault 根(宿主把多出来的首段丢掉,写 'probe/...' 会落到别的目录)。
const COMPAT_DIR = 'compat-probe/';
const NOTE_PATH = 'compat-probe/probe-note.md';
// 链接图探针:3 个 wikilink(1 个指向不存在的文件)+ 1 个 embed + frontmatter tags。
const LINK_SOURCE_PATH = 'compat-probe/links-source.md';
const LINK_TARGET_PATH = 'compat-probe/links-target.md';
const LINK_EMBED_PATH = 'compat-probe/links-embed.md';
const RENAMED_PATH = 'compat-probe/links-target-renamed.md';
const LINK_SOURCE_BODY = [
  '---',
  'tags: [probe-frontmatter, graph]',
  '---',
  '# 链接探针',
  '',
  '一 [[probe-note]]',
  '二 [[links-missing-note]]',
  '三 [[links-target|别名]]',
  '',
  '![[links-embed]]',
  '',
].join('\n');

interface ProbeSettings {
  tag: string;
}

const DEFAULT_SETTINGS: ProbeSettings = { tag: 'compat' };

function probeLog(topic: string, detail: Record<string, unknown>): void {
  // 容器把含 [lexi] 的 console 行转发到宿主 hilog(web.console)
  console.log('[lexi] probe.' + topic + ' ' + JSON.stringify(detail));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** 轮询等 DOM 出现(扩展装进活 EditorView 才能改 DOM,所以 DOM 是唯一硬证据)。 */
async function waitForCount(selector: string, attempts: number): Promise<number> {
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

class ProbeView extends ItemView {
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return '兼容探针';
  }

  getIcon(): string {
    return 'flask';
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'compat-probe' });
    contentEl.createEl('p', { text: '视图由 registerView + getLeaf().setViewState() 打开' });
    probeLog('view.open', { viewType: this.getViewType() });
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}

class ProbeSettingTab extends PluginSettingTab {
  private probe: CompatProbePlugin;

  constructor(app: App, plugin: CompatProbePlugin) {
    super(app, plugin);
    this.probe = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName('探针标签')
      .setDesc('compat-probe 写入笔记时使用的标签')
      .addText((text) =>
        text.setValue(this.probe.settings.tag).onChange(async (value: string) => {
          this.probe.settings.tag = value;
          await this.probe.saveSettings();
        }),
      );
  }
}

class ProbeModal extends Modal {
  onOpen(): void {
    this.titleEl.setText('compat-probe modal');
    this.contentEl.createEl('p', { text: 'ui.placeholder 的真实 DOM 占位' });
  }
}

export default class CompatProbePlugin extends Plugin {
  settings: ProbeSettings = { ...DEFAULT_SETTINGS };
  private echoCount = 0;

  async onload(): Promise<void> {
    const stored = await this.loadData();
    if (stored && typeof stored === 'object') {
      this.settings = { ...DEFAULT_SETTINGS, ...(stored as Partial<ProbeSettings>) };
    }

    this.addRibbonIcon('flask', 'compat-probe:运行兼容探针', () => {
      void this.runProbe('ribbon');
    });

    this.addCommand({
      id: 'run-probe',
      name: 'compat-probe:运行兼容探针',
      callback: () => {
        void this.runProbe('command');
      },
    });

    this.addCommand({
      id: 'probe-echo',
      name: 'compat-probe:回声命令(验证 commands.execute 同页执行)',
      callback: () => {
        this.echoCount += 1;
        probeLog('command.echo', { count: this.echoCount });
      },
    });

    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new ProbeView(leaf));
    this.addSettingTab(new ProbeSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on('file-open', (file: TFile | null) => {
        probeLog('workspace.file-open', { path: file ? file.path : '' });
      }),
    );
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        probeLog('workspace.layout-change', {});
      }),
    );

    this.registerGraphEvents();
    this.app.workspace.onLayoutReady(() => {
      probeLog('calendar.scan.start', { leaves: this.app.workspace.getLeavesOfType('calendar').length });
      void this.probeCalendarLeaf();
      this.probeOutliner();
      this.probeLeafKeys();
    });

    probeLog('plugin.onload', { viewType: VIEW_TYPE, tag: this.settings.tag });
    await this.runChannelProbe();
    await this.openProbeView();
    await this.runProbe('onload');
    await this.runLinkGraphProbe();
    this.probeCmIdentity();
    await this.probeExtensionLifecycle();
    const editor = this.acquireEditor();
    if (editor) {
      await this.probeEditorOps(editor);
    } else {
      probeLog('editor.missing', { route: 'getActiveViewOfType(MarkdownView)' });
    }
  }

  /** C2-③:CM6 必须是同一份实例。两份副本时 ViewPlugin/StateField 静默失效,所以只认构造器/模块对象恒等。 */
  private probeCmIdentity(): void {
    // esbuild 的 __toESM 会包一层,所以 namespace 对象本身不相等;可判定的是构造器与实例状态。
    // P4-006b 后包内自带 CM 打包副本;cmStateApi/cmViewApi 已按 preferSharedCm 优先对齐宿主注册表。
    // runtime 轨没有 workspace 的 editorIdentity 面,editorIdentity() 会返回 null —— 探针如实
    // 记 liveSame=false,不得让探针本身崩掉 onload。
    const registry = ((window as any).__lexiCmModules || {}) as Record<string, any>;
    const liveApi = (window as any).LexiObsidian;
    const live = liveApi && typeof liveApi.editorIdentity === 'function' ? liveApi.editorIdentity() : null;
    const regState = registry['@codemirror/state'] || {};
    const regView = registry['@codemirror/view'] || {};
    // 构造器恒等只能说明注册表与包内选中的模块是同一份;真正的行为证据是插件拿到的 editorInfoField
    // 能在活 EditorView 的 state 上取到值 —— 两份 @codemirror/state 时 StateField 键不同,field() 会抛。
    const editor = this.acquireEditor();
    const cm = editor && editor.cm ? editor.cm : null;
    let fieldReadable = false;
    try {
      fieldReadable = !!(cm && cm.state.field(editorInfoField));
    } catch (err) {
      fieldReadable = false;
    }
    probeLog('editor.identity', {
      ctorSame: regState.EditorState === cmStateApi.EditorState && regView.EditorView === cmViewApi.EditorView,
      liveSame: !!(live && live.stateCtor === cmStateApi.EditorState && live.viewCtor === cmViewApi.EditorView),
      liveCtorSame: !!(live && live.liveStateCtorSame === true && live.liveViewCtorSame === true),
      fieldReadable,
      hasCm: !!cm,
    });
  }

  /** outliner 唯一的取编辑器入口就是这一条,探针走同一条路。 */
  private acquireEditor(): any {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView) as unknown as { editor?: unknown } | null;
    return view && view.editor ? view.editor : null;
  }

  /** C2-②:扩展装进活 EditorView(DOM 变了才算装),撤掉后 DOM 必须消失。 */
  private async probeExtensionLifecycle(): Promise<void> {
    // 撤扩展时 CM6 必须调 destroy():属性由插件自己清,才能证明扩展真的被卸掉而不是只是不再更新。
    // cmViewApi = 宿主注册表实例优先(P4-006b),注册表缺席才用打包副本。
    const probeExt = cmViewApi.ViewPlugin.fromClass(
      class {
        private view: any;
        constructor(view: any) {
          this.view = view;
          view.dom.setAttribute('data-lexi-probe-ext', 'on');
        }
        update(): void {}
        destroy(): void {
          this.view.dom.removeAttribute('data-lexi-probe-ext');
        }
      },
    );
    let installError = '';
    try {
      this.registerEditorExtension(probeExt);
    } catch (error) {
      // 第二份 CM6 副本装扩展会在这里抛 Unrecognized extension value,不会静默
      installError = String(error);
    }
    const selector = '.cm-editor[data-lexi-probe-ext="on"]';
    const mounts = await waitForCount(selector, 20);
    probeLog('editor.ext.install', {
      installed: mounts > 0,
      mounts: mounts,
      error: installError,
      count: (window as any).LexiObsidian.editorExtensionCount('compat-probe'),
    });
    (window as any).LexiObsidian.releaseEditorExtensions('compat-probe');
    await wait(150);
    const remaining = document.querySelectorAll(selector).length;
    probeLog('editor.ext.release', {
      removed: remaining === 0,
      remaining: remaining,
      count: (window as any).LexiObsidian.editorExtensionCount('compat-probe'),
    });
  }

  /** C2-③:undo/redo 落到 CM6 history,exec/processLines 落到 transaction。 */
  private async probeEditorOps(editor: any): Promise<void> {
    // P4-006b:与文件里其他探针同一纪律 —— 探针失败要"如实打点",不许炸掉 onload。
    // runtime 轨宿主可能给出"占位 editor"(有对象无容器),editor.undo 会抛
    // "editor.undo 需要同页编辑器(容器未就绪)" —— 这本身就是要上报的兼容面读数。
    try {
      await editor.setValue('alpha');
      // CM6 的 history 会把 500ms 内的连续改动并成一组;等过窗口才能证明 undo 回滚的是这一次 replace。
      await wait(700);
      editor.replaceRange('beta', { line: 0, ch: 5 });
      const edited = editor.getValue();
      editor.undo();
      const undone = editor.getValue();
      editor.redo();
      const redone = editor.getValue();
      probeLog('editor.undo', {
        editedOk: edited === 'alphabeta',
        undoneOk: undone === 'alpha',
        redoneOk: redone === 'alphabeta',
      });

      await editor.setValue('one\ntwo\nthree');
      const ran = editor.exec('selectAll') === true;
      const selected = editor.getSelection();
      probeLog('editor.exec', { ran: ran, selLen: selected.length });

      editor.processLines((line: string, index: number) => (index === 0 ? line.toUpperCase() : line));
      const processed = editor.getValue();
      probeLog('editor.processLines', { ok: processed === 'ONE\ntwo\nthree' });
    } catch (error) {
      probeLog('editor.ops.error', { error: String(error) });
    }
  }

  /** C2-⑦:重启后同一 (type, 去 active 的 state) 的 leaf 数必须 ≤1。 */
  private probeLeafKeys(): void {
    const keys: string[] = (window as any).LexiObsidian.layoutKeys();
    const seen: Record<string, number> = {};
    let duplicates = 0;
    keys.forEach((key) => {
      if (seen[key]) {
        duplicates += 1;
      }
      seen[key] = (seen[key] || 0) + 1;
    });
    probeLog('editor.leaves', { leaves: keys.length, unique: Object.keys(seen).length, duplicates: duplicates });
  }

  /** C2-④:outliner 零改动装载后,它的扩展要在活编辑器的 DOM 上留下痕迹。 */
  private probeOutliner(): void {
    const extCount = (window as any).LexiObsidian.editorExtensionCount('obsidian-outliner');
    probeLog('editor.outliner', {
      extCount: extCount,
      markers: document.querySelectorAll('.cm-editor [class*="outliner-plugin-"]').length,
      bodyClass: document.body.classList.contains('outliner-plugin-better-lists'),
    });
  }

/** 日历是第三方零改动的验收物:它自己的 initLeaf 挂在 layout-ready 上,所以等它落完再断言。 */
  private async probeCalendarLeaf(): Promise<void> {
    let leaves: WorkspaceLeaf[] = [];
    let el: HTMLElement | null = null;
    let rendered = false;
    let attempts = 0;
    // 日历的 onOpen 先 await 设置再建 Svelte 组件,leaf 存在 ≠ 已渲染,必须等 .calendar 真出现。
    for (attempts = 0; attempts < 60; attempts += 1) {
      leaves = this.app.workspace.getLeavesOfType('calendar');
      if (leaves.length > 0) {
        const view = leaves[0].view as { contentEl?: HTMLElement } | null;
        el = view && view.contentEl ? view.contentEl : null;
        rendered = !!(el && el.querySelector('.calendar'));
        if (rendered) {
          break;
        }
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 250);
      });
    }
    const view = leaves.length > 0 ? (leaves[0].view as { getViewType?: () => string } | null) : null;
    probeLog('calendar.leaf', {
      viewType: view && view.getViewType ? view.getViewType() : '',
      leaves: leaves.length,
      rendered: rendered,
      attempts: attempts,
      domNodes: el ? el.childElementCount : 0,
      connected: !!(el && el.isConnected),
      className: el ? el.className : '',
      htmlLength: el ? el.innerHTML.length : 0,
      active: leaves.length > 0 && this.app.workspace.activeLeaf === leaves[0],
    });
  }

  /** 事件全量推送的负面要求:改名一份被双链引用的笔记,rename + changed + resolved 三者都要到。 */
  private graphEvents: Record<string, number> = { rename: 0, changed: 0, resolved: 0, 'modify': 0 };

  private registerGraphEvents(): void {
    this.registerEvent(
      this.app.vault.on('rename', (file: TFile, oldPath: string) => {
        this.graphEvents.rename += 1;
        probeLog('event.vault.rename', { path: file.path, oldPath: oldPath });
      }),
    );
    this.registerEvent(
      this.app.vault.on('modify', (file: TFile) => {
        this.graphEvents.modify += 1;
        probeLog('event.vault.modify', { path: file.path, count: this.graphEvents.modify });
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on('changed', (file: TFile) => {
        this.graphEvents.changed += 1;
        probeLog('event.metadata.changed', { path: file.path, count: this.graphEvents.changed });
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on('resolved', () => {
        this.graphEvents.resolved += 1;
        probeLog('event.metadata.resolved', { count: this.graphEvents.resolved });
      }),
    );
  }

  private async runLinkGraphProbe(): Promise<void> {
    try {
      // 起点必须干净:历史轮次留下的同名副本会让"重命名后该失效的链接"仍然命中,
      // 测出来的就不是本轮语义。先清空探针目录,再按官方 API 重建固定三个文件。
      const stale = this.app.vault
        .getMarkdownFiles()
        .filter((file: TFile) => file.path.indexOf(COMPAT_DIR) === 0);
      for (const file of stale) {
        await this.app.vault.delete(file, true);
      }
      probeLog('metadata.links.cleanup', { deleted: stale.length });
      await this.app.vault.create(LINK_TARGET_PATH, '# 链接目标\n\n被双链引用\n');
      await this.app.vault.create(NOTE_PATH, '# 探针笔记\n\n只作为双链目标\n');
      await this.app.vault.create(LINK_EMBED_PATH, '# 嵌入目标\n\n被 embed\n');
      const source = await this.ensureFile(LINK_SOURCE_PATH, LINK_SOURCE_BODY);
      const cache = await this.awaitFileCache(source);
      // 链接图由宿主异步重建:等到它认识这篇笔记的解析结果再取样,否则读到的是启动时的旧图。
      for (let attempt = 0; attempt < 30; attempt++) {
        const probe = this.app.metadataCache.resolvedLinks[source.path] || {};
        if (Object.keys(probe).length >= 3) {
          break;
        }
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 100);
        });
      }
      const probeFiles = this.app.vault
        .getMarkdownFiles()
        .map((file: TFile) => file.path)
        .filter((path: string) => path.indexOf('compat-probe/') === 0);
      probeLog('metadata.links.files', { source: source.path, files: probeFiles.join('|') });
      const resolvedForSource = this.app.metadataCache.resolvedLinks[source.path] || {};
      const unresolvedForSource = this.app.metadataCache.unresolvedLinks[source.path] || {};
      const frontmatter = cache && cache.frontmatter ? cache.frontmatter : null;
      const frontmatterTags = frontmatter && Array.isArray(frontmatter.tags) ? (frontmatter.tags as string[]) : [];
      probeLog('metadata.links', {
        ready: cache !== null,
        links: cache && cache.links ? cache.links.length : -1,
        embeds: cache && cache.embeds ? cache.embeds.length : -1,
        headings: cache && cache.headings ? cache.headings.length : -1,
        tags: cache && cache.tags ? cache.tags.length : -1,
        frontmatterTags: frontmatterTags.length,
        resolved: Object.keys(resolvedForSource).length,
        unresolved: Object.keys(unresolvedForSource).length,
        firstLinkDest: this.app.metadataCache.getFirstLinkpathDest('links-target', source.path) !== null,
        missingDest: this.app.metadataCache.getFirstLinkpathDest('links-missing-note', source.path) !== null,
      });
      probeLog('metadata.links.unresolved', { keys: Object.keys(unresolvedForSource).join(',') });
      probeLog('metadata.links.keys', { resolved: Object.keys(resolvedForSource).join(',') });

      const before = this.graphEvents.rename + this.graphEvents.changed + this.graphEvents.resolved;
      const moveTarget = this.app.vault.getAbstractFileByPath(LINK_TARGET_PATH);
      if (!(moveTarget instanceof TFile)) {
        probeLog('metadata.links.rename.skip', { reason: 'target missing' });
        return;
      }
      this.graphEvents.rename = 0;
      this.graphEvents.changed = 0;
      this.graphEvents.resolved = 0;
      await this.app.vault.rename(moveTarget, RENAMED_PATH);
      await this.waitGraphEvents();
      probeLog('metadata.links.rename', {
        eventsBefore: before,
        rename: this.graphEvents.rename,
        changed: this.graphEvents.changed,
        resolved: this.graphEvents.resolved,
        allArrived: this.graphEvents.rename > 0 && this.graphEvents.changed > 0 && this.graphEvents.resolved > 0,
        afterResolved: Object.keys(this.app.metadataCache.resolvedLinks[source.path] || {}).length,
        afterUnresolved: Object.keys(this.app.metadataCache.unresolvedLinks[source.path] || {}).length,
        oldLinkGone: this.app.metadataCache.getFirstLinkpathDest('links-target', source.path) === null,
        newLinkLive: this.app.metadataCache.getFirstLinkpathDest('links-target-renamed', source.path) !== null,
      });
      probeLog('metadata.links.rename.diag', {
        oldDest: (this.app.metadataCache.getFirstLinkpathDest('links-target', source.path) || { path: '' }).path,
        oldByPath: this.app.vault.getAbstractFileByPath(LINK_TARGET_PATH) !== null,
        keys: Object.keys(this.app.metadataCache.resolvedLinks[source.path] || {}).join(';'),
      });
      probeLog('metadata.links.done', {});
    } catch (error) {
      probeLog('metadata.links.error', { error: String(error) });
    }
  }

  private async waitGraphEvents(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (this.graphEvents.rename > 0 && this.graphEvents.changed > 0 && this.graphEvents.resolved > 0) {
        return;
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 100);
      });
    }
  }

  private async ensureFile(path: string, body: string): Promise<TFile> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      return existing;
    }
    return this.app.vault.create(path, body);
  }

  onunload(): void {
    probeLog('plugin.onunload', { viewType: VIEW_TYPE });
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** 逐条跑通曾经没有 handler 的通道:每条一行打点,缺一条 M1-B 就不算过。 */
  private async runChannelProbe(): Promise<void> {
    try {
      // launches 每次装载 +1:跨应用重启仍在,才证明落到了真实持久化而不是内存表。
      const previous = await this.app.loadLocalStorage('compat-probe:launch');
      const launches = (typeof previous === 'number' ? previous : 0) + 1;
      await this.app.saveLocalStorage('compat-probe:launch', launches);
      await this.app.saveLocalStorage('compat-probe:stamp', { at: Date.now(), tag: this.settings.tag });
      const stored = await this.app.loadLocalStorage('compat-probe:stamp');
      probeLog('channel.localStorage', {
        roundTrip: stored !== null && stored !== undefined,
        tag: stored && typeof stored === 'object' ? String((stored as { tag?: string }).tag || '') : '',
        launches: launches,
      });
    } catch (error) {
      probeLog('channel.localStorage.error', { error: String(error) });
    }

    this.app.workspace.onLayoutReady(() => {
      probeLog('channel.onLayoutReady', { fired: true });
    });

    try {
      const listed = await this.app.commands.listCommands();
      const echoed = await this.app.commands.executeCommandById('compat-probe:probe-echo');
      probeLog('channel.commands', {
        listed: listed ? listed.length : -1,
        echoed: echoed === true,
        echoCount: this.echoCount,
      });
    } catch (error) {
      probeLog('channel.commands.error', { error: String(error) });
    }

    // 本地优先执行之外还要证明宿主 handler 仍活着:命中一个只存在于宿主注册表的 id,
    // 走 commands.execute 的宿主兜底路径(旧宿主的 41 条 handler 才不会变成死码)。
    try {
      const hostOnly = await this.app.commands.executeCommandById('lexinote:no-such-command');
      probeLog('channel.commandsHost', { hostFallback: true, executed: hostOnly === true, rejected: false });
    } catch (error) {
      // 宿主正确地拒绝了一个不存在的命令 => handler 活着且做了 canExecute 判定。
      const reason = error instanceof Error ? error.message : String(error);
      probeLog('channel.commandsHost', {
        hostFallback: true,
        executed: false,
        rejected: reason.indexOf('命令不存在') >= 0,
        message: reason,
      });
    }

    // 只有『正确拒绝』证明不了宿主执行面:必须有一个只存在于宿主注册表的命令真的被执行并回结果。
    try {
      const selfcheck = await this.app.commands.executeCommandById('lexinote:host-only-selfcheck');
      probeLog('channel.commandsHostOnly', { executed: selfcheck === true, rejected: false });
    } catch (error) {
      probeLog('channel.commandsHostOnly', { executed: false, rejected: true, message: String(error) });
    }

    try {
      const statusbar = this.addStatusBarItem();
      statusbar.setText('compat-probe');
      const modal = new ProbeModal(this.app);
      modal.open();
      probeLog('channel.placeholder', {
        statusbar: document.querySelectorAll('.status-bar-item.plugin-status-bar-item').length,
        modals: document.querySelectorAll('.modal-container .modal').length,
        title: document.querySelectorAll('.modal-container .modal-title').length,
      });
      modal.close();
    } catch (error) {
      probeLog('channel.placeholder.error', { error: String(error) });
    }

    try {
      const opened = await this.app.workspace.openLinkText('probe-note', NOTE_PATH, false);
      probeLog('channel.openLinkText', { resolved: opened !== null && opened !== undefined });
    } catch (error) {
      probeLog('channel.openLinkText.error', { error: String(error) });
    }
  }

  private async openProbeView(): Promise<void> {
    try {
      const leaf = this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
      probeLog('view.setViewState', { leaves: leaves.length, viewType: VIEW_TYPE });
    } catch (error) {
      probeLog('view.setViewState.error', { error: String(error) });
    }
  }

  private async runProbe(source: string): Promise<void> {
    try {
      const target = await this.ensureNote();
      const before = await this.app.vault.read(target);
      const stamp = new Date().toISOString();
      await this.app.vault.modify(target, before + '\n- ' + stamp + ' 探针写入 (' + source + ')\n');
      probeLog('vault.modify', { path: target.path, bytesBefore: before.length });

      const cache = await this.awaitFileCache(target);
      probeLog('metadata.getFileCache', {
        ready: cache !== null,
        headings: cache && cache.headings ? cache.headings.length : -1,
        links: cache && cache.links ? cache.links.length : -1,
      });
      new Notice('compat-probe 完成:' + (cache ? 'metadata 就绪' : 'metadata 未就绪'));
      probeLog('probe.done', { source: source });
    } catch (error) {
      probeLog('probe.error', { error: String(error) });
    }
  }

  private async ensureNote(): Promise<TFile> {
    const files = await this.app.vault.getMarkdownFiles();
    for (const candidate of files) {
      if (candidate.path === NOTE_PATH) {
        return candidate;
      }
    }
    const created = await this.app.vault.create(NOTE_PATH, '# 兼容探针\n\n初始内容\n');
    probeLog('vault.create', { path: created.path });
    return created;
  }

  private async awaitFileCache(file: TFile): Promise<CachedMetadata | null> {
    for (let attempt = 0; attempt < 15; attempt++) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache) {
        return cache;
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 200);
      });
    }
    return null;
  }
}
