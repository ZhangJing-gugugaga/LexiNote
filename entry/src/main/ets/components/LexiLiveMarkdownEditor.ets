import { MarkdownBlock, NoteItem } from '../core/LexiModels';
import { LexiLiveEditorController, LexiLiveMarkdown, LexiLiveRange, LexiLiveSelection } from '../core/LexiLiveMarkdown';
import { LexiMarkdownPreview } from './LexiEditorPanels';
import { FrameCallback } from '@kit.ArkUI';
import { LexiCodeFence, LexiCodeFenceInfo } from '../core/LexiCodeFence';
import { LexiCodeTools } from '../core/LexiCodeTools';

class LexiLiveFocusFrame extends FrameCallback {
  private perform: () => void;
  constructor(perform: () => void) { super(); this.perform = perform; }
  onIdle(_remaining: number): void { this.perform(); }
}

/** Render by default. Only the paragraph selected by the user becomes a source field. */
@Component
export struct LexiLiveMarkdownEditor {
  @Prop @Watch('documentChanged') content: string = '';
  @Prop availableNotes: NoteItem[] = [];
  @Prop notePath: string = '';
  @Prop anchorPrefix: string = 'live-markdown';
  @Prop placeholder: string = '点击这里开始记录…';
  @Prop editorEnabled: boolean = true;
  editorController: LexiLiveEditorController = new LexiLiveEditorController();
  onChange: (text: string) => void = (_text: string): void => {};
  onSelectionChange: (start: number, end: number) => void = (_start: number, _end: number): void => {};
  onSourceKey: (event: KeyEvent) => boolean = (_event: KeyEvent): boolean => false;
  onOpenTarget: (target: string) => void = (_target: string): void => {};
  onToggleTodo: (lineIndex: number) => void = (_line: number): void => {};
  @State private activeEditing: boolean = false;
  @State private sourceText: string = '';
  @State private editingCode: boolean = false;
  @State private showCodeSource: boolean = false;
  @State private codeBody: string = '';
  @State private selectedCodeLanguage: string = '';
  @State private detectedCodeLanguage: string = '';
  @State private leadingBlocks: MarkdownBlock[] = [];
  @State private trailingBlocks: MarkdownBlock[] = [];
  @State private wholeBlocks: MarkdownBlock[] = [];
  @State private contentWidth: number = 340;
  private documentText: string = '';
  private activeRange: LexiLiveRange = new LexiLiveRange();
  private globalStart: number = 0;
  private globalEnd: number = 0;
  private inputController: TextAreaController = new TextAreaController();
  private focusRevision: number = 0;
  private codeFence: LexiCodeFenceInfo = new LexiCodeFenceInfo();
  private languageIds: string[] = ['', 'text', 'arkts', 'typescript', 'javascript', 'json', 'python', 'html', 'css', 'sql', 'java', 'c', 'cpp', 'shell', 'go', 'rust'];
  private languageNames: string[] = ['自动识别', '纯文本', 'ArkTS', 'TypeScript', 'JavaScript', 'JSON', 'Python', 'HTML', 'CSS', 'SQL', 'Java', 'C', 'C++', 'Shell', 'Go', 'Rust'];

  aboutToAppear(): void {
    this.documentText = this.content;
    this.globalStart = this.content.length; this.globalEnd = this.content.length;
    this.wholeBlocks = LexiLiveMarkdown.blocksBetween(this.content, 0, this.content.length);
    this.editorController.caretPosition = (offset: number): void => { this.selectSource(offset, offset); };
    this.editorController.setTextSelection = (start: number, end: number): void => { this.selectSource(start, end); };
    this.editorController.insert = (snippet: string): void => { this.insertSnippet(snippet); };
    this.editorController.finishEditing = (): void => { this.finishEditing(); };
    this.editorController.getText = (): string => this.documentText;
    this.editorController.getSelection = (): LexiLiveSelection => {
      const selection = new LexiLiveSelection();
      selection.start = this.globalStart;
      selection.end = this.globalEnd;
      return selection;
    };
    this.editorController.replaceRange = (start: number, end: number, text: string): void => {
      this.replaceRangeInDocument(start, end, text);
    };
  }

