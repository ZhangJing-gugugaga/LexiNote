// Test the real transfer validator and receiver after transpiling ArkTS. Only
// the platform storage boundary is replaced; no device handoff is simulated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const core = path.resolve(__dirname, '../../entry/src/main/ets/core');
const cache = new Map();
const copy = item => JSON.parse(JSON.stringify(item));
let notes, mappings, vaults, projects, activeVault, activeProject, saveAttempts, mappingAttempts;
let saveFailuresBefore, saveFailuresAfter, mapFailuresBefore, mapFailuresAfter, lastContext;
const fakeNativeStorage = {
  async getRawValue(key, fallback = '') { return mappings.has(key) ? mappings.get(key) : fallback; },
  async setRawValue(key, raw) {
    mappingAttempts++;
    if (mapFailuresBefore > 0) { mapFailuresBefore--; throw new Error('mapping write failed'); }
    mappings.set(key, raw);
    if (mapFailuresAfter > 0) { mapFailuresAfter--; throw new Error('mapping persisted but callback failed'); }
  },
  async getNoteById(id) { return notes.has(id) ? copy(notes.get(id)) : undefined; },
  async getVaults() { return copy(vaults.filter(vault => !vault.archived)); },
  async getProjects(vaultId = '', includeArchived = false) {
    return copy(projects.filter(project => (!vaultId || project.vaultId === vaultId) && (includeArchived || !project.archived)));
  },
  async getActiveVaultId() { return activeVault; },
  async getActiveProjectId() { return activeProject; },
  async saveNote(context, item) {
    saveAttempts++; lastContext = context;
    await new Promise(resolve => setImmediate(resolve));
    if (saveFailuresBefore > 0) { saveFailuresBefore--; throw new Error('note write failed'); }
    const saved = copy(item); saved.path = context.filesDir + '/notes/' + saved.id + '.md';
    saved.createdAt ||= 100; saved.updatedAt = 200; notes.set(saved.id, saved);
    if (saveFailuresAfter > 0) { saveFailuresAfter--; throw new Error('note persisted but callback failed'); }
    return copy(saved);
  }
};
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const filename = path.join(core, name + '.ets');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const scope = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename })(spec => {
    if (spec === './LexiStorageService') return { LexiStorageService: fakeNativeStorage };
    if (spec === '@kit.AbilityKit') return {};
    if (spec.startsWith('./')) return load(spec.substring(2));
    throw new Error('Unexpected platform dependency ' + spec);
  }, scope, scope.exports);
  cache.set(name, scope.exports); return scope.exports;
}
const { LexiContinuationData: Data, LexiContinuationDraft: Draft } = load('LexiContinuationData');
const { LexiContinuationReceiver: Receiver } = load('LexiContinuationReceiver');
const { NoteItem: Note, NoteProperty: Property, VaultItem: Vault, LexiProject: Project } = load('LexiModels');
const context = { filesDir: '/target-device/local-files' };
function source() {
  const note = new Note(); note.id = 'source-note'; note.vaultId = 'source-vault'; note.projectId = 'source-project';
  note.path = '/source-device/private/file.md'; note.title = '接续测试'; note.content = '包含中文与🙂的完整草稿';
  note.notebook = '个人记录'; note.noteType = 'markdown'; note.editorLevel = 'pro';
  note.tags = ['学习']; note.properties = [new Property('状态', '进行中')]; return note;
}
function draft(transferId = 'transfer-one') {
  const note = source();
  const result = Data.capture(note, note.title, note.content, 1, note.content.length, true);
  result.transferId = transferId; return result;
}
function raw(item = draft()) { return JSON.stringify(item); }
function targetNote(item, id = item.sourceNoteId) {
  const note = new Note(); note.id = id; note.vaultId = activeVault; note.projectId = activeProject;
  note.title = item.title; note.content = item.content; note.notebook = item.notebook;
  note.noteType = item.noteType; note.editorLevel = item.editorLevel;
  note.tags = item.tags.slice(); note.properties = copy(item.properties); return note;
}
function reset() {
  notes = new Map(); mappings = new Map();
  const vault = new Vault(); vault.id = 'target-vault'; vault.name = '目标工作区'; vaults = [vault];
  const project = new Project(); project.id = 'target-project'; project.vaultId = vault.id; project.name = '目标项目'; projects = [project];
  activeVault = vault.id; activeProject = project.id;
  saveAttempts = 0; mappingAttempts = 0; saveFailuresBefore = 0; saveFailuresAfter = 0;
  mapFailuresBefore = 0; mapFailuresAfter = 0; lastContext = undefined;
  Receiver.pending = Promise.resolve();
}
const tests = [];
const test = (name, run) => tests.push([name, run]);

