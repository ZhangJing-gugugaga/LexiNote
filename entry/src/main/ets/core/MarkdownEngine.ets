import {
  MarkdownBlock,
  MindMapDoc,
  MindMapNode,
  NoteItem,
  NoteLink,
  OutlineHeading,
  UnlinkedMention
} from './LexiModels';
import { LexiFrontmatter, LexiFrontmatterResult } from './LexiFrontmatter';

export class RawWikiLink {
  targetText: string = '';
  anchor: string = '';
  displayText: string = '';
}

export class LexiMarkdownTable {
  rows: string[][] = [];
  alignments: string[] = [];
}

export class LexiMarkdownInlineSpan {
  id: string = '';
  text: string = '';
  kind: string = 'text';
  target: string = '';
}

export class MarkdownEngine {
  static parseFrontmatter(markdown: string): LexiFrontmatterResult {
    return LexiFrontmatter.parse(markdown);
  }

  static serializeFrontmatter(note: NoteItem): string {
    return LexiFrontmatter.serialize(note);
  }

  static inlineSpans(text: string): LexiMarkdownInlineSpan[] {
    const spans: LexiMarkdownInlineSpan[] = [];
    const pattern = /`([^`]+)`|\[\[([^\[\]]+)\]\]|\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)|\*\*([^*]+)\*\*|__([^_]+)__|==([^=]+)==|~~([^~]+)~~|\*([^*\n]+)\*|_([^_\n]+)_/g;
    let cursor = 0;
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match !== null) {
      if (match.index > cursor) {
        const plain = new LexiMarkdownInlineSpan();
        plain.id = `text-${cursor}`;
        plain.text = text.substring(cursor, match.index);
        spans.push(plain);
      }
      const segment = new LexiMarkdownInlineSpan();
      segment.id = `mark-${match.index}`;
      if (match[1]) {
        segment.kind = 'code'; segment.text = match[1];
      } else if (match[2]) {
        const parts = match[2].split('|');
        segment.kind = 'link'; segment.target = parts[0].trim();
        segment.text = parts.length > 1 ? parts.slice(1).join('|').trim() : segment.target;
      } else if (match[3]) {
        segment.kind = 'url'; segment.text = match[3]; segment.target = match[4];
      } else if (match[5] || match[6]) {
        segment.kind = 'bold'; segment.text = match[5] || match[6];
      } else if (match[7]) {
        segment.kind = 'highlight'; segment.text = match[7];
      } else if (match[8]) {
        segment.kind = 'strike'; segment.text = match[8];
      } else {
        segment.kind = 'italic'; segment.text = match[9] || match[10];
      }
      spans.push(segment);
      cursor = match.index + match[0].length;
      match = pattern.exec(text);
    }
    if (cursor < text.length) {
      const tail = new LexiMarkdownInlineSpan();
      tail.id = `text-${cursor}`; tail.text = text.substring(cursor); spans.push(tail);
    }
    return spans;
  }

  static splitTableRow(line: string): string[] {
    let raw = line.trim();
    if (raw.startsWith('|')) { raw = raw.substring(1); }
    if (raw.endsWith('|') && !raw.endsWith('\\|')) { raw = raw.substring(0, raw.length - 1); }
    const cells: string[] = [];
    let cell = '';
    let inCode = false;
    for (let index = 0; index < raw.length; index++) {
      const character = raw[index];
      if (character === '\\' && raw[index + 1] === '|') { cell += '|'; index++; }
      else if (character === '`') { inCode = !inCode; cell += character; }
      else if (character === '|' && !inCode) { cells.push(cell.trim()); cell = ''; }
      else { cell += character; }
    }
    cells.push(cell.trim());
    return cells;
  }

  static tableData(block: MarkdownBlock): LexiMarkdownTable {
    try { return JSON.parse(block.meta) as LexiMarkdownTable; }
    catch (_) { return new LexiMarkdownTable(); }
  }

  static resolveImageSource(uri: string, notePath: string): string {
    let source = uri.trim();
    if (source.startsWith('<') && source.endsWith('>')) { source = source.slice(1, -1); }
    if (/^(https?:\/\/|file:\/\/|data:image\/|resource:\/\/)/i.test(source)) { return source; }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)) { return ''; }
    try { source = decodeURIComponent(source); } catch (_) {}
    if (source.startsWith('/')) { return `file://${source}`; }
    if (!notePath || !source) { return ''; }
    const localPath = notePath.replace(/^file:\/\/(?:[^/]+)?/, '');
    const base = localPath.substring(0, localPath.lastIndexOf('/'));
    const components = `${base}/${source}`.split('/');
    const normalized: string[] = [];
    for (const component of components) {
      if (component === '..') { if (normalized.length > 0) { normalized.pop(); } }
      else if (component !== '.' && component.length > 0) { normalized.push(component); }
    }
    return `file:///${normalized.join('/')}`;
  }

  static extractEmbeddedSection(markdown: string, anchor: string = ''): string {
    const parsed = LexiFrontmatter.parse(markdown);
    if (!anchor.trim()) { return parsed.body.trim().slice(0, 800); }
    const headings = MarkdownEngine.extractOutline(markdown);
    const normalized = anchor.trim().toLowerCase().replace(/\s+/g, '-');
    const heading = headings.find((candidate: OutlineHeading): boolean =>
      candidate.title.trim().toLowerCase().replace(/\s+/g, '-') === normalized);
    if (!heading) { return ''; }
    const next = headings.find((candidate: OutlineHeading): boolean =>
      candidate.lineIndex > heading.lineIndex && candidate.level <= heading.level);
    return markdown.split('\n').slice(heading.lineIndex + 1, next ? next.lineIndex : undefined).join('\n').trim().slice(0, 800);
  }
  static extractWikiLinks(markdown: string): RawWikiLink[] {
    const results: RawWikiLink[] = [];
    const regex = /\[\[([^\[\]]+)\]\]/g;
    let match: RegExpExecArray | null = regex.exec(markdown);
    while (match !== null) {
      const inner = match[1].trim();
      if (inner.length > 0) {
        const pipeParts = inner.split('|');
        const left = pipeParts[0].trim();
        const display = pipeParts.length > 1 ? pipeParts.slice(1).join('|').trim() : left;
        const hashParts = left.split('#');
        const target = hashParts[0].trim();
        const anchor = hashParts.length > 1 ? hashParts.slice(1).join('#').trim() : '';
        if (target.length > 0) {
          const item = new RawWikiLink();
          item.targetText = target;
          item.anchor = anchor;
          item.displayText = display;
          results.push(item);
        }
      }
      match = regex.exec(markdown);
    }
    return results;
  }

  static extractInlineTags(markdown: string): string[] {
    const tags: string[] = [];
    const lines = markdown.split('\n');
    let fence = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (fence) {
        if (new RegExp(`^\\s*${fence.charAt(0)}{${fence.length},}\\s*$`).test(line)) { fence = ''; }
        continue;
      }
      const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) { fence = fenceMatch[1]; continue; }
      const regex = /(?:^|\s)#([\u4e00-\u9fa5A-Za-z0-9_\/-]{1,28})/g;
      let match: RegExpExecArray | null = regex.exec(line);
      while (match !== null) {
        const tag = match[1].trim();
        if (tag.length > 0 && !tags.includes(tag)) {
          tags.push(tag);
        }
        match = regex.exec(line);
      }
    }
    return tags;
  }

  static buildNoteLinks(notes: NoteItem[]): NoteLink[] {
    const activeNotes = notes.filter((n: NoteItem): boolean => n.trashedAt === 0);
    const links: NoteLink[] = [];
    for (let i = 0; i < activeNotes.length; i++) {
      const source = activeNotes[i];
      const rawLinks = MarkdownEngine.extractWikiLinks(source.content);
      for (let j = 0; j < rawLinks.length; j++) {
        const raw = rawLinks[j];
        const target = activeNotes.find((candidate: NoteItem): boolean =>
          candidate.vaultId === source.vaultId &&
          (candidate.id === raw.targetText ||
          candidate.title.trim().toLowerCase() === raw.targetText.toLowerCase())
        );
        const link = new NoteLink();
        link.sourceId = source.id;
        link.sourceTitle = MarkdownEngine.displayTitle(source);
        link.targetId = target ? target.id : '';
        link.targetTitle = target ? MarkdownEngine.displayTitle(target) : raw.targetText;
        link.anchor = raw.anchor;
        link.displayText = raw.displayText;
        const duplicate = links.some((existing: NoteLink): boolean =>
          existing.sourceId === link.sourceId &&
          existing.targetTitle === link.targetTitle &&
          existing.anchor === link.anchor
        );
        if (!duplicate) {
          links.push(link);
        }
      }
    }
    return links;
  }

  static findUnlinkedMentions(notes: NoteItem[], links: NoteLink[]): UnlinkedMention[] {
    const active = notes.filter((n: NoteItem): boolean => n.trashedAt === 0 && n.title.trim().length >= 2);
    const mentions: UnlinkedMention[] = [];
    for (let i = 0; i < active.length; i++) {
      const target = active[i];
      const targetTitle = target.title.trim();
      for (let j = 0; j < active.length; j++) {
        const source = active[j];
        if (source.id === target.id || source.vaultId !== target.vaultId) {
          continue;
        }
        const alreadyLinked = links.some((l: NoteLink): boolean =>
          l.sourceId === source.id && (l.targetId === target.id || l.targetTitle === targetTitle)
        );
        if (alreadyLinked) {
          continue;
        }
        const idx = source.content.indexOf(targetTitle);
        if (idx >= 0) {
          const start = Math.max(0, idx - 16);
          const end = Math.min(source.content.length, idx + targetTitle.length + 24);
          const mention = new UnlinkedMention();
          mention.sourceId = source.id;
          mention.sourceTitle = MarkdownEngine.displayTitle(source);
          mention.targetId = target.id;
          mention.targetTitle = targetTitle;
          mention.snippet = source.content.substring(start, end).replace(/\n/g, ' ');
          mentions.push(mention);
          if (mentions.length >= 16) {
            return mentions;
          }
        }
      }
    }
    return mentions;
  }

  static renameLinksInMarkdown(content: string, oldTitle: string, newTitle: string): string {
    const cleanOld = oldTitle.trim();
    const cleanNew = newTitle.trim();
    if (!cleanOld || !cleanNew || cleanOld === cleanNew) {
      return content;
    }
    return content.replace(/\[\[([^\[\]]+)\]\]/g, (_full: string, inner: string): string => {
      const pipeParts = inner.split('|');
      const left = pipeParts[0].trim();
      const hashParts = left.split('#');
      const target = hashParts[0].trim();
      if (target.toLowerCase() !== cleanOld.toLowerCase()) {
        return `[[${inner}]]`;
      }
      const anchorSuffix = hashParts.length > 1 ? `#${hashParts.slice(1).join('#')}` : '';
      const displaySuffix = pipeParts.length > 1 ? `|${pipeParts.slice(1).join('|')}` : '';
      return `[[${cleanNew}${anchorSuffix}${displaySuffix}]]`;
    });
  }

  static displayTitle(note: NoteItem): string {
    if (note.title.trim().length > 0) {
      return note.title.trim();
    }
    const firstLine = LexiFrontmatter.parse(note.content).body
      .split('\n')
      .map((line: string): string => line.replace(/^[#>*\-\s]+/, '').trim())
      .find((line: string): boolean => line.length > 0);
    if (firstLine && firstLine.length > 0) {
      return firstLine.slice(0, 28);
    }
    return '未命名速记';
  }

  /** Card excerpts share the Markdown parser with the editor instead of displaying source syntax. */
  static previewSpans(note: NoteItem, query: string = ''): LexiMarkdownInlineSpan[] {
    const segments: LexiMarkdownInlineSpan[] = [];
    let length = 0;
    const title = MarkdownEngine.displayTitle(note);
    for (const block of MarkdownEngine.parseBlocks(note.content)) {
      if (block.kind === 'hr') { continue; }
      if (segments.length === 0 && block.kind === 'h1' && block.text.trim() === title) { continue; }
      let text = block.text;
      let literal = false;
      if (block.kind === 'table') {
        text = MarkdownEngine.tableData(block).rows.slice(0, 3)
          .map((row: string[]): string => row.join(' · ')).join('；');
      } else if (block.kind === 'todo') { text = `${block.checked ? '☑' : '☐'} ${text}`; }
      else if (block.kind === 'bullet') { text = `• ${text}`; }
      else if (block.kind === 'ordered') { text = `${block.meta}. ${text}`; }
      else if (block.kind === 'image') { text = block.text || '图片'; literal = true; }
      else if (block.kind === 'embed') { text = `引用：${block.text || block.meta}`; literal = true; }
      else if (block.kind === 'formula') { text = '数学公式'; literal = true; }
      else if (block.kind === 'code') { literal = true; }
      text = text.replace(/\s+/g, ' ').trim();
      if (!text) { continue; }
      if (segments.length > 0) {
        const separator = new LexiMarkdownInlineSpan(); separator.text = ' '; segments.push(separator); length++;
      }
      if (literal) {
        const span = new LexiMarkdownInlineSpan(); span.text = text;
        span.kind = block.kind === 'code' ? 'code' : 'text'; segments.push(span);
      } else {
        for (const span of MarkdownEngine.inlineSpans(text)) { segments.push(span); }
      }
      length += text.length;
      if (!query.trim() && length >= 128) { break; }
    }
    const plain = segments.map((span: LexiMarkdownInlineSpan): string => span.text).join('');
    const queryText = query.trim().toLowerCase();
    const match = queryText ? plain.toLowerCase().indexOf(queryText) : -1;
    const start = match >= 0 ? Math.max(0, match - 18) : 0;
    const end = Math.min(plain.length, match >= 0 ? match + queryText.length + 42 : 86);
    const preview: LexiMarkdownInlineSpan[] = [];
    if (start > 0) { const prefix = new LexiMarkdownInlineSpan(); prefix.text = '…'; preview.push(prefix); }
    let offset = 0;
    for (const span of segments) {
      const spanEnd = offset + span.text.length;
      if (spanEnd > start && offset < end) {
        span.text = span.text.substring(Math.max(0, start - offset), Math.min(span.text.length, end - offset));
        preview.push(span);
      }
      offset = spanEnd;
      if (offset >= end) { break; }
    }
    if (end < plain.length) { const suffix = new LexiMarkdownInlineSpan(); suffix.text = '…'; preview.push(suffix); }
    if (!preview.length) {
      const empty = new LexiMarkdownInlineSpan(); empty.text = '点击继续记录内容…'; preview.push(empty);
    }
    preview.forEach((span: LexiMarkdownInlineSpan, index: number): void => { span.id = `preview-${index}-${span.kind}-${span.text}`; });
    return preview;
  }

  static extractSnippet(note: NoteItem, query: string = ''): string {
    return MarkdownEngine.previewSpans(note, query).map((span: LexiMarkdownInlineSpan): string => span.text).join('');
  }

  static extractOutline(markdown: string): OutlineHeading[] {
    const headings: OutlineHeading[] = [];
    const lines = markdown.split('\n');
    const firstBodyLine = LexiFrontmatter.parse(markdown).bodyLineOffset;
    let fence = '';
    for (let i = firstBodyLine; i < lines.length; i++) {
      const line = lines[i].trim();
      if (fence) {
        if (new RegExp(`^${fence.charAt(0)}{${fence.length},}\\s*$`).test(line)) { fence = ''; }
        continue;
      }
      const fenceMatch = /^(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) { fence = fenceMatch[1]; continue; }
      const match = /^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/.exec(line);
      if (match) {
        const heading = new OutlineHeading();
        heading.id = `h-${i}`;
        heading.level = match[1].length;
        heading.title = match[2].trim();
        heading.lineIndex = i;
        headings.push(heading);
      }
    }
    return headings;
  }

  static parseBlocks(markdown: string): MarkdownBlock[] {
    const blocks: MarkdownBlock[] = [];
    const lines = markdown.split('\n');
    let i = LexiFrontmatter.parse(markdown).bodyLineOffset;
    while (i < lines.length) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        i++;
        continue;
      }
      const fenceOpen = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
      if (fenceOpen) {
        const fence = fenceOpen[1];
        const lang = fenceOpen[2].trim().split(/\s+/)[0] || 'code';
        const codeLines: string[] = [];
        const startLine = i;
        i++;
        const closePattern = new RegExp(`^${fence.charAt(0)}{${fence.length},}\\s*$`);
        while (i < lines.length && !closePattern.test(lines[i].trim())) {
          codeLines.push(lines[i]);
          i++;
        }
        i++;
        const block = new MarkdownBlock();
        block.id = `block-${startLine}`;
        block.kind = 'code';
        block.meta = lang;
        block.text = codeLines.join('\n');
        block.lineIndex = startLine;
        blocks.push(block);
        continue;
      }
      if (trimmed.startsWith('$$')) {
        const formulaLines: string[] = [];
        const startLine = i;
        if (trimmed.length > 4 && trimmed.endsWith('$$')) {
          formulaLines.push(trimmed.substring(2, trimmed.length - 2).trim());
          i++;
        } else {
          i++;
          while (i < lines.length && !lines[i].trim().startsWith('$$')) {
            formulaLines.push(lines[i]);
            i++;
          }
          i++;
        }
        const block = new MarkdownBlock();
        block.id = `block-${startLine}`;
        block.kind = 'formula';
        block.text = formulaLines.join('\n');
        block.lineIndex = startLine;
        blocks.push(block);
        continue;
      }
      const block = new MarkdownBlock();
      block.id = `block-${i}`;
      block.lineIndex = i;
      const heading = /^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/.exec(trimmed);
      const ordered = /^(\d{1,9})[.)]\s+(.+)$/.exec(trimmed);
      const image = /^!\[([^\]]*)\]\((<[^>]+>|[^)]+?)(?:\s+"[^"]*")?\)$/.exec(trimmed);
      const embed = /^!\[\[([^\[\]]+)\]\]$/.exec(trimmed);
      const separator = i + 1 < lines.length ? MarkdownEngine.splitTableRow(lines[i + 1]) : [];
      if (trimmed.includes('|') && separator.length > 0 && separator.every((cell: string): boolean => /^:?-{3,}:?$/.test(cell))) {
        const table = new LexiMarkdownTable();
        const headers = MarkdownEngine.splitTableRow(trimmed);
        if (headers.length === separator.length) {
          table.rows.push(headers);
          table.alignments = separator.map((cell: string): string => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
          i += 2;
          while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim().length > 0) {
            const cells = MarkdownEngine.splitTableRow(lines[i]);
            while (cells.length < headers.length) { cells.push(''); }
            table.rows.push(cells.slice(0, headers.length));
            i++;
          }
          block.kind = 'table';
          block.text = headers.join(' | ');
          block.meta = JSON.stringify(table);
          blocks.push(block);
          continue;
        }
      }
      if (heading) {
        block.kind = `h${Math.min(3, heading[1].length)}`;
        block.meta = String(heading[1].length);
        block.text = heading[2].trim();
      } else if (/^(?:\*\s*){3,}$|^(?:-\s*){3,}$|^(?:_\s*){3,}$/.test(trimmed)) {
        block.kind = 'hr';
      } else if (image) {
        block.kind = 'image'; block.text = image[1]; block.meta = image[2];
      } else if (embed) {
        block.kind = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(embed[1].split('|')[0].trim()) ? 'image' : 'embed';
        block.meta = embed[1].split('|')[0].trim();
        block.text = embed[1].split('|').slice(1).join('|').trim() || block.meta;
      } else if (ordered) {
        block.kind = 'ordered'; block.meta = ordered[1]; block.text = ordered[2];
      } else if (/^[-*+]\s+\[[xX]\](?:\s|$)/.test(trimmed)) {
        block.kind = 'todo';
        block.checked = true;
        block.text = trimmed.replace(/^[-*+]\s+\[[xX]\]\s*/, '');
      } else if (/^[-*+]\s+\[ \](?:\s|$)/.test(trimmed)) {
        block.kind = 'todo';
        block.checked = false;
        block.text = trimmed.replace(/^[-*+]\s+\[ \]\s*/, '');
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        block.kind = 'bullet';
        block.text = trimmed.substring(2).trim();
      } else if (trimmed.startsWith('> [!')) {
        block.kind = 'callout';
        const calloutMatch = /^>\s*\[!([A-Za-z]+)\]/.exec(trimmed);
        block.meta = calloutMatch ? calloutMatch[1] : 'NOTE';
        const bodyLines: string[] = [trimmed.replace(/^>\s*\[![A-Za-z]+\]\s*/, '')];
        while (i + 1 < lines.length && lines[i + 1].trim().startsWith('>')) {
          i++;
          bodyLines.push(lines[i].trim().replace(/^>\s?/, ''));
        }
        block.text = bodyLines.filter((s: string): boolean => s.length > 0).join('\n');
      } else if (trimmed.startsWith('> ')) {
        block.kind = 'quote';
        block.text = trimmed.substring(2).trim();
      } else {
        block.kind = 'paragraph';
        block.text = trimmed;
      }
      blocks.push(block);
      i++;
    }
    return blocks;
  }

  static computeMindMapLayout(doc: MindMapDoc): MindMapNode[] {
    const nodes = doc.nodes;
    const root = nodes.find((n: MindMapNode): boolean => n.id === doc.rootNodeId) || nodes[0];
    if (!root) {
      return [];
    }
    const visible: MindMapNode[] = [];
    const childrenOf = (parentId: string): MindMapNode[] => {
      return nodes
        .filter((n: MindMapNode): boolean => n.parentId === parentId)
        .sort((a: MindMapNode, b: MindMapNode): number => a.order - b.order);
    };

    const measureLeaves = (node: MindMapNode): number => {
      if (node.collapsed) {
        return 1;
      }
      const ch = childrenOf(node.id);
      if (ch.length === 0) {
        return 1;
      }
      let sum = 0;
      for (let i = 0; i < ch.length; i++) {
        sum += measureLeaves(ch[i]);
      }
      return Math.max(1, sum);
    };

    if (doc.layoutKind === 'org') {
      const hStep = 166;
      const vStep = 92;
      const placeOrg = (node: MindMapNode, level: number, startLeaf: number): number => {
        const span = measureLeaves(node);
        node.level = level;
        node.boxWidth = Math.min(184, Math.max(116, node.text.length * 14 + 34));
        node.boxHeight = node.note.length > 0 || node.noteRefId.length > 0 ? 54 : 42;
        node.x = 80 + (startLeaf + span / 2) * hStep;
        node.y = 76 + level * vStep;
        visible.push(node);
        if (!node.collapsed) {
          const ch = childrenOf(node.id);
          let cursor = startLeaf;
          for (let i = 0; i < ch.length; i++) {
            cursor += placeOrg(ch[i], level + 1, cursor);
          }
        }
        return span;
      };
      placeOrg(root, 0, 0);
      MarkdownEngine.applyMindMapOffsets(visible);
      return visible;
    }

    if (doc.layoutKind === 'balanced') {
      const topChildren = childrenOf(root.id);
      const rightGroup: MindMapNode[] = [];
      const leftGroup: MindMapNode[] = [];
      for (let i = 0; i < topChildren.length; i++) {
        if (i % 2 === 0) {
          rightGroup.push(topChildren[i]);
        } else {
          leftGroup.push(topChildren[i]);
        }
      }
      const vGap = 68;
      const hGap = 205;
      let rightLeaves = 0;
      for (let i = 0; i < rightGroup.length; i++) {
        rightLeaves += measureLeaves(rightGroup[i]);
      }
      let leftLeaves = 0;
      for (let i = 0; i < leftGroup.length; i++) {
        leftLeaves += measureLeaves(leftGroup[i]);
      }
      const totalLeaves = Math.max(3, Math.max(rightLeaves, leftLeaves));
      const centerY = Math.max(210, (totalLeaves * vGap) / 2 + 48);
      const centerX = 480;

      root.level = 0;
      root.boxWidth = Math.min(196, Math.max(132, root.text.length * 15 + 36));
      root.boxHeight = 48;
      root.x = centerX;
      root.y = centerY;
      visible.push(root);

      if (!root.collapsed) {
        const placeSide = (node: MindMapNode, level: number, startLeaf: number, dir: number, baseTop: number): number => {
          const span = measureLeaves(node);
          node.level = level;
          node.boxWidth = Math.min(184, Math.max(114, node.text.length * 13 + 34));
          node.boxHeight = node.note.length > 0 || node.noteRefId.length > 0 ? 52 : 42;
          node.x = centerX + dir * level * hGap;
          node.y = baseTop + (startLeaf + span / 2) * vGap;
          visible.push(node);
          if (!node.collapsed) {
            const ch = childrenOf(node.id);
            let cursor = startLeaf;
            for (let i = 0; i < ch.length; i++) {
              cursor += placeSide(ch[i], level + 1, cursor, dir, baseTop);
            }
          }
          return span;
        };

        const rightTop = centerY - (Math.max(1, rightLeaves) * vGap) / 2;
        let rCursor = 0;
        for (let i = 0; i < rightGroup.length; i++) {
          rCursor += placeSide(rightGroup[i], 1, rCursor, 1, rightTop);
        }

        const leftTop = centerY - (Math.max(1, leftLeaves) * vGap) / 2;
        let lCursor = 0;
        for (let i = 0; i < leftGroup.length; i++) {
          lCursor += placeSide(leftGroup[i], 1, lCursor, -1, leftTop);
        }
      }
      MarkdownEngine.applyMindMapOffsets(visible);
      return visible;
    }

    // Default 'right' tree layout
    const vGap = 68;
    const hGap = 206;
    const placeRight = (node: MindMapNode, level: number, startLeaf: number): number => {
      const span = measureLeaves(node);
      node.level = level;
      node.boxWidth = Math.min(192, Math.max(118, node.text.length * 14 + 34));
      node.boxHeight = node.note.length > 0 || node.noteRefId.length > 0 ? 52 : 42;
      node.x = 124 + level * hGap;
      node.y = 64 + (startLeaf + span / 2) * vGap;
      visible.push(node);
      if (!node.collapsed) {
        const ch = childrenOf(node.id);
        let cursor = startLeaf;
        for (let i = 0; i < ch.length; i++) {
          cursor += placeRight(ch[i], level + 1, cursor);
        }
      }
      return span;
    };
    placeRight(root, 0, 0);
    MarkdownEngine.applyMindMapOffsets(visible);
    return visible;
  }

  private static applyMindMapOffsets(nodes: MindMapNode[]): void {
    for (const node of nodes) {
      node.x += Number.isFinite(node.offsetX) ? node.offsetX : 0;
      node.y += Number.isFinite(node.offsetY) ? node.offsetY : 0;
    }
  }

  static mindMapToMarkdownOutline(doc: MindMapDoc): string {
    const lines: string[] = [`# ${doc.title}`];
    const childrenOf = (parentId: string): MindMapNode[] => {
      return doc.nodes
        .filter((n: MindMapNode): boolean => n.parentId === parentId)
        .sort((a: MindMapNode, b: MindMapNode): number => a.order - b.order);
    };
    const walk = (node: MindMapNode, depth: number): void => {
      if (depth > 0) {
        const indent = '  '.repeat(Math.max(0, depth - 1));
        const linkSuffix = node.noteRefTitle.length > 0 ? ` → [[${node.noteRefTitle}]]` : '';
        const noteSuffix = node.note.length > 0 ? ` （${node.note}）` : '';
        lines.push(`${indent}- ${node.text}${linkSuffix}${noteSuffix}`);
      }
      const ch = childrenOf(node.id);
      for (let i = 0; i < ch.length; i++) {
        walk(ch[i], depth + 1);
      }
    };
    const root = doc.nodes.find((n: MindMapNode): boolean => n.id === doc.rootNodeId) || doc.nodes[0];
    if (root) {
      walk(root, 0);
    }
    return lines.join('\n');
  }

  static markdownToMindMapNodes(title: string, markdown: string, noteId: string = ''): MindMapNode[] {
    const nodes: MindMapNode[] = [];
    const root = new MindMapNode();
    root.id = 'root';
    root.parentId = '';
    root.text = title.trim() || '核心主题';
    root.noteRefId = noteId;
    root.noteRefTitle = title.trim();
    root.colorTag = 'purple';
    root.order = 0;
    nodes.push(root);

    const lines = markdown.split('\n');
    let lastH1Id = 'root';
    let lastH2Id = 'root';
    let orderCounter = 1;
    const colors: string[] = ['purple', 'indigo', 'teal', 'amber', 'rose'];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.length === 0 || trimmed.startsWith('```')) {
        continue;
      }
      if (trimmed.startsWith('# ')) {
        const node = new MindMapNode();
        node.id = `node-${orderCounter}`;
        node.parentId = 'root';
        node.text = trimmed.substring(2).trim().slice(0, 32);
        node.order = orderCounter;
        node.colorTag = colors[orderCounter % colors.length];
        nodes.push(node);
        lastH1Id = node.id;
        lastH2Id = node.id;
        orderCounter++;
      } else if (trimmed.startsWith('## ')) {
        const node = new MindMapNode();
        node.id = `node-${orderCounter}`;
        node.parentId = lastH1Id;
        node.text = trimmed.substring(3).trim().slice(0, 32);
        node.order = orderCounter;
        node.colorTag = colors[orderCounter % colors.length];
        nodes.push(node);
        lastH2Id = node.id;
        orderCounter++;
      } else if (trimmed.startsWith('### ') || trimmed.startsWith('- ')) {
        const text = trimmed.startsWith('### ') ? trimmed.substring(4).trim() : trimmed.substring(2).trim();
        if (text.length > 0 && nodes.length < 48) {
          const node = new MindMapNode();
          node.id = `node-${orderCounter}`;
          node.parentId = lastH2Id;
          node.text = text.replace(/^\[[ xX]\]\s*/, '').slice(0, 32);
          node.order = orderCounter;
          node.colorTag = colors[orderCounter % colors.length];
          nodes.push(node);
          orderCounter++;
        }
      }
    }

    if (nodes.length === 1) {
      const branches: string[] = ['核心要点', '关联知识', '行动清单'];
      for (let i = 0; i < branches.length; i++) {
        const child = new MindMapNode();
        child.id = `node-${i + 1}`;
        child.parentId = 'root';
        child.text = branches[i];
        child.order = i + 1;
        child.colorTag = colors[i % colors.length];
        nodes.push(child);
      }
    }
    return nodes;
  }
}
