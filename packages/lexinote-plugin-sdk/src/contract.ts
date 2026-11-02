// 由 tools/sync-sdk.cjs 生成 —— 勿手改;真源: tools/plugin-contract/api-surface.json。
/** SDK/插件 API 版本(与宿主 PLUGIN_API_VERSION、shim API_VERSION 三方一致)。 */
export const API_VERSION = '1.0.0';

/** 宿主 RPC 方法契约(生成自 api-surface.json;kind 见 capability-map.json)。 */
export interface SdkMethodEntry {
  method: string;
  domain: 'app' | 'vault' | 'metadata' | 'workspace' | 'editor' | 'commands' | 'events' | 'storage' | 'ui' | 'network' | 'plugin' | 'markdown' | 'theme' | 'internal';
  kind: string;
  status: 'stable' | 'experimental' | 'deprecated' | 'removed';
}

export const SDK_METHODS: SdkMethodEntry[] = [
  { method: 'app.isDarkMode', domain: 'app', kind: 'public', status: 'stable' },
  { method: 'app.localStorage.get', domain: 'app', kind: 'ui-domain', status: 'stable' },
  { method: 'app.localStorage.set', domain: 'app', kind: 'ui-domain', status: 'stable' },
  { method: 'channel.auth', domain: 'app', kind: 'public', status: 'stable' },
  { method: 'channel.hello', domain: 'app', kind: 'public', status: 'stable' },
  { method: 'codeblocks.register', domain: 'markdown', kind: 'register', status: 'stable' },
  { method: 'codeblocks.unregister', domain: 'markdown', kind: 'plugin-owned', status: 'stable' },
  { method: 'commands.add', domain: 'commands', kind: 'register', status: 'stable' },
  { method: 'commands.execute', domain: 'commands', kind: 'ui-domain', status: 'stable' },
  { method: 'commands.list', domain: 'commands', kind: 'ui-domain', status: 'stable' },
  { method: 'commands.remove', domain: 'commands', kind: 'plugin-owned', status: 'stable' },
  { method: 'data.load', domain: 'storage', kind: 'plugin-storage', status: 'stable' },
  { method: 'data.save', domain: 'storage', kind: 'plugin-storage', status: 'stable' },
  { method: 'debug.delay', domain: 'app', kind: 'control-plane', status: 'stable' },
  { method: 'demo.ping', domain: 'app', kind: 'demo-plugin', status: 'stable' },
  { method: 'demo.ready', domain: 'app', kind: 'demo-plugin', status: 'stable' },
  { method: 'editor.applyChanges', domain: 'editor', kind: 'editor-write', status: 'stable' },
  { method: 'editor.replace', domain: 'editor', kind: 'editor-write', status: 'stable' },
  { method: 'editor.selection', domain: 'editor', kind: 'editor-write', status: 'stable' },
  { method: 'editor.state', domain: 'editor', kind: 'fs-read', status: 'stable' },
  { method: 'events.off', domain: 'events', kind: 'plugin-owned', status: 'stable' },
  { method: 'events.on', domain: 'events', kind: 'ui-domain', status: 'stable' },
  { method: 'log.event', domain: 'app', kind: 'public', status: 'stable' },
  { method: 'metadata.firstLink', domain: 'metadata', kind: 'fs-read', status: 'stable' },
  { method: 'metadata.get', domain: 'metadata', kind: 'fs-read', status: 'stable' },
  { method: 'metadata.getAllProperties', domain: 'metadata', kind: 'fs-read', status: 'stable' },
  { method: 'metadata.graph', domain: 'metadata', kind: 'fs-read', status: 'stable' },
  { method: 'metadata.resolved', domain: 'metadata', kind: 'fs-read', status: 'stable' },
  { method: 'net.requestUrl', domain: 'network', kind: 'net', status: 'stable' },
  { method: 'plugin.list', domain: 'plugin', kind: 'control-plane', status: 'stable' },
  { method: 'plugin.load', domain: 'plugin', kind: 'control-plane', status: 'stable' },
  { method: 'plugin.onload.done', domain: 'plugin', kind: 'public', status: 'stable' },
  { method: 'plugin.onload.error', domain: 'plugin', kind: 'public', status: 'stable' },
  { method: 'plugin.sourceChunk', domain: 'plugin', kind: 'plugin-source', status: 'stable' },
  { method: 'plugin.sourceSize', domain: 'plugin', kind: 'plugin-source', status: 'stable' },
  { method: 'plugin.unload', domain: 'plugin', kind: 'control-plane', status: 'stable' },
  { method: 'plugin.unload.done', domain: 'plugin', kind: 'public', status: 'stable' },
  { method: 'runtime.ready', domain: 'app', kind: 'public', status: 'stable' },
  { method: 'settings.register', domain: 'ui', kind: 'register', status: 'stable' },
  { method: 'settings.unregister', domain: 'ui', kind: 'register', status: 'stable' },
  { method: 'theme.config', domain: 'theme', kind: 'control-plane', status: 'stable' },
  { method: 'theme.install', domain: 'theme', kind: 'control-plane', status: 'stable' },
  { method: 'theme.list', domain: 'theme', kind: 'control-plane', status: 'stable' },
  { method: 'theme.load', domain: 'theme', kind: 'control-plane', status: 'stable' },
  { method: 'theme.setActive', domain: 'theme', kind: 'control-plane', status: 'stable' },
  { method: 'ui.addIcon', domain: 'ui', kind: 'ui-domain', status: 'stable' },
  { method: 'ui.addRibbon', domain: 'ui', kind: 'ui-domain', status: 'stable' },
  { method: 'ui.notice', domain: 'ui', kind: 'ui-domain', status: 'stable' },
  { method: 'ui.placeholder', domain: 'ui', kind: 'ui-domain', status: 'stable' },
  { method: 'ui.removeRibbon', domain: 'ui', kind: 'ui-domain', status: 'stable' },
  { method: 'vault.append', domain: 'vault', kind: 'fs-write', status: 'stable' },
  { method: 'vault.create', domain: 'vault', kind: 'fs-write', status: 'stable' },
  { method: 'vault.delete', domain: 'vault', kind: 'fs-write', status: 'stable' },
  { method: 'vault.files', domain: 'vault', kind: 'fs-read', status: 'stable' },
  { method: 'vault.getByPath', domain: 'vault', kind: 'fs-read', status: 'stable' },
  { method: 'vault.modify', domain: 'vault', kind: 'fs-write', status: 'stable' },
  { method: 'vault.read', domain: 'vault', kind: 'fs-read', status: 'stable' },
  { method: 'vault.rename', domain: 'vault', kind: 'fs-write', status: 'stable' },
  { method: 'views.add', domain: 'workspace', kind: 'register', status: 'stable' },
  { method: 'views.remove', domain: 'workspace', kind: 'plugin-owned', status: 'stable' },
  { method: 'workspace.closeView', domain: 'workspace', kind: 'plugin-owned', status: 'stable' },
  { method: 'workspace.layoutReady', domain: 'workspace', kind: 'public', status: 'stable' },
  { method: 'workspace.loadLayout', domain: 'workspace', kind: 'control-plane', status: 'stable' },
  { method: 'workspace.onLayoutReady', domain: 'workspace', kind: 'public', status: 'stable' },
  { method: 'workspace.openLinkText', domain: 'workspace', kind: 'ui-domain', status: 'stable' },
  { method: 'workspace.openView', domain: 'workspace', kind: 'ui-domain', status: 'stable' },
  { method: 'workspace.saveLayout', domain: 'workspace', kind: 'control-plane', status: 'stable' },
];

/** 按域取方法(开发者发现面)。 */
export function methodsOf(domain: string): SdkMethodEntry[] {
  return SDK_METHODS.filter((m) => m.domain === domain);
}
