// RFC §9.4/§12.3 / §14 T4.4 · 更新策略(LexiUpdatePolicy)。
//
// 安装/升级前的纯判定(在 PackageVerifier 结构校验之前执行,输入来自版本指针与索引):
//   - 同版本 + 字节证据(已装包哈希记录 vs 本次声明哈希)不同 → 拒绝
//     (§9.4 每版本不可变,禁止静默替换);
//   - 同版本 + 字节证据相同 → 幂等放行(重装同一包);
//   - 同版本 + 证据缺失(本地侧载未声明哈希 / 已装版本无记录)→ 拒绝,但理由必须
//     如实说"无法证明一致"(P5-010,Round 7 不对称修正:不得把"没有证据"谎报成
//     "检测到不同字节";拒绝语义在安装/更新两条通路对称);
//   - 降级 → ERR_DOWNGRADE_BLOCKED(与安装器既有语义同码);
//   - 升级 + 权限集合变化(新增任一能力标签)→ ERR_PERMISSION_REGRANT_REQUIRED(§9.5/T2.2);
//   - 首次安装(无版本指针)→ 放行,用户授权由 P5-004 安装后授权面板承接
//     (同意 → grant 落账 → 启用;ADR-R25-01 登记的「首装不询问」衔接点已复审收口);
//   - revoked 命中(pluginId@version 或 pluginId@*)→ ERR_SIGNATURE_INVALID(§9.2 下架/撤销)。
// 纯逻辑、零 @kit 依赖,可在 Node 转译真跑(plugin-update-policy.cjs)。

export const UPDATE_DECISION_ALLOW: string = 'allow';

export class LexiUpdateInput {
  pluginId: string = '';
  installedVersion: string = '';
  /** P5-010:已装版本的包哈希记录(.versions/<v>/.package.sha256,安装时验证过的 zip 摘要)。空=无记录。 */
  installedSha256: string = '';
  incomingVersion: string = '';
  /** 本次安装声明的包哈希(索引条目,经 verifyPackageHash 与下载字节核对)。空=本地侧载未声明。 */
  incomingSha256: string = '';
  oldCaps: string[] = [];
  newCaps: string[] = [];
  /** 撤销/下架条目:形如 'plug-a@1.1.0' 或 'plug-a@*'(全版本下架)。 */
  revoked: string[] = [];
  /** 能力差异(宿主按 T2.2 diffCapabilities 语义传入)。 */
  permissionDiff: LexiCapabilityDiffLite | null = null;
}

export class LexiCapabilityDiffLite {
  changed: boolean = false;
  added: string[] = [];
  removed: string[] = [];
}

export class LexiUpdateDecision {
  ok: boolean = false;
  code: string = UPDATE_DECISION_ALLOW;
  reason: string = '';
}

export class LexiUpdatePolicy {
  private static deny(code: string, reason: string): LexiUpdateDecision {
    const decision = new LexiUpdateDecision();
    decision.ok = false;
    decision.code = code;
    decision.reason = reason;
    return decision;
  }

  private static allow(): LexiUpdateDecision {
    const decision = new LexiUpdateDecision();
    decision.ok = true;
    return decision;
  }

  private static compareVersion(left: string, right: string): number {
    const parse = (v: string): number[] => {
      const parts: number[] = [];
      for (const piece of v.split('.')) {
        const n = parseInt(piece, 10);
        parts.push(Number.isNaN(n) ? 0 : n);
      }
      while (parts.length < 3) { parts.push(0); }
      return parts;
    };
    const a = parse(left);
    const b = parse(right);
    for (let i = 0; i < 3; i++) {
      if (a[i] < b[i]) { return -1; }
      if (a[i] > b[i]) { return 1; }
    }
    return 0;
  }

  private static revokedHit(pluginId: string, version: string, revoked: string[]): string | null {
    for (const entry of revoked) {
      if (entry === pluginId + '@' + version || entry === pluginId + '@*') { return entry; }
    }
    return null;
  }

  static decide(input: LexiUpdateInput): LexiUpdateDecision {
    if (input.pluginId !== undefined && input.pluginId !== null && input.pluginId.length > 0) {
      const hit = LexiUpdatePolicy.revokedHit(input.pluginId, input.incomingVersion, input.revoked);
      if (hit !== null) {
        return LexiUpdatePolicy.deny('ERR_SIGNATURE_INVALID', '该版本已被撤销/下架: ' + hit + '(§9.2)');
      }
    }
    const hasInstalled = input.installedVersion !== undefined && input.installedVersion.length > 0;
    if (!hasInstalled) {
      // 首次安装:能力授权走 T2.2 启用即授权,不在安装口拦截
      return LexiUpdatePolicy.allow();
    }
    const cmp = LexiUpdatePolicy.compareVersion(input.incomingVersion, input.installedVersion);
    if (cmp < 0) {
      return LexiUpdatePolicy.deny('ERR_DOWNGRADE_BLOCKED',
        '禁止降级安装: ' + input.incomingVersion + ' < 已装 ' + input.installedVersion);
    }
    if (cmp === 0) {
      // P5-010(Round 7 不对称修正):同版本拒绝必须对"字节证据"对称且诚实(§9.4 每版本不可变)。
      // 双方证据齐全(已装包哈希记录 + 本次声明哈希,同属 zip 字节域)才允许宣称"字节不同";
      // 任一侧缺失只能如实说"无法证明一致"——此前把侧载(空哈希)与主文件哈希域混比,
      // 安装/更新两条通路一个永远误拒、一个拿错误的话术拒绝,拒绝语义不对称。
      // 哈希入参按 string 防御式收敛(离线夹具/旧调用方可能传 undefined,视同未声明)。
      const recordedSha256 = typeof input.installedSha256 === 'string' ? input.installedSha256 : '';
      const declaredSha256 = typeof input.incomingSha256 === 'string' ? input.incomingSha256 : '';
      const hasRecord = recordedSha256.length > 0;
      const hasDeclared = declaredSha256.length > 0;
      if (hasRecord && hasDeclared) {
        if (recordedSha256 === declaredSha256) {
          // 幂等重装:与已装版本字节相同的包,放行重投影(§9.4 同一版本唯一字节)。
          return LexiUpdatePolicy.allow();
        }
        return LexiUpdatePolicy.deny('ERR_PACKAGE_INVALID',
          '同版本 ' + input.installedVersion + ' 不允许替换不同字节(§9.4 版本不可变:声明哈希与已装包哈希记录不一致)');
      }
      if (!hasDeclared) {
        return LexiUpdatePolicy.deny('ERR_PACKAGE_INVALID',
          '同版本 ' + input.installedVersion + ' 禁止覆盖安装:本地侧载未声明包哈希,无法证明与已装版本字节一致(§9.4 版本不可变;如需重装请先卸载或提升版本号)');
      }
      return LexiUpdatePolicy.deny('ERR_PACKAGE_INVALID',
        '同版本 ' + input.installedVersion + ' 禁止覆盖安装:已装版本缺少包哈希记录,无法与声明哈希比对(§9.4 版本不可变;如需重装请先卸载或提升版本号)');
    }
    // 升级:能力新增必须重新授权(§9.5)
    const diff = input.permissionDiff;
    if (diff !== null && diff.changed && diff.added.length > 0) {
      return LexiUpdatePolicy.deny('ERR_PERMISSION_REGRANT_REQUIRED',
        '升级引入新权限,需要重新授权(新增: ' + diff.added.join(', ') + ')');
    }
    return LexiUpdatePolicy.allow();
  }
}
