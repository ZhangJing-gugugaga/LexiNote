import {
  NoteItem,
  NoteLink
} from '../core/LexiModels';
import { MarkdownEngine } from '../core/MarkdownEngine';
import { LexiIcon } from './LexiIcon';
import { LexiHeroHeading, LexiNoteCard } from './LexiNoteCard';

@Component
struct LexiHomeMetric {
  @Prop labelText: string = '';
  @Prop metricValue: number = 0;

  build() {
    Column({ space: 4 }) {
      Text(`${this.metricValue}`).fontSize(20).fontWeight(FontWeight.Bold).fontColor($r('app.color.brand'))
      Text(this.labelText).fontSize(12).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_secondary'))
    }.layoutWeight(1).padding(12).backgroundColor($r('app.color.surface')).borderRadius(18)
      .alignItems(HorizontalAlign.Start)
  }
}

@Component
export struct LexiHomeTab {
  @Prop isWide: boolean = false;
  @Prop pagePadding: number = 24;
  @Prop bottomInset: number = 0;
  @Prop titleCollapsed: boolean = false;
  @Prop activeVaultName: string = '个人知识库';
  @Prop @Watch('recompute') notes: NoteItem[] = [];
  @Prop @Watch('recompute') links: NoteLink[] = [];
  @Prop mapCount: number = 0;
  @Prop canvasCount: number = 0;
  @Prop quickText: string = '';
  @Prop quickSaving: boolean = false;
  @State private activeList: NoteItem[] = [];
  @State private pinnedList: NoteItem[] = [];
  @State private recentList: NoteItem[] = [];
  @State private resolvedLinks: number = 0;
  private outgoingMap: Map<string, number> = new Map<string, number>();
  private backlinkMap: Map<string, number> = new Map<string, number>();
  onQuickTextChange: (val: string) => void = (_val: string): void => {};
  onSaveQuick: () => void = () => {};
  onExpandQuick: () => void = () => {};
  onOpenNote: (noteId: string) => void = (_noteId: string): void => {};
  onFilterTag: (tag: string) => void = (_tag: string): void => {};
  onTogglePin: (note: NoteItem) => void = (_note: NoteItem): void => {};
  onToggleFavorite: (note: NoteItem) => void = (_note: NoteItem): void => {};
  onMoveToTrash: (note: NoteItem) => void = (_note: NoteItem): void => {};
  onRestoreNote: (note: NoteItem) => void = (_note: NoteItem): void => {};
  onDeleteForever: (note: NoteItem) => void = (_note: NoteItem): void => {};
  onViewAllNotes: () => void = () => {};
  onOpenDaily: () => void = (): void => {};
  onOpenTemplates: () => void = (): void => {};
  onOpenAi: () => void = (): void => {};

  aboutToAppear(): void {
    this.recompute();
  }

  private recompute(): void {
    const active = this.notes.filter((n: NoteItem): boolean => n.trashedAt === 0);
    this.activeList = active;
    this.pinnedList = active.filter((n: NoteItem): boolean => n.pinned);
    this.recentList = active
      .filter((n: NoteItem): boolean => !n.pinned)
      .slice()
      .sort((a: NoteItem, b: NoteItem): number => b.updatedAt - a.updatedAt)
      .slice(0, 5);
    const outMap = new Map<string, number>();
    const backMap = new Map<string, number>();
    const activeIds = new Set<string>(active.map((note: NoteItem): string => note.id));
    let resolved = 0;
    for (let i = 0; i < this.links.length; i++) {
      const l = this.links[i];
      if (l.targetId.length > 0 && activeIds.has(l.sourceId) && activeIds.has(l.targetId)) {
        resolved++;
        outMap.set(l.sourceId, (outMap.get(l.sourceId) ?? 0) + 1);
        backMap.set(l.targetId, (backMap.get(l.targetId) ?? 0) + 1);
      }
    }
    this.outgoingMap = outMap;
    this.backlinkMap = backMap;
    this.resolvedLinks = resolved;
  }

  private backlinkCount(noteId: string): number {
    return this.backlinkMap.get(noteId) ?? 0;
  }

  private outgoingCount(noteId: string): number {
    return this.outgoingMap.get(noteId) ?? 0;
  }

  private greeting(): string {
    const hour = new Date().getHours();
    if (hour < 5) {
      return '夜深了';
    }
    if (hour < 11) {
      return '早上好';
    }
    if (hour < 14) {
      return '中午好';
    }
    if (hour < 18) {
      return '下午好';
    }
    return '晚上好';
  }

  @Builder
  renderNoteCard(note: NoteItem) {
    LexiNoteCard({
      note: note,
      query: '',
      outgoingCount: this.outgoingCount(note.id),
      backlinkCount: this.backlinkCount(note.id),
      onOpen: (id: string): void => {
        this.onOpenNote(id);
      },
      onFilterTag: (tag: string): void => {
        this.onFilterTag(tag);
      },
      onTogglePin: (n: NoteItem): void => {
        this.onTogglePin(n);
      },
      onToggleFavorite: (n: NoteItem): void => {
        this.onToggleFavorite(n);
      },
      onMoveToTrash: (n: NoteItem): void => {
        this.onMoveToTrash(n);
      },
      onRestore: (n: NoteItem): void => {
        this.onRestoreNote(n);
      },
      onDeleteForever: (n: NoteItem): void => {
        this.onDeleteForever(n);
      }
    })
  }

