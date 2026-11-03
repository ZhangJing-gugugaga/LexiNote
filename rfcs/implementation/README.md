# 插件生态工程实施体系

每轮工作（含新会话）按此顺序恢复状态：

1. 读 `../third-party-plugin-ecosystem-rfc.md`（架构基准，不得凭记忆改架构）。
2. 读 `EXECUTION_PLAN.md`：确认当前 Phase、任务状态、依赖。
3. 读 `PROGRESS.md` 最新一节：上轮实际做完什么、测试证据。
4. 读 `BLOCKERS.md`：当前阻塞与所需资源。
5. 读 `TEST_MATRIX.md`：哪些能力有证据、哪些只有接口。
6. `git status` + `git log --oneline -5`：检查工作区，禁止覆盖未提交修改。

## 工程纪律（摘自总 Goal,与 RFC §17 对齐）

- 每轮选**一个边界清晰的任务**（或高度相关小任务组），优先级：安全缺陷 > 阶段阻塞架构问题 > 核心缺陷 > 契约不一致 > 测试缺口 > 开发者体验 > 上层功能。
- IMPLEMENTED ≠ VERIFIED。没有实际执行证据不得标 VERIFIED；真机不能跑的测试如实标 BLOCKED/NOT RUN。
- 不删除原有测试来通过门禁；不用 mock 结果冒充集成验证；不把 TODO 当完成。
- 架构差异先查真实情况→分析原因→必要时写 ADR，不得静默改架构。
- 涉及插件运行时替换、RPC 协议大改、Manifest 破坏性修改、生产密钥、公开市场：先技术论证并取得确认。

## 测试入口（本机 Windows）

```bash
export LEXI_TYPESCRIPT="E:/dev-tools/harmonyos/command-line-tools/hvigor/hvigor/node_modules/typescript"
"<真实 node.exe>" tools/plugin-dist/release-gate.cjs --ci   # 28 步全量门禁
```

注意：PATH 上的 `node` 可能是坏 shim（"stdin is not a tty"，exit 1），需用
`"/c/Program Files/nodejs/node.exe"` 绝对路径（P0-006 待修）。
