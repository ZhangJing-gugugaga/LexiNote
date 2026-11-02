// RFC §5 / §4.4 / §14 T1.2 · 统一扩展注册中心(LexiExtensionRegistry)。
//
// 所有可注册扩展资源(命令/视图/代码块/Ribbon/设置/…)的唯一所有权账本:
//   - extensionId = pluginId:extensionType:localName(RFC §5.3 命名空间);
//   - 同插件重复 (type, localName) 拒绝;不同插件同名互不冲突(§5.4);
//   - 注销必须本人(会话不得代管注销他人资源,防跨插件资源删除);
//   - unregisterPlugin 一次性回收该插件全部注册记录(§4.4 disposeByActivation 语义的宿主面)。
// 纯逻辑、零依赖,可在 Node 转译真跑(plugin-extension-ownership.cjs)。

export type LexiExtensionType =
  | 'command' | 'ribbon' | 'statusbar' | 'view' | 'editor-extension'
  | 'markdown-processor' | 'codeblock-processor' | 'editor-suggest'
  | 'settings' | 'context-menu' | 'theme' | 'protocol-handler';

export class LexiExtensionRecord {
  /** pluginId:extensionType:localName(命名空间唯一)。 */
  extensionId: string = '';
  pluginId: string = '';
  /** 签发该注册的激活实例(资源所有权随 activation,宿主从生命周期管理器取)。 */
  activationId: string = '';
  type: LexiExtensionType = 'command';
  localName: string = '';
  createdAt: number = 0;
}

export class LexiExtensionOutcome {
  ok: boolean = false;
  extensionId: string = '';
  reason: string = '';
}

export class LexiExtensionRegistry {
  private records: Map<string, LexiExtensionRecord> = new Map();

  private static nowMs(): number {
    return new Date().getTime();
  }

  private static isValidType(type: string): boolean {
    const valid: string[] = ['command', 'ribbon', 'statusbar', 'view', 'editor-extension',
      'markdown-processor', 'codeblock-processor', 'editor-suggest', 'settings',
      'context-menu', 'theme', 'protocol-handler'];
    return valid.indexOf(type) >= 0;
  }

  /**
   * 登记:成功返回命名空间化的 extensionId。
   * 拒绝情形:pluginId 为空、未知类型、同插件同 (type, localName) 已存在(§5.4 ID 重复=拒绝)。
   */
  register(pluginId: string, type: string, localName: string, activationId: string): LexiExtensionOutcome {
    const outcome = new LexiExtensionOutcome();
    if (!pluginId || pluginId.length === 0) {
      outcome.reason = '注册缺少归属插件(匿名扩展一律拒绝)';
      return outcome;
    }
    if (!LexiExtensionRegistry.isValidType(type)) {
      outcome.reason = '未知扩展类型: ' + type;
      return outcome;
    }
    if (!localName || localName.length === 0) {
      outcome.reason = '扩展缺少局部名';
      return outcome;
    }
    const extensionId = pluginId + ':' + type + ':' + localName;
    if (this.records.has(extensionId)) {
      outcome.reason = 'extensionId 重复: ' + extensionId;
      return outcome;
    }
    const record = new LexiExtensionRecord();
    record.extensionId = extensionId;
    record.pluginId = pluginId;
    record.type = type as LexiExtensionType;
    record.localName = localName;
    record.activationId = activationId;
    record.createdAt = LexiExtensionRegistry.nowMs();
    this.records.set(extensionId, record);
    outcome.ok = true;
    outcome.extensionId = extensionId;
    return outcome;
  }

  /** 注销:只允许归属插件本人调用(会话与第三方一律拒绝)。 */
  unregister(pluginId: string, extensionId: string): boolean {
    const record = this.records.get(extensionId);
    if (record === undefined) { return false; }
    if (!pluginId || pluginId.length === 0 || record.pluginId !== pluginId) { return false; }
    this.records.delete(extensionId);
    return true;
  }

  /** 一次性回收某插件的全部注册记录(停用/卸载路径),返回回收条数。 */
  unregisterPlugin(pluginId: string): number {
    const doomed: string[] = [];
    this.records.forEach((record: LexiExtensionRecord, extensionId: string): void => {
      if (record.pluginId === pluginId) { doomed.push(extensionId); }
    });
    for (const extensionId of doomed) { this.records.delete(extensionId); }
    return doomed.length;
  }

  get(extensionId: string): LexiExtensionRecord | null {
    const record = this.records.get(extensionId);
    return record === undefined ? null : record;
  }

  list(pluginId: string = ''): LexiExtensionRecord[] {
    const result: LexiExtensionRecord[] = [];
    this.records.forEach((record: LexiExtensionRecord): void => {
      if (pluginId.length === 0 || record.pluginId === pluginId) { result.push(record); }
    });
    return result;
  }

  count(): number {
    return this.records.size;
  }
}
