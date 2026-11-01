import { common } from '@kit.AbilityKit';
import { fileUri } from '@kit.CoreFileKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { CanvasBoard, LexiProject, MindMapDoc, NoteItem, VaultItem } from './LexiModels';
import { LexiContextTarget } from './LexiContextModels';
import { LexiFolderStore } from './LexiFolderStore';
import { LexiStorageService as Storage } from './LexiStorageService';

export class LexiFileActions {
  static async spatialAction(context: common.UIAbilityContext, target: LexiContextTarget, action: string, title: string = ''): Promise<string> {
    const doc: MindMapDoc | CanvasBoard | undefined = target.kind === 'mindmap' ?
      await Storage.getMindMapById(target.id) : await Storage.getCanvasById(target.id);
    if (!doc) { throw new Error('文件已不存在'); }
    if (action === 'delete') {
      if (target.kind === 'mindmap') { await Storage.deleteMindMap(target.id); } else { await Storage.deleteCanvas(target.id); }
      return '';
    }
    const copy = JSON.parse(JSON.stringify(doc)) as MindMapDoc | CanvasBoard;
    if (action === 'duplicate') {
      copy.id = `${target.kind === 'mindmap' ? 'map' : 'canvas'}-${util.generateRandomUUID(true)}`;
      copy.title = `${doc.title || target.title} 副本`; copy.createdAt = 0;
    } else if (action === 'rename') {
      if (!title.trim()) { throw new Error('名称不能为空'); } copy.title = title.trim();
    }
    if (target.kind === 'mindmap') { await Storage.saveMindMap(context, copy as MindMapDoc); }
    else { await Storage.saveCanvas(context, copy as CanvasBoard); }
    return `${target.kind === 'mindmap' ? 'map' : 'canvas'}:${copy.id}`;
  }

