// Native renderer for declarative plugin settings (PluginSettingTab.getSettingDefinitions).
// Values live in the plugin's data.json; every change is persisted and pushed to the plugin.

import { LexiPluginManager } from '../../core/plugin/LexiPluginRuntime';
import { LexiPluginSettingDef } from '../../core/plugin/LexiPluginSettingModel';

@Observed
class LexiSettingRowState {
  def: LexiPluginSettingDef = new LexiPluginSettingDef();
  value: string = '';
  optionKeys: string[] = [];
  optionLabels: string[] = [];
}

@Component
export struct LexiPluginSettingsSheet {
  pluginId: string = '';
  @State private rows: LexiSettingRowState[] = [];
  @State private status: string = '';

  aboutToAppear(): void {
    this.load();
  }

  private async load(): Promise<void> {
    const manager = LexiPluginManager.shared;
    if (!manager) {
      this.status = '插件内核尚未就绪';
      return;
    }
    const defs = manager.pluginSettingDefinitions(this.pluginId);
    let data: Record<string, Object> = {};
    try {
      const raw = await manager.readPluginData(this.pluginId);
      if (raw.trim().length > 0) { data = JSON.parse(raw) as Record<string, Object>; }
    } catch { data = {}; }
    const rows: LexiSettingRowState[] = [];
    for (const def of defs) {
      const row = new LexiSettingRowState();
      row.def = def;
      const current = data[def.key];
      row.value = current !== undefined && current !== null ? String(current) : def.defaultValue;
      if (def.type === 'dropdown') {
        try {
          const options = JSON.parse(def.optionsJson) as Record<string, string>;
          for (const key of Object.keys(options)) {
            row.optionKeys.push(key);
            row.optionLabels.push(options[key]);
          }
        } catch {
          row.optionKeys = [];
          row.optionLabels = [];
        }
      }
      rows.push(row);
    }
    this.rows = rows;
    this.status = `共 ${rows.filter((item: LexiSettingRowState): boolean => item.def.type !== 'heading').length} 项设置`;
  }

  private async save(): Promise<void> {
    const manager = LexiPluginManager.shared;
    if (!manager) { return; }
    const payload: Record<string, Object> = {};
    for (const row of this.rows) {
      if (row.def.type === 'heading' || !row.def.key) { continue; }
      if (row.def.type === 'toggle') {
        payload[row.def.key] = (row.value === 'true') as Object;
      } else if (row.def.type === 'slider') {
        payload[row.def.key] = Number(row.value) as Object;
      } else {
        payload[row.def.key] = row.value as Object;
      }
    }
    try {
      await manager.writePluginData(this.pluginId, JSON.stringify(payload));
      this.status = '已保存';
    } catch (error) {
      this.status = '保存失败: ' + String(error);
    }
  }

  private selectOptions(row: LexiSettingRowState): SelectOption[] {
    const options: SelectOption[] = [];
    for (let i = 0; i < row.optionKeys.length; i++) {
      options.push({ value: row.optionLabels[i] });
    }
    return options;
  }

  private selectIndex(row: LexiSettingRowState): number {
    const index = row.optionKeys.indexOf(row.value);
    return index >= 0 ? index : 0;
  }

  @Builder
  private control(row: LexiSettingRowState) {
    if (row.def.type === 'toggle') {
      Toggle({ type: ToggleType.Switch, isOn: row.value === 'true' })
        .selectedColor($r('app.color.brand'))
        .onChange((isOn: boolean): void => {
          row.value = isOn ? 'true' : 'false';
          this.save();
        })
    } else if (row.def.type === 'dropdown') {
      Select(this.selectOptions(row))
        .selected(this.selectIndex(row))
        .value(row.optionLabels.length > 0 ? row.optionLabels[this.selectIndex(row)] : '')
        .font({ size: 12 })
        .onSelect((index: number): void => {
          row.value = row.optionKeys[index];
          this.save();
        })
    } else if (row.def.type === 'slider') {
      Slider({
        value: Number(row.value) || 0,
        min: row.def.min,
        max: row.def.max,
        step: row.def.step
      })
        .width(160)
        .selectedColor($r('app.color.brand'))
        .onChange((value: number): void => {
          row.value = String(Math.round(value * 100) / 100);
          this.save();
        })
    } else if (row.def.type === 'textarea') {
      TextArea({ text: row.value, placeholder: row.def.placeholder })
        .width(220)
        .height(72)
        .fontSize(12)
        .backgroundColor($r('app.color.soft_surface'))
        .onChange((text: string): void => {
          row.value = text;
          this.save();
        })
    } else {
      TextInput({ text: row.value, placeholder: row.def.placeholder })
        .width(220)
        .height(36)
        .fontSize(12)
        .backgroundColor($r('app.color.soft_surface'))
        .onChange((text: string): void => {
          row.value = text;
          this.save();
        })
    }
  }

  @Builder
  private rowView(row: LexiSettingRowState) {
    if (row.def.type === 'heading') {
      Text(row.def.name)
        .fontSize(13)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .margin({ top: 6 })
    } else {
      Row({ space: 10 }) {
        Column({ space: 3 }) {
          Text(row.def.name).fontSize(13).fontColor($r('app.color.text_primary'))
          if (row.def.desc.length > 0) {
            Text(row.def.desc)
              .fontSize(11)
              .fontColor($r('app.color.text_secondary'))
              .maxLines(2)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        this.control(row)
      }
      .width('100%')
      .padding(10)
      .backgroundColor($r('app.color.soft_surface'))
      .borderRadius(12)
    }
  }

  build() {
    Column({ space: 10 }) {
      Row({ space: 8 }) {
        Text('插件设置').fontSize(15).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
        Blank()
        Text(this.status).fontSize(11).fontColor($r('app.color.text_secondary'))
      }
      .width('100%')

      Scroll() {
        Column({ space: 8 }) {
          ForEach(this.rows, (row: LexiSettingRowState) => {
            this.rowView(row)
          }, (row: LexiSettingRowState): string => `${row.def.type}-${row.def.key || row.def.name}`)
        }
        .width('100%')
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Auto)
      .align(Alignment.TopStart)
    }
    .width('100%')
    .height('100%')
    .padding({ left: 20, right: 20, top: 16, bottom: 24 })
  }
}
