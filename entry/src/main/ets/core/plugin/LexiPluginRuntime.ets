// Plugin runtime: ArkWeb transport plus the plugin manager.
// The JS shim (rawfile/lexinote_plugin_shim.js) mirrors this protocol; every payload is a JSON string.

import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { webview } from '@kit.ArkWeb';
import { LexiContextRegistry, HostContextRecord } from './LexiContextRegistry';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { LexiStorageService } from '../LexiStorageService';
import { LexiPluginBus } from './LexiPluginBus';
import { LexiCommandRegistry, LexiEvents, LexiPluginCommand } from './LexiPluginKernel';
import {
  LexiInstalledPlugin,
  LexiPluginManifest,
  LexiCapabilityDecision,
  manifestCompatMessage,
  parsePluginManifest,
  checkFsCapability,
  vaultPathAllowed,
  ERROR_CAPABILITY_DENIED
} from './LexiPluginManifest';
import { capabilityTagsOfV2Caps } from './LexiPluginManifestV2';
import {
  LexiNetDeps,
  LexiNetOutcome,
  LexiNetResponse,
  LexiNetTransport,
  NET_TIMEOUT_MS,
  executeNetRequest
} from './LexiNetProbe';
import { LexiMetadataCache } from './LexiMetadataCache';
import { LexiVaultFacade } from './LexiVaultFacade';
import { LexiTFolder, LexiTFile } from './LexiVaultModel';
import { LexiEditorRegistry } from './LexiEditorRegistry';
import { LexiPluginViewInfo, LexiPluginViewRegistry } from './LexiPluginViewRegistry';
import { LexiEditorPosUtil, LexiEditorPosition } from './LexiEditorPos';
import { LexiPluginInstaller, PluginLifecycleOutcome } from './LexiPluginInstaller';
import { LexiPluginMarketEntry, LexiMarketIndexResult, parseMarketIndexResult, isTrustedInstallHash } from './LexiPluginMarketModel';
import { LexiPluginSettingDef, parseSettingDefinitions } from './LexiPluginSettingModel';
import { mintCredential } from './LexiCredentialFactory';
import {
  LexiAuthzResource,
  LexiCallerContext,
  LexiCallerRole,
  LexiAuthzDecision,
  LexiPermissionBroker
} from './LexiPermissionBroker';
import { LexiPluginLifecycleManager } from './LexiPluginLifecycleManager';
import { LexiContextKind } from './LexiPluginExecutionContext';
import { LexiExtensionRegistry } from './LexiExtensionRegistry';
import { LexiPermissionStore, PERMISSION_GRANTED, PERMISSION_REGRANT_REQUIRED } from './LexiPermissionStore';
import { LexiViewSessionTable } from './LexiViewSessionState';
import { LexiInspectorInput, LexiInspectorReport, LexiPluginInspector } from './LexiPluginInspector';

const LOAD_TIMEOUT_MS: number = 20000;
/** 源码分片通道的身份错误码:与 capability_denied / integrity_mismatch 区分开,便于定点断言。 */
const ERROR_IDENTITY_UNTRUSTED: string = 'identity_untrusted';
const SOURCE_CHUNK_SIZE: number = 48 * 1024;
const PLUGIN_DIR_NAME: string = 'plugins';
const KEY_ENABLED: string = 'lexiPluginEnabled';
const KEY_SAFE_MODE: string = 'lexiPluginSafeMode';
/** 随 HAP 内置、启动时复制进 files/plugins 的插件目录(演示插件 + 兼容层探针)。 */
const BUNDLED_PLUGIN_DIRS: Array<string> = [
  'plugins/lexi-sample-plugin',
  'plugins/compat-probe',
  'plugins/calendar',
  'plugins/editor-outliner',
  // 身份判定的活体探针:前者不声明任何 capabilities(攻击方),后者只声明 network 127.0.0.1(被冒名方)。
  'plugins/cap-probe-unauth',
  'plugins/cap-probe-open',
  // P1-003b:沙箱装载探针(entrypoints.service='sandbox:' 声明式 opt-in 的最小面)。
  'plugins/sandbox-probe'
];
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
    'size': file.stat.size as Object,
    'revision': file.stat.revision as Object
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
  /** 机器可读的失败原因(capability_denied / integrity_mismatch / ...)，成功时为空。 */
  code: string = '';
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

function failResponseCode(code: string, error: string): string {
  const body = new RpcResponse();
  body.ok = false;
  body.error = error;
  body.code = code;
  return JSON.stringify(body);
}

/** ArkWeb transport. The Web component exposes `call` as `lexiHost` inside the runtime page. */
export class LexiWebRuntime {
  private controller: webview.WebviewController | null = null;
  /** P1-003b 方案 B:沙箱容器页 controller(manager 登记后 sandbox.boot 走本页)。 */
  sandboxController: webview.WebviewController | null = null;
  private handlers: Map<string, (payloadJson: string, identity: string, token: string) => Promise<string>> = new Map();
  private ready: boolean = false;
  private readyWaiters: Array<() => void> = [];
  /**
   * 插件身份凭据表(credential → pluginId,''= 页面会话角色)。凭据只由本运行时铸造:
   * 装载时下发给运行时页面,页面侧每一次宿主调用把它当第 4 个实参带回来,call() 用它反查身份。
   * 凭据里不含插件 id(不可猜),页面自报的 pluginId 不参与身份判定。
   */
  private pluginTokens: Map<string, string> = new Map();
  /** 页面会话凭据(唯一一份,' '角色)。WorkspaceBridge 代表整个页面会话调用宿主时使用。 */
  private sessionCredential: string = '';
  /**
   * 授权矩阵(T0.3):call() 预检 + 所有权复查的唯一判定器。默认 fs 拒绝;
   * 管理器 init 时注入真实 fsAuthorizer(manifest 能力判定单一真源)。
   */
  broker: LexiPermissionBroker = new LexiPermissionBroker((_pluginId: string, _method: string): boolean => false);
  /** RPC 拒绝计数(T5.3 Inspector 数据源):key=插件 id 或 '(anonymous)'。 */
  rpcDenies: Map<string, number> = new Map();

  /** 铸造插件凭据并登记归属。返回空串表示插件 id 非法(调用方必须按失败处理)。 */
  mintPluginToken(pluginId: string): string {
    if (pluginId.length === 0) { return ''; }
    const token: string = mintCredential('tk');
    this.pluginTokens.set(token, pluginId);
    return token;
  }

  /** 铸造(或复用)页面会话凭据:会话角色不归属任何插件,能力面由授权矩阵另行限定。 */
  sessionCredentialToken(): string {
    if (this.sessionCredential.length === 0) {
      this.sessionCredential = mintCredential('st');
      this.pluginTokens.set(this.sessionCredential, '');
    }
    return this.sessionCredential;
  }

  /** 吊销某插件的全部令牌(停用/卸载/回滚),返回吊销条数。 */
  revokePluginTokens(pluginId: string): number {
    const doomed: string[] = [];
    this.pluginTokens.forEach((owner: string, token: string): void => {
      if (owner === pluginId) { doomed.push(token); }
    });
    for (const token of doomed) { this.pluginTokens.delete(token); }
    return doomed.length;
  }

  /** 只认本运行时铸造的令牌;不是令牌的一律回空串(fail-closed)。 */
  pluginIdForToken(token: string): string {
    if (typeof token !== 'string' || token.length === 0) { return ''; }
    const owner = this.pluginTokens.get(token);
    return owner === undefined ? '' : owner;
  }

  /**
   * 凭据 → 角色:'plugin' / 'session' / 'anonymous'。
   * 未知凭据一律 anonymous(fail-closed):调用方原串绝不参与身份判定(RFC P0-01 修复点)。
   */
  roleOfCredential(credential: string): string {
    if (typeof credential !== 'string' || credential.length === 0) { return 'anonymous'; }
    const owner = this.pluginTokens.get(credential);
    if (owner === undefined) { return 'anonymous'; }
    return owner.length === 0 ? 'session' : 'plugin';
  }

  /** 取该插件的令牌(没有就铸一个)：身份令牌只在宿主侧铸造，页面无法自造。 */
  tokenForPlugin(pluginId: string): string {
    let found: string = '';
    this.pluginTokens.forEach((owner: string, token: string): void => {
      if (found.length === 0 && owner === pluginId) { found = token; }
    });
    return found.length > 0 ? found : this.mintPluginToken(pluginId);
  }

  /** 令牌尾 6 位:日志里可对账,又不足以被复用来冒充。 */
  static tokenTail(token: string): string {
    return token.length <= 6 ? token : token.substring(token.length - 6);
  }

  /** 角色+归属 → 授权上下文。 */
  static contextOf(role: string, pluginId: string): LexiCallerContext {
    const ctx = new LexiCallerContext();
    ctx.role = role as LexiCallerRole;
    ctx.pluginId = pluginId;
    return ctx;
  }

  attach(controller: webview.WebviewController): void {
    this.controller = controller;
  }

