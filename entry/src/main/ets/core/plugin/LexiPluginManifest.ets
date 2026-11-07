// Plugin manifest model, compatible with the Obsidian manifest.json field set.
//
// v1 (legacy) = the eight Obsidian fields below.
// v2 (RFC §8.1) = manifestVersion:2 严格契约:未知 capability 拒绝、未声明=没有能力、
//   sha256 禁止入 manifest;解析走 LexiPluginManifestV2(严格路径),行为沿用本模型的
//   fail-closed 判定(checkFsCapability/checkNetworkCapability)。
// A v1 manifest without capabilities keeps loading; the capability policy below
// states exactly which legacy behaviour survives and which does not.

import { parseManifestV2, LexiManifestV2Normalized, LexiManifestV2Caps } from './LexiPluginManifestV2';

export class LexiPluginCapabilities {
  network: string[] = [];
  fs: boolean = false;
  clipboard: boolean = false;
}

export class LexiPluginManifest {
  id: string = '';
  name: string = '';
  author: string = '';
  version: string = '';
  minAppVersion: string = '';
  description: string = '';
  authorUrl: string = '';
  isDesktopOnly: boolean = false;
  // --- v2 ---
  /** 1=v1(legacy),2=严格 v2(RFC §8.1)。 */
  manifestVersion: number = 1;
  /** §8.2:v1 迁移产物标记,宿主沿用 legacy 语义,旧权限不自动继承为 Native 权限。 */
  legacyProfile: boolean = false;
  minApiVersion: string = '0.0.0';
  capabilities: LexiPluginCapabilities = new LexiPluginCapabilities();
  /** true only when the manifest carried an explicit capabilities object (v2 marker). */
  capabilitiesDeclared: boolean = false;
  sha256: string = '';
  /**
   * P2-001(RFC §4.3 前置):v2 清单的细粒度能力视图透传。
   * 此前 normalized.v2 在本模型边界被丢弃——paths/methods/quota/notifications
   * 在执行面永远不可见(审计 Round 7 确认的 P0-03 机械根因)。v1 清单保持默认全关:
   * 旧权限不自动继承为 Native 细粒度权限(§8.2 legacyProfile 语义)。
   */
  /**
   * P1-003b:沙箱轨声明(entrypoints.service === 'sandbox:')。
   * 声明式 opt-in:该插件的代码在 per-plugin iframe(opaque origin)内以端口身份执行,
   * 不再进入共享 realm `new Function` 路径(ADR-R18-01)。v1/未声明 = 旧轨。
   */
  sandboxService: boolean = false;
  v2: LexiManifestV2Caps = new LexiManifestV2Caps();
}

export class LexiInstalledPlugin {
  manifest: LexiPluginManifest = new LexiPluginManifest();
  dir: string = '';
  enabled: boolean = false;
  errorState: string = '';
  /** 当前 activation(生命周期管理器签发);停用后清空。 */
  activationId: string = '';
  /**
   * P2-009/P1-008(R32):安全隔离原因(非空 = quarantined 面)。enablePlugin 隔离门
   * 据此拒绝启用;随记录重建/卸载清除——宿主侧文档化唯一用户出口 = 卸载后重装。
   */
  quarantineReason: string = '';
}

/**
 * 我们模拟的 Obsidian API 级别。这是 Obsidian 的版本线,不是 LexiNote 自己的版本号。
 * 依据:仓库契约基线 obsidian.d.ts 的 npm 包版本 1.14.4
 * (.fixtures-out/.cache 下各夹具的 node_modules/obsidian/package.json)。
 * 插件的 minAppVersion 声明的是"要求的最低 Obsidian 版本",只能与这条线比较。
 */
export const OBSIDIAN_API_COMPAT: string = '1.14.4';
/** LexiNote plugin API version (mirrors API_VERSION in rawfile/lexinote_plugin_shim.js). */
export const PLUGIN_API_VERSION: string = '1.0.0';

export const ERROR_MANIFEST_INVALID: string = 'manifest_invalid';
export const ERROR_CAPABILITY_DENIED: string = 'capability_denied';
export const ERROR_INTEGRITY_MISMATCH: string = 'integrity_mismatch';
export const ERROR_MIN_API_UNSATISFIED: string = 'min_api_unsatisfied';
export const ERROR_DOWNGRADE_BLOCKED: string = 'downgrade_blocked';

/** Uniform result of one capability question; code is non-empty only when denied. */
export class LexiCapabilityDecision {
  allowed: boolean = true;
  code: string = '';
  kind: string = '';
  detail: string = '';
  host: string = '';
}

function denied(kind: string, detail: string, host: string = ''): LexiCapabilityDecision {
  const decision = new LexiCapabilityDecision();
  decision.allowed = false;
  decision.code = ERROR_CAPABILITY_DENIED;
  decision.kind = kind;
  decision.detail = detail;
  decision.host = host;
  return decision;
}

