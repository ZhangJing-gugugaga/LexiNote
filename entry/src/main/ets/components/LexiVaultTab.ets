import { deviceInfo } from '@kit.BasicServicesKit';
import { LexiContextSurface } from './LexiContextSurface';
import { LexiSearch } from '../core/LexiSearch';
import { LexiContextTarget } from '../core/LexiContextModels';
import {
  CanvasBoard,
  MindMapDoc,
  NoteItem,
  NoteLink,
  TagCount
} from '../core/LexiModels';
import { MarkdownEngine } from '../core/MarkdownEngine';
import { LexiIcon } from './LexiIcon';
import { LexiFilterChip, LexiHeroHeading, LexiNoteCard } from './LexiNoteCard';

@Component
export struct LexiVaultTab {
  @Prop requestedFolder: string = '';
  @Prop @Watch('contextSearchChanged') searchRevision: number = 0;
  private contextSearchChanged(): void {
    this.query = ''; this.notebookFilter = this.requestedFolder; this.vaultSection = 'notes';
    setTimeout((): void => { try { this.getUIContext().getFocusController().requestFocus('vault-search-input'); } catch {} }, 80);
  }
  aboutToAppear(): void {
    this.rebuildLinkCounts();
    if (this.searchRevision > 0) { this.contextSearchChanged(); }
  }
  @Prop isWide: boolean = false;
  @Prop pagePadding: number = 24;
  @Prop bottomInset: number = 0;
  @Prop titleCollapsed: boolean = false;
  @Prop activeVaultName: string = '个人知识库';
  @Prop notes: NoteItem[] = [];
  @Prop maps: MindMapDoc[] = [];
  @Prop canvases: CanvasBoard[] = [];
  @Prop @Watch('rebuildLinkCounts') links: NoteLink[] = [];
  @Prop viewMode: string = 'list';
  @Prop tagFilter: string = '';
  @Prop vaultSection: string = 'notes';
  @State private query: string = '';
  @State private noteFilter: string = 'all';
  @State private notebookFilter: string = '';
  @State private sortMode: string = 'updated';
  private outgoingMap: Map<string, number> = new Map<string, number>();
  private backlinkMap: Map<string, number> = new Map<string, number>();
  onSelectSection: (section: string) => void = (_section: string): void => {};
  onManageWorkspaces: () => void = (): void => {};
  onSetViewMode: (mode: string) => void = (_mode: string): void => {};
  onFilterTag: (tag: string) => void = (_tag: string): void => {};
  onOpenNote: (noteId: string) => void = (_noteId: string): void => {};
  onTogglePin: (note: NoteItem) => void = (_note: NoteItem): void => {};
  onToggleFavorite: (note: NoteItem) => void = (_note: NoteItem): void => {};
  onMoveToTrash: (note: NoteItem) => void = (_note: NoteItem): void => {};
  onRestoreNote: (note: NoteItem) => void = (_note: NoteItem): void => {};
  onDeleteForever: (note: NoteItem) => void = (_note: NoteItem): void => {};
  onEmptyTrash: () => void = () => {};
  onOpenMap: (mapId: string) => void = (_mapId: string): void => {};
  onOpenCanvas: (canvasId: string) => void = (_canvasId: string): void => {};

  private rebuildLinkCounts(): void {
    const outMap = new Map<string, number>();
    const backMap = new Map<string, number>();
    for (let i = 0; i < this.links.length; i++) {
      const l = this.links[i];
      if (l.targetId.length > 0) {
        outMap.set(l.sourceId, (outMap.get(l.sourceId) ?? 0) + 1);
        backMap.set(l.targetId, (backMap.get(l.targetId) ?? 0) + 1);
      }
    }
    this.outgoingMap = outMap;
    this.backlinkMap = backMap;
  }

  private activeNotes(): NoteItem[] {
    return this.notes.filter((n: NoteItem): boolean => n.trashedAt === 0);
  }

  private trashedNotes(): NoteItem[] {
    return this.notes.filter((n: NoteItem): boolean => n.trashedAt > 0);
  }

