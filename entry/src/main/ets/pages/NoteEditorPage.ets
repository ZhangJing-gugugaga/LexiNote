import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { KeyCode } from '@kit.InputKit';
import { LexiCompletionPanel } from '../components/LexiCompletionPanel';
import { LexiCompletion, LexiCompletionCandidate, LexiCompletionContext } from '../core/LexiCompletion';
import { LexiAnchorNavigation } from '../core/LexiAnchorNavigation';
import { FrameCallback, KeyboardAvoidMode as UIKeyboardAvoidMode } from '@kit.ArkUI';
import { LexiBackHeader } from '../components/LexiBackHeader';
import { LexiMarkdownPreview } from '../components/LexiEditorPanels';
import { LexiIcon } from '../components/LexiIcon';
import { LexiLiveMarkdownEditor } from '../components/LexiLiveMarkdownEditor';
import { LexiLiveEditorController } from '../core/LexiLiveMarkdown';
import {
  MarkdownBlock,
  MindMapRouteParam,
  NoteEditorRouteParam,
  NoteItem,
  NoteLink,
  NoteProperty,
  OutlineHeading
} from '../core/LexiModels';
import { MarkdownEngine } from '../core/MarkdownEngine';
import { LexiFrontmatter } from '../core/LexiFrontmatter';
import { LexiShareCapture } from '../core/LexiShareCapture';
import { LexiSharableNoteSnapshot, LexiShareService } from '../core/LexiShareService';
import { LexiStorageService } from '../core/LexiStorageService';
import { LexiTemplateItem, LexiTemplateLibrary } from '../core/LexiTemplateLibrary';
import { LexiCaptureAssistantPanel } from '../components/LexiCaptureAssistantPanel';
import { LexiHarnessModalDialog } from '../components/LexiHarnessPanel';
import { LexiHarnessService } from '../harness/LexiHarnessService';
import { LexiContinuationData, LexiContinuationDraft } from '../core/LexiContinuationData';
import { LexiContinuationSession } from '../core/LexiContinuationSession';

@Builder
export function noteEditorBuilder() {
  NoteEditorPage()
}

class LexiNoteEditorFrame extends FrameCallback {
  private perform: () => void;
  constructor(perform: () => void) { super(); this.perform = perform; }
  onIdle(_remaining: number): void { this.perform(); }
}

interface LexiNotePopupState {
  isVisible: boolean;
}

class EditorSnapshot {
  title: string = '';
  content: string = '';

  constructor(title: string, content: string) {
    this.title = title;
    this.content = content;
  }
}

@Component
export struct NoteEditorPage {
  @StorageProp('lexiTopInset') titleTopInset: number = 0;
  @StorageProp('lexiBottomInset') bottomInset: number = 0;
  @StorageProp('lexiViewportWidth') windowViewportWidth: number = 390;
  @StorageProp('lexiAnchorRequest') @Watch('anchorRequested') anchorRequest: number = 0;
  @StorageProp('lexiWorkspaceRevision') @Watch('workspaceRefreshed') private workspaceRevision: number = 0;
  @StorageProp('lexiAbilityForeground') private abilityForeground: boolean = true;
  @State private completionItems: LexiCompletionCandidate[] = [];
  @State private completionIndex: number = 0;
  private completionContext: LexiCompletionContext = new LexiCompletionContext();
  private bodyController: TextAreaController = new TextAreaController();
  private liveController: LexiLiveEditorController = new LexiLiveEditorController();
  private selectionStart: number = 0;
  private selectionEnd: number = 0;
  private previewScroller: Scroller = new Scroller();
  @State private note: NoteItem = new NoteItem();
  @State private templateMode: boolean = false;
  @State private externalFileMode: boolean = false;
  @State private deferredCreation: boolean = false;
  private externalFileUri: string = '';
  private templateRecord: LexiTemplateItem = new LexiTemplateItem();
  @State private titleText: string = '';
  @State private contentText: string = '';
  @State private notebookText: string = '速记收件箱';
  @State private editorTier: string = 'simple'; // 'simple' | 'study' | 'pro'
  @State private viewMode: string = 'live'; // live | edit | split | preview
  @State private saveStatus: string = '已保存';
  @State private showLinkPicker: boolean = false;
  @State private showRelationsPanel: boolean = false;
  @State private showPropertiesPanel: boolean = false;
  @State private showOutlinePanel: boolean = false;
  @State private linkSearchText: string = '';
  @State private newTagInput: string = '';
  @State private newPropKey: string = '';
  @State private newPropVal: string = '';
  @State private allVaultNotes: NoteItem[] = [];
  @State private outgoingLinks: NoteLink[] = [];
  @State private backlinks: NoteLink[] = [];
  @State private blocks: MarkdownBlock[] = [];
  @State private outlineHeadings: OutlineHeading[] = [];
  @State private undoCount: number = 0;
  @State private redoCount: number = 0;
  @State private viewportWidth: number = 390;
  @State private showToolsPanel: boolean = false;
  @State private toolPage: string = 'format';
  @StorageProp('lexiViewportHeight') viewportHeight: number = 760;
  private previousKeyboardMode: UIKeyboardAvoidMode | undefined;
  private undoStack: EditorSnapshot[] = [];
  private redoStack: EditorSnapshot[] = [];
  private lastHistoryAt: number = 0;
  private saveTimer: number = -1;
  private editRevision: number = 0;
  private savedEditRevision: number = 0;
  private baseTitle: string = '';
  private baseContent: string = '';
  private pendingSave: Promise<void> | undefined = undefined;
  private externalReadRevision: number = 0;
  private conflictVisible: boolean = false;
  private conflictResolving: boolean = false;
  private leavingEditor: boolean = false;
  private pendingToolSnippet: string = '';
  @State private showAssistantPanel: boolean = false;
  @State private showHarnessDialog: boolean = false;
  private pendingAssistantOpen: boolean = false;
  private pendingAssistantSnippet: string = '';
  private assistantSelectionStart: number = 0;
  private assistantSelectionEnd: number = 0;
  private assistantSelectionBody: string = '';
  private assistantNoteId: string = '';
  private continuationOwner: string = LexiContinuationSession.newOwner();
  private pageAttached: boolean = false;
  private pageVisible: boolean = false;
  private pageLoaded: boolean = false;
  private pendingRouteRestore: boolean = false;
  private focusRevision: number = 0;
  private pathStack: NavPathStack = new NavPathStack();

  aboutToAppear(): void {
    this.pageAttached = true; this.pageVisible = true;
    LexiShareService.activateKnockSource(this.continuationOwner, (): LexiSharableNoteSnapshot | undefined => {
      if (!this.pageAttached || !this.pageVisible || !this.pageLoaded || this.templateMode || this.deferredCreation) {
        return undefined;
      }
      const snapshot = new LexiSharableNoteSnapshot();
      snapshot.noteId = this.note.id;
      snapshot.title = this.titleText;
      snapshot.content = this.contentText;
      snapshot.notebook = this.notebookText;
      snapshot.tags = this.note.tags.slice();
      return snapshot;
    });
    try {
      this.previousKeyboardMode = this.getUIContext().getKeyboardAvoidMode();
      this.getUIContext().setKeyboardAvoidMode(UIKeyboardAvoidMode.RESIZE);
    } catch {}
  }

  aboutToDisappear(): void {
    this.pageAttached = false; this.pageVisible = false; this.focusRevision++; this.externalReadRevision++;
    LexiShareService.deactivateKnockSource(this.continuationOwner);
    this.releaseContinuation();
    this.pendingAssistantOpen = false; this.pendingAssistantSnippet = ''; this.showAssistantPanel = false;
    this.pendingToolSnippet = '';
    if (this.previousKeyboardMode !== undefined) {
      try { this.getUIContext().setKeyboardAvoidMode(this.previousKeyboardMode); } catch {}
    }
    if (this.saveTimer >= 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = -1;
    }
    this.persistNow().catch(() => {});
  }

