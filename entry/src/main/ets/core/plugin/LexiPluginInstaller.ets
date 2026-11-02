// Plugin package installer: zip extraction, integrity check, version store, upgrade/rollback.
//
// Layout (docs/lexinote_plugin_bridge_spec.md §4, tightened here):
//   files/plugins/<id>/                      projection of the current version + data.json
//   files/plugins/<id>/current.json          pointer: the single source of truth for "which version"
//   files/plugins/<id>/.versions/<version>/  immutable copy of every installed version
//   files/plugins/.trash/<id>-<ts>/          uninstall target (code + data.json kept for recovery)
//
// The projection exists so the rest of the host keeps its old contract: scanPluginDir still reads
// <dir>/manifest.json and enablePlugin still wants <dir>/main.js. data.json never enters .versions,
// so upgrades, rollbacks and reinstalls cannot touch user data.
//
// Everything below the zip-extraction step goes through PluginStorageIo, which lets the offline
// regression drive the whole upgrade/rollback/uninstall state machine on a fake in-memory tree
// (scripts/tests/plugin-dist-regression.cjs) instead of a device.

import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { zlib } from '@kit.BasicServicesKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import {
  LexiPluginManifest,
  parsePluginManifest,
  manifestApiCompatible,
  comparePluginVersion,
  ERROR_MANIFEST_INVALID,
  ERROR_INTEGRITY_MISMATCH,
  ERROR_MIN_API_UNSATISFIED,
  ERROR_DOWNGRADE_BLOCKED
} from './LexiPluginManifest';

export const INSTALL_ERROR_FAILED: string = 'install_failed';
export const UNINSTALL_ERROR_FAILED: string = 'uninstall_failed';
export const ROLLBACK_ERROR_UNAVAILABLE: string = 'rollback_unavailable';

export const POINTER_FILE: string = 'current.json';
export const VERSIONS_DIR: string = '.versions';
export const TRASH_DIR: string = '.trash';
export const DATA_FILE: string = 'data.json';

/** Filesystem seam: the system implementation is below, the regression harness supplies a fake. */
export interface PluginStorageIo {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  mkdirp(path: string): void;
  list(path: string): Promise<string[]>;
  listSync(path: string): string[];
  readText(path: string): string;
  writeText(path: string, content: string): void;
  copyFile(source: string, dest: string): void;
  copyTree(source: string, dest: string): Promise<void>;
  removeTree(path: string): void;
  sha256File(path: string): Promise<string>;
}

export class SystemPluginStorageIo implements PluginStorageIo {
  exists(path: string): boolean {
    return fs.accessSync(path);
  }

  isDirectory(path: string): boolean {
    if (!this.exists(path)) { return false; }
    try { return fs.statSync(path).isDirectory(); } catch { return false; }
  }

  mkdirp(path: string): void {
    if (!this.exists(path)) { fs.mkdirSync(path, true); }
  }

  async list(path: string): Promise<string[]> {
    return await fs.listFile(path);
  }

  listSync(path: string): string[] {
    return fs.listFileSync(path);
  }

  readText(path: string): string {
    return fs.readTextSync(path);
  }

  writeText(path: string, content: string): void {
    const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(file.fd, content);
    } finally {
      fs.closeSync(file);
    }
  }

  copyFile(source: string, dest: string): void {
    fs.copyFileSync(source, dest);
  }

  async copyTree(source: string, dest: string): Promise<void> {
    this.mkdirp(dest);
    const entries = await this.list(source);
    for (const entry of entries) {
      const src = source + '/' + entry;
      const dst = dest + '/' + entry;
      if (this.isDirectory(src)) {
        await this.copyTree(src, dst);
      } else {
        this.copyFile(src, dst);
      }
    }
  }

  removeTree(path: string): void {
    if (!this.exists(path)) { return; }
    fs.rmdirSync(path);
  }

  async sha256File(path: string): Promise<string> {
    const size = fs.statSync(path).size;
    const bytes = new Uint8Array(size);
    const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
    try {
      if (size > 0) { fs.readSync(file.fd, bytes.buffer as ArrayBuffer); }
    } finally {
      fs.closeSync(file);
    }
    const md = cryptoFramework.createMd('SHA256');
    await md.update({ data: bytes });
    const digest = await md.digest();
    const out = digest.data;
    let hex = '';
    for (let i = 0; i < out.length; i++) {
      const piece = out[i].toString(16);
      hex += piece.length === 1 ? '0' + piece : piece;
    }
    return hex;
  }
}

