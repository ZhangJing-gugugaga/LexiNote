import { common } from '@kit.AbilityKit';
import { NoteItem } from '../core/LexiModels';
import { LexiOfflineSpeech, LexiSpeechSnapshot } from '../core/LexiOfflineSpeech';
import { LexiLocalAssistant, LexiLocalArrangement, LexiLocalSuggestion } from '../core/LexiLocalAssistant';
import { LexiSemanticAssistant } from '../core/LexiSemanticAssistant';

@Component
export struct LexiCaptureAssistantPanel {
  @Prop content: string = '';
  @Prop availableNotes: NoteItem[] = [];
  onInsert: (text: string) => void = (_text: string): void => {};
  onClose: () => void = (): void => {};
  @State private panelKind: string = 'speech';
  @State private captureText: string = '';
  @State private speechState: string = 'idle';
  @State private speechMessage: string = '点击录音后才会请求麦克风权限。也可以直接输入文字。';
  @State private speechSupported: boolean = false;
  @State private arrangement: LexiLocalArrangement = new LexiLocalArrangement();
  @State private summaryDraft: string = '';
  @State private summarySelected: boolean = false;
  @State private selectedIds: string[] = [];
  @State private arranged: boolean = false;
  @State private arrangeMessage: string = '';
  @State private semanticRunning: boolean = false;
  private speech: LexiOfflineSpeech = new LexiOfflineSpeech();
  private semantic: LexiSemanticAssistant = new LexiSemanticAssistant();
  private arrangeGeneration: number = 0;
  private captureBase: string = '';
  private alive: boolean = false;

  aboutToAppear(): void {
    this.alive = true; this.speechSupported = LexiOfflineSpeech.supported();
    if (!this.speechSupported) { this.speechMessage = '这台设备未提供离线语音识别，可在下方手动输入。'; }
  }

  aboutToDisappear(): void {
    this.alive = false; this.arrangeGeneration++; this.speech.dispose(); this.semantic.dispose();
  }

  private activeSpeech(): boolean { return ['requesting', 'starting', 'listening', 'stopping'].includes(this.speechState); }

  private receiveSpeech(snapshot: LexiSpeechSnapshot): void {
    if (!this.alive) { return; }
    this.speechState = snapshot.state; this.speechMessage = snapshot.message;
    if (snapshot.state === 'cancelled') { this.captureText = this.captureBase; }
    else if (snapshot.text) { this.captureText = this.captureBase + (this.captureBase.trim() ? '\n\n' : '') + snapshot.text; }
  }

  private startRecording(): void {
    if (this.activeSpeech() || !this.speechSupported) { return; }
    this.captureBase = this.captureText;
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.speech.start(context, (snapshot: LexiSpeechSnapshot): void => { this.receiveSpeech(snapshot); })
      .catch((): void => {
        if (this.alive) { this.speechState = 'error'; this.speechMessage = '离线识别未能启动，可继续手动输入。'; }
      });
  }

  private closePanel(): void {
    this.arrangeGeneration++; this.semantic.cancel(); this.semanticRunning = false;
    if (this.activeSpeech()) { this.speech.cancel(); }
    this.onClose();
  }

  private insertCapture(): void {
    if (this.activeSpeech() || !this.captureText.trim()) { return; }
    this.onInsert(`\n\n${this.captureText.trim()}\n`);
    this.speechMessage = '文字已插入笔记。此处保留一份，便于继续修改。';
  }

  private mergeSuggestions(existing: LexiLocalSuggestion[], incoming: LexiLocalSuggestion[]): LexiLocalSuggestion[] {
    const merged = existing.slice();
    for (const suggestion of incoming) {
      if (!merged.some((item: LexiLocalSuggestion): boolean => item.markdown.toLowerCase() === suggestion.markdown.toLowerCase())) {
        merged.push(suggestion);
      }
    }
    return merged;
  }

  private async arrange(): Promise<void> {
    if (this.semanticRunning) { return; }
    const generation = ++this.arrangeGeneration;
    this.arrangement = LexiLocalAssistant.arrange(this.content, this.availableNotes);
    this.summaryDraft = this.arrangement.summary; this.summarySelected = false; this.selectedIds = [];
    this.arranged = true;
    const localMessage = this.summaryDraft || this.arrangement.actions.length || this.arrangement.links.length || this.arrangement.tags.length ?
      '建议已生成，请勾选需要的内容，再插入笔记。' : '当前内容不足以整理，可先补充一些正文。';
    this.semanticRunning = true; this.arrangeMessage = localMessage + '\n正在本机匹配相关笔记…';
    try {
      const semantic = await this.semantic.suggest(this.content, this.availableNotes);
      if (!this.alive || generation !== this.arrangeGeneration) { return; }
      const combined = new LexiLocalArrangement();
      combined.summary = this.arrangement.summary; combined.actions = this.arrangement.actions;
      combined.links = this.mergeSuggestions(this.arrangement.links, semantic.links);
      combined.tags = this.mergeSuggestions(this.arrangement.tags, semantic.tags);
      this.arrangement = combined; this.arrangeMessage = localMessage + '\n' + semantic.message;
    } catch {
      if (this.alive && generation === this.arrangeGeneration) {
        this.arrangeMessage = localMessage + '\n语义匹配暂不可用，已保留原文摘录与规则建议。';
      }
    } finally {
      if (this.alive && generation === this.arrangeGeneration) { this.semanticRunning = false; }
    }
  }

