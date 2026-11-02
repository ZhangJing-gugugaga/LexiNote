export const WORKSPACE_PROTOCOL_VERSION: number = 1;
export const WORKSPACE_MAX_BATCH: number = 64;
/** spec section 2: 单次调用 20s 超时,超时回 error.code=timeout 且不影响后续调用。 */
export const WORKSPACE_CALL_TIMEOUT_MS: number = 20000;
/** 装载方向:宿主按 path 读出正文后向页面下推的事件(workspace 主题,payload.name=note-open,键 path/content/error)。 */
export const WORKSPACE_EVENT_NOTE_OPEN: string = 'note-open';
/** 写回方向:页面把编辑器正文写回装载时那个 path 的 v1 方法名。 */
export const WORKSPACE_METHOD_NOTE_WRITE: string = 'workspace.note.write';

/**
 * 业务载荷。控制方法（channel.* / log.event / plugin.*）只读固定键，
 * 其余方法原样转发给旧宿主既有 handler，因此这里保留自由键集合（spec section 2）。
 */
export type WorkspacePayload = Record<string, Object>;

export interface WorkspaceCall {
  id?: string;
  method?: string;
  payload?: WorkspacePayload;
}

/** One inbound frame: either a single request, a batch, or (ignored) an event. */
export interface WorkspaceFrame {
  v?: number;
  type?: string;
  id?: string;
  token?: string;
  method?: string;
  payload?: WorkspacePayload;
  calls?: Array<WorkspaceCall>;
}

export interface WorkspaceError {
  code: string;
  message: string;
}

export interface WorkspaceReply {
  v: number;
  id: string;
  ok: boolean;
  data?: Object;
  error?: WorkspaceError;
}

export interface WorkspaceCallReply {
  id: string;
  ok: boolean;
  data?: Object;
  error?: WorkspaceError;
}

export interface WorkspaceBatchReply {
  v: number;
  calls: Array<WorkspaceCallReply>;
}

/** 宿主→页面单向下推的事件帧,与请求-应答共用端口但语义独立。 */
export interface WorkspaceEventFrame {
  v: number;
  type: string;
  topic: string;
  payload: Object;
}

export interface WorkspacePluginSummary {
  id: string;
  name: string;
  version: string;
}

export interface WorkspacePluginListData {
  plugins: Array<WorkspacePluginSummary>;
}

export interface WorkspaceHelloData {
  nonce: string;
  channelId: string;
  protocol: number;
}

export interface WorkspaceAuthData {
  channelId: string;
  authed: boolean;
  protocol: number;
  /** 宿主发放的会话身份令牌：此后每个业务调用都带着它，payload.pluginId 一律忽略。 */
  token: string;
}

/** Handed to the web side on plugin.load; the token is the only identity it may use. */
export interface WorkspacePluginDescriptorData {
  id: string;
  name: string;
  version: string;
  code: string;
  token: string;
  /** 原始 manifest.json（obsidian 兼容层装载真实插件时必需）。 */
  manifest?: Record<string, Object>;
}

export interface WorkspaceAck {
  ok: boolean;
  pluginId: string;
}

export interface WorkspacePong {
  pong: boolean;
  seq: number;
  pluginId: string;
}

/** JSON.parse into the frame shape; null when the text is not a v1 frame. */
export function parseWorkspaceFrame(text: string): WorkspaceFrame | null {
  let frame: WorkspaceFrame | null = null;
  try {
    frame = JSON.parse(text) as WorkspaceFrame;
  } catch (err) {
    return null;
  }
  if (frame === null) {
    return null;
  }
  if (frame.v !== WORKSPACE_PROTOCOL_VERSION) {
    return null;
  }
  return frame;
}

export function textOf(value: string | undefined): string {
  return typeof value === 'string' ? value : '';
}

/** 读一个字符串键；缺失或类型不符时返回空串（payload 是自由键集合）。 */
export function fieldOf(payload: WorkspacePayload | undefined, key: string): string {
  if (payload === undefined) { return ''; }
  const value = payload[key];
  return typeof value === 'string' ? value as string : '';
}

/** 复制载荷并覆写 pluginId：身份只来自宿主令牌，页面传什么都不算数。 */
export function withPluginId(payload: WorkspacePayload | undefined, pluginId: string): WorkspacePayload {
  const merged: WorkspacePayload = {};
  if (payload !== undefined) {
    const keys: string[] = Object.keys(payload);
    for (const key of keys) { merged[key] = payload[key]; }
  }
  merged['pluginId'] = pluginId;
  return merged;
}
