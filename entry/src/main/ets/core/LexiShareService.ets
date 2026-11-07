import { common } from '@kit.AbilityKit';
import { uniformTypeDescriptor as utd } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { window } from '@kit.ArkUI';
import { BusinessError, deviceInfo } from '@kit.BasicServicesKit';
import { fileIo as fs, fileUri } from '@kit.CoreFileKit';
import { harmonyShare, systemShare } from '@kit.ShareKit';
import { LexiContinuationSession } from './LexiContinuationSession';
import { LexiFrontmatter } from './LexiFrontmatter';
import { NoteItem, NoteProperty } from './LexiModels';
import { LexiShareCapture } from './LexiShareCapture';
import { LexiShareContent, LexiShareRecord } from './LexiShareContent';
import { LexiStorageService } from './LexiStorageService';
import { MarkdownEngine } from './MarkdownEngine';

export class LexiSharableNoteSnapshot {
  noteId: string = '';
  title: string = '';
  content: string = '';
  notebook: string = '';
  tags: string[] = [];
  properties: NoteProperty[] = [];
  filePath: string = '';
}

class LexiWindowShareBinding {
  context: common.UIAbilityContext;
  windowId: number;
  is2in1: boolean;
  knockCallback: (target: harmonyShare.SharableTarget) => void;
  receiveCallback: (receiveTarget: harmonyShare.ReceivableTarget) => void;

  constructor(
    context: common.UIAbilityContext,
    windowId: number,
    is2in1: boolean,
    knockCallback: (target: harmonyShare.SharableTarget) => void,
    receiveCallback: (receiveTarget: harmonyShare.ReceivableTarget) => void
  ) {
    this.context = context;
    this.windowId = windowId;
    this.is2in1 = is2in1;
    this.knockCallback = knockCallback;
    this.receiveCallback = receiveCallback;
  }
}

/**
 * System file sharing (ShareController) and Knock Share (harmonyShare) integration.
 */
export class LexiShareService {
  private static activeOwner: string = '';
  private static activeGetter: (() => LexiSharableNoteSnapshot | undefined) | undefined = undefined;
  private static windowBindings: Map<string, LexiWindowShareBinding> = new Map<string, LexiWindowShareBinding>();
  private static lastKnockCoordX: number = -1;
  private static lastKnockCoordY: number = -1;