  private context(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  private toast(msg: string): void {
    this.getUIContext().getPromptAction().showToast({ message: msg });
  }

  private async loadFromRoute(param: NoteEditorRouteParam | undefined): Promise<void> {
    await LexiStorageService.init(this.context());
    this.pageLoaded = false;
    this.deferredCreation = false;
    this.templateMode = !!(param && param.templateId);
    this.externalFileMode = !!(param && param.externalFileMode);
    this.externalFileUri = param && param.externalFileUri ? param.externalFileUri : '';
    const vaultId = param && param.vaultId ? param.vaultId : await LexiStorageService.getActiveVaultId();
    this.allVaultNotes = (await LexiStorageService.getNotes(vaultId)).filter(
      (n: NoteItem): boolean => n.trashedAt === 0
    );

    if (this.externalFileMode && param) {
      const extNote = new NoteItem();
      extNote.vaultId = vaultId;
      extNote.projectId = param.projectId || await LexiStorageService.getActiveProjectId(vaultId);
      extNote.noteType = param.initialType || 'markdown';
      extNote.editorLevel = param.initialTier || 'pro';
      extNote.title = param.initialTitle || '外部 Markdown';
      extNote.content = param.initialContent || '';
      extNote.notebook = '外部导入';
      extNote.path = this.externalFileUri;
      LexiFrontmatter.apply(extNote, extNote.content);
      const notebookProp = extNote.properties.find((prop: NoteProperty): boolean => prop.key === 'notebook' && !!prop.propValue.trim());
      if (notebookProp) {
        extNote.notebook = notebookProp.propValue.trim().slice(0, 80);
      }
      const titleProp = extNote.properties.find((prop: NoteProperty): boolean => prop.key === 'title' && !!prop.propValue.trim());
      const fileStem = LexiShareCapture.fileNameFromUri(this.externalFileUri).replace(/\.(md|markdown)$/i, '').trim();
      if (titleProp && (!extNote.title.trim() || extNote.title.trim() === fileStem)) {
        extNote.title = titleProp.propValue.trim().slice(0, 160);
      }
      if (!extNote.title.trim()) {
        extNote.title = param.initialTitle || '外部 Markdown';
      }
      this.note = extNote;
      this.titleText = this.note.title;
      this.contentText = this.note.content;
      this.notebookText = this.note.notebook;
      this.editorTier = this.note.editorLevel;
      this.saveStatus = '外部 Markdown 文件 · 点击保存可添加到工作区';
      this.refreshDerived();
      this.finishLoadingRoute(param);
      return;
    }

    if (this.templateMode && param) {
      const template = (await LexiStorageService.getTemplates()).find((item: LexiTemplateItem): boolean => item.id === param.templateId);
      if (!template) { this.toast('模板已不存在'); this.pathStack.pop(); return; }
      this.templateRecord = template;
      this.note.vaultId = vaultId;
      this.note = this.templateNote(template);
      this.titleText = template.title; this.contentText = template.content;
      this.notebookText = template.category || '通用'; this.editorTier = 'pro';
      this.saveStatus = '已保存到模板库'; this.refreshDerived(); this.pageLoaded = true; return;
    }

    if (param && param.noteId.length > 0 && !param.createNew) {
      const existing = await LexiStorageService.getNoteById(param.noteId);
      if (existing) {
        this.note = existing;
        this.titleText = existing.title;
        this.contentText = existing.content;
        this.notebookText = existing.notebook || '速记收件箱';
        this.editorTier = existing.editorLevel || 'simple';
        this.refreshDerived();
        this.anchorRequested();
        this.finishLoadingRoute(param);
        return;
      }
    }

    const fresh = new NoteItem();
    fresh.vaultId = vaultId;
    fresh.projectId = param && param.vaultId ? param.projectId :
      param && param.projectId ? param.projectId : await LexiStorageService.getActiveProjectId(vaultId);
    fresh.noteType = param && param.initialType ? param.initialType : 'quick';
    fresh.editorLevel = param && param.initialTier
      ? param.initialTier
      : fresh.noteType === 'markdown'
        ? 'pro'
        : fresh.noteType === 'study'
          ? 'study'
          : 'simple';
    fresh.title = param && param.initialTitle ? param.initialTitle : '';
    fresh.content = param && param.initialContent ? param.initialContent : '';
    fresh.notebook = param && param.initialNotebook ? param.initialNotebook : '笔记';
    if (param && param.createNew && param.deferCreationUntilInput) {
      // Keep a stable editor identity without adding a catalog entry or Markdown file.
      fresh.id = util.generateRandomUUID(true);
      this.note = fresh; this.deferredCreation = true;
      this.saveStatus = '输入内容后自动保存';
    } else {
      this.note = await LexiStorageService.saveNote(this.context(), fresh);
    }
    this.titleText = this.note.title;
    this.contentText = this.note.content;
    this.notebookText = this.note.notebook;
    this.editorTier = this.note.editorLevel;
    this.refreshDerived();
    this.finishLoadingRoute(param);
    if (this.deferredCreation && (this.titleText.trim() || this.contentText.trim())) { this.scheduleSave(); }
  }

  private templateNote(template: LexiTemplateItem): NoteItem {
    const note = new NoteItem(); note.id = template.id; note.vaultId = this.note.vaultId;
    note.title = template.title; note.content = template.content; note.notebook = template.category;
    note.tags = template.tags.slice(); note.properties = template.properties.map((prop: NoteProperty): NoteProperty => new NoteProperty(prop.key, prop.propValue));
    note.createdAt = template.createdAt; note.updatedAt = template.updatedAt;
    note.noteType = 'markdown'; note.editorLevel = this.editorTier;
    return note;
  }

  private pushHistory(force: boolean = false): void {
    const now = Date.now();
    if (!force && now - this.lastHistoryAt < 600 && this.undoStack.length > 0) {
      this.lastHistoryAt = now;
      return;
    }
    const last = this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1] : undefined;
    if (last && last.title === this.titleText && last.content === this.contentText) {
      return;
    }
    this.lastHistoryAt = now;
    this.undoStack.push(new EditorSnapshot(this.titleText, this.contentText));
    if (this.undoStack.length > 50) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.undoCount = this.undoStack.length;
    this.redoCount = 0;
  }

  private performUndo(): void {
    if (this.undoStack.length === 0) {
      return;
    }
    this.lastHistoryAt = 0;
    this.redoStack.push(new EditorSnapshot(this.titleText, this.contentText));
    const prev = this.undoStack.pop()!;
    this.titleText = prev.title;
    this.contentText = prev.content;
    this.undoCount = this.undoStack.length;
    this.redoCount = this.redoStack.length;
    this.refreshDerived();
    this.scheduleSave();
  }

  private performRedo(): void {
    if (this.redoStack.length === 0) {
      return;
    }
    this.lastHistoryAt = 0;
    this.undoStack.push(new EditorSnapshot(this.titleText, this.contentText));
    const next = this.redoStack.pop()!;
    this.titleText = next.title;
    this.contentText = next.content;
    this.undoCount = this.undoStack.length;
    this.redoCount = this.redoStack.length;
    this.refreshDerived();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    this.editRevision++;
    if (this.viewMode !== 'edit') {
      this.blocks = MarkdownEngine.parseBlocks(this.contentText);
    }
    if (this.showOutlinePanel || this.editorTier !== 'simple') {
      this.outlineHeadings = MarkdownEngine.extractOutline(this.contentText);
    }
    if (this.externalFileMode) {
      this.saveStatus = '已编辑 · 点击保存可添加到工作区';
      return;
    }
    if (this.saveTimer >= 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = -1;
    }
    if (this.deferredCreation && !this.titleText.trim() && !this.contentText.trim()) {
      this.saveStatus = '输入内容后自动保存';
      return;
    }
    this.saveStatus = '正在自动保存…';
    this.saveTimer = setTimeout(() => {
      this.persistNow().catch((error: Error): void => {
        this.saveStatus = error.message === 'DOCUMENT_CHANGED_ELSEWHERE' ? '其他位置已更新，当前草稿已保留' : '待重试保存';
      });
    }, 360);
  }

  private async persistNow(): Promise<void> {
    if (this.externalFileMode) { return; }
    while (this.pendingSave) { await this.pendingSave; }
    if (this.conflictResolving) { throw new Error('正在保存冲突副本，请稍候'); }
    if (!this.templateMode && (!this.pageLoaded || !this.hasUnsavedChanges())) { return; }
    if (this.deferredCreation && !this.titleText.trim() && !this.contentText.trim()) {
      this.saveStatus = '输入内容后自动保存';
      return;
    }
    if (!this.note.id && !this.titleText.trim() && !this.contentText.trim()) {
      return;
    }
    const operation = this.persistSnapshot();
    this.pendingSave = operation;
    try { await operation; } finally { if (this.pendingSave === operation) { this.pendingSave = undefined; } }
  }

  private hasUnsavedChanges(): boolean {
    return this.editRevision !== this.savedEditRevision || this.titleText.trim() !== this.baseTitle ||
      this.contentText !== this.baseContent || (this.notebookText.trim() || '速记收件箱') !== this.note.notebook ||
      this.editorTier !== this.note.editorLevel;
  }

  private async persistSnapshot(): Promise<void> {
    const revision = this.editRevision;
    const savingContent = this.contentText;
    const noteId = this.note.id;
    const creatingDraft = this.deferredCreation;
    const snapshot = JSON.parse(JSON.stringify(this.note)) as NoteItem;
    snapshot.title = this.titleText.trim(); snapshot.content = savingContent;
    snapshot.notebook = this.notebookText.trim() || '速记收件箱'; snapshot.editorLevel = this.editorTier;
    let saved: NoteItem;
    if (this.templateMode) {
      const template = LexiTemplateLibrary.clone(this.templateRecord);
      template.title = this.titleText.trim() || '未命名模板'; template.content = savingContent;
      template.category = this.notebookText.trim() || '通用'; template.tags = this.note.tags.slice();
      template.properties = this.note.properties.map((prop: NoteProperty): NoteProperty => new NoteProperty(prop.key, prop.propValue));
      this.templateRecord = await LexiStorageService.saveTemplate(template);
      saved = this.templateNote(this.templateRecord);
    } else {
      try {
        saved = creatingDraft ? await LexiStorageService.saveNote(this.context(), snapshot) :
          await LexiStorageService.saveNoteIfCurrent(this.context(), snapshot, this.baseTitle, this.baseContent);
      }
      catch (error) {
        if ((error as Error).message === 'DOCUMENT_CHANGED_ELSEWHERE') {
          this.saveStatus = '其他位置已更新，当前草稿已保留'; this.showSaveConflict();
        }
        throw error as Error;
      }
    }
    if (this.note.id !== noteId) { return; }
    const pendingTags = this.note.tags.slice();
    const pendingProperties = this.note.properties.map((prop: NoteProperty): NoteProperty => new NoteProperty(prop.key, prop.propValue));
    this.note = saved;
    if (creatingDraft) { this.deferredCreation = false; this.activateContinuation(); }
    if (!this.templateMode) {
      this.baseTitle = saved.title; this.baseContent = saved.content; this.savedEditRevision = revision;
      if (revision !== this.editRevision) { this.note.tags = pendingTags; this.note.properties = pendingProperties; }
    }
    if (revision === this.editRevision && this.contentText === savingContent && saved.content !== savingContent) {
      const selectionStart = this.mapSavedCursor(savingContent, saved.content, this.selectionStart);
      const selectionEnd = this.mapSavedCursor(savingContent, saved.content, this.selectionEnd);
      this.contentText = saved.content;
      this.selectionStart = selectionStart; this.selectionEnd = selectionEnd;
      this.completionItems = [];
      if (this.viewMode === 'edit' || this.viewMode === 'split') {
        this.restoreEditorSelection(selectionStart, selectionEnd, saved.content, false);
      }
    }
    if (!this.templateMode) {
      this.allVaultNotes = (await LexiStorageService.getNotes(this.note.vaultId)).filter((n: NoteItem): boolean => n.trashedAt === 0);
    }
    this.refreshDerived();
    const time = new Date(this.note.updatedAt);
    const hh = time.getHours().toString().padStart(2, '0');
    const mm = time.getMinutes().toString().padStart(2, '0');
    const ss = time.getSeconds().toString().padStart(2, '0');
    if (revision === this.editRevision) {
      this.saveStatus = `${this.templateMode ? '模板已保存' : '已保存'} ${hh}:${mm}:${ss}`;
    }
  }

