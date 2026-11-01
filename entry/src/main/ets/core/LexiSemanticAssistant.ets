import { intelligence } from '@kit.ArkData';
import { NoteItem } from './LexiModels';
import { MarkdownEngine, RawWikiLink } from './MarkdownEngine';
import { LexiLocalSuggestion } from './LexiLocalAssistant';

export class LexiSemanticSuggestion extends LexiLocalSuggestion {
  similarity: number = 0;
}

export class LexiSemanticResult {
  status: string = 'empty';
  message: string = '';
  candidateCount: number = 0;
  links: LexiSemanticSuggestion[] = [];
  tags: LexiSemanticSuggestion[] = [];
}

class LexiSemanticCandidate {
  noteId: string = '';
  title: string = '';
  text: string = '';
  tags: string[] = [];
  updatedAt: number = 0;
}

class LexiSemanticTask {
  settled: boolean = false;
  timer: number = -1;
  candidateCount: number = 0;
  resolve: ((result: LexiSemanticResult) => void) | undefined = undefined;
}

/**
 * Optional on-device semantic matching, not a generative assistant. ArkData's
 * BASIC_MODEL runs in the app process; no modelInfo, download policy or network
 * service is used. Phone/Tablet support starts at API 26; unavailable devices
 * return a reason so the caller can retain its clearly labelled rule results.
 */
export class LexiSemanticAssistant {
  private static nativeBusy: boolean = false;
  private static readonly candidateLimit: number = 24;
  private static readonly timeoutMs: number = 12000;
  private static readonly minimumSimilarity: number = 0.62;
  private pending: LexiSemanticTask | undefined = undefined;
  private disposed: boolean = false;

  static supported(): boolean {
    try { return canIUse('SystemCapability.DistributedDataManager.DataIntelligence.Core'); }
    catch { return false; }
  }

  private static result(status: string, message: string, count: number = 0): LexiSemanticResult {
    const result = new LexiSemanticResult();
    result.status = status; result.message = message; result.candidateCount = count; return result;
  }

  private static limit(text: string, count: number): string {
    if (text.length <= count) { return text; }
    const end = text.charCodeAt(count - 1);
    return text.slice(0, end >= 0xD800 && end <= 0xDBFF ? count - 1 : count);
  }

