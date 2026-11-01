import { common } from '@kit.AbilityKit';
import { KeyCode } from '@kit.InputKit';
import { FrameCallback, LengthMetrics } from '@kit.ArkUI';
import { deviceInfo } from '@kit.BasicServicesKit';
import { LexiCompletionPanel } from './LexiCompletionPanel';
import { LexiCompletion, LexiCompletionCandidate, LexiCompletionContext } from '../core/LexiCompletion';
import { LexiAnchorNavigation } from '../core/LexiAnchorNavigation';
import { LexiIcon } from './LexiIcon';
import { LexiLiveMarkdownEditor } from './LexiLiveMarkdownEditor';
import { LexiLiveEditorController } from '../core/LexiLiveMarkdown';
import { NoteItem, NoteLink, OutlineHeading } from '../core/LexiModels';
import { LexiWorkspaceEditorController } from '../core/LexiWorkspaceModels';
import { LexiStorageService } from '../core/LexiStorageService';
import { MarkdownEngine } from '../core/MarkdownEngine';
import { LexiContinuationData, LexiContinuationDraft } from '../core/LexiContinuationData';
import { LexiContinuationSession } from '../core/LexiContinuationSession';
import { LexiCaptureAssistantPanel } from './LexiCaptureAssistantPanel';

class LexiWorkspaceSourceFrame extends FrameCallback {
  private perform: () => void;
  constructor(perform: () => void) { super(); this.perform = perform; }
  onIdle(_remaining: number): void { this.perform(); }
}

interface LexiWorkspacePopupState {
  isVisible: boolean;
}

interface LexiWorkspaceEditorToolParams {
  iconName: string;
  label: string;
  action: () => void;
  isEnabled?: boolean;
}

@Component
export struct LexiWorkspaceEditor {
  noteId: string = '';
  @StorageProp('lexiAnchorRequest') @Watch('anchorRequested') anchorRequest: number = 0;
  @State private completionItems: LexiCompletionCandidate[] = [];
  @State private completionIndex: number = 0;
  private completionContext: LexiCompletionContext = new LexiCompletionContext();
  private bodyController: TextAreaController = new TextAreaController();
  private liveController: LexiLiveEditorController = new LexiLiveEditorController();
  private selectionStart: number = 0;
  private selectionEnd: number = 0;
  editorController: LexiWorkspaceEditorController = new LexiWorkspaceEditorController();
  @Prop @Watch('vaultNotesChanged') vaultNotes: NoteItem[] = [];
  @Prop paneWidth: number = 900;
  @Prop @Watch('continuationActivityChanged') continuationActive: boolean = true;
  @StorageProp('lexiViewportWidth') windowViewportWidth: number = 900;
  @StorageProp('lexiViewportHeight') windowViewportHeight: number = 800;
  @State private note: NoteItem = new NoteItem();
  @State private titleText: string = '';
  @State private bodyText: string = '';
  @State private loaded: boolean = false;
  @State private loadFailed: boolean = false;
  @State private editing: boolean = false; // Explicit whole-document source mode; live preview is the default.
  @State private inspectorOpen: boolean = true;
  @State private statusText: string = '正在打开文档…';
  @State private headings: OutlineHeading[] = [];
  @State private outgoing: NoteLink[] = [];
  @State private backlinks: NoteLink[] = [];
  @State private historyCount: number = 0;
  @State private conflictResolving: boolean = false;
  @State private showToolsPopup: boolean = false;
  @State private toolPage: string = 'format';
  @State private toolLinkQuery: string = '';
  @State private showCaptureAssistant: boolean = false;
  private pendingCaptureOpen: boolean = false;
  private continuationOwner: string = LexiContinuationSession.newOwner();
  private continuationFocused: boolean = false;
  private pendingToolSnippet: string = '';
  private toolSelectionStart: number = 0;
  private toolSelectionEnd: number = 0;
  private toolSelectionBody: string = '';
  private editorAttached: boolean = false;
  private focusRevision: number = 0;
  private conflictVisible: boolean = false;
  private baseTitle: string = '';
  private baseContent: string = '';
  private allNotes: NoteItem[] = [];
  private undoHistory: string[] = [];
  private lastUndoAt: number = 0;
  private saveTimer: number = -1;
  private revision: number = 0;
  private savedRevision: number = 0;
  private pendingSave: Promise<void> | undefined = undefined;
  private loading: Promise<void> | undefined = undefined;
  private documentScroller: Scroller = new Scroller();
  onRequestReadingSpace: () => void = (): void => {};
  onOpenAdvancedNote: (noteId: string) => void = (_id: string): void => {};
  onSaved: (note: NoteItem) => void = (_note: NoteItem): void => {};
  onOpenNote: (noteId: string) => void = (_id: string): void => {};
  onConvertMap: (noteId: string) => void = (_id: string): void => {};

  aboutToAppear(): void {
    this.editorAttached = true;
    this.inspectorOpen = this.paneWidth >= 900;
    this.editorController.flush = async (): Promise<void> => {
      if (this.loading) {
        try { await this.loading; } catch {
          // A failed read has no draft to lose; allow the tab to be closed or retried.
          if (this.revision !== this.savedRevision) { throw new Error('文档尚未保存'); }
        }
      }
      await this.flush();
    };
    this.editorController.toggleReading = (): void => { this.toggleSourceMode(); };
    this.loading = this.load();
    this.loading.catch((): void => { this.loadFailed = true; this.statusText = '文档读取失败'; });
  }

