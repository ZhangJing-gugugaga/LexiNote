import { common } from '@kit.AbilityKit';
import { LexiProject, NoteItem } from './LexiModels';
import { LexiFormData } from './LexiFormData';
import { LexiFormService } from './LexiFormService';
import { LexiStorageService } from './LexiStorageService';
import { LexiTemplates } from './LexiTemplates';

/** Short FormExtension work: only a verified checkbox is saved, then the host receives a real snapshot. */
export class LexiFormTasks {
  private static pending: Promise<void> = Promise.resolve();

  static async handle(context: common.Context, formId: string, raw: string): Promise<void> {
    const request = raw.length <= 8192 ? LexiFormData.decodeRequest(raw) : undefined;
    if (!request || request.lexiFormAction !== 'toggle-todo') { return; }
    const operation = LexiFormTasks.pending.then(async (): Promise<void> => {
      let message = '待办已更新';
      try {
        await LexiStorageService.init(context);
        const vaultId = await LexiStorageService.getActiveVaultId();
        if (!request.vaultId || request.vaultId !== vaultId) { throw new Error('工作区已切换，请刷新卡片后重试'); }
        const note = await LexiStorageService.getNoteById(request.noteId);
        const projects = await LexiStorageService.getProjects(vaultId);
        if (!note || note.vaultId !== vaultId || (note.projectId && !projects.some((project: LexiProject): boolean => project.id === note.projectId)) ||
          note.title !== LexiTemplates.dateKey() || note.notebook !== '日常记录 / 日记') {
          throw new Error('今日笔记已变化，请打开应用确认');
        }
        const changed = LexiFormData.applyTask(note, request);
        await LexiStorageService.saveNoteIfCurrent(context, changed, note.title, note.content);
        const freshVaultId = await LexiStorageService.getActiveVaultId();
        const freshProjects = await LexiStorageService.getProjects(freshVaultId);
        const notes = (await LexiStorageService.getNotes(freshVaultId)).filter((candidate: NoteItem): boolean =>
          !candidate.projectId || freshProjects.some((project: LexiProject): boolean => project.id === candidate.projectId));
        await LexiFormService.sync(context, notes, freshVaultId);
      } catch (error) {
        message = (error as Error).message === 'DOCUMENT_CHANGED_ELSEWHERE' ? '笔记已更新，请刷新卡片后重试' :
          (error as Error).message || '待办暂未保存，请打开应用确认';
      }
      await LexiFormService.update(context, formId, message);
    });
    LexiFormTasks.pending = operation.catch((): void => {});
    await operation;
  }
}