  static sanitizeFileName(rawTitle: string): string {
    const cleaned = (rawTitle || '')
      .replace(/\.(md|markdown)$/i, '')
      .replace(/[/\\:*?"<>|\r\n\u0000-\u001f]+/g, '_')
      .replace(/^[.\s_]+|[.\s_]+$/g, '')
      .slice(0, 80);
    return `${cleaned || '未命名笔记'}.md`;
  }

  static resolveMarkdownUtd(): string {
    try {
      const resolved = utd.getUniformDataTypeByFilenameExtension('.md');
      if (resolved && resolved.trim().length > 0) {
        return resolved;
      }
    } catch {}
    return 'general.markdown';
  }

  static writeShareSandboxFile(context: common.Context, title: string, markdownContent: string): string {
    const baseDir = context.cacheDir || context.filesDir;
    const shareDir = `${baseDir}/share-out`;
    if (!fs.accessSync(shareDir)) {
      fs.mkdirSync(shareDir, true);
    }
    const fileName = LexiShareService.sanitizeFileName(title);
    const fullPath = `${shareDir}/${fileName}`;
    const body = markdownContent.replace(/\r\n?/g, '\n');
    const normalized = body.endsWith('\n') || body.length === 0 ? body : `${body}\n`;
    const file = fs.openSync(fullPath, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(file.fd, normalized);
      fs.fsyncSync(file.fd);
    } finally {
      fs.closeSync(file);
    }
    return fullPath;
  }

  static buildNoteMarkdown(snapshot: LexiSharableNoteSnapshot): string {
    const note = new NoteItem();
    note.id = snapshot.noteId || 'shared-note';
    note.title = snapshot.title.trim() || '未命名笔记';
    note.content = snapshot.content;
    note.notebook = snapshot.notebook || '笔记';
    note.tags = snapshot.tags.slice();
    note.properties = snapshot.properties.map(
      (prop: NoteProperty): NoteProperty => new NoteProperty(prop.key, prop.propValue)
    );
    return LexiFrontmatter.serialize(note);
  }

  static createFileSharedData(context: common.Context, snapshot: LexiSharableNoteSnapshot): systemShare.SharedData {
    const displayTitle = snapshot.title.trim() || '未命名笔记';
    const markdown = LexiShareService.buildNoteMarkdown(snapshot);
    const filePath = LexiShareService.writeShareSandboxFile(context, displayTitle, markdown);
    const uri = fileUri.getUriFromPath(filePath);
    const record: systemShare.SharedRecord = {
      utd: LexiShareService.resolveMarkdownUtd(),
      uri: uri,
      title: `${displayTitle}.md`,
      label: 'FILE',
      description: snapshot.notebook ? `知萤笔记 · ${snapshot.notebook}` : '知萤 LexiNote Markdown 笔记'
    };
    return new systemShare.SharedData(record);
  }

  static async showSystemSharePanel(
    context: common.UIAbilityContext,
    snapshot: LexiSharableNoteSnapshot,
    anchorId: string = ''
  ): Promise<void> {
    const shareData = LexiShareService.createFileSharedData(context, snapshot);
    const controller = new systemShare.ShareController(shareData);
    const options: systemShare.ShareControllerOptions = {
      previewMode: systemShare.SharePreviewMode.DEFAULT,
      selectionMode: systemShare.SelectionMode.SINGLE
    };
    if (anchorId && anchorId.trim().length > 0) {
      options.anchor = anchorId.trim();
    }
    await controller.show(context, options);
  }

  static async shareNoteById(
    context: common.UIAbilityContext,
    noteId: string,
    anchorId: string = ''
  ): Promise<void> {
    await LexiStorageService.init(context);
    const note = await LexiStorageService.getNoteById(noteId);
    if (!note || note.trashedAt > 0) {
      throw new Error('未找到可分享的笔记文件');
    }
    const snapshot = new LexiSharableNoteSnapshot();
    snapshot.noteId = note.id;
    snapshot.title = MarkdownEngine.displayTitle(note);
    snapshot.content = note.content;
    snapshot.notebook = note.notebook;
    snapshot.tags = note.tags.slice();
    snapshot.properties = note.properties.map(
      (prop: NoteProperty): NoteProperty => new NoteProperty(prop.key, prop.propValue)
    );
    snapshot.filePath = note.path;
    await LexiShareService.showSystemSharePanel(context, snapshot, anchorId);
  }

  static async shareDraftNote(
    context: common.UIAbilityContext,
    note: NoteItem,
    titleText: string,
    contentText: string,
    notebookText: string,
    anchorId: string = ''
  ): Promise<void> {
    const snapshot = new LexiSharableNoteSnapshot();
    snapshot.noteId = note.id;
    snapshot.title = titleText.trim() || MarkdownEngine.displayTitle(note);
    snapshot.content = contentText;
    snapshot.notebook = notebookText.trim() || note.notebook || '笔记';
    snapshot.tags = note.tags.slice();
    snapshot.properties = note.properties.map(
      (prop: NoteProperty): NoteProperty => new NoteProperty(prop.key, prop.propValue)
    );
    snapshot.filePath = note.path;
    await LexiShareService.showSystemSharePanel(context, snapshot, anchorId);
  }

  static activateKnockSource(owner: string, getter: () => LexiSharableNoteSnapshot | undefined): void {
    LexiShareService.activeOwner = owner;
    LexiShareService.activeGetter = getter;
  }

  static deactivateKnockSource(owner: string): void {
    if (LexiShareService.activeOwner !== owner) {
      return;
    }
    LexiShareService.activeOwner = '';
    LexiShareService.activeGetter = undefined;
  }

  static resolveActiveSharable(): LexiSharableNoteSnapshot | undefined {
    if (LexiShareService.activeGetter) {
      try {
        const active = LexiShareService.activeGetter();
        if (active && (active.title.trim().length > 0 || active.content.trim().length > 0)) {
          return active;
        }
      } catch {}
    }
    try {
      const draft = LexiContinuationSession.current();
      if (draft && (draft.title.trim().length > 0 || draft.content.trim().length > 0)) {
        const snapshot = new LexiSharableNoteSnapshot();
        snapshot.noteId = draft.sourceNoteId;
        snapshot.title = draft.title.trim() || '未命名笔记';
        snapshot.content = draft.content;
        snapshot.notebook = draft.notebook || '笔记';
        snapshot.tags = draft.tags.slice();
        snapshot.properties = draft.properties.map(
          (prop: NoteProperty): NoteProperty => new NoteProperty(prop.key, prop.propValue)
        );
        return snapshot;
      }
    } catch {}
    return undefined;
  }

  static handleKnockShare(context: common.Context, target: harmonyShare.SharableTarget): void {
    try {
      if (deviceInfo.deviceType === '2in1' && deviceInfo.apiAvailable('26.0.0')) {
        const info = target.getInfo();
        if (info && info.coordinate) {
          LexiShareService.lastKnockCoordX = info.coordinate.screenX;
          LexiShareService.lastKnockCoordY = info.coordinate.screenY;
        }
      }
    } catch {}

    const active = LexiShareService.resolveActiveSharable();
    if (!active) {
      try {
        target.clarifyNonShare({ message: '请先打开一篇笔记再使用碰一碰分享' }).catch((): void => {});
      } catch {
        try {
          target.reject(harmonyShare.SharableErrorCode.NO_CONTENT_ERROR).catch((): void => {});
        } catch {}
      }
      return;
    }

    try {
      const shareData = LexiShareService.createFileSharedData(context, active);
      target.share(shareData).catch((): void => {});
    } catch {
      try {
        target.reject(harmonyShare.SharableErrorCode.NO_CONTENT_ERROR).catch((): void => {});
      } catch {}
    }
  }

  static handleKnockDataReceive(context: common.Context, receiveTarget: harmonyShare.ReceivableTarget): void {
    try {
      if (deviceInfo.deviceType === '2in1' && deviceInfo.apiAvailable('26.0.0')) {
        const info = receiveTarget.getInfo();
        if (info && info.coordinate) {
          LexiShareService.lastKnockCoordX = info.coordinate.screenX;
          LexiShareService.lastKnockCoordY = info.coordinate.screenY;
        }
      }
    } catch {}

    try {
      const receiveDir = `${context.filesDir}/knock-receive`;
      if (!fs.accessSync(receiveDir)) {
        fs.mkdirSync(receiveDir, true);
      }
      const receiveUri = fileUri.getUriFromPath(receiveDir);
      receiveTarget.receive(receiveUri, {
        onDataReceived: (shareData: systemShare.SharedData): void => {
          try {
            const records: LexiShareRecord[] = [];
            for (const item of shareData.getRecords()) {
              records.push(LexiShareCapture.recordFromSharedItem(item));
            }
            if (records.length === 0) {
              return;
            }
            const draft = LexiShareContent.fromRecords(records, util.generateRandomUUID(true), Date.now());
            draft.isMarkdownFile = true;
            AppStorage.setOrCreate<string>('lexiExternalMarkdownIncoming', JSON.stringify(draft));
          } catch {}
        },
        onResult: (_resultCode: harmonyShare.ShareResultCode): void => {}
      }).catch((): void => {});
    } catch {
      try {
        receiveTarget.reject(harmonyShare.ReceivableErrorCode.NO_RECEIVABLE_ERROR).catch((): void => {});
      } catch {}
    }
  }

  static registerWindow(key: string, context: common.UIAbilityContext, mainWindow: window.Window | undefined): void {
    if (!mainWindow || !canIUse('SystemCapability.Collaboration.HarmonyShare')) {
      return;
    }
    LexiShareService.unregisterWindow(key);
    try {
      const windowId = mainWindow.getWindowProperties().id;
      const is2in1 = deviceInfo.deviceType === '2in1';
      const knockCallback = (target: harmonyShare.SharableTarget): void => {
        LexiShareService.handleKnockShare(context, target);
      };
      const receiveCallback = (receiveTarget: harmonyShare.ReceivableTarget): void => {
        LexiShareService.handleKnockDataReceive(context, receiveTarget);
      };
      const binding = new LexiWindowShareBinding(context, windowId, is2in1, knockCallback, receiveCallback);
      if (is2in1) {
        harmonyShare.on('knockShare', { windowId: windowId }, knockCallback);
        const capabilities: harmonyShare.RecvCapability[] = [
          { utd: LexiShareService.resolveMarkdownUtd(), maxSupportedCount: 10 },
          { utd: utd.UniformDataType.PLAIN_TEXT, maxSupportedCount: 10 },
          { utd: utd.UniformDataType.TEXT, maxSupportedCount: 10 },
          { utd: utd.UniformDataType.FILE, maxSupportedCount: 10 }
        ];
        harmonyShare.on('dataReceive', { windowId: windowId, capabilities: capabilities }, receiveCallback);
      } else {
        harmonyShare.on('knockShare', knockCallback);
      }
      LexiShareService.windowBindings.set(key, binding);
    } catch (_error) {
      const err = _error as BusinessError;
      if (err && err.code) {
        // Ignore unsupported device/emulator capability errors gracefully
      }
    }
  }

  static unregisterWindow(key: string): void {
    const binding = LexiShareService.windowBindings.get(key);
    if (!binding) {
      return;
    }
    LexiShareService.windowBindings.delete(key);
    if (!canIUse('SystemCapability.Collaboration.HarmonyShare')) {
      return;
    }
    try {
      if (binding.is2in1) {
        harmonyShare.off('knockShare', { windowId: binding.windowId }, binding.knockCallback);
      } else {
        harmonyShare.off('knockShare', binding.knockCallback);
      }
    } catch {}
    if (binding.is2in1) {
      try {
        const capabilities: harmonyShare.RecvCapability[] = [
          { utd: LexiShareService.resolveMarkdownUtd(), maxSupportedCount: 10 },
          { utd: utd.UniformDataType.PLAIN_TEXT, maxSupportedCount: 10 },
          { utd: utd.UniformDataType.TEXT, maxSupportedCount: 10 },
          { utd: utd.UniformDataType.FILE, maxSupportedCount: 10 }
        ];
        harmonyShare.off(
          'dataReceive',
          { windowId: binding.windowId, capabilities: capabilities },
          binding.receiveCallback
        );
      } catch {}
    }
  }
}
