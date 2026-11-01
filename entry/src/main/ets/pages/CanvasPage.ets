import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { LexiBackHeader } from '../components/LexiBackHeader';
import {
  CanvasBoard,
  CanvasCard,
  CanvasEdge,
  CanvasRouteParam,
  NoteEditorRouteParam,
  NoteItem
} from '../core/LexiModels';
import { MarkdownEngine } from '../core/MarkdownEngine';
import { LexiStorageService } from '../core/LexiStorageService';
import { LexiSpatialEditor } from '../core/LexiSpatialEditor';

@Builder
export function canvasEditorBuilder() {
  CanvasPage()
}

@Component
export struct CanvasPage {
  @StorageProp('lexiTopInset') titleTopInset: number = 0;
  @StorageProp('lexiBottomInset') bottomInset: number = 0;
  @StorageProp('lexiViewportWidth') viewportWidth: number = 390;
  @State private board: CanvasBoard = new CanvasBoard();
  @State private selectedCardId: string = '';
  @State private cardTitle: string = '';
  @State private cardContent: string = '';
  @State private saveStatus: string = '';
  @State private edgeLabelInput: string = '关联';
  @State private vaultNotes: NoteItem[] = [];
  private saveTimer: number = -1;
  private readonly settings: RenderingContextSettings = new RenderingContextSettings(true);
  private readonly ctx2d: CanvasRenderingContext2D = new CanvasRenderingContext2D(this.settings);
  private canvasReady: boolean = false;
  private canvasWidth: number = 360;
  private boardScale: number = 1;
  private boardPanX: number = 0;
  private boardPanY: number = 0;
  private canvasHeight: number = 360;
  private viewFitted: boolean = false;
  private dragCardId: string = '';
  private dragStartX: number = 0;
  private dragStartY: number = 0;
  private dragPanX: number = 0;
  private dragPanY: number = 0;
  private pathStack: NavPathStack = new NavPathStack();

  aboutToDisappear(): void {
    if (this.saveTimer >= 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = -1;
      LexiStorageService.saveCanvas(this.context(), this.board).catch(() => {});
    }
  }

