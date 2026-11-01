import {
  CanvasBoard,
  CanvasCard,
  CanvasEdge,
  MindMapDoc,
  MindMapNode,
  NoteItem,
  NoteProperty,
  VaultItem
} from './LexiModels';

export class LexiSeedData {
  static buildSeedVaults(now: number): VaultItem[] {
    const v1 = new VaultItem();
    v1.id = 'default-vault';
    v1.name = '个人知识库';
    v1.description = '日常灵感、大学课程笔记与个人知识网络';
    v1.createdAt = now - 86400000 * 7;
    v1.version = 1;

    const v2 = new VaultItem();
    v2.id = 'dev-vault';
    v2.name = '开发项目库';
    v2.description = 'HarmonyOS 架构设计与技术复盘文档';
    v2.createdAt = now - 86400000 * 3;
    v2.version = 1;

    return [v1, v2];
  }

  static buildSeedNotes(now: number): NoteItem[] {
    const n1 = new NoteItem();
    n1.id = 'note-algo-complexity';
    n1.vaultId = 'default-vault';
    n1.title = '时间复杂度';
    n1.notebook = '计算机课程';
    n1.noteType = 'study';
    n1.editorLevel = 'study';
    n1.pinned = true;
    n1.favorite = true;
    n1.tags = ['学习/算法', '考试重点'];
    n1.properties = [
      new NoteProperty('课程', '数据结构与算法'),
      new NoteProperty('章节', '第 1 章 渐近分析'),
      new NoteProperty('掌握度', '熟练')
    ];
    n1.content = `# 时间复杂度核心笔记\n\n> [!NOTE] 核心定理\n> 算法的时间复杂度衡量输入规模 $n$ 趋近无穷时，基本操作执行次数的增长率。\n\n## 1. 主定理与递推公式\n\n$$T(n) = aT(n/b) + f(n)$$\n\n常见分治递归如归并排序满足 $a=2, b=2$，对应复杂度为 $O(n \\log n)$。\n\n## 2. 与其他结构的关联\n\n- 树形查找请结合 [[二叉树与递归遍历]] 一起复习\n- 状态转移空间优化参见 [[动态规划核心模型]]\n- 工程性能基线在 [[知萤 LexiNote 架构设计规范]] 中也有应用\n\n## 3. 自测清单\n\n- [x] 推导主定理三种情况\n- [x] 整理常见排序算法最坏与平均复杂度\n- [ ] 完成红黑树旋转摊还分析 #学习/算法`;
    n1.createdAt = now - 3600000 * 36;
    n1.updatedAt = now - 3600000 * 2;

    const n2 = new NoteItem();
    n2.id = 'note-binary-tree';
    n2.vaultId = 'default-vault';
    n2.title = '二叉树与递归遍历';
    n2.notebook = '计算机课程';
    n2.noteType = 'study';
    n2.editorLevel = 'study';
    n2.pinned = false;
    n2.favorite = true;
    n2.tags = ['学习/算法', '树结构'];
    n2.properties = [
      new NoteProperty('课程', '数据结构与算法'),
      new NoteProperty('关联导图', '数据结构与算法体系')
    ];
    n2.content = `# 二叉树与递归遍历\n\n> [!TIP] 记忆线索\n> 前序定根、中序分左右、后序自底向上汇总子树信息。\n\n## 1. 遍历框架代码\n\n\`\`\`typescript\nfunction traverse(node: TreeNode | undefined): void {\n  if (!node) return;\n  // 前序位置\n  traverse(node.left);\n  // 中序位置\n  traverse(node.right);\n  // 后序位置\n}\n\`\`\`\n\n## 2. 复杂度与拓展\n\n每个节点恰好被访问常数次，整体满足 [[时间复杂度]] 中的线性阶 $O(n)$。当树退化为链表时，高度变为 $O(n)$。\n\n子树最优解汇总可自然过渡到 [[动态规划核心模型]]（树形 DP）。`;
    n2.createdAt = now - 3600000 * 28;
    n2.updatedAt = now - 3600000 * 5;

    const n3 = new NoteItem();
    n3.id = 'note-dp-model';
    n3.vaultId = 'default-vault';
    n3.title = '动态规划核心模型';
    n3.notebook = '计算机课程';
    n3.noteType = 'study';
    n3.editorLevel = 'pro';
    n3.pinned = false;
    n3.favorite = false;
    n3.tags = ['学习/算法', '动态规划'];
    n3.properties = [
      new NoteProperty('状态定义', '重叠子问题 + 最优子结构')
    ];
    n3.content = `# 动态规划核心模型\n\n## 1. 状态转移三步法\n\n1. 明确状态变量（如容量、前 $i$ 个元素）\n2. 推导状态转移方程：\n\n$$dp[i][w] = \\max(dp[i-1][w], dp[i-1][w-c_i] + v_i)$$\n\n3. 利用滚动数组降低 [[时间复杂度]] 与空间开销。\n\n## 2. 树形与图论结合\n\n在树上进行状态转移时，必须先完成 [[二叉树与递归遍历]] 的后序收集。`;
    n3.createdAt = now - 3600000 * 20;
    n3.updatedAt = now - 3600000 * 8;

    const n4 = new NoteItem();
    n4.id = 'note-lexinote-arch';
    n4.vaultId = 'default-vault';
    n4.title = '知萤 LexiNote 架构设计规范';
    n4.notebook = '产品与架构';
    n4.noteType = 'markdown';
    n4.editorLevel = 'pro';
    n4.pinned = true;
    n4.favorite = true;
    n4.tags = ['开发/鸿蒙', '知识管理'];
    n4.properties = [
      new NoteProperty('架构原则', '本地优先 · 文件为事实来源'),
      new NoteProperty('视觉体系', '紫色沉浸光感 HDS')
    ];
    n4.content = `# 知萤 LexiNote 架构设计规范\n\n> 想记就记，需要时足够专业。让每一条笔记，成为可以连接、组织与重访的知识。\n\n## 1. 核心一致性原则\n\n- **不可变主键**：笔记以 UUID 标识，重命名标题时自动修复全文 [[双向链接]]，绝不断链。\n- **文件优先 + RDB 索引**：正文保存为标准 Markdown，随时可导出迁移。\n- **工具分层不割裂**：同一篇文档可在「简洁 / 学习 / 专业」三级工具间自由切换。\n\n## 2. 算法与性能基线\n\n大纲树与导图布局控制在目标 [[时间复杂度]] 之内，树形遍历采用 [[二叉树与递归遍历]] 的原子子树计算。`;
    n4.createdAt = now - 3600000 * 14;
    n4.updatedAt = now - 3600000 * 1;

    const n5 = new NoteItem();
    n5.id = 'note-quick-today';
    n5.vaultId = 'default-vault';
    n5.title = '今日灵感与待办速记';
    n5.notebook = '速记收件箱';
    n5.noteType = 'quick';
    n5.editorLevel = 'simple';
    n5.pinned = false;
    n5.favorite = false;
    n5.tags = ['日常/灵感', '待办'];
    n5.content = `# 今日灵感与待办速记\n\n- [x] 用 10 秒快速记录把散落的课堂想法收拢到知萤\n- [x] 把数据结构课程笔记连接到「数据结构与算法体系」思维导图\n- [ ] 周五前复盘一次时间复杂度与动态规划核心模型\n\n> 记下第一句话时不需要纠结分类，知识会在连接中自然生长。`;
    n5.createdAt = now - 3600000 * 4;
    n5.updatedAt = now - 1800000;

    return [n1, n2, n3, n4, n5];
  }

