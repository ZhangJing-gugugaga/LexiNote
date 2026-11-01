// Open-editor registry for the plugin Editor bridge.
// The workspace registers each mounted note editor; plugins reach the live controller
// through this registry so writes flow through the editor's own save boundary.

import { LexiLiveEditorController } from '../LexiLiveMarkdown';

export class LexiEditorRegistry {
  private static controllers: Map<string, LexiLiveEditorController> = new Map();
  private static activeNoteId: string = '';

  static register(noteId: string, controller: LexiLiveEditorController): void {
    if (!noteId) { return; }
    LexiEditorRegistry.controllers.set(noteId, controller);
    LexiEditorRegistry.activeNoteId = noteId;
  }

  static unregister(noteId: string): void {
    LexiEditorRegistry.controllers.delete(noteId);
    if (LexiEditorRegistry.activeNoteId === noteId) {
      LexiEditorRegistry.activeNoteId = '';
    }
  }

  static activate(noteId: string): void {
    if (LexiEditorRegistry.controllers.has(noteId)) {
      LexiEditorRegistry.activeNoteId = noteId;
    }
  }

  static controllerFor(noteId: string): LexiLiveEditorController | null {
    return LexiEditorRegistry.controllers.get(noteId) || null;
  }

  static activeController(): LexiLiveEditorController | null {
    if (!LexiEditorRegistry.activeNoteId) { return null; }
    return LexiEditorRegistry.controllers.get(LexiEditorRegistry.activeNoteId) || null;
  }

  static activeNote(): string {
    return LexiEditorRegistry.activeNoteId;
  }

  static hasActive(): boolean {
    return LexiEditorRegistry.activeController() !== null;
  }
}
