// RFC §4.1/§4.3/§14 T1.1 · 插件生命周期状态机(LexiPluginLifecycleManager)。
//
// 唯一状态真源:enabledIds 之外的每一次启动/停止/失败/隔离都必须经这里记账。
// 设计约束:
//   - 纯逻辑、零 @kit 依赖,可在 Node 转译真跑(plugin-lifecycle-once.cjs);
//   - 迁移受 TRANSITIONS 表约束,非法迁移一律拒绝(fail-closed);
//   - 每一次迁移都落账 LexiLifecycleEvent(from/to/reason/at,P2-009:状态变更必须记录原因);
//   - onload/onunload 语义唯一:markRunning / markStopped 各只计一次(§4.5);
//   - running 中重复 beginStart 报 alreadyRunning(宿主据此早退,不重复派发 load.plugin);
//   - 停用前置条件:该 activation 的执行上下文必须全部关闭(§4.3 先释放后停)。
//
// P2-009(R32)·状态语义对照(RFC §4.1 全量面 → 宿主既有语义):
//   verified           = 安装面验证通过(扫描清单解析/安装链校验通过,enabled-ok 的前置面)
//   permission-pending = 已安装未授权(R26/P5-004:授权面板同意前不运行)
//   degraded           = 能力收缩升级后降级运行(T4.4 只减不增放行;部分能力继续服务)
//   quarantined        = 安全事件隔离(§6.4:升级包 integrity_mismatch、运行期强停等;
//                        不得再启用,宿主侧唯一出口 = 卸载)
//   revoked            = 用户撤销授权(P2-010 链:disablePlugin → markRevoked;
//                        出口 = 卸载,或用户显式重新落账后 liftRevocation → permission-pending)

import { LexiLifecycleState, LexiLifecycleEvent, LexiPluginActivation } from './LexiPluginActivation';
import { LexiContextKind, LexiPluginExecutionContext } from './LexiPluginExecutionContext';

/** 一次 start 请求的结论:ok=false 且 alreadyRunning=true 表示插件已在运行(幂等早退)。 */
export class LexiStartOutcome {
  ok: boolean = false;
  alreadyRunning: boolean = false;
  reason: string = '';
  activation: LexiPluginActivation | null = null;
}

/** 一次 stop/迁移请求的结论。 */
export class LexiTransitionOutcome {
  ok: boolean = false;
  reason: string = '';
}

export class LexiPluginLifecycleManager {
  /**
   * 合法迁移表(RFC §4.1 全量状态面;P2-009/R32 补全 5 个状态的可达性与转出原因)。
   * 迁移原因由各入口方法的 reason 实参落 journal 账。
   */
  private static readonly TRANSITIONS: Record<string, string[]> = LexiPluginLifecycleManager.buildTransitions();
  /** 迁移账目环形上限:防长会话无限增长(审计按插件过滤读)。 */
  private static readonly JOURNAL_CAP: number = 256;

  private states: Map<string, LexiLifecycleState> = new Map();
  private activations: Map<string, LexiPluginActivation> = new Map();
  private currentActivation: Map<string, string> = new Map();
  private contexts: Map<string, LexiPluginExecutionContext> = new Map();
  private journal: LexiLifecycleEvent[] = [];
  private seq: number = 0;

