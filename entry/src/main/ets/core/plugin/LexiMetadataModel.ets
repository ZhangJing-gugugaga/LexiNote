// CachedMetadata projection for the plugin API, with character-level positions.
// Pure logic: scans the raw Markdown directly so the regression harness can verify positions.

import { MarkdownEngine } from '../MarkdownEngine';
import { LexiFrontmatter } from '../LexiFrontmatter';

export class LexiLoc {
  line: number = 0;
  col: number = 0;
  offset: number = 0;
}

export class LexiPosRange {
  start: LexiLoc = new LexiLoc();
  end: LexiLoc = new LexiLoc();
}

export class LexiHeadingCache {
  heading: string = '';
  level: number = 1;
  position: LexiPosRange = new LexiPosRange();
}

export class LexiLinkCache {
  link: string = '';
  original: string = '';
  displayText: string = '';
  position: LexiPosRange = new LexiPosRange();
}

export class LexiTagCache {
  tag: string = '';
  position: LexiPosRange = new LexiPosRange();
}

export class LexiSectionCache {
  id: string = '';
  type: string = 'paragraph';
  position: LexiPosRange = new LexiPosRange();
}

export class LexiCachedMetadata {
  headings: LexiHeadingCache[] | null = null;
  links: LexiLinkCache[] | null = null;
  embeds: LexiLinkCache[] | null = null;
  tags: LexiTagCache[] | null = null;
  sections: LexiSectionCache[] | null = null;
  frontmatter: Record<string, Object> | null = null;
  frontmatterPosition: LexiPosRange | null = null;
}

class LexiLineIndex {
  offsets: number[] = [0];

  constructor(content: string) {
    for (let i = 0; i < content.length; i++) {
      if (content.charAt(i) === '\n') { this.offsets.push(i + 1); }
    }
  }

  lineAt(offset: number): number {
    let line = 0;
    while (line + 1 < this.offsets.length && this.offsets[line + 1] <= offset) { line++; }
    return line;
  }

  lineStart(line: number): number {
    return this.offsets[Math.max(0, Math.min(line, this.offsets.length - 1))];
  }

  lineEnd(line: number, content: string): number {
    const start = this.lineStart(line);
    const next = this.lineStart(line + 1);
    let end = next > start ? next - 1 : content.length;
    if (end > start && content.charAt(end - 1) === '\r') { end--; }
    return Math.max(start, Math.min(end, content.length));
  }

  locAt(offset: number): LexiLoc {
    const safe = Math.max(0, Math.min(offset, 2147483647));
    const loc = new LexiLoc();
    loc.line = this.lineAt(safe);
    loc.offset = safe;
    loc.col = safe - this.lineStart(loc.line);
    return loc;
  }

  rangeAt(start: number, end: number): LexiPosRange {
    const range = new LexiPosRange();
    range.start = this.locAt(start);
    range.end = this.locAt(Math.max(start, end));
    return range;
  }
}

