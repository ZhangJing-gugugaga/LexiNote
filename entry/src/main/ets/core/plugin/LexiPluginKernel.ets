// Plugin kernel: event bus, component lifecycle and command registry.
// Pure logic with no ArkUI/kit dependencies so the regression harness can load it directly.

export interface LexiHotkey {
  modifiers: string[];
  key: string;
}

/** Command descriptor. `callback` runs inside the host; plugin-side callbacks are bridged by the runtime. */
export interface LexiPluginCommand {
  id: string;
  name: string;
  icon?: string;
  hotkeys?: LexiHotkey[];
  editorOnly?: boolean;
  callback?: () => void | Promise<void>;
  checkCallback?: (checking: boolean) => boolean;
  editorCallback?: (editor: Object, ctx: Object) => void | Promise<void>;
}

export class LexiEventRef {
  topic: string = '';
  id: number = 0;
  owner: LexiEvents | null = null;
}

export class LexiEvents {
  private handlers: Map<string, Map<number, (payload: Object | null) => void>> = new Map();
  private nextId: number = 1;

  on(name: string, callback: (payload: Object | null) => void): LexiEventRef {
    let bucket = this.handlers.get(name);
    if (!bucket) {
      bucket = new Map<number, (payload: Object | null) => void>();
      this.handlers.set(name, bucket);
    }
    const id = this.nextId++;
    bucket.set(id, callback);
    const ref = new LexiEventRef();
    ref.topic = name;
    ref.id = id;
    ref.owner = this;
    return ref;
  }

  off(name: string, callback: (payload: Object | null) => void): void {
    const bucket = this.handlers.get(name);
    if (!bucket) { return; }
    const doomed: number[] = [];
    bucket.forEach((handler: (payload: Object | null) => void, id: number): void => {
      if (handler === callback) { doomed.push(id); }
    });
    for (const id of doomed) { bucket.delete(id); }
  }

  offref(ref: LexiEventRef): void {
    if (!ref) { return; }
    const bucket = this.handlers.get(ref.topic);
    if (bucket) { bucket.delete(ref.id); }
  }

  trigger(name: string, payload: Object | null): void {
    const bucket = this.handlers.get(name);
    if (!bucket) { return; }
    // Iterate a copy so listeners may unsubscribe while the event is in flight.
    const snapshot: ((payload: Object | null) => void)[] = [];
    bucket.forEach((handler: (payload: Object | null) => void): void => { snapshot.push(handler); });
    for (const handler of snapshot) {
      try { handler(payload); } catch { /* a broken listener must not break the emitter */ }
    }
  }

  listenerCount(name: string): number {
    const bucket = this.handlers.get(name);
    return bucket ? bucket.size : 0;
  }
}

/** Mirrors the Obsidian Component lifecycle: unload children first, then timers, then registered cleanups. */
export abstract class LexiComponent {
  private children: LexiComponent[] = [];
  private cleanups: Array<() => void> = [];
  private intervalIds: number[] = [];
  private loaded: boolean = false;

  load(): void {
    if (this.loaded) { return; }
    this.loaded = true;
    this.onload();
    for (const child of this.children) { child.load(); }
  }

  onload(): void {
  }

  unload(): void {
    if (!this.loaded) { return; }
    this.loaded = false;
    for (const child of this.children) { child.unload(); }
    this.children = [];
    for (const id of this.intervalIds) { clearInterval(id); }
    this.intervalIds = [];
    for (const cleanup of this.cleanups) {
      try { cleanup(); } catch { /* cleanup must never block unloading */ }
    }
    this.cleanups = [];
    this.onunload();
  }

  onunload(): void {
  }

  addChild<T extends LexiComponent>(component: T): T {
    this.children.push(component);
    if (this.loaded) { component.load(); }
    return component;
  }

  removeChild<T extends LexiComponent>(component: T): T {
    const index = this.children.indexOf(component);
    if (index >= 0) { this.children.splice(index, 1); }
    component.unload();
    return component;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  register(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }

  registerEvent(eventRef: LexiEventRef): void {
    if (!eventRef) { return; }
    this.cleanups.push((): void => {
      if (eventRef.owner) { eventRef.owner.offref(eventRef); }
    });
  }

  // DOM events only exist inside ArkWeb view slots; in the headless kernel this is a documented no-op.
  registerDomEvent(_el: Object, _type: string, _callback: () => void, _options?: Object): void {
  }

  registerInterval(id: number): number {
    this.intervalIds.push(id);
    return id;
  }
}

/** Runtime command registry. Obsidian namespacing (`pluginId:commandId`) is applied here. */
export class LexiCommandRegistry {
  private commands: Map<string, LexiPluginCommand> = new Map();

  registerPluginCommand(pluginId: string, spec: LexiPluginCommand): LexiPluginCommand {
    const fullId = `${pluginId}:${spec.id}`;
    const registered: LexiPluginCommand = {
      id: fullId,
      name: spec.name,
      icon: spec.icon,
      hotkeys: spec.hotkeys,
      editorOnly: spec.editorOnly === true,
      callback: spec.callback,
      checkCallback: spec.checkCallback,
      editorCallback: spec.editorCallback
    };
    this.commands.set(fullId, registered);
    return registered;
  }

  removePluginCommand(fullId: string): void {
    this.commands.delete(fullId);
  }

  removePluginCommands(pluginId: string): void {
    const prefix = `${pluginId}:`;
    const doomed: string[] = [];
    this.commands.forEach((_command: LexiPluginCommand, fullId: string): void => {
      if (fullId.startsWith(prefix)) { doomed.push(fullId); }
    });
    for (const fullId of doomed) { this.commands.delete(fullId); }
  }

  get(fullId: string): LexiPluginCommand | undefined {
    return this.commands.get(fullId);
  }

  list(): LexiPluginCommand[] {
    const result: LexiPluginCommand[] = [];
    this.commands.forEach((command: LexiPluginCommand): void => { result.push(command); });
    return result;
  }

  async execute(fullId: string): Promise<boolean> {
    const command = this.commands.get(fullId);
    if (!command) { return false; }
    if (command.checkCallback && !command.checkCallback(false)) { return false; }
    if (command.callback) { await command.callback(); }
    return true;
  }

  canExecute(fullId: string): boolean {
    const command = this.commands.get(fullId);
    if (!command) { return false; }
    if (command.checkCallback) { return command.checkCallback(true); }
    return true;
  }
}