  private static buildTransitions(): Record<string, string[]> {
    const table: Record<string, string[]> = {};
    // discovered 只能走向验证/安装链(T4 接 PackageVerifier 后细化)
    table['discovered'] = ['verified', 'installed', 'removed'];
    // P2-009:installed → verified(安装面验证通过);verified 可启用/待授权/隔离/撤销/卸载。
    table['installed'] = ['verified', 'disabled', 'permission-pending', 'starting', 'quarantined', 'revoked', 'uninstalling', 'removed'];
    table['verified'] = ['permission-pending', 'starting', 'failed', 'quarantined', 'revoked', 'uninstalling', 'removed'];
    // permission-pending 转出:用户批准(starting)/拒绝(disabled)/安全事件/撤销/卸载。
    table['permission-pending'] = ['starting', 'disabled', 'quarantined', 'revoked', 'uninstalling', 'removed'];
    // installed 即宿主的"在盘未启用":RFC §4.1 的 Installed→Disabled 是装态记账,
    // 宿主启用直接 installed→starting(disabled 与 installed 同为"未运行"面)。
    table['disabled'] = ['starting', 'quarantined', 'revoked', 'uninstalling', 'removed'];
    // 运行面:disabled 起停;failed/quarantined 允许重试/释放;degraded = 降级运行面。
    table['starting'] = ['running', 'failed', 'disabled', 'permission-pending'];
    table['running'] = ['stopping', 'quarantined', 'degraded'];
    table['degraded'] = ['stopping', 'starting', 'disabled', 'quarantined', 'uninstalling', 'removed'];
    table['stopping'] = ['disabled', 'quarantined'];
    table['failed'] = ['starting', 'disabled', 'uninstalling'];
    // quarantined 转出:宿主强停释放(stopping→disabled)或卸载(宿主侧文档化唯一用户出口)。
    table['quarantined'] = ['stopping', 'disabled', 'uninstalling'];
    table['uninstalling'] = ['removed', 'disabled'];
    // revoked 转出(P2-009/P2-010):卸载,或用户显式重新落账后回到授权待定面(liftRevocation)。
    table['revoked'] = ['permission-pending', 'uninstalling', 'removed'];
    table['removed'] = [];
    return table;
  }

  private static nowMs(): number {
    return new Date().getTime();
  }

  /**
   * P2-009:迁移表查询(门禁/Inspector 对账用)——from→to 是否合法。
   * 静态面暴露整张表,plugin-lifecycle-once 逐格断言,防表漂移无测试覆盖。
   */
  static canTransitStatic(from: LexiLifecycleState, to: LexiLifecycleState): boolean {
    const allowed = LexiPluginLifecycleManager.TRANSITIONS[from];
    return allowed !== undefined && allowed.indexOf(to) >= 0;
  }

  private canTransit(pluginId: string, to: LexiLifecycleState): boolean {
    const from = this.stateOf(pluginId);
    const allowed = LexiPluginLifecycleManager.TRANSITIONS[from];
    return allowed !== undefined && allowed.indexOf(to) >= 0;
  }

  /** P2-009:迁移 + 原因落账(账目失败不改变迁移结果,审计面只增不阻)。 */
  private transit(pluginId: string, to: LexiLifecycleState, activationId: string, reason: string): LexiTransitionOutcome {
    const outcome = new LexiTransitionOutcome();
    if (!this.canTransit(pluginId, to)) {
      outcome.reason = '非法迁移: ' + this.stateOf(pluginId) + ' → ' + to + ' (plugin=' + pluginId + ')';
      return outcome;
    }
    const activation = this.activations.get(activationId);
    if (activation !== undefined) { activation.state = to; }
    this.recordEvent(pluginId, activationId, this.stateOf(pluginId), to, reason);
    this.states.set(pluginId, to);
    outcome.ok = true;
    return outcome;
  }

  /** P2-009:账目行(环形上限内保留最近 JOURNAL_CAP 条)。 */
  private recordEvent(pluginId: string, activationId: string, from: LexiLifecycleState,
    to: LexiLifecycleState, reason: string): void {
    const event = new LexiLifecycleEvent();
    event.pluginId = pluginId;
    event.activationId = activationId;
    event.from = from;
    event.to = to;
    event.reason = reason.length > 0 ? reason : '(unspecified)';
    event.at = LexiPluginLifecycleManager.nowMs();
    this.journal.push(event);
    if (this.journal.length > LexiPluginLifecycleManager.JOURNAL_CAP) {
      this.journal.splice(0, this.journal.length - LexiPluginLifecycleManager.JOURNAL_CAP);
    }
  }

  /** 某插件的状态迁移账目(时间序;审计/Inspector 对账用)。 */
  historyOf(pluginId: string): LexiLifecycleEvent[] {
    const result: LexiLifecycleEvent[] = [];
    this.journal.forEach((event: LexiLifecycleEvent): void => {
      if (event.pluginId === pluginId) { result.push(event); }
    });
    return result;
  }

  // -------------------------------------------------------------- 安装链

