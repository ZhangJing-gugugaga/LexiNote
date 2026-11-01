// Declarative plugin setting definitions (LexiNote subset of Obsidian's SettingDefinition).
// Pure parsing/validation so the regression harness covers it.

export class LexiPluginSettingDef {
  type: string = 'text'; // heading | toggle | text | textarea | dropdown | slider
  key: string = '';
  name: string = '';
  desc: string = '';
  defaultValue: string = '';
  optionsJson: string = '{}';
  min: number = 0;
  max: number = 100;
  step: number = 1;
  placeholder: string = '';
}

function textOf(source: Record<string, Object>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

function numberOf(source: Record<string, Object>, key: string, fallback: number): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function parseSettingDefinitions(json: string): LexiPluginSettingDef[] {
  let parsed: Object | null = null;
  try { parsed = JSON.parse(json) as Object; } catch { return []; }
  if (!Array.isArray(parsed)) { return []; }
  const result: LexiPluginSettingDef[] = [];
  for (const raw of parsed as Object[]) {
    if (!raw || typeof raw !== 'object') { continue; }
    const source = raw as Record<string, Object>;
    const name = textOf(source, 'name');
    if (!name) { continue; }
    // 兼容两种形态:Obsidian 新版 {control:{type,key,defaultValue,options}} 与 LexiNote 扁平 {type,key,default}
    const control = source['control'];
    const controlObj = control && typeof control === 'object' && !Array.isArray(control)
      ? control as Record<string, Object>
      : null;
    const type = controlObj ? textOf(controlObj, 'type') : textOf(source, 'type');
    const def = new LexiPluginSettingDef();
    def.name = name;
    def.type = ['heading', 'toggle', 'text', 'textarea', 'dropdown', 'slider'].includes(type) ? type : (controlObj || type ? 'text' : 'heading');
    def.key = controlObj ? textOf(controlObj, 'key') : textOf(source, 'key');
    if (def.type !== 'heading' && !def.key) { continue; }
    def.desc = textOf(source, 'desc');
    def.placeholder = controlObj ? textOf(controlObj, 'placeholder') : textOf(source, 'placeholder');
    const defaultRaw = controlObj ? controlObj['defaultValue'] : source['default'];
    if (typeof defaultRaw === 'string') { def.defaultValue = defaultRaw; }
    else if (typeof defaultRaw === 'number' || typeof defaultRaw === 'boolean') { def.defaultValue = String(defaultRaw); }
    const options = controlObj ? controlObj['options'] : source['options'];
    if (options && typeof options === 'object' && !Array.isArray(options)) {
      def.optionsJson = JSON.stringify(options);
    }
    def.min = controlObj ? numberOf(controlObj, 'min', 0) : numberOf(source, 'min', 0);
    def.max = controlObj ? numberOf(controlObj, 'max', 100) : numberOf(source, 'max', 100);
    def.step = controlObj ? numberOf(controlObj, 'step', 1) : numberOf(source, 'step', 1);
    result.push(def);
  }
  return result;
}