  private context(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  private toast(msg: string): void {
    this.getUIContext().getPromptAction().showToast({ message: msg });
  }

  private async loadFromRoute(param: CanvasRouteParam | undefined): Promise<void> {
    await LexiStorageService.init(this.context());
    const vaultId = await LexiStorageService.getActiveVaultId();
    this.vaultNotes = (await LexiStorageService.getNotes(vaultId)).filter(
      (n: NoteItem): boolean => n.trashedAt === 0
    );

    if (param && param.canvasId.length > 0 && !param.createNew) {
      const found = await LexiStorageService.getCanvasById(param.canvasId);
      if (found) {
        this.board = found;
        if (found.cards.length > 0) {
          this.selectCard(found.cards[0].id);
        }
        this.drawBoard();
        return;
      }
    }

    const existingList = await LexiStorageService.getCanvases(vaultId);
    if (existingList.length > 0 && (!param || !param.createNew)) {
      this.board = existingList[0];
      if (this.board.cards.length > 0) {
        this.selectCard(this.board.cards[0].id);
      }
      this.drawBoard();
      return;
    }

    const fresh = new CanvasBoard();
    fresh.vaultId = vaultId;
    fresh.projectId = param && param.projectId ? param.projectId : await LexiStorageService.getActiveProjectId(vaultId);
    fresh.title = '新建自由白板';
    this.board = await LexiStorageService.saveCanvas(this.context(), fresh);
    this.drawBoard();
  }

  private currentCard(): CanvasCard | undefined {
    return this.board.cards.find((c: CanvasCard): boolean => c.id === this.selectedCardId);
  }

  private selectCard(cardId: string): void {
    const found = this.board.cards.find((c: CanvasCard): boolean => c.id === cardId);
    if (!found) {
      return;
    }
    this.selectedCardId = found.id;
    this.cardTitle = found.title;
    this.cardContent = found.content;
    this.drawBoard();
  }

  private persistAndDraw(): void {
    if (this.saveTimer >= 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = -1;
    }
    this.board = JSON.parse(JSON.stringify(this.board)) as CanvasBoard;
    this.drawBoard();
    this.saveStatus = '正在保存…';
    LexiStorageService.saveCanvas(this.context(), this.board).then(() => {
      this.saveStatus = `已保存 · ${this.board.cards.length} 张卡片`;
    }).catch(() => {
      this.saveStatus = '保存失败，请重试';
    });
  }

  private schedulePersistAndDraw(): void {
    this.drawBoard();
    this.saveStatus = '正在保存…';
    if (this.saveTimer >= 0) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = -1;
      LexiStorageService.saveCanvas(this.context(), this.board).then(() => {
        this.saveStatus = `已保存 · ${this.board.cards.length} 张卡片`;
      }).catch(() => {
        this.saveStatus = '保存失败，请重试';
      });
    }, 320);
  }

  private addCard(): void {
    const card = new CanvasCard();
    card.id = `card-${util.generateRandomUUID(true)}`;
    card.title = `灵感卡片 ${this.board.cards.length + 1}`;
    card.content = '点击下方编辑区补充卡片内容或引用笔记';
    card.x = (this.canvasWidth / 2 - this.boardPanX) / this.boardScale - 77 + (this.board.cards.length % 4) * 42;
    card.y = (this.canvasHeight / 2 - this.boardPanY) / this.boardScale - 37 + (this.board.cards.length % 4) * 86;
    card.colorTag = ['purple', 'indigo', 'teal'][this.board.cards.length % 3];
    this.board.cards.push(card);
    this.selectCard(card.id);
    this.viewFitted = false;
    this.persistAndDraw();
  }

  private nudgeSelected(dx: number, dy: number): void {
    const card = this.currentCard();
    if (!card) {
      return;
    }
    card.x += dx;
    card.y += dy;
    this.persistAndDraw();
  }

  private toggleConnectionWith(targetCardId: string): void {
    const src = this.currentCard();
    if (!src || src.id === targetCardId) {
      return;
    }
    const existingIdx = this.board.edges.findIndex(
      (e: CanvasEdge): boolean =>
        (e.fromId === src.id && e.toId === targetCardId) ||
        (e.fromId === targetCardId && e.toId === src.id)
    );
    if (existingIdx >= 0) {
      this.board.edges.splice(existingIdx, 1);
      this.toast('已移除卡片连线');
    } else {
      const edge = new CanvasEdge();
      edge.id = `edge-${Date.now()}`;
      edge.fromId = src.id;
      edge.toId = targetCardId;
      edge.label = this.edgeLabelInput.trim() || '关联';
      this.board.edges.push(edge);
      this.toast('已建立卡片连线');
    }
    this.persistAndDraw();
  }

  private drawBoard(): void {
    if (!this.canvasReady || this.canvasWidth <= 0) {
      return;
    }
    this.ctx2d.clearRect(0, 0, this.canvasWidth, this.canvasHeight);

    // Dot grid
    this.ctx2d.fillStyle = 'rgba(182, 156, 255, 0.16)';
    for (let x = 20; x < this.canvasWidth; x += 28) {
      for (let y = 20; y < this.canvasHeight; y += 28) {
        this.ctx2d.fillRect(x, y, 2, 2);
      }
    }
    if (this.board.cards.length === 0) {
      this.ctx2d.fillStyle = '#C5B8E3';
      this.ctx2d.font = '14vp sans-serif'; this.ctx2d.textAlign = 'center';
      this.ctx2d.fillText('点击上方「新增卡片」开始', this.canvasWidth / 2, this.canvasHeight / 2);
    }

    const cardW = 154;
    const cardH = 74;
    if (!this.viewFitted && this.board.cards.length > 0) {
      const left = Math.min(...this.board.cards.map((card: CanvasCard): number => card.x));
      const right = Math.max(...this.board.cards.map((card: CanvasCard): number => card.x + cardW));
      const top = Math.min(...this.board.cards.map((card: CanvasCard): number => card.y));
      const bottom = Math.max(...this.board.cards.map((card: CanvasCard): number => card.y + cardH));
      this.boardScale = Math.min(1, (this.canvasWidth - 32) / Math.max(1, right - left),
        (this.canvasHeight - 32) / Math.max(1, bottom - top));
      this.boardPanX = this.canvasWidth / 2 - (left + right) * this.boardScale / 2;
      this.boardPanY = this.canvasHeight / 2 - (top + bottom) * this.boardScale / 2;
      this.viewFitted = true;
    }
    this.ctx2d.save();
    this.ctx2d.translate(this.boardPanX, this.boardPanY);
    this.ctx2d.scale(this.boardScale, this.boardScale);

    // Draw edges
    for (let i = 0; i < this.board.edges.length; i++) {
      const e = this.board.edges[i];
      const fromCard = this.board.cards.find((c: CanvasCard): boolean => c.id === e.fromId);
      const toCard = this.board.cards.find((c: CanvasCard): boolean => c.id === e.toId);
      if (!fromCard || !toCard) {
        continue;
      }
      const sx = fromCard.x + cardW / 2;
      const sy = fromCard.y + cardH / 2;
      const ex = toCard.x + cardW / 2;
      const ey = toCard.y + cardH / 2;
      this.ctx2d.beginPath();
      this.ctx2d.strokeStyle = '#9A7BFF';
      this.ctx2d.lineWidth = 2;
      this.ctx2d.moveTo(sx, sy);
      this.ctx2d.lineTo(ex, ey);
      this.ctx2d.stroke();

      if (e.label.length > 0) {
        const mx = (sx + ex) / 2;
        const my = (sy + ey) / 2;
        this.ctx2d.fillStyle = '#E0D0FF';
        this.ctx2d.font = '10vp sans-serif';
        this.ctx2d.textAlign = 'center';
        this.ctx2d.fillText(e.label, mx, my - 6);
      }
    }

    // Draw cards
    for (let i = 0; i < this.board.cards.length; i++) {
      const c = this.board.cards[i];
      const selected = c.id === this.selectedCardId;
      this.ctx2d.beginPath();
      this.ctx2d.roundRect(c.x, c.y, cardW, cardH, 14);
      this.ctx2d.fillStyle = selected ? '#3B2B63' : '#261D3F';
      this.ctx2d.fill();
      this.ctx2d.lineWidth = selected ? 2.4 : 1.2;
      this.ctx2d.strokeStyle = selected ? '#D8C7FF' : '#7C52E6';
      this.ctx2d.stroke();

      this.ctx2d.fillStyle = '#F5F0FF';
      this.ctx2d.font = 'bold 12vp sans-serif';
      this.ctx2d.textAlign = 'left';
      this.ctx2d.fillText(c.title.slice(0, 10), c.x + 12, c.y + 22);

      this.ctx2d.fillStyle = '#C5B8E3';
      this.ctx2d.font = '10vp sans-serif';
      this.ctx2d.fillText(c.content.slice(0, 13) + (c.content.length > 13 ? '…' : ''), c.x + 12, c.y + 42);

      if (c.noteRefTitle.length > 0) {
        this.ctx2d.fillStyle = '#B69CFF';
        this.ctx2d.font = '10vp sans-serif';
        this.ctx2d.fillText(`🔗 ${c.noteRefTitle.slice(0, 9)}`, c.x + 12, c.y + 60);
      }
    }
    this.ctx2d.restore();
  }

  private handleCanvasClick(tapX: number, tapY: number): void {
    const hit = LexiSpatialEditor.hitCard(this.board.cards, tapX, tapY, this.boardScale, this.boardPanX, this.boardPanY);
    if (hit) { this.selectCard(hit.id); }
  }

  private beginCanvasDrag(event: GestureEvent): void {
    this.dragCardId = ''; this.dragPanX = this.boardPanX; this.dragPanY = this.boardPanY;
    const finger = event.fingerList.find((item: FingerInfo): boolean => !!item);
    if (!finger) { return; }
    const hit = LexiSpatialEditor.hitCard(this.board.cards, finger.localX - event.offsetX,
      finger.localY - event.offsetY, this.boardScale, this.boardPanX, this.boardPanY);
    if (hit) {
      this.dragCardId = hit.id; this.dragStartX = hit.x; this.dragStartY = hit.y;
      this.selectCard(hit.id);
    }
  }

  private updateCanvasDrag(event: GestureEvent): void {
    const card = this.board.cards.find((item: CanvasCard): boolean => item.id === this.dragCardId);
    if (card) {
      card.x = this.dragStartX + event.offsetX / this.boardScale;
      card.y = this.dragStartY + event.offsetY / this.boardScale;
    } else {
      this.boardPanX = this.dragPanX + event.offsetX;
      this.boardPanY = this.dragPanY + event.offsetY;
    }
    this.drawBoard();
  }

  private finishCanvasDrag(cancelled: boolean): void {
    const card = this.board.cards.find((item: CanvasCard): boolean => item.id === this.dragCardId);
    if (card) {
      if (cancelled) { card.x = this.dragStartX; card.y = this.dragStartY; this.drawBoard(); }
      else { this.persistAndDraw(); }
    } else if (cancelled) {
      this.boardPanX = this.dragPanX; this.boardPanY = this.dragPanY; this.drawBoard();
    }
    this.dragCardId = '';
  }

  @Builder
  private pageTitleBar() {
    LexiBackHeader({
      title: this.board.title || '自由白板',
      subtitle: this.saveStatus || `${this.board.cards.length} 张卡片 · ${this.board.edges.length} 条连线`,
      actionLabel: '导出 JSON',
      onBack: () => {
        this.pathStack.pop();
      },
      onAction: () => {
        LexiStorageService.saveViaDocumentPicker(
          this.context(),
          `${this.board.title || '自由白板'}.json`,
          JSON.stringify(this.board, null, 2)
        )
          .then(() => {
            this.toast('白板 JSON 已导出');
          })
          .catch((err: Error) => {
            this.toast(err.message || '已保存在本机知识库');
          });
      }
    })
  }

  build() {
    NavDestination() {
      Scroll() {
        Column({ space: 14 }) {
          Row({ space: 8 }) {
            TextInput({ text: this.board.title, placeholder: '自由白板名称' })
              .id('canvas-title-input')
              .layoutWeight(1)
              .height(40)
              .fontSize(15)
              .fontWeight(FontWeight.Bold)
              .backgroundColor($r('app.color.surface'))
              .borderRadius(14)
              .onChange((v: string) => {
                this.board.title = v;
                this.schedulePersistAndDraw();
              })
            Button('+ 新增卡片', { type: ButtonType.Normal })
              .id('canvas-add-card')
              .height(40)
              .padding({ left: 14, right: 14 })
              .fontSize(12)
              .fontWeight(FontWeight.Medium)
              .borderRadius(14)
              .backgroundColor($r('app.color.brand'))
              .fontColor($r('app.color.inverse_text'))
              .onClick(() => {
                this.addCard();
              })
            Button('适应画布', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
              .id('canvas-fit').height(40).fontSize(12).fontColor($r('app.color.brand_ink'))
              .onClick((): void => { this.viewFitted = false; this.drawBoard(); })
          }
          .width('100%')

          Canvas(this.ctx2d)
            .id('canvas-board')
            .accessibilityText(`白板画布，${this.board.cards.length} 张卡片。拖动卡片调整位置，拖动空白平移。`)
            .width('100%')
            .height(350)
            .backgroundColor($r('app.color.canvas_surface'))
            .borderRadius(24)
            .onReady(() => {
              this.canvasReady = true;
              this.drawBoard();
            })
            .onAreaChange((_old: Area, area: Area) => {
              if (this.canvasWidth !== Number(area.width) || this.canvasHeight !== Number(area.height)) { this.viewFitted = false; }
              this.canvasWidth = Number(area.width);
              this.canvasHeight = Number(area.height);
              this.drawBoard();
            })
            .onClick((e: ClickEvent) => {
              this.handleCanvasClick(e.x, e.y);
            })
            .priorityGesture(
              PanGesture({ distance: 4 })
                .onActionStart((event: GestureEvent): void => { this.beginCanvasDrag(event); })
                .onActionUpdate((event: GestureEvent): void => { this.updateCanvasDrag(event); })
                .onActionEnd((): void => { this.finishCanvasDrag(false); })
                .onActionCancel((): void => { this.finishCanvasDrag(true); })
            )

          if (this.currentCard()) {
            Column({ space: 12 }) {
              Row() {
                Text('卡片编辑')
                  .fontSize(14)
                  .fontWeight(FontWeight.Bold)
                  .fontColor($r('app.color.text_primary'))
                Blank()
                Row({ space: 4 }) {
                  Button('←', { type: ButtonType.Normal })
                    .width(34)
              .padding(0)
                    .height(30)
                    .fontSize(12)
                    .borderRadius(8)
                    .backgroundColor($r('app.color.soft_surface'))
                    .fontColor($r('app.color.text_primary'))
                    .onClick(() => {
                      this.nudgeSelected(-24, 0);
                    })
                  Button('↑', { type: ButtonType.Normal })
                    .width(34)
              .padding(0)
                    .height(30)
                    .fontSize(12)
                    .borderRadius(8)
                    .backgroundColor($r('app.color.soft_surface'))
                    .fontColor($r('app.color.text_primary'))
                    .onClick(() => {
                      this.nudgeSelected(0, -20);
                    })
                  Button('↓', { type: ButtonType.Normal })
                    .width(34)
              .padding(0)
                    .height(30)
                    .fontSize(12)
                    .borderRadius(8)
                    .backgroundColor($r('app.color.soft_surface'))
                    .fontColor($r('app.color.text_primary'))
                    .onClick(() => {
                      this.nudgeSelected(0, 20);
                    })
                  Button('→', { type: ButtonType.Normal })
                    .width(34)
              .padding(0)
                    .height(30)
                    .fontSize(12)
                    .borderRadius(8)
                    .backgroundColor($r('app.color.soft_surface'))
                    .fontColor($r('app.color.text_primary'))
                    .onClick(() => {
                      this.nudgeSelected(24, 0);
                    })
                }
              }
              .width('100%')

              TextInput({ text: this.cardTitle, placeholder: '卡片标题' })
                .width('100%')
                .height(38)
                .fontSize(14)
                .backgroundColor($r('app.color.soft_surface'))
                .borderRadius(12)
                .onChange((val: string) => {
                  this.cardTitle = val;
                  const c = this.currentCard();
                  if (c && c.title !== val) {
                    c.title = val;
                    this.schedulePersistAndDraw();
                  }
                })

              TextArea({ text: this.cardContent, placeholder: '卡片思考摘录…' })
                .width('100%')
                .height(74)
                .fontSize(13)
                .backgroundColor($r('app.color.soft_surface'))
                .borderRadius(12)
                .onChange((val: string) => {
                  this.cardContent = val;
                  const c = this.currentCard();
                  if (c && c.content !== val) {
                    c.content = val;
                    this.schedulePersistAndDraw();
                  }
                })

              Text('点击其他卡片建立/解除连线：')
                .fontSize(12)
                .fontColor($r('app.color.text_secondary'))
                .width('100%')

              Flex({ wrap: FlexWrap.Wrap }) {
                ForEach(
                  this.board.cards.filter((c: CanvasCard): boolean => c.id !== this.selectedCardId),
                  (other: CanvasCard) => {
                    Button(`⇄ 连接「${other.title}」`, { type: ButtonType.Normal })
                      .height(32)
                      .margin({ right: 6, bottom: 6 })
                      .fontSize(11)
                      .borderRadius(9)
                      .backgroundColor($r('app.color.brand_soft'))
                      .fontColor($r('app.color.brand'))
                      .onClick(() => {
                        this.toggleConnectionWith(other.id);
                      })
                  },
                  (other: CanvasCard): string => other.id
                )
              }
              .width('100%')

              Text('引用知识库笔记：')
                .fontSize(12)
                .fontColor($r('app.color.text_secondary'))
                .width('100%')

              Flex({ wrap: FlexWrap.Wrap }) {
                if (this.currentCard()?.noteRefId) {
                  Button(`打开「${this.currentCard()?.noteRefTitle}」→`, { type: ButtonType.Normal })
                    .height(32)
                    .margin({ right: 6, bottom: 6 })
                    .fontSize(11)
                    .borderRadius(9)
                    .backgroundColor($r('app.color.brand'))
                    .fontColor($r('app.color.inverse_text'))
                    .onClick(() => {
                      const param = new NoteEditorRouteParam();
                      param.noteId = this.currentCard()?.noteRefId || '';
                      this.pathStack.pushPathByName('noteEditor', param);
                    })
                }
                ForEach(
                  this.vaultNotes,
                  (n: NoteItem) => {
                    Button(`关联：${MarkdownEngine.displayTitle(n)}`, { type: ButtonType.Normal })
                      .height(32)
                      .margin({ right: 6, bottom: 6 })
                      .fontSize(11)
                      .borderRadius(9)
                      .backgroundColor($r('app.color.soft_surface'))
                      .fontColor($r('app.color.text_primary'))
                      .onClick(() => {
                        const c = this.currentCard();
                        if (c) {
                          c.noteRefId = n.id;
                          c.noteRefTitle = MarkdownEngine.displayTitle(n);
                          this.persistAndDraw();
                          this.toast(`卡片已引用「${c.noteRefTitle}」`);
                        }
                      })
                  },
                  (n: NoteItem): string => n.id
                )
              }
              .width('100%')
            }
            .width('100%')
            .padding(16)
            .backgroundColor($r('app.color.surface'))
            .borderRadius(22)
          }
        }
        .width('100%')
        .constraintSize({ maxWidth: 1040 })
        .padding({ left: 20, right: 20, bottom: 36 + this.bottomInset })
      }
      .width('100%')
      .height('100%')
      .contentStartOffset(56 + (this.viewportWidth < 840 ? this.titleTopInset : 0))
      .contentEndOffset(0)
      .scrollBar(BarState.Off)
      .align(Alignment.Top)
      .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
    }
    .hideBackButton(true)
    .title(
      {
        builder: () => {
          this.pageTitleBar();
        },
        height: 56 + (this.viewportWidth < 840 ? this.titleTopInset : 0)
      },
      {
        barStyle: BarStyle.STACK,
        scrollEffectOptions: { scrollEffectType: ScrollEffectType.GRADUAL_BLUR }
      }
    )
    .backgroundColor($r('app.color.background'))
    .onReady((ctx: NavDestinationContext) => {
      this.pathStack = ctx.pathStack;
      const param = ctx.pathInfo.param as CanvasRouteParam | undefined;
      this.loadFromRoute(param);
    })
  }
}