  /** 扫描发现的插件落 installed(discovered → installed,简化的 verify 细化随 T4 到位)。 */
  markInstalled(pluginId: string, version: string): LexiTransitionOutcome {
    const outcome = new LexiTransitionOutcome();
    if (this.states.has(pluginId)) {
      // 重复扫描:已登记的插件保持现状(installed 幂等)
      outcome.ok = true;
      return outcome;
    }
    this.recordEvent(pluginId, '', 'discovered', 'installed', 'scan: 安装面落账');
    this.states.set(pluginId, 'installed');
    outcome.ok = true;
    return outcome;
  }

  /**
   * P2-009:installed → verified(安装面验证通过:扫描清单解析成功/安装链校验通过)。
   * 已 verified 幂等;其余状态拒绝(verified 是"验证通过"的一次性记账,不回退)。
   */
  markVerified(pluginId: string, reason: string): LexiTransitionOutcome {
    const outcome = new LexiTransitionOutcome();
    if (this.stateOf(pluginId) === 'verified') {
      outcome.ok = true;
      return outcome;
    }
    return this.transit(pluginId, 'verified', '', 'verified: ' + reason);
  }

  markRemoved(pluginId: string): LexiTransitionOutcome {
    const outcome = new LexiTransitionOutcome();
    const from = this.stateOf(pluginId);
    if (from !== 'installed' && from !== 'disabled' && from !== 'uninstalling' && from !== 'discovered' &&
      from !== 'verified' && from !== 'permission-pending' && from !== 'failed' &&
      from !== 'degraded' && from !== 'quarantined' && from !== 'revoked') {
      outcome.reason = '卸载前必须先停用(当前 ' + from + ')';
      return outcome;
    }
    this.recordEvent(pluginId, '', from, 'removed', 'uninstall: 卸载落账');
    this.states.set(pluginId, 'removed');
    const activationId = this.currentActivation.get(pluginId);
    if (activationId !== undefined) { this.currentActivation.delete(pluginId); }
    outcome.ok = true;
    return outcome;
  }

  // -------------------------------------------------------------- P2-009 安全面/授权面/降级面

  /**
   * P2-009:安装面 → permission-pending(R26/P5-004:已安装未授权)。
   * 转出:同意(starting)/拒绝(disabled)/隔离/撤销/卸载。
   */
  markPermissionPending(pluginId: string, reason: string): LexiTransitionOutcome {
    return this.transit(pluginId, 'permission-pending', '', 'permission-pending: ' + reason);
  }

  /**
   * P2-009:启用请求撞上授权前置(starting → permission-pending)。
   * activation 落授权待定面,不产生卡死 starting(宿主拒绝分支调用)。
   */
  markPendingFromStart(activationId: string, reason: string): LexiTransitionOutcome {
    const outcome = new LexiTransitionOutcome();
    const activation = this.activations.get(activationId);
    if (activation === undefined) {
      outcome.reason = '未知 activation: ' + activationId;
      return outcome;
    }
    return this.transit(activation.pluginId, 'permission-pending', activationId, 'permission-pending: ' + reason);
  }

  /**
   * P2-009:running → degraded(能力收缩升级后降级运行;T4.4 只减不增放行的宿主记账)。
   * 转出:重试启用(starting)/停用/隔离/卸载。
   */
  markDegraded(pluginId: string, reason: string): LexiTransitionOutcome {
    return this.transit(pluginId, 'degraded', '', 'degraded: ' + reason);
  }

  /**
   * P2-009/P2-010:disabled/permission-pending → revoked(用户撤销授权链落账)。
   * revoked 不得直接启用;出口 = 卸载,或用户显式重新落账后 liftRevocation。
   */
  markRevoked(pluginId: string, reason: string): LexiTransitionOutcome {
    return this.transit(pluginId, 'revoked', '', 'revoked: ' + reason);
  }

  /** P2-009:revoked → permission-pending(用户显式重新同意后恢复授权通道)。 */
  liftRevocation(pluginId: string, reason: string): LexiTransitionOutcome {
    return this.transit(pluginId, 'permission-pending', '', 're-consent: ' + reason);
  }

