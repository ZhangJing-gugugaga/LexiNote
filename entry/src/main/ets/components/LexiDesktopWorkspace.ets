import { LexiContextSurface } from './LexiContextSurface';
import { LexiContextTarget } from '../core/LexiContextModels';
import { deviceInfo } from '@kit.BasicServicesKit';
import { LexiIcon } from './LexiIcon';
import { LexiWorkspaceEditor } from './LexiWorkspaceEditor';
import { LexiWorkspaceMindMap } from './LexiWorkspaceMindMap';
import { CanvasBoard, LexiProject, MindMapDoc, NoteItem, VaultItem } from '../core/LexiModels';
import { LexiWorkspaceTab } from '../core/LexiWorkspaceModels';
import { MarkdownEngine } from '../core/MarkdownEngine';
import { LexiSearch } from '../core/LexiSearch';
import { LexiCommandPalette } from './LexiCommandPalette';
import { LexiPluginManager } from '../core/plugin/LexiPluginRuntime';
import { LexiEditorRegistry } from '../core/plugin/LexiEditorRegistry';
import { FrameCallback } from '@kit.ArkUI';
import { LexiTabStripLayout } from '../core/LexiTabStripLayout';

class LexiWorkspaceTabFrame extends FrameCallback {
  private perform: () => void;
  constructor(perform: () => void) { super(); this.perform = perform; }
  onIdle(_remaining: number): void { this.perform(); }
}

interface LexiWorkspaceActionParams {
  iconName: string;
  label: string;
  action: () => void;
  selected?: boolean;
}

interface LexiWorkspaceNoteRowParams { note: NoteItem; }

@Builder
function lexiWorkspaceEmptySlot() {}

@Component
export struct LexiDesktopWorkspace {
  @StorageProp('lexiTopInset') topInset: number = 0;
  @StorageProp('lexiWindowButtonsInset') windowButtonsInset: number = 0;
  @Prop projects: LexiProject[] = [];
  @Prop @Watch('projectChanged') activeProjectId: string = '';
  @Prop activeProjectName: string = '全部项目';
  @Prop viewportWidth: number = 1200;
  @Prop @Watch('documentsChanged') notes: NoteItem[] = [];
  @Prop @Watch('documentsChanged') maps: MindMapDoc[] = [];
  @Prop canvases: CanvasBoard[] = [];
  @Prop vaults: VaultItem[] = [];
  @Prop @Watch('vaultChanged') activeVaultId: string = '';
  @Prop activeVaultName: string = '';
  @Prop activeSection: number = 0;
  @Prop lastEditedNoteId: string = '';
  @Prop requestedOpenMode: string = 'tab';
  @Prop requestedNoteId: string = '';
  @Prop @Watch('requestedChanged') openRevision: number = 0;
  @Prop routeActive: boolean = false;
  @State private sidebarOpen: boolean = true;
  @State private searchText: string = '';
  @State private favoritesOnly: boolean = false;
  @State private closedFolders: string[] = [];
  @State private groupTabs: LexiWorkspaceTab[] = [];
  @State @Watch('scheduleActiveTabReveal') private tabs: LexiWorkspaceTab[] = [];
  @State @Watch('scheduleActiveTabReveal') private selectedId: string = '';
  @State @Watch('scheduleActiveTabReveal') private tabViewportWidth: number = 0;
  private tabScroller: Scroller = new Scroller();
  private tabLayoutRevision: number = 0;
  @State private switchingVault: boolean = false;
  @State private showPalette: boolean = false;
  @State private paletteMode: string = 'commands';
  routingStack: NavPathStack = new NavPathStack();
  @BuilderParam auxiliaryContent: () => void = lexiWorkspaceEmptySlot;
  onSelectProject: (projectId: string) => Promise<void> = async (_id: string): Promise<void> => {};
  onManageWorkspaces: () => void = (): void => {};
  onSelectSection: (index: number) => void = (_index: number): void => {};
  onCreateNote: () => void = (): void => {};
  onSaved: (note: NoteItem) => void = (_note: NoteItem): void => {};
  onMapSaved: (doc: MindMapDoc) => void = (_doc: MindMapDoc): void => {};
  onSwitchVault: (vaultId: string) => Promise<void> = async (_id: string): Promise<void> => {};
  onOpenMap: (mapId: string) => void = (_id: string): void => {};
  onCreateMap: () => void = (): void => {};
  onOpenCanvas: (canvasId: string) => void = (_id: string): void => {};
  onCreateCanvas: () => void = (): void => {};
  onConvertMap: (noteId: string) => void = (_id: string): void => {};
  onOpenAdvancedNote: (noteId: string) => void = (_id: string): void => {};
  onOpenHelp: () => void = (): void => {};
  onExecuteCommand: (command: string, noteId: string, title: string) => Promise<void> =
    async (_command: string, _id: string, _title: string): Promise<void> => {};

  aboutToAppear(): void {
    this.routingStack.disableAnimation(true);
    this.openInitialDocument();
  }

  aboutToDisappear(): void { this.tabLayoutRevision++; }

  private inlineContextMenus(): boolean { return deviceInfo.deviceType !== '2in1'; }

