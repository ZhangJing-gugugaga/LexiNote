import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { http } from '@kit.NetworkKit';
import { WorkspaceLog } from './WorkspaceLog';

/**
 * 主题存储根: <filesDir>/themes/<id>/
 * 与 <filesDir>/plugins 分开: 主题没有 main.js, manifest 也没有 id (Obsidian 允许),
 * 混进插件扫描目录会被 LexiPluginRuntime 当成损坏插件报错.
 */
const THEME_DIR_NAME: string = 'themes';
const ACTIVE_FILE: string = 'theme-active.json';
const STYLES_FILE: string = 'styles.css';
const MANIFEST_FILE: string = 'manifest.json';
const SHA_CHUNK: number = 65536;
/**
 * 默认安装源(本机夹具服务): 主题 505KB 不进 HAP (否则等于把夹具打进包),
 * hdc 又写不进应用沙箱, 所以安装走 http. 页面把它显示成可编辑输入框,
 * 换成任意静态源即可.
 */
export const DEFAULT_THEME_SOURCE: string = 'http://127.0.0.1:18080/theme-minimal/styles.css';

export interface WorkspaceThemeSummary {
  id: string;
  name: string;
  version: string;
  bytes: number;
  active: boolean;
}

export interface WorkspaceThemeCss {
  id: string;
  name: string;
  css: string;
  bytes: number;
  sha256: string;
}

export interface WorkspaceThemeInstallResult {
  id: string;
  bytes: number;
  sha256: string;
  manifest: boolean;
  source: string;
}

/** 主题 = styles.css + manifest.json (可缺), 没有 id: 目录名就是 id. */
export class WorkspaceThemeCatalog {
  private readonly context: common.Context;

  constructor(context: common.Context) {
    this.context = context;
  }

  root(): string {
    return this.context.filesDir + '/' + THEME_DIR_NAME;
  }

  dirOf(id: string): string {
    return this.root() + '/' + id;
  }

  private ensureRoot(): void {
    const root: string = this.root();
    if (!fs.accessSync(root)) {
      fs.mkdirSync(root, true);
    }
  }

  private ids(): string[] {
    this.ensureRoot();
    const out: string[] = [];
    const entries: string[] = fs.listFileSync(this.root());
    for (const name of entries) {
      const dir: string = this.root() + '/' + name;
      if (fs.statSync(dir).isDirectory() && fs.accessSync(dir + '/' + STYLES_FILE)) {
        out.push(name);
      }
    }
    out.sort();
    return out;
  }

  active(): string {
    const path: string = this.context.filesDir + '/' + ACTIVE_FILE;
    if (!fs.accessSync(path)) {
      return '';
    }
    const parsed: Record<string, Object> = JSON.parse(fs.readTextSync(path)) as Record<string, Object>;
    const id: Object | undefined = parsed['id'];
    return typeof id === 'string' ? id as string : '';
  }

  setActive(id: string): void {
    this.ensureRoot();
    const payload: Record<string, Object> = { 'id': id as Object };
    this.writeTextFile(this.context.filesDir + '/' + ACTIVE_FILE, JSON.stringify(payload));
    WorkspaceLog.info('theme.active', 'id=' + (id.length === 0 ? '(none)' : id));
  }

  list(): WorkspaceThemeSummary[] {
    const current: string = this.active();
    const out: WorkspaceThemeSummary[] = [];
    for (const id of this.ids()) {
      const meta: Record<string, Object> = this.manifestOf(id);
      out.push({
        id: id,
        name: typeof meta['name'] === 'string' ? meta['name'] as string : id,
        version: typeof meta['version'] === 'string' ? meta['version'] as string : '',
        bytes: fs.statSync(this.dirOf(id) + '/' + STYLES_FILE).size,
        active: id === current
      });
    }
    return out;
  }

  private manifestOf(id: string): Record<string, Object> {
    const path: string = this.dirOf(id) + '/' + MANIFEST_FILE;
    if (!fs.accessSync(path)) {
      return {};
    }
    try {
      return JSON.parse(fs.readTextSync(path)) as Record<string, Object>;
    } catch (err) {
      return {};
    }
  }

  load(id: string): WorkspaceThemeCss | null {
    const path: string = this.dirOf(id) + '/' + STYLES_FILE;
    if (id.length === 0 || !fs.accessSync(path)) {
      return null;
    }
    const meta: Record<string, Object> = this.manifestOf(id);
    const css: string = fs.readTextSync(path);
    const measured: WorkspaceThemeCss | null = this.measure(id);
    const bytes: number = measured === null ? 0 : measured.bytes;
    const sha: string = measured === null ? '' : measured.sha256;
    WorkspaceLog.info('theme.css.load',
      'id=' + id + ' bytes=' + bytes + ' chars=' + css.length + ' sha256=' + sha);
    return {
      id: id,
      name: typeof meta['name'] === 'string' ? meta['name'] as string : id,
      css: css,
      bytes: bytes,
      sha256: sha
    };
  }

