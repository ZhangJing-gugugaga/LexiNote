// P1-007(R31)·RPC 入口归一：单一 Gateway —— 授权 + 分发的唯一收口。
//
// 交付前的事实（入口地图，R31 收口对象）：
//   ① javaScriptProxy `lexiHost.call`（LexiPluginRuntimeHost / LexiPluginViewSlot /
//      LexiPluginCodeBlockSlot 三个绑定面）→ LexiWebRuntime.call；
//   ② javaScriptProxy `sandboxHost.call`（LexiSandboxContainerHost）→
//      manager.handleSandboxProxyCall → contextRegistry.adjudicate → callFromPort → call；
//   ③ context port 帧（LexiPluginRuntimeHost.openContextPort）→
//      manager.handleContextPortFrame → contextRegistry.adjudicate → callFromPort → call；
//   ④ host→页 dispatch（runJavaScript __receive）+ javaScriptProxy `admitDispatch`
//      （一次性通道凭据核销口，P1-006b①）；
//   ⑤ WorkspaceBridge.handleText（工作区页 WebMessagePort）→ 桥面原生分支 + delegate →
//      manager.runtime.call。
//   历史上授权判定有两个 broker 实例：LexiWebRuntime.broker（init 时注入真实
//   fsAuthorizer/capabilityGate）与 WorkspaceBridge.broker（默认 fail-closed）。
//
// 本模块收口后的形状：
//   - 全应用唯一 LexiPermissionBroker 实例由 Gateway 持有（LexiRpcGateway.shared），
//     runtime 与 bridge 的两个历史实例合并：LexiWebRuntime.broker 降级为转发访问器，
//     WorkspaceBridge 的第二个实例删除、桥面授权改走 shared.authorize；
//   - 未知方法 → 显式错误（机器码 unknown_method），不再静默 undefined；
//   - payload schema 校验在入口（敏感家族 fs/vault、editor、network、commands、data、
//     metadata 读的必需字段 + 类型），先于身份解析与 authorize，命中即 bad_request；
//   - host→页 dispatch 面方法注册表：dispatch 只许投递已登记的页侧方法，未知显式抛错；
//   - handler 表原位保留（registerHandler 调用点不动）——Gateway 是漏斗，不是 handler 重写；
//     已登记方法的既有 身份解析→authorize→handler 链行为不变。
//
// 设计约束：纯逻辑、零 @kit 依赖（Node 门禁直接转译真跑——plugin-authz-matrix M4）；
//   默认拒绝；fail-closed。

import { LexiAuthzDecision, LexiAuthzResource, LexiCallerContext, LexiPermissionBroker } from './LexiPermissionBroker';

/** Gateway 入口校验失败的机器码：未知方法（未登记 handler）。 */
export const ERROR_RPC_UNKNOWN_METHOD: string = 'unknown_method';
/** Gateway 入口校验失败的机器码：payload schema 违例（缺必需字段/类型不符/非对象载荷）。 */
export const ERROR_RPC_BAD_REQUEST: string = 'bad_request';

/** 页侧 handler 形状（与既有 LexiWebRuntime.registerHandler 完全一致，原位保留）。 */
export type LexiRpcHandler = (payloadJson: string, identity: string, token: string) => Promise<string>;

/** schema 字段期望类型：'string' | 'number' | 'array' | 'object'。 */
type LexiSchemaFieldKind = string;

/** 单条 schema 要求：必需字段名 + 期望类型。 */
class LexiSchemaField {
  name: string = '';
  kind: LexiSchemaFieldKind = 'string';
}

function fieldMatches(value: Object | undefined, kind: string): boolean {
  if (kind === 'string') { return typeof value === 'string'; }
  if (kind === 'number') { return typeof value === 'number'; }
  if (kind === 'array') { return Array.isArray(value); }
  if (kind === 'object') { return typeof value === 'object' && value !== null && !Array.isArray(value); }
  return false;
}

