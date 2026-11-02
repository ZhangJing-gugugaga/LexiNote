// Vault facade over LexiStorageService: exposes the Obsidian-style path API on top of the
// UUID note store. Open documents are written through the live editor to respect the
// save-boundary optimistic lock (saveNoteIfCurrent).

import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { NoteItem } from '../LexiModels';
import { LexiStorageService } from '../LexiStorageService';
import { LexiFrontmatter } from '../LexiFrontmatter';
import { LexiPluginBus, LexiNoteChange } from './LexiPluginBus';
import { LexiVaultRevisionGuard } from './LexiVaultRevisionGuard';
import { LexiEvents } from './LexiPluginKernel';
import { LexiEditorRegistry } from './LexiEditorRegistry';
import {
  buildVaultIndex,
  fileBaseName,
  LexiTFolder,
  LexiTFile,
  LexiTreeNode,
  LexiVaultIndex,
  normalizePath,
  resolvePath
} from './LexiVaultModel';

export class LexiFileEventPayload {
  file: LexiTFile = new LexiTFile();
  oldPath: string = '';
}

/**
 * Bridge for documents that are currently open in an editor tab. The UI layer assigns the
 * applier at startup; while it is set, vault.modify routes through the live editor instead
 * of writing behind the editor's back.
 */
export class LexiOpenEditorLink {
  static applier: ((noteId: string, nextText: string) => Promise<void>) | null = null;

  static hasApplier(): boolean {
    return LexiOpenEditorLink.applier !== null;
  }
}

export class LexiVaultFacade {
  /** revision 乐观锁(T2.3):写路径全部推进,过期预期写入判 vault_conflict(§7.1)。 */
  readonly revisionGuard: LexiVaultRevisionGuard = new LexiVaultRevisionGuard();

  /** 读路径统一补 revision:插件拿到的 TFile.stat.revision 是乐观锁凭据。 */
  private enrichRevision(file: LexiTFile | null): LexiTFile | null {
    if (file !== null) { file.stat.revision = this.revisionGuard.revisionOf(file.path); }
    return file;
  }
  private context: common.Context | null = null;
  private index: LexiVaultIndex = new LexiVaultIndex();
  private notes: NoteItem[] = [];
  private activeVaultId: string = '';
  private dirty: boolean = true;
  events: LexiEvents = new LexiEvents();

  async init(context: common.Context): Promise<void> {
    this.context = context;
    await LexiStorageService.init(context);
    LexiPluginBus.on('lexi.note.changed', (payload: Object): void => {
      // 单一事件源:任何笔记变更(含编辑器保存)都在这里桥接为 vault 事件
      const change = payload as LexiNoteChange;
      this.dirty = true;
      this.refresh().then((): void => {
        const file = this.index.fileByNoteId.get(change.noteId);
        hilog.info(0x1051, 'LexiPlugin', '%{public}s',
          `vault事件桥接: kind=${change.kind} note=${change.noteId} file=${file ? file.path : 'none'} listeners=${this.events.listenerCount(change.kind)}`);
        if (file) {
          const eventPayload = new LexiFileEventPayload();
          eventPayload.file = file;
          // 宿主只给 oldTitle(没有旧路径),按新路径的目录 + 旧标题近似还原 oldPath:
          // 重命名不改目录,所以目录部分一定是旧的正确值。
          if (change.kind === 'rename' && change.oldTitle.length > 0 && file.path.length > 0) {
            const slash: number = file.path.lastIndexOf('/');
            const dir: string = slash >= 0 ? file.path.substring(0, slash + 1) : '';
            eventPayload.oldPath = dir + change.oldTitle + '.md';
          } else {
            eventPayload.oldPath = '';
          }
          this.events.trigger(change.kind, eventPayload);
        } else if (change.kind === 'delete') {
          const sparse = new LexiTFile();
          sparse.noteId = change.noteId;
          sparse.vaultId = change.vaultId;
          sparse.name = change.title;
          sparse.path = '';
          const eventPayload = new LexiFileEventPayload();
          eventPayload.file = sparse;
          this.events.trigger('delete', eventPayload);
        }
      }).catch((): void => {});
    });
    await this.refresh();
  }

