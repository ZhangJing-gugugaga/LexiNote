// Plugin runtime: ArkWeb transport plus the plugin manager.
// The JS shim (rawfile/lexinote_plugin_shim.js) mirrors this protocol; every payload is a JSON string.

import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { LexiStorageService } from '../LexiStorageService';
import { LexiPluginBus } from './LexiPluginBus';
import { LexiCommandRegistry, LexiEvents, LexiPluginCommand } from './LexiPluginKernel';
import { LexiInstalledPlugin, LexiPluginManifest, manifestCompatible, parsePluginManifest } from './LexiPluginManifest';
import { LexiMetadataCache } from './LexiMetadataCache';
import { LexiVaultFacade } from './LexiVaultFacade';
import { LexiTFolder, LexiTFile } from './LexiVaultModel';
import { LexiEditorRegistry } from './LexiEditorRegistry';
import { LexiPluginViewInfo, LexiPluginViewRegistry } from './LexiPluginViewRegistry';
import { LexiPluginInstaller } from './LexiPluginInstaller';
import { LexiPluginMarketEntry, parseMarketIndex } from './LexiPluginMarketModel';

const LOAD_TIMEOUT_MS: number = 5000;
const PLUGIN_DIR_NAME: string = 'plugins';
const KEY_ENABLED: string = 'lexiPluginEnabled';
const KEY_SAFE_MODE: string = 'lexiPluginSafeMode';
const SAMPLE_DIR: string = 'plugins/lexi-sample-plugin';
const HI_DOMAIN: number = 0x1051;
const HI_TAG: string = 'LexiPlugin';

function pluginLog(message: string): void {
  hilog.info(HI_DOMAIN, HI_TAG, '%{public}s', message);
}

function pluginError(message: string): void {
  hilog.error(HI_DOMAIN, HI_TAG, '%{public}s', message);
}

export interface LexiRuntimeUiHost {
  toast(message: string): void;
}

class CallbackUiHost implements LexiRuntimeUiHost {
  private handler: (message: string) => void;

  constructor(handler: (message: string) => void) {
    this.handler = handler;
  }

  toast(message: string): void {
    this.handler(message);
  }
}

function fileToJson(file: LexiTFile): Record<string, Object> {
  const stat: Record<string, Object> = {
    'ctime': file.stat.ctime as Object,
    'mtime': file.stat.mtime as Object,
    'size': file.stat.size as Object
  };
  return {
    'kind': 'file' as Object,
    'path': file.path as Object,
    'name': file.name as Object,
    'basename': file.basename as Object,
    'extension': file.extension as Object,
    'noteId': file.noteId as Object,
    'vaultId': file.vaultId as Object,
    'projectId': file.projectId as Object,
    'notebook': file.notebook as Object,
    'stat': stat as Object
  };
}

function folderToJson(folder: LexiTFolder): Record<string, Object> {
  return { 'kind': 'folder' as Object, 'path': folder.path as Object, 'name': folder.name as Object };
}

class RpcResponse {
  ok: boolean = false;
  result: Object | null = null;
  error: string = '';
}

function okResponse(result: Object | null): string {
  const body = new RpcResponse();
  body.ok = true;
  body.result = result;
  return JSON.stringify(body);
}

function failResponse(error: string): string {
  const body = new RpcResponse();
  body.ok = false;
  body.error = error;
  return JSON.stringify(body);
}

/** ArkWeb transport. The Web component exposes `call` as `lexiHost` inside the runtime page. */
export class LexiWebRuntime {
  private controller: webview.WebviewController | null = null;
  private handlers: Map<string, (payloadJson: string) => Promise<string>> = new Map();
  private ready: boolean = false;
  private readyWaiters: Array<() => void> = [];

  attach(controller: webview.WebviewController): void {
    this.controller = controller;
  }

  registerHandler(method: string, handler: (payloadJson: string) => Promise<string>): void {
    this.handlers.set(method, handler);
  }

