import { common } from '@kit.AbilityKit';
import { NoteItem, UnlinkedMention } from './LexiModels';
import { LexiCompletion } from './LexiCompletion';
import { LexiStorageService } from './LexiStorageService';

export class LexiLinkActions {
  static async establishMention(context: common.UIAbilityContext, mention: UnlinkedMention): Promise<NoteItem> {
    const source = await LexiStorageService.getNoteById(mention.sourceId);
    const target = await LexiStorageService.getNoteById(mention.targetId);
    if (!source || !target || source.trashedAt > 0 || target.trashedAt > 0 || source.vaultId !== target.vaultId) {
      throw new Error('关联笔记已变化，请刷新后重试');
    }
    const content = LexiCompletion.linkFirstMention(source.content, target.title);
    if (content === source.content) { throw new Error('原文中没有可建立链接的纯文本提及'); }
    const draft = JSON.parse(JSON.stringify(source)) as NoteItem;
    draft.content = content;
    return LexiStorageService.saveNoteIfCurrent(context, draft, source.title, source.content);
  }
}
