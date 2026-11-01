import { deviceInfo } from '@kit.BasicServicesKit';
import { NoteItem } from '../core/LexiModels';
import { MarkdownEngine, LexiMarkdownInlineSpan } from '../core/MarkdownEngine';
import { LexiContextSurface } from './LexiContextSurface';
import { LexiContextBridge, LexiContextTarget, LexiContextAction } from '../core/LexiContextModels';
import { LexiIcon } from './LexiIcon';

@Component
export struct LexiFilterChip {
  @Prop selected: boolean = false;
  @Prop label: string = '';
  action: () => void = () => {};

  build() {
    Button(this.label, { type: ButtonType.Normal })
      .height(36)
      .padding({ left: 15, right: 15 })
      .fontSize(12)
      .borderRadius(13)
      .backgroundColor(this.selected ? $r('app.color.brand') : $r('app.color.surface'))
      .fontColor(this.selected ? $r('app.color.inverse_text') : $r('app.color.text_secondary'))
      .accessibilitySelected(this.selected)
      .onClick(() => {
        this.action();
      })
  }
}

@Component
export struct LexiHeroHeading {
  @Prop headingId: string = '';
  @Prop title: string = '';
  @Prop subtitle: string = '';
  @Prop isWide: boolean = false;
  @Prop collapsed: boolean = false;

  build() {
    Column({ space: 6 }) {
      Text(this.title)
        .fontSize(this.isWide ? 30 : 26)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_primary'))
      if (this.subtitle.length > 0) {
        Text(this.subtitle)
          .fontSize(13)
          .lineHeight(20)
          .fontColor($r('app.color.text_secondary'))
      }
    }
    .id(this.headingId)
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .margin({ top: 4, bottom: 4 })
    .opacity(this.collapsed ? 0 : 1)
    .animation({ duration: 160, curve: Curve.EaseOut })
  }
}

@Component
export struct LexiNoteCard {
  @Prop note: NoteItem = new NoteItem();
  @Prop query: string = '';
  @Prop outgoingCount: number = 0;
  @Prop backlinkCount: number = 0;
  onOpen: (noteId: string) => void = (_noteId: string): void => {};
  onFilterTag: (tag: string) => void = (_tag: string): void => {};
  onTogglePin: (note: NoteItem) => void = (_note: NoteItem): void => {};
  onToggleFavorite: (note: NoteItem) => void = (_note: NoteItem): void => {};
  onMoveToTrash: (note: NoteItem) => void = (_note: NoteItem): void => {};
  onRestore: (note: NoteItem) => void = (_note: NoteItem): void => {};
  onDeleteForever: (note: NoteItem) => void = (_note: NoteItem): void => {};

  private typeLabel(type: string): string {
    return type === 'study' ? '学习' : type === 'markdown' ? 'Markdown' : '速记';
  }

  private typeIcon(type: string): string {
    return type === 'study' ? 'study' : type === 'markdown' ? 'markdown' : 'note';
  }

