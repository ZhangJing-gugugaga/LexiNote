import { common } from '@kit.AbilityKit';
import { LexiMarkdownPreview } from '../components/LexiEditorPanels';
import { LexiShareCapture } from '../core/LexiShareCapture';
import { LexiShareContent, LexiShareDraft } from '../core/LexiShareContent';
import { LexiStorageService } from '../core/LexiStorageService';
import { MarkdownBlock, LexiProject, VaultItem } from '../core/LexiModels';
import { MarkdownEngine } from '../core/MarkdownEngine';

@Entry({ useSharedStorage: true })
@Component
struct ShareCapturePage {
  @LocalStorageProp('lexiShareSessionId') private sessionId: string = '';
  @LocalStorageProp('lexiShareDraftJson') @Watch('draftArrived') private draftJson: string = '';
  @LocalStorageProp('lexiShareError') private receiveError: string = '';
  @State private titleText: string = '';
  @State private sourceText: string = '';
  @State private quoteText: string = '';
  @State private vaults: VaultItem[] = [];
  @State private projects: LexiProject[] = [];
  @State private vaultId: string = '';
  @State private projectId: string = '';
  @State private previewBlocks: MarkdownBlock[] = [];
  @State private notice: string = '';
  @State private errorText: string = '';
  @State private previewError: string = '';
  @State private saving: boolean = false;
  @State private ready: boolean = false;
  @State private savedNoteId: string = '';
  @State private duplicateNoteId: string = '';
  @State private showPreview: boolean = true;
  private draft: LexiShareDraft = new LexiShareDraft();
  private received: boolean = false;
  private stashTimer: number = -1;
  private initializing: Promise<void> | undefined;

  private context(): common.Context {
    return this.getUIContext().getHostContext() as common.Context;
  }

  aboutToAppear(): void {
    this.ensureReady().then((): void => { this.draftArrived(); }).catch((error: Error): void => {
      this.errorText = error.message || '无法打开本地工作区，分享内容仍保留在当前页面';
    });
  }

  aboutToDisappear(): void {
    if (this.stashTimer >= 0) { clearTimeout(this.stashTimer); }
    if (this.ready && !this.savedNoteId) { LexiShareCapture.stashDraft(this.context(), this.snapshot()).catch((): void => {}); }
  }

  private async ensureReady(): Promise<void> {
    if (!this.initializing) { this.initializing = this.loadDestinations(); }
    await this.initializing;
  }

  private async loadDestinations(): Promise<void> {
    await LexiStorageService.init(this.context());
    this.vaults = await LexiStorageService.getVaults();
    this.projects = await LexiStorageService.getProjects();
    const active = await LexiStorageService.getActiveVaultId();
    this.vaultId = this.vaults.some((vault: VaultItem): boolean => vault.id === active) ? active : (this.vaults[0]?.id ?? '');
    this.projectId = this.vaultId ? await LexiStorageService.getActiveProjectId(this.vaultId) : '';
  }

  private draftArrived(): void {
    this.acceptDraft().catch((error: Error): void => {
      this.errorText = error.message || '分享内容读取失败，请返回分享面板重试';
    });
  }

  private async acceptDraft(): Promise<void> {
    if (this.received || !this.draftJson) { return; }
    this.received = true;
    await this.ensureReady();
    const incoming = JSON.parse(this.draftJson) as LexiShareDraft;
    this.draft = await LexiShareCapture.restoreDraft(this.context(), incoming);
    const ecoApp = this.draft.isMarkdownFile ? LexiShareCapture.detectEcosystemApp(this.draft.quote || '') : '';
    if (ecoApp) {
      const saved = await LexiShareCapture.saveToEcosystemWorkspace(this.context(), this.draft, ecoApp);
      this.vaults = await LexiStorageService.getVaults();
      this.vaultId = saved.vaultId;
      this.projectId = '';
      this.titleText = saved.title;
      this.sourceText = '';
      this.quoteText = saved.content;
      this.savedNoteId = saved.id;
      this.notice = `已自动保存到「${ecoApp === 'LumiKit' ? '集萤' : '词萤'}」工作区`;
      this.ready = true;
      this.refreshPreview();
      AppStorage.setOrCreate<number>('lexiWorkspaceRevision', (AppStorage.get<number>('lexiWorkspaceRevision') || 0) + 1);
      try { await LexiShareCapture.close(this.sessionId, true); } catch {}
      return;
    }
    this.titleText = this.draft.title; this.sourceText = this.draft.sourceUrl; this.quoteText = this.draft.quote;
    this.notice = this.draft.notice;
    this.ready = true; this.refreshPreview();
    await LexiShareCapture.stashDraft(this.context(), this.snapshot());
  }

