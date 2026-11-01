import { GraphEdge, GraphNode, MindMapDoc, NoteItem, NoteLink, UnlinkedMention } from '../core/LexiModels';
import { LexiRelations, RelatedContent } from '../core/LexiRelations';
import { LexiGraphView } from './LexiGraphView';
import { LexiIcon } from './LexiIcon';
import { LexiHeroHeading } from './LexiNoteCard';

@Component
struct RelationRow {
  @Prop contentId: string = '';
  @Prop title: string = '';
  @Prop subtitle: string = '';
  @Prop detail: string = '';
  @Prop icon: string = 'note';
  action: () => void = (): void => {};

  build() {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 12 }) {
        Row() { LexiIcon({ name: this.icon, iconSize: 21 }) }
          .width(42).height(42).justifyContent(FlexAlign.Center)
          .backgroundColor($r('app.color.brand_soft')).borderRadius(13)
        Column({ space: 5 }) {
          Text(this.title).fontSize(15).fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary')).maxLines(2).textAlign(TextAlign.Start)
          Text(this.subtitle).fontSize(12).fontColor($r('app.color.text_secondary'))
            .maxLines(2).lineHeight(18).textAlign(TextAlign.Start)
          if (this.detail) {
            Text(this.detail).fontSize(12).fontColor($r('app.color.brand')).maxLines(1)
          }
        }.layoutWeight(1).alignItems(HorizontalAlign.Start)
        LexiIcon({ name: 'chevron', iconSize: 16, muted: true })
      }.width('100%').padding(14)
    }
    .id(`relation-row-${this.contentId}`).width('100%').constraintSize({ minHeight: 76 })
    .backgroundColor($r('app.color.surface')).borderRadius(18)
    .accessibilityText(`${this.title}，${this.subtitle}，${this.detail}`)
    .onClick(this.action)
  }
}

@Component
export struct LexiExploreTab {
  @Prop isWide: boolean = false;
  @Prop pagePadding: number = 24;
  @Prop bottomInset: number = 0;
  @Prop titleCollapsed: boolean = false;
  @Prop scopeLabel: string = '';
  @Prop @Watch('recompute') notes: NoteItem[] = [];
  @Prop @Watch('recompute') maps: MindMapDoc[] = [];
  @Prop @Watch('recompute') links: NoteLink[] = [];
  @Prop graphNodes: GraphNode[] = [];
  @Prop graphEdges: GraphEdge[] = [];
  @Prop fullGraphNodes: GraphNode[] = [];
  @Prop graphScope: string = 'global';
  @Prop graphShowMaps: boolean = true;
  @Prop graphShowTags: boolean = false;
  @Prop selectedGraphId: string = '';
  @Prop mentions: UnlinkedMention[] = [];
  @State private view: string = 'list';
  @State private showAllNotes: boolean = false;
  @State private showAllMentions: boolean = false;
  @State private cachedContents: GraphNode[] = [];
  @State private cachedChoices: GraphNode[] = [];
  @State private cachedConnected: GraphNode[] = [];
  private relationCountMap: Map<string, number> = new Map<string, number>();
  onSetScope: (scope: string) => void = (_scope: string): void => {};
  onToggleMaps: (enabled: boolean) => void = (_enabled: boolean): void => {};
  onToggleTags: (enabled: boolean) => void = (_enabled: boolean): void => {};
  onSelectNode: (id: string) => void = (_id: string): void => {};
  onOpenNode: (id: string) => void = (_id: string): void => {};
  onOpenNote: (noteId: string) => void = (_noteId: string): void => {};
  onLinkMention: (mention: UnlinkedMention) => void = (_mention: UnlinkedMention): void => {};
  onCreateNote: () => void = (): void => {};

  aboutToAppear(): void {
    this.recompute();
  }

