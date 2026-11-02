// RFC §3.6/§10.1 · 能力标签助手(SDK 侧)。
// 与宿主 T2.2 指纹语义一致:vault.write / network:<host> / clipboard。
// 插件作者用它推导 manifest v2 capabilities 会产生的授权标签,便于预览授权范围。
// 运行时实现由宿主提供;本模块只做纯推导。

/** 归一化 host:小写、去 scheme/port/path(与宿主 normalizeCapabilityHost 同语义)。 */
export function normalizeCapabilityHost(entry: string): string {
  let value = entry.trim().toLowerCase();
  if (value.indexOf('://') > 0) { value = value.substring(value.indexOf('://') + 3); }
  const slash = value.indexOf('/');
  if (slash >= 0) { value = value.substring(0, slash); }
  const colon = value.indexOf(':');
  if (colon >= 0) { value = value.substring(0, colon); }
  return value;
}

export interface CapabilityDeclaration {
  vault?: { read?: { enabled?: boolean; paths?: string[] }; write?: { enabled?: boolean; paths?: string[] } | boolean; delete?: boolean };
  editor?: { readActive?: boolean; writeSelection?: boolean; writeDocument?: boolean; extensions?: 'none' | 'declarative' | 'trusted-cm6' };
  workspace?: { commands?: boolean; views?: boolean };
  network?: string[] | { origins?: string[]; methods?: string[]; maxRequestBytes?: number; maxResponseBytes?: number };
  clipboard?: boolean | { read?: boolean; write?: boolean };
  storage?: { quotaBytes?: number };
  notifications?: boolean;
}

/** manifest v2 capabilities 声明 → 宿主授权标签集(排序;即授权弹窗将展示的能力集)。 */
export function capabilityTags(capabilities: CapabilityDeclaration): string[] {
  const tags: string[] = [];
  if (capabilities.vault && capabilities.vault.write) {
    const write = capabilities.vault.write;
    const enabled = write === true || write.enabled === true;
    if (enabled) { tags.push('vault.write'); }
  }
  if (capabilities.network) {
    const origins = Array.isArray(capabilities.network)
      ? capabilities.network
      : (capabilities.network.origins || []);
    for (const origin of origins) {
      const host = normalizeCapabilityHost(origin);
      if (host.length > 0) { tags.push('network:' + host); }
    }
  }
  if (capabilities.clipboard) {
    tags.push('clipboard');
  }
  return tags.sort();
}
