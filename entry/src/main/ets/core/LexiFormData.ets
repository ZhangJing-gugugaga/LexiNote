import { NoteItem } from './LexiModels';
import { LexiFrontmatter } from './LexiFrontmatter';
import { LexiTemplates } from './LexiTemplates';

export class LexiFormTask {
  noteId: string = '';
  lineIndex: number = -1;
  text: string = '';
  expectedLine: string = '';
  checked: boolean = false;
}

export class LexiFormSnapshot {
  version: number = 1;
  vaultId: string = '';
  dateKey: string = '';
  updatedAt: number = 0;
  noteCount: number = 0;
  dailyNoteId: string = '';
  pendingCount: number = 0;
  tasks: LexiFormTask[] = [];
  reviewNoteId: string = '';
  reviewTitle: string = '';
  reviewSnippet: string = '';
}

export class LexiFormRequest {
  lexiFormAction: string = '';
  vaultId: string = '';
  noteId: string = '';
  lineIndex: number = -1;
  expectedLine: string = '';
  checked: boolean = false;
  requestId: string = '';
}

// Only primitive fields are bound to the sandboxed ArkTS card pages.
export class LexiFormBinding {
  taskStatus: string = '点选待办即可保存';
  vaultId: string = '';
  dateKey: string = '';
  statusText: string = '打开应用以同步本机笔记';
  noteCount: number = 0;
  dailyNoteId: string = '';
  pendingCount: number = 0;
  todayHint: string = '打开应用同步今日待办';
  task1Text: string = '';
  task1NoteId: string = '';
  task1LineIndex: number = -1;
  task1ExpectedLine: string = '';
  task1Checked: boolean = false;
  task2Text: string = '';
  task2NoteId: string = '';
  task2LineIndex: number = -1;
  task2ExpectedLine: string = '';
  task2Checked: boolean = false;
  reviewNoteId: string = '';
  reviewTitle: string = '回顾旧笔记';
  reviewSnippet: string = '积累笔记后，在这里重新遇见旧想法。';
}