  static async path(context: common.UIAbilityContext, target: LexiContextTarget): Promise<string> {
    if (target.kind === 'note') { return (await Storage.getNoteById(target.id))?.path || ''; }
    const project = target.projectId ? (await Storage.getProjects('', true)).find((p: LexiProject): boolean => p.id === target.projectId) : undefined;
    const vault = (await Storage.getVaults(true)).find((v: VaultItem): boolean => v.id === target.vaultId);
    return project?.folderUri ? LexiFolderStore.path(project.folderUri) : vault?.folderUri ? LexiFolderStore.path(vault.folderUri) :
      `${context.filesDir}/vaults/${target.vaultId}`;
  }
  static async copyPath(context: common.UIAbilityContext, target: LexiContextTarget, relative: boolean): Promise<void> {
    let path = await LexiFileActions.path(context, target);
    if (relative) {
      const rootTarget = LexiContextTarget.scope('workspace', target.vaultId, target.vaultId, '', '');
      const root = await LexiFileActions.path(context, rootTarget);
      path = path.startsWith(root + '/') ? path.substring(root.length + 1) : path.substring(path.lastIndexOf('/') + 1);
    }
    await pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, path));
  }
  static async openExternal(context: common.UIAbilityContext, target: LexiContextTarget): Promise<void> {
    const path = await LexiFileActions.path(context, target);
    if (!path) { throw new Error('文件尚未保存'); }
    await context.startAbility({ action: 'ohos.want.action.viewData', uri: fileUri.getUriFromPath(path),
      type: 'text/markdown', flags: 1 });
  }

  static async reveal(context: common.UIAbilityContext, target: LexiContextTarget): Promise<void> {
    const project = target.projectId ? (await Storage.getProjects('', true)).find((p: LexiProject): boolean => p.id === target.projectId) : undefined;
    const vault = (await Storage.getVaults(true)).find((v: VaultItem): boolean => v.id === target.vaultId);
    const rootUri = project?.folderUri || vault?.folderUri || '';
    if (!rootUri) { throw new Error('笔记保存在应用内部，系统文件管理无法直接访问'); }
    const root = LexiFolderStore.path(rootUri);
    let path = await LexiFileActions.path(context, target);
    if (!path) { throw new Error('文件尚未保存'); }
    if (target.kind === 'note') { path = path.substring(0, path.lastIndexOf('/')); }
    if (!root || (path !== root && !path.startsWith(`${root}/`))) { throw new Error('无法定位到已授权的工作区文件夹'); }
    const relative = path === root ? '' : path.substring(root.length + 1);
    const directoryUri = rootUri.replace(/\/+$/, '') + (relative ? '/' + relative.split('/').map((part: string): string => encodeURIComponent(part)).join('/') : '');
    try {
      await context.openLink('filemanager://openDirectory', { parameters: { 'fileUri': directoryUri } });
    } catch { throw new Error('系统无法打开这个文件夹，请检查文件管理和目录权限'); }
  }
  static async create(context: common.UIAbilityContext, target: LexiContextTarget, kind: string): Promise<string> {
    if (kind === 'new-canvas') {
      const board = new CanvasBoard(); board.vaultId = target.vaultId; board.projectId = target.projectId;
      board.title = '新建白板'; board.cards = [];
      const saved = await Storage.saveCanvas(context, board); return `canvas:${saved.id}`;
    }
    const note = new NoteItem(); note.vaultId = target.vaultId; note.projectId = target.projectId;
    note.notebook = target.notebook || '笔记';
    if (kind === 'new-table') {
      note.title = '新建表格'; note.noteType = 'markdown'; note.editorLevel = 'pro';
      note.content = '| 名称 | 状态 | 备注 |\n| --- | --- | --- |\n|  | 待办 |  |\n';
    }
    const saved = await Storage.saveNote(context, note); return saved.id;
  }
  static async duplicateScope(context: common.UIAbilityContext, target: LexiContextTarget): Promise<void> {
    let destination = target.vaultId;
    let projectId = '';
    if (target.kind === 'workspace') {
      destination = (await Storage.createVault(context, `${target.title} 副本`, '工作区副本')).id;
    } else {
      projectId = (await Storage.createInternalProject(context, destination, `${target.title} 副本`)).id;
    }
    const visibleProjects = await Storage.getProjects(target.vaultId);
    const notes = (await Storage.getNotes(target.vaultId)).filter((n: NoteItem): boolean => n.trashedAt === 0 && (!n.projectId || visibleProjects.some((project: LexiProject): boolean => project.id === n.projectId)) &&
      (target.kind === 'workspace' || (n.projectId || '') === target.projectId) && (target.kind !== 'folder' || n.notebook === target.notebook));
    const projectMap = new Map<string, string>();
    if (target.kind === 'workspace') {
      for (const sourceProject of await Storage.getProjects(target.vaultId)) {
        projectMap.set(sourceProject.id, (await Storage.createInternalProject(context, destination, sourceProject.name)).id);
      }
    }
    const idMap = new Map<string, string>();
    for (const note of notes) { idMap.set(note.id, util.generateRandomUUID(true)); }
    for (const original of notes) {
      const copy = JSON.parse(JSON.stringify(original)) as NoteItem;
      copy.id = idMap.get(original.id)!; copy.vaultId = destination; copy.projectId = target.kind === 'workspace' ? projectMap.get(original.projectId) ?? '' : projectId;
      copy.path = ''; copy.createdAt = 0; copy.updatedAt = 0;
      idMap.forEach((newId: string, oldId: string): void => { copy.content = copy.content.split(`[[${oldId}`).join(`[[${newId}`); });
      await Storage.saveNote(context, copy);
    }
    for (const original of await Storage.getMindMaps(target.vaultId)) {
      if (original.projectId && !visibleProjects.some((project: LexiProject): boolean => project.id === original.projectId)) { continue; }
      if (original.trashedAt > 0 || target.kind === 'folder' || (target.kind !== 'workspace' && (original.projectId || '') !== target.projectId)) { continue; }
      const copy = JSON.parse(JSON.stringify(original)) as MindMapDoc;
      copy.id = `map-${util.generateRandomUUID(true)}`; copy.vaultId = destination; copy.projectId = target.kind === 'workspace' ? projectMap.get(original.projectId) ?? '' : projectId; copy.createdAt = 0;
      for (const node of copy.nodes) { node.noteRefId = idMap.get(node.noteRefId) ?? ''; }
      await Storage.saveMindMap(context, copy);
    }
    for (const original of await Storage.getCanvases(target.vaultId)) {
      if (original.projectId && !visibleProjects.some((project: LexiProject): boolean => project.id === original.projectId)) { continue; }
      if (target.kind === 'folder' || (target.kind !== 'workspace' && (original.projectId || '') !== target.projectId)) { continue; }
      const copy = JSON.parse(JSON.stringify(original)) as CanvasBoard;
      copy.id = `canvas-${util.generateRandomUUID(true)}`; copy.vaultId = destination; copy.projectId = target.kind === 'workspace' ? projectMap.get(original.projectId) ?? '' : projectId; copy.createdAt = 0;
      for (const card of copy.cards) { card.noteRefId = idMap.get(card.noteRefId) ?? ''; }
      await Storage.saveCanvas(context, copy);
    }
  }
}
