// RFC §8.4 / §14 T4.1 · 安装包校验器(LexiPackageVerifier)。
//
// 安装链的结构与完整性门(§8.4 拒绝清单 + 初始预算):
//   - 路径穿越('../' / 尾段 '..' / 绝对路径 / 盘符 / 反斜杠 / NUL)与符号链接条目一律拒绝;
//   - 重复路径拒绝(§8.4);扩展名白名单制(非预期二进制拒绝,可执行类显式黑名单);
//   - 预算(§8.4 暂定):ZIP 20MB / 展开 100MB / 2000 文件 / 单文件 10MB;压缩炸弹 =
//     "体量 > 1MB 且压缩比 > 100"双条件(高压缩小资源不误报);
//   - 完整性 ERR_HASH_MISMATCH / 发布者签名 ERR_SIGNATURE_INVALID(RFC §12.3 语义)。
// 纯逻辑、零 @kit 依赖,可在 Node 转译真跑(plugin-package-verifier.cjs)。
// 签名体系在 T4.2 升级为 TUF 风格元数据链;本模块提供注入式校验缝。

export class LexiArchiveEntry {
  /** 归档内路径(zip 规范 '/' 分隔;允许反斜杠输入,校验前归一化)。 */
  name: string = '';
  /** 解压后字节。 */
  size: number = 0;
  compressedSize: number = 0;
  isSymlink: boolean = false;
  isDirectory: boolean = false;
}

export class LexiPackageDecision {
  ok: boolean = false;
  /** RFC §12.3 错误码:ERR_PACKAGE_INVALID / ERR_HASH_MISMATCH / ERR_SIGNATURE_INVALID / ERR_RESOURCE_LIMIT。 */
  code: string = '';
  reason: string = '';
  violations: string[] = [];
}

export class LexiPackageBudget {
  maxZipBytes: number = 20 * 1024 * 1024;
  maxExpandedBytes: number = 100 * 1024 * 1024;
  maxFileCount: number = 2000;
  maxSingleFileBytes: number = 10 * 1024 * 1024;
  /** 压缩炸弹双条件:体量超过该阈值且压缩比超限才判炸(高压缩小资源不误报)。 */
  bombSuspicionBytes: number = 1024 * 1024;
  maxCompressionRatio: number = 100;
  /** 白名单制(§8.4 非预期二进制拒绝);无扩展名的目录/特殊文件按拒绝处理。 */
  allowedExtensions: string[] = ['.js', '.mjs', '.json', '.css', '.md', '.svg', '.png',
    '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.html', '.woff', '.woff2', '.ttf', '.otf', '.map'];
  blockedExtensions: string[] = ['.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.sh',
    '.ps1', '.node', '.bin'];
}

export class LexiPackageVerifier {
  private budget: LexiPackageBudget;

  constructor(budget: LexiPackageBudget | null = null) {
    this.budget = budget !== null ? budget : new LexiPackageBudget();
  }

  private static normalize(name: string): string {
    return name.replace(/\\/g, '/');
  }

  private static extensionOf(name: string): string {
    const normalized = LexiPackageVerifier.normalize(name);
    const dot = normalized.lastIndexOf('.');
    const slash = normalized.lastIndexOf('/');
    if (dot < 0 || dot < slash) { return ''; }
    return normalized.substring(dot).toLowerCase();
  }

  private decision(): LexiPackageDecision {
    return new LexiPackageDecision();
  }

  private deny(violations: string[], code: string, reason: string): LexiPackageDecision {
    const outcome = this.decision();
    outcome.ok = false;
    outcome.code = code;
    outcome.reason = reason;
    outcome.violations = violations;
    return outcome;
  }

