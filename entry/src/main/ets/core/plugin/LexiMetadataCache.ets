// MetadataCache service: CachedMetadata per note plus resolved-link projections.
// One resolver feeds getFileCache, resolvedLinks/unresolvedLinks and getFirstLinkpathDest, so a
// backlink consumer can never see two different answers for the same link.

import hilog from '@ohos.hilog';
import { LexiPluginBus } from './LexiPluginBus';
import { LexiEvents } from './LexiPluginKernel';
import { LexiCachedMetadata, LexiLinkCache, LexiMetadataModel } from './LexiMetadataModel';
import { LexiVaultFacade } from './LexiVaultFacade';
import { LexiTFile } from './LexiVaultModel';
import { NoteItem } from '../LexiModels';

/** One link as written in a note, with the path it resolved to ('' when unresolved). */
export class LexiLinkOccurrence {
  source: string = '';
  link: string = '';
  target: string = '';
}

/** Path-keyed link graph, matching Obsidian's resolvedLinks / unresolvedLinks shape. */
export class LexiLinkGraph {
  resolved: Record<string, Record<string, number>> = {};
  unresolved: Record<string, Record<string, number>> = {};
  /** key: sourcePath + '\u0000' + lowercased linkpath → resolved target path */
  targets: Map<string, string> = new Map();
  /** Raw occurrences, so the container can resolve an arbitrary linkpath without a second rule set. */
  occurrences: LexiLinkOccurrence[] = [];
  signature: string = '';
}

function emptyInner(map: Record<string, Record<string, number>>, source: string): Record<string, number> {
  let inner = map[source];
  if (!inner) { inner = {}; map[source] = inner; }
  return inner;
}

function withoutMdExt(path: string): string {
  return /\.md$/i.test(path) ? path.substring(0, path.length - 3) : path;
}

/** Payload of the 'resolved' event (Obsidian passes resolved/unresolved link counts). */
export class LexiResolvedEvent {
  resolvedCount: number = 0;
  unresolvedCount: number = 0;
}

export class LexiMetadataCache {
  private vault: LexiVaultFacade;
  events: LexiEvents = new LexiEvents();
  private graph: LexiLinkGraph = new LexiLinkGraph();

  constructor(vault: LexiVaultFacade) {
    this.vault = vault;
    // 'changed' 立即推给插件;解析图必须等 vault 索引刷新之后重建——vault 事件是
    // '索引已是新值'的唯一可靠信号,早于此重建会让 resolved 事件永远比对到旧图。
    LexiPluginBus.on('lexi.note.changed', (payload: Object): void => {
      this.events.trigger('changed', payload);
    });
    vault.events.on('create', (payload: Object | null): void => { this.rebuildResolved(); });
    vault.events.on('modify', (payload: Object | null): void => { this.rebuildResolved(); });
    vault.events.on('delete', (payload: Object | null): void => { this.rebuildResolved(); });
    vault.events.on('rename', (payload: Object | null): void => { this.rebuildResolved(); });
    this.rebuildResolved();
  }

  private rebuildResolved(): void {
    const previous = this.graph;
    const graph = this.buildGraph();
    this.graph = graph;
    const changed: boolean = graph.signature !== previous.signature;
    hilog.info(0x1051, 'LexiPlugin', '%{public}s', '解析图重建: changed=' + changed + ' resolved源=' + Object.keys(graph.resolved).length);
    if (changed) {
      const event = new LexiResolvedEvent();
      event.resolvedCount = Object.keys(graph.resolved).length;
      event.unresolvedCount = Object.keys(graph.unresolved).length;
      this.events.trigger('resolved', event as Object);
    }
  }

