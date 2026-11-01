// Community plugin index model. Pure parsing so the regression harness can cover it.
// Schema (Obsidian-compatible superset):
//   [{ id, name, author, description, repo, zipUrl? }]  or  { plugins: [...] }

export class LexiPluginMarketEntry {
  id: string = '';
  name: string = '';
  author: string = '';
  description: string = '';
  repo: string = '';
  zipUrl: string = '';
  version: string = '';
}

function textOf(source: Record<string, Object>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

export function parseMarketIndex(json: string): LexiPluginMarketEntry[] {
  let parsed: Object | null = null;
  try { parsed = JSON.parse(json) as Object; } catch { return []; }
  let rawList: Object[] = [];
  if (Array.isArray(parsed)) {
    rawList = parsed as Object[];
  } else if (parsed !== null) {
    const wrapped = (parsed as Record<string, Object>)['plugins'];
    if (Array.isArray(wrapped)) { rawList = wrapped as Object[]; }
  }
  const result: LexiPluginMarketEntry[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') { continue; }
    const source = raw as Record<string, Object>;
    const entry = new LexiPluginMarketEntry();
    entry.id = textOf(source, 'id');
    entry.name = textOf(source, 'name');
    if (!entry.id || !entry.name) { continue; }
    entry.author = textOf(source, 'author');
    entry.description = textOf(source, 'description');
    entry.repo = textOf(source, 'repo');
    entry.zipUrl = textOf(source, 'zipUrl');
    entry.version = textOf(source, 'version');
    result.push(entry);
  }
  return result;
}
