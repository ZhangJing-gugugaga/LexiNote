// net.requestUrl 的执行管线：身份 → capability.net → 传输。
// 这里刻意不 import 任何 @kit 模块：设备侧由 LexiPluginRuntime 注入真实 http 传输，
// 离线门禁(scripts/tests/net-request-url.cjs)注入假传输驱动同一段代码。

import { LexiPluginManifest, LexiCapabilityDecision, checkNetworkCapability } from './LexiPluginManifest';

/** 调用方没有可信插件令牌，或令牌归属与调用身份不一致。 */
export const ERROR_IDENTITY_UNTRUSTED: string = 'identity_untrusted';
export const ERROR_INVALID_REQUEST: string = 'invalid_request';
export const ERROR_NET_TIMEOUT: string = 'net_timeout';
export const ERROR_NET_TRANSPORT: string = 'net_transport_failed';
export const NET_TIMEOUT_MS: number = 15000;

const TIMEOUT_MARKER: string = '@net_timeout';

export class LexiNetResponse {
  status: number = 0;
  headers: Record<string, string> = {};
  text: string = '';

  constructor(status: number, headers: Record<string, string>, text: string) {
    this.status = status;
    this.headers = headers;
    this.text = text;
  }
}

/** 唯一被注入的边界：网络 IO。设备侧是 @kit.NetworkKit，测试侧是假传输。 */
export interface LexiNetTransport {
  send(method: string, url: string, headers: Record<string, string>, body: string,
    timeoutMs: number): Promise<LexiNetResponse>;
}

/** 判定结果：ok=true 表示请求真的发出并拿到回包(非 2xx 也算回包)，ok=false 表示没发或没回。 */
export class LexiNetOutcome {
  ok: boolean = false;
  code: string = '';
  error: string = '';
  status: number = 0;
  headers: Record<string, string> = {};
  text: string = '';
}

export class LexiNetDeps {
  pluginIdForToken: (token: string) => string;
  manifestFor: (pluginId: string) => LexiPluginManifest | null;
  transport: LexiNetTransport;
  logInfo: (message: string) => void;
  logError: (message: string) => void;
  timeoutMs: number;

  constructor(pluginIdForToken: (token: string) => string,
    manifestFor: (pluginId: string) => LexiPluginManifest | null,
    transport: LexiNetTransport,
    logInfo: (message: string) => void,
    logError: (message: string) => void,
    timeoutMs: number) {
    this.pluginIdForToken = pluginIdForToken;
    this.manifestFor = manifestFor;
    this.transport = transport;
    this.logInfo = logInfo;
    this.logError = logError;
    this.timeoutMs = timeoutMs;
  }
}

function denied(code: string, error: string): LexiNetOutcome {
  const outcome = new LexiNetOutcome();
  outcome.ok = false;
  outcome.code = code;
  outcome.error = error;
  return outcome;
}

