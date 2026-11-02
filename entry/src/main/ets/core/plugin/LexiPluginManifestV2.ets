// RFC §8.1/§8.2 / §14 T2.1 · Manifest v2 严格解析与 v1 迁移(LexiPluginManifestV2)。
//
// 契约要点(§8.1):
//   - manifestVersion: 2;未知 capability 必须拒绝,不得静默忽略(顶层与嵌套同罚);
//   - 未声明能力 = 没有能力(归一化后走既有 fail-closed 判定);
//   - manifest.json 不存放自身 ZIP 指纹:sha256 一律拒绝(归签名 Registry Target Metadata);
//   - id 规则与 v1 一致;version 必须 x.y.z 数字段。
// 迁移要点(§8.2):
//   - minAppVersion→compatibility.obsidianApiLevel;minApiVersion→compatibility.min;
//     isDesktopOnly→platforms;capabilities.fs→vault.write;network[]→network.origins;
//     clipboard→clipboard;
//   - 旧插件进 Legacy Compatibility Profile:迁移产物 legacyProfile=true,宿主沿用 v1 语义,
//     旧权限不自动继承为 Native 细粒度权限。
// 本模块零 @kit 依赖,可在 Node 转译真跑(plugin-manifest-v2.cjs);schema 快照见
// tools/plugin-contract/schema/manifest-v2.schema.json(与 knownCapabilityKeys 对账)。

export class V2VaultScope {
  enabled: boolean = false;
  paths: string[] = [];
}

export class V2VaultCaps {
  read: V2VaultScope = new V2VaultScope();
  write: V2VaultScope = new V2VaultScope();
  delete: boolean = false;
}

export class V2EditorCaps {
  readActive: boolean = false;
  writeSelection: boolean = false;
  writeDocument: boolean = false;
  /** 'none' | 'declarative' | 'trusted-cm6'(RFC §3.1 运行等级)。 */
  extensions: string = 'none';
}

export class V2WorkspaceCaps {
  commands: boolean = false;
  views: boolean = false;
}

export class V2NetworkCaps {
  origins: string[] = [];
  methods: string[] = [];
  maxRequestBytes: number = 65536;
  maxResponseBytes: number = 1048576;
}

export class V2ClipboardCaps {
  read: boolean = false;
  write: boolean = false;
}

export class V2StorageCaps {
  quotaBytes: number = 1048576;
}

export class V2Compatibility {
  min: string = '0.0.0';
  maxExclusive: string = '';
  obsidianApiLevel: string = '0.0.0';
}

export class V2Entrypoints {
  service: string = 'main.js';
  views: string = '';
  editor: string = '';
  markdown: string = '';
}

export class LexiManifestV2Caps {
  vault: V2VaultCaps = new V2VaultCaps();
  editor: V2EditorCaps = new V2EditorCaps();
  workspace: V2WorkspaceCaps = new V2WorkspaceCaps();
  network: V2NetworkCaps = new V2NetworkCaps();
  clipboard: V2ClipboardCaps = new V2ClipboardCaps();
  storage: V2StorageCaps = new V2StorageCaps();
  notifications: boolean = false;
}

/** parseManifestV2 的归一化输出:capabilities 是既有 fail-closed 模型的 legacy 形状。 */
export class LexiManifestV2Normalized {
  manifestVersion: number = 2;
  id: string = '';
  name: string = '';
  version: string = '';
  author: string = '';
  description: string = '';
  license: string = '';
  repository: string = '';
  entrypoints: V2Entrypoints = new V2Entrypoints();
  platforms: string[] = [];
  compatibility: V2Compatibility = new V2Compatibility();
  /** legacy 形状(既有 fail-closed 模型):fs = vault.write.enabled;network = 归一化 host 列表;clipboard = 读或写。 */
  capabilities: V2NormalizedCaps = new V2NormalizedCaps();
  /** 细粒度 v2 能力视图(T2.2/T2.3 逐步接授权面)。 */
  v2: LexiManifestV2Caps = new LexiManifestV2Caps();
  /** §8.2:旧清单迁移产物标记,宿主沿用 legacy 语义。 */
  legacyProfile: boolean = false;
}