  private dateLabel(time: number): string {
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

  private buildMenu(): MenuElement[] {
    if (this.note.trashedAt > 0) {
      return [
        {
          value: '恢复笔记',
          action: (): void => {
            this.onRestore(this.note);
          }
        },
        {
          value: '永久删除',
          action: (): void => {
            this.onDeleteForever(this.note);
          }
        }
      ];
    }
    return LexiContextBridge.actions(LexiContextTarget.note(this.note), false).map((entry: LexiContextAction): MenuElement => {
      return { value: entry.label, action: (): void => { LexiContextBridge.send(entry.id, LexiContextTarget.note(this.note)); } };
    });
  }

  build() {
    LexiContextSurface({ target: LexiContextTarget.note(this.note), contextEnabled: this.note.trashedAt === 0, tabletCard: true }) {
    Column({ space: 10 }) {
      Row({ space: 6 }) {
        LexiIcon({ name: this.typeIcon(this.note.noteType), iconSize: 16 })
        Text(this.typeLabel(this.note.noteType))
          .fontSize(11)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.brand'))
          .padding({ left: 8, right: 8, top: 3, bottom: 3 })
          .backgroundColor($r('app.color.brand_soft'))
          .borderRadius(8)

        Text(this.note.notebook)
          .fontSize(11)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(1)

        Blank()

        if (this.note.pinned) {
          LexiIcon({ name: 'pin', iconSize: 14 })
        }
        if (this.note.favorite) {
          LexiIcon({ name: 'star', iconSize: 14 })
        }
        Text(this.dateLabel(this.note.updatedAt))
          .fontSize(11)
          .fontColor($r('app.color.text_secondary'))

        if (deviceInfo.deviceType === 'tablet' && this.note.trashedAt === 0) { Blank().width(28); } else {
        Button('⋯', { buttonStyle: ButtonStyleMode.TEXTUAL })
          .width(28)
          .height(26)
          .padding(0)
          .fontSize(14)
          .fontColor($r('app.color.text_secondary'))
          .bindMenu(this.buildMenu())
        }
      }
      .width('100%')

      Text(MarkdownEngine.displayTitle(this.note))
        .fontSize(16)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_primary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')

      Text() {
        ForEach(MarkdownEngine.previewSpans(this.note, this.query), (span: LexiMarkdownInlineSpan) => {
          Span(span.text)
            .fontWeight(span.kind === 'bold' ? FontWeight.Bold : FontWeight.Regular)
            .fontStyle(span.kind === 'italic' ? FontStyle.Italic : FontStyle.Normal)
            .fontFamily(span.kind === 'code' ? 'monospace' : 'HarmonyOS Sans')
            .fontColor(span.kind === 'link' || span.kind === 'url' ? $r('app.color.brand_ink') : $r('app.color.text_secondary'))
            .textBackgroundStyle({ color: span.kind === 'highlight' ? $r('app.color.brand_soft') : Color.Transparent, radius: 3 })
            .decoration({ type: span.kind === 'strike' ? TextDecorationType.LineThrough : TextDecorationType.None })
        }, (span: LexiMarkdownInlineSpan): string => span.id)
      }
        .fontSize(14)
        .lineHeight(22)
        .fontColor($r('app.color.text_secondary'))
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')

      Row({ space: 6 }) {
        ForEach(
          this.note.tags.slice(0, 3),
          (tag: string) => {
            Text(`#${tag}`)
              .fontSize(11)
              .fontColor($r('app.color.brand_ink'))
              .padding({ left: 8, right: 8, top: 3, bottom: 3 })
              .backgroundColor($r('app.color.soft_surface'))
              .borderRadius(7)
              .onClick(() => {
                this.onFilterTag(tag);
              })
          },
          (tag: string): string => `${this.note.id}-tag-${tag}`
        )

        Blank()

        if (this.outgoingCount > 0 || this.backlinkCount > 0) {
          Text(`🔗 ${this.outgoingCount} 出 · ${this.backlinkCount} 反`)
            .fontSize(11)
            .fontColor($r('app.color.brand'))
        }
      }
      .width('100%')

      if (this.note.trashedAt > 0) {
        Row({ space: 8 }) {
          Button('恢复笔记', { type: ButtonType.Normal })
            .layoutWeight(1)
            .height(34)
            .fontSize(12)
            .borderRadius(10)
            .backgroundColor($r('app.color.brand_soft'))
            .fontColor($r('app.color.brand'))
            .onClick(() => {
              this.onRestore(this.note);
            })
          Button('永久删除', { type: ButtonType.Normal })
            .layoutWeight(1)
            .height(34)
            .fontSize(12)
            .borderRadius(10)
            .backgroundColor($r('app.color.soft_surface'))
            .fontColor($r('app.color.error'))
            .onClick(() => {
              this.onDeleteForever(this.note);
            })
        }
        .width('100%')
      }
    }
    .width('100%')
    .padding(16)
    .backgroundColor($r('app.color.surface'))
    .borderRadius(20)
    .alignItems(HorizontalAlign.Start)
    .onClick(() => {
      if (this.note.trashedAt === 0) {
        this.onOpen(this.note.id);
      }
    })
    }
  }
}
