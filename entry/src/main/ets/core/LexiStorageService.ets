import { common } from '@kit.AbilityKit';
import { preferences, relationalStore } from '@kit.ArkData';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import {
  CanvasBoard,
  LexiBackupPackage,
  LexiProject,
  MindMapDoc,
  NoteItem,
  NoteLink,
  NoteProperty,
  NoteRevision,
  VaultItem
} from './LexiModels';
import { MarkdownEngine } from './MarkdownEngine';
import { LexiSeedData } from './LexiSeedData';
import { LexiLegacySamples } from './LexiLegacySamples';
import { LexiBackupValidation } from './LexiBackupValidation';
import { LexiFolderBinding, LexiFolderSnapshot, LexiFolderStore } from './LexiFolderStore';
import { LexiFolderPolicy } from './LexiFolderPolicy';
import { LexiFrontmatter } from './LexiFrontmatter';
import { LexiTemplates } from './LexiTemplates';
import { LexiTemplateItem, LexiTemplateLibrary, LexiTemplateLibraryState } from './LexiTemplateLibrary';
import { LexiFormService } from './LexiFormService';
import { LexiStorageLock } from './LexiStorageLock';

export class LexiCapturedNoteSaveResult {
  note: NoteItem = new NoteItem();
  duplicate: boolean = false;
  alreadySaved: boolean = false;
}

export class LexiStorageService {
  private static store: relationalStore.RdbStore | undefined;
  private static notesIndexReady: boolean = false;
  private static settings: preferences.Preferences | undefined;
  private static initPromise: Promise<void> | undefined;
  private static writeQueue: Promise<void> = Promise.resolve();
  private static mutationQueue: Promise<void> = Promise.resolve();
  private static templateQueue: Promise<void> = Promise.resolve();
  private static actionTransaction: boolean = false;
  private static appContext: common.Context | undefined;
  private static nativeSnapshotTimer: number = -1;

  static async init(context: common.Context): Promise<void> {
    LexiStorageService.appContext = context;
    if (!LexiStorageService.initPromise) {
      LexiStorageService.initPromise = LexiStorageLock.run<void>(context, async (): Promise<void> => LexiStorageService.initialize(context)).catch((error: Error) => {
        LexiStorageService.initPromise = undefined;
        throw error as Error;
      });
    }
    await LexiStorageService.initPromise;
  }

  private static async initialize(context: common.Context): Promise<void> {
    const store = await relationalStore.getRdbStore(context, {
      name: 'lexinote.db',
      securityLevel: relationalStore.SecurityLevel.S2
    });
    if (store.version === 0) {
      await store.beginTransaction();
      try {
        await store.executeSql(
          'CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
        );
        await store.executeSql(
          'CREATE TABLE IF NOT EXISTS link_index (source_id TEXT NOT NULL, target_id TEXT NOT NULL, target_title TEXT NOT NULL, anchor TEXT NOT NULL, display_text TEXT NOT NULL)'
        );
        store.version = 1;
        await store.commit();
      } catch {
        await store.rollBack();
        throw new Error('本地知识库索引初始化失败');
      }
    }
    LexiStorageService.store = store;
    LexiStorageService.notesIndexReady = store.version >= 2;
    await LexiStorageService.refreshSettings(context);
    await LexiStorageService.ensureCleanStart(context);
    if (!LexiStorageService.notesIndexReady) { await LexiStorageService.migrateNotesIndex(context); }
  }

  // Every public read-modify-write entry owns the same OS lock. Internal calls
  // target private implementations, so unrelated async calls cannot inherit ownership.
  private static async withStorageLock<T>(context: common.Context | undefined, operation: () => Promise<T>): Promise<T> {
    if (!context) { throw new Error('知识库尚未初始化'); }
    return LexiStorageLock.run<T>(context, async (): Promise<T> => {
      await LexiStorageService.refreshSettings(context);
      return operation();
    });
  }

  private static async refreshSettings(context: common.Context): Promise<void> {
    const appContext = context.getApplicationContext();
    preferences.removePreferencesFromCacheSync(appContext, 'lexinote_settings');
    LexiStorageService.settings = await preferences.getPreferences(appContext, 'lexinote_settings');
  }

  private static db(): relationalStore.RdbStore {
    if (!LexiStorageService.store) {
      throw new Error('知识库数据库尚未就绪');
    }
    return LexiStorageService.store;
  }

  // Version 2 keeps each note independently. The Markdown file remains the
  // portable source; notes_content is a rebuildable per-note read cache.
  private static async migrateNotesIndex(context: common.Context): Promise<void> {
    const legacy = await LexiStorageService.getRawValue('notes', '[]');
    const notes = JSON.parse(legacy) as NoteItem[];
    if (!Array.isArray(notes) || notes.some((note: NoteItem): boolean => !note || typeof note.id !== 'string' ||
      typeof note.content !== 'string' || typeof note.title !== 'string' || !Array.isArray(note.tags) || !Array.isArray(note.properties))) {
      throw new Error('原笔记索引格式异常，迁移已停止，旧数据保持原样');
    }
    const ids = new Set<string>();
    for (const note of notes) {
      if (!note.id || ids.has(note.id)) { throw new Error('原笔记索引包含重复标识，迁移已停止'); }
      ids.add(note.id);
    }
    const directory = `${context.filesDir}/migrations`;
    if (!fs.accessSync(directory)) { fs.mkdirSync(directory, true); }
    const archive = `${directory}/before-notes-index-v2.json`;
    if (!fs.accessSync(archive)) { LexiStorageService.writeTextAtomic(archive, legacy); }
    const db = LexiStorageService.db();
    await db.beginTransaction();
    try {
      await db.executeSql('CREATE TABLE IF NOT EXISTS notes_meta (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, project_id TEXT NOT NULL, title TEXT NOT NULL, path TEXT NOT NULL, tags_json TEXT NOT NULL, properties_json TEXT NOT NULL, snippet TEXT NOT NULL, updated_at INTEGER NOT NULL, metadata_json TEXT NOT NULL)');
      await db.executeSql('CREATE TABLE IF NOT EXISTS notes_content (id TEXT PRIMARY KEY, content TEXT NOT NULL)');
      await db.executeSql('CREATE INDEX IF NOT EXISTS notes_scope ON notes_meta(vault_id, project_id, updated_at)');
      await db.executeSql('CREATE INDEX IF NOT EXISTS links_by_source ON link_index(source_id)');
      for (const note of notes) { await LexiStorageService.upsertNoteInTransaction(note); }
      await db.executeSql('DELETE FROM kv_store WHERE key = ?', ['notes']);
      await db.commit();
      db.version = 2;
      LexiStorageService.notesIndexReady = true;
    } catch (error) { await db.rollBack(); throw error as Error; }
  }

  private static async upsertNoteInTransaction(note: NoteItem): Promise<void> {
    const metadata = JSON.parse(JSON.stringify(note)) as NoteItem; metadata.content = '';
    const db = LexiStorageService.db();
    await db.insert('notes_meta', { id: note.id, vault_id: note.vaultId, project_id: note.projectId || '',
      title: note.title, path: note.path, tags_json: JSON.stringify(note.tags), properties_json: JSON.stringify(note.properties),
      snippet: LexiFrontmatter.parse(note.content).body.replace(/\s+/g, ' ').slice(0, 180), updated_at: note.updatedAt,
      metadata_json: JSON.stringify(metadata) }, relationalStore.ConflictResolution.ON_CONFLICT_REPLACE);
    await db.insert('notes_content', { id: note.id, content: note.content }, relationalStore.ConflictResolution.ON_CONFLICT_REPLACE);
  }

  private static async replaceNotesInTransaction(notes: NoteItem[]): Promise<void> {
    const db = LexiStorageService.db();
    await db.executeSql('DELETE FROM notes_meta'); await db.executeSql('DELETE FROM notes_content');
    for (const note of notes) { await LexiStorageService.upsertNoteInTransaction(note); }
  }

  private static async writeValueInTransaction(key: string, payload: string): Promise<void> {
    if (key === 'notes' && LexiStorageService.notesIndexReady) {
      await LexiStorageService.replaceNotesInTransaction(JSON.parse(payload) as NoteItem[]);
    } else {
      await LexiStorageService.db().insert('kv_store', { key: key, value: payload, updated_at: Date.now() },
        relationalStore.ConflictResolution.ON_CONFLICT_REPLACE);
    }
  }

  private static async indexedNotes(vaultId: string = '', noteId: string = '', metadataOnly: boolean = false): Promise<NoteItem[]> {
    await LexiStorageService.writeQueue;
    let sql = metadataOnly ? 'SELECT metadata_json FROM notes_meta' :
      'SELECT notes_meta.metadata_json, notes_content.content FROM notes_meta JOIN notes_content ON notes_meta.id = notes_content.id';
    const args: string[] = [];
    if (noteId) { sql += ' WHERE notes_meta.id = ?'; args.push(noteId); }
    else if (vaultId) { sql += ' WHERE vault_id = ?'; args.push(vaultId); }
    const rows = await LexiStorageService.db().querySql(sql, args); const result: NoteItem[] = [];
    try {
      while (rows.goToNextRow()) {
        const note = JSON.parse(rows.getString(0)) as NoteItem;
        if (!metadataOnly) { note.content = rows.getString(1); }
        result.push(note);
      }
    } finally { rows.close(); }
    return result;
  }

  private static async noteMetadata(): Promise<NoteItem[]> {
    return LexiStorageService.notesIndexReady ? LexiStorageService.indexedNotes('', '', true) : LexiStorageService.getNotes();
  }

  private static async enqueueWrite(op: () => Promise<void>): Promise<void> {
    const next = LexiStorageService.writeQueue.then(op);
    LexiStorageService.writeQueue = next.catch(() => {});
    await next;
    LexiStorageService.scheduleNativeSnapshot();
  }

  private static scheduleNativeSnapshot(): void {
    if (!LexiStorageService.appContext || LexiStorageService.nativeSnapshotTimer >= 0) { return; }
    LexiStorageService.nativeSnapshotTimer = setTimeout((): void => {
      LexiStorageService.nativeSnapshotTimer = -1;
      const context = LexiStorageService.appContext;
      if (!context) { return; }
      LexiStorageService.getActiveVaultId().then(async (vaultId: string): Promise<void> => {
        const projects = await LexiStorageService.getProjects(vaultId);
        const notes = (await LexiStorageService.getNotes(vaultId)).filter((note: NoteItem): boolean => !note.projectId ||
          projects.some((project: LexiProject): boolean => project.id === note.projectId));
        await LexiFormService.sync(context, notes, vaultId);
      }).catch((): void => {});
    }, 240);
  }

  static async flushPendingWrites(): Promise<void> {
    await LexiStorageLock.flush();
    await LexiStorageService.templateQueue;
    await LexiStorageService.mutationQueue;
    await LexiStorageService.writeQueue;
  }

  private static ensureVaultDirs(context: common.Context, vaultId: string): string {
    const base = `${context.filesDir}/vaults/${vaultId}`;
    const subDirs: string[] = [base, `${base}/notes`, `${base}/maps`, `${base}/canvases`, `${base}/backups`];
    for (let i = 0; i < subDirs.length; i++) {
      if (!fs.accessSync(subDirs[i])) {
        fs.mkdirSync(subDirs[i], true);
      }
    }
    return base;
  }

  private static writeTextAtomic(filePath: string, content: string): void {
    const tmpPath = `${filePath}.tmp`;
    const file = fs.openSync(tmpPath, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(file.fd, content);
      fs.fsyncSync(file.fd);
    } finally {
      fs.closeSync(file);
    }
    // Replace only after the complete temporary file is durable.
    fs.renameSync(tmpPath, filePath);
  }

  static async getRawValue(key: string, fallback: string = ''): Promise<string> {
    if (key === 'notes' && LexiStorageService.notesIndexReady) { return JSON.stringify(await LexiStorageService.indexedNotes()); }
    await LexiStorageService.writeQueue;
    const rows = await LexiStorageService.db().querySql('SELECT value FROM kv_store WHERE key = ?', [key]);
    try {
      return rows.goToFirstRow() ? rows.getString(0) : fallback;
    } finally {
      rows.close();
    }
  }

  static async setRawValue(key: string, payload: string): Promise<void> {
    return LexiStorageService.withStorageLock<void>(LexiStorageService.appContext, async (): Promise<void> =>
      LexiStorageService.setRawValueUnlocked(key, payload));
  }

  private static async setRawValueUnlocked(key: string, payload: string): Promise<void> {
    await LexiStorageService.enqueueWrite(async (): Promise<void> => {
      const db = LexiStorageService.db(); const ownTransaction = key === 'notes' && LexiStorageService.notesIndexReady && !LexiStorageService.actionTransaction;
      if (ownTransaction) { await db.beginTransaction(); }
      try { await LexiStorageService.writeValueInTransaction(key, payload); if (ownTransaction) { await db.commit(); } }
      catch (error) { if (ownTransaction) { await db.rollBack(); } throw error as Error; }
    });
  }