export class V2NormalizedCaps {
  fs: boolean = false;
  network: string[] = [];
  clipboard: boolean = false;
}

const CAPABILITY_KEYS: string[] = ['vault', 'editor', 'workspace', 'network', 'clipboard', 'storage', 'notifications'];
const PLATFORMS: string[] = ['harmonyos-phone', 'harmonyos-tablet', 'harmonyos-pc'];
const TOP_LEVEL_KEYS: string[] = ['manifestVersion', 'id', 'name', 'version', 'author', 'description',
  'authorUrl', 'license', 'repository', 'homepage', 'keywords', 'funding', 'entrypoints',
  'compatibility', 'platforms', 'capabilities', 'dependencies', 'optionalDependencies',
  'minAppVersion', 'isDesktopOnly', 'legacyProfile'];
const ENTRY_KEYS: string[] = ['service', 'views', 'editor', 'markdown'];
const SCOPE_KEYS: string[] = ['enabled', 'paths'];

/** 已知能力键清单(schema 与解析器的单一真源;门禁对账)。 */
export function knownCapabilityKeys(): string[] {
  return CAPABILITY_KEYS.slice();
}

function isPlainObject(value: Object | undefined | null): boolean {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(message);
}

/** 与 v1 normalizeCapabilityHost 同语义的本地实现(host 归一化,保持模块零依赖)。 */
function normalizeHost(entry: string): string {
  let value = entry.trim().toLowerCase();
  if (value.indexOf('://') > 0) { value = value.substring(value.indexOf('://') + 3); }
  const slash = value.indexOf('/');
  if (slash >= 0) { value = value.substring(0, slash); }
  const colon = value.indexOf(':');
  if (colon >= 0) { value = value.substring(0, colon); }
  return value;
}

function semverOrFail(value: Object | undefined, field: string): string {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    fail(field + ' 必须是 x.y.z 数字版本号: ' + String(value));
  }
  return value as string;
}

function parseVaultScope(value: Object | undefined, field: string): V2VaultScope {
  const scope = new V2VaultScope();
  if (value === undefined) { return scope; }
  if (typeof value === 'boolean') {
    // 允许布尔简写:vault.write: true ≙ {enabled:true}
    scope.enabled = value as boolean;
    return scope;
  }
  if (!isPlainObject(value)) { fail('capability ' + field + ' 形状非法'); }
  const record = value as Record<string, Object>;
  for (const key of Object.keys(record)) {
    if (SCOPE_KEYS.indexOf(key) < 0) { fail('未知嵌套 capability 键: ' + field + '.' + key); }
  }
  if (record['enabled'] !== undefined) {
    if (typeof record['enabled'] !== 'boolean') { fail(field + '.enabled 必须是布尔'); }
    scope.enabled = record['enabled'] as boolean;
  }
  if (record['paths'] !== undefined) {
    if (!Array.isArray(record['paths'])) { fail(field + '.paths 必须是数组'); }
    for (const path of record['paths'] as Object[]) {
      if (typeof path !== 'string' || (path as string).length === 0) { fail(field + '.paths 元素必须是字符串'); }
      scope.paths.push(path as string);
    }
  }
  return scope;
}