export class LexiRpcGateway {
  /**
   * 全应用唯一 broker 实例。默认 fail-closed（fs 一律拒绝、无 capability gate——
   * 与历史 WorkspaceBridge.broker 同配置）；manager.init 注入真实判定器后换血。
   */
  private brokerInstance: LexiPermissionBroker =
    new LexiPermissionBroker((_pluginId: string, _method: string): boolean => false);
  /** 页侧 handler 表（从 LexiWebRuntime 移管；registerHandler 调用点原样转发）。 */
  private handlers: Map<string, LexiRpcHandler> = new Map();
  /** host→页 dispatch 允许投递的页侧方法面（shim __receive 消费的完整清单）。 */
  private readonly dispatchSurface: Set<string> = LexiRpcGateway.buildDispatchSurface();
  /**
   * 敏感家族 payload schema（P1-007：至少覆盖 fs/vault、editor、network、commands、data）。
   * 必需字段从既有 handler 的真实消费键推导（rpcString/rpcNumber/rpcBool/Array.isArray），
   * 与 shim/视图页/工作区页的实际发送形状逐条对齐——合法流量零拦截。
   */
  private readonly schema: Map<string, LexiSchemaField[]> = LexiRpcGateway.buildSchema();

  private static instanceRef: LexiRpcGateway | null = null;

  /** 单例（与 LexiPluginManager.shared 同纪律）：runtime 与 bridge 共用同一实例。 */
  static get shared(): LexiRpcGateway {
    if (LexiRpcGateway.instanceRef === null) { LexiRpcGateway.instanceRef = new LexiRpcGateway(); }
    return LexiRpcGateway.instanceRef;
  }

  private static buildDispatchSurface(): Set<string> {
    const surface = new Set<string>();
    surface.add('load.plugin');
    surface.add('unload.plugin');
    surface.add('invoke.ribbon');
    surface.add('invoke.command');
    surface.add('invoke.editorCommand');
    surface.add('event');
    surface.add('settings.values');
    return surface;
  }

  private static buildSchema(): Map<string, LexiSchemaField[]> {
    const schema = new Map<string, LexiSchemaField[]>();
    const field = (name: string, kind: LexiSchemaFieldKind): LexiSchemaField => {
      const entry = new LexiSchemaField();
      entry.name = name;
      entry.kind = kind;
      return entry;
    };
    // --- fs/vault（fs-read / fs-write 家族） ---
    schema.set('vault.getByPath', [field('path', 'string')]);
    schema.set('vault.read', [field('path', 'string')]);
    schema.set('vault.modify', [field('path', 'string'), field('data', 'string')]);
    schema.set('vault.create', [field('path', 'string'), field('data', 'string')]);
    schema.set('vault.delete', [field('path', 'string')]);
    schema.set('vault.rename', [field('path', 'string'), field('newPath', 'string')]);
    schema.set('vault.append', [field('path', 'string'), field('data', 'string')]);
    // --- metadata 读（fs-read 家族，按 path 寻址的那一条） ---
    schema.set('metadata.get', [field('path', 'string')]);
    // --- editor（editor-write 家族；档位精判仍在 handler 的 editorReplaceGate） ---
    schema.set('editor.replace', [field('start', 'number'), field('end', 'number'), field('text', 'string')]);
    schema.set('editor.selection', [field('start', 'number'), field('end', 'number')]);
    schema.set('editor.applyChanges', [field('changes', 'array')]);
    // --- network（net 家族；域白名单复核仍在 LexiNetProbe） ---
    schema.set('net.requestUrl', [field('url', 'string')]);
    // --- commands ---
    schema.set('commands.add', [field('command', 'object')]);
    schema.set('commands.remove', [field('fullId', 'string')]);
    schema.set('commands.execute', [field('id', 'string')]);
    // --- data（plugin-storage 家族；data.load 无必需字段） ---
    schema.set('data.save', [field('dataJson', 'string')]);
    // --- P4-001 插件 Modal/Menu 宿主面（ui-domain 家族；描述符出站的入口闸） ---
    schema.set('ui.modal.open', [field('modalId', 'string'), field('title', 'string'), field('content', 'string')]);
    schema.set('ui.modal.close', [field('modalId', 'string')]);
    schema.set('ui.menu.show', [field('menuId', 'string'), field('items', 'array')]);
    schema.set('ui.menu.hide', [field('menuId', 'string')]);
    return schema;
  }