  registerHandler(method: string,
    handler: (payloadJson: string, identity: string, token: string) => Promise<string>): void {
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

  /**
   * 唯一的两个入口,身份实参都必须是本运行时铸造的凭据:
   * (1) 运行时页面(lexiHost.call)带回装载时下发的插件凭据;
   * (2) WorkspaceBridge.delegate 带回会话凭据或 tokenForPlugin 铸出的插件凭据。
   * 凭据解析不出角色(anonymous)就 fail-closed:调用方原串(RFC P0-01 的 raw identity)
   * 绝不作为身份下传。payload 里的 pluginId 是自述,进处理器之前就被剥掉并落一行审计日志。
   */
  async call(_callId: string, method: string, payloadJson: string, identity: string): Promise<string> {
    const handler = this.handlers.get(method);
    if (!handler) { return failResponse(`未知插件通道: ${method}`); }
    const credential: string = typeof identity === 'string' ? identity : '';
    const role: string = this.roleOfCredential(credential);
    if (role === 'anonymous') {
      pluginError('identity.anonymous method=' + method +
        ' credential=' + (credential.length > 0 ? credential.substring(0, 24) : '(none)') +
        ' fail_closed=true code=' + ERROR_IDENTITY_UNTRUSTED);
    }
    if (method === 'plugin.sourceChunk' || method === 'plugin.sourceSize') {
      // 源码通道只认插件凭据:会话角色与匿名一律拒绝(否则任何页面都能读别人源码)。
      if (role !== 'plugin') {
        pluginError('源码通道拒绝: method=' + method + ' role=' + role +
          ' fail_closed=true code=' + ERROR_IDENTITY_UNTRUSTED);
        return failResponseCode(ERROR_IDENTITY_UNTRUSTED, '源码分片请求缺少可信插件凭据（fail-closed）');
      }
    }
    const trusted: string = role === 'plugin' ? this.pluginIdForToken(credential) : '';
    if (role === 'plugin') {
      pluginLog('identity.token method=' + method + ' identity=' + trusted +
        ' tokenTail=' + LexiWebRuntime.tokenTail(credential));
    }
    // 授权矩阵预检(T0.3):身份解析之后、进处理器之前。矩阵未登记的方法在此默认拒绝。
    const authz = this.broker.authorize(LexiWebRuntime.contextOf(role, trusted), method, null);
    if (!authz.allowed) {
      pluginError('authz.denied method=' + method + ' role=' + role + ' identity=' +
        (trusted.length > 0 ? trusted : '(none)') + ' kind=' + authz.kind +
        ' code=' + authz.code + ' reason=' + authz.reason);
      const denyKey: string = trusted.length > 0 ? trusted : '(anonymous)';
      const prior: number = this.rpcDenies.get(denyKey) === undefined ? 0 : this.rpcDenies.get(denyKey) as number;
      this.rpcDenies.set(denyKey, prior + 1);
      return failResponseCode(authz.code, authz.reason);
    }
    try {
      // 原始凭据一并交给处理器：能力判定要能反查"这个身份是否真的持有它自己的凭据"。
      return await handler(stripClaimedIdentity(payloadJson, trusted, method), trusted, credential);
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

  /**
   * P1-003b:沙箱轨装载直传(payload 为 JSON 对象,可直接作为 JS 字面量注入)。
   * 目标 = runtime 页容器 window.lexiContainerBoot;大码分片随 P1-003b 后续轮
   * (样本级源码直传当前可行,见 dispatch 注释的体积经验)。
   */
  async dispatchSandboxBoot(payloadJson: string): Promise<void> {
    if (!this.sandboxController) { throw new Error('沙箱容器未就绪(方案 B 组件未挂载)'); }
    await this.sandboxController.runJavaScript('window.lexiContainerBoot(' + payloadJson + ');');
    pluginLog('sandbox.boot dispatched');
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

/**
 * 能力判定只认令牌解析出来的身份:payload 里的 pluginId 是自述,处理器根本看不到它。
 * 带自述就落一行审计日志(与 WorkspaceBridge 的 frame.identity 同一口径),然后剥掉该键。
 * 这是 spec §13.1 的落地:能力声明不能靠调用方自曝 id 来"借用"别人的权限。
 */
function stripClaimedIdentity(payloadJson: string, identity: string, method: string): string {
  let request: RpcRequest;
  try {
    request = JSON.parse(payloadJson) as RpcRequest;
  } catch (error) {
    return payloadJson;
  }
  if (request === null || typeof request !== 'object') { return payloadJson; }
  const raw = request['pluginId'];
  const claimed: string = typeof raw === 'string' ? raw as string : '';
  if (claimed.length === 0) { return payloadJson; }
  pluginLog('identity.ignored method=' + method + ' identity=' + (identity.length > 0 ? identity : '(none)') +
    ' claimed=' + claimed + ' ignored=true');
  const clean: RpcRequest = {};
  const keys: string[] = Object.keys(request);
  for (const key of keys) {
    if (key !== 'pluginId') { clean[key] = request[key]; }
  }
  return JSON.stringify(clean);
}

function rpcBool(payload: RpcRequest, key: string): boolean {
  const value = payload[key];
  return value === true;
}

function rpcNumber(payload: RpcRequest, key: string): number {
  const value = payload[key];
  return typeof value === 'number' ? value : 0;
}

/** net.requestUrl 的真实网络边界：全工程唯一接触 @kit.NetworkKit 的实现，测试用假传输替换它。 */
class LexiHttpTransport implements LexiNetTransport {
  async send(method: string, url: string, headers: Record<string, string>, body: string,
    timeoutMs: number): Promise<LexiNetResponse> {
    const client = http.createHttp();
    try {
      const response = await client.request(url, {
        method: (method === 'POST' ? http.RequestMethod.POST : http.RequestMethod.GET),
        header: headers,
        extraData: body.length > 0 ? body : undefined,
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs
      });
      const headersOut: Record<string, string> = {};
      const rawOut = response.header as Record<string, string> | undefined;
      if (rawOut) {
        for (const key of Object.keys(rawOut)) { headersOut[key] = String(rawOut[key]); }
      }
      const text = typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
      return new LexiNetResponse(response.responseCode, headersOut, text);
    } finally {
      client.destroy();
    }
  }
}

/** P1-003b 方案 B:沙箱容器页 javaScriptProxy 面——call(frameJson) 转交网关。 */
export class LexiSandboxProxyFace {
  private ownerRef: LexiPluginManager | null = null;

  bind(owner: LexiPluginManager): void {
    this.ownerRef = owner;
  }

  call(frameJson: string): void {
    if (this.ownerRef) { this.ownerRef.handleSandboxProxyCall(frameJson); }
  }
}

export class LexiPluginManager {
  private static instanceRef: LexiPluginManager | null = null;

  readonly runtime: LexiWebRuntime = new LexiWebRuntime();
  readonly commands: LexiCommandRegistry = new LexiCommandRegistry();
  readonly workspaceEvents: LexiEvents = new LexiEvents();
  private netTransport: LexiHttpTransport = new LexiHttpTransport();
  vault: LexiVaultFacade = new LexiVaultFacade();
  metadata: LexiMetadataCache | null = null;
  /** 生命周期状态机(T1.1):启用/停用/失败/隔离的唯一记账处,防重复 onload/onunload。 */
  readonly lifecycle: LexiPluginLifecycleManager = new LexiPluginLifecycleManager();
  /** 统一扩展注册表(T1.2):命令/视图/代码块/Ribbon/设置的所有权账本,停用全回收。 */
  readonly extensionRegistry: LexiExtensionRegistry = new LexiExtensionRegistry();
  /** 权限存储(T2.2):版本权限变化必须重新授权(§9.5),用户可撤销(§16.2)。 */
  readonly permissionStore: LexiPermissionStore = new LexiPermissionStore();
  /** P1-003a(ADR-R18-01):沙箱执行上下文注册表——端口 RPC 的身份真源。 */
  readonly contextRegistry: LexiContextRegistry = new LexiContextRegistry();
  private contextPort: webview.WebMessagePort | null = null;
  /** P1-003b 方案 B:沙箱容器页 controller(attachSandboxController 登记后沙箱轨可用)。 */
  private sandboxController: webview.WebviewController | null = null;
  /** P1-003b 方案 B:容器页 javaScriptProxy 面(组件注册用)。 */
  readonly sandboxProxy: LexiSandboxProxyFace = new LexiSandboxProxyFace();
  /** 视图会话表(T2.4):open/close/reopen 记账,重开状态恢复正常。 */
  readonly viewSessions: LexiViewSessionTable = new LexiViewSessionTable();

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
  private settingDefs: Map<string, string> = new Map();
  private codeBlockPlugins: Map<string, string> = new Map();
  private pluginSources: Map<string, string> = new Map();
  private ribbonItems: Map<string, LexiRibbonRow> = new Map();
  private iconPaths: Map<string, string> = new Map();
  /** 图标归属表(ui.addIcon 防跨插件覆盖):iconId → 首次注册的插件 id。 */
  private iconOwners: Map<string, string> = new Map();
  /** ui.placeholder 登记表:key=kind#seq, value=标题(真实 DOM 由页面兼容层挂载)。 */
  private placeholders: Map<string, string> = new Map<string, string>();

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
    this.pluginSources.set(pluginId, code);
    const body: Record<string, Object> = {
      'pluginId': pluginId as Object,
      'manifestJson': JSON.stringify(record.manifest) as Object,
      'viewType': viewType as Object,
      'stylesCss': stylesCss as Object,
      // 视图侧的 net.requestUrl 也要带身份：令牌只在宿主侧铸造，随 boot payload 下发。
      'token': this.runtime.tokenForPlugin(pluginId) as Object
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

  /** 插件声明式设置:定义列表(JSON)与 data.json 读写。 */
  pluginSettingDefs(pluginId: string): string {
    return this.settingDefs.get(pluginId) || '';
  }

  hasPluginSettings(pluginId: string): boolean {
    const json = this.settingDefs.get(pluginId);
    if (!json || json === '[]') { return false; }
    return parseSettingDefinitions(json).length > 0;
  }

  pluginSettingDefinitions(pluginId: string): LexiPluginSettingDef[] {
    return parseSettingDefinitions(this.pluginSettingDefs(pluginId));
  }

  async readPluginData(pluginId: string): Promise<string> {
    const path = `${this.pluginsRoot()}/${pluginId}/data.json`;
    try {
      if (fs.accessSync(path)) { return this.readTextFile(path); }
    } catch { /* fall through to empty */ }
    return '{}';
  }

  async writePluginData(pluginId: string, dataJson: string): Promise<void> {
    const dir = `${this.pluginsRoot()}/${pluginId}`;
    if (!fs.accessSync(dir)) { fs.mkdirSync(dir, true); }
    this.writeTextFile(`${dir}/data.json`, dataJson);
    let values: Record<string, Object> = {};
    try { values = JSON.parse(dataJson) as Record<string, Object>; } catch { values = {}; }
    const body: Record<string, Object> = {
      'pluginId': pluginId as Object,
      'values': values as Object
    };
    this.runtime.dispatch('settings.values', JSON.stringify(body)).catch((): void => {
      /* 插件未启用时没有回写目标 */
    });
  }

  private bumpPluginRevision(): void {
    AppStorage.setOrCreate<number>('lexiPluginRevision', (AppStorage.get<number>('lexiPluginRevision') || 0) + 1);
  }

  /** 插件 Ribbon(左侧栏图标),宿主按修订号增量渲染。 */
  ribbonRows(): LexiRibbonRow[] {
    const rows: LexiRibbonRow[] = [];
    this.ribbonItems.forEach((row: LexiRibbonRow): void => { rows.push(row); });
    return rows;
  }

  iconSvgPath(iconId: string): string {
    return this.iconPaths.get(iconId) || '';
  }

  /** 点击 Ribbon:派发到插件侧回调。 */
  async invokeRibbon(pluginId: string, title: string): Promise<void> {
    const body: Record<string, Object> = { 'pluginId': pluginId as Object, 'title': title as Object };
    await this.runtime.dispatchWithTimeout('invoke.ribbon', JSON.stringify(body), LOAD_TIMEOUT_MS).catch((error: Error): void => {
      pluginError('Ribbon 回调派发失败: ' + String(error));
    });
  }

  private static positionOf(raw: Object | undefined): LexiEditorPosition {
    const position = new LexiEditorPosition();
    if (raw && typeof raw === 'object') {
      const record = raw as Record<string, Object>;
      const line = record['line'];
      const ch = record['ch'];
      position.line = typeof line === 'number' ? line : 0;
      position.ch = typeof ch === 'number' ? ch : 0;
    }
    return position;
  }

  /** 代码块处理器:语言 → 插件 id(预览按需渲染槽位)。 */
  static codeBlockPluginFor(language: string): string {
    const manager = LexiPluginManager.shared;
    if (!manager || !language) { return ''; }
    return manager.codeBlockPlugins.get(language.toLowerCase()) || '';
  }

  codeBlockPayload(pluginId: string, language: string, source: string): string {
    const record = this.plugins.get(pluginId);
    if (!record) { return ''; }
    let code = '';
    let stylesCss = '';
    try { code = this.readTextFile(`${record.dir}/main.js`); } catch { /* empty slot */ }
    try {
      if (fs.accessSync(`${record.dir}/styles.css`)) { stylesCss = this.readTextFile(`${record.dir}/styles.css`); }
    } catch { /* styles are optional */ }
    this.pluginSources.set(pluginId, code);
    const body: Record<string, Object> = {
      'pluginId': pluginId as Object,
      'manifestJson': JSON.stringify(record.manifest) as Object,
      'language': language as Object,
      'source': source as Object,
      'stylesCss': stylesCss as Object
    };
    return JSON.stringify(body);
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
  async installZip(zipSource: string, expectedSha256: string = '', optionsJson: string = ''): Promise<string> {
    // P2-008(§9.5):optionsJson.grantApproved = 用户已在 UI 确认本次权限变化。
    // 此前该缝从 UI 不可达(审计确认的死端):grantApproved 安装后 enablePlugin 的
    // 授权门仍会按新指纹打回 regrant-required。现在确认过的权限变化直接落账再启用。
    let grantApproved = false;
    if (optionsJson.length > 0) {
      try {
        grantApproved = (JSON.parse(optionsJson) as Record<string, Object>)['grantApproved'] === true;
      } catch { /* 非法 options 视为未批准 */ }
    }
    const manifest = await this.ensureInstaller().installZip(zipSource, expectedSha256, optionsJson);
    await this.scanPluginDir();
    pluginLog('插件安装完成: ' + manifest.id + ' v' + manifest.version);
    if (grantApproved) {
      this.permissionStore.grant(manifest.id, manifest.version, this.capabilityFingerprintOf(manifest));
      this.persistPermissions();
      pluginLog('权限已按用户确认落账: ' + manifest.id + ' v' + manifest.version);
    }
    await this.enablePlugin(manifest.id);
    return manifest.id;
  }

  /** Downloads a plugin zip and installs it. expectedSha256 comes from the index entry. */
  async installFromUrl(url: string, expectedSha256: string = '', optionsJson: string = ''): Promise<string> {
    // 信任闸门(LEXI-RFC-PLUGIN-001 P0-04/§8.5/§18.4):远程安装必须携带受信任哈希。
    // 空哈希在 verifyPackageHash 里会跳过比对(fail-open),必须在下载之前就挡掉;
    // 自述哈希尚不等于来源可信(TUF Targets 接线是后续任务),但没有哈希连完整性都无从谈起。
    // 本地侧载继续走 installZip 的空哈希语义,不受此闸门约束(开发安装另行标记)。
    if (!isTrustedInstallHash(expectedSha256)) {
      throw new Error('远程安装被拒绝：索引条目缺少受信任的 sha256 哈希（旧版索引请升级到 schemaVersion=1）');
    }
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
    return this.installZip(cachePath, expectedSha256, optionsJson);
  }

  /** 卸载:先走 disablePlugin 的回收序,再把目录移进 .trash(data.json 一并保留)。 */
  async uninstallPlugin(pluginId: string): Promise<PluginLifecycleOutcome> {
    await this.disablePlugin(pluginId);
    const outcome = this.ensureInstaller().uninstallPlugin(pluginId);
    if (outcome.ok) {
      this.plugins.delete(pluginId);
      this.enabledIds.delete(pluginId);
      await this.persistEnabled();
      this.lifecycle.markRemoved(pluginId);
      pluginLog('插件已卸载: ' + pluginId + ' → ' + outcome.path);
      this.bumpPluginRevision();
    } else {
      pluginError('插件卸载失败 ' + pluginId + ': ' + outcome.message);
    }
    return outcome;
  }

  /** 回滚到上一版本(current.json 指针是唯一真源)。 */
  async rollbackPlugin(pluginId: string): Promise<PluginLifecycleOutcome> {
    await this.disablePlugin(pluginId);
    const outcome = await this.ensureInstaller().rollbackPlugin(pluginId);
    if (outcome.ok) {
      await this.scanPluginDir();
      await this.enablePlugin(pluginId).catch((): void => {});
      pluginLog('插件已回滚: ' + pluginId + ' → v' + outcome.version);
      this.bumpPluginRevision();
    } else {
      pluginError('插件回滚失败 ' + pluginId + ': ' + outcome.message);
    }
    return outcome;
  }

  /** 已安装版本(来自 current.json 指针,不看目录 mtime)。 */
  pluginVersion(pluginId: string): string {
    return this.ensureInstaller().currentVersion(pluginId);
  }

  /** Fetches a community index without losing the rejection reason. */
  async fetchMarketIndex(indexUrl: string): Promise<LexiMarketIndexResult> {
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
      const result = parseMarketIndexResult(text);
      if (result.ok) {
        const note: string = result.warnings.length > 0 ? ' 警告: ' + result.warnings.join(', ') : '';
        pluginLog('市场索引加载: ' + result.entries.length + ' 个插件 schema=' + result.schemaVersion + note);
      } else {
        pluginError('市场索引被拒绝 ' + result.code + ': ' + result.message);
      }
      return result;
    } finally {
      client.destroy();
    }
  }

  /** 展示用包装:历史调用方仍只拿到条目。 */
  async fetchMarket(indexUrl: string): Promise<LexiPluginMarketEntry[]> {
    return (await this.fetchMarketIndex(indexUrl)).entries;
  }

  private async init(context: common.Context): Promise<void> {
    this.context = context;
    await LexiStorageService.init(context);
    this.vault = new LexiVaultFacade();
    await this.vault.init(context);
    this.metadata = new LexiMetadataCache(this.vault);
    // 授权矩阵的能力注入(P2-003):fs 写判定 + 细粒度 capability gate,单一真源 manifest。
    this.runtime.broker = new LexiPermissionBroker((pluginId: string, method: string): boolean =>
      this.fsAllowedByManifest(pluginId, method), (pluginId: string, method: string): boolean =>
      this.capabilityAllowedFor(pluginId, method));
    // P1-003b 方案 B:沙箱容器页 proxy 绑定(容器组件经 javaScriptProxy.sandboxHost.call 进网关)。
    this.sandboxProxy.bind(this);
    // 权限授予持久化(T2.2):重启后授权与撤销状态保留。
    this.loadPermissionStore();
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
    // 扫描落账:发现的插件进入生命周期 installed 态(T1.1,verify 细化随 T4 PackageVerifier)
    this.plugins.forEach((record: LexiInstalledPlugin): void => {
      this.lifecycle.markInstalled(record.manifest.id, record.manifest.version);
    });
    // 首次运行自动启用官方示范插件(仅一次;用户可在设置中停用)
    const bundledInit = await LexiStorageService.getSetting('lexiPluginBundledInit', 'false');
    if (bundledInit !== 'true' && !this.safeMode && this.plugins.has('lexi-sample-plugin')) {
      this.enabledIds.add('lexi-sample-plugin');
      // P1-003b 方案 B:沙箱探针随首启启用(容器页就绪即走沙箱轨;失败仅 errorState 无系统影响)。
      if (this.plugins.has('sandbox-probe')) { this.enabledIds.add('sandbox-probe'); }
      await LexiStorageService.setSetting('lexiPluginBundledInit', 'true');
      pluginLog('首次运行:自动启用官方示范插件');
    }
    pluginLog('插件管理器初始化完成: 已发现 ' + this.plugins.size + ' 个插件, safeMode=' + this.safeMode);
    this.registerRpcHandlers();
    this.registerHostOnlyCommands();
    this.workspaceEvents.trigger('layout-change', null);
  }

  /**
   * 只存在于宿主注册表的命令:容器里的兼容层根本没有这条,所以 executeCommandById 走到
   * 宿主并回结果,才证明 commands.execute 的成功路径真的存在(拒绝路径只证明防火墙)。
   */
  private registerHostOnlyCommands(): void {
    this.commands.registerPluginCommand('lexinote', {
      id: 'host-only-selfcheck',
      name: '宿主自检命令',
      icon: 'check',
      editorOnly: false,
      callback: (): void => {
        this.hostSelfcheckRuns += 1;
        pluginLog('宿主命令执行: lexinote:host-only-selfcheck runs=' + this.hostSelfcheckRuns);
      }
    });
    pluginLog('宿主专属命令注册: lexinote:host-only-selfcheck (容器内不存在)');
  }

  hostSelfcheckRuns: number = 0;

  /** 原始 manifest.json 文本:web 容器要把它原样交给 obsidian 兼容层。 */
  pluginManifestJson(pluginId: string): string {
    const record = this.plugins.get(pluginId);
    if (record === undefined) { throw new Error('未安装的插件: ' + pluginId); }
    return this.readTextFile(`${record.dir}/manifest.json`);
  }

  pluginMainCode(pluginId: string): string {
    const record = this.plugins.get(pluginId);
    if (record === undefined) { throw new Error('未安装的插件: ' + pluginId); }
    return this.readTextFile(`${record.dir}/main.js`);
  }

  private pluginsRoot(): string {
    if (!this.context) { throw new Error('插件管理器尚未初始化'); }
    return `${this.context.filesDir}/${PLUGIN_DIR_NAME}`;
  }

  private async installBundledSamples(): Promise<void> {
    for (const sourceDir of BUNDLED_PLUGIN_DIRS) {
      await this.installBundledPlugin(sourceDir);
    }
  }

  /**
   * 用户卸载过的插件不得被内置资源在下次启动时装回来。卸载会把整个目录移进
   * plugins/.trash/<id>-<ts>/,所以那片目录的存在就是"用户不要它"的记录。
   */
  private wasUninstalled(pluginId: string): boolean {
    const trash = `${this.pluginsRoot()}/.trash`;
    try {
      if (!fs.accessSync(trash)) { return false; }
      for (const entry of fs.listFileSync(trash)) {
        if (entry === pluginId || entry.startsWith(`${pluginId}-`)) { return true; }
      }
    } catch { /* 没有 trash 目录等于从未卸载 */ }
    return false;
  }

  private async installBundledPlugin(sourceDir: string): Promise<void> {
    if (!this.context) { return; }
    try {
      const resource = this.context.resourceManager;
      const manifestBuffer = await resource.getRawFileContent(`${sourceDir}/manifest.json`);
      const codeBuffer = await resource.getRawFileContent(`${sourceDir}/main.js`);
      const decoder = new util.TextDecoder('utf-8');
      const manifestJson = decoder.decodeToString(new Uint8Array(manifestBuffer));
      const code = decoder.decodeToString(new Uint8Array(codeBuffer));
      let stylesCss = '';
      try {
        const stylesBuffer = await resource.getRawFileContent(`${sourceDir}/styles.css`);
        stylesCss = decoder.decodeToString(new Uint8Array(stylesBuffer));
      } catch { /* styles.css 可选 */ }
      const entryName = sourceDir.substring(sourceDir.lastIndexOf('/') + 1);
      if (this.wasUninstalled(entryName)) { return; }
      const dir = `${this.pluginsRoot()}/${entryName}`;
      if (!fs.accessSync(dir)) { fs.mkdirSync(dir, true); }
      // 内置插件随应用版本更新:始终覆盖清单与代码,但保留其 data.json 用户配置
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
        // 落盘扫描 = 安装链的 discovered→installed 记账步。运行时安装后立刻启用时,
        // 生命周期表只认 installed/disabled 为未运行面(discovered→starting 非法迁移,
        // 真机回归"装得上却永不 onload"的根因)。markInstalled 对重复扫描幂等。
        this.lifecycle.markInstalled(manifest.id, manifest.version);
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
      // 生命周期落账:starting → running(onload 逻辑只计一次,RFC §4.5)。
      const activationId = manager.lifecycle.currentActivationIdOf(id);
      if (activationId.length > 0) { manager.lifecycle.markRunning(activationId); }
      const waiter = manager.pendingOnload.get(id);
      if (waiter) { manager.pendingOnload.delete(id); waiter(); }
      return okResponse(null);
    });
    runtime.registerHandler('plugin.onload.error', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const record = manager.plugins.get(rpcString(request, 'id'));
      if (record) { record.errorState = rpcString(request, 'error'); }
      const id = rpcString(request, 'id');
      // 生命周期落账:onload 失败落 failed,宿主据此展示与重试,不得停在 starting。
      const activationId = manager.lifecycle.currentActivationIdOf(id);
      if (activationId.length > 0) { manager.lifecycle.markFailed(activationId, record ? record.errorState : 'onload error'); }
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
    runtime.registerHandler('commands.add', async (payload: string, identity: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const pluginId: string = identity;
      const rawCommand = request['command'] as RpcRequest;
      if (!pluginId || !rawCommand) { return failResponse('命令注册缺少可信身份'); }
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
      manager.extensionRegistry.register(pluginId, 'command',
        rpcString(rawCommand, 'id'), manager.lifecycle.currentActivationIdOf(pluginId));
      pluginLog('插件命令注册: ' + pluginId + ':' + rpcString(rawCommand, 'id') + (editorOnly ? ' (编辑器)' : ''));
      return okResponse(null);
    });
    runtime.registerHandler('commands.remove', async (payload: string, identity: string,
      token: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const fullId = rpcString(request, 'fullId');
      // 所有权复查:fullId 的插件命名空间段就是资源归属,别人的命令删不得(RFC §4.5)。
      const resource = new LexiAuthzResource();
      const colon = fullId.indexOf(':');
      resource.owner = colon > 0 ? fullId.substring(0, colon) : '';
      resource.fullId = fullId;
      const authz = manager.authzFor(identity, token, 'commands.remove', resource);
      if (!authz.allowed) { return failResponseCode(authz.code, authz.reason); }
      manager.commands.removePluginCommand(fullId);
      return okResponse(null);
    });
    runtime.registerHandler('events.on', async (payload: string, identity: string,
      token: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const refId = rpcNumber(request, 'refId');
      // 订阅归属登记:events.off 的所有权复查靠它(订阅属于激活插件,不共 GLOBAL)。
      const resource = new LexiAuthzResource();
      resource.owner = identity;
      const authz = manager.authzFor(identity, token, 'events.on', resource);
      if (!authz.allowed) { return failResponseCode(authz.code, authz.reason); }
      manager.subscribeHostEvent(refId, rpcString(request, 'topic'), rpcString(request, 'name'), identity);
      return okResponse(refId as Object);
    });
    runtime.registerHandler('events.off', async (payload: string, identity: string,
      token: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const refId = rpcNumber(request, 'refId');
      const resource = new LexiAuthzResource();
      resource.owner = manager.hostEventOwnerOf(refId);
      const authz = manager.authzFor(identity, token, 'events.off', resource);
      if (!authz.allowed) { return failResponseCode(authz.code, authz.reason); }
      manager.unsubscribeHostEvent(refId);
      return okResponse(null);
    });
    runtime.registerHandler('ui.notice', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      pluginLog('插件通知: ' + rpcString(request, 'message'));
      if (manager.uiHost) { manager.uiHost.toast(rpcString(request, 'message')); }
      return okResponse(manager.uiHost !== null);
    });
    runtime.registerHandler('ui.addRibbon', async (payload: string, identity: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const pluginId: string = identity;
      const title = rpcString(request, 'title');
      const iconId = rpcString(request, 'icon');
      if (!pluginId || !title) { return failResponse('Ribbon 参数不完整'); }
      const row = new LexiRibbonRow();
      row.pluginId = pluginId;
      row.title = title;
      row.iconId = iconId;
      row.iconPath = manager.iconSvgPath(iconId);
      manager.ribbonItems.set(`${pluginId}:${title}`, row);
      manager.extensionRegistry.register(pluginId, 'ribbon',
        title, manager.lifecycle.currentActivationIdOf(pluginId));
      pluginLog('插件 Ribbon 注册: ' + pluginId + ' / ' + title);
      manager.bumpPluginRevision();
      return okResponse(null);
    });
    runtime.registerHandler('ui.removeRibbon', async (payload: string, identity: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      manager.ribbonItems.delete(`${identity}:${rpcString(request, 'title')}`);
      manager.bumpPluginRevision();
      return okResponse(null);
    });
    runtime.registerHandler('ui.addIcon', async (payload: string, identity: string,
      token: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const iconId = rpcString(request, 'iconId').replace(/[^a-zA-Z0-9_-]/g, '_');
      const svg = rpcString(request, 'svgContent');
      if (!iconId || !svg) { return failResponse('图标参数不完整'); }
      // 归属登记:图标命名空间全局共享,已被其他插件占用的 iconId 不得覆盖(RFC §5.4)。
      const existingOwner = manager.iconOwners.get(iconId) || '';
      if (existingOwner.length > 0 && identity.length > 0 && existingOwner !== identity) {
        pluginError('authz.denied method=ui.addIcon iconId=' + iconId +
          ' owner=' + existingOwner + ' caller=' + identity + ' code=ERR_PERMISSION_DENIED');
        return failResponseCode('ERR_PERMISSION_DENIED', '图标已被其他插件注册: ' + iconId);
      }
      try {
        if (manager.context) {
          const dir = `${manager.context.cacheDir}/plugin-icons`;
          if (!fs.accessSync(dir)) { fs.mkdirSync(dir, true); }
          const path = `${dir}/${iconId}.svg`;
          manager.writeTextFile(path, svg);
          manager.iconPaths.set(iconId, path);
          if (existingOwner.length === 0) { manager.iconOwners.set(iconId, identity); }
          manager.ribbonItems.forEach((row: LexiRibbonRow): void => {
            if (row.iconId === iconId) { row.iconPath = path; }
          });
          manager.bumpPluginRevision();
        }
      } catch (error) {
        return failResponse(String(error));
      }
      return okResponse(null);
    });
    runtime.registerHandler('views.add', async (payload: string, identity: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const info = new LexiPluginViewInfo();
      info.pluginId = identity;
      info.type = rpcString(request, 'type');
      info.displayName = rpcString(request, 'displayName');
      info.icon = rpcString(request, 'icon');
      LexiPluginViewRegistry.register(info);
      manager.extensionRegistry.register(info.pluginId, 'view',
        info.type, manager.lifecycle.currentActivationIdOf(info.pluginId));
      pluginLog('插件视图注册: ' + info.type + ' → ' + info.displayName);
      return okResponse(null);
    });
    runtime.registerHandler('views.remove', async (payload: string, identity: string,
      token: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const type = rpcString(request, 'type');
      const info = LexiPluginViewRegistry.get(type);
      const resource = new LexiAuthzResource();
      resource.type = type;
      resource.owner = info ? info.pluginId : '';
      const authz = manager.authzFor(identity, token, 'views.remove', resource);
      if (!authz.allowed) { return failResponseCode(authz.code, authz.reason); }
      LexiPluginViewRegistry.remove(type);
      return okResponse(null);
    });
    runtime.registerHandler('workspace.openView', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const type = rpcString(request, 'type');
      const info = LexiPluginViewRegistry.get(type);
      if (!info) { return failResponse('未注册的插件视图: ' + type); }
      // 视图↔上下文绑定(T2.4):每次打开挂到归属插件的 activation 下,关闭时成对回收。
      const activationId = manager.lifecycle.currentActivationIdOf(info.pluginId);
      let contextId = '';
      if (activationId.length > 0) {
        contextId = manager.lifecycle.createContext(activationId, 'view').contextId;
      }
      manager.viewSessions.open(type, info.pluginId, contextId);
      manager.requestViewOpen(type);
      return okResponse(info.displayName as Object);
    });
    runtime.registerHandler('workspace.closeView', async (payload: string, identity: string,
      token: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const type = rpcString(request, 'type');
      const info = LexiPluginViewRegistry.get(type);
      const resource = new LexiAuthzResource();
      resource.type = type;
      resource.owner = info ? info.pluginId : '';
      const authz = manager.authzFor(identity, token, 'workspace.closeView', resource);
      if (!authz.allowed) { return failResponseCode(authz.code, authz.reason); }
      // 会话与上下文成对回收(T2.4):先关宿主侧记账,再落页面侧关闭;状态留在会话表供重开。
      const session = manager.viewSessions.sessionOf(type);
      manager.viewSessions.close(type, null);
      if (session !== null && session.contextId.length > 0) {
        manager.lifecycle.closeContext(session.contextId);
      }
      if (manager.viewCloseHandler) { manager.viewCloseHandler(type); }
      return okResponse(null);
    });
    runtime.registerHandler('codeblocks.register', async (payload: string, identity: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const pluginId: string = identity;
      const language = rpcString(request, 'language').toLowerCase();
      if (!pluginId || !language) { return failResponse('代码块注册缺少可信身份'); }
      manager.codeBlockPlugins.set(language, pluginId);
      manager.extensionRegistry.register(pluginId, 'codeblock-processor',
        language, manager.lifecycle.currentActivationIdOf(pluginId));
      pluginLog('插件代码块注册: ' + language + ' ← ' + pluginId);
      return okResponse(null);
    });
    runtime.registerHandler('codeblocks.unregister', async (payload: string, identity: string,
      token: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const language = rpcString(request, 'language').toLowerCase();
      // 所有权复查:语言当前归属谁,只有主人(或会话代管)能注销。
      const resource = new LexiAuthzResource();
      resource.owner = manager.codeBlockPlugins.get(language) || '';
      const authz = manager.authzFor(identity, token, 'codeblocks.unregister', resource);
      if (!authz.allowed) { return failResponseCode(authz.code, authz.reason); }
      manager.codeBlockPlugins.delete(language);
      return okResponse(null);
    });
    // 源码分片只认装载时铸造的插件令牌:没有令牌、令牌不是本运行时铸造的 → 直接拒绝(fail-closed)。
    // 返回谁的源码只由令牌决定:令牌归属 A 就只会拿到 A 的字节,payload 里任何自述 id 都不参与寻址。
    runtime.registerHandler('plugin.sourceChunk', async (payload: string, identity: string): Promise<string> => {
      const pluginId: string = identity;
      const request = JSON.parse(payload) as RpcRequest;
      const source = manager.pluginSources.get(pluginId) || '';
      const offset = Math.max(0, rpcNumber(request, 'offset'));
      const length = rpcNumber(request, 'length') > 0 ? rpcNumber(request, 'length') : SOURCE_CHUNK_SIZE;
      const end = Math.min(source.length, offset + length);
      pluginLog('plugin.sourceChunk pluginId=' + pluginId + ' offset=' + offset +
        ' tokenTail=' + LexiWebRuntime.tokenTail(identity));
      return okResponse(offset >= source.length ? '' : source.substring(offset, end) as Object);
    });
    runtime.registerHandler('plugin.sourceSize', async (_payload: string, identity: string): Promise<string> => {
      const source = manager.pluginSources.get(identity) || '';
      return okResponse(source.length as Object);
    });
    runtime.registerHandler('settings.register', async (payload: string, identity: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const pluginId: string = identity;
      const definitionsJson = rpcString(request, 'definitionsJson');
      if (!pluginId) { return failResponse('设置注册缺少可信身份'); }
      manager.settingDefs.set(pluginId, definitionsJson);
      manager.extensionRegistry.register(pluginId, 'settings',
        'setting-tab', manager.lifecycle.currentActivationIdOf(pluginId));
      pluginLog('插件设置注册: ' + pluginId + ' (' + parseSettingDefinitions(definitionsJson).length + ' 项)');
      return okResponse(null);
    });
    runtime.registerHandler('settings.unregister', async (payload: string, identity: string): Promise<string> => {
      manager.settingDefs.delete(identity);
      return okResponse(null);
    });
    runtime.registerHandler('data.load', async (_payload: string, identity: string): Promise<string> => {
      // 身份来自令牌:归属不到已安装插件时 fail-closed,读不到任何人(包括自己的)data.json。
      if (manager.manifestFor(identity) === null) {
        pluginError('capability.fs identity=' + (identity.length > 0 ? identity : '(none)') +
          ' allowed=false fail_closed=true detail=data.load 调用方无法归属到已安装插件');
        return failResponseCode(ERROR_CAPABILITY_DENIED, 'fs: 调用方无法归属到已安装插件（fail-closed）');
      }
      const path = `${manager.pluginsRoot()}/${identity}/data.json`;
      if (!fs.accessSync(path)) { return okResponse(null); }
      return okResponse(manager.readTextFile(path) as Object);
    });
    runtime.registerHandler('data.save', async (payload: string, identity: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const gate = manager.fsGate(identity, 'data.save');
      if (gate) { return gate; }
      const dataJson = rpcString(request, 'dataJson');
      // P2-005(RFC §10.1):配额由宿主强制执行,不能只靠 manifest 声明。字节数按 UTF-16
      // 码元近似(length)——配额语义为字符量级约束,精确字节账随编码器接入再校准。
      const quotaGate = manager.storageQuotaGate(identity, dataJson.length);
      if (quotaGate) { return quotaGate; }
      const dir = `${manager.pluginsRoot()}/${identity}`;
      if (!fs.accessSync(dir)) { fs.mkdirSync(dir, true); }
      manager.writeTextFile(`${dir}/data.json`, dataJson);
      return okResponse(null);
    });
    runtime.registerHandler('app.isDarkMode', async (_payload: string): Promise<string> => {
      return okResponse((AppStorage.get<number>('lexiColorMode') || 0) === 1);
    });
    runtime.registerHandler('net.requestUrl', async (payload: string, identity: string,
      token: string): Promise<string> => {
      return manager.performRequest(payload, identity, token);
    });
    manager.registerChannelHandlers();
    manager.registerVaultHandlers();
    manager.registerMetadataHandlers();
    manager.registerEditorHandlers();
  }

  /**
   * 兼容层遗留通道(spec 门禁 1 的死通道):页面侧调用点早已存在,宿主侧一直没有处理器。
   * 这里全部补成真实现,不改兼容层语义、不删调用点。
   */
  private registerChannelHandlers(): void {
    const manager = this;
    const runtime = this.runtime;
    // app.localStorage:Obsidian 的全局键值存储,必须真持久化(filesDir/local-storage.json)。
    runtime.registerHandler('app.localStorage.get', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const key = rpcString(request, 'key');
      if (!key) { return failResponse('缺少 localStorage key'); }
      const stored = manager.readLocalStorage(key);
      if (stored === null) { return okResponse(null); }
      let value: Object = stored;
      try { value = JSON.parse(stored) as Object; } catch { value = stored; }
      return okResponse(value);
    });
    runtime.registerHandler('app.localStorage.set', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const key = rpcString(request, 'key');
      if (!key) { return failResponse('缺少 localStorage key'); }
      const data = request['data'];
      manager.writeLocalStorage(key, data === undefined ? 'null' : JSON.stringify(data));
      return okResponse(null);
    });
    // commands:执行/列举本宿主已注册的插件命令(命名空间 pluginId:commandId,安全模式禁执行)。
    runtime.registerHandler('commands.execute', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const id = rpcString(request, 'id');
      if (!id) { return failResponse('缺少命令 id'); }
      if (manager.safeMode) { return failResponse('安全模式已开启,命令不可执行'); }
      if (!manager.commands.canExecute(id)) { return failResponse('命令不存在或当前不可执行: ' + id); }
      const executed: boolean = await manager.commands.execute(id);
      pluginLog('命令执行: ' + id + ' → ' + (executed ? 'ok' : 'skipped'));
      const result: Record<string, Object> = { 'id': id as Object, 'executed': executed as Object };
      return okResponse(result);
    });
    runtime.registerHandler('commands.list', async (_payload: string): Promise<string> => {
      const items: Array<Record<string, Object>> = [];
      if (!manager.safeMode) {
        for (const command of manager.commands.list()) {
          const item: Record<string, Object> = {
            'id': command.id as Object,
            'name': command.name as Object,
            'icon': (command.icon || '') as Object,
            'editorOnly': (command.editorOnly === true) as Object
          };
          items.push(item);
        }
      }
      pluginLog('命令列举: ' + items.length + ' 条(safeMode=' + manager.safeMode + ')');
      return okResponse(items as Object);
    });
    // ui.placeholder:状态栏/模态占位的宿主侧登记页;真实 DOM 由页面(兼容层)挂在 .status-bar 上。
    runtime.registerHandler('ui.placeholder', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const kind = rpcString(request, 'kind') || 'unknown';
      const title = rpcString(request, 'title');
      const seq: number = manager.placeholders.size + 1;
      manager.placeholders.set(kind + '#' + seq, title);
      pluginLog('UI 占位登记: kind=' + kind + ' total=' + manager.placeholders.size + (title ? ' title=' + title : ''));
      const result: Record<string, Object> = {
        'kind': kind as Object,
        'accepted': true as Object,
        'total': manager.placeholders.size as Object
      };
      return okResponse(result);
    });
    // workspace.onLayoutReady:旧宿主页面在寄存器里已经是"布局就绪"之后才回调。
    runtime.registerHandler('workspace.onLayoutReady', async (_payload: string): Promise<string> => {
      pluginLog('布局就绪回调: 旧宿主路径立即放行');
      return okResponse(true);
    });
    // workspace.layoutReady:页面首帧渲染完成后通报(工作区容器路径),旧宿主同样应答。
    runtime.registerHandler('workspace.layoutReady', async (_payload: string): Promise<string> => {
      manager.workspaceEvents.trigger('layout-change', null);
      return okResponse(true);
    });
    // workspace.openLinkText:真实链接解析(metadataCache)→ 触发 file-open,返回解析结果。
    runtime.registerHandler('workspace.openLinkText', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const linktext = rpcString(request, 'linktext');
      const sourcePath = rpcString(request, 'sourcePath');
      if (!linktext) { return failResponse('缺少 linktext'); }
      const target = manager.metadata
        ? manager.metadata.getFirstLinkpathDest(linktext, sourcePath)
        : null;
      if (!target) { return failResponse('链接目标不存在: ' + linktext); }
      const json: Record<string, Object> = fileToJson(target);
      manager.workspaceEvents.trigger('file-open', json);
      pluginLog('链接打开: ' + linktext + ' → ' + target.path);
      return okResponse(json);
    });
    // workspace.saveLayout / workspace.loadLayout:视图状态机持久化。容器把 leaf 列表(type + state)
    // 落在这里,应用重启后由容器恢复,日历回到同一个视图。
    runtime.registerHandler('workspace.saveLayout', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const layout = request['layout'];
      const path = manager.workspaceLayoutPath();
      if (path.length === 0) { return failResponse('布局存储不可用'); }
      manager.writeTextFile(path, JSON.stringify(layout === undefined ? null : layout));
      const saved = manager.readTextFile(path);
      pluginLog('工作区布局已保存: ' + saved.length + ' bytes body=' + saved.substring(0, 240));
      return okResponse(true);
    });
    runtime.registerHandler('workspace.loadLayout', async (_payload: string): Promise<string> => {
      const path = manager.workspaceLayoutPath();
      if (path.length === 0 || !fs.accessSync(path)) { return okResponse(null); }
      const raw = manager.readTextFile(path);
      try {
        const layout = JSON.parse(raw) as Object;
        pluginLog('工作区布局已读取: ' + raw.length + ' bytes body=' + raw.substring(0, 240));
        return okResponse(layout);
      } catch {
        return okResponse(null);
      }
    });
    // debug.delay:超时回归探针(仅测试用),payload.ms 上限 30s。
    runtime.registerHandler('debug.delay', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const raw: number = rpcNumber(request, 'ms');
      const ms: number = raw < 0 ? 0 : (raw > 30000 ? 30000 : raw);
      pluginLog('debug.delay 开始: ' + ms + 'ms');
      await new Promise<void>((resolve: () => void): void => {
        setTimeout((): void => resolve(), ms);
      });
      pluginLog('debug.delay 结束: ' + ms + 'ms');
      const result: Record<string, Object> = { 'slept': ms as Object };
      return okResponse(result);
    });
  }

  workspaceLayoutPath(): string {
    return this.context ? `${this.context.filesDir}/workspace-layout.json` : '';
  }

  private localStorageCache: Map<string, string> | null = null;

  private localStoragePath(): string {
    return `${this.context ? this.context.filesDir : ''}/local-storage.json`;
  }

  private loadLocalStorageCache(): Map<string, string> {
    if (this.localStorageCache !== null) { return this.localStorageCache; }
    const cache: Map<string, string> = new Map<string, string>();
    try {
      const path = this.localStoragePath();
      if (path.length > 0 && fs.accessSync(path)) {
        const raw = JSON.parse(this.readTextFile(path)) as Record<string, string>;
        for (const key of Object.keys(raw)) { cache.set(key, String(raw[key])); }
      }
    } catch { /* 文件损坏时按空存储继续,下一次写入自愈 */ }
    this.localStorageCache = cache;
    return cache;
  }

  private readLocalStorage(key: string): string | null {
    const cache = this.loadLocalStorageCache();
    const value = cache.get(key);
    return value === undefined ? null : value;
  }

  private writeLocalStorage(key: string, value: string): void {
    const cache = this.loadLocalStorageCache();
    cache.set(key, value);
    const plain: Record<string, string> = {};
    cache.forEach((stored: string, storedKey: string): void => { plain[storedKey] = stored; });
    try {
      const path = this.localStoragePath();
      if (path.length > 0) { this.writeTextFile(path, JSON.stringify(plain)); }
    } catch (error) {
      pluginError('localStorage 写入失败: ' + String(error));
    }
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
    runtime.registerHandler('editor.applyChanges', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const controller = LexiEditorRegistry.activeController();
      if (!controller) { return failResponse('当前没有打开的编辑器'); }
      const text = controller.getText();
      const rawChanges = request['changes'];
      const changeList: Object[] = Array.isArray(rawChanges) ? rawChanges as Object[] : [];
      pluginLog('收到编辑器批量修改请求: ' + changeList.length + ' 段, 文档 ' + text.length + ' 字符');
      const starts: number[] = [];
      const ends: number[] = [];
      const texts: string[] = [];
      for (const raw of changeList) {
        const change = raw as Record<string, Object>;
        const fromPos = LexiPluginManager.positionOf(change['from']);
        const toPos = LexiPluginManager.positionOf(change['to']);
        starts.push(LexiEditorPosUtil.posToOffset(text, fromPos));
        ends.push(LexiEditorPosUtil.posToOffset(text, toPos));
        const textValue = change['text'];
        texts.push(typeof textValue === 'string' ? textValue : '');
      }
      // 按起点倒序应用,避免前面的修改影响后面的偏移
      let after = text;
      const order: number[] = [];
      for (let i = 0; i < starts.length; i++) { order.push(i); }
      order.sort((a: number, b: number): number => starts[b] - starts[a]);
      for (const index of order) {
        const start = Math.max(0, Math.min(after.length, starts[index]));
        const end = Math.max(start, Math.min(after.length, ends[index]));
        after = after.substring(0, start) + texts[index] + after.substring(end);
      }
      let selStart = after.length;
      let selEnd = after.length;
      const rawSelections = request['selections'];
      if (Array.isArray(rawSelections) && (rawSelections as Object[]).length > 0) {
        const selection = (rawSelections as Object[])[0] as Record<string, Object>;
        const anchor = LexiEditorPosUtil.posToOffset(after, LexiPluginManager.positionOf(selection['anchor']));
        const head = LexiEditorPosUtil.posToOffset(after, LexiPluginManager.positionOf(selection['head']));
        selStart = Math.min(anchor, head);
        selEnd = Math.max(anchor, head);
      }
      controller.replaceRange(0, text.length, after);
      controller.setTextSelection(selStart, selEnd);
      pluginLog(`编辑器批量修改: changes=${starts.length} ${text.length}→${after.length} 字符, selection=${selStart}-${selEnd}`);
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
    runtime.registerHandler('vault.getByPath', async (payload: string, identity: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const readGate = manager.vaultReadGate(identity, rpcString(request, 'path'));
      if (readGate) { return readGate; }
      const node = manager.vault.getAbstractFileByPath(rpcString(request, 'path'));
      if (!node) { return okResponse(null); }
      return okResponse(node.kind === 'file' ? fileToJson(node as LexiTFile) : folderToJson(node as LexiTFolder));
    });
    runtime.registerHandler('vault.read', async (payload: string, identity: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const readGate = manager.vaultReadGate(identity, rpcString(request, 'path'));
      if (readGate) { return readGate; }
      const file = manager.vault.getFileByPath(rpcString(request, 'path'));
      if (!file) { return failResponse('文件不存在'); }
      return okResponse(await manager.vault.read(file));
    });
    runtime.registerHandler('vault.modify', async (payload: string, identity: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const gate = manager.fsGate(identity, 'vault.modify', rpcString(request, 'path'));
      if (gate) { return gate; }
      const file = manager.vault.getFileByPath(rpcString(request, 'path'));
      if (!file) { return failResponse('文件不存在'); }
      // 乐观锁(T2.3):插件带上读取时的 stat.revision 即获并发保护;不带则盲写(行为不变)。
      const rawExpected = request['expectedRevision'];
      const expectedRevision = typeof rawExpected === 'number' ? rawExpected as number : -1;
      try {
        await manager.vault.modify(file, rpcString(request, 'data'), expectedRevision);
      } catch (error) {
        const message = String(error);
        if (message.indexOf('vault_conflict') === 0) {
          return failResponseCode('vault_conflict', message);
        }
        throw error instanceof Error ? error : new Error(message);
      }
      return okResponse(null);
    });
    runtime.registerHandler('vault.create', async (payload: string, identity: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const gate = manager.fsGate(identity, 'vault.create', rpcString(request, 'path'));
      if (gate) { return gate; }
      const file = await manager.vault.create(rpcString(request, 'path'), rpcString(request, 'data'));
      return okResponse(fileToJson(file));
    });
    runtime.registerHandler('vault.delete', async (payload: string, identity: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const gate = manager.fsGate(identity, 'vault.delete', rpcString(request, 'path'));
      if (gate) { return gate; }
      const file = manager.vault.getFileByPath(rpcString(request, 'path'));
      if (!file) { return failResponse('文件不存在'); }
      await manager.vault.delete(file, rpcBool(request, 'force'));
      return okResponse(null);
    });
    runtime.registerHandler('vault.rename', async (payload: string, identity: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      // P2-004:rename 的源与目标路径都必须落在白名单内(否则可借改名把内容移出范围)。
      const gate = manager.fsGate(identity, 'vault.rename', rpcString(request, 'path'));
      if (gate) { return gate; }
      const gateNew = manager.fsGate(identity, 'vault.rename', rpcString(request, 'newPath'));
      if (gateNew) { return gateNew; }
      const file = manager.vault.getFileByPath(rpcString(request, 'path'));
      if (!file) { return failResponse('文件不存在'); }
      await manager.vault.rename(file, rpcString(request, 'newPath'));
      return okResponse(null);
    });
    runtime.registerHandler('vault.append', async (payload: string, identity: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      const gate = manager.fsGate(identity, 'vault.append', rpcString(request, 'path'));
      if (gate) { return gate; }
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
    // M2-B(Tasks 依赖):getAllProperties = frontmatter 投影(T3.1)。
    runtime.registerHandler('metadata.getAllProperties', async (payload: string): Promise<string> => {
      const request = JSON.parse(payload) as RpcRequest;
      if (!manager.metadata) { return failResponse('元数据服务未就绪'); }
      const cache = manager.metadata.getCache(rpcString(request, 'path'));
      const emptyProps: Record<string, Object> = {};
      return okResponse((cache !== null && cache.frontmatter !== null ? cache.frontmatter : emptyProps) as Object);
    });
    runtime.registerHandler('metadata.resolved', async (_payload: string): Promise<string> => {
      if (!manager.metadata) { return failResponse('元数据服务未就绪'); }
      return okResponse(manager.metadata.resolvedLinks() as Object);
    });
    // metadata.graph:同一套解析结果的完整投影(resolved + unresolved),容器据此实现两个 getter。
    runtime.registerHandler('metadata.graph', async (_payload: string): Promise<string> => {
      if (!manager.metadata) { return failResponse('元数据服务未就绪'); }
      const links: Object[] = [];
      for (const occurrence of manager.metadata.linkOccurrences()) {
        links.push(occurrence as Object);
      }
      const graph: Record<string, Object> = {
        'resolved': manager.metadata.resolvedLinks() as Object,
        'unresolved': manager.metadata.unresolvedLinks() as Object,
        'links': links as Object
      };
      pluginLog('元数据图: resolved源=' + Object.keys(graph['resolved'] as Record<string, Object>).length +
        ' unresolved源=' + Object.keys(graph['unresolved'] as Record<string, Object>).length);
      return okResponse(graph);
    });
  }

  private hostEventFor(topic: string): LexiEvents | null {
    if (topic === 'vault') { return this.vault.events; }
    if (topic === 'metadata' && this.metadata) { return this.metadata.events; }
    if (topic === 'workspace') { return this.workspaceEvents; }
    return null;
  }

  private subscribeHostEvent(refId: number, topic: string, name: string, ownerPluginId: string): number {
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
    const subscription = new HostEventSubscription();
    subscription.events = events;
    subscription.name = name;
    subscription.listener = listener;
    subscription.ownerPluginId = ownerPluginId;
    this.hostEventListeners.set(refId, subscription);
    return refId;
  }

  /** 事件订阅当前归属(events.off 所有权复查用);未知 refId 回空串=归属不明。 */
  hostEventOwnerOf(refId: number): string {
    const subscription = this.hostEventListeners.get(refId);
    return subscription ? subscription.ownerPluginId : '';
  }

  private hostEventListeners: Map<number, HostEventSubscription> = new Map();

  private unsubscribeHostEvent(refId: number): void {
    const subscription = this.hostEventListeners.get(refId);
    if (!subscription) { return; }
    subscription.events.off(subscription.name, subscription.listener);
    this.hostEventListeners.delete(refId);
  }

  private manifestFor(pluginId: string): LexiPluginManifest | null {
    if (!pluginId) { return null; }
    const record = this.plugins.get(pluginId);
    return record ? record.manifest : null;
  }

  /** 从清单能力声明推导标签(P2-002:v2 走细粒度唯一正典,v1 保持 legacy 三标签)。 */
  private capabilityTagsOf(manifest: LexiPluginManifest): string[] {
    if (manifest.manifestVersion === 2) {
      // 细粒度正典:editor/notification/storage/quota/paths 扩张 ⇒ 指纹变化 ⇒ regrant-required。
      return capabilityTagsOfV2Caps(manifest.v2);
    }
    // v1(legacy):不自动细粒度化(§8.2 旧权限不继承 Native 权限)。
    const tags: string[] = [];
    if (manifest.capabilitiesDeclared) {
      if (manifest.capabilities.fs) { tags.push('vault.write'); }
      for (const host of manifest.capabilities.network) { tags.push('network:' + host); }
      if (manifest.capabilities.clipboard) { tags.push('clipboard'); }
    }
    return tags;
  }

  /** 从清单能力声明推导指纹(T2.2 授权比较的键)。 */
  private capabilityFingerprintOf(manifest: LexiPluginManifest): string {
    return this.permissionStore.fingerprintOf(this.capabilityTagsOf(manifest));
  }

  /**
   * Plugin Inspector(T5.3):每插件观察报告。
   * 隐私边界:报告只含生命周期/扩展/授权/RPC 审计计数,不含 session token 与用户内容(§10.3)。
   */
  inspectPlugin(pluginId: string): LexiInspectorReport {
    const input = new LexiInspectorInput();
    input.pluginId = pluginId;
    input.lifecycleState = this.lifecycle.stateOf(pluginId);
    const record = this.plugins.get(pluginId);
    input.activationId = this.lifecycle.currentActivationIdOf(pluginId).length > 0
      ? this.lifecycle.currentActivationIdOf(pluginId)
      : (record ? record.activationId : '');
    let extensionCount = 0;
    this.extensionRegistry.list(pluginId).forEach((_record: Object): void => { extensionCount += 1; });
    input.extensionCount = extensionCount;
    const grant = this.permissionStore.grantOf(pluginId);
    input.permissionState = grant !== null ? grant.state : 'not-granted';
    input.capabilityTags = record ? this.capabilityTagsOf(record.manifest) : [];
    input.errorState = record ? record.errorState : '';
    const denies = this.runtime.rpcDenies;
    input.rpcDeniedCount = denies.get(pluginId) === undefined ? 0 : denies.get(pluginId) as number;
    input.rpcAnonymousCount = denies.get('(anonymous)') === undefined ? 0 : denies.get('(anonymous)') as number;
    return LexiPluginInspector.report(input);
  }

  private permissionStorePath(): string {
    return `${this.context ? this.context.filesDir : ''}/plugin-permissions.json`;
  }

  private loadPermissionStore(): void {
    try {
      const path = this.permissionStorePath();
      if (this.context && fs.accessSync(path)) {
        if (!this.permissionStore.load(this.readTextFile(path))) {
          pluginError('权限存储载荷损坏,按空存储继续(fail-closed)');
        }
      }
    } catch { /* 无历史授权按空存储 */ }
  }

  private persistPermissions(): void {
    try {
      if (this.context) { this.writeTextFile(this.permissionStorePath(), this.permissionStore.serialize()); }
    } catch (error) {
      pluginError('权限存储写入失败: ' + String(error));
    }
  }

  /** P1-003a:宿主侧端口挂载(RuntimeHost onPageEnd 建立;幂等)。 */
  attachContextPort(port: webview.WebMessagePort): void {
    if (this.contextPort !== null) {
      pluginLog('context port 已挂载,跳过重复 attach');
      return;
    }
    this.contextPort = port;
    pluginLog('context port attached(页面侧 window.lexiContextPort);帧裁决走 contextRegistry+broker');
  }

  // ------------------------------------------------------------- 沙箱容器(方案 B, ADR-R21-02)

  /** 方案 B:等待容器页 controller 登记(onPageEnd 竞态兜底);100ms 步长轮询。 */
  private async waitForSandboxContainer(timeoutMs: number): Promise<boolean> {
    const deadline = new Date().getTime() + timeoutMs;
    while (new Date().getTime() < deadline) {
      if (this.sandboxController !== null) { return true; }
      await new Promise<string>((resolve: (value: string) => void): void => {
        setTimeout((): void => { resolve('tick'); }, 100);
      });
    }
    return this.sandboxController !== null;
  }

  /** P1-003b 方案 B:沙箱容器页 javaScriptProxy 面(call(frameJson) → 网关)。 */
  attachSandboxController(controller: webview.WebviewController): void {
    this.sandboxController = controller;
    this.runtime.sandboxController = controller;
    pluginLog('sandbox container controller attached(方案 B 容器页就绪)');
  }

  /** 方案 B 入口:容器页 proxy 的同步递交(adjudicate → broker → 异步 handler → 回推 inbox)。 */
  handleSandboxProxyCall(frameJson: string): void {
    let wrapped: Record<string, Object> = {};
    try { wrapped = JSON.parse(frameJson) as Record<string, Object>; } catch (error) { return; }
    const contextId: string = typeof wrapped['contextId'] === 'string' ? wrapped['contextId'] as string : '';
    const innerFrame: Object | undefined = wrapped['frame'];
    if (contextId.length === 0 || typeof innerFrame !== 'string') { return; }
    const gateway = this.contextRegistry.adjudicate(contextId, innerFrame);
    if (!gateway.ok) {
      pluginError('context.rpc contextId=' + contextId + ' allowed=false code=' + gateway.code +
        ' detail=' + gateway.error);
      this.dispatchSandboxResponse(contextId, this.contextRegistry.buildErrorFrame(gateway.code, gateway.error));
      return;
    }
    const record: HostContextRecord | null = this.contextRegistry.recordOf(contextId);
    if (record === null) { return; }
    const authz = this.runtime.broker.authorize(this.contextRegistry.contextOf(record), gateway.method, null);
    if (!authz.allowed) {
      pluginError('context.rpc identity=' + gateway.identity + ' method=' + gateway.method +
        ' allowed=false code=' + authz.code + ' detail=' + authz.reason);
      this.dispatchSandboxResponse(contextId, this.contextRegistry.buildErrorFrame(authz.code, authz.reason));
      return;
    }
    // 身份进入既有调用链:credential = tokenForPlugin(记录身份),与 javaScriptProxy 路径一致。
    const credential = this.runtime.tokenForPlugin(gateway.identity);
    this.runtime.call('sbx-' + gateway.requestId, gateway.method, gateway.payloadJson, credential)
      .then((responseJson: string): void => {
        this.dispatchSandboxResponse(contextId,
          this.contextRegistry.buildResponseFrame(gateway.requestId, true, responseJson, '', ''));
      })
      .catch((error: Object): void => {
        this.dispatchSandboxResponse(contextId,
          this.contextRegistry.buildErrorFrame('context_handler_failed', String(error)));
      });
  }

  /** 响应帧回推容器页 inbox(runJavaScript;宿主→页方向,久经验证通道)。 */
  private dispatchSandboxResponse(contextId: string, frameJson: string): void {
    if (!this.sandboxController) { return; }
    try {
      const frame = JSON.parse(frameJson) as Record<string, Object>;
      const wrapped: Record<string, Object> = {
        'contextId': contextId as Object,
        'frame': frame as Object
      };
      // 页函数期望字符串参数:二次 JSON 编码得到合法 JS 字符串字面量(对象字面量会被页侧当成 object)。
      this.sandboxController.runJavaScript('window.sandboxHostInbox(' + JSON.stringify(JSON.stringify(wrapped)) + ');');
    } catch (error) {
      pluginError('sandbox response 回推失败: ' + String(error));
    }
  }

  /** P1-003a:端口帧 → contextId 反查 → 既有 broker/能力门 → 既有 handler → §3.4 响应帧。 */
  handleContextPortFrame(data: string): void {
    pluginLog('port frame in bytes=' + data.length);
    // Round 20 定位:插件仍在共享 realm,contextId 可被同页代码伪造——本通道的完整安全
    // 语义在 P1-003b iframe 隔离后成立(ADR-R18-01);门禁覆盖 registry 层行为。
    let frame: Record<string, Object> = {};
    try { frame = JSON.parse(data) as Record<string, Object>; } catch (error) { return; }
    const contextId: string = typeof frame['contextId'] === 'string' ? frame['contextId'] as string : '';
    if (contextId.length === 0) { return; }
    const gateway = this.contextRegistry.adjudicate(contextId, data);
    if (!gateway.ok) {
      pluginError('context.rpc contextId=' + contextId + ' allowed=false code=' + gateway.code +
        ' detail=' + gateway.error);
      this.postContextFrame(this.contextRegistry.buildErrorFrame(gateway.code, gateway.error));
      return;
    }
    const record: HostContextRecord | null = this.contextRegistry.recordOf(contextId);
    if (record === null) { return; }
    const ctx = this.contextRegistry.contextOf(record);
    const authz = this.runtime.broker.authorize(ctx, gateway.method, null);
    if (!authz.allowed) {
      pluginError('context.rpc identity=' + gateway.identity + ' method=' + gateway.method +
        ' allowed=false code=' + authz.code + ' detail=' + authz.reason);
      this.postContextFrame(this.contextRegistry.buildErrorFrame(authz.code, authz.reason));
      return;
    }
    // 身份进入既有调用链:credential = tokenForPlugin(记录身份) → call() 内部
    // roleOfCredential/stripClaimedIdentity/authorize 与 javaScriptProxy 路径完全一致。
    const credential = this.runtime.tokenForPlugin(gateway.identity);
    this.runtime.call('ctxport-' + gateway.requestId, gateway.method, gateway.payloadJson, credential)
      .then((responseJson: string): void => {
        this.postContextFrame(this.contextRegistry.buildResponseFrame(gateway.requestId, true, responseJson, '', ''));
      })
      .catch((error: Object): void => {
        this.postContextFrame(this.contextRegistry.buildErrorFrame('context_handler_failed', String(error)));
      });
  }

  private postContextFrame(frameJson: string): void {
    pluginLog('port frame out ' + frameJson.slice(0, 60));
    if (this.contextPort === null) { return; }
    try {
      this.contextPort.postMessageEvent(frameJson);
    } catch (error) {
      pluginError('context.port 发送失败: ' + String(error));
    }
  }

  /** 用户重新授权(设置页/启用确认):按当前清单能力落账,返回是否成功。 */  grantPluginPermissions(pluginId: string): boolean {
    const record = this.plugins.get(pluginId);
    if (!record) { return false; }
    const ok = this.permissionStore.grant(pluginId, record.manifest.version,
      this.capabilityFingerprintOf(record.manifest));
    if (ok) { this.persistPermissions(); }
    return ok;
  }

  /** P2-008:已安装插件当前能力标签(UI 授权展示面;未安装返回空)。 */
  permissionTagsOf(pluginId: string): string[] {
    const record = this.plugins.get(pluginId);
    return record ? this.capabilityTagsOf(record.manifest) : [];
  }

  /** 用户撤销授权(§16.2):立即停用插件并拒绝后续启用。 */
  async revokePluginPermissions(pluginId: string): Promise<boolean> {
    const ok = this.permissionStore.revoke(pluginId);
    if (ok) {
      this.persistPermissions();
      await this.disablePlugin(pluginId);
      this.bumpPluginRevision();
    }
    return ok;
  }

  /** broker 的 fs 写能力判定核心(P2-003):归属失败 fail-closed;v1 legacy;v2 细粒度(delete 独立键)。 */
  private fsAllowedByManifest(pluginId: string, method: string): boolean {
    const manifest: LexiPluginManifest | null = this.manifestFor(pluginId);
    if (manifest === null) { return false; }
    if (manifest.manifestVersion === 2) {
      // RFC §4.4:vault.delete 是独立声明键——只声明 write 不等于可删除(P0-03 收口)。
      return method === 'vault.delete' ? manifest.v2.vault.delete : manifest.v2.vault.write.enabled;
    }
    const decision: LexiCapabilityDecision = checkFsCapability(manifest);
    return decision.allowed;
  }

  /**
   * P2-003:细粒度 capability 判定(方法→能力域→manifest.v2),注入 broker。
   * v1/legacy 清单恒 true(旧权限不自动细粒度化,§8.2);无 v2 键的管理面方法暂放行
   * (缺口登记:P2-008 权限 UI 轮补 manifest 键后收口);data.* 归 storage 域由 fsGate 处理。
   */
  private capabilityAllowedFor(pluginId: string, method: string): boolean {
    const manifest: LexiPluginManifest | null = this.manifestFor(pluginId);
    if (manifest === null) { return false; }
    if (manifest.manifestVersion !== 2) { return true; }
    const caps = manifest.v2;
    if (method === 'vault.files' || method === 'vault.getByPath' || method === 'vault.read' ||
      method.indexOf('metadata.') === 0) { return caps.vault.read.enabled; }
    if (method === 'editor.state') { return caps.editor.readActive; }
    if (method === 'editor.replace' || method === 'editor.applyChanges') { return caps.editor.writeDocument; }
    if (method === 'editor.selection') { return caps.editor.writeSelection; }
    if (method === 'commands.add') { return caps.workspace.commands; }
    if (method === 'views.add') { return caps.workspace.views; }
    if (method === 'codeblocks.register') { return caps.editor.extensions !== 'none'; }
    if (method === 'ui.notice') { return caps.notifications; }
    return true;
  }

  /**
   * 所有权复查入口:处理器在身份敏感的资源操作上带 resource 再问一次 broker。
   * identity 是 call() 已解析的可信归属;role 从原始凭据反推(会话/匿名)。
   */
  private authzFor(identity: string, credential: string, method: string,
    resource: LexiAuthzResource | null): LexiAuthzDecision {
    const role: string = this.runtime.roleOfCredential(credential);
    const ctx: LexiCallerContext = LexiWebRuntime.contextOf(role, role === 'plugin' ? identity : '');
    return this.runtime.broker.authorize(ctx, method, resource);
  }

  /**
   * '' = 放行, 否则返回已序列化的 capability_denied 响应。
   * 身份只认令牌解析结果:归属不到已安装插件时一律 fail-closed(不再套用 v1 清单默认值),
   * 否则"认不出是谁"就成了最省事的越权通道。
   */
  private fsGate(identity: string, method: string, path: string = ''): string {
    const manifest: LexiPluginManifest | null = this.manifestFor(identity);
    if (manifest === null) {
      pluginError('capability.fs method=' + method + ' identity=' + (identity.length > 0 ? identity : '(none)') +
        ' allowed=false fail_closed=true detail=调用方无法归属到已安装插件');
      return failResponseCode(ERROR_CAPABILITY_DENIED, 'fs: 调用方无法归属到已安装插件（fail-closed）');
    }
    // P2-003:插件数据存储不再误绑 vault.write(审计确认的反向绑定——只声明 storage 的
    // v2 插件曾无法读写自己的 data.json)。data.* 归 storage 域,配额执行在 P2-005;
    // v1 清单保持旧门(有 fs 声明才可写,存量语义不变)。
    if (method === 'data.load' || method === 'data.save') {
      if (manifest.manifestVersion === 2) { return ''; }
      const legacyStorage: LexiCapabilityDecision = checkFsCapability(manifest);
      if (legacyStorage.allowed) { return ''; }
      pluginError('capability.storage method=' + method + ' identity=' + identity +
        ' allowed=false detail=' + legacyStorage.detail);
      return failResponseCode(legacyStorage.code, legacyStorage.kind + ': ' + legacyStorage.detail);
    }
    // P2-004(RFC §4.4):v2 清单的写路径白名单(vault.write.paths;空=全库,与旧 fs 布尔一致)。
    if (manifest.manifestVersion === 2 && path.length > 0 &&
      !vaultPathAllowed(path, manifest.v2.vault.write.enabled, manifest.v2.vault.write.paths)) {
      pluginError('capability.path method=' + method + ' identity=' + identity + ' path=' + path +
        ' allowed=false detail=路径不在 vault.write.paths 白名单');
      return failResponseCode(ERROR_CAPABILITY_DENIED, 'fs: 路径不在 vault.write.paths 白名单: ' + path);
    }
    const decision: LexiCapabilityDecision = checkFsCapability(manifest);
    if (decision.allowed) { return ''; }
    pluginError('capability.fs method=' + method + ' identity=' + identity + ' allowed=false detail=' + decision.detail);
    return failResponseCode(decision.code, decision.kind + ': ' + decision.detail);
  }

  /** P2-004:v2 读路径白名单(vault.read.paths);v1/legacy 无此维度放行(域声明由 broker gate 判定)。 */
  private vaultReadGate(identity: string, path: string): string {    const manifest: LexiPluginManifest | null = this.manifestFor(identity);
    if (manifest === null || manifest.manifestVersion !== 2) { return ''; }
    if (!manifest.v2.vault.read.enabled) {
      pluginError('capability.read method=vault.read identity=' + identity +
        ' allowed=false detail=清单未声明 vault.read');
      return failResponseCode(ERROR_CAPABILITY_DENIED, 'fs: 清单未声明 vault.read');
    }
    if (!vaultPathAllowed(path, true, manifest.v2.vault.read.paths)) {
      pluginError('capability.path method=vault.read identity=' + identity + ' path=' + path +
        ' allowed=false detail=路径不在 vault.read.paths 白名单');
      return failResponseCode(ERROR_CAPABILITY_DENIED, 'fs: 路径不在 vault.read.paths 白名单: ' + path);
    }
    return '';
  }

  /**
   * P2-005(RFC §4.4/§10.1):插件存储配额宿主端强制执行(不能只靠 manifest 声明)。
   * v2 按清单 storage.quotaBytes 拒绝超限写入;v1/legacy 沿用无配额旧语义(存量不变)。
   * 字节账按 UTF-16 码元近似(dataJson.length),配额语义为字符量级约束。
   */
  private storageQuotaGate(identity: string, dataLength: number): string {
    const manifest: LexiPluginManifest | null = this.manifestFor(identity);
    if (manifest === null || manifest.manifestVersion !== 2) { return ''; }
    const quota = manifest.v2.storage.quotaBytes;
    if (quota <= 0 || dataLength <= quota) { return ''; }
    pluginError('capability.quota method=data.save identity=' + identity + ' bytes=' + dataLength +
      ' quota=' + quota + ' allowed=false detail=写入超出 storage.quotaBytes');
    return failResponseCode(ERROR_CAPABILITY_DENIED, 'storage: 数据量 ' + dataLength + ' 超出配额 ' + quota);
  }

  /**
   * net.requestUrl 的宿主适配层：令牌→身份、capability.net 判定、超时与传输全在 LexiNetProbe，
   * 这里只把判定结果序列化成 RpcResponse(失败带 code，成功带 status/headers/text)。
   */
  private async performRequest(payloadJson: string, identity: string, token: string): Promise<string> {
    const deps = new LexiNetDeps((value: string): string => this.runtime.pluginIdForToken(value),
      (pluginId: string): LexiPluginManifest | null => this.manifestFor(pluginId),
      this.netTransport,
      (message: string): void => pluginLog(message),
      (message: string): void => pluginError(message),
      NET_TIMEOUT_MS);
    const outcome: LexiNetOutcome = await executeNetRequest(payloadJson, identity, token, deps);
    if (!outcome.ok) { return failResponseCode(outcome.code, outcome.error); }
    const headersOut: Record<string, Object> = {};
    for (const key of Object.keys(outcome.headers)) { headersOut[key] = outcome.headers[key] as Object; }
    const result: Record<string, Object> = {
      'status': outcome.status as Object,
      'headers': headersOut as Object,
      'text': outcome.text as Object
    };
    return okResponse(result);
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
    if (!record) { return false; }
    // 幂等早退(RFC §4.5):已启用/已运行的插件重复 enable 不得再派发 onload。
    if (record.enabled || this.lifecycle.stateOf(pluginId) === 'running') { return true; }
    // 状态机起停:installed/failed → starting;running 中 alreadyRunning=true 同样早退。
    const start = this.lifecycle.beginStartIfNotRunning(pluginId, record.manifest.version);
    if (!start.ok) {
      record.errorState = start.reason;
      pluginError('插件启动被拒 ' + pluginId + ': ' + start.reason);
      return false;
    }
    const activationId = start.activation !== null ? start.activation.activationId : '';
    const compatMessage = manifestCompatMessage(record.manifest);
    if (compatMessage.length > 0) {
      record.errorState = compatMessage;
      pluginError('插件版本不兼容: ' + pluginId + ' — ' + compatMessage);
      return false;
    }
    // 授权决定门(T2.2/P2-010):撤销状态对所有清单版本生效——用户明确"不许"不因 v1
    // 而失效(此前 v1 撤销后仍可重新启用,撤销语义被版本门短路)。指纹级 regrant 与
    // 首启落账仍只对声明型清单(v1 沿用启用即授权、无指纹折腾的存量语义)。
    const storedGrant = this.permissionStore.grantOf(pluginId);
    if (storedGrant !== null && storedGrant.state === 'revoked') {
      record.errorState = '插件权限已被用户撤销,请在设置中重新授权';
      pluginError('插件启用被拒 ' + pluginId + ': ' + record.errorState);
      return false;
    }
    if (record.manifest.capabilitiesDeclared) {
      const fingerprint = this.capabilityFingerprintOf(record.manifest);
      const decision = this.permissionStore.decisionFor(pluginId, record.manifest.version, fingerprint);
      if (decision === PERMISSION_REGRANT_REQUIRED) {
        record.errorState = '插件升级引入权限变化,需要重新授权';
        pluginError('插件启用被拒 ' + pluginId + ': ' + record.errorState);
        return false;
      }
      if (decision !== PERMISSION_GRANTED) {
        // 首次启用:用户显式启用即授权(记录版本+能力指纹),宿主据此落账。
        this.permissionStore.grant(pluginId, record.manifest.version, fingerprint);
        this.persistPermissions();
        pluginLog('插件首次授权: ' + pluginId + ' v' + record.manifest.version);
      }
    }
    const mainPath = `${record.dir}/main.js`;
    if (!fs.accessSync(mainPath)) {
      record.errorState = '插件缺少 main.js';
      pluginError('插件缺少 main.js: ' + pluginId);
      return false;
    }
    try {
      // 上一次尝试留下的失败记录不能冒充本次结果:先清空,再由 onload 回调写回
      record.errorState = '';
      const code = this.readTextFile(mainPath);
      this.pluginSources.set(pluginId, code);
      // 装载令牌由本运行时铸造:页面侧后续每一次宿主调用(含源码分片)都靠它证明"我是哪个插件"。
      const token: string = this.runtime.mintPluginToken(pluginId);
      if (token.length === 0) { throw new Error('插件令牌铸造失败: ' + pluginId); }
      // P1-003b 沙箱轨:声明式 opt-in(entrypoints.service='sandbox:')的插件经 per-plugin
      // iframe(opaque origin)以端口身份装载,不进共享 realm `new Function`(ADR-R18-01)。
      // Round 21 发现:runtime 宿主页上 iframe→parent 与容器页 MessageChannel 两条跨帧
      // 回路均静默丢帧(真机证据链 r21h/r21i2/r21j;PoC 独立页同代码双向通)——沙箱容器迁往
      // 独立 Web 组件(方案 B,ADR-R21-02)前,此轨由运行开关显式启用,默认回落旧轨。
      const sandboxTrackOn = this.sandboxController !== null ||
        (await LexiStorageService.getSetting('lexiPluginSandboxTrack', 'false')) === 'true';
      if (record.manifest.sandboxService && sandboxTrackOn) {
        // 容器页 onPageEnd 的 attach 可能晚于 runtime.ready(竞态,Round 22 真机实测):
        // 短等待直至控制器登记;超时按 fail-closed 拒装(声明沙箱的插件不悄悄跑旧轨)。
        const containerReady = await this.waitForSandboxContainer(5000);
        if (!containerReady) { throw new Error('沙箱容器未就绪(等待超时)'); }
        const contextRecord = this.contextRegistry.ensureService(pluginId, activationId);
        const sandboxBoot: Record<string, Object> = {
          'contextId': contextRecord.contextId as Object,
          'code': code as Object,
          'manifestJson': JSON.stringify(record.manifest) as Object
        };
        pluginLog('沙箱轨装载: ' + pluginId + ' context=' + contextRecord.contextId);
        await this.runtime.waitReady();
        await this.runtime.dispatchSandboxBoot(JSON.stringify(sandboxBoot));
        record.enabled = true;
        record.activationId = activationId;
        this.enabledIds.add(pluginId);
        await this.persistEnabled();
        pluginLog('插件已启用(沙箱轨): ' + pluginId + ' activation=' + activationId);
        this.bumpPluginRevision();
        return true;
      }
      // 大源码经 runJavaScript 直传会静默挂起,改为分片拉取
      const payloadBody: Record<string, Object> = {
        'id': pluginId as Object,
        'manifest': record.manifest as Object,
        'size': code.length as Object,
        'token': token as Object
      };
      const payload = JSON.stringify(payloadBody);
      const done = new Promise<void>((resolve: () => void): void => { this.pendingOnload.set(pluginId, resolve); });
      await this.runtime.waitReady();
      pluginLog('插件源码就绪: ' + pluginId + ' ' + code.length + ' 字符');
      await this.runtime.dispatchWithTimeout('load.plugin', payload, LOAD_TIMEOUT_MS);
      await LexiWebRuntime.withTimeout(done, LOAD_TIMEOUT_MS, 'onload');
      // 垫片把 onload 成功与失败都当作"装载结束"唤醒同一个等待点(见 plugin.onload.error),
      // 所以这里必须回读 errorState:非空即装载失败,不许落进"已启用"分支把它抹成正常。
      if (record.errorState.length > 0) {
        pluginError('插件装载失败 ' + pluginId + ': ' + record.errorState);
        if (activationId.length > 0) { this.lifecycle.markFailed(activationId, record.errorState); }
        return false;
      }
      record.enabled = true;
      record.activationId = activationId;
      // 主执行上下文(service):插件后台 RPC/命令/事件的宿主侧记账点。
      if (activationId.length > 0) {
        this.lifecycle.createContext(activationId, 'service');
        // P1-003a:contextRegistry 注册端口身份(iframe 沙箱接入后成为 RPC 身份真源);
        // 沙箱轨已在 dispatch 前经 ensureService 注册,此处幂等兜底。
        this.contextRegistry.ensureService(pluginId, activationId);
      }
      this.enabledIds.add(pluginId);
      await this.persistEnabled();
      pluginLog('插件已启用: ' + pluginId + ' activation=' + activationId);
      this.bumpPluginRevision();
      return true;
    } catch (error) {
      record.errorState = String(error);
      pluginError('插件启用失败 ' + pluginId + ': ' + String(error));
      this.pendingOnload.delete(pluginId);
      if (activationId.length > 0) { this.lifecycle.markFailed(activationId, String(error)); }
      return false;
    }
  }

  async disablePlugin(pluginId: string): Promise<void> {
    const record = this.plugins.get(pluginId);
    pluginLog('请求停用插件: ' + pluginId + ' (当前启用=' + (record ? record.enabled : false) + ')');
    if (!record || !record.enabled) { return; }
    const activationId = this.lifecycle.currentActivationIdOf(pluginId);
    if (activationId.length > 0) {
      // 先释放后停(RFC §4.3):关闭宿主侧记账的全部执行上下文,再请求状态机迁移。
      for (const ctx of this.lifecycle.contextsOf(activationId)) {
        this.lifecycle.closeContext(ctx.contextId);
      }
      const stop = this.lifecycle.beginStop(activationId, 'user-disable');
      if (!stop.ok) {
        // 状态机拒绝(仍有未关上下文等):强制隔离后释放残骸(§4.3 强制停止语义)。
        pluginError('插件停止被拒 ' + pluginId + ': ' + stop.reason + ' → 强制隔离');
        this.lifecycle.quarantine(activationId, stop.reason);
        const forced = this.lifecycle.beginStop(activationId, 'forced-quarantine-release');
        if (!forced.ok) { return; }
      }
    }
    try {
      await this.runtime.waitReady();
      const done = new Promise<void>((resolve: () => void): void => { this.pendingUnload.set(pluginId, resolve); });
      const unloadBody: Record<string, Object> = { 'id': pluginId as Object };
      await this.runtime.dispatchWithTimeout('unload.plugin', JSON.stringify(unloadBody), LOAD_TIMEOUT_MS);
      await LexiWebRuntime.withTimeout(done, LOAD_TIMEOUT_MS, 'onunload');
    } catch { /* force removal locally even if the runtime page is gone */ }
    this.pendingUnload.delete(pluginId);
    // onunload 逻辑完成(含页面丢失的强制路径):stopping → disabled,凭据与扩展随后回收。
    if (activationId.length > 0) { this.lifecycle.markStopped(activationId); }
    record.enabled = false;
    record.activationId = '';
    this.extensionRegistry.unregisterPlugin(pluginId);
    this.viewSessions.dropPlugin(pluginId);
    this.commands.removePluginCommands(pluginId);
    LexiPluginViewRegistry.removePlugin(pluginId);
    this.settingDefs.delete(pluginId);
    this.pluginSources.delete(pluginId);
    this.runtime.revokePluginTokens(pluginId);
    // P1-003a:同步吊销端口身份(撤销/停用立即生效的载体级形态,P2-010 联动)。
    const revokedContexts = this.contextRegistry.revokePlugin(pluginId);
    if (revokedContexts > 0) { pluginLog('context registry 吊销 ' + revokedContexts + ' 个上下文: ' + pluginId); }
    const doomedRibbons: string[] = [];
    this.ribbonItems.forEach((row: LexiRibbonRow, key: string): void => {
      if (row.pluginId === pluginId) { doomedRibbons.push(key); }
    });
    for (const key of doomedRibbons) { this.ribbonItems.delete(key); }
    const languages: string[] = [];
    this.codeBlockPlugins.forEach((owner: string, language: string): void => {
      if (owner === pluginId) { languages.push(language); }
    });
    for (const language of languages) { this.codeBlockPlugins.delete(language); }
    this.enabledIds.delete(pluginId);
    await this.persistEnabled();
    pluginLog('插件已停用: ' + pluginId);
    this.bumpPluginRevision();
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
  /** 订阅归属插件(events.off 所有权复查的唯一真源)。 */
  ownerPluginId: string = '';
}

export class LexiRibbonRow {
  pluginId: string = '';
  title: string = '';
  iconId: string = '';
  iconPath: string = '';
}
