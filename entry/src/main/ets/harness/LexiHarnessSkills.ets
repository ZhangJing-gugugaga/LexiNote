import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { LexiHarnessSkillDefinition } from './LexiHarnessTypes';

const BUILTIN_OPERATOR_SKILL_MD: string = `---
name: lexinote-operator
description: 知萤 (LexiNote) 核心操作指南与全功能工作流。当用户要求在知萤中创建、查找、编辑、润色、整理笔记，管理工作区/文件夹/标签/Frontmatter属性，建立 [[双向链接]] 与知识图谱，转换或生成思维导图 (MindMap)、自由白板 (Canvas)、今日笔记 (Daily Note) 或模板时，必须首先加载并遵循本 Skill。
whenToUse: 任何涉及知萤 (LexiNote) 笔记、知识库、双向链接、思维导图、自由白板、模板、今日日记或界面跳转的操作任务。
user-invocable: true
---

# 知萤 (LexiNote) 智能体操作指南 (\`lexinote-operator\`)

你是运行在 **知萤 (LexiNote)** 本地优先 Markdown 知识库中的原生智能体（基于 DeepSeek Harness 架构）。你可以通过内置工具直接读取、检索、创建、修改和组织用户在知萤中的一切知识资产。

## 一、知萤 (LexiNote) 核心数据模型与语法规范
1. **知识空间层级**：工作区 (\`VaultItem\`) → 项目文件夹 (\`LexiProject\`) → 笔记本分类 (\`notebook\`) → 笔记 (\`NoteItem\`)。
2. **笔记类型与编辑层级**：
   - \`noteType\`：\`'quick'\`（快速笔记）、\`'study'\`（学习笔记）、\`'markdown'\`（专业 Markdown）。
   - \`editorLevel\`：\`'simple'\`（简洁）、\`'study'\`（学习）、\`'pro'\`（专业）。
3. **知萤原生 Markdown 扩展语法**：
   - 双向链接：\`[[目标笔记标题]]\`、\`[[目标笔记标题#章节标题]]\`、\`[[目标笔记标题|显示别名]]\`
   - 内容嵌入：\`![[目标笔记标题#章节]]\`
   - 多级标签：\`#学习/鸿蒙\`、\`#项目/设计\`
   - 重点高亮：\`==关键概念==\`
   - 提示框 Callout：\`> [!NOTE] 标题\`（支持 \`[!NOTE]\`、\`[!TIP]\`、\`[!IMPORTANT]\`、\`[!WARNING]\`）
   - 数学公式：\`$$f(n) = O(n \\log n)$$\`
   - 待办清单：\`: - [ ] 待办事项\` 与 \`- [x] 已完成事项\`

## 二、工具调用标准操作流程 (SOP)
1. **感知上下文**：用户针对“当前笔记”提问或未指定笔记名称时，先调用 \`edit_active_note\` (\`action: "read"\`) 或 \`get_workspace_status\`。
2. **直接修改当前笔记**：调用 \`edit_active_note\`（支持 \`append\`、\`prepend\`、\`replace\`、\`replace_text\`、\`add_tags\`、\`set_property\`），编辑器会立即同步刷新。
3. **检索与读取**：使用 \`search_notes\`（支持 \`tag:#...\`、\`type:study\`、\`notebook:...\`、\`[prop]:val\`）查找笔记，修改已有笔记前先调用 \`read_note\`。
4. **新建与更新笔记**：使用 \`create_note\` 或 \`update_note\`（优先使用 \`append\` / \`prepend\` / \`replace_section\` 非破坏性更新）。
5. **双向链接与图谱**：调用 \`manage_links_and_graph\` 查看出链/反向链接/未链接提及 (\`UnlinkedMention\`)，并用 \`establish_mention\` 或 \`link_notes\` 建立双链。
6. **思维导图与自由白板**：
   - 调用 \`manage_mindmap\` (\`action: "convert_from_note"\` 或 \`"create"\`) 将笔记大纲或知识树生成为思维导图 (\`MindMapDoc\`)。
   - 调用 \`manage_canvas\` (\`action: "create"\` 或 \`"update"\`) 创建带卡片 (\`CanvasCard\`) 与有向连线 (\`CanvasEdge\`) 的自由白板 (\`CanvasBoard\`)。
7. **今日笔记与模板**：调用 \`manage_templates_and_daily\` (\`action: "open_daily"\`、\`"list_templates"\`、\`"create_from_template"\`、\`"save_note_as_template"\`)。
8. **多步骤任务规划**：3 步以上复杂任务先调用 \`todo_write\` 规划进度，完成后可调用 \`navigate_ui\` 为用户打开生成的文档。`;

