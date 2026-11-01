// Each open document owns its editor and save boundary. Switching tabs never reloads a draft.
export class LexiWorkspaceEditorController {
  flush: () => Promise<void> = async (): Promise<void> => {};
  toggleReading: () => void = (): void => {};
}

export class LexiWorkspaceTab {
  noteId: string;
  controller: LexiWorkspaceEditorController = new LexiWorkspaceEditorController();

  constructor(noteId: string) {
    this.noteId = noteId;
  }
}
