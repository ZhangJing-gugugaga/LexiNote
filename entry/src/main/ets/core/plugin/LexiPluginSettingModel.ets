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
    const type = textOf(source, 'type');
    const name = textOf(source, 'name');
    if (!name) { continue; }
    const def = new LexiPluginSettingDef();
    def.name = name;
    def.type = ['heading', 'toggle', 'text', 'textarea', 'dropdown', 'slider'].includes(type) ? type : 'text';
    def.key = textOf(source, 'key');
    if (def.type !== 'heading' && !def.key) { continue; }
    def.desc = textOf(source, 'desc');
    def.placeholder = textOf(source, 'placeholder');
    const defaultRaw = source['default'];
    if (typeof defaultRaw === 'string') { def.defaultValue = defaultRaw; }
    else if (typeof defaultRaw === 'number' || typeof defaultRaw === 'boolean') { def.defaultValue = String(defaultRaw); }
    const options = source['options'];
    if (options && typeof options === 'object' && !Array.isArray(options)) {
      def.optionsJson = JSON.stringify(options);
    }
    def.min = numberOf(source, 'min', 0);
    def.max = numberOf(source, 'max', 100);
    def.step = numberOf(source, 'step', 1);
    result.push(def);
  }
  return result;
}
