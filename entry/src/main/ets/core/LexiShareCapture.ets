import { common, UIExtensionContentSession, Want } from '@kit.AbilityKit';
import { systemShare } from '@kit.ShareKit';
import { unifiedDataChannel } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { fileIo as fs, fileUri } from '@kit.CoreFileKit';
import { LexiFrontmatter } from './LexiFrontmatter';
import { NoteItem, NoteProperty, VaultItem } from './LexiModels';
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

  static fileNameFromUri(uri: string): string {
    if (!uri) { return ''; }
    const clean = uri.split('?')[0].replace(/\/+$/, '');
    const segment = clean.substring(clean.lastIndexOf('/') + 1);
    try { return decodeURIComponent(segment); }
    catch { return segment; }
  }

  static isMarkdownUriOrTitle(uri: string, title: string = '', utd: string = ''): boolean {
    if (utd === 'general.markdown') { return true; }
    const fileName = LexiShareCapture.fileNameFromUri(uri);
    return /\.(md|markdown)$/i.test(fileName) || /\.(md|markdown)$/i.test(title);
  }

  static readUriText(uri: string): string {
    if (!uri) { return ''; }
    const path = uri.startsWith('file:') ? new fileUri.FileUri(uri).path : uri;
    try {
      const file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      try {
        let stat = fs.statSync(file.fd);
        if (stat.size <= 0 && fs.accessSync(path)) {
          stat = fs.statSync(path);
        }
        if (stat.size > LexiShareContent.MAX_MARKDOWN_FILE_BYTES) {
          throw new Error('Markdown 文件超过 8 MB，请将它拆分后再打开');
        }
        if (stat.size <= 0) { return ''; }
        const buffer = new ArrayBuffer(stat.size);
        const readLen = fs.readSync(file.fd, buffer);
        return new util.TextDecoder('utf-8').decodeToString(new Uint8Array(buffer, 0, readLen)).replace(/^\uFEFF/, '');
      } finally {
        fs.closeSync(file);
      }
    } catch (error) {
      if ((error as Error).message && (error as Error).message.includes('8 MB')) {
        throw error as Error;
      }
      if (fs.accessSync(path)) {
        return (fs.readTextSync(path) || '').replace(/^\uFEFF/, '');
      }
      throw new Error('无法读取该 Markdown 文件内容');
    }
  }

  static writeUriText(uri: string, content: string): boolean {
    if (!uri) { return false; }
    try {
      const file = fs.openSync(uri, fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(file.fd, content);
        fs.fsyncSync(file.fd);
      } finally {
        fs.closeSync(file);
      }
      return true;
    } catch {
      return false;
    }
  }

  static recordFromSharedItem(item: systemShare.SharedRecord): LexiShareRecord {
    const record = new LexiShareRecord();
    record.utd = item.utd;
    record.title = item.title ?? '';
    record.description = item.description ?? '';
    record.content = item.content ?? '';
    record.fileUri = item.uri ?? '';
    if (record.fileUri && (!record.content || LexiShareCapture.isMarkdownUriOrTitle(record.fileUri, record.title, record.utd))) {
      const fileName = LexiShareCapture.fileNameFromUri(record.fileUri);
      if (!record.title && fileName) { record.title = fileName; }
      if (LexiShareCapture.isMarkdownUriOrTitle(record.fileUri, record.title, record.utd) ||
        record.utd === 'general.plain-text' || record.utd === 'general.text' || record.utd === 'general.file') {
        record.content = LexiShareCapture.readUriText(record.fileUri);
        record.isMarkdownFile = true;
        if (!record.utd || record.utd === 'general.file') { record.utd = 'general.markdown'; }
      }
    } else if (LexiShareCapture.isMarkdownUriOrTitle('', record.title, record.utd)) {
      record.isMarkdownFile = true;
    }
    return record;
  }

  private static decodeQueryParam(raw: string): string {
    try {
      return decodeURIComponent(raw.replace(/\+/g, '%20'));
    } catch {
      return '';
    }
  }

  static draftFromDirectWant(want: Want, sessionId: string): LexiShareDraft | undefined {
    const paramContent = typeof want.parameters?.lexinoteMarkdownContent === 'string'
      ? (want.parameters.lexinoteMarkdownContent as string)
      : '';
    const paramTitle = typeof want.parameters?.lexinoteMarkdownTitle === 'string'
      ? (want.parameters.lexinoteMarkdownTitle as string)
      : '';
    const uri = typeof want.uri === 'string' ? want.uri.trim() : '';
    let uriTitle = '';
    let uriContent = '';
    if (/^lexinote:\/\/import(?:\?|$)/i.test(uri)) {
      const qIdx = uri.indexOf('?');
      if (qIdx >= 0) {
        const pairs = uri.slice(qIdx + 1).split('&');
        for (const pair of pairs) {
          const eq = pair.indexOf('=');
          if (eq < 0) { continue; }
          const k = LexiShareCapture.decodeQueryParam(pair.slice(0, eq)).trim();
          const v = LexiShareCapture.decodeQueryParam(pair.slice(eq + 1));
          if (k === 'title' && !uriTitle) { uriTitle = v.trim(); }
          else if (k === 'content' && !uriContent) { uriContent = v; }
        }
      }
    }
    const finalContent = paramContent || uriContent;
    if (!finalContent.trim()) {
      return undefined;
    }
    const record = new LexiShareRecord();
    record.utd = 'general.markdown';
    record.title = (paramTitle || uriTitle || '词萤学习笔记').trim();
    record.content = finalContent;
    record.isMarkdownFile = true;
    return LexiShareContent.fromRecords([record], sessionId, Date.now());
  }

  static draftFromWantUri(want: Want, sessionId: string): LexiShareDraft | undefined {
    const uri = typeof want.uri === 'string' ? want.uri.trim() : '';
    if (!uri) { return undefined; }
    const record = new LexiShareRecord();
    record.fileUri = uri;
    record.utd = 'general.markdown';
    record.title = LexiShareCapture.fileNameFromUri(uri);
    record.content = LexiShareCapture.readUriText(uri);
    record.isMarkdownFile = true;
    return LexiShareContent.fromRecords([record], sessionId, Date.now());
  }

  static receiveWantMarkdown(want: Want): boolean {
    const sessionId = util.generateRandomUUID(true);
    try {
      const directMarkdownDraft = LexiShareCapture.draftFromDirectWant(want, sessionId);
      if (directMarkdownDraft) {
        AppStorage.setOrCreate<string>('lexiExternalMarkdownIncoming', JSON.stringify(directMarkdownDraft));
        return true;
      }
    } catch {}
    const incomingUri = typeof want.uri === 'string' ? want.uri.trim() : '';
    if (/^lexinote:\/\//i.test(incomingUri)) {
      return false;
    }
    try {
      const directDraft = LexiShareCapture.draftFromWantUri(want, sessionId);
      if (directDraft) {
        AppStorage.setOrCreate<string>('lexiExternalMarkdownIncoming', JSON.stringify(directDraft));
        return true;
      }
    } catch {}
    if (want.action === 'ohos.want.action.sendData' || want.action === 'ohos.want.action.viewData' || want.action === 'ohos.want.action.editData') {
      systemShare.getSharedData(want).then((data: systemShare.SharedData): void => {
        const records: LexiShareRecord[] = [];
        for (const item of data.getRecords()) {
          records.push(LexiShareCapture.recordFromSharedItem(item));
        }
        const draft = LexiShareContent.fromRecords(records, sessionId, Date.now());
        if (draft.isMarkdownFile || draft.quote) {
          draft.isMarkdownFile = true;
          AppStorage.setOrCreate<string>('lexiExternalMarkdownIncoming', JSON.stringify(draft));
        }
      }).catch((): void => {});
      return true;
    }
    return false;
  }

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
        records.push(LexiShareCapture.recordFromSharedItem(item));
      }
      const draft = LexiShareContent.fromRecords(records, sessionId, Date.now());
      storage.set<string>('lexiShareDraftJson', JSON.stringify(draft));
    }).catch((error: Error): void => {
      if (LexiShareCapture.sessionStorage.get(session) === storage) {
        try {
          const fallback = LexiShareCapture.draftFromWantUri(want, sessionId);
          if (fallback) {
            storage.set<string>('lexiShareDraftJson', JSON.stringify(fallback));
            return;
          }
        } catch {}
        storage.set<string>('lexiShareError', error.message || '无法读取分享内容，请重新选择 Markdown 文件、文本或网页链接');
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
    const maxBytes = draft && draft.isMarkdownFile ? LexiShareContent.MAX_MARKDOWN_FILE_BYTES : LexiShareContent.MAX_QUOTE_BYTES;
    return draft !== null && typeof draft.captureId === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(draft.captureId) &&
      typeof draft.receivedFingerprint === 'string' && /^[a-f0-9]{16}-\d+$/.test(draft.receivedFingerprint) &&
      typeof draft.title === 'string' && draft.title.length <= 160 && typeof draft.sourceUrl === 'string' && draft.sourceUrl.length <= 4096 &&
      typeof draft.quote === 'string' && LexiShareContent.bytes(draft.quote) <= maxBytes &&
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

  static detectEcosystemApp(markdown: string): string {
    if (!markdown) { return ''; }
    const parsed = LexiFrontmatter.parse(markdown);
    if (parsed.hasFrontmatter) {
      const sourceApp = (parsed.properties.find((p: NoteProperty): boolean => p.key === 'source_app')?.propValue || '').trim().toLowerCase();
      const sourceUri = (parsed.properties.find((p: NoteProperty): boolean => p.key === 'source_uri')?.propValue || '').trim().toLowerCase();
      if (sourceApp === 'lumikit' || sourceUri.startsWith('lumikit://')) {
        return 'LumiKit';
      }
      if (sourceApp === 'lexiglow' || sourceUri.startsWith('lexiglow://')) {
        return 'LexiGlow';
      }
    }
    if (markdown.includes('lumikit://')) {
      return 'LumiKit';
    }
    if (markdown.includes('lexiglow://')) {
      return 'LexiGlow';
    }
    return '';
  }

  static isLexiGlowMarkdown(markdown: string): boolean {
    return LexiShareCapture.detectEcosystemApp(markdown) === 'LexiGlow';
  }

  static isLumiKitMarkdown(markdown: string): boolean {
    return LexiShareCapture.detectEcosystemApp(markdown) === 'LumiKit';
  }

  static isEcosystemMarkdown(markdown: string): boolean {
    return LexiShareCapture.detectEcosystemApp(markdown) !== '';
  }

  static stripDuplicateLeadingH1(body: string, fallbackTitle: string): string[] {
    const lines = body.replace(/\r\n?/g, '\n').split('\n');
    let resolvedTitle = (fallbackTitle || '').trim();
    let firstNonEmpty = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().length > 0) {
        firstNonEmpty = i;
        break;
      }
    }
    if (firstNonEmpty >= 0) {
      const h1Match = /^#\s+(.+)$/.exec(lines[firstNonEmpty].trim());
      if (h1Match) {
        const h1Text = h1Match[1]
          .replace(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/, (_m: string, t: string, a: string): string => (a || t).trim())
          .trim();
        if (!resolvedTitle && h1Text) {
          resolvedTitle = h1Text;
        }
        if (!resolvedTitle || h1Text.toLowerCase() === resolvedTitle.toLowerCase() || h1Text.length > 0) {
          if (h1Text && (!resolvedTitle || resolvedTitle.includes('_'))) {
            resolvedTitle = h1Text;
          }
          lines.splice(firstNonEmpty, 1);
          while (firstNonEmpty < lines.length && lines[firstNonEmpty].trim().length === 0) {
            lines.splice(firstNonEmpty, 1);
          }
        }
      }
    }
    return [resolvedTitle || '联动导入笔记', lines.join('\n').trim()];
  }

  static async saveToEcosystemWorkspace(
    context: common.Context,
    draft: LexiShareDraft,
    explicitApp: string = ''
  ): Promise<NoteItem> {
    await LexiStorageService.init(context);
    const rawMarkdown = (draft.quote || '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
    const app = explicitApp || LexiShareCapture.detectEcosystemApp(rawMarkdown) || 'LexiGlow';
    const isLumiKit = app === 'LumiKit';
    const workspaceName = isLumiKit ? '集萤' : '词萤';
    const workspaceDesc = isLumiKit
      ? '集萤 LumiKit 资料采集、数据分析、物品与表单工作区'
      : '词萤 LexiGlow 词汇与英语精读工作区';
    const defaultNotebook = isLumiKit ? '资料摘录' : '英语精读';

    const allVaults = await LexiStorageService.getVaults(true);
    let targetVault = allVaults.find((v: VaultItem): boolean => {
      const name = v.name.trim();
      const lower = name.toLowerCase();
      return isLumiKit
        ? (name === '集萤' || name === '集萤 · LumiKit' || lower === 'lumikit')
        : (name === '词萤' || name === '词萤 · LexiGlow' || lower === 'lexiglow');
    });
    if (targetVault) {
      if (targetVault.archived) {
        await LexiStorageService.updateScope('workspace', targetVault.id, targetVault.name, targetVault.favorite, false);
        targetVault.archived = false;
      }
      await LexiStorageService.setActiveVaultId(targetVault.id);
      await LexiStorageService.setActiveProjectId(targetVault.id, '');
    } else {
      targetVault = await LexiStorageService.createVault(context, workspaceName, workspaceDesc);
      await LexiStorageService.setActiveProjectId(targetVault.id, '');
    }

    const parsed = LexiFrontmatter.parse(rawMarkdown);
    const titleProp = parsed.properties.find((p: NoteProperty): boolean => p.key === 'title' && !!p.propValue.trim());
    const notebookProp = parsed.properties.find((p: NoteProperty): boolean => p.key === 'notebook' && !!p.propValue.trim());
    const initialTitle = titleProp
      ? titleProp.propValue.trim()
      : (draft.title || '').replace(/\.(md|markdown)$/i, '').trim();
    const cleanedPair = LexiShareCapture.stripDuplicateLeadingH1(parsed.body, initialTitle);
    const noteTitle = cleanedPair[0].slice(0, 160);
    const cleanBody = cleanedPair[1];
    const targetNotebook = notebookProp ? notebookProp.propValue.trim().slice(0, 80) : defaultNotebook;

    const existingNotes = (await LexiStorageService.getNotes(targetVault.id)).filter(
      (n: NoteItem): boolean => n.trashedAt === 0 && !n.sourceMissing
    );
    const existing = existingNotes.find(
      (n: NoteItem): boolean =>
        n.title.trim().toLowerCase() === noteTitle.toLowerCase() &&
        n.notebook.trim() === targetNotebook
    );
    const note = existing ? existing : new NoteItem();
    note.vaultId = targetVault.id;
    note.projectId = '';
    note.title = noteTitle;
    note.notebook = targetNotebook;
    note.noteType = 'markdown';
    note.editorLevel = 'pro';
    note.tags = parsed.tags.slice();
    const props = parsed.properties.filter((p: NoteProperty): boolean => p.key !== 'title' && p.key !== 'notebook');
    props.unshift(new NoteProperty('notebook', targetNotebook));
    props.unshift(new NoteProperty('title', noteTitle));
    note.properties = props;
    note.content = parsed.hasFrontmatter
      ? `---\n${parsed.rawHeader}\n---\n${cleanBody}\n`
      : `${cleanBody}\n`;
    note.content = LexiFrontmatter.serialize(note);
    return LexiStorageService.saveNote(context, note);
  }

  static async saveToLexiGlowWorkspace(context: common.Context, draft: LexiShareDraft): Promise<NoteItem> {
    return LexiShareCapture.saveToEcosystemWorkspace(context, draft, 'LexiGlow');
  }

  static async saveToLumiKitWorkspace(context: common.Context, draft: LexiShareDraft): Promise<NoteItem> {
    return LexiShareCapture.saveToEcosystemWorkspace(context, draft, 'LumiKit');
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
    if (draft.isMarkdownFile && draft.fileUri) {
      LexiShareCapture.writeUriText(draft.fileUri, markdown);
    }
    const note = new NoteItem(); note.id = noteId; note.vaultId = vaultId; note.projectId = projectId;
    note.title = draft.title.trim().replace(/\.(md|markdown)$/i, '') || (draft.isMarkdownFile ? '未命名笔记' : '未命名剪藏');
    note.content = markdown;
    note.notebook = draft.isMarkdownFile ? '外部导入' : '剪藏收件箱';
    note.noteType = 'markdown'; note.editorLevel = 'pro';
    if (draft.isMarkdownFile) {
      LexiFrontmatter.apply(note, markdown);
      const notebookProp = note.properties.find((prop: NoteProperty): boolean => prop.key === 'notebook' && !!prop.propValue.trim());
      if (notebookProp) {
        note.notebook = notebookProp.propValue.trim().slice(0, 80);
      }
      const titleProp = note.properties.find((prop: NoteProperty): boolean => prop.key === 'title' && !!prop.propValue.trim());
      const fileStem = LexiShareCapture.fileNameFromUri(draft.fileUri).replace(/\.(md|markdown)$/i, '').trim();
      if (titleProp && (!draft.title.trim() || draft.title.trim() === fileStem)) {
        note.title = titleProp.propValue.trim().slice(0, 160);
      }
    } else {
      note.tags = ['剪藏'];
    }
    const existingProps = note.properties.filter((prop: NoteProperty): boolean =>
      prop.key !== 'capture_id' && prop.key !== 'capture_fingerprint' && prop.key !== 'captured_at' && prop.key !== 'source');
    existingProps.push(new NoteProperty('capture_id', draft.captureId));
    existingProps.push(new NoteProperty('capture_fingerprint', fingerprint));
    existingProps.push(new NoteProperty('captured_at', new Date(draft.receivedAt).toISOString()));
    const source = LexiShareContent.safeUrl(draft.sourceUrl);
    if (source) { existingProps.push(new NoteProperty('source', source)); }
    note.properties = existingProps;
    note.content = LexiFrontmatter.serialize(note);
    // Validation, deduplication and the Markdown write share one cross-process lock.
    const saved = await LexiStorageService.saveCapturedNote(context, note, allowDuplicate);
    const result = new LexiShareSaveResult(); result.note = saved.note;
    result.duplicate = saved.duplicate; result.alreadySaved = saved.alreadySaved;
    if (!result.duplicate) { try { fs.unlinkSync(LexiShareCapture.draftPath(context, draft.receivedFingerprint)); } catch {} }
    return result;
  }
}
