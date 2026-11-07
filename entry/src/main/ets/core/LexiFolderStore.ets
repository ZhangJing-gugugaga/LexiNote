import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { fileIo as fs, fileShare, fileUri, picker } from '@kit.CoreFileKit';
import { CanvasBoard, MindMapDoc, NoteItem } from './LexiModels';
import { LexiFolderPolicy } from './LexiFolderPolicy';
import { LexiFrontmatter } from './LexiFrontmatter';

export class LexiFolderBinding {
  folderUri: string = '';
  permissionUri: string = '';
}

export class LexiFolderDocument {
  relativePath: string = '';
  content: string = '';
  modifiedAt: number = 0;
}

export class LexiFolderCatalog {
  format: string = 'LexiNote.Folder';
  version: number = 1;
  notes: NoteItem[] = [];
  mindMaps: MindMapDoc[] = [];
  canvases: CanvasBoard[] = [];
}

export class LexiFolderSnapshot {
  catalog: LexiFolderCatalog = new LexiFolderCatalog();
  documents: LexiFolderDocument[] = [];
}

class LexiFolderRecovery {
  format: string = 'LexiNote.PendingWrite';
  target: string = '';
  existed: boolean = false;
  previous: string = '';
  next: string = '';
}

export class LexiFolderStore {
  private static activated: Set<string> = new Set<string>();
  private static grantedFileUris: Map<string, string[]> = new Map<string, string[]>();

  static supported(): boolean {
    return canIUse('SystemCapability.FileManagement.UserFileService') ||
      canIUse('SystemCapability.FileManagement.UserFileService.FolderSelection') ||
      canIUse('SystemCapability.FileManagement.AppFileService.FolderAuthorization');
  }

  static path(uri: string): string {
    if (!uri) { return ''; }
    const raw = uri.startsWith('file:') ? new fileUri.FileUri(uri).path : uri;
    return raw.replace(/\/+$/, '');
  }

  static folderName(uri: string): string {
    const path = LexiFolderStore.path(uri);
    return decodeURIComponent(path.substring(path.lastIndexOf('/') + 1)) || '工作区';
  }

  private static policy(uri: string): fileShare.PolicyInfo {
    return { uri: uri, operationMode: fileShare.OperationMode.READ_MODE | fileShare.OperationMode.WRITE_MODE };
  }

  private static async tryPersistAndActivate(uri: string): Promise<void> {
    if (!uri) { return; }
    const policies: fileShare.PolicyInfo[] = [LexiFolderStore.policy(uri)];
    if (canIUse('SystemCapability.FileManagement.AppFileService.FolderAuthorization')) {
      try {
        await fileShare.persistPermission(policies);
        await fileShare.activatePermission(policies);
      } catch (error) {
        const code = (error as BusinessError).code;
        if (code !== 201 && code !== 801 && code !== 401 && code !== 13900001) {
          throw error as Error;
        }
      }
    }
    LexiFolderStore.activated.add(uri);
  }

  static async choose(context: common.UIAbilityContext, initialUri: string = ''): Promise<string> {
    const viewPicker = new picker.DocumentViewPicker(context);
    const options = new picker.DocumentSelectOptions();
    options.selectMode = picker.DocumentSelectMode.FOLDER;
    options.maxSelectNumber = 500;
    if (initialUri) { options.defaultFilePathUri = initialUri; }
    let uris: string[] = [];
    try {
      uris = await viewPicker.select(options);
    } catch {
      const fallback = new picker.DocumentSelectOptions();
      fallback.fileSuffixFilters = ['Markdown 笔记|.md,.markdown'];
      fallback.maxSelectNumber = 500;
      if (initialUri) { fallback.defaultFilePathUri = initialUri; }
      uris = await viewPicker.select(fallback);
    }
    if (!uris || uris.length === 0) { return ''; }
    const uri = uris[0];
    await LexiFolderStore.tryPersistAndActivate(uri);
    const chosenPath = LexiFolderStore.path(uri);
    let isDir = false;
    try {
      const info = await fs.stat(chosenPath);
      isDir = info.isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) {
      return uri;
    }
    // When a device picker selects file(s) inside a folder instead of the directory itself,
    // bind the parent folder and scan both the folder (if accessible) and the selected .md files.
    const slash = uri.lastIndexOf('/');
    if (slash <= 'file://'.length) { throw new Error('请选择文件夹'); }
    const folderUri = uri.substring(0, slash);
    const folderPath = LexiFolderStore.path(folderUri);
    try { await LexiFolderStore.tryPersistAndActivate(folderUri); } catch {}
    for (const itemUri of uris) {
      try { await LexiFolderStore.tryPersistAndActivate(itemUri); } catch {}
    }
    LexiFolderStore.grantedFileUris.set(folderPath, uris.slice());
    return folderUri;
  }