  private scheduleActiveTabReveal(): void {
    const revision = ++this.tabLayoutRevision;
    const uiContext = this.getUIContext();
    uiContext.postFrameCallback(new LexiWorkspaceTabFrame((): void => {
      if (revision !== this.tabLayoutRevision || this.tabViewportWidth <= 0) { return; }
      const node = uiContext.getAttachedFrameNodeById('workspace-tab-scroll');
      if (!node || !node.isAttached() || !node.isVisible()) { return; }
      try {
        const current = this.tabScroller.currentOffset().xOffset;
        const index = this.tabs.findIndex((tab: LexiWorkspaceTab): boolean => tab.noteId === this.selectedId);
        const offset = LexiTabStripLayout.revealOffset(this.tabViewportWidth, this.tabs.length, index, current);
        if (Math.abs(offset - current) > 0.5) { this.tabScroller.scrollTo({ xOffset: offset, yOffset: 0 }); }
      } catch {
        // The window can detach between the frame callback and the scroll request.
      }
    }));
  }

  private isTabValid(docId: string): boolean {
    if (docId.startsWith('map:')) {
      const mapId = docId.substring(4);
      return this.maps.some((m: MindMapDoc): boolean => m.id === mapId && m.trashedAt === 0 &&
        (!m.projectId || this.projects.some((project: LexiProject): boolean => project.id === m.projectId)));
    }
    return this.notes.some((n: NoteItem): boolean => n.id === docId && n.trashedAt === 0 &&
      (!n.projectId || this.projects.some((project: LexiProject): boolean => project.id === n.projectId)));
  }

  private openInitialDocument(): void {
    const available = this.notes.filter((n: NoteItem): boolean => n.vaultId === this.activeVaultId && n.trashedAt === 0 &&
      (!this.activeProjectId || n.projectId === this.activeProjectId));
    const availableMaps = this.maps.filter((m: MindMapDoc): boolean => m.vaultId === this.activeVaultId && m.trashedAt === 0 &&
      (!this.activeProjectId || m.projectId === this.activeProjectId));
    if (this.selectedId.startsWith('map:')) {
      const mapId = this.selectedId.substring(4);
      if (availableMaps.some((m: MindMapDoc): boolean => m.id === mapId)) { return; }
    } else if (available.some((note: NoteItem): boolean => note.id === this.selectedId)) {
      return;
    }
    const recent = available.find((n: NoteItem): boolean => n.id === this.lastEditedNoteId);
    if (recent) { this.openDocument(recent.id, false); }
    else if (available.length > 0) { this.openDocument(available[0].id, false); }
    else if (availableMaps.length > 0) { this.openDocument(`map:${availableMaps[0].id}`, false); }
    else { this.selectedId = ''; }
  }

  private projectChanged(): void {
    setTimeout((): void => { this.openInitialDocument(); }, 0);
  }

  private documentsChanged(): void {
    const remaining = this.tabs.filter((tab: LexiWorkspaceTab): boolean => this.isTabValid(tab.noteId));
    this.groupTabs = this.groupTabs.filter((tab: LexiWorkspaceTab): boolean => this.isTabValid(tab.noteId));
    if (remaining.length !== this.tabs.length) {
      this.tabs = remaining;
      if (!remaining.some((tab: LexiWorkspaceTab): boolean => tab.noteId === this.selectedId)) {
        this.selectedId = remaining.length > 0 ? remaining[0].noteId : '';
      }
    }
  }

  private vaultChanged(): void {
    this.tabs = []; this.groupTabs = [];
    this.selectedId = '';
    this.searchText = '';
    this.closedFolders = [];
    // The parent refresh publishes vault and document props together.
    setTimeout((): void => { this.openInitialDocument(); }, 0);
  }

  private requestedChanged(): void {
    if (this.requestedNoteId) {
      if (this.requestedOpenMode === 'group') { this.openGroup(this.requestedNoteId); } else { this.openDocument(this.requestedNoteId); }
    }
  }

  private openDocument(noteId: string, activatePane: boolean = true): void {
    if (!this.tabs.some((tab: LexiWorkspaceTab): boolean => tab.noteId === noteId)) {
      this.tabs = this.tabs.concat([new LexiWorkspaceTab(noteId)]);
    }
    this.selectedId = noteId;
    LexiEditorRegistry.activate(noteId);
    if (activatePane) {
      this.routingStack.clear();
      if (this.activeSection > 1) { this.onSelectSection(1); }
      if (noteId.startsWith('map:')) {
        const mapId = noteId.substring(4);
        const targetMap = this.maps.find((m: MindMapDoc): boolean => m.id === mapId);
        if (targetMap && this.activeProjectId && (targetMap.projectId || '') !== this.activeProjectId) {
          this.onSelectProject(targetMap.projectId || '').catch((): void => {});
        }
      } else {
        const target = this.notes.find((note: NoteItem): boolean => note.id === noteId);
        if (target && this.activeProjectId && (target.projectId || '') !== this.activeProjectId) {
          this.onSelectProject(target.projectId || '').catch((): void => {});
        }
      }
    }
  }

  private async flushAll(): Promise<void> {
    for (const tab of this.tabs.concat(this.groupTabs)) { await tab.controller.flush(); }
  }
  private async openGroup(id: string): Promise<void> {
    await this.flushAll(); this.routingStack.clear(); this.onSelectSection(1);
    this.sidebarOpen = false; this.groupTabs = [new LexiWorkspaceTab(id)];
  }
  private async closeGroup(): Promise<void> {
    await this.flushAll(); this.groupTabs = [];
  }

