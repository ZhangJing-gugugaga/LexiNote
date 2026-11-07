import { common } from '@kit.AbilityKit';
import {
  CanvasBoard,
  CanvasCard,
  CanvasEdge,
  LexiProject,
  MindMapDoc,
  MindMapNode,
  NoteItem,
  NoteLink,
  NoteProperty,
  OutlineHeading,
  UnlinkedMention,
  VaultItem
} from '../core/LexiModels';
import { LexiStorageService } from '../core/LexiStorageService';
import { MarkdownEngine } from '../core/MarkdownEngine';
import { LexiSearch } from '../core/LexiSearch';
import { LexiFrontmatter } from '../core/LexiFrontmatter';
import { LexiCompletion } from '../core/LexiCompletion';
import { LexiTemplateItem } from '../core/LexiTemplateLibrary';
import {
  LexiHarnessSkillDefinition,
  LexiHarnessTodoItem,
  LexiHarnessToolExecutionOutput,
  LexiHarnessToolParamProp
} from './LexiHarnessTypes';
import { LexiHarnessSkills } from './LexiHarnessSkills';

export class LexiHarnessToolSchema {
  name: string = '';
  description: string = '';
  props: LexiHarnessToolParamProp[] = [];
  isConcurrencySafe: boolean = true;

  constructor(name: string, description: string, props: LexiHarnessToolParamProp[], isConcurrencySafe: boolean = true) {
    this.name = name;
    this.description = description;
    this.props = props;
    this.isConcurrencySafe = isConcurrencySafe;
  }
}

export class LexiHarnessUiActionRequest {
  action: string = ''; // 'open-note' | 'open-group' | 'open-map' | 'open-canvas' | 'select-section' | 'set-theme' | 'refresh'
  targetId: string = '';
  sectionIndex: number = 0;
  themeValue: string = '';
}

export class LexiHarnessTools {
  static getToolSchemas(): LexiHarnessToolSchema[] {
    return [
      new LexiHarnessToolSchema(
        'skill',
        '加载指定 Skill 的完整操作指南（如 lexinote-operator、lexinote-study-note、lexinote-knowledge-graph）。操作知萤前建议先加载 lexinote-operator。',
        [
          new LexiHarnessToolParamProp('name', 'string', 'Skill 名称，如 lexinote-operator、lexinote-study-note、lexinote-knowledge-graph', true)
        ],
        true
      ),
      new LexiHarnessToolSchema(
        'get_workspace_status',
        '获取知萤当前工作区状态：包括所有工作区(Vault)、当前项目(Project)、正在编辑的笔记信息、笔记/思维导图/自由白板/双向链接/未链接提及统计，以及最近更新的笔记列表。',
        [],
        true
      ),
      new LexiHarnessToolSchema(
        'search_notes',
        '在知萤当前工作区检索笔记。支持关键词、精确短语、tag:#标签、type:quick|study|markdown、notebook:分类名、[属性名]:属性值、-排除词等高级语法。',
        [
          new LexiHarnessToolParamProp('query', 'string', '搜索查询语句（可为空以列出最近笔记，或使用 tag:#学习 notebook:笔记 等语法）', false),
          new LexiHarnessToolParamProp('favoriteOnly', 'boolean', '是否仅筛选收藏笔记', false),
          new LexiHarnessToolParamProp('pinnedOnly', 'boolean', '是否仅筛选置顶笔记', false),
          new LexiHarnessToolParamProp('limit', 'number', '返回最大条数（默认 15）', false)
        ],
        true
      ),
      new LexiHarnessToolSchema(
        'read_note',
        '读取指定笔记的完整 Markdown 正文、YAML Frontmatter 属性、标签、章节大纲、出链与反向链接。可通过 noteId 或笔记标题 title 查找。',
        [
          new LexiHarnessToolParamProp('noteId', 'string', '笔记 ID（若已知）', false),
          new LexiHarnessToolParamProp('title', 'string', '笔记标题（支持按标题匹配）', false)
        ],
        true
      ),
      new LexiHarnessToolSchema(
        'edit_active_note',
        '直接读取或修改用户当前在编辑器中打开的笔记，并在界面上实时刷新。',
        [
          new LexiHarnessToolParamProp('action', 'string', '操作类型：read | append | prepend | replace | replace_text | add_tags | set_property', true,
            ['read', 'append', 'prepend', 'replace', 'replace_text', 'add_tags', 'set_property']),
          new LexiHarnessToolParamProp('content', 'string', '用于 append/prepend/replace 的 Markdown 内容', false),
          new LexiHarnessToolParamProp('oldText', 'string', 'replace_text 模式下要被替换的原文本片段', false),
          new LexiHarnessToolParamProp('newText', 'string', 'replace_text 模式下替换后的新文本片段', false),
          new LexiHarnessToolParamProp('newTitle', 'string', '可选：更新当前笔记标题', false),
          new LexiHarnessToolParamProp('notebook', 'string', '可选：更新所属笔记本分类', false),
          new LexiHarnessToolParamProp('tags', 'string', '逗号分隔的标签列表，如 学习/鸿蒙,重点', false),
          new LexiHarnessToolParamProp('propKey', 'string', 'set_property 模式下的属性键名', false),
          new LexiHarnessToolParamProp('propValue', 'string', 'set_property 模式下的属性值', false)
        ],
        false
      ),
      new LexiHarnessToolSchema(
        'create_note',
        '在知萤中创建一篇新 Markdown 笔记，支持设置标题、正文、所属笔记本、笔记类型(quick|study|markdown)、编辑层级(simple|study|pro)、标签、Frontmatter 属性、置顶与收藏，并可选择立即打开。',
        [
          new LexiHarnessToolParamProp('title', 'string', '笔记标题', true),
          new LexiHarnessToolParamProp('content', 'string', 'Markdown 正文内容（支持 [[双链]]、#标签、==高亮==、> [!NOTE]、$$公式$$、- [ ] 待办）', true),
          new LexiHarnessToolParamProp('notebook', 'string', '所属笔记本分类（如 速记收件箱、日常记录 / 日记、学习笔记、技术文档）', false),
          new LexiHarnessToolParamProp('noteType', 'string', '笔记类型：quick | study | markdown', false, ['quick', 'study', 'markdown']),
          new LexiHarnessToolParamProp('editorLevel', 'string', '编辑器层级：simple | study | pro', false, ['simple', 'study', 'pro']),
          new LexiHarnessToolParamProp('tags', 'string', '逗号分隔的标签，如 学习/算法,复习', false),
          new LexiHarnessToolParamProp('propertiesJson', 'string', 'JSON 格式的键值对属性，如 {"status":"进行中","source":"课程"}', false),
          new LexiHarnessToolParamProp('pinned', 'boolean', '是否置顶', false),
          new LexiHarnessToolParamProp('favorite', 'boolean', '是否收藏', false),
          new LexiHarnessToolParamProp('openAfterCreate', 'boolean', '创建后是否在编辑器中打开（默认 true）', false)
        ],
        false
      ),
      new LexiHarnessToolSchema(
        'update_note',
        '更新知萤中已有的笔记（通过 noteId 或 title 定位）。支持 append（末尾追加）、prepend（开头插入）、replace_section（按章节标题替换）、replace_text（局部替换）或 replace（全文替换），以及修改标题、笔记本、标签、属性、置顶和收藏。',
        [
          new LexiHarnessToolParamProp('noteId', 'string', '目标笔记 ID', false),
          new LexiHarnessToolParamProp('title', 'string', '目标笔记当前标题（当未提供 noteId 时用于查找）', false),
          new LexiHarnessToolParamProp('mode', 'string', '内容更新模式：append | prepend | replace_section | replace_text | replace | metadata_only', true,
            ['append', 'prepend', 'replace_section', 'replace_text', 'replace', 'metadata_only']),
          new LexiHarnessToolParamProp('content', 'string', '要追加、插入或替换的 Markdown 内容', false),
          new LexiHarnessToolParamProp('sectionHeading', 'string', 'replace_section 模式下的目标章节标题（不含 # 号）', false),
          new LexiHarnessToolParamProp('oldText', 'string', 'replace_text 模式下要替换的原文本', false),
          new LexiHarnessToolParamProp('newText', 'string', 'replace_text 模式下替换后的新文本', false),
          new LexiHarnessToolParamProp('newTitle', 'string', '可选：重命名笔记的新标题（会自动修复全库 [[双链]] 引用）', false),
          new LexiHarnessToolParamProp('notebook', 'string', '可选：修改所属笔记本分类', false),
          new LexiHarnessToolParamProp('tags', 'string', '可选：逗号分隔的标签列表（追加合并）', false),
          new LexiHarnessToolParamProp('propertiesJson', 'string', '可选：JSON 格式的 Frontmatter 属性键值对', false),
          new LexiHarnessToolParamProp('pinned', 'boolean', '可选：设置是否置顶', false),
          new LexiHarnessToolParamProp('favorite', 'boolean', '可选：设置是否收藏', false),
          new LexiHarnessToolParamProp('openAfterUpdate', 'boolean', '更新后是否在界面中打开该笔记', false)
        ],
        false
      ),
      new LexiHarnessToolSchema(
        'delete_or_restore_note',
        '管理笔记生命周期：移入回收站(trash)、从回收站恢复(restore)、列出回收站(list_trash)、复制笔记副本(duplicate)或将一篇笔记合并到另一篇笔记(merge)。',
        [
          new LexiHarnessToolParamProp('action', 'string', '操作类型：trash | restore | list_trash | duplicate | merge', true,
            ['trash', 'restore', 'list_trash', 'duplicate', 'merge']),
          new LexiHarnessToolParamProp('noteId', 'string', '目标笔记 ID（或合并时的源笔记 ID）', false),
          new LexiHarnessToolParamProp('title', 'string', '目标笔记标题（未提供 noteId 时匹配）', false),
          new LexiHarnessToolParamProp('targetNoteId', 'string', 'merge 模式下合并到的目标笔记 ID 或标题', false)
        ],
        false
      ),
      new LexiHarnessToolSchema(
        'manage_links_and_graph',
        '管理知萤双向链接与知识图谱：查看全库链接与未链接提及(inspect)、一键将未链接提及转化为双向链接(establish_mention)、建立全部未链接提及(establish_all_mentions)或在两篇笔记间建立 [[双向链接]](link_notes)。',
        [
          new LexiHarnessToolParamProp('action', 'string', '操作类型：inspect | establish_mention | establish_all_mentions | link_notes', true,
            ['inspect', 'establish_mention', 'establish_all_mentions', 'link_notes']),
          new LexiHarnessToolParamProp('sourceNote', 'string', '源笔记 ID 或标题', false),
          new LexiHarnessToolParamProp('targetNote', 'string', '目标笔记 ID 或标题', false),
          new LexiHarnessToolParamProp('anchor', 'string', '可选：链接到的章节锚点标题', false),
          new LexiHarnessToolParamProp('alias', 'string', '可选：[[目标#章节|显示别名]] 中的显示别名', false),
          new LexiHarnessToolParamProp('contextSentence', 'string', '可选：link_notes 时附带的关联说明文字', false)
        ],
        false
      ),
      new LexiHarnessToolSchema(
        'manage_mindmap',
        '管理知萤思维导图(MindMapDoc)：列出导图(list)、读取导图结构与大纲(read)、将指定笔记标题树转换为思维导图(convert_from_note)、新建或更新思维导图(create | update)、将导图导出为笔记(export_to_note)。',
        [
          new LexiHarnessToolParamProp('action', 'string', '操作类型：list | read | convert_from_note | create | update | export_to_note', true,
            ['list', 'read', 'convert_from_note', 'create', 'update', 'export_to_note']),
          new LexiHarnessToolParamProp('mapId', 'string', '思维导图 ID（read/update/export_to_note 时使用）', false),
          new LexiHarnessToolParamProp('title', 'string', '思维导图标题', false),
          new LexiHarnessToolParamProp('fromNote', 'string', 'convert_from_note 时的源笔记 ID 或标题', false),
          new LexiHarnessToolParamProp('layoutKind', 'string', '导图布局：right（右向树）| balanced（左右平衡）| org（向下组织图）', false,
            ['right', 'balanced', 'org']),
          new LexiHarnessToolParamProp('nodesJson', 'string', 'JSON 数组表示的节点列表，每个节点支持 {"id":"node-1","parentId":"root","text":"节点文本","note":"备注","colorTag":"purple|indigo|teal|amber|rose","noteRefTitle":"关联笔记标题"}', false),
          new LexiHarnessToolParamProp('markdownOutline', 'string', '可选：用 Markdown 标题(#/##/###)或缩进列表(- )快速生成导图节点树', false),
          new LexiHarnessToolParamProp('openAfterSave', 'boolean', '保存后是否立即打开该思维导图（默认 true）', false)
        ],
        false
      ),
      new LexiHarnessToolSchema(
        'manage_canvas',
        '管理知萤自由白板(CanvasBoard)：列出白板(list)、读取白板卡片与连线(read)、创建或更新自由白板(create | update)。',
        [
          new LexiHarnessToolParamProp('action', 'string', '操作类型：list | read | create | update', true,
            ['list', 'read', 'create', 'update']),
          new LexiHarnessToolParamProp('canvasId', 'string', '白板 ID（read/update 时使用）', false),
          new LexiHarnessToolParamProp('title', 'string', '白板标题', false),
          new LexiHarnessToolParamProp('cardsJson', 'string', 'JSON 数组表示的白板卡片：[{"id":"card-1","title":"卡片标题","content":"摘要","x":80,"y":80,"colorTag":"purple|indigo|teal|amber|rose","noteRefTitle":"可选关联笔记标题"}]', false),
          new LexiHarnessToolParamProp('edgesJson', 'string', 'JSON 数组表示的有向连线：[{"id":"edge-1","fromId":"card-1","toId":"card-2","label":"关系说明"}]', false),
          new LexiHarnessToolParamProp('openAfterSave', 'boolean', '保存后是否立即打开该自由白板（默认 true）', false)
        ],
        false
      ),
      new LexiHarnessToolSchema(
        'manage_templates_and_daily',
        '操作知萤「今日笔记」与「模板库」：打开或创建今日日记(open_daily)、列出所有模板(list_templates)、使用模板创建笔记(create_from_template)、将笔记保存为模板(save_note_as_template)。',
        [
          new LexiHarnessToolParamProp('action', 'string', '操作类型：open_daily | list_templates | create_from_template | save_note_as_template', true,
            ['open_daily', 'list_templates', 'create_from_template', 'save_note_as_template']),
          new LexiHarnessToolParamProp('templateId', 'string', '模板 ID 或模板名称（create_from_template 时使用）', false),
          new LexiHarnessToolParamProp('noteTitle', 'string', '从模板新建笔记时的标题，或 save_note_as_template 时的源笔记标题/ID', false),
          new LexiHarnessToolParamProp('dailyAppendContent', 'string', '可选：open_daily 时直接追加到今日笔记中的待办或记录内容', false)
        ],
        false
      ),
      new LexiHarnessToolSchema(
        'navigate_ui',
        '控制知萤界面导航与视图切换：在主编辑器打开笔记(open_note)、在桌面端右侧分屏打开笔记(open_note_split)、打开导图(open_mindmap)、打开白板(open_canvas)、切换主栏目(switch_section: home|vault|explore|settings)、切换工作区(switch_vault)或切换主题外观(set_theme: light|dark|system)。',
        [
          new LexiHarnessToolParamProp('action', 'string', '导航动作：open_note | open_note_split | open_mindmap | open_canvas | switch_section | switch_vault | set_theme', true,
            ['open_note', 'open_note_split', 'open_mindmap', 'open_canvas', 'switch_section', 'switch_vault', 'set_theme']),
          new LexiHarnessToolParamProp('target', 'string', '目标 ID、标题、栏目名(home|vault|explore|settings)或主题名(light|dark|system)', true)
        ],
        false
      ),
      new LexiHarnessToolSchema(
        'todo_write',
        '更新智能体当前会话的多步骤任务进度清单（模仿 deepseek-harness 的 todo_write 工具），在 UI 面板展示实时执行进度。',
        [
          new LexiHarnessToolParamProp('todosJson', 'string', 'JSON 数组，格式为 [{"id":"1","content":"步骤描述","status":"pending|in_progress|completed"}]', true)
        ],
        false
      )
    ];
  }