function allowed(kind: string, detail: string, host: string = ''): LexiCapabilityDecision {
  const decision = new LexiCapabilityDecision();
  decision.allowed = true;
  decision.kind = kind;
  decision.detail = detail;
  decision.host = host;
  return decision;
}

/** Lowercases a declared host entry and strips scheme/path/port noise so lists stay comparable. */
export function normalizeCapabilityHost(entry: string): string {
  let value = entry.trim().toLowerCase();
  if (value.indexOf('://') > 0) { value = value.substring(value.indexOf('://') + 3); }
  const slash = value.indexOf('/');
  if (slash >= 0) { value = value.substring(0, slash); }
  const colon = value.indexOf(':');
  if (colon >= 0) { value = value.substring(0, colon); }
  return value;
}

function parseHostList(value: Object | undefined): string[] {
  const result: string[] = [];
  if (!Array.isArray(value)) { return result; }
  for (const entry of value as Object[]) {
    if (typeof entry !== 'string') { continue; }
    const host = normalizeCapabilityHost(entry as string);
    if (host.length > 0) { result.push(host); }
  }
  return result;
}

function parseCapabilities(value: Object | undefined): LexiPluginCapabilities {
  const capabilities = new LexiPluginCapabilities();
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return capabilities; }
  const source = value as Record<string, Object>;
  capabilities.network = parseHostList(source['network']);
  capabilities.fs = source['fs'] === true;
  capabilities.clipboard = source['clipboard'] === true;
  return capabilities;
}

/** v2 严格解析结果 → 既有清单模型(归一化形状,判定面不变)。 */
function manifestFromV2(v2: LexiManifestV2Normalized): LexiPluginManifest {
  const manifest = new LexiPluginManifest();
  manifest.manifestVersion = 2;
  manifest.legacyProfile = v2.legacyProfile;
  manifest.id = v2.id;
  manifest.name = v2.name;
  manifest.author = v2.author;
  manifest.version = v2.version;
  manifest.description = v2.description;
  manifest.minAppVersion = v2.compatibility.obsidianApiLevel;
  manifest.minApiVersion = v2.compatibility.min;
  manifest.capabilitiesDeclared = true;
  manifest.capabilities.network = v2.capabilities.network.slice();
  manifest.capabilities.fs = v2.capabilities.fs;
  manifest.capabilities.clipboard = v2.capabilities.clipboard;
  // P2-001:细粒度视图穿透到执行面(paths/methods/quota/notifications 不再止步于解析器)。
  manifest.v2 = v2.v2;
  // P1-003b:沙箱轨声明式 opt-in(插件作者在 entrypoints.service 声明 'sandbox:')。
  manifest.sandboxService = v2.entrypoints.service === 'sandbox:';
  return manifest;
}

/** Parses and validates a manifest.json payload; throws with a user-facing message when invalid. */
export function parsePluginManifest(json: string): LexiPluginManifest {
  const raw = JSON.parse(json) as LexiPluginManifest;
  // RFC §8.1:manifestVersion=2 走严格路径——未知 capability/字段、畸形版本、携带 sha256
  // 一律抛错(宿主把插件判为 broken,fail-closed);v1 保持既有宽松语义。
  if (raw !== null && typeof raw === 'object' && (raw as Object as Record<string, Object>)['manifestVersion'] === 2) {
    return manifestFromV2(parseManifestV2(json));
  }
  if (!raw || typeof raw.id !== 'string' || raw.id.length === 0) { throw new Error('插件 manifest 缺少 id'); }
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(raw.id)) { throw new Error('插件 id 只允许小写字母、数字与连字符'); }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) { throw new Error('插件 manifest 缺少 name'); }
  if (typeof raw.version !== 'string' || raw.version.trim().length === 0) { throw new Error('插件 manifest 缺少 version'); }
  if (typeof raw.author !== 'string' || raw.author.trim().length === 0) { throw new Error('插件 manifest 缺少 author'); }
  const manifest = new LexiPluginManifest();
  manifest.id = raw.id;
  manifest.name = raw.name.trim();
  manifest.author = raw.author.trim();
  manifest.version = raw.version.trim();
  manifest.minAppVersion = typeof raw.minAppVersion === 'string' ? raw.minAppVersion : '0.0.0';
  manifest.description = typeof raw.description === 'string' ? raw.description : '';
  manifest.authorUrl = typeof raw.authorUrl === 'string' ? raw.authorUrl : '';
  manifest.isDesktopOnly = raw.isDesktopOnly === true;
  const v2 = raw as Object as Record<string, Object>;
  manifest.minApiVersion = typeof v2['minApiVersion'] === 'string' ? (v2['minApiVersion'] as string) : '0.0.0';
  manifest.sha256 = typeof v2['sha256'] === 'string' ? (v2['sha256'] as string) : '';
  const rawCapabilities = v2['capabilities'];
  manifest.capabilitiesDeclared = !!rawCapabilities && typeof rawCapabilities === 'object' && !Array.isArray(rawCapabilities);
  manifest.capabilities = parseCapabilities(rawCapabilities);
  return manifest;
}