  aboutToDisappear(): void {
    this.finishEditing();
    this.focusRevision++;
    this.editorController.caretPosition = (_offset: number): void => {};
    this.editorController.setTextSelection = (_start: number, _end: number): void => {};
    this.editorController.insert = (_snippet: string): void => {};
    this.editorController.finishEditing = (): void => {};
    this.editorController.getText = (): string => '';
    this.editorController.getSelection = (): LexiLiveSelection => new LexiLiveSelection();
    this.editorController.replaceRange = (_start: number, _end: number, _text: string): void => {};
  }

  private documentChanged(): void {
    if (this.content === this.documentText) { return; }
    const before = this.documentText;
    const start = LexiLiveMarkdown.mapOffset(before, this.content, this.globalStart);
    const end = LexiLiveMarkdown.mapOffset(before, this.content, this.globalEnd);
    const rangeStart = LexiLiveMarkdown.mapOffset(before, this.content, this.activeRange.start);
    const rangeEnd = LexiLiveMarkdown.mapOffset(before, this.content, this.activeRange.end);
    this.documentText = this.content; this.globalStart = start; this.globalEnd = end;
    if (this.activeEditing) {
      this.activeRange.start = rangeStart; this.activeRange.end = Math.max(rangeStart, rangeEnd);
      this.sourceText = this.content.substring(this.activeRange.start, this.activeRange.end);
      if (this.editingCode) { this.syncCodeSource(); }
      this.refreshOutsideSource();
      this.restoreFocus(start, end, false);
    } else { this.wholeBlocks = LexiLiveMarkdown.blocksBetween(this.content, 0, this.content.length); }
  }

  private refreshOutsideSource(): void {
    this.leadingBlocks = LexiLiveMarkdown.blocksBetween(this.documentText, 0, this.activeRange.start);
    this.trailingBlocks = LexiLiveMarkdown.blocksBetween(this.documentText, this.activeRange.end, this.documentText.length);
  }

  private restoreFocus(start: number, end: number, request: boolean = true): void {
    const revision = ++this.focusRevision;
    const uiContext = this.getUIContext();
    uiContext.postFrameCallback(new LexiLiveFocusFrame((): void => {
      if (!this.activeEditing || revision !== this.focusRevision) { return; }
      const source = uiContext.getAttachedFrameNodeById(`${this.anchorPrefix}-source`);
      if (!source || !source.isAttached() || !source.isVisible()) { return; }
      try {
        if (request) { uiContext.getFocusController().requestFocus(`${this.anchorPrefix}-source`); }
        const inputStart = this.inputStart();
        this.inputController.setTextSelection(Math.max(0, start - inputStart), Math.max(0, end - inputStart));
      } catch {
        // A popup or navigation may remove focus eligibility after the frame was scheduled.
        // The Markdown is already updated; a later tap can focus the retained source safely.
      }
    }));
  }

  private selectSource(start: number, end: number): void {
    if (!this.editorEnabled) { return; }
    if (this.activeEditing && this.editingCode && (start < this.activeRange.start || start > this.activeRange.end)) {
      const before = this.documentText;
      this.formatActiveCode();
      start = LexiLiveMarkdown.mapOffset(before, this.documentText, start);
      end = LexiLiveMarkdown.mapOffset(before, this.documentText, end);
    }
    this.activeRange = LexiLiveMarkdown.rangeAt(this.documentText, start);
    if (end > this.activeRange.end) { this.activeRange.end = Math.min(end, this.documentText.length); }
    this.sourceText = this.documentText.substring(this.activeRange.start, this.activeRange.end);
    this.editingCode = this.activeRange.kind === 'code'; this.showCodeSource = false;
    if (this.editingCode) { this.syncCodeSource(); }
    this.globalStart = Math.max(this.activeRange.start, Math.min(this.activeRange.end, start));
    this.globalEnd = Math.max(this.globalStart, Math.min(this.activeRange.end, end));
    if (this.editingCode) {
      const bodyStart = this.inputStart(); const bodyEnd = bodyStart + this.codeBody.length;
      this.globalStart = Math.max(bodyStart, Math.min(bodyEnd, this.globalStart));
      this.globalEnd = Math.max(this.globalStart, Math.min(bodyEnd, this.globalEnd));
    }
    this.refreshOutsideSource(); this.activeEditing = true;
    this.onSelectionChange(this.globalStart, this.globalEnd);
    this.restoreFocus(this.globalStart, this.globalEnd);
  }