  private selectSuggestion(id: string, selected: boolean): void {
    if (selected && !this.selectedIds.includes(id)) { this.selectedIds = this.selectedIds.concat(id); }
    else if (!selected) { this.selectedIds = this.selectedIds.filter((candidate: string): boolean => candidate !== id); }
  }

  private selectedMarkdown(): string {
    return LexiLocalAssistant.selectedMarkdown(this.arrangement, this.selectedIds, this.summaryDraft, this.summarySelected);
  }

  private insertArrangement(): void {
    const text = this.selectedMarkdown();
    if (!text) { return; }
    this.onInsert(text); this.selectedIds = []; this.summarySelected = false;
    this.arrangeMessage = '所选内容已插入笔记，原正文保留。';
  }

  @Builder
  private speechContent() {
    Column({ space: 12 }) {
      Text('中文离线语音速记').fontSize(17).fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary')).width('100%')
      Text('使用设备内置离线模型识别普通话，单次最长 60 秒。录音期间可预览，结束后可编辑文字。')
        .fontSize(13).lineHeight(21).fontColor($r('app.color.text_secondary')).width('100%')
      Row({ space: 8 }) {
        Button(this.activeSpeech() ? '正在识别…' : '开始录音').id('capture-speech-start').layoutWeight(1)
          .height(42).fontSize(13).enabled(this.speechSupported && !this.activeSpeech())
          .onClick((): void => { this.startRecording(); })
        Button('停止', { buttonStyle: ButtonStyleMode.TEXTUAL }).id('capture-speech-stop')
          .height(42).fontSize(13).enabled(this.activeSpeech() && this.speechState !== 'stopping')
          .onClick((): void => { this.speech.stop(); })
        Button('取消', { buttonStyle: ButtonStyleMode.TEXTUAL }).id('capture-speech-cancel')
          .height(42).fontSize(13).enabled(this.activeSpeech()).onClick((): void => { this.speech.cancel(); })
      }.width('100%')
      Text(this.speechMessage).id('capture-speech-status').fontSize(12).lineHeight(20)
        .fontColor(this.speechState === 'error' ? $r('app.color.error') : $r('app.color.text_secondary')).width('100%')
      TextArea({ text: this.captureText, placeholder: '识别结果会出现在这里，也可以手动输入 Markdown…' })
        .id('capture-speech-text').width('100%').height(220).enabled(!this.activeSpeech())
        .fontSize(15).lineHeight(25).fontColor($r('app.color.text_primary'))
        .backgroundColor($r('app.color.soft_surface')).borderRadius(12).padding(12)
        .onChange((text: string): void => { this.captureText = text; })
      Button('插入文字到笔记').id('capture-speech-insert').width('100%').height(42).fontSize(14)
        .enabled(!this.activeSpeech() && !!this.captureText.trim()).onClick((): void => { this.insertCapture(); })
    }.width('100%').alignItems(HorizontalAlign.Start)
  }