  /** Single resolution pass: every consumer below reads this one result. */
  private buildGraph(): LexiLinkGraph {
    const graph = new LexiLinkGraph();
    const notes: NoteItem[] = this.vault.allNotes();
    const byPath: Map<string, string> = new Map();
    const byName: Map<string, string> = new Map();
    const byNoteId: Map<string, string> = new Map();
    const sourceById: Map<string, NoteItem> = new Map();
    for (const note of notes) {
      if (note.trashedAt > 0) { continue; }
      const file = this.vault.fileForNoteId(note.id);
      if (!file || file.path.length === 0) { continue; }
      sourceById.set(note.id, note);
      const key = withoutMdExt(file.path).toLowerCase();
      if (!byPath.has(key)) { byPath.set(key, file.path); }
      const nameKey = withoutMdExt(file.basename).toLowerCase();
      if (!byName.has(nameKey)) { byName.set(nameKey, file.path); }
      byNoteId.set(note.id, file.path);
    }
    for (const note of notes) {
      const source = byNoteId.get(note.id);
      if (!source) { continue; }
      const cache = LexiMetadataModel.build(note.content);
      // resolvedLinks/unresolvedLinks 在 Obsidian 里包含 embed,所以解析输入 = links + embeds。
      const links: LexiLinkCache[] = (cache.links ? cache.links : []).concat(cache.embeds ? cache.embeds : []);
      for (const link of links) {
        const raw = link.link.trim();
        if (raw.length === 0) { continue; }
        const key = withoutMdExt(raw).toLowerCase();
        let target = byPath.get(key);
        if (!target) { target = byName.get(key); }
        if (!target) { target = byNoteId.get(raw); }
        const occurrence = new LexiLinkOccurrence();
        occurrence.source = source;
        occurrence.link = raw;
        if (target) {
          const inner = emptyInner(graph.resolved, source);
          inner[target] = (inner[target] || 0) + 1;
          graph.targets.set(source + '\u0000' + key, target);
          occurrence.target = target;
        } else {
          const inner = emptyInner(graph.unresolved, source);
          inner[raw] = (inner[raw] || 0) + 1;
        }
        graph.occurrences.push(occurrence);
      }
    }
    graph.signature = JSON.stringify({ 'r': graph.resolved as Object, 'u': graph.unresolved as Object });
    return graph;
  }

  getFileCache(file: LexiTFile): LexiCachedMetadata | null {
    const note = this.vault.noteById(file.noteId);
    if (!note) { return null; }
    return LexiMetadataModel.build(note.content);
  }

  getCache(path: string): LexiCachedMetadata | null {
    const file = this.vault.getFileByPath(path);
    return file ? this.getFileCache(file) : null;
  }

  /** Every link occurrence of the last build, for the container's synchronous resolver. */
  linkOccurrences(): LexiLinkOccurrence[] {
    return this.graph.occurrences;
  }

  /** Obsidian link resolution, read from the same graph that feeds resolvedLinks. */
  getFirstLinkpathDest(linkpath: string, sourcePath: string): LexiTFile | null {
    const raw = linkpath.trim();
    if (raw.length === 0) { return null; }
    const key = withoutMdExt(raw).toLowerCase();
    const target = this.graph.targets.get(sourcePath + '\u0000' + key);
    if (target) { return this.vault.getFileByPath(target); }
    // 未命中缓存的路径(例如从别处传入的 sourcePath)回落到同名解析
    for (const note of this.vault.allNotes()) {
      if (note.trashedAt > 0) { continue; }
      const file = this.vault.fileForNoteId(note.id);
      if (!file || file.path.length === 0) { continue; }
      if (withoutMdExt(file.path).toLowerCase() === key) { return file; }
      if (withoutMdExt(file.basename).toLowerCase() === key) { return file; }
    }
    return null;
  }

  fileToLinktext(file: LexiTFile, _sourcePath: string, _omitMdExtension: boolean = true): string {
    const note = this.vault.noteById(file.noteId);
    return note ? note.title : file.basename;
  }

  resolvedLinks(): Record<string, Record<string, number>> {
    return this.graph.resolved;
  }

  unresolvedLinks(): Record<string, Record<string, number>> {
    return this.graph.unresolved;
  }
}