  private showSaveConflict(): void {
    if (this.conflictVisible || !this.pageAttached || !this.pageVisible || !this.abilityForeground) { return; }
    this.conflictVisible = true;
    try { this.getUIContext().showAlertDialog({ title: '笔记已在其他位置更新',
      message: '当前草稿仍然保留。可另存为副本，避免覆盖桌面卡片或其他窗口的修改。',
      primaryButton: { value: '保留草稿', action: (): void => { this.conflictVisible = false; } },
      secondaryButton: { value: '另存为副本', action: (): void => { this.saveConflictCopy(); } },
      cancel: (): void => { this.conflictVisible = false; }
    }); } catch { this.conflictVisible = false; }
  }

  private async saveConflictCopy(): Promise<void> {
    if (this.conflictResolving || this.templateMode) { return; }
    this.conflictResolving = true;
    const revision = this.editRevision; const noteId = this.note.id;
    const savingContent = this.contentText;
    const copy = JSON.parse(JSON.stringify(this.note)) as NoteItem;
    copy.id = ''; copy.path = ''; copy.createdAt = 0; copy.updatedAt = 0;
    copy.title = `${this.titleText.trim() || '未命名笔记'}（冲突副本）`; copy.content = savingContent;
    copy.notebook = this.notebookText.trim() || '速记收件箱'; copy.editorLevel = this.editorTier;
    try {
      const saved = await LexiStorageService.saveNote(this.context(), copy);
      if (this.note.id !== noteId) { return; }
      const pendingTags = this.note.tags.slice();
      const pendingProperties = this.note.properties.map((prop: NoteProperty): NoteProperty => new NoteProperty(prop.key, prop.propValue));
      this.note = saved; this.baseTitle = saved.title; this.baseContent = saved.content; this.savedEditRevision = revision;
      if (revision === this.editRevision) {
        const start = this.mapSavedCursor(savingContent, saved.content, this.selectionStart);
        const end = this.mapSavedCursor(savingContent, saved.content, this.selectionEnd);
        this.titleText = saved.title; this.contentText = saved.content; this.selectionStart = start; this.selectionEnd = end;
        this.restoreEditorSelection(start, end, saved.content, false);
      } else { this.note.tags = pendingTags; this.note.properties = pendingProperties; }
      this.conflictVisible = false; this.saveStatus = '已另存冲突副本'; this.refreshDerived();
      this.toast('已另存冲突副本，原笔记中的修改已保留');
    } catch { this.conflictVisible = false; this.saveStatus = '副本保存失败，当前草稿已保留'; }
    finally { this.conflictResolving = false; }
    if (this.note.id !== noteId && this.hasUnsavedChanges()) { this.scheduleSave(); }
  }

  private workspaceRefreshed(): void {
    this.refreshExternalNote().catch((): void => {
      if (this.pageAttached && this.pageVisible && this.abilityForeground) { this.saveStatus = '其他位置的修改暂未读取，当前内容保留'; }
    });
  }

  private async refreshExternalNote(): Promise<void> {
    if (this.deferredCreation || this.externalFileMode || !this.pageAttached || !this.pageVisible || !this.abilityForeground || !this.pageLoaded || this.templateMode || this.pendingSave || this.conflictResolving) { return; }
    this.liveController.finishEditing();
    if (this.hasUnsavedChanges()) { return; }
    const sequence = ++this.externalReadRevision; const revision = this.editRevision; const noteId = this.note.id;
    const latest = await LexiStorageService.getNoteById(noteId);
    const notes = latest ? await LexiStorageService.getNotes(latest.vaultId) : [];
    if (sequence !== this.externalReadRevision || revision !== this.editRevision || this.note.id !== noteId || this.pendingSave ||
      !this.pageAttached || !this.pageVisible || !this.abilityForeground || this.hasUnsavedChanges()) { return; }
    if (!latest || latest.trashedAt > 0 || latest.sourceMissing) { this.saveStatus = '笔记已在其他位置移除，当前内容保留'; return; }
    this.allVaultNotes = notes.filter((item: NoteItem): boolean => item.trashedAt === 0);
    if (latest.title === this.baseTitle && latest.content === this.baseContent && latest.updatedAt === this.note.updatedAt) { return; }
    const start = this.mapSavedCursor(this.contentText, latest.content, this.selectionStart);
    const end = this.mapSavedCursor(this.contentText, latest.content, this.selectionEnd);
    this.note = latest; this.titleText = latest.title; this.contentText = latest.content;
    this.notebookText = latest.notebook || '速记收件箱'; this.editorTier = latest.editorLevel || 'simple';
    this.baseTitle = latest.title; this.baseContent = latest.content; this.savedEditRevision = this.editRevision;
    this.selectionStart = start; this.selectionEnd = end; this.completionItems = [];
    this.saveStatus = '已同步其他位置的修改'; this.refreshDerived();
    this.restoreEditorSelection(start, end, latest.content, false);
  }

  private refreshDerived(): void {
    this.blocks = MarkdownEngine.parseBlocks(this.contentText);
    this.outlineHeadings = MarkdownEngine.extractOutline(this.contentText);
    const workingNotes = this.allVaultNotes.slice();
    const idx = workingNotes.findIndex((n: NoteItem): boolean => n.id === this.note.id);
    const snapshotNote = new NoteItem();
    snapshotNote.id = this.note.id || 'temp-note';
    snapshotNote.vaultId = this.note.vaultId;
    snapshotNote.title = this.titleText;
    snapshotNote.content = this.contentText;
    if (idx >= 0) {
      workingNotes[idx] = snapshotNote;
    } else {
      workingNotes.push(snapshotNote);
    }
    const allLinks = MarkdownEngine.buildNoteLinks(workingNotes);
    this.outgoingLinks = allLinks.filter((l: NoteLink): boolean => l.sourceId === snapshotNote.id);
    const currentTitle = MarkdownEngine.displayTitle(snapshotNote).toLowerCase();
    this.backlinks = allLinks.filter(
      (l: NoteLink): boolean =>
        l.sourceId !== snapshotNote.id &&
        (l.targetId === snapshotNote.id || l.targetTitle.toLowerCase() === currentTitle)
    );
  }

  private insertSnippet(snippet: string): void {
    if (this.showToolsPanel) {
      this.pendingToolSnippet = snippet;
      this.showToolsPanel = false;
      return;
    }
    this.showToolsPanel = false;
    if (this.viewMode === 'live') { this.liveController.insert(snippet); return; }
    if (this.viewMode === 'preview') {
      this.viewMode = 'live';
      const expected = this.contentText;
      this.getUIContext().postFrameCallback(new LexiNoteEditorFrame((): void => {
        if (this.pageAttached && this.pageVisible && this.viewMode === 'live' && this.contentText === expected) { this.liveController.insert(snippet); }
      }));
      return;
    }
    this.pushHistory(true);
    const start = Math.max(0, Math.min(this.selectionStart, this.contentText.length));
    const end = Math.max(start, Math.min(this.selectionEnd, this.contentText.length));
    this.contentText = this.contentText.substring(0, start) + snippet + this.contentText.substring(end);
    this.selectionStart = start + snippet.length; this.selectionEnd = this.selectionStart;
    this.scheduleSave();
    this.restoreEditorSelection(start + snippet.length, start + snippet.length, this.contentText, true);
  }

  private insertPendingToolSnippet(): void {
    const snippet = this.pendingToolSnippet;
    this.pendingToolSnippet = '';
    if (snippet) { this.insertSnippet(snippet); }
    if (this.pendingAssistantOpen) { this.presentAssistant(); }
  }

  private insertWikiLink(targetTitle: string): void {
    const clean = targetTitle.trim();
    if (!clean) { return; }
    this.insertSnippet(`[[${clean}]] `);
    this.showLinkPicker = false; this.linkSearchText = '';
    this.refreshDerived();
  }

