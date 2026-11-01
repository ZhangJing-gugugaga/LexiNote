// Community plugin market sheet: fetch an index, install entries over HTTP.

import { LexiPluginManager } from '../../core/plugin/LexiPluginRuntime';
import { LexiPluginMarketEntry } from '../../core/plugin/LexiPluginMarketModel';

const DEFAULT_MARKET_URL: string = 'https://raw.githubusercontent.com/ZhangJing-gugugaga/lexinote-releases/master/community-plugins.json';
// 模拟器/调试用本地源:10.0.2.2 映射到宿主机回环地址
const DEMO_MARKET_URL: string = 'http://10.0.2.2:8099/market.json';

@Component
export struct LexiPluginMarketSheet {
  onInstalled: (pluginId: string) => void = (_pluginId: string): void => {};
  @State private entries: LexiPluginMarketEntry[] = [];
  @State private status: string = '';
  @State private busy: boolean = false;
  @State private marketUrl: string = DEFAULT_MARKET_URL;
  @State private demoMode: boolean = false;

  aboutToAppear(): void {
    this.load();
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
      this.entries = await manager.fetchMarket(this.marketUrl);
      this.status = this.entries.length > 0 ? `共 ${this.entries.length} 个插件` : '市场为空';
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
      const pluginId = await manager.installFromUrl(entry.zipUrl);
      this.status = `已安装并启用：${entry.name}`;
      this.onInstalled(pluginId);
    } catch (error) {
      this.status = `安装失败：${String(error)}`;
    } finally {
      this.busy = false;
    }
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
          .onClick((): void => { this.load(); })
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

      if (this.entries.length === 0 && !this.busy) {
        Text('暂无可用插件。默认索引指向 lexinote-releases 仓库；调试时可点击"演示源"。')
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