test('UTF-8 byte counts match actual encoding for CJK, emoji, combining text and lone surrogates', () => {
  for (const text of ['', 'abc', '知萤', '🙂', '👩‍💻', 'e\u0301', '\ud800', '\udc00', 'a🙂中\r\n']) {
    assert.equal(Data.bytes(text), Buffer.byteLength(text, 'utf8'), JSON.stringify(text));
  }
});
test('a payload of exactly 90 KiB including emoji is accepted intact and one more byte is rejected', () => {
  const item = draft(); item.content = ''; item.cursorStart = 0; item.cursorEnd = 0;
  const space = Data.maximumBytes - Buffer.byteLength(raw(item));
  item.content = '🙂'.repeat(Math.floor(space / 4)) + 'a'.repeat(space % 4);
  const maximum = raw(item); assert.equal(Buffer.byteLength(maximum), 90 * 1024);
  assert.equal(Data.decode(maximum).content, item.content);
  item.content += 'a'; assert.throws(() => Data.decode(raw(item)), /限制/);
});
test('capture never truncates large drafts and transfer validation rejects oversize instead', () => {
  const note = source(); const text = '中文🙂'.repeat(12000);
  const captured = Data.capture(note, note.title, text, 0, text.length, false); captured.transferId = 'big-transfer';
  assert.equal(captured.content, text); assert.equal(captured.cursorEnd, text.length);
  assert.throws(() => Data.decode(raw(captured)), /限制/);
});
test('capture is a deep snapshot and carries no source paths, workspace ids or project ids', () => {
  const note = source(); const captured = Data.capture(note, '新标题', '尚未保存的🙂正文', 2, 7, true);
  note.tags[0] = '之后的标签'; note.properties[0].propValue = '之后的状态';
  assert.deepEqual(captured.tags, ['学习']); assert.equal(captured.properties[0].propValue, '进行中');
  assert.equal(captured.content, '尚未保存的🙂正文'); assert.equal(captured.title, '新标题');
  const payload = JSON.stringify(captured);
  for (const value of ['source-vault', 'source-project', '/source-device/private/file.md']) assert.ok(!payload.includes(value));
  for (const key of ['path', 'vaultId', 'projectId', 'folderUri', 'permissionUri']) assert.ok(!Object.hasOwn(captured, key));
});
test('outbound capture bounds native cursor offsets without changing content', () => {
  const note = source(); const item = Data.capture(note, note.title, '🙂正文', -20, 999, false);
  assert.equal(item.cursorStart, 0); assert.equal(item.cursorEnd, item.content.length); assert.equal(item.content, '🙂正文');
});
test('bad JSON, primitive roots, unsupported versions and unknown transfer fields are rejected', () => {
  for (const value of ['', '{bad', 'null', '[]', 'true', '1', '{}']) assert.throws(() => Data.decode(value));
  for (const fields of [{ version: 2 }, { version: '1' }, { path: '/other/path' }, { vaultId: 'foreign-vault' }, { projectId: 'foreign-project' }]) {
    assert.throws(() => Data.decode(raw(Object.assign(draft(), fields))));
  }
});
test('wire cursor offsets must be ordered integers within the complete UTF-16 content', () => {
  const base = draft();
  for (const fields of [{ cursorStart: -1 }, { cursorEnd: base.content.length + 1 }, { cursorStart: 2, cursorEnd: 1 },
    { cursorStart: 0.5 }, { cursorEnd: '3' }, { cursorStart: null }, { cursorEnd: Infinity }]) {
    assert.throws(() => Data.decode(raw(Object.assign(draft(), fields))));
  }
});
test('wire metadata types, ids and nested property data are checked before storage', () => {
  const cases = [{ transferId: '' }, { transferId: 'x'.repeat(101) }, { transferId: '../path' }, { sourceNoteId: '' },
    { sourceNoteId: 'x'.repeat(129) }, { title: null }, { content: 1 }, { notebook: [] }, { noteType: 'unknown' },
    { editorLevel: 'unknown' }, { tags: [1] }, { tags: Array(501).fill('tag') }, { tags: ['x'.repeat(201)] },
    { properties: [null] }, { properties: [{ key: 1, propValue: 'x' }] }, { properties: [{ key: 'a', propValue: false }] },
    { properties: [{ key: 'a', propValue: '', extra: '/untrusted' }] }, { properties: Array(501).fill({ key: 'a', propValue: '' }) },
    { sourceMode: 'true' }, { capturedAt: -1 }, { capturedAt: 0.5 }, { capturedAt: Number.MAX_SAFE_INTEGER + 1 }];
  for (const fields of cases) assert.throws(() => Data.decode(raw(Object.assign(draft(), fields))));
});
test('100-character transfer ids produce deterministic note ids within the 128-character limit', () => {
  const item = draft('t'.repeat(100)); const checked = Data.decode(raw(item));
  const note = Data.toNote(checked, activeVault, activeProject, true);
  assert.equal(note.id, 'continued-' + 't'.repeat(100)); assert.equal(note.id.length, 110);
  assert.equal(note.path, ''); assert.equal(note.vaultId, activeVault); assert.equal(note.projectId, activeProject);
  assert.ok(note.title.endsWith('（接续草稿）'));
  note.tags[0] = 'changed'; note.properties[0].propValue = 'changed';
  assert.deepEqual(item.tags, ['学习']); assert.equal(item.properties[0].propValue, '进行中');
});
test('same() requires matching transferred metadata and an available source record', () => {
  const item = draft(); const local = targetNote(item);
  assert.equal(Data.same(local, item), true);
  for (const fields of [{ sourceMissing: true }, { trashedAt: 1 }, { notebook: '其他' }, { noteType: 'quick' }, { editorLevel: 'simple' },
    { content: 'different' }, { tags: [] }, { properties: [] }]) assert.equal(Data.same(Object.assign(copy(local), fields), item), false);
});
test('a different local note with the same source id is preserved and a deterministic conflict copy is saved', async () => {
  const item = draft(); const local = targetNote(item); local.content = '本机不同正文'; notes.set(local.id, copy(local));
  const before = copy(local); const received = await Receiver.receive(context, raw(item));
  assert.equal(received.conflictCopy, true); assert.equal(received.note.id, 'continued-' + item.transferId);
  assert.equal(received.note.content, item.content); assert.deepEqual(notes.get(local.id), before);
  assert.equal(received.note.vaultId, activeVault); assert.equal(received.note.projectId, activeProject);
  assert.equal(saveAttempts, 1); assert.equal(lastContext, context);
  assert.ok(received.note.path.startsWith(context.filesDir)); assert.ok(!received.note.path.includes('/source-device/'));
});
test('an identical local note is reused without saving or copying', async () => {
  const item = draft(); const local = targetNote(item); notes.set(local.id, copy(local));
  const received = await Receiver.receive(context, raw(item));
  assert.equal(received.note.id, local.id); assert.equal(received.conflictCopy, false);
  assert.equal(saveAttempts, 0); assert.equal(mappings.get('continuation:' + item.transferId), local.id);
});
test('concurrent repeated callbacks save a transfer exactly once', async () => {
  const item = draft(); const results = await Promise.all(Array.from({ length: 8 }, () => Receiver.receive(context, raw(item))));
  assert.equal(saveAttempts, 1); assert.equal(mappingAttempts, 1); assert.equal(notes.size, 1);
  assert.ok(results.every(result => result.note.id === 'continued-' + item.transferId));
});
test('duplicate callbacks reuse the mapped note without overwriting subsequent local edits', async () => {
  const item = draft(); const first = await Receiver.receive(context, raw(item));
  notes.get(first.note.id).content = '接收后用户继续编辑';
  const second = await Receiver.receive(context, raw(item));
  assert.equal(second.note.content, '接收后用户继续编辑'); assert.equal(saveAttempts, 1); assert.equal(mappingAttempts, 1);
});
test('a save failure before persistence can be retried using the same deterministic id', async () => {
  const item = draft(); saveFailuresBefore = 1;
  await assert.rejects(Receiver.receive(context, raw(item)), /write failed/); assert.equal(notes.size, 0);
  const received = await Receiver.receive(context, raw(item));
  assert.equal(received.note.id, 'continued-' + item.transferId); assert.equal(notes.size, 1); assert.equal(saveAttempts, 2);
});
test('a save callback failure after persistence reuses the durable note and repairs its mapping', async () => {
  const item = draft(); saveFailuresAfter = 1;
  await assert.rejects(Receiver.receive(context, raw(item)), /callback failed/); assert.equal(notes.size, 1);
  const received = await Receiver.receive(context, raw(item));
  assert.equal(received.note.id, 'continued-' + item.transferId); assert.equal(saveAttempts, 1);
  assert.equal(mappings.get('continuation:' + item.transferId), received.note.id);
});
test('a mapping write failure is retried without another body write or duplicate note', async () => {
  const item = draft(); mapFailuresBefore = 1;
  await assert.rejects(Receiver.receive(context, raw(item)), /mapping write failed/);
  const received = await Receiver.receive(context, raw(item));
  assert.equal(notes.size, 1); assert.equal(saveAttempts, 1); assert.equal(mappingAttempts, 2);
  assert.equal(mappings.get('continuation:' + item.transferId), received.note.id);
});
test('a mapping callback failure after persistence does not repeat any write', async () => {
  const item = draft(); mapFailuresAfter = 1;
  await assert.rejects(Receiver.receive(context, raw(item)), /mapping persisted/);
  await Receiver.receive(context, raw(item)); assert.equal(saveAttempts, 1); assert.equal(mappingAttempts, 1);
});
test('mapping failure while reusing an identical source note retries only the mapping', async () => {
  const item = draft(); notes.set(item.sourceNoteId, copy(targetNote(item))); mapFailuresBefore = 1;
  await assert.rejects(Receiver.receive(context, raw(item)));
  const received = await Receiver.receive(context, raw(item));
  assert.equal(received.note.id, item.sourceNoteId); assert.equal(saveAttempts, 0); assert.equal(mappingAttempts, 2);
});
test('a stale mapping can recover a known deterministic note without rewriting it', async () => {
  const item = draft(); const continued = targetNote(item, 'continued-' + item.transferId);
  notes.set(continued.id, copy(continued)); mappings.set('continuation:' + item.transferId, 'lost-old-id');
  const received = await Receiver.receive(context, raw(item));
  assert.equal(received.note.id, continued.id); assert.equal(saveAttempts, 0);
  assert.equal(mappings.get('continuation:' + item.transferId), continued.id);
});
test('a removed, trashed or unavailable mapped target is never silently resurrected', async () => {
  const item = draft(); mappings.set('continuation:' + item.transferId, 'previously-received');
  await assert.rejects(Receiver.receive(context, raw(item)), /不存在/); assert.equal(saveAttempts, 0);
  const deleted = targetNote(item, 'previously-received'); deleted.trashedAt = 1; notes.set(deleted.id, deleted);
  await assert.rejects(Receiver.receive(context, raw(item)), /回收站/); assert.equal(saveAttempts, 0);
  deleted.trashedAt = 0; deleted.sourceMissing = true;
  await assert.rejects(Receiver.receive(context, raw(item)), /不可用/); assert.equal(saveAttempts, 0);
});
test('an identical source in an archived scope is copied into the valid local scope', async () => {
  const item = draft(); const local = targetNote(item); local.vaultId = 'old-vault'; local.projectId = '';
  const archived = new Vault(); archived.id = local.vaultId; archived.archived = true; vaults.push(archived); notes.set(local.id, copy(local));
  const received = await Receiver.receive(context, raw(item));
  assert.equal(received.note.vaultId, activeVault); assert.equal(received.conflictCopy, true); assert.equal(notes.get(local.id).vaultId, 'old-vault');
});
test('matching project id in a different vault cannot authorize source-note reuse', async () => {
  const item = draft(); const local = targetNote(item); local.projectId = 'foreign-project'; notes.set(local.id, copy(local));
  const foreign = new Project(); foreign.id = local.projectId; foreign.vaultId = 'foreign-vault'; projects.push(foreign);
  const received = await Receiver.receive(context, raw(item));
  assert.equal(received.conflictCopy, true); assert.equal(received.note.id, 'continued-' + item.transferId);
  assert.equal(notes.get(local.id).projectId, foreign.id);
});
test('invalid destination vault or cross-vault project fails before saving', async () => {
  const item = draft(); activeVault = 'missing-vault';
  await assert.rejects(Receiver.receive(context, raw(item)), /目标工作区/); assert.equal(saveAttempts, 0);
  activeVault = 'target-vault'; activeProject = 'foreign-project';
  const foreign = new Project(); foreign.id = activeProject; foreign.vaultId = 'foreign-vault'; projects.push(foreign);
  await assert.rejects(Receiver.receive(context, raw(item)), /目标工作区/); assert.equal(saveAttempts, 0);
});
test('a target project archived after reception is not treated as an available duplicate destination', async () => {
  const item = draft(); await Receiver.receive(context, raw(item)); projects[0].archived = true;
  await assert.rejects(Receiver.receive(context, raw(item)), /不可用/); assert.equal(saveAttempts, 1);
});
test('a local root destination needs no source project or UIAbilityContext impersonation', async () => {
  activeProject = ''; projects = [];
  const received = await Receiver.receive(context, raw());
  assert.equal(received.note.vaultId, 'target-vault'); assert.equal(received.note.projectId, ''); assert.equal(lastContext, context);
});
test('invalid payloads and corrupt mappings never reach saveNote', async () => {
  await assert.rejects(Receiver.receive(context, '{bad')); assert.equal(saveAttempts, 0); assert.equal(mappingAttempts, 0);
  const item = draft(); mappings.set('continuation:' + item.transferId, '../invalid-note');
  await assert.rejects(Receiver.receive(context, raw(item)), /格式无效/); assert.equal(saveAttempts, 0);
});

(async () => {
  let failed = 0;
  for (const [name, run] of tests) {
    reset();
    try { await run(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  if (failed) process.exitCode = 1;
  else console.log(tests.length + ' continuation regression checks passed. Native cross-device transport still requires paired-device verification.');
})().catch(error => { console.error(error); process.exitCode = 1; });
