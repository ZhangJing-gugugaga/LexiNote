import { MarkdownBlock } from './LexiModels';
import { MarkdownEngine } from './MarkdownEngine';

export class LexiLiveSelection {
  start: number = 0;
  end: number = 0;
}

export class LexiLiveEditorController {
  caretPosition: (offset: number) => void = (_offset: number): void => {};
  setTextSelection: (start: number, end: number) => void = (_start: number, _end: number): void => {};
  insert: (snippet: string) => void = (_snippet: string): void => {};
  finishEditing: () => void = (): void => {};
  // Plugin editor facade hooks; the live editor assigns real implementations on mount.
  getText: () => string = (): string => '';
  getSelection: () => LexiLiveSelection = (): LexiLiveSelection => new LexiLiveSelection();
  replaceRange: (start: number, end: number, text: string) => void =
    (_start: number, _end: number, _text: string): void => {};
}

export class LexiLiveRange {
  start: number = 0;
  end: number = 0;
  kind: string = 'paragraph';
}

export class LexiLiveEdit {
  content: string = '';
  cursor: number = 0;
}

/** Source coordinates always refer to the original Markdown, including hidden YAML. */
export class LexiLiveMarkdown {
  static lineOffsets(content: string): number[] {
    const offsets: number[] = [0];
    for (let index = 0; index < content.length; index++) {
      if (content[index] === '\n') { offsets.push(index + 1); }
    }
    return offsets;
  }

  static lineAt(content: string, offset: number): number {
    let line = 0;
    for (let index = 0; index < Math.min(offset, content.length); index++) {
      if (content[index] === '\n') { line++; }
    }
    return line;
  }

  static rangeAt(content: string, offset: number): LexiLiveRange {
    const cursor = Math.max(0, Math.min(content.length, offset));
    const offsets = LexiLiveMarkdown.lineOffsets(content);
    const blocks = MarkdownEngine.parseBlocks(content);
    for (let index = 0; index < blocks.length; index++) {
      const start = offsets[blocks[index].lineIndex] ?? 0;
      let end = index + 1 < blocks.length ? (offsets[blocks[index + 1].lineIndex] ?? content.length) : content.length;
      // Leave separators outside the editable range so replacing a paragraph cannot join neighbours.
      while (end > start && (content[end - 1] === '\n' || content[end - 1] === '\r')) { end--; }
      if (cursor >= start && cursor <= end) {
        const range = new LexiLiveRange(); range.start = start; range.end = end; range.kind = blocks[index].kind;
        return range;
      }
    }
    const range = new LexiLiveRange();
    range.start = cursor > 0 ? content.lastIndexOf('\n', cursor - 1) + 1 : 0;
    const newline = content.indexOf('\n', cursor);
    range.end = newline < 0 ? content.length : newline;
    if (range.end > range.start && content[range.end - 1] === '\r') { range.end--; }
    return range;
  }

  static rangeForLine(content: string, lineIndex: number): LexiLiveRange {
    return LexiLiveMarkdown.rangeAt(content, LexiLiveMarkdown.lineOffsets(content)[lineIndex] ?? content.length);
  }

  static blocksBetween(content: string, start: number, end: number): MarkdownBlock[] {
    const lineOffset = LexiLiveMarkdown.lineAt(content, start);
    return MarkdownEngine.parseBlocks(content.substring(start, end)).map((block: MarkdownBlock): MarkdownBlock => {
      block.lineIndex += lineOffset; block.id = `live-block-${block.lineIndex}`; return block;
    });
  }

  static replace(content: string, start: number, end: number, snippet: string): LexiLiveEdit {
    const edit = new LexiLiveEdit();
    const first = Math.max(0, Math.min(content.length, Math.min(start, end)));
    const last = Math.max(first, Math.min(content.length, Math.max(start, end)));
    edit.content = content.substring(0, first) + snippet + content.substring(last);
    edit.cursor = first + snippet.length;
    return edit;
  }

  static changedCaret(before: string, after: string): number {
    let suffix = 0;
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) { prefix++; }
    while (suffix < before.length - prefix && suffix < after.length - prefix &&
      before[before.length - suffix - 1] === after[after.length - suffix - 1]) { suffix++; }
    return after.length - suffix;
  }

  static mapOffset(before: string, after: string, offset: number): number {
    let prefix = 0;
    let suffix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) { prefix++; }
    while (suffix < before.length - prefix && suffix < after.length - prefix &&
      before[before.length - suffix - 1] === after[after.length - suffix - 1]) { suffix++; }
    if (offset >= before.length - suffix) { return Math.max(0, Math.min(after.length, offset + after.length - before.length)); }
    if (offset <= prefix) { return Math.max(0, offset); }
    return Math.min(after.length - suffix, prefix);
  }

  static shouldAdvance(source: string, kind: string): boolean {
    source = source.replace(/\r\n/g, '\n');
    if (!source.endsWith('\n')) { return false; }
    const fence = /^\s*(`{3,}|~{3,})/.exec(source);
    if (fence) {
      const lines = source.split('\n');
      const close = fence[1];
      return lines.slice(1).some((line: string): boolean => line.trim().startsWith(close));
    }
    if (source.trimStart().startsWith('$$')) {
      return source.trim().length > 4 && source.trim().endsWith('$$');
    }
    if (kind === 'table' || kind === 'callout' || source.trimStart().startsWith('|') || source.trimStart().startsWith('>')) {
      return source.endsWith('\n\n');
    }
    return true;
  }

  static hasBody(content: string): boolean {
    return MarkdownEngine.parseFrontmatter(content).body.trim().length > 0;
  }
}
