import { LexiPluginManager } from '../core/plugin/LexiPluginRuntime';
import { LexiInstalledPlugin, LexiPluginManifest } from '../core/plugin/LexiPluginManifest';
import { resolvePluginTrack, TRACK_REFUSED } from '../core/plugin/LexiPluginTrackPolicy';
import { mintCredential } from '../core/plugin/LexiCredentialFactory';
import { LexiCallerContext, LexiCallerRole } from '../core/plugin/LexiPermissionBroker';
import { LexiRpcGateway } from '../core/plugin/LexiRpcGateway';
import { LexiNoteChange } from '../core/plugin/LexiPluginBus';
import { LexiFileEventPayload } from '../core/plugin/LexiVaultFacade';
import { LexiTFile } from '../core/plugin/LexiVaultModel';
import { WorkspaceLog } from './WorkspaceLog';
import { WorkspacePluginEntry, WorkspacePluginRegistry } from './WorkspacePluginCatalog';
import {
  DEFAULT_THEME_SOURCE,
  WorkspaceThemeCatalog,
  WorkspaceThemeCss,
  WorkspaceThemeInstallResult,
  WorkspaceThemeSummary
} from './WorkspaceThemeCatalog';
import {
  WORKSPACE_CALL_TIMEOUT_MS,
  WORKSPACE_EVENT_NOTE_OPEN,
  WORKSPACE_MAX_BATCH,
  WORKSPACE_METHOD_NOTE_WRITE,
  WORKSPACE_PROTOCOL_VERSION,
  fieldOf,
  parseWorkspaceFrame,
  textOf,

  WorkspaceAuthData,
  WorkspaceBatchReply,
  WorkspaceCall,
  WorkspaceCallReply,
  WorkspaceEventFrame,
  WorkspaceHelloData,
  WorkspacePayload,
  WorkspacePluginDescriptorData,
  WorkspacePluginListData,
  WorkspacePong,
  WorkspaceReply
} from './WorkspaceProtocol';

const ERR_UNAUTHORIZED: string = 'unauthorized';
const ERR_BAD_REQUEST: string = 'bad_request';
const ERR_UNKNOWN_METHOD: string = 'unknown_method';
const ERR_UNKNOWN_PLUGIN: string = 'unknown_plugin';
const ERR_ALREADY_AUTHED: string = 'already_authed';
const ERR_HOST_NOT_READY: string = 'host_not_ready';
const ERR_TIMEOUT: string = 'timeout';
const ERR_BATCH_OVERFLOW: string = 'batch_overflow';
const ERR_UNKNOWN_THEME: string = 'unknown_theme';
const ERR_INSTALL_FAILED: string = 'install_failed';
const ERR_NOTE_NOT_FOUND: string = 'note_not_found';
const ERR_WRITE_FAILED: string = 'write_failed';
/** P1-011(S1):装载门 ① 轨政策拒绝(沙箱声明插件 / legacy 轨停用开关关死)。 */
const ERR_PLUGIN_TRACK_REFUSED: string = 'plugin_track_refused';
/** P1-011(S1):装载门 ② 授权同意缺失(未启用 / 声明型清单授权态非 granted)。 */
const ERR_PLUGIN_CONSENT_REQUIRED: string = 'plugin_consent_required';

/** theme.config / theme.list 的应答形状:安装源 + 已装主题 + 当前激活项。 */
interface WorkspaceThemeListData {
  source: string;
  active: string;
  themes: WorkspaceThemeSummary[];
}

/** theme.setActive 的应答形状。 */
interface WorkspaceThemeActiveData {
  active: string;
  themes: WorkspaceThemeSummary[];
}

/** 会话身份:页面级令牌映射到这个空 pluginId(全局 app/vault/workspace/editor 调用不归属任何插件)。 */
const SESSION_PLUGIN_ID: string = '';

/** 旧宿主 LexiWebRuntime.call() 的应答形状:{"ok":true,"result":…} | {"ok":false,"error":"…"}。 */
interface LegacyOutcome {
  ok?: boolean;
  result?: Object | null;
  error?: string;
  /** 机器可读失败原因(capability_denied/timeout/…):必须原样传给页面,否则插件侧只看得到 unknown_method。 */
  code?: string;
}

/**
 * Frame-protocol v1 adapter (spec section 2) over the two things this track must not duplicate:
 *  - identity: the host mints a session token at channel.auth and one token per plugin at plugin.load;
 *    identity only ever travels out-of-band as the call's token argument. payload.pluginId is never
 *    trusted and never rewritten: LexiPluginRuntime ignores it and logs an audit line (spec 13.1).
 *  - business methods: delegated to the old host's 41 handlers instead of a second implementation.
 */
