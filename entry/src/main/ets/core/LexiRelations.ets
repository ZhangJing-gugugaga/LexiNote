import { GraphNode, MindMapDoc, NoteItem, NoteLink } from './LexiModels';
import { MarkdownEngine } from './MarkdownEngine';

export class RelatedContent {
  id: string = '';
  title: string = '';
  snippet: string = '';
  kind: string = 'note';
  reason: string = '';
}

/** Human-readable, deduplicated relations, independent of graph display filters. */
export class LexiRelations {
  static counts(contents: GraphNode[], maps: MindMapDoc[], links: NoteLink[]): Map<string, number> {
    const neighbours = new Map<string, Set<string>>();
    for (const content of contents) { neighbours.set(content.id, new Set<string>()); }
    const connect = (source: string, target: string): void => {
      if (source === target) { return; }
      const a = neighbours.get(source);
      const b = neighbours.get(target);
      if (a && b) { a.add(target); b.add(source); }
    };
    for (const link of links) { connect(link.sourceId, link.targetId); }
    for (const map of maps) {
      if (map.trashedAt > 0) { continue; }
      for (const node of map.nodes) { connect(`map:${map.id}`, node.noteRefId); }
    }
    const result = new Map<string, number>();
    neighbours.forEach((ids: Set<string>, id: string): void => { result.set(id, ids.size); });
    return result;
  }

  static contents(notes: NoteItem[], maps: MindMapDoc[]): GraphNode[] {
    const result: GraphNode[] = [];
    for (const note of notes) {
      if (note.trashedAt > 0) { continue; }
      const node = new GraphNode();
      node.id = note.id;
      node.label = MarkdownEngine.displayTitle(note);
      node.snippet = MarkdownEngine.extractSnippet(note);
      result.push(node);
    }
    for (const map of maps) {
      if (map.trashedAt > 0) { continue; }
      const node = new GraphNode();
      node.id = `map:${map.id}`;
      node.label = map.title || '未命名导图';
      node.kind = 'mindmap';
      node.snippet = '思维导图';
      result.push(node);
    }
    return result;
  }

  static connected(focusId: string, contents: GraphNode[], maps: MindMapDoc[], links: NoteLink[]): RelatedContent[] {
    const reasons = new Map<string, string>();
    for (const link of links) {
      if (!link.targetId || link.sourceId === link.targetId) { continue; }
      if (link.sourceId === focusId) { reasons.set(link.targetId, '这篇笔记引用了它'); }
      if (link.targetId === focusId) {
        reasons.set(link.sourceId, reasons.has(link.sourceId) ? '两篇笔记互相引用' : '它引用了这篇笔记');
      }
    }
    // Reciprocal links can arrive in either order.
    for (const link of links) {
      if (link.sourceId === focusId && links.some((other: NoteLink): boolean =>
        other.sourceId === link.targetId && other.targetId === focusId)) {
        reasons.set(link.targetId, '两篇笔记互相引用');
      }
    }
    for (const map of maps) {
      if (map.trashedAt > 0) { continue; }
      for (const node of map.nodes) {
        if (!node.noteRefId) { continue; }
        if (focusId === `map:${map.id}`) { reasons.set(node.noteRefId, '导图中的笔记引用'); }
        if (focusId === node.noteRefId) { reasons.set(`map:${map.id}`, '这张导图引用了它'); }
      }
    }
    const result: RelatedContent[] = [];
    for (const content of contents) {
      const reason = reasons.get(content.id);
      if (!reason || content.id === focusId) { continue; }
      const related = new RelatedContent();
      related.id = content.id;
      related.title = content.label;
      related.snippet = content.snippet;
      related.kind = content.kind;
      related.reason = reason;
      result.push(related);
    }
    return result;
  }
}
