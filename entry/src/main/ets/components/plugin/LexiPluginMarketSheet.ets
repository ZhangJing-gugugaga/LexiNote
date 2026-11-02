// Community plugin market sheet: fetch the v1 index, install entries over HTTP,
// and manage what is already installed (version / rollback / uninstall).

import { LexiPluginManager } from '../../core/plugin/LexiPluginRuntime';
import { LexiPluginMarketEntry, LexiMarketIndexResult } from '../../core/plugin/LexiPluginMarketModel';
import { LexiInstalledPlugin } from '../../core/plugin/LexiPluginManifest';

const DEFAULT_MARKET_URL: string = 'https://raw.githubusercontent.com/ZhangJing-gugugaga/lexinote-releases/master/community-plugins.json';
// 模拟器/调试用本地源:10.0.2.2 映射到宿主机回环地址
const DEMO_MARKET_URL: string = 'http://10.0.2.2:8099/market.json';

/**
 * 失败态的唯一判定入口:errorState 为空 ⇒ 'normal'(绝不把没出错的行渲染成失败)。
 * 分类只看 errorState 原文里的锚点——版本闸门的话术、沙箱装载异常——
 * 不在界面里硬编码"版本不兼容"去猜类别。
 */
export function pluginFailureKind(errorState: string): string {
  const text: string = errorState.replace(/\s+/g, ' ').trim();
  if (text.length === 0) { return 'normal'; }
  if (text.indexOf('本应用模拟 Obsidian API') >= 0) { return 'compat'; }
  if (text.indexOf('沙箱不支持模块') >= 0 || text.indexOf('onload') >= 0) { return 'load'; }
  return 'other';
}

/** 失败标签;errorState 为空时返回空串(正常行没有任何失败文案)。 */
export function pluginFailureLabel(errorState: string): string {
  const kind: string = pluginFailureKind(errorState);
  if (kind === 'normal') { return ''; }
  if (kind === 'compat') { return '版本要求未满足'; }
  if (kind === 'load') { return '加载失败'; }
  return '不可用';
}

/** 单行摘要:去掉重复前缀、压平换行、截断到 80 字符(含省略号)。完整原因仍是 errorState 原文。 */
export function pluginFailureSummary(errorState: string): string {
  if (pluginFailureKind(errorState) === 'normal') { return ''; }
  let text: string = errorState.replace(/\s+/g, ' ').trim();
  if (text.indexOf('插件版本不兼容') === 0) {
    const dash: number = text.indexOf('—');
    if (dash > 0) { text = text.substring(dash + 1).trim(); }
  }
  if (text.indexOf('Error:') === 0) { text = text.substring('Error:'.length).trim(); }
  const limit: number = 80;
  if (text.length > limit) { text = text.substring(0, limit - 1) + '…'; }
  return text;
}

@Component
export struct LexiPluginMarketSheet {
  onInstalled: (pluginId: string) => void = (_pluginId: string): void => {};
  @State private entries: LexiPluginMarketEntry[] = [];
  @State private installed: LexiInstalledPlugin[] = [];
  @State private status: string = '';
  @State private busy: boolean = false;
  @State private marketUrl: string = DEFAULT_MARKET_URL;
  @State private demoMode: boolean = false;

  aboutToAppear(): void {
    this.load();
    this.refreshInstalled();
  }

  private refreshInstalled(): void {
    const manager = LexiPluginManager.shared;
    this.installed = manager ? manager.installedPlugins() : [];
  }

  private async load(): Promise<void> {
    const manager = LexiPluginManager.shared;
    if (!manager) {
      this.status = '插件内核尚未就绪';
      return;
    }
    this.busy = true;
    this.status = '正在加载市场索引…';
    try {
      const result: LexiMarketIndexResult = await manager.fetchMarketIndex(this.marketUrl);
      this.entries = result.entries;
      if (result.ok) {
        this.status = result.entries.length > 0 ? `共 ${result.entries.length} 个插件` : '市场为空';
      } else {
        // 索引被拒绝时报出原因，而不是显示"市场为空"
        this.status = `索引被拒绝(${result.code})：${result.message}`;
      }
    } catch (error) {
      this.entries = [];
      this.status = '市场索引加载失败：' + String(error);
    } finally {
      this.busy = false;
    }
  }