function parseCaps(source: Record<string, Object>): LexiManifestV2Caps {
  const caps = new LexiManifestV2Caps();
  const rawCaps = source['capabilities'];
  if (rawCaps === undefined) { return caps; }
  if (!isPlainObject(rawCaps)) { fail('capabilities 必须是对象'); }
  const capsRecord = rawCaps as Record<string, Object>;
  for (const key of Object.keys(capsRecord)) {
    if (CAPABILITY_KEYS.indexOf(key) < 0) {
      fail('未知 capability: ' + key + '（不认识的 capability 必须拒绝,不得静默忽略）');
    }
  }
  if (capsRecord['vault'] !== undefined) {
    const vaultValue = capsRecord['vault'];
    if (!isPlainObject(vaultValue)) { fail('capability vault 形状非法'); }
    const vaultRecord = vaultValue as Record<string, Object>;
    for (const key of Object.keys(vaultRecord)) {
      if (['read', 'write', 'delete'].indexOf(key) < 0) { fail('未知嵌套 capability 键: vault.' + key); }
    }
    caps.vault.read = parseVaultScope(vaultRecord['read'], 'vault.read');
    caps.vault.write = parseVaultScope(vaultRecord['write'], 'vault.write');
    if (vaultRecord['delete'] !== undefined) {
      if (typeof vaultRecord['delete'] !== 'boolean') { fail('vault.delete 必须是布尔'); }
      caps.vault.delete = vaultRecord['delete'] as boolean;
    }
  }
  if (capsRecord['editor'] !== undefined) {
    const editorValue = capsRecord['editor'];
    if (!isPlainObject(editorValue)) { fail('capability editor 形状非法'); }
    const editorRecord = editorValue as Record<string, Object>;
    for (const key of Object.keys(editorRecord)) {
      if (['readActive', 'writeSelection', 'writeDocument', 'extensions'].indexOf(key) < 0) {
        fail('未知嵌套 capability 键: editor.' + key);
      }
    }
    if (editorRecord['readActive'] !== undefined) {
      if (typeof editorRecord['readActive'] !== 'boolean') { fail('editor.readActive 必须是布尔'); }
      caps.editor.readActive = editorRecord['readActive'] as boolean;
    }
    if (editorRecord['writeSelection'] !== undefined) {
      if (typeof editorRecord['writeSelection'] !== 'boolean') { fail('editor.writeSelection 必须是布尔'); }
      caps.editor.writeSelection = editorRecord['writeSelection'] as boolean;
    }
    if (editorRecord['writeDocument'] !== undefined) {
      if (typeof editorRecord['writeDocument'] !== 'boolean') { fail('editor.writeDocument 必须是布尔'); }
      caps.editor.writeDocument = editorRecord['writeDocument'] as boolean;
    }
    if (editorRecord['extensions'] !== undefined) {
      const ext = editorRecord['extensions'];
      if (typeof ext !== 'string' || ['none', 'declarative', 'trusted-cm6'].indexOf(ext as string) < 0) {
        fail('editor.extensions 只允许 none/declarative/trusted-cm6');
      }
      caps.editor.extensions = ext as string;
    }
  }
  if (capsRecord['workspace'] !== undefined) {
    const wsValue = capsRecord['workspace'];
    if (!isPlainObject(wsValue)) { fail('capability workspace 形状非法'); }
    const wsRecord = wsValue as Record<string, Object>;
    for (const key of Object.keys(wsRecord)) {
      if (['commands', 'views'].indexOf(key) < 0) { fail('未知嵌套 capability 键: workspace.' + key); }
      if (typeof wsRecord[key] !== 'boolean') { fail('workspace.' + key + ' 必须是布尔'); }
    }
    caps.workspace.commands = wsRecord['commands'] === true;
    caps.workspace.views = wsRecord['views'] === true;
  }
  if (capsRecord['network'] !== undefined) {
    const netValue = capsRecord['network'];
    if (netValue === null || netValue === undefined) { fail('capability network 形状非法'); }
    if (Array.isArray(netValue)) {
      // v1 兼容简写:network: ["host", …] ≙ {origins:[…]}
      for (const entry of netValue as Object[]) {
        if (typeof entry !== 'string') { fail('network origins 元素必须是字符串'); }
        const host = normalizeHost(entry as string);
        if (host.length > 0) { caps.network.origins.push(host); }
      }
    } else if (isPlainObject(netValue)) {
      const netRecord = netValue as Record<string, Object>;
      for (const key of Object.keys(netRecord)) {
        if (['origins', 'methods', 'maxRequestBytes', 'maxResponseBytes'].indexOf(key) < 0) {
          fail('未知嵌套 capability 键: network.' + key);
        }
      }
      if (netRecord['origins'] !== undefined) {
        if (!Array.isArray(netRecord['origins'])) { fail('network.origins 必须是数组'); }
        for (const entry of netRecord['origins'] as Object[]) {
          if (typeof entry !== 'string') { fail('network.origins 元素必须是字符串'); }
          const host = normalizeHost(entry as string);
          if (host.length > 0) { caps.network.origins.push(host); }
        }
      }
      if (netRecord['methods'] !== undefined) {
        if (!Array.isArray(netRecord['methods'])) { fail('network.methods 必须是数组'); }
        for (const method of netRecord['methods'] as Object[]) {
          if (typeof method !== 'string') { fail('network.methods 元素必须是字符串'); }
          caps.network.methods.push((method as string).toUpperCase());
        }
      }
      if (netRecord['maxRequestBytes'] !== undefined) {
        if (typeof netRecord['maxRequestBytes'] !== 'number') { fail('network.maxRequestBytes 必须是数字'); }
        caps.network.maxRequestBytes = netRecord['maxRequestBytes'] as number;
      }
      if (netRecord['maxResponseBytes'] !== undefined) {
        if (typeof netRecord['maxResponseBytes'] !== 'number') { fail('network.maxResponseBytes 必须是数字'); }
        caps.network.maxResponseBytes = netRecord['maxResponseBytes'] as number;
      }
    } else {
      fail('capability network 形状非法');
    }
  }
  if (capsRecord['clipboard'] !== undefined) {
    const clipValue = capsRecord['clipboard'];
    if (typeof clipValue === 'boolean') {
      caps.clipboard.write = clipValue as boolean;
      caps.clipboard.read = clipValue as boolean;
    } else if (isPlainObject(clipValue)) {
      const clipRecord = clipValue as Record<string, Object>;
      for (const key of Object.keys(clipRecord)) {
        if (['read', 'write'].indexOf(key) < 0) { fail('未知嵌套 capability 键: clipboard.' + key); }
        if (typeof clipRecord[key] !== 'boolean') { fail('clipboard.' + key + ' 必须是布尔'); }
      }
      caps.clipboard.read = clipRecord['read'] === true;
      caps.clipboard.write = clipRecord['write'] === true;
    } else {
      fail('capability clipboard 形状非法');
    }
  }
  if (capsRecord['storage'] !== undefined) {
    const storageValue = capsRecord['storage'];
    if (isPlainObject(storageValue)) {
      const storageRecord = storageValue as Record<string, Object>;
      for (const key of Object.keys(storageRecord)) {
        if (['quotaBytes'].indexOf(key) < 0) { fail('未知嵌套 capability 键: storage.' + key); }
      }
      if (storageRecord['quotaBytes'] !== undefined) {
        if (typeof storageRecord['quotaBytes'] !== 'number') { fail('storage.quotaBytes 必须是数字'); }
        caps.storage.quotaBytes = storageRecord['quotaBytes'] as number;
      }
    } else {
      fail('capability storage 形状非法');
    }
  }
  if (capsRecord['notifications'] !== undefined) {
    if (typeof capsRecord['notifications'] !== 'boolean') { fail('notifications 必须是布尔'); }
    caps.notifications = capsRecord['notifications'] as boolean;
  }
  return caps;
}

