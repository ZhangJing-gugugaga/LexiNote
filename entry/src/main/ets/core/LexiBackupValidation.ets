import { CanvasBoard, LexiBackupPackage, MindMapDoc, NoteProperty } from './LexiModels';
import { LexiTemplateLibrary } from './LexiTemplateLibrary';

// Validate external data before it reaches file paths, the database or tree layout.
export class LexiBackupValidation {
  static validId(id: string): boolean {
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  }

  static validateMap(doc: MindMapDoc): void {
    if (!doc || !LexiBackupValidation.validId(doc.id) || typeof doc.title !== 'string' ||
      !Array.isArray(doc.nodes) || doc.nodes.length === 0 || doc.nodes.length > 10000) {
      throw new Error('导图格式无效');
    }
    const parents = new Map<string, string>();
    let roots: number = 0;
    for (const node of doc.nodes) {
      if (!node || !LexiBackupValidation.validId(node.id) || parents.has(node.id) ||
        typeof node.parentId !== 'string' || typeof node.text !== 'string' ||
        typeof node.note !== 'string' || typeof node.noteRefId !== 'string' ||
        typeof node.noteRefTitle !== 'string' || typeof node.collapsed !== 'boolean' ||
        typeof node.colorTag !== 'string' || !Number.isFinite(node.order) ||
        (node.offsetX !== undefined && !Number.isFinite(node.offsetX)) ||
        (node.offsetY !== undefined && !Number.isFinite(node.offsetY))) {
        throw new Error('导图包含无效或重复节点');
      }
      parents.set(node.id, node.parentId);
      if (!node.parentId) {
        roots++;
        if (node.id !== doc.rootNodeId) { throw new Error('导图根节点不匹配'); }
      }
    }
    if (roots !== 1) { throw new Error('导图必须包含一个根节点'); }
    for (const node of doc.nodes) {
      const visited = new Set<string>();
      let current: string = node.id;
      while (current) {
        if (visited.size >= 512 || visited.has(current) || !parents.has(current)) { throw new Error('导图存在循环或缺失的父节点'); }
        visited.add(current);
        current = parents.get(current) ?? '';
      }
    }
  }

  static validateCanvas(board: CanvasBoard): void {
    if (!board || !LexiBackupValidation.validId(board.id) || typeof board.title !== 'string' ||
      !Array.isArray(board.cards) || !Array.isArray(board.edges)) { throw new Error('白板格式无效'); }
    const ids = new Set<string>();
    for (const card of board.cards) {
      if (!card || !LexiBackupValidation.validId(card.id) || ids.has(card.id) ||
        typeof card.title !== 'string' || typeof card.content !== 'string' ||
        typeof card.noteRefId !== 'string' || typeof card.noteRefTitle !== 'string' ||
        typeof card.colorTag !== 'string' ||
        !Number.isFinite(card.x) || !Number.isFinite(card.y)) { throw new Error('白板卡片无效'); }
      ids.add(card.id);
    }
    for (const edge of board.edges) {
      if (!edge || !ids.has(edge.fromId) || !ids.has(edge.toId)) { throw new Error('白板连线无效'); }
    }
  }

  static validate(pkg: LexiBackupPackage): void {
    if (!pkg || pkg.format !== 'LexiNote.Backup' || pkg.version !== 1 ||
      !Array.isArray(pkg.vaults) || pkg.vaults.length === 0 ||
      !Array.isArray(pkg.notes) || !Array.isArray(pkg.mindMaps) || !Array.isArray(pkg.canvases)) {
      throw new Error('备份格式无效或版本不受支持，当前知识库未改动');
    }
    if (pkg.templateLibrary !== undefined && pkg.templateLibrary !== '') {
      if (typeof pkg.templateLibrary !== 'string') { throw new Error('备份模板库格式无效'); }
      LexiTemplateLibrary.decode(pkg.templateLibrary);
    }
    const vaultIds = new Set<string>();
    for (const vault of pkg.vaults) {
      if (!vault || !LexiBackupValidation.validId(vault.id) || vaultIds.has(vault.id) ||
        typeof vault.name !== 'string') { throw new Error('备份知识库信息无效'); }
      vaultIds.add(vault.id);
    }
    const noteIds = new Set<string>();
    for (const note of pkg.notes) {
      if (!note || !LexiBackupValidation.validId(note.id) || noteIds.has(note.id) ||
        !vaultIds.has(note.vaultId) || typeof note.title !== 'string' || typeof note.content !== 'string' ||
        !Array.isArray(note.tags) || !note.tags.every((tag: string): boolean => typeof tag === 'string') ||
        !Array.isArray(note.properties) ||
        !note.properties.every((prop: NoteProperty): boolean => !!prop && typeof prop.key === 'string' && typeof prop.propValue === 'string') ||
        typeof note.notebook !== 'string' ||
        typeof note.noteType !== 'string' || typeof note.editorLevel !== 'string' ||
        typeof note.pinned !== 'boolean' || typeof note.favorite !== 'boolean' ||
        !Number.isFinite(note.trashedAt) || !Number.isFinite(note.createdAt) || !Number.isFinite(note.updatedAt)) {
        throw new Error('备份笔记信息无效');
      }
      noteIds.add(note.id);
    }
    const mapIds = new Set<string>();
    for (const doc of pkg.mindMaps) {
      LexiBackupValidation.validateMap(doc);
      if (!vaultIds.has(doc.vaultId) || mapIds.has(doc.id)) { throw new Error('备份导图信息无效'); }
      mapIds.add(doc.id);
    }
    const canvasIds = new Set<string>();
    for (const board of pkg.canvases) {
      LexiBackupValidation.validateCanvas(board);
      if (!vaultIds.has(board.vaultId) || canvasIds.has(board.id)) { throw new Error('备份白板信息无效'); }
      canvasIds.add(board.id);
    }
  }
}
