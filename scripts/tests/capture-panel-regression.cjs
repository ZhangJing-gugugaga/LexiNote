// Execute the real non-rendering methods extracted from the ArkUI panel. Native
// speech/embedding services are mocked; Markdown extraction/insertion is real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const coreRoot = path.resolve(__dirname, '../../entry/src/main/ets/core');
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const filename = path.join(coreRoot, name + '.ets');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '})', { filename })(spec => {
    if (spec.startsWith('./')) return load(spec.slice(2));
    throw new Error('Unexpected dependency ' + spec);
  }, mod, mod.exports);
  cache.set(name, mod.exports); return mod.exports;
}
const { LexiLocalAssistant, LexiLocalArrangement, LexiLocalSuggestion } = load('LexiLocalAssistant');
const { NoteItem } = load('LexiModels');
let speechSupported = true, semanticFactory;
const speechInstances = [], semanticInstances = [];
class SpeechMock {
  constructor() { this.starts = 0; this.cancels = 0; this.disposals = 0; speechInstances.push(this); }
  static supported() { return speechSupported; }
  async start(_context, listener) { this.starts++; this.listener = listener; }
  cancel() { this.cancels++; }
  dispose() { this.disposals++; }
}
class SemanticMock {
  constructor() { this.calls = []; this.cancels = 0; this.disposals = 0; semanticInstances.push(this); }
  suggest(content, notes) { this.calls.push([content, notes]); return semanticFactory(); }
  cancel() { this.cancels++; }
  dispose() { this.disposals++; }
}
const source = fs.readFileSync(path.resolve(coreRoot, '../components/LexiCaptureAssistantPanel.ets'), 'utf8');
const start = source.indexOf('export struct LexiCaptureAssistantPanel {');
const end = source.indexOf('  @Builder\n  private speechContent()', start);
assert.ok(start >= 0 && end > start, 'real panel method boundaries');
const classSource = source.slice(start, end).replace('export struct LexiCaptureAssistantPanel', 'class CapturePanel')
  .replace(/@Prop\s+/g, '').replace(/@State\s+/g, '') + '\n};globalThis.CapturePanel=CapturePanel;';