  @Builder
  private arrangementContent() {
    Column({ space: 12 }) {
      Text('本地整理').fontSize(17).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary')).width('100%')
      Text('摘录原文摘要与行动项，并匹配已有笔记和标签。设备支持时会用离线语义模型对比最近 24 篇可用笔记。请检查后选择插入。')
        .fontSize(13).lineHeight(21).fontColor($r('app.color.text_secondary')).width('100%')
      Text('摘要和行动项为原文摘录、规则提取，不是生成式 AI 回答。')
        .fontSize(12).lineHeight(20).fontColor($r('app.color.text_secondary')).width('100%')
      Button(this.semanticRunning ? '正在匹配相关笔记…' : this.arranged ? '重新整理当前笔记' : '整理当前笔记', { buttonStyle: ButtonStyleMode.TEXTUAL })
        .id('capture-arrange-run').height(40).fontSize(13).enabled(!!this.content.trim() && !this.semanticRunning)
        .onClick((): void => { this.arrange(); })
      if (this.arrangeMessage) {
        Text(this.arrangeMessage).id('capture-arrange-status').fontSize(12).lineHeight(20)
          .fontColor($r('app.color.text_secondary')).width('100%')
      }
      if (this.arranged) {
        if (this.summaryDraft) {
          Row({ space: 8 }) {
            Checkbox({ name: 'local-summary' }).select(this.summarySelected).selectedColor($r('app.color.brand'))
              .onChange((selected: boolean): void => { this.summarySelected = selected; })
            Text('摘录摘要（可编辑）').fontSize(14).fontWeight(FontWeight.Medium)
              .fontColor($r('app.color.text_primary')).layoutWeight(1)
          }.width('100%')
          TextArea({ text: this.summaryDraft }).id('capture-summary-text').width('100%').height(140)
            .fontSize(14).lineHeight(23).fontColor($r('app.color.text_primary'))
            .backgroundColor($r('app.color.soft_surface')).borderRadius(12).padding(12)
            .onChange((text: string): void => { this.summaryDraft = text; })
        }
        if (this.arrangement.actions.length) {
          Text('行动项').fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary')).width('100%')
          ForEach(this.arrangement.actions, (actionItem: LexiLocalSuggestion) => {
            Row({ space: 8 }) {
              Checkbox({ name: actionItem.id }).select(this.selectedIds.includes(actionItem.id)).selectedColor($r('app.color.brand'))
                .onChange((selected: boolean): void => { this.selectSuggestion(actionItem.id, selected); })
              Text(actionItem.label).fontSize(13).lineHeight(21).fontColor($r('app.color.text_primary')).layoutWeight(1)
            }.width('100%').alignItems(VerticalAlign.Top)
          }, (actionItem: LexiLocalSuggestion): string => `${actionItem.id}-${actionItem.label}`)
        }
        if (this.arrangement.links.length) {
          Text('已有笔记链接').fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary')).width('100%')
          Flex({ wrap: FlexWrap.Wrap }) {
            ForEach(this.arrangement.links, (linkItem: LexiLocalSuggestion) => {
              Button((this.selectedIds.includes(linkItem.id) ? '✓ ' : '') + linkItem.label, { buttonStyle: ButtonStyleMode.TEXTUAL })
                .height(36).fontSize(12).padding({ left: 10, right: 10 }).margin({ right: 6, bottom: 6 })
                .constraintSize({ maxWidth: '100%' }).backgroundColor(this.selectedIds.includes(linkItem.id) ? $r('app.color.brand_soft') : $r('app.color.soft_surface'))
                .fontColor($r('app.color.brand_ink')).borderRadius(9)
                .onClick((): void => { this.selectSuggestion(linkItem.id, !this.selectedIds.includes(linkItem.id)); })
            }, (linkItem: LexiLocalSuggestion): string => linkItem.id)
          }.width('100%')
        }
        if (this.arrangement.tags.length) {
          Text('标签建议').fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary')).width('100%')
          Flex({ wrap: FlexWrap.Wrap }) {
            ForEach(this.arrangement.tags, (tagItem: LexiLocalSuggestion) => {
              Button((this.selectedIds.includes(tagItem.id) ? '✓ ' : '') + tagItem.label, { buttonStyle: ButtonStyleMode.TEXTUAL })
                .height(34).fontSize(12).padding({ left: 10, right: 10 }).margin({ right: 6, bottom: 6 })
                .backgroundColor(this.selectedIds.includes(tagItem.id) ? $r('app.color.brand_soft') : $r('app.color.soft_surface'))
                .fontColor($r('app.color.brand_ink')).borderRadius(9)
                .onClick((): void => { this.selectSuggestion(tagItem.id, !this.selectedIds.includes(tagItem.id)); })
            }, (tagItem: LexiLocalSuggestion): string => tagItem.id)
          }.width('100%')
        }
        Button('插入所选建议').id('capture-arrange-insert').width('100%').height(42).fontSize(14)
          .enabled(!!this.selectedMarkdown()).onClick((): void => { this.insertArrangement(); })
      }
    }.width('100%').alignItems(HorizontalAlign.Start)
  }

  build() {
    Column({ space: 14 }) {
      Row() {
        Text('语音与本地整理').fontSize(18).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary')).layoutWeight(1)
        Button('关闭', { buttonStyle: ButtonStyleMode.TEXTUAL }).id('capture-panel-close').fontSize(13).height(38)
          .onClick((): void => { this.closePanel(); })
      }.width('100%')
      Row({ space: 6 }) {
        Button('语音速记', { buttonStyle: ButtonStyleMode.TEXTUAL }).id('capture-tab-speech').layoutWeight(1).height(40).fontSize(14)
          .backgroundColor(this.panelKind === 'speech' ? $r('app.color.brand_soft') : Color.Transparent)
          .fontColor($r('app.color.brand_ink')).onClick((): void => { this.panelKind = 'speech'; })
        Button('本地整理', { buttonStyle: ButtonStyleMode.TEXTUAL }).id('capture-tab-arrange').layoutWeight(1).height(40).fontSize(14)
          .enabled(!this.activeSpeech()).backgroundColor(this.panelKind === 'arrange' ? $r('app.color.brand_soft') : Color.Transparent)
          .fontColor($r('app.color.brand_ink')).onClick((): void => { this.panelKind = 'arrange'; })
      }.width('100%')
      Scroll() {
        Column() {
          if (this.panelKind === 'speech') { this.speechContent(); } else { this.arrangementContent(); }
        }.width('100%').padding({ bottom: 20 })
      }.width('100%').layoutWeight(1).align(Alignment.TopStart)
      Text('语音与笔记内容均在本机处理。选择“插入”才会写入正文。')
        .fontSize(11).lineHeight(18).fontColor($r('app.color.text_secondary')).width('100%')
    }.width('100%').height('100%').padding({ left: 20, right: 20, top: 12, bottom: 20 })
  }
}
