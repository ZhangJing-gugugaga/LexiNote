// Community plugin market sheet: fetch the v1 index, install entries over HTTP,
// and manage what is already installed (version / rollback / uninstall).

import { LexiPluginManager } from '../../core/plugin/LexiPluginRuntime';
import { LexiPluginMarketEntry, LexiMarketIndexResult, isTrustedInstallHash } from '../../core/plugin/LexiPluginMarketModel';
import { LexiInstalledPlugin } from '../../core/plugin/LexiPluginManifest';
import { LexiPermissionClassView, classifyCapabilityTags } from '../../core/plugin/LexiPluginManifestV2';

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
  // P2-008:权限增长被拒后暂存的待确认条目(渲染"重新授权并安装"按钮)。
  @State private pendingGrantEntry: LexiPluginMarketEntry | null = null;
  // P5-004:安装完成但尚未授权的插件 id(渲染授权面板:权限清单→同意启用/暂不启用)。
  @State private pendingConsentId: string = '';
  @State private pendingConsentRepo: string = '';
  @State private pendingConsentHashOk: boolean = false;

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
        // 旧版索引(warnings 非空)仍然展示,但缺受信任哈希的条目在安装口被硬拦截。
        const warn: string = result.warnings.length > 0
          ? `（旧版索引：${result.warnings.join('、')}，缺哈希条目不可安装）` : '';
        this.status = (result.entries.length > 0 ? `共 ${result.entries.length} 个插件` : '市场为空') + warn;
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

  private async install(entry: LexiPluginMarketEntry, grantApproved: boolean = false): Promise<void> {
    const manager = LexiPluginManager.shared;
    if (!manager || this.busy) { return; }
    if (!entry.zipUrl) {
      this.status = `${entry.name}：缺少下载地址(zipUrl)`;
      return;
    }
    // 与宿主 installFromUrl 同一判定：缺受信任哈希的条目不发起下载(RFC P0-04)。
    if (!isTrustedInstallHash(entry.sha256)) {
      this.status = `${entry.name}：缺少受信任哈希，市场禁止远程安装（可用本地安装包侧载）`;
      return;
    }
    this.busy = true;
    this.status = grantApproved ? `正在按用户确认的新权限安装 ${entry.name}…` : `正在安装 ${entry.name}…`;
    try {
      // P2-009(R32):options 携带目标插件 id——升级包完整性失败(integrity_mismatch)时
      // 宿主据此把已装版本转入安全隔离(§6.4/§9.2),不再只是一个无归属的失败。
      const optionsBody: Record<string, Object> = { 'targetPluginId': entry.id as Object };
      if (grantApproved) { optionsBody['grantApproved'] = true as Object; }
      const options = JSON.stringify(optionsBody);
      const pluginId = await manager.installFromUrl(entry.zipUrl, entry.sha256, options);
      // P5-004:安装不再自动 enable。回读落点:已启用 = 升级重启/重授权通路;未启用 =
      // 首装默认停在待授权,渲染授权面板(权限清单→用户同意→启用)而不是报"已启用"。
      const fresh = manager.installedPlugins()
        .find((plugin: LexiInstalledPlugin): boolean => plugin.manifest.id === pluginId);
      const failure: string = fresh ? pluginFailureSummary(fresh.errorState) : '';
      if (failure.length > 0) {
        this.status = `已安装但加载失败：${entry.name} — ${failure}`;
      } else if (fresh !== undefined && fresh.enabled) {
        this.status = `已安装并启用：${entry.name}`;
      } else {
        this.status = `已安装（未启用）：${entry.name} — 请确认权限清单后启用`;
        this.pendingConsentId = pluginId;
        this.pendingConsentRepo = entry.repo;
        this.pendingConsentHashOk = isTrustedInstallHash(entry.sha256);
      }
      this.pendingGrantEntry = null;
      this.onInstalled(pluginId);
      this.refreshInstalled();
    } catch (error) {
      const message = String(error);
      if (message.indexOf('ERR_PERMISSION_REGRANT_REQUIRED') >= 0) {
        // P2-008:升级引入新权限 → 不再是死端,给出显式确认通道(RFC §4.5)。
        this.pendingGrantEntry = entry;
        this.status = `${entry.name}：升级引入新权限，需要重新授权——请确认下方权限说明后安装`;
      } else {
        this.status = `安装失败：${message}`;
      }
    } finally {
      this.busy = false;
    }
  }

  /** P2-008:撤销授权(§16.2)——立即停用,后续启用被拒直到再次授权。 */
  private async revokePermissions(pluginId: string): Promise<void> {
    const manager = LexiPluginManager.shared;
    if (!manager || this.busy) { return; }
    this.busy = true;
    try {
      const ok = await manager.revokePluginPermissions(pluginId);
      this.status = ok ? `已撤销授权并停用：${pluginId}` : `撤销失败（未授权或插件不存在）：${pluginId}`;
      if (ok && pluginId === this.pendingConsentId) { this.pendingConsentId = ''; }
      this.refreshInstalled();
    } finally {
      this.busy = false;
    }
  }

  // ---------------- P5-004 授权面板(RFC §4.5):元数据 + 必需/可选/高风险分级 ----------------

  private consentPlugin(): LexiInstalledPlugin | null {
    const manager = LexiPluginManager.shared;
    if (!manager || this.pendingConsentId.length === 0) { return null; }
    const found = manager.installedPlugins()
      .find((plugin: LexiInstalledPlugin): boolean => plugin.manifest.id === this.pendingConsentId);
    return found !== undefined ? found : null;
  }

  private consentTagsOf(plugin: LexiInstalledPlugin): string[] {
    const manager = LexiPluginManager.shared;
    return manager ? manager.permissionTagsOf(plugin.manifest.id) : [];
  }

  private consentClassOf(plugin: LexiInstalledPlugin): LexiPermissionClassView {
    return classifyCapabilityTags(this.consentTagsOf(plugin));
  }

  private consentTitleLine(): string {
    const plugin = this.consentPlugin();
    return plugin !== null ? plugin.manifest.name : '';
  }

  private consentMetaLine(): string {
    const plugin = this.consentPlugin();
    if (plugin === null) { return ''; }
    const repo = this.pendingConsentRepo.length > 0 ? this.pendingConsentRepo : '本地来源';
    return `发布者 ${plugin.manifest.author.length > 0 ? plugin.manifest.author : '未知'} · v${plugin.manifest.version} · 来源仓库 ${repo}`;
  }

  private consentSignatureLine(): string {
    return this.pendingConsentHashOk ? '签名状态：包哈希已校验（与索引 sha256 一致）' : '签名状态：本地侧载（无远端哈希比对）';
  }

  private consentDisclosureLine(): string {
    const plugin = this.consentPlugin();
    if (plugin === null) { return ''; }
    const tags = this.consentTagsOf(plugin);
    const touches = (prefix: string): boolean =>
      tags.some((tag: string): boolean => tag.indexOf(prefix) === 0);
    const writesNotes = tags.some((tag: string): boolean =>
      tag === 'vault.write' || tag.indexOf('vault.write:') === 0 || tag === 'vault.delete' || tag === 'editor.writeDocument');
    const net = touches('network:') || touches('netmethod:');
    return `是否修改笔记：${writesNotes ? '是' : '否'} · 是否访问剪贴板：${touches('clipboard') ? '是' : '否'} · 是否涉及网络：${net ? '是' : '否'}`;
  }

  private consentNetworkLine(): string {
    const plugin = this.consentPlugin();
    if (plugin === null) { return ''; }
    const hosts: string[] = [];
    this.consentTagsOf(plugin).forEach((tag: string): void => {
      if (tag.indexOf('network:') === 0) { hosts.push(tag.substring('network:'.length)); }
    });
    return '网络访问域名：' + (hosts.length > 0 ? hosts.join(' · ') : '无自声明域名');
  }

  private consentStorageLine(): string {
    const plugin = this.consentPlugin();
    if (plugin === null) { return ''; }
    const quota = this.consentTagsOf(plugin)
      .find((tag: string): boolean => tag.indexOf('storage.quota:') === 0);
    return '数据存储空间：' + (quota !== undefined ? quota.substring('storage.quota:'.length) + ' 字节' : '默认配额');
  }

  private consentClassLine(kind: string): string {
    const plugin = this.consentPlugin();
    if (plugin === null) { return ''; }
    const view = this.consentClassOf(plugin);
    const tags = kind === 'risky' ? view.risky : (kind === 'optional' ? view.optional : view.required);
    return tags.join(' · ');
  }

  /** P5-004:用户对权限清单显式同意 → grant 落账 + 启用(拒绝必需权限的插件不得启用,§4.5)。 */
  private async consentEnable(): Promise<void> {
    const manager = LexiPluginManager.shared;
    const plugin = this.consentPlugin();
    if (!manager || plugin === null || this.busy) { return; }
    this.busy = true;
    try {
      const ok = await manager.consentEnablePlugin(plugin.manifest.id);
      const fresh = manager.installedPlugins()
        .find((item: LexiInstalledPlugin): boolean => item.manifest.id === plugin.manifest.id);
      const failure: string = fresh ? pluginFailureSummary(fresh.errorState) : '';
      this.status = ok ? `已安装并启用：${plugin.manifest.name}`
        : `启用失败：${plugin.manifest.name}${failure.length > 0 ? ' — ' + failure : ''}`;
      this.pendingConsentId = '';
    } finally {
      this.busy = false;
      this.refreshInstalled();
    }
  }

  /** P5-004:用户拒绝授权 → 插件保持已安装未启用(RFC §4.5:拒绝必需权限不得启用)。 */
  private declineConsent(): void {
    const plugin = this.consentPlugin();
    this.pendingConsentId = '';
    this.status = plugin !== null ? `已安装未启用：${plugin.manifest.name}（未授权的插件不能运行,可稍后重新授权）` : '已安装未启用';
    this.refreshInstalled();
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

  /** P2-008:已安装行的权限标签行;空集显示"未声明能力"。 */
  private permissionTagsLine(plugin: LexiInstalledPlugin): string {
    const manager = LexiPluginManager.shared;
    if (!manager) { return ''; }
    const tags = manager.permissionTagsOf(plugin.manifest.id);
    return tags.length > 0 ? '权限: ' + tags.join(' · ') : '权限: 未声明能力';
  }

  private versionLabel(plugin: LexiInstalledPlugin): string {
    const manager = LexiPluginManager.shared;
    const current = manager ? manager.pluginVersion(plugin.manifest.id) : '';
    return current.length > 0 ? current : plugin.manifest.version;
  }

  /** P5-004:声明了能力且尚未授权的已装插件 = 待授权(未授权不能运行)。 */
  private awaitingConsent(plugin: LexiInstalledPlugin): boolean {
    const manager = LexiPluginManager.shared;
    if (!manager || plugin.enabled || !plugin.manifest.capabilitiesDeclared) { return false; }
    return manager.permissionStateOf(plugin.manifest.id) !== 'granted';
  }

  /** 已安装行的状态行:errorState 非空时不出现"已启用"字样。 */
  private stateLine(plugin: LexiInstalledPlugin): string {
    const version: string = `v${this.versionLabel(plugin)}`;
    const suffix: string = ` · ${version} · ${plugin.manifest.id}`;
    if (pluginFailureKind(plugin.errorState) !== 'normal') {
      return pluginFailureLabel(plugin.errorState) + suffix;
    }
    if (plugin.enabled) { return '已启用' + suffix; }
    if (this.awaitingConsent(plugin)) { return '待授权·未启用' + suffix; }
    return '已停用' + suffix;
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

      if (this.pendingGrantEntry !== null && !this.busy) {
        // P2-008:重授权确认行——用户确认后以 grantApproved 重新安装(RFC §4.5)。
        Column({ space: 6 }) {
          Text(`「${this.pendingGrantEntry.name}」升级引入新权限，确认前请核对来源与权限`)
            .fontSize(11).fontColor($r('app.color.error')).width('100%')
          Button('重新授权并安装', { type: ButtonType.Normal })
            .height(34).fontSize(12).borderRadius(10)
            .backgroundColor($r('app.color.brand')).fontColor($r('app.color.inverse_text'))
            .onClick((): void => {
              const entry = this.pendingGrantEntry;
              if (entry !== null) { this.install(entry, true); }
            })
        }
        .width('100%').alignItems(HorizontalAlign.Start)
        .padding(10).backgroundColor($r('app.color.soft_surface')).borderRadius(10)
      }

      if (this.pendingConsentId.length > 0 && !this.busy && this.consentPlugin() !== null) {
        // P5-004 授权面板(RFC §4.5):插件元数据 + 权限分级清单 → 显式同意才启用;
        // 拒绝(暂不启用)= 插件保持已安装未启用,不能运行。
        Column({ space: 6 }) {
          Text('安装授权确认：' + this.consentTitleLine())
            .fontSize(12).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary')).width('100%')
          Text(this.consentMetaLine())
            .fontSize(10).fontColor($r('app.color.text_secondary')).width('100%')
          Text(this.consentSignatureLine())
            .fontSize(10).fontColor($r('app.color.text_secondary')).width('100%')
          Text(this.consentDisclosureLine())
            .fontSize(10).fontColor($r('app.color.text_secondary')).width('100%')
          Text(this.consentNetworkLine())
            .fontSize(10).fontColor($r('app.color.text_secondary')).width('100%')
          Text(this.consentStorageLine())
            .fontSize(10).fontColor($r('app.color.text_secondary')).width('100%')
          if (this.consentClassLine('risky').length > 0) {
            Text('高风险权限: ' + this.consentClassLine('risky'))
              .fontSize(10).fontColor($r('app.color.error')).width('100%')
          }
          if (this.consentClassLine('optional').length > 0) {
            Text('可选权限: ' + this.consentClassLine('optional'))
              .fontSize(10).fontColor($r('app.color.text_secondary')).width('100%')
          }
          if (this.consentClassLine('required').length > 0) {
            Text('必需/基线权限: ' + this.consentClassLine('required'))
              .fontSize(10).fontColor($r('app.color.text_secondary')).width('100%')
          }
          Text('同意 = 按上述清单授权并启用;拒绝 = 保持未启用(未授权的插件不能运行)。')
            .fontSize(10).fontColor($r('app.color.text_secondary')).width('100%')
          Row({ space: 8 }) {
            Button('同意并启用', { type: ButtonType.Normal })
              .height(34).fontSize(12).borderRadius(10)
              .backgroundColor($r('app.color.brand')).fontColor($r('app.color.inverse_text'))
              .onClick((): void => { this.consentEnable(); })
            Button('暂不启用', { type: ButtonType.Normal })
              .height(34).fontSize(12).borderRadius(10)
              .backgroundColor($r('app.color.soft_surface')).fontColor($r('app.color.text_primary'))
              .onClick((): void => { this.declineConsent(); })
          }
          .width('100%')
        }
        .width('100%').alignItems(HorizontalAlign.Start)
        .padding(10).backgroundColor($r('app.color.soft_surface')).borderRadius(10)
      }

      if (this.installed.length > 0) {
        // P5-007/KI-1（P0-012 真机发现）：根 Column height('100%') 把面板钉在视口高度上，
        // 已安装列表若不限高，行数一溢出，layoutWeight(1) 的市场条目 Scroll 就拿到
        // max(0, 剩余空间)=0 高——条目不是“滚出视口”而是根本不渲染。把已安装列表改成
        // 内部限高滚动（constraintSize 上限按面板高度的百分比），行数再多也只占面板一部分，
        // 市场条目区始终保住正高度（已安装 8-9 行时条目仍可见、可达）。
        Scroll() {
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
                // P2-008:权限标签展示(授权可读性;空标签=未声明能力)。
                Text(this.permissionTagsLine(plugin))
                  .fontSize(9).fontColor($r('app.color.text_secondary'))
                  .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
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
              Button('撤销授权', { type: ButtonType.Normal })
                .height(30)
                .fontSize(11)
                .borderRadius(8)
                .enabled(!this.busy)
                .backgroundColor($r('app.color.soft_surface'))
                .fontColor($r('app.color.error'))
                .onClick((): void => { this.revokePermissions(plugin.manifest.id); })
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
        .width('100%')
        .constraintSize({ maxHeight: '34%' })
        .scrollBar(BarState.Auto)
        .align(Alignment.TopStart)
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
                  if (isTrustedInstallHash(entry.sha256)) {
                    Text('哈希已校验').fontSize(10).fontColor($r('app.color.brand'))
                  } else if (entry.zipUrl.length > 0) {
                    Text('旧版·缺哈希').fontSize(10).fontColor($r('app.color.text_secondary'))
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

              Button(entry.zipUrl ? (isTrustedInstallHash(entry.sha256) ? '安装' : '缺哈希') : '无下载地址', { type: ButtonType.Normal })
                .height(34)
                .fontSize(12)
                .borderRadius(10)
                .enabled(!this.busy && entry.zipUrl.length > 0 && isTrustedInstallHash(entry.sha256))
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