  private recompute(): void {
    const contents = LexiRelations.contents(this.notes, this.maps);
    const counts = LexiRelations.counts(contents, this.maps, this.links);
    const choices = contents
      .filter((node: GraphNode): boolean => node.kind === 'note')
      .sort((a: GraphNode, b: GraphNode): number => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));
    const connected = choices.filter((node: GraphNode): boolean => (counts.get(node.id) ?? 0) > 0);
    this.relationCountMap = counts;
    this.cachedContents = contents;
    this.cachedChoices = choices;
    this.cachedConnected = connected;
  }

  private selected(): GraphNode | undefined {
    return this.cachedContents.concat(this.fullGraphNodes).find((node: GraphNode): boolean => node.id === this.selectedGraphId);
  }
  private related(id: string): RelatedContent[] {
    return LexiRelations.connected(id, this.cachedContents, this.maps, this.links);
  }
  private relationCount(id: string): number {
    return this.relationCountMap.get(id) ?? 0;
  }
  private visibleNotes(): GraphNode[] {
    const choices = this.cachedConnected.length > 0 ? this.cachedConnected : this.cachedChoices;
    return this.showAllNotes ? choices : choices.slice(0, 6);
  }
  private select(id: string): void {
    this.onSelectNode(id);
  }

  @Builder
  private graphOptions() {
    Menu() {
      MenuItem({ content: this.graphShowMaps ? '✓ 包含思维导图' : '包含思维导图' })
        .onClick(() => { this.onToggleMaps(!this.graphShowMaps); })
      MenuItem({ content: this.graphShowTags ? '✓ 包含标签' : '包含标签' })
        .onClick(() => { this.onToggleTags(!this.graphShowTags); })
    }
  }

  @Builder
  private startHint() {
    Column({ space: 14 }) {
      Row({ space: 12 }) {
        Row() { LexiIcon({ name: 'note', iconSize: 22 }) }
          .width(52).height(58).justifyContent(FlexAlign.Center)
          .backgroundColor($r('app.color.surface')).borderRadius(14).rotate({ angle: -6 })
        LexiIcon({ name: 'link', iconSize: 24 })
        Row() { LexiIcon({ name: 'note', iconSize: 22 }) }
          .width(52).height(58).justifyContent(FlexAlign.Center)
          .backgroundColor($r('app.color.surface')).borderRadius(14).rotate({ angle: 6 })
      }.justifyContent(FlexAlign.Center).width('100%').margin({ top: 8 })
      Text(this.notes.length === 0 ? '让想法慢慢连起来' : '从两篇笔记的联系开始')
        .fontSize(19).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
      Text(this.notes.length === 0 ? '先写下第一篇笔记。以后引用其他笔记时，就能在这里找回它们之间的联系。' :
        this.isWide ? '在笔记正文中输入 [[另一篇笔记标题]]，保存后就能在这里查看它们的联系。' :
        '打开一篇笔记，在「工具」中插入另一篇笔记的链接，关联就会自动出现在这里。')
        .fontSize(14).lineHeight(22).fontColor($r('app.color.text_secondary')).textAlign(TextAlign.Center)
      if (this.notes.length === 0) {
        Button('新建第一篇笔记', { type: ButtonType.Normal }).id('relations-create-first')
          .height(44).padding({ left: 22, right: 22 }).borderRadius(14)
          .fontSize(14).fontColor($r('app.color.inverse_text')).backgroundColor($r('app.color.brand'))
          .onClick(this.onCreateNote)
      }
    }.width('100%').padding(24).backgroundColor($r('app.color.brand_soft')).borderRadius(24)
  }

  @Builder
  private noteList() {
    Column({ space: 10 }) {
      Text(this.cachedConnected.length > 0 ? '有联系的笔记' : '选择一篇笔记开始')
        .fontSize(17).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary')).width('100%')
      ForEach(this.visibleNotes(), (choice: GraphNode) => {
        RelationRow({ contentId: choice.id, title: choice.label, subtitle: choice.snippet || '还没有正文',
          detail: this.relationCount(choice.id) > 0 ? `${this.relationCount(choice.id)} 个相关内容` : '打开并插入笔记链接',
          action: (): void => {
            if (this.relationCount(choice.id) > 0) { this.select(choice.id); } else { this.onOpenNote(choice.id); }
          } })
      }, (choice: GraphNode): string => `${choice.id}-${choice.label}-${choice.snippet}-${this.relationCount(choice.id)}`)
      if (!this.showAllNotes && (this.cachedConnected.length || this.cachedChoices.length) > 6) {
        Button('查看全部', { buttonStyle: ButtonStyleMode.TEXTUAL }).height(44)
          .fontColor($r('app.color.brand')).onClick(() => { this.showAllNotes = true; })
      }
    }.width('100%')
  }

  @Builder
  private selectedDetails() {
    Column({ space: 16 }) {
      if (this.view === 'list') {
        Button('‹  全部笔记', { buttonStyle: ButtonStyleMode.TEXTUAL }).id('relations-back')
          .height(44).fontSize(14).fontColor($r('app.color.brand')).alignSelf(ItemAlign.Start)
          .onClick(() => { this.select(''); })
      }
      if (this.view === 'list') {
      Column({ space: 12 }) {
        Text(this.selected()?.label ?? '').fontSize(20).fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary')).width('100%')
        Text(this.selected()?.snippet || '打开查看完整内容').fontSize(14).lineHeight(22).maxLines(3)
          .fontColor($r('app.color.text_secondary')).width('100%')
        Button(this.selected()?.kind === 'tag' ? '查看这个标签的笔记' : this.selected()?.kind === 'mindmap' ? '打开思维导图' : '打开笔记', { type: ButtonType.Normal })
          .id('relations-open-selected').height(44).width('100%').fontSize(14).borderRadius(13)
          .fontColor($r('app.color.brand')).backgroundColor($r('app.color.brand_soft'))
          .onClick(() => { this.onOpenNode(this.selectedGraphId); })
      }.width('100%').padding(20).backgroundColor($r('app.color.surface')).borderRadius(22)
      }
      if (this.selected()?.kind !== 'tag') {
        Text(`相关内容 · ${this.related(this.selectedGraphId).length}`).fontSize(16).fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary')).width('100%')
        ForEach(this.related(this.selectedGraphId), (related: RelatedContent) => {
          RelationRow({ contentId: related.id, title: related.title, subtitle: related.reason,
            detail: related.snippet, icon: related.kind === 'mindmap' ? 'mindmap' : 'note',
            action: (): void => { this.onOpenNode(related.id); } })
        }, (related: RelatedContent): string => `${this.selectedGraphId}-${related.id}-${related.title}-${related.reason}-${related.snippet}`)
        if (this.related(this.selectedGraphId).length === 0) {
          Text(this.isWide ? '还没有关联。在正文中输入 [[另一篇笔记标题]]，就能把相关想法放在一起。' :
            '还没有关联。打开笔记，在「工具」中插入笔记链接，就能把相关想法放在一起。')
            .fontSize(14).lineHeight(23).fontColor($r('app.color.text_secondary')).width('100%').padding(4)
        }
      }
    }.width('100%')
  }

  @Builder
  private graphPanel() {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Text('关系图').fontSize(16).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
        Blank()
        if (this.selectedGraphId) {
          Button(this.graphScope === 'local' ? '查看全部' : '只看这篇', { buttonStyle: ButtonStyleMode.TEXTUAL })
            .height(44).fontSize(12).fontColor($r('app.color.brand'))
            .onClick(() => { this.onSetScope(this.graphScope === 'local' ? 'global' : 'local'); })
        }
        Button('显示', { buttonStyle: ButtonStyleMode.TEXTUAL }).id('relations-graph-options')
          .height(44).fontSize(12).fontColor($r('app.color.brand')).bindMenu(this.graphOptions)
      }.width('100%')
      LexiGraphView({ nodes: this.graphNodes, edges: this.graphEdges, selectedId: this.selectedGraphId,
        graphHeight: this.isWide ? 380 : 220, onSelect: (id: string): void => { this.select(id); } })
      if (this.selected()) {
        Row({ space: 10 }) {
          Text(this.selected()?.label ?? '').fontSize(14).fontWeight(FontWeight.Medium).maxLines(1)
            .fontColor($r('app.color.text_primary')).layoutWeight(1)
          Button('打开', { type: ButtonType.Normal }).id('relations-graph-open').height(40).fontSize(13)
            .padding({ left: 16, right: 16 }).borderRadius(12)
            .fontColor($r('app.color.brand')).backgroundColor($r('app.color.brand_soft'))
            .onClick(() => { this.onOpenNode(this.selectedGraphId); })
        }.width('100%')
      } else {
        Text('点击节点查看关联')
          .fontSize(12).lineHeight(18).fontColor($r('app.color.text_secondary')).width('100%')
      }
    }.width('100%').padding(16).backgroundColor($r('app.color.surface')).borderRadius(24)
  }

  @Builder
  private suggestions() {
    Column({ space: 10 }) {
      Text('可能有关').fontSize(17).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary')).width('100%')
      ForEach(this.showAllMentions ? this.mentions : this.mentions.slice(0, 4), (mention: UnlinkedMention) => {
        RelationRow({ contentId: `mention-${mention.sourceId}-${mention.targetId}`, title: mention.sourceTitle,
          subtitle: `提到了「${mention.targetTitle}」`, detail: '查看原文 →', icon: 'link',
          action: (): void => { this.onOpenNote(mention.sourceId); } })
        Button('建立链接', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
          .id(`mention-link-${mention.sourceId}-${mention.targetId}`).height(36).fontSize(13)
          .fontColor($r('app.color.brand_ink')).alignSelf(ItemAlign.End)
          .onClick((): void => { this.onLinkMention(mention); })
      }, (mention: UnlinkedMention): string => `${mention.sourceId}-${mention.targetId}-${mention.snippet}`)
      if (!this.showAllMentions && this.mentions.length > 4) {
        Button(`查看全部 ${this.mentions.length} 条线索`, { buttonStyle: ButtonStyleMode.TEXTUAL }).height(44)
          .fontColor($r('app.color.brand')).onClick(() => { this.showAllMentions = true; })
      }
    }.width('100%')
  }

  build() {
    Column({ space: 18 }) {
      LexiHeroHeading({ headingId: 'primary-heading-2', title: '笔记关联',
        subtitle: '', isWide: this.isWide, collapsed: this.titleCollapsed })
      if (this.scopeLabel) {
        Row({ space: 6 }) {
          LexiIcon({ name: 'folder', iconSize: 15, muted: true })
          Text(this.scopeLabel).fontSize(12).fontColor($r('app.color.text_secondary')).maxLines(1)
        }.width('100%')
      }
      if (this.notes.length > 0) {
        Row({ space: 4 }) {
          Button('关联列表', { type: ButtonType.Normal }).id('relations-list-view')
            .layoutWeight(1).height(44).borderRadius(13).fontSize(14)
            .fontWeight(this.view === 'list' ? FontWeight.Medium : FontWeight.Normal)
            .backgroundColor(this.view === 'list' ? $r('app.color.surface') : Color.Transparent)
            .fontColor(this.view === 'list' ? $r('app.color.brand') : $r('app.color.text_secondary'))
            .accessibilitySelected(this.view === 'list').onClick(() => { this.view = 'list'; })
          Button('关系图', { type: ButtonType.Normal }).id('relations-graph-view')
            .layoutWeight(1).height(44).borderRadius(13).fontSize(14)
            .fontWeight(this.view === 'graph' ? FontWeight.Medium : FontWeight.Normal)
            .backgroundColor(this.view === 'graph' ? $r('app.color.surface') : Color.Transparent)
            .fontColor(this.view === 'graph' ? $r('app.color.brand') : $r('app.color.text_secondary'))
            .accessibilitySelected(this.view === 'graph').onClick(() => { this.view = 'graph'; })
        }.width('100%').padding(4).backgroundColor($r('app.color.soft_surface')).borderRadius(17)
      }
      if (this.view === 'graph' && this.notes.length > 0) { this.graphPanel(); }
      if (this.selected()) {
        this.selectedDetails()
      } else if (this.view === 'list' || this.notes.length === 0) {
        if (this.cachedConnected.length === 0) { this.startHint(); }
        if (this.notes.length > 0) { this.noteList(); }
        if (this.mentions.length > 0) { this.suggestions(); }
      }
    }
    .width('100%').constraintSize({ maxWidth: 920 }).alignItems(HorizontalAlign.Start)
    .padding({ left: this.pagePadding, right: this.pagePadding, bottom: (this.isWide ? 36 : 88) + this.bottomInset })
  }
}
