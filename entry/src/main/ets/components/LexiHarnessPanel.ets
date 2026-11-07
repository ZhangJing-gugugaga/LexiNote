import { common } from '@kit.AbilityKit';
import { curves } from '@kit.ArkUI';
import { pasteboard } from '@kit.BasicServicesKit';
import { MarkdownBlock, NoteItem } from '../core/LexiModels';
import { LexiStorageService } from '../core/LexiStorageService';
import { LexiMarkdownInlineSpan, MarkdownEngine } from '../core/MarkdownEngine';
import {
  LexiHarnessConfig,
  LexiHarnessModelProfile,
  LexiHarnessNoteRef,
  LexiHarnessSessionRecord,
  LexiHarnessSkillDefinition,
  LexiHarnessTodoItem,
  LexiHarnessUiItem,
  LexiHarnessUiToolRow
} from '../harness/LexiHarnessTypes';
import { LexiHarnessService } from '../harness/LexiHarnessService';
import { LexiHarnessSkills } from '../harness/LexiHarnessSkills';
import { LexiHarnessUiActionRequest } from '../harness/LexiHarnessTools';
import { LexiIcon } from './LexiIcon';

class LexiHarnessTableCell {
  id: string = '';
  text: string = '';
  alignment: string = 'left';
}

class LexiHarnessTableRow {
  id: string = '';
  header: boolean = false;
  stripe: boolean = false;
  cells: LexiHarnessTableCell[] = [];
}

@Component
struct LexiHarnessInlineText {
  @Prop sourceText: string = '';
  @Prop textSize: number = 13;
  @Prop textLeading: number = 20;
  @Prop strong: boolean = false;
  @Prop muted: boolean = false;
  @Prop checked: boolean = false;
  @Prop raw: boolean = false;
  onOpenTarget: (target: string) => void = (_target: string): void => {};

  private segments(): LexiMarkdownInlineSpan[] {
    if (this.raw) {
      const plain = new LexiMarkdownInlineSpan();
      plain.id = 'raw';
      plain.text = this.sourceText;
      return [plain];
    }
    return MarkdownEngine.inlineSpans(this.sourceText);
  }

  build() {
    Text() {
      ForEach(this.segments(), (segment: LexiMarkdownInlineSpan) => {
        Span(segment.text)
          .fontWeight(this.strong || segment.kind === 'bold' ? FontWeight.Bold : FontWeight.Regular)
          .fontStyle(segment.kind === 'italic' ? FontStyle.Italic : FontStyle.Normal)
          .fontFamily(this.raw || segment.kind === 'code' ? 'monospace' : 'HarmonyOS Sans')
          .fontColor(
            segment.kind === 'link' || segment.kind === 'url'
              ? $r('app.color.brand_ink')
              : (this.muted || this.checked ? $r('app.color.text_secondary') : $r('app.color.text_primary'))
          )
          .textBackgroundStyle({
            color: segment.kind === 'highlight'
              ? $r('app.color.brand_soft')
              : (segment.kind === 'code' ? $r('app.color.soft_surface') : Color.Transparent),
            radius: 3
          })
          .decoration({
            type: segment.kind === 'strike' || this.checked
              ? TextDecorationType.LineThrough
              : (segment.kind === 'link' || segment.kind === 'url' ? TextDecorationType.Underline : TextDecorationType.None)
          })
          .onClick((): void => {
            if (segment.kind === 'link' || segment.kind === 'url') {
              this.onOpenTarget(segment.target);
            }
          })
      }, (segment: LexiMarkdownInlineSpan): string => segment.id)
    }
    .fontSize(this.textSize)
    .lineHeight(this.textLeading)
    .copyOption(CopyOptions.LocalDevice)
    .width('100%')
  }
}

@Component
struct LexiHarnessMarkdownView {
  @Prop @Watch('rebuildBlocks') content: string = '';
  @Prop itemKey: string = 'md';
  onOpenTarget: (target: string) => void = (_target: string): void => {};
  @State private blocks: MarkdownBlock[] = [];

  aboutToAppear(): void {
    this.rebuildBlocks();
  }

  private rebuildBlocks(): void {
    this.blocks = MarkdownEngine.parseBlocks(this.content);
  }

  private tableRows(block: MarkdownBlock): LexiHarnessTableRow[] {
    const data = MarkdownEngine.tableData(block);
    return data.rows.map((cells: string[], rowIndex: number): LexiHarnessTableRow => {
      const row = new LexiHarnessTableRow();
      row.id = `${this.itemKey}-${block.id}-r-${rowIndex}`;
      row.header = rowIndex === 0;
      row.stripe = rowIndex % 2 === 1;
      row.cells = cells.map((text: string, colIndex: number): LexiHarnessTableCell => {
        const cell = new LexiHarnessTableCell();
        cell.id = `${row.id}-c-${colIndex}`;
        cell.text = text;
        cell.alignment = data.alignments[colIndex] || 'left';
        return cell;
      });
      return row;
    });
  }

