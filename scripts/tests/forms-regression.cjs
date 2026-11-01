// Exercise the real card data/command transformations. These tests do not claim
// that a desktop host has rendered a card or that a device provider refreshed it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const root = path.resolve(__dirname, '../..');
const core = path.join(root, 'entry/src/main/ets/core');
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const filename = path.join(core, name + '.ets');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const scope = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename })(spec => {
    if (!spec.startsWith('./')) throw new Error('Pure card tests must not invoke platform services: ' + spec);
    return load(spec.substring(2));
  }, scope, scope.exports);
  modules.set(name, scope.exports); return scope.exports;
}
const { LexiFormData: Data, LexiFormRequest: Request, LexiFormSnapshot: Snapshot } = load('LexiFormData');
const { NoteItem: Note } = load('LexiModels');
const now = new Date(2026, 9, 31, 12, 0, 0);
const today = '2026-10-31';
function note(id, content, vaultId = 'vault-one') {
  const item = new Note(); item.id = id; item.title = id; item.content = content; item.vaultId = vaultId;
  item.createdAt = now.getTime() - 86400000; item.updatedAt = now.getTime(); return item;
}
function daily(content) {
  const item = note('daily-note', content); item.title = today; item.notebook = '日常记录 / 日记'; return item;
}
function request(task, checked = true) {
  const item = new Request(); item.lexiFormAction = 'toggle-todo'; item.vaultId = 'vault-one';
  item.noteId = task.noteId; item.lineIndex = task.lineIndex; item.expectedLine = task.expectedLine;
  item.checked = checked; item.requestId = 'test-1'; return item;
}
const tests = [];
const test = (name, run) => tests.push([name, run]);

