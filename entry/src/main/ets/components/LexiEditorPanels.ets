import { MarkdownBlock, NoteItem, NoteLink, OutlineHeading } from '../core/LexiModels';
import { LexiIcon } from './LexiIcon';
import { MarkdownEngine, LexiMarkdownInlineSpan } from '../core/MarkdownEngine';
import { pasteboard } from '@kit.BasicServicesKit';
import { common } from '@kit.AbilityKit';
import { LexiCodeHighlight, LexiCodeToken } from '../core/LexiCodeHighlight';
import { LexiCodeTools } from '../core/LexiCodeTools';
import { LexiPluginManager } from '../core/plugin/LexiPluginRuntime';
import { LexiPluginCodeBlockSlot } from './plugin/LexiPluginCodeBlockSlot';

@Component
export struct LexiOutlinePanel {
  @Prop headings: OutlineHeading[] = [];
  onConvertToMindMap: () => void = () => {};

  build() {
    Column({ space: 8 }) {
      Row() {
        Text('文档结构大纲')
          .fontSize(14)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
        Blank()
        Button('转为思维导图 →', { buttonStyle: ButtonStyleMode.TEXTUAL })
          .fontSize(12)
          .fontColor($r('app.color.brand'))
          .onClick(() => {
            this.onConvertToMindMap();
          })
      }
      .width('100%')

      if (this.headings.length === 0) {
        Text('在正文中使用 # / ## / ### 添加标题即可自动生成结构大纲。')
          .fontSize(12)
          .fontColor($r('app.color.text_secondary'))
      } else {
        ForEach(
          this.headings,
          (h: OutlineHeading) => {
            Row({ space: 8 }) {
              Text(`H${h.level}`)
                .fontSize(10)
                .fontWeight(FontWeight.Bold)
                .fontColor($r('app.color.brand'))
                .padding({ left: 6, right: 6, top: 2, bottom: 2 })
                .backgroundColor($r('app.color.brand_soft'))
                .borderRadius(6)
              Text(h.title)
                .fontSize(13)
                .fontColor($r('app.color.text_primary'))
                .maxLines(1)
            }
            .width('100%')
            .padding({ left: (h.level - 1) * 14, top: 4, bottom: 4 })
          },
          (h: OutlineHeading): string => h.id
        )
      }
    }
    .width('100%')
    .padding(16)
    .backgroundColor($r('app.color.surface'))
    .borderRadius(18)
  }
}

@Component
export struct LexiRelationsPanel {
  @Prop outgoingLinks: NoteLink[] = [];
  @Prop backlinks: NoteLink[] = [];
  onOpenTarget: (targetIdOrTitle: string) => void = (_target: string): void => {};
  onConvertToMindMap: () => void = () => {};