  private async copyCodeBlock(codeText: string): Promise<void> {
    try {
      await pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, codeText));
      this.getUIContext().getPromptAction().showToast({ message: '代码已复制' });
    } catch {}
  }

  build() {
    Column({ space: 8 }) {
      ForEach(this.blocks, (block: MarkdownBlock) => {
        Column() {
          if (block.kind === 'hr') {
            Divider().color($r('app.color.divider')).strokeWidth(0.5).margin({ top: 4, bottom: 4 })
          } else if (block.kind === 'h1' || block.kind === 'h2' || block.kind === 'h3') {
            LexiHarnessInlineText({
              sourceText: block.text,
              textSize: block.kind === 'h1' ? 16 : (block.kind === 'h2' ? 15 : 14),
              textLeading: block.kind === 'h1' ? 24 : 22,
              strong: true,
              onOpenTarget: this.onOpenTarget
            })
          } else if (block.kind === 'table') {
            Scroll() {
              Column() {
                ForEach(this.tableRows(block), (row: LexiHarnessTableRow) => {
                  Row() {
                    ForEach(row.cells, (cell: LexiHarnessTableCell) => {
                      Column() {
                        LexiHarnessInlineText({
                          sourceText: cell.text,
                          textSize: 12,
                          textLeading: 18,
                          strong: row.header,
                          onOpenTarget: this.onOpenTarget
                        })
                      }
                      .width(120)
                      .padding({ left: 8, right: 8, top: 6, bottom: 6 })
                      .constraintSize({ minHeight: 32 })
                      .border({ width: 0.5, color: $r('app.color.divider') })
                      .backgroundColor(
                        row.header
                          ? $r('app.color.brand_soft')
                          : (row.stripe ? $r('app.color.soft_surface') : $r('app.color.surface'))
                      )
                    }, (cell: LexiHarnessTableCell): string => cell.id)
                  }
                  .alignItems(VerticalAlign.Top)
                }, (row: LexiHarnessTableRow): string => row.id)
              }
              .alignItems(HorizontalAlign.Start)
            }
            .scrollable(ScrollDirection.Horizontal)
            .scrollBar(BarState.Off)
            .align(Alignment.TopStart)
            .width('100%')
            .borderRadius(8)
            .clip(true)
          } else if (block.kind === 'bullet' || block.kind === 'ordered') {
            Row({ space: 6 }) {
              Text(block.kind === 'ordered' ? `${block.meta}.` : '•')
                .fontSize(13)
                .fontWeight(FontWeight.Bold)
                .fontColor($r('app.color.brand'))
                .padding({ top: 1 })
              Column() {
                LexiHarnessInlineText({
                  sourceText: block.text,
                  textSize: 13,
                  textLeading: 20,
                  onOpenTarget: this.onOpenTarget
                })
              }
              .layoutWeight(1)
            }
            .width('100%')
            .alignItems(VerticalAlign.Top)
          } else if (block.kind === 'todo') {
            Row({ space: 6 }) {
              Text(block.checked ? '☑' : '☐')
                .fontSize(13)
                .fontColor(block.checked ? '#10B981' : $r('app.color.brand'))
              Column() {
                LexiHarnessInlineText({
                  sourceText: block.text,
                  textSize: 13,
                  textLeading: 20,
                  checked: block.checked,
                  onOpenTarget: this.onOpenTarget
                })
              }
              .layoutWeight(1)
            }
            .width('100%')
            .alignItems(VerticalAlign.Top)
          } else if (block.kind === 'quote' || block.kind === 'callout') {
            Column({ space: 4 }) {
              if (block.kind === 'callout') {
                Text(`✦ ${block.meta || 'NOTE'}`)
                  .fontSize(10)
                  .fontWeight(FontWeight.Bold)
                  .fontColor($r('app.color.brand_ink'))
              }
              LexiHarnessInlineText({
                sourceText: block.text,
                textSize: 12,
                textLeading: 19,
                muted: block.kind === 'quote',
                onOpenTarget: this.onOpenTarget
              })
            }
            .width('100%')
            .padding(10)
            .borderRadius(8)
            .backgroundColor($r('app.color.brand_soft'))
            .alignItems(HorizontalAlign.Start)
          } else if (block.kind === 'code' || block.kind === 'formula') {
            Column({ space: 6 }) {
              Row() {
                Text(block.kind === 'formula' ? 'LaTeX' : (block.meta || 'code'))
                  .fontSize(10)
                  .fontWeight(FontWeight.Medium)
                  .fontColor($r('app.color.brand_ink'))
                Blank()
                Text('复制')
                  .fontSize(10)
                  .fontColor($r('app.color.brand_ink'))
                  .onClick((): void => {
                    this.copyCodeBlock(block.text);
                  })
              }
              .width('100%')

              LexiHarnessInlineText({
                sourceText: block.text,
                textSize: 12,
                textLeading: 18,
                raw: true
              })
            }
            .width('100%')
            .padding(10)
            .borderRadius(8)
            .backgroundColor($r('app.color.soft_surface'))
            .border({ width: 0.5, color: $r('app.color.divider') })
            .alignItems(HorizontalAlign.Start)
          } else {
            LexiHarnessInlineText({
              sourceText: block.text,
              textSize: 13,
              textLeading: 20,
              onOpenTarget: this.onOpenTarget
            })
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }, (block: MarkdownBlock): string => `${this.itemKey}-${block.id}-${block.kind}-${block.text}`)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

/**
 * Clean vector-style sliders icon for Settings (replaces emoji gear)
 */
@Component
struct LexiSettingsSlidersIcon {
  @Prop active: boolean = false;

  build() {
    Column({ space: 4 }) {
      Stack({ alignContent: Alignment.Start }) {
        Row()
          .width(14)
          .height(1.5)
          .borderRadius(1)
          .backgroundColor(this.active ? $r('app.color.brand_ink') : $r('app.color.text_secondary'))
        Row()
          .width(4)
          .height(4)
          .borderRadius(2)
          .margin({ left: 3 })
          .backgroundColor(this.active ? $r('app.color.brand_ink') : $r('app.color.text_secondary'))
      }
      .width(14)
      .height(4)

      Stack({ alignContent: Alignment.Start }) {
        Row()
          .width(14)
          .height(1.5)
          .borderRadius(1)
          .backgroundColor(this.active ? $r('app.color.brand_ink') : $r('app.color.text_secondary'))
        Row()
          .width(4)
          .height(4)
          .borderRadius(2)
          .margin({ left: 8 })
          .backgroundColor(this.active ? $r('app.color.brand_ink') : $r('app.color.text_secondary'))
      }
      .width(14)
      .height(4)
    }
    .width(16)
    .height(14)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }
}

@Component
export struct LexiHarnessPanel {
  @Prop isDialogMode: boolean = false;
  @Prop isWidePanel: boolean = false;
  @Prop activeNoteIdProp: string = '';
  onClose: () => void = () => {};
  onToggleWide: () => void = () => {};
  onInsertToEditor: (markdownText: string) => void = () => {};
  onCreateNoteFromReply: (title: string, markdownText: string) => void = () => {};

  @StorageLink('lexiHarnessRevision') @Watch('onHarnessRevisionChanged') harnessRevision: number = 0;
  @StorageLink('lexiWorkspaceRevision') @Watch('onWorkspaceRevisionChanged') workspaceRevision: number = 0;

  @State private currentTab: string = 'chat'; // 'chat' | 'sessions' | 'settings'
  @State private settingsSubTab: string = 'models'; // 'models' | 'skills'
  @State private composerText: string = '';
  @State private attachedRefs: LexiHarnessNoteRef[] = [];
  @State private showRefPicker: boolean = false;
  @State private showSkillPicker: boolean = false;
  @State private showModelPicker: boolean = false;
  @State private modelPickerView: string = 'slider'; // 'slider' | 'list'
  @State private refFilterText: string = '';
  @State private showSkillBanner: boolean = true;

  @State private uiItems: LexiHarnessUiItem[] = [];
  @State private todos: LexiHarnessTodoItem[] = [];
  @State private skills: LexiHarnessSkillDefinition[] = [];
  @State private sessions: LexiHarnessSessionRecord[] = [];
  @State private modelProfiles: LexiHarnessModelProfile[] = [];
  @State private activeModelId: string = '';
  @State private activeModelLabel: string = 'deepseek-chat';
  @State private activeReasoningEffort: string = 'medium';
  @State private balanceText: string = '';
  @State private balanceLoading: boolean = false;
  @State private activeSessionId: string = '';
  @State private activeSessionTitle: string = '新会话';
  @State private isTurnRunning: boolean = false;

  @State private availableNotes: NoteItem[] = [];
  @State private availableFolders: string[] = [];
  @State private currentOpenNoteTitle: string = '';
  @State private currentOpenNoteId: string = '';

  @State private expandedToolIds: string[] = [];
  @State private collapsedReasoningIds: string[] = [];

  // Skill viewer / creator states (inside Settings -> Skill 技能库)
  @State private selectedSkillName: string = '';
  @State private showCreateSkillForm: boolean = false;
  @State private newSkillNameInput: string = '';
  @State private newSkillDescInput: string = '';
  @State private newSkillBodyInput: string = '';

  // Multi-model editor form states (inside Settings -> 模型与 API)
  @State private showModelForm: boolean = false;
  @State private editingProfileId: string = '';
  @State private cfgLabel: string = '';
  @State private cfgProvider: string = 'deepseek-openai';
  @State private cfgBaseUrl: string = 'https://api.deepseek.com';
  @State private cfgApiKey: string = '';
  @State private cfgModel: string = 'deepseek-chat';
  @State private cfgEffort: string = 'medium';
  @State private settingsNotice: string = '';

  private chatScroller: Scroller = new Scroller();

  private hostContext(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  aboutToAppear(): void {
    this.initializePanel();
  }

  onHarnessRevisionChanged(): void {
    this.syncFromService();
  }

  onWorkspaceRevisionChanged(): void {
    this.refreshWorkspaceCandidates();
  }

  private async initializePanel(): Promise<void> {
    await LexiHarnessService.init(this.hostContext());
    if (this.activeNoteIdProp) {
      LexiHarnessService.setActiveEditorNoteId(this.activeNoteIdProp);
    }
    this.syncFromService();
    await this.refreshWorkspaceCandidates();
  }

  private syncFromService(): void {
    this.uiItems = LexiHarnessService.deriveUiItems();
    this.todos = LexiHarnessService.getTodos();
    this.skills = LexiHarnessService.getSkills();
    this.sessions = LexiHarnessService.getSessions();
    this.modelProfiles = LexiHarnessService.getModels().slice();
    const activeProfile = LexiHarnessService.getActiveModelProfile();
    this.activeModelId = activeProfile.id;
    this.activeModelLabel = activeProfile.label || activeProfile.model || 'deepseek-chat';
    this.activeReasoningEffort = activeProfile.reasoningEffort || LexiHarnessService.getConfig().reasoningEffort || 'medium';
    if (this.showModelForm && this.editingProfileId) {
      const editingTarget = this.modelProfiles.find((m: LexiHarnessModelProfile): boolean => m.id === this.editingProfileId);
      if (editingTarget) {
        this.cfgEffort = editingTarget.reasoningEffort;
      }
    }
    this.balanceText = LexiHarnessService.getBalanceText();
    this.balanceLoading = LexiHarnessService.isBalanceLoading();
    const activeRec = LexiHarnessService.getActiveSession().record;
    this.activeSessionId = activeRec.id;
    this.activeSessionTitle = activeRec.title || '新会话';
    this.isTurnRunning = LexiHarnessService.isRunning();
    this.refreshOpenNoteBadge();
  }

  private async refreshWorkspaceCandidates(): Promise<void> {
    const vaultId = await LexiStorageService.getActiveVaultId();
    const allNotes = (await LexiStorageService.getNotes(vaultId)).filter((n: NoteItem): boolean => n.trashedAt === 0);
    this.availableNotes = allNotes;
    const folderSet: string[] = [];
    for (let i = 0; i < allNotes.length; i++) {
      const nb = allNotes[i].notebook || '未分类';
      if (!folderSet.includes(nb)) {
        folderSet.push(nb);
      }
    }
    this.availableFolders = folderSet;
    this.refreshOpenNoteBadge();
  }

  private refreshOpenNoteBadge(): void {
    const targetId = this.activeNoteIdProp || LexiHarnessService.getActiveEditorNoteId();
    this.currentOpenNoteId = targetId;
    if (!targetId) {
      this.currentOpenNoteTitle = '';
      return;
    }
    const found = this.availableNotes.find((n: NoteItem): boolean => n.id === targetId);
    this.currentOpenNoteTitle = found ? MarkdownEngine.displayTitle(found) : '';
  }

  private openNoteByTarget(target: string): void {
    const clean = target.split('#')[0].trim().replace(/\.md$/i, '');
    if (!clean) {
      return;
    }
    const found = this.availableNotes.find((n: NoteItem): boolean =>
      n.id === clean || MarkdownEngine.displayTitle(n).toLowerCase() === clean.toLowerCase()
    );
    if (found) {
      const req = new LexiHarnessUiActionRequest();
      req.action = 'open-note';
      req.targetId = found.id;
      LexiHarnessService.triggerUiAction(req);
    }
  }

  private isToolExpanded(itemId: string): boolean {
    return this.expandedToolIds.includes(itemId);
  }

  private toggleToolExpand(itemId: string): void {
    if (this.expandedToolIds.includes(itemId)) {
      this.expandedToolIds = this.expandedToolIds.filter((id: string): boolean => id !== itemId);
    } else {
      this.expandedToolIds = [...this.expandedToolIds, itemId];
    }
  }

  private isReasoningCollapsed(itemId: string): boolean {
    return this.collapsedReasoningIds.includes(itemId);
  }

  private toggleReasoningCollapse(itemId: string): void {
    if (this.collapsedReasoningIds.includes(itemId)) {
      this.collapsedReasoningIds = this.collapsedReasoningIds.filter((id: string): boolean => id !== itemId);
    } else {
      this.collapsedReasoningIds = [...this.collapsedReasoningIds, itemId];
    }
  }

  private attachNoteReference(note: NoteItem): void {
    const title = MarkdownEngine.displayTitle(note);
    const exists = this.attachedRefs.some((r: LexiHarnessNoteRef): boolean => r.kind === 'note' && r.id === note.id);
    if (!exists) {
      this.attachedRefs = [...this.attachedRefs, new LexiHarnessNoteRef(note.id, title, 'note')];
    }
    this.showRefPicker = false;
  }

  private attachFolderReference(folderName: string): void {
    const exists = this.attachedRefs.some((r: LexiHarnessNoteRef): boolean => r.kind === 'folder' && r.title === folderName);
    if (!exists) {
      this.attachedRefs = [...this.attachedRefs, new LexiHarnessNoteRef(folderName, folderName, 'folder')];
    }
    this.showRefPicker = false;
  }

  private removeAttachedRef(refId: string): void {
    this.attachedRefs = this.attachedRefs.filter((r: LexiHarnessNoteRef): boolean => r.id !== refId);
  }

  private attachCurrentOpenNote(): void {
    if (!this.currentOpenNoteId) {
      return;
    }
    const found = this.availableNotes.find((n: NoteItem): boolean => n.id === this.currentOpenNoteId);
    if (found) {
      this.attachNoteReference(found);
    }
  }

  private insertSkillSlash(skillName: string): void {
    const token = `/${skillName} `;
    if (!this.composerText.includes(`/${skillName}`)) {
      this.composerText = `${token}${this.composerText}`;
    }
    this.showSkillPicker = false;
    this.showModelPicker = false;
    this.currentTab = 'chat';
  }

  private async submitMessage(overridePrompt: string = ''): Promise<void> {
    const textToSend = (overridePrompt || this.composerText).trim();
    if (!textToSend || this.isTurnRunning) {
      return;
    }
    const refsToSend = [...this.attachedRefs];
    if (!overridePrompt) {
      this.composerText = '';
    }
    this.attachedRefs = [];
    this.showRefPicker = false;
    this.showSkillPicker = false;
    this.showModelPicker = false;
    this.currentTab = 'chat';

    if (this.activeNoteIdProp) {
      LexiHarnessService.setActiveEditorNoteId(this.activeNoteIdProp);
    }

    await LexiHarnessService.sendUserMessage(this.hostContext(), textToSend, refsToSend);
    this.chatScroller.scrollEdge(Edge.Bottom);
  }

  private openAddModelForm(): void {
    const cfg = LexiHarnessService.getConfig();
    this.editingProfileId = '';
    this.cfgLabel = '';
    this.cfgProvider = cfg.provider || 'deepseek-openai';
    this.cfgBaseUrl = cfg.baseUrl || 'https://api.deepseek.com';
    this.cfgApiKey = cfg.apiKey || '';
    this.cfgModel = 'deepseek-chat';
    this.cfgEffort = 'medium';
    this.settingsNotice = '';
    this.showModelForm = true;
  }

  private openEditModelForm(profile: LexiHarnessModelProfile): void {
    this.editingProfileId = profile.id;
    this.cfgLabel = profile.label;
    this.cfgProvider = profile.provider;
    this.cfgBaseUrl = profile.baseUrl;
    this.cfgApiKey = profile.apiKey || LexiHarnessService.getConfig().apiKey;
    this.cfgModel = profile.model;
    this.cfgEffort = profile.reasoningEffort;
    this.settingsNotice = '';
    this.showModelForm = true;
  }

  private async saveModelProfileForm(): Promise<void> {
    const modelName = this.cfgModel.trim() || 'deepseek-chat';
    const label = this.cfgLabel.trim() || modelName;
    const baseUrl = this.cfgBaseUrl.trim() || (this.cfgProvider.includes('anthropic') ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com');
    const profile = new LexiHarnessModelProfile(
      this.editingProfileId || `model-${Date.now()}`,
      label,
      this.cfgProvider,
      baseUrl,
      this.cfgApiKey.trim(),
      modelName,
      this.cfgEffort
    );
    await LexiHarnessService.upsertModelProfile(profile, true);
    this.showModelForm = false;
    this.settingsNotice = `已保存并启用模型「${profile.label}」`;
  }

  private selectProviderPreset(provider: string): void {
    this.cfgProvider = provider;
    if (provider === 'deepseek-openai') {
      this.cfgBaseUrl = 'https://api.deepseek.com';
      if (!this.cfgModel || this.cfgModel.startsWith('claude') || this.cfgModel.startsWith('gpt')) {
        this.cfgModel = 'deepseek-chat';
      }
    } else if (provider === 'deepseek-anthropic') {
      this.cfgBaseUrl = 'https://api.deepseek.com/anthropic';
      if (!this.cfgModel || this.cfgModel.startsWith('claude') || this.cfgModel.startsWith('gpt')) {
        this.cfgModel = 'deepseek-flash';
      }
    } else if (provider === 'openai-compatible') {
      if (this.cfgBaseUrl.includes('deepseek.com/anthropic')) {
        this.cfgBaseUrl = 'https://api.openai.com/v1';
      }
    } else if (provider === 'anthropic-compatible') {
      if (this.cfgBaseUrl === 'https://api.deepseek.com') {
        this.cfgBaseUrl = 'https://api.deepseek.com/anthropic';
      }
    }
  }

  private async createCustomSkill(): Promise<void> {
    if (!this.newSkillNameInput.trim() || !this.newSkillDescInput.trim()) {
      return;
    }
    const created = await LexiHarnessSkills.saveCustomSkill(
      this.hostContext(),
      this.newSkillNameInput,
      this.newSkillDescInput,
      this.newSkillDescInput,
      this.newSkillBodyInput || `# ${this.newSkillNameInput}\n\n${this.newSkillDescInput}`
    );
    await LexiHarnessService.reloadSkills();
    this.skills = LexiHarnessService.getSkills();
    this.selectedSkillName = created.name;
    this.showCreateSkillForm = false;
    this.newSkillNameInput = '';
    this.newSkillDescInput = '';
    this.newSkillBodyInput = '';
  }

  private filteredNotesForPicker(): NoteItem[] {
    const q = this.refFilterText.trim().toLowerCase();
    if (!q) {
      return this.availableNotes.slice(0, 12);
    }
    return this.availableNotes
      .filter((n: NoteItem): boolean => MarkdownEngine.displayTitle(n).toLowerCase().includes(q) || n.notebook.toLowerCase().includes(q))
      .slice(0, 12);
  }

  private modelBadgeLabel(): string {
    if (this.showModelPicker && this.modelPickerView === 'slider') {
      return '选择模型';
    }
    return `${this.activeModelLabel} ${this.effortStepLabel(this.activeReasoningEffort)}`;
  }

  private effortStepIndex(effort: string): number {
    if (effort === 'off') {
      return 0;
    }
    if (effort === 'low') {
      return 1;
    }
    if (effort === 'medium') {
      return 2;
    }
    if (effort === 'high') {
      return 3;
    }
    if (effort === 'max') {
      return 4;
    }
    return 2;
  }

  private effortFromStepIndex(index: number): string {
    const steps: string[] = ['off', 'low', 'medium', 'high', 'max'];
    const clamped = Math.max(0, Math.min(4, index));
    return steps[clamped];
  }

  private effortStepLabel(effort: string): string {
    if (effort === 'off') {
      return '极速';
    }
    if (effort === 'low') {
      return '轻度';
    }
    if (effort === 'medium') {
      return '中度';
    }
    if (effort === 'high') {
      return '深度';
    }
    if (effort === 'max') {
      return '超高';
    }
    return '中度';
  }

  private selectEffortStep(stepIdx: number): void {
    const nextEffort = this.effortFromStepIndex(stepIdx);
    if (nextEffort === this.activeReasoningEffort) {
      return;
    }
    try {
      this.getUIContext().animateTo({ curve: curves.springMotion(0.24, 0.9) }, (): void => {
        this.activeReasoningEffort = nextEffort;
      });
    } catch {
      this.activeReasoningEffort = nextEffort;
    }
    LexiHarnessService.setActiveReasoningEffort(nextEffort);
  }

  private providerDisplayLabel(provider: string): string {
    if (provider === 'deepseek-anthropic' || provider === 'anthropic-compatible') {
      return 'Anthropic 协议';
    }
    return 'OpenAI 协议';
  }

  private formatSessionTime(time: number): string {
    if (!time || time <= 0) {
      return '刚刚';
    }
    const date = new Date(time);
    const now = new Date();
    const hm = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    if (date.toDateString() === now.toDateString()) {
      return `今天 ${hm}`;
    }
    const yesterday = new Date(now.getTime() - 86400000);
    if (date.toDateString() === yesterday.toDateString()) {
      return `昨天 ${hm}`;
    }
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }

  @Builder
  private topHeaderBar() {
    Row({ space: 4 }) {
      // Left tabs: 聊天 / 历史 (Skill is integrated into Settings)
      Row({ space: 4 }) {
        Button('聊天', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
          .height(34)
          .fontSize(12)
          .fontWeight(this.currentTab === 'chat' ? FontWeight.Bold : FontWeight.Medium)
          .fontColor(this.currentTab === 'chat' ? $r('app.color.brand_ink') : $r('app.color.text_secondary'))
          .padding({ left: 12, right: 12 })
          .borderRadius(7)
          .backgroundColor(this.currentTab === 'chat' ? $r('app.color.workspace_selection') : Color.Transparent)
          .onClick(() => {
            this.currentTab = 'chat';
          })

        Button(`历史(${this.sessions.length})`, { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
          .height(34)
          .fontSize(12)
          .fontWeight(this.currentTab === 'sessions' ? FontWeight.Bold : FontWeight.Medium)
          .fontColor(this.currentTab === 'sessions' ? $r('app.color.brand_ink') : $r('app.color.text_secondary'))
          .padding({ left: 12, right: 12 })
          .borderRadius(7)
          .backgroundColor(this.currentTab === 'sessions' ? $r('app.color.workspace_selection') : Color.Transparent)
          .onClick(() => {
            this.currentTab = 'sessions';
          })
      }

      Blank()

      // Right action icons: + (new chat), sliders settings icon, expand/collapse, close
      Row({ space: 4 }) {
        Column() {
          LexiIcon({ name: 'plus', iconSize: 15, muted: true })
        }
        .width(34)
        .height(34)
        .borderRadius(7)
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .onClick(async () => {
          await LexiHarnessService.createNewSession();
          this.currentTab = 'chat';
        })

        Column() {
          LexiSettingsSlidersIcon({ active: this.currentTab === 'settings' })
        }
        .width(34)
        .height(34)
        .borderRadius(7)
        .backgroundColor(this.currentTab === 'settings' ? $r('app.color.workspace_selection') : Color.Transparent)
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .onClick(() => {
          this.settingsNotice = '';
          this.currentTab = this.currentTab === 'settings' ? 'chat' : 'settings';
        })

        if (!this.isDialogMode) {
          Column() {
            SymbolGlyph(this.isWidePanel ? $r('sys.symbol.chevron_right') : $r('sys.symbol.chevron_left'))
              .fontSize(14)
              .fontColor([$r('app.color.text_secondary')])
          }
          .width(34)
          .height(34)
          .borderRadius(7)
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center)
          .onClick(() => {
            this.onToggleWide();
          })
        }

        Column() {
          SymbolGlyph($r('sys.symbol.xmark'))
            .fontSize(14)
            .fontColor([$r('app.color.text_secondary')])
        }
        .width(34)
        .height(34)
        .borderRadius(7)
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .onClick(() => {
          this.onClose();
        })
      }
    }
    .width('100%')
    .height(48)
    .alignItems(VerticalAlign.Center)
    .padding({ left: 12, right: 10 })
    .backgroundColor(this.isDialogMode ? Color.Transparent : $r('app.color.surface'))
    .border({ width: { bottom: 0.5 }, color: $r('app.color.workspace_line') })
  }

  @Builder
  private sessionSubHeaderBar() {
    Row({ space: 6 }) {
      Text('会话')
        .fontSize(11)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_secondary'))

      Text(this.activeSessionTitle)
        .fontSize(11)
        .fontColor($r('app.color.text_secondary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)

      if (this.balanceText.length > 0 && this.balanceText !== '未配置密钥') {
        Row({ space: 3 }) {
          Text(this.balanceLoading ? '余额刷新中…' : `余额 ${this.balanceText}`)
            .fontSize(10)
            .fontColor($r('app.color.brand_ink'))
        }
        .padding({ left: 6, right: 6, top: 2, bottom: 2 })
        .borderRadius(5)
        .backgroundColor($r('app.color.brand_soft'))
        .onClick(() => {
          LexiHarnessService.refreshBalance();
        })
      }

      if (this.currentOpenNoteTitle.length > 0) {
        Row({ space: 4 }) {
          LexiIcon({ name: 'note', iconSize: 11 })
          Text(this.currentOpenNoteTitle)
            .fontSize(10)
            .fontColor($r('app.color.brand_ink'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .constraintSize({ maxWidth: 96 })
        }
        .padding({ left: 6, right: 6, top: 3, bottom: 3 })
        .borderRadius(6)
        .backgroundColor($r('app.color.brand_soft'))
        .onClick(() => {
          this.attachCurrentOpenNote();
        })
      }

      Column() {
        LexiIcon({ name: 'search', iconSize: 13, muted: true })
      }
      .width(24)
      .height(24)
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .onClick(() => {
        this.showRefPicker = !this.showRefPicker;
        this.showSkillPicker = false;
        this.showModelPicker = false;
      })
    }
    .width('100%')
    .height(32)
    .padding({ left: 12, right: 10 })
    .border({ width: { bottom: 0.5 }, color: $r('app.color.workspace_line') })
  }

  @Builder
  private emptyChatWelcome() {
    Column({ space: 12 }) {
      Column({ space: 6 }) {
        Row({ space: 6 }) {
          LexiIcon({ name: 'star', iconSize: 16 })
          Text('知萤 DeepSeek Harness 智能体')
            .fontSize(14)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
        }
        Text('内置 `lexinote-operator` 核心技能，支持直接读写笔记、织网 [[双向链接]]、生成思维导图与自由白板。')
          .fontSize(12)
          .lineHeight(18)
          .fontColor($r('app.color.text_secondary'))
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding(12)
      .borderRadius(10)
      .backgroundColor($r('app.color.surface'))
      .border({ width: 0.5, color: $r('app.color.workspace_line') })

      Text('快捷指令')
        .fontSize(11)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')

      Column({ space: 6 }) {
        this.quickPromptChip(
          '盘点当前知识库概况',
          '/lexinote-operator 请盘点当前知识库的笔记、文件夹与知识连接概况'
        )
        this.quickPromptChip(
          '总结当前笔记并提取待办与标签',
          '/lexinote-operator 请读取并总结当前打开的笔记，提炼核心要点、待办事项并追加到笔记末尾'
        )
        this.quickPromptChip(
          '将当前笔记一键转换为思维导图',
          '/lexinote-study-note 请将当前打开的笔记转换为结构化思维导图并打开'
        )
        this.quickPromptChip(
          '扫描未链接提及并建立 [[双向链接]]',
          '/lexinote-knowledge-graph 请扫描当前知识库中的孤立笔记与未链接提及，自动建立双向链接'
        )
        this.quickPromptChip(
          '根据最近核心笔记生成自由白板',
          '/lexinote-knowledge-graph 请根据知识库中的核心笔记创建一张知识梳理自由白板并打开'
        )
      }
      .width('100%')
    }
    .width('100%')
    .padding({ top: 6, bottom: 10 })
  }

  @Builder
  private quickPromptChip(label: string, promptText: string) {
    Row({ space: 8 }) {
      LexiIcon({ name: 'star', iconSize: 13, muted: true })
      Text(label)
        .fontSize(12)
        .fontColor($r('app.color.text_primary'))
        .layoutWeight(1)
      LexiIcon({ name: 'chevron', iconSize: 12, muted: true })
    }
    .width('100%')
    .padding({ left: 10, right: 10, top: 9, bottom: 9 })
    .borderRadius(8)
    .backgroundColor($r('app.color.surface'))
    .border({ width: 0.5, color: $r('app.color.workspace_line') })
    .onClick(() => {
      this.submitMessage(promptText);
    })
  }

  @Builder
  private renderUiItem(item: LexiHarnessUiItem) {
    if (item.itemKind === 'user') {
      Column({ space: 6 }) {
        if (item.refs.length > 0) {
          Flex({ wrap: FlexWrap.Wrap }) {
            ForEach(item.refs, (ref: LexiHarnessNoteRef, idx: number) => {
              Row({ space: 4 }) {
                LexiIcon({ name: ref.kind === 'folder' ? 'folder' : 'note', iconSize: 11 })
                Text(ref.title)
                  .fontSize(10)
                  .fontColor($r('app.color.brand_ink'))
              }
              .padding({ left: 6, right: 6, top: 2, bottom: 2 })
              .margin({ right: 4, bottom: 4 })
              .borderRadius(6)
              .backgroundColor($r('app.color.brand_soft'))
            }, (ref: LexiHarnessNoteRef, idx: number): string => `${item.id}_ref_${ref.id}_${idx}`)
          }
        }
        Text(item.text)
          .fontSize(13)
          .lineHeight(20)
          .fontColor($r('app.color.text_primary'))
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding(12)
      .borderRadius(14)
      .backgroundColor($r('app.color.surface'))
    } else if (item.itemKind === 'skill') {
      Row({ space: 6 }) {
        LexiIcon({ name: 'star', iconSize: 12 })
        Text(`已挂载技能 · ${item.skillName}`)
          .fontSize(11)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.brand_ink'))
      }
      .padding({ left: 10, right: 10, top: 5, bottom: 5 })
      .borderRadius(8)
      .backgroundColor($r('app.color.brand_soft'))
    } else if (item.itemKind === 'tool') {
      this.renderToolRowCard(item.id, item.toolRow)
    } else if (item.itemKind === 'assistant') {
      Column({ space: 8 }) {
        if (item.reasoning.length > 0) {
          Column({ space: 6 }) {
            Row({ space: 6 }) {
              Circle({ width: 6, height: 6 })
                .fill(item.streaming ? '#8B5CF6' : '#9CA3AF')
              Text(item.streaming ? '深度思考中…' : '深度思考过程')
                .fontSize(11)
                .fontWeight(FontWeight.Medium)
                .fontColor($r('app.color.text_secondary'))
                .layoutWeight(1)
              Text(this.isReasoningCollapsed(item.id) ? '展开' : '收起')
                .fontSize(10)
                .fontColor($r('app.color.brand_ink'))
                .padding({ left: 6, right: 6, top: 2, bottom: 2 })
                .borderRadius(6)
                .backgroundColor($r('app.color.soft_surface'))
            }
            .width('100%')
            .alignItems(VerticalAlign.Center)
            .onClick(() => {
              this.toggleReasoningCollapse(item.id);
            })

            if (!this.isReasoningCollapsed(item.id)) {
              Text(item.reasoning)
                .fontSize(11)
                .lineHeight(17)
                .fontColor($r('app.color.text_secondary'))
                .width('100%')
                .padding({ top: 4 })
            }
          }
          .width('100%')
          .padding({ left: 12, right: 12, top: 9, bottom: 9 })
          .borderRadius(12)
          .backgroundColor($r('app.color.surface'))
        }

        if (item.text.length > 0) {
          Column({ space: 10 }) {
            LexiHarnessMarkdownView({
              content: item.text,
              itemKey: item.id,
              onOpenTarget: (target: string): void => {
                this.openNoteByTarget(target);
              }
            })

            if (!item.streaming && item.text.trim().length > 0) {
              Row({ space: 8 }) {
                Button('插入当前笔记', { type: ButtonType.Normal })
                  .height(30)
                  .fontSize(11)
                  .fontWeight(FontWeight.Medium)
                  .padding({ left: 10, right: 10 })
                  .borderRadius(8)
                  .backgroundColor($r('app.color.brand_soft'))
                  .fontColor($r('app.color.brand'))
                  .onClick(async () => {
                    this.onInsertToEditor(item.text);
                    const openId = this.activeNoteIdProp || LexiHarnessService.getActiveEditorNoteId();
                    if (openId) {
                      const vaultId = await LexiStorageService.getActiveVaultId();
                      const notes = await LexiStorageService.getNotes(vaultId);
                      const note = notes.find((n: NoteItem): boolean => n.id === openId);
                      if (note) {
                        note.content = `${note.content.trimEnd()}\n\n${item.text}`;
                        await LexiStorageService.saveNote(this.hostContext(), note);
                        const rev = AppStorage.get<number>('lexiWorkspaceRevision') ?? 0;
                        AppStorage.setOrCreate('lexiWorkspaceRevision', rev + 1);
                      }
                    }
                  })

                Button('存为新笔记', { type: ButtonType.Normal })
                  .height(30)
                  .fontSize(11)
                  .padding({ left: 10, right: 10 })
                  .borderRadius(8)
                  .backgroundColor($r('app.color.soft_surface'))
                  .fontColor($r('app.color.text_primary'))
                  .onClick(async () => {
                    const firstLine = item.text.split('\n')[0].replace(/^#+\s*/, '').trim().slice(0, 28) || 'AI 笔记';
                    this.onCreateNoteFromReply(firstLine, item.text);
                    const vaultId = await LexiStorageService.getActiveVaultId();
                    const projectId = await LexiStorageService.getActiveProjectId(vaultId);
                    const newNote = new NoteItem();
                    newNote.id = `note-${Date.now()}`;
                    newNote.vaultId = vaultId;
                    newNote.projectId = projectId;
                    newNote.title = firstLine;
                    newNote.notebook = '学习笔记';
                    newNote.noteType = 'study';
                    newNote.editorLevel = 'pro';
                    newNote.tags = ['AI生成'];
                    newNote.content = item.text.startsWith('#') ? item.text : `# ${firstLine}\n\n${item.text}`;
                    await LexiStorageService.saveNote(this.hostContext(), newNote);
                    const rev = AppStorage.get<number>('lexiWorkspaceRevision') ?? 0;
                    AppStorage.setOrCreate('lexiWorkspaceRevision', rev + 1);
                  })
              }
              .width('100%')
            }
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
          .padding(12)
          .borderRadius(14)
          .backgroundColor($r('app.color.surface'))
        }
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  @Builder
  private renderToolRowCard(itemId: string, tool: LexiHarnessUiToolRow) {
    Column({ space: 6 }) {
      Row({ space: 8 }) {
        Circle({ width: 7, height: 7 })
          .fill(
            tool.status === 'running'
              ? '#F59E0B'
              : (tool.status === 'error' ? '#EF4444' : '#10B981')
          )

        Text() {
          Span(tool.title)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
          if (tool.subtitle.length > 0) {
            Span(`  ${tool.subtitle}`)
              .fontWeight(FontWeight.Regular)
              .fontColor($r('app.color.text_secondary'))
          }
        }
        .fontSize(11)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)

        Text(this.isToolExpanded(itemId) ? '收起' : '详情')
          .fontSize(10)
          .fontColor($r('app.color.brand_ink'))
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .borderRadius(6)
          .backgroundColor($r('app.color.soft_surface'))
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.toggleToolExpand(itemId);
      })

      if (this.isToolExpanded(itemId)) {
        Column({ space: 4 }) {
          Text(`调用参数: ${tool.argsJson}`)
            .fontSize(10)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
          if (tool.outputPreview.length > 0) {
            Text(tool.outputPreview)
              .fontSize(11)
              .lineHeight(16)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
          }
        }
        .width('100%')
        .padding({ top: 6 })
        .border({ width: { top: 0.5 }, color: $r('app.color.workspace_line') })
      }
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 9, bottom: 9 })
    .borderRadius(12)
    .backgroundColor($r('app.color.surface'))
  }

  @Builder
  private todoProgressStrip() {
    if (this.todos.length > 0) {
      Column({ space: 6 }) {
        Row({ space: 6 }) {
          Text('✓')
            .fontSize(11)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.brand'))
          Text(`任务进度 (${this.todos.filter((t: LexiHarnessTodoItem): boolean => t.status === 'completed').length}/${this.todos.length})`)
            .fontSize(11)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
        }
        ForEach(this.todos.slice(0, 4), (todo: LexiHarnessTodoItem, idx: number) => {
          Row({ space: 6 }) {
            Text(todo.status === 'completed' ? '✓' : (todo.status === 'in_progress' ? '▶' : '○'))
              .fontSize(10)
              .fontColor(todo.status === 'completed' ? '#10B981' : $r('app.color.brand'))
            Text(todo.content)
              .fontSize(11)
              .fontColor($r('app.color.text_secondary'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .layoutWeight(1)
          }
          .width('100%')
        }, (todo: LexiHarnessTodoItem, idx: number): string => `todo_${todo.id}_${idx}`)
      }
      .width('100%')
      .padding(12)
      .borderRadius(14)
      .backgroundColor($r('app.color.surface'))
    }
  }

  @Builder
  private chatTabBody() {
    Column({ space: 0 }) {
      this.sessionSubHeaderBar()

      Scroll(this.chatScroller) {
        Column({ space: 10 }) {
          if (this.uiItems.length === 0) {
            this.emptyChatWelcome()
          } else {
            ForEach(this.uiItems, (item: LexiHarnessUiItem) => {
              this.renderUiItem(item)
            }, (item: LexiHarnessUiItem): string => item.id)
          }
          this.todoProgressStrip()
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding({ left: 12, right: 12, top: 10, bottom: 14 })
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
    }
    .layoutWeight(1)
    .width('100%')
  }

  /**
   * History list view designed to match LexiNoteCard & LexiSettingsTab card style
   */
  @Builder
  private sessionsTabBody() {
    Scroll() {
      Column({ space: 12 }) {
        Row() {
          Column({ space: 2 }) {
            Text('历史会话')
              .fontSize(15)
              .fontWeight(FontWeight.Bold)
              .fontColor($r('app.color.text_primary'))
            Text(`共 ${this.sessions.length} 条会话记录`)
              .fontSize(11)
              .fontColor($r('app.color.text_secondary'))
          }
          .alignItems(HorizontalAlign.Start)

          Blank()

          Button('+ 新建会话', { type: ButtonType.Normal })
            .height(34)
            .fontSize(12)
            .fontWeight(FontWeight.Medium)
            .padding({ left: 12, right: 12 })
            .borderRadius(12)
            .backgroundColor($r('app.color.brand'))
            .fontColor($r('app.color.inverse_text'))
            .onClick(async () => {
              await LexiHarnessService.createNewSession();
              this.currentTab = 'chat';
            })
        }
        .width('100%')

        ForEach(this.sessions, (sess: LexiHarnessSessionRecord) => {
          Column({ space: 10 }) {
            Row({ space: 6 }) {
              LexiIcon({ name: 'note', iconSize: 15, muted: sess.id !== this.activeSessionId })
              Text(sess.id === this.activeSessionId ? '当前会话' : '历史对话')
                .fontSize(11)
                .fontWeight(FontWeight.Medium)
                .fontColor(sess.id === this.activeSessionId ? $r('app.color.brand') : $r('app.color.text_secondary'))
                .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                .backgroundColor(sess.id === this.activeSessionId ? $r('app.color.brand_soft') : $r('app.color.soft_surface'))
                .borderRadius(8)

              Blank()

              Text(this.formatSessionTime(sess.updatedAt))
                .fontSize(11)
                .fontColor($r('app.color.text_secondary'))
            }
            .width('100%')

            Text(sess.title || '新会话')
              .fontSize(15)
              .fontWeight(FontWeight.Bold)
              .fontColor($r('app.color.text_primary'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')

            Row({ space: 6 }) {
              Text(`${sess.events.length} 条事件记录`)
                .fontSize(11)
                .fontColor($r('app.color.brand_ink'))
                .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                .backgroundColor($r('app.color.soft_surface'))
                .borderRadius(7)

              Blank()

              Button(sess.id === this.activeSessionId ? '继续对话' : '打开会话', { type: ButtonType.Normal })
                .height(30)
                .fontSize(11)
                .fontWeight(FontWeight.Medium)
                .padding({ left: 10, right: 10 })
                .borderRadius(9)
                .backgroundColor($r('app.color.brand_soft'))
                .fontColor($r('app.color.brand'))
                .onClick(async () => {
                  await LexiHarnessService.switchSession(sess.id);
                  this.currentTab = 'chat';
                })

              Button('删除', { type: ButtonType.Normal })
                .height(30)
                .fontSize(11)
                .padding({ left: 10, right: 10 })
                .borderRadius(9)
                .backgroundColor($r('app.color.soft_surface'))
                .fontColor($r('app.color.error'))
                .onClick(async () => {
                  await LexiHarnessService.deleteSession(sess.id);
                })
            }
            .width('100%')
          }
          .width('100%')
          .padding(14)
          .backgroundColor($r('app.color.surface'))
          .borderRadius(18)
          .alignItems(HorizontalAlign.Start)
          .onClick(async () => {
            await LexiHarnessService.switchSession(sess.id);
            this.currentTab = 'chat';
          })
        }, (sess: LexiHarnessSessionRecord): string => `${sess.id}-${sess.updatedAt}-${sess.events.length}`)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding(12)
    }
    .layoutWeight(1)
    .width('100%')
    .align(Alignment.Top)
    .scrollBar(BarState.Off)
  }

  /**
   * Skills library inside Settings designed with LexiNoteCard / LexiSettingsTab card language
   */
  @Builder
  private settingsSkillsSection() {
    Column({ space: 12 }) {
      Row() {
        Column({ space: 2 }) {
          Text('知萤 Skill 技能库')
            .fontSize(15)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
          Text('支持 `/skill-name` 挂载或由大模型按需加载')
            .fontSize(11)
            .fontColor($r('app.color.text_secondary'))
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        Button(this.showCreateSkillForm ? '收起' : '+ 新建 Skill', { type: ButtonType.Normal })
          .height(34)
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .padding({ left: 12, right: 12 })
          .borderRadius(12)
          .backgroundColor(this.showCreateSkillForm ? $r('app.color.soft_surface') : $r('app.color.brand_soft'))
          .fontColor(this.showCreateSkillForm ? $r('app.color.text_primary') : $r('app.color.brand'))
          .onClick(() => {
            this.showCreateSkillForm = !this.showCreateSkillForm;
          })
      }
      .width('100%')

      if (this.showCreateSkillForm) {
        Column({ space: 10 }) {
          Text('创建自定义知萤 Skill')
            .fontSize(14)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
          TextInput({ text: this.newSkillNameInput, placeholder: '技能标识 (如 lexinote-weekly-review)' })
            .height(38)
            .fontSize(12)
            .borderRadius(10)
            .backgroundColor($r('app.color.soft_surface'))
            .onChange((v: string) => {
              this.newSkillNameInput = v;
            })
          TextInput({ text: this.newSkillDescInput, placeholder: '触发条件与用途描述 (注入 <available_skills>)' })
            .height(38)
            .fontSize(12)
            .borderRadius(10)
            .backgroundColor($r('app.color.soft_surface'))
            .onChange((v: string) => {
              this.newSkillDescInput = v;
            })
          TextArea({ text: this.newSkillBodyInput, placeholder: '输入 SKILL.md 详细操作规范与工作流…' })
            .height(96)
            .fontSize(12)
            .borderRadius(10)
            .backgroundColor($r('app.color.soft_surface'))
            .onChange((v: string) => {
              this.newSkillBodyInput = v;
            })
          Button('保存并注册 Skill', { type: ButtonType.Normal })
            .width('100%')
            .height(40)
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .borderRadius(12)
            .backgroundColor($r('app.color.brand'))
            .fontColor($r('app.color.inverse_text'))
            .onClick(() => {
              this.createCustomSkill();
            })
        }
        .width('100%')
        .padding(16)
        .borderRadius(18)
        .backgroundColor($r('app.color.surface'))
        .alignItems(HorizontalAlign.Start)
      }

      ForEach(this.skills, (sk: LexiHarnessSkillDefinition) => {
        Column({ space: 10 }) {
          Row({ space: 6 }) {
            LexiIcon({ name: 'markdown', iconSize: 15 })
            Text(sk.sourceLabel)
              .fontSize(11)
              .fontWeight(FontWeight.Medium)
              .fontColor($r('app.color.brand'))
              .padding({ left: 8, right: 8, top: 3, bottom: 3 })
              .backgroundColor($r('app.color.brand_soft'))
              .borderRadius(8)

            Blank()

            Button('调用技能', { type: ButtonType.Normal })
              .height(28)
              .fontSize(11)
              .fontWeight(FontWeight.Medium)
              .padding({ left: 10, right: 10 })
              .borderRadius(8)
              .backgroundColor($r('app.color.brand_soft'))
              .fontColor($r('app.color.brand'))
              .onClick(() => {
                this.insertSkillSlash(sk.name);
              })
          }
          .width('100%')

          Text(sk.name)
            .fontSize(15)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
            .width('100%')

          Text(sk.description)
            .fontSize(12)
            .lineHeight(19)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')

          if (this.selectedSkillName === sk.name) {
            Column({ space: 6 }) {
              Text(`路径: ${sk.baseDir}`)
                .fontSize(10)
                .fontColor($r('app.color.text_secondary'))
              Text(sk.content)
                .fontSize(11)
                .lineHeight(17)
                .fontColor($r('app.color.text_secondary'))
                .width('100%')
            }
            .width('100%')
            .padding(10)
            .borderRadius(12)
            .backgroundColor($r('app.color.soft_surface'))
            .alignItems(HorizontalAlign.Start)
          }
        }
        .width('100%')
        .padding(16)
        .borderRadius(18)
        .backgroundColor($r('app.color.surface'))
        .alignItems(HorizontalAlign.Start)
        .onClick(() => {
          this.selectedSkillName = this.selectedSkillName === sk.name ? '' : sk.name;
        })
      }, (sk: LexiHarnessSkillDefinition): string => `skill_${sk.name}`)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /**
   * Models & Balance management section designed with LexiNoteCard / LexiSettingsTab card language
   */
  @Builder
  private settingsModelsSection() {
    Column({ space: 12 }) {
      // Balance Card (matching LexiHomeMetric & LexiSettingsTab)
      Row({ space: 10 }) {
        Column({ space: 4 }) {
          Text('API 账户可用余额')
            .fontSize(12)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_secondary'))
          Text(this.balanceLoading ? '查询中…' : (this.balanceText || '未查询'))
            .fontSize(20)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.brand'))
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        Button(this.balanceLoading ? '刷新中…' : '刷新余额', { type: ButtonType.Normal })
          .height(36)
          .padding({ left: 14, right: 14 })
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .borderRadius(12)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.brand'))
          .onClick(() => {
            LexiHarnessService.refreshBalance();
          })
      }
      .width('100%')
      .padding(16)
      .borderRadius(18)
      .backgroundColor($r('app.color.surface'))

      // Model List Header
      Row() {
        Column({ space: 2 }) {
          Text('多模型管理')
            .fontSize(15)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
          Text('可在聊天框右下角一键快速切换已配置的模型')
            .fontSize(11)
            .fontColor($r('app.color.text_secondary'))
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        Button(this.showModelForm ? '收起表单' : '+ 添加模型', { type: ButtonType.Normal })
          .height(34)
          .padding({ left: 12, right: 12 })
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .borderRadius(12)
          .backgroundColor(this.showModelForm ? $r('app.color.soft_surface') : $r('app.color.brand'))
          .fontColor(this.showModelForm ? $r('app.color.text_primary') : $r('app.color.inverse_text'))
          .onClick(() => {
            if (this.showModelForm) {
              this.showModelForm = false;
            } else {
              this.openAddModelForm();
            }
          })
      }
      .width('100%')

      if (this.settingsNotice.length > 0) {
        Text(this.settingsNotice)
          .fontSize(12)
          .fontColor($r('app.color.brand'))
          .padding(10)
          .width('100%')
          .backgroundColor($r('app.color.brand_soft'))
          .borderRadius(12)
      }

      // Add / Edit Model Form Card
      if (this.showModelForm) {
        Column({ space: 12 }) {
          Text(this.editingProfileId ? '编辑模型配置' : '新增模型配置')
            .fontSize(14)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
            .width('100%')

          Column({ space: 6 }) {
            Text('协议类型')
              .fontSize(11)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
            Flex({ wrap: FlexWrap.Wrap }) {
              this.providerOptionChip('deepseek-openai', 'DeepSeek (OpenAI)')
              this.providerOptionChip('deepseek-anthropic', 'DeepSeek (Anthropic)')
              this.providerOptionChip('openai-compatible', 'OpenAI 兼容')
              this.providerOptionChip('anthropic-compatible', 'Anthropic 兼容')
            }
          }
          .width('100%')

          Column({ space: 6 }) {
            Text('模型名称 (Model ID)')
              .fontSize(11)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
            TextInput({ text: this.cfgModel, placeholder: '如 deepseek-chat / deepseek-reasoner / deepseek-flash' })
              .height(38)
              .fontSize(12)
              .borderRadius(10)
              .backgroundColor($r('app.color.soft_surface'))
              .onChange((v: string) => {
                this.cfgModel = v;
              })
            Row({ space: 6 }) {
              this.modelPresetChip('deepseek-chat')
              this.modelPresetChip('deepseek-reasoner')
              this.modelPresetChip('deepseek-flash')
            }
            .width('100%')
          }
          .width('100%')

          Column({ space: 6 }) {
            Text('显示别名 (选填)')
              .fontSize(11)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
            TextInput({ text: this.cfgLabel, placeholder: '留空则默认使用模型 ID' })
              .height(38)
              .fontSize(12)
              .borderRadius(10)
              .backgroundColor($r('app.color.soft_surface'))
              .onChange((v: string) => {
                this.cfgLabel = v;
              })
          }
          .width('100%')

          Column({ space: 6 }) {
            Text('API Base URL')
              .fontSize(11)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
            TextInput({ text: this.cfgBaseUrl, placeholder: 'https://api.deepseek.com' })
              .height(38)
              .fontSize(12)
              .borderRadius(10)
              .backgroundColor($r('app.color.soft_surface'))
              .onChange((v: string) => {
                this.cfgBaseUrl = v;
              })
          }
          .width('100%')

          Column({ space: 6 }) {
            Text('API Key')
              .fontSize(11)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
            TextInput({ text: this.cfgApiKey, placeholder: '输入 sk-... 密钥' })
              .height(38)
              .fontSize(12)
              .type(InputType.Password)
              .borderRadius(10)
              .backgroundColor($r('app.color.soft_surface'))
              .onChange((v: string) => {
                this.cfgApiKey = v;
              })
          }
          .width('100%')

          Column({ space: 6 }) {
            Row() {
              Text('推理强度 (Reasoning Effort)')
                .fontSize(11)
                .fontColor($r('app.color.text_secondary'))
                .layoutWeight(1)
              Text(this.effortStepLabel(this.cfgEffort))
                .fontSize(11)
                .fontWeight(FontWeight.Medium)
                .fontColor($r('app.color.brand'))
            }
            .width('100%')
            Row({ space: 6 }) {
              this.effortChip('off', '极速')
              this.effortChip('low', '轻度')
              this.effortChip('medium', '中度')
              this.effortChip('high', '深度')
              this.effortChip('max', '超高')
            }
            .width('100%')
          }
          .width('100%')

          Button('保存并启用该模型', { type: ButtonType.Normal })
            .width('100%')
            .height(40)
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .borderRadius(12)
            .backgroundColor($r('app.color.brand'))
            .fontColor($r('app.color.inverse_text'))
            .onClick(async () => {
              await this.saveModelProfileForm();
            })
        }
        .width('100%')
        .padding(16)
        .borderRadius(18)
        .backgroundColor($r('app.color.surface'))
        .alignItems(HorizontalAlign.Start)
      }

      // Configured Models List (LexiNoteCard style)
      ForEach(this.modelProfiles, (prof: LexiHarnessModelProfile) => {
        Column({ space: 10 }) {
          Row({ space: 6 }) {
            LexiIcon({ name: 'note', iconSize: 15, muted: prof.id !== this.activeModelId })

            Text(this.providerDisplayLabel(prof.provider))
              .fontSize(11)
              .fontWeight(FontWeight.Medium)
              .fontColor($r('app.color.brand'))
              .padding({ left: 8, right: 8, top: 3, bottom: 3 })
              .backgroundColor($r('app.color.brand_soft'))
              .borderRadius(8)

            Text(prof.apiKey.trim().length > 0 ? '已配置密钥' : '未配置密钥')
              .fontSize(11)
              .fontColor(prof.apiKey.trim().length > 0 ? $r('app.color.brand_ink') : $r('app.color.text_secondary'))
              .padding({ left: 8, right: 8, top: 3, bottom: 3 })
              .backgroundColor($r('app.color.soft_surface'))
              .borderRadius(8)

            Blank()

            if (prof.id === this.activeModelId) {
              Text('当前使用')
                .fontSize(11)
                .fontWeight(FontWeight.Medium)
                .fontColor($r('app.color.inverse_text'))
                .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                .backgroundColor($r('app.color.brand'))
                .borderRadius(8)
            }
          }
          .width('100%')

          Text(prof.label || prof.model)
            .fontSize(16)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')

          Text(`模型标识：${prof.model} · 推理强度：${this.effortStepLabel(prof.reasoningEffort)}`)
            .fontSize(12)
            .fontColor($r('app.color.text_secondary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')

          // Unified 5-step Reasoning Effort selector synced with chat dialog slider
          Row({ space: 4 }) {
            ForEach(['off', 'low', 'medium', 'high', 'max'], (stepKey: string) => {
              Button(this.effortStepLabel(stepKey), { type: ButtonType.Normal })
                .layoutWeight(1)
                .height(28)
                .padding(0)
                .fontSize(11)
                .fontWeight(prof.reasoningEffort === stepKey ? FontWeight.Bold : FontWeight.Regular)
                .borderRadius(8)
                .fontColor(prof.reasoningEffort === stepKey ? $r('app.color.brand') : $r('app.color.text_secondary'))
                .backgroundColor(prof.reasoningEffort === stepKey ? $r('app.color.brand_soft') : Color.Transparent)
                .onClick(async () => {
                  await LexiHarnessService.setModelProfileReasoningEffort(prof.id, stepKey);
                })
            }, (stepKey: string): string => `card_effort_${prof.id}_${stepKey}`)
          }
          .width('100%')
          .padding(3)
          .borderRadius(10)
          .backgroundColor($r('app.color.soft_surface'))

          Row({ space: 8 }) {
            Button(prof.id === this.activeModelId ? '正在使用' : '切换使用', { type: ButtonType.Normal })
              .layoutWeight(1)
              .height(34)
              .fontSize(12)
              .fontWeight(FontWeight.Medium)
              .borderRadius(10)
              .backgroundColor(prof.id === this.activeModelId ? $r('app.color.brand_soft') : $r('app.color.brand'))
              .fontColor(prof.id === this.activeModelId ? $r('app.color.brand') : $r('app.color.inverse_text'))
              .onClick(async () => {
                if (prof.id !== this.activeModelId) {
                  await LexiHarnessService.selectModelProfile(prof.id);
                }
              })

            Button('编辑', { type: ButtonType.Normal })
              .height(34)
              .padding({ left: 12, right: 12 })
              .fontSize(12)
              .borderRadius(10)
              .backgroundColor($r('app.color.soft_surface'))
              .fontColor($r('app.color.text_primary'))
              .onClick(() => {
                this.openEditModelForm(prof);
              })

            if (this.modelProfiles.length > 1) {
              Button('删除', { type: ButtonType.Normal })
                .height(34)
                .padding({ left: 12, right: 12 })
                .fontSize(12)
                .borderRadius(10)
                .backgroundColor($r('app.color.soft_surface'))
                .fontColor($r('app.color.error'))
                .onClick(async () => {
                  await LexiHarnessService.deleteModelProfile(prof.id);
                })
            }
          }
          .width('100%')
        }
        .width('100%')
        .padding(16)
        .borderRadius(18)
        .backgroundColor($r('app.color.surface'))
        .alignItems(HorizontalAlign.Start)
      }, (prof: LexiHarnessModelProfile): string => `${prof.id}-${prof.model}-${prof.reasoningEffort}-${prof.apiKey.length}-${prof.id === this.activeModelId ? '1' : '0'}`)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  private settingsTabBody() {
    Column({ space: 0 }) {
      // Full-width segmented bar inside Settings aligned flush with cards below
      Column() {
        Row({ space: 4 }) {
          Button('模型与 API', { type: ButtonType.Normal })
            .layoutWeight(1)
            .height(34)
            .fontSize(12)
            .fontWeight(this.settingsSubTab === 'models' ? FontWeight.Bold : FontWeight.Medium)
            .borderRadius(11)
            .fontColor(this.settingsSubTab === 'models' ? $r('app.color.brand') : $r('app.color.text_secondary'))
            .backgroundColor(this.settingsSubTab === 'models' ? $r('app.color.brand_soft') : Color.Transparent)
            .onClick((): void => {
              this.settingsSubTab = 'models';
            })

          Button(`Skill 技能库 (${this.skills.length})`, { type: ButtonType.Normal })
            .layoutWeight(1)
            .height(34)
            .fontSize(12)
            .fontWeight(this.settingsSubTab === 'skills' ? FontWeight.Bold : FontWeight.Medium)
            .borderRadius(11)
            .fontColor(this.settingsSubTab === 'skills' ? $r('app.color.brand') : $r('app.color.text_secondary'))
            .backgroundColor(this.settingsSubTab === 'skills' ? $r('app.color.brand_soft') : Color.Transparent)
            .onClick((): void => {
              this.settingsSubTab = 'skills';
            })
        }
        .width('100%')
        .padding(4)
        .backgroundColor($r('app.color.surface'))
        .borderRadius(14)
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 10, bottom: 2 })

      Scroll() {
        Column({ space: 12 }) {
          if (this.settingsSubTab === 'models') {
            this.settingsModelsSection()
          } else {
            this.settingsSkillsSection()
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding(12)
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
    }
    .layoutWeight(1)
    .width('100%')
  }

  @Builder
  private providerOptionChip(value: string, label: string) {
    Text(label)
      .fontSize(11)
      .fontColor(this.cfgProvider === value ? $r('app.color.brand_ink') : $r('app.color.text_secondary'))
      .fontWeight(this.cfgProvider === value ? FontWeight.Bold : FontWeight.Normal)
      .padding({ left: 8, right: 8, top: 5, bottom: 5 })
      .margin({ right: 6, bottom: 6 })
      .borderRadius(6)
      .backgroundColor(this.cfgProvider === value ? $r('app.color.workspace_selection') : $r('app.color.workspace_page'))
      .border({
        width: 0.5,
        color: this.cfgProvider === value ? $r('app.color.brand') : $r('app.color.workspace_line')
      })
      .onClick(() => {
        this.selectProviderPreset(value);
      })
  }

  @Builder
  private modelPresetChip(modelName: string) {
    Text(modelName)
      .fontSize(10)
      .fontColor(this.cfgModel === modelName ? $r('app.color.brand_ink') : $r('app.color.text_secondary'))
      .padding({ left: 7, right: 7, top: 4, bottom: 4 })
      .borderRadius(5)
      .backgroundColor(this.cfgModel === modelName ? $r('app.color.workspace_selection') : $r('app.color.workspace_page'))
      .onClick(() => {
        this.cfgModel = modelName;
      })
  }

  @Builder
  private effortChip(effort: string, label: string) {
    Text(label)
      .fontSize(11)
      .fontColor(this.cfgEffort === effort ? $r('app.color.brand_ink') : $r('app.color.text_secondary'))
      .padding({ left: 8, right: 8, top: 5, bottom: 5 })
      .borderRadius(6)
      .backgroundColor(this.cfgEffort === effort ? $r('app.color.workspace_selection') : $r('app.color.workspace_page'))
      .onClick(() => {
        this.cfgEffort = effort;
      })
  }

  /**
   * Redesigned # Reference Picker matching LexiDesktopWorkspace's search & list style
   */
  @Builder
  private referencePickerOverlay() {
    Column({ space: 8 }) {
      Row({ space: 6 }) {
        LexiIcon({ name: 'link', iconSize: 13 })
        Text('引用笔记或文件夹 (#)')
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
        Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
          SymbolGlyph($r('sys.symbol.xmark')).fontSize(11).fontColor([$r('app.color.text_secondary')])
        }
        .width(24)
        .height(24)
        .padding(0)
        .backgroundColor(Color.Transparent)
        .onClick(() => {
          this.showRefPicker = false;
        })
      }
      .width('100%')

      // Search input styled identically to LexiDesktopWorkspace's workspace-search
      Row({ space: 6 }) {
        LexiIcon({ name: 'search', iconSize: 14, muted: true })
        TextInput({ text: this.refFilterText, placeholder: '搜索笔记标题或文件夹…' })
          .layoutWeight(1)
          .height(32)
          .padding(0)
          .fontSize(12)
          .placeholderFont({ size: 12 })
          .fontColor($r('app.color.text_primary'))
          .placeholderColor($r('app.color.text_secondary'))
          .caretColor($r('app.color.brand'))
          .backgroundColor(Color.Transparent)
          .onChange((v: string) => {
            this.refFilterText = v;
          })
        if (this.refFilterText.length > 0) {
          Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
            SymbolGlyph($r('sys.symbol.xmark')).fontSize(10).fontColor([$r('app.color.text_secondary')])
          }
          .width(24)
          .height(28)
          .padding(0)
          .backgroundColor(Color.Transparent)
          .onClick(() => {
            this.refFilterText = '';
          })
        }
      }
      .width('100%')
      .padding({ left: 10, right: 8 })
      .borderRadius(7)
      .backgroundColor($r('app.color.workspace_page'))
      .border({ width: 0.5, color: $r('app.color.workspace_line') })

      Scroll() {
        Column({ space: 4 }) {
          if (this.availableFolders.length > 0) {
            Flex({ wrap: FlexWrap.Wrap }) {
              ForEach(this.availableFolders, (folder: string) => {
                Row({ space: 4 }) {
                  LexiIcon({ name: 'folder', iconSize: 12 })
                  Text(folder)
                    .fontSize(11)
                    .fontColor($r('app.color.text_primary'))
                }
                .padding({ left: 8, right: 8, top: 4, bottom: 4 })
                .margin({ right: 6, bottom: 6 })
                .borderRadius(6)
                .backgroundColor($r('app.color.workspace_page'))
                .border({ width: 0.5, color: $r('app.color.workspace_line') })
                .onClick(() => {
                  this.attachFolderReference(folder);
                })
              }, (folder: string): string => `folder_ref_${folder}`)
            }
          }

          if (this.filteredNotesForPicker().length === 0) {
            Text(this.availableNotes.length === 0 ? '当前工作区暂无笔记，可直接让 AI 为你新建笔记' : '没有找到匹配的笔记')
              .fontSize(11)
              .fontColor($r('app.color.text_secondary'))
              .padding({ top: 6, bottom: 6 })
              .width('100%')
          } else {
            ForEach(this.filteredNotesForPicker(), (note: NoteItem) => {
              Row({ space: 8 }) {
                LexiIcon({ name: note.noteType === 'study' ? 'study' : 'note', iconSize: 14 })
                Text(MarkdownEngine.displayTitle(note))
                  .fontSize(12)
                  .fontColor($r('app.color.text_primary'))
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .layoutWeight(1)
                Text(note.notebook)
                  .fontSize(10)
                  .fontColor($r('app.color.text_secondary'))
              }
              .width('100%')
              .height(34)
              .padding({ left: 8, right: 8 })
              .borderRadius(6)
              .backgroundColor($r('app.color.workspace_page'))
              .onClick(() => {
                this.attachNoteReference(note);
              })
            }, (note: NoteItem): string => `note_ref_${note.id}`)
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }
      .constraintSize({ maxHeight: 160 })
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .padding(10)
    .borderRadius(10)
    .backgroundColor($r('app.color.surface'))
    .border({ width: 0.5, color: $r('app.color.workspace_line') })
  }

  @Builder
  private skillPickerOverlay() {
    Column({ space: 6 }) {
      Row({ space: 6 }) {
        LexiIcon({ name: 'tag', iconSize: 13 })
        Text('挂载知萤 Skill (/)')
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
        Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
          SymbolGlyph($r('sys.symbol.xmark')).fontSize(11).fontColor([$r('app.color.text_secondary')])
        }
        .width(24)
        .height(24)
        .padding(0)
        .backgroundColor(Color.Transparent)
        .onClick(() => {
          this.showSkillPicker = false;
        })
      }
      .width('100%')

      ForEach(this.skills, (sk: LexiHarnessSkillDefinition) => {
        Row({ space: 8 }) {
          LexiIcon({ name: 'star', iconSize: 13 })
          Column({ space: 2 }) {
            Text(`/${sk.name}`)
              .fontSize(12)
              .fontWeight(FontWeight.Bold)
              .fontColor($r('app.color.text_primary'))
            Text(sk.description)
              .fontSize(10)
              .fontColor($r('app.color.text_secondary'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start)
        }
        .width('100%')
        .padding(7)
        .borderRadius(6)
        .backgroundColor($r('app.color.workspace_page'))
        .onClick(() => {
          this.insertSkillSlash(sk.name);
        })
      }, (sk: LexiHarnessSkillDefinition): string => `picker_sk_${sk.name}`)
    }
    .width('100%')
    .padding(10)
    .borderRadius(10)
    .backgroundColor($r('app.color.surface'))
    .border({ width: 0.5, color: $r('app.color.workspace_line') })
  }

  /**
   * Two-stage compact Model & Reasoning Effort floating popover (Slider view <-> Model list view)
   * Floats directly over the composer text box above the model pill; clicking outside dismisses it.
   */
  @Builder
  private modelPickerFloatingLayer() {
    Stack({ alignContent: Alignment.BottomEnd }) {
      // Full-area transparent click-away backdrop to dismiss when clicking blank area
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(Color.Transparent)
        .onClick(() => {
          this.showModelPicker = false;
        })

      // Floating card anchored right above the bottom composer's model pill
      Column() {
        if (this.modelPickerView === 'slider') {
          // Stage 1: Compact Reasoning Effort Slider + Clickable Model Header
          Column({ space: 12 }) {
            // Top clickable model row: ModelName 中度 > (no lightning icon)
            Row({ space: 4 }) {
              Text(this.activeModelLabel)
                .fontSize(13)
                .fontWeight(FontWeight.Bold)
                .fontColor($r('app.color.text_primary'))
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .constraintSize({ maxWidth: 148 })

              Text(this.effortStepLabel(this.activeReasoningEffort))
                .fontSize(13)
                .fontColor($r('app.color.text_secondary'))

              SymbolGlyph($r('sys.symbol.chevron_right'))
                .fontSize(11)
                .fontColor([$r('app.color.text_secondary')])
            }
            .width('100%')
            .justifyContent(FlexAlign.Center)
            .alignItems(VerticalAlign.Center)
            .onClick(() => {
              try {
                this.getUIContext().animateTo({ curve: curves.springMotion(0.26, 0.9) }, (): void => {
                  this.modelPickerView = 'list';
                });
              } catch {
                this.modelPickerView = 'list';
              }
            })

            // Bottom 5-step sliding track with thumb
            Stack({ alignContent: Alignment.Start }) {
              // Track background
              Row()
                .width(216)
                .height(28)
                .borderRadius(14)
                .backgroundColor($r('app.color.soft_surface'))

              // Active colored fill bar up to current thumb position
              Row()
                .width(28 + this.effortStepIndex(this.activeReasoningEffort) * 47)
                .height(28)
                .borderRadius(14)
                .backgroundColor($r('app.color.brand'))

              // 5 step dots along the track
              Row() {
                ForEach([0, 1, 2, 3, 4], (stepIdx: number) => {
                  Circle({ width: 4, height: 4 })
                    .fill(
                      stepIdx <= this.effortStepIndex(this.activeReasoningEffort)
                        ? '#AAFFFFFF'
                        : '#999CA3AF'
                    )
                }, (stepIdx: number): string => `effort_dot_${stepIdx}`)
              }
              .width(216)
              .height(28)
              .padding({ left: 12, right: 12 })
              .justifyContent(FlexAlign.SpaceBetween)
              .alignItems(VerticalAlign.Center)

              // White circular thumb
              Circle({ width: 24, height: 24 })
                .fill(Color.White)
                .margin({ left: 2 + this.effortStepIndex(this.activeReasoningEffort) * 47 })
                .shadow({ radius: 6, color: '#33000000', offsetX: 0, offsetY: 1 })

              // Interactive tap & horizontal drag layer
              Row() {
                ForEach([0, 1, 2, 3, 4], (stepIdx: number) => {
                  Column()
                    .layoutWeight(1)
                    .height('100%')
                    .onClick(() => {
                      this.selectEffortStep(stepIdx);
                    })
                }, (stepIdx: number): string => `effort_hit_${stepIdx}`)
              }
              .width(216)
              .height(28)
              .gesture(
                PanGesture({ direction: PanDirection.Horizontal })
                  .onActionUpdate((event: GestureEvent): void => {
                    const finger = event.fingerList && event.fingerList.length > 0 ? event.fingerList[0] : undefined;
                    if (finger) {
                      const nextIdx = Math.max(0, Math.min(4, Math.round((finger.localX - 14) / 47)));
                      this.selectEffortStep(nextIdx);
                    }
                  })
              )
            }
            .width(216)
            .height(28)
          }
          .width(244)
          .padding({ left: 14, right: 14, top: 12, bottom: 14 })
          .borderRadius(18)
          .backgroundColor($r('app.color.surface'))
          .border({ width: 0.5, color: $r('app.color.workspace_line') })
          .shadow({ radius: 24, color: '#26000000', offsetX: 0, offsetY: 6 })
        } else {
          // Stage 2: Expanded Model Selection List Card
          Column({ space: 2 }) {
            Row() {
              Text('选择模型')
                .fontSize(12)
                .fontColor($r('app.color.text_secondary'))
                .layoutWeight(1)

              if (this.balanceText.length > 0 && this.balanceText !== '未配置密钥') {
                Text(this.balanceText)
                  .fontSize(11)
                  .fontColor($r('app.color.brand_ink'))
              }
            }
            .width('100%')
            .padding({ left: 10, right: 10, top: 6, bottom: 6 })
            .onClick(() => {
              this.modelPickerView = 'slider';
            })

            // Default / Recommended entry at top of list
            Row() {
              Column({ space: 2 }) {
                Text('默认')
                  .fontSize(13)
                  .fontWeight(FontWeight.Bold)
                  .fontColor($r('app.color.text_primary'))
                Text('推荐模型集')
                  .fontSize(11)
                  .fontColor($r('app.color.text_secondary'))
              }
              .layoutWeight(1)
              .alignItems(HorizontalAlign.Start)

              if (this.modelProfiles.length > 0 && this.activeModelId === this.modelProfiles[0].id) {
                SymbolGlyph($r('sys.symbol.checkmark'))
                  .fontSize(14)
                  .fontColor([$r('app.color.text_primary')])
              }
            }
            .width('100%')
            .padding({ left: 10, right: 10, top: 7, bottom: 7 })
            .borderRadius(10)
            .onClick(async () => {
              if (this.modelProfiles.length > 0) {
                await LexiHarnessService.selectModelProfile(this.modelProfiles[0].id);
              }
              this.showModelPicker = false;
            })

            // Configured models list
            ForEach(this.modelProfiles, (prof: LexiHarnessModelProfile) => {
              Row({ space: 8 }) {
                Text(prof.label || prof.model)
                  .fontSize(13)
                  .fontWeight(prof.id === this.activeModelId ? FontWeight.Medium : FontWeight.Regular)
                  .fontColor($r('app.color.text_primary'))
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .layoutWeight(1)

                if (prof.id === this.activeModelId) {
                  SymbolGlyph($r('sys.symbol.checkmark'))
                    .fontSize(13)
                    .fontColor([$r('app.color.brand')])
                }
              }
              .width('100%')
              .padding({ left: 10, right: 10, top: 9, bottom: 9 })
              .borderRadius(10)
              .backgroundColor(prof.id === this.activeModelId ? $r('app.color.soft_surface') : Color.Transparent)
              .onClick(async () => {
                await LexiHarnessService.selectModelProfile(prof.id);
                this.showModelPicker = false;
              })
            }, (prof: LexiHarnessModelProfile): string => `quick_model_${prof.id}_${prof.model}`)

            Divider()
              .color($r('app.color.workspace_line'))
              .margin({ top: 4, bottom: 2 })

            Row() {
              Text('管理模型与 API 密钥…')
                .fontSize(11)
                .fontColor($r('app.color.brand_ink'))
                .layoutWeight(1)
              SymbolGlyph($r('sys.symbol.chevron_right'))
                .fontSize(10)
                .fontColor([$r('app.color.brand_ink')])
            }
            .width('100%')
            .padding({ left: 10, right: 10, top: 7, bottom: 6 })
            .borderRadius(8)
            .onClick(() => {
              this.showModelPicker = false;
              this.settingsSubTab = 'models';
              this.currentTab = 'settings';
            })
          }
          .width(244)
          .padding(8)
          .borderRadius(18)
          .backgroundColor($r('app.color.surface'))
          .border({ width: 0.5, color: $r('app.color.workspace_line') })
          .shadow({ radius: 24, color: '#26000000', offsetX: 0, offsetY: 6 })
        }
      }
      .margin({ right: 18, bottom: 52 })
      .onClick(() => {
        // Consume clicks inside the floating card so they do not bubble to backdrop
      })
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  private bottomComposerSection() {
    Column({ space: 8 }) {
      if (this.showRefPicker) {
        this.referencePickerOverlay()
      }
      if (this.showSkillPicker) {
        this.skillPickerOverlay()
      }

      // Top status / skill notification card
      if (this.showSkillBanner) {
        Row({ space: 8 }) {
          Column({ space: 3 }) {
            Text(`已就绪 ${this.skills.length} 项知萤专属 Skill (含 lexinote-operator)`)
              .fontSize(11)
              .fontColor($r('app.color.text_secondary'))
            Text(
              this.balanceText && this.balanceText !== '未配置密钥'
                ? `已接入 ${this.activeModelLabel} · 余额 ${this.balanceText}`
                : `当前模型: ${this.activeModelLabel}`
            )
              .fontSize(11)
              .fontColor($r('app.color.brand_ink'))
              .onClick(() => {
                this.showModelPicker = !this.showModelPicker;
                this.showRefPicker = false;
                this.showSkillPicker = false;
              })
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start)

          Column() {
            SymbolGlyph($r('sys.symbol.xmark'))
              .fontSize(11)
              .fontColor([$r('app.color.text_secondary')])
          }
          .width(22)
          .height(22)
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center)
          .onClick(() => {
            this.showSkillBanner = false;
          })
        }
        .width('100%')
        .padding({ left: 10, right: 8, top: 8, bottom: 8 })
        .borderRadius(8)
        .backgroundColor($r('app.color.surface'))
        .border({ width: 0.5, color: $r('app.color.workspace_line') })
      }

      // Main Composer Box
      Column({ space: 0 }) {
        // Upper hint bar inside composer box
        Column({ space: 6 }) {
          Text('提示: 使用 # 引用文件或文件夹，以便为智能体提供有关任务的更多上下文。')
            .fontSize(11)
            .lineHeight(16)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
            .onClick(() => {
              this.showRefPicker = !this.showRefPicker;
              this.showSkillPicker = false;
              this.showModelPicker = false;
            })

          if (this.attachedRefs.length > 0) {
            Flex({ wrap: FlexWrap.Wrap }) {
              ForEach(this.attachedRefs, (ref: LexiHarnessNoteRef) => {
                Row({ space: 4 }) {
                  LexiIcon({ name: ref.kind === 'folder' ? 'folder' : 'note', iconSize: 11 })
                  Text(ref.title)
                    .fontSize(10)
                    .fontColor($r('app.color.brand_ink'))
                  Text('×')
                    .fontSize(11)
                    .fontColor($r('app.color.text_secondary'))
                    .onClick(() => {
                      this.removeAttachedRef(ref.id);
                    })
                }
                .padding({ left: 6, right: 6, top: 2, bottom: 2 })
                .margin({ right: 4, bottom: 4 })
                .borderRadius(5)
                .backgroundColor($r('app.color.brand_soft'))
              }, (ref: LexiHarnessNoteRef): string => `attached_${ref.kind}_${ref.id}`)
            }
          }
        }
        .width('100%')
        .padding({ left: 10, right: 10, top: 8, bottom: 6 })
        .border({ width: { bottom: 0.5 }, color: $r('app.color.workspace_line') })

        // TextArea input
        TextArea({
          text: this.composerText,
          placeholder: '与知萤 AI 聊天（输入 # 引用笔记，/ 调用 Skill）'
        })
          .width('100%')
          .constraintSize({ minHeight: 54, maxHeight: 110 })
          .fontSize(13)
          .fontColor($r('app.color.text_primary'))
          .placeholderColor($r('app.color.text_secondary'))
          .backgroundColor(Color.Transparent)
          .padding({ left: 10, right: 10, top: 8, bottom: 4 })
          .onChange((val: string) => {
            this.composerText = val;
            if (val.endsWith('#')) {
              this.showRefPicker = true;
              this.showSkillPicker = false;
              this.showModelPicker = false;
            } else if (val === '/') {
              this.showSkillPicker = true;
              this.showRefPicker = false;
              this.showModelPicker = false;
            }
          })

        // Bottom action bar inside composer box: Left (+ | Agent | Skill) + Right (Quick Model Switcher | Send/Stop)
        Row({ space: 6 }) {
          Row({ space: 4 }) {
            // + attach reference
            Column() {
              LexiIcon({ name: 'plus', iconSize: 14, muted: true })
            }
            .width(24)
            .height(24)
            .borderRadius(6)
            .justifyContent(FlexAlign.Center)
            .alignItems(HorizontalAlign.Center)
            .onClick(() => {
              this.showRefPicker = !this.showRefPicker;
              this.showSkillPicker = false;
              this.showModelPicker = false;
            })

            // Agent badge
            Row({ space: 3 }) {
              LexiIcon({ name: 'star', iconSize: 11 })
              Text('Agent')
                .fontSize(11)
                .fontWeight(FontWeight.Medium)
                .fontColor($r('app.color.text_secondary'))
                .maxLines(1)
            }
            .padding({ left: 5, right: 5, top: 3, bottom: 3 })
            .borderRadius(5)
            .backgroundColor($r('app.color.workspace_selection'))
            .onClick(() => {
              this.insertSkillSlash('lexinote-operator');
            })

            // Skill picker trigger
            Row({ space: 2 }) {
              LexiIcon({ name: 'tag', iconSize: 11, muted: true })
              Text('Skill')
                .fontSize(11)
                .fontColor($r('app.color.text_secondary'))
                .maxLines(1)
            }
            .padding({ left: 4, right: 4, top: 3, bottom: 3 })
            .borderRadius(5)
            .onClick(() => {
              this.showSkillPicker = !this.showSkillPicker;
              this.showRefPicker = false;
              this.showModelPicker = false;
            })
          }
          .layoutWeight(1)
          .alignItems(VerticalAlign.Center)

          Row({ space: 6 }) {
            // Quick Model Switcher pill (pops up two-stage reasoning effort slider + model selector)
            Row({ space: 3 }) {
              if (this.showModelPicker && this.modelPickerView === 'slider') {
                Text('选择模型')
                  .fontSize(11)
                  .fontWeight(FontWeight.Medium)
                  .fontColor($r('app.color.text_secondary'))
                  .maxLines(1)
              } else {
                Text(this.activeModelLabel)
                  .fontSize(11)
                  .fontWeight(FontWeight.Medium)
                  .fontColor($r('app.color.text_primary'))
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .constraintSize({ maxWidth: this.isWidePanel || this.isDialogMode ? 120 : 82 })

                Text(this.effortStepLabel(this.activeReasoningEffort))
                  .fontSize(11)
                  .fontColor($r('app.color.text_secondary'))
                  .maxLines(1)
              }

              SymbolGlyph($r('sys.symbol.chevron_down'))
                .fontSize(10)
                .fontColor([$r('app.color.text_secondary')])
            }
            .height(26)
            .padding({ left: 8, right: 7 })
            .borderRadius(13)
            .backgroundColor($r('app.color.soft_surface'))
            .alignItems(VerticalAlign.Center)
            .onClick(() => {
              if (!this.showModelPicker) {
                this.modelPickerView = 'slider';
                this.showModelPicker = true;
              } else {
                this.showModelPicker = false;
              }
              this.showRefPicker = false;
              this.showSkillPicker = false;
            })

            // Send or Stop button
            if (this.isTurnRunning) {
              Column() {
                Row()
                  .width(9)
                  .height(9)
                  .borderRadius(2)
                  .backgroundColor(Color.White)
              }
              .width(26)
              .height(26)
              .borderRadius(13)
              .backgroundColor('#EF4444')
              .justifyContent(FlexAlign.Center)
              .alignItems(HorizontalAlign.Center)
              .onClick(() => {
                LexiHarnessService.abortCurrentTurn();
              })
            } else {
              Column() {
                Text('↑')
                  .fontSize(13)
                  .fontWeight(FontWeight.Bold)
                  .fontColor(this.composerText.trim().length > 0 ? Color.White : $r('app.color.text_secondary'))
              }
              .width(26)
              .height(26)
              .borderRadius(13)
              .backgroundColor(
                this.composerText.trim().length > 0
                  ? $r('app.color.brand')
                  : $r('app.color.soft_surface')
              )
              .justifyContent(FlexAlign.Center)
              .alignItems(HorizontalAlign.Center)
              .onClick(() => {
                this.submitMessage();
              })
            }
          }
          .alignItems(VerticalAlign.Center)
        }
        .width('100%')
        .padding({ left: 8, right: 8, top: 4, bottom: 8 })
        .alignItems(VerticalAlign.Center)
      }
      .width('100%')
      .borderRadius(10)
      .backgroundColor($r('app.color.surface'))
      .border({ width: 0.5, color: $r('app.color.workspace_line') })
    }
    .width('100%')
    .padding({ left: 10, right: 10, top: 6, bottom: 10 })
    .backgroundColor($r('app.color.workspace_sidebar'))
    .border({ width: { top: 0.5 }, color: $r('app.color.workspace_line') })
  }

  build() {
    Stack({ alignContent: Alignment.BottomEnd }) {
      Column({ space: 0 }) {
        this.topHeaderBar()

        if (this.currentTab === 'chat') {
          this.chatTabBody()
          this.bottomComposerSection()
        } else if (this.currentTab === 'sessions') {
          this.sessionsTabBody()
        } else {
          this.settingsTabBody()
        }
      }
      .width('100%')
      .height('100%')

      if (this.currentTab === 'chat' && this.showModelPicker) {
        this.modelPickerFloatingLayer()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.workspace_sidebar'))
  }
}

/**
 * Bottom Sheet Card Modal for Phone screens (Home page & Note Editor page)
 */
@Component
export struct LexiHarnessModalDialog {
  @Prop activeNoteIdProp: string = '';
  @StorageProp('lexiBottomInset') bottomInset: number = 0;
  @State private backdropOpacity: number = 0;
  @State private sheetOffsetY: number = 760;
  private closing: boolean = false;
  onClose: () => void = () => {};
  onInsertToEditor: (markdownText: string) => void = () => {};
  onCreateNoteFromReply: (title: string, markdownText: string) => void = () => {};

  aboutToAppear(): void {
    this.closing = false;
    this.backdropOpacity = 0;
    this.sheetOffsetY = 760;
    setTimeout((): void => {
      try {
        this.getUIContext().animateTo({ curve: curves.springMotion(0.32, 0.88) }, (): void => {
          this.backdropOpacity = 1;
          this.sheetOffsetY = 0;
        });
      } catch {
        this.backdropOpacity = 1;
        this.sheetOffsetY = 0;
      }
    }, 16);
  }

  private dismissSheet(): void {
    if (this.closing) {
      return;
    }
    this.closing = true;
    try {
      this.getUIContext().animateTo({ curve: curves.springMotion(0.26, 0.94) }, (): void => {
        this.backdropOpacity = 0;
        this.sheetOffsetY = 820;
      });
    } catch {
      this.onClose();
      return;
    }
    setTimeout((): void => {
      this.onClose();
    }, 220);
  }

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      // Dimmed full-screen backdrop
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor('#52000000')
        .opacity(this.backdropOpacity)
        .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
        .onClick(() => {
          this.dismissSheet();
        })

      // Bottom-popping Sheet Card matching HarmonyOS native sheet card style
      Column({ space: 0 }) {
        // Top grabber handle bar (supports swipe-down to dismiss)
        Column() {
          Row()
            .width(38)
            .height(4)
            .borderRadius(2)
            .backgroundColor($r('app.color.divider'))
        }
        .width('100%')
        .height(20)
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .gesture(
          PanGesture({ direction: PanDirection.Vertical })
            .onActionUpdate((event: GestureEvent): void => {
              if (event.offsetY > 0) {
                this.sheetOffsetY = event.offsetY;
              }
            })
            .onActionEnd((event: GestureEvent): void => {
              if (event.offsetY > 110 || event.velocityY > 560) {
                this.dismissSheet();
              } else {
                try {
                  this.getUIContext().animateTo({ curve: curves.springMotion(0.3, 0.88) }, (): void => {
                    this.sheetOffsetY = 0;
                  });
                } catch {
                  this.sheetOffsetY = 0;
                }
              }
            })
        )

        Column() {
          LexiHarnessPanel({
            isDialogMode: true,
            isWidePanel: false,
            activeNoteIdProp: this.activeNoteIdProp,
            onClose: () => {
              this.dismissSheet();
            },
            onInsertToEditor: (markdownText: string) => {
              this.onInsertToEditor(markdownText);
            },
            onCreateNoteFromReply: (title: string, markdownText: string) => {
              this.onCreateNoteFromReply(title, markdownText);
            }
          })
        }
        .width('100%')
        .layoutWeight(1)
      }
      .width('100%')
      .height('91%')
      .padding({ bottom: Math.max(6, this.bottomInset) })
      .borderRadius({ topLeft: 32, topRight: 32, bottomLeft: 0, bottomRight: 0 })
      .clip(true)
      .backgroundColor($r('app.color.workspace_sidebar'))
      .shadow({ radius: 36, color: '#33000000', offsetX: 0, offsetY: -6 })
      .translate({ y: this.sheetOffsetY })
      .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
    }
    .width('100%')
    .height('100%')
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }
}
