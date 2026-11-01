import { NoteProperty } from './LexiModels';

export class LexiTemplateItem {
  id: string = '';
  title: string = '';
  content: string = '';
  category: string = '自定义';
  tags: string[] = [];
  properties: NoteProperty[] = [];
  builtIn: boolean = false;
  sourceNoteId: string = '';
  createdAt: number = 0;
  updatedAt: number = 0;
}

export class LexiTemplateLibraryState {
  version: number = 1;
  templates: LexiTemplateItem[] = [];
  defaultDailyId: string = 'builtin-daily';
  legacyImported: boolean = false;
}

// Templates are global library records, independent of any workspace or note.
// Only fresh() seeds built-ins. Decoding an existing library never reseeds it.
export class LexiTemplateLibrary {
  private static builtin(id: string, title: string, category: string, content: string, tags: string[]): LexiTemplateItem {
    const item = new LexiTemplateItem();
    item.id = id; item.title = title; item.category = category;
    item.content = content; item.tags = tags.slice(); item.builtIn = true;
    return item;
  }

  static builtins(): LexiTemplateItem[] {
    return [
      LexiTemplateLibrary.builtin('builtin-daily', '每日记录', '日常',
        '# {{date}} {{weekday}}\n\n## 今日重点\n\n- [ ] \n\n## 随手记录\n\n\n\n## 今日回顾\n\n- 今天完成了什么：\n- 明天想继续什么：\n', ['日记']),
      LexiTemplateLibrary.builtin('builtin-schedule', '日程计划', '计划',
        '# {{title}}\n\n日期：{{date}} {{weekday}}\n\n## 时间安排\n\n| 时间 | 事项 | 备注 |\n| --- | --- | --- |\n| 上午 |  |  |\n| 下午 |  |  |\n| 晚间 |  |  |\n\n## 待办清单\n\n- [ ] \n\n## 调整与提醒\n\n', ['计划']),
      LexiTemplateLibrary.builtin('builtin-code', '代码笔记', '代码',
        '# {{title}}\n\n记录时间：{{date}} {{time}}\n\n## 问题与目标\n\n\n\n## 代码\n\n```\n\n```\n\n## 实现说明\n\n\n\n## 验证结果\n\n- 输入与环境：\n- 预期结果：\n- 实际结果：\n\n## 后续改进\n\n- [ ] \n', ['代码']),
      LexiTemplateLibrary.builtin('builtin-study', '学习笔记', '学习',
        '# {{title}}\n\n学习日期：{{date}} {{weekday}}\n\n## 学习目标\n\n- [ ] \n\n## 核心概念\n\n\n\n## 示例与理解\n\n\n\n## 疑问与关联\n\n\n\n## 复习清单\n\n- [ ] 用自己的话解释核心概念\n- [ ] 完成一次练习\n', ['学习']),
      LexiTemplateLibrary.builtin('builtin-meeting', '会议纪要', '会议',
        '# {{title}}\n\n会议时间：{{date}} {{time}}\n参会人员：\n\n## 议题\n\n1. \n\n## 讨论记录\n\n\n\n## 决定事项\n\n\n\n## 后续行动\n\n| 事项 | 负责人 | 截止时间 | 状态 |\n| --- | --- | --- | --- |\n|  |  |  | 待办 |\n\n## 下次跟进\n\n', ['会议']),
      LexiTemplateLibrary.builtin('builtin-project', '项目规划', '项目',
        '# {{title}}\n\n创建日期：{{date}}\n\n## 目标与范围\n\n- 项目目标：\n- 交付内容：\n- 验收标准：\n\n## 里程碑\n\n| 阶段 | 交付物 | 计划完成时间 |\n| --- | --- | --- |\n| 准备 |  |  |\n| 实施 |  |  |\n| 验收 |  |  |\n\n## 当前任务\n\n- [ ] \n\n## 风险与依赖\n\n\n\n## 进展记录\n\n### {{date}} {{time}}\n\n', ['项目'])
    ];
  }

