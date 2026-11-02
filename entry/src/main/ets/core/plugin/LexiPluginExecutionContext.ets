// RFC §3.3/§4.4 · 插件执行上下文。
// 一个逻辑 activation 可以拥有多个受控执行上下文(service/view/markdown/editor/theme),
// 每个上下文有独立 contextId;宿主在创建传输端口时把身份四元组绑定到上下文,
// 插件侧拿不到该记录本体。停用前必须全部关闭(先释放资源、后停,§4.3)。

export type LexiContextKind = 'service' | 'view' | 'markdown' | 'editor' | 'theme';

export class LexiPluginExecutionContext {
  contextId: string = '';
  activationId: string = '';
  pluginId: string = '';
  kind: LexiContextKind = 'service';
  createdAt: number = 0;
  closedAt: number = 0;
}
