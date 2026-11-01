import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { LexiBackHeader } from '../components/LexiBackHeader';
import { LexiIcon } from '../components/LexiIcon';
import {
  MindMapDoc,
  MindMapNode,
  MindMapRouteParam,
  NoteEditorRouteParam,
  NoteItem
} from '../core/LexiModels';
import { MarkdownEngine } from '../core/MarkdownEngine';
import { LexiStorageService } from '../core/LexiStorageService';
import { LexiSpatialEditor } from '../core/LexiSpatialEditor';

@Builder
export function mindMapEditorBuilder() {
  MindMapPage()
}

@Component
export struct MindMapPage {
  @StorageProp('lexiTopInset') titleTopInset: number = 0;
  @StorageProp('lexiBottomInset') bottomInset: number = 0;
  @StorageProp('lexiViewportWidth') viewportWidth: number = 390;
  @State private doc: MindMapDoc = new MindMapDoc();
  @State private visibleNodes: MindMapNode[] = [];
  @State private selectedNodeId: string = 'root';
  @State private editNodeText: string = '';
  @State private editNodeNote: string = '';
  @State private viewKind: string = 'map'; // 'map' | 'outline'
  @State private showNoteLinker: boolean = false;
  @State private vaultNotes: NoteItem[] = [];
  @State private zoomScale: number = 1.0;
  @State private panX: number = 0;
  @State private panY: number = 0;
  @State private undoCount: number = 0;
  @State private redoCount: number = 0;
  @State private saveStatus: string = '已保存';
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private lastSnapshotAt: number = 0;
  private saveTimer: number = -1;
  private readonly canvasSettings: RenderingContextSettings = new RenderingContextSettings(true);
  private readonly ctx2d: CanvasRenderingContext2D = new CanvasRenderingContext2D(this.canvasSettings);
  private canvasReady: boolean = false;
  private viewFitted: boolean = false;
  private canvasWidth: number = 360;
  private canvasHeight: number = 420;
  private dragStartX: number = 0;
  private dragStartY: number = 0;
  private dragNodeId: string = '';
  private dragLastX: number = 0;
  private dragLastY: number = 0;
  private dragSnapshot: string = '';
  private dragUndoSnapshot: string[] = [];
  private dragRedoSnapshot: string[] = [];
  private pathStack: NavPathStack = new NavPathStack();

  aboutToDisappear(): void {
    if (this.saveTimer >= 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = -1;
      LexiStorageService.saveMindMap(this.context(), this.doc).catch(() => {});
    }
  }

