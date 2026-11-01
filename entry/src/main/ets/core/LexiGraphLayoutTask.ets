import { LexiGraphForce, LexiGraphForcePayload } from './LexiGraphForce';
import { GraphNode } from './LexiModels';

@Concurrent
export function lexiGraphLayoutTask(serialized: string): string {
  const payload = JSON.parse(serialized) as LexiGraphForcePayload;
  const nodes = payload.nodeIds.map((id: string): GraphNode => {
    const node = new GraphNode(); node.id = id; return node;
  });
  LexiGraphForce.layout(nodes, payload.edges);
  return JSON.stringify(nodes.map((node: GraphNode): number[] => [node.x, node.y]));
}