const sandbox = { LexiOfflineSpeech: SpeechMock, LexiSemanticAssistant: SemanticMock, LexiLocalAssistant, LexiLocalArrangement };
vm.createContext(sandbox);
vm.runInContext(ts.transpileModule(classSource, { compilerOptions: { target: ts.ScriptTarget.ES2021 } }).outputText, sandbox);
function defer() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function suggestion(id, markdown) { const s = new LexiLocalSuggestion(); s.id = id; s.label = markdown; s.markdown = markdown; return s; }
function result(links = [], tags = [], message = '本机语义匹配完成', status = 'ready') { return { status, message, links, tags, candidateCount: 2 }; }
function panel() {
  speechSupported = true; speechInstances.length = 0; semanticInstances.length = 0;
  const pending = defer(); semanticFactory = () => pending.promise;
  const p = new sandbox.CapturePanel(), events = [];
  const note = new NoteItem(); Object.assign(note, { id: 'n1', title: '架构设计', content: '其他资料', tags: ['项目'] });
  Object.assign(p, { content: '本次项目讨论记录了数据迁移的实施方案。\nTODO: 提交报告\n架构设计', availableNotes: [note], onClose: () => events.push(['close']), onInsert: text => events.push(['insert', text]), getUIContext: () => ({ getHostContext: () => ({}) }) });
  p.aboutToAppear(); return { p, pending, events, speech: speechInstances[0], semantic: semanticInstances[0] };
}
const tests = [
  ['opening and arranging never start recording or request microphone access', async () => {
    const { p, pending, speech, semantic, events } = panel();
    assert.equal(p.alive, true); assert.equal(speech.starts, 0); assert.equal(p.speechState, 'idle');
    const work = p.arrange(); assert.equal(p.arranged, true); assert.ok(p.summaryDraft); assert.equal(p.arrangement.actions[0].markdown, '- [ ] 提交报告');
    assert.equal(p.semanticRunning, true); assert.equal(semantic.calls.length, 1); assert.equal(speech.starts, 0); assert.equal(events.length, 0);
    pending.resolve(result()); await work; assert.equal(p.semanticRunning, false); assert.equal(speech.starts, 0); assert.equal(events.length, 0);
  }],
  ['merging semantic suggestions deduplicates Markdown case-insensitively and preserves original rule IDs', async () => {
    const { p } = panel(); const existing = [suggestion('rule-a', '[[架构设计]]'), suggestion('rule-b', '[[API]]')];
    const incoming = [suggestion('semantic-a', '[[架构设计]]'), suggestion('semantic-b', '[[api]]'), suggestion('semantic-c', '[[系统边界]]'), suggestion('semantic-d', '[[系统边界]]')];
    const before = JSON.stringify([existing, incoming]); const merged = p.mergeSuggestions(existing, incoming);
    assert.deepEqual(Array.from(merged, x => x.id), ['rule-a', 'rule-b', 'semantic-c']); assert.equal(JSON.stringify([existing, incoming]), before);
  }],
  ['a late semantic result preserves an edited summary, summary selection and checked rule suggestions', async () => {
    const { p, pending } = panel(), work = p.arrange(); const originalSummary = p.arrangement.summary;
    const actionId = p.arrangement.actions[0].id, linkId = p.arrangement.links[0].id, tagId = p.arrangement.tags[0].id;
    p.summaryDraft = '用户在等待期间重新写的摘要'; p.summarySelected = true; p.selectSuggestion(actionId, true); p.selectSuggestion(linkId, true); p.selectSuggestion(tagId, true);
    const before = Array.from(p.selectedIds);
    pending.resolve(result([suggestion('semantic-duplicate', '[[架构设计]]'), suggestion('semantic-extra', '[[旅行清单]]')], [suggestion('semantic-project', '#项目'), suggestion('semantic-new-tag', '#迁移')])); await work;
    assert.equal(p.summaryDraft, '用户在等待期间重新写的摘要'); assert.equal(p.summarySelected, true); assert.deepEqual(Array.from(p.selectedIds), before);
    assert.equal(p.arrangement.summary, originalSummary); assert.equal(p.arrangement.actions[0].id, actionId);
    assert.deepEqual(Array.from(p.arrangement.links, x => x.id), [linkId, 'semantic-extra']); assert.deepEqual(Array.from(p.arrangement.tags, x => x.id), [tagId, 'semantic-new-tag']);
    const markdown = p.selectedMarkdown(); assert.ok(markdown.includes('用户在等待期间重新写的摘要')); assert.ok(markdown.includes('- [ ] 提交报告')); assert.ok(markdown.includes('[[架构设计]]')); assert.ok(!markdown.includes('[[旅行清单]]')); assert.ok(!markdown.includes('#迁移'));
  }],
  ['reported model unavailability keeps rule results and the editable summary unchanged', async () => {
    const { p, pending } = panel(), work = p.arrange(); const rule = JSON.stringify(p.arrangement); p.summaryDraft = '已编辑摘要'; p.summarySelected = true;
    pending.resolve(result([], [], '本地模型不可用，未尝试联网', 'unavailable')); await work;
    assert.equal(JSON.stringify(p.arrangement), rule); assert.equal(p.summaryDraft, '已编辑摘要'); assert.equal(p.summarySelected, true); assert.ok(p.arrangeMessage.includes('未尝试联网')); assert.equal(p.semanticRunning, false);
  }],
  ['a rejected semantic request retains rule suggestions and stops the progress state', async () => {
    const { p, pending } = panel(), work = p.arrange(); const rule = JSON.stringify(p.arrangement); p.selectSuggestion(p.arrangement.actions[0].id, true);
    pending.reject(new Error('native failure')); await work;
    assert.equal(JSON.stringify(p.arrangement), rule); assert.equal(p.selectedIds.length, 1); assert.ok(p.arrangeMessage.includes('已保留原文摘录与规则建议')); assert.equal(p.semanticRunning, false);
  }],
  ['repeated arrange clicks while pending cannot reset edits or create concurrent native requests', async () => {
    const { p, pending, semantic } = panel(), first = p.arrange(); p.summaryDraft = '保留的修改'; p.summarySelected = true;
    const generation = p.arrangeGeneration; await p.arrange(); assert.equal(semantic.calls.length, 1); assert.equal(p.arrangeGeneration, generation); assert.equal(p.summaryDraft, '保留的修改'); assert.equal(p.summarySelected, true);
    pending.resolve(result()); await first;
  }],
  ['disappearing invalidates pending results and releases both service owners', async () => {
    const { p, pending, speech, semantic } = panel(), work = p.arrange(); p.aboutToDisappear();
    assert.equal(p.alive, false); assert.equal(speech.disposals, 1); assert.equal(semantic.disposals, 1);
    const snapshot = JSON.stringify(p); pending.resolve(result([suggestion('late', '[[迟到结果]]')])); await work; assert.equal(JSON.stringify(p), snapshot);
  }],
  ['an obsolete request cannot overwrite a newer generation even while the panel is alive', async () => {
    const { p, pending } = panel(), work = p.arrange(); p.arrangeGeneration++; p.arrangeMessage = '新的整理状态'; const snapshot = JSON.stringify(p);
    pending.resolve(result([suggestion('late', '[[迟到结果]]')])); await work; assert.equal(JSON.stringify(p), snapshot);
  }],
  ['pressing close invalidates a pending semantic result before the sheet disappearance animation finishes', async () => {
    const { p, pending, events, semantic } = panel(), work = p.arrange(); p.closePanel(); assert.equal(events.filter(x => x[0] === 'close').length, 1);
    assert.ok(semantic.cancels > 0 || semantic.disposals > 0, 'close immediately invalidates/releases semantic ownership');
    const snapshot = JSON.stringify(p); pending.resolve(result([suggestion('late', '[[关闭后迟到结果]]')])); await work; assert.equal(JSON.stringify(p), snapshot);
  }],
  ['only explicit insertion writes the edited selection and never records speech', async () => {
    const { p, pending, events, speech } = panel(), work = p.arrange(); pending.resolve(result([suggestion('extra', '[[旅行清单]]')])); await work;
    assert.equal(events.length, 0); p.insertArrangement(); assert.equal(events.length, 0);
    p.summaryDraft = '确认后的摘要'; p.summarySelected = true; p.selectSuggestion('extra', true); p.insertArrangement();
    assert.equal(events.length, 1); assert.equal(events[0][0], 'insert'); assert.ok(events[0][1].includes('确认后的摘要')); assert.ok(events[0][1].includes('[[旅行清单]]')); assert.ok(!events[0][1].includes('- [ ] 提交报告')); assert.equal(p.summarySelected, false); assert.equal(p.selectedIds.length, 0); assert.equal(speech.starts, 0);
  }],
  ['unsupported speech remains manual and dismissed panels ignore late speech callbacks', async () => {
    const { p, speech } = panel(); speechSupported = false; p.aboutToAppear(); p.startRecording(); assert.equal(speech.starts, 0); assert.equal(p.speechSupported, false); assert.ok(p.speechMessage.includes('手动输入'));
    p.aboutToDisappear(); const snapshot = JSON.stringify(p); p.receiveSpeech({ state: 'complete', text: '迟到的识别文字', message: '完成' }); assert.equal(JSON.stringify(p), snapshot);
  }]
];
(async () => { for (const [name, run] of tests) { await run(); console.log('PASS ' + name); } console.log(`${tests.length} capture panel regression groups passed.`); })().catch(error => { console.error(error); process.exitCode = 1; });
