// RFC §10.3 / §12 / §14 T5.3+P3-006 · Plugin Inspector(LexiPluginInspector)。
//
// 开发者观察面:生命周期/激活/扩展/授权/RPC 审计的每插件报告,P3-006 起可回答
// RFC §12 七问(每问 → 数据源 → 报告字段,宿主 inspectPlugin 组装、本类只做
// 白名单拷贝 + 脱敏收敛):
//
//   问 1 插件为什么启动失败?   → lifecycle journal(starting→failed 行)+
//                                activation.failReason + record.errorState
//                                → failReason / lastFailureAt / journal
//   问 2 插件请求了什么权限?   → permissionStore.grantOf(状态/指纹/时间) +
//                                manifest capabilityTags → permissionState /
//                                capabilityTags / permissionFingerprint /
//                                permissionGrantedAt / permissionRevokedAt
//   问 3 哪个 RPC 被拒绝?      → runtime.rpcDenies 计数 + rpcDenyJournal
//                                (method+code+at,新增于既有 authz.denied 记账点)
//                                → rpcDeniedCount / rpcDeniedRecent / rpcAnonymousCount
//   问 4 插件是否超时?         → runtime.rpcTimeouts 计数(宿主既有 catch 点记账)
//                                + journal 超时原因 → timeoutCount /
//                                lastTimeoutLabel / lastTimeoutAt
//   问 5 插件占用了多少资源?   → contextRegistry.aliveCountOf(只读)+
//                                extensionRegistry + activationCountOf +
//                                data.json 大小(fs.stat) + storage.quotaBytes
//                                → contextsAlive / extensionCount /
//                                activationCount / storageUsageBytes /
//                                storageQuotaBytes
//   问 6 插件卸载时是否清理完整? → journal(onunload-complete)+ 存活上下文/
//                                扩展残留(宿主 disablePlugin 尾序后的只读盘点)
//                                → cleanupComplete / cleanupLeftovers
//   问 7 插件为什么被隔离?     → record.quarantineReason + journal
//                                (to=quarantined 行) → quarantined / quarantineReason
//
// 兼容性报告(RFC §12 必备面)→ compatOk / minApiVersion / apiCompatLine;
// 运行日志/生命周期记录 → journal;权限拒绝记录 → journal(授权落账行)+
// rpcDeniedRecent;错误码 → errorState/journal reason(宿主机器码原样保留)。
//
// 隐私红线(§10.3/§12 不得包含):
//   - Session Token/凭据:自由文本字段(errorState/reason/label)经
//     redactCredentialShapes 收敛——凡「短前缀-长十六进制」凭据形状一律只剩
//     尾 6 位(与 LexiWebRuntime.tokenTail 同纪律),报告永远不含凭据全值;
//   - 用户笔记正文/隐私数据/其他插件私有数据:结构性收敛,报告只定义可观测
//     字段,宿主误传的多余输入字段(含 RPC 载荷)不会被抄入;
//   - 完整网络敏感请求内容:RPC 审计只有 method+code+at,无载荷。
//   - errorState 截断到 120 字符,自由文本截断到 160 字符(信息最小化)。
// 纯逻辑、零 @kit 依赖(Node 门禁直接转译真跑)。

/** 生命周期账目行的观察投影(白名单字段;宿主行多余字段不抄入)。 */
export class LexiInspectorJournalRow {
  at: number = 0;
  from: string = '';
  to: string = '';
  reason: string = '';
}

/** 一条 RPC 拒绝的观察投影:只有方法名/机器码/时间,绝不带载荷与凭据。 */
export class LexiInspectorRpcDeny {
  at: number = 0;
  method: string = '';
  code: string = '';
}