  build() {
    Column({ space: 12 }) {
      Row() {
        Text('知识关联与反向引用')
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
        Blank()
      }
      .width('100%')

      Text(`正向链接 (${this.outgoingLinks.length})`)
        .fontSize(12)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
      if (this.outgoingLinks.length === 0) {
        Text('暂无正向链接')
          .fontSize(12)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
      } else {
        Flex({ wrap: FlexWrap.Wrap }) {
          ForEach(
            this.outgoingLinks,
            (link: NoteLink) => {
              Button(`↗ ${link.targetTitle}`, { type: ButtonType.Normal })
                .height(34)
                .margin({ right: 8, bottom: 8 })
                .padding({ left: 12, right: 12 })
                .fontSize(12)
                .borderRadius(10)
                .backgroundColor($r('app.color.brand_soft'))
                .fontColor($r('app.color.brand'))
                .onClick(() => {
                  this.onOpenTarget((link.targetId || link.targetTitle) + (link.anchor ? `#${link.anchor}` : ''));
                })
            },
            (link: NoteLink): string => `${link.sourceId}->${link.targetTitle}`
          )
        }
        .width('100%')
      }

      Divider().color($r('app.color.divider'))

      Text(`反向引用 (${this.backlinks.length})`)
        .fontSize(12)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
      if (this.backlinks.length === 0) {
        Text('暂无反向引用')
          .fontSize(12)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
      } else {
        ForEach(
          this.backlinks,
          (backlink: NoteLink) => {
            Row({ space: 10 }) {
              LexiIcon({ name: 'link', iconSize: 18 })
              Column({ space: 2 }) {
                Text(backlink.sourceTitle)
                  .fontSize(13)
                  .fontWeight(FontWeight.Medium)
                  .fontColor($r('app.color.text_primary'))
                Text(`通过 [[${backlink.targetTitle}]] 引用了本笔记`)
                  .fontSize(11)
                  .fontColor($r('app.color.text_secondary'))
              }
              .layoutWeight(1)
              .alignItems(HorizontalAlign.Start)
              Button('跳转', { buttonStyle: ButtonStyleMode.TEXTUAL })
                .fontSize(12)
                .fontColor($r('app.color.brand'))
                .onClick(() => {
                  this.onOpenTarget(backlink.sourceId);
                })
            }
            .width('100%')
            .padding(12)
            .backgroundColor($r('app.color.soft_surface'))
            .borderRadius(14)
          },
          (backlink: NoteLink): string => `${backlink.sourceId}<-${backlink.targetTitle}`
        )
      }
    }
    .width('100%')
    .padding(16)
    .backgroundColor($r('app.color.surface'))
    .borderRadius(18)
  }
}

class LexiPreviewTableCell {
  id: string = '';
  text: string = '';
  alignment: string = 'left';
}

class LexiPreviewTableRow {
  id: string = '';
  header: boolean = false;
  stripe: boolean = false;
  cells: LexiPreviewTableCell[] = [];
}

@Component
struct LexiPreviewInlineText {
  @Prop sourceText: string = '';
  @Prop textSize: number = 16;
  @Prop textLeading: number = 27;
  @Prop strong: boolean = false;
  @Prop muted: boolean = false;
  @Prop checked: boolean = false;
  @Prop raw: boolean = false;
  @Prop cellAlignment: string = 'left';
  onOpenTarget: (target: string) => void = (_target: string): void => {};
  onEditText: () => void = (): void => {};
  onInteractiveAction: () => void = (): void => {};

  private segments(): LexiMarkdownInlineSpan[] {
    if (this.raw) {
      const plain = new LexiMarkdownInlineSpan(); plain.id = 'raw'; plain.text = this.sourceText;
      return [plain];
    }
    return MarkdownEngine.inlineSpans(this.sourceText);
  }

