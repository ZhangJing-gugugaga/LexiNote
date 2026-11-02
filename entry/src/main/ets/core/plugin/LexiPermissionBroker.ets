// RFC §3.5/§3.6/§14 T0.3 · API Gateway 授权矩阵（LexiPermissionBroker）。
//
// 唯一授权入口：每个 RPC 处理器的放行与否都由 authorize() 决定，禁止各 handler
// 自行编写不一致的身份判断。设计约束：
//   - 纯逻辑、零 @kit 依赖：可在 Node 侧直接转译求值（plugin-authz-matrix.cjs 用真实
//     本模块跑全量伪造场景）；
//   - 默认拒绝：矩阵未登记的方法一律 ERR_PERMISSION_DENIED（fail-closed）；
//   - 身份校验在前：anonymous 只能走 public 类；资源所有权（resource.owner）由调用点
//     查表后传入，broker 只认"归属 == 调用方"；
//   - fs 写能力委托宿主注入的 fsAuthorizer（保留 v1 清单 legacy 语义），broker 不复制
//     manifest 解析逻辑，单一真源仍在 LexiPluginManifest。
//
// 矩阵类别（kind）：
//   public          任何角色（含 anonymous）——握手/生命周期回报/宿主只读状态
//   control-plane   仅页面会话角色 —— 插件控制面、主题、笔记写回、布局与全局存储
//   ui-domain       会话 + 插件 —— 通知/占位/命令列举执行/视图打开/事件订阅
//   fs-read         会话 + 插件（归属已验）—— vault 读取、metadata、editor.state
//   fs-write        插件 + fsAuthorizer —— vault 修改/创建/删除/重命名/追加
//   editor-write    仅插件 —— 编辑器正文修改（容器自身写正文走本地 CM6，不经 RPC）
//   register        仅插件 —— 命令/视图/代码块/设置注册
//   plugin-owned    插件 + resource.owner === pluginId（会话可代管）—— 跨插件资源删除防线
//   plugin-storage  仅插件 —— data.load/save（路径由身份决定，他人 data.json 不可达）
//   plugin-source   仅插件 —— plugin.sourceChunk/sourceSize（只回自己的源码）
//   net             仅插件 —— 网络出口（域名白名单仍在 LexiNetProbe，二次把关）
//   demo-plugin     仅插件 —— demo 通道

export type LexiCallerRole = 'host' | 'session' | 'plugin' | 'anonymous';

/** 调用方上下文：role 由凭据表解析（LexiWebRuntime.roleOfCredential），pluginId 只在 role=plugin 时有意义。 */
export class LexiCallerContext {
  role: LexiCallerRole = 'anonymous';
  pluginId: string = '';
  activationId: string = '';
  contextId: string = '';
}

/** 资源描述：所有权敏感的方法必须带 owner（当前归属插件 id）。 */
export class LexiAuthzResource {
  owner: string = '';
  fullId: string = '';
  type: string = '';
  iconId: string = '';
}

/** 授权结论：code 区分 ERR_UNAUTHORIZED（身份/角色）与 ERR_PERMISSION_DENIED（权限/归属）。 */
export class LexiAuthzDecision {
  allowed: boolean = false;
  code: string = 'ERR_PERMISSION_DENIED';
  reason: string = '';
  method: string = '';
  role: string = '';
  kind: string = '';
}

/** fs 写能力判定器：由宿主注入（fsGate 语义），返回 true=放行。 */
export type LexiFsAuthorizer = (pluginId: string, method: string) => boolean;

export class LexiPermissionBroker {
  private readonly matrix: Map<string, string> = new Map<string, string>();
  private readonly fsAuthorizer: LexiFsAuthorizer;

  constructor(fsAuthorizer: LexiFsAuthorizer) {
    this.fsAuthorizer = fsAuthorizer;
    const matrix = this.matrix;
    // --- public：握手与生命周期回报（匿名可信度 = 零，但流程必须能走通） ---
    const publicMethods: string[] = [
      'channel.hello', 'channel.auth',
      'runtime.ready', 'plugin.onload.done', 'plugin.onload.error', 'plugin.unload.done',
      'app.isDarkMode', 'workspace.onLayoutReady', 'workspace.layoutReady',
      'log.event'
    ];
    for (const method of publicMethods) { matrix.set(method, 'public'); }
    // --- control-plane：页面会话专属（RFC T0.1：插件控制面不得暴露给插件上下文） ---
    const controlPlane: string[] = [
      'plugin.list', 'plugin.load', 'plugin.unload',
      'note.write', 'workspace.saveLayout', 'workspace.loadLayout',
      'theme.config', 'theme.list', 'theme.load', 'theme.install', 'theme.setActive',
      'debug.delay'
    ];
    for (const method of controlPlane) { matrix.set(method, 'control-plane'); }
    // --- ui-domain：会话 + 插件 ---
    const uiDomain: string[] = [
      'ui.notice', 'ui.placeholder', 'ui.addRibbon', 'ui.removeRibbon', 'ui.addIcon',
      'commands.list', 'commands.execute',
      'workspace.openView', 'workspace.openLinkText',
      'events.on',
      'app.localStorage.get', 'app.localStorage.set'
    ];
    for (const method of uiDomain) { matrix.set(method, 'ui-domain'); }
    // --- fs-read：会话 + 插件（metadata/editor.state 同为只读域） ---
    const fsRead: string[] = [
      'vault.files', 'vault.getByPath', 'vault.read',
      'metadata.get', 'metadata.firstLink', 'metadata.resolved', 'metadata.graph', 'metadata.getAllProperties',
      'editor.state'
    ];
    for (const method of fsRead) { matrix.set(method, 'fs-read'); }
    // --- fs-write：插件 + fsAuthorizer ---
    const fsWrite: string[] = ['vault.modify', 'vault.create', 'vault.delete', 'vault.rename', 'vault.append'];
    for (const method of fsWrite) { matrix.set(method, 'fs-write'); }
    // --- editor-write：仅插件 ---
    const editorWrite: string[] = ['editor.replace', 'editor.selection', 'editor.applyChanges'];
    for (const method of editorWrite) { matrix.set(method, 'editor-write'); }
    // --- register：仅插件 ---
    const register: string[] = ['commands.add', 'views.add', 'codeblocks.register', 'settings.register', 'settings.unregister'];
    for (const method of register) { matrix.set(method, 'register'); }
    // --- plugin-owned：归属校验（会话可代管） ---
    const owned: string[] = ['commands.remove', 'views.remove', 'events.off', 'codeblocks.unregister', 'workspace.closeView'];
    for (const method of owned) { matrix.set(method, 'plugin-owned'); }
    // --- plugin-storage / plugin-source / net / demo：仅插件 ---
    matrix.set('data.load', 'plugin-storage');
    matrix.set('data.save', 'plugin-storage');
    matrix.set('plugin.sourceChunk', 'plugin-source');
    matrix.set('plugin.sourceSize', 'plugin-source');
    matrix.set('net.requestUrl', 'net');
    matrix.set('demo.ready', 'demo-plugin');
    matrix.set('demo.ping', 'demo-plugin');
  }