  async refresh(): Promise<void> {
    // Obsidian 语义:插件看到的路径相对"当前库",切换工作区即切换根
    const activeVaultId = await LexiStorageService.getActiveVaultId();
    const allNotes = await LexiStorageService.getNotes('');
    const projects = await LexiStorageService.getProjects(activeVaultId, true);
    const projectNames = new Map<string, string>();
    for (const project of projects) { projectNames.set(project.id, project.name); }
    const scoped: NoteItem[] = [];
    for (const note of allNotes) {
      if (note.vaultId === activeVaultId) { scoped.push(note); }
    }
    this.activeVaultId = activeVaultId;
    this.notes = scoped;
    this.index = buildVaultIndex(scoped, projectNames);
    this.dirty = false;
  }

  private async ensureFresh(): Promise<void> {
    if (!this.dirty) {
      const current = await LexiStorageService.getActiveVaultId();
      if (current !== this.activeVaultId) { this.dirty = true; }
    }
    if (this.dirty) { await this.refresh(); }
  }

  private async noteByFile(file: LexiTFile): Promise<NoteItem | undefined> {
    await this.ensureFresh();
    return this.notes.find((note: NoteItem): boolean => note.id === file.noteId);
  }

  private async rebuild(): Promise<void> {
    await this.refresh();
  }

  getRoot(): LexiTFolder {
    return this.index.root;
  }

  getFileByPath(path: string): LexiTFile | null {
    const node = resolvePath(this.index, path);
    return this.enrichRevision(node && node.kind === 'file' ? node as LexiTFile : null);
  }

  getFolderByPath(path: string): LexiTFolder | null {
    const node = resolvePath(this.index, path);
    return node && node.kind === 'folder' ? node as LexiTFolder : null;
  }

  getAbstractFileByPath(path: string): LexiTreeNode | null {
    const node = resolvePath(this.index, path);
    if (node !== null && node.kind === 'file') { return this.enrichRevision(node as LexiTFile); }
    return node;
  }

  async getMarkdownFiles(): Promise<LexiTFile[]> {
    await this.ensureFresh();
    const files: LexiTFile[] = [];
    this.index.fileByNoteId.forEach((file: LexiTFile): void => { files.push(file); });
    return files.sort((a: LexiTFile, b: LexiTFile): number => a.path.localeCompare(b.path))
      .map((file: LexiTFile): LexiTFile => {
        file.stat.revision = this.revisionGuard.revisionOf(file.path);
        return file;
      });
  }

  async read(file: LexiTFile): Promise<string> {
    const note = await this.noteByFile(file);
    if (!note) { throw new Error('笔记不存在: ' + file.path); }
    return note.content;
  }

  async cachedRead(file: LexiTFile): Promise<string> {
    return this.read(file);
  }

  noteContentById(noteId: string): string {
    for (const note of this.notes) {
      if (note.id === noteId) { return note.content; }
    }
    return '';
  }

  async modify(file: LexiTFile, data: string, expectedRevision: number = -1): Promise<void> {
    // 乐观锁闸(T2.3):expectedRevision>=0 时必须与宿主侧一致,否则 vault_conflict(first-writer-wins)。
    const revisionGate = this.revisionGuard.checkAndBump(file.path, expectedRevision);
    if (!revisionGate.ok) { throw new Error(revisionGate.reason); }
    const note = await this.noteByFile(file);
    if (!note) { throw new Error('笔记不存在: ' + file.path); }
    const controller = LexiEditorRegistry.controllerFor(note.id);
    if (controller) {
      // The document is open: write through the live editor so the optimistic save boundary holds.
      const current = controller.getText();
      controller.replaceRange(0, current.length, data);
      await this.rebuild();
      return;
    }
    const incoming = JSON.parse(JSON.stringify(note)) as NoteItem;
    incoming.content = data;
    if (LexiFrontmatter.parse(data).hasFrontmatter) {
      LexiFrontmatter.apply(incoming, data);
    }
    await this.saveNoteThroughStorage(incoming);
    await this.rebuild();
  }