  private useDemoSource(): void {
    this.marketUrl = DEMO_MARKET_URL;
    this.demoMode = true;
    this.load();
  }

  private async install(entry: LexiPluginMarketEntry): Promise<void> {
    const manager = LexiPluginManager.shared;
    if (!manager || this.busy) { return; }
    if (!entry.zipUrl) {
      this.status = `${entry.name}：缺少下载地址(zipUrl)`;
      return;
    }
    this.busy = true;
    this.status = `正在安装 ${entry.name}…`;
    try {
      const pluginId = await manager.installFromUrl(entry.zipUrl, entry.sha256);
      // 安装完不等于装载成功:回读该插件的 errorState,别把"装上了但 onload 炸了"报成已启用。
      const fresh = manager.installedPlugins()
        .find((plugin: LexiInstalledPlugin): boolean => plugin.manifest.id === pluginId);
      const failure: string = fresh ? pluginFailureSummary(fresh.errorState) : '';
      this.status = failure.length > 0
        ? `已安装但加载失败：${entry.name} — ${failure}`
        : `已安装并启用：${entry.name}`;
      this.onInstalled(pluginId);
      this.refreshInstalled();
    } catch (error) {
      this.status = `安装失败：${String(error)}`;
    } finally {
      this.busy = false;
    }
  }

  private async uninstall(pluginId: string): Promise<void> {
    const manager = LexiPluginManager.shared;
    if (!manager || this.busy) { return; }
    this.busy = true;
    try {
      const outcome = await manager.uninstallPlugin(pluginId);
      this.status = outcome.ok ? `已卸载：${pluginId}` : `卸载失败：${outcome.message}`;
      this.refreshInstalled();
    } finally {
      this.busy = false;
    }
  }

  private async rollback(pluginId: string): Promise<void> {
    const manager = LexiPluginManager.shared;
    if (!manager || this.busy) { return; }
    this.busy = true;
    try {
      const outcome = await manager.rollbackPlugin(pluginId);
      this.status = outcome.ok ? `已回滚 ${pluginId} → v${outcome.version}` : `回滚失败：${outcome.message}`;
      this.refreshInstalled();
    } finally {
      this.busy = false;
    }
  }

  private versionLabel(plugin: LexiInstalledPlugin): string {
    const manager = LexiPluginManager.shared;
    const current = manager ? manager.pluginVersion(plugin.manifest.id) : '';
    return current.length > 0 ? current : plugin.manifest.version;
  }

  /** 已安装行的状态行:errorState 非空时不出现"已启用"字样。 */
  private stateLine(plugin: LexiInstalledPlugin): string {
    const version: string = `v${this.versionLabel(plugin)}`;
    const suffix: string = ` · ${version} · ${plugin.manifest.id}`;
    if (pluginFailureKind(plugin.errorState) !== 'normal') {
      return pluginFailureLabel(plugin.errorState) + suffix;
    }
    return (plugin.enabled ? '已启用' : '已停用') + suffix;
  }

