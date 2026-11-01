// Vault facade over LexiStorageService: exposes the Obsidian-style path API on top of the
// UUID note store. Open documents are written through the live editor to respect the
// save-boundary optimistic lock (saveNoteIfCurrent).

import { common } from '@kit.AbilityKit';
import { NoteItem } from '../LexiModels';
import { LexiStorageService } from '../LexiStorageService';
import { LexiFrontmatter } from '../LexiFrontmatter';
import { LexiPluginBus, LexiNoteChange } from './LexiPluginBus';
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
  private context: common.Context | null = null;
  private index: LexiVaultIndex = new LexiVaultIndex();
  private notes: NoteItem[] = [];
  private dirty: boolean = true;
  events: LexiEvents = new LexiEvents();

  async init(context: common.Context): Promise<void> {
    this.context = context;
    await LexiStorageService.init(context);
    LexiPluginBus.on('lexi.note.changed', (_payload: Object): void => { this.dirty = true; });
    await this.refresh();
  }

  async refresh(): Promise<void> {
    // ArkTS 禁止解构声明,顺序取回三类数据
    const notes = await LexiStorageService.getNotes('');
    const vaults = await LexiStorageService.getVaults(true);
    const projects = await LexiStorageService.getProjects('', true);
    const vaultNames = new Map<string, string>();
    for (const vault of vaults) { vaultNames.set(vault.id, vault.name); }
    const projectNames = new Map<string, string>();
    for (const project of projects) { projectNames.set(project.id, project.name); }
    this.notes = notes;
    this.index = buildVaultIndex(notes, vaultNames, projectNames);
    this.dirty = false;
  }

  private async ensureFresh(): Promise<void> {
    if (this.dirty) { await this.refresh(); }
  }

  private async noteByFile(file: LexiTFile): Promise<NoteItem | undefined> {
    await this.ensureFresh();
    return this.notes.find((note: NoteItem): boolean => note.id === file.noteId);
  }

  private async rebuildAndEmit(kind: string, file: LexiTFile, oldPath: string = ''): Promise<void> {
    await this.refresh();
    const payload = new LexiFileEventPayload();
    payload.file = file;
    payload.oldPath = oldPath;
    this.events.trigger(kind, payload);
  }

  getRoot(): LexiTFolder {
    return this.index.root;
  }

  getFileByPath(path: string): LexiTFile | null {
    const node = resolvePath(this.index, path);
    return node && node.kind === 'file' ? node as LexiTFile : null;
  }

  getFolderByPath(path: string): LexiTFolder | null {
    const node = resolvePath(this.index, path);
    return node && node.kind === 'folder' ? node as LexiTFolder : null;
  }

  getAbstractFileByPath(path: string): LexiTreeNode | null {
    return resolvePath(this.index, path);
  }

  async getMarkdownFiles(): Promise<LexiTFile[]> {
    await this.ensureFresh();
    const files: LexiTFile[] = [];
    this.index.fileByNoteId.forEach((file: LexiTFile): void => { files.push(file); });
    return files.sort((a: LexiTFile, b: LexiTFile): number => a.path.localeCompare(b.path));
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

  async modify(file: LexiTFile, data: string): Promise<void> {
    const note = await this.noteByFile(file);
    if (!note) { throw new Error('笔记不存在: ' + file.path); }
    const controller = LexiEditorRegistry.controllerFor(note.id);
    if (controller) {
      // The document is open: write through the live editor so the optimistic save boundary holds.
      const current = controller.getText();
      controller.replaceRange(0, current.length, data);
      await this.rebuildAndEmit('modify', file);
      return;
    }
    const incoming = JSON.parse(JSON.stringify(note)) as NoteItem;
    incoming.content = data;
    if (LexiFrontmatter.parse(data).hasFrontmatter) {
      LexiFrontmatter.apply(incoming, data);
    }
    await this.saveNoteThroughStorage(incoming);
    await this.rebuildAndEmit('modify', file);
  }

  private async saveNoteThroughStorage(note: NoteItem): Promise<void> {
    if (!this.context) { throw new Error('Vault 尚未初始化'); }
    await LexiStorageService.saveNote(this.context, note);
  }

  async create(path: string, data: string): Promise<LexiTFile> {
    await this.ensureFresh();
    const normalized = normalizePath(path);
    if (!normalized.toLowerCase().endsWith('.md')) { throw new Error('插件暂只支持创建 Markdown 笔记'); }
    const segments = normalized.split('/').filter((segment: string): boolean => segment.length > 0);
    if (segments.length < 2) { throw new Error('路径必须位于工作区目录下: ' + path); }
    const fileName = segments[segments.length - 1];
    const title = fileName.substring(0, fileName.length - 3);
    const folderPath = segments.slice(0, segments.length - 1);
    const vaultName = folderPath[0];
    const vaultId = this.index.vaultIdByName.get(vaultName);
    if (!vaultId) { throw new Error('未知工作区: ' + vaultName); }
    let projectId = '';
    let notebook = '';
    if (folderPath.length >= 3) {
      projectId = this.index.projectIdByName.get(folderPath[1]) || '';
      notebook = folderPath[2];
    } else {
      notebook = folderPath[1];
    }
    const note = new NoteItem();
    note.vaultId = vaultId;
    note.projectId = projectId;
    note.notebook = notebook;
    note.title = title;
    note.noteType = 'markdown';
    note.editorLevel = 'pro';
    note.content = data;
    LexiFrontmatter.apply(note, data);
    note.content = data;
    await this.saveNoteThroughStorage(note);
    await this.refresh();
    const created = this.index.fileByNoteId.get(note.id);
    if (!created) { throw new Error('笔记创建失败: ' + path); }
    await this.emitEvent('create', created, '');
    return created;
  }

  private async emitEvent(kind: string, file: LexiTFile, oldPath: string): Promise<void> {
    const payload = new LexiFileEventPayload();
    payload.file = file;
    payload.oldPath = oldPath;
    this.events.trigger(kind, payload);
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
      await this.refresh();
    }
    await this.emitEvent('delete', file, file.path);
  }

  async rename(file: LexiTFile, newPath: string): Promise<void> {
    if (!this.context) { throw new Error('Vault 尚未初始化'); }
    const normalized = normalizePath(newPath);
    if (!normalized.toLowerCase().endsWith('.md')) { throw new Error('重命名目标必须是 Markdown 文件'); }
    const newTitle = fileBaseName(normalized);
    if (newTitle.endsWith('.md')) { throw new Error('无效的文件名'); }
    const title = newTitle.substring(0, newTitle.length - 3);
    await LexiStorageService.renameNote(this.context, file.noteId, title);
    const payloadFile = new LexiTFile();
    payloadFile.path = file.path;
    payloadFile.noteId = file.noteId;
    await this.refresh();
    const renamed = this.index.fileByNoteId.get(file.noteId);
    await this.emitEvent('rename', renamed || file, file.path);
    void payloadFile;
  }

  async process(file: LexiTFile, fn: (data: string) => string): Promise<string> {
    const content = await this.read(file);
    const next = fn(content);
    if (next === content) { return next; }
    await this.modify(file, next);
    return next;
  }

  async append(file: LexiTFile, data: string): Promise<void> {
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
