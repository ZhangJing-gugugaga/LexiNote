// RFC §9.2/§9.3 / §14 T4.2 · Registry v2 元数据信任链(LexiRegistryTrust)。
//
// 简化 TUF 四角色链(§9.3:使用经过审查的实现或严格遵循协议;此处固化最小验证语义,
// 密码学签名由设备侧 cryptoFramework / 服务侧工具承接,本模块只做链上判定):
//   root      信任锚:声明全部角色 key + 有效期(自签);
//   snapshot  由 snapshot key 签,携带 targets 的 hash(一致性);
//   targets   由 targets key 签,携带插件版本 → sha256(下载前校验入口),带单调 version(防回滚);
//   timestamp 由 timestamp key 签,携带 snapshot 的 hash + 有效期(新鲜度)。
// 撤销:revokedKeys 串(逗号分隔)命中角色即整链拒绝(§9.2 发布者撤销/密钥轮换)。
// 纯逻辑、零 @kit 依赖,可在 Node 转译真跑(plugin-registry-trust.cjs)。

export class LexiTrustDecision {
  ok: boolean = false;
  code: string = '';
  reason: string = '';
}

interface LexiSignedMetadata {
  payload: string;
  signature: string;
}

export class LexiRegistryTrust {
  private static parseSigned(meta: LexiSignedMetadata): Record<string, Object> | null {
    if (meta === null || meta === undefined || !meta.payload || !meta.signature) { return null; }
    try {
      const parsed = JSON.parse(meta.payload) as Record<string, Object>;
      if (parsed === null || typeof parsed !== 'object') { return null; }
      return parsed;
    } catch (error) {
      return null;
    }
  }

  private static expired(expires: string, now: string): boolean {
    if (!expires || expires.length === 0) { return true; }
    return expires < now;
  }

  private static deny(code: string, reason: string): LexiTrustDecision {
    const decision = new LexiTrustDecision();
    decision.ok = false;
    decision.code = code;
    decision.reason = reason;
    return decision;
  }

  private static allow(): LexiTrustDecision {
    const decision = new LexiTrustDecision();
    decision.ok = true;
    return decision;
  }

  private static checkRevocation(role: string, revokedKeys: string): string | null {
    if (!revokedKeys || revokedKeys.length === 0) { return null; }
    if (revokedKeys.indexOf(role + '-key') >= 0) { return role; }
    return null;
  }

