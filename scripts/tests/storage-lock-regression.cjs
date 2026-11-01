// Run two independently loaded ArkTS lock classes against one simulated OS lock.
// Native file lock semantics and app persistence still need device verification.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const filename = path.resolve(__dirname, '../../entry/src/main/ets/core/LexiStorageLock.ets');
const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
let owner, openFailure, lockFailure, unlockFailure, closed = [], opened = [], unlocks = 0, attempts = 0, fd = 0;
const native = { OpenMode: { CREATE: 1, READ_WRITE: 2 }, openSync(p, flags) {
  if (openFailure) throw Object.assign(new Error('open failure'), { code: 13900012 });
  const id = ++fd; opened.push([p, flags]);
  return { fd: id, tryLock(exclusive) {
    attempts++; assert.equal(exclusive, true);
    if (lockFailure) throw Object.assign(new Error('lock failure'), { code: lockFailure });
    if (owner) throw Object.assign(new Error('busy'), { code: 13900034 });
    owner = id;
  }, unlock() {
    unlocks++; if (unlockFailure) throw new Error('unlock failure');
    assert.equal(owner, id); owner = undefined;
  }};
}, closeSync(file) { closed.push(file.fd); if (owner === file.fd) owner = undefined; } };
function processLock() {
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports,setTimeout){' + js + '})', { filename })(spec => {
    if (spec === '@kit.CoreFileKit') return { fileIo: native };
    if (['@kit.AbilityKit', '@kit.BasicServicesKit'].includes(spec)) return {};
    throw new Error(spec);
  }, mod, mod.exports, callback => setTimeout(callback, 1));
  return mod.exports.LexiStorageLock;
}
const app = { filesDir: '/same-app/files' };
const context = { filesDir: '/extension/different/path', getApplicationContext: () => app };
function reset() { owner = undefined; openFailure = false; lockFailure = 0; unlockFailure = false; closed = []; opened = []; unlocks = 0; attempts = 0; }
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
(async () => {
  reset(); const A = processLock(), B = processLock();
  let record = 0, active = 0, peak = 0; const started = deferred(), release = deferred(), order = [];
  const first = A.run(context, async () => { active++; peak = Math.max(peak, active); const old = record; order.push('first'); started.resolve(); await release.promise; record = old + 1; active--; });
  await started.promise;
  const second = B.run(context, async () => { active++; peak = Math.max(peak, active); const old = record; record = old + 1; order.push('cross-process'); active--; });
  const third = A.run(context, async () => { active++; peak = Math.max(peak, active); record++; order.push('same-process'); active--; });
  await new Promise(r => setTimeout(r, 4)); assert.equal(record, 0); release.resolve();
  await Promise.all([first, second, third]); assert.equal(record, 3); assert.equal(peak, 1); assert.equal(owner, undefined);
  assert.ok(order.indexOf('same-process') > order.indexOf('first'));
  assert.ok(opened.every(([p]) => p === '/same-app/files/lexinote-mutation.lock')); assert.equal(closed.length, 3);
  console.log('PASS independent processes and same-process callers serialize complete read-modify-write operations on the application lock');

  reset(); const C = processLock(); let executed = false; owner = -1;
  await assert.rejects(C.run(context, async () => { executed = true; }), /稍后重试/);
  assert.equal(executed, false); assert.equal(attempts, 101); assert.equal(closed.length, 1); assert.equal(unlocks, 0); assert.equal(owner, -1);
  owner = undefined; assert.equal(await C.run(context, async () => 'retry'), 'retry');
  console.log('PASS contention has a finite retry budget, never runs unlocked, closes its handle and leaves the queue reusable');

  reset(); const D = processLock(); lockFailure = 13900012;
  await assert.rejects(D.run(context, async () => assert.fail('must not run')), /lock failure/);
  assert.equal(attempts, 1); assert.equal(closed.length, 1); lockFailure = 0;
  await assert.rejects(D.run(context, async () => { throw new Error('disk full'); }), /disk full/);
  assert.equal(owner, undefined); assert.equal(closed.length, 2); assert.equal(unlocks, 1);
  assert.equal(await D.run(context, async () => 'recovered'), 'recovered');
  console.log('PASS non-contention errors fail promptly and operation failures release the kernel lock before later work');

  reset(); const E = processLock(); unlockFailure = true;
  await assert.rejects(E.run(context, async () => 'written'), /unlock failure/); assert.equal(owner, undefined); assert.equal(closed.length, 1);
  unlockFailure = false; openFailure = true;
  await assert.rejects(E.run(context, async () => assert.fail('must not run')), /open failure/); assert.equal(closed.length, 1);
  openFailure = false; await E.run(context, async () => {}); await E.flush(); assert.equal(owner, undefined);
  console.log('PASS close releases a lock after unlock failure; open failures and flush do not poison later operations');

  const lockSource = fs.readFileSync(filename, 'utf8'); assert.ok(!/unlink|rename/.test(lockSource.replace(/\/\/[^\n]*/g, '')));
  const servicePath = path.resolve(__dirname, '../../entry/src/main/ets/core/LexiStorageService.ets');
  const service = fs.readFileSync(servicePath, 'utf8'), ast = ts.createSourceFile(servicePath, service, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'LexiStorageService');
  const members = new Map(cls.members.filter(ts.isMethodDeclaration).map(m => [m.name.getText(ast), m]));
  const protectedMethods = ['setRawValue','setSetting','setActiveProjectId','reauthorizeFolder','createFolderWorkspace','createFolderProject','refreshFolders','syncScopeCatalog','setActiveVaultId','createVault','restoreNoteRevision','createInternalProject','updateScope','saveNoteIfCurrent','duplicateNote','moveNote','renameNote','mergeNotes','renameNotebook','saveNote','getTemplates','saveTemplate','saveNoteAsTemplate','deleteTemplate','getDailyTemplate','setDailyTemplate','createNoteFromTemplate','openOrCreateDailyNote','toggleNotePin','toggleNoteFavorite','setNoteTrash','deleteNotePermanently','saveMindMap','deleteMindMap','saveCanvas','deleteCanvas','rebuildIndex','restoreFromBackupPackage'];
  for (const name of protectedMethods) {
    assert.ok(members.get(name).body.getText(ast).includes('withStorageLock<'), name + ' is publicly gated');
    assert.ok(members.get(name + 'Unlocked').modifiers.some(m => m.kind === ts.SyntaxKind.PrivateKeyword), name + ' implementation is private');
  }
  assert.ok(members.get('saveCapturedNote').body.getText(ast).includes('withStorageLock<'));
  assert.ok(members.get('init').body.getText(ast).includes('LexiStorageLock.run<void>'));
  assert.ok(members.get('importFilesFromPicker').body.getText(ast).includes('LexiStorageService.saveNote(context'));
  assert.ok(members.get('exportFullBackup').body.getText(ast).includes('withStorageLock<LexiBackupPackage>'));
  console.log('PASS all 38 public mutation/template-seeding entries, capture idempotency and first initialization are gated; picker waits remain outside the lock');
  console.log('5 storage-lock regression groups passed. Native lock and independent process behavior are simulated.');
})().catch(error => { console.error(error); process.exitCode = 1; });
