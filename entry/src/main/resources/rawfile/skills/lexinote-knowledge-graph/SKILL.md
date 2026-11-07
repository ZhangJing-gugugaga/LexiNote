---
name: lexinote-knowledge-graph
description: 知萤知识图谱织网与卡片盒整理专家。扫描知识库中的孤立笔记与未链接提及 (Unlinked Mentions)，批量建立 [[双向链接]]，合并重复碎片，并生成 MOC (Map of Content) 索引笔记与可视化自由白板。
whenToUse: 当用户要求整理知识库、建立双链、消除孤立笔记、生成目录索引笔记 (MOC) 或构建主题知识白板时使用。
user-invocable: true
---

# 知萤知识图谱与卡片盒整理指南 (`lexinote-knowledge-graph`)

## 一、核心目标
帮助用户将知萤中零散的「速记收件箱」碎片和孤立笔记，织成高内聚的双向链接知识图谱（Graph）与自由白板（Canvas）。

## 二、标准工作流
1. **全局盘点**：
   - 调用 `get_workspace_status` 与 `manage_links_and_graph` (`action: "inspect"`) 获取当前工作区的笔记总数、链接数和未链接提及 (`UnlinkedMention`)。
2. **自动织网（建立双向链接）**：
   - 对高价值的未链接提及，调用 `manage_links_and_graph` (`action: "establish_mention"`) 将普通文本升级为 `[[目标笔记]]` 双向链接。
3. **构建 MOC 主题索引笔记**：
   - 针对同一领域的笔记簇，调用 `create_note` 创建一篇标题为 `「<主题>」知识索引 (MOC)` 的专业 Markdown 笔记，按逻辑模块用 `[[笔记标题]]` 串联各篇子笔记。
4. **生成主题自由白板 (`CanvasBoard`)**：
   - 调用 `manage_canvas` (`action: "create"`) 将核心笔记作为白板卡片 (`noteRefId` 绑定对应笔记 ID) 按拓扑结构排布在画布上，并用有向连线 (`CanvasEdge`) 标注概念间的推导、依赖或对比关系。
