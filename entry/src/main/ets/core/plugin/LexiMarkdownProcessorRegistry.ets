// RFC §7.5 / §14 T3.1 · Markdown 后处理器注册表(LexiMarkdownProcessorRegistry)。
//
// 语义(与页面侧 LexiReading.registerPostProcessor 同契约):
//   - extensionId = pluginId:markdown-processor:processorId(T1.2 命名空间);
//   - 优先级排序,同优先级保持注册序(§7.5 插件之间稳定执行顺序);
//   - 同插件重复注册拒绝;注销必须本人;unregisterPlugin 一次性回收。
// 纯逻辑、零 @kit 依赖,可在 Node 转译真跑(plugin-markdown-pipeline.cjs)。

export class LexiMarkdownProcessorEntry {
  extensionId: string = '';
  pluginId: string = '';
  processorId: string = '';
  priority: number = 0;
  /** 注册序(同优先级的稳定 tiebreaker)。 */
  order: number = 0;
}

export class LexiMarkdownProcessorOutcome {
  ok: boolean = false;
  extensionId: string = '';
  reason: string = '';
}

export class LexiMarkdownProcessorRegistry {
  private entries: Map<string, LexiMarkdownProcessorEntry> = new Map();
  private seq: number = 0;

  register(pluginId: string, processorId: string, priority: number): LexiMarkdownProcessorOutcome {
    const outcome = new LexiMarkdownProcessorOutcome();
    if (!pluginId || pluginId.length === 0) {
      outcome.reason = '注册缺少归属插件';
      return outcome;
    }
    if (!processorId || processorId.length === 0) {
      outcome.reason = '缺少处理器 id';
      return outcome;
    }
    const extensionId = pluginId + ':markdown-processor:' + processorId;
    if (this.entries.has(extensionId)) {
      outcome.reason = 'extensionId 重复: ' + extensionId;
      return outcome;
    }
    this.seq += 1;
    const entry = new LexiMarkdownProcessorEntry();
    entry.extensionId = extensionId;
    entry.pluginId = pluginId;
    entry.processorId = processorId;
    entry.priority = priority;
    entry.order = this.seq;
    this.entries.set(extensionId, entry);
    outcome.ok = true;
    outcome.extensionId = extensionId;
    return outcome;
  }

  /** 优先级升序 + 注册序稳定 tiebreaker(§7.5)。 */
  orderedIds(): string[] {
    const list: LexiMarkdownProcessorEntry[] = [];
    this.entries.forEach((entry: LexiMarkdownProcessorEntry): void => { list.push(entry); });
    list.sort((a: LexiMarkdownProcessorEntry, b: LexiMarkdownProcessorEntry): number => {
      if (a.priority !== b.priority) { return a.priority - b.priority; }
      return a.order - b.order;
    });
    const ids: string[] = [];
    for (const entry of list) { ids.push(entry.extensionId); }
    return ids;
  }

  get(extensionId: string): LexiMarkdownProcessorEntry | null {
    const entry = this.entries.get(extensionId);
    return entry === undefined ? null : entry;
  }

  /** 注销必须本人(会话不得代管注销他人后处理器)。 */
  unregister(pluginId: string, extensionId: string): boolean {
    const entry = this.entries.get(extensionId);
    if (entry === undefined) { return false; }
    if (!pluginId || pluginId.length === 0 || entry.pluginId !== pluginId) { return false; }
    this.entries.delete(extensionId);
    return true;
  }

  unregisterPlugin(pluginId: string): number {
    const doomed: string[] = [];
    this.entries.forEach((entry: LexiMarkdownProcessorEntry, extensionId: string): void => {
      if (entry.pluginId === pluginId) { doomed.push(extensionId); }
    });
    for (const extensionId of doomed) { this.entries.delete(extensionId); }
    return doomed.length;
  }

  count(): number {
    return this.entries.size;
  }
}
