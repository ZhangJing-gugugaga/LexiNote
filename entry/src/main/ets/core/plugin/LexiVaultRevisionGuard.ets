// RFC §7.1 / §14 T2.3 · Vault revision 乐观锁(LexiVaultRevisionGuard)。
//
// 并发写入保护:每次成功写入推进路径 revision;携带过期预期 revision 的写入判冲突
// (first-writer-wins);expectedRevision=-1 表示盲写(读改写不关心并发,行为同 last-write-wins)。
// 纯逻辑、零 @kit 依赖,可在 Node 转译真跑(plugin-vault-revision.cjs)。

export class LexiVaultRevisionOutcome {
  ok: boolean = false;
  /** 冲突时回传宿主侧当前 revision,供调用方重读后再试。 */
  currentRevision: number = 0;
  nextRevision: number = 0;
  reason: string = '';
}

export class LexiVaultRevisionGuard {
  private revisions: Map<string, number> = new Map();

  revisionOf(path: string): number {
    const value = this.revisions.get(path);
    return value === undefined ? 0 : value;
  }

  /**
   * 写入闸:expectedRevision >= 0 时必须与当前一致,否则冲突(不推进);
   * expectedRevision < 0 视为盲写放行。成功推进 revision。
   */
  checkAndBump(path: string, expectedRevision: number): LexiVaultRevisionOutcome {
    const outcome = new LexiVaultRevisionOutcome();
    if (!path || path.length === 0) {
      outcome.reason = '路径为空';
      return outcome;
    }
    const current = this.revisionOf(path);
    outcome.currentRevision = current;
    if (expectedRevision >= 0 && expectedRevision !== current) {
      outcome.reason = 'vault_conflict: 并发修改检出,宿主侧 revision=' + current +
        ',调用方预期=' + expectedRevision;
      return outcome;
    }
    const next = current + 1;
    this.revisions.set(path, next);
    outcome.ok = true;
    outcome.nextRevision = next;
    return outcome;
  }

  /** rename 迁移计数(revision 跟随内容,不随路径重置)。 */
  rename(oldPath: string, newPath: string): void {
    if (!oldPath || !newPath || oldPath === newPath) { return; }
    const value = this.revisions.get(oldPath);
    if (value === undefined) { return; }
    this.revisions.delete(oldPath);
    this.revisions.set(newPath, value);
  }

  /** delete 清账(新文件从 0 重新起算)。 */
  forget(path: string): void {
    this.revisions.delete(path);
  }
}
