// Plugin view type registry: maps ItemView types to owning plugins for workspace tabs.

export class LexiPluginViewInfo {
  type: string = '';
  pluginId: string = '';
  displayName: string = '';
  icon: string = '';
}

export class LexiPluginViewRegistry {
  private static views: Map<string, LexiPluginViewInfo> = new Map();

  static register(info: LexiPluginViewInfo): void {
    if (!info.type) { return; }
    LexiPluginViewRegistry.views.set(info.type, info);
  }

  static remove(type: string): void {
    LexiPluginViewRegistry.views.delete(type);
  }

  static removePlugin(pluginId: string): void {
    const doomed: string[] = [];
    LexiPluginViewRegistry.views.forEach((info: LexiPluginViewInfo, type: string): void => {
      if (info.pluginId === pluginId) { doomed.push(type); }
    });
    for (const type of doomed) { LexiPluginViewRegistry.views.delete(type); }
  }

  static get(type: string): LexiPluginViewInfo | null {
    return LexiPluginViewRegistry.views.get(type) || null;
  }

  static list(): LexiPluginViewInfo[] {
    const result: LexiPluginViewInfo[] = [];
    LexiPluginViewRegistry.views.forEach((info: LexiPluginViewInfo): void => { result.push(info); });
    return result;
  }
}