  static async getSetting(key: string, fallback: string = ''): Promise<string> {
    if (!LexiStorageService.settings) {
      return fallback;
    }
    return (await LexiStorageService.settings.get(key, fallback)) as string;
  }

  static async setSetting(key: string, value: string): Promise<void> {
    return LexiStorageService.withStorageLock<void>(LexiStorageService.appContext, async (): Promise<void> =>
      LexiStorageService.setSettingUnlocked(key, value));
  }

  private static async setSettingUnlocked(key: string, value: string): Promise<void> {
    if (!LexiStorageService.settings) {
      return;
    }
    await LexiStorageService.settings.put(key, value);
    await LexiStorageService.settings.flush();
  }

  static async getVaults(includeArchived: boolean = false): Promise<VaultItem[]> {
    const raw = await LexiStorageService.getRawValue('vaults', '[]');
    try {
      const parsed = JSON.parse(raw) as VaultItem[];
      return Array.isArray(parsed) ? parsed.filter((vault: VaultItem): boolean => includeArchived || !vault.archived) : [];
    } catch {
      return [];
    }
  }

  static async getActiveVaultId(): Promise<string> {
    const current = await LexiStorageService.getSetting('activeVaultId', 'default-vault');
    const vaults = await LexiStorageService.getVaults();
    if (vaults.some((v: VaultItem): boolean => v.id === current)) {
      return current;
    }
    return vaults.length > 0 ? vaults[0].id : 'default-vault';
  }

  static async getProjects(vaultId: string = '', includeArchived: boolean = false): Promise<LexiProject[]> {
    const raw = await LexiStorageService.getRawValue('projects', '[]');
    const parsed = JSON.parse(raw) as LexiProject[];
    return Array.isArray(parsed) ? parsed.filter((project: LexiProject): boolean => (!vaultId || project.vaultId === vaultId) && (includeArchived || !project.archived)) : [];
  }

  static async getActiveProjectId(vaultId: string): Promise<string> {
    const selected = await LexiStorageService.getSetting(`activeProject:${vaultId}`, '');
    const projects = await LexiStorageService.getProjects(vaultId);
    return projects.some((project: LexiProject): boolean => project.id === selected) ? selected : '';
  }

  static async setActiveProjectId(vaultId: string, projectId: string): Promise<void> {
    return LexiStorageService.withStorageLock<void>(LexiStorageService.appContext, async (): Promise<void> =>
      LexiStorageService.setActiveProjectIdUnlocked(vaultId, projectId));
  }

  private static async setActiveProjectIdUnlocked(vaultId: string, projectId: string): Promise<void> {
    if (projectId && !(await LexiStorageService.getProjects(vaultId)).some((project: LexiProject): boolean => project.id === projectId)) {
      throw new Error('项目不存在');
    }
    await LexiStorageService.setSettingUnlocked(`activeProject:${vaultId}`, projectId);
  }

  static async reauthorizeFolder(id: string, isProject: boolean, uri: string): Promise<void> {
    return LexiStorageService.withStorageLock<void>(LexiStorageService.appContext, async (): Promise<void> =>
      LexiStorageService.reauthorizeFolderUnlocked(id, isProject, uri));
  }

  private static async reauthorizeFolderUnlocked(id: string, isProject: boolean, uri: string): Promise<void> {
    const vaults = await LexiStorageService.getVaults(true);
    const projects = await LexiStorageService.getProjects('', true);
    const project = isProject ? projects.find((item: LexiProject): boolean => item.id === id) : undefined;
    const vault = !isProject ? vaults.find((item: VaultItem): boolean => item.id === id) : undefined;
    const originalUri = project ? project.folderUri : vault ? vault.folderUri : '';
    if (!originalUri || LexiFolderStore.path(uri) !== LexiFolderStore.path(originalUri)) {
      throw new Error('请选择原来的工作区或项目文件夹');
    }
    if (project) { project.folderUri = uri; project.permissionUri = uri; }
    if (vault) {
      vault.folderUri = uri; vault.permissionUri = uri;
      for (const child of projects) {
        if (child.vaultId === vault.id && child.folderUri && LexiFolderPolicy.within(LexiFolderStore.path(uri), LexiFolderStore.path(child.folderUri))) {
          child.permissionUri = uri;
        }
      }
    }
    await LexiStorageService.setRawValueUnlocked('vaults', JSON.stringify(vaults));
    await LexiStorageService.setRawValueUnlocked('projects', JSON.stringify(projects));
  }

  private static async folderBinding(vaultId: string, projectId: string = ''): Promise<LexiFolderBinding> {
    const binding = new LexiFolderBinding();
    if (projectId) {
      const project = (await LexiStorageService.getProjects(vaultId, true)).find((item: LexiProject): boolean => item.id === projectId);
      if (!project) { throw new Error('项目已不存在，请重新选择项目'); }
      binding.folderUri = project.folderUri || '';
      binding.permissionUri = project.permissionUri || binding.folderUri;
    } else {
      const vault = (await LexiStorageService.getVaults(true)).find((item: VaultItem): boolean => item.id === vaultId);
      if (vault) {
        binding.folderUri = vault.folderUri || '';
        binding.permissionUri = vault.permissionUri || binding.folderUri;
      }
    }
    return binding;
  }

  private static async excludedFolderRoots(uri: string): Promise<string[]> {
    const root = LexiFolderStore.path(uri);
    const others: string[] = [];
    for (const vault of await LexiStorageService.getVaults(true)) {
      if (vault.folderUri) { others.push(LexiFolderStore.path(vault.folderUri)); }
    }
    for (const project of await LexiStorageService.getProjects('', true)) {
      if (project.folderUri) { others.push(LexiFolderStore.path(project.folderUri)); }
    }
    return others.filter((path: string): boolean => path !== root && LexiFolderPolicy.within(root, path));
  }

  private static async assertNewFolder(uri: string): Promise<void> {
    const path = LexiFolderStore.path(uri);
    const vaults = await LexiStorageService.getVaults(true);
    const projects = await LexiStorageService.getProjects('', true);
    if (vaults.some((vault: VaultItem): boolean => !!vault.folderUri && LexiFolderStore.path(vault.folderUri) === path) ||
      projects.some((project: LexiProject): boolean => !!project.folderUri && LexiFolderStore.path(project.folderUri) === path)) {
      throw new Error('此文件夹已经是工作区或项目，请直接切换到它');
    }
  }

  static async createFolderWorkspace(name: string, parentUri: string, createChild: boolean, permissionUri: string = ''): Promise<VaultItem> {
    return LexiStorageService.withStorageLock<VaultItem>(LexiStorageService.appContext, async (): Promise<VaultItem> =>
      LexiStorageService.createFolderWorkspaceUnlocked(name, parentUri, createChild, permissionUri));
  }

  private static async createFolderWorkspaceUnlocked(name: string, parentUri: string, createChild: boolean, permissionUri: string = ''): Promise<VaultItem> {
    const binding = await LexiFolderStore.bind(parentUri, name, createChild, permissionUri);
    await LexiStorageService.assertNewFolder(binding.folderUri);
    const vault = new VaultItem();
    vault.id = `vault-${util.generateRandomUUID(true)}`;
    vault.name = name.trim() || LexiFolderStore.folderName(binding.folderUri);
    vault.folderUri = binding.folderUri;
    vault.permissionUri = binding.permissionUri;
    vault.description = '文件夹工作区';
    vault.createdAt = Date.now();
    const operation = LexiStorageService.mutationQueue.then(async (): Promise<void> => {
      const vaults = await LexiStorageService.getVaults(true);
      vaults.push(vault);
      await LexiStorageService.importFolderScope(vault, '', binding, vaults, await LexiStorageService.getProjects('', true));
    });
    LexiStorageService.mutationQueue = operation.catch((): void => {});
    await operation;
    await LexiStorageService.setActiveVaultIdUnlocked(vault.id);
    await LexiStorageService.setActiveProjectIdUnlocked(vault.id, '');
    return vault;
  }

  static async createFolderProject(vaultId: string, name: string, parentUri: string, createChild: boolean, permissionUri: string = ''): Promise<LexiProject> {
    return LexiStorageService.withStorageLock<LexiProject>(LexiStorageService.appContext, async (): Promise<LexiProject> =>
      LexiStorageService.createFolderProjectUnlocked(vaultId, name, parentUri, createChild, permissionUri));
  }

  private static async createFolderProjectUnlocked(vaultId: string, name: string, parentUri: string, createChild: boolean, permissionUri: string = ''): Promise<LexiProject> {
    const vault = (await LexiStorageService.getVaults(true)).find((item: VaultItem): boolean => item.id === vaultId);
    if (!vault) { throw new Error('请先选择工作区'); }
    const binding = await LexiFolderStore.bind(parentUri, name, createChild, permissionUri);
    await LexiStorageService.assertNewFolder(binding.folderUri);
    const project = new LexiProject();
    project.id = `project-${util.generateRandomUUID(true)}`;
    project.vaultId = vaultId;
    project.name = name.trim() || LexiFolderStore.folderName(binding.folderUri);
    project.folderUri = binding.folderUri;
    project.permissionUri = binding.permissionUri;
    project.createdAt = Date.now();
    const operation = LexiStorageService.mutationQueue.then(async (): Promise<void> => {
      const projects = await LexiStorageService.getProjects('', true);
      projects.push(project);
      await LexiStorageService.importFolderScope(vault, project.id, binding, await LexiStorageService.getVaults(true), projects);
      await LexiStorageService.persistFolderCatalog(vaultId, '');
    });
    LexiStorageService.mutationQueue = operation.catch((): void => {});
    await operation;
    await LexiStorageService.setActiveProjectIdUnlocked(vaultId, project.id);
    return project;
  }

  private static importFolderNote(snapshot: LexiFolderSnapshot, relative: string, path: string, vaultId: string,
    projectId: string, all: NoteItem[]): NoteItem {
    const metadata = snapshot.catalog.notes.find((item: NoteItem): boolean => item.path === relative);
    const note = new NoteItem();
    note.id = metadata && typeof metadata.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(metadata.id) &&
      !all.some((item: NoteItem): boolean => item.id === metadata.id) ? metadata.id : util.generateRandomUUID(true);
    note.vaultId = vaultId;
    note.projectId = projectId;
    note.path = path;
    note.title = metadata && typeof metadata.title === 'string' ? metadata.title : relative.substring(relative.lastIndexOf('/') + 1).replace(/\.(md|markdown)$/i, '');
    note.notebook = metadata && typeof metadata.notebook === 'string' ? metadata.notebook :
      relative.includes('/') ? relative.substring(0, relative.lastIndexOf('/')) : '项目笔记';
    note.noteType = metadata && ['quick', 'study', 'markdown'].includes(metadata.noteType) ? metadata.noteType : 'markdown';
    note.editorLevel = metadata && ['simple', 'study', 'pro'].includes(metadata.editorLevel) ? metadata.editorLevel : 'pro';
    note.favorite = !!metadata && metadata.favorite === true;
    note.pinned = !!metadata && metadata.pinned === true;
    note.trashedAt = metadata && typeof metadata.trashedAt === 'number' ? metadata.trashedAt : 0;
    note.tags = metadata && Array.isArray(metadata.tags) ? metadata.tags.filter((tag: string): boolean => typeof tag === 'string') : [];
    note.properties = metadata && Array.isArray(metadata.properties) ? metadata.properties.filter((prop: NoteProperty): boolean =>
      !!prop && typeof prop.key === 'string' && typeof prop.propValue === 'string') : [];
    return note;
  }

