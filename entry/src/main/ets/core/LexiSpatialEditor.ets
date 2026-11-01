import { CanvasCard, MindMapDoc, MindMapNode } from './LexiModels';

export class LexiSpatialEditor {
  static hitNode(nodes: MindMapNode[], localX: number, localY: number,
    scale: number, panX: number, panY: number): MindMapNode | undefined {
    const x = (localX - panX) / scale;
    const y = (localY - panY) / scale;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (Math.abs(x - node.x) <= node.boxWidth / 2 + 6 && Math.abs(y - node.y) <= node.boxHeight / 2 + 6) {
        return node;
      }
    }
    return undefined;
  }

  static hitCard(cards: CanvasCard[], localX: number, localY: number,
    scale: number, panX: number, panY: number): CanvasCard | undefined {
    const x = (localX - panX) / scale;
    const y = (localY - panY) / scale;
    for (let i = cards.length - 1; i >= 0; i--) {
      const card = cards[i];
      if (x >= card.x && x <= card.x + 154 && y >= card.y && y <= card.y + 74) { return card; }
    }
    return undefined;
  }

  static moveBranch(doc: MindMapDoc, nodeId: string, deltaX: number, deltaY: number): void {
    const moving = new Set<string>([nodeId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of doc.nodes) {
        if (moving.has(node.parentId) && !moving.has(node.id)) { moving.add(node.id); changed = true; }
      }
    }
    for (const node of doc.nodes) {
      if (moving.has(node.id)) {
        node.offsetX = (Number.isFinite(node.offsetX) ? node.offsetX : 0) + deltaX;
        node.offsetY = (Number.isFinite(node.offsetY) ? node.offsetY : 0) + deltaY;
      }
    }
  }
}