  private snapshot(): LexiShareDraft {
    const draft = JSON.parse(JSON.stringify(this.draft)) as LexiShareDraft;
    draft.title = this.titleText; draft.sourceUrl = this.sourceText; draft.quote = this.quoteText;
    return draft;
  }

  private refreshPreview(): void {
    this.duplicateNoteId = '';
    try {
      this.previewBlocks = MarkdownEngine.parseBlocks(LexiShareContent.markdown(this.snapshot()));
      this.previewError = '';
    } catch (error) { this.previewBlocks = []; this.previewError = (error as Error).message; }
  }

  private changed(): void {
    this.errorText = ''; this.refreshPreview();
    if (this.stashTimer >= 0) { clearTimeout(this.stashTimer); }
    this.stashTimer = setTimeout((): void => {
      LexiShareCapture.stashDraft(this.context(), this.snapshot()).catch((error: Error): void => {
        this.errorText = error.message || '本地草稿暂未保存，当前输入仍保留';
      });
    }, 400);
  }

  private workspaceName(): string { return this.vaults.find((vault: VaultItem): boolean => vault.id === this.vaultId)?.name || '选择工作区'; }
  private selectedProjectName(): string { return this.projects.find((project: LexiProject): boolean => project.id === this.projectId)?.name || '工作区根目录'; }

  private handleSaveClick(): void {
    if (this.saving || !this.ready || !this.vaultId || this.savedNoteId) { return; }
    if (this.draft.isMarkdownFile && !this.duplicateNoteId) {
      this.getUIContext().showAlertDialog({
        title: '是否要添加到工作区？',
        message: `是否将已编辑的 Markdown 文件「${this.titleText.trim() || '未命名笔记'}.md」添加到工作区「${this.workspaceName()}」？`,
        primaryButton: {
          value: '不添加（仅保存）',
          action: (): void => { this.saveExternalOnly(); }
        },
        secondaryButton: {
          value: '添加到工作区',
          action: (): void => { this.save(false); }
        }
      });
      return;
    }
    this.save(!!this.duplicateNoteId);
  }

  private async saveExternalOnly(): Promise<void> {
    if (this.saving || !this.ready || this.savedNoteId) { return; }
    this.saving = true; this.errorText = '';
    if (this.stashTimer >= 0) { clearTimeout(this.stashTimer); this.stashTimer = -1; }
    try {
      const current = this.snapshot();
      await LexiShareCapture.stashDraft(this.context(), current);
      const markdown = LexiShareContent.markdown(current);
      if (current.fileUri) {
        LexiShareCapture.writeUriText(current.fileUri, markdown);
      }
      this.savedNoteId = 'external-saved';
      this.notice = '已保存 Markdown 文件修改（未添加到工作区）';
      try { await LexiShareCapture.close(this.sessionId, true); }
      catch { this.errorText = '文件修改已保存，可点击“完成”关闭面板。'; }
    } catch (error) {
      this.errorText = (error as Error).message || '保存失败，当前编辑仍保留';
    } finally { this.saving = false; }
  }