export class LexiInspectorInput {
  pluginId: string = '';
  version: string = '';
  lifecycleState: string = '';
  activationId: string = '';
  extensionCount: number = 0;
  permissionState: string = '';
  capabilityTags: string[] = [];
  errorState: string = '';
  rpcDeniedCount: number = 0;
  rpcAnonymousCount: number = 0;
  // ---- P3-006 七问数据面(宿主只读组装;本类白名单拷贝) ----
  /** 问 2:授权指纹(grantOf;未授权为空串)。 */
  permissionFingerprint: string = '';
  permissionGrantedAt: number = 0;
  permissionRevokedAt: number = 0;
  /** 问 2:授权落账版本(grantOf.version;未授权为空串)。 */
  permissionVersion: string = '';
  /** 生命周期账目(问 1/6/7 与运行日志;宿主侧已按插件过滤+截尾)。 */
  journal: LexiInspectorJournalRow[] = [];
  /** 问 1:最近一次启动失败原因(activation.failReason 或账目 failed 行)。 */
  failReason: string = '';
  lastFailureAt: number = 0;
  /** 问 3:最近 RPC 拒绝(method+code+at;宿主侧已截尾)。 */
  rpcDeniedRecent: LexiInspectorRpcDeny[] = [];
  /** 问 4:超时计数与最近一次标签/时间(宿主既有失败出口记账)。 */
  timeoutCount: number = 0;
  lastTimeoutLabel: string = '';
  lastTimeoutAt: number = 0;
  /** 问 5:资源占用面(全部只读)。 */
  contextsAlive: number = 0;
  activationCount: number = 0;
  storageUsageBytes: number = 0;
  storageQuotaBytes: number = 0;
  /** 问 6:卸载清理结论(宿主只读盘点;true=无残骸)。 */
  cleanupComplete: boolean = false;
  cleanupLeftovers: string[] = [];
  /** 问 7:隔离面(record.quarantineReason 非空 = 隔离中)。 */
  quarantined: boolean = false;
  quarantineReason: string = '';
  /** 兼容性报告:插件 minApiVersion 与宿主模拟 API 线。 */
  compatOk: boolean = true;
  minApiVersion: string = '';
  apiCompatLine: string = '';
}

export class LexiInspectorReport {
  pluginId: string = '';
  version: string = '';
  lifecycleState: string = '';
  activationId: string = '';
  extensionCount: number = 0;
  permissionState: string = '';
  capabilityTags: string[] = [];
  errorState: string = '';
  rpcDeniedCount: number = 0;
  rpcAnonymousCount: number = 0;
  permissionFingerprint: string = '';
  permissionGrantedAt: number = 0;
  permissionRevokedAt: number = 0;
  permissionVersion: string = '';
  journal: LexiInspectorJournalRow[] = [];
  failReason: string = '';
  lastFailureAt: number = 0;
  rpcDeniedRecent: LexiInspectorRpcDeny[] = [];
  timeoutCount: number = 0;
  lastTimeoutLabel: string = '';
  lastTimeoutAt: number = 0;
  contextsAlive: number = 0;
  activationCount: number = 0;
  storageUsageBytes: number = 0;
  storageQuotaBytes: number = 0;
  cleanupComplete: boolean = false;
  cleanupLeftovers: string[] = [];
  quarantined: boolean = false;
  quarantineReason: string = '';
  compatOk: boolean = true;
  minApiVersion: string = '';
  apiCompatLine: string = '';
  generatedAt: number = 0;
}

/** errorState 的展示上限(§10.3 信息最小化;完整错误在宿主日志,不进观察面)。 */
const MAX_ERROR_LENGTH: number = 120;
/** 其余自由文本(journal reason/隔离原因/失败原因/超时标签)的展示上限。 */
const MAX_TEXT_LENGTH: number = 160;
/** 凭据形状判定:短前缀(-)后的最小十六进制长度(tk-/st-/dc-/ch-/n- 全覆盖)。 */
const CREDENTIAL_HEX_MIN: number = 16;
/** 凭据尾迹长度(与 LexiWebRuntime.tokenTail 同纪律:尾 6 位可对账、不可复用)。 */
const CREDENTIAL_TAIL: number = 6;
/** journal/rpcDeniedRecent 的报告截尾(防长会话报告膨胀;宿主侧还有环形上限)。 */
const MAX_JOURNAL_ROWS: number = 32;
const MAX_RPC_DENY_ROWS: number = 16;

