import { CanvasBoard, MindMapDoc, MindMapNode, NoteItem } from './LexiModels';

// Match only unchanged, built-in examples during the one-time clean-start migration.
export class LexiLegacySamples {
  static sameNote(note: NoteItem, example: NoteItem): boolean {
    return note.id === example.id && note.vaultId === example.vaultId && !note.projectId && !note.trashedAt && !note.sourceMissing &&
      note.title === example.title && note.content === example.content && note.notebook === example.notebook &&
      note.noteType === example.noteType && note.editorLevel === example.editorLevel &&
      note.pinned === example.pinned && note.favorite === example.favorite &&
      JSON.stringify(note.tags) === JSON.stringify(example.tags) && JSON.stringify(note.properties) === JSON.stringify(example.properties);
  }

  private static nodeSignature(node: MindMapNode): string {
    return JSON.stringify([node.id, node.parentId, node.text, node.note, node.noteRefId, node.noteRefTitle,
      node.order, node.collapsed, node.colorTag, node.offsetX || 0, node.offsetY || 0]);
  }

  static sameMap(doc: MindMapDoc, example: MindMapDoc): boolean {
    return doc.id === example.id && doc.vaultId === example.vaultId && !doc.projectId && !doc.trashedAt &&
      doc.title === example.title && doc.layoutKind === example.layoutKind && doc.rootNodeId === example.rootNodeId &&
      doc.favorite === example.favorite &&
      JSON.stringify(doc.nodes.map((node: MindMapNode): string => LexiLegacySamples.nodeSignature(node))) ===
      JSON.stringify(example.nodes.map((node: MindMapNode): string => LexiLegacySamples.nodeSignature(node)));
  }

  static sameBoard(board: CanvasBoard, example: CanvasBoard): boolean {
    return board.id === example.id && board.vaultId === example.vaultId && !board.projectId && board.title === example.title &&
      JSON.stringify(board.cards) === JSON.stringify(example.cards) && JSON.stringify(board.edges) === JSON.stringify(example.edges);
  }
}