  private backlinkCount(noteId: string): number {
    return this.backlinkMap.get(noteId) ?? 0;
  }

  private outgoingCount(noteId: string): number {
    return this.outgoingMap.get(noteId) ?? 0;
  }

  private notebooks(): string[] {
    const result: string[] = [];
    this.activeNotes().forEach((n: NoteItem) => {
      if (n.notebook && !result.includes(n.notebook)) {
        result.push(n.notebook);
      }
    });
    return result;
  }

  private tagCounts(): TagCount[] {
    const counts = new Map<string, number>();
    this.activeNotes().forEach((n: NoteItem) => {
      n.tags.forEach((t: string) => {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      });
    });
    const result: TagCount[] = [];
    counts.forEach((count: number, name: string) => {
      const item = new TagCount();
      item.name = name;
      item.count = count;
      result.push(item);
    });
    return result.sort((a: TagCount, b: TagCount): number => b.count - a.count);
  }

  private visibleNotes(): NoteItem[] {
    const term = this.query.trim().toLowerCase();
    let list = this.noteFilter === 'trash' ? this.trashedNotes() : this.activeNotes();
    if (this.noteFilter === 'pinned') {
      list = list.filter((n: NoteItem): boolean => n.pinned);
    }
    if (this.noteFilter === 'favorite') {
      list = list.filter((n: NoteItem): boolean => n.favorite);
    }
    if (this.notebookFilter) {
      list = list.filter((n: NoteItem): boolean => n.notebook === this.notebookFilter);
    }
    if (this.tagFilter) {
      list = list.filter((n: NoteItem): boolean => n.tags.includes(this.tagFilter));
    }
    if (term) {
      list = list.filter((n: NoteItem): boolean => LexiSearch.matches(n, this.query));
    }
    const sorted = list.slice();
    if (this.sortMode === 'title') {
      sorted.sort((a: NoteItem, b: NoteItem): number =>
        MarkdownEngine.displayTitle(a).localeCompare(MarkdownEngine.displayTitle(b))
      );
    } else if (this.sortMode === 'created') {
      sorted.sort((a: NoteItem, b: NoteItem): number => b.createdAt - a.createdAt);
    } else {
      sorted.sort((a: NoteItem, b: NoteItem): number => {
        if (a.pinned !== b.pinned) {
          return a.pinned ? -1 : 1;
        }
        return b.updatedAt - a.updatedAt;
      });
    }
    return sorted;
  }

  private notesInColumn(column: number, total: number): NoteItem[] {
    return this.visibleNotes().filter((_n: NoteItem, idx: number): boolean => idx % total === column);
  }

  private visibleMaps(): MindMapDoc[] {
    const term = this.query.trim().toLowerCase();
    return this.maps.filter(
      (m: MindMapDoc): boolean =>
        m.trashedAt === 0 &&
        (!term || `${m.title} ${m.nodes.map((node) => node.text).join(' ')}`.toLowerCase().includes(term))
    );
  }