  aboutToDisappear(): void {
    this.editorAttached = false; this.focusRevision++;
    this.pendingToolSnippet = ''; this.showToolsPopup = false;
    this.pendingCaptureOpen = false; this.showCaptureAssistant = false;
    this.continuationFocused = false;
    LexiContinuationSession.deactivate(this.context(), this.continuationOwner);
    if (this.saveTimer >= 0) { clearTimeout(this.saveTimer); }
    this.editorController.toggleReading = (): void => {};
    this.flush().catch((): void => {});
  }

  private context(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  private continuationActivityChanged(): void {
    if (!this.continuationActive) {
      this.continuationFocused = false;
      LexiContinuationSession.deactivate(this.context(), this.continuationOwner);
      this.pendingCaptureOpen = false; this.pendingToolSnippet = ''; this.showCaptureAssistant = false;
    } else { this.activateContinuation(false); }
  }

  private activateContinuation(focused: boolean): void {
    if (!this.editorAttached || !this.loaded || this.loadFailed || (!this.continuationActive && !focused)) { return; }
    if (focused) {
      try {
        const root = this.getUIContext().getAttachedFrameNodeById(`workspace-editor-${this.noteId}-${this.continuationOwner}`);
        if (!root || !root.isAttached() || !root.isVisible()) { return; }
      } catch { return; }
      this.continuationFocused = true;
    }
    LexiContinuationSession.activate(this.context(), this.continuationOwner, (): LexiContinuationDraft => {
      if (!this.editorAttached || !this.loaded || (!this.continuationActive && !this.continuationFocused)) {
        throw new Error('当前笔记已不在前台，请重新打开后接续');
      }
      const root = this.getUIContext().getAttachedFrameNodeById(`workspace-editor-${this.noteId}-${this.continuationOwner}`);
      if (!root || !root.isAttached() || !root.isVisible()) { throw new Error('当前笔记窗口不可见，请重新打开后接续'); }
      return LexiContinuationData.capture(this.note, this.titleText, this.bodyText,
        this.selectionStart, this.selectionEnd, this.editing);
    });
  }

  private toggleSourceMode(): void {
    this.focusRevision++;
    this.pendingToolSnippet = ''; this.showToolsPopup = false;
    this.pendingCaptureOpen = false; this.showCaptureAssistant = false;
    this.liveController.finishEditing();
    if (this.editing) { this.refreshDocument(true); }
    this.editing = !this.editing;
    this.completionItems = [];
  }

  private async load(): Promise<void> {
    this.loadFailed = false;
    const found = await LexiStorageService.getNoteById(this.noteId);
    if (!found) { throw new Error('文档不存在'); }
    this.note = found; this.baseTitle = found.title; this.baseContent = found.content;
    this.titleText = found.title;
    this.bodyText = found.content;
    this.selectionStart = found.content.length; this.selectionEnd = found.content.length;
    this.allNotes = (await LexiStorageService.getNotes(found.vaultId)).filter((n: NoteItem): boolean => n.trashedAt === 0);
    this.editing = false;
    this.refreshDocument();
    this.loaded = true;
    this.statusText = '已保存到本机';
    this.activateContinuation(false);
    this.anchorRequested();
  }

  private vaultNotesChanged(): void {
    this.allNotes = this.vaultNotes.filter((n: NoteItem): boolean => n.trashedAt === 0);
    if (this.loaded) {
      const latest = this.allNotes.find((n: NoteItem): boolean => n.id === this.noteId);
      if (latest) {
        if (this.revision === this.savedRevision && !this.pendingSave && latest.updatedAt !== this.note.updatedAt) {
          this.titleText = latest.title; this.baseTitle = latest.title;
          this.bodyText = latest.content; this.baseContent = latest.content;
        }
        this.note = latest;
      }
      this.refreshDocument();
    }
  }

  private refreshDocument(includeLinks: boolean = true): void {
    this.headings = MarkdownEngine.extractOutline(this.bodyText);
    if (!includeLinks) {
      return;
    }
    const snapshot = new NoteItem();
    snapshot.id = this.note.id;
    snapshot.vaultId = this.note.vaultId;
    snapshot.title = this.titleText;
    snapshot.content = this.bodyText;
    const working = this.allNotes.filter((n: NoteItem): boolean => n.id !== this.noteId);
    working.push(snapshot);
    const links = MarkdownEngine.buildNoteLinks(working);
    this.outgoing = links.filter((link: NoteLink): boolean => link.sourceId === this.noteId);
    this.backlinks = links.filter((link: NoteLink): boolean => link.targetId === this.noteId);
  }

  private changed(): void {
    this.revision++;
    this.statusText = '正在自动保存…';
    if (!this.editing || this.inspectorOpen) {
      this.refreshDocument(false);
    }
    if (this.saveTimer >= 0) { clearTimeout(this.saveTimer); }
    this.saveTimer = setTimeout((): void => {
      this.flush().catch((): void => { this.statusText = '保存失败 · 点击重试'; });
    }, 400);
  }

  private async flush(): Promise<void> {
    while (this.pendingSave) { await this.pendingSave; }
    if (!this.loaded || this.savedRevision === this.revision) { return; }
    const savingRevision = this.revision;
    const snapshot = JSON.parse(JSON.stringify(this.note)) as NoteItem;
    snapshot.title = this.titleText.trim();
    snapshot.content = this.bodyText;
    const operation = this.saveSnapshot(snapshot, savingRevision);
    this.pendingSave = operation;
    try { await operation; } finally { this.pendingSave = undefined; }
    if (this.savedRevision !== this.revision) { await this.flush(); }
  }

  private async saveSnapshot(snapshot: NoteItem, savingRevision: number): Promise<void> {
    const savingContent = snapshot.content;
    let saved: NoteItem;
    try { saved = await LexiStorageService.saveNoteIfCurrent(this.context(), snapshot, this.baseTitle, this.baseContent); }
    catch (error) {
      if ((error as Error).message === 'DOCUMENT_CHANGED_ELSEWHERE' && !this.conflictVisible) {
        this.conflictVisible = true;
        this.getUIContext().showAlertDialog({ title: '笔记已在其他位置更新', message: '当前草稿仍然保留，可另存为副本，避免覆盖另一个窗口的修改。',
          primaryButton: { value: '保留草稿', action: (): void => { this.conflictVisible = false; } },
          secondaryButton: { value: '另存为副本', action: (): void => { this.saveConflictCopy(); } } });
      }
      throw error as Error;
    }
    this.note = saved; this.baseTitle = saved.title; this.baseContent = saved.content;
    if (this.revision === savingRevision && this.bodyText === savingContent && saved.content !== savingContent) {
      const selectionStart = this.mapSavedCursor(savingContent, saved.content, this.selectionStart);
      const selectionEnd = this.mapSavedCursor(savingContent, saved.content, this.selectionEnd);
      this.bodyText = saved.content;
      this.selectionStart = selectionStart; this.selectionEnd = selectionEnd;
      this.completionItems = [];
      if (this.editing) {
        this.restoreEditorSelection(selectionStart, selectionEnd, saved.content, false);
      }
    }
    this.savedRevision = savingRevision;
    this.refreshDocument(true);
    this.onSaved(saved);
    if (this.revision === savingRevision) { this.statusText = '已保存到本机'; }
  }

  private async saveConflictCopy(): Promise<void> {
    if (this.conflictResolving) { return; }
    this.conflictResolving = true;
    try {
      const copy = JSON.parse(JSON.stringify(this.note)) as NoteItem;
      copy.id = ''; copy.path = ''; copy.createdAt = 0; copy.updatedAt = 0;
      copy.title = `${this.titleText || '未命名笔记'}（冲突副本）`; copy.content = this.bodyText;
      const saved = await LexiStorageService.saveNote(this.context(), copy);
      const latest = await LexiStorageService.getNoteById(this.noteId);
      if (latest) {
        this.note = latest; this.titleText = latest.title; this.bodyText = latest.content;
        this.baseTitle = latest.title; this.baseContent = latest.content;
      }
      this.savedRevision = this.revision; this.conflictVisible = false;
      this.onSaved(saved); this.onOpenNote(saved.id);
    } catch { this.statusText = '副本保存失败，当前草稿已保留'; }
    finally { this.conflictResolving = false; }
  }

  private updateBody(text: string): void {
    if (text === this.bodyText) { return; }
    const now = Date.now();
    if (now - this.lastUndoAt >= 600 || this.undoHistory.length === 0) {
      this.undoHistory.push(this.bodyText);
      if (this.undoHistory.length > 50) { this.undoHistory.shift(); }
      this.historyCount = this.undoHistory.length;
    }
    this.lastUndoAt = now;
    this.bodyText = text;
    this.changed();
  }

  private undo(): void {
    this.liveController.finishEditing();
    const previous = this.undoHistory.pop();
    if (previous === undefined) { return; }
    this.lastUndoAt = 0;
    this.bodyText = previous;
    this.historyCount = this.undoHistory.length;
    this.changed();
  }

  private toggleTodo(lineIndex: number): void {
    const lines = this.bodyText.split('\n');
    if (lineIndex < 0 || lineIndex >= lines.length) { return; }
    lines[lineIndex] = /^\s*[-*+]\s+\[ \]/.test(lines[lineIndex]) ?
      lines[lineIndex].replace('[ ]', '[x]') : lines[lineIndex].replace(/\[[xX]\]/, '[ ]');
    this.updateBody(lines.join('\n'));
  }

  private async openTarget(rawTarget: string): Promise<void> {
    this.liveController.finishEditing();
    await this.flush();
    const target = LexiCompletion.splitTarget(rawTarget);
    this.allNotes = (await LexiStorageService.getNotes(this.note.vaultId)).filter((n: NoteItem): boolean => n.trashedAt === 0);
    const found = this.allNotes.find((n: NoteItem): boolean =>
      target.noteName ? n.id === target.noteName || n.title.trim().toLowerCase() === target.noteName.toLowerCase() : n.id === this.noteId);
    if (found) {
      if (found.id === this.noteId) { this.jumpToAnchor(target.anchor); return; }
      LexiAnchorNavigation.request(found.id, target.anchor);
      this.onOpenNote(found.id); return;
    }
    if (!target.noteName) { return; }
    const fresh = new NoteItem();
    fresh.vaultId = this.note.vaultId;
    fresh.projectId = this.note.projectId || '';
    fresh.title = target.noteName;
    fresh.notebook = this.note.notebook;
    fresh.noteType = 'markdown';
    fresh.editorLevel = 'pro';
    const saved = await LexiStorageService.saveNote(this.context(), fresh);
    this.onSaved(saved);
    LexiAnchorNavigation.request(saved.id, target.anchor);
    this.onOpenNote(saved.id);
  }

  private anchorRequested(): void {
    if (!this.loaded) { return; }
    const anchor = LexiAnchorNavigation.take(this.noteId);
    if (anchor) { this.jumpToAnchor(anchor); }
  }

  private jumpToAnchor(anchor: string): void {
    this.refreshDocument(false);
    const heading = LexiCompletion.findHeading(this.headings, anchor);
    if (heading) { this.jumpToHeading(heading); }
    else if (anchor) { this.getUIContext().getPromptAction().showToast({ message: `未找到章节「${anchor}」` }); }
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
    this.activateContinuation(true);
    this.completionContext = LexiCompletion.context(this.bodyText, start, end);
    const currentDraft = JSON.parse(JSON.stringify(this.note)) as NoteItem;
    currentDraft.title = this.titleText; currentDraft.content = this.bodyText;
    const workingNotes = this.allNotes.filter((n: NoteItem): boolean => n.id !== this.noteId);
    workingNotes.push(currentDraft);
    this.completionItems = LexiCompletion.candidates(this.completionContext, workingNotes, this.noteId);
    this.completionIndex = 0;
  }

  private acceptCompletion(candidate: LexiCompletionCandidate): void {
    const edit = LexiCompletion.apply(this.bodyText, this.completionContext, candidate);
    this.updateBody(edit.text);
    this.completionItems = [];
    this.selectionStart = edit.cursor; this.selectionEnd = edit.cursor;
    this.restoreEditorSelection(edit.cursor, edit.cursor, edit.text, true);
  }

  private completionKey(event: KeyEvent): boolean {
    if (!this.completionItems.length || event.type !== KeyType.Down) { return false; }
    if (event.keyCode === KeyCode.KEYCODE_DPAD_DOWN || event.keyCode === KeyCode.KEYCODE_DPAD_UP) {
      const movement = event.keyCode === KeyCode.KEYCODE_DPAD_DOWN ? 1 : -1;
      this.completionIndex = (this.completionIndex + movement + this.completionItems.length) % this.completionItems.length;
      return true;
    } else if (event.keyCode === KeyCode.KEYCODE_ENTER || event.keyCode === KeyCode.KEYCODE_TAB) {
      this.acceptCompletion(this.completionItems[this.completionIndex]); return true;
    } else if (event.keyCode === KeyCode.KEYCODE_ESCAPE) {
      this.completionItems = []; return true;
    }
    return false;
  }

  private jumpToHeading(heading: OutlineHeading): void {
    this.liveController.finishEditing();
    if (this.editing) { this.editing = false; }
    this.completionItems = [];
    if (heading.level === 1 && heading.title.trim() === this.titleText.trim()) {
      this.documentScroller.scrollTo({ xOffset: 0, yOffset: 0 }); return;
    }
    setTimeout((): void => {
      try {
        const utils = this.getUIContext().getComponentUtils();
        const target = utils.getRectangleById(`workspace-block-${this.noteId}-${this.continuationOwner}-${heading.lineIndex}`);
        const viewport = utils.getRectangleById(`workspace-document-${this.noteId}-${this.continuationOwner}`);
        const delta = this.getUIContext().px2vp(target.windowOffset.y - viewport.windowOffset.y);
        this.documentScroller.scrollTo({ xOffset: 0,
          yOffset: Math.max(0, this.documentScroller.currentOffset().yOffset + delta - 24) });
      } catch {}
    }, 80);
  }

  private async exportDocument(): Promise<void> {
    try {
      await this.flush();
      await LexiStorageService.saveViaDocumentPicker(this.context(), `${MarkdownEngine.displayTitle(this.note)}.md`, this.bodyText);
    } catch (error) {
      this.getUIContext().getPromptAction().showToast({ message: (error as Error).message || '导出未完成' });
    }
  }

  private restoreEditorSelection(start: number, end: number, expectedBody: string, requestFocus: boolean): void {
    const revision = ++this.focusRevision;
    const sourceMode = this.editing;
    const uiContext = this.getUIContext();
    uiContext.postFrameCallback(new LexiWorkspaceSourceFrame((): void => {
      if (!this.editorAttached || revision !== this.focusRevision || !this.loaded || this.conflictResolving || this.showCaptureAssistant ||
        this.bodyText !== expectedBody || this.editing !== sourceMode) { return; }
      try {
        const root = uiContext.getAttachedFrameNodeById(`workspace-editor-${this.noteId}-${this.continuationOwner}`);
        if (!root || !root.isAttached() || !root.isVisible()) { return; }
        if (sourceMode) {
          const inputId = `workspace-body-input-${this.noteId}-${this.continuationOwner}`;
          const input = uiContext.getAttachedFrameNodeById(inputId);
          if (!input || !input.isAttached() || !input.isVisible()) { return; }
          if (requestFocus) { uiContext.getFocusController().requestFocus(inputId); }
          this.bodyController.setTextSelection(start, end);
        } else { this.liveController.setTextSelection(start, end); }
      } catch {
        // Retained tabs may become hidden between scheduling a frame and restoring the selection.
      }
    }));
  }

  private openTools(): void {
    if (!this.loaded || this.conflictResolving) { return; }
    this.pendingToolSnippet = ''; this.pendingCaptureOpen = false;
    this.toolPage = 'format'; this.toolLinkQuery = '';
    this.toolSelectionStart = this.selectionStart; this.toolSelectionEnd = this.selectionEnd;
    this.toolSelectionBody = this.bodyText;
    this.showToolsPopup = !this.showToolsPopup;
  }

  private selectedToolText(): string {
    const start = Math.max(0, Math.min(this.toolSelectionStart, this.toolSelectionBody.length));
    const end = Math.max(start, Math.min(this.toolSelectionEnd, this.toolSelectionBody.length));
    return this.toolSelectionBody.substring(start, end);
  }

  private queueToolAction(action: string): void {
    if (!this.loaded || this.conflictResolving) { return; }
    const selected = this.selectedToolText();
    let snippet = '';
    if (action === 'bold') { snippet = `**${selected || '粗体内容'}**`; }
    else if (action === 'italic') { snippet = `*${selected || '强调内容'}*`; }
    else if (action === 'strike') { snippet = `~~${selected || '待修订内容'}~~`; }
    else if (action === 'highlight') { snippet = `==${selected || '重点内容'}==`; }
    else if (action === 'h1') { snippet = `\n# ${selected || '章节标题'}\n`; }
    else if (action === 'h2') { snippet = `\n## ${selected || '核心小节'}\n`; }
    else if (action === 'todo') { snippet = `\n- [ ] ${selected || '待完成事项'}\n`; }
    else if (action === 'hr') { snippet = '\n\n---\n\n'; }
    else if (action === 'table') { snippet = '\n| 项目 | 内容 |\n| --- | --- |\n|  |  |\n'; }
    else if (action === 'code') { snippet = '\n```\n' + selected + '\n```\n'; }
    else if (action === 'formula') { snippet = `\n$$${selected || 'f(n) = O(n \\log n)'}$$\n`; }
    else if (action === 'callout') { snippet = `\n> [!NOTE] 知识要点\n> ${selected || '在此记录要点'}\n`; }
    else if (action === 'link') { this.toolPage = 'links'; return; }
    else if (action === 'assistant') {
      this.pendingToolSnippet = ''; this.pendingCaptureOpen = true; this.showToolsPopup = false; return;
    }
    this.queueToolSnippet(snippet);
  }

  private queueToolSnippet(snippet: string): void {
    if (!snippet || !this.loaded || this.conflictResolving) { return; }
    this.pendingCaptureOpen = false; this.pendingToolSnippet = snippet;
    this.showToolsPopup = false;
  }

  private insertPendingToolSnippet(): void {
    const snippet = this.pendingToolSnippet;
    this.pendingToolSnippet = '';
    if (!snippet || !this.editorAttached || !this.loaded || this.conflictResolving) { return; }
    try {
      const root = this.getUIContext().getAttachedFrameNodeById(`workspace-editor-${this.noteId}-${this.continuationOwner}`);
      if (!root || !root.isAttached() || !root.isVisible()) { return; }
    } catch { return; }
    const start = this.mapSavedCursor(this.toolSelectionBody, this.bodyText, this.toolSelectionStart);
    const end = Math.max(start, this.mapSavedCursor(this.toolSelectionBody, this.bodyText, this.toolSelectionEnd));
    if (this.editing) {
      this.lastUndoAt = 0;
      this.updateBody(this.bodyText.substring(0, start) + snippet + this.bodyText.substring(end));
      this.selectionStart = start + snippet.length; this.selectionEnd = this.selectionStart;
      this.restoreEditorSelection(this.selectionStart, this.selectionEnd, this.bodyText, true);
    } else {
      this.lastUndoAt = 0;
      this.liveController.setTextSelection(start, end);
      this.liveController.insert(snippet);
    }
  }

  private toolLinkCandidates(): NoteItem[] {
    const query = this.toolLinkQuery.trim().toLowerCase();
    return this.allNotes.filter((note: NoteItem): boolean => note.id !== this.noteId && note.trashedAt === 0 &&
      (!query || MarkdownEngine.displayTitle(note).toLowerCase().includes(query))).slice(0, 8);
  }

  private toolsPopupDidDisappear(): void {
    if (!this.pendingCaptureOpen) { this.insertPendingToolSnippet(); return; }
    this.pendingCaptureOpen = false;
    if (!this.editorAttached || !this.loaded || this.conflictResolving) { return; }
    try {
      const root = this.getUIContext().getAttachedFrameNodeById(`workspace-editor-${this.noteId}-${this.continuationOwner}`);
      if (!root || !root.isAttached() || !root.isVisible()) { return; }
    } catch { return; }
    this.liveController.finishEditing(); this.completionItems = [];
    this.showCaptureAssistant = true;
  }

  private captureSheetHeight(): number {
    const viewport = this.windowViewportHeight > 0 ? this.windowViewportHeight : 800;
    return Math.max(1, Math.min(720, viewport - 96));
  }

  private captureDismissed(): void {
    this.showCaptureAssistant = false;
    this.insertPendingToolSnippet();
  }

  @Builder
  private formatTool(label: string, action: string) {
    Button(label, { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
      .id(`workspace-tool-${this.noteId}-${action}`).width('32%').height(40).fontSize(12)
      .padding(2).borderRadius(8).margin({ right: '1%', bottom: 6 })
      .fontColor($r('app.color.brand_ink')).backgroundColor($r('app.color.soft_surface'))
      .onClick((): void => { this.queueToolAction(action); })
  }

  @Builder
  private captureAssistantSheet() {
    LexiCaptureAssistantPanel({ content: this.bodyText,
      availableNotes: this.allNotes.filter((note: NoteItem): boolean => note.id !== this.noteId &&
        note.trashedAt === 0 && note.vaultId === this.note.vaultId),
      onInsert: (text: string): void => {
        if (!text || !this.editorAttached || !this.loaded || this.conflictResolving) { return; }
        this.pendingToolSnippet = text; this.showCaptureAssistant = false;
      },
      onClose: (): void => { this.pendingToolSnippet = ''; this.showCaptureAssistant = false; }
    })
  }

  @Builder
  private toolsPopup() {
    Column({ space: 8 }) {
      Row({ space: 6 }) {
        if (this.toolPage === 'links') {
          Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
            Row({ space: 3 }) {
              LexiIcon({ name: 'back', iconSize: 13 })
              Text('返回').fontSize(12).fontColor($r('app.color.brand_ink'))
            }.width('100%').justifyContent(FlexAlign.Center)
          }.id(`workspace-tools-back-${this.noteId}`).width(62).height(32).padding(0).borderRadius(8)
            .accessibilityText('返回工具列表').onClick((): void => { this.toolPage = 'format'; })
        }
        Text(this.toolPage === 'links' ? '插入笔记链接' : '笔记工具').fontSize(14).fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary')).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
        Button('关闭', { buttonStyle: ButtonStyleMode.TEXTUAL }).height(30).fontSize(11)
          .fontColor($r('app.color.brand_ink')).onClick((): void => { this.pendingToolSnippet = ''; this.showToolsPopup = false; })
      }.width('100%')
      Scroll() {
        Column({ space: 7 }) {
          if (this.toolPage === 'links') {
            TextInput({ text: this.toolLinkQuery, placeholder: '搜索笔记或输入新标题' })
              .id(`workspace-tool-link-search-${this.noteId}`).height(36).fontSize(12)
              .fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.soft_surface'))
              .onChange((text: string): void => { this.toolLinkQuery = text; })
            ForEach(this.toolLinkCandidates(), (candidate: NoteItem) => {
              Button(MarkdownEngine.displayTitle(candidate), { buttonStyle: ButtonStyleMode.TEXTUAL })
                .id(`workspace-tool-link-${this.noteId}-${candidate.id}`).width('100%').height(34).fontSize(12)
                .fontColor($r('app.color.brand_ink')).onClick((): void => {
                  this.queueToolSnippet(`[[${MarkdownEngine.displayTitle(candidate)}]]`);
                })
            }, (candidate: NoteItem): string => candidate.id)
            if (this.toolLinkQuery.trim()) {
              Button('插入此标题链接', { buttonStyle: ButtonStyleMode.TEXTUAL }).width('100%').height(34).fontSize(12)
                .fontColor($r('app.color.brand_ink')).onClick((): void => { this.queueToolSnippet(`[[${this.toolLinkQuery.trim()}]]`); })
            }
          } else {
            Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Start }) {
              this.formatTool('粗体', 'bold')
              this.formatTool('斜体', 'italic')
              this.formatTool('删除线', 'strike')
              this.formatTool('高亮', 'highlight')
              this.formatTool('一级标题', 'h1')
              this.formatTool('二级标题', 'h2')
              this.formatTool('待办清单', 'todo')
              this.formatTool('分割线', 'hr')
              this.formatTool('表格', 'table')
              this.formatTool('代码块', 'code')
              this.formatTool('公式', 'formula')
              this.formatTool('提示框', 'callout')
              this.formatTool('笔记链接', 'link')
              this.formatTool('语音 / 整理', 'assistant')
            }.width('100%')
          }
        }.width('100%').alignItems(HorizontalAlign.Start)
      }.width('100%').layoutWeight(1).align(Alignment.Top).scrollBar(BarState.Auto)
    }.id(`workspace-tools-popup-${this.noteId}`).width(Math.min(312, Math.max(236, this.paneWidth - 32)))
      .height(320).padding(12).backgroundColor($r('app.color.surface')).borderRadius(16)
      .onDisAppear((): void => { this.toolsPopupDidDisappear(); })
  }