  private context(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  private toast(msg: string): void {
    this.getUIContext().getPromptAction().showToast({ message: msg });
  }

  private async loadFromRoute(param: MindMapRouteParam | undefined): Promise<void> {
    await LexiStorageService.init(this.context());
    const vaultId = await LexiStorageService.getActiveVaultId();
    this.vaultNotes = (await LexiStorageService.getNotes(vaultId)).filter(
      (n: NoteItem): boolean => n.trashedAt === 0
    );

    if (param && param.mapId.length > 0 && !param.createNew) {
      const found = await LexiStorageService.getMindMapById(param.mapId);
      if (found) {
        this.doc = found;
        this.selectNode(found.rootNodeId || 'root');
        this.relayoutAndDraw();
        return;
      }
    }

    if (param && param.fromNoteId.length > 0) {
      const srcNote = await LexiStorageService.getNoteById(param.fromNoteId);
      if (srcNote) {
        const generated = new MindMapDoc();
        generated.vaultId = vaultId;
        generated.projectId = srcNote.projectId || '';
        generated.title = `${MarkdownEngine.displayTitle(srcNote)} · 导图`;
        generated.layoutKind = 'right';
        generated.rootNodeId = 'root';
        generated.nodes = MarkdownEngine.markdownToMindMapNodes(
          MarkdownEngine.displayTitle(srcNote),
          srcNote.content,
          srcNote.id
        );
        this.doc = await LexiStorageService.saveMindMap(this.context(), generated);
        this.selectNode('root');
        this.relayoutAndDraw();
        return;
      }
    }

    const fresh = new MindMapDoc();
    fresh.vaultId = vaultId;
    fresh.projectId = param && param.projectId ? param.projectId : await LexiStorageService.getActiveProjectId(vaultId);
    fresh.title = '新建思维导图';
    fresh.layoutKind = 'right';
    fresh.rootNodeId = 'root';
    fresh.nodes = MarkdownEngine.markdownToMindMapNodes('中心主题', '');
    this.doc = await LexiStorageService.saveMindMap(this.context(), fresh);
    this.selectNode('root');
    this.relayoutAndDraw();
  }

  private pushSnapshot(force: boolean = false): void {
    const now = Date.now();
    if (!force && now - this.lastSnapshotAt < 600 && this.undoStack.length > 0) {
      this.lastSnapshotAt = now;
      return;
    }
    const snap = JSON.stringify(this.doc.nodes);
    if (this.undoStack.length > 0 && this.undoStack[this.undoStack.length - 1] === snap) {
      return;
    }
    this.lastSnapshotAt = now;
    this.undoStack.push(snap);
    if (this.undoStack.length > 40) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.undoCount = this.undoStack.length;
    this.redoCount = 0;
  }

  private undo(): void {
    if (this.undoStack.length === 0) {
      return;
    }
    this.lastSnapshotAt = 0;
    this.redoStack.push(JSON.stringify(this.doc.nodes));
    const prev = this.undoStack.pop()!;
    this.doc.nodes = JSON.parse(prev) as MindMapNode[];
    this.undoCount = this.undoStack.length;
    this.redoCount = this.redoStack.length;
    this.selectNode(this.selectedNodeId);
    this.persistAndRedraw();
  }

  private redo(): void {
    if (this.redoStack.length === 0) {
      return;
    }
    this.lastSnapshotAt = 0;
    this.undoStack.push(JSON.stringify(this.doc.nodes));
    const next = this.redoStack.pop()!;
    this.doc.nodes = JSON.parse(next) as MindMapNode[];
    this.undoCount = this.undoStack.length;
    this.redoCount = this.redoStack.length;
    this.selectNode(this.selectedNodeId);
    this.persistAndRedraw();
  }

  private currentSelectedNode(): MindMapNode | undefined {
    return this.doc.nodes.find((n: MindMapNode): boolean => n.id === this.selectedNodeId) || this.doc.nodes[0];
  }

  private selectNode(nodeId: string): void {
    const found = this.doc.nodes.find((n: MindMapNode): boolean => n.id === nodeId) || this.doc.nodes[0];
    if (!found) {
      return;
    }
    this.selectedNodeId = found.id;
    this.editNodeText = found.text;
    this.editNodeNote = found.note;
    this.drawCanvas();
  }

  private relayoutAndDraw(): void {
    this.visibleNodes = MarkdownEngine.computeMindMapLayout(this.doc);
    if (this.canvasReady && !this.viewFitted && this.visibleNodes.length > 0) {
      this.fitCanvasToNodes();
    }
    this.drawCanvas();
  }

  private fitCanvasToNodes(): void {
    if (this.visibleNodes.length === 0) { return; }
    let left: number = Number.POSITIVE_INFINITY;
    let right: number = Number.NEGATIVE_INFINITY;
    let top: number = Number.POSITIVE_INFINITY;
    let bottom: number = Number.NEGATIVE_INFINITY;
    for (const node of this.visibleNodes) {
      left = Math.min(left, node.x - node.boxWidth / 2);
      right = Math.max(right, node.x + node.boxWidth / 2);
      top = Math.min(top, node.y - node.boxHeight / 2);
      bottom = Math.max(bottom, node.y + node.boxHeight / 2);
    }
    this.zoomScale = Math.max(0.1, Math.min(1, (this.canvasWidth - 40) / Math.max(1, right - left),
      (this.canvasHeight - 40) / Math.max(1, bottom - top)));
    this.panX = this.canvasWidth / 2 - ((left + right) / 2) * this.zoomScale;
    this.panY = this.canvasHeight / 2 - ((top + bottom) / 2) * this.zoomScale;
    this.viewFitted = true;
  }

  private persistAndRedraw(): void {
    if (this.saveTimer >= 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = -1;
    }
    this.doc = JSON.parse(JSON.stringify(this.doc)) as MindMapDoc;
    this.relayoutAndDraw();
    LexiStorageService.saveMindMap(this.context(), this.doc)
      .then(() => {
        this.saveStatus = `已保存 · ${this.doc.nodes.length} 个节点`;
      })
      .catch(() => {
        this.saveStatus = '待重试保存';
      });
  }

  private schedulePersistAndRedraw(): void {
    this.relayoutAndDraw();
    if (this.saveTimer >= 0) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = -1;
      LexiStorageService.saveMindMap(this.context(), this.doc)
        .then(() => {
          this.saveStatus = `已保存 · ${this.doc.nodes.length} 个节点`;
        })
        .catch(() => {
          this.saveStatus = '待重试保存';
        });
    }, 320);
  }

  private addChildNode(): void {
    const parent = this.currentSelectedNode();
    if (!parent) {
      return;
    }
    this.pushSnapshot();
    parent.collapsed = false;
    const siblings = this.doc.nodes.filter((n: MindMapNode): boolean => n.parentId === parent.id);
    const child = new MindMapNode();
    child.id = `node-${util.generateRandomUUID(true)}`;
    child.parentId = parent.id;
    child.text = `子主题 ${siblings.length + 1}`;
    child.order = siblings.length + 1;
    child.colorTag = parent.id === this.doc.rootNodeId
      ? ['purple', 'indigo', 'teal', 'amber', 'rose'][siblings.length % 5]
      : parent.colorTag;
    this.doc.nodes.push(child);
    this.selectNode(child.id);
    this.viewFitted = false;
    this.persistAndRedraw();
  }

  private addSiblingNode(): void {
    const current = this.currentSelectedNode();
    if (!current) {
      return;
    }
    if (current.id === this.doc.rootNodeId || !current.parentId) {
      this.addChildNode();
      return;
    }
    this.pushSnapshot();
    const siblings = this.doc.nodes.filter((n: MindMapNode): boolean => n.parentId === current.parentId);
    const node = new MindMapNode();
    node.id = `node-${util.generateRandomUUID(true)}`;
    node.parentId = current.parentId;
    node.text = `同级主题 ${siblings.length + 1}`;
    node.order = current.order + 1;
    node.colorTag = current.colorTag;
    this.doc.nodes.push(node);
    this.selectNode(node.id);
    this.viewFitted = false;
    this.persistAndRedraw();
  }

  private toggleCollapseSelected(): void {
    const current = this.currentSelectedNode();
    if (!current || current.id === this.doc.rootNodeId) {
      return;
    }
    const hasChildren = this.doc.nodes.some((n: MindMapNode): boolean => n.parentId === current.id);
    if (!hasChildren) {
      this.toast('当前节点暂无子分支');
      return;
    }
    this.pushSnapshot();
    current.collapsed = !current.collapsed;
    this.persistAndRedraw();
  }

  private moveSelectedOrder(delta: number): void {
    const current = this.currentSelectedNode();
    if (!current || !current.parentId) {
      return;
    }
    const siblings = this.doc.nodes
      .filter((n: MindMapNode): boolean => n.parentId === current.parentId)
      .sort((a: MindMapNode, b: MindMapNode): number => a.order - b.order);
    const idx = siblings.findIndex((n: MindMapNode): boolean => n.id === current.id);
    const targetIdx = idx + delta;
    if (idx < 0 || targetIdx < 0 || targetIdx >= siblings.length) {
      return;
    }
    this.pushSnapshot();
    const temp = siblings[idx].order;
    siblings[idx].order = siblings[targetIdx].order;
    siblings[targetIdx].order = temp;
    if (siblings[idx].order === siblings[targetIdx].order) {
      for (let i = 0; i < siblings.length; i++) {
        siblings[i].order = i + 1;
      }
      const swap = siblings[idx].order;
      siblings[idx].order = siblings[targetIdx].order;
      siblings[targetIdx].order = swap;
    }
    this.persistAndRedraw();
  }

  private deleteSelectedSubtree(): void {
    const current = this.currentSelectedNode();
    if (!current || current.id === this.doc.rootNodeId) {
      this.toast('中心根节点不能删除');
      return;
    }
    this.pushSnapshot();
    const toDelete = new Set<string>([current.id]);
    let added = true;
    while (added) {
      added = false;
      for (let i = 0; i < this.doc.nodes.length; i++) {
        const candidate = this.doc.nodes[i];
        if (toDelete.has(candidate.parentId) && !toDelete.has(candidate.id)) {
          toDelete.add(candidate.id);
          added = true;
        }
      }
    }
    const parentId = current.parentId || this.doc.rootNodeId;
    this.doc.nodes = this.doc.nodes.filter((n: MindMapNode): boolean => !toDelete.has(n.id));
    this.selectNode(parentId);
    this.persistAndRedraw();
    this.toast('已移除节点分支（关联的实际笔记安全保留）');
  }

  private linkSelectedToNote(note: NoteItem): void {
    const current = this.currentSelectedNode();
    if (!current) {
      return;
    }
    this.pushSnapshot();
    current.noteRefId = note.id;
    current.noteRefTitle = MarkdownEngine.displayTitle(note);
    this.showNoteLinker = false;
    this.persistAndRedraw();
    this.toast(`节点已关联至笔记「${current.noteRefTitle}」`);
  }

  private async createNoteFromSelectedNode(): Promise<void> {
    const current = this.currentSelectedNode();
    if (!current) {
      return;
    }
    const created = new NoteItem();
    created.vaultId = this.doc.vaultId;
    created.projectId = this.doc.projectId || '';
    created.title = current.text;
    created.notebook = '导图衍生笔记';
    created.noteType = 'study';
    created.editorLevel = 'study';
    created.tags = ['导图关联'];
    created.content = `# ${current.text}\n\n${current.note ? `> ${current.note}\n\n` : ''}来自思维导图「${this.doc.title}」的关联知识节点。\n`;
    const saved = await LexiStorageService.saveNote(this.context(), created);
    this.vaultNotes = (await LexiStorageService.getNotes(this.doc.vaultId)).filter(
      (n: NoteItem): boolean => n.trashedAt === 0
    );
    this.linkSelectedToNote(saved);
  }

  private openLinkedNote(noteId: string): void {
    if (!noteId) {
      return;
    }
    const param = new NoteEditorRouteParam();
    param.noteId = noteId;
    this.pathStack.pushPathByName('noteEditor', param);
  }

  private nodeAccentColor(colorTag: string, isRoot: boolean): string {
    if (isRoot) {
      return '#6E44D9';
    }
    if (colorTag === 'indigo') {
      return '#5258E8';
    }
    if (colorTag === 'teal') {
      return '#2C8C7C';
    }
    if (colorTag === 'amber') {
      return '#C7812C';
    }
    if (colorTag === 'rose') {
      return '#C44D78';
    }
    return '#7C52E6';
  }

  private drawCanvas(): void {
    if (!this.canvasReady || this.canvasWidth <= 0) {
      return;
    }
    this.ctx2d.clearRect(0, 0, this.canvasWidth, this.canvasHeight);

    // Draw subtle background grid dots in screen space to avoid hundreds of arc paths
    this.ctx2d.fillStyle = 'rgba(182, 156, 255, 0.14)';
    for (let gx = 20; gx < this.canvasWidth; gx += 32) {
      for (let gy = 20; gy < this.canvasHeight; gy += 32) {
        this.ctx2d.fillRect(gx, gy, 2, 2);
      }
    }

    this.ctx2d.save();
    this.ctx2d.translate(this.panX, this.panY);
    this.ctx2d.scale(this.zoomScale, this.zoomScale);

    // Draw curved edges first
    for (let i = 0; i < this.visibleNodes.length; i++) {
      const child = this.visibleNodes[i];
      if (!child.parentId) {
        continue;
      }
      const parent = this.visibleNodes.find((n: MindMapNode): boolean => n.id === child.parentId);
      if (!parent) {
        continue;
      }
      const accent = this.nodeAccentColor(child.colorTag, false);
      this.ctx2d.beginPath();
      this.ctx2d.strokeStyle = accent;
      this.ctx2d.lineWidth = 2.2;
      if (this.doc.layoutKind === 'org') {
        const sx = parent.x;
        const sy = parent.y + parent.boxHeight / 2;
        const ex = child.x;
        const ey = child.y - child.boxHeight / 2;
        const my = (sy + ey) / 2;
        this.ctx2d.moveTo(sx, sy);
        this.ctx2d.bezierCurveTo(sx, my, ex, my, ex, ey);
      } else {
        const goingLeft = child.x < parent.x;
        const sx = goingLeft ? parent.x - parent.boxWidth / 2 : parent.x + parent.boxWidth / 2;
        const sy = parent.y;
        const ex = goingLeft ? child.x + child.boxWidth / 2 : child.x - child.boxWidth / 2;
        const ey = child.y;
        const mx = (sx + ex) / 2;
        this.ctx2d.moveTo(sx, sy);
        this.ctx2d.bezierCurveTo(mx, sy, mx, ey, ex, ey);
      }
      this.ctx2d.stroke();
    }

    // Draw nodes
    for (let i = 0; i < this.visibleNodes.length; i++) {
      const node = this.visibleNodes[i];
      const isRoot = node.id === this.doc.rootNodeId;
      const isSelected = node.id === this.selectedNodeId;
      const accent = this.nodeAccentColor(node.colorTag, isRoot);
      const rx = node.x - node.boxWidth / 2;
      const ry = node.y - node.boxHeight / 2;

      this.ctx2d.beginPath();
      this.ctx2d.roundRect(rx, ry, node.boxWidth, node.boxHeight, 12);
      if (isRoot) {
        this.ctx2d.fillStyle = '#6E44D9';
      } else if (isSelected) {
        this.ctx2d.fillStyle = '#38295C';
      } else {
        this.ctx2d.fillStyle = '#261E3D';
      }
      if (isSelected) {
        this.ctx2d.shadowColor = '#B69CFF';
        this.ctx2d.shadowBlur = 12;
      }
      this.ctx2d.fill();
      if (isSelected) {
        this.ctx2d.shadowBlur = 0;
      }

      this.ctx2d.lineWidth = isSelected ? 2.5 : 1.3;
      this.ctx2d.strokeStyle = isSelected ? '#E0D0FF' : accent;
      this.ctx2d.stroke();

      // Node main label
      this.ctx2d.fillStyle = '#F5F0FF';
      this.ctx2d.font = `${isRoot ? 'bold 14vp' : 'medium 13vp'} sans-serif`;
      this.ctx2d.textAlign = 'center';
      this.ctx2d.textBaseline = 'middle';
      const label = node.text.length > 11 ? `${node.text.slice(0, 10)}…` : node.text;
      const textY = node.noteRefId.length > 0 || node.note.length > 0 ? node.y - 6 : node.y;
      this.ctx2d.fillText(label, node.x, textY);

      if (node.noteRefId.length > 0 || node.note.length > 0) {
        this.ctx2d.fillStyle = '#C9B5FF';
        this.ctx2d.font = '10vp sans-serif';
        const subText = node.noteRefTitle.length > 0 ? `🔗 ${node.noteRefTitle.slice(0, 9)}` : `✦ ${node.note.slice(0, 9)}`;
        this.ctx2d.fillText(subText, node.x, node.y + 11);
      }

      // Collapsed children badge
      const hiddenCount = this.doc.nodes.filter((c: MindMapNode): boolean => c.parentId === node.id).length;
      if (node.collapsed && hiddenCount > 0) {
        const bx = rx + node.boxWidth + 10;
        const by = node.y;
        this.ctx2d.beginPath();
        this.ctx2d.arc(bx, by, 10, 0, Math.PI * 2);
        this.ctx2d.fillStyle = '#6E44D9';
        this.ctx2d.fill();
        this.ctx2d.fillStyle = '#FFFFFF';
        this.ctx2d.font = 'bold 10vp sans-serif';
        this.ctx2d.fillText(`+${hiddenCount}`, bx, by);
      }
    }

    this.ctx2d.restore();
  }

  private handleCanvasTap(tapX: number, tapY: number): void {
    const hit = LexiSpatialEditor.hitNode(this.visibleNodes, tapX, tapY, this.zoomScale, this.panX, this.panY);
    if (hit) { this.selectNode(hit.id); }
  }

  private beginCanvasDrag(event: GestureEvent): void {
    this.dragStartX = this.panX; this.dragStartY = this.panY;
    this.dragLastX = 0; this.dragLastY = 0; this.dragNodeId = ''; this.dragSnapshot = '';
    const finger = event.fingerList.find((item: FingerInfo): boolean => !!item);
    if (!finger) { return; }
    const hit = LexiSpatialEditor.hitNode(this.visibleNodes, finger.localX - event.offsetX,
      finger.localY - event.offsetY, this.zoomScale, this.panX, this.panY);
    if (hit) {
      this.dragNodeId = hit.id;
      this.dragSnapshot = JSON.stringify(this.doc.nodes);
      this.dragUndoSnapshot = this.undoStack.slice();
      this.dragRedoSnapshot = this.redoStack.slice();
      this.pushSnapshot(); this.selectNode(hit.id);
    }
  }

  private updateCanvasDrag(event: GestureEvent): void {
    if (this.dragNodeId) {
      const dx = event.offsetX / this.zoomScale;
      const dy = event.offsetY / this.zoomScale;
      LexiSpatialEditor.moveBranch(this.doc, this.dragNodeId, dx - this.dragLastX, dy - this.dragLastY);
      this.dragLastX = dx; this.dragLastY = dy;
      this.drawCanvas();
    } else {
      this.panX = this.dragStartX + event.offsetX;
      this.panY = this.dragStartY + event.offsetY;
      this.drawCanvas();
    }
  }

  private finishCanvasDrag(cancelled: boolean): void {
    if (this.dragNodeId) {
      if (cancelled) {
        this.doc.nodes = JSON.parse(this.dragSnapshot) as MindMapNode[];
        this.undoStack = this.dragUndoSnapshot;
        this.redoStack = this.dragRedoSnapshot;
        this.undoCount = this.undoStack.length;
        this.redoCount = this.redoStack.length;
        this.relayoutAndDraw();
      } else { this.persistAndRedraw(); }
    } else if (cancelled) {
      this.panX = this.dragStartX; this.panY = this.dragStartY; this.drawCanvas();
    }
    this.dragNodeId = ''; this.dragSnapshot = ''; this.dragUndoSnapshot = []; this.dragRedoSnapshot = [];
  }

  private async exportOutlineOrJson(asJson: boolean): Promise<void> {
    const ext = asJson ? 'json' : 'md';
    const content = asJson
      ? JSON.stringify(this.doc, null, 2)
      : MarkdownEngine.mindMapToMarkdownOutline(this.doc);
    const fileName = `${this.doc.title || '思维导图'}.${ext}`;
    try {
      await LexiStorageService.saveViaDocumentPicker(this.context(), fileName, content);
      this.toast(asJson ? '导图 JSON 已导出' : 'Markdown 大纲已导出');
    } catch (err) {
      this.toast((err as Error).message || '已保存在本机知识库');
    }
  }

  @Builder
  topControlStrip() {
    Column({ space: 10 }) {
      Row({ space: 8 }) {
        TextInput({ text: this.doc.title, placeholder: '思维导图标题' })
          .layoutWeight(1)
          .padding({ left: 8, right: 8 })
          .height(38)
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .backgroundColor($r('app.color.soft_surface'))
          .borderRadius(12)
          .onChange((val: string) => {
            this.doc.title = val;
            const root = this.doc.nodes.find((n: MindMapNode): boolean => n.id === this.doc.rootNodeId);
            if (root && val.trim().length > 0) {
              root.text = val.trim();
            }
            this.schedulePersistAndRedraw();
          })

        Row({ space: 4 }) {
          Button('导图', { type: ButtonType.Normal })
            .height(32)
            .padding({ left: 12, right: 12 })
            .fontSize(12)
            .borderRadius(10)
            .backgroundColor(this.viewKind === 'map' ? $r('app.color.brand') : Color.Transparent)
            .fontColor(this.viewKind === 'map' ? $r('app.color.inverse_text') : $r('app.color.text_secondary'))
            .onClick(() => {
              this.viewKind = 'map';
              this.relayoutAndDraw();
            })
          Button('大纲', { type: ButtonType.Normal })
            .height(32)
            .padding({ left: 12, right: 12 })
            .fontSize(12)
            .borderRadius(10)
            .backgroundColor(this.viewKind === 'outline' ? $r('app.color.brand') : Color.Transparent)
            .fontColor(this.viewKind === 'outline' ? $r('app.color.inverse_text') : $r('app.color.text_secondary'))
            .onClick(() => {
              this.viewKind = 'outline';
            })
        }
        .padding(3)
        .backgroundColor($r('app.color.soft_surface'))
        .borderRadius(12)
      }
      .width('100%')

      Row({ space: 8 }) {
        Button('+ 子主题', { type: ButtonType.Normal })
          .id('mindmap-add-child').layoutWeight(1).height(40).fontSize(12).borderRadius(12)
          .backgroundColor($r('app.color.brand')).fontColor($r('app.color.inverse_text'))
          .onClick((): void => { this.addChildNode(); })
        Button('+ 同级主题', { type: ButtonType.Normal })
          .id('mindmap-add-sibling').layoutWeight(1).height(40).fontSize(12).borderRadius(12)
          .backgroundColor($r('app.color.brand_soft')).fontColor($r('app.color.brand_ink'))
          .onClick((): void => { this.addSiblingNode(); })
      }.width('100%')

      Row({ space: 6 }) {
        ForEach(
          [
            ['right', '向右'],
            ['balanced', '双向'],
            ['org', '组织']
          ],
          (item: string[]) => {
            Button(item[1], { type: ButtonType.Normal })
              .layoutWeight(1)
              .height(32)
              .fontSize(11)
              .borderRadius(10)
              .backgroundColor(this.doc.layoutKind === item[0] ? $r('app.color.brand_soft') : $r('app.color.soft_surface'))
              .fontColor(this.doc.layoutKind === item[0] ? $r('app.color.brand') : $r('app.color.text_secondary'))
              .onClick(() => {
                this.doc.layoutKind = item[0];
                this.viewFitted = false;
                this.persistAndRedraw();
              })
          },
          (item: string[]): string => item[0]
        )

        Button({ type: ButtonType.Normal }) {
          LexiIcon({ name: 'undo', iconSize: 16, muted: this.undoCount === 0 })
        }
        .width(34)
        .padding(0)
        .height(32)
        .borderRadius(10)
        .enabled(this.undoCount > 0)
        .backgroundColor($r('app.color.soft_surface'))
        .onClick(() => {
          this.undo();
        })

        Button({ type: ButtonType.Normal }) {
          LexiIcon({ name: 'redo', iconSize: 16, muted: this.redoCount === 0 })
        }
        .width(34)
        .padding(0)
        .height(32)
        .borderRadius(10)
        .enabled(this.redoCount > 0)
        .backgroundColor($r('app.color.soft_surface'))
        .onClick(() => {
          this.redo();
        })
      }
      .width('100%')
    }
    .width('100%')
    .padding(14)
    .backgroundColor($r('app.color.surface'))
    .borderRadius(20)
  }

  @Builder
  nodeInspectorCard() {
    Column({ space: 12 }) {
      Row({ space: 6 }) {
        Button(this.currentSelectedNode()?.collapsed ? '展开' : '折叠', { type: ButtonType.Normal })
          .height(38)
          .padding({ left: 10, right: 10 })
          .fontSize(12)
          .borderRadius(12)
          .backgroundColor($r('app.color.soft_surface'))
          .fontColor($r('app.color.text_primary'))
          .onClick(() => {
            this.toggleCollapseSelected();
          })

        Button('↑', { type: ButtonType.Normal })
          .width(36)
        .padding(0)
          .height(38)
          .fontSize(14)
          .borderRadius(12)
          .backgroundColor($r('app.color.soft_surface'))
          .fontColor($r('app.color.text_primary'))
          .onClick(() => {
            this.moveSelectedOrder(-1);
          })

        Button('↓', { type: ButtonType.Normal })
          .width(36)
        .padding(0)
          .height(38)
          .fontSize(14)
          .borderRadius(12)
          .backgroundColor($r('app.color.soft_surface'))
          .fontColor($r('app.color.text_primary'))
          .onClick(() => {
            this.moveSelectedOrder(1);
          })

        Button({ type: ButtonType.Normal }) {
          LexiIcon({ name: 'trash', iconSize: 17 })
        }
        .width(38)
        .padding(0)
        .height(38)
        .borderRadius(12)
        .backgroundColor($r('app.color.soft_surface'))
        .onClick(() => {
          this.deleteSelectedSubtree();
        })
      }
      .width('100%')

      Row({ space: 8 }) {
        TextInput({ text: this.editNodeText, placeholder: '节点主题文字' })
          .layoutWeight(1)
          .height(40)
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .backgroundColor($r('app.color.soft_surface'))
          .borderRadius(12)
          .onChange((val: string) => {
            this.editNodeText = val;
            const current = this.currentSelectedNode();
            if (current && current.text !== val) {
              this.pushSnapshot(false);
              current.text = val;
              this.schedulePersistAndRedraw();
            }
          })

        TextInput({ text: this.editNodeNote, placeholder: '节点简短备注…' })
          .layoutWeight(1)
          .height(40)
          .fontSize(13)
          .backgroundColor($r('app.color.soft_surface'))
          .borderRadius(12)
          .onChange((val: string) => {
            this.editNodeNote = val;
            const current = this.currentSelectedNode();
            if (current && current.note !== val) {
              current.note = val;
              this.schedulePersistAndRedraw();
            }
          })
      }
      .width('100%')

      Flex({ wrap: FlexWrap.Wrap }) {
        ForEach(
          [
            ['purple', '#6E44D9', '紫晶'],
            ['indigo', '#5258E8', '靛蓝'],
            ['teal', '#2C8C7C', '青翠'],
            ['amber', '#C7812C', '琥珀'],
            ['rose', '#C44D78', '暮粉']
          ],
          (colorItem: string[]) => {
            Button(colorItem[2], { type: ButtonType.Normal })
              .height(30)
              .margin({ right: 8, bottom: 8 })
              .padding({ left: 10, right: 10 })
              .fontSize(11)
              .borderRadius(9)
              .backgroundColor(colorItem[1])
              .fontColor('#FFFFFF')
              .onClick(() => {
                const current = this.currentSelectedNode();
                if (current) {
                  this.pushSnapshot();
                  current.colorTag = colorItem[0];
                  this.persistAndRedraw();
                }
              })
          },
          (colorItem: string[]): string => colorItem[0]
        )


        Button(
          this.currentSelectedNode()?.noteRefId
            ? `🔗 ${this.currentSelectedNode()?.noteRefTitle.slice(0, 12)}`
            : '🔗 关联笔记',
          { type: ButtonType.Normal }
        )
          .height(32)
          .constraintSize({ maxWidth: '100%' })
          .padding({ left: 12, right: 12 })
          .fontSize(12)
          .borderRadius(10)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.brand'))
          .onClick(() => {
            this.showNoteLinker = !this.showNoteLinker;
          })
      }
      .width('100%')

      if (this.showNoteLinker) {
        Column({ space: 8 }) {
          Row() {
            Text('将当前导图节点关联至笔记')
              .fontSize(13)
              .fontWeight(FontWeight.Bold)
              .fontColor($r('app.color.text_primary'))
            Blank()
            if (this.currentSelectedNode()?.noteRefId) {
              Button('打开已关联笔记 →', { buttonStyle: ButtonStyleMode.TEXTUAL })
                .fontSize(12)
                .fontColor($r('app.color.brand'))
                .onClick(() => {
                  this.openLinkedNote(this.currentSelectedNode()?.noteRefId || '');
                })
            }
          }
          .width('100%')

          Flex({ wrap: FlexWrap.Wrap }) {
            Button('+ 由该节点生成新笔记', { type: ButtonType.Normal })
              .height(32)
              .margin({ right: 6, bottom: 6 })
              .fontSize(11)
              .borderRadius(9)
              .backgroundColor($r('app.color.brand'))
              .fontColor($r('app.color.inverse_text'))
              .onClick(() => {
                this.createNoteFromSelectedNode();
              })

            ForEach(
              this.vaultNotes,
              (n: NoteItem) => {
                Button(MarkdownEngine.displayTitle(n), { type: ButtonType.Normal })
                  .height(32)
                  .margin({ right: 6, bottom: 6 })
                  .fontSize(11)
                  .borderRadius(9)
                  .backgroundColor($r('app.color.soft_surface'))
                  .fontColor($r('app.color.text_primary'))
                  .onClick(() => {
                    this.linkSelectedToNote(n);
                  })
              },
              (n: NoteItem): string => n.id
            )
          }
          .width('100%')
        }
        .width('100%')
        .padding(12)
        .backgroundColor($r('app.color.soft_surface'))
        .borderRadius(14)
      }
    }
    .width('100%')
    .padding(16)
    .backgroundColor($r('app.color.surface'))
    .borderRadius(22)
  }

  @Builder
  outlineTreeCard() {
    Column({ space: 10 }) {
      Row() {
        Text('大纲视图')
          .fontSize(13)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
        Blank()
        Button('导出 .md 大纲', { buttonStyle: ButtonStyleMode.TEXTUAL })
          .fontSize(12)
          .fontColor($r('app.color.brand'))
          .onClick(() => {
            this.exportOutlineOrJson(false);
          })
      }
      .width('100%')

      ForEach(
        this.visibleNodes,
        (node: MindMapNode) => {
          Row({ space: 10 }) {
            Column()
              .width(8)
              .height(8)
              .borderRadius(4)
              .backgroundColor(this.nodeAccentColor(node.colorTag, node.id === this.doc.rootNodeId))

            Column({ space: 3 }) {
              Text(node.text)
                .fontSize(node.level === 0 ? 16 : 14)
                .fontWeight(node.level <= 1 ? FontWeight.Bold : FontWeight.Medium)
                .fontColor(node.id === this.selectedNodeId ? $r('app.color.brand') : $r('app.color.text_primary'))
              if (node.note.length > 0) {
                Text(node.note)
                  .fontSize(11)
                  .fontColor($r('app.color.text_secondary'))
              }
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Start)

            if (node.noteRefId.length > 0) {
              Button(`🔗 ${node.noteRefTitle}`, { type: ButtonType.Normal })
                .height(28)
                .fontSize(11)
                .borderRadius(8)
                .backgroundColor($r('app.color.brand_soft'))
                .fontColor($r('app.color.brand'))
                .onClick(() => {
                  this.openLinkedNote(node.noteRefId);
                })
            }
          }
          .width('100%')
          .padding({ left: 10 + node.level * 18, right: 12, top: 10, bottom: 10 })
          .backgroundColor(node.id === this.selectedNodeId ? $r('app.color.brand_soft') : $r('app.color.soft_surface'))
          .borderRadius(14)
          .onClick(() => {
            this.selectNode(node.id);
          })
        },
        (node: MindMapNode): string => node.id
      )
    }
    .width('100%')
    .padding(18)
    .backgroundColor($r('app.color.surface'))
    .borderRadius(22)
  }

  @Builder
  private pageTitleBar() {
    LexiBackHeader({
      title: this.doc.title || '思维导图',
      subtitle: this.saveStatus,
      actionLabel: '导出 JSON',
      onBack: () => {
        this.pathStack.pop();
      },
      onAction: () => {
        this.exportOutlineOrJson(true);
      }
    })
  }

  build() {
    NavDestination() {
      Scroll() {
        Column({ space: 14 }) {
          this.topControlStrip()

          if (this.viewKind === 'map') {
            Stack({ alignContent: Alignment.BottomEnd }) {
              Canvas(this.ctx2d)
                .id('mindmap-canvas')
                .accessibilityText(`思维导图画布，${this.visibleNodes.length} 个主题。拖动主题移动分支，拖动空白平移。`)
                .width('100%')
                .height(420)
                .backgroundColor($r('app.color.canvas_surface'))
                .borderRadius(24)
                .onReady(() => {
                  this.canvasReady = true;
                  this.relayoutAndDraw();
                })
                .onAreaChange((_old: Area, area: Area) => {
                  this.canvasWidth = Number(area.width);
                  this.canvasHeight = Number(area.height);
                  this.viewFitted = false;
                  this.relayoutAndDraw();
                })
                .onClick((event: ClickEvent) => {
                  this.handleCanvasTap(event.x, event.y);
                })
                .priorityGesture(
                  PanGesture({ distance: 4 })
                    .onActionStart((event: GestureEvent): void => { this.beginCanvasDrag(event); })
                    .onActionUpdate((event: GestureEvent): void => { this.updateCanvasDrag(event); })
                    .onActionEnd((): void => { this.finishCanvasDrag(false); })
                    .onActionCancel((): void => { this.finishCanvasDrag(true); })
                )

              Row({ space: 6 }) {
                Button('-', { type: ButtonType.Normal })
                  .width(34)
        .padding(0)
                  .height(32)
                  .fontSize(15)
                  .borderRadius(10)
                  .backgroundColor('#332854')
                  .fontColor('#F2EEFF')
                  .onClick(() => {
                    this.zoomScale = Math.max(0.1, Number((this.zoomScale - 0.15).toFixed(2)));
                    this.drawCanvas();
                  })
                Button(`${Math.round(this.zoomScale * 100)}%`, { type: ButtonType.Normal })
                  .height(32)
                  .padding({ left: 10, right: 10 })
                  .fontSize(11)
                  .borderRadius(10)
                  .backgroundColor('#332854')
                  .fontColor('#F2EEFF')
                  .onClick(() => {
                    this.fitCanvasToNodes();
                    this.drawCanvas();
                  })
                Button('+', { type: ButtonType.Normal })
                  .width(34)
        .padding(0)
                  .height(32)
                  .fontSize(15)
                  .borderRadius(10)
                  .backgroundColor('#332854')
                  .fontColor('#F2EEFF')
                  .onClick(() => {
                    this.zoomScale = Math.min(1.6, Number((this.zoomScale + 0.15).toFixed(2)));
                    this.drawCanvas();
                  })
              }
              .margin({ right: 14, bottom: 14 })
            }
            .width('100%')
          } else {
            this.outlineTreeCard()
          }

          this.nodeInspectorCard()
        }
        .width('100%')
        .constraintSize({ maxWidth: 1080 })
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
      const param = ctx.pathInfo.param as MindMapRouteParam | undefined;
      this.loadFromRoute(param);
    })
  }
}
