// Pure library checks against the real ArkTS classes. No storage/UI mocks or
// project data writes are needed for this independent template model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const core = path.resolve(__dirname, '../../entry/src/main/ets/core');
const loaded = new Map();
function load(name) {
  if (loaded.has(name)) return loaded.get(name);
  const filename = path.join(core, name + '.ets');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const scope = { exports: {} };
  const requireLocal = spec => {
    assert.ok(spec.startsWith('./'), 'Only pure local dependencies are allowed');
    return load(spec.substring(2));
  };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename })(requireLocal, scope, scope.exports);
  loaded.set(name, scope.exports);
  return scope.exports;
}
const { LexiTemplateLibrary: Library, LexiTemplateItem: Item, LexiTemplateLibraryState: State } = load('LexiTemplateLibrary');
const { NoteProperty } = load('LexiModels');
const { LexiTemplates: Variables } = load('LexiTemplates');
const tests = [];
const test = (name, run) => tests.push([name, run]);
const encode = state => JSON.stringify(state);
const decode = state => Library.decode(encode(state));
const invalid = mutate => {
  const state = Library.fresh();
  mutate(state, state.templates[0]);
  assert.throws(() => decode(state));
};

test('fresh seeds exactly six templates with stable ids and a daily default', () => {
  const state = Library.fresh();
  assert.ok(state instanceof State);
  assert.equal(state.version, 1);
  assert.equal(state.defaultDailyId, 'builtin-daily');
  assert.equal(state.legacyImported, false);
  assert.deepEqual(state.templates.map(item => item.id), [
    'builtin-daily', 'builtin-schedule', 'builtin-code', 'builtin-study', 'builtin-meeting', 'builtin-project'
  ]);
  assert.ok(state.templates.every(item => item instanceof Item && item.builtIn && item.title && item.content && item.category));
});

