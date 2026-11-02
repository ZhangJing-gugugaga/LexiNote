// RFC §10.3 / §14 T5.3 · Plugin Inspector(LexiPluginInspector)。
//
// 开发者观察面:生命周期/激活/扩展/授权/RPC 审计的每插件报告。
// 隐私边界(§10.3):报告不承载 session token、用户笔记内容、其他插件私有数据——
// 报告类只定义可观测字段(结构性收敛),宿主误传的多余输入字段不会被抄入;
// errorState 截断到安全长度(信息最小化)。纯逻辑、零 @kit 依赖。

export class LexiInspectorInput {
  pluginId: string = '';
  lifecycleState: string = '';
  activationId: string = '';
  extensionCount: number = 0;
  permissionState: string = '';
  capabilityTags: string[] = [];
  errorState: string = '';
  rpcDeniedCount: number = 0;
  rpcAnonymousCount: number = 0;
}

export class LexiInspectorReport {
  pluginId: string = '';
  lifecycleState: string = '';
  activationId: string = '';
  extensionCount: number = 0;
  permissionState: string = '';
  capabilityTags: string[] = [];
  errorState: string = '';
  rpcDeniedCount: number = 0;
  rpcAnonymousCount: number = 0;
  generatedAt: number = 0;
}

/** errorState 的展示上限(§10.3 信息最小化;完整错误在宿主日志,不进观察面)。 */
const MAX_ERROR_LENGTH: number = 120;

export class LexiPluginInspector {
  private static nowMs(): number {
    return new Date().getTime();
  }

  /** 组装每插件观察报告:只拷贝白名单字段,多余输入字段一律丢弃。 */
  static report(input: LexiInspectorInput): LexiInspectorReport {
    const report = new LexiInspectorReport();
    report.pluginId = input.pluginId;
    report.lifecycleState = input.lifecycleState;
    report.activationId = input.activationId;
    report.extensionCount = input.extensionCount;
    report.permissionState = input.permissionState;
    report.capabilityTags = input.capabilityTags.slice().sort();
    const errorState = input.errorState;
    report.errorState = errorState.length > MAX_ERROR_LENGTH
      ? errorState.substring(0, MAX_ERROR_LENGTH) + '…'
      : errorState;
    report.rpcDeniedCount = input.rpcDeniedCount;
    report.rpcAnonymousCount = input.rpcAnonymousCount;
    report.generatedAt = LexiPluginInspector.nowMs();
    return report;
  }
}
