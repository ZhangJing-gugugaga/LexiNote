import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { accessibility } from '@kit.AccessibilityKit';
import { CustomTheme, curves, LengthMetrics, uiMaterial } from '@kit.ArkUI';
import { LexiDesktopWorkspace } from '../components/LexiDesktopWorkspace';
import { LexiPluginRuntimeHost } from '../components/plugin/LexiPluginRuntimeHost';
import { LexiSandboxHost } from '../components/plugin/LexiSandboxHost';
import { LexiIcon } from '../components/LexiIcon';
import { LexiTitleBackdrop } from '../components/LexiTitleBackdrop';
import { LexiNavigation } from '../components/LexiNavigation';
import { LexiLaunchScreen } from '../components/LexiLaunchScreen';
import { LexiWelcomeGuide } from '../components/LexiWelcomeGuide';
import { LexiHomeTab } from '../components/LexiHomeTab';
import { LexiVaultTab } from '../components/LexiVaultTab';
import { WorkspaceLog } from '../workspace/WorkspaceLog';
import { LexiExploreTab } from '../components/LexiExploreTab';
import { LexiContextActionHost } from '../components/LexiContextActionHost';
import { LexiContextTarget } from '../core/LexiContextModels';
import { LexiNoteDestinationPicker } from '../components/LexiNoteDestinationPicker';

import { LexiSettingsWindow } from '../components/LexiSettingsWindow';
import { LexiTemplatePicker } from '../components/LexiTemplatePicker';
import { LexiTemplateItem } from '../core/LexiTemplateLibrary';
import { LexiTemplates } from '../core/LexiTemplates';
import { LexiFormData } from '../core/LexiFormData';
import { LexiFormService } from '../core/LexiFormService';
import { LexiNativeLaunch } from '../core/LexiNativeLaunch';
import { LexiContinuationData } from '../core/LexiContinuationData';
import { LexiContinuationReceiver } from '../core/LexiContinuationReceiver';
import { LexiContinuationSession } from '../core/LexiContinuationSession';
import { LexiLiveMarkdown } from '../core/LexiLiveMarkdown';
import { LexiLinkActions } from '../core/LexiLinkActions';
import { LexiStorageService } from '../core/LexiStorageService';
import { MarkdownEngine } from '../core/MarkdownEngine';
import { GraphData, GraphLayout } from '../core/GraphLayout';
import {
  CanvasBoard,
  CanvasRouteParam,
  GraphEdge,
  GraphNode,
  MindMapDoc,
  LexiProject,
  MindMapRouteParam,
  NoteEditorRouteParam,
  NoteItem,
  NoteLink,
  UnlinkedMention,
  VaultItem
} from '../core/LexiModels';

@Entry
@Component
struct Index {
  @StorageProp('lexiContinuationIncoming') @Watch('nativeLaunchChanged') private continuationIncoming: string = '';
  @StorageProp('lexiFormLaunch') @Watch('nativeLaunchChanged') private formLaunch: string = '';
  private handlingNativeLaunch: boolean = false;
  private nativeLaunchAgain: boolean = false;
  @StorageProp('lexiTopInset') titleTopInset: number = 0;
  @StorageProp('lexiBottomInset') bottomInset: number = 0;
  @StorageProp('lexiViewportWidth') viewportWidth: number = 390;
  @StorageProp('lexiViewportHeight') viewportHeight: number = 760;
  @StorageProp('lexiWindowButtonsInset') windowButtonsInset: number = 0;
  @StorageProp('lexiWorkspaceRevision') @Watch('workspaceSelectionChanged') workspaceRevision: number = 0;
  @State projects: LexiProject[] = [];
  @State activeProjectId: string = '';
  @State private contextSearchFolder: string = '';
  @State private contextSearchRevision: number = 0;
  @State private desktopOpenMode: string = 'tab';
  @State private desktopNoteId: string = '';
  @State private desktopOpenRevision: number = 0;
  @State private desktopRouteActive: boolean = false;
  @State private wideOpenTarget: string = '';
  @State ready: boolean = false;
  @State private showWelcome: boolean = false;
  @State startupError: string = '';
  @State startupStep: number = 0;
  @State activeTab: number = 0;
  @State reduceMotion: boolean = false;
  @State immersiveSupported: boolean = false;
  @State titleCollapsed: boolean[] = [false, false, false, false];
  // Knowledge data
  @State vaults: VaultItem[] = [];
  @State activeVaultId: string = 'default-vault';
  @State notes: NoteItem[] = [];
  @State maps: MindMapDoc[] = [];
  @State canvases: CanvasBoard[] = [];
  @State links: NoteLink[] = [];
  @State mentions: UnlinkedMention[] = [];
  @State lastEditedNoteId: string = '';
  // Home
  @State quickText: string = '';
  @State quickSaving: boolean = false;
  @State private showTemplates: boolean = false;
  @State private showSettingsWindow: boolean = false;
  @State private noteTemplates: LexiTemplateItem[] = [];
  @State private dailyTemplateId: string = '';
  @State private templateBusy: boolean = false;
  private pendingTemplateEditorId: string = '';
  private reopenTemplatesAfterEditor: boolean = false;
  private dailyOpening: boolean = false;
  @State private showNoteDestination: boolean = false;
  @State private destinationProjects: LexiProject[] = [];
  @State private destinationBusy: boolean = false;
  @State private pendingNoteAction: string = 'editor';
  private pendingNoteType: string = 'quick';
  private pendingNoteContent: string = '';
  // Vault
  @State vaultSection: string = 'notes';
  @State tagFilter: string = '';
  @State viewMode: string = 'list';
  // Explore
  @State fullGraphNodes: GraphNode[] = [];
  @State graphNodes: GraphNode[] = [];
  @State graphEdges: GraphEdge[] = [];
  @State graphScope: string = 'global';
  @State graphShowMaps: boolean = true;
  @State graphShowTags: boolean = false;
  @State selectedGraphId: string = '';
  // Settings
  @State theme: string = 'system';
  @State defaultTier: string = 'simple';
  @State arkuiEditorOpen: boolean = false;
  @State busy: boolean = false;
  @State dataStatus: string = '';
  @State lastBackup: string = '';

  private fullGraph: GraphData = new GraphData();
  private graphBuildSequence: number = 0;
  private graphScopeSequence: number = 0;
  private refreshSequence: number = 0;
  private listening: boolean = false;
  private startupRunning: boolean = false;
  private tabScrollers: Scroller[] = [new Scroller(), new Scroller(), new Scroller(), new Scroller()];
  private tabsController: TabsController = new TabsController();
  private readonly titleBarHeight: number = 56;
  // Native scroll masks use this token; match the page instead of the default gray/black tint.
  private readonly titleTheme: CustomTheme = {
    colors: { compBackgroundGray: $r('app.color.background') }
  };
  private titleActiveChipMaterial: uiMaterial.ImmersiveMaterial = new uiMaterial.ImmersiveMaterial({
    style: uiMaterial.ImmersiveStyle.ULTRA_THIN,
    materialColor: $r('app.color.title_chip_active'),
    interactive: true,
    applyShadow: true,
    lightEffect: { color: $r('app.color.dock_light') }
  });
  private dockMaterial: uiMaterial.ImmersiveMaterial = new uiMaterial.ImmersiveMaterial({
    style: uiMaterial.ImmersiveStyle.THIN,
    materialColor: $r('app.color.dock_surface'),
    interactive: true,
    applyShadow: true,
    lightEffect: { color: $r('app.color.dock_light') }
  });
  private readonly tabSpring: curves.ICurve = curves.springMotion(0.30, 0.82);
  private pathStack: NavPathStack = new NavPathStack();
  private readonly motionListener: (enabled: boolean) => void = (enabled: boolean): void => {
    this.reduceMotion = enabled;
    this.pathStack.disableAnimation(enabled || this.wide());
  };

  aboutToAppear(): void {
    try { this.immersiveSupported = uiMaterial.isImmersiveMaterialSupported(); } catch { this.immersiveSupported = false; }
    this.pathStack.setInterception({
      willShow: (_from: NavDestinationContext | NavBar, to: NavDestinationContext | NavBar,
        _operation: NavigationOperation, _isAnimated: boolean) => {
        this.desktopRouteActive = to !== 'navBar';
      },
      didShow: (_from: NavDestinationContext | NavBar, to: NavDestinationContext | NavBar,
        _operation: NavigationOperation, _isAnimated: boolean) => {
        this.desktopRouteActive = to !== 'navBar';
        if (to === 'navBar' && this.ready) {
          this.refresh().catch(() => { this.toast('读取最新笔记失败'); });
          if (this.reopenTemplatesAfterEditor) { this.reopenTemplatesAfterEditor = false; this.openTemplates(); }
        }
      }
    });
    try { this.reduceMotion = accessibility.isAnimationReduceEnabledSync(); } catch { this.reduceMotion = false; }
    try {
      accessibility.onAnimationReduceStateChange(this.motionListener);
      this.listening = true;
    } catch {
      this.listening = false;
    }
    this.pathStack.disableAnimation(this.reduceMotion || this.wide());
    this.initialize();
  }

