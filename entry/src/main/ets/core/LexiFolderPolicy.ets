// Pure path rules are shared by directory import, writes, and tests.
export class LexiFolderPolicy {
  static within(root: string, candidate: string): boolean {
    const base = root.replace(/\/+$/, '');
    return candidate.startsWith(`${base}/`) && LexiFolderPolicy.safeRelative(candidate.substring(base.length + 1));
  }

  static safeRelative(relative: string): boolean {
    return relative.length > 0 && !relative.startsWith('/') && !relative.includes('\\') &&
      relative.split('/').every((part: string): boolean => part.length > 0 && part !== '.' && part !== '..');
  }

  static fileName(title: string): string {
    const cleaned = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
    return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned.substring(0, 80) : '未命名笔记';
  }
}