test('all builtins have Chinese content and supported dynamic variables', () => {
  for (const item of Library.builtins()) {
    assert.match(item.title, /[\u4e00-\u9fff]/);
    assert.match(item.content, /[\u4e00-\u9fff]/);
    const rendered = Variables.render(item.content, '验收标题', new Date(2026, 9, 31, 9, 5));
    assert.ok(!/\{\{/.test(rendered), item.id);
    assert.ok(rendered.includes('2026-10-31'), item.id);
  }
});

test('the code template uses an unlabeled fence rather than a hardcoded language', () => {
  const code = Library.builtins().find(item => item.id === 'builtin-code');
  assert.equal(code.content.split('\n').filter(line => line === '```').length, 2);
  assert.ok(!/^```[^\r\n]+/m.test(code.content));
});

test('builtin calls and fresh libraries never share mutable arrays or items', () => {
  const first = Library.builtins();
  first[0].title = '编辑过的内置';
  first[0].tags.push('新标签');
  first[0].properties.push(new NoteProperty('作者', '我'));
  first.splice(1, 1);
  const second = Library.builtins();
  assert.equal(second.length, 6);
  assert.equal(second[0].title, '每日记录');
  assert.deepEqual(second[0].tags, ['日记']);
  assert.deepEqual(second[0].properties, []);
  const a = Library.fresh(), b = Library.fresh();
  a.templates[0].content = '改写';
  assert.notEqual(a.templates[0].content, b.templates[0].content);
});

test('clone preserves every field while copying tags and property objects independently', () => {
  const item = new Item();
  Object.assign(item, { id: 'custom-one', title: '自定义', content: '内容', category: '个人', tags: ['一'],
    properties: [new NoteProperty('状态', '草稿')], builtIn: false, sourceNoteId: 'source-note', createdAt: 1, updatedAt: 2 });
  const copy = Library.clone(item);
  assert.deepEqual(copy, item);
  assert.ok(copy instanceof Item);
  assert.ok(copy.properties[0] instanceof NoteProperty);
  copy.tags[0] = '二'; copy.properties[0].propValue = '完成'; copy.title = '副本';
  assert.deepEqual(item.tags, ['一']);
  assert.equal(item.properties[0].propValue, '草稿');
  assert.equal(item.title, '自定义');
});

test('decode preserves edited builtins and never replenishes deleted builtin records', () => {
  const state = Library.fresh();
  state.templates[0].title = '我的日记'; state.templates[0].content = '# 自定义内容';
  state.templates[0].properties = [new NoteProperty('主题', '个人')];
  state.templates = state.templates.filter(item => item.id !== 'builtin-schedule');
  state.legacyImported = true;
  const restored = decode(state);
  assert.equal(restored.templates.length, 5);
  assert.equal(restored.templates[0].title, '我的日记');
  assert.equal(restored.templates[0].content, '# 自定义内容');
  assert.equal(restored.templates[0].properties[0].propValue, '个人');
  assert.equal(restored.legacyImported, true);
  assert.ok(!restored.templates.some(item => item.id === 'builtin-schedule'));
  assert.deepEqual(decode(restored), restored);
});

test('deleting every template remains an empty library after decode', () => {
  const state = new State(); state.templates = []; state.defaultDailyId = ''; state.legacyImported = true;
  assert.deepEqual(decode(state), state);
  assert.equal(decode(state).templates.length, 0);
});

test('the daily default may point to a custom template and is never silently replaced', () => {
  const state = Library.fresh();
  const item = new Item(); item.id = 'custom-daily'; item.title = '个人日记'; item.content = '{{date}}';
  item.sourceNoteId = 'legacy-note-123'; item.createdAt = 10; item.updatedAt = 20;
  state.templates.push(item); state.defaultDailyId = item.id;
  const restored = decode(state);
  assert.equal(restored.defaultDailyId, item.id);
  assert.equal(restored.templates.at(-1).sourceNoteId, 'legacy-note-123');
  assert.equal(restored.templates.at(-1).builtIn, false);
});

test('empty text, broken JSON and non-object root data throw instead of reseeding', () => {
  for (const raw of ['', '{broken', 'null', '[]', '1', 'true', '"text"', '{}']) {
    assert.throws(() => Library.decode(raw), undefined, raw);
  }
});

test('missing, mistyped or unknown state fields and unsupported versions are rejected', () => {
  invalid(state => { delete state.version; });
  invalid(state => { state.version = 2; });
  invalid(state => { state.version = '1'; });
  invalid(state => { state.templates = {}; });
  invalid(state => { delete state.legacyImported; });
  invalid(state => { state.legacyImported = 'false'; });
  invalid(state => { state.defaultDailyId = null; });
  invalid(state => { state.unrecognized = 'must not be discarded'; });
});

test('duplicate template ids and dangling daily defaults are rejected', () => {
  invalid(state => { state.templates.push(Library.clone(state.templates[0])); });
  invalid(state => { state.defaultDailyId = 'missing-template'; });
  invalid(state => { state.templates = state.templates.filter(item => item.id !== state.defaultDailyId); });
});

test('template identity and every required field are validated', () => {
  const cases = [
    ['id', ''], ['id', '../escape'], ['id', 42], ['title', '  '], ['title', null],
    ['content', null], ['category', 42], ['tags', 'tag'], ['properties', null],
    ['builtIn', 'true'], ['sourceNoteId', null], ['sourceNoteId', '../note'],
    ['createdAt', -1], ['createdAt', 0.5], ['updatedAt', -1], ['updatedAt', Number.MAX_SAFE_INTEGER + 1]
  ];
  for (const [key, data] of cases) invalid((_state, item) => { item[key] = data; });
  invalid((_state, item) => { delete item.createdAt; });
  invalid((_state, item) => { item.unrecognized = 'must not be discarded'; });
  invalid(state => { state.templates[0] = null; });
  invalid(state => { state.templates[0] = []; });
});

test('tags and properties reject invalid nested data without partial recovery', () => {
  invalid((_state, item) => { item.tags = ['valid', 42]; });
  invalid((_state, item) => { item.properties = [null]; });
  invalid((_state, item) => { item.properties = [{ key: '状态', propValue: 1 }]; });
  invalid((_state, item) => { item.properties = [{ key: '', propValue: '' }]; });
  invalid((_state, item) => { item.properties = [{ key: '状态', propValue: '', extra: 'unknown' }]; });
  invalid((_state, item) => { item.properties = [new NoteProperty('状态', '一'), new NoteProperty('状态', '二')]; });
});

test('editable builtin content can be empty and is preserved rather than reset', () => {
  const state = Library.fresh(); state.templates[0].content = ''; state.templates[0].tags = [];
  const restored = decode(state);
  assert.equal(restored.templates[0].content, '');
  assert.deepEqual(restored.templates[0].tags, []);
});

let failed = 0;
for (const [name, run] of tests) {
  try { run(); console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
if (failed) process.exitCode = 1;
else console.log(tests.length + ' template-library regression checks passed. No library persistence was mutated.');
