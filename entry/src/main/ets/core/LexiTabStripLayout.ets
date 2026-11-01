/** Uses the measured scroll viewport, after fixed controls and window insets. */
export class LexiTabStripLayout {
  static readonly gap: number = 3;
  static readonly minimum: number = 104;
  static readonly preferred: number = 196;

  static tabWidth(viewport: number, count: number): number {
    if (count <= 0) { return LexiTabStripLayout.preferred; }
    const available = Math.max(0, viewport - Math.max(0, count - 1) * LexiTabStripLayout.gap);
    return Math.max(LexiTabStripLayout.minimum, Math.min(LexiTabStripLayout.preferred, available / count));
  }

  static contentWidth(viewport: number, count: number): number {
    return count <= 0 ? 0 : count * LexiTabStripLayout.tabWidth(viewport, count) + (count - 1) * LexiTabStripLayout.gap;
  }

  static revealOffset(viewport: number, count: number, index: number, current: number): number {
    const maximum = Math.max(0, LexiTabStripLayout.contentWidth(viewport, count) - viewport);
    let offset = Math.max(0, Math.min(maximum, current));
    if (viewport <= 0 || index < 0 || index >= count) { return offset; }
    const width = LexiTabStripLayout.tabWidth(viewport, count);
    const left = index * (width + LexiTabStripLayout.gap);
    const right = left + width;
    if (left < offset) { offset = left; }
    else if (right > offset + viewport) { offset = right - viewport; }
    return Math.max(0, Math.min(maximum, offset));
  }
}
