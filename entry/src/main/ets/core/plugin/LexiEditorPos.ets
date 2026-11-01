// EditorPosition <-> character offset conversions for the plugin editor facade.
// Coordinates always refer to the raw Markdown text, hidden YAML included.

import { LexiLiveMarkdown } from '../LexiLiveMarkdown';

export class LexiEditorPosition {
  line: number = 0;
  ch: number = 0;
}

export class LexiEditorPosUtil {
  static offsetToPos(content: string, offset: number): LexiEditorPosition {
    const safeOffset = Math.max(0, Math.min(content.length, offset));
    const offsets = LexiLiveMarkdown.lineOffsets(content);
    let line = 0;
    while (line + 1 < offsets.length && offsets[line + 1] <= safeOffset) { line++; }
    const position = new LexiEditorPosition();
    position.line = line;
    position.ch = safeOffset - offsets[line];
    return position;
  }

  static posToOffset(content: string, position: LexiEditorPosition): number {
    const offsets = LexiLiveMarkdown.lineOffsets(content);
    const line = Math.max(0, Math.min(offsets.length - 1, Math.floor(position.line)));
    const lineStart = offsets[line];
    const lineEnd = line + 1 < offsets.length ? offsets[line + 1] - 1 : content.length;
    return lineStart + Math.max(0, Math.min(position.ch, lineEnd - lineStart));
  }
}
