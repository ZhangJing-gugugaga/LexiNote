// RFC §4.2/§4.4 · 插件激活记录。
// 一个 activation = 一次逻辑装载实例:同一插件停用再启用产生新 activation;
// onload/onunload 计数由 LifecycleManager 维护,"同一 activation 只触发一次"的账在这里。

export type LexiLifecycleState =
  | 'discovered' | 'verified' | 'installed' | 'disabled'
  | 'starting' | 'running' | 'stopping'
  | 'failed' | 'quarantined'
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
