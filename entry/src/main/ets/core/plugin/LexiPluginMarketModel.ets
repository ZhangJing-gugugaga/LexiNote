// Community plugin index model. Pure parsing so the regression harness can cover it.
//
// Single schema v1 (docs/lexinote_plugin_bridge_spec.md §6):
//   { schemaVersion: 1, plugins: [ { id, name, version, minApiVersion, isDesktopOnly,
//                                    sha256, zipUrl, repo, description, author,
//                                    capabilities, updatedAt } ] }
// The machine-readable form of these rules lives in tools/plugin-dist/market-index-v1.schema.json
// and is implemented once for Node in tools/plugin-dist/market-index-v1.cjs. This file is the
// ArkTS twin; scripts/tests/plugin-dist-regression.cjs feeds both the same fixture matrix and
// fails on any accept/reject divergence, so the export side and the client cannot drift apart.
//
// v1 rules, in one place:
//   * required per entry: id, name, version, author, sha256, zipUrl
//   * id matches ^[a-z0-9][a-z0-9-]{0,99}$ ; sha256 is 64 lowercase hex ; zipUrl is http(s)
//   * an index that violates any rule is rejected whole, with a code - never silently emptied
//   * two legacy shapes are still accepted, with a warning: a bare array, and {plugins:[...]}
//   * the ZCode marketplace schema (owner/unlistedPlugins/source{url,sha256}) is rejected

import { LexiPluginCapabilities } from './LexiPluginManifest';

export const MARKET_INDEX_SCHEMA_VERSION: number = 1;

export const INDEX_ERROR_INVALID: string = 'index_invalid';
export const INDEX_ERROR_SCHEMA_VERSION: string = 'unsupported_schema_version';
export const INDEX_ERROR_ZCODE: string = 'legacy_zcode_rejected';

export class LexiPluginMarketEntry {
  id: string = '';
  name: string = '';
  author: string = '';
  description: string = '';
  repo: string = '';
  zipUrl: string = '';
  version: string = '';
  sha256: string = '';
  minApiVersion: string = '0.0.0';
  isDesktopOnly: boolean = false;
  capabilities: LexiPluginCapabilities = new LexiPluginCapabilities();
  capabilitiesDeclared: boolean = false;
  updatedAt: string = '';
}

export class LexiMarketIndexResult {
  ok: boolean = false;
  code: string = '';
  message: string = '';
  schemaVersion: number = 0;
  entries: LexiPluginMarketEntry[] = [];
  warnings: string[] = [];
}