const BUILTIN_STUDY_SKILL_MD: string = `---
name: lexinote-study-note
description: 知萤学习笔记与费曼精读构建器。将零散速记、课堂记录或技术主题转化为包含核心导读、章节大纲、==重点高亮==、[!NOTE] 提示框、LaTeX 公式、自测复习题及配套思维导图的结构化学习笔记。
whenToUse: 当用户要求生成学习笔记、复习提纲、课程总结、知识点拆解或将速记整理为结构化教材式笔记时使用。
user-invocable: true
---

# 知萤结构化学习笔记构建指南 (\`lexinote-study-note\`)

1. 创建或整理学习笔记时，将 \`noteType\` 设为 \`"study"\`、\`editorLevel\` 设为 \`"pro"\`。
2. 在正文顶部放置 \`> [!NOTE] 核心导读\` 提示框概括本章要点。
3. 使用 \`##\` / \`###\` 构建清晰章节，核心概念用 \`==高亮==\` 标注，公式用 \`$$...$$\`，代码使用带语言标识的代码块。
4. 调用 \`search_notes\` 检索知识库内已有相关笔记，在文末用 \`[[笔记标题]]\` 建立双向链接，并附上 2~3 道 \`- [ ]\` 费曼自测复习题。
5. 保存笔记后，可调用 \`manage_mindmap\` (\`action: "convert_from_note"\`) 生成配套思维导图。`;

const BUILTIN_GRAPH_SKILL_MD: string = `---
name: lexinote-knowledge-graph
description: 知萤知识图谱织网与卡片盒整理专家。扫描知识库中的孤立笔记与未链接提及 (Unlinked Mentions)，批量建立 [[双向链接]]，合并重复碎片，并生成 MOC (Map of Content) 索引笔记与可视化自由白板。
whenToUse: 当用户要求整理知识库、建立双链、消除孤立笔记、生成目录索引笔记 (MOC) 或构建主题知识白板时使用。
user-invocable: true
---

# 知萤知识图谱与卡片盒整理指南 (\`lexinote-knowledge-graph\`)

1. 调用 \`get_workspace_status\` 与 \`manage_links_and_graph\` (\`action: "inspect"\`) 盘点当前工作区的孤立笔记与未链接提及 (\`UnlinkedMention\`)。
2. 调用 \`manage_links_and_graph\` (\`action: "establish_mention"\` 或 \`"link_notes"\`) 将未链接提及升级为 \`[[双向链接]]\`。
3. 针对同一主题的多篇笔记，调用 \`create_note\` 生成一篇 \`「<主题>」知识索引 (MOC)\` 笔记，按逻辑章节用 \`[[笔记标题]]\` 组织。
4. 调用 \`manage_canvas\` (\`action: "create"\`) 创建主题自由白板，将核心笔记卡片按坐标排布并用有向连线 (\`CanvasEdge\`) 串联。`;

export class LexiHarnessSkills {
  private static bundledNames: string[] = [
    'lexinote-operator',
    'lexinote-study-note',
    'lexinote-knowledge-graph'
  ];