  private static createNode(
    id: string,
    parentId: string,
    text: string,
    order: number,
    colorTag: string,
    noteRefId: string = '',
    noteRefTitle: string = '',
    noteText: string = ''
  ): MindMapNode {
    const node = new MindMapNode();
    node.id = id;
    node.parentId = parentId;
    node.text = text;
    node.order = order;
    node.colorTag = colorTag;
    node.noteRefId = noteRefId;
    node.noteRefTitle = noteRefTitle;
    node.note = noteText;
    return node;
  }

  static buildSeedMindMaps(now: number): MindMapDoc[] {
    const map1 = new MindMapDoc();
    map1.id = 'map-ds-system';
    map1.vaultId = 'default-vault';
    map1.title = '数据结构与算法体系';
    map1.layoutKind = 'right';
    map1.rootNodeId = 'root';
    map1.favorite = true;
    map1.createdAt = now - 3600000 * 24;
    map1.updatedAt = now - 3600000 * 1;
    map1.nodes = [
      LexiSeedData.createNode('root', '', '数据结构与算法体系', 0, 'purple', 'note-algo-complexity', '时间复杂度', '期末核心复习总纲'),
      LexiSeedData.createNode('b1', 'root', '复杂度分析', 1, 'purple', 'note-algo-complexity', '时间复杂度', '渐近上界 O 与主定理'),
      LexiSeedData.createNode('b1-1', 'b1', '大 O 渐近记号', 1, 'purple'),
      LexiSeedData.createNode('b1-2', 'b1', 'Master 主定理', 2, 'purple'),
      LexiSeedData.createNode('b2', 'root', '非线性树结构', 2, 'indigo', 'note-binary-tree', '二叉树与递归遍历', '递归序与平衡树'),
      LexiSeedData.createNode('b2-1', 'b2', '前/中/后序递归框架', 1, 'indigo', 'note-binary-tree', '二叉树与递归遍历'),
      LexiSeedData.createNode('b2-2', 'b2', '二叉搜索树与 AVL', 2, 'indigo'),
      LexiSeedData.createNode('b3', 'root', '动态规划模型', 3, 'teal', 'note-dp-model', '动态规划核心模型', '状态定义与空间压缩'),
      LexiSeedData.createNode('b3-1', 'b3', '背包与区间 DP', 1, 'teal'),
      LexiSeedData.createNode('b3-2', 'b3', '树形 DP 状态汇总', 2, 'teal', 'note-dp-model', '动态规划核心模型')
    ];

    const map2 = new MindMapDoc();
    map2.id = 'map-lexi-product';
    map2.vaultId = 'default-vault';
    map2.title = '知萤个人知识工作流';
    map2.layoutKind = 'balanced';
    map2.rootNodeId = 'root';
    map2.favorite = false;
    map2.createdAt = now - 3600000 * 12;
    map2.updatedAt = now - 3600000 * 3;
    map2.nodes = [
      LexiSeedData.createNode('root', '', '知萤知识工作流', 0, 'purple', 'note-lexinote-arch', '知萤 LexiNote 架构设计规范'),
      LexiSeedData.createNode('p1', 'root', '1. 随手速记', 1, 'purple', 'note-quick-today', '今日灵感与待办速记', '10秒无负担记录'),
      LexiSeedData.createNode('p2', 'root', '2. 深度整理', 2, 'indigo', 'note-algo-complexity', '时间复杂度', '公式、高亮与代码块'),
      LexiSeedData.createNode('p3', 'root', '3. 双链成网', 3, 'teal', 'note-binary-tree', '二叉树与递归遍历', '双向引用与局部图谱'),
      LexiSeedData.createNode('p4', 'root', '4. 本地导出备份', 4, 'amber', '', '', 'Markdown 与 JSON 自由迁移')
    ];

    return [map1, map2];
  }