  markReady(): void {
    this.ready = true;
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) { waiter(); }
  }

  isReady(): boolean {
    return this.ready;
  }

  async waitReady(): Promise<void> {
    if (this.ready) { return; }
    await new Promise<void>((resolve: () => void) => { this.readyWaiters.push(resolve); });
  }

  /** javaScriptProxy entry point (exposed as window.lexiHost.call). */
  async call(_callId: string, method: string, payloadJson: string): Promise<string> {
    const handler = this.handlers.get(method);
    if (!handler) { return failResponse(`未知插件通道: ${method}`); }
    try {
      return await handler(payloadJson);
    } catch (error) {
      return failResponse(String(error));
    }
  }

  async dispatch(method: string, payloadJson: string): Promise<void> {
    if (!this.controller || !this.ready) { throw new Error('插件运行时未就绪'); }
    const script = `window.lexiRuntime && window.lexiRuntime.__receive(${JSON.stringify(method)}, ${JSON.stringify(payloadJson)})`;
    await this.controller.runJavaScript(script);
  }

  async dispatchWithTimeout(method: string, payloadJson: string, timeoutMs: number): Promise<void> {
    const work = this.dispatch(method, payloadJson);
    await LexiWebRuntime.withTimeout(work, timeoutMs, method);
  }

  static async withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: number = -1;
    const timeout = new Promise<T>((_resolve: (value: T) => void, reject: (reason: Error) => void): void => {
      timer = setTimeout((): void => { reject(new Error(`插件操作超时: ${label}`)); }, timeoutMs);
    });
    try {
      return await Promise.race<T>([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

type RpcRequest = Record<string, Object>;

function rpcString(payload: RpcRequest, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

function rpcBool(payload: RpcRequest, key: string): boolean {
  const value = payload[key];
  return value === true;
}

function rpcNumber(payload: RpcRequest, key: string): number {
  const value = payload[key];
  return typeof value === 'number' ? value : 0;
}

export class LexiPluginManager {
  private static instanceRef: LexiPluginManager | null = null;

  readonly runtime: LexiWebRuntime = new LexiWebRuntime();
  readonly commands: LexiCommandRegistry = new LexiCommandRegistry();
  readonly workspaceEvents: LexiEvents = new LexiEvents();
  vault: LexiVaultFacade = new LexiVaultFacade();
  metadata: LexiMetadataCache | null = null;

  private context: common.Context | null = null;
  private uiHost: LexiRuntimeUiHost | null = null;
  private plugins: Map<string, LexiInstalledPlugin> = new Map();
  private enabledIds: Set<string> = new Set();
  private safeMode: boolean = false;
  private ready: boolean = false;
  private pendingOnload: Map<string, () => void> = new Map();
  private pendingUnload: Map<string, () => void> = new Map();
  private viewOpenHandler: ((viewType: string) => void) | null = null;
  private viewCloseHandler: ((viewType: string) => void) | null = null;
  private pendingViewOpens: string[] = [];

  static get shared(): LexiPluginManager | null {
    return LexiPluginManager.instanceRef;
  }

  static async createShared(context: common.Context): Promise<LexiPluginManager> {
    if (LexiPluginManager.instanceRef) { return LexiPluginManager.instanceRef; }
    const manager = new LexiPluginManager();
    LexiPluginManager.instanceRef = manager;
    await manager.init(context);
    return manager;
  }

  setUiHost(host: LexiRuntimeUiHost): void {
    this.uiHost = host;
  }

  setToastHandler(handler: (message: string) => void): void {
    this.uiHost = new CallbackUiHost(handler);
  }

  /** Workspace supplies the tab opener; plugins request views through workspace.openView. */
  setViewOpenHandler(handler: (viewType: string) => void): void {
    this.viewOpenHandler = handler;
    const pending = this.pendingViewOpens;
    this.pendingViewOpens = [];
    for (const type of pending) { handler(type); }
  }

  private requestViewOpen(type: string): void {
    if (this.viewOpenHandler) { this.viewOpenHandler(type); return; }
    this.pendingViewOpens.push(type);
  }

  setViewCloseHandler(handler: (viewType: string) => void): void {
    this.viewCloseHandler = handler;
  }

  /** Boot payload for a plugin view slot web page. */
  viewBootPayload(pluginId: string, viewType: string): string {
    const record = this.plugins.get(pluginId);
    if (!record) { return ''; }
    let code = '';
    let stylesCss = '';
    try { code = this.readTextFile(`${record.dir}/main.js`); } catch { /* missing code keeps the slot empty */ }
    try {
      if (fs.accessSync(`${record.dir}/styles.css`)) { stylesCss = this.readTextFile(`${record.dir}/styles.css`); }
    } catch { /* styles are optional */ }
    const body: Record<string, Object> = {
      'manifestJson': JSON.stringify(record.manifest) as Object,
      'code': code as Object,
      'viewType': viewType as Object,
      'stylesCss': stylesCss as Object
    };
    return JSON.stringify(body);
  }

  isSafeMode(): boolean {
    return this.safeMode;
  }

  async setSafeMode(safeMode: boolean): Promise<void> {
    this.safeMode = safeMode;
    if (safeMode) {
      const ids: string[] = [];
      this.enabledIds.forEach((id: string): void => { ids.push(id); });
      for (const id of ids) { await this.disablePlugin(id); }
    }
    await this.persistSafeMode();
  }

  installedPlugins(): LexiInstalledPlugin[] {
    const result: LexiInstalledPlugin[] = [];
    this.plugins.forEach((plugin: LexiInstalledPlugin): void => { result.push(plugin); });
    return result;
  }

  private ensureInstaller(): LexiPluginInstaller {
    if (!this.context) { throw new Error('插件管理器尚未初始化'); }
    return new LexiPluginInstaller(this.context, this.pluginsRoot());
  }

  /** Installs a plugin from a local zip (path or file URI), rescans and enables it. */
  async installZip(zipSource: string): Promise<string> {
    const manifest = await this.ensureInstaller().installZip(zipSource);
    await this.scanPluginDir();
    pluginLog('插件安装完成: ' + manifest.id + ' v' + manifest.version);
    await this.enablePlugin(manifest.id);
    return manifest.id;
  }

  /** Downloads a plugin zip and installs it. */
  async installFromUrl(url: string): Promise<string> {
    if (!this.context) { throw new Error('插件管理器尚未初始化'); }
    if (!/^https?:\/\//i.test(url)) { throw new Error('仅支持 http/https 下载地址'); }
    const cachePath = `${this.context.cacheDir}/plugin-download-${Date.now()}.zip`;
    const client = http.createHttp();
    try {
      const response = await client.request(url, {
        method: http.RequestMethod.GET,
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        connectTimeout: 20000,
        readTimeout: 60000
      });
      if (response.responseCode < 200 || response.responseCode >= 300) {
        throw new Error('插件下载失败: HTTP ' + response.responseCode);
      }
      const buffer = response.result as ArrayBuffer;
      const file = fs.openSync(cachePath, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      try { fs.writeSync(file.fd, buffer); } finally { fs.closeSync(file); }
    } finally {
      client.destroy();
    }
    return this.installZip(cachePath);
  }

  /** Fetches and parses a community plugin index. */
  async fetchMarket(indexUrl: string): Promise<LexiPluginMarketEntry[]> {
    const client = http.createHttp();
    try {
      const response = await client.request(indexUrl, {
        method: http.RequestMethod.GET,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 10000,
        readTimeout: 20000
      });
      if (response.responseCode < 200 || response.responseCode >= 300) {
        throw new Error('市场索引请求失败: HTTP ' + response.responseCode);
      }
      const text = typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
      const entries = parseMarketIndex(text);
      pluginLog('市场索引加载: ' + entries.length + ' 个插件');
      return entries;
    } finally {
      client.destroy();
    }
  }

  private async init(context: common.Context): Promise<void> {
    this.context = context;
    await LexiStorageService.init(context);
    this.vault = new LexiVaultFacade();
    await this.vault.init(context);
    this.metadata = new LexiMetadataCache(this.vault);
    this.safeMode = (await LexiStorageService.getSetting(KEY_SAFE_MODE, 'false')) === 'true';
    const enabledRaw = await LexiStorageService.getSetting(KEY_ENABLED, '[]');
    try {
      const parsed = JSON.parse(enabledRaw) as string[];
      if (Array.isArray(parsed)) {
        for (const id of parsed) { this.enabledIds.add(id); }
      }
    } catch { /* a corrupted enable list falls back to none */ }
    await this.installBundledSamples();
    await this.scanPluginDir();
    // 首次运行自动启用官方示范插件(仅一次;用户可在设置中停用)
    const bundledInit = await LexiStorageService.getSetting('lexiPluginBundledInit', 'false');
    if (bundledInit !== 'true' && !this.safeMode && this.plugins.has('lexi-sample-plugin')) {
      this.enabledIds.add('lexi-sample-plugin');
      await LexiStorageService.setSetting('lexiPluginBundledInit', 'true');
      pluginLog('首次运行:自动启用官方示范插件');
    }
    pluginLog('插件管理器初始化完成: 已发现 ' + this.plugins.size + ' 个插件, safeMode=' + this.safeMode);
    this.registerRpcHandlers();
    this.workspaceEvents.trigger('layout-change', null);
  }

  private pluginsRoot(): string {
    if (!this.context) { throw new Error('插件管理器尚未初始化'); }
    return `${this.context.filesDir}/${PLUGIN_DIR_NAME}`;
  }

  private async installBundledSamples(): Promise<void> {
    if (!this.context) { return; }
    try {
      const resource = this.context.resourceManager;
      const manifestBuffer = await resource.getRawFileContent(`${SAMPLE_DIR}/manifest.json`);
      const codeBuffer = await resource.getRawFileContent(`${SAMPLE_DIR}/main.js`);
      const decoder = new util.TextDecoder('utf-8');
      const manifestJson = decoder.decodeToString(new Uint8Array(manifestBuffer));
      const code = decoder.decodeToString(new Uint8Array(codeBuffer));
      let stylesCss = '';
      try {
        const stylesBuffer = await resource.getRawFileContent(`${SAMPLE_DIR}/styles.css`);
        stylesCss = decoder.decodeToString(new Uint8Array(stylesBuffer));
      } catch { /* styles.css 可选 */ }
      const dir = `${this.pluginsRoot()}/lexi-sample-plugin`;
      if (!fs.accessSync(dir)) { fs.mkdirSync(dir, true); }
      // 内置示范插件随应用版本更新:始终覆盖清单与代码,但保留其 data.json 用户配置
      this.writeTextFile(`${dir}/manifest.json`, manifestJson);
      this.writeTextFile(`${dir}/main.js`, code);
      if (stylesCss.length > 0) { this.writeTextFile(`${dir}/styles.css`, stylesCss); }
    } catch { /* sample assets are optional; the manager still works without them */ }
  }

  private writeTextFile(path: string, content: string): void {
    const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(file.fd, content);
    } finally {
      fs.closeSync(file);
    }
  }

  private async scanPluginDir(): Promise<void> {
    const root = this.pluginsRoot();
    if (!fs.accessSync(root)) { fs.mkdirSync(root, true); }
    const entries = await fs.listFile(root);
    for (const entry of entries) {
      const dir = `${root}/${entry}`;
      const manifestPath = `${dir}/manifest.json`;
      if (!fs.accessSync(manifestPath)) { continue; }
      try {
        const manifest = parsePluginManifest(this.readTextFile(manifestPath));
        const record = new LexiInstalledPlugin();
        record.manifest = manifest;
        record.dir = dir;
        record.enabled = false;
        this.plugins.set(manifest.id, record);
      } catch (error) {
        const broken = new LexiInstalledPlugin();
        broken.manifest.id = entry;
        broken.dir = dir;
        broken.errorState = String(error);
        this.plugins.set(`broken:${entry}`, broken);
      }
    }
  }

  private readTextFile(path: string): string {
    return fs.readTextSync(path);
  }

  private registerRpcHandlers(): void {
    const runtime = this.runtime;
    const manager = this;
    runtime.registerHandler('runtime.ready', async (_payload: string): Promise<string> => {
      pluginLog('runtime.ready 收到,插件垫片握手成功');
      manager.ready = true;
      runtime.markReady();
      await manager.enableRestoredPlugins();
      return okResponse(null);
    });
    runtime.registerHandler('plugin.onload.done', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const id = rpcString(request, 'id');
      pluginLog('插件 onload 完成: ' + id);
      const waiter = manager.pendingOnload.get(id);
      if (waiter) { manager.pendingOnload.delete(id); waiter(); }
      return okResponse(null);
    });
    runtime.registerHandler('plugin.onload.error', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const record = manager.plugins.get(rpcString(request, 'id'));
      if (record) { record.errorState = rpcString(request, 'error'); }
      const id = rpcString(request, 'id');
      const waiter = manager.pendingOnload.get(id);
      if (waiter) { manager.pendingOnload.delete(id); waiter(); }
      return okResponse(null);
    });
    runtime.registerHandler('plugin.unload.done', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const id = rpcString(request, 'id');
      const waiter = manager.pendingUnload.get(id);
      if (waiter) { manager.pendingUnload.delete(id); waiter(); }
      return okResponse(null);
    });
    runtime.registerHandler('commands.add', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const pluginId = rpcString(request, 'pluginId');
      const rawCommand = request['command'] as RpcRequest;
      if (!pluginId || !rawCommand) { return failResponse('命令注册缺少参数'); }
      const editorOnly = rpcBool(rawCommand, 'editorOnly');
      const spec: LexiPluginCommand = {
        id: rpcString(rawCommand, 'id'),
        name: rpcString(rawCommand, 'name'),
        icon: rpcString(rawCommand, 'icon'),
        editorOnly: editorOnly,
        callback: (): Promise<void> => editorOnly
          ? manager.invokeEditorCommand(pluginId, `${pluginId}:${rpcString(rawCommand, 'id')}`)
          : manager.invokePluginCommand(pluginId, `${pluginId}:${rpcString(rawCommand, 'id')}`)
      };
      manager.commands.registerPluginCommand(pluginId, spec);
      pluginLog('插件命令注册: ' + pluginId + ':' + rpcString(rawCommand, 'id') + (editorOnly ? ' (编辑器)' : ''));
      return okResponse(null);
    });
    runtime.registerHandler('commands.remove', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      manager.commands.removePluginCommand(rpcString(request, 'fullId'));
      return okResponse(null);
    });
    runtime.registerHandler('events.on', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      manager.subscribeHostEvent(rpcNumber(request, 'refId'), rpcString(request, 'topic'), rpcString(request, 'name'));
      return okResponse(rpcNumber(request, 'refId') as Object);
    });
    runtime.registerHandler('events.off', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      manager.unsubscribeHostEvent(rpcNumber(request, 'refId'));
      return okResponse(null);
    });
    runtime.registerHandler('ui.notice', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      pluginLog('插件通知: ' + rpcString(request, 'message'));
      if (manager.uiHost) { manager.uiHost.toast(rpcString(request, 'message')); }
      return okResponse(manager.uiHost !== null);
    });
    runtime.registerHandler('ui.placeholder', async (_payload: string): Promise<string> => {
      return okResponse('rendered-in-p1');
    });
    runtime.registerHandler('views.add', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const info = new LexiPluginViewInfo();
      info.pluginId = rpcString(request, 'pluginId');
      info.type = rpcString(request, 'type');
      info.displayName = rpcString(request, 'displayName');
      info.icon = rpcString(request, 'icon');
      LexiPluginViewRegistry.register(info);
      pluginLog('插件视图注册: ' + info.type + ' → ' + info.displayName);
      return okResponse(null);
    });
    runtime.registerHandler('views.remove', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      LexiPluginViewRegistry.remove(rpcString(request, 'type'));
      return okResponse(null);
    });
    runtime.registerHandler('workspace.openView', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const type = rpcString(request, 'type');
      const info = LexiPluginViewRegistry.get(type);
      if (!info) { return failResponse('未注册的插件视图: ' + type); }
      manager.requestViewOpen(type);
      return okResponse(info.displayName as Object);
    });
    runtime.registerHandler('workspace.closeView', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const type = rpcString(request, 'type');
      if (manager.viewCloseHandler) { manager.viewCloseHandler(type); }
      return okResponse(null);
    });
    runtime.registerHandler('data.load', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const pluginId = rpcString(request, 'pluginId');
      const path = `${manager.pluginsRoot()}/${pluginId}/data.json`;
      if (!fs.accessSync(path)) { return okResponse(null); }
      return okResponse(manager.readTextFile(path) as Object);
    });
    runtime.registerHandler('data.save', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const pluginId = rpcString(request, 'pluginId');
      if (!pluginId) { return failResponse('缺少插件 id'); }
      const dir = `${manager.pluginsRoot()}/${pluginId}`;
      if (!fs.accessSync(dir)) { fs.mkdirSync(dir, true); }
      manager.writeTextFile(`${dir}/data.json`, rpcString(request, 'dataJson'));
      return okResponse(null);
    });
    runtime.registerHandler('app.isDarkMode', async (_payload: string): Promise<string> => {
      return okResponse((AppStorage.get<number>('lexiColorMode') || 0) === 1);
    });
    runtime.registerHandler('net.requestUrl', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      return manager.performRequest(request);
    });
    manager.registerVaultHandlers();
    manager.registerMetadataHandlers();
    manager.registerEditorHandlers();
  }

  private registerEditorHandlers(): void {
    const manager = this;
    const runtime = this.runtime;
    runtime.registerHandler('editor.state', async (_payload: string): Promise<string> => {
      return okResponse(manager.editorStateJson() as Object);
    });
    runtime.registerHandler('editor.replace', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const controller = LexiEditorRegistry.activeController();
      if (!controller) { return failResponse('当前没有打开的编辑器'); }
      controller.replaceRange(rpcNumber(request, 'start'), rpcNumber(request, 'end'), rpcString(request, 'text'));
      return okResponse(manager.editorStateJson() as Object);
    });
    runtime.registerHandler('editor.selection', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const controller = LexiEditorRegistry.activeController();
      if (!controller) { return failResponse('当前没有打开的编辑器'); }
      controller.setTextSelection(rpcNumber(request, 'start'), rpcNumber(request, 'end'));
      return okResponse(manager.editorStateJson() as Object);
    });
  }

  private registerVaultHandlers(): void {
    const manager = this;
    const runtime = this.runtime;
    runtime.registerHandler('vault.files', async (_payload: string): Promise<string> => {
      const files = await manager.vault.getMarkdownFiles();
      return okResponse(files.map((file: LexiTFile): Record<string, Object> => fileToJson(file)) as Object);
    });
    runtime.registerHandler('vault.getByPath', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const node = manager.vault.getAbstractFileByPath(rpcString(request, 'path'));
      if (!node) { return okResponse(null); }
      return okResponse(node.kind === 'file' ? fileToJson(node as LexiTFile) : folderToJson(node as LexiTFolder));
    });
    runtime.registerHandler('vault.read', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const file = manager.vault.getFileByPath(rpcString(request, 'path'));
      if (!file) { return failResponse('文件不存在'); }
      return okResponse(await manager.vault.read(file));
    });
    runtime.registerHandler('vault.modify', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const file = manager.vault.getFileByPath(rpcString(request, 'path'));
      if (!file) { return failResponse('文件不存在'); }
      await manager.vault.modify(file, rpcString(request, 'data'));
      return okResponse(null);
    });
    runtime.registerHandler('vault.create', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const file = await manager.vault.create(rpcString(request, 'path'), rpcString(request, 'data'));
      return okResponse(fileToJson(file));
    });
    runtime.registerHandler('vault.delete', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const file = manager.vault.getFileByPath(rpcString(request, 'path'));
      if (!file) { return failResponse('文件不存在'); }
      await manager.vault.delete(file, rpcBool(request, 'force'));
      return okResponse(null);
    });
    runtime.registerHandler('vault.rename', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const file = manager.vault.getFileByPath(rpcString(request, 'path'));
      if (!file) { return failResponse('文件不存在'); }
      await manager.vault.rename(file, rpcString(request, 'newPath'));
      return okResponse(null);
    });
    runtime.registerHandler('vault.append', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const file = manager.vault.getFileByPath(rpcString(request, 'path'));
      if (!file) { return failResponse('文件不存在'); }
      await manager.vault.append(file, rpcString(request, 'data'));
      return okResponse(null);
    });
  }

  private registerMetadataHandlers(): void {
    const manager = this;
    const runtime = this.runtime;
    runtime.registerHandler('metadata.get', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      if (!manager.metadata) { return failResponse('元数据服务未就绪'); }
      const cache = manager.metadata.getCache(rpcString(request, 'path'));
      return okResponse(cache ? (cache as Object) : null);
    });
    runtime.registerHandler('metadata.firstLink', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      if (!manager.metadata) { return failResponse('元数据服务未就绪'); }
      const file = manager.metadata.getFirstLinkpathDest(rpcString(request, 'linkpath'), rpcString(request, 'sourcePath'));
      return okResponse(file ? fileToJson(file) : null);
    });
    runtime.registerHandler('metadata.resolved', async (_payload: string): Promise<string> => {
      if (!manager.metadata) { return failResponse('元数据服务未就绪'); }
      return okResponse(manager.metadata.resolvedLinks() as Object);
    });
  }

  private hostEventFor(topic: string): LexiEvents | null {
    if (topic === 'vault') { return this.vault.events; }
    if (topic === 'metadata' && this.metadata) { return this.metadata.events; }
    if (topic === 'workspace') { return this.workspaceEvents; }
    return null;
  }

  private subscribeHostEvent(refId: number, topic: string, name: string): number {
    const events = this.hostEventFor(topic);
    if (!events || refId <= 0) { return -1; }
    const runtime = this.runtime;
    const listener = (payload: Object | null): void => {
      const body: Record<string, Object> = {
        'topic': topic as Object,
        'name': name as Object,
        'payload': (payload === null ? null : payload) as Object
      };
      pluginLog(`转发宿主事件 → 插件: ${topic}/${name}`);
      runtime.dispatch('event', JSON.stringify(body)).catch((error: Error): void => {
        pluginError('事件转发失败: ' + String(error));
      });
    };
    events.on(name, listener);
    this.hostEventListeners.set(refId, { events: events, name: name, listener: listener });
    return refId;
  }

  private hostEventListeners: Map<number, HostEventSubscription> = new Map();

  private unsubscribeHostEvent(refId: number): void {
    const subscription = this.hostEventListeners.get(refId);
    if (!subscription) { return; }
    subscription.events.off(subscription.name, subscription.listener);
    this.hostEventListeners.delete(refId);
  }

  private async performRequest(request: RpcRequest): Promise<string> {
    const url = rpcString(request, 'url');
    if (!url) { return failResponse('缺少 url'); }
    const client = http.createHttp();
    try {
      const method = rpcString(request, 'method') || 'GET';
      const headers: Record<string, string> = {};
      const rawHeaders = request['headers'] as Record<string, string> | undefined;
      if (rawHeaders) {
        for (const key of Object.keys(rawHeaders)) { headers[key] = String(rawHeaders[key]); }
      }
      const response = await client.request(url, {
        method: (method.toUpperCase() === 'POST' ? http.RequestMethod.POST : http.RequestMethod.GET),
        header: headers,
        extraData: rpcString(request, 'body') || undefined,
        connectTimeout: 15000,
        readTimeout: 15000
      });
      const headersOut: Record<string, Object> = {};
      const rawOut = response.header as Record<string, string> | undefined;
      if (rawOut) {
        for (const key of Object.keys(rawOut)) { headersOut[key] = String(rawOut[key]) as Object; }
      }
      const bodyText = typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
      const result: Record<string, Object> = {
        'status': response.responseCode as Object,
        'headers': headersOut as Object,
        'text': bodyText as Object
      };
      return okResponse(result);
    } catch (error) {
      return failResponse(String(error));
    } finally {
      client.destroy();
    }
  }

  private async invokePluginCommand(pluginId: string, fullId: string): Promise<void> {
    const body: Record<string, Object> = { 'fullId': fullId as Object, 'pluginId': pluginId as Object };
    await this.runtime.dispatchWithTimeout('invoke.command', JSON.stringify(body), LOAD_TIMEOUT_MS).catch((): void => {});
  }

  private editorStateJson(): Record<string, Object> {
    const controller = LexiEditorRegistry.activeController();
    const body: Record<string, Object> = { 'active': controller !== null };
    if (controller) {
      const selection = controller.getSelection();
      const sel: Record<string, Object> = {
        'start': selection.start as Object,
        'end': selection.end as Object
      };
      body['noteId'] = LexiEditorRegistry.activeNote() as Object;
      body['text'] = controller.getText() as Object;
      body['selection'] = sel as Object;
    }
    return body;
  }

  private async invokeEditorCommand(pluginId: string, fullId: string): Promise<void> {
    const controller = LexiEditorRegistry.activeController();
    pluginLog('派发编辑器命令: ' + fullId + ' 编辑器=' + (controller !== null ? LexiEditorRegistry.activeNote() : '无'));
    if (!controller) { return; }
    const body: Record<string, Object> = {
      'fullId': fullId as Object,
      'pluginId': pluginId as Object,
      'editor': this.editorStateJson() as Object
    };
    await this.runtime.dispatchWithTimeout('invoke.editorCommand', JSON.stringify(body), LOAD_TIMEOUT_MS).catch((error: Error): void => {
      pluginError('编辑器命令派发失败: ' + String(error));
    });
  }

  /** Palette/workspace fallback entry: executes a plugin command and reports whether it existed. */
  static async tryExecuteCommand(fullId: string): Promise<boolean> {
    const manager = LexiPluginManager.shared;
    if (!manager || manager.safeMode || !manager.ready) { return false; }
    const command = manager.commands.get(fullId);
    if (!command) { return false; }
    const colon = fullId.indexOf(':');
    if (colon <= 0) { return false; }
    if (command.editorOnly) {
      if (!LexiEditorRegistry.hasActive()) { return false; }
      await manager.invokeEditorCommand(fullId.substring(0, colon), fullId);
      return true;
    }
    await manager.invokePluginCommand(fullId.substring(0, colon), fullId);
    return true;
  }

  static commandList(): LexiPluginCommand[] {
    const manager = LexiPluginManager.shared;
    if (!manager) { return []; }
    const hasEditor = LexiEditorRegistry.hasActive();
    return manager.commands.list().filter((command: LexiPluginCommand): boolean => !command.editorOnly || hasEditor);
  }

  async attachRuntime(controller: webview.WebviewController): Promise<void> {
    this.runtime.attach(controller);
  }

  notifyRuntimePageLoaded(): void {
    // The shim itself calls runtime.ready once lexiHost answers; nothing to do eagerly.
  }

  private async enableRestoredPlugins(): Promise<void> {
    if (this.safeMode) { return; }
    const ids: string[] = [];
    this.enabledIds.forEach((id: string): void => { ids.push(id); });
    for (const id of ids) {
      await this.enablePlugin(id).catch((): void => {});
    }
  }

  async enablePlugin(pluginId: string): Promise<boolean> {
    pluginLog('请求启用插件: ' + pluginId + ' safeMode=' + this.safeMode);
    if (this.safeMode) { return false; }
    const record = this.plugins.get(pluginId);
    if (!record || record.enabled) { return false; }
    if (!manifestCompatible(record.manifest)) {
      record.errorState = `需要 LexiNote ${record.manifest.minAppVersion} 及以上`;
      return false;
    }
    const mainPath = `${record.dir}/main.js`;
    if (!fs.accessSync(mainPath)) {
      record.errorState = '插件缺少 main.js';
      return false;
    }
    try {
      const code = this.readTextFile(mainPath);
      const payloadBody: Record<string, Object> = { 'manifest': record.manifest as Object, 'code': code as Object };
      const payload = JSON.stringify(payloadBody);
      const done = new Promise<void>((resolve: () => void): void => { this.pendingOnload.set(pluginId, resolve); });
      await this.runtime.waitReady();
      await this.runtime.dispatchWithTimeout('load.plugin', payload, LOAD_TIMEOUT_MS);
      await LexiWebRuntime.withTimeout(done, LOAD_TIMEOUT_MS, 'onload');
      record.enabled = true;
      record.errorState = '';
      this.enabledIds.add(pluginId);
      await this.persistEnabled();
      pluginLog('插件已启用: ' + pluginId);
      return true;
    } catch (error) {
      record.errorState = String(error);
      pluginError('插件启用失败 ' + pluginId + ': ' + String(error));
      this.pendingOnload.delete(pluginId);
      return false;
    }
  }

  async disablePlugin(pluginId: string): Promise<void> {
    const record = this.plugins.get(pluginId);
    pluginLog('请求停用插件: ' + pluginId + ' (当前启用=' + (record ? record.enabled : false) + ')');
    if (!record || !record.enabled) { return; }
    try {
      await this.runtime.waitReady();
      const done = new Promise<void>((resolve: () => void): void => { this.pendingUnload.set(pluginId, resolve); });
      const unloadBody: Record<string, Object> = { 'id': pluginId as Object };
      await this.runtime.dispatchWithTimeout('unload.plugin', JSON.stringify(unloadBody), LOAD_TIMEOUT_MS);
      await LexiWebRuntime.withTimeout(done, LOAD_TIMEOUT_MS, 'onunload');
    } catch { /* force removal locally even if the runtime page is gone */ }
    this.pendingUnload.delete(pluginId);
    record.enabled = false;
    this.commands.removePluginCommands(pluginId);
    LexiPluginViewRegistry.removePlugin(pluginId);
    this.enabledIds.delete(pluginId);
    await this.persistEnabled();
    pluginLog('插件已停用: ' + pluginId);
  }

  private async persistEnabled(): Promise<void> {
    const ids: string[] = [];
    this.enabledIds.forEach((id: string): void => { ids.push(id); });
    await LexiStorageService.setSetting(KEY_ENABLED, JSON.stringify(ids));
  }

  private async persistSafeMode(): Promise<void> {
    await LexiStorageService.setSetting(KEY_SAFE_MODE, this.safeMode ? 'true' : 'false');
  }
}

class HostEventSubscription {
  events: LexiEvents = new LexiEvents();
  name: string = '';
  listener: (payload: Object | null) => void = (_payload: Object | null): void => {};
}