  static fresh(): LexiTemplateLibraryState {
    const state = new LexiTemplateLibraryState();
    state.templates = LexiTemplateLibrary.builtins();
    return state;
  }

  static clone(item: LexiTemplateItem): LexiTemplateItem {
    const copy = new LexiTemplateItem();
    copy.id = item.id; copy.title = item.title; copy.content = item.content;
    copy.category = item.category; copy.tags = item.tags.slice();
    copy.properties = item.properties.map((prop: NoteProperty): NoteProperty => new NoteProperty(prop.key, prop.propValue));
    copy.builtIn = item.builtIn; copy.sourceNoteId = item.sourceNoteId;
    copy.createdAt = item.createdAt; copy.updatedAt = item.updatedAt;
    return copy;
  }

  private static validId(id: string): boolean {
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  }

  private static validateItem(item: LexiTemplateItem): void {
    const fields: string[] = ['id', 'title', 'content', 'category', 'tags', 'properties', 'builtIn', 'sourceNoteId', 'createdAt', 'updatedAt'];
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
      Object.keys(item).some((key: string): boolean => !fields.includes(key)) ||
      !LexiTemplateLibrary.validId(item.id) || typeof item.title !== 'string' || !item.title.trim() ||
      typeof item.content !== 'string' || typeof item.category !== 'string' ||
      !Array.isArray(item.tags) || !item.tags.every((tag: string): boolean => typeof tag === 'string') ||
      !Array.isArray(item.properties) || typeof item.builtIn !== 'boolean' ||
      typeof item.sourceNoteId !== 'string' || (item.sourceNoteId !== '' && !LexiTemplateLibrary.validId(item.sourceNoteId)) ||
      !Number.isSafeInteger(item.createdAt) || item.createdAt < 0 || !Number.isSafeInteger(item.updatedAt) || item.updatedAt < 0) {
      throw new Error('模板库包含无效模板，原始数据未修改');
    }
    const propertyKeys = new Set<string>();
    for (const prop of item.properties) {
      if (!prop || typeof prop !== 'object' || Array.isArray(prop) ||
        Object.keys(prop).some((key: string): boolean => key !== 'key' && key !== 'propValue') ||
        typeof prop.key !== 'string' || !prop.key.trim() || typeof prop.propValue !== 'string' || propertyKeys.has(prop.key)) {
        throw new Error('模板属性格式无效或键名重复，原始数据未修改');
      }
      propertyKeys.add(prop.key);
    }
  }

  static decode(raw: string): LexiTemplateLibraryState {
    let parsed: LexiTemplateLibraryState;
    try { parsed = JSON.parse(raw) as LexiTemplateLibraryState; }
    catch (_) { throw new Error('模板库数据不是有效 JSON，原始数据未修改'); }
    const fields: string[] = ['version', 'templates', 'defaultDailyId', 'legacyImported'];
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1 ||
      Object.keys(parsed).some((key: string): boolean => !fields.includes(key)) || !Array.isArray(parsed.templates) ||
      typeof parsed.defaultDailyId !== 'string' || typeof parsed.legacyImported !== 'boolean') {
      throw new Error('模板库格式无效或版本不受支持，原始数据未修改');
    }
    const ids = new Set<string>();
    for (const item of parsed.templates) {
      LexiTemplateLibrary.validateItem(item);
      if (ids.has(item.id)) { throw new Error('模板库存在重复模板标识，原始数据未修改'); }
      ids.add(item.id);
    }
    if (parsed.defaultDailyId !== '' && !ids.has(parsed.defaultDailyId)) {
      throw new Error('默认日记模板已不存在，请检查模板库设置，原始数据未修改');
    }
    const state = new LexiTemplateLibraryState();
    state.templates = parsed.templates.map((item: LexiTemplateItem): LexiTemplateItem => LexiTemplateLibrary.clone(item));
    state.defaultDailyId = parsed.defaultDailyId; state.legacyImported = parsed.legacyImported;
    return state;
  }
}
