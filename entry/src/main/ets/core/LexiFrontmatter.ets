import { NoteItem, NoteProperty } from './LexiModels';

export class LexiFrontmatterResult {
  hasFrontmatter: boolean = false;
  body: string = '';
  bodyLineOffset: number = 0;
  tags: string[] = [];
  properties: NoteProperty[] = [];
  rawHeader: string = '';
}

class LexiYamlField {
  key: string = '';
  text: string = '';
  parsed: string = '';
  supported: boolean = false;
}

// A deliberately bounded YAML reader: scalars and flat lists are editable;
// nested/custom YAML is retained verbatim rather than evaluated or discarded.
export class LexiFrontmatter {
  private static scalar(raw: string): string {
    let text = raw.trim(); let quote = '';
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if ((char === '"' || char === "'") && (index === 0 || text[index - 1] !== '\\')) {
        if (!quote) { quote = char; } else if (quote === char) { quote = ''; }
      }
      if (char === '#' && !quote && (index === 0 || /\s/.test(text[index - 1]))) { text = text.slice(0, index).trim(); break; }
    }
    if (text.startsWith('"') && text.endsWith('"')) {
      try { return JSON.parse(text) as string; } catch { return text; }
    }
    if (text.startsWith("'") && text.endsWith("'")) { return text.slice(1, -1).replace(/''/g, "'"); }
    return text === 'null' || text === '~' ? '' : text;
  }

  private static fields(header: string): LexiYamlField[] {
    const result: LexiYamlField[] = [];
    for (const line of header.split('\n')) {
      const matched = /^("(?:[^"\\]|\\.)+"|'(?:[^']|'')+'|[^\s:#][^:]*):(?:\s+(.*)|\s*)$/.exec(line);
      if (!matched) {
        if (result.length > 0) { result[result.length - 1].text += `\n${line}`; }
        else { const empty = new LexiYamlField(); empty.text = line; result.push(empty); }
        continue;
      }
      const field = new LexiYamlField();
      field.key = LexiFrontmatter.scalar(matched[1]); field.text = line;
      const scalar = matched[2] || '';
      field.supported = !/^[>|{&*!]/.test(scalar.trim());
      field.parsed = LexiFrontmatter.scalar(scalar);
      result.push(field);
    }
    for (const field of result) {
      const rows = field.text.split('\n').slice(1).filter((line: string): boolean => !!line.trim() && !line.trim().startsWith('#'));
      if (rows.length > 0) {
        if (rows.every((line: string): boolean => /^\s+-\s+/.test(line))) {
          field.parsed = JSON.stringify(rows.map((line: string): string => LexiFrontmatter.scalar(line.replace(/^\s+-\s+/, ''))));
          field.supported = true;
        } else { field.supported = false; }
      }
    }
    return result;
  }

  private static list(raw: string): string[] {
    const text = raw.trim();
    if (text.startsWith('[') && text.endsWith(']')) {
      // YAML allows unquoted list items; split only on commas outside quotes.
      const items: string[] = []; let part = ''; let quote = '';
      for (let i = 1; i < text.length - 1; i++) {
        const char = text[i];
        if ((char === '"' || char === "'") && (i === 0 || text[i - 1] !== '\\')) {
          if (!quote) { quote = char; } else if (quote === char) { quote = ''; }
        }
        if (char === ',' && !quote) { items.push(LexiFrontmatter.scalar(part)); part = ''; }
        else { part += char; }
      }
      if (part.trim()) { items.push(LexiFrontmatter.scalar(part)); }
      return items;
    }
    return text ? [LexiFrontmatter.scalar(text)] : [];
  }

  static parse(raw: string): LexiFrontmatterResult {
    const result = new LexiFrontmatterResult(); result.body = raw;
    const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (!normalized.startsWith('---\n')) { return result; }
    const lines = normalized.split('\n');
    let end = -1;
    for (let i = 1; i < lines.length; i++) { if (lines[i] === '---' || lines[i] === '...') { end = i; break; } }
    if (end < 0) { return result; }
    result.hasFrontmatter = true; result.bodyLineOffset = end + 1;
    result.rawHeader = lines.slice(1, end).join('\n'); result.body = lines.slice(end + 1).join('\n');
    for (const field of LexiFrontmatter.fields(result.rawHeader)) {
      if (field.key === 'tags' || field.key === 'tag') {
        for (const tag of LexiFrontmatter.list(field.parsed)) {
          const cleaned = tag.replace(/^#/, '').trim(); if (cleaned && !result.tags.includes(cleaned)) { result.tags.push(cleaned); }
        }
      } else if (field.key && field.supported) { result.properties.push(new NoteProperty(field.key, field.parsed)); }
    }
    return result;
  }

  static apply(note: NoteItem, raw: string): void {
    note.content = raw;
    const parsed = LexiFrontmatter.parse(raw);
    if (parsed.hasFrontmatter) { note.tags = parsed.tags; note.properties = parsed.properties; }
  }

  static serialize(note: NoteItem): string {
    const parsed = LexiFrontmatter.parse(note.content);
    if (!parsed.hasFrontmatter && note.tags.length === 0 && note.properties.length === 0) { return note.content; }
    const output: string[] = []; const used: string[] = [];
    const tags = note.tags.filter((tag: string): boolean => !!tag.trim()).map((tag: string): string => tag.replace(/^#/, '').trim());
    for (const field of LexiFrontmatter.fields(parsed.rawHeader)) {
      if (field.key === 'tag' || field.key === 'tags') {
        if (!used.includes('tags')) { output.push(`tags: ${JSON.stringify(tags)}`); used.push('tags'); }
      } else if (!field.key || !field.supported) {
        if (field.text.trim()) { output.push(field.text); } if (field.key) { used.push(field.key); }
      }
      else {
        const prop = note.properties.find((item: NoteProperty): boolean => item.key === field.key);
        if (prop) {
          output.push(prop.propValue === field.parsed ? field.text : `${JSON.stringify(prop.key)}: ${JSON.stringify(prop.propValue)}`);
          used.push(prop.key);
        }
      }
    }
    if (tags.length > 0 && !used.includes('tags')) { output.push(`tags: ${JSON.stringify(tags)}`); }
    for (const prop of note.properties) {
      if (prop.key.trim() && prop.key !== 'tag' && prop.key !== 'tags' && !used.includes(prop.key)) {
        output.push(`${JSON.stringify(prop.key)}: ${JSON.stringify(prop.propValue)}`); used.push(prop.key);
      }
    }
    return `---\n${output.join('\n')}\n---\n${parsed.body}`;
  }
}