test('snapshot derives only real active notes from the selected vault', () => {
  const active = note('active', '真实内容'); const deleted = note('deleted', '删除内容'); deleted.trashedAt = 1;
  const missing = note('missing', '缓存内容'); missing.sourceMissing = true;
  const other = note('other', '另一工作区', 'vault-two');
  const snapshot = Data.build([active, deleted, missing, other], 'vault-one', now);
  assert.equal(snapshot.noteCount, 1); assert.equal(snapshot.reviewNoteId, active.id);
  assert.equal(snapshot.dateKey, today); assert.equal(snapshot.updatedAt, now.getTime());
});
test('daily tasks preserve physical line indices and omit YAML and fenced code examples', () => {
  const body = '---\ntags: [日记]\n---\n# 今日\n- [ ] 第一项\n```md\n- [ ] 示例\n```\n- [x] 已完成\n1. [ ] 第二项\n~~~text\n- [ ] 不算\n~~~';
  const snapshot = Data.build([daily(body)], 'vault-one', now);
  assert.equal(snapshot.pendingCount, 2); assert.equal(snapshot.tasks.length, 2);
  assert.deepEqual(snapshot.tasks.map(task => [task.lineIndex, task.text, task.checked]), [[4, '第一项', false], [9, '第二项', false]]);
  assert.equal(snapshot.tasks[0].expectedLine, '- [ ] 第一项');
});
test('when several project daily notes exist the latest is selected explicitly', () => {
  const old = daily('- [ ] 旧项目'); old.id = 'old-daily'; old.updatedAt = 1;
  const latest = daily('- [ ] 新项目'); latest.projectId = 'project-latest';
  const snapshot = Data.build([old, latest], 'vault-one', now);
  assert.equal(snapshot.dailyNoteId, latest.id); assert.equal(snapshot.tasks[0].text, '新项目');
});
test('a fence-like line with a language suffix cannot prematurely end a code sample', () => {
  const snapshot = Data.build([daily('```md\n- [ ] 示例\n```not-a-closing-fence\n- [ ] 仍在代码里\n```\n- [ ] 真正事项')], 'vault-one', now);
  assert.equal(snapshot.pendingCount, 1); assert.equal(snapshot.tasks[0].text, '真正事项');
});
test('only two safe-size rows are displayed but pending count includes long tasks', () => {
  const item = daily('- [ ] ' + '长'.repeat(4100) + '\n- [ ] 二\n- [ ] 三\n- [ ] 四');
  const snapshot = Data.build([item], 'vault-one', now);
  assert.equal(snapshot.pendingCount, 4); assert.equal(snapshot.tasks.length, 2);
  assert.deepEqual(snapshot.tasks.map(task => task.text), ['二', '三']);
});
test('completed rows remain truthful when no pending tasks remain', () => {
  const snapshot = Data.build([daily('- [x] 完成\n- [X] 也完成')], 'vault-one', now);
  const binding = Data.binding(snapshot, now);
  assert.equal(binding.pendingCount, 0); assert.equal(binding.task1Checked, true); assert.equal(binding.task2Checked, true);
});
test('daily random review is stable during the day and excludes new/empty notes', () => {
  const oldA = note('a', '---\nsecret: metadata\n---\n# 过去的想法\n[[目标|别名]]');
  const oldB = note('b', '第二篇'); const empty = note('empty', '   ');
  const fresh = note('fresh', '今天刚记录'); fresh.createdAt = now.getTime();
  const first = Data.build([fresh, empty, oldA, oldB], 'vault-one', now);
  const second = Data.build([oldB, fresh, oldA, empty], 'vault-one', now);
  assert.equal(first.reviewNoteId, second.reviewNoteId); assert.ok(['a', 'b'].includes(first.reviewNoteId));
  assert.ok(!first.reviewSnippet.includes('secret:'));
  const only = Data.build([oldA], 'vault-one', now); assert.ok(only.reviewSnippet.includes('别名'));
  assert.ok(!only.reviewSnippet.includes('别名目标'));
});
test('a card never labels stale yesterday tasks as today after midnight', () => {
  const snapshot = Data.build([daily('- [ ] 昨日事项')], 'vault-one', now);
  const tomorrow = new Date(2026, 10, 1, 8, 0);
  const binding = Data.binding(snapshot, tomorrow);
  assert.equal(binding.dateKey, '2026-11-01'); assert.equal(binding.dailyNoteId, '');
  assert.equal(binding.task1Text, ''); assert.equal(binding.pendingCount, 0);
  assert.match(binding.todayHint, /更新/);
});
test('an unsynchronized card advertises the need to open the app rather than invented notes', () => {
  const binding = Data.binding(new Snapshot(), now);
  assert.equal(binding.noteCount, 0); assert.equal(binding.task1Text, ''); assert.equal(binding.reviewNoteId, '');
  assert.match(binding.statusText, /同步/); assert.match(binding.todayHint, /同步/);
});
test('snapshot decode round-trips data and rejects corrupt nested tasks', () => {
  const snapshot = Data.build([daily('- [ ] 真实待办')], 'vault-one', now);
  assert.deepEqual(Data.decode(JSON.stringify(snapshot)), JSON.parse(JSON.stringify(snapshot)));
  assert.throws(() => Data.decode('{broken'));
  assert.throws(() => Data.decode('{}'));
  const bad = JSON.parse(JSON.stringify(snapshot)); bad.tasks[0].lineIndex = -1;
  assert.throws(() => Data.decode(JSON.stringify(bad)));
});
test('request decoding accepts real launch actions and rejects forged commands', () => {
  for (const action of ['quick', 'voice', 'daily', 'open-note', 'toggle-todo']) {
    const item = request({ noteId: 'daily-note', lineIndex: 0, expectedLine: '- [ ] 待办' }); item.lexiFormAction = action;
    assert.ok(Data.decodeRequest(JSON.stringify(item)), action);
  }
  const item = request({ noteId: 'daily-note', lineIndex: 0, expectedLine: '- [ ] 待办' });
  for (const bad of [{}, { ...item, lexiFormAction: 'delete-all' }, { ...item, noteId: '../file' },
    { ...item, checked: 'true' }, { ...item, lineIndex: 0.5 }, { ...item, requestId: '' }]) {
    assert.equal(Data.decodeRequest(JSON.stringify(bad)), undefined);
  }
  assert.equal(Data.decodeRequest('{bad'), undefined);
});
test('a task request modifies just the verified checkbox and preserves CRLF and metadata', () => {
  const original = daily('# 标题\r\n- [ ] 原事项  \r\n其他正文\r\n'); original.tags = ['日记'];
  const task = Data.build([original], 'vault-one', now).tasks[0];
  const updated = Data.applyTask(original, request(task));
  assert.equal(updated.content, '# 标题\r\n- [x] 原事项  \r\n其他正文\r\n');
  assert.equal(original.content, '# 标题\r\n- [ ] 原事项  \r\n其他正文\r\n');
  assert.deepEqual(updated.tags, original.tags); assert.equal(updated.id, original.id); assert.equal(updated.vaultId, original.vaultId);
});
test('unrelated text changes are retained when the expected task line is unchanged', () => {
  const original = daily('# 标题\n- [ ] 待办\n旧结尾'); const item = request(Data.build([original], 'vault-one', now).tasks[0]);
  original.content = '# 新标题\n- [ ] 待办\n外部追加';
  assert.equal(Data.applyTask(original, item).content, '# 新标题\n- [x] 待办\n外部追加');
});
test('changed/moved/trashed/missing tasks are rejected without modifying the document', () => {
  const original = daily('- [ ] 待办'); const item = request(Data.build([original], 'vault-one', now).tasks[0]);
  for (const fields of [{ content: '- [ ] 已改动' }, { vaultId: 'vault-two' }, { id: 'another-note' }, { trashedAt: 1 }, { sourceMissing: true }]) {
    const changed = Object.assign(new Note(), original, fields); const before = changed.content;
    assert.throws(() => Data.applyTask(changed, item)); assert.equal(changed.content, before);
  }
});
test('requests cannot modify a line newly moved into a code fence or YAML header', () => {
  const original = daily('普通首行\n- [ ] 同一行\n尾行');
  const item = request(Data.build([original], 'vault-one', now).tasks[0]);
  const fenced = Object.assign(new Note(), original, { content: '```md\n- [ ] 同一行\n```' });
  assert.throws(() => Data.applyTask(fenced, item));
  const frontmatter = Object.assign(new Note(), original, { content: '---\n- [ ] 同一行\n---' });
  assert.throws(() => Data.applyTask(frontmatter, item));
});
test('duplicate desired-state requests cannot accidentally toggle a task back', () => {
  const original = daily('- [ ] 待办'); const item = request(Data.build([original], 'vault-one', now).tasks[0]);
  const completed = Data.applyTask(original, item); assert.equal(completed.content, '- [x] 待办');
  assert.throws(() => Data.applyTask(completed, item));
  const checked = request(Data.build([completed], 'vault-one', now).tasks[0], true);
  assert.equal(Data.applyTask(completed, checked).content, completed.content);
});
test('form profiles point to real independent card pages with the required dimensions', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'entry/src/main/resources/base/profile/form_config.json'), 'utf8'));
  assert.deepEqual(config.forms.map(form => form.defaultDimension), ['2*2', '2*4']);
  for (const form of config.forms) {
    assert.equal(form.uiSyntax, 'arkts'); assert.equal(form.isDynamic, true);
    assert.ok(fs.existsSync(path.join(root, 'entry/src/main', form.src)));
  }
});

let failed = 0;
for (const [name, run] of tests) {
  try { run(); console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
if (failed) process.exitCode = 1;
else console.log(tests.length + ' form-data regression checks passed. Desktop-host rendering requires device verification.');