/**
 * 严格解析 manifest v2。任何违规(未知 capability/字段、畸形版本、携带 sha256)一律抛错,
 * 宿主据此把插件判为 broken(fail-closed)。
 */
export function parseManifestV2(json: string): LexiManifestV2Normalized {
  let raw: Record<string, Object>;
  try {
    raw = JSON.parse(json) as Record<string, Object>;
  } catch (error) {
    fail('manifest 不是合法 JSON');
  }
  if (!isPlainObject(raw as Object)) { fail('manifest 必须是 JSON 对象'); }
  const record = raw as Record<string, Object>;
  if (record['manifestVersion'] === undefined) {
    fail('manifestVersion 缺失(本解析器只接受 manifestVersion: 2)');
  }
  if (record['manifestVersion'] !== 2) {
    fail('不支持的 manifestVersion: ' + String(record['manifestVersion']) + '（v2 解析器只接受 2,未来版本 fail-closed）');
  }
  for (const key of Object.keys(record)) {
    if (TOP_LEVEL_KEYS.indexOf(key) < 0) {
      if (key === 'sha256') {
        fail('v2 manifest 不得携带 sha256(§8.1:完整性指纹归签名 Registry Target Metadata)');
      }
      fail('未知 manifest 字段: ' + key);
    }
  }
  const normalized = new LexiManifestV2Normalized();
  const id = record['id'];
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(id as string)) {
    fail('插件 id 只允许小写字母、数字与连字符');
  }
  normalized.id = id as string;
  if (typeof record['name'] !== 'string' || (record['name'] as string).trim().length === 0) {
    fail('manifest 缺少 name');
  }
  normalized.name = (record['name'] as string).trim();
  normalized.version = semverOrFail(record['version'], 'version');
  if (typeof record['author'] !== 'string' || (record['author'] as string).trim().length === 0) {
    fail('manifest 缺少 author');
  }
  normalized.author = (record['author'] as string).trim();
  if (record['description'] !== undefined && typeof record['description'] === 'string') {
    normalized.description = record['description'] as string;
  }
  if (record['license'] !== undefined) {
    if (typeof record['license'] !== 'string') { fail('license 必须是字符串'); }
    normalized.license = record['license'] as string;
  }
  if (record['repository'] !== undefined) {
    if (typeof record['repository'] !== 'string') { fail('repository 必须是字符串'); }
    normalized.repository = record['repository'] as string;
  }
  if (record['entrypoints'] !== undefined) {
    const entryValue = record['entrypoints'];
    if (!isPlainObject(entryValue)) { fail('entrypoints 必须是对象'); }
    const entryRecord = entryValue as Record<string, Object>;
    for (const key of Object.keys(entryRecord)) {
      if (ENTRY_KEYS.indexOf(key) < 0) { fail('未知 entrypoint: ' + key + '（所有入口必须经 Manifest 声明）'); }
      if (typeof entryRecord[key] !== 'string') { fail('entrypoints.' + key + ' 必须是字符串'); }
    }
    normalized.entrypoints.service = (entryRecord['service'] as string) || 'main.js';
    normalized.entrypoints.views = (entryRecord['views'] as string) || '';
    normalized.entrypoints.editor = (entryRecord['editor'] as string) || '';
    normalized.entrypoints.markdown = (entryRecord['markdown'] as string) || '';
  }
  if (record['platforms'] !== undefined) {
    if (!Array.isArray(record['platforms'])) { fail('platforms 必须是数组'); }
    for (const platform of record['platforms'] as Object[]) {
      if (typeof platform !== 'string' || PLATFORMS.indexOf(platform as string) < 0) {
        fail('未知 platform: ' + String(platform) + '（允许: ' + PLATFORMS.join('/') + '）');
      }
      normalized.platforms.push(platform as string);
    }
  }
  if (record['compatibility'] !== undefined) {
    const compatValue = record['compatibility'];
    if (!isPlainObject(compatValue)) { fail('compatibility 必须是对象'); }
    const compatRecord = compatValue as Record<string, Object>;
    for (const key of Object.keys(compatRecord)) {
      if (['min', 'maxExclusive', 'obsidianApiLevel', 'lexinote', 'harmonyOS'].indexOf(key) < 0) {
        fail('未知 compatibility 键: ' + key);
      }
    }
    if (compatRecord['obsidianApiLevel'] !== undefined) {
      if (typeof compatRecord['obsidianApiLevel'] !== 'string') { fail('compatibility.obsidianApiLevel 必须是字符串'); }
      normalized.compatibility.obsidianApiLevel = compatRecord['obsidianApiLevel'] as string;
    }
    if (compatRecord['min'] !== undefined) {
      normalized.compatibility.min = semverOrFail(compatRecord['min'], 'compatibility.min');
    }
    if (compatRecord['maxExclusive'] !== undefined && compatRecord['maxExclusive'] !== '') {
      normalized.compatibility.maxExclusive = semverOrFail(compatRecord['maxExclusive'], 'compatibility.maxExclusive');
    }
    // lexinote:{min,maxExclusive} 与 harmonyOS:{min} 嵌套形状:键白名单已放行,值形状宽松校验
    for (const nested of ['lexinote', 'harmonyOS']) {
      if (compatRecord[nested] !== undefined && !isPlainObject(compatRecord[nested])) {
        fail('compatibility.' + nested + ' 必须是对象');
      }
    }
  }
  if (record['legacyProfile'] !== undefined) {
    if (typeof record['legacyProfile'] !== 'boolean') { fail('legacyProfile 必须是布尔'); }
    normalized.legacyProfile = record['legacyProfile'] as boolean;
  }
  normalized.v2 = parseCaps(record);
  // 归一化进既有 fail-closed 模型的 legacy 形状:未声明能力=没有能力
  normalized.capabilities.fs = normalized.v2.vault.write.enabled;
  normalized.capabilities.network = normalized.v2.network.origins.slice();
  normalized.capabilities.clipboard = normalized.v2.clipboard.read || normalized.v2.clipboard.write;
  return normalized;
}

