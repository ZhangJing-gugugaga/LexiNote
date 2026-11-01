// Plugin package installer: zip extraction, manifest validation and directory copy.
// Sources: local file URI (document picker) or a downloaded zip path.

import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { zlib } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { LexiPluginManifest, parsePluginManifest } from './LexiPluginManifest';

export class LexiPluginInstaller {
  private context: common.Context;
  private pluginsRoot: string;

  constructor(context: common.Context, pluginsRoot: string) {
    this.context = context;
    this.pluginsRoot = pluginsRoot;
  }

  private readText(path: string): string {
    return fs.readTextSync(path);
  }

  private writeText(path: string, content: string): void {
    const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(file.fd, content);
    } finally {
      fs.closeSync(file);
    }
  }

  private mkdirp(path: string): void {
    if (!fs.accessSync(path)) { fs.mkdirSync(path, true); }
  }

  /** Extracts a zip (local path or file URI) and installs the plugin into the plugins root. */
  async installZip(zipSource: string): Promise<LexiPluginManifest> {
    const work = `${this.context.cacheDir}/plugin-install-${Date.now()}`;
    this.mkdirp(work);
    let zipPath = zipSource;
    if (zipSource.startsWith('file://') || zipSource.indexOf(':') > 0) {
      zipPath = `${work}/package.zip`;
      fs.copyFileSync(zipSource, zipPath);
    }
    const extractRoot = `${work}/unpacked`;
    this.mkdirp(extractRoot);
    await zlib.decompressFile(zipPath, extractRoot);
    const root = await this.locatePluginRoot(extractRoot);
    if (!root) { throw new Error('安装包中未找到 manifest.json'); }
    const manifest = parsePluginManifest(this.readText(`${root}/manifest.json`));
    const dest = `${this.pluginsRoot}/${manifest.id}`;
    await this.copyTree(root, dest);
    try { fs.rmdirSync(work); } catch { /* 缓存目录残留可接受 */ }
    return manifest;
  }

  private async locatePluginRoot(extractRoot: string): Promise<string> {
    if (fs.accessSync(`${extractRoot}/manifest.json`)) { return extractRoot; }
    const entries = await fs.listFile(extractRoot);
    for (const entry of entries) {
      const candidate = `${extractRoot}/${entry}`;
      const stat = fs.statSync(candidate);
      if (stat.isDirectory() && fs.accessSync(`${candidate}/manifest.json`)) { return candidate; }
    }
    return '';
  }

  private async copyTree(source: string, dest: string): Promise<void> {
    this.mkdirp(dest);
    const entries = await fs.listFile(source);
    for (const entry of entries) {
      const src = `${source}/${entry}`;
      const dst = `${dest}/${entry}`;
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        await this.copyTree(src, dst);
      } else {
        // 不覆盖用户已有的 data.json
        if (entry === 'data.json' && fs.accessSync(dst)) { continue; }
        fs.copyFileSync(src, dst);
      }
    }
  }
}