function probeString(payload: Record<string, Object>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

function probeHeaders(payload: Record<string, Object>): Record<string, string> {
  const headers: Record<string, string> = {};
  const raw = payload['headers'] as Record<string, string> | undefined;
  if (raw) {
    for (const key of Object.keys(raw)) { headers[key] = String(raw[key]); }
  }
  return headers;
}

async function sendWithTimeout(deps: LexiNetDeps, method: string, url: string, headers: Record<string, string>,
  body: string): Promise<LexiNetResponse> {
  let timer: number = -1;
  const timeout = new Promise<LexiNetResponse>((_resolve: (value: LexiNetResponse) => void,
    reject: (reason: Error) => void): void => {
    timer = setTimeout((): void => { reject(new Error(TIMEOUT_MARKER)); }, deps.timeoutMs);
  });
  try {
    return await Promise.race<LexiNetResponse>([deps.transport.send(method, url, headers, body, deps.timeoutMs),
      timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 三道门禁按顺序在触碰传输之前跑完：令牌归属 → 令牌与身份一致 → capability.net。
 * 任何一道拒绝都直接返回，传输一次都不会被调用(拒绝即"不留半发")。
 */
export async function executeNetRequest(payloadJson: string, identity: string, token: string,
  deps: LexiNetDeps): Promise<LexiNetOutcome> {
  const who: string = identity.length > 0 ? identity : '(none)';
  const owner: string = deps.pluginIdForToken(token);
  if (owner.length === 0) {
    deps.logError('identity.net identity=' + who + ' allowed=false fail_closed=true code=' + ERROR_IDENTITY_UNTRUSTED +
      ' detail=调用方未携带可信插件令牌');
    return denied(ERROR_IDENTITY_UNTRUSTED, 'net: 调用方未携带可信插件令牌（fail-closed）');
  }
  if (owner !== identity) {
    deps.logError('identity.net identity=' + who + ' owner=' + owner + ' allowed=false fail_closed=true code=' +
      ERROR_IDENTITY_UNTRUSTED + ' detail=令牌归属与调用身份不一致');
    return denied(ERROR_IDENTITY_UNTRUSTED, 'net: 令牌归属与调用身份不一致（fail-closed）');
  }
  let request: Record<string, Object> = {};
  try {
    request = JSON.parse(payloadJson) as Record<string, Object>;
  } catch (error) {
    return denied(ERROR_INVALID_REQUEST, 'net: 请求参数不是合法 JSON');
  }
  if (request === null || typeof request !== 'object') {
    return denied(ERROR_INVALID_REQUEST, 'net: 请求参数不是合法 JSON');
  }
  const url: string = probeString(request, 'url');
  if (url.length === 0) {
    deps.logError('net.requestUrl identity=' + who + ' allowed=false code=' + ERROR_INVALID_REQUEST + ' detail=缺少 url');
    return denied(ERROR_INVALID_REQUEST, 'net: 缺少 url');
  }
  const rawMethod: string = probeString(request, 'method').toUpperCase();
  const method: string = rawMethod === 'POST' ? 'POST' : 'GET';
  // manifestFor(identity) === null → checkNetworkCapability 直接 denied：认不出身份必须 fail-closed。
  const manifest: LexiPluginManifest | null = deps.manifestFor(identity);
  // P2-006(RFC §4.4):v2 清单的 network.methods 白名单——空声明按只读默认(仅 GET);
  // 声明了清单外方法一律拒绝。v1/legacy 保持既有 GET/POST 双法语义。
  if (manifest !== null && manifest.manifestVersion === 2) {
    const declared = manifest.v2.network.methods;
    const effective: string[] = declared.length > 0
      ? declared.map((entry: string): string => entry.toUpperCase()) : ['GET'];
    if (effective.indexOf(method) < 0) {
      deps.logError('capability.net identity=' + who + ' method=' + method + ' allowed=false code=capability_denied' +
        ' detail=HTTP 方法不在 network.methods 白名单');
      return denied('capability_denied', 'net: HTTP 方法 ' + method + ' 不在 network.methods 白名单');
    }
  }
  const decision: LexiCapabilityDecision = checkNetworkCapability(manifest, url);
  const line: string = 'capability.net identity=' + who + ' host=' + decision.host + ' method=' + method +
    ' allowed=' + (decision.allowed ? 'true' : 'false') + ' detail=' + decision.detail;
  if (!decision.allowed) {
    deps.logError(line + ' code=' + decision.code);
    return denied(decision.code, decision.kind + ': ' + decision.detail);
  }
  deps.logInfo(line);
  const headers: Record<string, string> = probeHeaders(request);
  const body: string = probeString(request, 'body');
  // P2-006:请求体字节上限(声明 maxRequestBytes 才约束;默认 65536 也生效——恒入指纹标签)。
  if (manifest !== null && manifest.manifestVersion === 2 && manifest.v2.network.maxRequestBytes > 0 &&
    body.length > manifest.v2.network.maxRequestBytes) {
    deps.logError('capability.net identity=' + who + ' allowed=false code=capability_denied detail=请求体 ' +
      body.length + ' 超出 maxRequestBytes ' + manifest.v2.network.maxRequestBytes);
    return denied('capability_denied',
      'net: 请求体 ' + body.length + ' 超出 maxRequestBytes ' + manifest.v2.network.maxRequestBytes);
  }
  const startedAt: number = Date.now();
  let response: LexiNetResponse;
  try {
    response = await sendWithTimeout(deps, method, url, headers, body);
  } catch (error) {
    const failure = error as Error;
    let message: string = typeof failure.message === 'string' ? failure.message : '';
    if (message.length === 0) { message = String(error); }
    const timedOut: boolean = message.indexOf(TIMEOUT_MARKER) >= 0;
    const code: string = timedOut ? ERROR_NET_TIMEOUT : ERROR_NET_TRANSPORT;
    deps.logError('net.requestUrl identity=' + who + ' host=' + decision.host + ' method=' + method + ' ok=false code=' +
      code + ' ms=' + (Date.now() - startedAt) + ' detail=' + message);
    return denied(code, timedOut ? 'net: 请求超时（' + deps.timeoutMs + 'ms）' : 'net: 传输失败 ' + message);
  }
  // P2-006:响应体字节上限——超限即弃包(不把超限内容交给插件),与请求上限同语义。
  if (manifest !== null && manifest.manifestVersion === 2 && manifest.v2.network.maxResponseBytes > 0 &&
    response.text.length > manifest.v2.network.maxResponseBytes) {
    deps.logError('capability.net identity=' + who + ' allowed=false code=capability_denied detail=响应体 ' +
      response.text.length + ' 超出 maxResponseBytes ' + manifest.v2.network.maxResponseBytes);
    return denied('capability_denied',
      'net: 响应体 ' + response.text.length + ' 超出 maxResponseBytes ' + manifest.v2.network.maxResponseBytes);
  }
  const outcome = new LexiNetOutcome();
  outcome.ok = true;
  outcome.status = response.status;
  outcome.headers = response.headers;
  outcome.text = response.text;
  deps.logInfo('net.requestUrl identity=' + who + ' host=' + decision.host + ' method=' + method + ' ok=true status=' +
    response.status + ' ms=' + (Date.now() - startedAt));
  return outcome;
}