/** v2 文档形状(迁移产物/未解析的 v2 结构;capabilities 是细粒度视图,与 §8.1 示例同名同形)。 */
export class LexiManifestV2Document {
  manifestVersion: number = 2;
  id: string = '';
  name: string = '';
  version: string = '';
  author: string = '';
  description: string = '';
  license: string = '';
  repository: string = '';
  entrypoints: V2Entrypoints = new V2Entrypoints();
  platforms: string[] = [];
  compatibility: V2Compatibility = new V2Compatibility();
  capabilities: LexiManifestV2Caps = new LexiManifestV2Caps();
  legacyProfile: boolean = false;
}

/** v1 迁移输入的最小形状(宽松读取,与 v1 解析器同字段);输出为可通过 parseManifestV2 的 v2 文档。 */
export function migrateManifestV1(json: string): LexiManifestV2Document {
  let raw: Record<string, Object>;
  try {
    raw = JSON.parse(json) as Record<string, Object>;
  } catch (error) {
    fail('迁移输入不是合法 JSON');
  }
  if (!isPlainObject(raw as Object)) { fail('迁移输入必须是 JSON 对象'); }
  const record = raw as Record<string, Object>;
  const doc = new LexiManifestV2Document();
  const id = record['id'];
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(id as string)) {
    fail('插件 id 只允许小写字母、数字与连字符');
  }
  doc.id = id as string;
  if (typeof record['name'] !== 'string' || (record['name'] as string).trim().length === 0) {
    fail('manifest 缺少 name');
  }
  doc.name = (record['name'] as string).trim();
  doc.version = semverOrFail(record['version'], 'version');
  if (typeof record['author'] !== 'string' || (record['author'] as string).trim().length === 0) {
    fail('manifest 缺少 author');
  }
  doc.author = (record['author'] as string).trim();
  // §8.2 映射表
  if (typeof record['minAppVersion'] === 'string') {
    doc.compatibility.obsidianApiLevel = record['minAppVersion'] as string;
  }
  if (typeof record['minApiVersion'] === 'string') {
    doc.compatibility.min = record['minApiVersion'] as string;
  }
  if (record['isDesktopOnly'] === true) {
    doc.platforms.push('harmonyos-pc');
  }
  const caps = record['capabilities'];
  if (isPlainObject(caps)) {
    const capsRecord = caps as Record<string, Object>;
    if (capsRecord['fs'] === true) { doc.capabilities.vault.write.enabled = true; }
    if (Array.isArray(capsRecord['network'])) {
      for (const entry of capsRecord['network'] as Object[]) {
        // §8.2 是机械映射:保留原串,host 归一化在解析层统一做
        if (typeof entry === 'string' && (entry as string).length > 0) {
          doc.capabilities.network.origins.push(entry as string);
        }
      }
    }
    if (capsRecord['clipboard'] === true) { doc.capabilities.clipboard.read = true; }
  }
  // §8.2 迁移原则:旧插件进 Legacy Compatibility Profile,旧权限不自动继承为 Native 权限
  doc.legacyProfile = true;
  return doc;
}