  private editLine(lineIndex: number): void {
    const range = LexiLiveMarkdown.rangeForLine(this.documentText, lineIndex);
    this.selectSource(range.end, range.end);
  }

  private finishEditing(): void {
    if (!this.activeEditing) { return; }
    this.formatActiveCode();
    this.focusRevision++; this.activeEditing = false;
    this.editingCode = false;
    this.wholeBlocks = LexiLiveMarkdown.blocksBetween(this.documentText, 0, this.documentText.length);
  }

  private sourceChanged(text: string): void {
    if (text === this.sourceText) { return; }
    const oldSource = this.sourceText;
    const cursor = this.activeRange.start + LexiLiveMarkdown.changedCaret(oldSource, text);
    this.documentText = this.documentText.substring(0, this.activeRange.start) + text + this.documentText.substring(this.activeRange.end);
    this.sourceText = text; this.activeRange.end = this.activeRange.start + text.length;
    if (this.editingCode && this.showCodeSource) { this.syncCodeSource(); }
    this.globalStart = cursor; this.globalEnd = cursor;
    this.refreshOutsideSource(); this.onChange(this.documentText); this.onSelectionChange(cursor, cursor);
    if (text.length > oldSource.length && LexiLiveMarkdown.shouldAdvance(text.substring(0, cursor - this.activeRange.start), this.activeRange.kind)) {
      this.selectSource(cursor, cursor);
    }
  }

  private insertSnippet(snippet: string): void {
    if (!this.editorEnabled) { return; }
    if (this.activeEditing && this.editingCode) {
      const before = this.documentText; const start = this.globalStart; const end = this.globalEnd;
      this.finishEditing();
      this.globalStart = LexiLiveMarkdown.mapOffset(before, this.documentText, start);
      this.globalEnd = LexiLiveMarkdown.mapOffset(before, this.documentText, end);
    }
    const edit = LexiLiveMarkdown.replace(this.documentText, this.globalStart, this.globalEnd, snippet);
    this.documentText = edit.content; this.globalStart = edit.cursor; this.globalEnd = edit.cursor;
    this.onChange(edit.content);
    const codeIndex = snippet.indexOf('```\n\n```');
    const cursor = codeIndex >= 0 ? edit.cursor - snippet.length + codeIndex + 4 : edit.cursor;
    this.selectSource(cursor, cursor);
  }

  /** Plugin-facing explicit range replacement; mirrors insertSnippet's code-block offset remapping. */
  private replaceRangeInDocument(start: number, end: number, text: string): void {
    if (!this.editorEnabled) { return; }
    let from = Math.max(0, Math.min(this.documentText.length, start));
    let to = Math.max(from, Math.min(this.documentText.length, end));
    if (this.activeEditing && this.editingCode && (from < this.activeRange.start || from > this.activeRange.end)) {
      const before = this.documentText;
      this.formatActiveCode();
      from = LexiLiveMarkdown.mapOffset(before, this.documentText, from);
      to = LexiLiveMarkdown.mapOffset(before, this.documentText, to);
    }
    const edit = LexiLiveMarkdown.replace(this.documentText, from, to, text);
    this.documentText = edit.content;
    this.globalStart = edit.cursor; this.globalEnd = edit.cursor;
    this.onChange(edit.content);
    this.selectSource(edit.cursor, edit.cursor);
  }

