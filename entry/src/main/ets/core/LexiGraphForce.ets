import { GraphEdge, GraphNode } from './LexiModels';

export class LexiGraphForcePayload {
  nodeIds: string[] = [];
  edges: GraphEdge[] = [];
}

class LexiGraphForceVector {
  x: number = 0;
  y: number = 0;
}

/** Pure deterministic layout shared by the background task and synchronous compatibility API. */
export class LexiGraphForce {
  static golden(nodes: GraphNode[]): void {
    const count = nodes.length;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let index = 0; index < count; index++) {
      const radius = count === 1 ? 0 : Math.sqrt((index + 0.5) / count) * 0.46;
      nodes[index].x = 0.5 + Math.cos(index * goldenAngle) * radius;
      nodes[index].y = 0.5 + Math.sin(index * goldenAngle) * radius;
    }
  }

  static layout(nodes: GraphNode[], edges: GraphEdge[]): void {
    const count = nodes.length;
    if (count <= 1) { LexiGraphForce.golden(nodes); return; }
    const positions: LexiGraphForceVector[] = [];
    const displacements: LexiGraphForceVector[] = [];
    const slots = new Map<string, number>();
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let index = 0; index < count; index++) {
      const position = new LexiGraphForceVector();
      const radius = Math.sqrt((index + 0.5) / count);
      position.x = Math.cos(index * goldenAngle) * radius;
      position.y = Math.sin(index * goldenAngle) * radius;
      positions.push(position);
      displacements.push(new LexiGraphForceVector());
      slots.set(nodes[index].id, index);
    }
    const spring = Math.sqrt(4 / count) * 0.9;
    const iterations = count > 320 ? 90 : count > 160 ? 120 : count > 80 ? 160 : 260;
    const samples = Math.min(96, count - 1);
    let temperature = 0.18;
    for (let iteration = 0; iteration < iterations; iteration++) {
      for (let index = 0; index < count; index++) {
        displacements[index].x = 0; displacements[index].y = 0;
      }
      for (let index = 0; index < count; index++) {
        // Small graphs use every pair; larger graphs sample the whole index range each iteration.
        const visits = count > 320 ? samples : count - index - 1;
        const multiplier = count > 320 ? (count - 1) / (2 * samples) : 1;
        for (let visit = 0; visit < visits; visit++) {
          const other = count > 320 ?
            (index + 1 + Math.floor(visit * (count - 1) / samples) + iteration * 17) % count : index + 1 + visit;
          if (other === index) { continue; }
          let dx = positions[index].x - positions[other].x;
          let dy = positions[index].y - positions[other].y;
          let distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < 0.0001) { dx = 0.001 * (index - other); dy = 0.001; distance = Math.max(0.0015, Math.sqrt(dx * dx + dy * dy)); }
          const force = (spring * spring) / distance * multiplier;
          const fx = dx / distance * force; const fy = dy / distance * force;
          displacements[index].x += fx; displacements[index].y += fy;
          displacements[other].x -= fx; displacements[other].y -= fy;
        }
      }
      for (const edge of edges) {
        const start = slots.get(edge.sourceId); const end = slots.get(edge.targetId);
        if (start === undefined || end === undefined) { continue; }
        const dx = positions[start].x - positions[end].x; const dy = positions[start].y - positions[end].y;
        const distance = Math.max(0.0001, Math.sqrt(dx * dx + dy * dy));
        const force = distance * distance / spring;
        const fx = dx / distance * force; const fy = dy / distance * force;
        displacements[start].x -= fx; displacements[start].y -= fy;
        displacements[end].x += fx; displacements[end].y += fy;
      }
      for (let index = 0; index < count; index++) {
        displacements[index].x -= positions[index].x * 0.6 * spring;
        displacements[index].y -= positions[index].y * 0.6 * spring;
        const length = Math.max(0.0001, Math.sqrt(displacements[index].x * displacements[index].x + displacements[index].y * displacements[index].y));
        const step = Math.min(length, temperature);
        positions[index].x += displacements[index].x / length * step;
        positions[index].y += displacements[index].y / length * step;
      }
      temperature = Math.max(0.004, temperature * 0.975);
    }
    let minX = Number.MAX_VALUE; let maxX = -Number.MAX_VALUE;
    let minY = Number.MAX_VALUE; let maxY = -Number.MAX_VALUE;
    for (const position of positions) {
      minX = Math.min(minX, position.x); maxX = Math.max(maxX, position.x);
      minY = Math.min(minY, position.y); maxY = Math.max(maxY, position.y);
    }
    const spanX = Math.max(0.0001, maxX - minX); const spanY = Math.max(0.0001, maxY - minY);
    for (let index = 0; index < count; index++) {
      nodes[index].x = (positions[index].x - minX) / spanX;
      nodes[index].y = (positions[index].y - minY) / spanY;
    }
  }
}
