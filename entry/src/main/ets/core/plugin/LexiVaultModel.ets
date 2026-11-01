// Virtual path space over the UUID-based note store.
// Path scheme: /<vault>/<project>/<notebook>/<title>.md — folders collapse when a level is absent.
// Pure logic so the regression harness can load it directly.

import { NoteItem } from '../LexiModels';

export class LexiFileStat {
  ctime: number = 0;
  mtime: number = 0;
  size: number = 0;
}

export class LexiTreeNode {
  kind: string = 'folder'; // 'file' | 'folder'
  path: string = '';
  name: string = '';
}

export class LexiTFile extends LexiTreeNode {
  basename: string = '';
  extension: string = 'md';
  noteId: string = '';
  vaultId: string = '';
  projectId: string = '';
  notebook: string = '';
  stat: LexiFileStat = new LexiFileStat();
}

export class LexiTFolder extends LexiTreeNode {
  children: LexiTreeNode[] = [];
}

export class LexiVaultIndex {
  root: LexiTFolder = new LexiTFolder();
  byPath: Map<string, LexiTreeNode> = new Map();
  fileByNoteId: Map<string, LexiTFile> = new Map();
  vaultIdByName: Map<string, string> = new Map();
  projectIdByName: Map<string, string> = new Map();
}

const DEFAULT_NOTEBOOK: string = '速记收件箱';

/** Faithful-enough port of the Obsidian path normalizer: backslashes collapse, edges trimmed, no case folding. */
export function normalizePath(input: string): string {
  let path = input.trim().replace(/\\/g, '/');
  path = path.replace(/\/{2,}/g, '/');
  while (path.startsWith('/')) { path = path.substring(1); }
  while (path.endsWith('/') && path.length > 0) { path = path.substring(0, path.length - 1); }
  return path;
}

function sanitizeSegment(input: string): string {
  const cleaned = input.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : '_';
}

function baseName(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.substring(index + 1) : normalized;
}

function dirName(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.substring(0, index) : '';
}

function ensureFolder(index: LexiVaultIndex, segments: string[]): LexiTFolder {
  let current = index.root;
  let walked = '';
  for (const segment of segments) {
    walked = walked.length > 0 ? `${walked}/${segment}` : segment;
    let next: LexiTFolder | null = null;
    for (const child of current.children) {
      if (child.kind === 'folder' && child.name === segment) { next = child as LexiTFolder; break; }
    }
    if (!next) {
      next = new LexiTFolder();
      next.kind = 'folder';
      next.name = segment;
      next.path = walked;
      current.children.push(next);
      index.byPath.set(walked, next);
    }
    current = next;
  }
  return current;
}

function registerFile(index: LexiVaultIndex, note: NoteItem, segments: string[], title: string): void {
  const folder = ensureFolder(index, segments);
  const extension = 'md';
  let fileName = `${title}.${extension}`;
  let filePath = normalizePath(`${folder.path}/${fileName}`);
  if (index.byPath.has(filePath)) {
    // Titles repeat in real vaults; the id tail keeps paths unique while staying human readable.
    fileName = `${title} ${note.id.slice(-6)}.${extension}`;
    filePath = normalizePath(`${folder.path}/${fileName}`);
  }
  const file = new LexiTFile();
  file.kind = 'file';
  file.path = filePath;
  file.name = fileName;
  file.basename = fileName.substring(0, fileName.length - extension.length - 1);
  file.extension = extension;
  file.noteId = note.id;
  file.vaultId = note.vaultId;
  file.projectId = note.projectId;
  file.notebook = note.notebook || DEFAULT_NOTEBOOK;
  file.stat.ctime = note.createdAt;
  file.stat.mtime = note.updatedAt;
  file.stat.size = note.content.length;
  folder.children.push(file);
  index.byPath.set(filePath, file);
  index.fileByNoteId.set(note.id, file);
}

/**
 * Rebuilds the whole virtual tree for the active vault.
 * Paths are vault-relative like Obsidian's (`<project?>/<notebook>/<title>.md`);
 * the caller supplies only the notes of the active vault.
 */
export function buildVaultIndex(notes: NoteItem[], projectNames: Map<string, string>): LexiVaultIndex {
  const index = new LexiVaultIndex();
  index.root.kind = 'folder';
  index.root.name = '';
  index.root.path = '';
  index.byPath.set('', index.root);
  projectNames.forEach((name: string, id: string): void => {
    const key = sanitizeSegment(name);
    if (!index.projectIdByName.has(key)) { index.projectIdByName.set(key, id); }
  });
  for (const note of notes) {
    if (note.trashedAt > 0 || note.sourceMissing) { continue; }
    const segments: string[] = [];
    if (note.projectId && projectNames.has(note.projectId)) {
      segments.push(sanitizeSegment(projectNames.get(note.projectId) || ''));
    }
    segments.push(sanitizeSegment(note.notebook || DEFAULT_NOTEBOOK));
    const title = note.title.trim().length > 0 ? note.title.trim() : '未命名笔记';
    registerFile(index, note, segments, sanitizeSegment(title));
  }
  return index;
}

export function resolvePath(index: LexiVaultIndex, path: string): LexiTreeNode | null {
  const normalized = normalizePath(path);
  return index.byPath.get(normalized) || null;
}

export function fileBaseName(path: string): string {
  return baseName(path);
}

export function fileDirName(path: string): string {
  return dirName(path);
}