function textOf(source: Record<string, Object>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

function isObject(value: Object | null | undefined): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseCapabilities(value: Object | undefined): LexiPluginCapabilities {
  const capabilities = new LexiPluginCapabilities();
  if (!isObject(value)) { return capabilities; }
  const source = value as Record<string, Object>;
  const network = source['network'];
  if (Array.isArray(network)) {
    for (const host of network as Object[]) {
      if (typeof host === 'string' && (host as string).trim().length > 0) { capabilities.network.push((host as string).trim()); }
    }
  }
  capabilities.fs = source['fs'] === true;
  capabilities.clipboard = source['clipboard'] === true;
  return capabilities;
}

/** Validates one v1 entry; returns '' when valid, else a field-level reason. */
function validateV1Entry(source: Record<string, Object>, index: number): string {
  const at = '第 ' + index + ' 条';
  const id = textOf(source, 'id');
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(id)) { return at + ' id 非法: ' + (id.length > 0 ? id : '(缺失)'); }
  if (textOf(source, 'name').trim().length === 0) { return at + ' 缺少 name'; }
  if (textOf(source, 'version').trim().length === 0) { return at + ' 缺少 version'; }
  if (textOf(source, 'author').trim().length === 0) { return at + ' 缺少 author'; }
  const sha256 = textOf(source, 'sha256');
  if (!/^[0-9a-f]{64}$/.test(sha256)) { return at + ' sha256 必须是 64 位小写十六进制'; }
  const zipUrl = textOf(source, 'zipUrl');
  if (!/^https?:\/\//i.test(zipUrl)) { return at + ' zipUrl 必须是 http(s) 地址'; }
  const minApiVersion = source['minApiVersion'];
  if (minApiVersion !== undefined && typeof minApiVersion !== 'string') { return at + ' minApiVersion 必须是字符串'; }
  const capabilities = source['capabilities'];
  if (capabilities !== undefined && !isObject(capabilities)) { return at + ' capabilities 必须是对象'; }
  if (isObject(capabilities)) {
    const network = (capabilities as Record<string, Object>)['network'];
    if (network !== undefined && !Array.isArray(network)) { return at + ' capabilities.network 必须是数组'; }
  }
  return '';
}

function buildV1Entry(source: Record<string, Object>): LexiPluginMarketEntry {
  const entry = new LexiPluginMarketEntry();
  entry.id = textOf(source, 'id');
  entry.name = textOf(source, 'name').trim();
  entry.author = textOf(source, 'author').trim();
  entry.description = textOf(source, 'description');
  entry.repo = textOf(source, 'repo');
  entry.zipUrl = textOf(source, 'zipUrl');
  entry.version = textOf(source, 'version').trim();
  entry.sha256 = textOf(source, 'sha256');
  entry.minApiVersion = textOf(source, 'minApiVersion') || '0.0.0';
  entry.isDesktopOnly = source['isDesktopOnly'] === true;
  entry.updatedAt = textOf(source, 'updatedAt');
  entry.capabilitiesDeclared = source['capabilities'] !== undefined;
  entry.capabilities = parseCapabilities(source['capabilities']);
  return entry;
}

/** Legacy (pre-schema) entry: only id + name are required, everything else is best effort. */
function buildLegacyEntry(source: Record<string, Object>): LexiPluginMarketEntry {
  const entry = new LexiPluginMarketEntry();
  entry.id = textOf(source, 'id');
  entry.name = textOf(source, 'name');
  entry.author = textOf(source, 'author');
  entry.description = textOf(source, 'description');
  entry.repo = textOf(source, 'repo');
  entry.zipUrl = textOf(source, 'zipUrl');
  entry.version = textOf(source, 'version');
  entry.sha256 = textOf(source, 'sha256');
  return entry;
}

function failure(code: string, message: string): LexiMarketIndexResult {
  const result = new LexiMarketIndexResult();
  result.ok = false;
  result.code = code;
  result.message = message;
  return result;
}

function looksLikeZcode(source: Record<string, Object>): boolean {
  if (source['owner'] !== undefined || source['unlistedPlugins'] !== undefined) { return true; }
  const plugins = source['plugins'];
  if (!Array.isArray(plugins)) { return false; }
  const list = plugins as Object[];
  if (list.length === 0) { return false; }
  const first = list[0];
  if (!isObject(first)) { return false; }
  const record = first as Record<string, Object>;
  return isObject(record['source']) || record['componentTypes'] !== undefined;
}

/** Full parse: always reports why an index was rejected instead of returning an empty list. */
export function parseMarketIndexResult(json: string): LexiMarketIndexResult {
  let parsed: Object | null = null;
  try { parsed = JSON.parse(json) as Object; } catch { return failure(INDEX_ERROR_INVALID, '市场索引不是合法 JSON'); }
  if (Array.isArray(parsed)) {
    const rawList = parsed as Object[];
    const entries: LexiPluginMarketEntry[] = [];
    for (const raw of rawList) {
      if (!isObject(raw)) { continue; }
      const entry = buildLegacyEntry(raw as Record<string, Object>);
      if (!entry.id || !entry.name) { continue; }
      entries.push(entry);
    }
    const result = new LexiMarketIndexResult();
    result.ok = true;
    result.entries = entries;
    result.warnings.push('legacy_array_schema');
    return result;
  }
  if (!isObject(parsed)) { return failure(INDEX_ERROR_INVALID, '市场索引顶层必须是对象或数组'); }
  const root = parsed as Record<string, Object>;
  const schemaVersion = root['schemaVersion'];
  if (schemaVersion === undefined) {
    if (looksLikeZcode(root)) {
      return failure(INDEX_ERROR_ZCODE, '检测到 ZCode 市场 schema（owner/unlistedPlugins/source），已停用；请改用 schemaVersion=1 索引');
    }
    const wrapped = root['plugins'];
    if (!Array.isArray(wrapped)) { return failure(INDEX_ERROR_INVALID, '缺少 schemaVersion 或 plugins 数组'); }
    const entries: LexiPluginMarketEntry[] = [];
    for (const raw of wrapped as Object[]) {
      if (!isObject(raw)) { continue; }
      const entry = buildLegacyEntry(raw as Record<string, Object>);
      if (!entry.id || !entry.name) { continue; }
      entries.push(entry);
    }
    const result = new LexiMarketIndexResult();
    result.ok = true;
    result.entries = entries;
    result.warnings.push('legacy_object_schema');
    return result;
  }
  if (typeof schemaVersion !== 'number' || schemaVersion !== MARKET_INDEX_SCHEMA_VERSION) {
    return failure(INDEX_ERROR_SCHEMA_VERSION, '不支持的市场索引 schemaVersion: ' + String(schemaVersion) + '（只接受 1）');
  }
  const plugins = root['plugins'];
  if (!Array.isArray(plugins)) { return failure(INDEX_ERROR_INVALID, 'schemaVersion=1 的索引必须带 plugins 数组'); }
  const result = new LexiMarketIndexResult();
  result.ok = true;
  result.schemaVersion = MARKET_INDEX_SCHEMA_VERSION;
  const rawPlugins = plugins as Object[];
  for (let index = 0; index < rawPlugins.length; index++) {
    const raw = rawPlugins[index];
    if (!isObject(raw)) { return failure(INDEX_ERROR_INVALID, '第 ' + index + ' 条不是对象'); }
    const problem = validateV1Entry(raw as Record<string, Object>, index);
    if (problem.length > 0) { return failure(INDEX_ERROR_INVALID, problem); }
    result.entries.push(buildV1Entry(raw as Record<string, Object>));
  }
  return result;
}

/**
 * Compatibility wrapper. Keeps the historical "return the entries you could read" signature for
 * display-only callers; anything that must not lose a rejection has to use parseMarketIndexResult.
 */
export function parseMarketIndex(json: string): LexiPluginMarketEntry[] {
  return parseMarketIndexResult(json).entries;
}