  private visibleCanvases(): CanvasBoard[] {
    const term = this.query.trim().toLowerCase();
    return this.canvases.filter((c: CanvasBoard): boolean => !term || c.title.toLowerCase().includes(term));
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

  private notebookMenu(): MenuElement[] {
    const items: MenuElement[] = [
      {
        value: '全部笔记本',
        action: (): void => {
          this.notebookFilter = '';
        }
      }
    ];
    this.notebooks().forEach((name: string) => {
      items.push({
        value: name,
        action: (): void => {
          this.notebookFilter = name;
        }
      });
    });
    return items;
  }

  private sortMenu(): MenuElement[] {
    return [
      {
        value: '最近编辑',
        action: (): void => {
          this.sortMode = 'updated';
        }
      },
      {
        value: '创建时间',
        action: (): void => {
          this.sortMode = 'created';
        }
      },
      {
        value: '标题',
        action: (): void => {
          this.sortMode = 'title';
        }
      }
    ];
  }

  @Builder
  renderNoteCard(note: NoteItem) {
    LexiNoteCard({
      note: note,
      query: this.query,
      outgoingCount: this.outgoingCount(note.id),
      backlinkCount: this.backlinkCount(note.id),
      onOpen: (id: string): void => {
        this.onOpenNote(id);
      },
      onFilterTag: (tag: string): void => {
        this.onSelectSection('notes');
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
    Column({ space: 14 }) {
      LexiHeroHeading({
        headingId: 'primary-heading-1',
        title: this.activeVaultName,
        subtitle: '',
        isWide: this.isWide,
        collapsed: this.titleCollapsed
      })

      if (!this.isWide) {
        Button('工作区与项目', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
          .id('phone-workspace-manager').width('100%').height(40).fontSize(13).borderRadius(9)
          .fontColor($r('app.color.brand_ink')).backgroundColor($r('app.color.brand_soft'))
          .onClick((): void => { this.onManageWorkspaces(); })
      }

      Search({ value: this.query, placeholder: '搜索 · tag:#标签 type:study notebook:分类' }).id('vault-search-input')
        .width('100%')
        .height(42)
        .fontColor($r('app.color.text_primary'))
        .placeholderColor($r('app.color.text_secondary'))
        .backgroundColor($r('app.color.surface'))
        .onChange((val: string) => {
          this.query = val;
        })

      Row({ space: 6 }) {
        ForEach(
          [
            ['notes', `笔记 (${this.activeNotes().length})`],
            ['maps', `导图 (${this.visibleMaps().length})`],
            ['canvases', `白板 (${this.visibleCanvases().length})`],
            ['tags', `标签 (${this.tagCounts().length})`]
          ],
          (sec: string[]) => {
            Button(sec[1], { type: ButtonType.Normal })
              .layoutWeight(1)
              .height(36)
              .fontSize(12)
              .fontWeight(this.vaultSection === sec[0] ? FontWeight.Bold : FontWeight.Medium)
              .borderRadius(12)
              .backgroundColor(this.vaultSection === sec[0] ? $r('app.color.brand') : $r('app.color.surface'))
              .fontColor(this.vaultSection === sec[0] ? $r('app.color.inverse_text') : $r('app.color.text_secondary'))
              .onClick(() => {
                this.onSelectSection(sec[0]);
              })
          },
          (sec: string[]): string => `${sec[0]}-${sec[1]}`
        )
      }
      .width('100%')

      if (this.vaultSection === 'notes') {
        Scroll() {
          Row({ space: 8 }) {
            LexiFilterChip({
              selected: this.noteFilter === 'all',
              label: '全部笔记',
              action: (): void => {
                this.noteFilter = 'all';
              }
            })
            LexiFilterChip({
              selected: this.noteFilter === 'pinned',
              label: '置顶',
              action: (): void => {
                this.noteFilter = 'pinned';
              }
            })
            LexiFilterChip({
              selected: this.noteFilter === 'favorite',
              label: '收藏',
              action: (): void => {
                this.noteFilter = 'favorite';
              }
            })
          }
        }
        .scrollable(ScrollDirection.Horizontal)
        .scrollBar(BarState.Off)
        .width('100%')

        Row({ space: 8 }) {
          Button(this.notebookFilter ? `📁 ${this.notebookFilter}` : '📁 全部笔记本', { type: ButtonType.Normal })
            .height(34)
            .padding({ left: 12, right: 12 })
            .fontSize(12)
            .borderRadius(10)
            .backgroundColor($r('app.color.surface'))
            .fontColor($r('app.color.text_primary'))
            .bindMenu(this.notebookMenu())

          Button(
            this.sortMode === 'title' ? '排序：标题' : this.sortMode === 'created' ? '排序：创建时间' : '排序：最近编辑',
            { type: ButtonType.Normal }
          )
            .height(34)
            .padding({ left: 12, right: 12 })
            .fontSize(12)
            .borderRadius(10)
            .backgroundColor($r('app.color.surface'))
            .fontColor($r('app.color.text_primary'))
            .bindMenu(this.sortMenu())

          Blank()

          Button(this.viewMode === 'card' ? '视图：双栏卡片' : '视图：列表', { type: ButtonType.Normal })
            .height(34)
            .padding({ left: 12, right: 12 })
            .fontSize(12)
            .borderRadius(10)
            .backgroundColor($r('app.color.surface'))
            .fontColor($r('app.color.brand'))
            .onClick(() => {
              this.onSetViewMode(this.viewMode === 'card' ? 'list' : 'card');
            })
        }
        .width('100%')

        if (this.tagFilter.length > 0) {
          Row() {
            Text(`当前筛选标签：#${this.tagFilter}`)
              .fontSize(12)
              .fontWeight(FontWeight.Medium)
              .fontColor($r('app.color.brand'))
            Blank()
            Button('清除筛选', { buttonStyle: ButtonStyleMode.TEXTUAL })
              .fontSize(12)
              .fontColor($r('app.color.text_secondary'))
              .onClick(() => {
                this.onFilterTag('');
              })
          }
          .width('100%')
          .padding({ left: 14, right: 14, top: 8, bottom: 8 })
          .backgroundColor($r('app.color.brand_soft'))
          .borderRadius(12)
        }

        if (this.noteFilter === 'trash' && this.trashedNotes().length > 0) {
          Row() {
            Text(`${this.trashedNotes().length} 篇已删除笔记`)
              .fontSize(12)
              .fontColor($r('app.color.text_secondary'))
            Blank()
            Button('清空回收站', { buttonStyle: ButtonStyleMode.TEXTUAL })
              .fontSize(12)
              .fontColor($r('app.color.error'))
              .onClick(() => {
                this.onEmptyTrash();
              })
          }
          .width('100%')
          .padding({ left: 14, right: 14, top: 8, bottom: 8 })
          .backgroundColor($r('app.color.surface'))
          .borderRadius(12)
        }

        if (this.visibleNotes().length === 0) {
          Column({ space: 8 }) {
            Text('暂无笔记').fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
            Text('点击右上角“新建”添加').fontSize(12).fontColor($r('app.color.text_secondary'))
          }
          .width('100%')
          .padding(32)
          .backgroundColor($r('app.color.surface'))
          .borderRadius(20)
        } else if (this.viewMode === 'card' || this.isWide) {
          Row({ space: 10 }) {
            Column({ space: 10 }) {
              ForEach(
                this.notesInColumn(0, 2),
                (n: NoteItem) => {
                  this.renderNoteCard(n)
                },
                (n: NoteItem): string => `col0-${n.id}-${n.updatedAt}`
              )
            }
            .layoutWeight(1)

            Column({ space: 10 }) {
              ForEach(
                this.notesInColumn(1, 2),
                (n: NoteItem) => {
                  this.renderNoteCard(n)
                },
                (n: NoteItem): string => `col1-${n.id}-${n.updatedAt}`
              )
            }
            .layoutWeight(1)
          }
          .width('100%')
          .alignItems(VerticalAlign.Top)
        } else {
          Column({ space: 10 }) {
            ForEach(
              this.visibleNotes(),
              (n: NoteItem) => {
                this.renderNoteCard(n)
              },
              (n: NoteItem): string => `${n.id}-${n.updatedAt}`
            )
          }
          .width('100%')
        }
      } else if (this.vaultSection === 'maps') {
        if (this.visibleMaps().length === 0) {
          Column({ space: 8 }) {
            Text('暂无思维导图').fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
            Text('点击右上角“新建”创建思维导图').fontSize(12).fontColor($r('app.color.text_secondary'))
          }
          .width('100%')
          .padding(32)
          .backgroundColor($r('app.color.surface'))
          .borderRadius(20)
        }

        ForEach(
          this.visibleMaps(),
          (map: MindMapDoc) => {
            LexiContextSurface({ target: LexiContextTarget.scope('mindmap', map.id, map.vaultId, map.projectId || '', map.title), tabletCard: true }) {
            Row({ space: 12 }) {
              LexiIcon({ name: 'mindmap', iconSize: 26 })
              Column({ space: 4 }) {
                Text(map.title)
                  .fontSize(16)
                  .fontWeight(FontWeight.Bold)
                  .fontColor($r('app.color.text_primary'))
                Text(
                  `${map.nodes.length} 个节点 · ${map.layoutKind === 'balanced' ? '双向平衡' : map.layoutKind === 'org' ? '组织结构' : '右侧逻辑'} · ${this.dateLabel(map.updatedAt)}`
                )
                  .fontSize(12)
                  .fontColor($r('app.color.text_secondary'))
              }
              .layoutWeight(1)
              .alignItems(HorizontalAlign.Start)
            }
            .width('100%')
            .padding({ left: 16, right: deviceInfo.deviceType === 'tablet' ? 56 : 16, top: 16, bottom: 16 })
            .backgroundColor($r('app.color.surface'))
            .borderRadius(20)
            .onClick(() => {
              this.onOpenMap(map.id);
            })
            }
          },
          (map: MindMapDoc): string => `${map.id}-${map.updatedAt}`
        )
      } else if (this.vaultSection === 'canvases') {
        if (this.visibleCanvases().length === 0) {
          Column({ space: 8 }) {
            Text('暂无自由白板').fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
            Text('点击右上角“新建”创建自由白板').fontSize(12).fontColor($r('app.color.text_secondary'))
          }
          .width('100%')
          .padding(32)
          .backgroundColor($r('app.color.surface'))
          .borderRadius(20)
        }

        ForEach(
          this.visibleCanvases(),
          (board: CanvasBoard) => {
            LexiContextSurface({ target: LexiContextTarget.scope('canvas', board.id, board.vaultId, board.projectId || '', board.title), tabletCard: true }) {
            Row({ space: 12 }) {
              LexiIcon({ name: 'canvas', iconSize: 26 })
              Column({ space: 4 }) {
                Text(board.title)
                  .fontSize(16)
                  .fontWeight(FontWeight.Bold)
                  .fontColor($r('app.color.text_primary'))
                Text(`${board.cards.length} 张卡片 · ${board.edges.length} 条连线 · ${this.dateLabel(board.updatedAt)}`)
                  .fontSize(12)
                  .fontColor($r('app.color.text_secondary'))
              }
              .layoutWeight(1)
              .alignItems(HorizontalAlign.Start)
            }
            .width('100%')
            .padding({ left: 16, right: deviceInfo.deviceType === 'tablet' ? 56 : 16, top: 16, bottom: 16 })
            .backgroundColor($r('app.color.surface'))
            .borderRadius(20)
            .onClick(() => {
              this.onOpenCanvas(board.id);
            })
            }
          },
          (board: CanvasBoard): string => `${board.id}-${board.updatedAt}`
        )
      } else {
        if (this.tagCounts().length === 0) {
          Column({ space: 8 }) {
            Text('暂无标签').fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
            Text('在笔记中添加 #标签 后自动归类').fontSize(12).fontColor($r('app.color.text_secondary'))
          }
          .width('100%')
          .padding(32)
          .backgroundColor($r('app.color.surface'))
          .borderRadius(20)
        } else {
          Column({ space: 12 }) {
            Flex({ wrap: FlexWrap.Wrap }) {
              ForEach(
                this.tagCounts(),
                (tc: TagCount) => {
                  Button(`#${tc.name} (${tc.count})`, { type: ButtonType.Normal })
                    .height(36)
                    .margin({ right: 8, bottom: 8 })
                    .padding({ left: 14, right: 14 })
                    .fontSize(12)
                    .borderRadius(12)
                    .backgroundColor($r('app.color.brand_soft'))
                    .fontColor($r('app.color.brand'))
                    .onClick(() => {
                      this.onSelectSection('notes');
                      this.noteFilter = 'all';
                      this.notebookFilter = '';
                      this.onFilterTag(tc.name);
                    })
                },
                (tc: TagCount): string => tc.name
              )
            }
            .width('100%')
          }
          .width('100%')
          .padding(18)
          .backgroundColor($r('app.color.surface'))
          .borderRadius(22)
        }
      }
    }
    .width('100%')
    .constraintSize({ maxWidth: 1080 })
    .padding({ left: this.pagePadding, right: this.pagePadding, bottom: (this.isWide ? 36 : 88) + this.bottomInset })
  }
}