  aboutToDisappear(): void {
    if (this.listening) { try { accessibility.offAnimationReduceStateChange(this.motionListener); } catch {} }
  }

  onBackPress(): boolean {
    if (this.showWelcome) { this.finishWelcome(); return true; }
    if (this.pathStack.size() > 0) { return false; }
    if (this.activeTab !== 0) { this.selectTab(0); return true; }
    return false;
  }

  private context(): common.UIAbilityContext { return this.getUIContext().getHostContext() as common.UIAbilityContext; }
  private toast(message: string): void { this.getUIContext().getPromptAction().showToast({ message: message }); }
  private wide(): boolean { return this.viewportWidth >= 840; }
  private pagePadding(): number { return this.viewportWidth >= 1200 ? 32 : 24; }
  private activeNotes(): NoteItem[] { return this.projectNotes().filter((n: NoteItem): boolean => n.trashedAt === 0); }
  private trashedNotes(): NoteItem[] { return this.notes.filter((n: NoteItem): boolean => n.trashedAt > 0); }
  private activeVaultName(): string {
    const vault = this.vaults.find((v: VaultItem): boolean => v.id === this.activeVaultId);
    return vault ? vault.name : '个人知识库';
  }

  private async initialize(): Promise<void> {
    if (this.startupRunning) { return; }
    this.startupRunning = true;
    this.startupError = '';
    this.startupStep = 0;
    try {
      await LexiStorageService.init(this.context());
      this.startupStep = 1;
      this.theme = await LexiStorageService.getSetting('theme', 'system');
      this.applyTheme(this.theme);
      this.defaultTier = await LexiStorageService.getSetting('defaultTier', 'simple');
      this.lastBackup = await LexiStorageService.getSetting('lastBackup', '');
      this.graphShowTags = await LexiStorageService.getSetting('graphShowTags', 'false') === 'true';
      this.arkuiEditorOpen = await LexiStorageService.getSetting('arkuiEditorOpen', 'false') === 'true';
      this.wideOpenTarget = await LexiStorageService.getSetting('wideOpenTarget', '');
      this.viewMode = await LexiStorageService.getSetting('vaultViewMode', 'list');
      this.startupStep = 2;
      try { await LexiStorageService.refreshFolders(await LexiStorageService.getActiveVaultId()); }
      catch (error) { this.dataStatus = (error as Error).message; this.toast(this.dataStatus); }
      await this.refresh();
      this.showWelcome = await LexiStorageService.getSetting('onboarding_completed_v1', '') !== 'true';
      if (this.continuationIncoming || this.formLaunch) { this.showWelcome = false; }
      this.ready = true;
      this.nativeLaunchChanged();
    } catch {
      this.startupError = this.startupStep === 0 ? '本地知识库暂时无法打开，请重试。已有笔记会完整保留。' :
        '索引读取未完成，请重试。笔记正文仍以 Markdown 文件保存在本机。';
    } finally {
      this.startupRunning = false;
    }
  }

  private workspaceSelectionChanged(): void {
    if (this.ready) { this.refresh().catch((): void => { this.toast('刷新工作区失败，现有笔记仍然保留'); }); }
  }

  private nativeLaunchChanged(): void {
    if (!this.ready) { return; }
    if (!this.continuationIncoming && !this.formLaunch) { return; }
    if (this.handlingNativeLaunch) { this.nativeLaunchAgain = true; return; }
    this.handleNativeLaunches().catch((): void => { this.toast('系统入口暂时不可用，请从应用内重试'); });
  }

  private async handleNativeLaunches(): Promise<void> {
    this.handlingNativeLaunch = true;
    this.showWelcome = false;
    try {
      do {
        this.nativeLaunchAgain = false;
        if (this.continuationIncoming) {
          const raw = this.continuationIncoming; this.continuationIncoming = ''; AppStorage.setOrCreate('lexiContinuationIncoming', '');
          try {
            const restored = await LexiContinuationReceiver.receive(this.context(), raw);
            await LexiStorageService.setActiveVaultId(restored.note.vaultId);
            await LexiStorageService.setActiveProjectId(restored.note.vaultId, restored.note.projectId || '');
            await this.refresh();
            const param = new NoteEditorRouteParam(); param.noteId = restored.note.id; param.vaultId = restored.note.vaultId;
            param.restoreSelectionStart = LexiLiveMarkdown.mapOffset(restored.draft.content, restored.note.content, restored.draft.cursorStart);
            param.restoreSelectionEnd = LexiLiveMarkdown.mapOffset(restored.draft.content, restored.note.content, restored.draft.cursorEnd);
            param.restoreSourceMode = restored.draft.sourceMode;
            this.pathStack.pushPathByName('noteEditor', param);
            this.toast(restored.conflictCopy ? '本机内容不同，已保留双方内容并打开接续草稿' : '已恢复接续草稿与编辑位置');
          } catch (error) { this.toast((error as Error).message || '接续草稿暂时无法恢复，原有笔记未改动'); }
        }
        if (this.formLaunch) {
          const raw = this.formLaunch; this.formLaunch = ''; AppStorage.setOrCreate('lexiFormLaunch', '');
          try {
            const request = LexiNativeLaunch.decode(raw).request;
            const vaultId = request.vaultId || await LexiStorageService.getActiveVaultId();
            if (!(await LexiStorageService.getVaults()).some((vault: VaultItem): boolean => vault.id === vaultId)) { throw new Error('卡片工作区已不可用，请打开应用重新同步'); }
            await LexiStorageService.setActiveVaultId(vaultId); await this.refresh();
            if (request.lexiFormAction === 'quick' || request.lexiFormAction === 'voice') {
              const param = new NoteEditorRouteParam(); param.createNew = true; param.initialType = 'quick';
              param.vaultId = vaultId; param.projectId = this.activeProjectId; param.initialTier = this.defaultTier;
              param.launchAssistant = request.lexiFormAction === 'voice';
              this.pathStack.pushPathByName('noteEditor', param);
            } else if (request.lexiFormAction === 'daily') {
              const existing = request.noteId ? await LexiStorageService.getNoteById(request.noteId) : undefined;
              if (existing && existing.vaultId === vaultId && existing.trashedAt === 0 && !existing.sourceMissing &&
                existing.title === LexiTemplates.dateKey() && existing.notebook === '日常记录 / 日记' &&
                (!existing.projectId || this.projects.some((project: LexiProject): boolean => project.id === existing.projectId))) { this.openNote(existing.id); }
              else { await this.openDailyNote(); }
            } else {
              const note = await LexiStorageService.getNoteById(request.noteId);
              if (!note || note.vaultId !== vaultId || note.trashedAt > 0) { throw new Error('卡片中的笔记已变化，请重新同步'); }
              if (request.lexiFormAction === 'toggle-todo') {
                try {
                  const draft = LexiContinuationSession.current();
                  if (draft && draft.sourceNoteId === note.id && !LexiContinuationData.same(note, draft)) { throw new Error('当前笔记有未保存修改，请在编辑器中确认待办'); }
                  const changed = LexiFormData.applyTask(note, request);
                  await LexiStorageService.saveNoteIfCurrent(this.context(), changed, note.title, note.content);
                } catch (error) { this.toast((error as Error).message || '待办未更新，已打开原笔记'); }
                await this.refresh();
              }
              this.openNote(note.id);
            }
            await this.syncDesktopCards();
          } catch (error) { this.toast((error as Error).message || '卡片操作暂时不可用'); }
        }
      } while (this.nativeLaunchAgain || this.continuationIncoming || this.formLaunch);
    } finally { this.handlingNativeLaunch = false; }
  }

  private async syncDesktopCards(): Promise<void> {
    const visible = this.notes.filter((note: NoteItem): boolean => !note.projectId || this.projects.some((project: LexiProject): boolean => project.id === note.projectId));
    await LexiFormService.sync(this.context(), visible, this.activeVaultId).catch((): void => {});
  }

  private async finishWelcome(): Promise<void> {
    try {
      await LexiStorageService.setSetting('onboarding_completed_v1', 'true');
      this.showWelcome = false;
    } catch { this.toast('引导完成状态未保存，请重试'); }
  }