  private static plain(content: string): string {
    // Bound preprocessing before parsing, and keep metadata/code out of vectors.
    return MarkdownEngine.parseFrontmatter(content.slice(0, 50000)).body
      .replace(/```[\s\S]*?(?:```|$)/g, '').replace(/~~~[\s\S]*?(?:~~~|$)/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/!?\[\[([^\]]+)\]\]/g, '$1')
      .replace(/^[#>\s]+/gm, '').replace(/(?:\*\*|__|==|~~|`)/g, '')
      .replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?/gm, '').replace(/\s+/g, ' ').trim();
  }

  private static candidates(content: string, notes: NoteItem[], currentNoteId: string): LexiSemanticCandidate[] {
    const body = MarkdownEngine.parseFrontmatter(content.slice(0, 50000)).body;
    const targets = MarkdownEngine.extractWikiLinks(body).map((link: RawWikiLink): string => link.targetText.toLowerCase());
    const pool: LexiSemanticCandidate[] = [];
    const seen = new Set<string>();
    // The caller supplies its available workspace notes. Never read other files,
    // use paths, or expand the search outside these explicitly supplied notes.
    const available = notes.slice(0, 3000).filter((note: NoteItem): boolean =>
      note.id !== currentNoteId && note.content !== content && note.trashedAt === 0 && !note.sourceMissing &&
      note.title.trim().length >= 2 && note.title.trim().length <= 80 && !/[\[\]|#\r\n]/.test(note.title));
    available.sort((first: NoteItem, second: NoteItem): number =>
      second.updatedAt - first.updatedAt || first.id.localeCompare(second.id));
    for (const note of available) {
      const title = note.title.trim(); const titleKey = title.toLowerCase();
      if (seen.has(titleKey) || targets.includes(titleKey) || targets.includes(note.id.toLowerCase())) { continue; }
      const candidate = new LexiSemanticCandidate();
      candidate.noteId = note.id; candidate.title = title; candidate.updatedAt = note.updatedAt;
      candidate.tags = note.tags.slice(0, 30);
      // Only an excerpt is compared. Bound preparation on the UI thread even
      // when a candidate contains a very large Markdown document.
      candidate.text = LexiSemanticAssistant.limit(`${title} ${LexiSemanticAssistant.plain(note.content.slice(0, 6000))}`, 512);
      pool.push(candidate); seen.add(titleKey);
      if (pool.length >= LexiSemanticAssistant.candidateLimit) { break; }
    }
    return pool;
  }

  private static normalized(vector: number[]): number[] | undefined {
    if (!Array.isArray(vector) || !vector.length || vector.length > 4096) { return undefined; }
    let scale = 0;
    for (const coordinate of vector) {
      if (!Number.isFinite(coordinate)) { return undefined; }
      scale = Math.max(scale, Math.abs(coordinate));
    }
    if (scale === 0) { return undefined; }
    let squared = 0;
    for (const coordinate of vector) { squared += (coordinate / scale) * (coordinate / scale); }
    const magnitude = Math.sqrt(squared);
    return vector.map((coordinate: number): number => (coordinate / scale) / magnitude);
  }

  private static cosine(query: number[], candidate: number[]): number {
    if (query.length !== candidate.length) { return -1; }
    let product = 0;
    for (let index = 0; index < query.length; index++) { product += query[index] * candidate[index]; }
    return Math.min(1, Math.max(-1, product));
  }

  private static ranked(content: string, candidates: LexiSemanticCandidate[], vectors: number[][]): LexiSemanticResult {
    const query = LexiSemanticAssistant.normalized(vectors[0]);
    if (!query || vectors.length !== candidates.length + 1) { throw new Error('invalid-embedding'); }
    const result = LexiSemanticAssistant.result('ready', '已使用本机语义模型匹配相关笔记和已有标签，请确认后插入。', candidates.length);
    const ranked: LexiSemanticSuggestion[] = [];
    const tagScores = new Map<string, number>();
    const existingTags = MarkdownEngine.parseFrontmatter(content.slice(0, 50000)).tags
      .concat(MarkdownEngine.extractInlineTags(content.slice(0, 50000))).map((tag: string): string => tag.toLowerCase());
    for (let index = 0; index < candidates.length; index++) {
      const normalized = LexiSemanticAssistant.normalized(vectors[index + 1]);
      if (!normalized) { continue; }
      const similarity = LexiSemanticAssistant.cosine(query, normalized);
      if (similarity < LexiSemanticAssistant.minimumSimilarity) { continue; }
      const candidate = candidates[index];
      const suggestion = new LexiSemanticSuggestion();
      suggestion.id = `semantic-link-${candidate.noteId}`; suggestion.label = candidate.title;
      suggestion.markdown = `[[${candidate.title}]]`; suggestion.similarity = similarity;
      suggestion.detail = '由设备内置语义模型匹配，请检查内容是否相关'; ranked.push(suggestion);
      for (const tag of candidate.tags) {
        if (!/^[\u4e00-\u9fa5A-Za-z0-9_\/-]{1,28}$/.test(tag) || existingTags.includes(tag.toLowerCase())) { continue; }
        tagScores.set(tag, Math.max(tagScores.get(tag) ?? 0, similarity));
      }
    }
    ranked.sort((first: LexiSemanticSuggestion, second: LexiSemanticSuggestion): number =>
      second.similarity - first.similarity || first.id.localeCompare(second.id));
    result.links = ranked.slice(0, 6);
    const tags: LexiSemanticSuggestion[] = [];
    tagScores.forEach((similarity: number, tag: string): void => {
      const suggestion = new LexiSemanticSuggestion();
      suggestion.id = `semantic-tag-${tag}`; suggestion.label = `#${tag}`; suggestion.markdown = `#${tag}`;
      suggestion.similarity = similarity; suggestion.detail = '来自语义相关笔记的已有标签，请检查后使用'; tags.push(suggestion);
    });
    tags.sort((first: LexiSemanticSuggestion, second: LexiSemanticSuggestion): number =>
      second.similarity - first.similarity || first.id.localeCompare(second.id));
    result.tags = tags.slice(0, 6);
    if (!result.links.length && !result.tags.length) {
      result.status = 'empty'; result.message = '本次未找到足够相关的语义建议，可继续使用原文摘录与规则匹配。';
    }
    return result;
  }

  private settle(task: LexiSemanticTask, result: LexiSemanticResult): void {
    if (task.settled) { return; }
    task.settled = true;
    if (task.timer >= 0) { clearTimeout(task.timer); task.timer = -1; }
    if (this.pending === task) { this.pending = undefined; }
    const resolve = task.resolve; task.resolve = undefined;
    if (resolve) { resolve(result); }
  }

  private async run(task: LexiSemanticTask, content: string, query: string, candidates: LexiSemanticCandidate[]): Promise<void> {
    let model: intelligence.TextEmbedding | undefined = undefined;
    try {
      const config: intelligence.ModelConfig = {
        version: intelligence.ModelVersion.BASIC_MODEL, isNpuAvailable: false
      };
      model = await intelligence.getTextEmbeddingModel(config);
      if (task.settled) { return; }
      await model.loadModel();
      if (task.settled) { return; }
      const batch: string[] = [query].concat(candidates.map((candidate: LexiSemanticCandidate): string => candidate.text));
      const vectors: number[][] = await model.getEmbedding(batch);
      if (!task.settled) { this.settle(task, LexiSemanticAssistant.ranked(content, candidates, vectors)); }
    } catch {
      this.settle(task, LexiSemanticAssistant.result('unavailable',
        '设备本地语义模型暂不可用，已保留规则匹配；未尝试下载模型或使用联网服务。', task.candidateCount));
    } finally {
      // There is no native cancel API. A cancelled/timed-out caller resolves
      // immediately, but cleanup waits for the in-flight native call to return.
      // Keep the process-wide lease until release settles to avoid overlapping
      // model loads or release racing an inference from another editor window.
      if (model) { try { await model.releaseModel(); } catch {} }
      LexiSemanticAssistant.nativeBusy = false;
    }
  }

  suggest(content: string, notes: NoteItem[], currentNoteId: string = ''): Promise<LexiSemanticResult> {
    if (this.disposed) { return Promise.resolve(LexiSemanticAssistant.result('disposed', '语义面板已关闭。')); }
    this.cancel();
    if (!LexiSemanticAssistant.supported()) {
      return Promise.resolve(LexiSemanticAssistant.result('unsupported', '这台设备未提供本地语义模型，可继续使用原文摘录与规则匹配。'));
    }
    if (LexiSemanticAssistant.nativeBusy) {
      return Promise.resolve(LexiSemanticAssistant.result('busy', '本地语义模型正在处理上一项请求，请稍后重试。'));
    }
    const query = LexiSemanticAssistant.limit(LexiSemanticAssistant.plain(content), 512);
    if (query.length < 10) {
      return Promise.resolve(LexiSemanticAssistant.result('empty', '正文较少，先补充一些内容再匹配相关笔记。'));
    }
    const candidates = LexiSemanticAssistant.candidates(content, notes, currentNoteId);
    if (!candidates.length) {
      return Promise.resolve(LexiSemanticAssistant.result('empty', '当前没有可比较的其他笔记，可继续使用原文摘录与规则匹配。'));
    }
    const task = new LexiSemanticTask(); task.candidateCount = candidates.length;
    this.pending = task; LexiSemanticAssistant.nativeBusy = true;
    return new Promise<LexiSemanticResult>((resolve: (result: LexiSemanticResult) => void): void => {
      task.resolve = resolve;
      task.timer = setTimeout((): void => {
        this.settle(task, LexiSemanticAssistant.result('timeout', '本地语义匹配超时，已保留规则结果，可稍后重试。', task.candidateCount));
      }, LexiSemanticAssistant.timeoutMs);
      this.run(task, content, query, candidates);
    });
  }

  cancel(): void {
    if (this.pending) {
      this.settle(this.pending, LexiSemanticAssistant.result('cancelled', '已取消本次语义匹配。'));
    }
  }

  dispose(): void { this.disposed = true; this.cancel(); }
}