  build() {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Text('社区插件市场')
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
        Text(this.busy ? '处理中…' : this.status)
          .fontSize(11)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .width('100%')

      Row({ space: 8 }) {
        Button('刷新', { type: ButtonType.Normal })
          .height(36)
          .fontSize(12)
          .borderRadius(10)
          .enabled(!this.busy)
          .backgroundColor($r('app.color.soft_surface'))
          .fontColor($r('app.color.text_primary'))
          .onClick((): void => { this.load(); this.refreshInstalled(); })
        Button(this.demoMode ? '演示源（使用中）' : '演示源', { type: ButtonType.Normal })
          .height(36)
          .fontSize(12)
          .borderRadius(10)
          .enabled(!this.busy)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.brand'))
          .onClick((): void => { this.useDemoSource(); })
      }
      .width('100%')

      if (this.installed.length > 0) {
        Column({ space: 8 }) {
          Text('已安装').fontSize(12).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
          ForEach(this.installed, (plugin: LexiInstalledPlugin) => {
            Row({ space: 8 }) {
              Column({ space: 2 }) {
                Text(plugin.manifest.name).fontSize(13).fontColor($r('app.color.text_primary'))
                Text(this.stateLine(plugin))
                  .fontSize(10)
                  .fontColor(pluginFailureKind(plugin.errorState) === 'normal'
                    ? $r('app.color.text_secondary') : $r('app.color.error'))
                if (pluginFailureKind(plugin.errorState) !== 'normal') {
                  // 单行摘要(maxLines=1 + 80 字符上限);完整原因留在 errorState 原文里
                  Text(pluginFailureSummary(plugin.errorState))
                    .fontSize(10)
                    .fontColor($r('app.color.error'))
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .width('100%')
                }
              }
              .layoutWeight(1)
              .alignItems(HorizontalAlign.Start)
              Button('回滚', { type: ButtonType.Normal })
                .height(30)
                .fontSize(11)
                .borderRadius(8)
                .enabled(!this.busy)
                .backgroundColor($r('app.color.soft_surface'))
                .fontColor($r('app.color.text_primary'))
                .onClick((): void => { this.rollback(plugin.manifest.id); })
              Button('卸载', { type: ButtonType.Normal })
                .height(30)
                .fontSize(11)
                .borderRadius(8)
                .enabled(!this.busy)
                .backgroundColor($r('app.color.soft_surface'))
                .fontColor($r('app.color.text_primary'))
                .onClick((): void => { this.uninstall(plugin.manifest.id); })
            }
            .width('100%')
            .padding(10)
            .backgroundColor($r('app.color.soft_surface'))
            .borderRadius(10)
          }, (plugin: LexiInstalledPlugin): string => plugin.manifest.id)
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }

      if (this.entries.length === 0 && !this.busy) {
        Text('暂无可用插件。索引必须是 schemaVersion=1 的单一日志；ZCode 格式的旧索引会被明确拒绝。')
          .fontSize(12)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .padding(12)
          .backgroundColor($r('app.color.soft_surface'))
          .borderRadius(12)
      }

      Scroll() {
        Column({ space: 8 }) {
          ForEach(this.entries, (entry: LexiPluginMarketEntry) => {
            Row({ space: 10 }) {
              Column({ space: 4 }) {
                Row({ space: 6 }) {
                  Text(entry.name).fontSize(14).fontColor($r('app.color.text_primary'))
                  if (entry.version.length > 0) {
                    Text(`v${entry.version}`).fontSize(10).fontColor($r('app.color.text_secondary'))
                  }
                  if (entry.sha256.length > 0) {
                    Text('已签名哈希').fontSize(10).fontColor($r('app.color.brand'))
                  }
                }
                Text(entry.description.length > 0 ? entry.description : entry.repo)
                  .fontSize(11)
                  .fontColor($r('app.color.text_secondary'))
                  .maxLines(2)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                if (entry.author.length > 0) {
                  Text(`作者:${entry.author}`).fontSize(10).fontColor($r('app.color.text_secondary'))
                }
              }
              .layoutWeight(1)
              .alignItems(HorizontalAlign.Start)

              Button(entry.zipUrl ? '安装' : '无下载地址', { type: ButtonType.Normal })
                .height(34)
                .fontSize(12)
                .borderRadius(10)
                .enabled(!this.busy && entry.zipUrl.length > 0)
                .backgroundColor($r('app.color.brand'))
                .fontColor($r('app.color.inverse_text'))
                .onClick((): void => { this.install(entry); })
            }
            .width('100%')
            .padding(12)
            .backgroundColor($r('app.color.soft_surface'))
            .borderRadius(12)
          }, (entry: LexiPluginMarketEntry): string => entry.id)
        }
        .width('100%')
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Auto)
      .align(Alignment.TopStart)
    }
    .width('100%')
    .padding({ left: 20, right: 20, top: 16, bottom: 24 })
    .height('100%')
  }
}