  private inputStart(): number {
    return this.activeRange.start + (this.editingCode && !this.showCodeSource ? this.codeFence.bodyOffset : 0);
  }

  private syncCodeSource(): void {
    this.codeFence = LexiCodeFence.parse(this.sourceText);
    this.codeBody = this.codeFence.body; this.selectedCodeLanguage = this.codeFence.language;
    this.detectedCodeLanguage = LexiCodeTools.detect(this.codeBody);
  }

  private codeChanged(text: string): void {
    if (text === this.codeBody) { return; }
    const raw = LexiCodeFence.update(this.sourceText, text, this.selectedCodeLanguage);
    this.codeBody = text; this.sourceChanged(raw);
    this.codeFence = LexiCodeFence.parse(this.sourceText);
    this.detectedCodeLanguage = LexiCodeTools.detect(text);
  }

  private formatActiveCode(): void {
    if (!this.activeEditing || !this.editingCode || this.showCodeSource) { return; }
    const language = this.selectedCodeLanguage || this.detectedCodeLanguage;
    const formatted = LexiCodeTools.format(this.codeBody, language);
    if (formatted !== this.codeBody) { this.codeChanged(formatted); }
  }

  private selectCodeLanguage(index: number): void {
    if (index < 0 || index >= this.languageIds.length) { return; }
    const language = this.languageIds[index];
    if (language === this.selectedCodeLanguage) { return; }
    const before = this.documentText; const start = this.globalStart; const end = this.globalEnd;
    this.selectedCodeLanguage = language;
    this.sourceChanged(LexiCodeFence.update(this.sourceText, this.codeBody, language));
    this.codeFence = LexiCodeFence.parse(this.sourceText);
    this.globalStart = LexiLiveMarkdown.mapOffset(before, this.documentText, start);
    this.globalEnd = LexiLiveMarkdown.mapOffset(before, this.documentText, end);
    this.onSelectionChange(this.globalStart, this.globalEnd);
  }

  private codeLanguageLabel(): string {
    const index = this.languageIds.indexOf(this.selectedCodeLanguage);
    if (index > 0) { return this.languageNames[index]; }
    if (index < 0) { return this.selectedCodeLanguage; }
    const detected = this.languageIds.indexOf(this.detectedCodeLanguage);
    return detected > 0 ? `自动：${this.languageNames[detected]}` : '选择语言';
  }

  private languageOptions(): SelectOption[] {
    return this.languageNames.map((name: string): SelectOption => ({ value: name }));
  }

  private toggleCodeSource(): void {
    this.showCodeSource = !this.showCodeSource;
    if (!this.showCodeSource) { this.syncCodeSource(); }
    this.restoreFocus(this.globalStart, this.globalEnd);
  }

  private sourceHeight(): number {
    const columns = Math.max(16, Math.floor((this.contentWidth - 24) / 8.5));
    let count = 0;
    const text = this.editingCode && !this.showCodeSource ? this.codeBody : this.sourceText;
    for (const line of text.split('\n')) {
      let units = 0;
      for (let index = 0; index < line.length; index++) { units += line.charCodeAt(index) > 255 ? 2 : 1; }
      count += Math.max(1, Math.ceil(units / columns));
    }
    return Math.max(56, Math.min(this.contentWidth > 700 ? 600 : 360, count * 28 + 24));
  }

