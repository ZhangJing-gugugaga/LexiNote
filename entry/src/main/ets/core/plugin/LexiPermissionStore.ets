// RFC §14 T2.2 · 权限存储(LexiPermissionStore)。
//
// 授权模型(RFC §9.5/§16.2):
//   - 首次启用 = 用户显式启用即授权(记录版本 + 能力指纹);
//   - 同指纹升版本 = 自动延续授权(能力未变不折腾用户);
//   - 指纹变化(新增/收缩权限)= regrant-required,宿主拒绝启用并把差异展示给用户;
//   - 撤销 = revoked,启用被拒直到再次授权;
//   - 持久化:serialize/load 往返,损坏载荷按空存储载入(fail-closed)。
// 纯逻辑、零 @kit 依赖,可在 Node 转译真跑(plugin-permission-store.cjs)。

export const PERMISSION_GRANTED: string = 'granted';
export const PERMISSION_REGRANT_REQUIRED: string = 'regrant-required';
export const PERMISSION_NOT_GRANTED: string = 'not-granted';
export const PERMISSION_REVOKED: string = 'revoked';

const SCHEMA_VERSION: number = 1;

export class LexiPermissionGrant {
  pluginId: string = '';
  version: string = '';
  /** 能力集指纹(与键序无关;变更即触发重授权)。 */
  fingerprint: string = '';
  grantedAt: number = 0;
  revokedAt: number = 0;
  state: string = 'granted';
}

export class LexiCapabilityDiff {
  changed: boolean = false;
  added: string[] = [];
  removed: string[] = [];
}

export class LexiPermissionStore {
  private grants: Map<string, LexiPermissionGrant> = new Map();

  private static nowMs(): number {
    return new Date().getTime();
  }

  private keyOf(pluginId: string): string {
    return pluginId;
  }

  /**
   * 能力集指纹:排序后拼接(与键序无关)。输入约定为 "域:细节" 标签列表
   * (宿主从 manifest v2 细粒度能力视图推导,如 'vault.write','network:api.example.com')。
   */
  fingerprintOf(capabilityTags: string[]): string {
    const sorted = capabilityTags.slice().sort();
    let hash = 'fp:';
    for (const tag of sorted) {
      hash += tag + '|';
    }
    return hash;
  }

  /** 能力集差异(宿主用于权限变化展示与授权提示)。 */
  diffCapabilities(oldTags: string[], newTags: string[]): LexiCapabilityDiff {
    const oldSet = new Map<string, boolean>();
    for (const tag of oldTags) { oldSet.set(tag, true); }
    const newSet = new Map<string, boolean>();
    for (const tag of newTags) { newSet.set(tag, true); }
    const diff = new LexiCapabilityDiff();
    for (const tag of newTags) {
      if (!oldSet.has(tag)) { diff.added.push(tag); }
    }
    for (const tag of oldTags) {
      if (!newSet.has(tag)) { diff.removed.push(tag); }
    }
    diff.added.sort();
    diff.removed.sort();
    diff.changed = diff.added.length > 0 || diff.removed.length > 0;
    return diff;
  }

  /** 用户授权(启用确认/重新授权弹窗/设置页按钮)。 */
  grant(pluginId: string, version: string, fingerprint: string): boolean {
    if (!pluginId || pluginId.length === 0) { return false; }
    const key = this.keyOf(pluginId);
    const existing = this.grants.get(key);
    if (existing !== undefined && existing.fingerprint === fingerprint) {
      existing.version = version;
      existing.state = 'granted';
      existing.revokedAt = 0;
      existing.grantedAt = LexiPermissionStore.nowMs();
      return true;
    }
    const grant = new LexiPermissionGrant();
    grant.pluginId = pluginId;
    grant.version = version;
    grant.fingerprint = fingerprint;
    grant.grantedAt = LexiPermissionStore.nowMs();
    grant.state = 'granted';
    this.grants.set(key, grant);
    return true;
  }

  /** 用户撤销(RFC §16.2 用户侧可撤销):撤销后启用被拒,直到再次授权。 */
  revoke(pluginId: string): boolean {
    const grant = this.grants.get(this.keyOf(pluginId));
    if (grant === undefined) { return false; }
    grant.state = 'revoked';
    grant.revokedAt = LexiPermissionStore.nowMs();
    return true;
  }

  /**
   * 启用前的授权决定:
   *   granted          —— 已授权且指纹一致(含同指纹升版本,自动延续并更新版本号);
   *   regrant-required —— 已授权但指纹变化(升级引入权限差异,必须再次授权);
   *   revoked          —— 用户已撤销;
   *   not-granted      —— 从未授权。
   */
  decisionFor(pluginId: string, version: string, fingerprint: string): string {
    const grant = this.grants.get(this.keyOf(pluginId));
    if (grant === undefined) { return PERMISSION_NOT_GRANTED; }
    if (grant.state === 'revoked') { return PERMISSION_REVOKED; }
    if (grant.fingerprint === fingerprint) {
      grant.version = version;
      return PERMISSION_GRANTED;
    }
    return PERMISSION_REGRANT_REQUIRED;
  }

  /** 当前授权记录(宿主 UI 展示授权时间/版本/指纹)。 */
  grantOf(pluginId: string): LexiPermissionGrant | null {
    const grant = this.grants.get(this.keyOf(pluginId));
    return grant === undefined ? null : grant;
  }

  /** 持久化载荷(schemaVersion 标记 + grants 数组)。 */
  serialize(): string {
    const list: Object[] = [];
    this.grants.forEach((grant: LexiPermissionGrant): void => {
      const entry: Record<string, Object> = {
        'pluginId': grant.pluginId as Object,
        'version': grant.version as Object,
        'fingerprint': grant.fingerprint as Object,
        'grantedAt': grant.grantedAt as Object,
        'revokedAt': grant.revokedAt as Object,
        'state': grant.state as Object
      };
      list.push(entry);
    });
    const body: Record<string, Object> = {
      'schemaVersion': SCHEMA_VERSION as Object,
      'grants': list as Object
    };
    return JSON.stringify(body);
  }

  /** 载入持久化载荷;损坏/异形载荷返回 false(宿主按空存储继续,fail-closed)。 */
  load(json: string): boolean {
    let parsed: Record<string, Object>;
    try {
      parsed = JSON.parse(json) as Record<string, Object>;
    } catch (error) {
      return false;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { return false; }
    if (parsed['schemaVersion'] !== SCHEMA_VERSION) { return false; }
    const list = parsed['grants'];
    if (!Array.isArray(list)) { return false; }
    const loaded: Map<string, LexiPermissionGrant> = new Map();
    for (const entry of list as Object[]) {
      if (entry === null || typeof entry !== 'object') { return false; }
      const record = entry as Record<string, Object>;
      const pluginId = record['pluginId'];
      const version = record['version'];
      const fingerprint = record['fingerprint'];
      const state = record['state'];
      if (typeof pluginId !== 'string' || pluginId.length === 0) { return false; }
      if (typeof version !== 'string' || typeof fingerprint !== 'string') { return false; }
      if (state !== 'granted' && state !== 'revoked') { return false; }
      const grant = new LexiPermissionGrant();
      grant.pluginId = pluginId;
      grant.version = version;
      grant.fingerprint = fingerprint;
      grant.grantedAt = typeof record['grantedAt'] === 'number' ? record['grantedAt'] as number : 0;
      grant.revokedAt = typeof record['revokedAt'] === 'number' ? record['revokedAt'] as number : 0;
      grant.state = state as string;
      loaded.set(pluginId, grant);
    }
    this.grants = loaded;
    return true;
  }
}
