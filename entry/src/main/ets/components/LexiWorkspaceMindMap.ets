import { common } from '@kit.AbilityKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { LexiIcon } from './LexiIcon';
import { MindMapDoc, MindMapNode, NoteItem } from '../core/LexiModels';
import { LexiWorkspaceEditorController } from '../core/LexiWorkspaceModels';
import { LexiStorageService } from '../core/LexiStorageService';
import { MarkdownEngine } from '../core/MarkdownEngine';
import { LexiSpatialEditor } from '../core/LexiSpatialEditor';

interface LexiWorkspaceMapToolParams {
  iconName: string;
  label: string;
  action: () => void;
  isEnabled?: boolean;
}

@Component
export struct LexiWorkspaceMindMap {
  mapId: string = '';
  editorController: LexiWorkspaceEditorController = new LexiWorkspaceEditorController();
  @Prop @Watch('vaultNotesChanged') vaultNotes: NoteItem[] = [];
  @Prop paneWidth: number = 900;
  @State private doc: MindMapDoc = new MindMapDoc();
  @State private visibleNodes: MindMapNode[] = [];
  @State private selectedNodeId: string = 'root';
  @State private titleText: string = '';
  @State private editNodeText: string = '';
  @State private editNodeNote: string = '';
  @State private viewKind: string = 'map';
  @State private loaded: boolean = false;
  @State private loadFailed: boolean = false;
  @State private inspectorOpen: boolean = true;
  @State private saveStatus: string = '正在打开导图…';
  @State private zoomScale: number = 1.0;
  @State private panX: number = 0;
  @State private panY: number = 0;
  @State private undoCount: number = 0;
  @State private redoCount: number = 0;
  private allNotes: NoteItem[] = [];
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private lastSnapshotAt: number = 0;
  private saveTimer: number = -1;
  private revision: number = 0;
  private savedRevision: number = 0;
  private pendingSave: Promise<void> | undefined = undefined;
  private loading: Promise<void> | undefined = undefined;
  private readonly canvasSettings: RenderingContextSettings = new RenderingContextSettings(true);
  private readonly ctx2d: CanvasRenderingContext2D = new CanvasRenderingContext2D(this.canvasSettings);
  private canvasReady: boolean = false;
  private viewFitted: boolean = false;
  private canvasWidth: number = 640;
  private canvasHeight: number = 480;
  private dragStartX: number = 0;
  private dragStartY: number = 0;
  private dragNodeId: string = '';
  private dragLastX: number = 0;
  private dragLastY: number = 0;
  private dragSnapshot: string = '';
  private dragUndoSnapshot: string[] = [];
  private dragRedoSnapshot: string[] = [];
  onRequestReadingSpace: () => void = (): void => {};
  onSaved: (doc: MindMapDoc) => void = (_doc: MindMapDoc): void => {};
  onSavedNote: (note: NoteItem) => void = (_note: NoteItem): void => {};
  onOpenNote: (noteId: string) => void = (_id: string): void => {};

  aboutToAppear(): void {
    this.inspectorOpen = this.paneWidth >= 820;
    this.editorController.flush = async (): Promise<void> => {
      if (this.loading) {
        try { await this.loading; } catch {
          if (this.revision !== this.savedRevision) { throw new Error('导图尚未保存'); }
        }
      }
      await this.flush();
    };
    this.loading = this.load();
    this.loading.catch((): void => {
      this.loadFailed = true;
      this.saveStatus = '导图读取失败';
    });
  }

  aboutToDisappear(): void {
    if (this.saveTimer >= 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = -1;
    }
    this.flush().catch((): void => {});
  }

