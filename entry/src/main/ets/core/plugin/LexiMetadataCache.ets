// MetadataCache service: CachedMetadata per note plus resolved-link projections.
// Builds on LexiMetadataModel (pure) and follows vault changes via the note-change bus.

import { MarkdownEngine } from '../MarkdownEngine';
import { LexiPluginBus } from './LexiPluginBus';
import { LexiEvents } from './LexiPluginKernel';
import { LexiCachedMetadata, LexiMetadataModel } from './LexiMetadataModel';
import { LexiVaultFacade } from './LexiVaultFacade';
import { LexiTFile } from './LexiVaultModel';
import { NoteLink } from '../LexiModels';

export class LexiResolvedLinks {
  bySource: Map<string, Map<string, number>> = new Map();

  asRecord(): Record<string, Record<string, number>> {
    const outer: Record<string, Record<string, number>> = {};
    this.bySource.forEach((targets: Map<string, number>, sourceId: string): void => {
      const inner: Record<string, number> = {};
      targets.forEach((count: number, targetId: string): void => { inner[targetId] = count; });
      outer[sourceId] = inner;
    });
    return outer;
  }
}

export class LexiMetadataCache {
  private vault: LexiVaultFacade;
  events: LexiEvents = new LexiEvents();
  private resolved: LexiResolvedLinks = new LexiResolvedLinks();

  constructor(vault: LexiVaultFacade) {
    this.vault = vault;
    LexiPluginBus.on('lexi.note.changed', (payload: Object): void => {
      this.rebuildResolved();
      this.events.trigger('changed', payload);
    });
    this.rebuildResolved();
  }

  private rebuildResolved(): void {
    const links: NoteLink[] = MarkdownEngine.buildNoteLinks(this.vault.allNotes());
    const next = new LexiResolvedLinks();
    for (const link of links) {
      if (!link.targetId) { continue; }
      let targets = next.bySource.get(link.sourceId);
      if (!targets) {
        targets = new Map<string, number>();
        next.bySource.set(link.sourceId, targets);
      }
      targets.set(link.targetId, (targets.get(link.targetId) || 0) + 1);
    }
    this.resolved = next;
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

  /** Obsidian link resolution: vault-scoped title match (case-insensitive) or direct note id. */
  getFirstLinkpathDest(linkpath: string, sourcePath: string): LexiTFile | null {
    const source = this.vault.getFileByPath(sourcePath);
    const vaultId = source ? source.vaultId : '';
    const needle = linkpath.trim().toLowerCase();
    for (const note of this.vault.allNotes()) {
      if (note.trashedAt > 0) { continue; }
      if (vaultId && note.vaultId !== vaultId) { continue; }
      if (note.id === linkpath || note.title.trim().toLowerCase() === needle) {
        return this.vault.fileForNoteId(note.id);
      }
    }
    return null;
  }

  fileToLinktext(file: LexiTFile, _sourcePath: string, _omitMdExtension: boolean = true): string {
    const note = this.vault.noteById(file.noteId);
    return note ? note.title : file.basename;
  }

  resolvedLinks(): Record<string, Record<string, number>> {
    return this.resolved.asRecord();
  }
}