export class PluginInstallOptions {
  /** Expected sha256 of the package bytes. Empty = no declared hash (local side-load). */
  expectedSha256: string = '';
  /** Allow installing an older version over a newer one. */
  allowDowngrade: boolean = false;
}

export class PluginInstallOutcome {
  ok: boolean = false;
  code: string = '';
  message: string = '';
  manifest: LexiPluginManifest | null = null;
  version: string = '';
  previousVersion: string = '';
  rolledBack: boolean = false;
}

export class PluginLifecycleOutcome {
  ok: boolean = false;
  code: string = '';
  message: string = '';
  id: string = '';
  version: string = '';
  previousVersion: string = '';
  path: string = '';
}

export class PluginVersionPointer {
  version: string = '';
  previousVersion: string = '';
  installedAt: number = 0;
}

export class LexiPluginInstaller {
  private context: common.Context;
  private pluginsRoot: string;
  private io: PluginStorageIo;

  constructor(context: common.Context, pluginsRoot: string, io: PluginStorageIo | null = null) {
    this.context = context;
    this.pluginsRoot = pluginsRoot;
    this.io = io === null ? new SystemPluginStorageIo() : io;
  }

  // --- path helpers -------------------------------------------------------

  pluginDir(id: string): string {
    return this.pluginsRoot + '/' + id;
  }

  versionsDir(id: string): string {
    return this.pluginDir(id) + '/' + VERSIONS_DIR;
  }

  versionDir(id: string, version: string): string {
    return this.versionsDir(id) + '/' + version;
  }

  pointerPath(id: string): string {
    return this.pluginDir(id) + '/' + POINTER_FILE;
  }

  // --- package hash -------------------------------------------------------

  /** Compares the package bytes against the declared hash. The only place sha256 is trusted. */
  async verifyPackageHash(zipPath: string, expectedSha256: string): Promise<PluginInstallOutcome> {
    const outcome = new PluginInstallOutcome();
    const actual = await this.io.sha256File(zipPath);
    if (expectedSha256.length > 0 && actual !== expectedSha256) {
      outcome.ok = false;
      outcome.code = ERROR_INTEGRITY_MISMATCH;
      outcome.message = '安装包 sha256 与索引声明不符（声明 ' + expectedSha256 + '，实际 ' + actual + '）';
      return outcome;
    }
    outcome.ok = true;
    outcome.version = actual;
    return outcome;
  }

  // --- install ------------------------------------------------------------

  /** Extracts a zip (local path or file URI) and installs the plugin into the plugins root. */
  async installZip(zipSource: string, expectedSha256: string = ''): Promise<LexiPluginManifest> {
    const work = this.context.cacheDir + '/plugin-install-' + Date.now();
    this.io.mkdirp(work);
    let zipPath = zipSource;
    if (zipSource.startsWith('file://') || zipSource.indexOf(':') > 0) {
      zipPath = work + '/package.zip';
      this.io.copyFile(zipSource, zipPath);
    }
    try {
      const verified = await this.verifyPackageHash(zipPath, expectedSha256);
      if (!verified.ok) { throw new Error(verified.code + ': ' + verified.message); }
      const extractRoot = work + '/unpacked';
      this.io.mkdirp(extractRoot);
      await zlib.decompressFile(zipPath, extractRoot);
      const root = await this.locatePluginRoot(extractRoot);
      if (!root) { throw new Error(ERROR_MANIFEST_INVALID + ': 安装包中未找到 manifest.json'); }
      const outcome = await this.installExtracted(root, this.optionsFor(expectedSha256));
      if (!outcome.ok) { throw new Error(outcome.code + ': ' + outcome.message); }
      return outcome.manifest as LexiPluginManifest;
    } finally {
      try { this.io.removeTree(work); } catch { /* 缓存目录残留可接受 */ }
    }
  }