  /**
   * P2-009:安全事件 → quarantined(安装/升级 integrity_mismatch 等宿主级隔离;
   * 运行期隔离走 quarantine(activationId))。隔离中的插件不得启用,
   * 宿主侧文档化唯一用户出口 = 卸载(§6.4 高风险异常)。
   */
  markQuarantined(pluginId: string, reason: string): LexiTransitionOutcome {
    const outcome = new LexiTransitionOutcome();
    if (this.stateOf(pluginId) === 'quarantined') {
      outcome.ok = true;
      return outcome;
    }
    return this.transit(pluginId, 'quarantined', '', 'quarantined(安全事件): ' + reason);
  }

  // -------------------------------------------------------------- 启动

  /**
   * 请求启动:installed/verified/permission-pending/degraded/failed/disabled 起停,
   * running 幂等早退(alreadyRunning,不产生新 activation,宿主不得再派发 load.plugin
   * —— "同一 activation 只触发一次 onload"的守门点)。quarantined/revoked/removed 拒绝。
   */
  beginStartIfNotRunning(pluginId: string, version: string): LexiStartOutcome {
    const outcome = new LexiStartOutcome();
    const state = this.stateOf(pluginId);
    if (state === 'running' || state === 'starting' || state === 'stopping') {
      outcome.alreadyRunning = state === 'running';
      outcome.reason = '启动被拒: 插件当前 ' + state;
      return outcome;
    }
    if (!this.canTransit(pluginId, 'starting')) {
      outcome.reason = '非法迁移: ' + state + ' → starting (plugin=' + pluginId + ')';
      return outcome;
    }
    this.seq += 1;
    const activation = new LexiPluginActivation();
    activation.activationId = 'act-' + this.seq.toString(36) + '-' + pluginId;
    activation.pluginId = pluginId;
    activation.version = version;
    activation.state = 'starting';
    activation.startedAt = LexiPluginLifecycleManager.nowMs();
    this.activations.set(activation.activationId, activation);
    this.currentActivation.set(pluginId, activation.activationId);
    this.recordEvent(pluginId, activation.activationId, state, 'starting', 'enable-request: 用户/恢复链请求启用');
    this.states.set(pluginId, 'starting');
    outcome.ok = true;
    outcome.activation = activation;
    return outcome;
  }

  /** starting → running:onload 逻辑完成。重复调用不累计(RFC §4.5 防重复 onload)。 */
  markRunning(activationId: string): LexiTransitionOutcome {
    const outcome = new LexiTransitionOutcome();
    const activation = this.activations.get(activationId);
    if (activation === undefined) {
      outcome.reason = '未知 activation: ' + activationId;
      return outcome;
    }
    if (activation.state !== 'starting') {
      outcome.reason = 'markRunning 只允许 starting(当前 ' + activation.state + ')';
      return outcome;
    }
    activation.onloadCount = 1;
    const transit = this.transit(activation.pluginId, 'running', activationId, 'onload-complete');
    if (!transit.ok) {
      // 计数回滚:迁移被拒时不得留半程账(onloadCount 与状态机一致)。
      activation.onloadCount = 0;
      return transit;
    }
    return transit;
  }

  /** starting → failed:onload 异常/超时。失败原因落账,宿主展示与重试用。 */
  markFailed(activationId: string, reason: string): LexiTransitionOutcome {
    const outcome = new LexiTransitionOutcome();
    const activation = this.activations.get(activationId);
    if (activation === undefined) {
      outcome.reason = '未知 activation: ' + activationId;
      return outcome;
    }
    const transit = this.transit(activation.pluginId, 'failed', activationId, 'failed: ' + reason);
    if (!transit.ok) { return transit; }
    activation.failReason = reason;
    if (this.currentActivation.get(activation.pluginId) === activationId) {
      this.currentActivation.delete(activation.pluginId);
    }
    return transit;
  }

  // -------------------------------------------------------------- 停止

  /** running/quarantined → stopping。stopping/disabled 中重复 stop 一律拒绝(§4.5 防重复 onunload)。 */
  beginStop(activationId: string, reason: string): LexiTransitionOutcome {
    const outcome = new LexiTransitionOutcome();
    const activation = this.activations.get(activationId);
    if (activation === undefined) {
      outcome.reason = '未知 activation: ' + activationId;
      return outcome;
    }
    if (activation.state !== 'running' && activation.state !== 'quarantined') {
      outcome.reason = 'beginStop 只允许 running/quarantined(当前 ' + activation.state + ')';
      return outcome;
    }
    // 先释放后停(§4.3):还有未关闭的执行上下文不得进入 stopping。
    for (const entry of this.contexts.values()) {
      if (entry.activationId === activationId && entry.closedAt === 0) {
        outcome.reason = 'activation ' + activationId + ' 仍有未关闭上下文: ' + entry.contextId + ' (' + entry.kind + ')';
        return outcome;
      }
    }
    activation.stopReason = reason;
    return this.transit(activation.pluginId, 'stopping', activationId, 'stopping: ' + reason);
  }

