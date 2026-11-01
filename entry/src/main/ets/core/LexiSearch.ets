import { NoteItem, NoteProperty } from './LexiModels';

export class LexiSearchTerm {
  field: string = '';
  text: string = '';
  excluded: boolean = false;
}

/** Shared search grammar for the library, desktop tree and quick switcher. */
export class LexiSearch {
  static parse(query: string): LexiSearchTerm[] {
    const tokens = query.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    const result: LexiSearchTerm[] = [];
    for (const token of tokens) {
      const term = new LexiSearchTerm();
      let text = token;
      if (text.startsWith('-') && text.length > 1) { term.excluded = true; text = text.substring(1); }
      const colon = text.indexOf(':');
      if (colon > 0) {
        const field = text.substring(0, colon).toLowerCase();
        if (['tag', 'type', 'notebook', 'path'].includes(field) || /^\[[^\]]+\]$/.test(field)) {
          term.field = field; text = text.substring(colon + 1);
        }
      }
      term.text = text.replace(/^["']|["']$/g, '').toLowerCase();
      if (term.text) { result.push(term); }
    }
    return result;
  }

  static matches(note: NoteItem, query: string): boolean {
    const haystack = `${note.title}\n${note.content}\n${note.notebook}\n${note.tags.join(' ')}`.toLowerCase();
    for (const term of LexiSearch.parse(query)) {
      let found = false;
      if (term.field === 'tag') {
        const tag = term.text.replace(/^#/, '');
        found = note.tags.some((item: string): boolean => item.toLowerCase() === tag || item.toLowerCase().startsWith(`${tag}/`));
      } else if (term.field === 'type') {
        found = note.noteType.toLowerCase() === term.text;
      } else if (term.field === 'notebook') {
        found = note.notebook.toLowerCase().includes(term.text);
      } else if (term.field === 'path') {
        found = note.path.toLowerCase().includes(term.text);
      } else if (term.field.startsWith('[')) {
        const key = term.field.substring(1, term.field.length - 1);
        found = note.properties.some((prop: NoteProperty): boolean =>
          prop.key.toLowerCase() === key && prop.propValue.toLowerCase().includes(term.text));
      } else { found = haystack.includes(term.text); }
      if (term.excluded ? found : !found) { return false; }
    }
    return true;
  }

  /** Lower is better; a subsequence also accepts initials typed in order. */
  static rank(title: string, query: string): number {
    const needle = query.trim().toLowerCase();
    const text = title.toLowerCase();
    if (!needle) { return 0; }
    if (text === needle) { return 0; }
    const offset = text.indexOf(needle);
    if (offset >= 0) { return 1 + offset; }
    let cursor = 0;
    let gaps = 0;
    for (let i = 0; i < needle.length; i++) {
      const next = text.indexOf(needle[i], cursor);
      if (next < 0) { return -1; }
      gaps += next - cursor; cursor = next + 1;
    }
    return 100 + gaps;
  }
}