  private projectNotes(): NoteItem[] {
    return this.notes.filter((note: NoteItem): boolean => this.activeProjectId ? note.projectId === this.activeProjectId :
      !note.projectId || this.projects.some((project: LexiProject): boolean => project.id === note.projectId));
  }
  private projectMaps(): MindMapDoc[] {
    return this.maps.filter((doc: MindMapDoc): boolean => this.activeProjectId ? doc.projectId === this.activeProjectId :
      !doc.projectId || this.projects.some((project: LexiProject): boolean => project.id === doc.projectId));
  }
  private projectCanvases(): CanvasBoard[] {
    return this.canvases.filter((board: CanvasBoard): boolean => this.activeProjectId ? board.projectId === this.activeProjectId :
      !board.projectId || this.projects.some((project: LexiProject): boolean => project.id === board.projectId));
  }
  private activeProjectName(): string {
    const project = this.projects.find((item: LexiProject): boolean => item.id === this.activeProjectId);
    return project ? project.name : '全部项目';
  }
  private async selectProject(projectId: string): Promise<void> {
    try {
      await LexiStorageService.setActiveProjectId(this.activeVaultId, projectId);
      this.refreshSequence++;
      this.activeProjectId = projectId;
      this.links = MarkdownEngine.buildNoteLinks(this.activeNotes());
      this.mentions = MarkdownEngine.findUnlinkedMentions(this.activeNotes(), this.links);
      this.rebuildGraph();
    } catch { this.toast('切换项目失败'); }
  }
  private openWorkspaceManager(): void { this.pathStack.pushPathByName('workspaceManager', undefined); }

  private async refresh(): Promise<void> {
    const sequence = ++this.refreshSequence;
    await LexiStorageService.flushPendingWrites();
    const vaults = await LexiStorageService.getVaults();
    const vaultId = await LexiStorageService.getActiveVaultId();
    const projects = await LexiStorageService.getProjects(vaultId);
    const projectId = await LexiStorageService.getActiveProjectId(vaultId);
    const notes = await LexiStorageService.getNotes(vaultId);
    const maps = await LexiStorageService.getMindMaps(vaultId);
    const canvases = await LexiStorageService.getCanvases(vaultId);
    const lastEdited = await LexiStorageService.getSetting('lastEditedNoteId', '');
    if (sequence !== this.refreshSequence) { return; }
    this.vaults = vaults; this.activeVaultId = vaultId;
    this.projects = projects; this.activeProjectId = projectId;
    this.notes = notes; this.maps = maps; this.canvases = canvases;
    this.lastEditedNoteId = lastEdited;
    const active = this.activeNotes();
    this.links = MarkdownEngine.buildNoteLinks(active);
    this.mentions = MarkdownEngine.findUnlinkedMentions(active, this.links);
    this.rebuildGraph();
    this.syncDesktopCards();
  }

  private async rebuildGraph(): Promise<void> {
    const sequence = ++this.graphBuildSequence;
    const data = await GraphLayout.buildAsync(this.activeNotes(), this.projectMaps(), this.links, this.graphShowMaps, this.graphShowTags);
    if (sequence !== this.graphBuildSequence) { return; }
    this.fullGraph = data;
    this.fullGraphNodes = data.nodes;
    if (this.selectedGraphId && !data.nodes.some((n: GraphNode): boolean => n.id === this.selectedGraphId)) {
      this.selectedGraphId = '';
    }
    await this.applyGraphScope();
  }

  private async applyGraphScope(): Promise<void> {
    const sequence = ++this.graphScopeSequence;
    const data = this.graphScope === 'local' && this.selectedGraphId ?
      await GraphLayout.localAsync(this.fullGraph, this.selectedGraphId) : this.fullGraph;
    if (sequence !== this.graphScopeSequence) { return; }
    this.graphNodes = data.nodes;
    this.graphEdges = data.edges;
  }

  private selectTab(index: number): void {
    if (this.wide()) { this.activeTab = index; return; }
    if (this.activeTab !== index) {
      this.tabsController.changeIndex(index);
      return;
    }
    this.activateTab(index);
  }

  private activateTab(index: number): void {
    this.activeTab = index;
    this.tabScrollers[index].scrollEdge(Edge.Top);
    if (index === 0 && this.ready) { this.refresh().catch((): void => { this.toast('首页统计刷新失败，请稍后重试'); }); }
  }

  private tabTitle(index: number): string {
    return ['首页', '知识库', '关联', '我的'][index] ?? 'LexiNote';
  }

  private updateTitleCollapse(index: number): void {
    if (index !== this.activeTab) { return; }
    const yOffset = this.tabScrollers[index].currentOffset().yOffset;
    const current = this.titleCollapsed[index];
    const collapsed = current ? yOffset > 32 : yOffset > 52;
    if (current !== collapsed) {
      const states = this.titleCollapsed.slice();
      states[index] = collapsed;
      this.titleCollapsed = states;
    }
  }