  /** stopping → disabled:onunload 逻辑完成,只计一次。 */
  markStopped(activationId: string): LexiTransitionOutcome {
    const outcome = new LexiTransitionOutcome();
    const activation = this.activations.get(activationId);
    if (activation === undefined) {
      outcome.reason = '未知 activation: ' + activationId;
      return outcome;
    }
    if (activation.state !== 'stopping') {
      outcome.reason = 'markStopped 只允许 stopping(当前 ' + activation.state + ')';
      return outcome;
    }
    activation.onunloadCount = 1;
    activation.stoppedAt = LexiPluginLifecycleManager.nowMs();
    activation.state = 'disabled';
    this.recordEvent(activation.pluginId, activationId, 'stopping', 'disabled', 'onunload-complete');
    this.states.set(activation.pluginId, 'disabled');
    if (this.currentActivation.get(activation.pluginId) === activationId) {
      this.currentActivation.delete(activation.pluginId);
    }
    outcome.ok = true;
    return outcome;
  }

  /** running → quarantined:RPC 崩溃/强制停止路径(§4.3 强制停止语义,停用回收随宿主执行)。 */
  quarantine(activationId: string, reason: string): LexiTransitionOutcome {
    const outcome = new LexiTransitionOutcome();
    const activation = this.activations.get(activationId);
    if (activation === undefined) {
      outcome.reason = '未知 activation: ' + activationId;
      return outcome;
    }
    const transit = this.transit(activation.pluginId, 'quarantined', activationId, 'quarantined(安全事件): ' + reason);
    if (transit.ok) { activation.failReason = reason; }
    return transit;
  }

  // -------------------------------------------------------------- 执行上下文

  /** 创建执行上下文并绑定到 activation(身份绑定发生在宿主端口侧,这里只记账)。 */
  createContext(activationId: string, kind: LexiContextKind): LexiPluginExecutionContext {
    const activation = this.activations.get(activationId);
    const record = new LexiPluginExecutionContext();
    this.seq += 1;
    record.contextId = 'ctx-' + this.seq.toString(36) + '-' + (activation ? activation.pluginId : 'orphan');
    record.activationId = activationId;
    record.pluginId = activation ? activation.pluginId : '';
    record.kind = kind;
    record.createdAt = LexiPluginLifecycleManager.nowMs();
    this.contexts.set(record.contextId, record);
    return record;
  }

  closeContext(contextId: string): boolean {
    const record = this.contexts.get(contextId);
    if (record === undefined || record.closedAt !== 0) { return false; }
    record.closedAt = LexiPluginLifecycleManager.nowMs();
    return true;
  }

  /** activation 当前活跃(未关闭)的执行上下文清单。 */
  contextsOf(activationId: string): LexiPluginExecutionContext[] {
    const result: LexiPluginExecutionContext[] = [];
    this.contexts.forEach((record: LexiPluginExecutionContext): void => {
      if (record.activationId === activationId && record.closedAt === 0) { result.push(record); }
    });
    return result;
  }

  // -------------------------------------------------------------- 查询

  stateOf(pluginId: string): LexiLifecycleState {
    const state = this.states.get(pluginId);
    return state === undefined ? 'discovered' : state;
  }

  activationOf(activationId: string): LexiPluginActivation | null {
    const activation = this.activations.get(activationId);
    return activation === undefined ? null : activation;
  }

  currentActivationIdOf(pluginId: string): string {
    const id = this.currentActivation.get(pluginId);
    return id === undefined ? '' : id;
  }

  activationCountOf(pluginId: string): number {
    let count = 0;
    this.activations.forEach((activation: LexiPluginActivation): void => {
      if (activation.pluginId === pluginId) { count += 1; }
    });
    return count;
  }
}
