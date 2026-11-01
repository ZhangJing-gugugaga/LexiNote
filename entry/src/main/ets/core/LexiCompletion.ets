import { NoteItem, OutlineHeading } from './LexiModels';
import { MarkdownEngine } from './MarkdownEngine';

export class LexiLinkTarget {
  noteName: string = '';
  anchor: string = '';
}

export class LexiCompletionContext {
  kind: string = '';
  query: string = '';
  noteName: string = '';
  start: number = 0;
  end: number = 0;
}

export class LexiCompletionCandidate {
  id: string = '';
  label: string = '';
  detail: string = '';
  insertion: string = '';
}

export class LexiCompletionEdit {
  text: string = '';
  cursor: number = 0;
}

/** Shared cursor-aware completion and link handling for both editor surfaces. */
export class LexiCompletion {
  static splitTarget(raw: string): LexiLinkTarget {
    const target = new LexiLinkTarget();
    const clean = raw.replace(/^!\[\[|^\[\[|\]\]$/g, '').split('|')[0].trim();
    const marker = clean.indexOf('#');
    target.noteName = (marker < 0 ? clean : clean.substring(0, marker)).trim();
    target.anchor = marker < 0 ? '' : clean.substring(marker + 1).trim();
    try { target.anchor = decodeURIComponent(target.anchor); } catch {}
    return target;
  }

  static context(text: string, start: number, end: number = start): LexiCompletionContext {
    const result = new LexiCompletionContext();
    if (start !== end || start < 0 || start > text.length || LexiCompletion.inCode(text, start)) { return result; }
    const before = text.substring(0, start);
    const wiki = /\[\[([^\[\]\n]{0,160})$/.exec(before);
    if (wiki) {
      result.kind = 'note'; result.query = wiki[1]; result.start = start - wiki[0].length; result.end = start;
      const hash = result.query.indexOf('#');
      if (hash >= 0) {
        result.kind = 'heading'; result.noteName = result.query.substring(0, hash).trim();
        result.query = result.query.substring(hash + 1);
      }
      return result;
    }
    const tag = /(?:^|\s)#([\u4e00-\u9fffA-Za-z0-9_\/-]{0,48})$/.exec(before);
    if (tag && !/^\s*#{1,6}\s/.test(before.substring(before.lastIndexOf('\n') + 1))) {
      result.kind = 'tag'; result.query = tag[1]; result.start = start - tag[1].length - 1; result.end = start;
    }
    return result;
  }

  static candidates(context: LexiCompletionContext, notes: NoteItem[], currentId: string): LexiCompletionCandidate[] {
    const results: LexiCompletionCandidate[] = [];
    const query = context.query.trim().toLowerCase();
    if (context.kind === 'heading') {
      const note = notes.find((n: NoteItem): boolean => n.trashedAt === 0 &&
        (context.noteName ? n.id === context.noteName || n.title.trim().toLowerCase() === context.noteName.toLowerCase() : n.id === currentId));
      if (!note) { return results; }
      for (const heading of MarkdownEngine.extractOutline(note.content)) {
        if (query && !heading.title.toLowerCase().includes(query)) { continue; }
        const candidate = new LexiCompletionCandidate();
        candidate.id = `${note.id}-${heading.id}`; candidate.label = heading.title;
        candidate.detail = `${MarkdownEngine.displayTitle(note)} · 章节`;
        candidate.insertion = `[[${context.noteName}#${heading.title}]]`;
        results.push(candidate);
        if (results.length >= 6) { break; }
      }
    } else if (context.kind === 'note') {
      for (const note of notes) {
        if (note.trashedAt > 0 || note.id === currentId) { continue; }
        const title = MarkdownEngine.displayTitle(note);
        if (query && !title.toLowerCase().includes(query)) { continue; }
        const candidate = new LexiCompletionCandidate();
        candidate.id = note.id; candidate.label = title; candidate.detail = note.notebook || '笔记';
        candidate.insertion = `[[${title}]]`; results.push(candidate);
        if (results.length >= 6) { break; }
      }
    } else if (context.kind === 'tag') {
      const seen = new Set<string>();
      for (const note of notes) {
        if (note.trashedAt > 0) { continue; }
        const tags = note.tags.concat(MarkdownEngine.extractInlineTags(note.content));
        for (const tag of tags) {
          if (seen.has(tag) || (query && !tag.toLowerCase().includes(query))) { continue; }
          seen.add(tag);
          const candidate = new LexiCompletionCandidate();
          candidate.id = `tag-${tag}`; candidate.label = `#${tag}`; candidate.detail = '已有标签';
          candidate.insertion = `#${tag} `; results.push(candidate);
          if (results.length >= 6) { return results; }
        }
      }
    }
    return results;
  }

  static apply(text: string, context: LexiCompletionContext, candidate: LexiCompletionCandidate): LexiCompletionEdit {
    const edit = new LexiCompletionEdit();
    let end = context.end;
    if (context.kind !== 'tag' && text.substring(end, end + 2) === ']]') { end += 2; }
    edit.text = text.substring(0, context.start) + candidate.insertion + text.substring(end);
    edit.cursor = context.start + candidate.insertion.length;
    return edit;
  }

  static findHeading(headings: OutlineHeading[], anchor: string): OutlineHeading | undefined {
    const normalize = (title: string): string => title.trim().toLowerCase().replace(/[*`~]/g, '').replace(/\s+/g, '-');
    return headings.find((heading: OutlineHeading): boolean => normalize(heading.title) === normalize(anchor));
  }

  static linkFirstMention(markdown: string, title: string): string {
    const needle = title.trim();
    if (!needle || /[\[\]\n|]/.test(needle)) { return markdown; }
    let offset = 0;
    while (offset < markdown.length) {
      const found = markdown.toLowerCase().indexOf(needle.toLowerCase(), offset);
      if (found < 0) { return markdown; }
      offset = found + needle.length;
      if (LexiCompletion.inCode(markdown, found)) { continue; }
      const before = markdown.substring(0, found);
      const after = markdown.substring(offset);
      // Never rewrite existing wiki/Markdown links, URLs, frontmatter, or part of an English word.
      const fmEnd = markdown.startsWith('---\n') ? markdown.indexOf('\n---', 4) : -1;
      if (fmEnd >= 0 && found < fmEnd + 4) { continue; }
      if (before.lastIndexOf('[[') > before.lastIndexOf(']]')) { continue; }
      if (before.lastIndexOf('[') > before.lastIndexOf(']') || /\]\([^)]*$/.test(before)) { continue; }
      if (/(?:https?:\/\/|file:\/\/)[^\s]*$/.test(before)) { continue; }
      if ((/[A-Za-z0-9_]$/.test(before) && /^[A-Za-z0-9_]/.test(needle)) ||
        (/[A-Za-z0-9_]$/.test(needle) && /^[A-Za-z0-9_]/.test(after))) { continue; }
      return markdown.substring(0, found) + `[[${needle}]]` + after;
    }
    return markdown;
  }

  private static inCode(text: string, position: number): boolean {
    const before = text.substring(0, position);
    const lines = before.split('\n');
    let fence = '';
    for (const line of lines) {
      const match = /^\s*(`{3,}|~{3,})/.exec(line);
      if (!match) { continue; }
      if (!fence) { fence = match[1]; }
      else if (match[1].charAt(0) === fence.charAt(0) && match[1].length >= fence.length) { fence = ''; }
    }
    if (fence) { return true; }
    const line = lines[lines.length - 1] || '';
    return (line.match(/`/g) || []).length % 2 === 1;
  }
}
