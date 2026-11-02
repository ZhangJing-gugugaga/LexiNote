// RFC §7.5 / §14 T3.1 · Markdown 渲染上下文与处理器执行(LexiMarkdownRenderContext)。
//
// MarkdownPostProcessorContext(sourcePath/frontmatter/renderId/getSectionInfo/signal)
// + 顺序执行器:同步与异步处理器混排、按优先级顺序执行、单个处理器失败只记账不破坏
// 整篇(§7.5 "处理器失败不破坏整篇笔记")、abort 后跳过。
// runProcessorsSync 用 Promise 化包装执行(在 Node 转译求值里同步序即可断言;页面侧
// LexiReading.applyPostProcessors 承担真正的 async 编排,契约一致)。
// 纯逻辑、零 @kit 依赖。

export class LexiAbortSignal {
  aborted: boolean = false;
}

export class LexiSectionInfo {
  sourcePath: string = '';
  frontmatterPosition: number = -1;
  sectionIndex: number = -1;
}

export class LexiProcessorError {
  id: string = '';
  message: string = '';
}

export class LexiProcessorRunOutcome {
  errors: LexiProcessorError[] = [];
  completed: number = 0;
  skipped: number = 0;
}

export interface LexiMarkdownProcessorLike {
  id: string;
  priority: number;
  run: (el: Object | null, context: LexiMarkdownRenderContext) => void | Promise<void>;
}

/** 顺序执行器与上下文同类承载:实例字段是 §7.5 处理器上下文,静态方法是执行编排。 */
export class LexiMarkdownRenderContext {
  sourcePath: string = '';
  renderId: string = '';
  frontmatter: Record<string, Object> | null = null;
  signal: LexiAbortSignal = new LexiAbortSignal();

  /** §7.5 getSectionInfo:处理器按需取 section 元信息(页面侧绑定真实 DOM/位置)。 */
  getSectionInfo(_el: Object | null): LexiSectionInfo | null {
    return null;
  }

  /**
   * 顺序执行器:优先级升序;每个处理器 try/catch,失败落 errors 继续;signal.aborted 全部跳过。
   * 处理器可返回 Promise(异步):本执行器按序调度,保持"稳定执行顺序"语义;
   * 真正的 await 编排在页面侧 LexiReading.applyPostProcessors(契约一致)。
   */
  static runProcessorsSync(entries: LexiMarkdownProcessorLike[], signal: LexiAbortSignal | null): LexiProcessorRunOutcome {
    const outcome = new LexiProcessorRunOutcome();
    const sorted = entries.slice().sort((a: LexiMarkdownProcessorLike, b: LexiMarkdownProcessorLike): number => a.priority - b.priority);
    for (const entry of sorted) {
      if (signal !== null && signal.aborted) {
        outcome.skipped += 1;
        continue;
      }
      try {
        const context = new LexiMarkdownRenderContext();
        entry.run(null, context);
        outcome.completed += 1;
      } catch (error) {
        const failure = new LexiProcessorError();
        failure.id = entry.id;
        failure.message = error instanceof Error ? error.message : String(error);
        outcome.errors.push(failure);
      }
    }
    return outcome;
  }
}