  /** 矩阵登记表（门禁用它对账"每个 handler 都有矩阵条目"）。 */
  matrixKeys(): string[] {
    const keys: string[] = [];
    this.matrix.forEach((_kind: string, method: string): void => { keys.push(method); });
    return keys.sort();
  }

  kindOf(method: string): string {
    const kind = this.matrix.get(method);
    return kind === undefined ? '' : kind;
  }

  private isPlugin(ctx: LexiCallerContext): boolean {
    return ctx.role === 'plugin' && ctx.pluginId.length > 0;
  }

  private deny(decision: LexiAuthzDecision, code: string, reason: string): LexiAuthzDecision {
    decision.allowed = false;
    decision.code = code;
    decision.reason = reason;
    return decision;
  }

  private allow(decision: LexiAuthzDecision, reason: string): LexiAuthzDecision {
    decision.allowed = true;
    decision.code = '';
    decision.reason = reason;
    return decision;
  }

  /**
   * 唯一授权入口。resource 在所有权敏感的方法上必须携带当前归属；
   * 归属为空时插件一律拒绝（会话可代管），即"不能删除看不清主人的东西"。
   */
  authorize(ctx: LexiCallerContext, method: string, resource: LexiAuthzResource | null = null): LexiAuthzDecision {
    const decision = new LexiAuthzDecision();
    decision.method = method;
    decision.role = ctx.role as string;
    const kind = this.kindOf(method);
    decision.kind = kind.length > 0 ? kind : 'unmapped';
    if (kind.length === 0) {
      return this.deny(decision, 'ERR_PERMISSION_DENIED', '方法未登记授权矩阵（默认拒绝）: ' + method);
    }
    if (kind === 'public') {
      return this.allow(decision, 'public 方法不要求身份');
    }
    if (kind === 'control-plane') {
      if (ctx.role === 'session') { return this.allow(decision, '页面会话角色'); }
      return this.deny(decision, 'ERR_UNAUTHORIZED',
        '控制面方法只允许页面会话调用（当前角色 ' + ctx.role + '）: ' + method);
    }
    if (kind === 'ui-domain' || kind === 'fs-read') {
      if (ctx.role === 'session' || this.isPlugin(ctx)) {
        return this.allow(decision, kind + ' 对已认证调用方放行');
      }
      return this.deny(decision, 'ERR_UNAUTHORIZED', '匿名调用无权访问 ' + kind + ' 方法: ' + method);
    }
    if (kind === 'fs-write') {
      if (!this.isPlugin(ctx)) {
        return this.deny(decision, 'ERR_UNAUTHORIZED',
          'vault 写入只允许插件身份（当前角色 ' + ctx.role + '）: ' + method);
      }
      if (this.fsAuthorizer(ctx.pluginId, method)) {
        return this.allow(decision, '插件声明了 fs 写能力');
      }
      return this.deny(decision, 'ERR_PERMISSION_DENIED', 'fs: 插件未获得写授权: ' + method);
    }
    if (kind === 'editor-write' || kind === 'register' || kind === 'plugin-storage' ||
      kind === 'plugin-source' || kind === 'net' || kind === 'demo-plugin') {
      if (this.isPlugin(ctx)) {
        return this.allow(decision, kind + ' 对插件身份放行');
      }
      return this.deny(decision, 'ERR_UNAUTHORIZED',
        kind + ' 方法只允许插件身份（当前角色 ' + ctx.role + '）: ' + method);
    }
    if (kind === 'plugin-owned') {
      if (ctx.role === 'session') { return this.allow(decision, '会话可代管资源删除'); }
      if (!this.isPlugin(ctx)) {
        return this.deny(decision, 'ERR_UNAUTHORIZED', '匿名调用无权删除资源: ' + method);
      }
      const owner: string = resource === null ? '' : resource.owner;
      if (owner.length === 0) {
        return this.deny(decision, 'ERR_PERMISSION_DENIED', '资源归属不明（拒绝删除）: ' + method);
      }
      if (owner === ctx.pluginId) {
        return this.allow(decision, '资源归属调用方');
      }
      return this.deny(decision, 'ERR_PERMISSION_DENIED',
        '资源归属 ' + owner + '，调用方 ' + ctx.pluginId + ' 无权删除: ' + method);
    }
    return this.deny(decision, 'ERR_PERMISSION_DENIED', '未处理的矩阵类别: ' + kind);
  }
}