function fencedAt(line: string, active: string): string {
  if (active) {
    return new RegExp(`^\\s*\\${active.charAt(0)}{${active.length},}\\s*$`).test(line) ? '' : active;
  }
  const match = /^\s*(`{3,}|~{3,})/.exec(line);
  return match ? match[1] : '';
}

function sectionType(blockKind: string): string {
  if (blockKind === 'h1' || blockKind === 'h2' || blockKind === 'h3') { return 'heading'; }
  if (blockKind === 'todo' || blockKind === 'bullet' || blockKind === 'ordered') { return 'list'; }
  if (blockKind === 'quote' || blockKind === 'callout') { return 'blockquote'; }
  if (blockKind === 'code') { return 'code'; }
  if (blockKind === 'table') { return 'table'; }
  if (blockKind === 'hr') { return 'thematicBreak'; }
  return 'paragraph';
}

export class LexiMetadataModel {
  /** Builds the CachedMetadata projection for one raw document. */
  static build(content: string): LexiCachedMetadata {
    const result = new LexiCachedMetadata();
    const lines = content.split('\n');
    const index = new LexiLineIndex(content);

    const headings: LexiHeadingCache[] = [];
    for (const heading of MarkdownEngine.extractOutline(content)) {
      const cache = new LexiHeadingCache();
      cache.heading = heading.title;
      cache.level = heading.level;
      cache.position = index.rangeAt(index.lineStart(heading.lineIndex), index.lineEnd(heading.lineIndex, content));
      headings.push(cache);
    }
    result.headings = headings.length > 0 ? headings : null;

    const links: LexiLinkCache[] = [];
    const embeds: LexiLinkCache[] = [];
    let fence = '';
    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const line = lines[lineNo];
      const lineStart = index.lineStart(lineNo);
      fence = fencedAt(line, fence);
      if (fence) { continue; }
      const wiki = /(!?)\[\[([^\[\]]+)\]\]/g;
      let match: RegExpExecArray | null = wiki.exec(line);
      while (match !== null) {
        const inner = match[2].trim();
        if (inner.length > 0) {
          const pipeParts = inner.split('|');
          const hashParts = pipeParts[0].split('#');
          const cache = new LexiLinkCache();
          cache.link = hashParts[0].trim();
          cache.original = match[0];
          cache.displayText = pipeParts.length > 1 ? pipeParts.slice(1).join('|').trim() : cache.link;
          const start = lineStart + match.index;
          cache.position = index.rangeAt(start, start + match[0].length);
          // '![[' 是嵌入:Obsidian 把它记进 embeds,不再冒充普通链接
          if (match[1] === '!') { embeds.push(cache); } else { links.push(cache); }
        }
        match = wiki.exec(line);
      }
      const markdown = /(!?)\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;
      match = markdown.exec(line);
      while (match !== null) {
        const target = match[3].replace(/^</, '').replace(/>$/, '');
        const external = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target) || target.charAt(0) === '#';
        if (!external) {
          const cache = new LexiLinkCache();
          cache.link = target;
          cache.original = match[0];
          cache.displayText = match[2];
          const start = lineStart + match.index;
          cache.position = index.rangeAt(start, start + match[0].length);
          if (match[1] === '!') { embeds.push(cache); } else { links.push(cache); }
        }
        match = markdown.exec(line);
      }
    }
    result.links = links.length > 0 ? links : null;
    result.embeds = embeds.length > 0 ? embeds : null;

    const tags: LexiTagCache[] = [];
    fence = '';
    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const line = lines[lineNo];
      const lineStart = index.lineStart(lineNo);
      fence = fencedAt(line, fence);
      if (fence) { continue; }
      const pattern = /(^|\s)#([\u4e00-\u9fa5A-Za-z0-9_\/-]{1,28})/g;
      let match: RegExpExecArray | null = pattern.exec(line);
      while (match !== null) {
        const cache = new LexiTagCache();
        cache.tag = match[2];
        const start = lineStart + match.index + match[1].length;
        cache.position = index.rangeAt(start, start + 1 + match[2].length);
        tags.push(cache);
        match = pattern.exec(line);
      }
    }
    result.tags = tags.length > 0 ? tags : null;

    const blocks = MarkdownEngine.parseBlocks(content);
    const sections: LexiSectionCache[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const section = new LexiSectionCache();
      section.id = blocks[i].id;
      section.type = sectionType(blocks[i].kind);
      const startLine = blocks[i].lineIndex;
      const endLine = i + 1 < blocks.length ? blocks[i + 1].lineIndex : lines.length;
      const start = index.lineStart(startLine);
      const end = endLine < lines.length ? index.lineStart(endLine) : content.length;
      section.position = index.rangeAt(start, Math.max(start, end));
      sections.push(section);
    }
    result.sections = sections.length > 0 ? sections : null;

    const frontmatter = LexiFrontmatter.parse(content);
    if (frontmatter.hasFrontmatter) {
      const record: Record<string, Object> = {};
      const tagList: string[] = frontmatter.tags.slice();
      record['tags'] = tagList as Object;
      for (const property of frontmatter.properties) {
        record[property.key] = property.propValue as Object;
      }
      result.frontmatter = record;
      const headerEnd = index.lineEnd(frontmatter.bodyLineOffset - 1, content);
      result.frontmatterPosition = index.rangeAt(0, headerEnd);
      // Obsidian 把 frontmatter tags 也计入 CachedMetadata.tags(位置落在 frontmatter 内)
      for (const rawTag of tagList) {
        const clean = rawTag.trim().replace(/^#/, '');
        if (clean.length === 0) { continue; }
        const cache = new LexiTagCache();
        cache.tag = clean;
        cache.position = index.rangeAt(0, headerEnd);
        tags.push(cache);
      }
      result.tags = tags.length > 0 ? tags : null;
    }
    return result;
  }
}