  private context(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  private toast(msg: string): void {
    this.getUIContext().getPromptAction().showToast({ message: msg });
  }

  private async load(): Promise<void> {
    this.loadFailed = false;
    const found = await LexiStorageService.getMindMapById(this.mapId);
    if (!found) {
      throw new Error('思维导图不存在');
    }
    this.doc = found;
    this.titleText = found.title;
    this.allNotes = (await LexiStorageService.getNotes(found.vaultId)).filter(
      (n: NoteItem): boolean => n.trashedAt === 0
    );
    this.loaded = true;
    this.selectNode(found.rootNodeId || 'root');
    this.relayoutAndDraw();
    this.saveStatus = '已保存到本机';
  }

  private vaultNotesChanged(): void {
    this.allNotes = this.vaultNotes.filter((n: NoteItem): boolean => n.trashedAt === 0);
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
    this.scheduleSave(true);
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
    this.scheduleSave(true);
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
    if (this.visibleNodes.length === 0 || this.canvasWidth <= 0 || this.canvasHeight <= 0) {
      return;
    }
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
    this.zoomScale = Math.max(
      0.1,
      Math.min(
        1,
        (this.canvasWidth - 64) / Math.max(1, right - left),
        (this.canvasHeight - 64) / Math.max(1, bottom - top)
      )
    );
    this.panX = this.canvasWidth / 2 - ((left + right) / 2) * this.zoomScale;
    this.panY = this.canvasHeight / 2 - ((top + bottom) / 2) * this.zoomScale;
    this.viewFitted = true;
  }

  private scheduleSave(immediate: boolean = false): void {
    this.revision++;
    this.saveStatus = '正在自动保存…';
    this.relayoutAndDraw();
    if (this.saveTimer >= 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = -1;
    }
    if (immediate) {
      this.flush().catch((): void => {
        this.saveStatus = '保存失败 · 点击重试';
      });
      return;
    }
    this.saveTimer = setTimeout((): void => {
      this.saveTimer = -1;
      this.flush().catch((): void => {
        this.saveStatus = '保存失败 · 点击重试';
      });
    }, 280);
  }

  private async flush(): Promise<void> {
    while (this.pendingSave) {
      await this.pendingSave;
    }
    if (!this.loaded || this.savedRevision === this.revision) {
      return;
    }
    const savingRevision = this.revision;
    const snapshot = JSON.parse(JSON.stringify(this.doc)) as MindMapDoc;
    snapshot.title = this.titleText.trim() || '未命名导图';
    const operation = this.saveSnapshot(snapshot, savingRevision);
    this.pendingSave = operation;
    try {
      await operation;
    } finally {
      this.pendingSave = undefined;
    }
    if (this.savedRevision !== this.revision) {
      await this.flush();
    }
  }

  private async saveSnapshot(snapshot: MindMapDoc, savingRevision: number): Promise<void> {
    const saved = await LexiStorageService.saveMindMap(this.context(), snapshot);
    this.doc = saved;
    this.savedRevision = savingRevision;
    this.onSaved(saved);
    if (this.revision === savingRevision) {
      this.saveStatus = '已保存到本机';
    }
  }

  private addChildNode(): void {
    const parent = this.currentSelectedNode();
    if (!parent) {
      return;
    }
    this.pushSnapshot(true);
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
    this.scheduleSave(true);
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
    this.pushSnapshot(true);
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
    this.scheduleSave(true);
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
    this.pushSnapshot(true);
    current.collapsed = !current.collapsed;
    this.scheduleSave(true);
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
    this.pushSnapshot(true);
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
    this.scheduleSave(true);
  }

  private deleteSelectedSubtree(): void {
    const current = this.currentSelectedNode();
    if (!current || current.id === this.doc.rootNodeId) {
      this.toast('中心根节点不能删除');
      return;
    }
    this.pushSnapshot(true);
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
    this.scheduleSave(true);
    this.toast('已移除节点分支');
  }

  private linkSelectedToNote(note: NoteItem): void {
    const current = this.currentSelectedNode();
    if (!current) {
      return;
    }
    this.pushSnapshot(true);
    current.noteRefId = note.id;
    current.noteRefTitle = MarkdownEngine.displayTitle(note);
    this.scheduleSave(true);
    this.toast(`已关联至「${current.noteRefTitle}」`);
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
    created.content = `# ${current.text}\n\n${current.note ? `> ${current.note}\n\n` : ''}来自思维导图「${this.doc.title}」的关联节点。\n`;
    const saved = await LexiStorageService.saveNote(this.context(), created);
    this.allNotes = (await LexiStorageService.getNotes(this.doc.vaultId)).filter(
      (n: NoteItem): boolean => n.trashedAt === 0
    );
    this.onSavedNote(saved);
    this.linkSelectedToNote(saved);
    this.onOpenNote(saved.id);
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
    if (!this.canvasReady || this.canvasWidth <= 0 || this.canvasHeight <= 0) {
      return;
    }
    this.ctx2d.clearRect(0, 0, this.canvasWidth, this.canvasHeight);

    this.ctx2d.fillStyle = 'rgba(182, 156, 255, 0.14)';
    for (let gx = 20; gx < this.canvasWidth; gx += 32) {
      for (let gy = 20; gy < this.canvasHeight; gy += 32) {
        this.ctx2d.fillRect(gx, gy, 2, 2);
      }
    }

    this.ctx2d.save();
    this.ctx2d.translate(this.panX, this.panY);
    this.ctx2d.scale(this.zoomScale, this.zoomScale);

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
    if (hit) {
      this.selectNode(hit.id);
    }
  }

  private beginCanvasDrag(event: GestureEvent): void {
    this.dragStartX = this.panX;
    this.dragStartY = this.panY;
    this.dragLastX = 0;
    this.dragLastY = 0;
    this.dragNodeId = '';
    this.dragSnapshot = '';
    const finger = event.fingerList.find((item: FingerInfo): boolean => !!item);
    if (!finger) {
      return;
    }
    const hit = LexiSpatialEditor.hitNode(
      this.visibleNodes,
      finger.localX - event.offsetX,
      finger.localY - event.offsetY,
      this.zoomScale,
      this.panX,
      this.panY
    );
    if (hit) {
      this.dragNodeId = hit.id;
      this.dragSnapshot = JSON.stringify(this.doc.nodes);
      this.dragUndoSnapshot = this.undoStack.slice();
      this.dragRedoSnapshot = this.redoStack.slice();
      this.pushSnapshot(true);
      this.selectNode(hit.id);
    }
  }

  private updateCanvasDrag(event: GestureEvent): void {
    if (this.dragNodeId) {
      const dx = event.offsetX / this.zoomScale;
      const dy = event.offsetY / this.zoomScale;
      LexiSpatialEditor.moveBranch(this.doc, this.dragNodeId, dx - this.dragLastX, dy - this.dragLastY);
      this.dragLastX = dx;
      this.dragLastY = dy;
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
      } else {
        this.scheduleSave(true);
      }
    } else if (cancelled) {
      this.panX = this.dragStartX;
      this.panY = this.dragStartY;
      this.drawCanvas();
    }
    this.dragNodeId = '';
    this.dragSnapshot = '';
    this.dragUndoSnapshot = [];
    this.dragRedoSnapshot = [];
  }