export class WorkspaceBridge {
  private readonly managerReady: Promise<LexiPluginManager | null>;
  private registry: WorkspacePluginRegistry = new WorkspacePluginRegistry();
  private registryLoaded: boolean = false;
  /** token -> pluginId ('' means the page session). Tokens die with plugin.unload / page teardown. */
  private tokens: Map<string, string> = new Map<string, string>();
  /**
   * 桥侧身份 → 宿主凭据(RFC §3.4):delegate 转发宿主调用时必须携带运行时铸造的凭据,
   * 不得把 token 表解析出的 pluginId 字符串直接当身份传下去。
   */
  private runtimeSessionCredential: string = '';
  private runtimePluginCredentials: Map<string, string> = new Map<string, string>();
  /**
   * 桥面授权矩阵(T0.3):bridge 原生方法(hello/auth/插件控制面/主题/note.write/demo)
   * 在进分支处理前必须过授权判定;fs/network 判定不在这里(桥面没有这类方法)。
   * P1-007(R31)RPC 入口归一:桥内第二个 LexiPermissionBroker 实例删除,授权改走
   * 单一 Gateway(LexiRpcGateway.shared,与 runtime 同一份判定器)。桥面语义不变的
   * 依据:桥面方法只有 public/control-plane/demo-plugin 三类(fs/capability 两个 seam
   * 在这三类上从不触发),与旧桥内实例(默认 fail-closed)的判定逐格一致;delegate 转发
   * 的业务方法在 runtime.call 内仍过同一 Gateway 的 authorize(既有双重裁决收敛为一处)。
   */
  private readonly rpcGateway: LexiRpcGateway = LexiRpcGateway.shared;
  private channelId: string = '';
  private nonce: string = '';
  private authed: boolean = false;
  private seq: number = 0;
  private minted: number = 0;
  /** 页面首帧渲染完成后置真:在此之前 workspace.onLayoutReady 的调用者排队等真实布局。 */
  private layoutReady: boolean = false;
  private layoutWaiters: Array<() => void> = [];
  /** 宿主→页面事件帧的下推出口(由页面注入,复用同一个 WebMessagePort)。 */
  private eventSink: ((text: string) => void) | null = null;
  /** 宿主事件源只订阅一次:同一个 manager 的所有 vault/metadata/workspace 事件都走这几条线。 */
  private eventsAttached: boolean = false;
  private managerRef: LexiPluginManager | null = null;
  /** 装载序号:异步读正文期间又来了新的 file-open 时,旧的那次只落日志、不再下推(防乱序覆盖)。 */
  private noteSeq: number = 0;
  /** 路由参数带来的初始笔记:页面只给 noteId,path 由宿主索引反查(页面不自填路径/身份)。 */
  private initialNoteId: string = '';
  private initialNoteSent: boolean = false;

  private readonly themes: WorkspaceThemeCatalog;

  constructor(managerReady: Promise<LexiPluginManager | null>, themes: WorkspaceThemeCatalog) {
    this.managerReady = managerReady;
    this.themes = themes;
  }

  /** Always returns the text to post back; an empty string means "no reply for this frame". */
  async handleText(text: string): Promise<string> {
    const frame = parseWorkspaceFrame(text);
    if (frame === null) {
      WorkspaceLog.warn('frame.reject', 'not a protocol v1 frame, bytes=' + text.length);
      return '';
    }
    const calls: Array<WorkspaceCall> | undefined = frame.calls;
    if (calls !== undefined && calls.length > 0) {
      return this.handleBatch(calls, textOf(frame.token));
    }
    const reply: WorkspaceCallReply = await this.dispatch(textOf(frame.method), textOf(frame.token), frame.payload);
    const single: WorkspaceReply = {
      v: WORKSPACE_PROTOCOL_VERSION,
      id: textOf(frame.id),
      ok: reply.ok
    };
    if (reply.data !== undefined) {
      single.data = reply.data;
    }
    if (reply.error !== undefined) {
      single.error = reply.error;
    }
    return JSON.stringify(single);
  }

  private async handleBatch(calls: Array<WorkspaceCall>, token: string): Promise<string> {
    // 超限不是"截断后当没事":整批拒绝并给出明确错误码,页面侧 sendBatch 也会先本地拦一层。
    if (calls.length > WORKSPACE_MAX_BATCH) {
      WorkspaceLog.warn('frame.batch.overflow',
        'calls=' + calls.length + ' limit=' + WORKSPACE_MAX_BATCH + ' code=' + ERR_BATCH_OVERFLOW);
      const refusal: WorkspaceReply = {
        v: WORKSPACE_PROTOCOL_VERSION,
        id: '',
        ok: false,
        error: { code: ERR_BATCH_OVERFLOW, message: '单批上限 ' + WORKSPACE_MAX_BATCH + ',收到 ' + calls.length }
      };
      return JSON.stringify(refusal);
    }
    const replies: Array<WorkspaceCallReply> = [];
    for (const call of calls) {
      const reply: WorkspaceCallReply = await this.dispatch(textOf(call.method), token, call.payload);
      reply.id = textOf(call.id);
      replies.push(reply);
    }
    WorkspaceLog.info('frame.batch', 'calls=' + replies.length + ' limit=' + WORKSPACE_MAX_BATCH);
    const batch: WorkspaceBatchReply = { v: WORKSPACE_PROTOCOL_VERSION, calls: replies };
    return JSON.stringify(batch);
  }

  /** 页面注入事件通道:与请求-应答共用端口,但事件帧只有一个方向(宿主→页面)。 */
  setEventSink(sink: (text: string) => void): void {
    this.eventSink = sink;
  }

  /** 页面把路由参数里的笔记标识交给桥:装载复用 file-open→note-open 同一条通道,只是起点换成本地 id。 */
  setInitialNote(noteId: string): void {
    this.initialNoteId = noteId;
  }

  /** spec section 2 事件帧:{v:1,type:'event',topic,payload}。 */
  pushEvent(topic: string, payload: Object): void {
    const sink = this.eventSink;
    if (sink === null) {
      WorkspaceLog.warn('frame.event.drop', 'topic=' + topic + ' sink missing');
      return;
    }
    const frame: WorkspaceEventFrame = {
      v: WORKSPACE_PROTOCOL_VERSION,
      type: 'event',
      topic: topic,
      payload: payload
    };
    WorkspaceLog.info('frame.event.out', 'topic=' + topic + ' bytes=' + JSON.stringify(frame).length);
    sink(JSON.stringify(frame));
  }