  @Builder
  private tool($$: LexiWorkspaceEditorToolParams) {
    Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
      LexiIcon({ name: $$.iconName, iconSize: 17 })
    }
    .width(36).height(36).padding(0).borderRadius(7)
    .backgroundColor(Color.Transparent).enabled($$.isEnabled !== false)
    .accessibilityText($$.label).onClick($$.action)
  }

  @Builder
  private documentMenu() {
    Menu() {
      MenuItem({ content: '文档属性与高级编辑' }).onClick((): void => {
        this.flush().then((): void => { this.onOpenAdvancedNote(this.noteId); }).catch((): void => {
          this.statusText = '保存失败 · 点击重试';
        });
      })
      MenuItem({ content: '导出 Markdown' }).onClick((): void => { this.exportDocument(); })
      MenuItem({ content: '生成思维导图' }).onClick((): void => {
        this.flush().then((): void => { this.onConvertMap(this.noteId); }).catch((): void => {
          this.statusText = '保存失败 · 点击重试';
        });
      })
    }
  }

  @Builder
  private inspector() {
    Column({ space: 18 }) {
      Row() {
        Text('文档大纲').fontSize(13).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
        Blank()
        Text(`${this.headings.length}`).fontSize(11).fontColor($r('app.color.text_secondary'))
      }.width('100%')
      Scroll() {
        Column({ space: 4 }) {
          if (this.headings.length === 0) {
            Text('用 Markdown 标题梳理思路，大纲会出现在这里。')
              .fontSize(12).lineHeight(21).fontColor($r('app.color.text_secondary')).width('100%')
          }
          ForEach(this.headings, (heading: OutlineHeading) => {
            Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
              Text(heading.title).fontSize(12).maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
                .fontColor($r('app.color.text_secondary')).width('100%').textAlign(TextAlign.Start)
            }
            .width('100%').constraintSize({ minHeight: 36 }).padding({ left: (heading.level - 1) * 10, right: 2, top: 7, bottom: 7 })
            .backgroundColor(Color.Transparent).borderRadius(6).onClick((): void => { this.jumpToHeading(heading); })
          }, (heading: OutlineHeading): string => heading.id)
          Divider().color($r('app.color.workspace_line')).margin({ top: 22, bottom: 16 })
          Text('双向链接').fontSize(13).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary')).width('100%')
          Text(`${this.outgoing.length} 个出链 · ${this.backlinks.length} 个反向链接`)
            .fontSize(11).fontColor($r('app.color.text_secondary')).width('100%').margin({ top: 6, bottom: 10 })
          ForEach(this.outgoing, (link: NoteLink) => {
            Button(link.targetTitle, { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
              .fontSize(12).fontColor($r('app.color.brand_ink')).width('100%').height(34)
              .backgroundColor(Color.Transparent).padding(0)
              .onClick((): void => { this.openTarget(`${link.targetId || link.targetTitle}${link.anchor ? '#' + link.anchor : ''}`).catch((): void => {}); })
          }, (link: NoteLink): string => `${link.sourceId}-${link.targetTitle}`)
          ForEach(this.backlinks, (link: NoteLink) => {
            Button(link.sourceTitle, { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
              .fontSize(12).fontColor($r('app.color.brand_ink')).width('100%').height(34)
              .backgroundColor(Color.Transparent).padding(0)
              .onClick((): void => { this.openTarget(link.sourceId).catch((): void => {}); })
          }, (link: NoteLink): string => `back-${link.sourceId}-${link.targetTitle}`)
        }.width('100%').alignItems(HorizontalAlign.Start)
      }.width('100%').layoutWeight(1).scrollBar(BarState.Off).align(Alignment.Top)
    }
    .width(216).height('100%').padding({ left: 20, right: 20, top: 28, bottom: 24 })
    .backgroundColor($r('app.color.workspace_inspector'))
    .border({ width: { left: 0.5 }, color: $r('app.color.workspace_line') })
  }

  build() {
    Column() {
      Row({ space: 6 }) {
        LexiIcon({ name: 'folder', iconSize: 15 })
        Text(this.note.notebook || '知识库').fontSize(12).fontColor($r('app.color.text_secondary'))
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        Text('/').fontSize(12).fontColor($r('app.color.text_secondary'))
        Text(this.titleText || '无标题笔记').fontSize(12).fontColor($r('app.color.text_primary'))
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
        Button(this.editing ? '实时预览' : '源码', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
          .id('workspace-edit-toggle').fontSize(12).height(34).padding({ left: 14, right: 14 }).borderRadius(7)
          .backgroundColor(this.editing ? $r('app.color.workspace_selection') : Color.Transparent)
          .fontColor($r('app.color.brand_ink'))
          .accessibilityText(this.editing ? '当前为整篇源码编辑，切换到实时预览' : '当前为实时预览，切换到整篇源码编辑')
          .onClick((): void => { this.toggleSourceMode(); })
        Button('工具', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
          .id(`workspace-tools-${this.noteId}`).height(34).fontSize(12).padding({ left: 12, right: 12 }).borderRadius(7)
          .fontColor($r('app.color.brand_ink')).backgroundColor($r('app.color.workspace_selection'))
          .enabled(this.loaded && !this.conflictResolving).onClick((): void => { this.openTools(); })
          .bindPopup(this.showToolsPopup, {
            builder: this.toolsPopup, placement: Placement.BottomRight, width: Math.min(312, Math.max(236, this.paneWidth - 32)),
            popupColor: $r('app.color.surface'), enableArrow: true, autoCancel: true, focusable: true,
            keyboardAvoidMode: KeyboardAvoidMode.DEFAULT,
            onStateChange: (event: LexiWorkspacePopupState): void => { this.showToolsPopup = event.isVisible; }
          })
        Button('更多', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
          .id('workspace-document-more').height(34).fontSize(12).padding({ left: 10, right: 10 }).borderRadius(7)
          .fontColor($r('app.color.text_secondary')).backgroundColor(Color.Transparent).bindMenu(this.documentMenu())
        this.tool({ iconName: 'undo', label: '撤销正文编辑', action: (): void => { this.undo(); }, isEnabled: this.historyCount > 0 })
        Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
          SymbolGlyph($r('sys.symbol.list_bullet')).fontSize(17).fontColor([$r('app.color.text_secondary')])
        }.id('workspace-outline-toggle').width(36).height(36).padding(0).borderRadius(7)
          .backgroundColor(this.inspectorOpen && this.paneWidth >= 680 ? $r('app.color.workspace_selection') : Color.Transparent)
          .accessibilityText('展开或收起大纲').onClick((): void => {
            if (this.inspectorOpen && this.paneWidth >= 680) { this.inspectorOpen = false; }
            else {
              this.inspectorOpen = true;
              if (this.paneWidth < 900) { this.onRequestReadingSpace(); }
            }
          })
      }
      .height(48).width('100%').padding({ left: 28, right: 16 })
      .border({ width: { bottom: 0.5 }, color: $r('app.color.workspace_line') })
      Row() {
        Scroll(this.documentScroller) {
          Column({ space: 18 }) {
            if (this.loadFailed) {
              Text('文档暂时无法打开').fontSize(24).fontColor($r('app.color.text_primary'))
              Button('重新读取').onClick((): void => {
                this.loading = this.load(); this.loading.catch((): void => { this.loadFailed = true; });
              })
            } else if (this.loaded) {
              TextInput({ text: this.titleText, placeholder: '无标题笔记' })
                .id(`workspace-title-input-${this.noteId}-${this.continuationOwner}`).enabled(!this.conflictResolving).height(58).width('100%').padding(0)
                .fontSize(30).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
                .placeholderColor($r('app.color.text_secondary')).caretColor($r('app.color.brand'))
                .backgroundColor(Color.Transparent).borderRadius(0)
                .onFocus((): void => { this.activateContinuation(true); })
                .onChange((text: string): void => {
                  if (text !== this.titleText) { this.titleText = text; this.changed(); }
                })
              Row({ space: 8 }) {
                Text(this.note.noteType === 'study' ? '学习笔记' : this.note.noteType === 'quick' ? '快速笔记' : 'Markdown')
                  .fontSize(11).fontColor($r('app.color.brand_ink'))
                Text('·').fontSize(11).fontColor($r('app.color.text_secondary'))
                Text(`${this.bodyText.length} 字符`).fontSize(11).fontColor($r('app.color.text_secondary'))
                ForEach(this.note.tags.slice(0, 3), (tag: string) => {
                  Text(`#${tag}`).fontSize(11).fontColor($r('app.color.brand_ink'))
                }, (tag: string): string => tag)
              }.width('100%').margin({ bottom: 14 })
              if (this.editing) {
                TextArea({ text: this.bodyText, controller: this.bodyController, placeholder: '从一个想法开始。支持 Markdown、#标签与 [[双向链接]]。' })
                  .id(`workspace-body-input-${this.noteId}-${this.continuationOwner}`).enabled(!this.conflictResolving).width('100%').constraintSize({ minHeight: 460 })
                  .fontSize(16).lineHeight(28).fontColor($r('app.color.text_primary'))
                  .placeholderColor($r('app.color.text_secondary')).caretColor($r('app.color.brand'))
                  .backgroundColor(Color.Transparent).borderRadius(0).padding(0)
                  .onFocus((): void => { this.activateContinuation(true); })
                  .onChange((text: string): void => { this.updateBody(text); })
                  .onTextSelectionChange((start: number, end: number): void => { this.refreshCompletion(start, end); })
                  .onKeyPreIme((event: KeyEvent): boolean => { return this.completionKey(event); })
              } else {
                LexiLiveMarkdownEditor({
                  content: this.bodyText, editorController: this.liveController, editorEnabled: !this.conflictResolving,
                  availableNotes: this.allNotes, notePath: this.note.path,
                  anchorPrefix: `workspace-block-${this.noteId}-${this.continuationOwner}`,
                  placeholder: '点按这里开始记录。支持 Markdown、#标签与 [[双向链接]]。',
                  onChange: (text: string): void => { this.updateBody(text); },
                  onSelectionChange: (start: number, end: number): void => { this.refreshCompletion(start, end); },
                  onSourceKey: (event: KeyEvent): boolean => { return this.completionKey(event); },
                  onOpenTarget: (target: string): void => { this.openTarget(target).catch((): void => {}); },
                  onToggleTodo: (line: number): void => { this.toggleTodo(line); }
                })
              }
              if (this.completionItems.length > 0) {
                LexiCompletionPanel({ candidates: this.completionItems, activeIndex: this.completionIndex,
                  onSelect: (candidate: LexiCompletionCandidate): void => { this.acceptCompletion(candidate); } })
              }
            }
          }
          .width('100%').constraintSize({ maxWidth: 800 })
          .padding({ left: 56, right: 56, top: 42, bottom: 80 }).alignItems(HorizontalAlign.Start)
        }
        .id(`workspace-document-${this.noteId}-${this.continuationOwner}`).layoutWeight(1).height('100%')
        .align(Alignment.Top).scrollBar(BarState.Auto)
        if (this.inspectorOpen && this.paneWidth >= 680) { this.inspector(); }
      }.width('100%').layoutWeight(1)
      Row({ space: 16 }) {
        Text(this.editing ? 'Markdown 源码' : '实时预览 · 点按段落编辑').fontSize(11).fontColor($r('app.color.text_secondary'))
        Blank()
        Text(`${this.backlinks.length} 个反向链接`).fontSize(11).fontColor($r('app.color.text_secondary'))
        Text(`${this.bodyText.length} 字符`).fontSize(11).fontColor($r('app.color.text_secondary'))
        Text(this.statusText).id('workspace-save-status').fontSize(11).fontColor($r('app.color.text_secondary'))
          .onClick((): void => { this.flush().catch((): void => { this.statusText = '保存失败 · 点击重试'; }); })
      }
      .height(deviceInfo.deviceType === '2in1' ? 30 : 34).width('100%')
      .padding({ left: 24, right: 20, bottom: deviceInfo.deviceType === '2in1' ? 0 : 4 })
      .border({ width: { top: 0.5 }, color: $r('app.color.workspace_line') })
    }.id(`workspace-editor-${this.noteId}-${this.continuationOwner}`).width('100%').height('100%').backgroundColor($r('app.color.workspace_page'))
      .onVisibleAreaChange([0], (visible: boolean, _ratio: number): void => {
        if (!visible) {
          this.continuationFocused = false;
          LexiContinuationSession.deactivate(this.context(), this.continuationOwner);
          this.pendingCaptureOpen = false; this.pendingToolSnippet = ''; this.showCaptureAssistant = false;
        } else if (this.continuationActive) { this.activateContinuation(false); }
      })
      .bindSheet($$this.showCaptureAssistant, this.captureAssistantSheet, {
        height: this.captureSheetHeight(), width: this.windowViewportWidth >= 840 ? 680 : '100%',
        preferType: this.windowViewportWidth >= 840 ? SheetType.CENTER : SheetType.BOTTOM,
        radius: this.windowViewportWidth >= 840 ? LengthMetrics.vp(24) : undefined,
        dragBar: this.windowViewportWidth < 840, showClose: true,
        backgroundColor: $r('app.color.surface'),
        onDisappear: (): void => { this.captureDismissed(); }
      })
  }
}