  build() {
    Column({ space: 16 }) {
      if (this.isWide) {
        LexiHeroHeading({
          headingId: 'primary-heading-0',
          title: this.greeting(),
          subtitle: this.activeVaultName,
          isWide: this.isWide,
          collapsed: this.titleCollapsed
        })
      }

      // Keep quick capture compact so recent notes are visible on the home screen.
      Row({ space: 8 }) {
        Button('今日笔记', { type: ButtonType.Normal }).id('home-daily-note').layoutWeight(1).height(44)
          .fontSize(13).borderRadius(16).backgroundColor($r('app.color.brand')).fontColor($r('app.color.inverse_text'))
          .onClick(this.onOpenDaily)
        Button('从模板新建', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
          .id('home-templates').layoutWeight(1).height(44).fontSize(13).borderRadius(16)
          .backgroundColor($r('app.color.surface')).fontColor($r('app.color.brand_ink')).onClick(this.onOpenTemplates)
        Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
          Row({ space: 5 }) {
            LexiIcon({ name: 'spark', iconSize: 16 })
            Text('AI 助手')
              .fontSize(13)
              .fontWeight(FontWeight.Bold)
              .fontColor($r('app.color.brand_ink'))
          }
        }
        .id('home-ai-harness')
        .layoutWeight(1)
        .height(44)
        .borderRadius(16)
        .backgroundColor($r('app.color.soft_surface'))
        .onClick(this.onOpenAi)
      }.width('100%')
      Column({ space: 10 }) {
        Row() {
          Row({ space: 6 }) {
            LexiIcon({ name: 'note', iconSize: 18 })
            Text('随手记')
              .fontSize(14)
              .fontWeight(FontWeight.Bold)
              .fontColor($r('app.color.text_primary'))
          }
          Blank()
          Button('完整编辑 →', { buttonStyle: ButtonStyleMode.TEXTUAL })
            .height(28)
            .fontSize(12)
            .fontColor($r('app.color.brand'))
            .onClick(() => {
              this.onExpandQuick();
            })
        }
        .width('100%')

        TextArea({
          text: this.quickText,
          placeholder: '记录想法或待办…'
        })
          .id('home-quick-input')
          .width('100%')
          .height(this.isWide ? 88 : 112)
          .fontSize(14)
          .fontColor($r('app.color.text_primary'))
          .placeholderColor($r('app.color.text_secondary'))
          .caretColor($r('app.color.brand'))
          .backgroundColor($r('app.color.soft_surface'))
          .borderRadius(16)
          .onChange((val: string) => {
            this.onQuickTextChange(val);
          })

        Row() {
          Blank()
          Button(this.quickSaving ? '保存中…' : '随手记下', { type: ButtonType.Normal })
            .id('home-quick-save')
            .height(36)
            .padding({ left: 16, right: 16 })
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .borderRadius(12)
            .backgroundColor($r('app.color.brand'))
            .fontColor($r('app.color.inverse_text'))
            .onClick(() => {
              this.onSaveQuick();
            })
        }
        .width('100%')
      }
      .width('100%')
      .padding(18)
      .backgroundColor($r('app.color.surface'))
      .borderRadius(24)

      if (this.activeList.length > 0 || this.mapCount > 0 || this.canvasCount > 0) {
        Row({ space: 8 }) {
          LexiHomeMetric({ labelText: '笔记', metricValue: this.activeList.length })
          LexiHomeMetric({ labelText: '链接', metricValue: this.resolvedLinks })
          LexiHomeMetric({ labelText: '导图', metricValue: this.mapCount })
          LexiHomeMetric({ labelText: '白板', metricValue: this.canvasCount })
        }.width('100%')
      }

      if (this.pinnedList.length > 0) {
        Column({ space: 10 }) {
          Text('置顶')
            .fontSize(15)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
            .width('100%')
          ForEach(
            this.pinnedList,
            (note: NoteItem) => {
              this.renderNoteCard(note)
            },
            (note: NoteItem): string => `pin-${note.id}-${note.updatedAt}`
          )
        }
        .width('100%')
      }

      if (this.activeList.length > 0) {
        Column({ space: 10 }) {
          Row() {
            Text('最近笔记').fontSize(15).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
            Blank()
            Button('全部笔记 →', { buttonStyle: ButtonStyleMode.TEXTUAL })
              .fontSize(12).fontColor($r('app.color.brand')).onClick((): void => { this.onViewAllNotes(); })
          }.width('100%')
          ForEach(this.recentList, (note: NoteItem) => { this.renderNoteCard(note); },
            (note: NoteItem): string => `recent-${note.id}-${note.updatedAt}`)
        }.width('100%')
      }
    }
    .width('100%')
    .constraintSize({ maxWidth: 1080 })
    .padding({ left: this.pagePadding, right: this.pagePadding, bottom: (this.isWide ? 36 : 88) + this.bottomInset })
  }
}
