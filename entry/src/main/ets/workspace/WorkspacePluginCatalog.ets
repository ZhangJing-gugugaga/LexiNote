import { LexiInstalledPlugin } from '../core/plugin/LexiPluginManifest';
import { LexiPluginManager } from '../core/plugin/LexiPluginRuntime';
import { WorkspacePluginSummary } from './WorkspaceProtocol';

export const DEMO_PLUGIN_ID: string = 'lexinote.demo-status';
export const DEMO_PLUGIN_VERSION: string = '1.0.0';

/**
 * Demo plugin source, evaluated once by the web container (spec section 3).
 * It exercises the three surfaces the slice must prove: a command, a view, and a host call.
 */
const DEMO_PLUGIN_SOURCE: string = `module.exports = function (api) {
  api.commands.addCommand({
    id: 'insert-stamp',
    name: '示例插件：插入时间戳并提示',
    callback: function () {
      var stamp = new Date().toLocaleTimeString();
      api.editor.insertText('[插件事务 ' + stamp + ']');
      api.workspace.notice('示例插件命令已执行 ' + stamp);
      return api.host.call('demo.ping', { from: 'plugin', at: stamp }).then(function (res) {
        api.log('plugin.command.ok', { stamp: stamp, hostSeq: res ? res.seq : -1 });
      });
    }
  });
  api.views.register('demo-status', function (el, ctx) {
    el.textContent = '';
    var first = document.createElement('div');
    first.textContent = '实例 ' + ctx.instanceKey;
    var second = document.createElement('div');
    second.textContent = '创建次数 ' + ctx.instanceCreated + ' · 视图 ' + ctx.viewId;
    var third = document.createElement('div');
    third.innerHTML = '<b>同一个插件对象</b>跨视图复用';
    el.appendChild(first);
    el.appendChild(second);
    el.appendChild(third);
  });
  return {
    onload: function () {
      api.log('plugin.demo.onload', { plugin: api.pluginId, at: Date.now() });
      return api.host.call('demo.ready', { at: Date.now() });
    }
  };
};
`;

export class WorkspacePluginEntry {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly code: string;
  /** obsidian 插件装载需要原始 manifest；容器内联 demo 插件没有清单。 */
  readonly manifest: Record<string, Object> | null;

  constructor(id: string, name: string, version: string, code: string, manifest: Record<string, Object> | null = null) {
    this.id = id;
    this.name = name;
    this.version = version;
    this.code = code;
    this.manifest = manifest;
  }
}

/**
 * Installed-plugin catalogue: the inline demo plugin (web-container API, keeps the slice gate green)
 * plus every real plugin the old host already installed under files/plugins/<id>.
 */
export class WorkspacePluginRegistry {
  private entries: Map<string, WorkspacePluginEntry> = new Map<string, WorkspacePluginEntry>();

  constructor() {
    this.entries.set(DEMO_PLUGIN_ID,
      new WorkspacePluginEntry(DEMO_PLUGIN_ID, '示例状态插件', DEMO_PLUGIN_VERSION, DEMO_PLUGIN_SOURCE));
  }

  /** Copies manifest + main.js of each installed plugin; unreadable entries are skipped, not faked. */
  loadFromManager(manager: LexiPluginManager): void {
    const installed: Array<LexiInstalledPlugin> = manager.installedPlugins();
    for (const record of installed) {
      const id: string = record.manifest.id;
      // 装载失败的记录不进工作区列表:可见行为只保留"能跑的插件"。
      if (id.length === 0 || record.errorState.length > 0 || this.entries.has(id)) {
        continue;
      }
      let manifest: Record<string, Object> | null = null;
      let code: string = '';
      try {
        manifest = JSON.parse(manager.pluginManifestJson(id)) as Record<string, Object>;
        code = manager.pluginMainCode(id);
      } catch (err) {
        continue; // 源码或清单读不出来就不进列表:宁可少一个插件,也不下发半截代码
      }
      if (manifest === null || code.length === 0) {
        continue;
      }
      this.entries.set(id,
        new WorkspacePluginEntry(id, record.manifest.name, record.manifest.version, code, manifest));
    }
  }

  summaries(): Array<WorkspacePluginSummary> {
    const list: Array<WorkspacePluginSummary> = [];
    this.entries.forEach((entry: WorkspacePluginEntry) => {
      const row: WorkspacePluginSummary = { id: entry.id, name: entry.name, version: entry.version };
      list.push(row);
    });
    return list;
  }

  entry(id: string): WorkspacePluginEntry | null {
    const found = this.entries.get(id);
    return found === undefined ? null : found;
  }
}