  static async activate(binding: LexiFolderBinding): Promise<string> {
    if (!binding.folderUri) { return ''; }
    const permissionUri = binding.permissionUri || binding.folderUri;
    if (!LexiFolderStore.activated.has(permissionUri)) {
      try {
        if (canIUse('SystemCapability.FileManagement.AppFileService.FolderAuthorization')) {
          await fileShare.activatePermission([LexiFolderStore.policy(permissionUri)]);
        }
        LexiFolderStore.activated.add(permissionUri);
      } catch (error) {
        const code = (error as BusinessError).code;
        if (code !== 201 && code !== 801 && code !== 401) {
          throw new Error('文件夹授权已失效，请在工作区管理中重新授权。');
        }
        LexiFolderStore.activated.add(permissionUri);
      }
    }
    const root = LexiFolderStore.path(binding.folderUri);
    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) { throw new Error('工作区文件夹不存在，请重新选择。'); }
    } catch (error) {
      if ((error as Error).message === '工作区文件夹不存在，请重新选择。') { throw error as Error; }
      if (LexiFolderStore.grantedFileUris.has(root)) { return root; }
      throw new Error('文件夹授权已失效，请在工作区管理中重新授权。');
    }
    return root;
  }

  static async bind(parentUri: string, name: string, createChild: boolean, permissionUri: string = ''): Promise<LexiFolderBinding> {
    const binding = new LexiFolderBinding();
    binding.folderUri = parentUri;
    binding.permissionUri = permissionUri || parentUri;
    const root = await LexiFolderStore.activate(binding);
    if (createChild) {
      const clean = LexiFolderPolicy.fileName(name);
      if (!name.trim() || clean !== name.trim()) { throw new Error('文件夹名称不能包含路径符号或特殊字符'); }
      const child = `${root}/${clean}`;
      if (fs.accessSync(child)) { throw new Error('已有同名文件夹；请直接选择该文件夹作为项目。'); }
      await fs.mkdir(child);
      binding.folderUri = `${parentUri.replace(/\/+$/, '')}/${encodeURIComponent(clean)}`;
    }
    return binding;
  }

  private static guardPath(root: string, path: string): void {
    if (!LexiFolderPolicy.within(root, path)) { throw new Error('文件不在所选工作区内'); }
    const relative = path.substring(root.length + 1);
    let parent = root;
    for (const part of relative.split('/')) {
      parent = `${parent}/${part}`;
      if (fs.accessSync(parent) && fs.lstatSync(parent).isSymbolicLink()) {
        throw new Error('无法通过符号链接写入工作区文件');
      }
    }
  }

  private static writeDirect(path: string, text: string): void {
    const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try { fs.writeSync(file.fd, text); fs.fsyncSync(file.fd); } finally { fs.closeSync(file); }
    if (fs.readTextSync(path) !== text) { throw new Error('文件未完整写入'); }
  }

  private static recoverWrite(root: string, path: string): void {
    const recoveryPath = `${path}.lexinote-recovery`;
    LexiFolderStore.guardPath(root, recoveryPath);
    if (!fs.accessSync(recoveryPath)) { return; }
    const recovery = JSON.parse(fs.readTextSync(recoveryPath)) as LexiFolderRecovery;
    if (recovery.format !== 'LexiNote.PendingWrite' || recovery.target !== path.substring(root.length + 1) ||
      typeof recovery.previous !== 'string' || typeof recovery.next !== 'string' || typeof recovery.existed !== 'boolean') {
      throw new Error('文件夹中存在无法识别的保存恢复记录，未修改原文件');
    }
    LexiFolderStore.guardPath(root, path);
    const current = fs.accessSync(path) ? fs.readTextSync(path) : '';
    if (current !== recovery.next) {
      if (current && current !== recovery.previous) {
        let suffix = 1;
        let interrupted = `${path}.lexinote-interrupted-${suffix}`;
        while (fs.accessSync(interrupted)) { interrupted = `${path}.lexinote-interrupted-${++suffix}`; }
        LexiFolderStore.guardPath(root, interrupted);
        LexiFolderStore.writeDirect(interrupted, current);
      }
      if (recovery.existed) { LexiFolderStore.writeDirect(path, recovery.previous); }
      else if (fs.accessSync(path)) { fs.unlinkSync(path); }
    }
    fs.unlinkSync(recoveryPath);
  }

  private static writeAtomic(root: string, path: string, text: string): void {
    LexiFolderStore.guardPath(root, path);
    LexiFolderStore.recoverWrite(root, path);
    const temporary = `${path}.lexinote-tmp`;
    LexiFolderStore.guardPath(root, temporary);
    LexiFolderStore.writeDirect(temporary, text);
    try { fs.renameSync(temporary, path); }
    catch (error) {
      if ((error as BusinessError).code !== 13900012) {
        throw new Error(`无法替换文件「${path.substring(root.length + 1)}」：${(error as Error).message}`);
      }
      // Some public-directory providers allow writes but deny rename. Keep a
      // durable recovery record before changing the destination in place.
      const recovery = new LexiFolderRecovery();
      recovery.target = path.substring(root.length + 1);
      recovery.existed = fs.accessSync(path);
      recovery.previous = recovery.existed ? fs.readTextSync(path) : '';
      recovery.next = text;
      const recoveryPath = `${path}.lexinote-recovery`;
      try { LexiFolderStore.writeDirect(recoveryPath, JSON.stringify(recovery)); }
      catch (journalError) {
        if (fs.accessSync(recoveryPath)) { fs.unlinkSync(recoveryPath); }
        throw journalError as Error;
      }
      try { LexiFolderStore.writeDirect(path, text); }
      catch (writeError) {
        try {
          if (recovery.existed) { LexiFolderStore.writeDirect(path, recovery.previous); }
          else if (fs.accessSync(path)) { fs.unlinkSync(path); }
          fs.unlinkSync(recoveryPath);
        } catch { throw new Error('保存未完成，旧内容保留在文件旁的 .lexinote-recovery 恢复记录中；请释放空间后重试。'); }
        throw writeError as Error;
      }
      fs.unlinkSync(recoveryPath);
      fs.unlinkSync(temporary);
    }
  }

  static async writeNote(binding: LexiFolderBinding, note: NoteItem): Promise<string> {
    const root = await LexiFolderStore.activate(binding);
    let path = note.path;
    if (!LexiFolderPolicy.within(root, path)) {
      const stem = `${LexiFolderPolicy.fileName(note.title || '未命名笔记')}-${note.id.substring(0, 8)}`;
      path = `${root}/${stem}.md`;
      let suffix = 1;
      while (fs.accessSync(path)) { path = `${root}/${stem}-${suffix++}.md`; }
    }
    LexiFolderStore.writeAtomic(root, path, LexiFrontmatter.serialize(note));
    return path;
  }

  static async removeNote(binding: LexiFolderBinding, path: string): Promise<void> {
    const root = await LexiFolderStore.activate(binding);
    LexiFolderStore.guardPath(root, path);
    if (fs.accessSync(path)) { fs.unlinkSync(path); }
  }

  static async writeCatalog(binding: LexiFolderBinding, notes: NoteItem[], maps: MindMapDoc[], canvases: CanvasBoard[]): Promise<void> {
    const root = await LexiFolderStore.activate(binding);
    const directory = `${root}/.lexinote`;
    LexiFolderStore.guardPath(root, directory);
    if (!fs.accessSync(directory)) {
      try { await fs.mkdir(directory); }
      catch (error) { throw new Error(`无法创建文件夹索引：${(error as Error).message}`); }
    }
    const catalog = new LexiFolderCatalog();
    catalog.notes = notes.map((note: NoteItem): NoteItem => {
      const copy = JSON.parse(JSON.stringify(note)) as NoteItem;
      copy.content = '';
      copy.path = LexiFolderPolicy.within(root, note.path) ? note.path.substring(root.length + 1) : '';
      return copy;
    });
    catalog.mindMaps = maps;
    catalog.canvases = canvases;
    LexiFolderStore.writeAtomic(root, `${directory}/catalog.json`, JSON.stringify(catalog, null, 2));
  }

  private static async readFileText(pathOrUri: string): Promise<string> {
    try {
      const text = await fs.readText(pathOrUri);
      if (typeof text === 'string') { return text.replace(/^\uFEFF/, ''); }
    } catch {}
    const file = await fs.open(pathOrUri, fs.OpenMode.READ_ONLY);
    try {
      const stat = await fs.stat(file.fd);
      if (stat.size <= 0) { return ''; }
      const buffer = new ArrayBuffer(stat.size);
      const readLen = await fs.read(file.fd, buffer);
      return new util.TextDecoder('utf-8').decodeToString(new Uint8Array(buffer, 0, readLen)).replace(/^\uFEFF/, '');
    } finally {
      await fs.close(file);
    }
  }

  static async read(binding: LexiFolderBinding, excludedRoots: string[] = []): Promise<LexiFolderSnapshot> {
    const root = await LexiFolderStore.activate(binding);
    const snapshot = new LexiFolderSnapshot();
    const catalogPath = `${root}/.lexinote/catalog.json`;
    try { LexiFolderStore.recoverWrite(root, catalogPath); } catch {}
    let hasCatalog = false;
    try { hasCatalog = fs.accessSync(catalogPath); }
    catch { hasCatalog = false; }
    if (hasCatalog) {
      LexiFolderStore.guardPath(root, catalogPath);
      const stat = await fs.stat(catalogPath);
      if (stat.size > 16 * 1024 * 1024) { throw new Error('工作区目录信息过大，暂时无法读取'); }
      const parsed = JSON.parse(await LexiFolderStore.readFileText(catalogPath)) as LexiFolderCatalog;
      if (parsed.format !== 'LexiNote.Folder' || parsed.version !== 1 || !Array.isArray(parsed.notes) ||
        !Array.isArray(parsed.mindMaps) || !Array.isArray(parsed.canvases)) {
        throw new Error('文件夹中存在无法识别的知萤目录信息，未作修改');
      }
      snapshot.catalog = parsed;
    }
    await LexiFolderStore.walk(root, root, excludedRoots, snapshot.documents);
    return snapshot;
  }

  private static async walk(root: string, directory: string, excluded: string[], documents: LexiFolderDocument[]): Promise<void> {
    let rawNames: string[] = [];
    try {
      rawNames = (await fs.listFile(directory, { recursion: false })).sort();
    } catch (error) {
      if (directory === root && LexiFolderStore.grantedFileUris.has(root)) {
        rawNames = [];
      } else {
        throw new Error(`无法列出文件夹内容：${(error as Error).message}`);
      }
    }
    const names = rawNames.map((item: string): string => item.replace(/^\/+/, '')).filter((item: string): boolean => item.length > 0);
    for (const name of names) {
      if (/\.(md|markdown)\.lexinote-recovery$/i.test(name)) {
        LexiFolderStore.recoverWrite(root, `${directory}/${name.replace(/\.lexinote-recovery$/, '')}`);
      }
    }
    for (const name of names) {
      if (name === '.lexinote' || name === '.git' || name === 'node_modules' || name.startsWith('.')) { continue; }
      const path = `${directory}/${name}`;
      if (excluded.some((skip: string): boolean => path === skip || path.startsWith(`${skip}/`))) { continue; }
      let stat: fs.Stat;
      try {
        if (!fs.accessSync(path)) { continue; }
        stat = await fs.lstat(path);
      } catch {
        try { stat = await fs.stat(path); }
        catch { continue; }
      }
      if (stat.isSymbolicLink()) { continue; }
      if (stat.isDirectory()) { await LexiFolderStore.walk(root, path, excluded, documents); }
      else if (stat.isFile() && /\.(md|markdown)$/i.test(name)) {
        if (documents.length >= 5000) { throw new Error('文件夹中的笔记超过 5000 篇，请选择更具体的项目文件夹'); }
        if (stat.size > 8 * 1024 * 1024) { throw new Error(`「${name}」超过 8 MB，请将它拆分后再打开`); }
        const document = new LexiFolderDocument();
        document.relativePath = path.substring(root.length + 1);
        document.content = await LexiFolderStore.readFileText(path);
        document.modifiedAt = stat.mtime * 1000;
        documents.push(document);
      }
    }
    if (directory === root && LexiFolderStore.grantedFileUris.has(root)) {
      const granted = LexiFolderStore.grantedFileUris.get(root) ?? [];
      for (const uri of granted) {
        const filePath = LexiFolderStore.path(uri);
        const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
        if (!/\.(md|markdown)$/i.test(fileName)) { continue; }
        const relativePath = LexiFolderPolicy.within(root, filePath) ? filePath.substring(root.length + 1) : fileName;
        if (documents.some((doc: LexiFolderDocument): boolean => doc.relativePath === relativePath)) { continue; }
        try {
          const document = new LexiFolderDocument();
          document.relativePath = relativePath;
          document.content = await LexiFolderStore.readFileText(uri);
          document.modifiedAt = Date.now();
          documents.push(document);
        } catch {}
      }
    }
  }
}