function versionParts(version: string): number[] {
  const parts: number[] = [];
  for (const piece of version.split('.')) {
    const numeric = parseInt(piece, 10);
    parts.push(Number.isNaN(numeric) ? 0 : numeric);
  }
  while (parts.length < 3) { parts.push(0); }
  return parts;
}

/** Compares two dotted versions: -1 / 0 / 1. */
export function comparePluginVersion(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) { return -1; }
    if (a[i] > b[i]) { return 1; }
  }
  return 0;
}

/**
 * minAppVersion 的可解析性:null 表示这条声明不能当成版本号理解。
 * 容忍前导 v、1/2/3 段(不足补 0)、多出的第 4 段(按前 3 段比较);
 * 含非数字段的声明一律判畸形——把 '1.x' 读成 1.0.0 等于凭空把未知要求降级成
 * "任何宿主都满足",那正是这条闸门要防的事。
 */
function parseCompatRequirement(value: string): string | null {
  let text = value.trim();
  if (text.length > 0 && (text.charAt(0) === 'v' || text.charAt(0) === 'V')) { text = text.substring(1); }
  const pieces = text.split('.');
  if (pieces.length > 4) { return null; }
  const numbers: number[] = [];
  for (const piece of pieces) {
    if (!/^[0-9]+$/.test(piece)) { return null; }
    numbers.push(parseInt(piece, 10));
  }
  while (numbers.length < 3) { numbers.push(0); }
  return numbers[0] + '.' + numbers[1] + '.' + numbers[2];
}

/** One compatibility verdict: the flag plus what the manifest actually demanded. */
export class LexiManifestCompat {
  compatible: boolean = true;
  /** 声明原文(trim 后);畸形声明原样保留,好让提示能点名它。 */
  requirement: string = '';
  malformed: boolean = false;
}

/** Compares the declared minAppVersion with the Obsidian API level we emulate. */
export function evaluateManifestCompat(manifest: LexiPluginManifest): LexiManifestCompat {
  const verdict = new LexiManifestCompat();
  const declared = typeof manifest.minAppVersion === 'string' ? manifest.minAppVersion.trim() : '';
  // 空声明 = 没提要求(Obsidian 侧同样按 falsy 跳过这条检查)。
  verdict.requirement = declared.length > 0 ? declared : '0.0.0';
  if (declared.length === 0) { return verdict; }
  const normalized = parseCompatRequirement(declared);
  if (normalized === null) {
    verdict.compatible = false;
    verdict.malformed = true;
    return verdict;
  }
  verdict.compatible = comparePluginVersion(normalized, OBSIDIAN_API_COMPAT) <= 0;
  return verdict;
}

/** 不兼容时的用户提示(两侧版本都给出:宿主侧 compat + 插件侧声明);兼容时返回空串。 */
export function manifestCompatMessage(manifest: LexiPluginManifest): string {
  const verdict = evaluateManifestCompat(manifest);
  if (verdict.compatible) { return ''; }
  const demanded = verdict.malformed ? `${verdict.requirement}（版本声明无法解析）` : verdict.requirement;
  return `本应用模拟 Obsidian API ${OBSIDIAN_API_COMPAT}，该插件要求 ${demanded}`;
}

/** Obsidian-compatible compatibility check against the emulated Obsidian API level. */
export function manifestCompatible(manifest: LexiPluginManifest): boolean {
  return evaluateManifestCompat(manifest).compatible;
}

/** v2 check: minApiVersion must not exceed the plugin API version the host exposes. */
export function manifestApiCompatible(manifest: LexiPluginManifest): boolean {
  return comparePluginVersion(manifest.minApiVersion, PLUGIN_API_VERSION) <= 0;
}

