import { NoteItem, NoteProperty } from './LexiModels';

export class LexiContinuationDraft {
  version: number = 1;
  transferId: string = '';
  sourceNoteId: string = '';
  title: string = '';
  content: string = '';
  notebook: string = '';
  noteType: string = 'markdown';
  editorLevel: string = 'pro';
  tags: string[] = [];
  properties: NoteProperty[] = [];
  cursorStart: number = 0;
  cursorEnd: number = 0;
  sourceMode: boolean = false;
  capturedAt: number = 0;
}

export class LexiContinuationData {
  static readonly maximumBytes: number = 90 * 1024;

  static bytes(text: string): number {
    let size = 0;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code < 0x80) { size++; }
      else if (code < 0x800) { size += 2; }
      else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xDC00 && text.charCodeAt(index + 1) <= 0xDFFF) {
        size += 4; index++;
      } else { size += 3; }
    }
    return size;
  }

  static capture(note: NoteItem, title: string, content: string, start: number, end: number, sourceMode: boolean): LexiContinuationDraft {
    const draft = new LexiContinuationDraft();
    draft.sourceNoteId = note.id; draft.title = title; draft.content = content;
    draft.notebook = note.notebook; draft.noteType = note.noteType; draft.editorLevel = note.editorLevel;
    draft.tags = note.tags.slice(); draft.properties = note.properties.map((prop: NoteProperty): NoteProperty => new NoteProperty(prop.key, prop.propValue));
    draft.cursorStart = Math.max(0, Math.min(content.length, start));
    draft.cursorEnd = Math.max(draft.cursorStart, Math.min(content.length, end));
    draft.sourceMode = sourceMode; draft.capturedAt = Date.now(); return draft;
  }

  static decode(raw: string): LexiContinuationDraft {
    if (typeof raw !== 'string' || LexiContinuationData.bytes(raw) > LexiContinuationData.maximumBytes) { throw new Error('接续内容超过系统传输限制，请先缩小当前笔记'); }
    const draft = JSON.parse(raw) as LexiContinuationDraft;
    const fields: string[] = ['version', 'transferId', 'sourceNoteId', 'title', 'content', 'notebook', 'noteType', 'editorLevel',
      'tags', 'properties', 'cursorStart', 'cursorEnd', 'sourceMode', 'capturedAt'];
    if (!draft || typeof draft !== 'object' || Array.isArray(draft) ||
      Object.keys(draft).some((key: string): boolean => !fields.includes(key)) ||
      draft.version !== 1 || typeof draft.transferId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(draft.transferId) ||
      typeof draft.sourceNoteId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(draft.sourceNoteId) ||
      typeof draft.title !== 'string' || typeof draft.content !== 'string' || typeof draft.notebook !== 'string' ||
      !['quick', 'study', 'markdown'].includes(draft.noteType) || !['simple', 'study', 'pro'].includes(draft.editorLevel) ||
      !Array.isArray(draft.tags) || draft.tags.length > 500 || !draft.tags.every((tag: string): boolean => typeof tag === 'string' && tag.length <= 200) ||
      !Array.isArray(draft.properties) || draft.properties.length > 500 ||
      !draft.properties.every((prop: NoteProperty): boolean => !!prop && typeof prop === 'object' && !Array.isArray(prop) &&
        Object.keys(prop).every((key: string): boolean => key === 'key' || key === 'propValue') &&
        typeof prop.key === 'string' && typeof prop.propValue === 'string') ||
      !Number.isInteger(draft.cursorStart) || !Number.isInteger(draft.cursorEnd) || draft.cursorStart < 0 || draft.cursorEnd < draft.cursorStart || draft.cursorEnd > draft.content.length ||
      typeof draft.sourceMode !== 'boolean' || !Number.isSafeInteger(draft.capturedAt) || draft.capturedAt < 0) { throw new Error('接续草稿格式无效，原有笔记未改动'); }
    return draft;
  }

  static same(note: NoteItem, draft: LexiContinuationDraft): boolean {
    return note.trashedAt === 0 && !note.sourceMissing && note.title.trim() === draft.title.trim() && note.content === draft.content &&
      note.notebook === draft.notebook && note.noteType === draft.noteType && note.editorLevel === draft.editorLevel &&
      JSON.stringify(note.tags) === JSON.stringify(draft.tags) && JSON.stringify(note.properties) === JSON.stringify(draft.properties);
  }

  static toNote(draft: LexiContinuationDraft, vaultId: string, projectId: string, copy: boolean): NoteItem {
    const note = new NoteItem(); note.id = `continued-${draft.transferId}`;
    note.vaultId = vaultId; note.projectId = projectId;
    note.title = (draft.title.trim() || '未命名笔记') + (copy ? '（接续草稿）' : '');
    note.content = draft.content; note.notebook = draft.notebook || '接续草稿';
    note.noteType = draft.noteType; note.editorLevel = draft.editorLevel;
    note.tags = draft.tags.slice(); note.properties = draft.properties.map((prop: NoteProperty): NoteProperty => new NoteProperty(prop.key, prop.propValue));
    return note;
  }
}
