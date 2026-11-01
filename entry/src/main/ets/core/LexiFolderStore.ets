import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
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

  static supported(): boolean {
    return canIUse('SystemCapability.FileManagement.AppFileService.FolderAuthorization') &&
      canIUse('SystemCapability.FileManagement.UserFileService.FolderSelection');
  }

  static path(uri: string): string {
    return uri ? new fileUri.FileUri(uri).path.replace(/\/+$/, '') : '';
  }

  static folderName(uri: string): string {
    const path = LexiFolderStore.path(uri);
    return path.substring(path.lastIndexOf('/') + 1) || '工作区';
  }

  private static policy(uri: string): fileShare.PolicyInfo {
    return { uri: uri, operationMode: fileShare.OperationMode.READ_MODE | fileShare.OperationMode.WRITE_MODE };
  }

  static async choose(context: common.UIAbilityContext, initialUri: string = ''): Promise<string> {
    if (!LexiFolderStore.supported()) { throw new Error('当前设备暂不支持长期访问文件夹，已有应用内工作区仍可使用。'); }
    const viewPicker = new picker.DocumentViewPicker(context);
    const options = new picker.DocumentSelectOptions();
    options.selectMode = picker.DocumentSelectMode.FOLDER;
    options.maxSelectNumber = 1;
    if (initialUri) { options.defaultFilePathUri = initialUri; }
    const uris = await viewPicker.select(options);
    if (uris.length === 0) { return ''; }
    const uri = uris[0];
    const policies: fileShare.PolicyInfo[] = [LexiFolderStore.policy(uri)];
    await fileShare.persistPermission(policies);
    await fileShare.activatePermission(policies);
    LexiFolderStore.activated.add(uri);
    const info = await fs.stat(LexiFolderStore.path(uri));
    if (!info.isDirectory()) { throw new Error('请选择文件夹'); }
    return uri;
  }

  static async activate(binding: LexiFolderBinding): Promise<string> {
    if (!binding.folderUri) { return ''; }
    const permissionUri = binding.permissionUri || binding.folderUri;
    if (!LexiFolderStore.activated.has(permissionUri)) {
      try {
        await fileShare.activatePermission([LexiFolderStore.policy(permissionUri)]);
        LexiFolderStore.activated.add(permissionUri);
      } catch { throw new Error('文件夹授权已失效，请在工作区管理中重新授权。'); }
    }
    const root = LexiFolderStore.path(binding.folderUri);
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) { throw new Error('工作区文件夹不存在，请重新选择。'); }
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

  static async read(binding: LexiFolderBinding, excludedRoots: string[] = []): Promise<LexiFolderSnapshot> {
    const root = await LexiFolderStore.activate(binding);
    const snapshot = new LexiFolderSnapshot();
    const catalogPath = `${root}/.lexinote/catalog.json`;
    LexiFolderStore.recoverWrite(root, catalogPath);
    let hasCatalog = false;
    try { hasCatalog = fs.accessSync(catalogPath); }
    catch (error) { throw new Error(`无法读取文件夹索引：${(error as Error).message}`); }
    if (hasCatalog) {
      LexiFolderStore.guardPath(root, catalogPath);
      const stat = await fs.stat(catalogPath);
      if (stat.size > 16 * 1024 * 1024) { throw new Error('工作区目录信息过大，暂时无法读取'); }
      const parsed = JSON.parse(await fs.readText(catalogPath)) as LexiFolderCatalog;
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
    let names: string[];
    try { names = (await fs.listFile(directory, { recursion: false })).sort(); }
    catch (error) { throw new Error(`无法列出文件夹内容：${(error as Error).message}`); }
    for (const name of names) {
      if (/\.(md|markdown)\.lexinote-recovery$/i.test(name)) {
        LexiFolderStore.recoverWrite(root, `${directory}/${name.replace(/\.lexinote-recovery$/, '')}`);
      }
    }
    for (const name of names) {
      if (name === '.lexinote' || name === '.git' || name === 'node_modules' || name.startsWith('.')) { continue; }
      const path = `${directory}/${name}`;
      if (excluded.some((skip: string): boolean => path === skip || path.startsWith(`${skip}/`))) { continue; }
      if (!fs.accessSync(path)) { continue; }
      const stat = await fs.lstat(path);
      if (stat.isSymbolicLink()) { continue; }
      if (stat.isDirectory()) { await LexiFolderStore.walk(root, path, excluded, documents); }
      else if (stat.isFile() && /\.(md|markdown)$/i.test(name)) {
        if (documents.length >= 5000) { throw new Error('文件夹中的笔记超过 5000 篇，请选择更具体的项目文件夹'); }
        if (stat.size > 8 * 1024 * 1024) { throw new Error(`「${name}」超过 8 MB，请将它拆分后再打开`); }
        const document = new LexiFolderDocument();
        document.relativePath = path.substring(root.length + 1);
        document.content = await fs.readText(path);
        document.modifiedAt = stat.mtime * 1000;
        documents.push(document);
      }
    }
  }
}