  private activate(segment: LexiMarkdownInlineSpan): void {
    if (segment.kind !== 'link' && segment.kind !== 'url') { this.onEditText(); return; }
    this.onInteractiveAction();
    if (segment.kind === 'link') { this.onOpenTarget(segment.target); }
    if (segment.kind === 'url') {
      if (!/^https?:\/\//i.test(segment.target) && !/^mailto:/i.test(segment.target)) {
        this.onOpenTarget(segment.target.replace(/\.md(?=#|$)/i, '')); return;
      }
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      context.startAbility({ action: 'ohos.want.action.viewData', uri: segment.target })
        .catch((): void => { this.getUIContext().getPromptAction().showToast({ message: '无法打开此链接' }); });
    }
  }

  build() {
    Text() {
      ForEach(this.segments(), (segment: LexiMarkdownInlineSpan) => {
        Span(segment.text)
          .fontWeight(this.strong || segment.kind === 'bold' ? FontWeight.Bold : FontWeight.Regular)
          .fontStyle(segment.kind === 'italic' ? FontStyle.Italic : FontStyle.Normal)
          .fontFamily(this.raw || segment.kind === 'code' ? 'monospace' : 'HarmonyOS Sans')
          .fontColor(segment.kind === 'link' || segment.kind === 'url' ? $r('app.color.brand_ink') : this.muted || this.checked ? $r('app.color.text_secondary') : $r('app.color.text_primary'))
          .textBackgroundStyle({ color: segment.kind === 'highlight' ? $r('app.color.brand_soft') : segment.kind === 'code' ? $r('app.color.soft_surface') : Color.Transparent, radius: 3 })
          .decoration({ type: segment.kind === 'strike' || this.checked ? TextDecorationType.LineThrough : segment.kind === 'link' || segment.kind === 'url' ? TextDecorationType.Underline : TextDecorationType.None })
          .onClick((): void => { this.activate(segment); })
      }, (segment: LexiMarkdownInlineSpan): string => segment.id)
    }
    .fontSize(this.textSize)
    .lineHeight(this.textLeading)
    .copyOption(CopyOptions.LocalDevice)
    .textAlign(this.cellAlignment === 'center' ? TextAlign.Center : this.cellAlignment === 'right' ? TextAlign.End : TextAlign.Start)
    .width('100%')
  }
}

@Component
struct LexiPreviewCodeBlock {
  @Prop @Watch('refreshTokens') codeSource: string = '';
  @Prop @Watch('refreshTokens') fencedLanguage: string = '';
  @StorageProp('lexiColorMode') codeColorMode: number = 0;
  @State private codeTokens: LexiCodeToken[] = [];
  @State private languageLabel: string = '未指定语言';
  onCopyCode: () => void = (): void => {};
  onEditCode: () => void = (): void => {};

  aboutToAppear(): void { this.refreshTokens(); }

  private refreshTokens(): void {
    const specified = LexiCodeHighlight.normalizeLanguage(this.fencedLanguage);
    const language = specified || LexiCodeHighlight.normalizeLanguage(LexiCodeTools.detect(this.codeSource));
    this.languageLabel = LexiCodeHighlight.label(language) + (!specified && language ? ' · 自动识别' : '');
    this.codeTokens = LexiCodeHighlight.tokenize(this.codeSource, language);
  }

  build() {
    Column({ space: 8 }) {
      Row() {
        Text(this.languageLabel).fontSize(11).fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.brand_ink')).layoutWeight(1)
        Button('复制代码', { buttonStyle: ButtonStyleMode.TEXTUAL }).fontSize(11).height(28)
          .fontColor($r('app.color.brand_ink')).onClick(this.onCopyCode)
      }.width('100%')
      Text() {
        ForEach(this.codeTokens, (token: LexiCodeToken) => {
          Span(token.text)
            .fontColor(LexiCodeHighlight.color(token.kind, this.codeColorMode === 1))
            .fontWeight(token.kind === 'keyword' ? FontWeight.Medium : FontWeight.Regular)
        }, (token: LexiCodeToken): string => `${token.id}-${token.kind}-${token.text}`)
      }
      .fontFamily('monospace').fontSize(13).lineHeight(21).width('100%')
      .copyOption(CopyOptions.LocalDevice).onClick(this.onEditCode)
    }.width('100%').alignItems(HorizontalAlign.Start)
  }
}

@Component
export struct LexiMarkdownPreview {
  @Prop frameless: boolean = false;
  @Prop anchorPrefix: string = 'markdown-block';
  @Prop blocks: MarkdownBlock[] = [];
  @StorageProp('lexiPluginRevision') private pluginRevision: number = 0;
  @Prop outgoingLinks: NoteLink[] = [];
  @Prop availableNotes: NoteItem[] = [];
  @Prop notePath: string = '';
  @Prop editable: boolean = false;
  onEditBlock: (lineIndex: number) => void = (_line: number): void => {};
  @State private failedImages: string[] = [];
  private lastInteractiveAt: number = 0;
  onOpenTarget: (targetIdOrTitle: string) => void = (_target: string): void => {};
  onToggleTodo: (lineIndex: number) => void = (_lineIndex: number): void => {};

  static pluginCodeBlockOwner(language: string): string {
    return LexiPluginManager.codeBlockPluginFor(language);
  }

  private tableRows(block: MarkdownBlock): LexiPreviewTableRow[] {
    const data = MarkdownEngine.tableData(block);
    return data.rows.map((cells: string[], rowIndex: number): LexiPreviewTableRow => {
      const row = new LexiPreviewTableRow(); row.id = `${block.id}-row-${rowIndex}`;
      row.header = rowIndex === 0; row.stripe = rowIndex % 2 === 0;
      row.cells = cells.map((text: string, columnIndex: number): LexiPreviewTableCell => {
        const cell = new LexiPreviewTableCell(); cell.id = `${row.id}-cell-${columnIndex}`;
        cell.text = text; cell.alignment = data.alignments[columnIndex] || 'left'; return cell;
      });
      return row;
    });
  }

  private embeddedNote(block: MarkdownBlock): NoteItem | undefined {
    const target = block.meta.split('#')[0].trim().replace(/\.md$/i, '').toLowerCase();
    return this.availableNotes.find((note: NoteItem): boolean => note.trashedAt === 0 &&
      (note.id.toLowerCase() === target || note.title.trim().toLowerCase() === target));
  }

  private embeddedText(block: MarkdownBlock): string {
    const note = this.embeddedNote(block);
    if (!note) { return '未找到引用的笔记，点击查找或创建。'; }
    const anchor = block.meta.includes('#') ? block.meta.substring(block.meta.indexOf('#') + 1) : '';
    const body = MarkdownEngine.extractEmbeddedSection(note.content, anchor);
    return body || (anchor ? '未找到对应章节，点击打开原笔记。' : '这篇笔记还没有正文。');
  }

  private imageSource(block: MarkdownBlock): string {
    return MarkdownEngine.resolveImageSource(block.meta, this.notePath);
  }

  private async copyCode(block: MarkdownBlock): Promise<void> {
    try {
      await pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, block.text));
      this.getUIContext().getPromptAction().showToast({ message: '代码已复制' });
    } catch (_) { this.getUIContext().getPromptAction().showToast({ message: '复制失败，请重试' }); }
  }

  build() {
    Column({ space: 12 }) {
      if (!this.frameless && this.outgoingLinks.length > 0) {
        Flex({ wrap: FlexWrap.Wrap }) {
          ForEach(this.outgoingLinks, (link: NoteLink) => {
            Button(`🔗 ${link.displayText || link.targetTitle}`, { type: ButtonType.Normal })
              .height(30).margin({ right: 6, bottom: 6 }).padding({ left: 10, right: 10 })
              .fontSize(11).borderRadius(9).backgroundColor($r('app.color.brand_soft'))
              .fontColor($r('app.color.brand'))
              .onClick((): void => { this.onOpenTarget(`${link.targetId || link.targetTitle}${link.anchor ? '#' + link.anchor : ''}`); })
          }, (link: NoteLink): string => `chip-${link.targetTitle}-${link.anchor}`)
        }.width('100%')
      }
      ForEach(this.blocks, (block: MarkdownBlock) => {
        Column() {
          if (block.kind === 'hr') {
            Divider().color($r('app.color.divider')).strokeWidth(1).margin({ top: 10, bottom: 10 })
          } else if (block.kind === 'table') {
            Scroll() {
              Column() {
                ForEach(this.tableRows(block), (tableRow: LexiPreviewTableRow) => {
                  Row() {
                    ForEach(tableRow.cells, (cell: LexiPreviewTableCell) => {
                      Column() {
                        LexiPreviewInlineText({ sourceText: cell.text, textSize: 13, textLeading: 21,
                          strong: tableRow.header, cellAlignment: cell.alignment, onOpenTarget: this.onOpenTarget,
                onEditText: (): void => { if (this.editable) { this.onEditBlock(block.lineIndex); } },
                onInteractiveAction: (): void => { this.lastInteractiveAt = Date.now(); } })
                      }
                      .width(156).padding(12).constraintSize({ minHeight: 46 })
                      .border({ width: 0.5, color: $r('app.color.divider') })
                      .backgroundColor(tableRow.header ? $r('app.color.brand_soft') : tableRow.stripe ? $r('app.color.soft_surface') : $r('app.color.surface'))
                    }, (cell: LexiPreviewTableCell): string => cell.id)
                  }.alignItems(VerticalAlign.Top)
                }, (tableRow: LexiPreviewTableRow): string => tableRow.id)
              }.alignItems(HorizontalAlign.Start)
            }.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Auto).width('100%')
          } else if (block.kind === 'image') {
            Column({ space: 7 }) {
              if (this.imageSource(block) && !this.failedImages.includes(this.imageSource(block))) {
                Image(this.imageSource(block))
                  .width('100%').constraintSize({ maxHeight: 420 }).objectFit(ImageFit.Contain)
                  .borderRadius(10).accessibilityText(block.text || '笔记图片')
                  .onError((): void => {
                    this.failedImages = this.failedImages.concat(this.imageSource(block));
                  })
              } else {
                Text('图片暂时无法显示').fontSize(13).fontColor($r('app.color.text_secondary')).padding(18)
              }
              if (block.text) {
                Text(block.text).fontSize(12).fontColor($r('app.color.text_secondary'))
              }
            }.width('100%').padding(8).backgroundColor($r('app.color.soft_surface')).borderRadius(12)
          } else if (block.kind === 'embed') {
            Column({ space: 9 }) {
              Row() {
                Text(`↗ ${block.text}`).fontSize(13).fontWeight(FontWeight.Bold).fontColor($r('app.color.brand_ink')).layoutWeight(1)
                Text('引用笔记').fontSize(10).fontColor($r('app.color.text_secondary'))
              }.width('100%')
              LexiPreviewInlineText({ sourceText: this.embeddedText(block), textSize: 14, textLeading: 23,
                onOpenTarget: this.onOpenTarget,
                onEditText: (): void => { if (this.editable) { this.onEditBlock(block.lineIndex); } },
                onInteractiveAction: (): void => { this.lastInteractiveAt = Date.now(); } })
            }.width('100%').padding(16).backgroundColor($r('app.color.soft_surface'))
              .border({ width: 1, color: $r('app.color.divider') }).borderRadius(12)
              .onClick((): void => { this.lastInteractiveAt = Date.now(); this.onOpenTarget(block.meta); })
          } else if (block.kind === 'h1' || block.kind === 'h2' || block.kind === 'h3') {
            LexiPreviewInlineText({ sourceText: block.text, textSize: block.kind === 'h1' ? 24 : block.kind === 'h2' ? 20 : 17,
              textLeading: block.kind === 'h1' ? 34 : 28, strong: true, onOpenTarget: this.onOpenTarget,
                onEditText: (): void => { if (this.editable) { this.onEditBlock(block.lineIndex); } },
                onInteractiveAction: (): void => { this.lastInteractiveAt = Date.now(); } })
          } else if (block.kind === 'todo') {
            Row({ space: 10 }) {
              Checkbox({ name: block.id }).select(block.checked).selectedColor($r('app.color.brand'))
                .onChange((): void => { this.onToggleTodo(block.lineIndex); })
                .onClick((): void => { this.lastInteractiveAt = Date.now(); })
              Column() {
                LexiPreviewInlineText({ sourceText: block.text, textSize: this.frameless ? 16 : 14,
                  textLeading: 26, checked: block.checked, onOpenTarget: this.onOpenTarget,
                onEditText: (): void => { if (this.editable) { this.onEditBlock(block.lineIndex); } },
                onInteractiveAction: (): void => { this.lastInteractiveAt = Date.now(); } })
              }.layoutWeight(1)
            }.width('100%').alignItems(VerticalAlign.Top)
          } else if (block.kind === 'bullet' || block.kind === 'ordered') {
            Row({ space: 9 }) {
              Text(block.kind === 'ordered' ? `${block.meta}.` : '•').fontSize(15)
                .fontWeight(FontWeight.Medium).fontColor($r('app.color.brand')).padding({ top: 2 })
              Column() {
                LexiPreviewInlineText({ sourceText: block.text, textSize: this.frameless ? 16 : 14,
                  textLeading: 26, onOpenTarget: this.onOpenTarget,
                onEditText: (): void => { if (this.editable) { this.onEditBlock(block.lineIndex); } },
                onInteractiveAction: (): void => { this.lastInteractiveAt = Date.now(); } })
              }.layoutWeight(1)
            }.width('100%').alignItems(VerticalAlign.Top)
          } else if (block.kind === 'quote' || block.kind === 'callout') {
            Column({ space: 6 }) {
              if (block.kind === 'callout') {
                Text(`✦ ${block.meta || 'NOTE'}`).fontSize(11).fontWeight(FontWeight.Bold).fontColor($r('app.color.brand'))
              }
              LexiPreviewInlineText({ sourceText: block.text, textSize: 14, textLeading: 23,
                muted: block.kind === 'quote', onOpenTarget: this.onOpenTarget,
                onEditText: (): void => { if (this.editable) { this.onEditBlock(block.lineIndex); } },
                onInteractiveAction: (): void => { this.lastInteractiveAt = Date.now(); } })
            }.width('100%').padding(14).backgroundColor($r('app.color.brand_soft')).borderRadius(12)
              .alignItems(HorizontalAlign.Start)
          } else if (block.kind === 'code' || block.kind === 'formula') {
            Column({ space: 8 }) {
              if (block.kind === 'code') {
                if (this.pluginRevision >= 0 && LexiMarkdownPreview.pluginCodeBlockOwner(block.meta).length > 0) {
                  LexiPluginCodeBlockSlot({
                    pluginId: LexiMarkdownPreview.pluginCodeBlockOwner(block.meta),
                    language: block.meta,
                    source: block.text
                  })
                } else {
                LexiPreviewCodeBlock({ codeSource: block.text, fencedLanguage: block.meta,
                  onCopyCode: (): void => { this.lastInteractiveAt = Date.now(); this.copyCode(block); },
                  onEditCode: (): void => {
                    if (this.editable) { this.lastInteractiveAt = Date.now(); this.onEditBlock(block.lineIndex); }
                  } })
                }
              } else {
              Row() {
                Text('LaTeX')
                  .fontSize(10).fontWeight(FontWeight.Bold).fontColor($r('app.color.brand'))
                Blank()
              }.width('100%')
              LexiPreviewInlineText({ sourceText: block.text, textSize: 13, textLeading: 21, raw: true,
                onEditText: (): void => { if (this.editable) { this.onEditBlock(block.lineIndex); } } })
              }
            }.width('100%').padding(14).backgroundColor($r('app.color.soft_surface')).borderRadius(12)
          } else {
            LexiPreviewInlineText({ sourceText: block.text, textSize: this.frameless ? 16 : 14,
              textLeading: this.frameless ? 28 : 23, onOpenTarget: this.onOpenTarget,
                onEditText: (): void => { if (this.editable) { this.onEditBlock(block.lineIndex); } },
                onInteractiveAction: (): void => { this.lastInteractiveAt = Date.now(); } })
          }
        }.width('100%').alignItems(HorizontalAlign.Start).id(`${this.anchorPrefix}-${block.lineIndex}`)
          .onClick((): void => { if (this.editable && Date.now() - this.lastInteractiveAt > 150) { this.onEditBlock(block.lineIndex); } })
      }, (block: MarkdownBlock): string => `${block.id}-${block.kind}-${block.text}-${block.meta}-${block.checked}`)
    }
    .width('100%').padding(this.frameless ? 0 : 18)
    .backgroundColor(this.frameless ? Color.Transparent : $r('app.color.surface'))
    .borderRadius(this.frameless ? 0 : 22).alignItems(HorizontalAlign.Start)
  }
}
