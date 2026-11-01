/** Carries a chapter request across tabs and native navigation without changing document identity. */
export class LexiAnchorNavigation {
  private static noteId: string = '';
  private static anchor: string = '';
  private static sequence: number = 0;

  static request(noteId: string, anchor: string): void {
    LexiAnchorNavigation.noteId = noteId; LexiAnchorNavigation.anchor = anchor;
    LexiAnchorNavigation.sequence++;
    AppStorage.setOrCreate<number>('lexiAnchorRequest', LexiAnchorNavigation.sequence);
  }

  static take(noteId: string): string {
    if (LexiAnchorNavigation.noteId !== noteId) { return ''; }
    const anchor = LexiAnchorNavigation.anchor;
    LexiAnchorNavigation.noteId = ''; LexiAnchorNavigation.anchor = '';
    return anchor;
  }
}
