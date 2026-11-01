const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const cache = new Map();
const timers = new Map();
let timerId = 0, supported = true, factory, calls = [], capturedBatch = [];
global.canIUse = () => supported;
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const filename = path.resolve(__dirname, '../../entry/src/main/ets/core/' + name + '.ets');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports,setTimeout,clearTimeout){' + js + '})', { filename })(spec => {
    if (spec.startsWith('./')) return load(spec.slice(2));
    if (spec === '@kit.ArkData') return { intelligence: { ModelVersion: { BASIC_MODEL: 0 }, getTextEmbeddingModel: config => { calls.push(config); return factory(); } } };
    throw new Error('Unexpected external dependency ' + spec);
  }, mod, mod.exports, (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, id => timers.delete(id));
  cache.set(name, mod.exports); return mod.exports;
}
const { LexiSemanticAssistant: Assistant } = load('LexiSemanticAssistant');
const { NoteItem } = load('LexiModels');
function note(id, title, content = '与当前正文不同的笔记内容', tags = [], updatedAt = 0) { const n = new NoteItem(); Object.assign(n, { id, title, content, tags, updatedAt }); return n; }
function model(vectors) { return { loads: 0, releases: 0, embeddings: 0, async loadModel() { this.loads++; }, async getEmbedding(batch) { capturedBatch = batch; this.embeddings++; return typeof vectors === 'function' ? vectors(batch) : vectors; }, async releaseModel() { this.releases++; } }; }
function defer() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function tick() { await new Promise(resolve => setImmediate(resolve)); }
function reset() { supported = true; calls = []; capturedBatch = []; timers.clear(); }
const body = '下次出门准备背包，检查防雨装备，然后规划山间路线。';
const tests = [
  ['unsupported and empty inputs never load a model', async () => {
    reset(); supported = false; const a = new Assistant(); assert.equal((await a.suggest(body, [note('a', '旅行准备')])).status, 'unsupported'); assert.equal(calls.length, 0);
    supported = true; assert.equal((await a.suggest('', [note('a', '旅行准备')])).status, 'empty'); assert.equal((await a.suggest(body, [])).status, 'empty'); assert.equal(calls.length, 0); assert.equal(timers.size, 0);
  }],
  ['real native vectors drive semantic links and existing tag suggestions without lexical title matches', async () => {
    reset(); const native = model([[1, 0], [9, 1], [0, 1], [3, 1]]); factory = async () => native;
    const notes = [note('a', '徒步入门', '徒步技巧', ['户外', '已选']), note('b', '数据库设计', '范式设计', ['技术']), note('c', '轻装远足', '旅行检查', ['旅行'])];
    const before = JSON.stringify(notes); const result = await new Assistant().suggest(body + ' #已选', notes); await tick();
    assert.equal(result.status, 'ready'); assert.deepEqual(result.links.map(x => x.markdown), ['[[徒步入门]]', '[[轻装远足]]']);
    assert.deepEqual(result.tags.map(x => x.markdown), ['#户外', '#旅行']); assert.ok(result.links[0].similarity > result.links[1].similarity);
    assert.ok(result.links[0].detail.includes('语义模型')); assert.equal(result.candidateCount, 3); assert.equal(JSON.stringify(notes), before);
    assert.deepEqual(calls, [{ version: 0, isNpuAvailable: false }]); assert.equal(native.loads, 1); assert.equal(native.releases, 1); assert.equal(timers.size, 0);
  }],
  ['candidate selection excludes self, unavailable, already linked and unsafe or repeated titles, then caps recent notes', async () => {
    reset(); const native = model(batch => batch.map(() => [1, 0])); factory = async () => native;
    const notes = [note('self', '自己'), note('same', '相同正文', body), note('gone', '已删除'), note('missing', '文件缺失'), note('unsafe', '误导]]标题'), note('linked', '已有链接'), note('duplicate-old', '同名记录', '旧版', [], 1), note('duplicate-new', '同名记录', '新版', [], 1000)];
    notes[2].trashedAt = 1; notes[3].sourceMissing = true;
    for (let i = 0; i < 40; i++) notes.push(note('n-' + i, '普通笔记' + i, '有效正文' + i, [], 100 + i));
    const result = await new Assistant().suggest(body + '\n[[已有链接]]', notes, 'self'); await tick();
    assert.equal(result.candidateCount, 24); assert.equal(capturedBatch.length, 25); assert.equal(capturedBatch[1], '同名记录 新版'); assert.ok(!capturedBatch.includes('同名记录 旧版'));
    for (const forbidden of ['自己', '已删除', '文件缺失', '误导]]标题', '已有链接']) assert.ok(!capturedBatch.slice(1).some(x => x.startsWith(forbidden)));
    assert.equal(result.links.length, 6); assert.ok(result.links.every(x => x.similarity === 1));
  }],
  ['vectors contain bounded plain text rather than YAML, fenced code, image URLs or broken surrogate pairs', async () => {
    reset(); const native = model(batch => batch.map(() => [1, 0])); factory = async () => native;
    const content = '---\nsecret: 不应进入模型\n---\n# 普通正文\n```ts\n私密代码\n```\n![图](https://secret.invalid)\n' + '山'.repeat(501) + '😀';
    const result = await new Assistant().suggest(content, [note('a', '其他记录', content + '不同')]); await tick();
    assert.equal(result.status, 'ready'); for (const text of capturedBatch) { assert.ok(text.length <= 512); assert.ok(!text.includes('不应进入模型')); assert.ok(!text.includes('私密代码')); assert.ok(!text.includes('secret.invalid')); assert.ok(!/[\uD800-\uDBFF]$/.test(text)); }
  }],
  ['similarity is scale invariant and rejects weak, negative and invalid candidate vectors', async () => {
    reset(); const native = model([[1e300, 0], [1e-300, 0], [0, 1], [-1, 0], [NaN, 0], [0, 0], [1, 0, 1]]); factory = async () => native;
    const result = await new Assistant().suggest(body, Array.from({ length: 6 }, (_, i) => note('n' + i, '不同主题' + i))); await tick();
    assert.deepEqual(result.links.map(x => x.markdown), ['[[不同主题0]]']); assert.equal(result.links[0].similarity, 1);
  }],
  ['malformed native batches and invalid query vectors fail gracefully and release resources', async () => {
    for (const vectors of [[], [[0, 0], [1, 0]], [[Infinity], [1]], [[1, 0]], [Array(4097).fill(1), [1]]]) {
      reset(); const native = model(vectors); factory = async () => native; const result = await new Assistant().suggest(body, [note('a', '其他笔记')]); await tick();
      assert.equal(result.status, 'unavailable'); assert.deepEqual(result.links, []); assert.equal(native.releases, 1); assert.equal(timers.size, 0);
    }
  }],
  ['native failures retain an explicit offline fallback reason and release the acquired model', async () => {
    reset(); const native = model([]); native.loadModel = async () => { throw new Error('801'); }; factory = async () => native;
    const result = await new Assistant().suggest(body, [note('a', '其他笔记')]); await tick();
    assert.equal(result.status, 'unavailable'); assert.ok(result.message.includes('未尝试下载模型或使用联网服务')); assert.equal(native.embeddings, 0); assert.equal(native.releases, 1);
    factory = async () => { throw new Error('model missing'); }; assert.equal((await new Assistant().suggest(body, [note('a', '其他笔记')])).status, 'unavailable'); await tick();
  }],
  ['cancellation while acquisition is pending releases a late model before loading or inference', async () => {
    reset(); const waiting = defer(); factory = () => waiting.promise; const assistant = new Assistant(); const pending = assistant.suggest(body, [note('a', '其他笔记')]); assistant.cancel();
    assert.equal((await pending).status, 'cancelled'); const native = model([]); waiting.resolve(native); await tick();
    assert.equal(native.loads, 0); assert.equal(native.embeddings, 0); assert.equal(native.releases, 1); assert.equal(timers.size, 0);
  }],
  ['cancelled inferences never publish stale suggestions and process-wide lease prevents overlapping native work', async () => {
    reset(); const waiting = defer(); const native = model([]); native.getEmbedding = async () => { native.embeddings++; return waiting.promise; }; factory = async () => native;
    const first = new Assistant(), second = new Assistant(); const pending = first.suggest(body, [note('a', '其他笔记')]); await tick();
    assert.equal((await second.suggest(body, [note('b', '第三笔记')])).status, 'busy'); first.cancel(); assert.equal((await pending).status, 'cancelled');
    assert.equal((await second.suggest(body, [note('b', '第三笔记')])).status, 'busy'); assert.equal(native.releases, 0);
    waiting.resolve([[1, 0], [1, 0]]); await tick(); assert.equal(native.releases, 1);
    const fresh = model([[1, 0], [1, 0]]); factory = async () => fresh; assert.equal((await second.suggest(body, [note('b', '第三笔记')])).status, 'ready'); await tick(); assert.equal(fresh.releases, 1);
  }],
  ['timeout resolves UI promptly, clears timers and ignores eventual inference results before releasing', async () => {
    reset(); const waiting = defer(), native = model([]); native.getEmbedding = async () => waiting.promise; factory = async () => native;
    const assistant = new Assistant(), pending = assistant.suggest(body, [note('a', '其他笔记')]); await tick();
    const timer = [...timers.values()].find(t => t.ms === 12000); assert.ok(timer); timer.fn(); const result = await pending;
    assert.equal(result.status, 'timeout'); assert.equal(result.candidateCount, 1); assert.deepEqual(result.links, []); assert.equal(timers.size, 0);
    waiting.resolve([[1, 0], [1, 0]]); await tick(); assert.equal(result.status, 'timeout'); assert.equal(native.releases, 1);
  }],
  ['dispose cancels pending requests and permanently prevents future model loading', async () => {
    reset(); const waiting = defer(); factory = () => waiting.promise; const assistant = new Assistant(), pending = assistant.suggest(body, [note('a', '其他笔记')]); assistant.dispose();
    assert.equal((await pending).status, 'cancelled'); assert.equal((await assistant.suggest(body, [note('a', '其他笔记')])).status, 'disposed'); assert.equal(calls.length, 1);
    const native = model([]); waiting.resolve(native); await tick(); assert.equal(native.releases, 1);
  }],
  ['no relevant vectors return an empty result and a failed release does not keep the model busy forever', async () => {
    reset(); const native = model([[1, 0], [0, 1]]); native.releaseModel = async () => { throw new Error('release failure'); }; factory = async () => native;
    const assistant = new Assistant(), result = await assistant.suggest(body, [note('a', '其他笔记')]); await tick(); assert.equal(result.status, 'empty');
    const fresh = model([[1, 0], [1, 0]]); factory = async () => fresh; assert.equal((await assistant.suggest(body, [note('a', '其他笔记')])).status, 'ready'); await tick();
    const source = fs.readFileSync(path.resolve(__dirname, '../../entry/src/main/ets/core/LexiSemanticAssistant.ets'), 'utf8');
    assert.ok(!source.includes('@kit.NetworkKit')); assert.equal((source.match(/version:\s*intelligence\.ModelVersion\.\w+/g) || []).join(','), 'version: intelligence.ModelVersion.BASIC_MODEL');
  }]
];
(async () => { for (const [name, run] of tests) { await run(); console.log('PASS ' + name); } console.log(`${tests.length} semantic assistant regression groups passed. Native model quality/availability still require supported real devices.`); })().catch(error => { console.error(error); process.exitCode = 1; });
