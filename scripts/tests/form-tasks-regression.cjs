const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const root = path.resolve(__dirname, '../..');
const core = path.join(root, 'entry/src/main/ets/core');
const cache = new Map();
let note, activeVault, projects, saves, updates, syncs, initialized, interfere;
const storage = {
  async init() { initialized++; },
  async getActiveVaultId() { return activeVault; },
  async getNoteById() { return structuredClone(note); },
  async getProjects() { return projects; },
  async getNotes() { return note ? [structuredClone(note)] : []; },
  async saveNoteIfCurrent(_context, next, title, content) {
    if (interfere) { interfere(); }
    if (note.title !== title || note.content !== content) throw new Error('DOCUMENT_CHANGED_ELSEWHERE');
    saves.push(structuredClone(next)); note = structuredClone(next); return next;
  }
};
const service = {
  async sync(_context, notes, vaultId) { syncs.push({ notes: structuredClone(notes), vaultId }); },
  async update(_context, formId, message) { updates.push({ formId, message }); }
};
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const file = path.join(core, name + '.ets');
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
  const mod = {exports:{}};
  vm.runInThisContext('(function(require,module,exports){'+js+'})', {filename:file})(spec => {
    if (spec === '@kit.AbilityKit') return {};
    if (spec === './LexiStorageService') return {LexiStorageService:storage};
    if (spec === './LexiFormService') return {LexiFormService:service};
    if (spec.startsWith('./')) return load(spec.slice(2));
    throw new Error(spec);
  }, mod, mod.exports);
  cache.set(name, mod.exports); return mod.exports;
}
const {LexiFormTasks:Tasks} = load('LexiFormTasks');
const {LexiTemplates:Templates} = load('LexiTemplates');
const {NoteItem} = load('LexiModels');
function reset() {
  note = new NoteItem(); note.id = 'today-note'; note.vaultId = 'vault-one'; note.title = Templates.dateKey();
  note.notebook = '日常记录 / 日记'; note.content = '# 今日\r\n- [ ] 写总结\r\n';
  activeVault = note.vaultId; projects = []; saves = []; updates = []; syncs = []; initialized = 0; interfere = undefined;
  Tasks.pending = Promise.resolve();
}
function request(changes={}) {
  return JSON.stringify({lexiFormAction:'toggle-todo',vaultId:'vault-one',noteId:'today-note',lineIndex:1,
    expectedLine:'- [ ] 写总结\r',checked:true,requestId:'task-1',...changes});
}
let passed=0;
async function test(name, run) { reset(); await run(); passed++; console.log('PASS '+name); }
(async () => {
  await test('message handler saves the verified checkbox without starting a UIAbility and refreshes after persistence', async () => {
    await Tasks.handle({}, 'form-1', request());
    assert.equal(saves.length,1); assert.equal(note.content,'# 今日\r\n- [x] 写总结\r\n');
    assert.equal(syncs.length,1); assert.equal(syncs[0].notes[0].content,note.content);
    assert.equal(updates.at(-1).message,'待办已更新');
  });
  await test('invalid, oversized, and non-task messages never initialize or write storage', async () => {
    for (const raw of ['{',request({lexiFormAction:'voice'}),' '.repeat(8193),request({checked:'yes'})]) await Tasks.handle({}, 'form', raw);
    assert.equal(initialized,0); assert.equal(saves.length,0); assert.equal(updates.length,0);
  });
  await test('stale task text reports a visible failure without any optimistic checked state', async () => {
    note.content='# 今日\r\n- [ ] 更新后的事项\r\n';
    await Tasks.handle({},'form',request()); assert.equal(saves.length,0); assert.equal(syncs.length,0);
    assert.match(updates[0].message,/变化|更新/); assert.ok(note.content.includes('[ ]'));
  });
  await test('changed vault, archived project, and yesterday note cannot be modified by stale cards', async () => {
    activeVault='other-vault'; await Tasks.handle({},'form',request()); assert.equal(saves.length,0);
    activeVault='vault-one'; note.projectId='archived'; await Tasks.handle({},'form',request()); assert.equal(saves.length,0);
    note.projectId=''; note.title='2000-01-01'; await Tasks.handle({},'form',request()); assert.equal(saves.length,0);
  });
  await test('a concurrent editor save is rechecked atomically and the newer content is preserved', async () => {
    interfere=()=>{note.content += '编辑器新增内容';}; await Tasks.handle({},'form',request());
    assert.equal(saves.length,0); assert.match(note.content,/编辑器新增内容/); assert.match(updates[0].message,/更新/);
  });
  await test('rapid duplicate requests are serialized and cannot toggle the task back', async () => {
    await Promise.all([Tasks.handle({},'form',request()),Tasks.handle({},'form',request())]);
    assert.equal(saves.length,1); assert.ok(note.content.includes('[x]')); assert.equal(updates.length,2);
  });
  const card=fs.readFileSync(path.join(root,'entry/src/main/ets/lexiform/pages/LexiTodayCard.ets'),'utf8');
  assert.match(card.slice(card.indexOf('private requestTask('),card.indexOf('  build()')),/action: 'message'/);
  assert.doesNotMatch(card.slice(card.indexOf('private requestTask('),card.indexOf('  build()')),/action: 'router'/);
  console.log(`${passed} background form task regression groups passed. Native host delivery still requires device validation.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
