// RFC §4.1/§4.3/§14 T1.1 · 插件生命周期状态机(LexiPluginLifecycleManager)。
//
// 唯一状态真源:enabledIds 之外的每一次启动/停止/失败/隔离都必须经这里记账。
// 设计约束:
//   - 纯逻辑、零 @kit 依赖,可在 Node 转译真跑(plugin-lifecycle-once.cjs);
//   - 迁移受 TRANSITIONS 表约束,非法迁移一律拒绝(fail-closed);
//   - onload/onunload 语义唯一:markRunning / markStopped 各只计一次(§4.5);
//   - running 中重复 beginStart 报 alreadyRunning(宿主据此早退,不重复派发 load.plugin);
//   - 停用前置条件:该 activation 的执行上下文必须全部关闭(§4.3 先释放后停)。

import { LexiLifecycleState, LexiPluginActivation } from './LexiPluginActivation';
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
  /** 合法迁移表(RFC §4.1 状态机的宿主侧子集:verified/installed 由安装链维护)。 */
  private static readonly TRANSITIONS: Record<string, string[]> = LexiPluginLifecycleManager.buildTransitions();

  private states: Map<string, LexiLifecycleState> = new Map();
  private activations: Map<string, LexiPluginActivation> = new Map();
  private currentActivation: Map<string, string> = new Map();
  private contexts: Map<string, LexiPluginExecutionContext> = new Map();
  private seq: number = 0;

  private static buildTransitions(): Record<string, string[]> {
    const table: Record<string, string[]> = {};
    // discovered 只能走向验证/安装链(T4 接 PackageVerifier 后细化)
    table['discovered'] = ['verified', 'installed', 'removed'];
    table['verified'] = ['installed', 'failed'];
    // installed 即宿主的"在盘未启用":RFC §4.1 的 Installed→Disabled 是装态记账,
    // 宿主启用直接 installed→starting(disabled 与 installed 同为"未运行"面)。
    table['installed'] = ['disabled', 'starting', 'uninstalling', 'removed'];
    // 运行面:disabled 起停;failed/quarantined 允许重试/释放
    table['disabled'] = ['starting', 'uninstalling', 'removed'];
    table['starting'] = ['running', 'failed', 'disabled'];
    table['running'] = ['stopping', 'quarantined'];
    table['stopping'] = ['disabled', 'quarantined'];
    table['failed'] = ['starting', 'disabled', 'uninstalling'];
    table['quarantined'] = ['stopping', 'disabled', 'uninstalling'];
    table['uninstalling'] = ['removed', 'disabled'];
    table['removed'] = [];
    return table;
  }

  private static nowMs(): number {
    return new Date().getTime();
  }

  private canTransit(pluginId: string, to: LexiLifecycleState): boolean {
    const from = this.stateOf(pluginId);
    const allowed = LexiPluginLifecycleManager.TRANSITIONS[from];
    return allowed !== undefined && allowed.indexOf(to) >= 0;
  }

  private transit(pluginId: string, to: LexiLifecycleState, activationId: string): LexiTransitionOutcome {
    const outcome = new LexiTransitionOutcome();
    if (!this.canTransit(pluginId, to)) {
      outcome.reason = '非法迁移: ' + this.stateOf(pluginId) + ' → ' + to + ' (plugin=' + pluginId + ')';
      return outcome;
    }
    const activation = this.activations.get(activationId);
    if (activation !== undefined) { activation.state = to; }
    this.states.set(pluginId, to);
    outcome.ok = true;
    return outcome;
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
    this.states.set(pluginId, 'installed');
    outcome.ok = true;
    return outcome;
  }

  markRemoved(pluginId: string): LexiTransitionOutcome {
    const outcome = new LexiTransitionOutcome();
    const from = this.stateOf(pluginId);
    if (from !== 'installed' && from !== 'disabled' && from !== 'uninstalling' && from !== 'discovered') {
      outcome.reason = '卸载前必须先停用(当前 ' + from + ')';
      return outcome;
    }
    this.states.set(pluginId, 'removed');
    const activationId = this.currentActivation.get(pluginId);
    if (activationId !== undefined) { this.currentActivation.delete(pluginId); }
    outcome.ok = true;
    return outcome;
  }

  // -------------------------------------------------------------- 启动

  /**
   * 请求启动:installed/failed 起停,running 幂等早退(alreadyRunning,不产生新 activation,
   * 宿主不得再派发 load.plugin —— "同一 activation 只触发一次 onload"的守门点)。
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
    this.states.set(activation.pluginId, 'running');
    activation.state = 'running';
    outcome.ok = true;
    return outcome;
  }

  /** starting → failed:onload 异常/超时。失败原因落账,宿主展示与重试用。 */
  markFailed(activationId: string, reason: string): LexiTransitionOutcome {
    const outcome = new LexiTransitionOutcome();
    const activation = this.activations.get(activationId);
    if (activation === undefined) {
      outcome.reason = '未知 activation: ' + activationId;
      return outcome;
    }
    const transit = this.transit(activation.pluginId, 'failed', activationId);
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
    return this.transit(activation.pluginId, 'stopping', activationId);
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
    const transit = this.transit(activation.pluginId, 'quarantined', activationId);
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
