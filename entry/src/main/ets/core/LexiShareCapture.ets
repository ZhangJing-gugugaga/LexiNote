import { common, UIExtensionContentSession, Want } from '@kit.AbilityKit';
import { systemShare } from '@kit.ShareKit';
import { unifiedDataChannel } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { fileIo as fs } from '@kit.CoreFileKit';
import { NoteItem, NoteProperty } from './LexiModels';
import { LexiShareContent, LexiShareDraft, LexiShareRecord } from './LexiShareContent';
import { LexiStorageService } from './LexiStorageService';

class LexiShareUDMFValue {
  textContent?: string;
  htmlContent?: string;
  plainContent?: string;
  url?: string;
  description?: string;
  abstract?: string;
}

export class LexiShareSaveResult {
  note: NoteItem = new NoteItem();
  duplicate: boolean = false;
  alreadySaved: boolean = false;
}

export class LexiShareCapture {
  private static sessions: Map<string, UIExtensionContentSession> = new Map<string, UIExtensionContentSession>();
  private static sessionStorage: Map<UIExtensionContentSession, LocalStorage> = new Map<UIExtensionContentSession, LocalStorage>();
  private static saveQueue: Promise<void> = Promise.resolve();

  static open(want: Want, session: UIExtensionContentSession): void {
    // The system may repeat a lifecycle callback for the same native content session.
    if (LexiShareCapture.sessionStorage.has(session)) { return; }
    const sessionId = util.generateRandomUUID(true);
    const storage = new LocalStorage();
    storage.setOrCreate<string>('lexiShareSessionId', sessionId);
    storage.setOrCreate<string>('lexiShareDraftJson', '');
    storage.setOrCreate<string>('lexiShareError', '');
    LexiShareCapture.sessions.set(sessionId, session);
    LexiShareCapture.sessionStorage.set(session, storage);
    try { session.loadContent('pages/ShareCapturePage', storage); }
    catch { LexiShareCapture.release(session); return; }
    systemShare.getSharedData(want).then((data: systemShare.SharedData): void => {
      if (LexiShareCapture.sessionStorage.get(session) !== storage) { return; }
      const records: LexiShareRecord[] = [];
      const shared = data.getRecords();
      if (shared.length > LexiShareContent.MAX_RECORDS) { throw new Error('一次最多接收 32 条文本或链接'); }
      for (const item of shared) {
        const record = new LexiShareRecord(); record.utd = item.utd;
        record.content = item.content ?? ''; record.title = item.title ?? ''; record.description = item.description ?? '';
        records.push(record);
      }
      const draft = LexiShareContent.fromRecords(records, sessionId, Date.now());
      storage.set<string>('lexiShareDraftJson', JSON.stringify(draft));
    }).catch((error: Error): void => {
      if (LexiShareCapture.sessionStorage.get(session) === storage) {
        storage.set<string>('lexiShareError', error.message || '无法读取分享内容，请重新选择文本或网页链接');
      }
    });
  }

  static release(session: UIExtensionContentSession): void {
    const storage = LexiShareCapture.sessionStorage.get(session);
    if (storage) {
      const id = storage.get<string>('lexiShareSessionId');
      if (id) { LexiShareCapture.sessions.delete(id); }
    }
    LexiShareCapture.sessionStorage.delete(session);
  }

  static async close(sessionId: string, saved: boolean): Promise<void> {
    const session = LexiShareCapture.sessions.get(sessionId);
    if (!session) { throw new Error('分享会话已关闭，草稿仍保存在本机'); }
    await session.terminateSelfWithResult({ resultCode: saved ? systemShare.ShareAbilityResultCode.CLOSE : systemShare.ShareAbilityResultCode.BACK });
  }

  /** Adapter for native UDMF plain-text, HTML and hyperlink records, including multi-entry records. */
  static fromUnifiedData(data: unifiedDataChannel.UnifiedData[], captureId: string): LexiShareDraft {
    const records: LexiShareRecord[] = [];
    for (const item of data) {
      for (const native of item.getRecords()) {
        const types = native.getTypes();
        for (const type of types) {
          if (!['general.plain-text', 'general.html', 'general.hyperlink', 'general.text'].includes(type)) { continue; }
          const entry = native.getEntry(type);
          const record = new LexiShareRecord(); record.utd = type;
          if (typeof entry === 'string') { record.content = entry; }
          else if (typeof entry === 'object' && entry !== null) {
            const fields = entry as LexiShareUDMFValue;
            if (type === 'general.hyperlink') {
              record.content = typeof fields.url === 'string' ? fields.url : '';
              record.title = typeof fields.description === 'string' ? fields.description : '';
            } else if (type === 'general.html') {
              record.content = typeof fields.htmlContent === 'string' ? fields.htmlContent : '';
              record.plainContent = typeof fields.plainContent === 'string' ? fields.plainContent : '';
            } else { record.content = typeof fields.textContent === 'string' ? fields.textContent : ''; }
          }
          records.push(record);
          if (records.length > LexiShareContent.MAX_RECORDS) { throw new Error('一次最多接收 32 条文本或链接'); }
        }
      }
    }
    return LexiShareContent.fromRecords(records, captureId, Date.now());
  }