  private async exportOutlineOrJson(asJson: boolean): Promise<void> {
    await this.flush();
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
  private tool($$: LexiWorkspaceMapToolParams) {
    Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
      LexiIcon({ name: $$.iconName, iconSize: 16, muted: $$.isEnabled === false })
    }
    .width(34)
    .height(34)
    .padding(0)
    .borderRadius(7)
    .backgroundColor(Color.Transparent)
    .enabled($$.isEnabled !== false)
    .accessibilityText($$.label)
    .onClick($$.action)
  }

  @Builder
  private mapMenu() {
    Menu() {
      MenuItem({ content: '导出导图 JSON' }).onClick((): void => {
        this.exportOutlineOrJson(true);
      })
      MenuItem({ content: '导出 Markdown 大纲' }).onClick((): void => {
        this.exportOutlineOrJson(false);
      })
    }
  }

  @Builder
  private inspector() {
    Column({ space: 14 }) {
      Row() {
        Text('节点属性').fontSize(13).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
        Blank()
        Text(`${this.visibleNodes.length} 节点`).fontSize(11).fontColor($r('app.color.text_secondary'))
      }.width('100%')

      Scroll() {
        Column({ space: 12 }) {
          Column({ space: 6 }) {
            Text('主题文字').fontSize(11).fontColor($r('app.color.text_secondary')).width('100%')
            TextInput({ text: this.editNodeText, placeholder: '节点主题文字' })
              .width('100%')
              .height(38)
              .fontSize(13)
              .fontWeight(FontWeight.Medium)
              .backgroundColor($r('app.color.soft_surface'))
              .borderRadius(8)
              .onChange((val: string) => {
                this.editNodeText = val;
                const current = this.currentSelectedNode();
                if (current && current.text !== val) {
                  this.pushSnapshot(false);
                  current.text = val;
                  if (current.id === this.doc.rootNodeId && val.trim().length > 0) {
                    this.titleText = val.trim();
                    this.doc.title = val.trim();
                  }
                  this.scheduleSave(false);
                }
              })
          }.width('100%')

          Column({ space: 6 }) {
            Text('节点备注').fontSize(11).fontColor($r('app.color.text_secondary')).width('100%')
            TextInput({ text: this.editNodeNote, placeholder: '简短备注…' })
              .width('100%')
              .height(36)
              .fontSize(12)
              .backgroundColor($r('app.color.soft_surface'))
              .borderRadius(8)
              .onChange((val: string) => {
                this.editNodeNote = val;
                const current = this.currentSelectedNode();
                if (current && current.note !== val) {
                  current.note = val;
                  this.scheduleSave(false);
                }
              })
          }.width('100%')

          Row({ space: 6 }) {
            Button(this.currentSelectedNode()?.collapsed ? '展开' : '折叠', { type: ButtonType.Normal })
              .layoutWeight(1)
              .height(34)
              .fontSize(12)
              .borderRadius(8)
              .backgroundColor($r('app.color.soft_surface'))
              .fontColor($r('app.color.text_primary'))
              .onClick((): void => {
                this.toggleCollapseSelected();
              })
            Button('↑', { type: ButtonType.Normal })
              .width(34)
              .height(34)
              .padding(0)
              .fontSize(13)
              .borderRadius(8)
              .backgroundColor($r('app.color.soft_surface'))
              .fontColor($r('app.color.text_primary'))
              .onClick((): void => {
                this.moveSelectedOrder(-1);
              })
            Button('↓', { type: ButtonType.Normal })
              .width(34)
              .height(34)
              .padding(0)
              .fontSize(13)
              .borderRadius(8)
              .backgroundColor($r('app.color.soft_surface'))
              .fontColor($r('app.color.text_primary'))
              .onClick((): void => {
                this.moveSelectedOrder(1);
              })
            Button({ type: ButtonType.Normal }) {
              LexiIcon({ name: 'trash', iconSize: 15 })
            }
            .width(34)
            .height(34)
            .padding(0)
            .borderRadius(8)
            .backgroundColor($r('app.color.soft_surface'))
            .onClick((): void => {
              this.deleteSelectedSubtree();
            })
          }.width('100%')

          Column({ space: 6 }) {
            Text('节点配色').fontSize(11).fontColor($r('app.color.text_secondary')).width('100%')
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
                    .height(28)
                    .margin({ right: 6, bottom: 6 })
                    .padding({ left: 9, right: 9 })
                    .fontSize(11)
                    .borderRadius(7)
                    .backgroundColor(colorItem[1])
                    .fontColor('#FFFFFF')
                    .onClick((): void => {
                      const current = this.currentSelectedNode();
                      if (current) {
                        this.pushSnapshot(true);
                        current.colorTag = colorItem[0];
                        this.scheduleSave(true);
                      }
                    })
                },
                (colorItem: string[]): string => colorItem[0]
              )
            }.width('100%')
          }.width('100%')

          Divider().color($r('app.color.workspace_line')).margin({ top: 4, bottom: 4 })

          Column({ space: 8 }) {
            Row() {
              Text('关联笔记').fontSize(12).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
              Blank()
              if (this.currentSelectedNode()?.noteRefId) {
                Button('打开笔记 →', { buttonStyle: ButtonStyleMode.TEXTUAL })
                  .fontSize(11)
                  .height(28)
                  .padding(0)
                  .fontColor($r('app.color.brand'))
                  .onClick((): void => {
                    const refId = this.currentSelectedNode()?.noteRefId || '';
                    if (refId) {
                      this.onOpenNote(refId);
                    }
                  })
              }
            }.width('100%')

            Button('+ 由该节点生成新笔记', { type: ButtonType.Normal })
              .width('100%')
              .height(34)
              .fontSize(12)
              .borderRadius(8)
              .backgroundColor($r('app.color.brand_soft'))
              .fontColor($r('app.color.brand_ink'))
              .onClick((): void => {
                this.createNoteFromSelectedNode();
              })

            ForEach(
              this.allNotes.slice(0, 12),
              (n: NoteItem) => {
                Button(MarkdownEngine.displayTitle(n), { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
                  .width('100%')
                  .height(32)
                  .padding({ left: 8, right: 8 })
                  .fontSize(12)
                  .borderRadius(6)
                  .fontColor(
                    this.currentSelectedNode()?.noteRefId === n.id
                      ? $r('app.color.brand_ink')
                      : $r('app.color.text_secondary')
                  )
                  .backgroundColor(
                    this.currentSelectedNode()?.noteRefId === n.id
                      ? $r('app.color.workspace_selection')
                      : Color.Transparent
                  )
                  .onClick((): void => {
                    this.linkSelectedToNote(n);
                  })
              },
              (n: NoteItem): string => n.id
            )
          }.width('100%').alignItems(HorizontalAlign.Start)
        }.width('100%').alignItems(HorizontalAlign.Start)
      }.width('100%').layoutWeight(1).scrollBar(BarState.Off).align(Alignment.Top)
    }
    .width(236)
    .height('100%')
    .padding({ left: 18, right: 18, top: 20, bottom: 20 })
    .backgroundColor($r('app.color.workspace_inspector'))
    .border({ width: { left: 0.5 }, color: $r('app.color.workspace_line') })
  }

  @Builder
  private outlineView() {
    Scroll() {
      Column({ space: 10 }) {
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
                  .onClick((): void => {
                    this.onOpenNote(node.noteRefId);
                  })
              }
            }
            .width('100%')
            .padding({ left: 12 + node.level * 18, right: 14, top: 10, bottom: 10 })
            .backgroundColor(node.id === this.selectedNodeId ? $r('app.color.brand_soft') : $r('app.color.surface'))
            .borderRadius(12)
            .onClick((): void => {
              this.selectNode(node.id);
            })
          },
          (node: MindMapNode): string => node.id
        )
      }
      .width('100%')
      .constraintSize({ maxWidth: 820 })
      .padding({ left: 40, right: 40, top: 28, bottom: 48 })
      .alignItems(HorizontalAlign.Start)
    }
    .layoutWeight(1)
    .height('100%')
    .align(Alignment.Top)
    .scrollBar(BarState.Auto)
  }

  build() {
    Column() {
      Row({ space: 8 }) {
        LexiIcon({ name: 'mindmap', iconSize: 15 })
        TextInput({ text: this.titleText, placeholder: '思维导图标题' })
          .id('workspace-mindmap-title')
          .width(180)
          .height(34)
          .padding({ left: 8, right: 8 })
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
          .backgroundColor($r('app.color.soft_surface'))
          .borderRadius(7)
          .onChange((val: string) => {
            if (val !== this.titleText) {
              this.titleText = val;
              this.doc.title = val;
              const root = this.doc.nodes.find((n: MindMapNode): boolean => n.id === this.doc.rootNodeId);
              if (root && val.trim().length > 0) {
                root.text = val.trim();
                if (this.selectedNodeId === root.id) {
                  this.editNodeText = root.text;
                }
              }
              this.scheduleSave(false);
            }
          })

        Row({ space: 2 }) {
          ForEach(
            [
              ['right', '向右'],
              ['balanced', '双向'],
              ['org', '组织']
            ],
            (item: string[]) => {
              Button(item[1], { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
                .height(28)
                .padding({ left: 8, right: 8 })
                .fontSize(11)
                .borderRadius(6)
                .backgroundColor(this.doc.layoutKind === item[0] ? $r('app.color.workspace_selection') : Color.Transparent)
                .fontColor(this.doc.layoutKind === item[0] ? $r('app.color.brand_ink') : $r('app.color.text_secondary'))
                .onClick((): void => {
                  this.doc.layoutKind = item[0];
                  this.viewFitted = false;
                  this.scheduleSave(true);
                })
            },
            (item: string[]): string => item[0]
          )
        }
        .padding(2)
        .backgroundColor($r('app.color.soft_surface'))
        .borderRadius(8)

        Blank()

        Button('+ 子主题', { type: ButtonType.Normal })
          .id('mindmap-add-child')
          .height(32)
          .padding({ left: 12, right: 12 })
          .fontSize(12)
          .borderRadius(7)
          .backgroundColor($r('app.color.brand'))
          .fontColor($r('app.color.inverse_text'))
          .onClick((): void => {
            this.addChildNode();
          })

        Button('+ 同级', { type: ButtonType.Normal })
          .id('mindmap-add-sibling')
          .height(32)
          .padding({ left: 10, right: 10 })
          .fontSize(12)
          .borderRadius(7)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.brand_ink'))
          .onClick((): void => {
            this.addSiblingNode();
          })

        Button(this.viewKind === 'map' ? '大纲' : '导图', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
          .height(32)
          .padding({ left: 10, right: 10 })
          .fontSize(12)
          .borderRadius(7)
          .backgroundColor(this.viewKind === 'outline' ? $r('app.color.workspace_selection') : Color.Transparent)
          .fontColor($r('app.color.brand_ink'))
          .onClick((): void => {
            this.viewKind = this.viewKind === 'map' ? 'outline' : 'map';
            if (this.viewKind === 'map') {
              this.relayoutAndDraw();
            }
          })

        this.tool({
          iconName: 'undo',
          label: '撤销',
          action: (): void => { this.undo(); },
          isEnabled: this.undoCount > 0
        })
        this.tool({
          iconName: 'redo',
          label: '重做',
          action: (): void => { this.redo(); },
          isEnabled: this.redoCount > 0
        })

        Button('更多', { type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL })
          .height(32)
          .fontSize(12)
          .padding({ left: 8, right: 8 })
          .borderRadius(7)
          .fontColor($r('app.color.text_secondary'))
          .backgroundColor(Color.Transparent)
          .bindMenu(this.mapMenu())

        Button({ type: ButtonType.Normal, buttonStyle: ButtonStyleMode.TEXTUAL }) {
          SymbolGlyph($r('sys.symbol.list_bullet')).fontSize(17).fontColor([$r('app.color.text_secondary')])
        }
        .id('mindmap-inspector-toggle')
        .width(34)
        .height(34)
        .padding(0)
        .borderRadius(7)
        .backgroundColor(this.inspectorOpen ? $r('app.color.workspace_selection') : Color.Transparent)
        .accessibilityText('展开或收起节点属性')
        .onClick((): void => {
          if (this.inspectorOpen) {
            this.inspectorOpen = false;
          } else {
            this.inspectorOpen = true;
            if (this.paneWidth < 820) {
              this.onRequestReadingSpace();
            }
          }
        })
      }
      .height(48)
      .width('100%')
      .padding({ left: 20, right: 14 })
      .border({ width: { bottom: 0.5 }, color: $r('app.color.workspace_line') })

      Row() {
        if (this.loadFailed) {
          Column({ space: 12 }) {
            Text('思维导图暂时无法打开').fontSize(20).fontColor($r('app.color.text_primary'))
            Button('重新读取').onClick((): void => {
              this.loading = this.load();
              this.loading.catch((): void => {
                this.loadFailed = true;
              });
            })
          }
          .layoutWeight(1)
          .height('100%')
          .justifyContent(FlexAlign.Center)
        } else if (this.loaded) {
          if (this.viewKind === 'map') {
            Stack({ alignContent: Alignment.BottomEnd }) {
              Canvas(this.ctx2d)
                .id('mindmap-canvas')
                .accessibilityText(`思维导图画布，${this.visibleNodes.length} 个主题。拖动主题移动分支，拖动空白平移。`)
                .width('100%')
                .height('100%')
                .backgroundColor($r('app.color.canvas_surface'))
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
                  .width(32)
                  .height(30)
                  .padding(0)
                  .fontSize(15)
                  .borderRadius(8)
                  .backgroundColor('#332854')
                  .fontColor('#F2EEFF')
                  .onClick((): void => {
                    this.zoomScale = Math.max(0.1, Number((this.zoomScale - 0.15).toFixed(2)));
                    this.drawCanvas();
                  })
                Button(`${Math.round(this.zoomScale * 100)}%`, { type: ButtonType.Normal })
                  .height(30)
                  .padding({ left: 10, right: 10 })
                  .fontSize(11)
                  .borderRadius(8)
                  .backgroundColor('#332854')
                  .fontColor('#F2EEFF')
                  .onClick((): void => {
                    this.fitCanvasToNodes();
                    this.drawCanvas();
                  })
                Button('+', { type: ButtonType.Normal })
                  .width(32)
                  .height(30)
                  .padding(0)
                  .fontSize(15)
                  .borderRadius(8)
                  .backgroundColor('#332854')
                  .fontColor('#F2EEFF')
                  .onClick((): void => {
                    this.zoomScale = Math.min(1.6, Number((this.zoomScale + 0.15).toFixed(2)));
                    this.drawCanvas();
                  })
              }
              .margin({ right: 16, bottom: 16 })
            }
            .layoutWeight(1)
            .height('100%')
          } else {
            this.outlineView()
          }
        } else {
          Column()
            .layoutWeight(1)
            .height('100%')
        }

        if (this.inspectorOpen) {
          this.inspector()
        }
      }
      .width('100%')
      .layoutWeight(1)

      Row({ space: 16 }) {
        Text('思维导图').fontSize(11).fontColor($r('app.color.text_secondary'))
        Blank()
        Text(`${this.doc.nodes.length} 个节点`).fontSize(11).fontColor($r('app.color.text_secondary'))
        Text(this.saveStatus)
          .id('workspace-mindmap-save-status')
          .fontSize(11)
          .fontColor($r('app.color.text_secondary'))
          .onClick((): void => {
            this.flush().catch((): void => {
              this.saveStatus = '保存失败 · 点击重试';
            });
          })
      }
      .height(deviceInfo.deviceType === '2in1' ? 30 : 34)
      .width('100%')
      .padding({ left: 24, right: 20, bottom: deviceInfo.deviceType === '2in1' ? 0 : 4 })
      .border({ width: { top: 0.5 }, color: $r('app.color.workspace_line') })
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.workspace_page'))
  }
}