  static parseSkillMarkdown(rawMarkdown: string, fallbackName: string, baseDir: string, rank: number, sourceLabel: string): LexiHarnessSkillDefinition {
    const normalized = rawMarkdown.replace(/\r\n/g, '\n').trim();
    const skill = new LexiHarnessSkillDefinition();
    skill.name = fallbackName;
    skill.baseDir = baseDir;
    skill.sourceRank = rank;
    skill.sourceLabel = sourceLabel;
    skill.content = normalized;

    if (normalized.startsWith('---\n')) {
      const endFence = normalized.indexOf('\n---\n', 4);
      if (endFence > 0) {
        const header = normalized.substring(4, endFence);
        skill.content = normalized.substring(endFence + 5).trim();
        const lines = header.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          const colon = line.indexOf(':');
          if (colon <= 0) { continue; }
          const key = line.substring(0, colon).trim();
          const val = line.substring(colon + 1).trim().replace(/^["']|["']$/g, '');
          if (key === 'name' && val) {
            skill.name = val;
          } else if (key === 'description' && val) {
            skill.description = val;
          } else if ((key === 'whenToUse' || key === 'when-to-use') && val) {
            skill.whenToUse = val;
          } else if (key === 'disable-model-invocation') {
            skill.modelInvocable = val.toLowerCase() !== 'true';
          } else if (key === 'user-invocable') {
            skill.userInvocable = val.toLowerCase() !== 'false';
          }
        }
      }
    }
    if (!skill.description) {
      const firstLine = skill.content.split('\n').find((l: string): boolean => l.trim().length > 0 && !l.trim().startsWith('#')) ?? '';
      skill.description = firstLine.trim().slice(0, 160) || `${skill.name} 技能指令`;
    }
    return skill;
  }

  private static fallbackBundledMarkdown(name: string): string {
    if (name === 'lexinote-operator') { return BUILTIN_OPERATOR_SKILL_MD; }
    if (name === 'lexinote-study-note') { return BUILTIN_STUDY_SKILL_MD; }
    if (name === 'lexinote-knowledge-graph') { return BUILTIN_GRAPH_SKILL_MD; }
    return '';
  }

  static async loadAllSkills(context: common.Context | undefined): Promise<LexiHarnessSkillDefinition[]> {
    const byName: Map<string, LexiHarnessSkillDefinition> = new Map<string, LexiHarnessSkillDefinition>();

    // 1. Load bundled skills (Rank 600)
    for (let i = 0; i < LexiHarnessSkills.bundledNames.length; i++) {
      const skillName = LexiHarnessSkills.bundledNames[i];
      let rawText = '';
      if (context) {
        try {
          const bytes = await context.resourceManager.getRawFileContent(`skills/${skillName}/SKILL.md`);
          rawText = new util.TextDecoder('utf-8').decodeToString(bytes);
        } catch {
          rawText = '';
        }
      }
      if (!rawText.trim()) {
        rawText = LexiHarnessSkills.fallbackBundledMarkdown(skillName);
      }
      if (rawText.trim()) {
        const parsed = LexiHarnessSkills.parseSkillMarkdown(rawText, skillName, `rawfile://skills/${skillName}`, 600, '内置');
        byName.set(parsed.name, parsed);
      }
    }

    // 2. Scan custom user skills in <filesDir>/skills/<name>/SKILL.md (Rank 100 overrides Rank 600)
    if (context) {
      const customRoot = `${context.filesDir}/skills`;
      try {
        if (fs.accessSync(customRoot)) {
          const entries = fs.listFileSync(customRoot);
          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const dirPath = `${customRoot}/${entry}`;
            const skillFile = `${dirPath}/SKILL.md`;
            if (fs.accessSync(skillFile)) {
              const content = fs.readTextSync(skillFile);
              if (content && content.trim().length > 0) {
                const parsed = LexiHarnessSkills.parseSkillMarkdown(content, entry, dirPath, 100, '自定义');
                byName.set(parsed.name, parsed);
              }
            }
          }
        }
      } catch {
        // Ignore custom scan errors
      }
    }

    return Array.from(byName.values());
  }