  private static strArg(args: Record<string, Object>, key: string, fallback: string = ''): string {
    const val = args[key];
    if (val === undefined || val === null) { return fallback; }
    if (typeof val === 'string') { return val; }
    if (typeof val === 'number' || typeof val === 'boolean') { return `${val}`; }
    try { return JSON.stringify(val); } catch { return fallback; }
  }

  private static boolArg(args: Record<string, Object>, key: string, fallback: boolean = false): boolean {
    const val = args[key];
    if (val === undefined || val === null) { return fallback; }
    if (typeof val === 'boolean') { return val; }
    if (typeof val === 'string') {
      const lower = val.trim().toLowerCase();
      if (lower === 'true' || lower === '1') { return true; }
      if (lower === 'false' || lower === '0') { return false; }
    }
    return fallback;
  }

  private static numArg(args: Record<string, Object>, key: string, fallback: number = 0): number {
    const val = args[key];
    if (val === undefined || val === null) { return fallback; }
    if (typeof val === 'number' && Number.isFinite(val)) { return val; }
    if (typeof val === 'string') {
      const parsed = Number(val);
      if (Number.isFinite(parsed)) { return parsed; }
    }
    return fallback;
  }

  static parseArgsObject(argsJson: string): Record<string, Object> {
    if (!argsJson || !argsJson.trim()) {
      return {};
    }
    try {
      const parsed = JSON.parse(argsJson) as Record<string, Object>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Fallback empty object
    }
    return {};
  }

  static presentCallSummary(toolName: string, argsJson: string): string[] {
    const args = LexiHarnessTools.parseArgsObject(argsJson);
    if (toolName === 'skill') {
      const name = LexiHarnessTools.strArg(args, 'name', 'lexinote-operator');
      return [`加载技能 · ${name}`, '读取 SKILL.md 操作指南'];
    }
    if (toolName === 'get_workspace_status') {
      return ['盘点知萤工作区状态', '读取笔记、导图、白板与链接统计'];
    }
    if (toolName === 'search_notes') {
      const q = LexiHarnessTools.strArg(args, 'query', '');
      return ['检索知识库笔记', q ? `查询: ${q}` : '列出最近更新的笔记'];
    }
    if (toolName === 'read_note') {
      const target = LexiHarnessTools.strArg(args, 'title') || LexiHarnessTools.strArg(args, 'noteId');
      return ['读取笔记详情', target ? `《${target}》` : '读取正文与大纲'];
    }
    if (toolName === 'edit_active_note') {
      const action = LexiHarnessTools.strArg(args, 'action', 'read');
      return [`操作当前打开的笔记 (${action})`, '同步编辑器内容与元数据'];
    }
    if (toolName === 'create_note') {
      const title = LexiHarnessTools.strArg(args, 'title', '新笔记');
      const nb = LexiHarnessTools.strArg(args, 'notebook', '笔记');
      return [`创建新笔记《${title}》`, `笔记本: ${nb}`];
    }
    if (toolName === 'update_note') {
      const target = LexiHarnessTools.strArg(args, 'newTitle') || LexiHarnessTools.strArg(args, 'title') || LexiHarnessTools.strArg(args, 'noteId');
      const mode = LexiHarnessTools.strArg(args, 'mode', 'append');
      return [`更新笔记《${target}》`, `模式: ${mode}`];
    }
    if (toolName === 'delete_or_restore_note') {
      const action = LexiHarnessTools.strArg(args, 'action', 'trash');
      const target = LexiHarnessTools.strArg(args, 'title') || LexiHarnessTools.strArg(args, 'noteId');
      return [`笔记管理 (${action})`, target];
    }
    if (toolName === 'manage_links_and_graph') {
      const action = LexiHarnessTools.strArg(args, 'action', 'inspect');
      return [`知识图谱与双向链接 (${action})`, '分析并建立 [[Wiki Links]]'];
    }
    if (toolName === 'manage_mindmap') {
      const action = LexiHarnessTools.strArg(args, 'action', 'list');
      const title = LexiHarnessTools.strArg(args, 'title') || LexiHarnessTools.strArg(args, 'fromNote');
      return [`思维导图操作 (${action})`, title || '知萤可视化导图'];
    }
    if (toolName === 'manage_canvas') {
      const action = LexiHarnessTools.strArg(args, 'action', 'list');
      const title = LexiHarnessTools.strArg(args, 'title');
      return [`自由白板操作 (${action})`, title || '知萤卡片白板'];
    }
    if (toolName === 'manage_templates_and_daily') {
      const action = LexiHarnessTools.strArg(args, 'action', 'open_daily');
      return [`今日笔记与模板 (${action})`, '调用模板库与日记系统'];
    }
    if (toolName === 'navigate_ui') {
      const action = LexiHarnessTools.strArg(args, 'action');
      const target = LexiHarnessTools.strArg(args, 'target');
      return [`界面跳转 (${action})`, target];
    }
    if (toolName === 'todo_write') {
      return ['更新任务进度清单', '规划多步骤执行状态'];
    }
    return [toolName, '执行知萤工具'];
  }