  private optionsFor(expectedSha256: string): PluginInstallOptions {
    const options = new PluginInstallOptions();
    options.expectedSha256 = expectedSha256;
    return options;
  }

  /**
   * Installs from an already-extracted package directory.
   * On any failure the version store and the pointer are left exactly as they were, and the
   * staging directory is removed - a failed install never leaves a half-installed plugin.
   */
  async installExtracted(root: string, options: PluginInstallOptions): Promise<PluginInstallOutcome> {
    const outcome = new PluginInstallOutcome();
    let manifest: LexiPluginManifest;
    try {
      manifest = parsePluginManifest(this.io.readText(root + '/manifest.json'));
    } catch (error) {
      outcome.code = ERROR_MANIFEST_INVALID;
      outcome.message = (error as Error).message;
      return outcome;
    }
    outcome.manifest = manifest;
    outcome.version = manifest.version;
    if (!manifestApiCompatible(manifest)) {
      outcome.code = ERROR_MIN_API_UNSATISFIED;
      outcome.message = '插件要求 API ' + manifest.minApiVersion + '，宿主仅提供更低版本';
      return outcome;
    }
    const id = manifest.id;
    const previous = this.currentVersion(id);
    outcome.previousVersion = previous;
    if (previous.length > 0 && !options.allowDowngrade && comparePluginVersion(manifest.version, previous) < 0) {
      outcome.code = ERROR_DOWNGRADE_BLOCKED;
      outcome.message = '禁止降级安装：已安装 ' + previous + '，安装包为 ' + manifest.version;
      return outcome;
    }
    const dir = this.pluginDir(id);
    const versions = this.versionsDir(id);
    const staging = versions + '/.staging-' + Date.now();
    this.io.mkdirp(versions);
    try {
      this.io.mkdirp(staging);
      await this.copyTreeExcept(root, staging, DATA_FILE);
      await this.assertUsable(staging);
    } catch (error) {
      try { this.io.removeTree(staging); } catch { /* 清理失败不改变结果 */ }
      outcome.ok = false;
      outcome.code = INSTALL_ERROR_FAILED;
      outcome.message = (error as Error).message;
      return outcome;
    }
    // Snapshot the currently projected version before overwriting it.
    if (previous.length > 0 && !this.io.exists(this.versionDir(id, previous))) {
      try {
        this.io.mkdirp(this.versionDir(id, previous));
        await this.copyTreeExcept(dir, this.versionDir(id, previous), DATA_FILE);
      } catch { /* 快照失败不阻塞升级：指针仍指向新版本，回滚机会随旧投影一起丢失 */ }
    }
    const target = this.versionDir(id, manifest.version);
    try {
      if (this.io.exists(target)) { this.io.removeTree(target); }
      await this.io.copyTree(staging, target);
      this.io.removeTree(staging);
      await this.project(id, manifest.version);
      this.writePointer(id, manifest.version, previous);
    } catch (error) {
      outcome.ok = false;
      outcome.code = INSTALL_ERROR_FAILED;
      outcome.message = (error as Error).message;
      const restored = previous.length > 0 ? this.tryRestore(id, previous) : false;
      outcome.rolledBack = restored;
      return outcome;
    }
    outcome.ok = true;
    return outcome;
  }

  private tryRestore(id: string, version: string): boolean {
    try {
      if (!this.io.exists(this.versionDir(id, version))) { return false; }
      this.projectSync(id, version);
      this.writePointer(id, version, '');
      return true;
    } catch {
      return false;
    }
  }

