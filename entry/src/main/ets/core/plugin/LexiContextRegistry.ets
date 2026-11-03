// RFC §3.3/§3.4 · 沙箱执行上下文注册表与端口 RPC 网关（P1-003a，ADR-R18-01）。
//
// 职责（ADR-R18-01 定案 2/3）：
//   - contextRegistry：每执行上下文一条 HostContextRecord（身份四元组 + revoked），
//     身份真源在宿主端口表——插件侧报文里的任何身份字段一律不可信；
//   - 端口 RPC 网关：解析 RFC §3.4 请求帧 → contextId 反查记录 → revoked/未知拒绝 →
//     剥离载荷自证身份 → 喂给既有 broker.authorize（矩阵/能力/fsGate 全部原样生效）
//     → 分发给既有 handler，响应帧按 §3.4 组装。
// 设计约束：纯逻辑、零 @kit 依赖（可在 Node 转译真跑——plugin-context-registry.cjs）；
//   默认拒绝；审计行带 context 前缀可对账。
// 设备接线（Track1 页面 port 转移）由 LexiPluginRuntimeHost 在 P1-003a 收尾轮接入；
// 本模块只承诺"拿到帧就能安全裁决"。

import { LexiCallerContext, LexiAuthzDecision } from './LexiPermissionBroker';

export const CONTEXT_PROTOCOL_VERSION: number = 1;

export const CONTEXT_ERROR_UNREGISTERED: string = 'context_unregistered';
export const CONTEXT_ERROR_REVOKED: string = 'context_revoked';
export const CONTEXT_ERROR_BAD_FRAME: string = 'context_bad_frame';

export class HostContextRecord {
  contextId: string = '';
  pluginId: string = '';
  activationId: string = '';
  /** 'service' | 'view' | 'editor' | 'markdown' | 'theme'（RFC §3.1）。 */
  kind: string = 'service';
  createdAt: number = 0;
  revoked: boolean = false;
}

export class LexiContextGatewayDecision {
  ok: boolean = false;
  code: string = '';
  error: string = '';
  /** 网关放行后给 handler 的可信身份（记录反查，非载荷自证）。 */
  identity: string = '';
  method: string = '';
  payloadJson: string = '';
  requestId: string = '';
}

function nowMs(): number {
  return new Date().getTime();
}

export class LexiContextRegistry {
  private records: Map<string, HostContextRecord> = new Map();
  private seq: number = 0;

  /** 创建执行上下文（宿主在插件启用/视图打开时调用；contextId 宿主铸造，插件不可见）。 */
  create(pluginId: string, activationId: string, kind: string): HostContextRecord {
    if (pluginId.length === 0) { throw new Error('context 注册缺少 pluginId'); }
    this.seq += 1;
    const record = new HostContextRecord();
    record.contextId = 'ctx-' + this.seq.toString(36) + '-' + pluginId;
    record.pluginId = pluginId;
    record.activationId = activationId;
    record.kind = kind.length > 0 ? kind : 'service';
    record.createdAt = nowMs();
    this.records.set(record.contextId, record);
    return record;
  }

  recordOf(contextId: string): HostContextRecord | null {
    const record = this.records.get(contextId);
    return record === undefined ? null : record;
  }

  /** 吊销单上下文（视图关闭等）；吊销后该 contextId 的一切帧被拒。 */
  revoke(contextId: string): boolean {
    const record = this.records.get(contextId);
    if (record === undefined) { return false; }
    record.revoked = true;
    return true;
  }

  /** 吊销插件全部上下文（停用/卸载链调用）；返回吊销条数。 */
  revokePlugin(pluginId: string): number {
    let count = 0;
    this.records.forEach((record: HostContextRecord): void => {
      if (record.pluginId === pluginId && !record.revoked) {
        record.revoked = true;
        count += 1;
      }
    });
    return count;
  }

  /** 存活（未吊销）上下文数——生命周期审计/Inspector 用。 */
  aliveCount(): number {
    let count = 0;
    this.records.forEach((record: HostContextRecord): void => {
      if (!record.revoked) { count += 1; }
    });
    return count;
  }

  /**
   * 幂等取/建 service 上下文(P1-003b):沙箱轨在 dispatch 前就需要 contextId,
   * 而旧轨在 onload 成功后才建——统一走本方法避免同一 activation 重复注册。
   */
  ensureService(pluginId: string, activationId: string): HostContextRecord {
    let found: HostContextRecord | null = null;
    this.records.forEach((record: HostContextRecord): void => {
      if (record.pluginId === pluginId && record.activationId === activationId && !record.revoked) {
        found = record;
      }
    });
    if (found !== null) { return found; }
    return this.create(pluginId, activationId, 'service');
  }