  build() {
    Column({ space: 12 }) {
      if (this.activeEditing) {
        if (this.leadingBlocks.length) {
          LexiMarkdownPreview({ frameless: true, blocks: this.leadingBlocks, availableNotes: this.availableNotes,
            notePath: this.notePath, anchorPrefix: this.anchorPrefix, editable: this.editorEnabled,
            onEditBlock: (line: number): void => { this.editLine(line); },
            onOpenTarget: this.onOpenTarget, onToggleTodo: this.onToggleTodo })
        }
        if (this.editingCode) {
          Row({ space: 4 }) {
            Select(this.languageOptions()).value(this.codeLanguageLabel()).font({ size: 12 }).height(36).layoutWeight(1)
              .onSelect((index: number): void => { this.selectCodeLanguage(index); })
            Button(this.showCodeSource ? '代码' : '源码', { buttonStyle: ButtonStyleMode.TEXTUAL })
              .fontSize(12).height(36).padding({ left: 6, right: 6 }).onClick((): void => { this.toggleCodeSource(); })
            Button('格式化', { buttonStyle: ButtonStyleMode.TEXTUAL }).fontSize(12).height(36)
              .padding({ left: 6, right: 6 }).enabled(!this.showCodeSource).onClick((): void => { this.formatActiveCode(); })
            Button('完成', { buttonStyle: ButtonStyleMode.TEXTUAL }).fontSize(12).height(36)
              .padding({ left: 6, right: 6 }).onClick((): void => { this.finishEditing(); })
          }.width('100%')
        }
        TextArea({ text: this.editingCode && !this.showCodeSource ? this.codeBody : this.sourceText,
          controller: this.inputController, placeholder: this.editingCode ? '在这里输入代码' : this.placeholder })
          .id(`${this.anchorPrefix}-source`).enabled(this.editorEnabled).width('100%').height(this.sourceHeight())
          .fontSize(16).lineHeight(28).fontColor($r('app.color.text_primary'))
          .placeholderColor($r('app.color.text_secondary')).caretColor($r('app.color.brand'))
          .backgroundColor($r('app.color.soft_surface')).borderRadius(10).padding(12)
          .onChange((text: string): void => {
            if (this.editingCode && !this.showCodeSource) { this.codeChanged(text); } else { this.sourceChanged(text); }
          })
          .onTextSelectionChange((start: number, end: number): void => {
            if (!this.activeEditing) { return; }
            this.globalStart = this.inputStart() + start; this.globalEnd = this.inputStart() + end;
            this.onSelectionChange(this.globalStart, this.globalEnd);
          })
          .onKeyPreIme((event: KeyEvent): boolean => this.onSourceKey(event))
          .onBlur((): void => { if (!this.editingCode) { this.finishEditing(); } })
        if (this.trailingBlocks.length) {
          LexiMarkdownPreview({ frameless: true, blocks: this.trailingBlocks, availableNotes: this.availableNotes,
            notePath: this.notePath, anchorPrefix: this.anchorPrefix, editable: this.editorEnabled,
            onEditBlock: (line: number): void => { this.editLine(line); },
            onOpenTarget: this.onOpenTarget, onToggleTodo: this.onToggleTodo })
        }
      } else if (this.wholeBlocks.length) {
        LexiMarkdownPreview({ frameless: true, blocks: this.wholeBlocks, availableNotes: this.availableNotes,
          notePath: this.notePath, anchorPrefix: this.anchorPrefix, editable: this.editorEnabled,
          onEditBlock: (line: number): void => { this.editLine(line); },
          onOpenTarget: this.onOpenTarget, onToggleTodo: this.onToggleTodo })
      }
      Text(LexiLiveMarkdown.hasBody(this.documentText) ? ' ' : this.placeholder)
        .id(`${this.anchorPrefix}-append`).width('100%').constraintSize({ minHeight: 64 })
        .fontSize(16).fontColor($r('app.color.text_secondary')).padding({ top: 8, bottom: 20 })
        .onClick((): void => {
          if (!this.documentText.endsWith('\n') && this.documentText.length) {
            this.documentText += '\n\n'; this.onChange(this.documentText);
          }
          this.selectSource(this.documentText.length, this.documentText.length);
        })
    }.width('100%').alignItems(HorizontalAlign.Start)
      .onAreaChange((_old: Area, current: Area): void => { this.contentWidth = Number(current.width); })
  }
}