  static async saveCustomSkill(
    context: common.Context,
    name: string,
    description: string,
    whenToUse: string,
    instructionsBody: string
  ): Promise<LexiHarnessSkillDefinition> {
    const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!cleanName) {
      throw new Error('技能名称需使用小写字母、数字或连字符（如 my-note-skill）');
    }
    const dirPath = `${context.filesDir}/skills/${cleanName}`;
    if (!fs.accessSync(dirPath)) {
      fs.mkdirSync(dirPath, true);
    }
    const filePath = `${dirPath}/SKILL.md`;
    const fullMarkdown = [
      '---',
      `name: ${cleanName}`,
      `description: ${description.trim() || '自定义知萤技能'}`,
      `whenToUse: ${whenToUse.trim() || '当用户点名调用该技能时使用'}`,
      'user-invocable: true',
      '---',
      '',
      instructionsBody.trim()
    ].join('\n');
    const file = fs.openSync(filePath, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(file.fd, fullMarkdown);
      fs.fsyncSync(file.fd);
    } finally {
      fs.closeSync(file);
    }
    return LexiHarnessSkills.parseSkillMarkdown(fullMarkdown, cleanName, dirPath, 100, '自定义');
  }

  static async deleteCustomSkill(context: common.Context, name: string): Promise<void> {
    const skillFile = `${context.filesDir}/skills/${name}/SKILL.md`;
    if (fs.accessSync(skillFile)) {
      fs.unlinkSync(skillFile);
    }
  }

  static catalogDigest(skills: LexiHarnessSkillDefinition[]): string {
    const parts: string[] = [];
    for (let i = 0; i < skills.length; i++) {
      const s = skills[i];
      if (!s.modelInvocable) { continue; }
      parts.push(`${s.name}:${s.description}:${s.whenToUse}`);
    }
    return parts.join('|');
  }

  static formatCatalogBlock(skills: LexiHarnessSkillDefinition[]): string {
    const lines: string[] = [];
    for (let i = 0; i < skills.length; i++) {
      const s = skills[i];
      if (!s.modelInvocable) { continue; }
      const summary = s.whenToUse ? `${s.description} — ${s.whenToUse}` : s.description;
      lines.push(`- \`${s.name}\`: ${summary.slice(0, 500)}`);
    }
    if (lines.length === 0) {
      return '';
    }
    return [
      '<system-reminder>',
      'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
      '',
      '<available_skills>',
      lines.join('\n'),
      '</available_skills>',
      '',
      'If the user names a skill, or the task clearly matches a skill\'s description (especially operating LexiNote / 知萤), call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill\'s instructions until it has been loaded.',
      'A user may also invoke a skill directly with `/skill-name`; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
      '</system-reminder>'
    ].join('\n');
  }

  static formatSkillContentBlock(skill: LexiHarnessSkillDefinition): string {
    const resourcesBlock = skill.baseDir
      ? `<skill_resources>\nBase directory for this skill: ${skill.baseDir}\n</skill_resources>\n\n`
      : '';
    return `<skill_content name="${skill.name}">\n${resourcesBlock}<skill_instructions>\n${skill.content.trim()}\n</skill_instructions>\n</skill_content>`;
  }

  static extractSlashSkills(text: string, skills: LexiHarnessSkillDefinition[]): LexiHarnessSkillDefinition[] {
    const matched: LexiHarnessSkillDefinition[] = [];
    const seen: Set<string> = new Set<string>();
    const regex = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;
    let match: RegExpExecArray | null = regex.exec(text);
    while (match !== null) {
      const name = match[2];
      if (name && !seen.has(name)) {
        const found = skills.find((s: LexiHarnessSkillDefinition): boolean => s.name === name && s.userInvocable);
        if (found) {
          seen.add(name);
          matched.push(found);
        }
      }
      match = regex.exec(text);
    }
    return matched;
  }
}
