// Process-wide change bus. LexiStorageService publishes note mutations here;
// plugin facades subscribe to keep their projections and plugin events fresh.

export class LexiNoteChange {
  kind: string = 'modify'; // 'create' | 'modify' | 'rename' | 'delete'
  noteId: string = '';
  vaultId: string = '';
  title: string = '';
  trashedAt: number = 0;
  updatedAt: number = 0;
  oldTitle: string = '';
}

export class LexiPluginBus {
  private static listeners: Map<string, Array<(payload: Object) => void>> = new Map();

  static on(name: string, callback: (payload: Object) => void): void {
    let bucket = LexiPluginBus.listeners.get(name);
    if (!bucket) {
      bucket = new Array<(payload: Object) => void>();
      LexiPluginBus.listeners.set(name, bucket);
    }
    if (!bucket.includes(callback)) { bucket.push(callback); }
  }

  static off(name: string, callback: (payload: Object) => void): void {
    const bucket = LexiPluginBus.listeners.get(name);
    if (!bucket) { return; }
    const index = bucket.indexOf(callback);
    if (index >= 0) { bucket.splice(index, 1); }
  }

  static emit(name: string, payload: Object): void {
    const bucket = LexiPluginBus.listeners.get(name);
    if (!bucket) { return; }
    const snapshot = bucket.slice();
    for (const listener of snapshot) {
      try { listener(payload); } catch { /* a broken subscriber must not break the publisher */ }
    }
  }

  static noteChanged(change: LexiNoteChange): void {
    LexiPluginBus.emit('lexi.note.changed', change);
  }
}