  /**
   * 解压前/解压后的结构总检:预算、路径安全、重复、符号链接、扩展名、压缩炸弹。
   * name 一律先归一化反斜杠再判——'\..' 与 '../' 同罚。
   */
  inspectArchive(entries: LexiArchiveEntry[], zipBytes: number): LexiPackageDecision {
    const violations: string[] = [];
    const budget = this.budget;
    if (zipBytes > budget.maxZipBytes) {
      return this.deny(['zip 体积 ' + zipBytes + ' 超预算 ' + budget.maxZipBytes],
        'ERR_RESOURCE_LIMIT', 'ZIP 体积超预算(§8.4)');
    }
    const files = entries.filter((e: LexiArchiveEntry): boolean => !e.isDirectory);
    if (files.length > budget.maxFileCount) {
      return this.deny(['文件数 ' + files.length + ' 超预算 ' + budget.maxFileCount],
        'ERR_RESOURCE_LIMIT', '文件数超预算(§8.4)');
    }
    const seen: Map<string, boolean> = new Map();
    let expandedTotal = 0;
    for (const entry of entries) {
      const normalized = LexiPackageVerifier.normalize(entry.name);
      if (entry.isSymlink) {
        violations.push('符号链接条目: ' + normalized);
        continue;
      }
      if (normalized.indexOf('\u0000') >= 0) {
        violations.push('路径含 NUL: ' + normalized);
        continue;
      }
      const segments = normalized.split('/').filter((s: string): boolean => s.length > 0);
      const traversal =
        normalized.indexOf('/') === 0 ||
        /^[A-Za-z]:/.test(normalized) ||
        segments.indexOf('..') >= 0;
      if (traversal) {
        violations.push('路径穿越/绝对路径: ' + normalized);
        continue;
      }
      if (seen.has(normalized)) {
        violations.push('重复路径: ' + normalized);
        continue;
      }
      seen.set(normalized, true);
      if (!entry.isDirectory) {
        expandedTotal += entry.size;
        if (entry.size > budget.maxSingleFileBytes) {
          violations.push('单文件超限: ' + normalized + ' (' + entry.size + ' > ' + budget.maxSingleFileBytes + ')');
        }
        const ext = LexiPackageVerifier.extensionOf(normalized);
        if (budget.blockedExtensions.indexOf(ext) >= 0) {
          violations.push('受限二进制扩展: ' + normalized);
        } else if (budget.allowedExtensions.indexOf(ext) < 0) {
          violations.push('非白名单扩展: ' + normalized + ' (' + (ext.length === 0 ? '(无扩展名)' : ext) + ')');
        }
        if (entry.compressedSize > 0 && entry.size > budget.bombSuspicionBytes &&
          entry.size / entry.compressedSize > budget.maxCompressionRatio) {
          violations.push('压缩炸弹嫌疑: ' + normalized + ' (ratio=' +
            Math.round(entry.size / entry.compressedSize) + ')');
        }
      }
    }
    if (expandedTotal > budget.maxExpandedBytes) {
      violations.push('展开总体积 ' + expandedTotal + ' 超预算 ' + budget.maxExpandedBytes);
    }
    if (violations.length > 0) {
      return this.deny(violations, 'ERR_PACKAGE_INVALID',
        '安装包结构校验失败(§8.4): ' + violations.length + ' 处违规');
    }
    const outcome = this.decision();
    outcome.ok = true;
    return outcome;
  }

  /** 完整性:expected 为空 = 本地安装语义(跳过,结构校验不豁免);否则逐字节比对。 */
  static verifyHash(expected: string, actual: string): LexiPackageDecision {
    const outcome = new LexiPackageDecision();
    if (expected === undefined || expected === null || expected.length === 0) {
      outcome.ok = true;
      return outcome;
    }
    if (actual !== expected) {
      outcome.ok = false;
      outcome.code = 'ERR_HASH_MISMATCH';
      outcome.reason = '安装包 sha256 与声明不符(声明 ' + expected + ',实际 ' + actual + ')';
      return outcome;
    }
    outcome.ok = true;
    return outcome;
  }

  /**
   * 发布者签名(§9.2):expectedPayload 存在时 provided 必须存在且通过注入的校验函数;
   * 应签未签 = 拒绝(不能静默放过)。T4.2 升级为 TUF 风格角色链后,此缝承接 Targets 签名校验。
   */
  static verifyPublisherSignature(sigVerify: (signature: string, expectedPayload: string) => boolean,
    expectedPayload: string, provided: string): LexiPackageDecision {
    const outcome = new LexiPackageDecision();
    if (!provided || provided.length === 0) {
      outcome.ok = false;
      outcome.code = 'ERR_SIGNATURE_INVALID';
      outcome.reason = '发布者签名缺失(应签未签)';
      return outcome;
    }
    if (!sigVerify(provided, expectedPayload)) {
      outcome.ok = false;
      outcome.code = 'ERR_SIGNATURE_INVALID';
      outcome.reason = '发布者签名校验失败';
      return outcome;
    }
    outcome.ok = true;
    return outcome;
  }
}