  /**
   * 端口帧裁决：RFC §3.4 请求帧 { v, type:'request', id, method, payload }。
   * 返回网关结论——ok=true 时 identity 来自记录反查，调用方据此调 handler 并用
   * buildResponseFrame() 组响应；ok=false 时 error 已可直接入帧。
   */
  adjudicate(contextId: string, frameJson: string): LexiContextGatewayDecision {
    const decision = new LexiContextGatewayDecision();
    const record = this.records.get(contextId);
    if (record === undefined) {
      decision.code = CONTEXT_ERROR_UNREGISTERED;
      decision.error = 'context: 未注册的上下文（fail-closed）';
      return decision;
    }
    if (record.revoked) {
      decision.code = CONTEXT_ERROR_REVOKED;
      decision.error = 'context: 上下文已吊销（fail-closed）';
      return decision;
    }
    let frame: Record<string, Object> = {};
    try {
      frame = JSON.parse(frameJson) as Record<string, Object>;
    } catch (error) {
      decision.code = CONTEXT_ERROR_BAD_FRAME;
      decision.error = 'context: 帧不是合法 JSON';
      return decision;
    }
    if (frame === null || typeof frame !== 'object' || frame['type'] !== 'request') {
      decision.code = CONTEXT_ERROR_BAD_FRAME;
      decision.error = 'context: 非请求帧';
      return decision;
    }
    if (frame['v'] !== CONTEXT_PROTOCOL_VERSION) {
      decision.code = CONTEXT_ERROR_BAD_FRAME;
      decision.error = 'context: 协议版本不支持: ' + String(frame['v']);
      return decision;
    }
    const method = frame['method'];
    const requestId = frame['id'];
    if (typeof method !== 'string' || method.length === 0 || typeof requestId !== 'string') {
      decision.code = CONTEXT_ERROR_BAD_FRAME;
      decision.error = 'context: 帧缺少 method/id';
      return decision;
    }
    let payloadJson = '{}';
    const payload = frame['payload'];
    if (payload !== undefined && payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      // 身份自证字段剥离（与宿主 stripClaimedIdentity 同语义:载荷 pluginId 不可信）。
      const source = payload as Record<string, Object>;
      const cleaned: Record<string, Object> = {};
      const keys = Object.keys(source);
      for (const key of keys) {
        if (key === 'pluginId') { continue; }
        cleaned[key] = source[key];
      }
      payloadJson = JSON.stringify(cleaned);
    }
    decision.ok = true;
    decision.identity = record.pluginId;
    decision.method = method;
    decision.payloadJson = payloadJson;
    decision.requestId = requestId;
    return decision;
  }

  /** 响应帧组装（RFC §3.4）；错误帧带 code/retryable。data 解析失败按缺省省略（fail-safe）。 */
  buildResponseFrame(requestId: string, ok: boolean, dataJson: string, errorCode: string, errorMessage: string): string {
    const frame: Record<string, Object> = {
      'v': CONTEXT_PROTOCOL_VERSION as Object,
      'type': 'response' as Object,
      'id': requestId as Object,
      'ok': ok as Object
    };
    if (ok && dataJson.length > 0) {
      try {
        frame['data'] = JSON.parse(dataJson) as Object;
      } catch (error) { /* 非 JSON 结果按缺省 data 省略 */ }
    } else {
      const errorBody: Record<string, Object> = {
        'code': errorCode as Object,
        'message': errorMessage as Object,
        'retryable': false as Object
      };
      frame['error'] = errorBody as Object;
    }
    return JSON.stringify(frame);
  }

  /** 网关拒绝的即时响应帧（adjudicate ok=false 时直接回）。 */
  buildErrorFrame(errorCode: string, errorMessage: string): string {
    return this.buildResponseFrame('', false, '', errorCode, errorMessage);
  }

  /** 上下文调用方（喂既有 broker：role=plugin，身份来自记录）。 */
  contextOf(record: HostContextRecord): LexiCallerContext {
    const ctx = new LexiCallerContext();
    ctx.role = 'plugin';
    ctx.pluginId = record.pluginId;
    ctx.activationId = record.activationId;
    ctx.contextId = record.contextId;
    return ctx;
  }
}