  private async closeDocument(tab: LexiWorkspaceTab): Promise<void> {
    try { await tab.controller.flush(); } catch {
      this.getUIContext().getPromptAction().showToast({ message: '保存未完成，文档仍保留在标签页中。' });
      return;
    }
    const index = this.tabs.findIndex((item: LexiWorkspaceTab): boolean => item.noteId === tab.noteId);
    const remaining = this.tabs.filter((item: LexiWorkspaceTab): boolean => item.noteId !== tab.noteId);
    if (this.selectedId === tab.noteId) {
      this.selectedId = remaining.length > 0 ? remaining[Math.min(index, remaining.length - 1)].noteId : '';
    }
    this.tabs = remaining;
  }

  private async manageWorkspaces(): Promise<void> {
    try {
      await this.flushAll();
      this.onManageWorkspaces();
    } catch { this.getUIContext().getPromptAction().showToast({ message: '保存未完成，请重试。' }); }
  }

  private async selectProject(projectId: string): Promise<void> {
    try {
      await this.flushAll();
      await this.onSelectProject(projectId);
      this.routingStack.clear(); this.onSelectSection(1);
    } catch { this.getUIContext().getPromptAction().showToast({ message: '切换项目失败，文档已保留。' }); }
  }

  private async showAuxiliary(section: number): Promise<void> {
    try {
      await this.flushAll();
      this.routingStack.clear();
      if (section === 4) { this.sidebarOpen = false; }
      this.onSelectSection(section);
    } catch {
      this.getUIContext().getPromptAction().showToast({ message: '保存未完成，文档已保留，请重试。' });
    }
  }

  private async switchVault(vaultId: string): Promise<void> {
    if (this.switchingVault || vaultId === this.activeVaultId) { return; }
    this.switchingVault = true;
    try {
      await this.flushAll();
      await this.onSwitchVault(vaultId);
      this.routingStack.clear();
    } catch {
      this.getUIContext().getPromptAction().showToast({ message: '保存或切换失败，当前文档已保留，请重试。' });
    } finally { this.switchingVault = false; }
  }

  private visibleNotes(): NoteItem[] {
    return this.notes.filter((n: NoteItem): boolean => n.trashedAt === 0 && n.vaultId === this.activeVaultId &&
      (!n.projectId || this.projects.some((project: LexiProject): boolean => project.id === n.projectId)) &&
      (!this.activeProjectId || n.projectId === this.activeProjectId) && (!this.favoritesOnly || n.favorite) && LexiSearch.matches(n, this.searchText));
  }

  private openPalette(mode: string): void {
    if (this.routeActive) { return; }
    this.paletteMode = mode; this.showPalette = true;
    setTimeout((): void => { this.getUIContext().getFocusController().requestFocus('command-palette-input'); }, 180);
  }

  private async executeCommand(command: string, title: string = ''): Promise<void> {
    this.showPalette = false;
    try {
      if (command === 'switcher') { setTimeout((): void => { this.openPalette('switcher'); }, 120); return; }
      if (command === 'sidebar') { this.sidebarOpen = !this.sidebarOpen; return; }
      if (command === 'reading') {
        const tab = this.tabs.find((item: LexiWorkspaceTab): boolean => item.noteId === this.selectedId);
        if (tab && !this.selectedId.startsWith('map:') && this.activeSection <= 1) { tab.controller.toggleReading(); }
        return;
      }
      await this.flushAll();
      if (command === 'split' && this.selectedId) { await this.openGroup(this.selectedId); }
      else if (command === 'close-split') { await this.closeGroup(); }
      else if (command === 'close-tab') {
        const tab = this.tabs.find((item: LexiWorkspaceTab): boolean => item.noteId === this.selectedId);
        if (tab) { await this.closeDocument(tab); }
      } else if (command === 'map') { this.onCreateMap(); }
      else if (command === 'canvas') { this.onCreateCanvas(); }
      else if (command === 'convert' && this.selectedId && !this.selectedId.startsWith('map:')) { this.onConvertMap(this.selectedId); }
      else if (command === 'graph') { await this.showAuxiliary(2); }
      else if (command === 'library') { await this.showAuxiliary(4); }
      else if (command === 'settings') { await this.showAuxiliary(3); }
      else if (command === 'workspaces') { await this.manageWorkspaces(); }
      else if (command === 'help') { this.onOpenHelp(); }
      else if (await LexiPluginManager.tryExecuteCommand(command)) { return; }
      else { await this.onExecuteCommand(command, this.selectedId, title); }
    } catch { this.getUIContext().getPromptAction().showToast({ message: '操作未完成，当前文档已保留，请重试。' }); }
  }

  private async openFromPalette(id: string): Promise<void> {
    try {
      await this.flushAll(); this.showPalette = false;
      if (id.startsWith('canvas:')) { this.onOpenCanvas(id.substring(7)); }
      else { this.openDocument(id); }
    } catch { this.getUIContext().getPromptAction().showToast({ message: '保存未完成，请重试。' }); }
  }

  @Builder
  private paletteSheet() {
    LexiCommandPalette({ mode: this.paletteMode,
      notes: this.notes.filter((note: NoteItem): boolean => note.vaultId === this.activeVaultId &&
        (!note.projectId || this.projects.some((project: LexiProject): boolean => project.id === note.projectId))),
      maps: this.maps, canvases: this.canvases,
      onCommand: (command: string): void => { this.executeCommand(command); },
      onOpen: (id: string): void => { this.openFromPalette(id); },
      onCreate: (title: string): void => { this.executeCommand('new-titled', title); },
      onClose: (): void => { this.showPalette = false; } })
  }

  private folders(): string[] {
    const names: string[] = [];
    for (const note of this.visibleNotes()) {
      if (!this.activeProjectId && !this.searchText && note.projectId) { continue; }
      const name = note.notebook || '未分类';
      if (!names.includes(name)) { names.push(name); }
    }
    return names;
  }

