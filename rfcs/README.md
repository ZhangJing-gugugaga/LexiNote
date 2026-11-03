# LexiNote 插件生态 RFC 与工程记录

**最高架构依据：** [`third-party-plugin-ecosystem-rfc.md`](./third-party-plugin-ecosystem-rfc.md)（LEXI-RFC-PLUGIN-001 v1.0.0，审查基线 commit `c1863ff`）。

RFC 描述**目标架构**，不代表已实现。实现状态一律以 `implementation/` 下的记录和实际测试为准，状态词汇：

| 状态 | 含义 |
|---|---|
| Existing | 源码中已实现 |
| Partial | 部分实现，未成闭环 |
| Proposed | RFC 提议，未开工 |
| IMPLEMENTED | 代码完成，离线门禁通过 |
| VERIFIED | 有实际测试/真机证据的验收 |
| BLOCKED | 有外部依赖或决策阻塞，见 BLOCKERS.md |
| DEFERRED | 明确推迟 |

## 目录

```text
rfcs/
├── README.md                        ← 本文件
├── third-party-plugin-ecosystem-rfc.md  ← 主 RFC（进 Git,不依赖被忽略的 docs/）
└── implementation/
    ├── README.md                    ← 工程体系使用说明(如何无损恢复状态)
    ├── EXECUTION_PLAN.md            ← P0-P6 任务树(唯一计划真源)
    ├── PROGRESS.md                  ← 逐轮进展记录
    ├── ARCHITECTURE_DECISIONS.md    ← 架构决策记录
    ├── TEST_MATRIX.md               ← 能力→测试→证据矩阵
    ├── BLOCKERS.md                  ← 阻塞与外部依赖
    ├── MODULE_MAP.md                ← 当前真实模块图(审计结论)
    └── RELEASE_READINESS.md         ← 发布就绪清单
```

## 历史说明

2026-11-03 之前的六轮工作记录在 `docs/lexinote_phase*_round*.md`。`docs/` 被根 `.gitignore` 忽略（本地留存），
自 Round 7 起，工程状态的版本控制真源迁移到本目录；`docs/` 中八篇公开开发者文档纳入 Git 的任务为 P0-004。