  /** 原样装入的硬证据: 字节数与 sha256 都从落盘文件重新算, 不信任下载端返回的长度. */
  measure(id: string): WorkspaceThemeCss | null {
    const path: string = this.dirOf(id) + '/' + STYLES_FILE;
    if (id.length === 0 || !fs.accessSync(path)) {
      return null;
    }
    const meta: Record<string, Object> = this.manifestOf(id);
    return {
      id: id,
      name: typeof meta['name'] === 'string' ? meta['name'] as string : id,
      css: '',
      bytes: fs.statSync(path).size,
      sha256: this.sha256Of(path)
    };
  }

  async install(url: string, id: string): Promise<WorkspaceThemeInstallResult> {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('仅支持 http/https 安装源: ' + url);
    }
    const targetId: string = this.sanitize(id.length > 0 ? id : this.idFromUrl(url));
    const dir: string = this.dirOf(targetId);
    if (!fs.accessSync(dir)) {
      fs.mkdirSync(dir, true);
    }
    const payload: ArrayBuffer = await this.download(url);
    this.writeBytesFile(dir + '/' + STYLES_FILE, payload);
    let manifest: boolean = false;
    try {
      const manifestUrl: string = url.substring(0, url.lastIndexOf('/') + 1) + MANIFEST_FILE;
      this.writeBytesFile(dir + '/' + MANIFEST_FILE, await this.download(manifestUrl));
      manifest = true;
    } catch (err) {
      // manifest 可选: 没有 id 字段的 manifest 本来也不能作为身份来源.
      WorkspaceLog.warn('theme.install', 'manifest missing id=' + targetId);
    }
    const measured: WorkspaceThemeCss | null = this.measure(targetId);
    const bytes: number = measured === null ? 0 : measured.bytes;
    const sha: string = measured === null ? '' : measured.sha256;
    WorkspaceLog.info('theme.css.verified',
      'id=' + targetId + ' bytes=' + bytes + ' sha256=' + sha + ' source=' + url);
    return { id: targetId, bytes: bytes, sha256: sha, manifest: manifest, source: url };
  }

  private async download(url: string): Promise<ArrayBuffer> {
    const client = http.createHttp();
    try {
      const response = await client.request(url, {
        method: http.RequestMethod.GET,
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        connectTimeout: 10000,
        readTimeout: 30000
      });
      if (response.responseCode < 200 || response.responseCode >= 300) {
        throw new Error('主题下载失败: HTTP ' + response.responseCode + ' url=' + url);
      }
      return response.result as ArrayBuffer;
    } finally {
      client.destroy();
    }
  }

  private sha256Of(path: string): string {
    const size: number = fs.statSync(path).size;
    const buffer: ArrayBuffer = new ArrayBuffer(size);
    const handle = fs.openSync(path, fs.OpenMode.READ_ONLY);
    try {
      fs.readSync(handle.fd, buffer);
    } finally {
      fs.closeSync(handle);
    }
    const bytes: Uint8Array = new Uint8Array(buffer);
    const md = cryptoFramework.createMd('SHA256');
    let offset: number = 0;
    while (offset < bytes.length) {
      const end: number = Math.min(offset + SHA_CHUNK, bytes.length);
      md.updateSync({ data: bytes.subarray(offset, end) });
      offset = end;
    }
    return this.hex(md.digestSync().data);
  }

  private hex(bytes: Uint8Array): string {
    let out: string = '';
    for (let i: number = 0; i < bytes.length; i++) {
      const part: string = bytes[i].toString(16);
      out += part.length === 1 ? '0' + part : part;
    }
    return out;
  }

  private writeTextFile(path: string, content: string): void {
    const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(file.fd, content);
    } finally {
      fs.closeSync(file);
    }
  }

  private writeBytesFile(path: string, content: ArrayBuffer): void {
    const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(file.fd, content);
    } finally {
      fs.closeSync(file);
    }
  }

  private idFromUrl(url: string): string {
    const cleaned: string = url.split('?')[0].replace(/\/+$/, '');
    const cut: number = cleaned.lastIndexOf('/');
    const parent: string = cut > 0 ? cleaned.substring(0, cut) : cleaned;
    const parentCut: number = parent.lastIndexOf('/');
    return parentCut >= 0 ? parent.substring(parentCut + 1) : 'theme';
  }

  private sanitize(id: string): string {
    let out: string = '';
    for (let i: number = 0; i < id.length; i++) {
      const ch: string = id.charAt(i);
      const ok: boolean = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
        (ch >= '0' && ch <= '9') || ch === '.' || ch === '_' || ch === '-';
      out += ok ? ch : '-';
    }
    return out.length === 0 ? 'theme' : out;
  }
}