  private static async importFolderScope(vault: VaultItem, projectId: string, binding: LexiFolderBinding,
    vaults: VaultItem[], projects: LexiProject[]): Promise<void> {
    const root = await LexiFolderStore.activate(binding);
    const snapshot = await LexiFolderStore.read(binding, await LexiStorageService.excludedFolderRoots(binding.folderUri));
    const notes = await LexiStorageService.getNotes('');
    const maps = await LexiStorageService.getMindMaps('');
    const boards = await LexiStorageService.getCanvases('');
    const present: string[] = [];
    const noteIds = new Map<string, string>();
    for (const document of snapshot.documents) {
      const path = `${root}/${document.relativePath}`;
      let note = notes.find((item: NoteItem): boolean => item.path === path && item.vaultId === vault.id);
      if (!note) {
        note = LexiStorageService.importFolderNote(snapshot, document.relativePath, path, vault.id, projectId, notes);
        note.createdAt = document.modifiedAt || Date.now();
        notes.push(note);
      }
      const source = snapshot.catalog.notes.find((item: NoteItem): boolean => item.path === document.relativePath);
      if (source && typeof source.id === 'string') { noteIds.set(source.id, note.id); }
      note.projectId = projectId;
      if (note.sourceMissing) { note.trashedAt = 0; }
      note.sourceMissing = false;
      if (note.content !== document.content) { note.updatedAt = document.modifiedAt || Date.now(); }
      LexiFrontmatter.apply(note, document.content);
      if (!note.updatedAt) { note.updatedAt = document.modifiedAt || Date.now(); }
      present.push(path);
    }
    for (const note of notes) {
      if (note.vaultId === vault.id && (note.projectId || '') === projectId && LexiFolderPolicy.within(root, note.path) && !present.includes(note.path)) {
        if (!note.trashedAt) { note.trashedAt = Date.now(); note.sourceMissing = true; }
      }
    }
    for (const source of snapshot.catalog.mindMaps) {
      LexiBackupValidation.validateMap(source);
      const existing = maps.find((doc: MindMapDoc): boolean => doc.id === source.id && doc.vaultId === vault.id && (doc.projectId || '') === projectId);
      if (existing) { continue; }
      const doc = JSON.parse(JSON.stringify(source)) as MindMapDoc;
      if (maps.some((other: MindMapDoc): boolean => other.id === doc.id)) { doc.id = `map-${util.generateRandomUUID(true)}`; }
      doc.vaultId = vault.id; doc.projectId = projectId;
      for (const node of doc.nodes) { node.noteRefId = noteIds.get(node.noteRefId) || node.noteRefId; }
      maps.push(doc);
    }
    for (const source of snapshot.catalog.canvases) {
      LexiBackupValidation.validateCanvas(source);
      const existing = boards.find((board: CanvasBoard): boolean => board.id === source.id && board.vaultId === vault.id && (board.projectId || '') === projectId);
      if (existing) { continue; }
      const board = JSON.parse(JSON.stringify(source)) as CanvasBoard;
      if (boards.some((other: CanvasBoard): boolean => other.id === board.id)) { board.id = `canvas-${util.generateRandomUUID(true)}`; }
      board.vaultId = vault.id; board.projectId = projectId;
      for (const card of board.cards) { card.noteRefId = noteIds.get(card.noteRefId) || card.noteRefId; }
      boards.push(board);
    }
    try {
      await LexiFolderStore.writeCatalog(binding, notes.filter((n: NoteItem): boolean => n.vaultId === vault.id && (n.projectId || '') === projectId),
        maps.filter((doc: MindMapDoc): boolean => doc.vaultId === vault.id && (doc.projectId || '') === projectId),
        boards.filter((board: CanvasBoard): boolean => board.vaultId === vault.id && (board.projectId || '') === projectId));
    } catch {}
    const keys: string[] = ['vaults', 'projects', 'notes', 'mindmaps', 'canvases'];
    const values: string[] = [JSON.stringify(vaults), JSON.stringify(projects), JSON.stringify(notes), JSON.stringify(maps), JSON.stringify(boards)];
    await LexiStorageService.enqueueWrite(async (): Promise<void> => {
      const db = LexiStorageService.db(); await db.beginTransaction();
      try {
        for (let i = 0; i < keys.length; i++) {
          await LexiStorageService.writeValueInTransaction(keys[i], values[i]);
        }
        await db.commit();
      } catch (error) { await db.rollBack(); throw error as Error; }
    });
    await LexiStorageService.syncLinkTable(notes);
  }

  static async refreshFolders(vaultId: string): Promise<void> {
    return LexiStorageService.withStorageLock<void>(LexiStorageService.appContext, async (): Promise<void> =>
      LexiStorageService.refreshFoldersUnlocked(vaultId));
  }

  private static async refreshFoldersUnlocked(vaultId: string): Promise<void> {
    const operation = LexiStorageService.mutationQueue.then(async (): Promise<void> => {
      const vaults = await LexiStorageService.getVaults(true);
      const vault = vaults.find((item: VaultItem): boolean => item.id === vaultId);
      if (!vault) { return; }
      const projects = await LexiStorageService.getProjects('', true);
      if (vault.folderUri) { await LexiStorageService.importFolderScope(vault, '', await LexiStorageService.folderBinding(vaultId), vaults, projects); }
      for (const project of projects.filter((item: LexiProject): boolean => !item.archived && item.vaultId === vaultId && !!item.folderUri)) {
        await LexiStorageService.importFolderScope(vault, project.id, await LexiStorageService.folderBinding(vaultId, project.id), vaults, projects);
      }
    });
    LexiStorageService.mutationQueue = operation.catch((): void => {});
    await operation;
  }

  private static async persistFolderCatalog(vaultId: string, projectId: string = ''): Promise<void> {
    const binding = await LexiStorageService.folderBinding(vaultId, projectId);
    if (!binding.folderUri) { return; }
    const notes = (await LexiStorageService.noteMetadata()).filter((note: NoteItem): boolean => note.vaultId === vaultId && (note.projectId || '') === projectId);
    const maps = (await LexiStorageService.getMindMaps(vaultId)).filter((doc: MindMapDoc): boolean => (doc.projectId || '') === projectId);
    const boards = (await LexiStorageService.getCanvases(vaultId)).filter((board: CanvasBoard): boolean => (board.projectId || '') === projectId);
    try { await LexiFolderStore.writeCatalog(binding, notes, maps, boards); } catch {}
  }

  static async setActiveVaultId(vaultId: string): Promise<void> {
    return LexiStorageService.withStorageLock<void>(LexiStorageService.appContext, async (): Promise<void> =>
      LexiStorageService.setActiveVaultIdUnlocked(vaultId));
  }

  private static async setActiveVaultIdUnlocked(vaultId: string): Promise<void> {
    await LexiStorageService.setSettingUnlocked('activeVaultId', vaultId);
  }

  static async createVault(context: common.Context, name: string, description: string): Promise<VaultItem> {
    return LexiStorageService.withStorageLock<VaultItem>(context, async (): Promise<VaultItem> =>
      LexiStorageService.createVaultUnlocked(context, name, description));
  }

  private static async createVaultUnlocked(context: common.Context, name: string, description: string): Promise<VaultItem> {
    const trimmedDesc = description.trim();
    if (trimmedDesc.startsWith('file://') || (trimmedDesc.startsWith('/') && fs.accessSync(trimmedDesc))) {
      try {
        return await LexiStorageService.createFolderWorkspaceUnlocked(name, trimmedDesc, false, trimmedDesc);
      } catch {}
    }
    const vaults = await LexiStorageService.getVaults(true);
    const vault = new VaultItem();
    vault.id = `vault-${util.generateRandomUUID(true)}`;
    vault.name = name.trim() || '新建知识库';
    vault.description = description.trim() || '独立本地知识空间';
    vault.createdAt = Date.now();
    vault.version = 1;
    vaults.push(vault);
    LexiStorageService.ensureVaultDirs(context, vault.id);
    await LexiStorageService.setRawValueUnlocked('vaults', JSON.stringify(vaults));
    await LexiStorageService.setActiveVaultIdUnlocked(vault.id);

    return vault;
  }

  private static async actionMutation<T>(work: () => Promise<T>): Promise<T> {
    const pending = LexiStorageService.mutationQueue.then(work);
    LexiStorageService.mutationQueue = pending.then((): void => {}).catch((): void => {});
    return pending;
  }

  static async syncScopeCatalog(vaultId: string, projectId: string = ''): Promise<void> {
    return LexiStorageService.withStorageLock<void>(LexiStorageService.appContext, async (): Promise<void> =>
      LexiStorageService.syncScopeCatalogUnlocked(vaultId, projectId));
  }

  private static async syncScopeCatalogUnlocked(vaultId: string, projectId: string = ''): Promise<void> {
    await LexiStorageService.actionMutation<void>(async (): Promise<void> => {
      await LexiStorageService.persistFolderCatalog(vaultId, projectId);
    });
  }

  static async getNoteHistory(noteId: string): Promise<NoteRevision[]> {
    return JSON.parse(await LexiStorageService.getRawValue(`history:${noteId}`, '[]')) as NoteRevision[];
  }

  static async restoreNoteRevision(context: common.Context, noteId: string, revisionId: string): Promise<NoteItem> {
    return LexiStorageService.withStorageLock<NoteItem>(context, async (): Promise<NoteItem> =>
      LexiStorageService.restoreNoteRevisionUnlocked(context, noteId, revisionId));
  }

  private static async restoreNoteRevisionUnlocked(context: common.Context, noteId: string, revisionId: string): Promise<NoteItem> {
    return LexiStorageService.actionMutation<NoteItem>(async (): Promise<NoteItem> => {
      const current = await LexiStorageService.getNoteById(noteId);
      const revision = (await LexiStorageService.getNoteHistory(noteId)).find((entry: NoteRevision): boolean => entry.id === revisionId);
      if (!current || !revision) { throw new Error('该版本已不存在'); }
      current.title = revision.snapshot.title; current.content = revision.snapshot.content;
      return LexiStorageService.saveNoteSnapshot(context, current);
    });
  }

  static async createInternalProject(context: common.Context, vaultId: string, name: string): Promise<LexiProject> {
    return LexiStorageService.withStorageLock<LexiProject>(context, async (): Promise<LexiProject> =>
      LexiStorageService.createInternalProjectUnlocked(context, vaultId, name));
  }

  private static async createInternalProjectUnlocked(context: common.Context, vaultId: string, name: string): Promise<LexiProject> {
    if (!name.trim() || LexiFolderPolicy.fileName(name) !== name.trim()) { throw new Error('请输入有效的文件夹名称'); }
    const vault = (await LexiStorageService.getVaults()).find((item: VaultItem): boolean => item.id === vaultId);
    if (!vault) { throw new Error('工作区不存在'); }
    if (vault.folderUri) {
      return LexiStorageService.createFolderProjectUnlocked(vaultId, name, vault.folderUri, true, vault.permissionUri);
    }
    return LexiStorageService.actionMutation<LexiProject>(async (): Promise<LexiProject> => {
      const projects = await LexiStorageService.getProjects('', true);
      if (projects.some((item: LexiProject): boolean => !item.archived && item.vaultId === vaultId && item.name === name.trim())) {
        throw new Error('已有同名文件夹');
      }
      const project = new LexiProject(); project.id = `project-${util.generateRandomUUID(true)}`;
      project.vaultId = vaultId; project.name = name.trim(); project.createdAt = Date.now();
      LexiStorageService.ensureVaultDirs(context, vaultId);
      projects.push(project); await LexiStorageService.setRawValueUnlocked('projects', JSON.stringify(projects));
      return project;
    });
  }

  static async updateScope(kind: string, id: string, name: string = '', favorite: boolean | undefined = undefined, archived: boolean | undefined = undefined, destinationVault: string = ''): Promise<void> {
    return LexiStorageService.withStorageLock<void>(LexiStorageService.appContext, async (): Promise<void> =>
      LexiStorageService.updateScopeUnlocked(kind, id, name, favorite, archived, destinationVault));
  }

  private static async updateScopeUnlocked(kind: string, id: string, name: string = '', favorite: boolean | undefined = undefined,
    archived: boolean | undefined = undefined, destinationVault: string = ''): Promise<void> {
    await LexiStorageService.actionMutation<void>(async (): Promise<void> => {
      await LexiStorageService.store?.beginTransaction();
      LexiStorageService.actionTransaction = true;
      try {
      if (kind === 'workspace') {
        const vaults = await LexiStorageService.getVaults(true);
        const vault = vaults.find((item: VaultItem): boolean => item.id === id);
        if (!vault) { throw new Error('工作区不存在'); }
        if (archived && vaults.filter((item: VaultItem): boolean => !item.archived).length < 2) {
          throw new Error('至少需要保留一个工作区，请先创建或添加另一个工作区。');
        }
        if (name.trim()) { vault.name = name.trim(); }
        if (favorite !== undefined) { vault.favorite = favorite; }
        if (archived !== undefined) { vault.archived = archived; }
        await LexiStorageService.setRawValueUnlocked('vaults', JSON.stringify(vaults));
        if (archived && await LexiStorageService.getSetting('activeVaultId', '') === id) {
          await LexiStorageService.setActiveVaultIdUnlocked(vaults.find((item: VaultItem): boolean => !item.archived)!.id);
        }
      } else {
        const projects = await LexiStorageService.getProjects('', true);
        const project = projects.find((item: LexiProject): boolean => item.id === id);
        if (!project) { throw new Error('文件夹不存在'); }
        if (name.trim()) { project.name = name.trim(); }
        if (favorite !== undefined) { project.favorite = favorite; }
        if (archived !== undefined) { project.archived = archived; }
        if (destinationVault && destinationVault !== project.vaultId) {
          if (!(await LexiStorageService.getVaults()).some((item: VaultItem): boolean => item.id === destinationVault)) { throw new Error('目标工作区不存在'); }
          const oldVault = project.vaultId;
          project.vaultId = destinationVault;
          const notes = await LexiStorageService.getNotes();
          for (const note of notes) { if (note.projectId === id) { note.vaultId = destinationVault; } }
          const maps = await LexiStorageService.getMindMaps();
          for (const map of maps) { if (map.projectId === id) { map.vaultId = destinationVault; } }
          const boards = await LexiStorageService.getCanvases();
          for (const board of boards) { if (board.projectId === id) { board.vaultId = destinationVault; } }
          await LexiStorageService.setRawValueUnlocked('notes', JSON.stringify(notes));
          await LexiStorageService.setRawValueUnlocked('mindmaps', JSON.stringify(maps));
          await LexiStorageService.setRawValueUnlocked('canvases', JSON.stringify(boards));
          await LexiStorageService.setActiveProjectIdUnlocked(oldVault, '');
        }
        await LexiStorageService.setRawValueUnlocked('projects', JSON.stringify(projects));
        await LexiStorageService.persistFolderCatalog(project.vaultId, project.id);
      }
      await LexiStorageService.store?.commit();
      LexiStorageService.actionTransaction = false;
      } catch (error) { await LexiStorageService.store?.rollBack(); LexiStorageService.actionTransaction = false; throw error as Error; }
    });
  }

