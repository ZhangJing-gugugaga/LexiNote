export class VaultItem {
  archived: boolean = false;
  favorite: boolean = false;
  id: string = 'default-vault';
  name: string = '个人知识库';
  description: string = '日常记录、课程学习与技术文档';
  createdAt: number = 0;
  version: number = 1;
  folderUri: string = '';
  permissionUri: string = '';
}

export class LexiProject {
  archived: boolean = false;
  favorite: boolean = false;
  id: string = '';
  vaultId: string = '';
  name: string = '';
  folderUri: string = '';
  permissionUri: string = '';
  createdAt: number = 0;
}

export class NoteProperty {
  key: string = '';
  propValue: string = '';

  constructor(key: string = '', propValue: string = '') {
    this.key = key;
    this.propValue = propValue;
  }
}

export class NoteItem {
  id: string = '';
  vaultId: string = 'default-vault';
  projectId: string = '';
  sourceMissing: boolean = false;
  title: string = '';
  notebook: string = '速记收件箱';
  content: string = '';
  path: string = '';
  noteType: string = 'quick'; // 'quick' | 'study' | 'markdown'
  editorLevel: string = 'simple'; // 'simple' | 'study' | 'pro'
  tags: string[] = [];
  properties: NoteProperty[] = [];
  pinned: boolean = false;
  favorite: boolean = false;
  trashedAt: number = 0;
  createdAt: number = 0;
  updatedAt: number = 0;
}

export class NoteLink {
  sourceId: string = '';
  sourceTitle: string = '';
  targetId: string = '';
  targetTitle: string = '';
  anchor: string = '';
  displayText: string = '';
}

export class UnlinkedMention {
  sourceId: string = '';
  sourceTitle: string = '';
  targetId: string = '';
  targetTitle: string = '';
  snippet: string = '';
}

export class MindMapNode {
  id: string = '';
  parentId: string = '';
  text: string = '';
  note: string = '';
  noteRefId: string = '';
  noteRefTitle: string = '';
  order: number = 0;
  collapsed: boolean = false;
  colorTag: string = 'purple'; // 'purple' | 'indigo' | 'teal' | 'amber' | 'rose'
  level: number = 0;
  x: number = 0;
  y: number = 0;
  boxWidth: number = 136;
  boxHeight: number = 44;
  offsetX: number = 0;
  offsetY: number = 0;
}

export class MindMapDoc {
  id: string = '';
  vaultId: string = 'default-vault';
  projectId: string = '';
  title: string = '';
  layoutKind: string = 'right'; // 'right' | 'balanced' | 'org'
  rootNodeId: string = 'root';
  nodes: MindMapNode[] = [];
  favorite: boolean = false;
  trashedAt: number = 0;
  createdAt: number = 0;
  updatedAt: number = 0;
}

export class CanvasCard {
  id: string = '';
  title: string = '';
  content: string = '';
  noteRefId: string = '';
  noteRefTitle: string = '';
  x: number = 60;
  y: number = 60;
  colorTag: string = 'purple';
}

export class CanvasEdge {
  id: string = '';
  fromId: string = '';
  toId: string = '';
  label: string = '';
}

export class CanvasBoard {
  id: string = '';
  vaultId: string = 'default-vault';
  projectId: string = '';
  title: string = '';
  cards: CanvasCard[] = [];
  edges: CanvasEdge[] = [];
  createdAt: number = 0;
  updatedAt: number = 0;
}

export class GraphNode {
  id: string = '';
  label: string = '';
  kind: string = 'note'; // 'note' | 'mindmap' | 'tag'
  noteType: string = 'quick';
  degree: number = 0;
  x: number = 0;
  y: number = 0;
  tags: string[] = [];
  snippet: string = '';
}

export class GraphEdge {
  sourceId: string = '';
  targetId: string = '';
  kind: string = 'link'; // 'link' | 'mapRef'
}

export class MarkdownBlock {
  id: string = '';
  kind: string = 'paragraph'; // 'h1' | 'h2' | 'h3' | 'todo' | 'bullet' | 'quote' | 'callout' | 'code' | 'formula' | 'paragraph'
  text: string = '';
  checked: boolean = false;
  meta: string = '';
  lineIndex: number = 0;
}

export class OutlineHeading {
  id: string = '';
  level: number = 1;
  title: string = '';
  lineIndex: number = 0;
}

export class NoteEditorRouteParam {
  restoreSelectionStart: number = -1;
  restoreSelectionEnd: number = -1;
  restoreSourceMode: boolean = false;
  launchAssistant: boolean = false;
  templateId: string = '';
  vaultId: string = '';
  projectId: string = '';
  noteId: string = '';
  createNew: boolean = false;
  initialType: string = 'quick';
  initialTier: string = 'simple';
  initialTitle: string = '';
  initialContent: string = '';
}

export class MindMapRouteParam {
  projectId: string = '';
  mapId: string = '';
  createNew: boolean = false;
  fromNoteId: string = '';
}

export class CanvasRouteParam {
  projectId: string = '';
  canvasId: string = '';
  createNew: boolean = false;
}

export class LexiBackupPackage {
  format: string = 'LexiNote.Backup';
  version: number = 1;
  exportedAt: number = 0;
  vaults: VaultItem[] = [];
  projects: LexiProject[] = [];
  notes: NoteItem[] = [];
  mindMaps: MindMapDoc[] = [];
  canvases: CanvasBoard[] = [];
  templateLibrary: string = '';
}

export class TagCount {
  name: string = '';
  count: number = 0;
}

export class CreateEntry {
  kind: string = '';
  icon: string = '';
  title: string = '';
  caption: string = '';

  constructor(kind: string, icon: string, title: string, caption: string) {
    this.kind = kind;
    this.icon = icon;
    this.title = title;
    this.caption = caption;
  }
}

export const CREATE_ENTRIES: CreateEntry[] = [
  new CreateEntry('quick', 'note', '快速笔记', '灵感 · 待办 · 日记'),
  new CreateEntry('study', 'study', '学习笔记', '公式 · 代码 · 大纲'),
  new CreateEntry('markdown', 'markdown', '专业 Markdown', '源码 · 双链 · 属性'),
  new CreateEntry('mindmap', 'mindmap', '思维导图', '树形结构 · 大纲切换'),
  new CreateEntry('canvas', 'canvas', '自由白板', '卡片 · 连线 · 拼贴'),
  new CreateEntry('explore', 'graph', '笔记关联', '查看相关笔记与引用')
];

export class NoteRevision {
  id: string = '';
  savedAt: number = 0;
  snapshot: NoteItem = new NoteItem();
}