/** Extracts the host from an http(s) URL; returns '' for anything else. */
export function capabilityHostOfUrl(url: string): string {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) { return ''; }
  const afterScheme = trimmed.substring(trimmed.indexOf('//') + 2);
  const end = afterScheme.search(/[/?#]/);
  const authority = end < 0 ? afterScheme : afterScheme.substring(0, end);
  const at = authority.lastIndexOf('@');
  const hostPort = at >= 0 ? authority.substring(at + 1) : authority;
  const colon = hostPort.indexOf(':');
  return (colon >= 0 ? hostPort.substring(0, colon) : hostPort).toLowerCase();
}

/** Exact host match, or a declared wildcard entry "*.example.com". */
export function capabilityHostAllowed(host: string, declared: string[]): boolean {
  if (host.length === 0) { return false; }
  for (const entry of declared) {
    if (entry === host) { return true; }
    if (entry.startsWith('*.') && (host === entry.substring(2) || host.endsWith(entry.substring(1)))) { return true; }
  }
  return false;
}

/**
 * Network egress policy: fail closed, always.
 * No bundled fixture calls net.requestUrl (tools/plugins-fixtures), so requiring an
 * explicit host declaration costs nothing today and is the only trustworthy default.
 */
export function checkNetworkCapability(manifest: LexiPluginManifest | null, url: string): LexiCapabilityDecision {
  const host = capabilityHostOfUrl(url);
  if (host.length === 0) { return denied('network', '仅允许 http/https 请求', host); }
  if (manifest === null) { return denied('network', '调用方无法归属到已安装插件', host); }
  if (!manifest.capabilitiesDeclared) {
    return denied('network', '插件清单未声明 capabilities（v1 清单默认无出站权限）', host);
  }
  if (capabilityHostAllowed(host, manifest.capabilities.network)) {
    return allowed('network', 'host 在 capabilities.network 声明内', host);
  }
  return denied('network', 'host 不在 capabilities.network 声明列表: ' + host, host);
}

/**
 * Filesystem policy. A v2 manifest must declare fs:true to write through the vault.
 * A v1 manifest keeps the historical vault semantics: all four bundled fixtures write
 * through vault.create and none of them can be edited this round (rawfile is frozen),
 * so default-denying here would break them on the next device run.
 */
export function checkFsCapability(manifest: LexiPluginManifest | null): LexiCapabilityDecision {
  if (manifest === null) { return allowed('fs', '未归属调用：沿用 v1 语义（legacy-unattributed）'); }
  if (!manifest.capabilitiesDeclared) { return allowed('fs', 'v1 清单未声明 capabilities：沿用既有 vault 写语义（legacy-v1）'); }
  if (manifest.capabilities.fs) { return allowed('fs', 'capabilities.fs=true'); }
  return denied('fs', '插件未声明 capabilities.fs');
}

/** Clipboard policy mirrors fs: v1 keeps working, v2 must declare clipboard:true. */
export function checkClipboardCapability(manifest: LexiPluginManifest | null): LexiCapabilityDecision {
  if (manifest === null) { return denied('clipboard', '调用方无法归属到已安装插件'); }
  if (!manifest.capabilitiesDeclared) { return denied('clipboard', '插件清单未声明 capabilities（v1 清单无剪贴板权限）'); }
  if (manifest.capabilities.clipboard) { return allowed('clipboard', 'capabilities.clipboard=true'); }
  return denied('clipboard', '插件未声明 capabilities.clipboard');
}

/**
 * P2-004(RFC §4.4)·vault 路径级授权匹配(宿主端执行,插件 SDK 侧的检查只是提示)。
 * 语义:enabled=false → 一律拒绝;patterns 为空 → 全库(与旧 fs 布尔语义一致);
 * 任一规则命中即放行。规则形态(示例中"星"代指星号字符,注释内不写字面星号斜杠序列):
 *   'notes/draft/'    目录前缀;
 *   'notes'(星).md    单段通配——星号不跨 '/';
 *   'notes'(双星).md  跨段通配——双星匹配任意深度含零段;
 *   'notes/a.md'      精确。
 * 入参 path 由调用方按 normalizePath 语义给定(相对、'/' 分隔);本函数容忍前导 '/'。
 * P2-003 落点:写路径在 fsGate、读路径在 vaultReadGate,broker gate 只判域声明——两层纵深。
 */
export function vaultPathAllowed(path: string, enabled: boolean, patterns: string[]): boolean {
  if (!enabled) { return false; }
  if (patterns.length === 0) { return true; }
  const target = path.replace(/^\//, '');
  for (const raw of patterns) {
    const rule = raw.replace(/^\//, '');
    if (rule.length === 0) { continue; }
    if (rule.indexOf('*') < 0) {
      if (target === rule) { return true; }
      if (rule.charAt(rule.length - 1) === '/' && target.indexOf(rule) === 0) { return true; }
      continue;
    }
    if (vaultPathMatchesGlob(target, rule)) { return true; }
  }
  return false;
}

/** glob → RegExp:'**' 跨段(可带尾 '/' 一起吃),'*'/'?' 单段,其余字符按字面量转义。 */
function vaultPathMatchesGlob(target: string, rule: string): boolean {
  let source = '^';
  for (let i = 0; i < rule.length; i++) {
    const ch = rule.charAt(i);
    if (ch === '*') {
      if (rule.charAt(i + 1) === '*') {
        if (rule.charAt(i + 2) === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const pattern = new RegExp(source + '$');
  return pattern.test(target);
}