  static buildSeedCanvas(now: number): CanvasBoard {
    const board = new CanvasBoard();
    board.id = 'canvas-main';
    board.vaultId = 'default-vault';
    board.title = '算法与架构灵感白板';
    board.createdAt = now - 3600000 * 10;
    board.updatedAt = now - 3600000 * 2;

    const c1 = new CanvasCard();
    c1.id = 'card-1';
    c1.title = '渐近复杂度基石';
    c1.content = '先明确输入规模 n，再衡量递归分治与状态空间。';
    c1.noteRefId = 'note-algo-complexity';
    c1.noteRefTitle = '时间复杂度';
    c1.x = 36;
    c1.y = 42;
    c1.colorTag = 'purple';

    const c2 = new CanvasCard();
    c2.id = 'card-2';
    c2.title = '递归子树思维';
    c2.content = '把原问题拆解成左子树与右子树的信息汇总。';
    c2.noteRefId = 'note-binary-tree';
    c2.noteRefTitle = '二叉树与递归遍历';
    c2.x = 310;
    c2.y = 46;
    c2.colorTag = 'indigo';

    const c3 = new CanvasCard();
    c3.id = 'card-3';
    c3.title = '重叠子问题记忆化';
    c3.content = '从递归树剪枝自然导出自底向上的状态转移表。';
    c3.noteRefId = 'note-dp-model';
    c3.noteRefTitle = '动态规划核心模型';
    c3.x = 170;
    c3.y = 205;
    c3.colorTag = 'teal';

    board.cards = [c1, c2, c3];

    const e1 = new CanvasEdge();
    e1.id = 'edge-1';
    e1.fromId = 'card-1';
    e1.toId = 'card-2';
    e1.label = '分治递推';

    const e2 = new CanvasEdge();
    e2.id = 'edge-2';
    e2.fromId = 'card-2';
    e2.toId = 'card-3';
    e2.label = '树形 DP';

    board.edges = [e1, e2];
    return board;
  }
}