  private async dispatch(method: string, token: string, payload: WorkspacePayload | undefined): Promise<WorkspaceCallReply> {
    // 桥面授权(T0.3):token 表解析角色 → broker 矩阵。未知令牌=anonymous,除 public 外全拒。
    const authzReply: WorkspaceCallReply | null = this.bridgeAuthorize(token, method);
    if (authzReply !== null) {
      return authzReply;
    }
    if (method === 'channel.hello') {
      return this.onHello();
    }
    if (method === 'channel.auth') {
      return this.onAuth(payload);
    }
    if (method === 'log.event') {
      return this.onLogEvent(payload);
    }
    if (method === 'plugin.list' || method === 'plugin.load') {
      if (!this.authed) {
        return this.fail(ERR_UNAUTHORIZED, 'channel.auth 未完成');
      }
      // RFC T0.1:plugin 控制面只允许页面会话角色。插件令牌(已归属插件的调用方,
      // 例如容器里跑起来的插件本体)不得装载/列举其他插件,否则等于把别人的源码和
      // 全新身份凭据递到对手手里。
      const owner: string | undefined = this.tokens.get(token);
      if (owner === undefined || owner !== SESSION_PLUGIN_ID) {
        WorkspaceLog.warn('plugin.controlplane',
          'method=' + method + ' deny=non_session identity=' + (owner === undefined ? '(unknown token)' : owner));
        return this.fail(ERR_UNAUTHORIZED, '插件控制面只允许页面会话调用');
      }
      if (method === 'plugin.list') {
        return this.onPluginList();
      }
      return this.onPluginLoad(payload);
    }
    if (method === 'plugin.unload') {
      return this.onPluginUnload(token);
    }
    if (method === 'demo.ready' || method === 'demo.ping') {
      return this.onDemoHostCall(method, token);
    }
    if (method === 'workspace.onLayoutReady') {
      if (this.layoutReady) {
        WorkspaceLog.info('frame.layoutReady', 'immediate=true waiters=0');
        return this.success(null);
      }
      return this.waitLayoutReady();
    }
    if (method === 'workspace.layoutReady') {
      this.markLayoutReady();
      return this.success(null);
    }
    if (method === 'theme.config' || method === 'theme.list' || method === 'theme.load' ||
      method === 'theme.install' || method === 'theme.setActive') {
      if (!this.authed) {
        return this.fail(ERR_UNAUTHORIZED, 'channel.auth 未完成');
      }
      return this.onTheme(method, payload);
    }
    if (method === WORKSPACE_METHOD_NOTE_WRITE) {
      return this.onNoteWrite(token, payload);
    }
    return this.delegate(method, token, payload);
  }

  /** 桥面授权:token → 角色(会话/插件/匿名),单一 Gateway 的矩阵判定(P1-007);允许时返回 null。 */
  private bridgeAuthorize(token: string, method: string): WorkspaceCallReply | null {
    const owner: string | undefined = this.tokens.get(token);
    const ctx = new LexiCallerContext();
    if (owner === undefined) {
      ctx.role = 'anonymous' as LexiCallerRole;
    } else if (owner === SESSION_PLUGIN_ID) {
      ctx.role = 'session' as LexiCallerRole;
    } else {
      ctx.role = 'plugin' as LexiCallerRole;
      ctx.pluginId = owner;
    }
    const authz = this.rpcGateway.authorize(ctx, method, null);
    if (authz.allowed) {
      return null;
    }
    WorkspaceLog.warn('bridge.authz',
      'method=' + method + ' role=' + ctx.role + ' kind=' + authz.kind +
      ' code=' + authz.code + ' reason=' + authz.reason);
    return this.fail(authz.code, authz.reason);
  }

  private onHello(): WorkspaceCallReply {
    this.nonce = this.mint('n');
    this.channelId = this.mint('ch');
    WorkspaceLog.info('channel.hello', 'channelId=' + this.channelId);
    const data: WorkspaceHelloData = {
      nonce: this.nonce,
      channelId: this.channelId,
      protocol: WORKSPACE_PROTOCOL_VERSION
    };
    return this.success(data);
  }

  private onAuth(payload: WorkspacePayload | undefined): WorkspaceCallReply {
    if (this.authed) {
      return this.fail(ERR_ALREADY_AUTHED, '通道已鉴权');
    }
    const offered: string = fieldOf(payload, 'nonce');
    if (this.nonce.length === 0 || offered !== this.nonce) {
      WorkspaceLog.warn('channel.auth', 'nonce mismatch');
      return this.fail(ERR_UNAUTHORIZED, 'nonce 校验失败');
    }
    this.authed = true;
    this.nonce = '';
    // 身份在这里出生:token -> pluginId('' = 页面会话),此后所有调用只认它。
    const sessionToken: string = this.mint('st');
    this.tokens.set(sessionToken, SESSION_PLUGIN_ID);
    // 身份就绪后立刻接上宿主事件源:插件 onload 期间发生的 vault 变化也必须能到页面。
    this.managerReady.then((ready: LexiPluginManager | null): void => {
      if (ready !== null) {
        this.attachHostEvents(ready);
      }
    });
    const data: WorkspaceAuthData = {
      channelId: this.channelId,
      authed: true,
      protocol: WORKSPACE_PROTOCOL_VERSION,
      token: sessionToken
    };
    WorkspaceLog.info('channel.auth',
      'channelId=' + this.channelId + ' authed=true tokenTail=' + this.tail(sessionToken));
    return this.success(data);
  }