  private static async findNoteByIdOrTitle(vaultId: string, noteId: string, title: string): Promise<NoteItem | undefined> {
    if (noteId.trim()) {
      const byId = await LexiStorageService.getNoteById(noteId.trim());
      if (byId && byId.trashedAt === 0) {
        return byId;
      }
    }
    const cleanTitle = title.trim() || noteId.trim();
    if (!cleanTitle) {
      return undefined;
    }
    const notes = (await LexiStorageService.getNotes(vaultId)).filter((n: NoteItem): boolean => n.trashedAt === 0);
    const exact = notes.find((n: NoteItem): boolean =>
      n.id === cleanTitle ||
      n.title.trim().toLowerCase() === cleanTitle.toLowerCase() ||
      MarkdownEngine.displayTitle(n).toLowerCase() === cleanTitle.toLowerCase()
    );
    if (exact) {
      return exact;
    }
    return notes.find((n: NoteItem): boolean =>
      MarkdownEngine.displayTitle(n).toLowerCase().includes(cleanTitle.toLowerCase())
    );
  }

  private static notifyWorkspaceUpdated(): void {
    const current = AppStorage.get<number>('lexiWorkspaceRevision') ?? 0;
    AppStorage.setOrCreate('lexiWorkspaceRevision', current + 1);
  }

