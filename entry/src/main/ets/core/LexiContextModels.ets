import { NoteItem } from './LexiModels';
import { MarkdownEngine } from './MarkdownEngine';

export class LexiContextTarget {
  kind: string = 'workspace';
  id: string = '';
  vaultId: string = '';
  projectId: string = '';
  notebook: string = '';
  title: string = '';
  favorite: boolean = false;
  static note(note: NoteItem): LexiContextTarget {
    const target = new LexiContextTarget();
    target.kind = 'note'; target.id = note.id; target.vaultId = note.vaultId;
    target.projectId = note.projectId || ''; target.notebook = note.notebook;
    target.title = MarkdownEngine.displayTitle(note); target.favorite = note.favorite;
    return target;
  }
  static scope(kind: string, id: string, vaultId: string, projectId: string, title: string, favorite: boolean = false): LexiContextTarget {
    const target = new LexiContextTarget();
    target.favorite = favorite; target.kind = kind; target.id = id; target.vaultId = vaultId; target.projectId = projectId; target.title = title;
    if (kind === 'folder') { target.notebook = title; }
    return target;
  }
}
export class LexiContextCommand {
  nonce: number = Date.now();
  action: string = '';
  target: LexiContextTarget = new LexiContextTarget();
}
export class LexiContextAction {
  id: string;
  label: string;
  group: string;
  constructor(id: string, label: string, group: string) { this.id = id; this.label = label; this.group = group; }
}
export class LexiContextBridge {
  static send(action: string, target: LexiContextTarget): void {
    const command = new LexiContextCommand(); command.action = action; command.target = target;
    AppStorage.setOrCreate('lexiContextCommand', JSON.stringify(command));
  }
  static actions(target: LexiContextTarget, desktop: boolean): LexiContextAction[] {
    const actions: LexiContextAction[] = [];
    if (target.kind === 'mindmap' || target.kind === 'canvas') {
      actions.push(new LexiContextAction('open-tab', target.kind === 'mindmap' ? (desktop ? '在新标签页中打开' : '打开思维导图') : '打开白板', '打开'));
      if (desktop && target.kind === 'mindmap') {
        actions.push(new LexiContextAction('open-group', '在新标签组中打开', '打开'));
        actions.push(new LexiContextAction('open-window', '在新窗口中打开', '打开'));
      }
      actions.push(new LexiContextAction('duplicate', '创建副本', '整理'));
      actions.push(new LexiContextAction('rename', '重命名', '管理'));
      actions.push(new LexiContextAction('delete', '删除…', '管理'));
      return actions;
    }
    if (target.kind === 'note') {
      actions.push(new LexiContextAction('open-tab', desktop ? '在新标签页中打开' : '打开笔记', '打开'));
      if (desktop) {
        actions.push(new LexiContextAction('open-group', '在新标签组中打开', '打开'));
        actions.push(new LexiContextAction('open-window', '在新窗口中打开', '打开'));
      }
    } else {
      actions.push(new LexiContextAction('new-note', '新建笔记', '创建'));
      actions.push(new LexiContextAction('new-folder', '新建文件夹', '创建'));
      actions.push(new LexiContextAction('new-canvas', '新建白板', '创建'));
      actions.push(new LexiContextAction('new-table', '新建数据库（表格笔记）', '创建'));
    }
    actions.push(new LexiContextAction('duplicate', '创建副本', '整理'));
    actions.push(new LexiContextAction('move', '移动到…', '整理'));
    if (target.kind !== 'note') { actions.push(new LexiContextAction('search', '在文件夹中查找', '整理')); }
    actions.push(new LexiContextAction('favorite', target.favorite ? '取消收藏' : '收藏', '整理'));
    if (target.kind === 'note') { actions.push(new LexiContextAction('merge', '将该笔记合并到…', '整理')); }
    actions.push(new LexiContextAction('copy-path', '复制完整路径', '文件'));
    actions.push(new LexiContextAction('copy-relative', '复制相对路径', '文件'));
    if (target.kind === 'note') {
      actions.push(new LexiContextAction('history', '打开版本历史', '文件'));
      actions.push(new LexiContextAction('save-template', '设为模板', '整理'));
      actions.push(new LexiContextAction('share-file', '系统分享文件', '文件'));
      actions.push(new LexiContextAction('open-external', '使用默认应用打开', '文件'));
    }
    actions.push(new LexiContextAction('reveal', '在文件管理中显示', '文件'));
    actions.push(new LexiContextAction('rename', '重命名', '管理'));
    actions.push(new LexiContextAction('delete', target.kind === 'note' || target.kind === 'folder' ? '移到回收站' : '移除（保留原文件）', '管理'));
    return actions;
  }
}
