import { GraphEdge, GraphNode, MindMapDoc, NoteItem, NoteLink } from './LexiModels';
import { MarkdownEngine } from './MarkdownEngine';
import { taskpool } from '@kit.ArkTS';
import { LexiGraphForce, LexiGraphForcePayload } from './LexiGraphForce';
import { lexiGraphLayoutTask } from './LexiGraphLayoutTask';

export class GraphData {
  nodes: GraphNode[] = [];
  edges: GraphEdge[] = [];
}

/**
 * Builds the knowledge graph from saved relations (links, mind map references, tags)
 * and computes a deterministic force-directed layout normalised to [0, 1].
 */
export class GraphLayout {
  private static topology(notes: NoteItem[], maps: MindMapDoc[], links: NoteLink[], includeMaps: boolean,
    includeTags: boolean): GraphData {
    const data = new GraphData();
    const index = new Map<string, GraphNode>();
    const edgeKeys = new Set<string>();
    const active = notes.filter((n: NoteItem): boolean => n.trashedAt === 0);

    for (let i = 0; i < active.length; i++) {
      const note = active[i];
      const node = new GraphNode();
      node.id = note.id;
      node.label = MarkdownEngine.displayTitle(note);
      node.kind = 'note';
      node.noteType = note.noteType;
      node.tags = note.tags.slice();
      node.snippet = MarkdownEngine.extractSnippet(note).slice(0, 72);
      index.set(node.id, node);
      data.nodes.push(node);
    }

    const addEdge = (sourceId: string, targetId: string, kind: string): void => {
      if (sourceId === targetId) {
        return;
      }
      const a = index.get(sourceId);
      const b = index.get(targetId);
      if (!a || !b) {
        return;
      }
      const key = sourceId < targetId ? `${sourceId}|${targetId}` : `${targetId}|${sourceId}`;
      if (edgeKeys.has(key)) {
        return;
      }
      edgeKeys.add(key);
      const edge = new GraphEdge();
      edge.sourceId = sourceId;
      edge.targetId = targetId;
      edge.kind = kind;
      data.edges.push(edge);
      a.degree++;
      b.degree++;
    };

    for (let i = 0; i < links.length; i++) {
      if (links[i].targetId.length > 0) {
        addEdge(links[i].sourceId, links[i].targetId, 'link');
      }
    }

    if (includeMaps) {
      for (let i = 0; i < maps.length; i++) {
        const map = maps[i];
        if (map.trashedAt > 0) {
          continue;
        }
        const node = new GraphNode();
        node.id = `map:${map.id}`;
        node.label = map.title || '未命名导图';
        node.kind = 'mindmap';
        node.snippet = `${map.nodes.length} 个节点的思维导图`;
        index.set(node.id, node);
        data.nodes.push(node);
        for (let j = 0; j < map.nodes.length; j++) {
          if (map.nodes[j].noteRefId.length > 0) {
            addEdge(node.id, map.nodes[j].noteRefId, 'mapRef');
          }
        }
      }
    }

    if (includeTags) {
      for (let i = 0; i < active.length; i++) {
        for (let j = 0; j < active[i].tags.length; j++) {
          const tag = active[i].tags[j];
          const tagId = `tag:${tag}`;
          if (!index.has(tagId)) {
            const node = new GraphNode();
            node.id = tagId;
            node.label = `#${tag}`;
            node.kind = 'tag';
            node.snippet = '标签';
            index.set(tagId, node);
            data.nodes.push(node);
          }
          addEdge(active[i].id, tagId, 'tag');
        }
      }
    }

    return data;
  }

  static build(notes: NoteItem[], maps: MindMapDoc[], links: NoteLink[], includeMaps: boolean,
    includeTags: boolean): GraphData {
    const data = GraphLayout.topology(notes, maps, links, includeMaps, includeTags);
    GraphLayout.layout(data.nodes, data.edges);
    return data;
  }

  static async buildAsync(notes: NoteItem[], maps: MindMapDoc[], links: NoteLink[], includeMaps: boolean,
    includeTags: boolean): Promise<GraphData> {
    const data = GraphLayout.topology(notes, maps, links, includeMaps, includeTags);
    await GraphLayout.layoutAsync(data);
    return data;
  }

  /** Restrict a graph to a focus node and its direct neighbours, then re-layout. */
  private static localTopology(data: GraphData, focusId: string): GraphData {
    const keep = new Set<string>();
    keep.add(focusId);
    for (let i = 0; i < data.edges.length; i++) {
      const e = data.edges[i];
      if (e.sourceId === focusId) {
        keep.add(e.targetId);
      } else if (e.targetId === focusId) {
        keep.add(e.sourceId);
      }
    }
    const result = new GraphData();
    for (let i = 0; i < data.nodes.length; i++) {
      if (keep.has(data.nodes[i].id)) {
        const src = data.nodes[i];
        const copy = new GraphNode();
        copy.id = src.id;
        copy.label = src.label;
        copy.kind = src.kind;
        copy.noteType = src.noteType;
        copy.tags = src.tags;
        copy.snippet = src.snippet;
        copy.degree = src.degree;
        result.nodes.push(copy);
      }
    }
    result.edges = data.edges.filter((e: GraphEdge): boolean => keep.has(e.sourceId) && keep.has(e.targetId));
    return result;
  }

  static local(data: GraphData, focusId: string): GraphData {
    const result = GraphLayout.localTopology(data, focusId);
    GraphLayout.layout(result.nodes, result.edges);
    return result;
  }

  static async localAsync(data: GraphData, focusId: string): Promise<GraphData> {
    const result = GraphLayout.localTopology(data, focusId);
    await GraphLayout.layoutAsync(result);
    return result;
  }

  static layout(nodes: GraphNode[], edges: GraphEdge[]): void {
    LexiGraphForce.layout(nodes, edges);
  }

  private static async layoutAsync(data: GraphData): Promise<void> {
    if (data.nodes.length <= 1) { LexiGraphForce.golden(data.nodes); return; }
    const payload = new LexiGraphForcePayload();
    // Only identifiers and endpoints cross the worker boundary; content and UI objects stay local.
    payload.nodeIds = data.nodes.map((node: GraphNode): string => node.id);
    payload.edges = data.edges;
    try {
      const result = await taskpool.execute(lexiGraphLayoutTask, JSON.stringify(payload)) as string;
      const positions = JSON.parse(result) as number[][];
      if (positions.length !== data.nodes.length) { throw new Error('Incomplete graph layout'); }
      for (let index = 0; index < data.nodes.length; index++) {
        if (!positions[index] || positions[index].length !== 2 ||
          !Number.isFinite(positions[index][0]) || !Number.isFinite(positions[index][1])) {
          throw new Error('Invalid graph position');
        }
        data.nodes[index].x = Math.max(0, Math.min(1, positions[index][0]));
        data.nodes[index].y = Math.max(0, Math.min(1, positions[index][1]));
      }
    } catch (_) {
      // A failed worker must never run the quadratic force solver on the UI thread.
      LexiGraphForce.golden(data.nodes);
    }
  }
}