  private folderNotes(folder: string): NoteItem[] {
    return this.visibleNotes().filter((n: NoteItem): boolean => (n.notebook || '未分类') === folder);
  }

  private toggleFolder(folder: string): void {
    this.closedFolders = this.closedFolders.includes(folder) ? this.closedFolders.filter((f: string): boolean => f !== folder) :
      this.closedFolders.concat([folder]);
  }

  private tabTitle(noteId: string): string {
    if (noteId.startsWith('map:')) {
      const mapId = noteId.substring(4);
      const map = this.maps.find((m: MindMapDoc): boolean => m.id === mapId);
      return map ? (map.title || '未命名导图') : '思维导图';
    }
    const note = this.notes.find((n: NoteItem): boolean => n.id === noteId);
    return note ? MarkdownEngine.displayTitle(note) : '无标题笔记';
  }

  @Builder
  private iconButton($$: LexiWorkspaceActionParams) {
    Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
      LexiIcon({ name: $$.iconName, iconSize: 19, muted: !$$.selected })
    }
    .id(`workspace-action-${$$.iconName}`).width(40).height(40).padding(0).borderRadius(9)
    .backgroundColor($$.selected ? $r('app.color.workspace_selection') : Color.Transparent)
    .accessibilityText($$.label).onClick($$.action)
  }

  @Builder
  private createMenu() {
    Menu() {
      MenuItem({ content: '笔记' }).onClick((): void => { this.onCreateNote(); })
      MenuItem({ content: '思维导图' }).onClick((): void => { this.onCreateMap(); })
      MenuItem({ content: '白板' }).onClick((): void => { this.onCreateCanvas(); })
    }
  }

  @Builder
  private vaultMenu() {
    Menu() {
      ForEach(this.vaults, (vault: VaultItem) => {
        MenuItem({ content: vault.id === this.activeVaultId ? `${vault.name} · 当前` : vault.name })
          .enabled(!this.switchingVault).onClick((): void => { this.switchVault(vault.id); })
      }, (vault: VaultItem): string => vault.id)
      MenuItem({ content: this.activeProjectId ? '全部项目' : '全部项目 · 当前' })
        .onClick((): void => { this.selectProject(''); })
      ForEach(this.projects, (project: LexiProject) => {
        MenuItem({ content: project.id === this.activeProjectId ? `${project.name} · 当前` : project.name })
          .onClick((): void => { this.selectProject(project.id); })
      }, (project: LexiProject): string => project.id)
      MenuItem({ content: '工作区与项目…' }).id('workspace-manager-entry').onClick((): void => { this.manageWorkspaces(); })
      MenuItem({ content: '文档管理' }).onClick((): void => { this.showAuxiliary(4); })
    }
  }

  @Builder
  private rail() {
    Column({ space: 8 }) {
      this.iconButton({ iconName: 'dock-vault', label: '知识库', action: (): void => { this.routingStack.clear(); this.onSelectSection(1); }, selected: this.activeSection <= 1 })
      Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
        LexiIcon({ name: 'search', iconSize: 19 })
      }.id('workspace-quick-switcher').width(40).height(40).padding(0).backgroundColor(Color.Transparent)
        .accessibilityText('快速切换文档 Ctrl+O').keyboardShortcut('o', [ModifierKey.CTRL], (): void => { this.openPalette('switcher'); })
        .onClick((): void => { this.openPalette('switcher'); })
      Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
        Text('⌘').fontSize(22).fontColor($r('app.color.text_secondary'))
      }.id('workspace-command-palette').width(40).height(40).padding(0).backgroundColor(Color.Transparent)
        .accessibilityText('命令面板 Ctrl+P').keyboardShortcut('p', [ModifierKey.CTRL], (): void => { this.openPalette('commands'); })
        .onClick((): void => { this.openPalette('commands'); })
      Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
        LexiIcon({ name: 'note', iconSize: 19 })
      }.width(40).height(40).padding(0).backgroundColor(Color.Transparent)
        .accessibilityText('切换编辑与阅读 Ctrl+E').keyboardShortcut('e', [ModifierKey.CTRL], (): void => { this.executeCommand('reading'); })
        .onClick((): void => { this.executeCommand('reading'); })
      this.iconButton({ iconName: 'graph', label: '笔记关联', action: (): void => { this.showAuxiliary(2); }, selected: this.activeSection === 2 })
      Blank()
      this.iconButton({ iconName: 'dock-profile', label: '我的', action: (): void => { this.showAuxiliary(3); }, selected: this.activeSection === 3 })
    }
    .width(56).height('100%').padding({ top: 16, bottom: this.inlineContextMenus() ? 10 : 14 }).backgroundColor($r('app.color.workspace_rail'))
    .border({ width: { right: 0.5 }, color: $r('app.color.workspace_line') })
  }

  @Builder
  private documentRow($$: LexiWorkspaceNoteRowParams) {
    LexiContextSurface({ target: LexiContextTarget.note($$.note), beforeAction: (): Promise<void> => this.flushAll() }) {
    Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
      Row({ space: 8 }) {
        LexiIcon({ name: $$.note.noteType === 'study' ? 'study' : 'note', iconSize: 15, muted: this.selectedId !== $$.note.id })
        Text(MarkdownEngine.displayTitle($$.note)).fontSize(13)
          .fontColor(this.selectedId === $$.note.id ? $r('app.color.brand_ink') : $r('app.color.text_primary'))
          .fontWeight(this.selectedId === $$.note.id ? FontWeight.Medium : FontWeight.Regular)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
        if ($$.note.favorite) { LexiIcon({ name: 'star', iconSize: 12 }); }
      }.width('100%')
    }
    .id(`workspace-note-${$$.note.id}`).width('100%').height(38).padding({ left: 14, right: this.inlineContextMenus() ? 48 : 10 }).borderRadius(7)
    .backgroundColor(this.selectedId === $$.note.id && this.activeSection <= 1 ? $r('app.color.workspace_selection') : Color.Transparent)
    .onClick((): void => { this.openDocument($$.note.id); })
    }
  }

  @Builder
  private sidebar() {
    Column() {
      LexiContextSurface({ target: LexiContextTarget.scope('workspace', this.activeVaultId, this.activeVaultId, '', this.activeVaultName, this.vaults.find((vault: VaultItem): boolean => vault.id === this.activeVaultId)?.favorite ?? false),
        beforeAction: (): Promise<void> => this.flushAll() }) {
      Row({ space: 8 }) {
        Text('知识库').fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary')).layoutWeight(1)
        Text(`${this.visibleNotes().length}`).fontSize(11).fontColor($r('app.color.text_secondary'))
      }.height(48).width('100%').padding({ left: 6, right: this.inlineContextMenus() ? 44 : 0 })
      }
      Row({ space: 6 }) {
        LexiIcon({ name: 'search', iconSize: 15 })
        TextInput({ text: this.searchText, placeholder: '搜索 · tag: type: notebook:' })
          .id('workspace-search').layoutWeight(1).height(34).padding(0).fontSize(12)
          .fontColor($r('app.color.text_primary')).placeholderColor($r('app.color.text_secondary'))
          .caretColor($r('app.color.brand')).backgroundColor(Color.Transparent)
          .onChange((text: string): void => { this.searchText = text; })
        if (this.searchText.length > 0) {
          Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
            SymbolGlyph($r('sys.symbol.xmark')).fontSize(10).fontColor([$r('app.color.text_secondary')])
          }.id('workspace-search-clear').width(28).height(32).padding(0).backgroundColor(Color.Transparent)
            .accessibilityText('清空搜索').onClick((): void => { this.searchText = ''; })
        }
      }.width('100%').padding({ left: 10, right: 8 }).borderRadius(7).backgroundColor($r('app.color.workspace_page'))
        .border({ width: 0.5, color: $r('app.color.workspace_line') }).margin({ bottom: 14 })
      Row({ space: 6 }) {
        Button('今日笔记', { buttonStyle: ButtonStyleMode.TEXTUAL }).id('workspace-daily-note').height(34).fontSize(12)
          .onClick((): void => { this.executeCommand('daily'); })
        Button('模板', { buttonStyle: ButtonStyleMode.TEXTUAL }).id('workspace-templates').height(34).fontSize(12)
          .onClick((): void => { this.executeCommand('templates'); })
      }.width('100%').margin({ bottom: 8 })
      Row({ space: 6 }) {
        Button('全部笔记', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
          .height(30).fontSize(12).padding({ left: 10, right: this.inlineContextMenus() ? 48 : 10 }).borderRadius(6)
          .fontColor(!this.favoritesOnly ? $r('app.color.brand_ink') : $r('app.color.text_secondary'))
          .backgroundColor(!this.favoritesOnly ? $r('app.color.workspace_selection') : Color.Transparent)
          .onClick((): void => { this.favoritesOnly = false; })
        Button('收藏', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
          .height(30).fontSize(12).padding({ left: 10, right: this.inlineContextMenus() ? 48 : 10 }).borderRadius(6)
          .fontColor(this.favoritesOnly ? $r('app.color.brand_ink') : $r('app.color.text_secondary'))
          .backgroundColor(this.favoritesOnly ? $r('app.color.workspace_selection') : Color.Transparent)
          .onClick((): void => { this.favoritesOnly = true; })
      }.width('100%').margin({ bottom: 12 })
      Scroll() {
        Column({ space: 4 }) {
          if (!this.activeProjectId && !this.searchText) {
            ForEach(this.projects, (project: LexiProject) => {
              LexiContextSurface({ target: LexiContextTarget.scope('project', project.id, project.vaultId, project.id, project.name, project.favorite),
                beforeAction: (): Promise<void> => this.flushAll() }) {
                Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
                  Row({ space: 8 }) {
                    LexiIcon({ name: 'folder', iconSize: 16 })
                    Text(project.name).fontSize(13).fontColor($r('app.color.text_primary')).layoutWeight(1).maxLines(1)
                    if (project.favorite) { LexiIcon({ name: 'star', iconSize: 12 }); }
                    LexiIcon({ name: 'chevron', iconSize: 12 })
                  }.width('100%')
                }.id(`workspace-project-${project.id}`).width('100%').height(40).padding({ left: 10, right: this.inlineContextMenus() ? 48 : 10 })
                  .backgroundColor(Color.Transparent).borderRadius(7).onClick((): void => { this.selectProject(project.id); })
              }
            }, (project: LexiProject): string => `${project.id}-${project.name}-${project.favorite}`)
          }
          ForEach(this.folders(), (folder: string) => {
            Column({ space: 2 }) {
              LexiContextSurface({ target: LexiContextTarget.scope('folder', folder, this.activeVaultId, this.activeProjectId, folder),
                beforeAction: (): Promise<void> => this.flushAll() }) {
              Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
                Row({ space: 7 }) {
                  SymbolGlyph($r('sys.symbol.chevron_right')).fontSize(9).fontColor([$r('app.color.text_secondary')])
                    .rotate({ angle: this.closedFolders.includes(folder) ? 0 : 90 })
                    .animation({ duration: 150, curve: Curve.EaseOut })
                  LexiIcon({ name: 'folder', iconSize: 15 })
                  Text(folder).fontSize(12).fontColor($r('app.color.text_secondary')).maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
                  Text(`${this.folderNotes(folder).length}`).fontSize(10).fontColor($r('app.color.text_secondary'))
                }.width('100%')
              }.width('100%').height(36).padding({ left: 5, right: this.inlineContextMenus() ? 48 : 10 }).backgroundColor(Color.Transparent).borderRadius(6)
                .onClick((): void => { this.toggleFolder(folder); })
              }
              if (!this.closedFolders.includes(folder) || this.searchText.trim()) {
                ForEach(this.folderNotes(folder), (note: NoteItem) => { this.documentRow({ note: note }); }, (note: NoteItem): string => `${note.id}-${note.updatedAt}-${note.favorite}`)
              }
            }.width('100%').margin({ bottom: 8 })
          }, (folder: string): string => folder)
          if (this.visibleNotes().length === 0) {
            Text(this.searchText ? '没有找到匹配的笔记' : this.favoritesOnly ? '收藏的笔记会出现在这里' : '写下第一条笔记')
              .fontSize(12).lineHeight(22).fontColor($r('app.color.text_secondary')).width('100%').padding(12)
          }
          if (!this.searchText && !this.favoritesOnly) {
            Divider().color($r('app.color.workspace_line')).margin({ top: 12, bottom: 12 })
            Text('可视化空间').fontSize(11).fontColor($r('app.color.text_secondary')).width('100%').padding({ left: 6, bottom: 6 })
            ForEach(this.maps.filter((map: MindMapDoc): boolean => map.trashedAt === 0 && (!this.activeProjectId || map.projectId === this.activeProjectId)), (map: MindMapDoc) => {
              LexiContextSurface({ target: LexiContextTarget.scope('mindmap', map.id, map.vaultId, map.projectId || '', map.title),
                beforeAction: (): Promise<void> => this.flushAll() }) {
              Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
                Row({ space: 8 }) {
                  LexiIcon({ name: 'mindmap', iconSize: 15, muted: this.selectedId !== `map:${map.id}` })
                  Text(map.title || '未命名导图').fontSize(12)
                    .fontColor(this.selectedId === `map:${map.id}` ? $r('app.color.brand_ink') : $r('app.color.text_primary'))
                    .fontWeight(this.selectedId === `map:${map.id}` ? FontWeight.Medium : FontWeight.Regular)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
                }.width('100%')
              }.id(`workspace-map-${map.id}`).height(38).width('100%').padding({ left: 10, right: this.inlineContextMenus() ? 48 : 10 })
                .backgroundColor(this.selectedId === `map:${map.id}` && this.activeSection <= 1 ? $r('app.color.workspace_selection') : Color.Transparent)
                .borderRadius(6)
                .onClick((): void => { this.openDocument(`map:${map.id}`); })
              }
            }, (map: MindMapDoc): string => `${map.id}-${map.updatedAt}-${map.title}`)
            ForEach(this.canvases.filter((board: CanvasBoard): boolean => !this.activeProjectId || board.projectId === this.activeProjectId), (board: CanvasBoard) => {
              LexiContextSurface({ target: LexiContextTarget.scope('canvas', board.id, board.vaultId, board.projectId || '', board.title),
                beforeAction: (): Promise<void> => this.flushAll() }) {
              Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
                Row({ space: 8 }) {
                  LexiIcon({ name: 'canvas', iconSize: 15 })
                  Text(board.title || '未命名白板').fontSize(12).fontColor($r('app.color.text_primary')).maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
                }.width('100%')
              }.height(38).width('100%').padding({ left: 10, right: this.inlineContextMenus() ? 48 : 10 }).backgroundColor(Color.Transparent).borderRadius(6)
                .onClick((): void => { this.onOpenCanvas(board.id); })
              }
            }, (board: CanvasBoard): string => `${board.id}-${board.updatedAt}`)
          }
        }.width('100%').alignItems(HorizontalAlign.Start)
      }.layoutWeight(1).width('100%').scrollBar(BarState.Off).align(Alignment.Top)
      LexiContextSurface({ target: LexiContextTarget.scope(this.activeProjectId ? 'project' : 'workspace',
        this.activeProjectId || this.activeVaultId, this.activeVaultId, this.activeProjectId,
        this.activeProjectId ? this.activeProjectName : this.activeVaultName, this.activeProjectId ?
          this.projects.find((project: LexiProject): boolean => project.id === this.activeProjectId)?.favorite ?? false :
          this.vaults.find((vault: VaultItem): boolean => vault.id === this.activeVaultId)?.favorite ?? false), beforeAction: (): Promise<void> => this.flushAll() }) {
      Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
        Row({ space: 8 }) {
          LexiIcon({ name: 'folder', iconSize: 17 })
          Column({ space: 3 }) {
            Text(this.activeVaultName).fontSize(12).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
              .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(this.activeProjectName).fontSize(10).fontColor($r('app.color.text_secondary'))
          }.layoutWeight(1).alignItems(HorizontalAlign.Start)
          SymbolGlyph($r('sys.symbol.chevron_right')).fontSize(10).fontColor([$r('app.color.text_secondary')])
        }.width('100%')
      }.width('100%').height(this.inlineContextMenus() ? 56 : 62).padding({ left: 10, right: this.inlineContextMenus() ? 48 : 10, bottom: this.inlineContextMenus() ? 4 : 0 }).borderRadius(0)
        .backgroundColor(Color.Transparent).border({ width: { top: 0.5 }, color: $r('app.color.workspace_line') })
        .id('workspace-switcher').accessibilityText('工作区与项目').bindMenu(this.vaultMenu())
      }
    }
    .width(244).height('100%').padding({ left: 12, right: 12 }).backgroundColor($r('app.color.workspace_sidebar'))
  }

  @Builder
  private tabStrip() {
    Row({ space: 4 }) {
      Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
        SymbolGlyph($r('sys.symbol.list_bullet')).fontSize(17).fontColor([$r('app.color.text_secondary')])
      }.id('workspace-sidebar-toggle').width(40).height(40).padding(0).borderRadius(7).backgroundColor(Color.Transparent)
        .accessibilityText('展开或收起知识库侧栏').onClick((): void => { this.sidebarOpen = !this.sidebarOpen; })
      Scroll(this.tabScroller) {
        Row({ space: 3 }) {
          ForEach(this.tabs, (tab: LexiWorkspaceTab) => {
            Row({ space: 0 }) {
              Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
                Row({ space: 8 }) {
                  LexiIcon({ name: tab.noteId.startsWith('map:') ? 'mindmap' : 'note', iconSize: 14, muted: this.selectedId !== tab.noteId })
                  Text(this.tabTitle(tab.noteId)).fontSize(12).fontColor($r('app.color.text_primary')).maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
                }.width('100%')
              }.id(`workspace-tab-${tab.noteId}`).height(38).layoutWeight(1).padding({ left: 14, right: 4 })
                .backgroundColor(Color.Transparent).borderRadius(0).onClick((): void => { this.openDocument(tab.noteId); })
              Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
                SymbolGlyph($r('sys.symbol.xmark')).fontSize(10).fontColor([$r('app.color.text_secondary')])
              }.id(`workspace-close-${tab.noteId}`).width(30).height(34).padding(0).backgroundColor(Color.Transparent)
                .accessibilityText(`关闭 ${this.tabTitle(tab.noteId)}`).onClick((): void => { this.closeDocument(tab); })
            }
            .width(LexiTabStripLayout.tabWidth(this.tabViewportWidth, this.tabs.length)).height(40).clip(true)
            .borderRadius({ topLeft: 8, topRight: 8 })
            .backgroundColor(this.selectedId === tab.noteId && this.activeSection <= 1 ? $r('app.color.workspace_page') : Color.Transparent)
            .border({ width: { top: this.selectedId === tab.noteId && this.activeSection <= 1 ? 2 : 0 }, color: $r('app.color.brand') })
          }, (tab: LexiWorkspaceTab): string => tab.noteId)
        }.width(LexiTabStripLayout.contentWidth(this.tabViewportWidth, this.tabs.length))
          .height('100%').alignItems(VerticalAlign.Bottom)
      }.id('workspace-tab-scroll').layoutWeight(1).height('100%').clip(true)
        .scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).align(Alignment.Start)
        .onAreaChange((_old: Area, current: Area): void => {
          const measured = Number(current.width);
          if (measured > 0 && Math.abs(measured - this.tabViewportWidth) > 0.5) { this.tabViewportWidth = measured; }
        })
      Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
        Row({ space: 6 }) {
          LexiIcon({ name: 'plus', iconSize: 17 })
          Text('新建').fontSize(12).fontWeight(FontWeight.Medium).fontColor($r('app.color.brand_ink'))
        }
      }.id('workspace-create-menu').width(76).height(36).padding({ left: 8, right: 8 }).borderRadius(7)
        .backgroundColor($r('app.color.workspace_selection')).accessibilityText('新建内容').bindMenu(this.createMenu())
    }
    .width('100%').height(52 + this.topInset).padding({ left: 8, right: 12 + this.windowButtonsInset, top: 4 + this.topInset })
    .backgroundColor($r('app.color.workspace_tabs'))
    .border({ width: { bottom: 0.5 }, color: $r('app.color.workspace_line') })
  }

  build() {
    Row() {
      Column() {
        Row({ space: 10 }) {
          Image($r('app.media.lexi_logo')).width(28).height(28).borderRadius(7)
          if (this.sidebarOpen) {
            Text('知萤').fontSize(17).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
            Text('LexiNote').fontSize(12).fontWeight(FontWeight.Medium).fontColor($r('app.color.brand_ink'))
            Blank()
          }
        }.width('100%').height(52 + this.topInset).padding({ left: 14, right: 18, top: this.topInset }).backgroundColor($r('app.color.workspace_sidebar'))
          .border({ width: { bottom: 0.5 }, color: $r('app.color.workspace_line') })
        Row() {
          this.rail()
          if (this.sidebarOpen) { this.sidebar(); }
        }.width('100%').layoutWeight(1)
      }
      .width(this.sidebarOpen ? 300 : 56).height('100%')
      .backgroundColor($r('app.color.workspace_sidebar')).clip(true).zIndex(2)
      .border({ width: { right: 0.5 }, color: $r('app.color.workspace_line') })
      Column() {
        this.tabStrip()
        Navigation(this.routingStack) {
          Row() {
          Stack() {
            // Keep document instances mounted when opening auxiliary sections or switching tabs.
            ForEach(this.tabs, (tab: LexiWorkspaceTab) => {
              Column() {
                if (tab.noteId.startsWith('map:')) {
                  LexiWorkspaceMindMap({
                    mapId: tab.noteId.substring(4),
                    editorController: tab.controller,
                    paneWidth: (this.viewportWidth - (this.sidebarOpen ? 300 : 56)) / (this.groupTabs.length > 0 ? 2 : 1),
                    vaultNotes: this.notes,
                    onRequestReadingSpace: (): void => { this.sidebarOpen = false; },
                    onSaved: (doc: MindMapDoc): void => { this.onMapSaved(doc); },
                    onSavedNote: (note: NoteItem): void => { this.onSaved(note); },
                    onOpenNote: (noteId: string): void => { this.openDocument(noteId); }
                  })
                } else {
                  LexiWorkspaceEditor({ noteId: tab.noteId, editorController: tab.controller,
                    continuationActive: this.selectedId === tab.noteId && this.activeSection <= 1 && !this.routeActive,
                    paneWidth: (this.viewportWidth - (this.sidebarOpen ? 300 : 56)) / (this.groupTabs.length > 0 ? 2 : 1), vaultNotes: this.notes,
                    onRequestReadingSpace: (): void => { this.sidebarOpen = false; },
                    onSaved: (note: NoteItem): void => { this.onSaved(note); },
                    onOpenNote: (noteId: string): void => { this.openDocument(noteId); },
                    onConvertMap: (noteId: string): void => { this.onConvertMap(noteId); },
                    onOpenAdvancedNote: (noteId: string): void => { this.onOpenAdvancedNote(noteId); }
                  })
                }
              }.width('100%').height('100%').visibility(this.selectedId === tab.noteId && this.activeSection <= 1 ? Visibility.Visible : Visibility.Hidden)
            }, (tab: LexiWorkspaceTab): string => tab.noteId)
            if (this.activeSection > 1) {
              this.auxiliaryContent()
            } else if (this.tabs.length === 0 || !this.selectedId) {
              Column({ space: 12 }) {
                LexiIcon({ name: 'note', iconSize: 32 })
                Text('选择或新建一篇笔记').fontSize(20).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
                Text('从左侧打开已有笔记，或点击右上角“新建”开始记录。').fontSize(13).fontColor($r('app.color.text_secondary'))
              }.width('100%').height('100%').justifyContent(FlexAlign.Center)
                .backgroundColor($r('app.color.workspace_page'))
            }
          }.layoutWeight(1).height('100%')
          if (this.groupTabs.length > 0 && this.activeSection <= 1) {
            Column() {
              Row() {
                Text('标签组').fontSize(12).fontColor($r('app.color.text_secondary')).layoutWeight(1)
                Button('关闭分组', { buttonStyle: ButtonStyleMode.TEXTUAL }).height(40).fontSize(12)
                  .fontColor($r('app.color.brand')).onClick((): void => { this.closeGroup(); })
              }.width('100%').padding({ left: 16, right: 8 })
              Column() {
              ForEach(this.groupTabs, (groupTab: LexiWorkspaceTab) => {
                if (groupTab.noteId.startsWith('map:')) {
                  LexiWorkspaceMindMap({
                    mapId: groupTab.noteId.substring(4),
                    editorController: groupTab.controller,
                    paneWidth: (this.viewportWidth - 56) / 2,
                    vaultNotes: this.notes,
                    onSaved: (doc: MindMapDoc): void => { this.onMapSaved(doc); },
                    onSavedNote: (note: NoteItem): void => { this.onSaved(note); },
                    onOpenNote: (id: string): void => { this.openGroup(id); }
                  })
                } else {
                  LexiWorkspaceEditor({ noteId: groupTab.noteId, editorController: groupTab.controller,
                    continuationActive: false,
                    paneWidth: (this.viewportWidth - 56) / 2, vaultNotes: this.notes,
                    onSaved: (note: NoteItem): void => { this.onSaved(note); },
                    onOpenNote: (id: string): void => { this.openGroup(id); },
                    onOpenAdvancedNote: (id: string): void => { this.onOpenAdvancedNote(id); } })
                }
              }, (groupTab: LexiWorkspaceTab): string => groupTab.noteId)
              }.width('100%').layoutWeight(1)
            }.layoutWeight(1).height('100%').border({ width: { left: 1 }, color: $r('app.color.workspace_line') })
          }
          }.width('100%').height('100%').visibility(this.routeActive ? Visibility.Hidden : Visibility.Visible)
        }.mode(NavigationMode.Stack).hideTitleBar(true).width('100%').layoutWeight(1).clip(true)
      }.layoutWeight(1).height('100%')
        .backgroundColor($r('app.color.workspace_page')).clip(true).zIndex(1)
    }
    .width('100%').height('100%')
    .backgroundColor($r('app.color.workspace_page'))
    .onKeyEvent((event: KeyEvent): void => {
      if (event.type !== KeyType.Down || this.routeActive) { return; }
      if (event.metaKey === 1) {
        const key = event.keyText.toLowerCase();
        if (key === 'o') { this.openPalette('switcher'); event.stopPropagation(); }
        else if (key === 'p') { this.openPalette('commands'); event.stopPropagation(); }
        else if (key === 'e') { this.executeCommand('reading'); event.stopPropagation(); }
      }
    })
    .bindSheet($$this.showPalette, this.paletteSheet, {
      height: 540, dragBar: false, showClose: true,
      title: { title: this.paletteMode === 'commands' ? '命令面板' : '快速切换' },
      backgroundColor: $r('app.color.surface')
    })
  }
}