function isHexChar(ch: string): boolean {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function isAlnum(ch: string): boolean {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

export class LexiPluginInspector {
  private static nowMs(): number {
    return new Date().getTime();
  }

  /**
   * 脱敏红线:自由文本里的凭据形状(短前缀 + '-' + 长十六进制,tk-/st-/dc-/
   * ch-/n- 等宿主铸造形状全覆盖)收敛为 尾 6 位(与 tokenTail 同纪律)。
   * 纯手工扫描(不用正则回调,ArkTS 严格模式友好)。
   */
  static redactCredentialShapes(text: string): string {
    if (text.length === 0) { return text; }
    let out = '';
    let i = 0;
    while (i < text.length) {
      const dash = text.indexOf('-', i);
      if (dash < 0 || dash === text.length - 1) {
        out += text.substring(i);
        return out;
      }
      // 前缀段:1-3 个字母数字(短前缀-长十六进制 = 宿主凭据铸造形状)。
      let prefixStart = dash;
      while (prefixStart > i && isAlnum(text.charAt(prefixStart - 1)) && dash - prefixStart < 3) {
        prefixStart -= 1;
      }
      const prefixLen = dash - prefixStart;
      let j = dash + 1;
      while (j < text.length && isHexChar(text.charAt(j))) { j += 1; }
      const hexLen = j - (dash + 1);
      if (prefixLen >= 1 && hexLen >= CREDENTIAL_HEX_MIN) {
        // 凭据全值绝不进报告:保留前缀与尾 6 位(tokenTail 纪律)。
        out += text.substring(i, dash + 1) + '…' + text.substring(Math.max(dash + 1, j - CREDENTIAL_TAIL), j);
        i = j;
      } else {
        out += text.substring(i, dash + 1);
        i = dash + 1;
      }
    }
    return out;
  }

  /** 自由文本收敛:先脱敏凭据形状,再截断到安全长度(信息最小化)。 */
  private static sanitizeText(text: string, max: number): string {
    const redacted = LexiPluginInspector.redactCredentialShapes(text);
    return redacted.length > max ? redacted.substring(0, max) + '…' : redacted;
  }

  /** 自由文本行收敛(脱敏 + 截断)——journal 行复用。 */
  private static sanitizeRow(row: LexiInspectorJournalRow): LexiInspectorJournalRow {
    const clean = new LexiInspectorJournalRow();
    clean.at = row.at;
    clean.from = row.from;
    clean.to = row.to;
    clean.reason = LexiPluginInspector.sanitizeText(row.reason, MAX_TEXT_LENGTH);
    return clean;
  }

  /** RPC 拒绝行收敛(载荷/凭据/多余字段绝不进报告;method/code 机器面照抄)。 */
  private static sanitizeDeny(row: LexiInspectorRpcDeny): LexiInspectorRpcDeny {
    const clean = new LexiInspectorRpcDeny();
    clean.at = row.at;
    clean.method = row.method;
    clean.code = row.code;
    return clean;
  }

  /** 组装每插件观察报告:只拷贝白名单字段,多余输入字段一律丢弃 + 脱敏。 */
  static report(input: LexiInspectorInput): LexiInspectorReport {
    const report = new LexiInspectorReport();
    report.pluginId = input.pluginId;
    report.version = input.version;
    report.lifecycleState = input.lifecycleState;
    report.activationId = input.activationId;
    report.extensionCount = input.extensionCount;
    report.permissionState = input.permissionState;
    report.capabilityTags = input.capabilityTags.slice().sort();
    report.errorState = LexiPluginInspector.sanitizeText(input.errorState, MAX_ERROR_LENGTH);
    report.rpcDeniedCount = input.rpcDeniedCount;
    report.rpcAnonymousCount = input.rpcAnonymousCount;
    // ---- P3-006 七问面 ----
    report.permissionFingerprint = input.permissionFingerprint;
    report.permissionGrantedAt = input.permissionGrantedAt;
    report.permissionRevokedAt = input.permissionRevokedAt;
    report.permissionVersion = input.permissionVersion;
    report.journal = [];
    const startRow = Math.max(0, input.journal.length - MAX_JOURNAL_ROWS);
    for (let i = startRow; i < input.journal.length; i++) {
      report.journal.push(LexiPluginInspector.sanitizeRow(input.journal[i]));
    }
    report.failReason = LexiPluginInspector.sanitizeText(input.failReason, MAX_TEXT_LENGTH);
    report.lastFailureAt = input.lastFailureAt;
    report.rpcDeniedRecent = [];
    const startDeny = Math.max(0, input.rpcDeniedRecent.length - MAX_RPC_DENY_ROWS);
    for (let i = startDeny; i < input.rpcDeniedRecent.length; i++) {
      report.rpcDeniedRecent.push(LexiPluginInspector.sanitizeDeny(input.rpcDeniedRecent[i]));
    }
    report.timeoutCount = input.timeoutCount;
    report.lastTimeoutLabel = LexiPluginInspector.sanitizeText(input.lastTimeoutLabel, MAX_TEXT_LENGTH);
    report.lastTimeoutAt = input.lastTimeoutAt;
    report.contextsAlive = input.contextsAlive;
    report.activationCount = input.activationCount;
    report.storageUsageBytes = input.storageUsageBytes;
    report.storageQuotaBytes = input.storageQuotaBytes;
    report.cleanupComplete = input.cleanupComplete;
    report.cleanupLeftovers = input.cleanupLeftovers.slice();
    report.quarantined = input.quarantined;
    report.quarantineReason = LexiPluginInspector.sanitizeText(input.quarantineReason, MAX_TEXT_LENGTH);
    report.compatOk = input.compatOk;
    report.minApiVersion = input.minApiVersion;
    report.apiCompatLine = input.apiCompatLine;
    report.generatedAt = LexiPluginInspector.nowMs();
    return report;
  }

  /**
   * RFC §12 七问应答(每问一行,只由已脱敏报告字段拼装;设备 UI/日志可直接消费)。
   * 无记录时如实说"无",不编造。
   */
  static answersOf(report: LexiInspectorReport): string[] {
    const answers: string[] = [];
    // 问 1:插件为什么启动失败?
    if (report.failReason.length > 0) {
      answers.push('启动失败: ' + report.failReason + (report.lastFailureAt > 0 ? ' @' + report.lastFailureAt : ''));
    } else {
      answers.push('启动失败: 无启动失败记录(当前 ' + report.lifecycleState + ')');
    }
    // 问 2:插件请求了什么权限?
    answers.push('权限: ' + report.permissionState + '(' + report.capabilityTags.length + ' 项能力: ' +
      (report.capabilityTags.length > 0 ? report.capabilityTags.join(', ') : '未声明') + ')' +
      (report.permissionFingerprint.length > 0 ? ' 指纹=' + report.permissionFingerprint : ''));
    // 问 3:哪个 RPC 被拒绝?
    const denies = report.rpcDeniedRecent;
    if (report.rpcDeniedCount > 0) {
      let tail = '';
      for (let i = Math.max(0, denies.length - 3); i < denies.length; i++) {
        tail += (tail.length > 0 ? '; ' : '') + denies[i].method + '/' + denies[i].code;
      }
      answers.push('RPC 拒绝 ' + report.rpcDeniedCount + ' 次' + (tail.length > 0 ? '(最近: ' + tail + ')' : '') +
        (report.rpcAnonymousCount > 0 ? ',匿名拒绝 ' + report.rpcAnonymousCount + ' 次' : ''));
    } else {
      answers.push('RPC 拒绝: 无拒绝记录');
    }
    // 问 4:插件是否超时?
    if (report.timeoutCount > 0) {
      answers.push('超时 ' + report.timeoutCount + ' 次' +
        (report.lastTimeoutLabel.length > 0 ? '(最近: ' + report.lastTimeoutLabel + ')' : ''));
    } else {
      answers.push('超时: 无超时记录');
    }
    // 问 5:插件占用了多少资源?
    answers.push('资源: 存活上下文 ' + report.contextsAlive + ',扩展 ' + report.extensionCount +
      ',激活 ' + report.activationCount + ' 次,存储 ' + report.storageUsageBytes + 'B' +
      (report.storageQuotaBytes > 0 ? '(配额 ' + report.storageQuotaBytes + 'B)' : ''));
    // 问 6:插件卸载时是否清理完整?
    if (report.cleanupComplete) {
      answers.push('清理: 完整(无残骸)');
    } else {
      answers.push('清理: ' + (report.cleanupLeftovers.length > 0
        ? '残留 ' + report.cleanupLeftovers.length + ' 项: ' + report.cleanupLeftovers.join('; ')
        : '未停用/未盘点(插件运行中或尚未装载)'));
    }
    // 问 7:插件为什么被隔离?
    if (report.quarantined) {
      answers.push('隔离: ' + (report.quarantineReason.length > 0 ? report.quarantineReason : '安全事件(原因未留痕)'));
    } else {
      answers.push('隔离: 未被隔离');
    }
    return answers;
  }
}
