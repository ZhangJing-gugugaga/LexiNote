// RFC §4.2/§4.4 · 插件激活记录。
// 一个 activation = 一次逻辑装载实例:同一插件停用再启用产生新 activation;
// onload/onunload 计数由 LifecycleManager 维护,"同一 activation 只触发一次"的账在这里。

/**
 * RFC §4.1 全量状态面(P2-009/R32 补全)。
 * 本轮新增:permission-pending(R26 安装未授权面)/ degraded(能力收缩降级运行面)/
 * revoked(P2-010 撤销链落账面)。verified = 安装面验证通过(enabled-ok 前置);
 * quarantined = 安全事件隔离面(§6.4)。每一次迁移都必须带原因(账目留痕)。
 */
export type LexiLifecycleState =
  | 'discovered' | 'verified' | 'installed' | 'permission-pending' | 'disabled'
  | 'starting' | 'running' | 'degraded' | 'stopping'
  | 'failed' | 'quarantined' | 'revoked'
  | 'uninstalling' | 'removed';

export class LexiPluginActivation {
  activationId: string = '';
  pluginId: string = '';
  version: string = '';
  state: LexiLifecycleState = 'disabled';
  startedAt: number = 0;
  stoppedAt: number = 0;
  stopReason: string = '';
  failReason: string = '';
  /** 逻辑 onload 次数:running 后恒为 1(重复 markRunning 不累计,RFC §4.5)。 */
  onloadCount: number = 0;
  /** 逻辑 onunload 次数:markStopped 只计一次。 */
  onunloadCount: number = 0;
}

/**
 * P2-009(R32)·状态迁移账目行:每一次状态变更都必须记录原因(RFC §4.1)。
 * 由 LifecycleManager 的 journal 记账(环形上限),historyOf(pluginId) 供 Inspector/审计对账。
 */
export class LexiLifecycleEvent {
  pluginId: string = '';
  activationId: string = '';
  from: LexiLifecycleState = 'discovered';
  to: LexiLifecycleState = 'discovered';
  reason: string = '';
  at: number = 0;
}