  private static parseTagsList(rawTags: string, existing: string[] = []): string[] {
    const merged: string[] = existing.slice();
    if (!rawTags.trim()) { return merged; }
    const parts = rawTags.split(/[,，\s]+/);
    for (let i = 0; i < parts.length; i++) {
      const clean = parts[i].trim().replace(/^#/, '');
      if (clean && !merged.includes(clean)) {
        merged.push(clean);
      }
    }
    return merged;
  }

  private static applyPropertiesJson(rawJson: string, existing: NoteProperty[] = []): NoteProperty[] {
    const result: NoteProperty[] = existing.map((p: NoteProperty): NoteProperty => new NoteProperty(p.key, p.propValue));
    if (!rawJson.trim()) { return result; }
    try {
      const parsed = JSON.parse(rawJson) as Record<string, Object>;
      const keys = Object.keys(parsed);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i].trim();
        if (!k) { continue; }
        const v = `${parsed[k] ?? ''}`.trim();
        const idx = result.findIndex((p: NoteProperty): boolean => p.key === k);
        if (idx >= 0) {
          result[idx].propValue = v;
        } else {
          result.push(new NoteProperty(k, v));
        }
      }
    } catch {
      // Ignore malformed propertiesJson
    }
    return result;
  }

  private static replaceSectionInMarkdown(markdown: string, sectionHeading: string, newSectionBody: string): string {
    const headings = MarkdownEngine.extractOutline(markdown);
    const targetNorm = sectionHeading.trim().replace(/^#+\s*/, '').toLowerCase();
    const matched = headings.find((h: OutlineHeading): boolean => h.title.trim().toLowerCase() === targetNorm ||
      h.title.trim().toLowerCase().includes(targetNorm));
    if (!matched) {
      return `${markdown.trimEnd()}\n\n## ${sectionHeading.trim().replace(/^#+\s*/, '')}\n\n${newSectionBody.trim()}\n`;
    }
    const nextHeading = headings.find((h: OutlineHeading): boolean => h.lineIndex > matched.lineIndex && h.level <= matched.level);
    const lines = markdown.split('\n');
    const prefix = lines.slice(0, matched.lineIndex + 1).join('\n');
    const suffix = nextHeading ? '\n' + lines.slice(nextHeading.lineIndex).join('\n') : '';
    return `${prefix}\n\n${newSectionBody.trim()}\n${suffix}`;
  }

  static async executeTool(
    context: common.UIAbilityContext,
    toolName: string,
    argsJson: string,
    skills: LexiHarnessSkillDefinition[],
    activeEditorNoteId: string,
    onTodosUpdated: (todos: LexiHarnessTodoItem[]) => void,
    onUiAction: (req: LexiHarnessUiActionRequest) => void
  ): Promise<LexiHarnessToolExecutionOutput> {
    const out = new LexiHarnessToolExecutionOutput();
    const summary = LexiHarnessTools.presentCallSummary(toolName, argsJson);
    out.title = summary[0];
    out.subtitle = summary[1];
    const args = LexiHarnessTools.parseArgsObject(argsJson);

    try {
      await LexiStorageService.init(context);
      const vaultId = await LexiStorageService.getActiveVaultId();
      const projectId = await LexiStorageService.getActiveProjectId(vaultId);

      // 1. skill
      if (toolName === 'skill') {
        const rawName = LexiHarnessTools.strArg(args, 'name', 'lexinote-operator').trim().replace(/^\//, '');
        const found = skills.find((s: LexiHarnessSkillDefinition): boolean => s.name === rawName);
        if (!found) {
          const available = skills.map((s: LexiHarnessSkillDefinition): string => s.name).join(', ');
          out.isError = true;
          out.contentText = `未找到名为 "${rawName}" 的 Skill。当前可用 Skills: ${available}`;
          out.preview = out.contentText;
          return out;
        }
        out.title = `已加载技能 · ${found.name}`;
        out.subtitle = found.description;
        out.contentText = LexiHarnessSkills.formatSkillContentBlock(found);
        out.preview = `已加载 <skill_content name="${found.name}"> (${found.content.length} 字符)`;
        return out;
      }

      // 2. get_workspace_status
      if (toolName === 'get_workspace_status') {
        const vaults = await LexiStorageService.getVaults();
        const projects = await LexiStorageService.getProjects(vaultId);
        const allNotes = await LexiStorageService.getNotes(vaultId);
        const activeNotes = allNotes.filter((n: NoteItem): boolean => n.trashedAt === 0);
        const trashedNotes = allNotes.filter((n: NoteItem): boolean => n.trashedAt > 0);
        const maps = (await LexiStorageService.getMindMaps(vaultId)).filter((m: MindMapDoc): boolean => m.trashedAt === 0);
        const canvases = await LexiStorageService.getCanvases(vaultId);
        const links = MarkdownEngine.buildNoteLinks(activeNotes);
        const mentions = MarkdownEngine.findUnlinkedMentions(activeNotes, links);
        const activeVault = vaults.find((v: VaultItem): boolean => v.id === vaultId);
        const activeProject = projects.find((p: LexiProject): boolean => p.id === projectId);
        const openNoteId = activeEditorNoteId || await LexiStorageService.getSetting('lastEditedNoteId', '');
        const openNote = openNoteId ? activeNotes.find((n: NoteItem): boolean => n.id === openNoteId) : undefined;

        const notebooks: Set<string> = new Set<string>();
        const tagCounts: Map<string, number> = new Map<string, number>();
        for (let i = 0; i < activeNotes.length; i++) {
          const n = activeNotes[i];
          if (n.notebook) { notebooks.add(n.notebook); }
          for (let t = 0; t < n.tags.length; t++) {
            const tag = n.tags[t];
            tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
          }
        }

        const recentLines = activeNotes.slice(0, 8).map((n: NoteItem): string =>
          `- [${n.id}] 《${MarkdownEngine.displayTitle(n)}》 (笔记本: ${n.notebook}, 类型: ${n.noteType}, 标签: ${n.tags.map((t: string): string => '#' + t).join(' ') || '无'})`
        );

        const lines: string[] = [
          `# 知萤 (LexiNote) 当前工作区状态`,
          `- 当前工作区: ${activeVault ? activeVault.name : '个人知识库'} (ID: ${vaultId})`,
          `- 全部工作区(${vaults.length}): ${vaults.map((v: VaultItem): string => `${v.name}(${v.id})`).join(', ')}`,
          `- 当前项目文件夹: ${activeProject ? activeProject.name : '全部项目'} ${projects.length > 0 ? `(共 ${projects.length} 个项目: ${projects.map((p: LexiProject): string => p.name).join(', ')})` : ''}`,
          `- 统计指标: 有效笔记 ${activeNotes.length} 篇 | 回收站 ${trashedNotes.length} 篇 | 思维导图 ${maps.length} 幅 | 自由白板 ${canvases.length} 块 | 双向链接 ${links.length} 条 | 未链接提及 ${mentions.length} 处`,
          `- 笔记本分类: ${Array.from(notebooks).join('、') || '默认'}`,
          `- 常用标签: ${Array.from(tagCounts.entries()).slice(0, 12).map((entry: [string, number]): string => `#${entry[0]}(${entry[1]})`).join(' ') || '暂无'}`,
          openNote
            ? `- 当前打开/最近编辑笔记: 《${MarkdownEngine.displayTitle(openNote)}》 (ID: ${openNote.id}, 笔记本: ${openNote.notebook}, 字数: ${openNote.content.length})`
            : `- 当前打开笔记: 暂无`,
          ``,
          `## 最近更新的笔记 (Top ${recentLines.length})`,
          recentLines.join('\n') || '暂无笔记'
        ];
        out.contentText = lines.join('\n');
        out.preview = `工作区「${activeVault ? activeVault.name : '个人知识库'}」: ${activeNotes.length} 篇笔记, ${maps.length} 幅导图, ${canvases.length} 块白板`;
        return out;
      }

      // 3. search_notes
      if (toolName === 'search_notes') {
        const query = LexiHarnessTools.strArg(args, 'query', '').trim();
        const favoriteOnly = LexiHarnessTools.boolArg(args, 'favoriteOnly', false);
        const pinnedOnly = LexiHarnessTools.boolArg(args, 'pinnedOnly', false);
        const limit = Math.max(1, Math.min(50, LexiHarnessTools.numArg(args, 'limit', 15)));
        const activeNotes = (await LexiStorageService.getNotes(vaultId)).filter((n: NoteItem): boolean => n.trashedAt === 0);
        const matched = activeNotes.filter((n: NoteItem): boolean => {
          if (favoriteOnly && !n.favorite) { return false; }
          if (pinnedOnly && !n.pinned) { return false; }
          if (!query) { return true; }
          return LexiSearch.matches(n, query);
        }).slice(0, limit);

        if (matched.length === 0) {
          out.contentText = `未找到匹配查询 "${query}" 的笔记（当前工作区共 ${activeNotes.length} 篇有效笔记）。`;
          out.preview = `0 篇匹配结果`;
          return out;
        }
        const rows = matched.map((n: NoteItem, idx: number): string => {
          const title = MarkdownEngine.displayTitle(n);
          const snippet = MarkdownEngine.extractSnippet(n, query);
          const tags = n.tags.map((t: string): string => `#${t}`).join(' ');
          const props = n.properties.map((p: NoteProperty): string => `${p.key}=${p.propValue}`).join(', ');
          return `${idx + 1}. 《${title}》 (ID: \`${n.id}\`)\n   - 笔记本: ${n.notebook} | 类型: ${n.noteType}/${n.editorLevel} ${n.pinned ? '📌置顶 ' : ''}${n.favorite ? '⭐收藏' : ''}\n   - 标签: ${tags || '无'} ${props ? `| 属性: ${props}` : ''}\n   - 摘要: ${snippet}`;
        });
        out.contentText = `共找到 ${matched.length} 篇匹配笔记：\n\n${rows.join('\n\n')}`;
        out.preview = `找到 ${matched.length} 篇笔记：${matched.slice(0, 3).map((n: NoteItem): string => `《${MarkdownEngine.displayTitle(n)}》`).join('、')}`;
        return out;
      }

      // 4. read_note
      if (toolName === 'read_note') {
        const noteId = LexiHarnessTools.strArg(args, 'noteId', '');
        const title = LexiHarnessTools.strArg(args, 'title', '');
        const target = await LexiHarnessTools.findNoteByIdOrTitle(vaultId, noteId, title);
        if (!target) {
          out.isError = true;
          out.contentText = `未找到指定的笔记（noteId="${noteId}", title="${title}"）。请先使用 search_notes 查看可用笔记。`;
          out.preview = out.contentText;
          return out;
        }
        const allNotes = (await LexiStorageService.getNotes(vaultId)).filter((n: NoteItem): boolean => n.trashedAt === 0);
        const links = MarkdownEngine.buildNoteLinks(allNotes);
        const outgoing = links.filter((l: NoteLink): boolean => l.sourceId === target.id);
        const backlinks = links.filter((l: NoteLink): boolean => l.targetId === target.id);
        const headings = MarkdownEngine.extractOutline(target.content);
        const propsStr = target.properties.map((p: NoteProperty): string => `${p.key}: ${p.propValue}`).join(', ');

        const detail: string[] = [
          `# 笔记详情：《${MarkdownEngine.displayTitle(target)}》`,
          `- ID: \`${target.id}\``,
          `- 所属笔记本: ${target.notebook}`,
          `- 类型与层级: noteType=${target.noteType}, editorLevel=${target.editorLevel}`,
          `- 状态: ${target.pinned ? '已置顶' : '未置顶'} | ${target.favorite ? '已收藏' : '未收藏'}`,
          `- 标签: ${target.tags.map((t: string): string => '#' + t).join(' ') || '无'}`,
          `- Frontmatter 属性: ${propsStr || '无'}`,
          `- 文档大纲 (${headings.length}): ${headings.map((h: OutlineHeading): string => `${'#'.repeat(h.level)} ${h.title}`).join(' | ') || '无标题大纲'}`,
          `- 出链 (${outgoing.length}): ${outgoing.map((l: NoteLink): string => `[[${l.targetTitle}${l.anchor ? '#' + l.anchor : ''}]]`).join(', ') || '无'}`,
          `- 反向链接 (${backlinks.length}): ${backlinks.map((l: NoteLink): string => `[[${l.sourceTitle}]]`).join(', ') || '无'}`,
          ``,
          `## 完整 Markdown 内容`,
          target.content
        ];
        out.title = `读取笔记《${MarkdownEngine.displayTitle(target)}》`;
        out.subtitle = `${target.content.length} 字符 · ${headings.length} 个章节`;
        out.contentText = detail.join('\n');
        out.preview = `《${MarkdownEngine.displayTitle(target)}》(${target.content.length} 字, ${outgoing.length} 出链, ${backlinks.length} 反链)`;
        return out;
      }

      // 5. edit_active_note
      if (toolName === 'edit_active_note') {
        const action = LexiHarnessTools.strArg(args, 'action', 'read');
        const targetId = activeEditorNoteId || await LexiStorageService.getSetting('lastEditedNoteId', '');
        let activeNote = targetId ? await LexiStorageService.getNoteById(targetId) : undefined;
        if (!activeNote || activeNote.trashedAt > 0) {
          const allActive = (await LexiStorageService.getNotes(vaultId)).filter((n: NoteItem): boolean => n.trashedAt === 0);
          activeNote = allActive.length > 0 ? allActive[0] : undefined;
        }
        if (!activeNote) {
          out.isError = true;
          out.contentText = '当前没有打开或可用的笔记。你可以使用 create_note 创建一篇新笔记。';
          out.preview = out.contentText;
          return out;
        }
        if (action === 'read') {
          const headings = MarkdownEngine.extractOutline(activeNote.content);
          out.title = `读取当前笔记《${MarkdownEngine.displayTitle(activeNote)}》`;
          out.contentText = [
            `# 当前打开笔记：《${MarkdownEngine.displayTitle(activeNote)}》 (ID: \`${activeNote.id}\`)`,
            `- 笔记本: ${activeNote.notebook} | 类型: ${activeNote.noteType}/${activeNote.editorLevel}`,
            `- 标签: ${activeNote.tags.map((t: string): string => '#' + t).join(' ') || '无'}`,
            `- 属性: ${activeNote.properties.map((p: NoteProperty): string => `${p.key}=${p.propValue}`).join(', ') || '无'}`,
            `- 大纲: ${headings.map((h: OutlineHeading): string => h.title).join(' / ') || '无'}`,
            ``,
            activeNote.content
          ].join('\n');
          out.preview = `已读取当前笔记《${MarkdownEngine.displayTitle(activeNote)}》(${activeNote.content.length} 字)`;
          return out;
        }

        const draft = JSON.parse(JSON.stringify(activeNote)) as NoteItem;
        const parsed = LexiFrontmatter.parse(draft.content);
        let body = parsed.body;
        const contentArg = LexiHarnessTools.strArg(args, 'content', '');
        const newTitle = LexiHarnessTools.strArg(args, 'newTitle', '').trim();
        const notebook = LexiHarnessTools.strArg(args, 'notebook', '').trim();
        const rawTags = LexiHarnessTools.strArg(args, 'tags', '').trim();

        if (newTitle) { draft.title = newTitle; }
        if (notebook) { draft.notebook = notebook; }
        if (rawTags) { draft.tags = LexiHarnessTools.parseTagsList(rawTags, draft.tags); }

        if (action === 'append') {
          body = `${body.trimEnd()}\n\n${contentArg.trim()}\n`;
        } else if (action === 'prepend') {
          body = `${contentArg.trim()}\n\n${body.trimStart()}`;
        } else if (action === 'replace') {
          body = contentArg;
        } else if (action === 'replace_text') {
          const oldText = LexiHarnessTools.strArg(args, 'oldText', '');
          const newText = LexiHarnessTools.strArg(args, 'newText', '');
          if (!oldText || !body.includes(oldText)) {
            out.isError = true;
            out.contentText = `在当前笔记《${MarkdownEngine.displayTitle(activeNote)}》中未找到要替换的原文本片段。`;
            out.preview = out.contentText;
            return out;
          }
          body = body.replace(oldText, newText);
        } else if (action === 'add_tags') {
          draft.tags = LexiHarnessTools.parseTagsList(rawTags || contentArg, draft.tags);
          draft.editorLevel = 'pro';
        } else if (action === 'set_property') {
          const propKey = LexiHarnessTools.strArg(args, 'propKey', '').trim();
          const propVal = LexiHarnessTools.strArg(args, 'propValue', '').trim();
          if (propKey) {
            const idx = draft.properties.findIndex((p: NoteProperty): boolean => p.key === propKey);
            if (idx >= 0) { draft.properties[idx].propValue = propVal; }
            else { draft.properties.push(new NoteProperty(propKey, propVal)); }
            draft.editorLevel = 'pro';
          }
        }

        draft.content = body;
        draft.content = LexiFrontmatter.serialize(draft);
        const saved = await LexiStorageService.saveNote(context, draft);
        LexiHarnessTools.notifyWorkspaceUpdated();
        out.openedNoteId = saved.id;
        out.title = `已更新当前笔记《${MarkdownEngine.displayTitle(saved)}》`;
        out.subtitle = `动作: ${action}`;
        out.contentText = `已成功更新当前打开的笔记《${MarkdownEngine.displayTitle(saved)}》(ID: ${saved.id})，编辑器已实时同步刷新。`;
        out.preview = `《${MarkdownEngine.displayTitle(saved)}》已实时更新 (${saved.content.length} 字)`;
        return out;
      }

      // 6. create_note
      if (toolName === 'create_note') {
        const title = LexiHarnessTools.strArg(args, 'title', '未命名笔记').trim();
        const content = LexiHarnessTools.strArg(args, 'content', '');
        const notebook = LexiHarnessTools.strArg(args, 'notebook', '笔记').trim() || '笔记';
        const noteType = LexiHarnessTools.strArg(args, 'noteType', 'markdown').trim();
        const editorLevel = LexiHarnessTools.strArg(args, 'editorLevel', noteType === 'markdown' ? 'pro' : noteType === 'study' ? 'study' : 'simple');
        const rawTags = LexiHarnessTools.strArg(args, 'tags', '');
        const propsJson = LexiHarnessTools.strArg(args, 'propertiesJson', '');
        const pinned = LexiHarnessTools.boolArg(args, 'pinned', false);
        const favorite = LexiHarnessTools.boolArg(args, 'favorite', false);
        const openAfterCreate = LexiHarnessTools.boolArg(args, 'openAfterCreate', true);

        const fresh = new NoteItem();
        fresh.vaultId = vaultId;
        fresh.projectId = projectId;
        fresh.title = title;
        fresh.notebook = notebook;
        fresh.noteType = ['quick', 'study', 'markdown'].includes(noteType) ? noteType : 'markdown';
        fresh.editorLevel = ['simple', 'study', 'pro'].includes(editorLevel) ? editorLevel : 'pro';
        fresh.tags = LexiHarnessTools.parseTagsList(rawTags);
        fresh.properties = LexiHarnessTools.applyPropertiesJson(propsJson);
        fresh.pinned = pinned;
        fresh.favorite = favorite;
        fresh.content = content;
        if (fresh.tags.length > 0 || fresh.properties.length > 0) {
          fresh.editorLevel = 'pro';
        }
        fresh.content = LexiFrontmatter.serialize(fresh);

        const saved = await LexiStorageService.saveNote(context, fresh);
        LexiHarnessTools.notifyWorkspaceUpdated();
        if (openAfterCreate) {
          const req = new LexiHarnessUiActionRequest();
          req.action = 'open-note';
          req.targetId = saved.id;
          onUiAction(req);
        }
        out.openedNoteId = saved.id;
        out.title = `已创建笔记《${MarkdownEngine.displayTitle(saved)}》`;
        out.subtitle = `${saved.notebook} · ${saved.content.length} 字`;
        out.contentText = `已成功创建笔记《${MarkdownEngine.displayTitle(saved)}》(ID: \`${saved.id}\`, 笔记本: ${saved.notebook}, 标签: ${saved.tags.map((t: string): string => '#' + t).join(' ') || '无'})。`;
        out.preview = `已创建《${MarkdownEngine.displayTitle(saved)}》(${saved.notebook})`;
        return out;
      }

      // 7. update_note
      if (toolName === 'update_note') {
        const noteId = LexiHarnessTools.strArg(args, 'noteId', '');
        const title = LexiHarnessTools.strArg(args, 'title', '');
        const mode = LexiHarnessTools.strArg(args, 'mode', 'append');
        const existing = await LexiHarnessTools.findNoteByIdOrTitle(vaultId, noteId, title);
        if (!existing) {
          out.isError = true;
          out.contentText = `未找到要更新的笔记（noteId="${noteId}", title="${title}"）。`;
          out.preview = out.contentText;
          return out;
        }
        const draft = JSON.parse(JSON.stringify(existing)) as NoteItem;
        const parsed = LexiFrontmatter.parse(draft.content);
        let body = parsed.body;
        const contentArg = LexiHarnessTools.strArg(args, 'content', '');

        if (mode === 'append' && contentArg) {
          body = `${body.trimEnd()}\n\n${contentArg.trim()}\n`;
        } else if (mode === 'prepend' && contentArg) {
          body = `${contentArg.trim()}\n\n${body.trimStart()}`;
        } else if (mode === 'replace_section') {
          const heading = LexiHarnessTools.strArg(args, 'sectionHeading', '');
          body = LexiHarnessTools.replaceSectionInMarkdown(body, heading || '补充章节', contentArg);
        } else if (mode === 'replace_text') {
          const oldText = LexiHarnessTools.strArg(args, 'oldText', '');
          const newText = LexiHarnessTools.strArg(args, 'newText', '');
          if (!oldText || !body.includes(oldText)) {
            out.isError = true;
            out.contentText = `在笔记《${MarkdownEngine.displayTitle(existing)}》中未找到指定的 oldText 片段。`;
            out.preview = out.contentText;
            return out;
          }
          body = body.replace(oldText, newText);
        } else if (mode === 'replace' && contentArg) {
          body = contentArg;
        }

        const newTitle = LexiHarnessTools.strArg(args, 'newTitle', '').trim();
        const notebook = LexiHarnessTools.strArg(args, 'notebook', '').trim();
        const rawTags = LexiHarnessTools.strArg(args, 'tags', '').trim();
        const propsJson = LexiHarnessTools.strArg(args, 'propertiesJson', '').trim();
        if (newTitle) { draft.title = newTitle; }
        if (notebook) { draft.notebook = notebook; }
        if (rawTags) { draft.tags = LexiHarnessTools.parseTagsList(rawTags, draft.tags); }
        if (propsJson) {
          draft.properties = LexiHarnessTools.applyPropertiesJson(propsJson, draft.properties);
          draft.editorLevel = 'pro';
        }
        if (args['pinned'] !== undefined) { draft.pinned = LexiHarnessTools.boolArg(args, 'pinned', draft.pinned); }
        if (args['favorite'] !== undefined) { draft.favorite = LexiHarnessTools.boolArg(args, 'favorite', draft.favorite); }

        draft.content = body;
        draft.content = LexiFrontmatter.serialize(draft);
        const saved = await LexiStorageService.saveNote(context, draft);
        LexiHarnessTools.notifyWorkspaceUpdated();
        if (LexiHarnessTools.boolArg(args, 'openAfterUpdate', false)) {
          const req = new LexiHarnessUiActionRequest();
          req.action = 'open-note';
          req.targetId = saved.id;
          onUiAction(req);
        }
        out.openedNoteId = saved.id;
        out.title = `已更新笔记《${MarkdownEngine.displayTitle(saved)}》`;
        out.subtitle = `模式: ${mode}`;
        out.contentText = `已成功更新笔记《${MarkdownEngine.displayTitle(saved)}》(ID: \`${saved.id}\`, 字数: ${saved.content.length})。`;
        out.preview = `已更新《${MarkdownEngine.displayTitle(saved)}》(${saved.content.length} 字)`;
        return out;
      }

      // 8. delete_or_restore_note
      if (toolName === 'delete_or_restore_note') {
        const action = LexiHarnessTools.strArg(args, 'action', 'trash');
        const noteId = LexiHarnessTools.strArg(args, 'noteId', '');
        const title = LexiHarnessTools.strArg(args, 'title', '');
        if (action === 'list_trash') {
          const trashed = (await LexiStorageService.getNotes(vaultId)).filter((n: NoteItem): boolean => n.trashedAt > 0);
          out.contentText = trashed.length === 0
            ? '回收站当前为空。'
            : `回收站共有 ${trashed.length} 篇笔记：\n` + trashed.map((n: NoteItem): string => `- [${n.id}] 《${MarkdownEngine.displayTitle(n)}》`).join('\n');
          out.preview = `回收站共 ${trashed.length} 篇笔记`;
          return out;
        }
        if (action === 'restore') {
          const all = await LexiStorageService.getNotes(vaultId);
          const target = all.find((n: NoteItem): boolean => n.trashedAt > 0 &&
            (n.id === noteId || n.title.toLowerCase() === title.toLowerCase() || MarkdownEngine.displayTitle(n).toLowerCase().includes((title || noteId).toLowerCase())));
          if (!target) {
            out.isError = true;
            out.contentText = '在回收站中未找到该笔记。';
            out.preview = out.contentText;
            return out;
          }
          await LexiStorageService.setNoteTrash(context, target.id, false);
          LexiHarnessTools.notifyWorkspaceUpdated();
          out.contentText = `已从回收站恢复笔记《${MarkdownEngine.displayTitle(target)}》(ID: ${target.id})。`;
          out.preview = out.contentText;
          return out;
        }
        const source = await LexiHarnessTools.findNoteByIdOrTitle(vaultId, noteId, title);
        if (!source) {
          out.isError = true;
          out.contentText = `未找到目标笔记（noteId="${noteId}", title="${title}"）。`;
          out.preview = out.contentText;
          return out;
        }
        if (action === 'trash') {
          await LexiStorageService.setNoteTrash(context, source.id, true);
          LexiHarnessTools.notifyWorkspaceUpdated();
          out.contentText = `已将笔记《${MarkdownEngine.displayTitle(source)}》移入回收站（可随时恢复）。`;
          out.preview = out.contentText;
          return out;
        }
        if (action === 'duplicate') {
          const copy = await LexiStorageService.duplicateNote(context, source.id);
          LexiHarnessTools.notifyWorkspaceUpdated();
          out.contentText = `已创建副本笔记《${MarkdownEngine.displayTitle(copy)}》(ID: ${copy.id})。`;
          out.preview = out.contentText;
          return out;
        }
        if (action === 'merge') {
          const targetKey = LexiHarnessTools.strArg(args, 'targetNoteId', '');
          const mergeTarget = await LexiHarnessTools.findNoteByIdOrTitle(vaultId, targetKey, targetKey);
          if (!mergeTarget) {
            out.isError = true;
            out.contentText = `未找到合并目标笔记 "${targetKey}"。`;
            out.preview = out.contentText;
            return out;
          }
          const merged = await LexiStorageService.mergeNotes(context, source.id, mergeTarget.id);
          LexiHarnessTools.notifyWorkspaceUpdated();
          out.contentText = `已将《${MarkdownEngine.displayTitle(source)}》合并入《${MarkdownEngine.displayTitle(merged)}》，并自动更新了全库双向链接引用。`;
          out.preview = out.contentText;
          return out;
        }
      }

      // 9. manage_links_and_graph
      if (toolName === 'manage_links_and_graph') {
        const action = LexiHarnessTools.strArg(args, 'action', 'inspect');
        const activeNotes = (await LexiStorageService.getNotes(vaultId)).filter((n: NoteItem): boolean => n.trashedAt === 0);
        const links = MarkdownEngine.buildNoteLinks(activeNotes);
        const mentions = MarkdownEngine.findUnlinkedMentions(activeNotes, links);

        if (action === 'inspect') {
          const linkedIds: Set<string> = new Set<string>();
          for (let i = 0; i < links.length; i++) {
            linkedIds.add(links[i].sourceId);
            if (links[i].targetId) { linkedIds.add(links[i].targetId); }
          }
          const orphans = activeNotes.filter((n: NoteItem): boolean => !linkedIds.has(n.id));
          const mentionLines = mentions.map((m: UnlinkedMention, idx: number): string =>
            `${idx + 1}. 《${m.sourceTitle}》(${m.sourceId}) 提及了 《${m.targetTitle}》(${m.targetId}) — 片段: "${m.snippet}"`
          );
          out.contentText = [
            `# 知萤知识图谱与双向链接报告`,
            `- 有效笔记总数: ${activeNotes.length}`,
            `- 已建立双向链接数: ${links.length}`,
            `- 孤立笔记数 (${orphans.length}): ${orphans.slice(0, 10).map((n: NoteItem): string => `《${MarkdownEngine.displayTitle(n)}》`).join('、') || '无'}`,
            `- 检测到的「可能有关」未链接提及 (${mentions.length}):`,
            mentionLines.join('\n') || '暂无未链接提及'
          ].join('\n');
          out.preview = `${links.length} 条双链 · ${mentions.length} 处未链接提及 · ${orphans.length} 篇孤立笔记`;
          return out;
        }

        if (action === 'establish_all_mentions') {
          let count = 0;
          for (let i = 0; i < mentions.length; i++) {
            const m = mentions[i];
            const src = await LexiStorageService.getNoteById(m.sourceId);
            const tgt = await LexiStorageService.getNoteById(m.targetId);
            if (!src || !tgt || src.trashedAt > 0 || tgt.trashedAt > 0) { continue; }
            const updated = LexiCompletion.linkFirstMention(src.content, tgt.title);
            if (updated !== src.content) {
              src.content = updated;
              await LexiStorageService.saveNote(context, src);
              count++;
            }
          }
          LexiHarnessTools.notifyWorkspaceUpdated();
          out.contentText = `已批量将 ${count} 处未链接提及自动转换为 [[双向链接]]。`;
          out.preview = out.contentText;
          return out;
        }

        const srcKey = LexiHarnessTools.strArg(args, 'sourceNote', '');
        const tgtKey = LexiHarnessTools.strArg(args, 'targetNote', '');
        const srcNote = await LexiHarnessTools.findNoteByIdOrTitle(vaultId, srcKey, srcKey);
        const tgtNote = await LexiHarnessTools.findNoteByIdOrTitle(vaultId, tgtKey, tgtKey);
        if (!srcNote || !tgtNote) {
          out.isError = true;
          out.contentText = `未找到源笔记("${srcKey}")或目标笔记("${tgtKey}")。`;
          out.preview = out.contentText;
          return out;
        }

        if (action === 'establish_mention') {
          const updated = LexiCompletion.linkFirstMention(srcNote.content, MarkdownEngine.displayTitle(tgtNote));
          if (updated !== srcNote.content) {
            srcNote.content = updated;
            await LexiStorageService.saveNote(context, srcNote);
            LexiHarnessTools.notifyWorkspaceUpdated();
            out.contentText = `已在《${MarkdownEngine.displayTitle(srcNote)}》中将首次提及转换为 [[${MarkdownEngine.displayTitle(tgtNote)}]] 双向链接。`;
            out.preview = out.contentText;
            return out;
          }
        }

        // link_notes or fallback
        const anchor = LexiHarnessTools.strArg(args, 'anchor', '').trim();
        const alias = LexiHarnessTools.strArg(args, 'alias', '').trim();
        const contextSentence = LexiHarnessTools.strArg(args, 'contextSentence', '').trim();
        const targetTitle = MarkdownEngine.displayTitle(tgtNote);
        const wikiLink = `[[${targetTitle}${anchor ? '#' + anchor : ''}${alias ? '|' + alias : ''}]]`;
        if (!srcNote.content.includes(`[[${targetTitle}`)) {
          const addition = contextSentence ? `- ${contextSentence}：${wikiLink}` : `- 关联笔记：${wikiLink}`;
          srcNote.content = `${srcNote.content.trimEnd()}\n\n${addition}\n`;
          await LexiStorageService.saveNote(context, srcNote);
          LexiHarnessTools.notifyWorkspaceUpdated();
        }
        out.contentText = `已在《${MarkdownEngine.displayTitle(srcNote)}》中建立指向 ${wikiLink} 的双向链接。`;
        out.preview = `《${MarkdownEngine.displayTitle(srcNote)}》 ↗ ${wikiLink}`;
        return out;
      }

      // 10. manage_mindmap
      if (toolName === 'manage_mindmap') {
        const action = LexiHarnessTools.strArg(args, 'action', 'list');
        const maps = (await LexiStorageService.getMindMaps(vaultId)).filter((m: MindMapDoc): boolean => m.trashedAt === 0);

        if (action === 'list') {
          out.contentText = maps.length === 0
            ? '当前工作区暂无思维导图。'
            : `当前共有 ${maps.length} 幅思维导图：\n` + maps.map((m: MindMapDoc, idx: number): string =>
              `${idx + 1}. 《${m.title || '未命名导图'}》 (ID: \`${m.id}\`, 节点数: ${m.nodes.length}, 布局: ${m.layoutKind})`
            ).join('\n');
          out.preview = `共 ${maps.length} 幅思维导图`;
          return out;
        }

        const mapId = LexiHarnessTools.strArg(args, 'mapId', '');
        const titleArg = LexiHarnessTools.strArg(args, 'title', '').trim();

        if (action === 'read') {
          const targetMap = maps.find((m: MindMapDoc): boolean => m.id === mapId || m.title.toLowerCase() === (titleArg || mapId).toLowerCase());
          if (!targetMap) {
            out.isError = true;
            out.contentText = `未找到思维导图 "${mapId || titleArg}"。`;
            out.preview = out.contentText;
            return out;
          }
          const outline = MarkdownEngine.mindMapToMarkdownOutline(targetMap);
          out.contentText = `# 思维导图《${targetMap.title}》 (ID: \`${targetMap.id}\`, 布局: ${targetMap.layoutKind}, 节点数: ${targetMap.nodes.length})\n\n## 大纲视图\n${outline}\n\n## 节点 JSON\n${JSON.stringify(targetMap.nodes, null, 2)}`;
          out.preview = `《${targetMap.title}》(${targetMap.nodes.length} 个节点)`;
          return out;
        }

        if (action === 'export_to_note') {
          const targetMap = maps.find((m: MindMapDoc): boolean => m.id === mapId || m.title.toLowerCase() === (titleArg || mapId).toLowerCase());
          if (!targetMap) {
            out.isError = true;
            out.contentText = `未找到思维导图 "${mapId || titleArg}"。`;
            out.preview = out.contentText;
            return out;
          }
          const note = new NoteItem();
          note.vaultId = vaultId;
          note.projectId = projectId;
          note.title = `${targetMap.title}（导图大纲）`;
          note.notebook = '思维导图整理';
          note.noteType = 'study';
          note.editorLevel = 'pro';
          note.content = MarkdownEngine.mindMapToMarkdownOutline(targetMap);
          const savedNote = await LexiStorageService.saveNote(context, note);
          LexiHarnessTools.notifyWorkspaceUpdated();
          out.contentText = `已将思维导图《${targetMap.title}》导出为笔记《${savedNote.title}》(ID: \`${savedNote.id}\`)。`;
          out.preview = out.contentText;
          return out;
        }

        if (action === 'convert_from_note') {
          const fromKey = LexiHarnessTools.strArg(args, 'fromNote', '') || titleArg;
          const srcNote = await LexiHarnessTools.findNoteByIdOrTitle(vaultId, fromKey, fromKey);
          if (!srcNote) {
            out.isError = true;
            out.contentText = `未找到要转换为思维导图的源笔记 "${fromKey}"。`;
            out.preview = out.contentText;
            return out;
          }
          const doc = new MindMapDoc();
          doc.vaultId = vaultId;
          doc.projectId = srcNote.projectId || projectId;
          doc.title = titleArg || `${MarkdownEngine.displayTitle(srcNote)} · 导图`;
          const layout = LexiHarnessTools.strArg(args, 'layoutKind', 'right');
          doc.layoutKind = ['right', 'balanced', 'org'].includes(layout) ? layout : 'right';
          doc.rootNodeId = 'root';
          doc.nodes = MarkdownEngine.markdownToMindMapNodes(MarkdownEngine.displayTitle(srcNote), LexiFrontmatter.parse(srcNote.content).body, srcNote.id);
          const savedMap = await LexiStorageService.saveMindMap(context, doc);
          LexiHarnessTools.notifyWorkspaceUpdated();
          if (LexiHarnessTools.boolArg(args, 'openAfterSave', true)) {
            const req = new LexiHarnessUiActionRequest();
            req.action = 'open-map';
            req.targetId = savedMap.id;
            onUiAction(req);
          }
          out.title = `已生成思维导图《${savedMap.title}》`;
          out.subtitle = `${savedMap.nodes.length} 个节点 · 源自《${MarkdownEngine.displayTitle(srcNote)}》`;
          out.contentText = `已成功将笔记《${MarkdownEngine.displayTitle(srcNote)}》转化为思维导图《${savedMap.title}》(ID: \`${savedMap.id}\`, 共 ${savedMap.nodes.length} 个节点)。`;
          out.preview = `《${savedMap.title}》(${savedMap.nodes.length} 个节点)`;
          return out;
        }

        // create or update
        const existingMap = (action === 'update' && (mapId || titleArg))
          ? maps.find((m: MindMapDoc): boolean => m.id === mapId || m.title.toLowerCase() === titleArg.toLowerCase())
          : undefined;
        const doc = existingMap ? JSON.parse(JSON.stringify(existingMap)) as MindMapDoc : new MindMapDoc();
        doc.vaultId = vaultId;
        doc.projectId = projectId;
        if (titleArg) { doc.title = titleArg; }
        else if (!doc.title) { doc.title = '知识导图'; }
        const layout = LexiHarnessTools.strArg(args, 'layoutKind', doc.layoutKind || 'right');
        doc.layoutKind = ['right', 'balanced', 'org'].includes(layout) ? layout : 'right';
        doc.rootNodeId = 'root';

        const nodesJson = LexiHarnessTools.strArg(args, 'nodesJson', '').trim();
        const markdownOutline = LexiHarnessTools.strArg(args, 'markdownOutline', '').trim();
        const allNotes = (await LexiStorageService.getNotes(vaultId)).filter((n: NoteItem): boolean => n.trashedAt === 0);

        if (nodesJson) {
          try {
            const rawNodes = JSON.parse(nodesJson) as Record<string, Object>[];
            if (Array.isArray(rawNodes) && rawNodes.length > 0) {
              const builtNodes: MindMapNode[] = [];
              const colors: string[] = ['purple', 'indigo', 'teal', 'amber', 'rose'];
              for (let i = 0; i < rawNodes.length; i++) {
                const rn = rawNodes[i];
                const node = new MindMapNode();
                node.id = LexiHarnessTools.strArg(rn, 'id', i === 0 ? 'root' : `node-${i}`);
                node.parentId = node.id === 'root' ? '' : LexiHarnessTools.strArg(rn, 'parentId', 'root');
                node.text = LexiHarnessTools.strArg(rn, 'text', `节点 ${i + 1}`);
                node.note = LexiHarnessTools.strArg(rn, 'note', '');
                node.order = i;
                const color = LexiHarnessTools.strArg(rn, 'colorTag', colors[i % colors.length]);
                node.colorTag = colors.includes(color) ? color : colors[i % colors.length];
                const refTitle = LexiHarnessTools.strArg(rn, 'noteRefTitle', '') || LexiHarnessTools.strArg(rn, 'noteRefId', '');
                if (refTitle) {
                  const matchedNote = allNotes.find((n: NoteItem): boolean => n.id === refTitle || MarkdownEngine.displayTitle(n).toLowerCase() === refTitle.toLowerCase());
                  if (matchedNote) {
                    node.noteRefId = matchedNote.id;
                    node.noteRefTitle = MarkdownEngine.displayTitle(matchedNote);
                  }
                }
                builtNodes.push(node);
              }
              if (!builtNodes.some((n: MindMapNode): boolean => n.id === 'root')) {
                const root = new MindMapNode();
                root.id = 'root';
                root.parentId = '';
                root.text = doc.title;
                root.order = 0;
                builtNodes.unshift(root);
              }
              doc.nodes = builtNodes;
            }
          } catch {
            // Fallback to outline
          }
        }
        if (doc.nodes.length === 0 || markdownOutline) {
          doc.nodes = MarkdownEngine.markdownToMindMapNodes(doc.title, markdownOutline || `# 核心要点\n## 概念解析\n## 实践应用`);
        }

        const savedMap = await LexiStorageService.saveMindMap(context, doc);
        LexiHarnessTools.notifyWorkspaceUpdated();
        if (LexiHarnessTools.boolArg(args, 'openAfterSave', true)) {
          const req = new LexiHarnessUiActionRequest();
          req.action = 'open-map';
          req.targetId = savedMap.id;
          onUiAction(req);
        }
        out.title = `已保存思维导图《${savedMap.title}》`;
        out.subtitle = `${savedMap.nodes.length} 个节点 · ${savedMap.layoutKind}`;
        out.contentText = `已成功保存思维导图《${savedMap.title}》(ID: \`${savedMap.id}\`, 共 ${savedMap.nodes.length} 个节点)。`;
        out.preview = `《${savedMap.title}》(${savedMap.nodes.length} 个节点)`;
        return out;
      }

      // 11. manage_canvas
      if (toolName === 'manage_canvas') {
        const action = LexiHarnessTools.strArg(args, 'action', 'list');
        const boards = await LexiStorageService.getCanvases(vaultId);

        if (action === 'list') {
          out.contentText = boards.length === 0
            ? '当前工作区暂无自由白板。'
            : `当前共有 ${boards.length} 块自由白板：\n` + boards.map((b: CanvasBoard, idx: number): string =>
              `${idx + 1}. 《${b.title || '未命名白板'}》 (ID: \`${b.id}\`, 卡片: ${b.cards.length}, 连线: ${b.edges.length})`
            ).join('\n');
          out.preview = `共 ${boards.length} 块自由白板`;
          return out;
        }

        const canvasId = LexiHarnessTools.strArg(args, 'canvasId', '');
        const titleArg = LexiHarnessTools.strArg(args, 'title', '').trim();

        if (action === 'read') {
          const targetBoard = boards.find((b: CanvasBoard): boolean => b.id === canvasId || b.title.toLowerCase() === (titleArg || canvasId).toLowerCase());
          if (!targetBoard) {
            out.isError = true;
            out.contentText = `未找到自由白板 "${canvasId || titleArg}"。`;
            out.preview = out.contentText;
            return out;
          }
          out.contentText = `# 自由白板《${targetBoard.title}》 (ID: \`${targetBoard.id}\`)\n\n## 卡片 (${targetBoard.cards.length})\n${JSON.stringify(targetBoard.cards, null, 2)}\n\n## 连线 (${targetBoard.edges.length})\n${JSON.stringify(targetBoard.edges, null, 2)}`;
          out.preview = `《${targetBoard.title}》(${targetBoard.cards.length} 张卡片, ${targetBoard.edges.length} 条连线)`;
          return out;
        }

        const existingBoard = (action === 'update' && (canvasId || titleArg))
          ? boards.find((b: CanvasBoard): boolean => b.id === canvasId || b.title.toLowerCase() === titleArg.toLowerCase())
          : undefined;
        const board = existingBoard ? JSON.parse(JSON.stringify(existingBoard)) as CanvasBoard : new CanvasBoard();
        board.vaultId = vaultId;
        board.projectId = projectId;
        if (titleArg) { board.title = titleArg; }
        else if (!board.title) { board.title = '知识白板'; }

        const cardsJson = LexiHarnessTools.strArg(args, 'cardsJson', '').trim();
        const edgesJson = LexiHarnessTools.strArg(args, 'edgesJson', '').trim();
        const allNotes = (await LexiStorageService.getNotes(vaultId)).filter((n: NoteItem): boolean => n.trashedAt === 0);
        const colors: string[] = ['purple', 'indigo', 'teal', 'amber', 'rose'];

        if (cardsJson) {
          try {
            const rawCards = JSON.parse(cardsJson) as Record<string, Object>[];
            if (Array.isArray(rawCards)) {
              const builtCards: CanvasCard[] = [];
              for (let i = 0; i < rawCards.length; i++) {
                const rc = rawCards[i];
                const card = new CanvasCard();
                card.id = LexiHarnessTools.strArg(rc, 'id', `card-${i + 1}`);
                card.title = LexiHarnessTools.strArg(rc, 'title', `卡片 ${i + 1}`);
                card.content = LexiHarnessTools.strArg(rc, 'content', '');
                card.x = LexiHarnessTools.numArg(rc, 'x', 80 + (i % 3) * 280);
                card.y = LexiHarnessTools.numArg(rc, 'y', 80 + Math.floor(i / 3) * 200);
                const cTag = LexiHarnessTools.strArg(rc, 'colorTag', colors[i % colors.length]);
                card.colorTag = colors.includes(cTag) ? cTag : colors[i % colors.length];
                const refKey = LexiHarnessTools.strArg(rc, 'noteRefTitle', '') || LexiHarnessTools.strArg(rc, 'noteRefId', '');
                if (refKey) {
                  const matched = allNotes.find((n: NoteItem): boolean => n.id === refKey || MarkdownEngine.displayTitle(n).toLowerCase() === refKey.toLowerCase());
                  if (matched) {
                    card.noteRefId = matched.id;
                    card.noteRefTitle = MarkdownEngine.displayTitle(matched);
                    if (!card.content) { card.content = MarkdownEngine.extractSnippet(matched); }
                  }
                }
                builtCards.push(card);
              }
              board.cards = action === 'update' ? board.cards.concat(builtCards) : builtCards;
            }
          } catch {}
        }

        if (edgesJson) {
          try {
            const rawEdges = JSON.parse(edgesJson) as Record<string, Object>[];
            if (Array.isArray(rawEdges)) {
              const builtEdges: CanvasEdge[] = [];
              for (let i = 0; i < rawEdges.length; i++) {
                const re = rawEdges[i];
                const edge = new CanvasEdge();
                edge.id = LexiHarnessTools.strArg(re, 'id', `edge-${i + 1}`);
                edge.fromId = LexiHarnessTools.strArg(re, 'fromId', '');
                edge.toId = LexiHarnessTools.strArg(re, 'toId', '');
                edge.label = LexiHarnessTools.strArg(re, 'label', '');
                if (edge.fromId && edge.toId) {
                  builtEdges.push(edge);
                }
              }
              board.edges = action === 'update' ? board.edges.concat(builtEdges) : builtEdges;
            }
          } catch {}
        }

        const savedBoard = await LexiStorageService.saveCanvas(context, board);
        LexiHarnessTools.notifyWorkspaceUpdated();
        if (LexiHarnessTools.boolArg(args, 'openAfterSave', true)) {
          const req = new LexiHarnessUiActionRequest();
          req.action = 'open-canvas';
          req.targetId = savedBoard.id;
          onUiAction(req);
        }
        out.title = `已保存自由白板《${savedBoard.title}》`;
        out.subtitle = `${savedBoard.cards.length} 张卡片 · ${savedBoard.edges.length} 条连线`;
        out.contentText = `已成功保存自由白板《${savedBoard.title}》(ID: \`${savedBoard.id}\`, 卡片: ${savedBoard.cards.length}, 连线: ${savedBoard.edges.length})。`;
        out.preview = `《${savedBoard.title}》(${savedBoard.cards.length} 卡片, ${savedBoard.edges.length} 连线)`;
        return out;
      }

      // 12. manage_templates_and_daily
      if (toolName === 'manage_templates_and_daily') {
        const action = LexiHarnessTools.strArg(args, 'action', 'open_daily');
        if (action === 'open_daily') {
          let daily = await LexiStorageService.openOrCreateDailyNote(context, vaultId, projectId);
          const appendText = LexiHarnessTools.strArg(args, 'dailyAppendContent', '').trim();
          if (appendText) {
            daily.content = `${daily.content.trimEnd()}\n\n${appendText}\n`;
            daily = await LexiStorageService.saveNote(context, daily);
          }
          LexiHarnessTools.notifyWorkspaceUpdated();
          const req = new LexiHarnessUiActionRequest();
          req.action = 'open-note';
          req.targetId = daily.id;
          onUiAction(req);
          out.openedNoteId = daily.id;
          out.title = `今日笔记《${daily.title}》`;
          out.contentText = `已打开/更新今日笔记《${daily.title}》(ID: \`${daily.id}\`)：\n\n${daily.content}`;
          out.preview = `已打开今日笔记《${daily.title}》`;
          return out;
        }
        if (action === 'list_templates') {
          const templates = await LexiStorageService.getTemplates();
          const defaultId = await LexiStorageService.getDailyTemplate();
          out.contentText = `模板库共有 ${templates.length} 个模板：\n` + templates.map((t: LexiTemplateItem, idx: number): string =>
            `${idx + 1}. 《${t.title}》 (ID: \`${t.id}\`, 分类: ${t.category}${t.id === defaultId ? ' · 默认日记模板' : ''})`
          ).join('\n');
          out.preview = `共 ${templates.length} 个模板`;
          return out;
        }
        if (action === 'create_from_template') {
          const tplKey = LexiHarnessTools.strArg(args, 'templateId', '');
          const noteTitle = LexiHarnessTools.strArg(args, 'noteTitle', '');
          const templates = await LexiStorageService.getTemplates();
          const tpl = templates.find((t: LexiTemplateItem): boolean => t.id === tplKey || t.title.toLowerCase().includes(tplKey.toLowerCase()));
          if (!tpl) {
            out.isError = true;
            out.contentText = `未找到模板 "${tplKey}"。`;
            out.preview = out.contentText;
            return out;
          }
          const created = await LexiStorageService.createNoteFromTemplate(context, tpl.id, noteTitle || tpl.title, vaultId, projectId);
          LexiHarnessTools.notifyWorkspaceUpdated();
          const req = new LexiHarnessUiActionRequest();
          req.action = 'open-note';
          req.targetId = created.id;
          onUiAction(req);
          out.openedNoteId = created.id;
          out.contentText = `已使用模板《${tpl.title}》创建新笔记《${MarkdownEngine.displayTitle(created)}》(ID: \`${created.id}\`)。`;
          out.preview = out.contentText;
          return out;
        }
        if (action === 'save_note_as_template') {
          const noteKey = LexiHarnessTools.strArg(args, 'noteTitle', '') || activeEditorNoteId;
          const srcNote = await LexiHarnessTools.findNoteByIdOrTitle(vaultId, noteKey, noteKey);
          if (!srcNote) {
            out.isError = true;
            out.contentText = `未找到要保存为模板的笔记 "${noteKey}"。`;
            out.preview = out.contentText;
            return out;
          }
          const savedTpl = await LexiStorageService.saveNoteAsTemplate(srcNote.id);
          out.contentText = `已将笔记《${MarkdownEngine.displayTitle(srcNote)}》保存至模板库（模板 ID: \`${savedTpl.id}\`）。`;
          out.preview = out.contentText;
          return out;
        }
      }

      // 13. navigate_ui
      if (toolName === 'navigate_ui') {
        const action = LexiHarnessTools.strArg(args, 'action', 'open_note');
        const target = LexiHarnessTools.strArg(args, 'target', '').trim();
        const req = new LexiHarnessUiActionRequest();
        if (action === 'open_note' || action === 'open_note_split') {
          const note = await LexiHarnessTools.findNoteByIdOrTitle(vaultId, target, target);
          if (!note) {
            out.isError = true;
            out.contentText = `未找到要打开的笔记 "${target}"。`;
            out.preview = out.contentText;
            return out;
          }
          req.action = action === 'open_note_split' ? 'open-group' : 'open-note';
          req.targetId = note.id;
          onUiAction(req);
          out.openedNoteId = note.id;
          out.contentText = `已在${action === 'open_note_split' ? '右侧分屏' : '编辑器'}中打开笔记《${MarkdownEngine.displayTitle(note)}》。`;
          out.preview = out.contentText;
          return out;
        }
        if (action === 'open_mindmap') {
          const maps = await LexiStorageService.getMindMaps(vaultId);
          const map = maps.find((m: MindMapDoc): boolean => m.id === target || m.title.toLowerCase().includes(target.toLowerCase()));
          if (!map) {
            out.isError = true;
            out.contentText = `未找到思维导图 "${target}"。`;
            out.preview = out.contentText;
            return out;
          }
          req.action = 'open-map';
          req.targetId = map.id;
          onUiAction(req);
          out.contentText = `已打开思维导图《${map.title}》。`;
          out.preview = out.contentText;
          return out;
        }
        if (action === 'open_canvas') {
          const boards = await LexiStorageService.getCanvases(vaultId);
          const board = boards.find((b: CanvasBoard): boolean => b.id === target || b.title.toLowerCase().includes(target.toLowerCase()));
          if (!board) {
            out.isError = true;
            out.contentText = `未找到自由白板 "${target}"。`;
            out.preview = out.contentText;
            return out;
          }
          req.action = 'open-canvas';
          req.targetId = board.id;
          onUiAction(req);
          out.contentText = `已打开自由白板《${board.title}》。`;
          out.preview = out.contentText;
          return out;
        }
        if (action === 'switch_section') {
          req.action = 'select-section';
          req.sectionIndex = target === 'home' ? 0 : target === 'vault' ? 1 : target === 'explore' ? 2 : target === 'settings' ? 3 : 1;
          onUiAction(req);
          out.contentText = `已切换至「${target}」视图。`;
          out.preview = out.contentText;
          return out;
        }
        if (action === 'switch_vault') {
          const vaults = await LexiStorageService.getVaults();
          const matchedVault = vaults.find((v: VaultItem): boolean => v.id === target || v.name.toLowerCase().includes(target.toLowerCase()));
          if (!matchedVault) {
            out.isError = true;
            out.contentText = `未找到工作区 "${target}"。`;
            out.preview = out.contentText;
            return out;
          }
          await LexiStorageService.setActiveVaultId(matchedVault.id);
          LexiHarnessTools.notifyWorkspaceUpdated();
          out.contentText = `已切换至工作区「${matchedVault.name}」。`;
          out.preview = out.contentText;
          return out;
        }
        if (action === 'set_theme') {
          const themeVal = ['light', 'dark', 'system'].includes(target) ? target : 'system';
          await LexiStorageService.setSetting('theme', themeVal);
          req.action = 'set-theme';
          req.themeValue = themeVal;
          onUiAction(req);
          out.contentText = `已将知萤外观主题切换为 ${themeVal}。`;
          out.preview = out.contentText;
          return out;
        }
      }

      // 14. todo_write
      if (toolName === 'todo_write') {
        const todosJson = LexiHarnessTools.strArg(args, 'todosJson', '[]');
        const todos: LexiHarnessTodoItem[] = [];
        try {
          const parsed = JSON.parse(todosJson) as Record<string, Object>[];
          if (Array.isArray(parsed)) {
            for (let i = 0; i < parsed.length; i++) {
              const item = parsed[i];
              const id = LexiHarnessTools.strArg(item, 'id', `${i + 1}`);
              const content = LexiHarnessTools.strArg(item, 'content', '');
              const status = LexiHarnessTools.strArg(item, 'status', 'pending');
              if (content) {
                todos.push(new LexiHarnessTodoItem(id, content, ['pending', 'in_progress', 'completed'].includes(status) ? status : 'pending'));
              }
            }
          }
        } catch {}
        onTodosUpdated(todos);
        const completedCount = todos.filter((t: LexiHarnessTodoItem): boolean => t.status === 'completed').length;
        out.title = `任务规划 (${completedCount}/${todos.length})`;
        out.contentText = `已更新任务进度 (${completedCount}/${todos.length} 完成)：\n` + todos.map((t: LexiHarnessTodoItem): string =>
          `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '>' : ' '}] ${t.content}`
        ).join('\n');
        out.preview = `已完成 ${completedCount}/${todos.length} 项任务`;
        return out;
      }

      out.isError = true;
      out.contentText = `未知工具: ${toolName}`;
      out.preview = out.contentText;
      return out;
    } catch (error) {
      out.isError = true;
      out.contentText = `执行工具 ${toolName} 失败: ${(error as Error).message || '未知异常'}`;
      out.preview = out.contentText;
      return out;
    }
  }
}
