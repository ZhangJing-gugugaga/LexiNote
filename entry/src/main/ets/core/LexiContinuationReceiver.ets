import { common } from '@kit.AbilityKit';
import { LexiProject, NoteItem, VaultItem } from './LexiModels';
import { LexiContinuationData, LexiContinuationDraft } from './LexiContinuationData';
import { LexiStorageService as Storage } from './LexiStorageService';

export class LexiReceivedContinuation {
  note: NoteItem = new NoteItem();
  draft: LexiContinuationDraft = new LexiContinuationDraft();
  conflictCopy: boolean = false;
}

export class LexiContinuationReceiver {
  private static pending: Promise<void> = Promise.resolve();

  private static available(note: NoteItem, vaults: VaultItem[], projects: LexiProject[]): boolean {
    return !note.sourceMissing && vaults.some((vault: VaultItem): boolean => !vault.archived && vault.id === note.vaultId) &&
      (!note.projectId || projects.some((project: LexiProject): boolean => !project.archived &&
        project.id === note.projectId && project.vaultId === note.vaultId));
  }

  static async receive(context: common.Context, raw: string): Promise<LexiReceivedContinuation> {
    const draft = LexiContinuationData.decode(raw);
    const operation = LexiContinuationReceiver.pending.then(async (): Promise<LexiReceivedContinuation> => {
      const result = new LexiReceivedContinuation(); result.draft = draft;
      const key = `continuation:${draft.transferId}`;
      const mapped = await Storage.getRawValue(key, '');
      if (mapped && !/^[A-Za-z0-9_-]{1,128}$/.test(mapped)) { throw new Error('接续接收记录格式无效，未修改原有笔记'); }
      const vaults = await Storage.getVaults();
      const projects = await Storage.getProjects('', false);
      const mappedNote = mapped ? await Storage.getNoteById(mapped) : undefined;
      const already = mappedNote || await Storage.getNoteById(`continued-${draft.transferId}`);
      if (already) {
        if (already.trashedAt > 0) { throw new Error('这份接续草稿已在回收站中，未重复创建'); }
        if (!LexiContinuationReceiver.available(already, vaults, projects)) { throw new Error('接续笔记所在工作区或项目暂不可用，原内容未修改'); }
        // A note can be durable even if writing its transfer mapping failed.
        // Repair that mapping without saving the body or overwriting local edits.
        if (mapped !== already.id) { await Storage.setRawValue(key, already.id); }
        result.note = already; return result;
      }
      if (mapped) { throw new Error('这份接续草稿的目标已不存在，请重新发起接续'); }
      const existing = await Storage.getNoteById(draft.sourceNoteId);
      if (existing && LexiContinuationData.same(existing, draft) && LexiContinuationReceiver.available(existing, vaults, projects)) {
        result.note = existing;
      } else {
        const vaultId = await Storage.getActiveVaultId();
        const projectId = await Storage.getActiveProjectId(vaultId);
        if (!vaults.some((vault: VaultItem): boolean => !vault.archived && vault.id === vaultId) ||
          (projectId && !projects.some((project: LexiProject): boolean => !project.archived && project.id === projectId && project.vaultId === vaultId))) {
          throw new Error('目标工作区或项目不可用，请先在本机选择保存位置');
        }
        result.conflictCopy = !!existing;
        result.note = await Storage.saveNote(context, LexiContinuationData.toNote(draft, vaultId, projectId, result.conflictCopy));
      }
      await Storage.setRawValue(key, result.note.id);
      return result;
    });
    LexiContinuationReceiver.pending = operation.then((): void => {}, (): void => {});
    return operation;
  }
}