  private applyTheme(value: string): void {
    this.context().getApplicationContext().setColorMode(value === 'dark' ? ConfigurationConstant.ColorMode.COLOR_MODE_DARK :
      value === 'light' ? ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT : ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
  }

  private openNote(noteId: string): void {
    // 全局开关优先:开关打开时一律走 ArkUI,不做宽屏询问。
    if (this.arkuiEditorOpen || noteId.length === 0) { this.openNoteArkui(noteId); return; }
    if (!this.wide()) { this.openNoteContainer(noteId); return; }
    // 宽屏:已记住的选择直接生效,从未选择才询问一次。
    if (this.wideOpenTarget === 'container') { this.openNoteContainer(noteId); return; }
    if (this.wideOpenTarget === 'arkui') { this.openNoteArkui(noteId); return; }
    this.askWideOpenTarget(noteId);
  }
  private openNoteContainer(noteId: string): void {
    WorkspaceLog.info('note.route', 'target=container noteId=' + noteId);
    const params: Record<string, string> = { 'noteId': noteId };
    this.getUIContext().getRouter().pushUrl({ url: 'workspace/LexiWorkspacePage', params: params })
      .catch((): void => { this.toast('插件工作区暂时无法打开'); });
  }
  private openNoteArkui(noteId: string): void {
    WorkspaceLog.info('note.route', 'target=arkui noteId=' + noteId);
    if (this.wide()) {
      this.activeTab = 1; this.desktopOpenMode = 'tab'; this.desktopNoteId = noteId; this.desktopOpenRevision++; return;
    }
    const param = new NoteEditorRouteParam();
    param.noteId = noteId;
    this.pathStack.pushPathByName('noteEditor', param);
  }
  // 桌面工作区点击笔记时先问宿主:true = 宿主已处理(容器路由或正在询问),组件不要再就地开标签。
  private requestNoteOpen(noteId: string): boolean {
    if (this.arkuiEditorOpen || this.wideOpenTarget === 'arkui') {
      WorkspaceLog.info('note.route', 'target=arkui noteId=' + noteId + ' reason=wide-tab');
      return false;
    }
    if (this.wideOpenTarget === 'container') { this.openNoteContainer(noteId); return true; }
    this.askWideOpenTarget(noteId);
    return true;
  }
  private async askWideOpenTarget(noteId: string): Promise<void> {
    WorkspaceLog.info('note.route', 'target=ask noteId=' + noteId);
    let index = -1;
    try {
      const choice = await this.getUIContext().getPromptAction().showDialog({
        title: '用哪种方式打开笔记？',
        message: '这次选择会被记住，之后可在「设置 - 编辑器」里重新询问。',
        buttons: [{ text: '插件工作区容器', color: $r('app.color.brand') },
          { text: 'ArkUI 编辑器', color: $r('app.color.text_primary') }]
      });
      index = choice.index;
    } catch { return; }
    if (index === 0) { await this.setWideOpenTarget('container'); this.openNoteContainer(noteId); }
    else if (index === 1) { await this.setWideOpenTarget('arkui'); this.openNoteArkui(noteId); }
  }
  private async setWideOpenTarget(value: string): Promise<void> {
    try { await LexiStorageService.setSetting('wideOpenTarget', value); this.wideOpenTarget = value; }
    catch { this.toast('设置保存失败'); }
  }
  private openContextContent(id: string, mode: string): void {
    this.openContextDestination(id, mode).catch((): void => { this.toast('暂时无法打开内容，请刷新后重试'); });
  }
  private async openContextDestination(id: string, mode: string): Promise<void> {
    let vaultId: string = '';
    let projectId: string = '';
    if (id.startsWith('map:')) {
      const doc = await LexiStorageService.getMindMapById(id.substring(4));
      if (!doc) { throw new Error('思维导图不存在'); }
      vaultId = doc.vaultId; projectId = doc.projectId;
    } else if (id.startsWith('canvas:')) {
      const board = await LexiStorageService.getCanvasById(id.substring(7));
      if (!board) { throw new Error('白板不存在'); }
      vaultId = board.vaultId; projectId = board.projectId;
    } else {
      const note = await LexiStorageService.getNoteById(id);
      if (!note || note.trashedAt > 0) { throw new Error('笔记不存在'); }
      vaultId = note.vaultId; projectId = note.projectId;
    }
    const activeVaultId = await LexiStorageService.getActiveVaultId();
    const activeProjectId = await LexiStorageService.getActiveProjectId(vaultId);
    if (activeVaultId !== vaultId) {
      await LexiStorageService.setActiveVaultId(vaultId);
      await LexiStorageService.setActiveProjectId(vaultId, projectId);
    } else if (activeProjectId && activeProjectId !== projectId) {
      await LexiStorageService.setActiveProjectId(vaultId, projectId);
    }
    await this.refresh();
    if (id.startsWith('map:')) {
      if (this.wide()) {
        this.activeTab = 1; this.desktopNoteId = id; this.desktopOpenMode = mode; this.desktopOpenRevision++;
      } else {
        this.openMap(id.substring(4));
      }
      return;
    }
    if (id.startsWith('canvas:')) { this.openCanvas(id.substring(7)); return; }
    if (this.wide()) {
      this.activeTab = 1; this.desktopNoteId = id; this.desktopOpenMode = mode; this.desktopOpenRevision++;
    } else { this.openNote(id); }
  }
  private async searchContext(target: LexiContextTarget): Promise<void> {
    if (target.vaultId !== this.activeVaultId) { await LexiStorageService.setActiveVaultId(target.vaultId); }
    await LexiStorageService.setActiveProjectId(target.vaultId, target.projectId);
    await this.refresh();
    this.contextSearchFolder = target.kind === 'folder' ? target.notebook : '';
    this.contextSearchRevision++;
    this.vaultSection = 'notes'; this.selectTab(this.wide() ? 4 : 1);
  }
  private createNote(type: string, content: string = ''): void {
    if (this.wide()) { this.createDesktopNote(type, content); return; }
    this.chooseNoteDestination(type, content, 'editor');
  }

  private async openDailyNote(): Promise<void> {
    if (this.dailyOpening) { return; }
    this.dailyOpening = true;
    try {
      const note = await LexiStorageService.openOrCreateDailyNote(this.context(), this.activeVaultId, this.activeProjectId);
      this.desktopNoteSaved(note); this.openNote(note.id);
    } catch { this.toast('今日笔记暂时无法打开，请检查工作区后重试'); }
    finally { this.dailyOpening = false; }
  }

  private async openTemplates(): Promise<void> {
    if (this.showTemplates) { return; }
    try {
      this.noteTemplates = await LexiStorageService.getTemplates();
      this.dailyTemplateId = await LexiStorageService.getDailyTemplate();
      this.showTemplates = true;
    } catch { this.toast('无法读取模板，请重试'); }
  }

  private async createFromTemplate(templateId: string, title: string): Promise<void> {
    if (this.templateBusy) { return; }
    this.templateBusy = true;
    try {
      const note = await LexiStorageService.createNoteFromTemplate(this.context(), templateId,
        title.trim(), this.activeVaultId, this.activeProjectId);
      this.showTemplates = false; this.desktopNoteSaved(note); this.openNote(note.id);
    } catch { this.toast('从模板创建失败，请重试'); }
    finally { this.templateBusy = false; }
  }

  private async setDailyTemplate(templateId: string): Promise<void> {
    if (this.templateBusy) { return; }
    this.templateBusy = true;
    try {
      await LexiStorageService.setDailyTemplate(templateId);
      this.dailyTemplateId = templateId; this.toast('日记模板已更新，将用于新建的今日笔记');
    } catch { this.toast('设置日记模板失败'); }
    finally { this.templateBusy = false; }
  }

  private async newTemplate(): Promise<void> {
    if (this.templateBusy) { return; }
    this.templateBusy = true;
    let id = '';
    try {
      const template = new LexiTemplateItem(); template.title = '新模板'; template.category = '通用';
      template.content = '# {{title}}\n\n';
      id = (await LexiStorageService.saveTemplate(template)).id;
    } catch { this.toast('无法新建模板，请重试'); }
    finally { this.templateBusy = false; }
    if (id) { this.editTemplate(id); }
  }

  private editTemplate(id: string): void {
    if (this.templateBusy || !id) { return; }
    this.pendingTemplateEditorId = id;
    if (this.showTemplates) { this.showTemplates = false; }
    else { this.presentTemplateEditor(); }
  }

  private presentTemplateEditor(): void {
    if (!this.pendingTemplateEditorId) { return; }
    const param = new NoteEditorRouteParam(); param.templateId = this.pendingTemplateEditorId;
    this.pendingTemplateEditorId = ''; this.reopenTemplatesAfterEditor = true;
    this.pathStack.pushPathByName('noteEditor', param);
  }

  private async deleteTemplate(id: string): Promise<void> {
    if (this.templateBusy) { throw new Error('正在处理模板，请稍候'); }
    this.templateBusy = true;
    try {
      await LexiStorageService.deleteTemplate(id);
      this.noteTemplates = await LexiStorageService.getTemplates();
      this.dailyTemplateId = await LexiStorageService.getDailyTemplate();
      this.toast('模板已删除');
    } catch { throw new Error('删除模板失败，请重试'); }
    finally { this.templateBusy = false; }
  }

  private async executeDesktopCommand(command: string, noteId: string, title: string): Promise<void> {
    if (command === 'daily') { await this.openDailyNote(); }
    else if (command === 'templates') { await this.openTemplates(); }
    else if (command === 'quick' || command === 'study' || command === 'new') {
      this.createNote(command === 'new' ? 'markdown' : command);
    } else if (command === 'new-titled') {
      const note = new NoteItem(); note.title = title; note.vaultId = this.activeVaultId;
      note.projectId = this.activeProjectId; note.noteType = 'markdown'; note.editorLevel = 'pro'; note.notebook = '笔记';
      const saved = await LexiStorageService.saveNote(this.context(), note);
      this.desktopNoteSaved(saved); this.openNote(saved.id);
    } else if (command === 'save-template') {
      const source = await LexiStorageService.getNoteById(noteId);
      if (!source || source.trashedAt > 0) { this.toast('请先打开一篇笔记'); return; }
      await LexiStorageService.saveNoteAsTemplate(source.id);
      this.toast('已添加到独立模板库，可从模板入口编辑和复用');
    } else if (['light', 'dark', 'system'].includes(command)) { await this.setTheme(command); }
    else if (command === 'export-md') { await this.exportMarkdown(); }
    else if (command === 'backup') { await this.exportBackup(); }
    else if (command === 'import') { await this.importFiles(); }
  }

  private async establishMention(mention: UnlinkedMention): Promise<void> {
    try {
      const saved = await LexiLinkActions.establishMention(this.context(), mention);
      this.desktopNoteSaved(saved); this.toast('已建立双向链接');
    } catch { this.toast('原文已变化或当前提及不可转换，请刷新后重试'); }
  }

  @Builder
  private templateSheet() {
    LexiTemplatePicker({ templates: this.noteTemplates, defaultTemplateId: this.dailyTemplateId,
      templateBusy: this.templateBusy,
      onCreate: (id: string, title: string): void => { this.createFromTemplate(id, title); },
      onSetDaily: (id: string): void => { this.setDailyTemplate(id); },
      onNewTemplate: (): void => { this.newTemplate(); },
      onEdit: (id: string): void => { this.editTemplate(id); },
      onDelete: async (id: string): Promise<void> => { await this.deleteTemplate(id); } })
  }

  private dismissTemplates(action: DismissSheetAction): void {
    if (!this.templateBusy) { action.dismiss(); }
  }

  private async chooseNoteDestination(type: string, content: string, action: string): Promise<void> {
    if (this.showNoteDestination || this.destinationBusy) { return; }
    this.destinationBusy = true;
    try {
      try { this.getUIContext().getFocusController().clearFocus(); } catch {}
      this.destinationProjects = await LexiStorageService.getProjects();
      this.vaults = await LexiStorageService.getVaults();
      this.pendingNoteType = type;
      this.pendingNoteContent = content;
      this.pendingNoteAction = action;
      this.showNoteDestination = true;
    } catch { this.toast('无法读取工作区，请重试'); }
    finally { this.destinationBusy = false; }
  }

  private async confirmNoteDestination(vaultId: string, projectId: string): Promise<void> {
    if (this.destinationBusy) { return; }
    this.destinationBusy = true;
    try {
      if (!this.vaults.some((vault: VaultItem): boolean => vault.id === vaultId) ||
        (projectId && !this.destinationProjects.some((project: LexiProject): boolean =>
          project.id === projectId && project.vaultId === vaultId))) { throw new Error('Invalid destination'); }
      const note = new NoteItem();
      note.vaultId = vaultId;
      note.projectId = projectId;
      note.noteType = this.pendingNoteType;
      note.editorLevel = this.pendingNoteType === 'markdown' ? 'pro' : this.pendingNoteType === 'study' ? 'study' : this.defaultTier;
      note.notebook = this.pendingNoteAction === 'quick' ? '速记收件箱' : '笔记';
      note.content = this.pendingNoteContent;
      const saved = await LexiStorageService.saveNote(this.context(), note);
      this.showNoteDestination = false;
      if ((this.pendingNoteAction === 'quick' || this.pendingNoteAction === 'expand') &&
        this.quickText.trim() === this.pendingNoteContent.trim()) { this.quickText = ''; }
      // A failure to update navigation preferences must not retry an already saved note.
      try {
        await LexiStorageService.setActiveVaultId(vaultId);
        await LexiStorageService.setActiveProjectId(vaultId, projectId);
        await this.refresh();
      } catch { this.toast('笔记已保存，工作区列表稍后刷新'); }
      if (this.pendingNoteAction === 'quick') {
        this.toast(`已保存到 ${this.vaults.find((vault: VaultItem): boolean => vault.id === vaultId)?.name ?? '工作区'}`);
      } else {
        const param = new NoteEditorRouteParam();
        param.noteId = saved.id;
        param.vaultId = vaultId;
        this.pathStack.pushPathByName('noteEditor', param);
      }
    } catch { this.toast('保存位置不可用，请重新选择；输入内容已保留'); }
    finally { this.destinationBusy = false; }
  }

  @Builder
  private noteDestinationSheet() {
    LexiNoteDestinationPicker({ vaults: this.vaults, projects: this.destinationProjects,
      busy: this.destinationBusy, saveOnly: this.pendingNoteAction === 'quick',
      onConfirm: (vaultId: string, projectId: string): void => { this.confirmNoteDestination(vaultId, projectId); } })
  }
  private async createDesktopNote(type: string, content: string): Promise<void> {
    try {
      const note = new NoteItem();
      note.vaultId = this.activeVaultId;
      note.projectId = this.activeProjectId;
      note.noteType = type;
      note.editorLevel = type === 'markdown' ? 'pro' : type === 'study' ? 'study' : this.defaultTier;
      note.notebook = '笔记';
      note.content = content;
      const saved = await LexiStorageService.saveNote(this.context(), note);
      this.desktopNoteSaved(saved);
      this.openNote(saved.id);
    } catch { this.toast('创建文档失败，请重试'); }
  }

  private desktopNoteSaved(note: NoteItem): void {
    if (note.vaultId !== this.activeVaultId) { return; }
    const updated = this.notes.filter((n: NoteItem): boolean => n.id !== note.id);
    this.notes = [note].concat(updated);
    this.lastEditedNoteId = note.id;
    this.links = MarkdownEngine.buildNoteLinks(this.activeNotes());
    this.mentions = MarkdownEngine.findUnlinkedMentions(this.activeNotes(), this.links);
    this.rebuildGraph();
    this.syncDesktopCards();
  }

  private desktopMapSaved(doc: MindMapDoc): void {
    if (doc.vaultId !== this.activeVaultId) { return; }
    const updated = this.maps.filter((m: MindMapDoc): boolean => m.id !== doc.id);
    this.maps = [doc].concat(updated);
    this.rebuildGraph();
  }

  private async createDesktopMap(fromNoteId: string = ''): Promise<void> {
    try {
      const fresh = new MindMapDoc();
      fresh.vaultId = this.activeVaultId;
      fresh.projectId = this.activeProjectId;
      fresh.layoutKind = 'right';
      fresh.rootNodeId = 'root';
      if (fromNoteId.length > 0) {
        const srcNote = await LexiStorageService.getNoteById(fromNoteId);
        if (srcNote) {
          fresh.projectId = srcNote.projectId || this.activeProjectId;
          fresh.title = `${MarkdownEngine.displayTitle(srcNote)} · 导图`;
          fresh.nodes = MarkdownEngine.markdownToMindMapNodes(
            MarkdownEngine.displayTitle(srcNote),
            srcNote.content,
            srcNote.id
          );
        } else {
          fresh.title = '新建思维导图';
          fresh.nodes = MarkdownEngine.markdownToMindMapNodes('中心主题', '');
        }
      } else {
        fresh.title = '新建思维导图';
        fresh.nodes = MarkdownEngine.markdownToMindMapNodes('中心主题', '');
      }
      const saved = await LexiStorageService.saveMindMap(this.context(), fresh);
      this.desktopMapSaved(saved);
      this.openMap(saved.id);
    } catch {
      this.toast('创建思维导图失败，请重试');
    }
  }

  private openMap(mapId: string): void {
    if (this.wide()) {
      this.activeTab = 1;
      this.desktopOpenMode = 'tab';
      this.desktopNoteId = `map:${mapId}`;
      this.desktopOpenRevision++;
      return;
    }
    const param = new MindMapRouteParam();
    param.mapId = mapId;
    this.pathStack.pushPathByName('mindMapEditor', param);
  }
  private createMap(fromNoteId: string = ''): void {
    if (this.wide()) {
      this.createDesktopMap(fromNoteId);
      return;
    }
    const param = new MindMapRouteParam();
    param.createNew = true;
    param.fromNoteId = fromNoteId;
    param.projectId = this.activeProjectId;
    this.pathStack.pushPathByName('mindMapEditor', param);
  }
  private openCanvas(canvasId: string): void {
    const param = new CanvasRouteParam();
    param.canvasId = canvasId;
    this.pathStack.pushPathByName('canvasEditor', param);
  }
  private createCanvas(): void {
    const param = new CanvasRouteParam();
    param.createNew = true;
    param.projectId = this.activeProjectId;
    this.pathStack.pushPathByName('canvasEditor', param);
  }
  private openHelp(): void { this.pathStack.pushPathByName('help', undefined); }
  private openGraphNode(id: string): void {
    if (id.startsWith('map:')) { this.openMap(id.substring(4)); }
    else if (id.startsWith('tag:')) { this.filterByTag(id.substring(4)); }
    else { this.openNote(id); }
  }
  private filterByTag(tag: string): void {
    this.tagFilter = tag;
    if (tag) {
      this.vaultSection = 'notes';
      this.selectTab(this.wide() ? 4 : 1);
    }
  }

  private async saveQuick(): Promise<void> {
    const text = this.quickText.trim();
    if (!text) { this.toast('先写下想要保存的内容'); return; }
    if (this.quickSaving) { return; }
    if (!this.wide()) { this.chooseNoteDestination('quick', text, 'quick'); return; }
    this.quickSaving = true;
    try {
      const note = new NoteItem();
      note.vaultId = this.activeVaultId;
      note.projectId = this.activeProjectId;
      note.noteType = 'quick';
      note.editorLevel = this.defaultTier;
      note.notebook = '速记收件箱';
      note.content = text;
      await LexiStorageService.saveNote(this.context(), note);
      this.quickText = '';
      await this.refresh();
      this.toast('已保存到速记收件箱');
    } catch {
      this.toast('保存失败，内容仍保留在输入框');
    } finally {
      this.quickSaving = false;
    }
  }
  private expandQuick(): void {
    const text = this.quickText;
    if (!this.wide()) { this.chooseNoteDestination('quick', text, 'expand'); return; }
    this.quickText = '';
    this.createNote('quick', text);
  }
  private async togglePin(note: NoteItem): Promise<void> {
    try { await LexiStorageService.toggleNotePin(this.context(), note.id); await this.refresh(); }
    catch { this.toast('操作失败，请重试'); }
  }
  private async toggleFavorite(note: NoteItem): Promise<void> {
    try { await LexiStorageService.toggleNoteFavorite(this.context(), note.id); await this.refresh(); }
    catch { this.toast('操作失败，请重试'); }
  }
  private async moveToTrash(note: NoteItem): Promise<void> {
    try {
      await LexiStorageService.setNoteTrash(this.context(), note.id, true);
      await this.refresh();
      this.toast('已移到回收站，可随时恢复');
    } catch { this.toast('操作失败，请重试'); }
  }
  private async restoreNote(note: NoteItem): Promise<void> {
    try { await LexiStorageService.setNoteTrash(this.context(), note.id, false); await this.refresh(); this.toast('笔记已恢复'); }
    catch { this.toast('恢复失败，请重试'); }
  }
  private async deleteForever(note: NoteItem): Promise<void> {
    const choice = await this.getUIContext().getPromptAction().showDialog({
      title: '永久删除这篇笔记？',
      message: `「${MarkdownEngine.displayTitle(note)}」的 Markdown 文件将被移除，指向它的 [[链接]] 会显示为未解析。此操作无法撤销。`,
      buttons: [{ text: '取消', color: $r('app.color.text_secondary') }, { text: '永久删除', color: $r('app.color.error') }]
    });
    if (choice.index !== 1) { return; }
    try { await LexiStorageService.deleteNotePermanently(note.id); await this.refresh(); this.toast('已永久删除'); }
    catch { this.toast('删除失败，请重试'); }
  }
  private async emptyTrash(): Promise<void> {
    const trashed = this.trashedNotes();
    if (!trashed.length) { return; }
    const choice = await this.getUIContext().getPromptAction().showDialog({
      title: '清空回收站？',
      message: `${trashed.length} 篇笔记将被永久删除，此操作无法撤销。`,
      buttons: [{ text: '取消', color: $r('app.color.text_secondary') }, { text: '清空', color: $r('app.color.error') }]
    });
    if (choice.index !== 1) { return; }
    try {
      for (const note of trashed) { await LexiStorageService.deleteNotePermanently(note.id); }
      await this.refresh();
      this.toast('回收站已清空');
    } catch { this.toast('部分笔记未能删除，请重试'); }
  }
  private async switchVault(vaultId: string): Promise<void> {
    if (vaultId === this.activeVaultId) { return; }
    try {
      await LexiStorageService.setActiveVaultId(vaultId);
      try { await LexiStorageService.refreshFolders(vaultId); } catch (error) { this.toast((error as Error).message); }
      this.tagFilter = '';
      this.selectedGraphId = '';
      await this.refresh();
      this.toast(`已切换到「${this.activeVaultName()}」`);
    } catch { this.toast('切换知识库失败'); }
  }
  private async setTheme(value: string): Promise<void> {
    try { await LexiStorageService.setSetting('theme', value); this.theme = value; this.applyTheme(value); }
    catch { this.toast('外观设置保存失败'); }
  }
  private async setDefaultTier(value: string): Promise<void> {
    try { await LexiStorageService.setSetting('defaultTier', value); this.defaultTier = value; }
    catch { this.toast('设置保存失败'); }
  }
  private async setArkuiEditor(on: boolean): Promise<void> {
    try { await LexiStorageService.setSetting('arkuiEditorOpen', on ? 'true' : 'false'); this.arkuiEditorOpen = on; }
    catch { this.toast('设置保存失败'); }
  }
  private async setViewMode(value: string): Promise<void> {
    this.viewMode = value;
    try { await LexiStorageService.setSetting('vaultViewMode', value); } catch {}
  }
  private async toggleGraphTags(enabled: boolean): Promise<void> {
    this.graphShowTags = enabled;
    this.rebuildGraph();
    try { await LexiStorageService.setSetting('graphShowTags', enabled ? 'true' : 'false'); } catch {}
  }
  private toggleGraphMaps(enabled: boolean): void {
    this.graphShowMaps = enabled;
    this.rebuildGraph();
  }
  private setGraphScope(scope: string): void {
    if (scope === 'local' && !this.selectedGraphId) { this.toast('先在图谱中点选一个节点'); return; }
    this.graphScope = scope;
    this.applyGraphScope();
  }
  private selectGraphNode(id: string): void {
    this.selectedGraphId = id;
    if (!id && this.graphScope === 'local') {
      this.graphScope = 'global';
      this.applyGraphScope();
    }
  }
  private async exportBackup(): Promise<void> {
    this.busy = true;
    this.dataStatus = '正在打包笔记、导图与白板…';
    try {
      await LexiStorageService.exportFullBackup(this.context());
      this.lastBackup = `${new Date().toLocaleString()} · ${this.activeNotes().length} 篇笔记`;
      await LexiStorageService.setSetting('lastBackup', this.lastBackup);
      this.dataStatus = '完整备份已导出，同时在本机保留一份副本。';
      this.toast('完整备份已导出');
    } catch (error) {
      this.dataStatus = (error as Error).message || '备份未完成';
    } finally { this.busy = false; }
  }
  private async exportMarkdown(): Promise<void> {
    this.busy = true;
    try {
      await LexiStorageService.exportMarkdownBundle(this.context(), this.activeVaultId);
      this.dataStatus = `「${this.activeVaultName()}」已导出为 Markdown。`;
      this.toast('Markdown 已导出');
    } catch (error) {
      this.dataStatus = (error as Error).message || '导出未完成';
    } finally { this.busy = false; }
  }
  private async importFiles(): Promise<void> {
    const choice = await this.getUIContext().getPromptAction().showDialog({
      title: '导入笔记或恢复备份',
      message: '支持 .md / .txt 笔记、原生导图 JSON，以及知萤完整备份。完整备份将替换当前全部知识库内容，导入前建议先导出一次备份。',
      buttons: [{ text: '取消', color: $r('app.color.text_secondary') }, { text: '选择文件', color: $r('app.color.brand') }]
    });
    if (choice.index !== 1) { return; }
    this.busy = true;
    try {
      const message = await LexiStorageService.importFilesFromPicker(this.context(), this.activeVaultId);
      await this.refresh();
      this.dataStatus = message;
      this.toast(message);
    } catch (error) {
      this.dataStatus = (error as Error).message || '导入未完成';
    } finally { this.busy = false; }
  }
  private async rebuildIndex(): Promise<void> {
    this.busy = true;
    try {
      const count = await LexiStorageService.rebuildIndex(this.context());
      await this.refresh();
      this.dataStatus = `已从 Markdown 文件重建 ${count} 篇笔记的链接与标签索引。`;
      this.toast('索引已重建');
    } catch { this.dataStatus = '重建索引失败，原始文件未受影响。'; }
    finally { this.busy = false; }
  }
  private information(title: string, message: string): void {
    this.getUIContext().getPromptAction().showDialog({ title: title, message: message, buttons: [{ text: '知道了', color: $r('app.color.brand') }] });
  }
  private createMenu(): MenuElement[] {
    return [
      { value: '笔记', action: (): void => { this.createNote('quick'); } },
      { value: '思维导图', action: (): void => { this.createMap(); } },
      { value: '自由白板', action: (): void => { this.createCanvas(); } }
    ];
  }

  @Builder
  dockTabItem(index: number, label: string, icon: string) {
    Column({ space: 3 }) {
      LexiIcon({ name: icon, iconSize: 22, muted: this.activeTab !== index })
      Text(label)
        .fontSize(10)
        .fontWeight(this.activeTab === index ? FontWeight.Bold : FontWeight.Medium)
        .fontColor(this.activeTab === index ? $r('app.color.brand') : $r('app.color.text_secondary'))
    }
    .id(`primary-tab-${index}`)
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .accessibilityText(label)
    .accessibilitySelected(this.activeTab === index)
  }

  @Builder
  primaryTitleBar(index: number) {
    Stack({ alignContent: Alignment.TopStart }) {
      LexiTitleBackdrop()
      Row({ space: 10 }) {
        if (this.wide()) {
          LexiNavigation({
            active: this.activeTab,
            onSelect: (tabIdx: number): void => {
              this.selectTab(tabIdx);
            }
          })
        } else {
          Row({ space: 8 }) {
            Image($r('app.media.lexi_logo'))
              .width(28)
              .height(28)
              .borderRadius(8)
            Text(this.titleCollapsed[index] ? this.tabTitle(index) : 'LexiNote')
              .fontSize(this.titleCollapsed[index] ? 20 : 23)
              .fontWeight(FontWeight.Bold)
              .fontColor($r('app.color.text_primary'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .animation({ duration: 150, curve: Curve.EaseOut })
          }
        }

        Blank()

        Button({ type: ButtonType.Circle, buttonStyle: ButtonStyleMode.TEXTUAL }) {
          LexiIcon({ name: 'plus', iconSize: 20 })
        }
        .id(`header-create-${index}`)
        .width(40)
        .height(40)
        .padding(0)
        .backgroundColor(this.immersiveSupported ? Color.Transparent : $r('app.color.brand_soft'))
        .systemMaterial(this.immersiveSupported ? this.titleActiveChipMaterial : undefined)
        .accessibilityText('新建内容')
        .bindMenu(this.createMenu())
      }
      .id(`primary-title-${index}`)
      .width('100%')
      .height('100%')
      .padding({ top: this.titleTopInset, left: this.pagePadding(), right: this.pagePadding() + this.windowButtonsInset })
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .height('100%')
    .clip(false)
  }

  @Builder
  tabScrollPage(index: number) {
    WithTheme({ theme: this.titleTheme }) {
      // Give each tab its own native title bar so inactive scrollers cannot retain its blur state.
      Navigation() {
        Scroll(this.tabScrollers[index]) {
          if (index === 0) {
            LexiHomeTab({
              isWide: this.wide(),
              pagePadding: this.pagePadding(),
              bottomInset: this.bottomInset,
              titleCollapsed: this.titleCollapsed[0],
              activeVaultName: this.activeVaultName(),
              notes: this.projectNotes(),
              links: this.links,
              mapCount: this.projectMaps().filter((m: MindMapDoc): boolean => m.trashedAt === 0).length,
              canvasCount: this.projectCanvases().length,
              quickText: this.quickText,
              quickSaving: this.quickSaving,
              onOpenDaily: (): void => { this.openDailyNote(); },
              onOpenTemplates: (): void => { this.openTemplates(); },
              onQuickTextChange: (val: string): void => { this.quickText = val; },
              onSaveQuick: (): void => { this.saveQuick(); },
              onExpandQuick: (): void => { this.expandQuick(); },
              onOpenNote: (noteId: string): void => { this.openNote(noteId); },
              onFilterTag: (tag: string): void => { this.filterByTag(tag); },
              onTogglePin: (note: NoteItem): void => { this.togglePin(note); },
              onToggleFavorite: (note: NoteItem): void => { this.toggleFavorite(note); },
              onMoveToTrash: (note: NoteItem): void => { this.moveToTrash(note); },
              onRestoreNote: (note: NoteItem): void => { this.restoreNote(note); },
              onDeleteForever: (note: NoteItem): void => { this.deleteForever(note); },
              onViewAllNotes: (): void => { this.selectTab(1); }
            })
          } else if (index === 1) {
            LexiVaultTab({
              requestedFolder: this.contextSearchFolder, searchRevision: this.contextSearchRevision,
              isWide: this.wide(),
              pagePadding: this.pagePadding(),
              bottomInset: this.bottomInset,
              titleCollapsed: this.titleCollapsed[1],
              activeVaultName: this.activeVaultName(),
              notes: this.projectNotes(),
              maps: this.projectMaps(),
              canvases: this.projectCanvases(),
              links: this.links,
              viewMode: this.viewMode,
              tagFilter: this.tagFilter,
              vaultSection: this.vaultSection,
              onSelectSection: (sec: string): void => { this.vaultSection = sec; },
              onManageWorkspaces: (): void => { this.openWorkspaceManager(); },
              onSetViewMode: (mode: string): void => { this.setViewMode(mode); },
              onFilterTag: (tag: string): void => { this.filterByTag(tag); },
              onOpenNote: (noteId: string): void => { this.openNote(noteId); },
              onTogglePin: (note: NoteItem): void => { this.togglePin(note); },
              onToggleFavorite: (note: NoteItem): void => { this.toggleFavorite(note); },
              onMoveToTrash: (note: NoteItem): void => { this.moveToTrash(note); },
              onRestoreNote: (note: NoteItem): void => { this.restoreNote(note); },
              onDeleteForever: (note: NoteItem): void => { this.deleteForever(note); },
              onEmptyTrash: (): void => { this.emptyTrash(); },
              onOpenMap: (mapId: string): void => { this.openMap(mapId); },
              onOpenCanvas: (canvasId: string): void => { this.openCanvas(canvasId); }
            })
          } else if (index === 2) {
            LexiExploreTab({
              isWide: this.wide(),
              pagePadding: this.pagePadding(),
              bottomInset: this.bottomInset,
              titleCollapsed: this.titleCollapsed[2],
              graphNodes: this.graphNodes,
              graphEdges: this.graphEdges,
              fullGraphNodes: this.fullGraphNodes,
              graphScope: this.graphScope,
              graphShowMaps: this.graphShowMaps,
              graphShowTags: this.graphShowTags,
              selectedGraphId: this.selectedGraphId,
              notes: this.activeNotes(), maps: this.projectMaps(), links: this.links,
              scopeLabel: (this.vaults.find((vault: VaultItem): boolean => vault.id === this.activeVaultId)?.name ?? '') +
                (this.activeProjectId ? ` · ${this.activeProjectName()}` : ''),
              onCreateNote: (): void => { this.createNote('quick'); },
              mentions: this.mentions,
              onLinkMention: (mention: UnlinkedMention): void => { this.establishMention(mention); },
              onSetScope: (scope: string): void => { this.setGraphScope(scope); },
              onToggleMaps: (enabled: boolean): void => { this.toggleGraphMaps(enabled); },
              onToggleTags: (enabled: boolean): void => { this.toggleGraphTags(enabled); },
              onSelectNode: (id: string): void => { this.selectGraphNode(id); },
              onOpenNode: (id: string): void => { this.openGraphNode(id); },
              onOpenNote: (noteId: string): void => { this.openNote(noteId); }
            })
          } else {
            this.settingsEntryPage()
          }
        }
        .width('100%')
        .height('100%')
        // Reserve the title at rest; scrolling content can pass beneath its native material.
        .contentStartOffset(this.titleBarHeight + this.titleTopInset)
        .contentEndOffset(this.bottomInset)
        .scrollBar(BarState.Off)
        .align(Alignment.Top)
        .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
        .onDidScroll(() => {
          this.updateTitleCollapse(index);
        })
      }
      .mode(NavigationMode.Stack)
      .hideBackButton(true)
      .titleMode(NavigationTitleMode.Mini)
      .title(
        {
          builder: () => { this.primaryTitleBar(index); },
          height: this.titleBarHeight + this.titleTopInset
        },
        {
          backgroundColor: Color.Transparent,
          barStyle: BarStyle.STACK,
          scrollEffectOptions: { scrollEffectType: ScrollEffectType.GRADUAL_BLUR }
        }
      )
      .width('100%')
      .height('100%')
      .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
    }
  }

  @Builder
  private settingsEntryPage() {
    Column({ space: 14 }) {
      Text('我的')
        .fontSize(30)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_primary'))
        .width('100%')

      Button('打开设置', { type: ButtonType.Normal })
        .width('100%')
        .height(52)
        .fontSize(15)
        .borderRadius(18)
        .backgroundColor($r('app.color.brand'))
        .fontColor($r('app.color.inverse_text'))
        .onClick((): void => { this.showSettingsWindow = true; })

      Text('外观、编辑器、插件、社区市场、数据备份与帮助都收敛在同一个设置窗口。')
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')

      Button('回收站  →', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
        .width('100%').height(48).fontSize(14).borderRadius(14)
        .backgroundColor($r('app.color.surface')).fontColor($r('app.color.brand_ink'))
        .onClick((): void => { this.pathStack.pushPathByName('trash', undefined); })

      Button('使用说明  →', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
        .width('100%').height(48).fontSize(14).borderRadius(14)
        .backgroundColor($r('app.color.surface')).fontColor($r('app.color.brand_ink'))
        .onClick((): void => { this.openHelp(); })
    }
    .width('100%')
    .constraintSize({ maxWidth: 860 })
    .padding({ left: this.pagePadding(), right: this.pagePadding(), bottom: 48 })
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  private desktopAuxiliary() {
    Scroll() {
      Column() {
        if (this.activeTab === 4) {
            LexiVaultTab({
              requestedFolder: this.contextSearchFolder, searchRevision: this.contextSearchRevision,
              isWide: this.wide(),
              pagePadding: this.pagePadding(),
              bottomInset: this.bottomInset,
              titleCollapsed: this.titleCollapsed[1],
              activeVaultName: this.activeVaultName(),
              notes: this.projectNotes(),
              maps: this.projectMaps(),
              canvases: this.projectCanvases(),
              links: this.links,
              viewMode: this.viewMode,
              tagFilter: this.tagFilter,
              vaultSection: this.vaultSection,
              onSelectSection: (sec: string): void => { this.vaultSection = sec; },
              onManageWorkspaces: (): void => { this.openWorkspaceManager(); },
              onSetViewMode: (mode: string): void => { this.setViewMode(mode); },
              onFilterTag: (tag: string): void => { this.filterByTag(tag); },
              onOpenNote: (noteId: string): void => { this.openNote(noteId); },
              onTogglePin: (note: NoteItem): void => { this.togglePin(note); },
              onToggleFavorite: (note: NoteItem): void => { this.toggleFavorite(note); },
              onMoveToTrash: (note: NoteItem): void => { this.moveToTrash(note); },
              onRestoreNote: (note: NoteItem): void => { this.restoreNote(note); },
              onDeleteForever: (note: NoteItem): void => { this.deleteForever(note); },
              onEmptyTrash: (): void => { this.emptyTrash(); },
              onOpenMap: (mapId: string): void => { this.openMap(mapId); },
              onOpenCanvas: (canvasId: string): void => { this.openCanvas(canvasId); }
            })
        } else if (this.activeTab === 2) {
            LexiExploreTab({
              isWide: this.wide(),
              pagePadding: this.pagePadding(),
              bottomInset: this.bottomInset,
              titleCollapsed: this.titleCollapsed[2],
              graphNodes: this.graphNodes,
              graphEdges: this.graphEdges,
              fullGraphNodes: this.fullGraphNodes,
              graphScope: this.graphScope,
              graphShowMaps: this.graphShowMaps,
              graphShowTags: this.graphShowTags,
              selectedGraphId: this.selectedGraphId,
              notes: this.activeNotes(), maps: this.projectMaps(), links: this.links,
              scopeLabel: (this.vaults.find((vault: VaultItem): boolean => vault.id === this.activeVaultId)?.name ?? '') +
                (this.activeProjectId ? ` · ${this.activeProjectName()}` : ''),
              onCreateNote: (): void => { this.createNote('quick'); },
              mentions: this.mentions,
              onLinkMention: (mention: UnlinkedMention): void => { this.establishMention(mention); },
              onSetScope: (scope: string): void => { this.setGraphScope(scope); },
              onToggleMaps: (enabled: boolean): void => { this.toggleGraphMaps(enabled); },
              onToggleTags: (enabled: boolean): void => { this.toggleGraphTags(enabled); },
              onSelectNode: (id: string): void => { this.selectGraphNode(id); },
              onOpenNode: (id: string): void => { this.openGraphNode(id); },
              onOpenNote: (noteId: string): void => { this.openNote(noteId); }
            })
          } else {
            this.settingsEntryPage()
        }
      }.width('100%').constraintSize({ maxWidth: 1160 }).padding({ top: 32, bottom: 32 })
    }.width('100%').height('100%').align(Alignment.Top).backgroundColor($r('app.color.workspace_page'))
  }

  @Builder
  private desktopWorkspace() {
    LexiDesktopWorkspace({
      viewportWidth: this.viewportWidth, notes: this.notes, maps: this.maps, canvases: this.canvases,
      projects: this.projects, activeProjectId: this.activeProjectId, activeProjectName: this.activeProjectName(),
      vaults: this.vaults, activeVaultId: this.activeVaultId, activeVaultName: this.activeVaultName(),
      activeSection: this.activeTab, lastEditedNoteId: this.lastEditedNoteId,
      requestedNoteId: this.desktopNoteId, requestedOpenMode: this.desktopOpenMode, openRevision: this.desktopOpenRevision,
      routeActive: this.desktopRouteActive, routingStack: this.pathStack,
      auxiliaryContent: () => { this.desktopAuxiliary(); },
      onSelectSection: (index: number): void => { this.selectTab(index); },
      onCreateNote: (): void => { this.createNote('markdown'); },
      onExecuteCommand: async (command: string, id: string, title: string): Promise<void> => {
        await this.executeDesktopCommand(command, id, title);
      },
      onSaved: (note: NoteItem): void => { this.desktopNoteSaved(note); },
      onMapSaved: (doc: MindMapDoc): void => { this.desktopMapSaved(doc); },
      onSelectProject: async (projectId: string): Promise<void> => { await this.selectProject(projectId); },
      onManageWorkspaces: (): void => { this.openWorkspaceManager(); },
      onSwitchVault: async (vaultId: string): Promise<void> => { await this.switchVault(vaultId); },
      onOpenMap: (mapId: string): void => { this.openMap(mapId); },
      onCreateMap: (): void => { this.createMap(); },
      onOpenCanvas: (canvasId: string): void => { this.openCanvas(canvasId); },
      onCreateCanvas: (): void => { this.createCanvas(); },
      onConvertMap: (noteId: string): void => {
        this.createMap(noteId);
      },
      onOpenAdvancedNote: (noteId: string): void => {
        const param = new NoteEditorRouteParam(); param.noteId = noteId;
        this.pathStack.pushPathByName('noteEditor', param);
      },
      onOpenHelp: (): void => { this.openHelp(); },
      onOpenSettings: (): void => { this.showSettingsWindow = true; },
      onNoteOpenRequest: (noteId: string): boolean => this.requestNoteOpen(noteId)
    })
  }

  build() {
    Stack() {
      // 无头插件运行时内核(1x1 ArkWeb):应用级单例,手机/桌面全形态生效
      LexiPluginRuntimeHost()
      // RFC T0.2 沙箱 PoC 宿主(1x1 ArkWeb):跑沙箱逃逸探针,结论进 hilog
      LexiSandboxHost()
      Stack() {
      if (!this.ready) {
        LexiLaunchScreen({
          startupStep: this.startupStep,
          errorMessage: this.startupError,
          reduceMotion: this.reduceMotion,
          bottomInset: this.bottomInset,
          onRetry: (): void => {
            this.initialize();
          }
        })
      } else if (this.showWelcome) {
        LexiWelcomeGuide({ reduceMotion: this.reduceMotion, topInset: this.titleTopInset, bottomInset: this.bottomInset,
          windowButtonsInset: this.windowButtonsInset, wideScreen: this.wide(), onFinish: (): void => { this.finishWelcome(); } })
      } else if (this.wide()) {
        this.desktopWorkspace()
      } else {
        Navigation(this.pathStack) {
          Tabs({
            barPosition: BarPosition.End,
            index: this.activeTab,
            controller: this.tabsController
          }) {
            TabContent() {
              this.tabScrollPage(0)
            }
            .tabBar(this.dockTabItem(0, '首页', 'dock-home'))
            .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])

            TabContent() {
              this.tabScrollPage(1)
            }
            .tabBar(this.dockTabItem(1, '知识库', 'dock-vault'))
            .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])

            TabContent() {
              this.tabScrollPage(2)
            }
            .tabBar(this.dockTabItem(2, '关联', 'dock-explore'))
            .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])

            TabContent() {
              this.tabScrollPage(3)
            }
            .tabBar(this.dockTabItem(3, '我的', 'dock-profile'))
            .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
          }
          .barHeight(this.wide() ? 0 : 62)
          .barOverlap(!this.wide())
          .barBackgroundColor(this.wide() || this.immersiveSupported ? Color.Transparent : $r('app.color.dock_fallback'))
          .barFloatingStyle(
            !this.wide()
              ? {
                  barBottomMargin: this.bottomInset,
                  barSideMargin: 24,
                  maskColor: Color.Transparent,
                  systemMaterial: this.immersiveSupported ? this.dockMaterial : undefined
                }
              : undefined
          )
          .animationCurve(this.tabSpring)
          .animationDuration(this.reduceMotion ? 0 : 260)
          .scrollable(false)
          .onChange((index: number) => {
            this.activateTab(index);
          })
          .width('100%')
          .height('100%')
          .expandSafeArea([SafeAreaType.SYSTEM], this.wide() ? [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM] : [SafeAreaEdge.BOTTOM])
        }
        .mode(NavigationMode.Stack)
        .hideTitleBar(true)
        .width('100%')
        .height('100%')
        .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
      }
      LexiContextActionHost({ onOpen: (id: string, mode: string): void => { this.openContextContent(id, mode); },
        onSearch: (target: LexiContextTarget): void => { this.searchContext(target); } })
      if (this.showSettingsWindow) {
        LexiSettingsWindow({
          theme: this.theme,
          defaultTier: this.defaultTier,
          arkuiEditorOpen: this.arkuiEditorOpen,
          wideOpenTarget: this.wideOpenTarget,
          busy: this.busy,
          dataStatus: this.dataStatus,
          lastBackup: this.lastBackup,
          onSelectTheme: (theme: string): void => { this.setTheme(theme); },
          onSelectTier: (tier: string): void => { this.setDefaultTier(tier); },
          onToggleArkuiEditor: (on: boolean): void => { this.setArkuiEditor(on); },
          onResetWideOpen: (): void => { this.setWideOpenTarget(''); },
          onExportBackup: (): void => { this.exportBackup(); },
          onExportMarkdown: (): void => { this.exportMarkdown(); },
          onImportFiles: (): void => { this.importFiles(); },
          onRebuildIndex: (): void => { this.rebuildIndex(); },
          onOpenHelp: (): void => { this.openHelp(); },
          onOpenTrash: (): void => { this.pathStack.pushPathByName('trash', undefined); },
          onShowInfo: (title: string, msg: string): void => { this.information(title, msg); },
          onClose: (): void => { this.showSettingsWindow = false; }
        })
      }
      }.width('100%').height('100%')
        .bindSheet($$this.showTemplates, this.templateSheet, {
          height: this.wide() ? Math.min(720, Math.max(280, this.viewportHeight - this.titleTopInset - this.bottomInset - 96)) : SheetSize.LARGE,
          width: this.wide() ? Math.min(760, this.viewportWidth - 96) : '100%',
          preferType: this.wide() ? SheetType.CENTER : SheetType.BOTTOM,
          radius: LengthMetrics.vp(28), shadow: ShadowStyle.OUTER_DEFAULT_LG,
          borderWidth: 0.5, borderColor: $r('app.color.workspace_line'),
          dragBar: !this.wide(), showClose: true, title: { title: '模板库' },
          keyboardAvoidMode: SheetKeyboardAvoidMode.TRANSLATE_AND_RESIZE,
          onWillDismiss: (action: DismissSheetAction): void => { this.dismissTemplates(action); },
          onDisappear: (): void => { this.presentTemplateEditor(); },
          backgroundColor: $r('app.color.background')
        })
    }
    .width('100%')
    .height(LayoutPolicy.matchParent)
    .background($r('app.color.background'))
    .bindSheet($$this.showNoteDestination, this.noteDestinationSheet, {
      height: SheetSize.MEDIUM, dragBar: true, showClose: true, title: { title: '选择保存工作区' },
      backgroundColor: $r('app.color.surface')
    })
    .ignoreLayoutSafeArea([LayoutSafeAreaType.SYSTEM], [LayoutSafeAreaEdge.TOP, LayoutSafeAreaEdge.BOTTOM])
    .onAreaChange((_old: Area, current: Area) => {
      const w = Number(current.width);
      const h = Number(current.height);
      if (h > 0) { AppStorage.setOrCreate('lexiViewportHeight', h); }
      if (w > 0) {
        if (w < 840 && this.activeTab > 3) { this.activeTab = 1; }
        this.viewportWidth = w;
        this.pathStack.disableAnimation(this.reduceMotion || w >= 840);
        AppStorage.setOrCreate('lexiViewportWidth', w);
      }
    })
  }
}
