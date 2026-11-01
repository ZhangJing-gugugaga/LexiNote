import { GraphEdge, GraphNode } from '../core/LexiModels';

/**
 * Canvas-rendered knowledge graph. Positions come pre-normalised (0..1) from GraphLayout.
 */
@Component
export struct LexiGraphView {
  @Prop @Watch('redraw') nodes: GraphNode[] = [];
  @Prop @Watch('redraw') edges: GraphEdge[] = [];
  @Prop @Watch('redraw') selectedId: string = '';
  @StorageProp('lexiColorMode') @Watch('redraw') colorMode: number = -1;
  @Prop graphHeight: number = 340;
  onSelect: (id: string) => void = (_id: string): void => {};
  private readonly settings: RenderingContextSettings = new RenderingContextSettings(true);
  private readonly ctx: CanvasRenderingContext2D = new CanvasRenderingContext2D(this.settings);
  private canvasWidth: number = 0;
  private canvasHeight: number = 0;
  private canvasReady: boolean = false;
  private nodeIndex: Map<string, GraphNode> = new Map<string, GraphNode>();
  private readonly graphPadding: number = 34;

  private color(res: Resource, alpha: number = 1): string {
    try {
      const value = this.getUIContext().getHostContext()!.resourceManager.getColorSync(res.id);
      const a = ((value >>> 24) & 0xff) / 255 * alpha;
      const r = (value >>> 16) & 0xff;
      const g = (value >>> 8) & 0xff;
      const b = value & 0xff;
      return `rgba(${r},${g},${b},${a.toFixed(3)})`;
    } catch {
      return `rgba(110,68,217,${alpha})`;
    }
  }

  private nodeColor(node: GraphNode): string {
    if (node.kind === 'mindmap') {
      return this.color($r('app.color.brand_ink'));
    }
    if (node.kind === 'tag') {
      return this.color($r('app.color.text_secondary'));
    }
    if (node.noteType === 'study') {
      return this.color($r('app.color.success'));
    }
    if (node.noteType === 'markdown') {
      return this.color($r('app.color.warning'));
    }
    return this.color($r('app.color.brand'));
  }

  private radius(node: GraphNode): number {
    const base = node.kind === 'tag' ? 4 : 6;
    return base + Math.min(node.degree, 8) * 1.3;
  }

  private px(node: GraphNode): number {
    return this.graphPadding + node.x * Math.max(1, this.canvasWidth - this.graphPadding * 2);
  }

  private py(node: GraphNode): number {
    return this.graphPadding + node.y * Math.max(1, this.canvasHeight - this.graphPadding * 2);
  }

  private find(id: string): GraphNode | undefined {
    return this.nodeIndex.get(id);
  }

  redraw(): void {
    if (!this.canvasReady || this.canvasWidth <= 0 || this.canvasHeight <= 0) {
      return;
    }
    const ctx = this.ctx;
    this.nodeIndex.clear();
    for (const node of this.nodes) { this.nodeIndex.set(node.id, node); }
    ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
    const edgeColor = this.color($r('app.color.text_secondary'), 0.28);
    const focusEdge = this.color($r('app.color.brand'), 0.85);
    for (let i = 0; i < this.edges.length; i++) {
      const edge = this.edges[i];
      const a = this.find(edge.sourceId);
      const b = this.find(edge.targetId);
      if (!a || !b) {
        continue;
      }
      const focused = this.selectedId.length > 0 && (edge.sourceId === this.selectedId || edge.targetId === this.selectedId);
      ctx.beginPath();
      ctx.lineWidth = focused ? 2 : 1.1;
      ctx.strokeStyle = focused ? focusEdge : edgeColor;
      ctx.setLineDash(edge.kind === 'link' ? [] : [4, 4]);
      ctx.moveTo(this.px(a), this.py(a));
      ctx.lineTo(this.px(b), this.py(b));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const labelColor = this.color($r('app.color.text_primary'), 0.88);
    const ringColor = this.color($r('app.color.brand_soft'));
    const showAllLabels = this.nodes.length <= 26;
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const x = this.px(node);
      const y = this.py(node);
      const r = this.radius(node);
      const selected = node.id === this.selectedId;
      if (selected) {
        ctx.beginPath();
        ctx.fillStyle = ringColor;
        ctx.arc(x, y, r + 8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.fillStyle = this.nodeColor(node);
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (showAllLabels || selected || node.degree >= 3) {
        const label = node.label.length > 12 ? node.label.slice(0, 12) + '…' : node.label;
        ctx.font = selected ? 'bold 12vp sans-serif' : '11vp sans-serif';
        ctx.fillStyle = labelColor;
        ctx.textAlign = 'center';
        ctx.fillText(label, x, y + r + 14);
      }
    }
  }

  private hitTest(x: number, y: number): string {
    let best = '';
    let bestDist = 26;
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const dx = this.px(node) - x;
      const dy = this.py(node) - y;
      const dist = Math.sqrt(dx * dx + dy * dy) - this.radius(node);
      if (dist < bestDist) {
        bestDist = dist;
        best = node.id;
      }
    }
    return best;
  }

  build() {
    Canvas(this.ctx)
      .width('100%')
      .height(this.graphHeight)
      .onReady(() => {
        this.canvasReady = true;
        this.redraw();
      })
      .onAreaChange((_old: Area, current: Area) => {
        this.canvasWidth = Number(current.width);
        this.canvasHeight = Number(current.height);
        this.redraw();
      })
      .onClick((event: ClickEvent) => {
        this.onSelect(this.hitTest(event.x, event.y));
      })
      .accessibilityText(`知识图谱，共 ${this.nodes.length} 个节点，${this.edges.length} 条关系`)
  }
}