  private async createAndLinkNote(newTitle: string): Promise<void> {
    const clean = newTitle.trim();
    if (!clean) {
      return;
    }
    if (this.templateMode) { this.insertWikiLink(clean); return; }
    const created = new NoteItem();
    created.vaultId = this.note.vaultId;
    created.projectId = this.note.projectId || '';
    created.title = clean;
    created.notebook = this.notebookText;
    created.noteType = 'study';
    created.editorLevel = 'study';
    created.content = `# ${clean}\n\n由 [[${MarkdownEngine.displayTitle(this.note)}]] 关联创建。\n`;
    await LexiStorageService.saveNote(this.context(), created);
    this.insertWikiLink(clean);
    await this.persistNow();
    this.toast(`已创建并关联「${clean}」`);
  }

  private async openWikiLinkTarget(rawTarget: string): Promise<void> {
    if (this.templateMode) { this.toast('模板中的链接会保留到新建笔记中'); return; }
    try {
      if (!this.externalFileMode) {
        await this.persistNow();
      }
      const parsed = LexiCompletion.splitTarget(rawTarget);
      const currentTitle = (this.titleText.trim() || MarkdownEngine.displayTitle(this.note)).trim().toLowerCase();
      if (!parsed.noteName || parsed.noteName === this.note.id || parsed.noteName.trim().toLowerCase() === currentTitle) {
        if (parsed.anchor) {
          this.jumpToAnchor(parsed.anchor);
        } else {
          this.toast('当前已是该笔记');
        }
        return;
      }
      const activeVaultId = this.note.vaultId || await LexiStorageService.getActiveVaultId();
      this.allVaultNotes = (await LexiStorageService.getNotes(activeVaultId)).filter(
        (n: NoteItem): boolean => n.trashedAt === 0
      );
      const target = this.allVaultNotes.find((n: NoteItem): boolean =>
        n.id === parsed.noteName || n.title.trim().toLowerCase() === parsed.noteName.trim().toLowerCase());
      if (target) {
        if (target.id === this.note.id) { this.jumpToAnchor(parsed.anchor); return; }
        LexiAnchorNavigation.request(target.id, parsed.anchor);
        const param = new NoteEditorRouteParam();
        param.noteId = target.id; param.vaultId = target.vaultId;
        this.pathStack.pushPathByName('noteEditor', param);
        return;
      }
      const created = new NoteItem();
      created.vaultId = activeVaultId;
      created.projectId = this.note.projectId || '';
      created.title = parsed.noteName.trim();
      created.notebook = this.notebookText;
      created.noteType = 'study'; created.editorLevel = 'study';
      const saved = await LexiStorageService.saveNote(this.context(), created);
      this.allVaultNotes.push(saved);
      LexiAnchorNavigation.request(saved.id, parsed.anchor);
      const param = new NoteEditorRouteParam();
      param.noteId = saved.id; param.vaultId = saved.vaultId;
      this.pathStack.pushPathByName('noteEditor', param);
    } catch (error) { this.toast((error as Error).message || '保存未完成，草稿已保留'); }
  }

  private anchorRequested(): void {
    if (!this.note.id) { return; }
    const anchor = LexiAnchorNavigation.take(this.note.id);
    if (anchor) { this.jumpToAnchor(anchor); }
  }

  private jumpToAnchor(anchor: string): void {
    this.refreshDerived();
    const heading = LexiCompletion.findHeading(this.outlineHeadings, anchor);
    if (!heading) {
      if (anchor) { this.toast(`未找到章节「${anchor}」`); }
      return;
    }
    this.liveController.finishEditing();
    if (this.viewMode !== 'preview') { this.viewMode = 'live'; }
    this.showToolsPanel = false;
    setTimeout((): void => {
      try {
        const utils = this.getUIContext().getComponentUtils();
        const target = utils.getRectangleById(`note-block-${this.note.id}-${heading.lineIndex}`);
        const viewport = utils.getRectangleById(`note-preview-scroll-${this.note.id}`);
        const scroller = this.previewScroller;
        const delta = this.getUIContext().px2vp(target.windowOffset.y - viewport.windowOffset.y);
        scroller.scrollTo({ xOffset: 0, yOffset: Math.max(0, scroller.currentOffset().yOffset + delta - 24) });
      } catch {}
    }, 80);
  }