  // ------------------------------------------------------------ 唯一 broker 实例

  /** manager.init 把真实判定器（fsAuthorizer + capabilityGate）的唯一实例挂进 Gateway。 */
  attachBroker(replacement: LexiPermissionBroker): void {
    this.brokerInstance = replacement;
  }

  /** 全应用唯一授权判定器（运行时/桥面/端口预检/所有权复查全部经此取用）。 */
  broker(): LexiPermissionBroker {
    return this.brokerInstance;
  }

  /**
   * 唯一授权入口：call() 预检、端口帧/沙箱容器预检、WorkspaceBridge 桥面授权、
   * 所有权复查（authzFor）全部经本方法落到同一个 broker 实例。
   */
  authorize(ctx: LexiCallerContext, method: string, resource: LexiAuthzResource | null = null): LexiAuthzDecision {
    return this.brokerInstance.authorize(ctx, method, resource);
  }

  // ------------------------------------------------------------ handler 表（漏斗，不改写）

  registerHandler(method: string, handler: LexiRpcHandler): void {
    this.handlers.set(method, handler);
  }

  hasHandler(method: string): boolean {
    return this.handlers.get(method) !== undefined;
  }

  /** 已登记返回 handler；未登记返回 null（入口由 entryReject 显式拒绝，绝不静默 undefined）。 */
  handlerOf(method: string): LexiRpcHandler | null {
    const handler = this.handlers.get(method);
    return handler === undefined ? null : handler;
  }

  /** 已登记 handler 数（契约对账/门禁用）。 */
  handlerCount(): number {
    return this.handlers.size;
  }

  // ------------------------------------------------------------ 入口双闸（未知方法 + payload schema）

  /**
   * 入口双闸：①未知方法显式拒绝（机器码 unknown_method）；②payload schema 校验
   * （机器码 bad_request）。返回 '' = 放行进既有身份→authorize→handler 链。
   * 在身份解析之前执行——伪造身份的调用方同样先撞上入口闸。
   */
  entryReject(method: string, payloadJson: string): string {
    if (this.handlers.get(method) === undefined) {
      return LexiRpcGateway.rejectReply(ERROR_RPC_UNKNOWN_METHOD, '未知插件通道(未登记 handler): ' + method);
    }
    const violation = this.schemaRejectReason(method, payloadJson);
    if (violation.length > 0) {
      return LexiRpcGateway.rejectReply(ERROR_RPC_BAD_REQUEST, 'payload schema 违例: ' + violation);
    }
    return '';
  }

  /** schema 违例原因；'' = 通过。未登记 schema 的方法不做校验（只拦敏感家族）。 */
  schemaRejectReason(method: string, payloadJson: string): string {
    const fields = this.schema.get(method);
    if (fields === undefined) { return ''; }
    let request: Record<string, Object> | null = null;
    try {
      const parsed: Object = JSON.parse(payloadJson) as Object;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        request = parsed as Record<string, Object>;
      }
    } catch (error) {
      request = null;
    }
    if (request === null) {
      return method + ' 需要对象载荷(JSON object)';
    }
    for (const required of fields) {
      const value: Object | undefined = request[required.name];
      if (!fieldMatches(value, required.kind)) {
        return method + ' 缺少必需字段或类型不符: ' + required.name + '(' + required.kind + ')';
      }
    }
    return '';
  }

  /** 机器可读拒绝应答（与宿主 failResponseCode 同形状，Gateway 自持以免反向依赖）。 */
  private static rejectReply(code: string, error: string): string {
    const body: Record<string, Object> = {
      'ok': false as Object,
      'error': error as Object,
      'code': code as Object
    };
    return JSON.stringify(body);
  }

  // ------------------------------------------------------------ host→页 dispatch 面

  /**
   * dispatch 面（host→页 __receive）方法策略：已登记返回 ''，未知返回显式错误。
   * dispatch 是宿主内部调用点——拼写错误在启动即抛错，不再静默空转。
   */
  dispatchSurfaceReject(method: string): string {
    if (this.dispatchSurface.has(method)) { return ''; }
    return 'dispatch 未登记的页侧方法(允许面: load/unload.plugin, invoke.*, event, settings.values): ' + method;
  }
}
