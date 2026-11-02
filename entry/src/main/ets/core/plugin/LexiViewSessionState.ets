// RFC §7.3 / §14 T2.4 · 插件视图会话表(LexiViewSessionState)。
//
// 视图生命周期记账:创建→关闭→重开,重开时状态恢复正常(T2.4 验收)。
// 每个 open 会话绑定一个生命周期执行上下文(contextId 由宿主在 createContext(kind='view')
// 时签发),close 留 lastState 供重开恢复。纯逻辑、零 @kit 依赖,可在 Node 转译真跑。

export class LexiViewSession {
  viewType: string = '';
  pluginId: string = '';
  /** 当前打开会话的执行上下文;关闭后为空串。 */
  contextId: string = '';
  open: boolean = false;
  openCount: number = 0;
  closeCount: number = 0;
  /** 最近一次关闭时的视图状态(重开恢复的宿主侧真源)。 */
  lastState: Object | null = null;
}

export class LexiViewSessionTable {
  private sessions: Map<string, LexiViewSession> = new Map();

  /**
   * 打开(或重开)视图:未开过→创建;已关闭→重开并保留 lastState;
   * 已打开→拒绝(防重复挂载同一视图)。返回是否成功。
   */
  open(viewType: string, pluginId: string, contextId: string): boolean {
    if (!viewType || viewType.length === 0) { return false; }
    let session = this.sessions.get(viewType);
    if (session === undefined) {
      session = new LexiViewSession();
      session.viewType = viewType;
      session.pluginId = pluginId;
      this.sessions.set(viewType, session);
    }
    if (session.open) { return false; }
    session.open = true;
    session.contextId = contextId;
    session.openCount += 1;
    return true;
  }

  /** 关闭视图:记录关闭时状态(可 null),上下文交由宿主侧关闭。 */
  close(viewType: string, state: Object | null): boolean {
    const session = this.sessions.get(viewType);
    if (session === undefined || !session.open) { return false; }
    session.open = false;
    session.contextId = '';
    session.lastState = state;
    session.closeCount += 1;
    return true;
  }

  sessionOf(viewType: string): LexiViewSession | null {
    const session = this.sessions.get(viewType);
    return session === undefined ? null : session;
  }

  /** 插件停用:回收其全部会话(所有权清理)。 */
  dropPlugin(pluginId: string): number {
    const doomed: string[] = [];
    this.sessions.forEach((session: LexiViewSession, viewType: string): void => {
      if (session.pluginId === pluginId) { doomed.push(viewType); }
    });
    for (const viewType of doomed) { this.sessions.delete(viewType); }
    return doomed.length;
  }
}