  private async save(allowDuplicate: boolean = false): Promise<void> {
    if (this.saving || !this.ready || !this.vaultId || this.savedNoteId) { return; }
    this.saving = true; this.errorText = '';
    if (this.stashTimer >= 0) { clearTimeout(this.stashTimer); this.stashTimer = -1; }
    try {
      const result = await LexiShareCapture.save(this.context(), this.snapshot(), this.vaultId, this.projectId, allowDuplicate);
      if (result.duplicate) {
        this.duplicateNoteId = result.note.id;
        this.errorText = `此位置已有相同笔记「${result.note.title}」。可返回，或明确另存一份。`;
        return;
      }
      this.savedNoteId = result.note.id;
      this.notice = result.alreadySaved ? '该内容已经保存，未重复创建。' :
        (this.draft.isMarkdownFile ? `已保存并添加到工作区「${this.workspaceName()}」` : `已保存到 ${this.workspaceName()} / 剪藏收件箱`);
      AppStorage.setOrCreate<number>('lexiWorkspaceRevision', (AppStorage.get<number>('lexiWorkspaceRevision') || 0) + 1);
      try { await LexiShareCapture.close(this.sessionId, true); }
      catch { this.errorText = '已保存，可点击“完成”关闭分享面板。'; }
    } catch (error) {
      this.errorText = (error as Error).message || '保存失败，当前草稿已保留，可重试';
    } finally { this.saving = false; }
  }

  private async close(): Promise<void> {
    if (this.saving) { return; }
    try {
      if (this.ready && !this.savedNoteId) { await LexiShareCapture.stashDraft(this.context(), this.snapshot()); }
      await LexiShareCapture.close(this.sessionId, !!this.savedNoteId);
    } catch (error) { this.errorText = (error as Error).message || '当前草稿仍保留，请稍后重试'; }
  }

  @Builder
  private workspaceMenu() {
    Menu() {
      ForEach(this.vaults, (vault: VaultItem) => {
        MenuItem({ content: `${vault.id === this.vaultId ? '✓ ' : ''}${vault.name}` }).onClick((): void => {
          this.vaultId = vault.id; this.projectId = ''; this.duplicateNoteId = ''; this.errorText = '';
        })
      }, (vault: VaultItem): string => vault.id)
    }
  }

  @Builder
  private projectMenu() {
    Menu() {
      MenuItem({ content: `${this.projectId ? '' : '✓ '}工作区根目录` }).onClick((): void => { this.projectId = ''; this.duplicateNoteId = ''; })
      ForEach(this.projects.filter((project: LexiProject): boolean => project.vaultId === this.vaultId), (project: LexiProject) => {
        MenuItem({ content: `${project.id === this.projectId ? '✓ ' : ''}${project.name}` }).onClick((): void => {
          this.projectId = project.id; this.duplicateNoteId = ''; this.errorText = '';
        })
      }, (project: LexiProject): string => project.id)
    }
  }