  /** 存储层在内部深拷贝后才分配 id,必须使用返回值定位新笔记。 */
  private async saveNoteThroughStorage(note: NoteItem): Promise<NoteItem> {
    if (!this.context) { throw new Error('Vault 尚未初始化'); }
    return await LexiStorageService.saveNote(this.context, note);
  }

  async create(path: string, data: string): Promise<LexiTFile> {
    await this.ensureFresh();
    const normalized = normalizePath(path);
    if (!normalized.toLowerCase().endsWith('.md')) { throw new Error('插件暂只支持创建 Markdown 笔记'); }
    const segments = normalized.split('/').filter((segment: string): boolean => segment.length > 0);
    if (segments.length < 2) { throw new Error('路径必须包含文件夹: ' + path); }
    const fileName = segments[segments.length - 1];
    const title = fileName.substring(0, fileName.length - 3);
    const folderPath = segments.slice(0, segments.length - 1);
    // 路径相对当前库:<项目?>/<文件夹>/<标题>.md
    let projectId = '';
    let notebook = folderPath[0];
    if (folderPath.length >= 2) {
      projectId = this.index.projectIdByName.get(folderPath[0]) || '';
      notebook = folderPath[1];
    }
    const note = new NoteItem();
    note.vaultId = this.activeVaultId;
    note.projectId = projectId;
    note.notebook = notebook;
    note.title = title;
    note.noteType = 'markdown';
    note.editorLevel = 'pro';
    note.content = data;
    LexiFrontmatter.apply(note, data);
    note.content = data;
    const saved = await this.saveNoteThroughStorage(note);
    await this.refresh();
    const created = this.index.fileByNoteId.get(saved.id);
    if (!created) { throw new Error('笔记创建失败: ' + path); }
    this.revisionGuard.checkAndBump(created.path, -1);
    return created;
  }

  async delete(file: LexiTFile, force: boolean = false): Promise<void> {
    if (!this.context) { throw new Error('Vault 尚未初始化'); }
    await this.ensureFresh();
    const note = await this.noteByFile(file);
    if (!note) { return; }
    if (force) {
      await LexiStorageService.deleteNotePermanently(note.id);
    } else {
      await LexiStorageService.setNoteTrash(this.context, note.id, true);
    }
    await this.refresh();
    this.revisionGuard.forget(file.path);
  }

  async rename(file: LexiTFile, newPath: string): Promise<void> {
    if (!this.context) { throw new Error('Vault 尚未初始化'); }
    const normalized = normalizePath(newPath);
    if (!normalized.toLowerCase().endsWith('.md')) { throw new Error('重命名目标必须是 Markdown 文件'); }
    const fileName = fileBaseName(normalized);
    const title = fileName.toLowerCase().endsWith('.md') ? fileName.substring(0, fileName.length - 3) : fileName;
    if (title.length === 0) { throw new Error('无效的文件名'); }
    await LexiStorageService.renameNote(this.context, file.noteId, title);
    await this.refresh();
    this.revisionGuard.rename(file.path, normalized);
  }

  async process(file: LexiTFile, fn: (data: string) => string): Promise<string> {
    const content = await this.read(file);
    const next = fn(content);
    if (next === content) { return next; }
    await this.modify(file, next);
    return next;
  }

  async append(file: LexiTFile, data: string): Promise<void> {
    this.revisionGuard.checkAndBump(file.path, -1);
    const content = await this.read(file);
    await this.modify(file, content + data);
  }

  fileForNoteId(noteId: string): LexiTFile | null {
    return this.index.fileByNoteId.get(noteId) || null;
  }

  noteById(noteId: string): NoteItem | undefined {
    return this.notes.find((note: NoteItem): boolean => note.id === noteId);
  }

  allNotes(): NoteItem[] {
    return this.notes;
  }
}

export function fileEventPayload(payload: Object | null): LexiFileEventPayload | null {
  return payload as LexiFileEventPayload;
}

export function noteChangePayload(payload: Object): LexiNoteChange | null {
  return payload as LexiNoteChange;
}