  /**
   * 完整信任链验证。sigVerify(signature, payload, key) → boolean 由宿主注入
   * (设备侧 cryptoFramework verify / 测试替身)。lastSeenTargetsVersion 用于回滚检测(可选)。
   */
  static verifyChain(root: LexiSignedMetadata, snapshot: LexiSignedMetadata, targets: LexiSignedMetadata,
    timestamp: LexiSignedMetadata, now: string,
    sigVerify: (signature: string, payload: string, key: string) => boolean,
    revokedKeys: string = '', lastSeenTargetsVersion: number = -1): LexiTrustDecision {
    const rootParsed = LexiRegistryTrust.parseSigned(root);
    if (rootParsed === null) { return LexiRegistryTrust.deny('ERR_SIGNATURE_INVALID', 'root 元数据不可解析'); }
    const keysRecord = rootParsed['keys'] as Record<string, Object>;
    if (keysRecord === null || keysRecord === undefined) {
      return LexiRegistryTrust.deny('ERR_SIGNATURE_INVALID', 'root 未声明角色 key');
    }
    // root 自签(信任锚只有自洽 + 本地 pin 的 root key 才可信;测试里 sigVerify 绑定期望 key)
    const rootKey = keysRecord['root'] as string;
    if (!root || !sigVerify(root.signature, root.payload, rootKey)) {
      return LexiRegistryTrust.deny('ERR_SIGNATURE_INVALID', 'root 自签不通过');
    }
    if (LexiRegistryTrust.expired(rootParsed['expires'] as string, now)) {
      return LexiRegistryTrust.deny('ERR_SIGNATURE_INVALID', 'root 元数据过期');
    }
    // 撤销检查(§9.2):任一角色 key 被撤销即整链拒绝
    for (const role of ['root', 'snapshot', 'targets', 'timestamp']) {
      if (LexiRegistryTrust.checkRevocation(role, revokedKeys) !== null) {
        return LexiRegistryTrust.deny('ERR_SIGNATURE_INVALID', '角色 key 已撤销: ' + role);
      }
    }
    // timestamp(新鲜度入口)
    const timestampParsed = LexiRegistryTrust.parseSigned(timestamp);
    if (timestampParsed === null) { return LexiRegistryTrust.deny('ERR_SIGNATURE_INVALID', 'timestamp 不可解析'); }
    if (!sigVerify(timestamp.signature, timestamp.payload, keysRecord['timestamp'] as string)) {
      return LexiRegistryTrust.deny('ERR_SIGNATURE_INVALID', 'timestamp 签名不通过');
    }
    if (LexiRegistryTrust.expired(timestampParsed['expires'] as string, now)) {
      return LexiRegistryTrust.deny('ERR_SIGNATURE_INVALID', 'timestamp 过期(新鲜度不足)');
    }
    // snapshot(一致性)
    const snapshotParsed = LexiRegistryTrust.parseSigned(snapshot);
    if (snapshotParsed === null) { return LexiRegistryTrust.deny('ERR_SIGNATURE_INVALID', 'snapshot 不可解析'); }
    if (!sigVerify(snapshot.signature, snapshot.payload, keysRecord['snapshot'] as string)) {
      return LexiRegistryTrust.deny('ERR_SIGNATURE_INVALID', 'snapshot 签名不通过');
    }
    const declaredSnapshotHash = 'hash:' + snapshot.payload;
    if (timestampParsed['snapshotHash'] !== declaredSnapshotHash) {
      return LexiRegistryTrust.deny('ERR_HASH_MISMATCH', 'timestamp 携带的 snapshot hash 不匹配');
    }
    // targets(版本一致性 + 防回滚)
    const targetsParsed = LexiRegistryTrust.parseSigned(targets);
    if (targetsParsed === null) { return LexiRegistryTrust.deny('ERR_SIGNATURE_INVALID', 'targets 不可解析'); }
    if (!sigVerify(targets.signature, targets.payload, keysRecord['targets'] as string)) {
      return LexiRegistryTrust.deny('ERR_SIGNATURE_INVALID', 'targets 签名不通过');
    }
    if (timestampParsed['snapshotHash'] !== 'hash:' + snapshot.payload ||
      snapshotParsed['targetsHash'] !== 'hash:' + targets.payload) {
      return LexiRegistryTrust.deny('ERR_HASH_MISMATCH', 'snapshot 携带的 targets hash 不匹配(§9.2 一致性)');
    }
    const version = targetsParsed['version'];
    if (typeof version === 'number' && lastSeenTargetsVersion >= 0 && (version as number) < lastSeenTargetsVersion) {
      return LexiRegistryTrust.deny('ERR_SIGNATURE_INVALID',
        'targets 版本回滚: ' + version + ' < lastSeen ' + lastSeenTargetsVersion + '(§9.2 回滚攻击)');
    }
    return LexiRegistryTrust.allow();
  }

  /** 下载前校验:targets 里声明的版本 hash 与获取渠道声明的 sha256 逐字节比对。 */
  static verifyPackageTarget(targets: LexiSignedMetadata, pluginId: string,
    version: string, expectedSha256: string): LexiTrustDecision {
    const targetsParsed = LexiRegistryTrust.parseSigned(targets);
    if (targetsParsed === null) {
      return LexiRegistryTrust.deny('ERR_SIGNATURE_INVALID', 'targets 不可解析');
    }
    const plugins = targetsParsed['plugins'] as Record<string, Object>;
    const versions = plugins !== undefined && plugins !== null
      ? plugins[pluginId] as Record<string, Object> : undefined;
    const entry = versions !== undefined && versions !== null ? versions[version] as Record<string, Object> : undefined;
    if (entry === undefined || entry === null) {
      return LexiRegistryTrust.deny('ERR_PLUGIN_NOT_FOUND', 'targets 未声明该版本: ' + pluginId + '@' + version);
    }
    const declared = entry['sha256'] as string;
    if (declared !== expectedSha256) {
      return LexiRegistryTrust.deny('ERR_HASH_MISMATCH',
        '版本 sha256 与 targets 声明不符(声明 ' + declared + ',渠道 ' + expectedSha256 + ')');
    }
    return LexiRegistryTrust.allow();
  }
}