  static async saveNoteIfCurrent(context: common.Context, snapshot: NoteItem, expectedTitle: string, expectedContent: string): Promise<NoteItem> {
    const captured = JSON.parse(JSON.stringify(snapshot)) as NoteItem;
    return LexiStorageService.withStorageLock<NoteItem>(context, async (): Promise<NoteItem> =>
      LexiStorageService.saveNoteIfCurrentUnlocked(context, captured, expectedTitle, expectedContent));
  }

  private static async saveNoteIfCurrentUnlocked(context: common.Context, snapshot: NoteItem, expectedTitle: string, expectedContent: string): Promise<NoteItem> {
    return LexiStorageService.actionMutation<NoteItem>(async (): Promise<NoteItem> => {
      const latest = await LexiStorageService.getNoteById(snapshot.id);
      if (!latest || latest.trashedAt > 0 || latest.title !== expectedTitle || latest.content !== expectedContent) {
        throw new Error('DOCUMENT_CHANGED_ELSEWHERE');
      }
      return LexiStorageService.saveNoteSnapshot(context, snapshot);
    });
  }

  static async duplicateNote(context: common.Context, noteId: string): Promise<NoteItem> {
    return LexiStorageService.withStorageLock<NoteItem>(context, async (): Promise<NoteItem> =>
      LexiStorageService.duplicateNoteUnlocked(context, noteId));
  }

  private static async duplicateNoteUnlocked(context: common.Context, noteId: string): Promise<NoteItem> {
    return LexiStorageService.actionMutation<NoteItem>(async (): Promise<NoteItem> => {
      const original = await LexiStorageService.getNoteById(noteId);
      if (!original || original.trashedAt > 0) { throw new Error('笔记不存在'); }
      const copy = JSON.parse(JSON.stringify(original)) as NoteItem;
      copy.id = ''; copy.path = ''; copy.createdAt = 0; copy.updatedAt = 0;
      copy.title = `${MarkdownEngine.displayTitle(original)} 副本`; copy.pinned = false;
      return LexiStorageService.saveNoteSnapshot(context, copy);
    });
  }

  private static async restorePhysicalNotes(context: common.Context, notes: NoteItem[]): Promise<void> {
    const failures: NoteItem[] = [];
    for (const note of notes) {
      if (!note.path) { continue; }
      try {
        if (fs.accessSync(note.path) && fs.readTextSync(note.path) === note.content) { continue; }
        const binding = await LexiStorageService.folderBinding(note.vaultId, note.projectId || '');
        if (binding.folderUri) { await LexiFolderStore.writeNote(binding, note); }
        else { LexiStorageService.writeTextAtomic(note.path, note.content); }
      } catch { failures.push(note); }
    }
    if (failures.length > 0) {
      const directory = `${context.filesDir}/backups`;
      if (!fs.accessSync(directory)) { fs.mkdirSync(directory, true); }
      LexiStorageService.writeTextAtomic(`${directory}/file-action-recovery-${util.generateRandomUUID(true)}.json`, JSON.stringify(failures));
      throw new Error('原文件恢复未完成，正文已保留在应用本地恢复记录中。');
    }
  }

  private static async relocateNote(context: common.Context, original: NoteItem, next: NoteItem): Promise<NoteItem> {
    const originals = await LexiStorageService.getNotes();
    const oldBinding = await LexiStorageService.folderBinding(original.vaultId, original.projectId || '');
    const newBinding = await LexiStorageService.folderBinding(next.vaultId, next.projectId || '');
    next.path = '';
    await LexiStorageService.store?.beginTransaction();
      LexiStorageService.actionTransaction = true;
    try {
      const saved = await LexiStorageService.saveNoteSnapshot(context, next);
      if (original.path && original.path !== saved.path) {
        if (oldBinding.folderUri) { await LexiFolderStore.removeNote(oldBinding, original.path); }
        else if (LexiFolderPolicy.within(context.filesDir, original.path) && fs.accessSync(original.path)) { fs.unlinkSync(original.path); }
      }
      await LexiStorageService.persistFolderCatalog(original.vaultId, original.projectId || '');
      await LexiStorageService.store?.commit();
      LexiStorageService.actionTransaction = false;
      return saved;
    } catch (error) {
      await LexiStorageService.store?.rollBack();
      LexiStorageService.actionTransaction = false;
      await LexiStorageService.restorePhysicalNotes(context, originals);
      if (next.path && next.path !== original.path) {
        if (newBinding.folderUri) { await LexiFolderStore.removeNote(newBinding, next.path); }
        else if (LexiFolderPolicy.within(context.filesDir, next.path) && fs.accessSync(next.path)) { fs.unlinkSync(next.path); }
      }
      await LexiStorageService.persistFolderCatalog(original.vaultId, original.projectId || '');
      await LexiStorageService.persistFolderCatalog(next.vaultId, next.projectId || '');
      throw error as Error;
    }
  }

  static async moveNote(context: common.Context, noteId: string, vaultId: string, projectId: string): Promise<NoteItem> {
    return LexiStorageService.withStorageLock<NoteItem>(context, async (): Promise<NoteItem> =>
      LexiStorageService.moveNoteUnlocked(context, noteId, vaultId, projectId));
  }

  private static async moveNoteUnlocked(context: common.Context, noteId: string, vaultId: string, projectId: string): Promise<NoteItem> {
    return LexiStorageService.actionMutation<NoteItem>(async (): Promise<NoteItem> => {
      const original = await LexiStorageService.getNoteById(noteId);
      if (!original || original.trashedAt > 0) { throw new Error('笔记不存在'); }
      if (!(await LexiStorageService.getVaults()).some((vault: VaultItem): boolean => vault.id === vaultId)) { throw new Error('目标工作区不存在'); }
      if (projectId && !(await LexiStorageService.getProjects(vaultId)).some((project: LexiProject): boolean => project.id === projectId)) { throw new Error('目标文件夹不存在'); }
      const next = JSON.parse(JSON.stringify(original)) as NoteItem;
      next.vaultId = vaultId; next.projectId = projectId; next.notebook = '笔记';
      return LexiStorageService.relocateNote(context, original, next);
    });
  }

  static async renameNote(context: common.Context, noteId: string, title: string): Promise<NoteItem> {
    return LexiStorageService.withStorageLock<NoteItem>(context, async (): Promise<NoteItem> =>
      LexiStorageService.renameNoteUnlocked(context, noteId, title));
  }

  private static async renameNoteUnlocked(context: common.Context, noteId: string, title: string): Promise<NoteItem> {
    if (!title.trim()) { throw new Error('名称不能为空'); }
    return LexiStorageService.actionMutation<NoteItem>(async (): Promise<NoteItem> => {
      const original = await LexiStorageService.getNoteById(noteId);
      if (!original) { throw new Error('笔记不存在'); }
      const next = JSON.parse(JSON.stringify(original)) as NoteItem; next.title = title.trim();
      const binding = await LexiStorageService.folderBinding(next.vaultId, next.projectId || '');
      return binding.folderUri ? LexiStorageService.relocateNote(context, original, next) : LexiStorageService.saveNoteSnapshot(context, next);
    });
  }

  static async mergeNotes(context: common.Context, sourceId: string, targetId: string): Promise<NoteItem> {
    return LexiStorageService.withStorageLock<NoteItem>(context, async (): Promise<NoteItem> =>
      LexiStorageService.mergeNotesUnlocked(context, sourceId, targetId));
  }

  private static async mergeNotesUnlocked(context: common.Context, sourceId: string, targetId: string): Promise<NoteItem> {
    if (sourceId === targetId) { throw new Error('不能合并到自身'); }
    return LexiStorageService.actionMutation<NoteItem>(async (): Promise<NoteItem> => {
      const originals = await LexiStorageService.getNotes();
      const source = originals.find((note: NoteItem): boolean => note.id === sourceId);
      const target = originals.find((note: NoteItem): boolean => note.id === targetId);
      if (!source || !target || source.trashedAt > 0 || target.trashedAt > 0 || source.vaultId !== target.vaultId) { throw new Error('请选择同一工作区中的有效笔记'); }
      const changed = JSON.parse(JSON.stringify(originals)) as NoteItem[];
      const merged = changed.find((note: NoteItem): boolean => note.id === targetId)!;
      merged.content += `\n\n## ${MarkdownEngine.displayTitle(source)}\n\n${source.content}`;
      const targetTitle = target.title || MarkdownEngine.displayTitle(target);
      for (const note of changed) {
        if (note.vaultId !== source.vaultId) { continue; }
        note.content = MarkdownEngine.renameLinksInMarkdown(note.content, source.title || MarkdownEngine.displayTitle(source), targetTitle);
        note.content = MarkdownEngine.renameLinksInMarkdown(note.content, source.id, target.id);
        if (note.id === sourceId) { note.trashedAt = Date.now(); }
      }
      const originalMaps = await LexiStorageService.getMindMaps(source.vaultId);
      const originalBoards = await LexiStorageService.getCanvases(source.vaultId);
      await LexiStorageService.store?.beginTransaction();
      LexiStorageService.actionTransaction = true;
      try {
        for (const note of changed) {
          const old = originals.find((item: NoteItem): boolean => item.id === note.id)!;
          if (note.content !== old.content || note.trashedAt !== old.trashedAt) { await LexiStorageService.saveNoteSnapshot(context, note); }
        }
        for (const map of await LexiStorageService.getMindMaps(source.vaultId)) {
          let changedReference = false;
          for (const node of map.nodes) {
            if (node.noteRefId === sourceId) { node.noteRefId = targetId; node.noteRefTitle = targetTitle; changedReference = true; }
          }
          if (changedReference) { await LexiStorageService.saveMindMapSnapshot(context, map); }
        }
        for (const board of await LexiStorageService.getCanvases(source.vaultId)) {
          let changedReference = false;
          for (const card of board.cards) {
            if (card.noteRefId === sourceId) { card.noteRefId = targetId; card.noteRefTitle = targetTitle; changedReference = true; }
          }
          if (changedReference) { await LexiStorageService.saveCanvasSnapshot(context, board); }
        }
        await LexiStorageService.setSettingUnlocked(`noteRedirect:${sourceId}`, targetId);
        await LexiStorageService.store?.commit();
      LexiStorageService.actionTransaction = false;
        return merged;
      } catch (error) {
        await LexiStorageService.store?.rollBack();
      LexiStorageService.actionTransaction = false;
        await LexiStorageService.restorePhysicalNotes(context, originals);
        for (const map of originalMaps) {
          const path = `${context.filesDir}/vaults/${map.vaultId}/maps/${map.id}.json`;
          LexiStorageService.writeTextAtomic(path, JSON.stringify(map, null, 2));
        }
        for (const board of originalBoards) {
          const path = `${context.filesDir}/vaults/${board.vaultId}/canvases/${board.id}.json`;
          LexiStorageService.writeTextAtomic(path, JSON.stringify(board, null, 2));
        }
        await LexiStorageService.persistFolderCatalog(source.vaultId, source.projectId || '');
        await LexiStorageService.persistFolderCatalog(target.vaultId, target.projectId || '');
        throw error as Error;
      }
    });
  }

  static async renameNotebook(context: common.Context, vaultId: string, projectId: string, notebook: string, title: string): Promise<void> {
    return LexiStorageService.withStorageLock<void>(context, async (): Promise<void> =>
      LexiStorageService.renameNotebookUnlocked(context, vaultId, projectId, notebook, title));
  }

  private static async renameNotebookUnlocked(context: common.Context, vaultId: string, projectId: string, notebook: string, title: string): Promise<void> {
    if (!title.trim()) { throw new Error('名称不能为空'); }
    await LexiStorageService.actionMutation<void>(async (): Promise<void> => {
      for (const note of await LexiStorageService.getNotes(vaultId)) {
        if ((!projectId || (note.projectId || '') === projectId) && note.notebook === notebook) {
          note.notebook = title.trim(); await LexiStorageService.saveNoteSnapshot(context, note);
        }
      }
    });
  }

  static async getNotes(vaultId: string = ''): Promise<NoteItem[]> {
    try {
      const all = LexiStorageService.notesIndexReady ? await LexiStorageService.indexedNotes(vaultId) :
        JSON.parse(await LexiStorageService.getRawValue('notes', '[]')) as NoteItem[];
      if (!Array.isArray(all)) {
        return [];
      }
      const filtered = vaultId.length > 0
        ? all.filter((n: NoteItem): boolean => n.vaultId === vaultId)
        : all;
      return filtered.sort((a: NoteItem, b: NoteItem): number => {
        if (a.pinned !== b.pinned) {
          return a.pinned ? -1 : 1;
        }
        return b.updatedAt - a.updatedAt;
      });
    } catch {
      return [];
    }
  }