  /** 订阅宿主三类事件源并转成事件帧:topic 与 Obsidian 同名(vault/metadata/workspace)。 */
  private attachHostEvents(manager: LexiPluginManager): void {
    if (this.eventsAttached) {
      return;
    }
    this.eventsAttached = true;
    this.managerRef = manager;
    manager.vault.events.on('create', (payload: Object | null): void => { this.pushVault('create', payload); });
    manager.vault.events.on('modify', (payload: Object | null): void => { this.pushVault('modify', payload); });
    manager.vault.events.on('delete', (payload: Object | null): void => { this.pushVault('delete', payload); });
    manager.vault.events.on('rename', (payload: Object | null): void => { this.pushVault('rename', payload); });
    const metadata = manager.metadata;
    if (metadata !== null) {
      metadata.events.on('changed', (payload: Object | null): void => { this.pushMetadata('changed', payload); });
      metadata.events.on('resolved', (payload: Object | null): void => { this.pushMetadata('resolved', payload); });
    }
    manager.workspaceEvents.on('file-open', (payload: Object | null): void => {
      this.pushWorkspace('file-open', payload);
      this.openNoteOf(payload);
    });
    manager.workspaceEvents.on('layout-change', (payload: Object | null): void => { this.pushWorkspace('layout-change', payload); });
    WorkspaceLog.info('frame.event.source', 'vault=4 metadata=2 workspace=2');
  }

  private pushVault(kind: string, payload: Object | null): void {
    const event: LexiFileEventPayload | null = payload as LexiFileEventPayload | null;
    const frame: Record<string, Object> = { 'name': kind as Object };
    if (event !== null) {
      frame['file'] = this.fileJson(event.file);
      frame['oldPath'] = event.oldPath as Object;
    }
    this.pushEvent('vault', frame);
  }

  private pushMetadata(kind: string, payload: Object | null): void {
    const frame: Record<string, Object> = { 'name': kind as Object };
    if (kind === 'changed') {
      const change: LexiNoteChange | null = payload as LexiNoteChange | null;
      if (change !== null && change.noteId.length > 0) {
        frame['noteId'] = change.noteId as Object;
        const manager = this.managerRef;
        const file: LexiTFile | null = manager === null ? null : manager.vault.fileForNoteId(change.noteId);
        if (file !== null && file.path.length > 0) {
          frame['path'] = file.path as Object;
        }
      }
    }
    // 解析图与事件同帧下发:插件在 changed/resolved 回调里同步读 resolvedLinks 必须已是新值。
    // 只再发一次异步 RPC 会让这条读取稳定读到上一版图(实测 rename 后 oldLinkGone 恒为 false)。
    const owner = this.managerRef;
    if (owner !== null && owner.metadata !== null) {
      const occurrences: Object[] = [];
      for (const occurrence of owner.metadata.linkOccurrences()) { occurrences.push(occurrence as Object); }
      const graph: Record<string, Object> = {
        'resolved': owner.metadata.resolvedLinks() as Object,
        'unresolved': owner.metadata.unresolvedLinks() as Object,
        'links': occurrences as Object
      };
      frame['graph'] = graph;
    }
    this.pushEvent('metadata', frame);
  }

  private pushWorkspace(kind: string, payload: Object | null): void {
    const frame: Record<string, Object> = { 'name': kind as Object };
    if (payload !== null) {
      const record: Record<string, Object> = payload as Record<string, Object>;
      if (record['path'] !== undefined) {
        frame['file'] = payload;
      }
    }
    this.pushEvent('workspace', frame);
  }

  /**
   * 装载方向:file-open 的 path 取出正文,再以 note-open 事件下推给页面。
   * 读文件只走 vault 既有读取实现(getFileByPath + read),不直读文件系统绕开门禁。
   */
  private openNoteOf(payload: Object | null): void {
    const path: string = payload === null ? '' : WorkspaceBridge.pathOf(payload);
    if (path.length === 0) {
      WorkspaceLog.warn('note.open.skip', 'reason=empty_path');
      return;
    }
    this.noteSeq += 1;
    this.pumpNote(path, this.noteSeq);
  }

  /**
   * 初始笔记只在页面报过布局就绪后装载一次:那时页面的事件钩子已经装好,早推的 note-open 会被丢掉。
   * 身份化路径不变——noteId 来自路由参数,path 由 vault 索引给出。
   */
  private openInitialNote(): void {
    if (this.initialNoteSent || this.initialNoteId.length === 0) {
      return;
    }
    const manager: LexiPluginManager | null = this.managerRef;
    if (manager === null) {
      WorkspaceLog.warn('note.open.initial', 'reason=host_not_ready noteId=' + this.initialNoteId);
      return;
    }
    const file: LexiTFile | null = manager.vault.fileForNoteId(this.initialNoteId);
    if (file === null) {
      this.initialNoteSent = true;
      WorkspaceLog.warn('note.open.initial', 'miss noteId=' + this.initialNoteId);
      return;
    }
    this.initialNoteSent = true;
    this.noteSeq += 1;
    WorkspaceLog.info('note.open.initial',
      'noteId=' + this.initialNoteId + ' path=' + file.path + ' seq=' + this.noteSeq);
    this.pumpNote(file.path, this.noteSeq);
  }