  private async assertUsable(staging: string): Promise<void> {
    if (!this.io.exists(staging + '/manifest.json')) { throw new Error('安装包缺少 manifest.json'); }
    if (!this.io.exists(staging + '/main.js') && !this.io.exists(staging + '/styles.css')) {
      throw new Error('安装包既无 main.js 也无 styles.css');
    }
  }

  private async locatePluginRoot(extractRoot: string): Promise<string> {
    if (this.io.exists(extractRoot + '/manifest.json')) { return extractRoot; }
    const entries = await this.io.list(extractRoot);
    for (const entry of entries) {
      const candidate = extractRoot + '/' + entry;
      if (this.io.isDirectory(candidate) && this.io.exists(candidate + '/manifest.json')) { return candidate; }
    }
    return '';
  }

  private async copyTreeExcept(source: string, dest: string, skipName: string): Promise<void> {
    this.io.mkdirp(dest);
    const entries = await this.io.list(source);
    for (const entry of entries) {
      if (skipName.length > 0 && entry === skipName) { continue; }
      const src = source + '/' + entry;
      const dst = dest + '/' + entry;
      if (this.io.isDirectory(src)) {
        await this.copyTreeExcept(src, dst, '');
      } else {
        this.io.copyFile(src, dst);
      }
    }
  }

  // --- projection ---------------------------------------------------------

  /** Copies .versions/<version>/* over the plugin dir, leaving data.json untouched. */
  async project(id: string, version: string): Promise<void> {
    this.clearProjection(id);
    await this.copyTreeExcept(this.versionDir(id, version), this.pluginDir(id), DATA_FILE);
  }

  private projectSync(id: string, version: string): void {
    this.clearProjection(id);
    this.copyTreeSync(this.versionDir(id, version), this.pluginDir(id), true);
  }

  private copyTreeSync(source: string, dest: string, preserveDataFile: boolean = false): void {
    this.io.mkdirp(dest);
    const names = this.io.listSync(source);
    for (const entry of names) {
      if (preserveDataFile && entry === DATA_FILE) { continue; }
      const src = source + '/' + entry;
      const dst = dest + '/' + entry;
      if (this.io.isDirectory(src)) { this.copyTreeSync(src, dst, preserveDataFile); } else { this.io.copyFile(src, dst); }
    }
  }

  private clearProjection(id: string): void {
    const dir = this.pluginDir(id);
    if (!this.io.exists(dir)) { return; }
    const names = this.io.listSync(dir);
    for (const entry of names) {
      if (entry === DATA_FILE || entry === VERSIONS_DIR || entry === POINTER_FILE) { continue; }
      const path = dir + '/' + entry;
      if (this.io.isDirectory(path)) { continue; }
      try { this.io.removeTree(path); } catch { /* 单文件删除失败下一轮重试 */ }
    }
  }

  // --- pointer ------------------------------------------------------------

  readPointer(id: string): PluginVersionPointer {
    const pointer = new PluginVersionPointer();
    const path = this.pointerPath(id);
    if (!this.io.exists(path)) { return pointer; }
    try {
      const raw = JSON.parse(this.io.readText(path)) as PluginVersionPointer;
      pointer.version = typeof raw.version === 'string' ? raw.version : '';
      pointer.previousVersion = typeof raw.previousVersion === 'string' ? raw.previousVersion : '';
      pointer.installedAt = typeof raw.installedAt === 'number' ? raw.installedAt : 0;
    } catch { /* 指针损坏等价于无指针 */ }
    return pointer;
  }

  currentVersion(id: string): string {
    const pointer = this.readPointer(id);
    if (pointer.version.length > 0 && this.io.exists(this.versionDir(id, pointer.version))) { return pointer.version; }
    // 指针缺失/指向已删目录时，从投影里的 manifest 兜底（仅迁移旧布局用）。
    const projected = this.pluginDir(id) + '/manifest.json';
    if (this.io.exists(projected)) {
      try { return parsePluginManifest(this.io.readText(projected)).version; } catch { return ''; }
    }
    return '';
  }