  static async getNoteById(noteId: string): Promise<NoteItem | undefined> {
    if (LexiStorageService.notesIndexReady) { return (await LexiStorageService.indexedNotes('', noteId))[0]; }
    const all = await LexiStorageService.getNotes('');
    return all.find((n: NoteItem): boolean => n.id === noteId);
  }

  static async saveNote(context: common.Context, note: NoteItem): Promise<NoteItem> {
    const captured = JSON.parse(JSON.stringify(note)) as NoteItem;
    return LexiStorageService.withStorageLock<NoteItem>(context, async (): Promise<NoteItem> =>
      LexiStorageService.saveNoteUnlocked(context, captured));
  }

  private static async saveNoteUnlocked(context: common.Context, note: NoteItem): Promise<NoteItem> {
    const snapshot = JSON.parse(JSON.stringify(note)) as NoteItem;
    const operation = LexiStorageService.mutationQueue.then(async (): Promise<NoteItem> => {
      return LexiStorageService.saveNoteSnapshot(context, snapshot);
    });
    LexiStorageService.mutationQueue = operation.then((): void => {}).catch((): void => {});
    return operation;
  }

  /** Shared-content idempotency and the actual write are one cross-process operation. */
  static async saveCapturedNote(context: common.Context, incoming: NoteItem, allowDuplicate: boolean = false): Promise<LexiCapturedNoteSaveResult> {
    const captured = JSON.parse(JSON.stringify(incoming)) as NoteItem;
    return LexiStorageService.withStorageLock<LexiCapturedNoteSaveResult>(context, async (): Promise<LexiCapturedNoteSaveResult> => {
      const captureId = captured.properties.find((prop: NoteProperty): boolean => prop.key === 'capture_id')?.propValue || '';
      const fingerprint = captured.properties.find((prop: NoteProperty): boolean => prop.key === 'capture_fingerprint')?.propValue || '';
      if (!/^[A-Za-z0-9-]{8,80}$/.test(captureId) || captured.id !== `clip-${captureId}` || !fingerprint) { throw new Error('剪藏标识无效，请重新分享'); }
      const vault = (await LexiStorageService.getVaults()).find((item: VaultItem): boolean => item.id === captured.vaultId);
      const project = captured.projectId ? (await LexiStorageService.getProjects(captured.vaultId)).find((item: LexiProject): boolean =>
        item.id === captured.projectId && item.vaultId === captured.vaultId) : undefined;
      if (!vault || (captured.projectId && !project)) { throw new Error('保存位置已变化，请重新选择工作区和项目'); }
      const result = new LexiCapturedNoteSaveResult();
      const previous = await LexiStorageService.getNoteById(captured.id);
      if (previous) {
        const previousId = previous.properties.find((prop: NoteProperty): boolean => prop.key === 'capture_id')?.propValue || '';
        if (previousId !== captureId || previous.trashedAt > 0 || previous.sourceMissing) { throw new Error('此剪藏已处理或移入回收站，请重新分享'); }
        if (previous.vaultId !== captured.vaultId || (previous.projectId || '') !== (captured.projectId || '')) {
          throw new Error('这条剪藏已经保存到其他位置，请在知萤中移动笔记');
        }
        result.note = previous; result.alreadySaved = true; return result;
      }
      const body = LexiFrontmatter.parse(captured.content).body;
      const duplicate = (await LexiStorageService.getNotes(captured.vaultId)).find((note: NoteItem): boolean =>
        note.trashedAt === 0 && !note.sourceMissing && (note.projectId || '') === (captured.projectId || '') &&
        note.properties.some((prop: NoteProperty): boolean => prop.key === 'capture_fingerprint' && prop.propValue === fingerprint) &&
        LexiFrontmatter.parse(note.content).body === body);
      if (duplicate && !allowDuplicate) { result.note = duplicate; result.duplicate = true; return result; }
      result.note = await LexiStorageService.saveNoteSnapshot(context, captured);
      return result;
    });
  }

  private static async saveNoteSnapshot(context: common.Context, note: NoteItem): Promise<NoteItem> {
    let all = await LexiStorageService.noteMetadata();
    const previous = note.id ? await LexiStorageService.getNoteById(note.id) : undefined;
    const incomingHeader = LexiFrontmatter.parse(note.content);
    const previousHeader = LexiFrontmatter.parse(previous ? previous.content : '');
    if (incomingHeader.hasFrontmatter && (!previous || incomingHeader.rawHeader !== previousHeader.rawHeader)) {
      LexiFrontmatter.apply(note, note.content);
    } else if (previousHeader.hasFrontmatter && !incomingHeader.hasFrontmatter) {
      note.tags = []; note.properties = [];
    }
    if (previous && previous.title.trim() !== note.title.trim()) { all = await LexiStorageService.getNotes(); }
    if (!note.id) {
      note.id = util.generateRandomUUID(true);
    }
    if (!note.vaultId) {
      note.vaultId = await LexiStorageService.getActiveVaultId();
    }
    const now = Date.now();
    if (!note.createdAt) {
      note.createdAt = now;
    }
    note.updatedAt = now;

    // Extract #tags from markdown body and merge with explicit tags
    const inlineTags = MarkdownEngine.extractInlineTags(LexiFrontmatter.parse(note.content).body);
    const mergedTags: string[] = [];
    for (let i = 0; i < note.tags.length; i++) {
      const t = note.tags[i].trim();
      if (t.length > 0 && !mergedTags.includes(t)) {
        mergedTags.push(t);
      }
    }
    for (let i = 0; i < inlineTags.length; i++) {
      const t = inlineTags[i].trim();
      if (t.length > 0 && !mergedTags.includes(t)) {
        mergedTags.push(t);
      }
    }
    note.tags = mergedTags;

    const existingIdx = all.findIndex((item: NoteItem): boolean => item.id === note.id);
    const oldTitle = existingIdx >= 0 ? all[existingIdx].title.trim() : '';
    const newTitle = note.title.trim();
    const changedNotes: NoteItem[] = [note];

    // Write Markdown body to physical file (File as source of truth)
    const binding = await LexiStorageService.folderBinding(note.vaultId, note.projectId || '');
    note.content = LexiFrontmatter.serialize(note);
    if (binding.folderUri) {
      note.path = await LexiFolderStore.writeNote(binding, note);
    } else {
      const vaultBase = LexiStorageService.ensureVaultDirs(context, note.vaultId);
      note.path = `${vaultBase}/notes/${note.id}.md`;
      LexiStorageService.writeTextAtomic(note.path, note.content);
    }
    note.sourceMissing = false;

    if (existingIdx >= 0) {
      all[existingIdx] = note;
    } else {
      all.unshift(note);
    }

    // Repair [[OldTitle]] links if the note was renamed (04 关联: 重命名链接修复)
    if (oldTitle.length > 0 && newTitle.length > 0 && oldTitle !== newTitle) {
      for (let i = 0; i < all.length; i++) {
        if (all[i].id !== note.id && all[i].vaultId === note.vaultId) {
          const updatedContent = MarkdownEngine.renameLinksInMarkdown(all[i].content, oldTitle, newTitle);
          if (updatedContent !== all[i].content) {
            all[i].content = updatedContent;
            changedNotes.push(all[i]);
            if (all[i].path.length > 0) {
              try {
                const otherBinding = await LexiStorageService.folderBinding(all[i].vaultId, all[i].projectId || '');
                if (otherBinding.folderUri) { all[i].path = await LexiFolderStore.writeNote(otherBinding, all[i]); }
                else { LexiStorageService.writeTextAtomic(all[i].path, updatedContent); }
              } catch {}
            }
          }
        }
      }
      // Also update mindMap node noteRefTitle and canvas card noteRefTitle
      const maps = await LexiStorageService.getMindMaps('');
      let mapChanged = false;
      for (let i = 0; i < maps.length; i++) {
        for (let j = 0; j < maps[i].nodes.length; j++) {
          if (maps[i].nodes[j].noteRefId === note.id) {
            maps[i].nodes[j].noteRefTitle = newTitle;
            mapChanged = true;
          }
        }
      }
      if (mapChanged) {
        await LexiStorageService.setRawValueUnlocked('mindmaps', JSON.stringify(maps));
      }
    }

    if (LexiStorageService.notesIndexReady) {
      await LexiStorageService.enqueueWrite(async (): Promise<void> => {
        const db = LexiStorageService.db(); const ownTransaction = !LexiStorageService.actionTransaction;
        if (ownTransaction) { await db.beginTransaction(); }
        try {
          for (const changed of changedNotes) { await LexiStorageService.upsertNoteInTransaction(changed); }
          if (ownTransaction) { await db.commit(); }
        } catch (error) { if (ownTransaction) { await db.rollBack(); } throw error as Error; }
      });
    } else { await LexiStorageService.setRawValueUnlocked('notes', JSON.stringify(all)); }
    if (!previous || oldTitle !== newTitle || previous.vaultId !== note.vaultId || previous.trashedAt !== note.trashedAt) {
      await LexiStorageService.syncLinkTable(await LexiStorageService.getNotes());
    } else { await LexiStorageService.syncNoteLinks(note, all); }
    await LexiStorageService.setSettingUnlocked('lastEditedNoteId', note.id);
    await LexiStorageService.persistFolderCatalog(note.vaultId, note.projectId || '');
    if (oldTitle && newTitle && oldTitle !== newTitle) {
      await LexiStorageService.persistFolderCatalog(note.vaultId, '');
      for (const project of await LexiStorageService.getProjects(note.vaultId)) {
        await LexiStorageService.persistFolderCatalog(note.vaultId, project.id);
      }
    }
    if (previous && (previous.title !== note.title || previous.content !== note.content)) {
      const versions = await LexiStorageService.getNoteHistory(note.id);
      const version = new NoteRevision(); version.id = util.generateRandomUUID(true);
      version.savedAt = previous.updatedAt; version.snapshot = previous;
      await LexiStorageService.setRawValueUnlocked(`history:${note.id}`, JSON.stringify([version].concat(versions).slice(0, 20)));
    }
    return note;
  }