  /** 读正文并入队下推。整段失败都收敛成事件里的 error,不把异常抛回事件总线。 */
  private pumpNote(path: string, seq: number): void {
    const manager: LexiPluginManager | null = this.managerRef;
    if (manager === null) {
      WorkspaceLog.warn('note.open.skip', 'reason=host_not_ready path=' + path);
      return;
    }
    const file: LexiTFile | null = manager.vault.getFileByPath(path);
    if (file === null) {
      WorkspaceLog.warn('note.open.miss', 'path=' + path + ' error=not_found');
      this.pushNoteOpen(path, '', 'not_found');
      return;
    }
    manager.vault.read(file).then((text: string): void => {
      if (seq !== this.noteSeq) {
        WorkspaceLog.warn('note.open.stale', 'path=' + path + ' seq=' + seq + ' latest=' + this.noteSeq);
        return;
      }
      this.pushNoteOpen(path, text, '');
      WorkspaceLog.info('note.open.out', 'path=' + path + ' chars=' + text.length);
    }, (err: Error): void => {
      const message: string = err instanceof Error ? err.message : String(err);
      WorkspaceLog.error('note.open.read', 'path=' + path + ' threw: ' + message);
      this.pushNoteOpen(path, '', 'read_failed');
    });
  }

  private pushNoteOpen(path: string, content: string, error: string): void {
    const payload: Record<string, Object> = {
      'name': WORKSPACE_EVENT_NOTE_OPEN as Object,
      'path': path as Object,
      'content': content as Object,
      'error': error as Object
    };
    this.pushEvent('workspace', payload);
  }

  private static pathOf(payload: Object): string {
    const record: Record<string, Object> = payload as Record<string, Object>;
    const raw: Object | undefined = record['path'];
    return typeof raw === 'string' ? raw as string : '';
  }