  build() {
    Column({ space: 0 }) {
      Row({ space: 10 }) {
        Image($r('app.media.lexi_logo')).width(28).height(28).borderRadius(7)
        Text(this.draft.isMarkdownFile ? '打开并编辑 Markdown' : '保存到知萤')
          .fontSize(18).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary')).layoutWeight(1)
        Button(this.savedNoteId ? '完成' : '返回', { buttonStyle: ButtonStyleMode.TEXTUAL }).id('share-capture-close')
          .height(40).fontSize(13).fontColor($r('app.color.brand_ink')).enabled(!this.saving).onClick((): void => { this.close(); })
      }.width('100%').padding({ left: 20, right: 12, top: 12, bottom: 8 })
      Scroll() {
        Column({ space: 14 }) {
          Text(this.draft.isMarkdownFile
            ? '已打开分享的 Markdown 文件，可直接编辑正文，点击“保存”时可选择是否添加到当前工作区。'
            : '只接收本次分享的文字和链接，在本机生成 Markdown。返回时保留草稿，再次分享相同内容可继续编辑。')
            .fontSize(12).lineHeight(20).fontColor($r('app.color.text_secondary')).width('100%')
          if (this.receiveError) {
            Text(this.receiveError).id('share-capture-receive-error').fontSize(14).lineHeight(23).fontColor($r('app.color.text_primary')).width('100%')
          } else if (!this.ready) {
            Text('正在读取分享内容…').fontSize(14).fontColor($r('app.color.text_secondary')).padding(24)
          }
          if (this.ready) {
            Row({ space: 8 }) {
              Button(this.workspaceName(), { buttonStyle: ButtonStyleMode.TEXTUAL }).id('share-capture-workspace')
                .layoutWeight(1).height(40).fontSize(13).fontColor($r('app.color.brand_ink')).backgroundColor($r('app.color.soft_surface'))
                .enabled(!this.saving && !this.savedNoteId).bindMenu(this.workspaceMenu())
              Button(this.selectedProjectName(), { buttonStyle: ButtonStyleMode.TEXTUAL }).id('share-capture-project')
                .layoutWeight(1).height(40).fontSize(13).fontColor($r('app.color.brand_ink')).backgroundColor($r('app.color.soft_surface'))
                .enabled(!this.saving && !this.savedNoteId).bindMenu(this.projectMenu())
            }.width('100%')
            TextInput({ text: this.titleText, placeholder: this.draft.isMarkdownFile ? 'Markdown 文件标题' : '剪藏标题' })
              .id('share-capture-title').height(44).maxLength(160)
              .fontSize(16).fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.soft_surface'))
              .enabled(!this.saving && !this.savedNoteId).onChange((text: string): void => { this.titleText = text; this.changed(); })
            if (!this.draft.isMarkdownFile) {
              TextInput({ text: this.sourceText, placeholder: '来源链接（可选，仅 HTTP / HTTPS）' }).id('share-capture-source')
                .height(42).maxLength(4096).fontSize(12).fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.soft_surface'))
                .enabled(!this.saving && !this.savedNoteId).onChange((text: string): void => { this.sourceText = text; this.changed(); })
            }
            TextArea({ text: this.quoteText, placeholder: this.draft.isMarkdownFile ? '在此编辑 Markdown 文件内容…' : '引用文本，可在保存前修改' })
              .id('share-capture-text')
              .height(this.draft.isMarkdownFile ? 260 : 160).maxLength(this.draft.isMarkdownFile ? 1048576 : 102400)
              .fontSize(14).fontColor($r('app.color.text_primary')).backgroundColor($r('app.color.soft_surface'))
              .enabled(!this.saving && !this.savedNoteId).onChange((text: string): void => { this.quoteText = text; this.changed(); })
            Button(this.showPreview ? '收起 Markdown 预览' : '查看 Markdown 预览', { buttonStyle: ButtonStyleMode.TEXTUAL })
              .id('share-capture-preview-toggle').fontSize(12).height(34).fontColor($r('app.color.brand_ink'))
              .onClick((): void => { this.showPreview = !this.showPreview; })
            if (this.previewError) { Text(this.previewError).fontSize(12).fontColor($r('app.color.text_secondary')).width('100%'); }
            if (this.showPreview && !this.previewError) { LexiMarkdownPreview({ blocks: this.previewBlocks, frameless: true }); }
          }
          if (this.notice) { Text(this.notice).id('share-capture-notice').fontSize(12).lineHeight(20).fontColor($r('app.color.brand_ink')).width('100%'); }
          if (this.errorText) { Text(this.errorText).id('share-capture-error').fontSize(13).lineHeight(21).fontColor($r('app.color.text_primary')).width('100%'); }
        }.width('100%').padding({ left: 20, right: 20, top: 10, bottom: 24 }).alignItems(HorizontalAlign.Start)
      }.width('100%').layoutWeight(1).align(Alignment.Top).scrollBar(BarState.Auto)
      if (this.ready && !this.savedNoteId) {
        Button(this.saving ? '正在保存…' : this.duplicateNoteId ? '仍另存一份' : (this.draft.isMarkdownFile ? '保存' : '保存到剪藏收件箱'))
          .id('share-capture-save').width('100%').height(46).fontSize(15).borderRadius(14)
          .fontColor($r('app.color.inverse_text')).backgroundColor($r('app.color.brand'))
          .enabled(!this.saving && !!this.vaultId && !this.previewError)
          .onClick((): void => { this.handleSaveClick(); })
          .margin({ top: 8, bottom: 16 })
      }
    }.width('100%').height('100%').padding({ left: 8, right: 8 }).backgroundColor($r('app.color.surface'))
  }
}
