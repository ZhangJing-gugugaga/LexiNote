import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo } from '@kit.CoreFileKit';

/** One process queue plus an OS file lock shared by UIAbility and extension processes. */
export class LexiStorageLock {
  private static pending: Promise<void> = Promise.resolve();

  static async run<T>(context: common.Context, operation: () => Promise<T>): Promise<T> {
    const next = LexiStorageLock.pending.then(async (): Promise<T> =>
      LexiStorageLock.acquire<T>(context, operation));
    LexiStorageLock.pending = next.then((): void => {}, (): void => {});
    return next;
  }

  static async flush(): Promise<void> { await LexiStorageLock.pending; }

  private static async acquire<T>(context: common.Context, operation: () => Promise<T>): Promise<T> {
    const appContext = context.getApplicationContext();
    // This file must never be renamed or deleted: all processes must lock the same inode.
    const file = fileIo.openSync(`${appContext.filesDir}/lexinote-mutation.lock`, fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE);
    let acquired = false;
    try {
      for (let attempt = 0; attempt < 101; attempt++) {
        try { file.tryLock(true); acquired = true; break; }
        catch (error) {
          if ((error as BusinessError).code !== 13900034) { throw error as Error; }
          if (attempt === 100) { throw new Error('知识库正在处理其他操作，请稍后重试。当前内容仍然保留。'); }
          await new Promise<void>((resolve: () => void): void => { setTimeout((): void => resolve(), 40); });
        }
      }
      return await operation();
    } finally {
      // close also releases a kernel lock if unlock itself fails or the process exits.
      try { if (acquired) { file.unlock(); } } finally { fileIo.closeSync(file); }
    }
  }
}