  private static draftPath(context: common.Context, fingerprint: string): string {
    if (!/^[a-f0-9]{16}-\d+$/.test(fingerprint)) { throw new Error('剪藏草稿标识无效'); }
    return `${context.filesDir}/share-capture/${fingerprint}.json`;
  }

  private static draftShape(draft: LexiShareDraft): boolean {
    return draft !== null && typeof draft.captureId === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(draft.captureId) &&
      typeof draft.receivedFingerprint === 'string' && /^[a-f0-9]{16}-\d+$/.test(draft.receivedFingerprint) &&
      typeof draft.title === 'string' && draft.title.length <= 160 && typeof draft.sourceUrl === 'string' && draft.sourceUrl.length <= 4096 &&
      typeof draft.quote === 'string' && LexiShareContent.bytes(draft.quote) <= LexiShareContent.MAX_QUOTE_BYTES &&
      typeof draft.receivedAt === 'number' && Number.isFinite(draft.receivedAt) && draft.receivedAt > 0;
  }

  static async restoreDraft(context: common.Context, incoming: LexiShareDraft): Promise<LexiShareDraft> {
    const path = LexiShareCapture.draftPath(context, incoming.receivedFingerprint);
    if (fs.accessSync(path)) {
      try {
        if (fs.statSync(path).size <= 512 * 1024) {
          const draft = JSON.parse(fs.readTextSync(path)) as LexiShareDraft;
          if (LexiShareCapture.draftShape(draft) && draft.receivedFingerprint === incoming.receivedFingerprint) {
            draft.notice = '已恢复上次未保存的剪藏草稿。'; return draft;
          }
        }
      } catch {}
    }
    return incoming;
  }

  static async stashDraft(context: common.Context, draft: LexiShareDraft): Promise<void> {
    if (!LexiShareCapture.draftShape(draft)) { throw new Error('草稿过大或格式无效，当前编辑仍保留'); }
    const directory = `${context.filesDir}/share-capture`;
    if (!fs.accessSync(directory)) { fs.mkdirSync(directory, true); }
    const path = LexiShareCapture.draftPath(context, draft.receivedFingerprint);
    const temp = `${path}.tmp`;
    const file = fs.openSync(temp, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try { fs.writeSync(file.fd, JSON.stringify(draft)); fs.fsyncSync(file.fd); }
    finally { fs.closeSync(file); }
    fs.renameSync(temp, path);
  }

  static async save(context: common.Context, draft: LexiShareDraft, vaultId: string, projectId: string, allowDuplicate: boolean = false): Promise<LexiShareSaveResult> {
    const snapshot = JSON.parse(JSON.stringify(draft)) as LexiShareDraft;
    const operation = LexiShareCapture.saveQueue.then(async (): Promise<LexiShareSaveResult> => {
      return LexiShareCapture.saveSnapshot(context, snapshot, vaultId, projectId, allowDuplicate);
    });
    LexiShareCapture.saveQueue = operation.then((): void => {}).catch((): void => {});
    return operation;
  }

  private static async saveSnapshot(context: common.Context, draft: LexiShareDraft, vaultId: string, projectId: string, allowDuplicate: boolean): Promise<LexiShareSaveResult> {
    const markdown = LexiShareContent.markdown(draft);
    await LexiStorageService.init(context);
    const noteId = `clip-${draft.captureId}`;
    const fingerprint = LexiShareContent.fingerprint(markdown);
    // Keep the editable draft durable before any file or database mutation.
    await LexiShareCapture.stashDraft(context, draft);
    const note = new NoteItem(); note.id = noteId; note.vaultId = vaultId; note.projectId = projectId;
    note.title = draft.title.trim() || '未命名剪藏'; note.content = markdown;
    note.notebook = '剪藏收件箱'; note.noteType = 'markdown'; note.editorLevel = 'pro'; note.tags = ['剪藏'];
    note.properties = [new NoteProperty('capture_id', draft.captureId), new NoteProperty('capture_fingerprint', fingerprint),
      new NoteProperty('captured_at', new Date(draft.receivedAt).toISOString())];
    const source = LexiShareContent.safeUrl(draft.sourceUrl);
    if (source) { note.properties.push(new NoteProperty('source', source)); }
    // Validation, deduplication and the Markdown write share one cross-process lock.
    const saved = await LexiStorageService.saveCapturedNote(context, note, allowDuplicate);
    const result = new LexiShareSaveResult(); result.note = saved.note;
    result.duplicate = saved.duplicate; result.alreadySaved = saved.alreadySaved;
    if (!result.duplicate) { try { fs.unlinkSync(LexiShareCapture.draftPath(context, draft.receivedFingerprint)); } catch {} }
    return result;
  }
}
