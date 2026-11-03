# MODULE_MAP — 审计确认的真实模块图（c1863ff）

## 执行路径（两条业务轨道 + PoC）

```text
轨道1 无头运行时(service 插件, 宿主 push)
  Index.ets:1354 → LexiPluginRuntimeHost(components/plugin/)
    Web(lexinote_plugin_runtime.html) [CSP 允许 'unsafe-eval', fileAccess(false)]
    页→宿主: javaScriptProxy 'lexiHost'.call(callId, method, raw, token)
    宿主→页: LexiWebRuntime.dispatch = runJavaScript('window.lexiRuntime.__receive(…)')
    lexinote_plugin_shim.js: loadPlugin → new Function(code)   ← 所有插件共享同一 realm
    身份: LexiCredentialFactory(CSPRNG) → pluginTokens: Map<credential, pluginId> (LexiPluginRuntime.ets:164)
    暴露面: LexiObsidian.currentToken()(:2626 回落 sessionToken)、app.plugins.getPlugin 实例.__lexiToken(:2306)

轨道2 Workspace 容器(手机默认开笔记路径)
  Index.ets:444 → LexiWorkspacePage: Web(lexinote_workspace.html)
    握手 javaScriptProxy '__lexiHandshake'.hello → createWebMessagePorts 端口对(此页已用 MessageChannel)
    页内 bundle lexinote_workspace.js 同时驱动两个 shim:
      lexinote_workspace_shim.js:224 new Function(新 SDK 插件)   ← 共享 realm
      lexinote_plugin_shim.js:2275 new Function(obsidian 兼容插件) ← 同上
      lexiHost 被重指向端口; setSessionToken 暴露为 window 全局(workspace_shim:329-349)
    宿主: WorkspaceBridge.dispatch → 自有 broker(:100) → mint tokens → delegate → LexiWebRuntime.call

PoC(仅探针, 不承载业务)
  Index.ets:1356 → LexiSandboxHost(components/plugin/LexiSandboxHost.ets)
    Web(lexinote_sandbox_poc.html): per-context iframe sandbox="allow-scripts"(opaque origin)
    + 每上下文独立 MessageChannel, port2 转移, 身份只留宿主侧; 唯一 RPC 方法 log.event

退役面: LexiPluginViewSlot/CodeBlockSlot → lexinote_plugin_view.html → reportRetired(不再求值)
```

## 核心模块清单（复用优先，RFC §1.1）

| 域 | 文件(entry/src/main/ets/) | 现状 |
|---|---|---|
| 运行时/RPC | core/plugin/LexiPluginRuntime.ets（含类 LexiPluginManager:409, LexiWebRuntime.call:274 单入口+broker+stripClaimedIdentity） | Existing; 身份暴露面待修 P1-006 |
| 桥 | core/plugin/WorkspaceBridge.ets（第二 RPC 入口, 自有 broker） | Existing; 双入口待收敛 P1-007 |
| 沙箱 | components/plugin/LexiSandboxHost.ets + rawfile/lexinote_{sandbox_poc.html,plugin_sandbox.html,sandbox_probe.js} | Partial(PoC) |
| 上下文记账 | core/plugin/LexiPluginExecutionContext.ets(contextId/activationId/kind, 无端口绑定), LexiPluginLifecycleManager.ets | Partial |
| 清单 | core/plugin/LexiPluginManifestV2.ets（严格解析✔）→ LexiPluginManifest.ets(manifestFromV2 **销毁 v2 细粒度视图**) | Partial→P2-001 |
| 授权 | core/plugin/LexiPermissionBroker.ets(10 kind 矩阵, unmapped 默认拒✔; 真 capability 仅 fs-write+net host), LexiPermissionStore.ets(指纹=3 类粗标签) | Partial→P2-002/003 |
| 网络 | core/plugin/LexiNetProbe.ets(origin 白名单✔; method 硬转 GET/POST、无字节上限) | Partial→P2-006 |
| 生命周期 | core/plugin/LexiPluginLifecycleManager.ets, LexiPluginActivation.ets | Partial(状态面不全) |
| 注册表 | core/plugin/LexiExtensionRegistry.ets(所有权✔测试), LexiEditorRegistry/LexiPluginViewRegistry/LexiMarkdownProcessorRegistry | Existing |
| 安装 | core/plugin/LexiPluginInstaller.ets(不可变版本目录/回滚✔; verifyPackageHash 空哈希跳过→仅被 P5-001 闸门在外围封死; revocations 永不填充) | Partial |
| 包校验 | core/plugin/LexiPackageVerifier.ets(结构/预算✔; verifyPublisherSignature 生产零调用) | Partial |
| 信任链 | core/plugin/LexiRegistryTrust.ets(TUF 风格 4 角色✔单测; **宿主零引用**) | Partial→P5-002 |
| 更新策略 | core/plugin/LexiUpdatePolicy.ets(降级拒✔/重授权缝在但 grantApproved 无 UI 可达) | Partial |
| 市场 | components/plugin/LexiPluginMarketSheet.ets + core/plugin/LexiPluginMarketModel.ets（Round 7: isTrustedInstallHash 唯一判定, fail-closed 远程闸门） | Partial→P5-004/006 |
| Inspector | core/plugin/LexiPluginInspector.ets(rpcDenies/报告缝) | Partial→P3-006 |
| SDK | packages/lexinote-plugin-sdk(ts 源码直连, sync 方向倒置模板→SDK) | Partial→P3-001/002 |
| CLI | tools/lexi-cli/lexi.cjs(create/validate/pack/sign(HMAC dev 缝)/publish) | Partial |
| 模板 | tools/lexinote-plugin-template(自带类型副本) | Partial |
| 契约 | tools/plugin-contract + tools/contract/symbols.json(334 符号: implemented 33/partial 67/stub 19/unsupported 215) | Existing |
| 发布 | tools/lexinote-releases(索引/元数据镜像仓库) + tools/plugin-dist/release-gate.cjs(28 门禁) | Partial |

## 测试设施

84 个 `.cjs`（40 个 plugin-*），唯一统一入口 `tools/plugin-dist/release-gate.cjs --ci`（28 步）；
根仓库无 GitHub Actions（P0-003）；`lefthook.yml` 全注释（无钩子）。真机批次
`plugin-dist-flows.cjs`（默认 dry-run）依赖模拟器（当前 B-001）。

## 已知问题台账

`tools/plugin-dist/known-issues.md`：KI-1 市场 Sheet 滚动不可达、KI-2 幽灵已安装条目、KI-3 shell 无写权限（workaround 已采纳）。归入 P5-007/008。