  private static async templateMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = LexiStorageService.templateQueue.then(operation);
    LexiStorageService.templateQueue = next.then((): void => {}, (): void => {});
    return next;
  }

  private static async templateLibraryState(): Promise<LexiTemplateLibraryState> {
    const raw = await LexiStorageService.getRawValue('templateLibrary:v1', '');
    const state = raw ? LexiTemplateLibrary.decode(raw) : LexiTemplateLibrary.fresh();
    if (!state.legacyImported) {
      // Copy old template notes once. Source documents and linked folders remain intact.
      const legacy = (await LexiStorageService.getNotes()).filter((note: NoteItem): boolean => note.trashedAt === 0 &&
        (note.notebook === 'Templates' || note.notebook.startsWith('Templates/') || note.notebook === '模板' || note.tags.includes('模板')));
      for (const note of legacy) {
        if (state.templates.some((item: LexiTemplateItem): boolean => item.sourceNoteId === note.id)) { continue; }
        const item = new LexiTemplateItem(); item.id = `template-${util.generateRandomUUID(true)}`;
        item.title = note.title || '导入模板'; item.category = '导入模板'; item.content = note.content;
        item.tags = note.tags.slice(); item.properties = note.properties.map((prop: NoteProperty): NoteProperty => new NoteProperty(prop.key, prop.propValue));
        item.sourceNoteId = note.id; item.createdAt = note.createdAt; item.updatedAt = note.updatedAt;
        state.templates.push(item);
      }
      const oldDefault = await LexiStorageService.getSetting(`dailyTemplate:${await LexiStorageService.getActiveVaultId()}`, '');
      const importedDefault = state.templates.find((item: LexiTemplateItem): boolean => !!oldDefault && item.sourceNoteId === oldDefault);
      if (importedDefault) { state.defaultDailyId = importedDefault.id; }
      state.legacyImported = true;
      LexiTemplateLibrary.decode(JSON.stringify(state));
      await LexiStorageService.setRawValueUnlocked('templateLibrary:v1', JSON.stringify(state));
    }
    return state;
  }

  static async getTemplates(): Promise<LexiTemplateItem[]> {
    return LexiStorageService.withStorageLock<LexiTemplateItem[]>(LexiStorageService.appContext, async (): Promise<LexiTemplateItem[]> =>
      LexiStorageService.getTemplatesUnlocked());
  }

  private static async getTemplatesUnlocked(): Promise<LexiTemplateItem[]> {
    return LexiStorageService.templateMutation<LexiTemplateItem[]>(async (): Promise<LexiTemplateItem[]> =>
      (await LexiStorageService.templateLibraryState()).templates.map((item: LexiTemplateItem): LexiTemplateItem => LexiTemplateLibrary.clone(item)));
  }

  static async saveTemplate(template: LexiTemplateItem): Promise<LexiTemplateItem> {
    const captured = JSON.parse(JSON.stringify(template)) as LexiTemplateItem;
    return LexiStorageService.withStorageLock<LexiTemplateItem>(LexiStorageService.appContext, async (): Promise<LexiTemplateItem> =>
      LexiStorageService.saveTemplateUnlocked(captured));
  }

  private static async saveTemplateUnlocked(template: LexiTemplateItem): Promise<LexiTemplateItem> {
    return LexiStorageService.templateMutation<LexiTemplateItem>(async (): Promise<LexiTemplateItem> => {
      const state = await LexiStorageService.templateLibraryState();
      const previous = state.templates.find((item: LexiTemplateItem): boolean => template.id ? item.id === template.id :
        !!template.sourceNoteId && item.sourceNoteId === template.sourceNoteId);
      if (template.id && !previous) { throw new Error('模板已被删除，请重新打开模板库'); }
      const item = LexiTemplateLibrary.clone(template);
      item.title = item.title.trim(); item.category = item.category.trim() || '我的模板';
      if (!item.title) { throw new Error('请输入模板名称'); }
      const metadata = LexiFrontmatter.parse(item.content);
      const previousMetadata = LexiFrontmatter.parse(previous ? previous.content : '');
      if (metadata.hasFrontmatter && (!previous || metadata.rawHeader !== previousMetadata.rawHeader)) {
        item.tags = metadata.tags; item.properties = metadata.properties;
      } else if (previousMetadata.hasFrontmatter && !metadata.hasFrontmatter) { item.tags = []; item.properties = []; }
      const document = new NoteItem(); document.content = item.content; document.tags = item.tags; document.properties = item.properties;
      item.content = LexiFrontmatter.serialize(document);
      item.id = previous ? previous.id : `template-${util.generateRandomUUID(true)}`;
      item.builtIn = previous ? previous.builtIn : false;
      item.sourceNoteId = previous ? previous.sourceNoteId : item.sourceNoteId;
      item.createdAt = previous ? previous.createdAt : Date.now(); item.updatedAt = Date.now();
      state.templates = previous ? state.templates.map((existing: LexiTemplateItem): LexiTemplateItem => existing.id === item.id ? item : existing) : state.templates.concat([item]);
      LexiTemplateLibrary.decode(JSON.stringify(state));
      await LexiStorageService.setRawValueUnlocked('templateLibrary:v1', JSON.stringify(state));
      return LexiTemplateLibrary.clone(item);
    });
  }

  static async saveNoteAsTemplate(noteId: string): Promise<LexiTemplateItem> {
    return LexiStorageService.withStorageLock<LexiTemplateItem>(LexiStorageService.appContext, async (): Promise<LexiTemplateItem> =>
      LexiStorageService.saveNoteAsTemplateUnlocked(noteId));
  }

  private static async saveNoteAsTemplateUnlocked(noteId: string): Promise<LexiTemplateItem> {
    const source = await LexiStorageService.getNoteById(noteId);
    if (!source || source.trashedAt > 0) { throw new Error('笔记已不存在'); }
    const item = new LexiTemplateItem(); item.title = source.title || '未命名模板'; item.category = '我的模板';
    item.content = source.content; item.sourceNoteId = source.id; item.tags = source.tags.slice();
    item.properties = source.properties.map((prop: NoteProperty): NoteProperty => new NoteProperty(prop.key, prop.propValue));
    return LexiStorageService.saveTemplateUnlocked(item);
  }

  static async deleteTemplate(templateId: string): Promise<void> {
    return LexiStorageService.withStorageLock<void>(LexiStorageService.appContext, async (): Promise<void> =>
      LexiStorageService.deleteTemplateUnlocked(templateId));
  }

  private static async deleteTemplateUnlocked(templateId: string): Promise<void> {
    await LexiStorageService.templateMutation<void>(async (): Promise<void> => {
      const state = await LexiStorageService.templateLibraryState();
      state.templates = state.templates.filter((item: LexiTemplateItem): boolean => item.id !== templateId);
      if (state.defaultDailyId === templateId) { state.defaultDailyId = ''; }
      await LexiStorageService.setRawValueUnlocked('templateLibrary:v1', JSON.stringify(state));
    });
  }

  static async getDailyTemplate(): Promise<string> {
    return LexiStorageService.withStorageLock<string>(LexiStorageService.appContext, async (): Promise<string> =>
      LexiStorageService.getDailyTemplateUnlocked());
  }

  private static async getDailyTemplateUnlocked(): Promise<string> {
    return LexiStorageService.templateMutation<string>(async (): Promise<string> => (await LexiStorageService.templateLibraryState()).defaultDailyId);
  }

  static async setDailyTemplate(templateId: string): Promise<void> {
    return LexiStorageService.withStorageLock<void>(LexiStorageService.appContext, async (): Promise<void> =>
      LexiStorageService.setDailyTemplateUnlocked(templateId));
  }

  private static async setDailyTemplateUnlocked(templateId: string): Promise<void> {
    await LexiStorageService.templateMutation<void>(async (): Promise<void> => {
      const state = await LexiStorageService.templateLibraryState();
      if (templateId && !state.templates.some((item: LexiTemplateItem): boolean => item.id === templateId)) { throw new Error('请选择模板库中的模板'); }
      state.defaultDailyId = templateId;
      await LexiStorageService.setRawValueUnlocked('templateLibrary:v1', JSON.stringify(state));
    });
  }

  static async createNoteFromTemplate(context: common.Context, templateId: string, title: string, vaultId: string = '', projectId: string = ''): Promise<NoteItem> {
    return LexiStorageService.withStorageLock<NoteItem>(context, async (): Promise<NoteItem> =>
      LexiStorageService.createNoteFromTemplateUnlocked(context, templateId, title, vaultId, projectId));
  }

  private static async createNoteFromTemplateUnlocked(context: common.Context, templateId: string, title: string,
    vaultId: string = '', projectId: string = ''): Promise<NoteItem> {
    const template = (await LexiStorageService.getTemplatesUnlocked()).find((item: LexiTemplateItem): boolean => item.id === templateId);
    if (!template) { throw new Error('模板已不存在'); }
    const note = new NoteItem(); note.vaultId = vaultId || await LexiStorageService.getActiveVaultId(); note.projectId = projectId;
    note.title = title.trim() || template.title || '未命名笔记'; note.noteType = 'markdown'; note.editorLevel = 'pro';
    const rendered = LexiTemplates.render(template.content, note.title);
    const parsed = LexiFrontmatter.parse(rendered);
    note.content = rendered;
    note.tags = (parsed.hasFrontmatter ? parsed.tags : template.tags).filter((tag: string): boolean => tag !== '模板');
    note.properties = parsed.hasFrontmatter ? parsed.properties : template.properties.map((prop: NoteProperty): NoteProperty =>
      new NoteProperty(prop.key, LexiTemplates.render(prop.propValue, note.title)));
    note.content = LexiFrontmatter.serialize(note);
    return LexiStorageService.saveNoteUnlocked(context, note);
  }

  static async openOrCreateDailyNote(context: common.Context, vaultId: string, projectId: string = ''): Promise<NoteItem> {
    return LexiStorageService.withStorageLock<NoteItem>(context, async (): Promise<NoteItem> =>
      LexiStorageService.openOrCreateDailyNoteUnlocked(context, vaultId, projectId));
  }

  private static async openOrCreateDailyNoteUnlocked(context: common.Context, vaultId: string, projectId: string = ''): Promise<NoteItem> {
    return LexiStorageService.actionMutation<NoteItem>(async (): Promise<NoteItem> => {
      const today = LexiTemplates.dateKey();
      const existing = (await LexiStorageService.getNotes(vaultId)).find((note: NoteItem): boolean => note.trashedAt === 0 &&
        (note.projectId || '') === projectId && note.notebook === '日常记录 / 日记' && note.title === today);
      if (existing) { return existing; }
      const templateId = await LexiStorageService.getDailyTemplateUnlocked();
      const template = (await LexiStorageService.getTemplatesUnlocked()).find((item: LexiTemplateItem): boolean => item.id === templateId);
      const note = new NoteItem(); note.vaultId = vaultId; note.projectId = projectId; note.title = today;
      note.notebook = '日常记录 / 日记'; note.noteType = 'markdown'; note.editorLevel = 'pro';
      note.content = LexiTemplates.render(template ? template.content :
        '# {{date}} {{weekday}}\n\n## 今日待办\n\n- [ ] \n\n## 随手记录\n\n', today);
      if (template) {
        const parsed = LexiFrontmatter.parse(note.content);
        note.tags = (parsed.hasFrontmatter ? parsed.tags : template.tags).filter((tag: string): boolean => tag !== '模板');
        note.properties = parsed.hasFrontmatter ? parsed.properties : template.properties.map((prop: NoteProperty): NoteProperty =>
          new NoteProperty(prop.key, LexiTemplates.render(prop.propValue, note.title)));
        note.content = LexiFrontmatter.serialize(note);
      }
      return LexiStorageService.saveNoteSnapshot(context, note);
    });
  }

  static async toggleNotePin(context: common.Context, noteId: string): Promise<void> {
    return LexiStorageService.withStorageLock<void>(context, async (): Promise<void> =>
      LexiStorageService.toggleNotePinUnlocked(context, noteId));
  }

  private static async toggleNotePinUnlocked(context: common.Context, noteId: string): Promise<void> {
    const note = await LexiStorageService.getNoteById(noteId);
    if (!note) {
      return;
    }
    note.pinned = !note.pinned;
    await LexiStorageService.saveNoteUnlocked(context, note);
  }

  static async toggleNoteFavorite(context: common.Context, noteId: string): Promise<void> {
    return LexiStorageService.withStorageLock<void>(context, async (): Promise<void> =>
      LexiStorageService.toggleNoteFavoriteUnlocked(context, noteId));
  }

  private static async toggleNoteFavoriteUnlocked(context: common.Context, noteId: string): Promise<void> {
    const note = await LexiStorageService.getNoteById(noteId);
    if (!note) {
      return;
    }
    note.favorite = !note.favorite;
    await LexiStorageService.saveNoteUnlocked(context, note);
  }

  static async setNoteTrash(context: common.Context, noteId: string, trashed: boolean): Promise<void> {
    return LexiStorageService.withStorageLock<void>(context, async (): Promise<void> =>
      LexiStorageService.setNoteTrashUnlocked(context, noteId, trashed));
  }

  private static async setNoteTrashUnlocked(context: common.Context, noteId: string, trashed: boolean): Promise<void> {
    const note = await LexiStorageService.getNoteById(noteId);
    if (!note) {
      return;
    }
    note.trashedAt = trashed ? Date.now() : 0;
    if (trashed) {
      note.pinned = false;
    }
    await LexiStorageService.saveNoteUnlocked(context, note);
  }

  static async deleteNotePermanently(noteId: string): Promise<void> {
    return LexiStorageService.withStorageLock<void>(LexiStorageService.appContext, async (): Promise<void> =>
      LexiStorageService.deleteNotePermanentlyUnlocked(noteId));
  }

  private static async deleteNotePermanentlyUnlocked(noteId: string): Promise<void> {
    const operation = LexiStorageService.mutationQueue.then(async (): Promise<void> => {
      await LexiStorageService.deleteNoteFileAndIndex(noteId);
    });
    LexiStorageService.mutationQueue = operation.catch((): void => {});
    await operation;
  }

  private static async deleteNoteFileAndIndex(noteId: string): Promise<void> {
    const all = await LexiStorageService.getNotes('');
    const target = all.find((n: NoteItem): boolean => n.id === noteId);
    if (target && target.path.length > 0) {
      const binding = await LexiStorageService.folderBinding(target.vaultId, target.projectId || '');
      if (binding.folderUri) { await LexiFolderStore.removeNote(binding, target.path); }
      else if (fs.accessSync(target.path)) { fs.unlinkSync(target.path); }
    }
    const next = all.filter((n: NoteItem): boolean => n.id !== noteId);
    await LexiStorageService.setRawValueUnlocked('notes', JSON.stringify(next));
    await LexiStorageService.setRawValueUnlocked(`history:${noteId}`, '[]');
    await LexiStorageService.setSettingUnlocked(`noteRedirect:${noteId}`, '');
    await LexiStorageService.syncLinkTable(next);
    if (target) { await LexiStorageService.persistFolderCatalog(target.vaultId, target.projectId || ''); }
  }

  static async getMindMaps(vaultId: string = ''): Promise<MindMapDoc[]> {
    const raw = await LexiStorageService.getRawValue('mindmaps', '[]');
    try {
      const all = JSON.parse(raw) as MindMapDoc[];
      if (!Array.isArray(all)) {
        return [];
      }
      const filtered = vaultId.length > 0
        ? all.filter((m: MindMapDoc): boolean => m.vaultId === vaultId)
        : all;
      return filtered.sort((a: MindMapDoc, b: MindMapDoc): number => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  static async getMindMapById(mapId: string): Promise<MindMapDoc | undefined> {
    const all = await LexiStorageService.getMindMaps('');
    return all.find((m: MindMapDoc): boolean => m.id === mapId);
  }

  static async saveMindMap(context: common.Context, doc: MindMapDoc): Promise<MindMapDoc> {
    const captured = JSON.parse(JSON.stringify(doc)) as MindMapDoc;
    return LexiStorageService.withStorageLock<MindMapDoc>(context, async (): Promise<MindMapDoc> =>
      LexiStorageService.saveMindMapUnlocked(context, captured));
  }

  private static async saveMindMapUnlocked(context: common.Context, doc: MindMapDoc): Promise<MindMapDoc> {
    const snapshot = JSON.parse(JSON.stringify(doc)) as MindMapDoc;
    const operation = LexiStorageService.mutationQueue.then(async (): Promise<MindMapDoc> => {
      return LexiStorageService.saveMindMapSnapshot(context, snapshot);
    });
    LexiStorageService.mutationQueue = operation.then((): void => {}).catch((): void => {});
    return operation;
  }

  private static async saveMindMapSnapshot(context: common.Context, doc: MindMapDoc): Promise<MindMapDoc> {
    const all = await LexiStorageService.getMindMaps('');
    if (!doc.id) {
      doc.id = `map-${Date.now()}`;
    }
    if (!doc.vaultId) {
      doc.vaultId = await LexiStorageService.getActiveVaultId();
    }
    const now = Date.now();
    if (!doc.createdAt) {
      doc.createdAt = now;
    }
    doc.updatedAt = now;

    const vaultBase = LexiStorageService.ensureVaultDirs(context, doc.vaultId);
    const mapPath = `${vaultBase}/maps/${doc.id}.json`;
    LexiStorageService.writeTextAtomic(mapPath, JSON.stringify(doc, null, 2));

    const idx = all.findIndex((m: MindMapDoc): boolean => m.id === doc.id);
    if (idx >= 0) {
      all[idx] = doc;
    } else {
      all.unshift(doc);
    }
    await LexiStorageService.setRawValueUnlocked('mindmaps', JSON.stringify(all));
    await LexiStorageService.setSettingUnlocked('lastEditedMapId', doc.id);
    await LexiStorageService.persistFolderCatalog(doc.vaultId, doc.projectId || '');
    return doc;
  }

  static async deleteMindMap(mapId: string): Promise<void> {
    return LexiStorageService.withStorageLock<void>(LexiStorageService.appContext, async (): Promise<void> =>
      LexiStorageService.deleteMindMapUnlocked(mapId));
  }

  private static async deleteMindMapUnlocked(mapId: string): Promise<void> {
    const all = await LexiStorageService.getMindMaps('');
    const target = all.find((m: MindMapDoc): boolean => m.id === mapId);
    const next = all.filter((m: MindMapDoc): boolean => m.id !== mapId);
    await LexiStorageService.setRawValueUnlocked('mindmaps', JSON.stringify(next));
    if (target) { await LexiStorageService.persistFolderCatalog(target.vaultId, target.projectId || ''); }
  }

  static async getCanvases(vaultId: string = ''): Promise<CanvasBoard[]> {
    const raw = await LexiStorageService.getRawValue('canvases', '[]');
    try {
      const all = JSON.parse(raw) as CanvasBoard[];
      if (!Array.isArray(all)) {
        return [];
      }
      const filtered = vaultId.length > 0
        ? all.filter((c: CanvasBoard): boolean => c.vaultId === vaultId)
        : all;
      return filtered.sort((a: CanvasBoard, b: CanvasBoard): number => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  static async getCanvasById(canvasId: string): Promise<CanvasBoard | undefined> {
    const all = await LexiStorageService.getCanvases('');
    return all.find((c: CanvasBoard): boolean => c.id === canvasId);
  }

  static async saveCanvas(context: common.Context, board: CanvasBoard): Promise<CanvasBoard> {
    const captured = JSON.parse(JSON.stringify(board)) as CanvasBoard;
    return LexiStorageService.withStorageLock<CanvasBoard>(context, async (): Promise<CanvasBoard> =>
      LexiStorageService.saveCanvasUnlocked(context, captured));
  }

  private static async saveCanvasUnlocked(context: common.Context, board: CanvasBoard): Promise<CanvasBoard> {
    const snapshot = JSON.parse(JSON.stringify(board)) as CanvasBoard;
    const operation = LexiStorageService.mutationQueue.then(async (): Promise<CanvasBoard> => {
      return LexiStorageService.saveCanvasSnapshot(context, snapshot);
    });
    LexiStorageService.mutationQueue = operation.then((): void => {}).catch((): void => {});
    return operation;
  }

  private static async saveCanvasSnapshot(context: common.Context, board: CanvasBoard): Promise<CanvasBoard> {
    const all = await LexiStorageService.getCanvases('');
    if (!board.id) {
      board.id = `canvas-${Date.now()}`;
    }
    if (!board.vaultId) {
      board.vaultId = await LexiStorageService.getActiveVaultId();
    }
    const now = Date.now();
    if (!board.createdAt) {
      board.createdAt = now;
    }
    board.updatedAt = now;

    const vaultBase = LexiStorageService.ensureVaultDirs(context, board.vaultId);
    const canvasPath = `${vaultBase}/canvases/${board.id}.json`;
    LexiStorageService.writeTextAtomic(canvasPath, JSON.stringify(board, null, 2));

    const idx = all.findIndex((c: CanvasBoard): boolean => c.id === board.id);
    if (idx >= 0) {
      all[idx] = board;
    } else {
      all.unshift(board);
    }
    await LexiStorageService.setRawValueUnlocked('canvases', JSON.stringify(all));
    await LexiStorageService.persistFolderCatalog(board.vaultId, board.projectId || '');
    return board;
  }

  static async deleteCanvas(canvasId: string): Promise<void> {
    return LexiStorageService.withStorageLock<void>(LexiStorageService.appContext, async (): Promise<void> =>
      LexiStorageService.deleteCanvasUnlocked(canvasId));
  }

  private static async deleteCanvasUnlocked(canvasId: string): Promise<void> {
    const all = await LexiStorageService.getCanvases('');
    const target = all.find((c: CanvasBoard): boolean => c.id === canvasId);
    const next = all.filter((c: CanvasBoard): boolean => c.id !== canvasId);
    await LexiStorageService.setRawValueUnlocked('canvases', JSON.stringify(next));
    if (target) { await LexiStorageService.persistFolderCatalog(target.vaultId, target.projectId || ''); }
  }

  private static async syncNoteLinks(note: NoteItem, candidates: NoteItem[]): Promise<void> {
    const sources = candidates.filter((item: NoteItem): boolean => item.id !== note.id).map((item: NoteItem): NoteItem => {
      const metadata = JSON.parse(JSON.stringify(item)) as NoteItem; metadata.content = ''; return metadata;
    });
    sources.unshift(note);
    const links = MarkdownEngine.buildNoteLinks(sources).filter((link: NoteLink): boolean => link.sourceId === note.id);
    await LexiStorageService.enqueueWrite(async (): Promise<void> => {
      const db = LexiStorageService.db();
      const ownTransaction = !LexiStorageService.actionTransaction;
      if (ownTransaction) { await db.beginTransaction(); }
      try {
        await db.executeSql('DELETE FROM link_index WHERE source_id = ?', [note.id]);
        for (const link of links) {
          await db.insert('link_index', { source_id: link.sourceId, target_id: link.targetId,
            target_title: link.targetTitle, anchor: link.anchor, display_text: link.displayText });
        }
        if (ownTransaction) { await db.commit(); }
      } catch (error) { if (ownTransaction) { await db.rollBack(); } throw error as Error; }
    });
  }

  private static async syncLinkTable(allNotes: NoteItem[]): Promise<void> {
    const links = MarkdownEngine.buildNoteLinks(allNotes);
    await LexiStorageService.enqueueWrite(async () => {
      const db = LexiStorageService.db();
      const ownTransaction = !LexiStorageService.actionTransaction;
      if (ownTransaction) { await db.beginTransaction(); }
      try {
        await db.executeSql('DELETE FROM link_index');
        for (let i = 0; i < links.length; i++) {
          const link = links[i];
          await db.insert('link_index', {
            source_id: link.sourceId,
            target_id: link.targetId,
            target_title: link.targetTitle,
            anchor: link.anchor,
            display_text: link.displayText
          });
        }
        if (ownTransaction) { await db.commit(); }
      } catch {
        if (ownTransaction) { await db.rollBack(); }
        throw new Error('链接索引更新失败');
      }
    });
  }

  static async rebuildIndex(context: common.Context): Promise<number> {
    return LexiStorageService.withStorageLock<number>(context, async (): Promise<number> =>
      LexiStorageService.rebuildIndexUnlocked(context));
  }

  private static async rebuildIndexUnlocked(context: common.Context): Promise<number> {
    const projects = await LexiStorageService.getProjects();
    for (const vault of await LexiStorageService.getVaults()) {
      if (vault.folderUri || projects.some((project: LexiProject): boolean => project.vaultId === vault.id && !!project.folderUri)) {
        await LexiStorageService.refreshFoldersUnlocked(vault.id);
      }
    }
    const notes = await LexiStorageService.getNotes('');
    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      const binding = await LexiStorageService.folderBinding(note.vaultId, note.projectId || '');
      if (binding.folderUri) { continue; }
      if (note.path.length > 0 && fs.accessSync(note.path)) {
        try {
          const fileContent = fs.readTextSync(note.path);
          LexiFrontmatter.apply(note, fileContent);
        } catch {}
      } else {
        const vaultBase = LexiStorageService.ensureVaultDirs(context, note.vaultId);
        note.path = `${vaultBase}/notes/${note.id}.md`;
        try {
          LexiStorageService.writeTextAtomic(note.path, note.content);
        } catch {}
      }
      const inlineTags = MarkdownEngine.extractInlineTags(LexiFrontmatter.parse(note.content).body);
      for (let j = 0; j < inlineTags.length; j++) {
        if (!note.tags.includes(inlineTags[j])) {
          note.tags.push(inlineTags[j]);
        }
      }
    }
    await LexiStorageService.setRawValueUnlocked('notes', JSON.stringify(notes));
    await LexiStorageService.syncLinkTable(notes);
    return notes.length;
  }

  private static async captureBackupUnlocked(): Promise<LexiBackupPackage> {
    const pkg = new LexiBackupPackage();
    pkg.exportedAt = Date.now();
    pkg.vaults = await LexiStorageService.getVaults(true);
    pkg.projects = await LexiStorageService.getProjects('', true);
    pkg.notes = await LexiStorageService.getNotes('');
    pkg.mindMaps = await LexiStorageService.getMindMaps('');
    pkg.canvases = await LexiStorageService.getCanvases('');
    pkg.templateLibrary = await LexiStorageService.templateMutation<string>(async (): Promise<string> => JSON.stringify(await LexiStorageService.templateLibraryState()));
    return pkg;
  }

  static async exportFullBackup(context: common.Context): Promise<string> {
    const pkg = await LexiStorageService.withStorageLock<LexiBackupPackage>(context, async (): Promise<LexiBackupPackage> =>
      LexiStorageService.captureBackupUnlocked());
    const json = JSON.stringify(pkg, null, 2);
    const fileName = `知萤_完整知识库备份_${new Date().toISOString().slice(0, 10)}.json`;
    return LexiStorageService.saveViaDocumentPicker(context, fileName, json);
  }

  static async exportMarkdownBundle(context: common.Context, vaultId: string): Promise<string> {
    const notes = (await LexiStorageService.getNotes(vaultId)).filter((n: NoteItem): boolean => n.trashedAt === 0);
    const sections: string[] = [];
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const tagStr = n.tags.map((t: string): string => `#${t}`).join(' ');
      sections.push(
        `---\ntitle: ${MarkdownEngine.displayTitle(n)}\nid: ${n.id}\nnotebook: ${n.notebook}\ntype: ${n.noteType}\ntags: ${tagStr}\n---\n\n${n.content}`
      );
    }
    const merged = sections.join('\n\n\n');
    const fileName = `知萤_知识库导出_${new Date().toISOString().slice(0, 10)}.md`;
    return LexiStorageService.saveViaDocumentPicker(context, fileName, merged);
  }

  static async saveViaDocumentPicker(
    context: common.Context,
    fileName: string,
    content: string
  ): Promise<string> {
    const vaultBase = LexiStorageService.ensureVaultDirs(context, 'default-vault');
    const localCopyPath = `${vaultBase}/backups/${util.generateRandomUUID(true)}_${fileName.replace(/[\\/:*?"<>|]/g, '_')}`;
    try {
      LexiStorageService.writeTextAtomic(localCopyPath, content);
    } catch {}

    const docPicker = new picker.DocumentViewPicker(context);
    const uris = await docPicker.save({ newFileNames: [fileName] });
    if (!uris || uris.length === 0) {
      throw new Error('已取消外部保存，备份副本已保留在本机知识库目录');
    }
    const targetFile = await fs.open(uris[0], fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try {
      await fs.write(targetFile.fd, content);
    } finally {
      await fs.close(targetFile);
    }
    return uris[0];
  }

  static async importFilesFromPicker(context: common.Context, vaultId: string): Promise<string> {
    const docPicker = new picker.DocumentViewPicker(context);
    const uris = await docPicker.select({
      fileSuffixFilters: ['知萤笔记与备份|.md,.txt,.json'],
      maxSelectNumber: 10
    });
    if (!uris || uris.length === 0) {
      throw new Error('未选择文件');
    }
    let importedNotes = 0;
    let importedMaps = 0;
    for (let i = 0; i < uris.length; i++) {
      const uri = uris[i];
      const rawName = decodeURIComponent(uri.substring(uri.lastIndexOf('/') + 1).split('?')[0]);
      const srcFile = await fs.open(uri, fs.OpenMode.READ_ONLY);
      let content = '';
      try {
        const stat = await fs.stat(srcFile.fd);
        if (stat.size > 8 * 1024 * 1024) {
          throw new Error('单个导入文件上限为 8 MB');
        }
        const buf = new ArrayBuffer(stat.size);
        await fs.read(srcFile.fd, buf);
        content = new util.TextDecoder('utf-8').decodeToString(new Uint8Array(buf)).replace(/^\uFEFF/, '');
      } finally {
        await fs.close(srcFile);
      }

      if (rawName.toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(content) as LexiBackupPackage;
        if (parsed && parsed.format === 'LexiNote.Backup' && Array.isArray(parsed.notes)) {
          await LexiStorageService.restoreFromBackupPackage(context, parsed);
          return `已恢复完整备份（${parsed.notes.length} 篇笔记，${parsed.mindMaps ? parsed.mindMaps.length : 0} 幅导图）`;
        }
        const mapCandidate = JSON.parse(content) as MindMapDoc;
        if (mapCandidate && Array.isArray(mapCandidate.nodes) && mapCandidate.nodes.length > 0) {
          LexiBackupValidation.validateMap(mapCandidate);
          mapCandidate.id = `map-${Date.now()}-${i}`;
          mapCandidate.vaultId = vaultId;
          await LexiStorageService.saveMindMap(context, mapCandidate);
          importedMaps++;
          continue;
        }
      }

      const note = new NoteItem();
      note.id = util.generateRandomUUID(true);
      note.vaultId = vaultId;
      note.title = rawName.replace(/\.(md|txt|json)$/i, '');
      note.notebook = '导入资料';
      note.noteType = rawName.toLowerCase().endsWith('.md') ? 'markdown' : 'quick';
      note.editorLevel = rawName.toLowerCase().endsWith('.md') ? 'pro' : 'simple';
      LexiFrontmatter.apply(note, content);
      if (!note.tags.includes('导入')) { note.tags.push('导入'); }
      await LexiStorageService.saveNote(context, note);
      importedNotes++;
    }
    return `成功导入 ${importedNotes} 篇笔记${importedMaps > 0 ? `、${importedMaps} 幅思维导图` : ''}`;
  }

  static async restoreFromBackupPackage(context: common.Context, pkg: LexiBackupPackage): Promise<void> {
    const captured = JSON.parse(JSON.stringify(pkg)) as LexiBackupPackage;
    return LexiStorageService.withStorageLock<void>(context, async (): Promise<void> =>
      LexiStorageService.restoreFromBackupPackageUnlocked(context, captured));
  }

  private static async restoreFromBackupPackageUnlocked(
    context: common.Context,
    pkg: LexiBackupPackage
  ): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(pkg)) as LexiBackupPackage;
    LexiBackupValidation.validate(snapshot);
    const operation = LexiStorageService.mutationQueue.then(async (): Promise<void> => {
      await LexiStorageService.templateMutation<void>(async (): Promise<void> => { await LexiStorageService.restoreValidatedSnapshot(context, snapshot); });
    });
    LexiStorageService.mutationQueue = operation.catch((): void => {});
    await operation;
  }

  private static async restoreValidatedSnapshot(context: common.Context, pkg: LexiBackupPackage): Promise<void> {
    // Backup paths never grant access to external folders. Restore into a fresh local generation.
    pkg.projects = Array.isArray(pkg.projects) ? pkg.projects : [];
    for (const vault of pkg.vaults) { vault.folderUri = ''; vault.permissionUri = ''; }
    for (const project of pkg.projects) {
      if (!project || typeof project.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(project.id) ||
        !pkg.vaults.some((vault: VaultItem): boolean => vault.id === project.vaultId)) { throw new Error('备份中的项目归属无效'); }
      project.folderUri = ''; project.permissionUri = '';
    }
    for (const note of pkg.notes) {
      if (!pkg.projects.some((project: LexiProject): boolean => project.id === note.projectId && project.vaultId === note.vaultId)) { note.projectId = ''; }
      note.sourceMissing = false;
    }
    for (const doc of pkg.mindMaps) {
      if (!pkg.projects.some((project: LexiProject): boolean => project.id === doc.projectId && project.vaultId === doc.vaultId)) { doc.projectId = ''; }
    }
    for (const board of pkg.canvases) {
      if (!pkg.projects.some((project: LexiProject): boolean => project.id === board.projectId && project.vaultId === board.vaultId)) { board.projectId = ''; }
    }
    const generation = `${context.filesDir}/restores/${util.generateRandomUUID(true)}`;
    for (const vault of pkg.vaults) {
      for (const dir of ['notes', 'maps', 'canvases']) {
        fs.mkdirSync(`${generation}/${vault.id}/${dir}`, true);
      }
    }
    for (const note of pkg.notes) {
      note.path = `${generation}/${note.vaultId}/notes/${note.id}.md`;
      LexiStorageService.writeTextAtomic(note.path, note.content);
    }
    for (const doc of pkg.mindMaps) {
      LexiStorageService.writeTextAtomic(`${generation}/${doc.vaultId}/maps/${doc.id}.json`, JSON.stringify(doc));
    }
    for (const board of pkg.canvases) {
      LexiStorageService.writeTextAtomic(`${generation}/${board.vaultId}/canvases/${board.id}.json`, JSON.stringify(board));
    }
    const keys: string[] = ['vaults', 'projects', 'notes', 'mindmaps', 'canvases'];
    const values: string[] = [JSON.stringify(pkg.vaults), JSON.stringify(pkg.projects), JSON.stringify(pkg.notes),
      JSON.stringify(pkg.mindMaps), JSON.stringify(pkg.canvases)];
    if (pkg.templateLibrary) {
      const library = LexiTemplateLibrary.decode(pkg.templateLibrary);
      library.legacyImported = true;
      keys.push('templateLibrary:v1'); values.push(JSON.stringify(library));
    }
    const links = MarkdownEngine.buildNoteLinks(pkg.notes);
    await LexiStorageService.enqueueWrite(async (): Promise<void> => {
      const db = LexiStorageService.db();
      await db.beginTransaction();
      try {
        for (let i = 0; i < keys.length; i++) {
          await LexiStorageService.writeValueInTransaction(keys[i], values[i]);
        }
        await db.executeSql('DELETE FROM link_index');
        for (const link of links) {
          await db.insert('link_index', { source_id: link.sourceId, target_id: link.targetId,
            target_title: link.targetTitle, anchor: link.anchor, display_text: link.displayText });
        }
        await db.commit();
      } catch (error) {
        await db.rollBack();
        throw error as Error;
      }
    });
  }

  private static async ensureCleanStart(context: common.Context): Promise<void> {
    if (await LexiStorageService.getSetting('clean_start_v2', '') === 'true' &&
      await LexiStorageService.getSetting('legacy_examples_cleaned_v2', '') === 'true') { return; }
    let vaults = await LexiStorageService.getVaults();
    let notes = await LexiStorageService.getNotes('');
    let maps = await LexiStorageService.getMindMaps('');
    let boards = await LexiStorageService.getCanvases('');
    const projects = await LexiStorageService.getProjects();
    const before = new LexiBackupPackage();
    before.exportedAt = Date.now(); before.vaults = vaults; before.projects = projects;
    before.notes = notes; before.mindMaps = maps; before.canvases = boards;
    if (await LexiStorageService.getSetting('seeded_v1', '') === 'true') {
      const internal = vaults.some((vault: VaultItem): boolean => vault.id === 'default-vault' && !vault.folderUri);
      if (internal) {
        const examples = LexiSeedData.buildSeedNotes(0);
        notes = notes.filter((note: NoteItem): boolean => {
          const example = examples.find((item: NoteItem): boolean => item.id === note.id);
          const originalPath = `${context.filesDir}/vaults/default-vault/notes/${note.id}.md`;
          if (!example || note.path !== originalPath || !LexiLegacySamples.sameNote(note, example)) { return true; }
          try {
            const source = fs.readTextSync(originalPath);
            if (source !== example.content) { note.content = source; return true; }
            return false;
          } catch { return true; }
        });
        const exampleMaps = LexiSeedData.buildSeedMindMaps(0);
        maps = maps.filter((doc: MindMapDoc): boolean => {
          const example = exampleMaps.find((item: MindMapDoc): boolean => item.id === doc.id);
          if (!example || !LexiLegacySamples.sameMap(doc, example)) { return true; }
          try {
            const saved = JSON.parse(fs.readTextSync(`${context.filesDir}/vaults/default-vault/maps/${doc.id}.json`)) as MindMapDoc;
            return !LexiLegacySamples.sameMap(saved, example);
          } catch { return true; }
        });
        const exampleBoard = LexiSeedData.buildSeedCanvas(0);
        boards = boards.filter((board: CanvasBoard): boolean => {
          if (!LexiLegacySamples.sameBoard(board, exampleBoard)) { return true; }
          try {
            const saved = JSON.parse(fs.readTextSync(`${context.filesDir}/vaults/default-vault/canvases/${board.id}.json`)) as CanvasBoard;
            return !LexiLegacySamples.sameBoard(saved, exampleBoard);
          } catch { return true; }
        });
        const keptNotes = new Set<string>(notes.map((note: NoteItem): string => note.id));
        for (const doc of maps) { for (const node of doc.nodes) { if (node.noteRefId) { keptNotes.add(node.noteRefId); } } }
        for (const board of boards) { for (const card of board.cards) { if (card.noteRefId) { keptNotes.add(card.noteRefId); } } }
        const links = MarkdownEngine.buildNoteLinks(before.notes);
        let changed = true;
        while (changed) {
          changed = false;
          for (const link of links) {
            if (keptNotes.has(link.sourceId) && link.targetId && !keptNotes.has(link.targetId)) {
              keptNotes.add(link.targetId); changed = true;
            }
          }
        }
        notes = before.notes.filter((note: NoteItem): boolean => keptNotes.has(note.id));
      }
      vaults = vaults.filter((vault: VaultItem): boolean => vault.id !== 'dev-vault' || !!vault.folderUri ||
        vault.name !== '开发项目库' || vault.description !== 'HarmonyOS 架构设计与技术复盘文档' ||
        notes.some((note: NoteItem): boolean => note.vaultId === vault.id) ||
        maps.some((doc: MindMapDoc): boolean => doc.vaultId === vault.id) ||
        boards.some((board: CanvasBoard): boolean => board.vaultId === vault.id) ||
        projects.some((project: LexiProject): boolean => project.vaultId === vault.id));
    }
    if (notes.length !== before.notes.length || maps.length !== before.mindMaps.length ||
      boards.length !== before.canvases.length || vaults.length !== before.vaults.length) {
      const archiveDirectory = `${context.filesDir}/migrations`;
      if (!fs.accessSync(archiveDirectory)) { fs.mkdirSync(archiveDirectory, true); }
      const archivePath = `${archiveDirectory}/before-clean-start-v2.json`;
      if (!fs.accessSync(archivePath)) { LexiStorageService.writeTextAtomic(archivePath, JSON.stringify(before, null, 2)); }
    }
    if (vaults.length === 0) {
      const vault = new VaultItem(); vault.name = '我的工作区'; vault.description = '本机工作区'; vault.createdAt = Date.now();
      vaults = [vault];
    }
    const keys: string[] = ['vaults', 'projects', 'notes', 'mindmaps', 'canvases'];
    const payloads: string[] = [JSON.stringify(vaults), JSON.stringify(projects), JSON.stringify(notes), JSON.stringify(maps), JSON.stringify(boards)];
    await LexiStorageService.enqueueWrite(async (): Promise<void> => {
      const db = LexiStorageService.db(); await db.beginTransaction();
      try {
        for (let i = 0; i < keys.length; i++) {
          await LexiStorageService.writeValueInTransaction(keys[i], payloads[i]);
        }
        await db.commit();
      } catch (error) { await db.rollBack(); throw error as Error; }
    });
    await LexiStorageService.syncLinkTable(notes);
    const active = await LexiStorageService.getSetting('activeVaultId', '');
    if (!vaults.some((vault: VaultItem): boolean => vault.id === active)) { await LexiStorageService.setActiveVaultIdUnlocked(vaults[0].id); }
    await LexiStorageService.setSettingUnlocked('clean_start_v2', 'true');
    await LexiStorageService.setSettingUnlocked('legacy_examples_cleaned_v2', 'true');
  }
}