export class LexiFormData {
  private static validId(id: string): boolean { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id); }

  private static title(note: NoteItem): string {
    return note.title.trim() || LexiFrontmatter.parse(note.content).body.replace(/^[#>*\-\s]+/, '').trim().slice(0, 30) || '未命名笔记';
  }

  private static taskRows(note: NoteItem): LexiFormTask[] {
    const lines = note.content.split('\n'); const tasks: LexiFormTask[] = [];
    const start = LexiFrontmatter.parse(note.content).bodyLineOffset;
    let fence = ''; let fenceLength = 0;
    for (let index = start; index < lines.length; index++) {
      const line = lines[index]; const delimiter = /^\s*(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r$/, ''));
      if (delimiter) {
        if (!fence) { fence = delimiter[1][0]; fenceLength = delimiter[1].length; }
        else if (delimiter[1][0] === fence && delimiter[1].length >= fenceLength && !delimiter[2].trim()) { fence = ''; }
        continue;
      }
      if (fence) { continue; }
      const matched = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s+)(.*)$/.exec(line.replace(/\r$/, ''));
      if (!matched || !matched[4].trim()) { continue; }
      const task = new LexiFormTask(); task.noteId = note.id; task.lineIndex = index;
      task.expectedLine = line; task.checked = matched[2].toLowerCase() === 'x'; task.text = matched[4].trim().slice(0, 90);
      tasks.push(task);
    }
    return tasks;
  }

  static build(notes: NoteItem[], vaultId: string, now: Date = new Date()): LexiFormSnapshot {
    const snapshot = new LexiFormSnapshot(); snapshot.vaultId = vaultId;
    snapshot.dateKey = LexiTemplates.dateKey(now); snapshot.updatedAt = now.getTime();
    const active = notes.filter((note: NoteItem): boolean => note.vaultId === vaultId && note.trashedAt === 0 && !note.sourceMissing);
    snapshot.noteCount = active.length;
    const daily = active.filter((note: NoteItem): boolean => note.title === snapshot.dateKey && note.notebook === '日常记录 / 日记')
      .sort((first: NoteItem, second: NoteItem): number => second.updatedAt - first.updatedAt)[0];
    if (daily) {
      snapshot.dailyNoteId = daily.id; const tasks = LexiFormData.taskRows(daily);
      snapshot.pendingCount = tasks.filter((task: LexiFormTask): boolean => !task.checked).length;
      snapshot.tasks = tasks.filter((task: LexiFormTask): boolean => task.expectedLine.length <= 4000)
        .sort((first: LexiFormTask, second: LexiFormTask): number => Number(first.checked) - Number(second.checked) || first.lineIndex - second.lineIndex).slice(0, 2);
    }
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const older = active.filter((note: NoteItem): boolean => note.id !== snapshot.dailyNoteId && note.createdAt < today &&
      LexiFrontmatter.parse(note.content).body.trim().length > 0).sort((first: NoteItem, second: NoteItem): number => first.id.localeCompare(second.id));
    if (older.length > 0) {
      let seed = 0; const key = `${snapshot.dateKey}:${vaultId}`;
      for (let index = 0; index < key.length; index++) { seed = (seed * 31 + key.charCodeAt(index)) >>> 0; }
      const review = older[seed % older.length]; snapshot.reviewNoteId = review.id;
      snapshot.reviewTitle = LexiFormData.title(review);
      snapshot.reviewSnippet = LexiFrontmatter.parse(review.content).body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
        (_match: string, target: string, display: string): string => display || target)
        .replace(/^[#>*\-\s]+/gm, '').replace(/\s+/g, ' ').trim().slice(0, 100);
    }
    return snapshot;
  }

  static decode(raw: string): LexiFormSnapshot {
    const snapshot = JSON.parse(raw) as LexiFormSnapshot;
    if (!snapshot || snapshot.version !== 1 || typeof snapshot.vaultId !== 'string' || typeof snapshot.dateKey !== 'string' ||
      !Number.isFinite(snapshot.updatedAt) || snapshot.updatedAt < 0 || !Number.isInteger(snapshot.noteCount) || snapshot.noteCount < 0 ||
      typeof snapshot.dailyNoteId !== 'string' || !Number.isInteger(snapshot.pendingCount) || snapshot.pendingCount < 0 ||
      !Array.isArray(snapshot.tasks) || snapshot.tasks.length > 2 || typeof snapshot.reviewNoteId !== 'string' ||
      typeof snapshot.reviewTitle !== 'string' || typeof snapshot.reviewSnippet !== 'string') { throw new Error('卡片快照格式无效'); }
    for (const task of snapshot.tasks) {
      if (!task || !LexiFormData.validId(task.noteId) || !Number.isInteger(task.lineIndex) || task.lineIndex < 0 ||
        typeof task.text !== 'string' || typeof task.expectedLine !== 'string' || task.expectedLine.length > 4000 || typeof task.checked !== 'boolean') {
        throw new Error('卡片待办快照格式无效');
      }
    }
    return snapshot;
  }

  static binding(snapshot: LexiFormSnapshot, now: Date = new Date()): LexiFormBinding {
    const result = new LexiFormBinding(); result.vaultId = snapshot.vaultId; result.noteCount = snapshot.noteCount;
    result.dateKey = LexiTemplates.dateKey(now);
    if (!snapshot.updatedAt) { return result; }
    result.statusText = snapshot.dateKey === result.dateKey ? `已同步 ${snapshot.noteCount} 篇本机笔记` : '日期已更新，打开今日笔记同步';
    result.todayHint = snapshot.dateKey === result.dateKey ? (snapshot.dailyNoteId ? '今天还没有待办' : '打开今日笔记开始记录') : '打开今日笔记更新待办';
    // Old-day task rows must never be displayed as today's tasks.
    if (snapshot.dateKey === result.dateKey) {
      result.dailyNoteId = snapshot.dailyNoteId; result.pendingCount = snapshot.pendingCount;
      const first = snapshot.tasks[0]; const second = snapshot.tasks[1];
      if (first) {
        result.task1Text = first.text; result.task1NoteId = first.noteId; result.task1LineIndex = first.lineIndex;
        result.task1ExpectedLine = first.expectedLine; result.task1Checked = first.checked;
      }
      if (second) {
        result.task2Text = second.text; result.task2NoteId = second.noteId; result.task2LineIndex = second.lineIndex;
        result.task2ExpectedLine = second.expectedLine; result.task2Checked = second.checked;
      }
    }
    if (snapshot.reviewNoteId) {
      result.reviewNoteId = snapshot.reviewNoteId; result.reviewTitle = snapshot.reviewTitle; result.reviewSnippet = snapshot.reviewSnippet;
    }
    return result;
  }

  static decodeRequest(raw: string): LexiFormRequest | undefined {
    let request: LexiFormRequest;
    try { request = JSON.parse(raw) as LexiFormRequest; } catch (_) { return undefined; }
    if (!request || !['quick', 'voice', 'daily', 'open-note', 'toggle-todo'].includes(request.lexiFormAction) ||
      typeof request.vaultId !== 'string' || (request.vaultId !== '' && !LexiFormData.validId(request.vaultId)) ||
      typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 128) { return undefined; }
    if (request.lexiFormAction === 'open-note' || request.lexiFormAction === 'toggle-todo') {
      if (!LexiFormData.validId(request.noteId)) { return undefined; }
    }
    if (request.lexiFormAction === 'toggle-todo' && (!Number.isInteger(request.lineIndex) || request.lineIndex < 0 ||
      typeof request.expectedLine !== 'string' || request.expectedLine.length > 4000 || typeof request.checked !== 'boolean')) { return undefined; }
    return request;
  }

  static applyTask(note: NoteItem, request: LexiFormRequest): NoteItem {
    if (request.lexiFormAction !== 'toggle-todo' || note.id !== request.noteId || note.vaultId !== request.vaultId || note.trashedAt > 0 || note.sourceMissing ||
      !Number.isInteger(request.lineIndex) || request.lineIndex < 0 || typeof request.checked !== 'boolean' ||
      typeof request.expectedLine !== 'string' || request.expectedLine.length > 4000) {
      throw new Error('卡片指向的笔记已变化，请打开笔记确认');
    }
    const lines = note.content.split('\n'); const current = lines[request.lineIndex];
    if (typeof current !== 'string' || current !== request.expectedLine ||
      !LexiFormData.taskRows(note).some((task: LexiFormTask): boolean => task.lineIndex === request.lineIndex && task.expectedLine === current)) {
      throw new Error('待办内容已更新，未修改其他行，请打开笔记确认');
    }
    const copy = JSON.parse(JSON.stringify(note)) as NoteItem;
    lines[request.lineIndex] = current.replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[)[ xX](\]\s+)/, `$1${request.checked ? 'x' : ' '}$2`);
    copy.content = lines.join('\n'); return copy;
  }
}
