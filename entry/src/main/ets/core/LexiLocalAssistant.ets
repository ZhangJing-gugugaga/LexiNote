import { NoteItem } from './LexiModels';
import { MarkdownEngine, RawWikiLink } from './MarkdownEngine';

export class LexiLocalSuggestion {
  id: string = '';
  label: string = '';
  detail: string = '';
  markdown: string = '';
}

export class LexiLocalArrangement {
  summary: string = '';
  actions: LexiLocalSuggestion[] = [];
  links: LexiLocalSuggestion[] = [];
  tags: LexiLocalSuggestion[] = [];
  method: string = '按本地规则摘录原文与匹配已有笔记，不调用生成式模型。';
}

/** Deterministic local organization. Results are suggestions and never mutate notes. */
export class LexiLocalAssistant {
  private static body(content: string): string {
    return MarkdownEngine.parseFrontmatter(content).body.slice(0, 50000)
      .replace(/```[\s\S]*?(?:```|$)/g, '').replace(/~~~[\s\S]*?(?:~~~|$)/g, '');
  }

  private static plain(text: string): string {
    return text.replace(/!\[\[([^\]]+)\]\]/g, '$1').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^[#>\s]+/gm, '')
      .replace(/(?:\*\*|__|==|~~|`)/g, '').replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?/gm, '')
      .replace(/[ \t]+/g, ' ').trim();
  }

  private static suggestion(id: string, label: string, markdown: string, detail: string): LexiLocalSuggestion {
    const suggestion = new LexiLocalSuggestion(); suggestion.id = id; suggestion.label = label;
    suggestion.markdown = markdown; suggestion.detail = detail; return suggestion;
  }

  static arrange(content: string, notes: NoteItem[]): LexiLocalArrangement {
    const result = new LexiLocalArrangement();
    const body = LexiLocalAssistant.body(content);
    const plain = LexiLocalAssistant.plain(body);
    const candidates = plain.split(/[\n。！？!?]+/).map((line: string): string => line.trim())
      .filter((line: string): boolean => line.length >= 10 && !/^[-:|\s]+$/.test(line));
    const selected: string[] = [];
    for (const candidate of candidates) {
      if (!selected.includes(candidate)) { selected.push(candidate.slice(0, 140)); }
      if (selected.length >= 3) { break; }
    }
    result.summary = selected.join('；').slice(0, 360) || plain.slice(0, 240);
    const actionKeys = new Set<string>();
    for (const raw of body.split('\n')) {
      if (/^\s*[-*+]\s+\[[xX]\]/.test(raw)) { continue; }
      const task = /^\s*[-*+]\s+\[ \]\s*(.+)$/.exec(raw);
      const prose = /^(?:\s*[-*+]\s+)?\s*(?:(?:待办|TODO|行动项|下一步)\s*[:：]\s*|(?:需要|计划|记得|明天要)\s*)(.+)$/i.exec(raw);
      const text = LexiLocalAssistant.plain(task ? task[1] : prose ? prose[1] : '').slice(0, 180);
      const key = text.toLowerCase();
      if (!text || actionKeys.has(key)) { continue; }
      actionKeys.add(key);
      result.actions.push(LexiLocalAssistant.suggestion(`action-${result.actions.length}`, text, `- [ ] ${text}`, '从未完成任务或行动提示语摘录'));
      if (result.actions.length >= 8) { break; }
    }
    const lower = plain.toLowerCase();
    const existingTargets = MarkdownEngine.extractWikiLinks(body).map((link: RawWikiLink): string => link.targetText.toLowerCase());
    const existingTags = MarkdownEngine.parseFrontmatter(content).tags.concat(MarkdownEngine.extractInlineTags(body));
    const tagCounts = new Map<string, number>();
    const linkTitles = new Set<string>();
    for (const note of notes.slice(0, 3000)) {
      if (note.trashedAt > 0) { continue; }
      const title = note.title.trim(); const titleKey = title.toLowerCase();
      if (title.length >= 2 && title.length <= 80 && !/[\[\]|#\r\n]/.test(title) && lower.includes(titleKey) &&
        note.content !== content && !existingTargets.includes(titleKey) && !existingTargets.includes(note.id.toLowerCase()) &&
        !linkTitles.has(titleKey) && result.links.length < 8) {
        linkTitles.add(titleKey);
        result.links.push(LexiLocalAssistant.suggestion(`link-${note.id}`, title, `[[${title}]]`, '正文提到了这篇已有笔记的标题'));
      }
      for (const tag of note.tags) {
        if (/^[\u4e00-\u9fa5A-Za-z0-9_\/-]{1,28}$/.test(tag) && lower.includes(tag.toLowerCase()) && !existingTags.includes(tag)) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
      }
    }
    const tags: string[] = [];
    tagCounts.forEach((_count: number, tag: string): void => { tags.push(tag); });
    tags.sort((first: string, second: string): number => (tagCounts.get(second) ?? 0) - (tagCounts.get(first) ?? 0));
    const topicTags: string[][] = [
      ['学习', '学习|课程|复习|考试'], ['会议', '会议|议程|纪要'], ['读书', '读书|阅读|书评'],
      ['项目', '项目|迭代|需求'], ['计划', '计划|日程|安排'], ['灵感', '灵感|创意|想法']
    ];
    for (const topic of topicTags) {
      if (!tags.includes(topic[0]) && !existingTags.includes(topic[0]) && new RegExp(topic[1]).test(plain)) { tags.push(topic[0]); }
    }
    result.tags = tags.slice(0, 8).map((tag: string): LexiLocalSuggestion =>
      LexiLocalAssistant.suggestion(`tag-${tag}`, `#${tag}`, `#${tag}`, '按正文关键词与现有标签匹配'));
    return result;
  }

  static selectedMarkdown(result: LexiLocalArrangement, selectedIds: string[], summary: string, includeSummary: boolean): string {
    const sections: string[] = [];
    if (includeSummary && summary.trim()) { sections.push(`## 摘要（本地整理）\n\n${summary.trim()}`); }
    const actions = result.actions.filter((suggestion: LexiLocalSuggestion): boolean => selectedIds.includes(suggestion.id));
    if (actions.length) { sections.push('## 行动项\n\n' + actions.map((item: LexiLocalSuggestion): string => item.markdown).join('\n')); }
    const links = result.links.filter((suggestion: LexiLocalSuggestion): boolean => selectedIds.includes(suggestion.id));
    if (links.length) { sections.push('相关笔记：' + links.map((item: LexiLocalSuggestion): string => item.markdown).join(' · ')); }
    const tags = result.tags.filter((suggestion: LexiLocalSuggestion): boolean => selectedIds.includes(suggestion.id));
    if (tags.length) { sections.push(tags.map((item: LexiLocalSuggestion): string => item.markdown).join(' ')); }
    return sections.length ? `\n\n${sections.join('\n\n')}\n` : '';
  }
}
