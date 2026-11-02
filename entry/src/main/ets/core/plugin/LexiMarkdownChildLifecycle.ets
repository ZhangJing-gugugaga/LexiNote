// RFC §7.5 / §14 T3.1 · Markdown 渲染子生命周期(LexiMarkdownChildLifecycle)。
//
// MarkdownRenderChild 账本(§7.5):addChild 即 onload;release(renderId) 按"后进先出"
// 逆序 onunload 且各一次;重渲染 = 新 renderId 建子 + 旧 renderId 释放(重渲染时释放旧实例);
// releaseAll 供容器销毁。纯逻辑、零 @kit 依赖,可在 Node 转译真跑。

export interface LexiMarkdownChildLike {
  onload?: () => void;
  onunload?: () => void;
}

export class LexiMarkdownChildLifecycle {
  /** renderId → 该次渲染挂载的子实例(按 addChild 顺序)。 */
  private children: Map<string, Object[]> = new Map();
  /** 已卸载标记:Object → true(保证 onunload 恰一次)。 */
  private unloaded: Map<Object, boolean> = new Map();

  /** 挂载子实例:立即调 onload(若实现)。 */
  addChild(renderId: string, child: Object): void {
    if (!renderId || renderId.length === 0 || child === null || child === undefined) { return; }
    let bucket = this.children.get(renderId);
    if (bucket === undefined) {
      bucket = [];
      this.children.set(renderId, bucket);
    }
    bucket.push(child);
    const childLike = child as LexiMarkdownChildLike;
    if (typeof childLike.onload === 'function') { childLike.onload(); }
  }

  countOf(renderId: string): number {
    const bucket = this.children.get(renderId);
    return bucket === undefined ? 0 : bucket.length;
  }

  /** 释放一次渲染的全部子实例:逆序 onunload(后进先出),每个实例恰一次。 */
  release(renderId: string): number {
    const bucket = this.children.get(renderId);
    if (bucket === undefined || bucket.length === 0) { return 0; }
    this.children.delete(renderId);
    let released = 0;
    for (let i = bucket.length - 1; i >= 0; i--) {
      const child = bucket[i];
      if (this.unloaded.get(child) === true) { continue; }
      this.unloaded.set(child, true);
      const childLike = child as LexiMarkdownChildLike;
      if (typeof childLike.onunload === 'function') { childLike.onunload(); }
      released += 1;
    }
    return released;
  }

  /** 容器销毁:释放所有 renderId 的子实例。 */
  releaseAll(): number {
    const renderIds: string[] = [];
    this.children.forEach((_bucket: Object[], renderId: string): void => { renderIds.push(renderId); });
    let total = 0;
    for (const renderId of renderIds) { total += this.release(renderId); }
    return total;
  }
}