  private writePointer(id: string, version: string, previousVersion: string): void {
    this.io.mkdirp(this.pluginDir(id));
    const pointer = new PluginVersionPointer();
    pointer.version = version;
    pointer.previousVersion = previousVersion;
    pointer.installedAt = Date.now();
    this.io.writeText(this.pointerPath(id), JSON.stringify(pointer));
  }

  async listVersions(id: string): Promise<string[]> {
    const dir = this.versionsDir(id);
    const result: string[] = [];
    if (!this.io.exists(dir)) { return result; }
    const entries = await this.io.list(dir);
    for (const entry of entries) {
      if (entry.startsWith('.')) { continue; }
      if (this.io.exists(dir + '/' + entry + '/manifest.json')) { result.push(entry); }
    }
    return result;
  }

  // --- rollback -----------------------------------------------------------

  /** Switches the pointer back to the version that was current before the last install. */
  async rollbackPlugin(id: string): Promise<PluginLifecycleOutcome> {
    const outcome = new PluginLifecycleOutcome();
    outcome.id = id;
    const pointer = this.readPointer(id);
    const target = pointer.previousVersion;
    outcome.previousVersion = pointer.version;
    if (target.length === 0) {
      outcome.code = ROLLBACK_ERROR_UNAVAILABLE;
      outcome.message = '没有可回滚的上一版本';
      return outcome;
    }
    if (!this.io.exists(this.versionDir(id, target))) {
      outcome.code = ROLLBACK_ERROR_UNAVAILABLE;
      outcome.message = '上一版本目录不存在: ' + target;
      return outcome;
    }
    try {
      await this.project(id, target);
      this.writePointer(id, target, pointer.version);
    } catch (error) {
      outcome.code = ROLLBACK_ERROR_UNAVAILABLE;
      outcome.message = (error as Error).message;
      return outcome;
    }
    outcome.ok = true;
    outcome.version = target;
    outcome.path = this.pluginDir(id);
    return outcome;
  }

  // --- uninstall ----------------------------------------------------------

  /**
   * Moves the whole plugin directory into files/plugins/.trash/<id>-<ts>/.
   * Code and manifest leave the plugins root (so the next scan cannot resurrect the plugin),
   * data.json travels inside the same directory and stays recoverable.
   */
  uninstallPlugin(id: string): PluginLifecycleOutcome {
    const outcome = new PluginLifecycleOutcome();
    outcome.id = id;
    const dir = this.pluginDir(id);
    if (!this.io.exists(dir)) {
      outcome.code = UNINSTALL_ERROR_FAILED;
      outcome.message = '插件目录不存在: ' + id;
      return outcome;
    }
    outcome.version = this.currentVersion(id);
    outcome.previousVersion = this.readPointer(id).previousVersion;
    const trash = this.trashDir(id);
    try {
      this.io.mkdirp(trash);
      this.moveDir(dir, trash + '/' + id);
      this.io.writeText(trash + '/uninstall.json', JSON.stringify({
        id: id, version: outcome.version, removedAt: Date.now()
      }));
    } catch (error) {
      outcome.code = UNINSTALL_ERROR_FAILED;
      outcome.message = (error as Error).message;
      return outcome;
    }
    outcome.ok = true;
    outcome.path = trash;
    return outcome;
  }

  private trashDir(id: string): string {
    return this.pluginsRoot + '/' + TRASH_DIR + '/' + id + '-' + Date.now();
  }

  private moveDir(source: string, dest: string): void {
    try {
      fs.renameSync(source, dest);
      return;
    } catch { /* rename 跨卷可用性因设备而异，回退到复制+删除 */ }
    this.io.mkdirp(dest);
    this.copyTreeSync(source, dest);
    this.io.removeTree(source);
  }
}