  private mapSavedCursor(before: string, after: string, cursor: number): number {
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before.charAt(prefix) === after.charAt(prefix)) { prefix++; }
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix &&
      before.charAt(before.length - suffix - 1) === after.charAt(after.length - suffix - 1)) { suffix++; }
    if (cursor <= prefix) { return cursor; }
    if (cursor >= before.length - suffix) { return Math.max(0, Math.min(after.length, cursor + after.length - before.length)); }
    return Math.min(after.length - suffix, prefix);
  }

  private refreshCompletion(start: number, end: number): void {
    this.selectionStart = start; this.selectionEnd = end;
    this.completionContext = LexiCompletion.context(this.contentText, start, end);
    const currentDraft = JSON.parse(JSON.stringify(this.note)) as NoteItem;
    currentDraft.title = this.titleText; currentDraft.content = this.contentText;
    const workingNotes = this.allVaultNotes.filter((n: NoteItem): boolean => n.id !== this.note.id);
    workingNotes.push(currentDraft);
    this.completionItems = LexiCompletion.candidates(this.completionContext, workingNotes, this.note.id);
    this.completionIndex = 0;
  }

  private acceptCompletion(candidate: LexiCompletionCandidate): void {
    const edit = LexiCompletion.apply(this.contentText, this.completionContext, candidate);
    this.pushHistory(true); this.contentText = edit.text; this.completionItems = [];
    this.scheduleSave();
    this.selectionStart = edit.cursor; this.selectionEnd = edit.cursor;
    this.restoreEditorSelection(edit.cursor, edit.cursor, edit.text, true);
  }

  private completionKey(event: KeyEvent): boolean {
    if (!this.completionItems.length || event.type !== KeyType.Down) { return false; }
    if (event.keyCode === KeyCode.KEYCODE_DPAD_DOWN || event.keyCode === KeyCode.KEYCODE_DPAD_UP) {
      const movement = event.keyCode === KeyCode.KEYCODE_DPAD_DOWN ? 1 : -1;
      this.completionIndex = (this.completionIndex + movement + this.completionItems.length) % this.completionItems.length;
      return true;
    }
    if (event.keyCode === KeyCode.KEYCODE_ENTER || event.keyCode === KeyCode.KEYCODE_TAB) {
      this.acceptCompletion(this.completionItems[this.completionIndex]); return true;
    }
    if (event.keyCode === KeyCode.KEYCODE_ESCAPE) { this.completionItems = []; return true; }
    return false;
  }

  @Builder
  private inlineCompletion() {
    if (this.completionItems.length > 0) {
      LexiCompletionPanel({ candidates: this.completionItems, activeIndex: this.completionIndex,
        onSelect: (candidate: LexiCompletionCandidate): void => { this.acceptCompletion(candidate); } })
    }
  }

  private toggleTodoAtLine(lineIndex: number): void {
    const lines = this.contentText.split('\n');
    if (lineIndex < 0 || lineIndex >= lines.length) {
      return;
    }
    this.pushHistory(true);
    const line = lines[lineIndex];
    if (/^\s*[-*+]\s+\[ \]/.test(line)) {
      lines[lineIndex] = line.replace('[ ]', '[x]');
    } else if (/^\s*[-*+]\s+\[[xX]\]/.test(line)) {
      lines[lineIndex] = line.replace(/\[[xX]\]/, '[ ]');
    }
    this.contentText = lines.join('\n');
    this.blocks = MarkdownEngine.parseBlocks(this.contentText);
    this.scheduleSave();
  }

  private async convertToMindMap(): Promise<void> {
    await this.persistNow();
    if (this.deferredCreation) { this.toast('请先输入笔记内容，再生成思维导图'); return; }
    const param = new MindMapRouteParam();
    param.createNew = true;
    param.fromNoteId = this.note.id;
    this.pathStack.pushPathByName('mindMapEditor', param);
  }

  private async exportCurrentMarkdown(): Promise<void> {
    await this.persistNow();
    const name = `${MarkdownEngine.displayTitle(this.note)}.md`;
    try {
      await LexiStorageService.saveViaDocumentPicker(this.context(), name, this.contentText);
      this.toast('Markdown 文件已导出');
    } catch (error) {
      this.toast((error as Error).message || '已保存在本地知识库');
    }
  }

  private async shareCurrentMarkdown(): Promise<void> {
    try {
      if (!this.externalFileMode) {
        await this.persistNow();
      }
      await LexiShareService.shareDraftNote(
        this.context(),
        this.note,
        this.titleText,
        this.contentText,
        this.notebookText,
        'note-tools-open'
      );
    } catch (error) {
      this.toast((error as Error).message || '系统分享面板暂时无法打开');
    }
  }

  private async openCurrentNoteInLexiGlow(): Promise<void> {
    if (!this.contentText.trim()) {
      this.toast('当前笔记还没有正文内容');
      return;
    }
    try {
      if (!this.externalFileMode) {
        await this.persistNow();
      }
      await this.context().startAbility({
        bundleName: 'com.lovexjy.lexiglow',
        abilityName: 'EntryAbility',
        parameters: {
          route: 'sharedArticle',
          lexiglowSharedTitle: (this.titleText.trim() || MarkdownEngine.displayTitle(this.note)).slice(0, 80),
          lexiglowSharedArticle: this.contentText.slice(0, 60000)
        }
      });
    } catch (_) {
      await this.shareCurrentMarkdown();
    }
  }

  private async openLumiKitTool(toolId: string): Promise<void> {
    const uri = `lumikit://tool?id=${encodeURIComponent(toolId)}`;
    try {
      await this.context().startAbility({
        action: 'ohos.want.action.viewData',
        entities: ['entity.system.browsable'],
        uri: uri
      });
    } catch (_) {
      this.toast('未检测到集萤 LumiKit，请先安装或打开集萤');
    }
  }

  private filteredLinkCandidates(): NoteItem[] {
    const q = this.linkSearchText.trim().toLowerCase();
    return this.allVaultNotes
      .filter((n: NoteItem): boolean => n.id !== this.note.id)
      .filter((n: NoteItem): boolean => !q || MarkdownEngine.displayTitle(n).toLowerCase().includes(q))
      .slice(0, 8);
  }

  private promptSaveExternalFile(closeAfter: boolean = false): void {
    this.liveController.finishEditing();
    try {
      this.getUIContext().showAlertDialog({
        title: '是否要添加到工作区？',
        message: '已编辑当前 Markdown 文件。是否将其添加到当前工作区知识库？',
        primaryButton: {
          value: '不添加（仅保存）',
          action: (): void => {
            this.saveExternalFileOnly(closeAfter);
          }
        },
        secondaryButton: {
          value: '添加到工作区',
          action: (): void => {
            this.addExternalFileToWorkspace(closeAfter);
          }
        },
        cancel: (): void => {
          this.leavingEditor = false;
        }
      });
    } catch {
      this.addExternalFileToWorkspace(closeAfter);
    }
  }

  private async saveExternalFileOnly(closeAfter: boolean): Promise<void> {
    const wrote = this.externalFileUri ? LexiShareCapture.writeUriText(this.externalFileUri, this.contentText) : false;
    if (wrote) {
      this.baseTitle = this.titleText.trim();
      this.baseContent = this.contentText;
      this.savedEditRevision = this.editRevision;
      this.saveStatus = '已保存到原 Markdown 文件';
      this.toast('已保存到原 Markdown 文件');
    } else {
      const name = `${this.titleText.trim() || MarkdownEngine.displayTitle(this.note)}.md`;
      try {
        await LexiStorageService.saveViaDocumentPicker(this.context(), name, this.contentText);
        this.baseTitle = this.titleText.trim();
        this.baseContent = this.contentText;
        this.savedEditRevision = this.editRevision;
        this.saveStatus = '已导出保存 Markdown 文件';
        this.toast('已保存 Markdown 文件');
      } catch (error) {
        this.leavingEditor = false;
        this.toast((error as Error).message || '保存取消');
        return;
      }
    }
    if (closeAfter) {
      this.pathStack.pop();
    }
  }

  private async addExternalFileToWorkspace(closeAfter: boolean): Promise<void> {
    if (this.externalFileUri) {
      LexiShareCapture.writeUriText(this.externalFileUri, this.contentText);
    }
    const fresh = new NoteItem();
    fresh.vaultId = this.note.vaultId || await LexiStorageService.getActiveVaultId();
    fresh.projectId = this.note.projectId || await LexiStorageService.getActiveProjectId(fresh.vaultId);
    fresh.noteType = 'markdown';
    fresh.editorLevel = this.editorTier || 'pro';
    fresh.title = this.titleText.trim() || '外部 Markdown';
    fresh.content = this.contentText;
    fresh.notebook = this.notebookText.trim() || '外部导入';
    fresh.tags = this.note.tags.slice();
    fresh.properties = this.note.properties.map((prop: NoteProperty): NoteProperty => new NoteProperty(prop.key, prop.propValue));
    LexiFrontmatter.apply(fresh, this.contentText);
    const notebookProp = fresh.properties.find((prop: NoteProperty): boolean => prop.key === 'notebook' && !!prop.propValue.trim());
    if (notebookProp && (!this.notebookText.trim() || this.notebookText.trim() === '外部导入')) {
      fresh.notebook = notebookProp.propValue.trim().slice(0, 80);
    }
    if (this.titleText.trim()) {
      fresh.title = this.titleText.trim();
    }
    try {
      const saved = await LexiStorageService.saveNote(this.context(), fresh);
      this.externalFileMode = false;
      this.note = saved;
      this.titleText = saved.title;
      this.contentText = saved.content;
      this.baseTitle = saved.title;
      this.baseContent = saved.content;
      this.savedEditRevision = this.editRevision;
      this.allVaultNotes = (await LexiStorageService.getNotes(saved.vaultId)).filter((n: NoteItem): boolean => n.trashedAt === 0);
      this.refreshDerived();
      this.activateContinuation();
      this.saveStatus = '已保存并添加到工作区';
      this.toast('已保存并添加到工作区');
      if (closeAfter) {
        this.pathStack.pop();
      }
    } catch (error) {
      this.leavingEditor = false;
      this.toast((error as Error).message || '添加到工作区失败');
    }
  }

  private leaveEditor(): void {
    if (this.leavingEditor) { return; }
    if (this.templateMode && !this.note.id) { this.pathStack.pop(); return; }
    this.liveController.finishEditing();
    if (this.externalFileMode) {
      if (this.hasUnsavedChanges()) {
        this.leavingEditor = true;
        this.promptSaveExternalFile(true);
      } else {
        this.pathStack.pop();
      }
      return;
    }
    this.leavingEditor = true;
    this.persistNow().then(() => {
      this.pathStack.pop();
    }).catch((error: Error): void => {
      this.leavingEditor = false;
      this.saveStatus = error.message === 'DOCUMENT_CHANGED_ELSEWHERE' ? '其他位置已更新，当前草稿已保留' : '保存失败，请重试';
      this.toast(error.message === 'DOCUMENT_CHANGED_ELSEWHERE' ? '当前草稿已保留，请另存副本后返回。' : '保存未完成，笔记已留在编辑器中，请重试。');
    });
  }

  @Builder
  private pageTitleBar() {
    LexiBackHeader({
      title: this.templateMode ? '模板' : this.externalFileMode ? (this.titleText.trim() || '外部 Markdown') :
        this.viewportWidth < 840 ? '笔记' : MarkdownEngine.displayTitle(this.note),
      subtitle: this.saveStatus,
      actionLabel: this.externalFileMode ? '保存' : this.viewportWidth < 840 ? '' : '导出 .md',
      onBack: () => { this.leaveEditor(); },
      onAction: () => {
        if (this.externalFileMode) {
          this.promptSaveExternalFile(false);
        } else {
          this.exportCurrentMarkdown();
        }
      }
    })
  }

  private toolPopupWidth(): number { return Math.max(236, Math.min(312, this.viewportWidth - 32)); }

  private toolPopupHeight(): number { return Math.max(220, Math.min(356, this.viewportHeight - 160)); }

  private toolPageTitle(): string {
    if (this.toolPage === 'links') { return '插入笔记链接'; }
    if (this.toolPage === 'properties') { return '属性与标签'; }
    if (this.toolPage === 'outline') { return '文档大纲'; }
    if (this.toolPage === 'relations') { return '双向链接'; }
    return '笔记工具';
  }

  private selectToolPage(page: string): void { this.refreshDerived(); this.toolPage = page; }

  private selectViewMode(mode: string): void {
    this.refreshDerived(); this.viewMode = mode; this.showToolsPanel = false; this.completionItems = [];
  }

  @Builder
  private popupAction(label: string, action: () => void, available: boolean = true) {
    Button(label, { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
      .width('32%').height(42).fontSize(12).padding(2).borderRadius(8).margin({ right: '1%', bottom: 6 })
      .fontColor($r('app.color.brand_ink')).backgroundColor($r('app.color.soft_surface'))
      .enabled(available).onClick(action)
  }

  @Builder
  private popupFormats() {
    Row({ space: 4 }) {
      ForEach([['simple', '简洁'], ['study', '学习'], ['pro', '专业']], (tier: string[]) => {
        Button(tier[1], { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
          .height(30).layoutWeight(1).fontSize(12).borderRadius(7)
          .fontColor(this.editorTier === tier[0] ? $r('app.color.brand_ink') : $r('app.color.text_secondary'))
          .backgroundColor(this.editorTier === tier[0] ? $r('app.color.brand_soft') : Color.Transparent)
          .onClick((): void => { this.editorTier = tier[0]; this.scheduleSave(); })
      }, (tier: string[]): string => tier[0])
    }.width('100%').margin({ bottom: 8 })
    Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Start }) {
      this.popupAction('撤销', (): void => { this.performUndo(); this.showToolsPanel = false; }, this.undoCount > 0)
      this.popupAction('重做', (): void => { this.performRedo(); this.showToolsPanel = false; }, this.redoCount > 0)
      this.popupAction('粗体', (): void => { this.insertSnippet(' **重点内容** '); })
      this.popupAction('一级标题', (): void => { this.insertSnippet('\n# 章节标题\n'); })
      this.popupAction('二级标题', (): void => { this.insertSnippet('\n## 核心小节\n'); })
      this.popupAction('待办清单', (): void => { this.insertSnippet('\n- [ ] 待完成事项\n'); })
      this.popupAction('斜体', (): void => { this.insertSnippet(' *强调内容* '); })
      this.popupAction('删除线', (): void => { this.insertSnippet(' ~~待修订~~ '); })
      this.popupAction('分割线', (): void => { this.insertSnippet('\n\n---\n\n'); })
      if (this.editorTier !== 'simple') {
        this.popupAction('高亮', (): void => { this.insertSnippet(' ==关键考点== '); })
        this.popupAction('公式', (): void => { this.insertSnippet('\n$$f(n) = O(n \\log n)$$\n'); })
        this.popupAction('代码块', (): void => { this.insertSnippet('\n```\n\n```\n'); })
        this.popupAction('提示框', (): void => { this.insertSnippet('\n> [!NOTE] 知识要点\n> 在此记录要点\n'); })
        this.popupAction('表格', (): void => { this.insertSnippet('\n| 项目 | 内容 |\n| --- | --- |\n|  |  |\n'); })
      }
      if (this.templateMode) {
        this.popupAction('日期变量', (): void => { this.insertSnippet('{{date}}'); })
        this.popupAction('时间变量', (): void => { this.insertSnippet('{{time}}'); })
        this.popupAction('标题变量', (): void => { this.insertSnippet('{{title}}'); })
        this.popupAction('星期变量', (): void => { this.insertSnippet('{{weekday}}'); })
      }
    }.width('100%')
  }

  @Builder
  private popupPanels() {
    Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Start }) {
      this.popupAction('笔记链接', (): void => { this.selectToolPage('links'); })
      if (this.editorTier !== 'simple') {
        this.popupAction('文档大纲', (): void => { this.selectToolPage('outline'); })
      }
      if (this.editorTier === 'pro') {
        this.popupAction('属性标签', (): void => { this.selectToolPage('properties'); })
        if (!this.templateMode) { this.popupAction('双向链接', (): void => { this.selectToolPage('relations'); }); }
      }
      this.popupAction('实时预览', (): void => { this.selectViewMode('live'); })
      this.popupAction('只读阅读', (): void => { this.selectViewMode('preview'); })
      this.popupAction('全文源码', (): void => { this.selectViewMode('edit'); })
      this.popupAction('源码对照', (): void => { this.selectViewMode('split'); })
      this.popupAction('导出 .md', (): void => { this.showToolsPanel = false; this.exportCurrentMarkdown(); })
      this.popupAction('系统分享', (): void => { this.showToolsPanel = false; this.shareCurrentMarkdown(); })
      if (!this.templateMode) {
        this.popupAction('词萤伴读', (): void => { this.showToolsPanel = false; this.openCurrentNoteInLexiGlow(); })
        this.popupAction('集萤 OCR', (): void => { this.showToolsPanel = false; this.openLumiKitTool('image-ocr'); })
        this.popupAction('语音 / 整理', (): void => { this.requestAssistant(); })
        this.popupAction('转思维导图', (): void => { this.showToolsPanel = false; this.convertToMindMap(); })
        this.popupAction(this.note.favorite ? '取消收藏' : '收藏笔记', (): void => {
          this.note.favorite = !this.note.favorite; this.scheduleSave(); this.showToolsPanel = false;
        })
      }
    }.width('100%')
  }

  @Builder
  private popupProperties() {
    Column({ space: 10 }) {
      TextInput({ text: this.notebookText, placeholder: this.templateMode ? '模板分类' : '所属笔记本' }).height(36).fontSize(13)
        .fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.soft_surface'))
        .onChange((text: string): void => { this.notebookText = text; this.scheduleSave(); })
      Flex({ wrap: FlexWrap.Wrap }) {
        ForEach(this.note.tags, (tag: string) => {
          Button(`#${tag} ×`, { buttonStyle: ButtonStyleMode.TEXTUAL }).height(30).fontSize(11)
            .fontColor($r('app.color.brand_ink')).onClick((): void => {
              this.note.tags = this.note.tags.filter((existing: string): boolean => existing !== tag); this.scheduleSave();
            })
        }, (tag: string): string => tag)
      }.width('100%')
      Row({ space: 5 }) {
        TextInput({ text: this.newTagInput, placeholder: '标签，如 学习/算法' }).layoutWeight(1).height(34).fontSize(12)
          .fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.soft_surface'))
          .onChange((text: string): void => { this.newTagInput = text; })
        Button('添加', { buttonStyle: ButtonStyleMode.TEXTUAL }).height(34).fontSize(12).onClick((): void => {
          const tag = this.newTagInput.trim().replace(/^#/, '');
          if (tag && !this.note.tags.includes(tag)) { this.note.tags.push(tag); this.newTagInput = ''; this.scheduleSave(); }
        })
      }.width('100%')
      ForEach(this.note.properties, (property: NoteProperty, propertyIndex: number) => {
        Row({ space: 6 }) {
          Text(`${property.key}: ${property.propValue}`).fontSize(12).fontColor($r('app.color.text_primary')).layoutWeight(1)
          Button('删除', { buttonStyle: ButtonStyleMode.TEXTUAL }).height(30).fontSize(11).onClick((): void => {
            this.note.properties.splice(propertyIndex, 1); this.scheduleSave();
          })
        }.width('100%')
      }, (property: NoteProperty, propertyIndex: number): string => `${property.key}-${propertyIndex}`)
      TextInput({ text: this.newPropKey, placeholder: '属性名' }).height(34).fontSize(12)
        .fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.soft_surface'))
        .onChange((text: string): void => { this.newPropKey = text; })
      Row({ space: 5 }) {
        TextInput({ text: this.newPropVal, placeholder: '属性值' }).layoutWeight(1).height(34).fontSize(12)
          .fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.soft_surface'))
          .onChange((text: string): void => { this.newPropVal = text; })
        Button('添加', { buttonStyle: ButtonStyleMode.TEXTUAL }).height(34).fontSize(12).onClick((): void => {
          if (this.newPropKey.trim()) {
            this.note.properties.push(new NoteProperty(this.newPropKey.trim(), this.newPropVal.trim()));
            this.newPropKey = ''; this.newPropVal = ''; this.scheduleSave();
          }
        })
      }.width('100%')
    }.width('100%')
  }

  @Builder
  private popupLinks() {
    Column({ space: 7 }) {
      TextInput({ text: this.linkSearchText, placeholder: '搜索笔记，或输入新标题' }).height(36).fontSize(12)
        .fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.soft_surface'))
        .onChange((text: string): void => { this.linkSearchText = text; })
      ForEach(this.filteredLinkCandidates(), (candidate: NoteItem) => {
        Button(MarkdownEngine.displayTitle(candidate), { buttonStyle: ButtonStyleMode.TEXTUAL })
          .width('100%').height(34).fontSize(12).fontColor($r('app.color.brand_ink'))
          .onClick((): void => { this.insertWikiLink(MarkdownEngine.displayTitle(candidate)); })
      }, (candidate: NoteItem): string => candidate.id)
      if (this.linkSearchText.trim()) {
        Button(this.templateMode ? '插入标题链接' : '新建并关联', { buttonStyle: ButtonStyleMode.TEXTUAL }).width('100%').height(34).fontSize(12)
          .onClick((): void => { this.showToolsPanel = false; this.createAndLinkNote(this.linkSearchText); })
      }
    }.width('100%')
  }

  @Builder
  private popupOutline() {
    Column({ space: 6 }) {
      if (!this.outlineHeadings.length) {
        Text('用 # 标题整理内容，大纲会出现在这里。').fontSize(12).fontColor($r('app.color.text_secondary'))
      }
      ForEach(this.outlineHeadings, (heading: OutlineHeading) => {
        Button(heading.title, { buttonStyle: ButtonStyleMode.TEXTUAL }).width('100%').height(34).fontSize(12)
          .fontColor($r('app.color.brand_ink')).padding({ left: (heading.level - 1) * 10, right: 4 })
          .onClick((): void => { this.showToolsPanel = false; this.jumpToAnchor(heading.title); })
      }, (heading: OutlineHeading): string => heading.id)
      Button('转为思维导图', { buttonStyle: ButtonStyleMode.TEXTUAL }).height(34).fontSize(12)
        .onClick((): void => { this.showToolsPanel = false; this.convertToMindMap(); })
    }.width('100%')
  }

  @Builder
  private popupRelations() {
    Column({ space: 6 }) {
      Text(`${this.outgoingLinks.length} 出链 · ${this.backlinks.length} 反向链接`).fontSize(12).fontColor($r('app.color.text_secondary'))
      ForEach(this.outgoingLinks, (link: NoteLink) => {
        Button(`↗ ${link.displayText || link.targetTitle}`, { buttonStyle: ButtonStyleMode.TEXTUAL }).width('100%').height(34).fontSize(12)
          .fontColor($r('app.color.brand_ink')).onClick((): void => {
            this.showToolsPanel = false; this.openWikiLinkTarget(`${link.targetId || link.targetTitle}${link.anchor ? '#' + link.anchor : ''}`);
          })
      }, (link: NoteLink): string => `out-${link.targetId}-${link.targetTitle}-${link.anchor}`)
      ForEach(this.backlinks, (link: NoteLink) => {
        Button(`↙ ${link.sourceTitle}`, { buttonStyle: ButtonStyleMode.TEXTUAL }).width('100%').height(34).fontSize(12)
          .fontColor($r('app.color.brand_ink')).onClick((): void => { this.showToolsPanel = false; this.openWikiLinkTarget(link.sourceId); })
      }, (link: NoteLink): string => `back-${link.sourceId}-${link.targetTitle}-${link.anchor}`)
    }.width('100%')
  }

  @Builder
  private compactToolsPopup() {
    Column({ space: 9 }) {
      Row({ space: 5 }) {
        if (this.toolPage !== 'format' && this.toolPage !== 'panels') {
          Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
            Row({ space: 3 }) {
              LexiIcon({ name: 'back', iconSize: 13 })
              Text('返回').fontSize(12).fontColor($r('app.color.brand_ink'))
            }.width('100%').justifyContent(FlexAlign.Center)
          }.id('note-tools-back').width(62).height(32).padding(0).borderRadius(8)
            .accessibilityText('返回工具列表')
            .onClick((): void => { this.toolPage = 'panels'; })
        }
        Text(this.toolPageTitle()).fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
        Button('关闭', { buttonStyle: ButtonStyleMode.TEXTUAL }).height(30).fontSize(11)
          .fontColor($r('app.color.brand_ink'))
          .onClick((): void => { this.showToolsPanel = false; })
      }.width('100%')
      if (this.toolPage === 'format' || this.toolPage === 'panels') {
        Row({ space: 5 }) {
          Button('格式', { buttonStyle: ButtonStyleMode.TEXTUAL }).layoutWeight(1).height(30).fontSize(12)
            .fontColor($r('app.color.brand_ink'))
            .backgroundColor(this.toolPage === 'format' ? $r('app.color.brand_soft') : Color.Transparent)
            .onClick((): void => { this.toolPage = 'format'; })
          Button('面板与视图', { buttonStyle: ButtonStyleMode.TEXTUAL }).layoutWeight(1).height(30).fontSize(12)
            .fontColor($r('app.color.brand_ink'))
            .backgroundColor(this.toolPage === 'panels' ? $r('app.color.brand_soft') : Color.Transparent)
            .onClick((): void => { this.toolPage = 'panels'; })
        }.width('100%')
      }
      Scroll() {
        Column({ space: 8 }) {
          if (this.toolPage === 'format') { this.popupFormats(); }
          else if (this.toolPage === 'panels') { this.popupPanels(); }
          else if (this.toolPage === 'properties') { this.popupProperties(); }
          else if (this.toolPage === 'links') { this.popupLinks(); }
          else if (this.toolPage === 'outline') { this.popupOutline(); }
          else if (this.toolPage === 'relations') { this.popupRelations(); }
        }.width('100%').alignItems(HorizontalAlign.Start)
      }.width('100%').layoutWeight(1).align(Alignment.Top).scrollBar(BarState.Auto)
    }.id(`note-tools-popup-${this.note.id}-${this.continuationOwner}`).width(this.toolPopupWidth()).height(this.toolPopupHeight()).padding(12)
      .backgroundColor($r('app.color.surface')).borderRadius(16)
      .onDisAppear((): void => { this.insertPendingToolSnippet(); })
  }

  private sourceInputId(): string { return `note-body-textarea-${this.note.id}-${this.continuationOwner}`; }

  private restoreEditorSelection(start: number, end: number, expected: string, requestFocus: boolean): void {
    const revision = ++this.focusRevision;
    const sourceMode = this.viewMode === 'edit' || this.viewMode === 'split';
    const noteId = this.note.id;
    const uiContext = this.getUIContext();
    uiContext.postFrameCallback(new LexiNoteEditorFrame((): void => {
      if (!this.pageAttached || !this.pageVisible || !this.pageLoaded || this.showAssistantPanel ||
        revision !== this.focusRevision || this.note.id !== noteId || this.contentText !== expected ||
        sourceMode !== (this.viewMode === 'edit' || this.viewMode === 'split')) { return; }
      try {
        const root = uiContext.getAttachedFrameNodeById(`note-writing-surface-${this.note.id}-${this.continuationOwner}`);
        if (!root || !root.isAttached() || !root.isVisible()) { return; }
        if (sourceMode) {
          const input = uiContext.getAttachedFrameNodeById(this.sourceInputId());
          if (!input || !input.isAttached() || !input.isVisible()) { return; }
          if (requestFocus) { uiContext.getFocusController().requestFocus(this.sourceInputId()); }
          this.bodyController.setTextSelection(start, end);
        } else if (this.viewMode === 'live') { this.liveController.setTextSelection(start, end); }
        this.pendingRouteRestore = false;
      } catch {}
    }));
  }

  private finishLoadingRoute(param: NoteEditorRouteParam | undefined): void {
    this.pageLoaded = true;
    this.baseTitle = this.note.title; this.baseContent = this.note.content; this.savedEditRevision = this.editRevision;
    this.conflictVisible = false; this.conflictResolving = false;
    const restore = !!param && Number.isInteger(param.restoreSelectionStart) && param.restoreSelectionStart >= 0;
    this.selectionStart = restore && param ? Math.min(this.contentText.length, param.restoreSelectionStart) : this.contentText.length;
    this.selectionEnd = restore && param ? Math.max(this.selectionStart, Math.min(this.contentText.length, param.restoreSelectionEnd)) : this.selectionStart;
    if (restore && param) {
      this.viewMode = param.restoreSourceMode ? 'edit' : 'live'; this.refreshDerived();
      this.pendingRouteRestore = true;
    }
    this.activateContinuation();
    if (param && param.launchAssistant) {
      this.pendingRouteRestore = false; this.requestAssistant();
    } else if (this.pendingRouteRestore) { this.restoreRouteSelection(); }
  }

  private restoreRouteSelection(): void {
    if (!this.pendingRouteRestore || !this.pageVisible || !this.pageAttached) { return; }
    this.restoreEditorSelection(this.selectionStart, this.selectionEnd, this.contentText, true);
  }

  private activateContinuation(): void {
    if (this.deferredCreation || this.externalFileMode || !this.pageAttached || !this.pageVisible || !this.pageLoaded || this.templateMode || !this.note.id) { return; }
    LexiContinuationSession.activate(this.context(), this.continuationOwner, (): LexiContinuationDraft => {
      const draft = LexiContinuationData.capture(this.note, this.titleText, this.contentText,
        this.selectionStart, this.selectionEnd, this.viewMode === 'edit' || this.viewMode === 'split');
      draft.notebook = this.notebookText; draft.editorLevel = this.editorTier;
      return draft;
    });
  }

  private releaseContinuation(): void {
    if (this.templateMode || this.externalFileMode) { return; }
    try { LexiContinuationSession.deactivate(this.context(), this.continuationOwner); } catch {}
  }

  private editorShown(): void {
    this.pageVisible = true;
    if (this.note.id) {
      LexiHarnessService.setActiveEditorNoteId(this.note.id);
    }
    this.activateContinuation(); this.restoreRouteSelection();
    if (this.pendingAssistantOpen && !this.showToolsPanel) { this.presentAssistant(); }
    this.workspaceRefreshed();
  }

  private editorHidden(): void {
    this.pageVisible = false; this.focusRevision++;
    this.releaseContinuation();
    this.pendingToolSnippet = ''; this.pendingAssistantOpen = false; this.pendingAssistantSnippet = '';
    this.showToolsPanel = false; this.showAssistantPanel = false; this.showHarnessDialog = false;
  }

  private requestAssistant(): void {
    if (!this.pageLoaded || this.templateMode || !this.note.id) { return; }
    this.liveController.finishEditing();
    this.assistantSelectionStart = this.selectionStart; this.assistantSelectionEnd = this.selectionEnd;
    this.assistantSelectionBody = this.contentText; this.assistantNoteId = this.note.id;
    this.pendingAssistantSnippet = ''; this.pendingAssistantOpen = true;
    if (this.showToolsPanel) { this.showToolsPanel = false; }
    else { this.presentAssistant(); }
  }

  private presentAssistant(): void {
    if (!this.pendingAssistantOpen || !this.pageLoaded || this.templateMode) { return; }
    const noteId = this.note.id;
    // A direct toolbar tap need not produce another render frame. Open on the
    // next event turn rather than waiting indefinitely for a frame's idle phase.
    setTimeout((): void => {
      if (!this.pendingAssistantOpen || !this.pageAttached || !this.pageVisible || this.note.id !== noteId || this.showToolsPanel || this.templateMode) { return; }
      this.pendingAssistantOpen = false; this.completionItems = []; this.focusRevision++;
      this.showAssistantPanel = true;
    }, 0);
  }

  private queueAssistantInsertion(text: string): void {
    if (!this.showAssistantPanel || this.pendingAssistantSnippet || !text.trim()) { return; }
    this.pendingAssistantSnippet = text; this.showAssistantPanel = false;
  }

  private assistantDisappeared(): void {
    const snippet = this.pendingAssistantSnippet;
    this.pendingAssistantSnippet = '';
    if (!snippet || !this.pageAttached || !this.pageVisible || this.templateMode || this.note.id !== this.assistantNoteId) { return; }
    const start = this.mapSavedCursor(this.assistantSelectionBody, this.contentText, this.assistantSelectionStart);
    const end = Math.max(start, this.mapSavedCursor(this.assistantSelectionBody, this.contentText, this.assistantSelectionEnd));
    this.pushHistory(true);
    this.contentText = this.contentText.substring(0, start) + snippet + this.contentText.substring(end);
    this.selectionStart = start + snippet.length; this.selectionEnd = this.selectionStart;
    if (this.viewMode === 'preview') { this.viewMode = 'live'; }
    this.scheduleSave();
    this.restoreEditorSelection(this.selectionStart, this.selectionEnd, this.contentText, true);
  }

  @Builder
  private assistantSheet() {
    LexiCaptureAssistantPanel({ content: this.contentText,
      availableNotes: this.allVaultNotes.filter((note: NoteItem): boolean => note.id !== this.note.id),
      onInsert: (text: string): void => { this.queueAssistantInsertion(text); },
      onClose: (): void => { this.pendingAssistantSnippet = ''; this.showAssistantPanel = false; } })
  }

  @Builder
  private sourceBody() {
    TextArea({ text: this.contentText, controller: this.bodyController, placeholder: '全文 Markdown 源码' })
      .id(this.sourceInputId()).width('100%').constraintSize({ minHeight: this.viewMode === 'split' ? 260 : 400 })
      .fontSize(16).lineHeight(28).fontColor($r('app.color.text_primary'))
      .placeholderColor($r('app.color.text_secondary')).caretColor($r('app.color.brand'))
      .backgroundColor(Color.Transparent).borderRadius(0).padding(0)
      .onChange((text: string): void => {
        if (text !== this.contentText) { this.pushHistory(); this.contentText = text; this.scheduleSave(); }
      })
      .onTextSelectionChange((start: number, end: number): void => { this.refreshCompletion(start, end); })
      .onKeyPreIme((event: KeyEvent): boolean => { return this.completionKey(event); })
  }

  @Builder
  private renderedBody() {
    LexiMarkdownPreview({ frameless: true, blocks: this.blocks, outgoingLinks: this.outgoingLinks,
      availableNotes: this.allVaultNotes, notePath: this.note.path, anchorPrefix: `note-block-${this.note.id}`,
      onOpenTarget: (target: string): void => { this.openWikiLinkTarget(target); },
      onToggleTodo: (lineIndex: number): void => { this.toggleTodoAtLine(lineIndex); } })
  }

  @Builder
  private compactWritingSurface() {
    Column() {
      TextArea({ text: this.titleText, placeholder: this.templateMode ? '模板名称' : '标题（选填）' })
        .id('note-title-input').width('100%').constraintSize({ minHeight: 42 }).fontSize(25).lineHeight(34).fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_primary')).placeholderColor($r('app.color.text_secondary'))
        .caretColor($r('app.color.brand')).borderRadius(0)
        .backgroundColor(Color.Transparent).padding({ left: 24, right: 24, top: 8, bottom: 4 })
        .onChange((text: string): void => {
          const clean = text.replace(/\r?\n/g, ' ');
          if (clean !== this.titleText) { this.pushHistory(); this.titleText = clean; this.scheduleSave(); }
        })
      Scroll(this.previewScroller) {
        Column({ space: 12 }) {
          if (this.viewMode === 'live') {
            LexiLiveMarkdownEditor({ content: this.contentText, availableNotes: this.allVaultNotes,
              notePath: this.note.path, anchorPrefix: `note-block-${this.note.id}`,
              placeholder: '点击段落即可编辑，写下此刻的想法…', editorController: this.liveController,
              onChange: (text: string): void => {
                if (text !== this.contentText) { this.pushHistory(); this.contentText = text; this.scheduleSave(); }
              },
              onSelectionChange: (start: number, end: number): void => { this.refreshCompletion(start, end); },
              onSourceKey: (event: KeyEvent): boolean => { return this.completionKey(event); },
              onOpenTarget: (target: string): void => { this.openWikiLinkTarget(target); },
              onToggleTodo: (lineIndex: number): void => { this.toggleTodoAtLine(lineIndex); } })
          } else if (this.viewMode === 'preview') { this.renderedBody(); }
          else {
            this.sourceBody()
            if (this.viewMode === 'split') { Divider().color($r('app.color.divider')); this.renderedBody(); }
          }
        }.width('100%').padding({ left: 24, right: 24, top: 8, bottom: 80 }).alignItems(HorizontalAlign.Start)
      }.id(`note-preview-scroll-${this.note.id}`).width('100%').layoutWeight(1).align(Alignment.Top).scrollBar(BarState.Auto)
      this.inlineCompletion()
      Row({ space: 8 }) {
        Button('工具', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
          .id('note-tools-open').height(44).fontSize(14).fontColor($r('app.color.brand_ink'))
          .padding({ left: 8, right: 8 })
          .onClick((): void => { this.toolPage = 'format'; this.showToolsPanel = !this.showToolsPanel; })
          .bindPopup(this.showToolsPanel, {
            builder: this.compactToolsPopup, placement: Placement.TopLeft, width: this.toolPopupWidth(),
            popupColor: $r('app.color.surface'), enableArrow: true, autoCancel: true, focusable: true,
            keyboardAvoidMode: KeyboardAvoidMode.DEFAULT,
            onStateChange: (event: LexiNotePopupState): void => { this.showToolsPanel = event.isVisible; }
          })
        if (!this.templateMode) {
          Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
            Row({ space: 4 }) {
              LexiIcon({ name: 'spark', iconSize: 16 })
              Text('AI 助手').fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.brand_ink')).maxLines(1)
            }
          }.id('note-ai-harness').height(44).padding({ left: 8, right: 8 }).borderRadius(10)
            .accessibilityText('打开知萤 AI 助手对话框')
            .onClick((): void => {
              this.liveController.finishEditing();
              if (this.note.id) {
                LexiHarnessService.setActiveEditorNoteId(this.note.id);
              }
              this.showHarnessDialog = true;
            })

          Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
            Row({ space: 4 }) {
              SymbolGlyph($r('sys.symbol.mic')).fontSize(16).fontColor([$r('app.color.brand_ink')])
                .accessibilityLevel('no')
              Text('语音记录').fontSize(14).fontColor($r('app.color.brand_ink')).maxLines(1)
            }
          }.id('note-voice-record').height(44).padding({ left: 8, right: 8 }).borderRadius(10)
            .accessibilityText('语音记录，打开离线语音记录面板')
            .enabled(this.pageLoaded && !this.showAssistantPanel)
            .onClick((): void => { this.requestAssistant(); })
        }
        if (!this.externalFileMode || this.viewportWidth >= 440) {
          Text(`${this.contentText.length} 字`).fontSize(11).fontColor($r('app.color.text_secondary'))
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
        } else {
          Blank().layoutWeight(1)
        }
        if (this.viewportWidth >= 480) {
          Text(this.viewMode === 'live' ? '实时预览' : this.viewMode === 'preview' ? '只读' : '源码')
            .fontSize(11).fontColor($r('app.color.text_secondary'))
        }
        Button(this.viewMode === 'preview' ? '继续编辑' : '阅读', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
          .id('note-preview-toggle').height(44).fontSize(14).fontColor($r('app.color.brand_ink'))
          .padding({ left: 8, right: 8 })
          .onClick((): void => { this.liveController.finishEditing(); this.selectViewMode(this.viewMode === 'preview' ? 'live' : 'preview'); })
        if (this.externalFileMode) {
          Button('保存', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
            .id('note-external-save').height(44).fontSize(14).fontColor($r('app.color.brand_ink'))
            .padding({ left: 8, right: 8 })
            .onClick((): void => { this.promptSaveExternalFile(false); })
        }
      }.width('100%').height(48).padding({ left: 12, right: 12 })
        .border({ width: { top: 0.5 }, color: $r('app.color.divider') })
    }.id(`note-writing-surface-${this.note.id}-${this.continuationOwner}`).width('100%').constraintSize({ maxWidth: 1040 }).height('100%')
      .padding({ top: 56 + (this.windowViewportWidth < 840 ? this.titleTopInset : 0), bottom: this.windowViewportWidth < 840 ? this.bottomInset : 4 })
      .backgroundColor($r('app.color.surface'))
      .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }

  build() {
    NavDestination() {
      Stack({ alignContent: Alignment.Top }) {
        this.compactWritingSurface()
        if (this.showHarnessDialog) {
          LexiHarnessModalDialog({
            activeNoteIdProp: this.note.id,
            onClose: (): void => {
              this.showHarnessDialog = false;
            },
            onInsertToEditor: (markdownText: string): void => {
              this.pushHistory(true);
              this.contentText = `${this.contentText.trimEnd()}\n\n${markdownText}`;
              this.scheduleSave();
              this.showHarnessDialog = false;
            }
          })
        }
      }.width('100%').height('100%')
    }
    .hideBackButton(true)
    .onShown((): void => { this.editorShown(); })
    .onHidden((): void => { this.editorHidden(); })
    .bindSheet($$this.showAssistantPanel, this.assistantSheet, {
      height: SheetSize.LARGE, dragBar: true, showClose: true, title: { title: '语音与本地整理' },
      backgroundColor: $r('app.color.surface'), onDisappear: (): void => { this.assistantDisappeared(); }
    })
    .onBackPressed((): boolean => {
      if (this.showHarnessDialog) {
        this.showHarnessDialog = false;
        return true;
      }
      this.leaveEditor();
      return true;
    })
    .title(
      {
        builder: () => {
          this.pageTitleBar();
        },
        height: 56 + (this.windowViewportWidth < 840 ? this.titleTopInset : 0)
      },
      {
        barStyle: BarStyle.STACK,
        scrollEffectOptions: { scrollEffectType: ScrollEffectType.GRADUAL_BLUR }
      }
    )
    .backgroundColor($r('app.color.background'))
    .onAreaChange((_old: Area, current: Area) => {
      this.viewportWidth = Number(current.width);
    })
    .onReady((ctx: NavDestinationContext) => {
      this.pathStack = ctx.pathStack;
      const param = ctx.pathInfo.param as NoteEditorRouteParam | undefined;
      this.loadFromRoute(param).catch((error: Error): void => { this.saveStatus = '无法打开'; this.toast(error.message || '无法打开编辑器'); });
    })
  }
}