  /** 与旧宿主 fileToJson 同一投影:页面侧 fileFromJson 认的就是这些字段。 */
  private fileJson(file: LexiTFile): Record<string, Object> {
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
      'stat': stat as Object
    };
  }

  private onLogEvent(payload: WorkspacePayload | undefined): WorkspaceCallReply {
    const topic: string = fieldOf(payload, 'topic');
    let detail: string = '{}';
    if (payload !== undefined) {
      const raw: Object | undefined = payload['detail'];
      if (raw !== undefined && raw !== null) {
        detail = JSON.stringify(raw);
      }
    }
    WorkspaceLog.info(topic.length === 0 ? 'log.event' : topic, detail);
    const ack: Record<string, Object> = { 'ok': true };
    return this.success(ack);
  }

  private async onPluginList(): Promise<WorkspaceCallReply> {
    const registry: WorkspacePluginRegistry = await this.registryReady();
    const data: WorkspacePluginListData = { plugins: registry.summaries() };
    WorkspaceLog.info('plugin.list', 'count=' + data.plugins.length);
    return this.success(data);
  }

  private async onPluginLoad(payload: WorkspacePayload | undefined): Promise<WorkspaceCallReply> {
    const id: string = fieldOf(payload, 'id');
    const registry: WorkspacePluginRegistry = await this.registryReady();
    const entry: WorkspacePluginEntry | null = registry.entry(id);
    if (entry === null) {
      WorkspaceLog.warn('plugin.load', 'unknown plugin id=' + id);
      return this.fail(ERR_UNKNOWN_PLUGIN, '未安装的插件: ' + id);
    }
    // P1-011(S1/ADR-R29-01):Track2 装载门必须先于一切下发动作(令牌/源码)。
    // 这条旁路 caller 此前无轨政策查阅、无授权同意检查——已装未授权插件经
    // plugin.list→plugin.load 在工作区页被自动求值,同时绕过 ADR-R28-01 停用开关。
    const manager: LexiPluginManager | null = await this.managerReady;
    const refusal: WorkspaceCallReply | null = this.pluginLoadRefusal(manager, id, entry);
    if (refusal !== null) {
      return refusal;
    }
    const token: string = this.mint('tk');
    this.tokens.set(token, entry.id);
    const data: WorkspacePluginDescriptorData = {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      code: entry.code,
      token: token
    };
    if (entry.manifest !== null) {
      data.manifest = entry.manifest;
    }
    WorkspaceLog.info('plugin.load',
      'id=' + entry.id + ' version=' + entry.version + ' codeBytes=' + entry.code.length +
        ' tokenTail=' + this.tail(token));
    return this.success(data);
  }

  /**
   * P1-011(S1/ADR-R29-01):Track2(workspace 页)plugin.load 装载门——把两道已定案闸门
   * 接到这条旁路 caller(非新架构,判定全部复用既有机制)。返回 null = 放行。
   *
   * 门 ① 轨政策(ADR-R28-01 单一真源 LexiPluginTrackPolicy):工作区页按 ADR-R21-02 无
   *   iframe 容器(runtime 宿主页形态的跨帧通道真机证伪),沙箱轨在本页结构性不可达
   *   (sandboxTrackOn 恒 false)。因此:
   *   - 沙箱声明插件(manifest.sandboxService)在本页没有正确执行面——其代码不得下发,
   *     也绝不许回落进本页共享求值面;其命令/事件面经既有 manager 端口链,可见视图载体
   *     收敛归 P4-005/ADR-R29-01 S2;
   *   - 非沙箱声明插件按 resolvePluginTrack 判定:legacy 轨开关(lexiPluginLegacyTrack)
   *     关死时,工作区页同样 fail-closed 拒载(此前 R28 停用开关只裁决 runtime 轨)。
   * 门 ② 授权同意(ADR-R26-01,"未授权插件不能运行"):沿用 manager 既有授权语义——
   *   - 未启用(record.enabled=false,含 revoked/regrant-required 被 enablePlugin 打回的
   *     插件)不下发;
   *   - 声明型清单(capabilitiesDeclared)授权状态必须 granted(permissionStateOf,与设置页
   *     "开关即同意"同一判定);revoked/not-granted/regrant-required 一律拒绝;
   *   - v1 无声明清单沿用启用即授权的存量语义,不新增授权面。
   * 内联 demo 夹具(manifest=null、无 manager 记录)随 HAP 签名分发、不经安装/授权链
   * (ADR-R26-01 内置白名单同纪律),不套门。
   *
   * fail-visible:拒载回明确错误码+可读信息(页面 bundle 落 plugin.obsidian.error),
   * 绝不静默缺席——这正是 plugin.list 仍列出已装插件、由本门在 load 时拒绝的原因;
   * errorState 的权威记录仍归 enablePlugin 语义,本门只读、不改 manager 状态。
   */
  private pluginLoadRefusal(manager: LexiPluginManager | null, id: string,
    entry: WorkspacePluginEntry): WorkspaceCallReply | null {
    if (manager === null) {
      // 宿主未就绪时注册表只可能含内联 demo(loadFromManager 未跑过),无门可套。
      return null;
    }
    let record: LexiInstalledPlugin | null = null;
    for (const installed of manager.installedPlugins()) {
      if (installed.manifest.id === id) {
        record = installed;
        break;
      }
    }
    if (record === null) {
      if (entry.manifest !== null) {
        // 注册表条目带清单 = 来自 manager 目录;manager 已无记录 = 卸载/重扫后的陈旧快照,
        // 不得借陈旧条目继续下发源码(否则卸载变成绕过本门的通路)。
        WorkspaceLog.warn('plugin.load.track', 'id=' + id + ' refuse=stale_entry(注册表快照过期)');
        return this.fail(ERR_UNKNOWN_PLUGIN, '插件已不在宿主注册表中: 工作区注册表快照过期,拒绝下发源码: ' + id);
      }
      return null; // 内联 demo:随 HAP 分发,不经安装/授权链(内置白名单同纪律)
    }
    const manifest: LexiPluginManifest = record.manifest;
    // 门 ①-a:沙箱声明插件不发进工作区页(本页无 iframe 容器,ADR-R21-02;视图面归 P4-005)。
    if (manifest.sandboxService) {
      WorkspaceLog.warn('plugin.load.track',
        'id=' + id + ' refuse=sandbox_declared realm=workspace(无 iframe 容器,ADR-R21-02)');
      return this.fail(ERR_PLUGIN_TRACK_REFUSED,
        '沙箱轨插件不能在工作区页装载:本页无 per-plugin iframe 容器(ADR-R21-02),' +
          '其代码不得进入本页求值;可见视图载体收敛归 P4-005');
    }
    // 门 ①-b:legacy 共享 realm 轨受 ADR-R28-01 开关约束(单一真源,不内联第二份判定)。
    const track: string = resolvePluginTrack(manifest.sandboxService, false,
      manager.isLegacyTrackEnabled() ? 'true' : 'false');
    if (track === TRACK_REFUSED) {
      WorkspaceLog.warn('plugin.load.track',
        'id=' + id + ' refuse=legacy_track_disabled(lexiPluginLegacyTrack=false) fail-closed');
      return this.fail(ERR_PLUGIN_TRACK_REFUSED,
        '旧共享 realm 轨已停用(lexiPluginLegacyTrack=false):工作区页同样拒绝下发插件源码(fail-closed)');
    }
    // 门 ②:授权同意(ADR-R26-01 语义,与 enablePlugin/设置页同一套状态判定)。
    if (!record.enabled) {
      WorkspaceLog.warn('plugin.load.consent', 'id=' + id + ' refuse=not_enabled');
      return this.fail(ERR_PLUGIN_CONSENT_REQUIRED,
        '插件未启用:工作区页不下发未启用插件的源码(未授权插件不能运行)');
    }
    if (manifest.capabilitiesDeclared) {
      const state: string = manager.permissionStateOf(id);
      if (state !== 'granted') {
        WorkspaceLog.warn('plugin.load.consent', 'id=' + id + ' refuse=not_granted state=' + state);
        return this.fail(ERR_PLUGIN_CONSENT_REQUIRED,
          '插件权限尚未授权(当前 ' + state + '):请在授权面板同意后启用(未授权插件不能运行)');
      }
    }
    return null;
  }

  private onPluginUnload(token: string): WorkspaceCallReply {
    const pluginId: string | undefined = this.tokens.get(token);
    if (pluginId === undefined || pluginId === SESSION_PLUGIN_ID) {
      WorkspaceLog.warn('plugin.unload', 'unknown plugin token');
      return this.fail(ERR_UNAUTHORIZED, '未知身份令牌');
    }
    this.tokens.delete(token);
    WorkspaceLog.info('plugin.unload',
      'id=' + pluginId + ' tokenRevoked=true remainingTokens=' + this.tokens.size);
    const ack: Record<string, Object> = { 'ok': true, 'pluginId': pluginId };
    return this.success(ack);
  }

  private onDemoHostCall(method: string, token: string): WorkspaceCallReply {
    const pluginId: string | undefined = this.tokens.get(token);
    if (pluginId === undefined || pluginId === SESSION_PLUGIN_ID) {
      return this.fail(ERR_UNAUTHORIZED, '未知身份令牌');
    }
    this.seq = this.seq + 1;
    WorkspaceLog.info('demo.hostcall', 'method=' + method + ' pluginId=' + pluginId + ' seq=' + this.seq);
    const pong: WorkspacePong = { pong: true, seq: this.seq, pluginId: pluginId };
    return this.success(pong);
  }

  /** 其余方法全部转给旧宿主既有 handler;身份覆盖 payload.pluginId。 */
  /** 页面回报布局首帧就绪:放行所有排队者,并单向下推一次 layout-change。 */
  private markLayoutReady(): void {
    this.layoutReady = true;
    const waiting: Array<() => void> = this.layoutWaiters;
    this.layoutWaiters = [];
    for (const waiter of waiting) {
      waiter();
    }
    WorkspaceLog.info('frame.layoutReady', 'flushed=' + waiting.length);
    const payload: Record<string, Object> = { 'name': 'layout-change' };
    this.pushEvent('workspace', payload);
    this.openInitialNote();
  }

  /** onLayoutReady 必须真的等布局,不能同步回调;等不到就按超时口径放行(回调仍会被 layout-change 事件补一次)。 */
  private waitLayoutReady(): Promise<WorkspaceCallReply> {
    return new Promise<WorkspaceCallReply>((resolve: (reply: WorkspaceCallReply) => void) => {
      const timer: number = setTimeout((): void => {
        WorkspaceLog.warn('frame.layoutReady', 'wait 10s, releasing waiter without layout');
        resolve(this.success(null));
      }, 10000);
      this.layoutWaiters.push((): void => {
        clearTimeout(timer);
        resolve(this.success(null));
      });
    });
  }

  private withTimeout(call: Promise<string>, method: string): Promise<string> {
    return new Promise<string>((resolve: (value: string) => void, reject: (err: Error) => void) => {
      let settled: boolean = false;
      const timer: number = setTimeout((): void => {
        if (settled) {
          return;
        }
        settled = true;
        WorkspaceLog.warn('frame.timeout', 'method=' + method + ' ms=' + WORKSPACE_CALL_TIMEOUT_MS + ' code=' + ERR_TIMEOUT);
        reject(new Error('调用超时 ' + WORKSPACE_CALL_TIMEOUT_MS + 'ms: ' + method));
      }, WORKSPACE_CALL_TIMEOUT_MS);
      call.then((value: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, (err: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * 写回方向:页面把编辑器正文写回装载时那个 path。
   * 只认页面会话身份(插件令牌不许用这条通道改正文);写入复用 vault 既有 modify 通道。
   */
  private async onNoteWrite(token: string, payload: WorkspacePayload | undefined): Promise<WorkspaceCallReply> {
    const pluginId: string | undefined = this.tokens.get(token);
    if (pluginId === undefined || pluginId !== SESSION_PLUGIN_ID) {
      WorkspaceLog.warn('note.write.deny', 'identity not session token');
      return this.fail(ERR_UNAUTHORIZED, '笔记写回只接受页面会话身份');
    }
    const path: string = fieldOf(payload, 'path');
    if (path.length === 0) {
      return this.fail(ERR_BAD_REQUEST, '缺少 path');
    }
    const raw: Object | undefined = payload === undefined ? undefined : payload['content'];
    if (typeof raw !== 'string') {
      return this.fail(ERR_BAD_REQUEST, '缺少 content');
    }
    const data: string = raw as string;
    const manager: LexiPluginManager | null = await this.managerReady;
    if (manager === null) {
      return this.fail(ERR_HOST_NOT_READY, '旧宿主运行时尚未就绪');
    }
    const file: LexiTFile | null = manager.vault.getFileByPath(path);
    if (file === null) {
      WorkspaceLog.warn('note.write.miss', 'path=' + path);
      return this.fail(ERR_NOTE_NOT_FOUND, '文件不存在: ' + path);
    }
    try {
      await manager.vault.modify(file, data);
    } catch (err) {
      const message: string = err instanceof Error ? err.message : String(err);
      WorkspaceLog.error('note.write', 'path=' + path + ' threw: ' + message);
      return this.fail(ERR_WRITE_FAILED, message);
    }
    const ack: Record<string, Object> = { 'path': path as Object, 'chars': data.length as Object };
    WorkspaceLog.info('note.write.saved', 'path=' + path + ' chars=' + data.length);
    return this.success(ack);
  }

  /** 桥侧身份 → 运行时铸造的凭据(RFC §3.4):身份翻译发生在宿主侧,页面拿不到这份凭据。 */
  private async runtimeCredentialFor(pluginId: string): Promise<string> {
    const manager: LexiPluginManager | null = await this.managerReady;
    if (manager === null) {
      return '';
    }
    if (pluginId === SESSION_PLUGIN_ID) {
      if (this.runtimeSessionCredential.length === 0) {
        this.runtimeSessionCredential = manager.runtime.sessionCredentialToken();
      }
      return this.runtimeSessionCredential;
    }
    const cached: string | undefined = this.runtimePluginCredentials.get(pluginId);
    if (cached !== undefined && cached.length > 0) {
      return cached;
    }
    const credential: string = manager.runtime.tokenForPlugin(pluginId);
    this.runtimePluginCredentials.set(pluginId, credential);
    return credential;
  }

  private async delegate(method: string, token: string, payload: WorkspacePayload | undefined): Promise<WorkspaceCallReply> {
    const pluginId: string | undefined = this.tokens.get(token);
    if (pluginId === undefined) {
      WorkspaceLog.warn('frame.token', 'unknown token method=' + method);
      return this.fail(ERR_UNAUTHORIZED, '未知身份令牌');
    }
    const manager: LexiPluginManager | null = await this.managerReady;
    if (manager === null) {
      return this.fail(ERR_HOST_NOT_READY, '旧宿主运行时尚未就绪');
    }
    // 负向证据:页面/插件自报的 pluginId 一律不作数,只打印"ignored"。
    const claimed: string = fieldOf(payload, 'pluginId');
    if (claimed.length > 0 && claimed !== pluginId) {
      WorkspaceLog.warn('frame.identity',
        'method=' + method + ' identity=' + pluginId + ' claimed=' + claimed + ' ignored=true');
    }
    // 身份只走带外参数(第 4 个实参 = 运行时铸造的凭据):payload 原样转发,不改写、不注入。
    // 页面自报的 pluginId 由 LexiPluginRuntime 统一忽略并落审计日志,这一层不再替它打掩护。
    const credential: string = await this.runtimeCredentialFor(pluginId);
    const forwarded: WorkspacePayload = payload === undefined ? {} : payload;
    let raw: string = '';
    try {
      raw = await this.withTimeout(manager.runtime.call('', method, JSON.stringify(forwarded), credential), method);
    } catch (err) {
      const message: string = err instanceof Error ? err.message : String(err);
      WorkspaceLog.error('frame.dispatch', method + ' threw: ' + message);
      return this.fail(message.indexOf('调用超时') === 0 ? ERR_TIMEOUT : ERR_UNKNOWN_METHOD, message);
    }
    let outcome: LegacyOutcome | null = null;
    try {
      outcome = JSON.parse(raw) as LegacyOutcome;
    } catch (err) {
      outcome = null;
    }
    if (outcome === null || outcome.ok === undefined) {
      return this.fail(ERR_HOST_NOT_READY, '宿主返回了非 JSON 应答');
    }
    if (outcome.ok) {
      const data: Object | null | undefined = outcome.result;
      return this.success(data === undefined || data === null ? null : data);
    }
    const reason: string = outcome.error === undefined ? '宿主通道调用失败' : outcome.error;
    const code: string = outcome.code === undefined || outcome.code.length === 0 ? ERR_UNKNOWN_METHOD : outcome.code;
    return this.fail(code, reason);
  }

  /**
   * 主题不是插件:不走 manager.runtime 的 handler 表,但同样只认已鉴权的会话身份。
   * 页面拿到的 CSS 与宿主落盘文件是同一份字节(load 时重新算 sha256,不做任何改写)。
   */
  /** http 失败抛的是 BusinessError（不是 Error 子类），直接 String(err) 只会打出 [object Object]。 */
  private static describeError(err: Object): string {
    if (err instanceof Error) {
      return err.message;
    }
    const record: Record<string, Object> = err as Record<string, Object>;
    const code: number = typeof record['code'] === 'number' ? record['code'] as number : 0;
    const message: string = typeof record['message'] === 'string' ? record['message'] as string : '';
    const tail: string = code === 0 ? '' : ' (code ' + code.toString() + ')';
    return message.length > 0 ? message + tail : 'install failed' + tail;
  }

  private async onTheme(method: string, payload: WorkspacePayload | undefined): Promise<WorkspaceCallReply> {
    if (method === 'theme.config' || method === 'theme.list') {
      const themes: WorkspaceThemeSummary[] = this.themes.list();
      const active: string = this.themes.active();
      WorkspaceLog.info('theme.list',
        'count=' + themes.length + ' active=' + (active.length === 0 ? '(none)' : active));
      const data: WorkspaceThemeListData = {
        source: DEFAULT_THEME_SOURCE,
        active: active,
        themes: themes
      };
      return this.success(data);
    }
    if (method === 'theme.load') {
      const requested: string = fieldOf(payload, 'id');
      const id: string = requested.length > 0 ? requested : this.themes.active();
      const css: WorkspaceThemeCss | null = this.themes.load(id);
      if (css === null) {
        WorkspaceLog.warn('theme.load', 'unknown theme id=' + id);
        return this.fail(ERR_UNKNOWN_THEME, '未安装的主题: ' + id);
      }
      return this.success(css);
    }
    if (method === 'theme.install') {
      const requested: string = fieldOf(payload, 'url');
      const url: string = requested.length > 0 ? requested : DEFAULT_THEME_SOURCE;
      const installId: string = fieldOf(payload, 'id');
      try {
        const result: WorkspaceThemeInstallResult = await this.themes.install(url, installId);
        WorkspaceLog.info('theme.install',
          'id=' + result.id + ' manifest=' + (result.manifest ? 'true' : 'false') + ' source=' + url);
        return this.success(result);
      } catch (err) {
        const message: string = WorkspaceBridge.describeError(err);
        WorkspaceLog.error('theme.install', 'failed: ' + message);
        return this.fail(ERR_INSTALL_FAILED, message);
      }
    }
    const id: string = fieldOf(payload, 'id');
    this.themes.setActive(id);
    const data: WorkspaceThemeActiveData = { active: id, themes: this.themes.list() };
    return this.success(data);
  }

  private async registryReady(): Promise<WorkspacePluginRegistry> {
    if (this.registryLoaded) {
      return this.registry;
    }
    const manager: LexiPluginManager | null = await this.managerReady;
    if (manager !== null) {
      this.registry.loadFromManager(manager);
    }
    this.registryLoaded = true;
    WorkspaceLog.info('plugin.registry', 'entries=' + this.registry.summaries().length);
    return this.registry;
  }

  private tail(token: string): string {
    return token.substring(Math.max(0, token.length - 6));
  }

  private mint(prefix: string): string {
    this.minted = this.minted + 1;
    // CSPRNG 铸造(RFC §3.4):nonce/channelId/会话与插件令牌都不再依赖时间戳+伪随机数。
    return mintCredential(prefix);
  }

  private success(data: Object | null): WorkspaceCallReply {
    const reply: WorkspaceCallReply = { id: '', ok: true };
    if (data !== null) {
      reply.data = data;
    }
    return reply;
  }

  private fail(code: string, message: string): WorkspaceCallReply {
    const reply: WorkspaceCallReply = { id: '', ok: false };
    reply.error = { code: code, message: message };
    return reply;
  }
}
