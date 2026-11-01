// Run with the DevEco bundled Node. These tests execute the real non-UI ArkTS core
// after TypeScript transpilation, with filesystem/RDB fault injection.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const core = path.resolve(__dirname, '../../entry/src/main/ets/core');
let noteRows, contentRows, linkRows, sqlCalls, insertCalls, nativeLocks;
let files, values, handles, failRename, failWrite, denyPublicRename, failUnlink, failInsert, dbSnapshot, directories, symlinks, persistentGrants, prefs;
function fileStat(p) {
 if (!files.has(p) && !directories.has(p) && !symlinks.has(p)) throw new Error('ENOENT '+p);
 return {size:Buffer.byteLength(files.get(p)||''),mtime:Date.now()/1000,
 isDirectory:()=>directories.has(p),isFile:()=>files.has(p)&&!symlinks.has(p),isSymbolicLink:()=>symlinks.has(p)};
}
const fakeFileShare = {
 OperationMode:{READ_MODE:1,WRITE_MODE:2,CREATE_MODE:4,DELETE_MODE:8,RENAME_MODE:16},
 async persistPermission(policies){for(const p of policies)persistentGrants.add(p.uri);},
 async activatePermission(policies){for(const p of policies)if(!persistentGrants.has(p.uri))throw new Error('authorization revoked');}
};
class FakeFileUri { constructor(uri){this.path=uri.startsWith('file:')?decodeURIComponent(new URL(uri).pathname):uri;} }
global.canIUse=()=>true;
const fakeFs = {
 accessSync: p => files.has(p)||directories.has(p)||symlinks.has(p),
 mkdirSync(p){const parts=p.split('/');for(let i=1;i<=parts.length;i++)directories.add(parts.slice(0,i).join('/')||'/');},
 async mkdir(p){fakeFs.mkdirSync(p);}, stat:async p=>fileStat(p), lstat:async p=>fileStat(p),
 statSync:fileStat,lstatSync:fileStat,readText:async p=>files.get(p),
 async listFile(p){return [...new Set([...files.keys(),...directories,...symlinks.keys()].filter(x=>x.startsWith(p+'/')&&x!==p).map(x=>x.slice(p.length+1).split('/')[0]))];},
 openSync(p) { const fd = handles.size + 1; handles.set(fd, p); if(!p.endsWith('/lexinote-mutation.lock'))files.set(p, ''); return {fd,tryLock(){if(nativeLocks.has(p))throw Object.assign(new Error('busy'),{code:13900034});nativeLocks.set(p,fd);},unlock(){assert.equal(nativeLocks.get(p),fd);nativeLocks.delete(p);}}; },
 writeSync(fd, text) { const p=handles.get(fd);if(failWrite&&failWrite(p,text))throw new Error('write denied');files.set(p, text); return Buffer.byteLength(text); },
 fsyncSync() {}, closeSync(file) {if(nativeLocks.get(handles.get(file.fd))===file.fd)nativeLocks.delete(handles.get(file.fd));}, readTextSync: p => files.get(p),
 renameSync(from, to) { if(denyPublicRename&&to.startsWith('/user/')){const e=new Error('Permission denied');e.code=13900012;throw e;}if (failRename && failRename(to)) throw new Error('disk full'); files.set(to, files.get(from)); files.delete(from); },
 unlinkSync(p) { if(failUnlink && failUnlink(p))throw new Error('unlink denied');files.delete(p); }, OpenMode: {CREATE:1,WRITE_ONLY:2,TRUNC:4,READ_WRITE:8}
};
const db = {
 async querySql(sql, args=[]) {
  let data=[];
  if(sql.includes('FROM notes_meta')) {
   data=[...noteRows.values()].filter(row=>sql.includes('notes_meta.id = ?')?row.id===args[0]:sql.includes('vault_id = ?')?row.vault_id===args[0]:true)
    .map(row=>[row.metadata_json,contentRows.get(row.id)?.content||'']);
  } else { const val=values.get(args[0]);if(val!==undefined)data=[[val]]; }
  let cursor=-1;return {goToFirstRow:()=>{cursor=0;return data.length>0;},goToNextRow:()=>++cursor<data.length,getString:i=>data[cursor][i],close(){}};
 },
 async insert(table, row) {
  await new Promise(resolve=>setTimeout(resolve,1));insertCalls.push({table,row:structuredClone(row)});
  if(table===failInsert||(table==='kv_store'&&row.key===failInsert))throw new Error('RDB failure');
  if(table==='kv_store')values.set(row.key,row.value);
  else if(table==='notes_meta')noteRows.set(row.id,structuredClone(row));
  else if(table==='notes_content')contentRows.set(row.id,structuredClone(row));
  else if(table==='link_index')linkRows.push(structuredClone(row));
 },
 async executeSql(sql,args=[]) {
  sqlCalls.push({sql,args});
  if(sql==='DELETE FROM notes_meta')noteRows.clear();
  else if(sql==='DELETE FROM notes_content')contentRows.clear();
  else if(sql==='DELETE FROM link_index')linkRows=[];
  else if(sql==='DELETE FROM link_index WHERE source_id = ?')linkRows=linkRows.filter(row=>row.source_id!==args[0]);
  else if(sql==='DELETE FROM kv_store WHERE key = ?')values.delete(args[0]);
 },
 async beginTransaction() { dbSnapshot={values:new Map(values),noteRows:new Map(noteRows),contentRows:new Map(contentRows),linkRows:structuredClone(linkRows)}; },
 async commit() { dbSnapshot=undefined; },
 async rollBack() { values=new Map(dbSnapshot.values);noteRows=new Map(dbSnapshot.noteRows);contentRows=new Map(dbSnapshot.contentRows);linkRows=structuredClone(dbSnapshot.linkRows);dbSnapshot=undefined; }
};
const cache = new Map();
function load(name, memo=cache) {
 if (memo.has(name)) return memo.get(name);
 const filename = path.join(core, name + '.ets');
 const source = fs.readFileSync(filename,'utf8');
 const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
 const module = {exports:{}}; memo.set(name,module.exports);
 const req = spec => {
  if (spec.startsWith('./')) return load(spec.slice(2), memo);
  if (spec === '@kit.CoreFileKit') return {fileIo:fakeFs,picker:{},fileShare:fakeFileShare,fileUri:{FileUri:FakeFileUri}};
  if (spec === '@kit.ArkData') return {relationalStore:{ConflictResolution:{ON_CONFLICT_REPLACE:1},SecurityLevel:{S2:2},getRdbStore:async()=>db},preferences:{removePreferencesFromCacheSync(){},getPreferences:async()=>S.settings}};
  if (spec === '@kit.ArkTS') return {util:{generateRandomUUID:()=>crypto.randomUUID()}};
  if (spec === '@kit.AbilityKit') return {};
  if (spec === '@kit.BasicServicesKit') return {pasteboard:{}};
  if (spec === '@kit.FormKit') return {formBindingData:{createFormBindingData: data=>data},formProvider:{getPublishedRunningFormInfos:async()=>[]}};
  if (spec === '@kit.PerformanceAnalysisKit') return {hilog:{warn(){},info(){},error(){}}};
  throw new Error('Unexpected import: '+spec);
 };
 vm.runInThisContext('(function(require,module,exports){'+js+'\n})',{filename})(req,module,module.exports);
 memo.set(name,module.exports);return module.exports;
}
const {LexiStorageService:S} = load('LexiStorageService');
const storageInstances=new Set([S]);
function isolatedStorage(){const other=load('LexiStorageService',new Map()).LexiStorageService;other.store=db;other.appContext=context;other.settings=S.settings;other.notesIndexReady=S.notesIndexReady;storageInstances.add(other);return other;}
const {LexiBackupValidation:V} = load('LexiBackupValidation');
const {MarkdownEngine:M} = load('MarkdownEngine');
const {NoteItem,NoteProperty,VaultItem,LexiBackupPackage,MindMapDoc,MindMapNode,LexiProject} = load('LexiModels');
const {LexiFolderStore:F}=load('LexiFolderStore');
const {LexiFolderPolicy:P}=load('LexiFolderPolicy');
const {LexiSpatialEditor:Spatial}=load('LexiSpatialEditor');
const {LexiSeedData:Seed}=load('LexiSeedData');
const context = {filesDir:'/sandbox/files',getApplicationContext(){return this;}};
function reset() {
 for(const instance of storageInstances){if(instance.nativeSnapshotTimer>=0)clearTimeout(instance.nativeSnapshotTimer);instance.nativeSnapshotTimer=-1;}
 nativeLocks=new Map();db.version=0;S.initPromise=undefined;noteRows=new Map();contentRows=new Map();linkRows=[];sqlCalls=[];insertCalls=[];dbSnapshot=undefined;S.notesIndexReady=false;
 files = new Map(); values = new Map(); handles = new Map(); directories=new Set();symlinks=new Map();persistentGrants=new Set();prefs=new Map();F.activated=new Set(); failRename = undefined; failWrite=undefined;denyPublicRename=false;failUnlink = undefined; failInsert = undefined;
 S.actionTransaction=false; S.store = db; S.writeQueue = Promise.resolve(); S.mutationQueue = Promise.resolve(); S.templateQueue = Promise.resolve();
 S.appContext=context; S.settings = {get:async(k,fallback)=>prefs.has(k)?prefs.get(k):fallback,put:async(k,v)=>prefs.set(k,v),flush:async()=>{}};
}
function note(id, content='正文') { const n = new NoteItem(); n.id=id; n.title=id; n.content=content; return n; }
function backup() { const p = new LexiBackupPackage();p.vaults=[new VaultItem()];p.notes=[note('restored','恢复内容')];return p; }
async function folderWorkspace(root='/user/work', initial={}) {
 fakeFs.mkdirSync(root);persistentGrants.add('file://docs'+root);
 for(const [name,body] of Object.entries(initial)){fakeFs.mkdirSync(path.posix.dirname(root+'/'+name));files.set(root+'/'+name,body);}
 return S.createFolderWorkspace('文件工作区','file://docs'+root,false);
}
function legacySeedFixture() {
 const now=Date.now();const vaults=Seed.buildSeedVaults(now);const notes=Seed.buildSeedNotes(now);const maps=Seed.buildSeedMindMaps(now);const board=Seed.buildSeedCanvas(now);
 for(const n of notes){n.path=context.filesDir+'/vaults/default-vault/notes/'+n.id+'.md';fakeFs.mkdirSync(path.posix.dirname(n.path));files.set(n.path,n.content);}
 for(const m of maps){m.updatedAt=now;const p=context.filesDir+'/vaults/default-vault/maps/'+m.id+'.json';fakeFs.mkdirSync(path.posix.dirname(p));files.set(p,JSON.stringify(m));}
 board.updatedAt=now;const p=context.filesDir+'/vaults/default-vault/canvases/'+board.id+'.json';fakeFs.mkdirSync(path.posix.dirname(p));files.set(p,JSON.stringify(board));
 values.set('vaults',JSON.stringify(vaults));values.set('notes',JSON.stringify(notes));values.set('mindmaps',JSON.stringify(maps));values.set('canvases',JSON.stringify([board]));prefs.set('seeded_v1','true');return {vaults,notes,maps,board};
}
const {LexiRelations:Relations}=load('LexiRelations');
const {MarkdownEngine:Markdown}=load('MarkdownEngine');
const {LexiFileActions:FileActions}=load('LexiFileActions');
const {LexiContextTarget:ContextTarget}=load('LexiContextModels');
const {LexiFrontmatter:Frontmatter}=load('LexiFrontmatter');
const {LexiTemplates:Templates}=load('LexiTemplates');
const {LexiTemplateItem,LexiTemplateLibrary}=load('LexiTemplateLibrary');
const {LexiContextBridge}=load('LexiContextModels');
const tests = [
 ['YAML frontmatter reads quoted values and lists and retains unsupported nested data',async()=>{
 const raw='---\ntags:\n  - 学习\n  - "project/a"\nauthor: "Ada: Lovelace"\nreviewed: true\ncustom:\n  nested: preserved\n---\n# 正文';
 const parsed=Frontmatter.parse(raw);assert.equal(parsed.body,'# 正文');assert.equal(parsed.bodyLineOffset,9);assert.deepEqual(parsed.tags,['学习','project/a']);
 const n=note('yaml');Frontmatter.apply(n,raw);n.properties.find(p=>p.key==='author').propValue='Grace';
 const saved=Frontmatter.serialize(n);assert.ok(saved.includes('custom:\n  nested: preserved'));assert.ok(saved.includes('reviewed: true'));assert.equal(Frontmatter.parse(saved).properties.find(p=>p.key==='author').propValue,'Grace');
 assert.equal(Frontmatter.parse('---\nunclosed: value').hasFrontmatter,false);
 }],
 ['external YAML metadata edits replace properties and tags without rewriting source on scan',async()=>{
 const v=await folderWorkspace('/user/yaml',{'YAML.md':'---\ntags: [one, "two"]\nstatus: draft\n---\nBody'});
 let n=(await S.getNotes(v.id))[0];assert.deepEqual(n.tags,['one','two']);assert.equal(n.properties[0].propValue,'draft');
 const changed='---\ntags: []\nstatus: done\n---\nBody';files.set(n.path,changed);await S.refreshFolders(v.id);n=await S.getNoteById(n.id);
 assert.deepEqual(n.tags,[]);assert.equal(n.properties[0].propValue,'done');assert.equal(files.get(n.path),changed);
 n.properties[0].propValue='review';await S.saveNote(context,n);assert.equal(Frontmatter.parse(files.get(n.path)).properties[0].propValue,'review');
 }],
 ['template variables use the local calendar and preserve unknown placeholders',async()=>{
 assert.equal(Templates.render('{{date}} {{time}} {{title}} {{weekday}} {{custom}}','会议',new Date(2026,9,29,8,5)),'2026-10-29 08:05 会议 星期四 {{custom}}');
 }],
 ['daily note creation is idempotent under concurrent requests and uses the chosen template',async()=>{
 await S.ensureCleanStart(context);const t=note('daily-template','# {{date}} {{weekday}}\n{{title}} {{time}}');t.notebook='Templates';await S.saveNote(context,t);
 const template=(await S.getTemplates()).find(item=>item.sourceNoteId===t.id);
 await S.setDailyTemplate(template.id);assert.equal(await S.getDailyTemplate(),template.id);
 const [a,b]=await Promise.all([S.openOrCreateDailyNote(context,'default-vault'),S.openOrCreateDailyNote(context,'default-vault')]);assert.equal(a.id,b.id);assert.equal(a.title,Templates.dateKey());assert.ok(!a.content.includes('{{date}}'));
 const copy=await S.createNoteFromTemplate(context,template.id,'复盘');assert.ok(copy.content.includes('复盘'));assert.equal(copy.notebook,'速记收件箱');
 }],
 ['global template library seeds once without creating workspace notes or files',async()=>{
 await S.ensureCleanStart(context);const beforeFiles=new Map(files);const beforeNotes=await S.getNotes();
 const templates=await S.getTemplates();assert.equal(templates.length,6);assert.deepEqual(await S.getNotes(),beforeNotes);assert.deepEqual(files,beforeFiles);
 const other=await S.createVault(context,'其他','');await S.setActiveVaultId(other.id);
 assert.deepEqual((await S.getTemplates()).map(t=>t.id),templates.map(t=>t.id));assert.equal(await S.getDailyTemplate(),'builtin-daily');
 templates[0].content='unsaved mutation';assert.notEqual((await S.getTemplates())[0].content,'unsaved mutation');
 }],
 ['legacy templates are imported once with their source and previous daily default preserved',async()=>{
 await S.ensureCleanStart(context);const legacy=note('legacy-template','# {{title}}');legacy.notebook='Templates';await S.saveNote(context,legacy);
 await S.setSetting('dailyTemplate:default-vault',legacy.id);const source=await S.getNoteById(legacy.id);const original=files.get(source.path);
 const imported=(await S.getTemplates()).find(t=>t.sourceNoteId===legacy.id);assert.ok(imported);assert.equal(await S.getDailyTemplate(),imported.id);
 await S.deleteTemplate(imported.id);assert.equal((await S.getTemplates()).some(t=>t.sourceNoteId===legacy.id),false);
 assert.equal(files.get(source.path),original);assert.equal((await S.getNoteById(legacy.id)).content,source.content);
 }],
 ['saving a note as a template takes an independent snapshot and serializes repeated requests',async()=>{
 await S.ensureCleanStart(context);const source=await S.saveNote(context,note('source-template','内容 {{title}}'));
 const before=new Map(files);const [a,b]=await Promise.all([S.saveNoteAsTemplate(source.id),S.saveNoteAsTemplate(source.id)]);
 assert.equal(a.id,b.id);assert.equal((await S.getTemplates()).filter(t=>t.sourceNoteId===source.id).length,1);assert.deepEqual(files,before);
 a.content='模板修改';await S.saveTemplate(a);assert.equal((await S.getNoteById(source.id)).content,source.content);
 source.content='原文后续修改';await S.saveNote(context,source);assert.equal((await S.getTemplates()).find(t=>t.id===a.id).content,'模板修改');
 }],
 ['edited or deleted builtins persist and failed template writes retain the saved library',async()=>{
 await S.ensureCleanStart(context);const builtin=(await S.getTemplates()).find(t=>t.id==='builtin-code');builtin.content='# 修改后的代码模板';await S.saveTemplate(builtin);
 assert.equal(Frontmatter.parse((await S.getTemplates()).find(t=>t.id===builtin.id).content).body,builtin.content);
 const saved=values.get('templateLibrary:v1');failInsert='templateLibrary:v1';builtin.content='失败修改';await assert.rejects(S.saveTemplate(builtin));failInsert=undefined;
 assert.equal(values.get('templateLibrary:v1'),saved);await S.deleteTemplate('builtin-daily');assert.equal(await S.getDailyTemplate(),'');
 assert.equal((await S.getTemplates()).some(t=>t.id==='builtin-daily'),false);
 }],
 ['removing template YAML metadata does not resurrect stale tags in created notes',async()=>{
 await S.ensureCleanStart(context);const item=new LexiTemplateItem();item.title='YAML模板';item.content='---\ntags: [旧标签]\nstatus: draft\n---\n正文';
 let saved=await S.saveTemplate(item);assert.deepEqual(saved.tags,['旧标签']);saved.content='新正文';saved=await S.saveTemplate(saved);
 const created=await S.createNoteFromTemplate(context,saved.id,'新笔记');assert.deepEqual(created.tags,[]);assert.deepEqual(created.properties,[]);assert.equal(created.content,'新正文');
 }],
 ['template creates an ordinary note in the requested workspace and leaves the library untouched',async()=>{
 await S.ensureCleanStart(context);const other=await S.createVault(context,'其他','');const project=await S.createInternalProject(context,other.id,'学习');
 const template=(await S.getTemplates()).find(t=>t.id==='builtin-study');const before=values.get('templateLibrary:v1');
 const created=await S.createNoteFromTemplate(context,template.id,'数学',other.id,project.id);
 assert.equal(created.vaultId,other.id);assert.equal(created.projectId,project.id);assert.ok(created.content.includes('# 数学'));assert.ok(!created.content.includes('{{date}}'));
 assert.equal(values.get('templateLibrary:v1'),before);assert.equal((await S.getTemplates()).length,6);
 }],
 ['template library backup restores atomically while old backups preserve the current library',async()=>{
 await S.ensureCleanStart(context);await S.getTemplates();const pkg=backup();const library=LexiTemplateLibrary.fresh();library.legacyImported=true;
 library.templates=library.templates.filter(t=>t.id==='builtin-study');library.defaultDailyId='builtin-study';pkg.templateLibrary=JSON.stringify(library);
 await S.restoreFromBackupPackage(context,pkg);assert.equal((await S.getTemplates()).length,1);assert.equal(await S.getDailyTemplate(),'builtin-study');
 const old=backup();await S.restoreFromBackupPackage(context,old);assert.equal((await S.getTemplates()).length,1);
 const before=values.get('templateLibrary:v1');failInsert='templateLibrary:v1';pkg.templateLibrary=JSON.stringify(LexiTemplateLibrary.fresh());
 await assert.rejects(S.restoreFromBackupPackage(context,pkg));failInsert=undefined;assert.equal(values.get('templateLibrary:v1'),before);
 const corrupt=backup();corrupt.templateLibrary='{broken';await assert.rejects(S.restoreFromBackupPackage(context,corrupt));assert.equal(values.get('templateLibrary:v1'),before);
 }],
 ['note context menus expose set-as-template on phones and desktops',async()=>{
 for(const desktop of [false,true])assert.ok(LexiContextBridge.actions(ContextTarget.note(note('menu-template')),desktop).some(a=>a.id==='save-template'));
 assert.equal(LexiContextBridge.actions(ContextTarget.scope('workspace','v','v','','V'),true).some(a=>a.id==='save-template'),false);
 }],
 ['version 2 migrates legacy note bodies into per-note rows and preserves a recovery archive',async()=>{
 await S.ensureCleanStart(context);await S.saveNote(context,note('indexed','旧正文'));await S.migrateNotesIndex(context);
 assert.equal(values.has('notes'),false);assert.equal(noteRows.size,1);assert.equal(JSON.parse(noteRows.get('indexed').metadata_json).content,'');assert.equal(contentRows.get('indexed').content,'旧正文');
 assert.ok(files.has(context.filesDir+'/migrations/before-notes-index-v2.json'));assert.equal((await S.getNoteById('indexed')).content,'旧正文');
 }],
 ['failed notes-index migration keeps the legacy source and rolls back partial rows',async()=>{
 await S.ensureCleanStart(context);await S.saveNote(context,note('migration-failure','完整正文'));const old=values.get('notes');failInsert='notes_content';await assert.rejects(S.migrateNotesIndex(context));failInsert=undefined;
 assert.equal(values.get('notes'),old);assert.equal(noteRows.size,0);assert.equal(S.notesIndexReady,false);
 }],
 ['an indexed body save writes one note and updates only that source link index',async()=>{
 await S.ensureCleanStart(context);await S.saveNote(context,note('Target'));await S.saveNote(context,note('Source','[[Target]]'));await S.migrateNotesIndex(context);
 const n=await S.getNoteById('Source');n.content='Updated [[Target#Section]]';sqlCalls=[];insertCalls=[];await S.saveNote(context,n);
 assert.equal(insertCalls.filter(c=>c.table==='notes_meta').length,1);assert.equal(insertCalls.filter(c=>c.table==='notes_content').length,1);assert.equal(insertCalls.some(c=>c.table==='kv_store'&&c.row.key==='notes'),false);
 assert.ok(sqlCalls.some(c=>c.sql==='DELETE FROM link_index WHERE source_id = ?'&&c.args[0]==='Source'));assert.equal(sqlCalls.some(c=>c.sql==='DELETE FROM link_index'),false);assert.equal((await S.getNoteById('Source')).content,n.content);
 }],
 ['indexed backup restore rolls back both note tables on a later transaction failure',async()=>{
 await S.ensureCleanStart(context);await S.saveNote(context,note('old-indexed','保留正文'));await S.migrateNotesIndex(context);const oldMeta=new Map(noteRows),oldContent=new Map(contentRows);
 failInsert='canvases';await assert.rejects(S.restoreFromBackupPackage(context,backup()));failInsert=undefined;assert.deepEqual(noteRows,oldMeta);assert.deepEqual(contentRows,oldContent);assert.equal((await S.getNoteById('old-indexed')).content,'保留正文');
 }],

 ['indexed rename and merge failures restore note tables and physical source contents',async()=>{
 const v=await folderWorkspace('/user/indexed-actions',{'Old.md':'正文','Reference.md':'[[Old]]','Target.md':'目标'});await S.migrateNotesIndex(context);
 const original=(await S.getNotes(v.id)).find(n=>n.title==='Old');failUnlink=p=>p===original.path;await assert.rejects(S.renameNote(context,original.id,'New'));failUnlink=undefined;
 assert.equal((await S.getNoteById(original.id)).title,'Old');assert.equal(files.get('/user/indexed-actions/Reference.md'),'[[Old]]');
 const target=(await S.getNotes(v.id)).find(n=>n.title==='Target');failWrite=p=>p===target.path+'.lexinote-tmp';await assert.rejects(S.mergeNotes(context,original.id,target.id));failWrite=undefined;
 assert.equal((await S.getNoteById(original.id)).trashedAt,0);assert.equal((await S.getNoteById(target.id)).content,'目标');
 }],
 ['indexed folder refresh preserves external YAML edits and missing-file recoverability',async()=>{
 const v=await folderWorkspace('/user/indexed-refresh',{'One.md':'正文'});await S.migrateNotesIndex(context);const original=(await S.getNotes(v.id))[0];
 files.set(original.path,'---\ntags: [external]\n---\n外部更新');await S.refreshFolders(v.id);let n=await S.getNoteById(original.id);assert.deepEqual(n.tags,['external']);assert.ok(n.content.includes('外部更新'));
 files.delete(original.path);await S.refreshFolders(v.id);n=await S.getNoteById(original.id);assert.ok(n.trashedAt>0);assert.ok(n.content.includes('外部更新'));assert.equal(files.has(original.path),false);
 }],
 ['indexed project moves avoid nested transactions and roll back metadata on failure',async()=>{
 await S.ensureCleanStart(context);const project=await S.createInternalProject(context,'default-vault','项目');const n=note('indexed-project');n.projectId=project.id;await S.saveNote(context,n);const other=await S.createVault(context,'其他','');await S.migrateNotesIndex(context);
 failInsert='projects';await assert.rejects(S.updateScope('project',project.id,'',undefined,undefined,other.id));failInsert=undefined;
 assert.equal((await S.getNoteById(n.id)).vaultId,'default-vault');assert.equal((await S.getProjects('default-vault'))[0].id,project.id);
 await S.updateScope('project',project.id,'',undefined,undefined,other.id);assert.equal((await S.getNoteById(n.id)).vaultId,other.id);
 }],
 ['removing YAML explicitly removes header properties and templates do not propagate the template tag',async()=>{
 await S.ensureCleanStart(context);let n=note('header-removal','---\nstatus: draft\ntags: [模板]\n---\n内容');n.notebook='Templates';n=await S.saveNote(context,n);
 const template=(await S.getTemplates()).find(item=>item.sourceNoteId===n.id);
 const copy=await S.createNoteFromTemplate(context,template.id,'新笔记');assert.equal(copy.tags.includes('模板'),false);assert.ok(!Frontmatter.parse(copy.content).tags.includes('模板'));
 n.content='仅正文';n=await S.saveNote(context,n);assert.deepEqual(n.properties,[]);assert.deepEqual(n.tags,[]);assert.equal(n.content,'仅正文');
 }],
 ['quoted YAML hashes and inline comments retain their scalar values',async()=>{
 const parsed=Frontmatter.parse('---\nname: "A # value" # comment\nquote: \'A # value\'\n---\nBody');assert.equal(parsed.properties[0].propValue,'A # value');assert.equal(parsed.properties[1].propValue,'A # value');
 }],
 ['malformed legacy index cannot be silently migrated to an empty library',async()=>{
 values.set('notes','{broken json');await assert.rejects(S.migrateNotesIndex(context));assert.equal(values.get('notes'),'{broken json');assert.equal(S.notesIndexReady,false);
 }],
 ['scope move catalog sync does not resurrect moved maps when reopening the old folder',async()=>{
 const a=await folderWorkspace('/user/old-scope');const b=await folderWorkspace('/user/new-scope');const map=new MindMapDoc();map.id='moved-map';map.vaultId=a.id;const root=new MindMapNode();root.id='root';map.nodes=[root];map.rootNodeId='root';await S.saveMindMap(context,map);
 map.vaultId=b.id;await S.saveMindMap(context,map);await S.syncScopeCatalog(a.id);await S.refreshFolders(a.id);
 assert.equal((await S.getMindMaps(a.id)).length,0);assert.equal((await S.getMindMaps(b.id)).length,1);
 }],
 ['permanent deletion also removes retained version content',async()=>{
 await S.ensureCleanStart(context);const note=await S.saveNote(context,new NoteItem());note.content='旧正文';await S.saveNote(context,note);note.content='新正文';await S.saveNote(context,note);
 assert.ok((await S.getNoteHistory(note.id)).length>0);await S.deleteNotePermanently(note.id);assert.equal((await S.getNoteHistory(note.id)).length,0);assert.equal(await S.getNoteById(note.id),undefined);
 }],
 ['graphic file menus copy and rename mind maps and whiteboards independently',async()=>{
 await S.ensureCleanStart(context);const map=new MindMapDoc();map.id='map-context';map.title='导图';const root=new MindMapNode();root.id='root';root.x=80;root.noteRefId='linked-note';map.rootNodeId='root';map.nodes=[root];await S.saveMindMap(context,map);
 const target=ContextTarget.scope('mindmap',map.id,map.vaultId,'',map.title);const copyId=(await FileActions.spatialAction(context,target,'duplicate')).slice(4);assert.notEqual(copyId,map.id);
 await FileActions.spatialAction(context,target,'rename','新导图');assert.equal((await S.getMindMapById(map.id)).title,'新导图');assert.equal((await S.getMindMapById(copyId)).nodes[0].noteRefId,'linked-note');
 const board=Seed.buildSeedCanvas(Date.now());board.id='board-context';await S.saveCanvas(context,board);
 const boardTarget=ContextTarget.scope('canvas',board.id,board.vaultId,'',board.title);const boardCopy=(await FileActions.spatialAction(context,boardTarget,'duplicate')).slice(7);
 assert.notEqual(boardCopy,board.id);assert.equal((await S.getCanvasById(boardCopy)).cards.length,board.cards.length);
 await FileActions.spatialAction(context,boardTarget,'rename','新白板');assert.equal((await S.getCanvasById(board.id)).title,'新白板');
 }],
 ['removed workspace and project metadata survive later creates and folder refreshes',async()=>{
 const v=await folderWorkspace('/user/archive');const p=await S.createInternalProject(context,v.id,'旧项目');await S.createVault(context,'其他','');
 await S.updateScope('project',p.id,'',undefined,true);await S.createInternalProject(context,v.id,'新项目');await S.refreshFolders(v.id);
 assert.ok((await S.getProjects(v.id,true)).find(x=>x.id===p.id).archived);
 await S.updateScope('workspace',v.id,'',undefined,true);await S.createVault(context,'后续工作区','');
 assert.ok((await S.getVaults(true)).find(x=>x.id===v.id).archived);assert.equal((await S.getVaults()).some(x=>x.id===v.id),false);
 await S.updateScope('workspace',v.id,'',undefined,false);await S.updateScope('project',p.id,'',undefined,false);assert.ok((await S.getProjects(v.id)).some(x=>x.id===p.id));
 }],
 ['rename cleanup failure restores inbound physical links and original title',async()=>{
 const v=await folderWorkspace('/user/rename-rollback',{'Old.md':'正文','Reference.md':'[[Old]]'});const original=(await S.getNotes(v.id)).find(n=>n.title==='Old');
 failUnlink=p=>p===original.path;await assert.rejects(S.renameNote(context,original.id,'New'));failUnlink=undefined;
 assert.equal((await S.getNoteById(original.id)).title,'Old');assert.equal(files.get('/user/rename-rollback/Reference.md'),'[[Old]]');
 }],
 ['merge write failure rolls back all notes and keeps source out of trash',async()=>{
 await S.ensureCleanStart(context);await S.saveNote(context,note('Source','来源正文'));await S.saveNote(context,note('Target','目标正文'));await S.saveNote(context,note('Referer','[[Source]]'));
 failWrite=p=>p.endsWith('/Target.md.tmp');await assert.rejects(S.mergeNotes(context,'Source','Target'));failWrite=undefined;
 assert.equal((await S.getNoteById('Target')).content,'目标正文');assert.equal((await S.getNoteById('Source')).trashedAt,0);assert.equal((await S.getNoteById('Referer')).content,'[[Source]]');
 assert.equal(files.get('/sandbox/files/vaults/default-vault/notes/Referer.md'),'[[Source]]');
 }],
 ['concurrent document panes cannot overwrite an external edit with a stale draft',async()=>{
 await S.ensureCleanStart(context);const initial=await S.saveNote(context,note('shared','共同版本'));
 const external=JSON.parse(JSON.stringify(initial));external.content='另一窗口版本';await S.saveNote(context,external);
 const draft=JSON.parse(JSON.stringify(initial));draft.content='过期草稿';
 await assert.rejects(S.saveNoteIfCurrent(context,draft,initial.title,initial.content),/DOCUMENT_CHANGED_ELSEWHERE/);
 assert.equal((await S.getNoteById(initial.id)).content,'另一窗口版本');
 }],
 ['project reparent failure rolls back all document and project metadata',async()=>{
 await S.ensureCleanStart(context);const original=(await S.getVaults())[0];const project=await S.createInternalProject(context,original.id,'项目');
 const n=note('project-note');n.projectId=project.id;await S.saveNote(context,n);const other=await S.createVault(context,'目标工作区','');
 failInsert='projects';await assert.rejects(S.updateScope('project',project.id,'',undefined,undefined,other.id));failInsert=undefined;
 assert.equal((await S.getProjects(original.id))[0].id,project.id);assert.equal((await S.getNoteById(n.id)).vaultId,original.id);
 }],
 ['context workspace copy preserves project hierarchy and remaps note references',async()=>{
 await S.ensureCleanStart(context);const original=(await S.getVaults())[0];const project=await S.createInternalProject(context,original.id,'课程');
 const a=note('a','[[b]]'),b=note('b','正文');a.projectId=project.id;b.projectId=project.id;await S.saveNote(context,a);await S.saveNote(context,b);
 const map=new MindMapDoc();map.id='source-map';map.vaultId=original.id;map.projectId=project.id;const root=new MindMapNode();root.id='root';root.noteRefId=b.id;map.rootNodeId='root';map.nodes=[root];await S.saveMindMap(context,map);
 const target=ContextTarget.scope('workspace',original.id,original.id,'',original.name);await FileActions.duplicateScope(context,target);
 const copy=(await S.getVaults()).find(v=>v.id!==original.id);const projects=await S.getProjects(copy.id);assert.equal(projects.length,1);assert.equal(projects[0].name,'课程');
 const notes=await S.getNotes(copy.id);assert.equal(notes.length,2);assert.ok(notes.every(n=>n.projectId===projects[0].id));
 const copiedB=notes.find(n=>n.title==='b');assert.equal(notes.find(n=>n.title==='a').content,`[[${copiedB.id}]]`);
 assert.equal((await S.getMindMaps(copy.id))[0].nodes[0].noteRefId,copiedB.id);assert.equal((await S.getNotes(original.id)).length,2);
 }],
 ['context duplicate has an independent id and physical file',async()=>{
 await S.ensureCleanStart(context);const saved=await S.saveNote(context,note('original','保留正文'));
 const copied=await S.duplicateNote(context,saved.id);assert.notEqual(copied.id,saved.id);assert.notEqual(copied.path,saved.path);
 copied.content='副本修改';await S.saveNote(context,copied);assert.equal((await S.getNoteById(saved.id)).content,'保留正文');
 }],
 ['context rename repairs inbound titles and moves public filename without losing identity',async()=>{
 const v=await folderWorkspace('/user/rename',{'Old.md':'正文','Reference.md':'[[Old]]'});
 const original=(await S.getNotes(v.id)).find(n=>n.title==='Old');const oldPath=original.path;
 const renamed=await S.renameNote(context,original.id,'New');assert.equal(renamed.id,original.id);assert.ok(renamed.path.includes('New'));
 assert.equal(files.has(oldPath),false);assert.equal((await S.getNotes(v.id)).find(n=>n.title==='Reference').content,'[[New]]');
 }],
 ['context move keeps identity and removes source only after destination persists',async()=>{
 const a=await folderWorkspace('/user/source',{'Moving.md':'不可丢失'});const b=await folderWorkspace('/user/destination');
 const old=(await S.getNotes(a.id))[0];const moved=await S.moveNote(context,old.id,b.id,'');
 assert.equal(moved.id,old.id);assert.equal(files.get(moved.path),'不可丢失');assert.equal(files.has(old.path),false);
 assert.equal((await S.getNotes(a.id)).length,0);assert.equal((await S.getNotes(b.id)).length,1);
 }],
 ['context failed source cleanup restores original and does not leave a duplicate destination',async()=>{
 const a=await folderWorkspace('/user/source',{'Moving.md':'不可丢失'});const b=await folderWorkspace('/user/destination');const old=(await S.getNotes(a.id))[0];
 failUnlink=p=>p===old.path;await assert.rejects(S.moveNote(context,old.id,b.id,''));failUnlink=undefined;
 assert.equal((await S.getNoteById(old.id)).vaultId,a.id);assert.equal(files.get(old.path),'不可丢失');
 assert.equal((await S.getNotes(b.id)).length,0);assert.equal([...files.keys()].filter(p=>p.startsWith('/user/destination/')&&p.endsWith('.md')).length,0);
 }],
 ['context history restores body while preserving workspace and previous current content',async()=>{
 await S.ensureCleanStart(context);const old=await S.saveNote(context,note('versioned','第一版'));old.content='第二版';await S.saveNote(context,old);
 const versions=await S.getNoteHistory(old.id);assert.equal(versions[0].snapshot.content,'第一版');
 const restored=await S.restoreNoteRevision(context,old.id,versions[0].id);assert.equal(restored.content,'第一版');assert.equal(restored.vaultId,old.vaultId);
 assert.equal((await S.getNoteHistory(old.id))[0].snapshot.content,'第二版');
 }],
 ['context merge keeps source recoverable and repairs incoming title links',async()=>{
 await S.ensureCleanStart(context);await S.saveNote(context,note('Source','来源正文'));await S.saveNote(context,note('Target','目标正文'));
 await S.saveNote(context,note('Referer','[[Source]]'));
 await S.mergeNotes(context,'Source','Target');assert.ok((await S.getNoteById('Target')).content.includes('来源正文'));
 assert.ok((await S.getNoteById('Source')).trashedAt>0);assert.equal((await S.getNoteById('Referer')).content,'[[Target]]');
 await S.setNoteTrash(context,'Source',false);assert.equal((await S.getNoteById('Source')).trashedAt,0);
 }],
 ['context workspace removal is reversible and preserves source files',async()=>{
 const a=await folderWorkspace('/user/removed',{'Keep.md':'原文件'});await S.createVault(context,'另一个工作区','');
 await S.updateScope('workspace',a.id,'',undefined,true);assert.equal((await S.getVaults()).some(v=>v.id===a.id),false);
 assert.equal((await S.getVaults(true)).some(v=>v.id===a.id),true);assert.equal(files.get('/user/removed/Keep.md'),'原文件');
 await S.updateScope('workspace',a.id,'',undefined,false);assert.equal((await S.getVaults()).some(v=>v.id===a.id),true);
 }],
 ['context empty project creation adds no sample notes and rejects duplicate names',async()=>{
 await S.ensureCleanStart(context);const v=(await S.getVaults())[0];const p=await S.createInternalProject(context,v.id,'文件夹');
 assert.equal((await S.getProjects(v.id))[0].id,p.id);assert.equal((await S.getNotes(v.id)).length,0);
 await assert.rejects(S.createInternalProject(context,v.id,'文件夹'));await assert.rejects(S.updateScope('workspace',v.id,'',undefined,true));
 }],
 ['relations explain incoming, outgoing and reciprocal links in either order',async()=>{
 const a=note('a'),b=note('b'),c=note('c');a.content='[[b]]';b.content='[[a]]';c.content='[[a]]';
 const links=Markdown.buildNoteLinks([a,b,c]);const contents=Relations.contents([a,b,c],[]);
 for(const ordered of [links,[...links].reverse()]){
 const related=Relations.connected('a',contents,[],ordered);assert.equal(related.length,2);
 assert.equal(related.find(x=>x.id==='b').reason,'两篇笔记互相引用');assert.equal(related.find(x=>x.id==='c').reason,'它引用了这篇笔记');
 assert.equal(Relations.connected('c',contents,[],ordered)[0].reason,'这篇笔记引用了它');
 }
 }],
 ['relations deduplicate map references and retain them without graph display options',async()=>{
 const a=note('a');const m=new MindMapDoc();m.id='m';m.title='导图';const n1=new MindMapNode();n1.noteRefId='a';const n2=new MindMapNode();n2.noteRefId='a';m.nodes=[n1,n2];
 const contents=Relations.contents([a],[m]);assert.equal(Relations.connected('a',contents,[m],[]).length,1);
 assert.equal(Relations.connected('map:m',contents,[m],[])[0].id,'a');assert.equal(Relations.counts(contents,[m],[]).get('a'),1);
 }],
 ['relations omit trashed, unresolved, self and out-of-scope references',async()=>{
 const a=note('a'),b=note('b');b.trashedAt=1;a.content='[[a]] [[b]] [[missing]]';
 const m=new MindMapDoc();m.id='m';m.trashedAt=1;const n=new MindMapNode();n.noteRefId='a';m.nodes=[n];
 const contents=Relations.contents([a,b],[m]);const links=Markdown.buildNoteLinks([a,b]);assert.equal(contents.length,1);
 assert.deepEqual(Array.from(Relations.counts(contents,[m],links).values()),[0]);assert.equal(Relations.connected('a',contents,[m],links).length,0);
 }],
 ['confirmed save destination overrides active workspace and preserves project membership',async()=>{
 await S.ensureCleanStart(context);const v=await S.createVault(context,'选定工作区','');
 const active=new VaultItem();active.id='other-vault';active.name='另一个工作区';values.set('vaults',JSON.stringify([...(await S.getVaults()),active]));await S.setActiveVaultId(active.id);const project=new LexiProject();project.id='save-project';project.vaultId=v.id;project.name='项目';values.set('projects',JSON.stringify([project]));
 const saved=note('explicit-destination');saved.vaultId=v.id;saved.projectId=project.id;await S.saveNote(context,saved);
 assert.equal((await S.getNotes(v.id))[0].projectId,project.id);assert.equal((await S.getNotes(active.id)).length,0);
 }],
 ['fresh startup creates one empty workspace and zero sample files',async()=>{
 await S.ensureCleanStart(context);assert.equal((await S.getVaults()).length,1);assert.equal((await S.getNotes()).length,0);assert.equal((await S.getMindMaps()).length,0);assert.equal((await S.getCanvases()).length,0);assert.equal(files.size,0);
 await S.ensureCleanStart(context);assert.equal(files.size,0);assert.equal((await S.getVaults()).length,1);assert.equal(prefs.get('seeded_v1'),undefined);
 }],
 ['untouched legacy examples are archived before leaving the visible library',async()=>{
 legacySeedFixture();await S.ensureCleanStart(context);assert.equal((await S.getNotes()).length,0);assert.equal((await S.getMindMaps()).length,0);assert.equal((await S.getCanvases()).length,0);assert.equal((await S.getVaults()).length,1);
 const archived=JSON.parse(files.get(context.filesDir+'/migrations/before-clean-start-v2.json'));assert.equal(archived.notes.length,5);assert.equal(archived.mindMaps.length,2);assert.equal(archived.canvases.length,1);assert.equal(prefs.get('clean_start_v2'),'true');
 }],
 ['autosaved but semantically unchanged examples are still archived',async()=>{
 const f=legacySeedFixture();for(const n of f.notes)n.updatedAt=Date.now();for(const m of f.maps){m.updatedAt=Date.now()+10000;M.computeMindMapLayout(m);files.set(context.filesDir+'/vaults/default-vault/maps/'+m.id+'.json',JSON.stringify(m));}
 f.board.updatedAt=Date.now()+10000;files.set(context.filesDir+'/vaults/default-vault/canvases/'+f.board.id+'.json',JSON.stringify(f.board));values.set('notes',JSON.stringify(f.notes));values.set('mindmaps',JSON.stringify(f.maps));values.set('canvases',JSON.stringify([f.board]));
 await S.ensureCleanStart(context);assert.equal((await S.getNotes()).length,0);assert.equal((await S.getMindMaps()).length,0);assert.equal((await S.getCanvases()).length,0);
 }],
 ['edited examples and original user notes survive clean startup',async()=>{
 const f=legacySeedFixture();const changed=f.notes.find(n=>n.id==='note-quick-today');changed.content='用户亲自改写的正文';changed.updatedAt=Date.now();files.set(changed.path,changed.content);const own=note('user-owned','独立笔记');f.notes.push(own);values.set('notes',JSON.stringify(f.notes));
 await S.ensureCleanStart(context);assert.equal((await S.getNoteById(changed.id)).content,changed.content);assert.equal((await S.getNoteById(own.id)).content,own.content);
 }],
 ['examples referenced by retained user content remain available',async()=>{
 const f=legacySeedFixture();f.notes.push(note('user-link','继续阅读 [[时间复杂度]]'));values.set('notes',JSON.stringify(f.notes));await S.ensureCleanStart(context);assert.ok(await S.getNoteById('note-algo-complexity'));assert.ok(await S.getNoteById('user-link'));
 }],
 ['an example edited directly on disk keeps the actual latest Markdown',async()=>{
 const f=legacySeedFixture();const n=f.notes.find(n=>n.id==='note-quick-today');files.set(n.path,'文件中修改过的私人内容');await S.ensureCleanStart(context);assert.equal((await S.getNoteById(n.id)).content,'文件中修改过的私人内容');assert.equal(files.get(n.path),'文件中修改过的私人内容');
 }],
 ['legacy-looking data in a folder workspace is never classified as an internal example',async()=>{
 const f=legacySeedFixture();f.vaults[0].folderUri='file://docs/user/work';values.set('vaults',JSON.stringify(f.vaults));await S.ensureCleanStart(context);assert.equal((await S.getNotes()).length,5);assert.equal((await S.getMindMaps()).length,2);
 }],
 ['archive write failure leaves the entire prior library visible',async()=>{
 legacySeedFixture();const before=new Map(values);failRename=p=>p.includes('/migrations/');await assert.rejects(S.ensureCleanStart(context));assert.deepEqual(values,before);assert.notEqual(prefs.get('clean_start_v2'),'true');
 }],
 ['clean-start transaction rolls back if any database write fails',async()=>{
 legacySeedFixture();const before=new Map(values);failInsert='canvases';await assert.rejects(S.ensureCleanStart(context));assert.deepEqual(values,before);assert.notEqual(prefs.get('clean_start_v2'),'true');
 }],
 ['spatial hit tests use zoom, pan and the topmost card',async()=>{
 const {CanvasCard}=load('LexiModels');const a=new CanvasCard();a.id='a';a.x=120;a.y=-30;const b=new CanvasCard();b.id='b';b.x=140;b.y=-20;
 assert.equal(Spatial.hitCard([a,b],300+150*0.5,100-10*0.5,0.5,300,100).id,'b');
 assert.equal(Spatial.hitCard([a,b],10,10,0.5,300,100),undefined);
 const n=new MindMapNode();n.id='node';n.x=-100;n.y=200;assert.equal(Spatial.hitNode([n],30-100*0.4,50+200*0.4,0.4,30,50).id,n.id);
 }],
 ['dragged branches retain their offset through every layout without cumulative drift',async()=>{
 for(const layout of ['right','balanced','org']){const d=new MindMapDoc();d.layoutKind=layout;d.nodes=M.markdownToMindMapNodes('根','# 分支\n## 子节点\n# 其他');
 const initial=M.computeMindMapLayout(d).map(n=>({id:n.id,x:n.x,y:n.y}));const branch=d.nodes.find(n=>n.parentId==='root');const child=d.nodes.find(n=>n.parentId===branch.id);
 Spatial.moveBranch(d,branch.id,120,-60);M.computeMindMapLayout(d);
 for(const id of [branch.id,child.id]){const before=initial.find(n=>n.id===id);const after=d.nodes.find(n=>n.id===id);assert.equal(after.x,before.x+120);assert.equal(after.y,before.y-60);}
 const once=JSON.stringify(d.nodes);M.computeMindMapLayout(d);assert.equal(JSON.stringify(d.nodes),once);assert.equal(d.nodes[0].x,initial[0].x);
 }
 }],
 ['collapsed descendants move with their branch and appear at the saved position',async()=>{
 const d=new MindMapDoc();d.nodes=M.markdownToMindMapNodes('根','# 分支\n## 子节点');const branch=d.nodes.find(n=>n.parentId==='root');const child=d.nodes.find(n=>n.parentId===branch.id);branch.collapsed=true;
 Spatial.moveBranch(d,branch.id,-80,150);assert.equal(child.offsetX,-80);assert.equal(child.offsetY,150);branch.collapsed=false;
 const restored=JSON.parse(JSON.stringify(d));const moved=M.computeMindMapLayout(restored).find(n=>n.id===child.id);assert.ok(Number.isFinite(moved.x));assert.equal(moved.offsetY,150);
 }],
 ['legacy maps without offsets still load and malformed offsets are rejected',async()=>{
 const d=new MindMapDoc();d.id='legacy-map';d.title='旧导图';d.nodes=M.markdownToMindMapNodes('根','# 分支');for(const n of d.nodes){delete n.offsetX;delete n.offsetY;}
 V.validateMap(d);assert.ok(M.computeMindMapLayout(d).every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y)));d.nodes[0].offsetX='invalid';assert.throws(()=>V.validateMap(d));
 }],
 ['saved maps retain manually dragged positions after reopening',async()=>{
 const d=new MindMapDoc();d.nodes=M.markdownToMindMapNodes('根','# 分支');const branch=d.nodes.find(n=>n.parentId==='root');Spatial.moveBranch(d,branch.id,125,85);M.computeMindMapLayout(d);
 const saved=await S.saveMindMap(context,d);const reopened=await S.getMindMapById(saved.id);M.computeMindMapLayout(reopened);assert.equal(reopened.nodes.find(n=>n.id===branch.id).x,branch.x);assert.equal(reopened.nodes.find(n=>n.id===branch.id).offsetY,85);
 }],
 ['rapid board additions retain every card and its final dragged coordinates',async()=>{
 const {CanvasBoard,CanvasCard}=load('LexiModels');const b=new CanvasBoard();b.id='board';const saves=[];
 for(let i=0;i<4;i++){const c=new CanvasCard();c.id='card-'+i;c.x=i*110;c.y=i*80;b.cards.push(c);saves.push(S.saveCanvas(context,b));}
 await Promise.all(saves);b.cards[2].x=-156;b.cards[2].y=480;await S.saveCanvas(context,b);const reopened=await S.getCanvasById(b.id);assert.equal(reopened.cards.length,4);assert.equal(reopened.cards[2].x,-156);assert.equal(reopened.cards[2].y,480);
 }],
 ['concurrent saves retain both notes',async()=>{await Promise.all([S.saveNote(context,note('a')),S.saveNote(context,note('b'))]);assert.equal((await S.getNotes()).length,2);}],
 ['failed file replacement retains prior bytes and index',async()=>{await S.saveNote(context,note('a','旧正文'));failRename=p=>p.endsWith('/a.md');await assert.rejects(S.saveNote(context,note('a','新正文')));assert.equal(files.get('/sandbox/files/vaults/default-vault/notes/a.md'),'旧正文');assert.equal((await S.getNoteById('a')).content,'旧正文');}],
 ['save uses an immutable call-time snapshot',async()=>{const n=note('a','提交内容');const saving=S.saveNote(context,n);n.content='尚未提交';await saving;assert.equal((await S.getNoteById('a')).content,'提交内容');}],
 ['same-title links stay within their vault',async()=>{const source=note('s','[[同名]]');source.vaultId='vault-b';const a=note('a');a.title='同名';const b=note('b');b.title='同名';b.vaultId='vault-b';assert.equal(M.buildNoteLinks([source,a,b])[0].targetId,'b');}],
 ['malformed backup never writes database or paths',async()=>{const p=backup();p.notes[0].id='../escape';await assert.rejects(S.restoreFromBackupPackage(context,p));assert.equal(values.size,0);assert.equal(files.size,0);}],
 ['staging failure leaves current vault intact',async()=>{await S.saveNote(context,note('old','当前数据'));const before=values.get('notes');failRename=p=>p.includes('/restores/');await assert.rejects(S.restoreFromBackupPackage(context,backup()));assert.equal(values.get('notes'),before);assert.equal(files.get('/sandbox/files/vaults/default-vault/notes/old.md'),'当前数据');}],
 ['restore transaction rolls back on RDB failure',async()=>{await S.saveNote(context,note('old'));const before=new Map(values);failInsert='canvases';await assert.rejects(S.restoreFromBackupPackage(context,backup()));assert.deepEqual(values,before);}],
 ['restored note indexes point at successfully staged files',async()=>{await S.restoreFromBackupPackage(context,backup());const n=await S.getNoteById('restored');assert.ok(n.path.startsWith('/sandbox/files/restores/'));assert.equal(files.get(n.path),'恢复内容');}],
 ['cyclic imported trees are rejected',async()=>{const d=new MindMapDoc();d.id='map';d.title='图';d.rootNodeId='root';const r=new MindMapNode();r.id='root';const a=new MindMapNode();a.id='a';a.parentId='b';const b=new MindMapNode();b.id='b';b.parentId='a';d.nodes=[r,a,b];assert.throws(()=>V.validateMap(d));}],
 ['empty Markdown remains empty after index rebuild',async()=>{await S.saveNote(context,note('a','旧正文'));files.set('/sandbox/files/vaults/default-vault/notes/a.md','');await S.rebuildIndex(context);assert.equal((await S.getNoteById('a')).content,'');}],
 ['folder paths reject traversal and sibling-prefix escapes',async()=>{
 assert.equal(P.within('/work','/work/note.md'),true);assert.equal(P.within('/work','/workspace/note.md'),false);
 for(const p of ['../secret.md','nested/../../secret.md','/absolute.md','nested\\secret.md'])assert.equal(P.safeRelative(p),false);
 assert.equal(P.fileName('../escape').includes('/'),false);
 }],
 ['opening a folder reads existing Markdown without rewriting it',async()=>{
 const v=await folderWorkspace('/user/work',{'Existing.md':'# 已有笔记','nested/Second.md':'第二条','.git/ignored.md':'忽略'});
 const notes=await S.getNotes(v.id);assert.equal(notes.length,2);assert.equal(files.get('/user/work/Existing.md'),'# 已有笔记');
 assert.ok(files.has('/user/work/.lexinote/catalog.json'));assert.equal(await S.getActiveVaultId(),v.id);
 }],
 ['projects write into their folder and reopen with persistent authorization',async()=>{
 const v=await folderWorkspace();const p=await S.createFolderProject(v.id,'项目 A',v.folderUri,true,v.permissionUri);
 const n=note('project-note','项目里的真实正文');n.vaultId=v.id;n.projectId=p.id;
 const saved=await S.saveNote(context,n);assert.ok(saved.path.startsWith('/user/work/项目 A/'));assert.equal(files.get(saved.path),n.content);
 F.activated=new Set();await S.refreshFolders(v.id);assert.equal((await S.getNoteById(n.id)).content,n.content);
 assert.equal(await S.getActiveProjectId(v.id),p.id);assert.ok(files.has('/user/work/项目 A/.lexinote/catalog.json'));
 }],
 ['registering a nested project moves ownership without duplicating notes',async()=>{
 const v=await folderWorkspace('/user/work',{'project/Original.md':'正文'});const first=(await S.getNotes(v.id))[0];
 persistentGrants.add('file://docs/user/work/project');
 const p=await S.createFolderProject(v.id,'项目','file://docs/user/work/project',false);
 await S.refreshFolders(v.id);const notes=await S.getNotes(v.id);assert.equal(notes.length,1);assert.equal(notes[0].id,first.id);assert.equal(notes[0].projectId,p.id);
 }],
 ['one folder cannot be registered twice',async()=>{
 const v=await folderWorkspace();const before=values.get('vaults');await assert.rejects(S.createFolderWorkspace('重复',v.folderUri,false));assert.equal(values.get('vaults'),before);
 }],
 ['failed external file replacement retains prior content and index',async()=>{
 const v=await folderWorkspace();const n=note('external','原始正文');n.vaultId=v.id;const saved=await S.saveNote(context,n);
 failRename=p=>p===saved.path;saved.content='失败的新正文';await assert.rejects(S.saveNote(context,saved));assert.equal(files.get(saved.path),'原始正文');assert.equal((await S.getNoteById(n.id)).content,'原始正文');
 }],
 ['revoked folder authorization never falls back to a different save location',async()=>{
 const v=await folderWorkspace();const n=note('external','原始正文');n.vaultId=v.id;const saved=await S.saveNote(context,n);
 F.activated=new Set();persistentGrants.clear();saved.content='新正文';await assert.rejects(S.saveNote(context,saved));assert.equal(files.get(saved.path),'原始正文');assert.equal(files.has('/sandbox/files/vaults/'+v.id+'/notes/external.md'),false);
 }],
 ['externally removed files are retained in trash without recreating them',async()=>{
 const v=await folderWorkspace('/user/work',{'Gone.md':'可恢复正文'});const old=(await S.getNotes(v.id))[0];files.delete(old.path);
 await S.refreshFolders(v.id);const trashed=await S.getNoteById(old.id);assert.ok(trashed.trashedAt>0);assert.equal(trashed.content,'可恢复正文');assert.equal(files.has(old.path),false);
 await S.setNoteTrash(context,old.id,false);assert.equal(files.get(old.path),'可恢复正文');
 }],
 ['rebuilding the index respects external edits and missing source files',async()=>{
 const v=await folderWorkspace('/user/work',{'Gone.md':'可恢复正文','Edited.md':'原正文'});const notes=await S.getNotes(v.id);const gone=notes.find(n=>n.path.endsWith('/Gone.md'));const edited=notes.find(n=>n.path.endsWith('/Edited.md'));
 files.delete(gone.path);files.set(edited.path,'文件管理器修改');await S.rebuildIndex(context);
 assert.equal(files.has(gone.path),false);assert.ok((await S.getNoteById(gone.id)).sourceMissing);assert.equal((await S.getNoteById(edited.id)).content,'文件管理器修改');
 }],
 ['failed permanent file removal keeps its record available for retry',async()=>{
 const v=await folderWorkspace('/user/work',{'Keep.md':'保留正文'});const n=(await S.getNotes(v.id))[0];failUnlink=p=>p===n.path;
 await assert.rejects(S.deleteNotePermanently(n.id));assert.equal(files.get(n.path),'保留正文');assert.ok(await S.getNoteById(n.id));
 }],
 ['public providers that deny rename use a durable recovery record',async()=>{
 denyPublicRename=true;const v=await folderWorkspace();const n=note('journal','原正文');n.vaultId=v.id;const saved=await S.saveNote(context,n);assert.equal(files.get(saved.path),'原正文');
 saved.content='修改正文';await S.saveNote(context,saved);assert.equal(files.get(saved.path),'修改正文');assert.equal(files.has(saved.path+'.lexinote-recovery'),false);
 }],
 ['provider fallback restores the original file after a write failure',async()=>{
 denyPublicRename=true;const v=await folderWorkspace('/user/work',{'Keep.md':'旧正文'});const n=(await S.getNotes(v.id))[0];
 failWrite=(p,text)=>p===n.path&&text==='新正文';n.content='新正文';await assert.rejects(S.saveNote(context,n));assert.equal(files.get(n.path),'旧正文');assert.equal((await S.getNoteById(n.id)).content,'旧正文');
 }],
 ['interrupted provider writes recover before indexing a partial document',async()=>{
 const v=await folderWorkspace('/user/work',{'Keep.md':'旧正文'});const n=(await S.getNotes(v.id))[0];
 files.set(n.path+'.lexinote-recovery',JSON.stringify({format:'LexiNote.PendingWrite',target:'Keep.md',existed:true,previous:'旧正文',next:'新正文'}));files.set(n.path,'新');
 await S.refreshFolders(v.id);assert.equal(files.get(n.path),'旧正文');assert.equal((await S.getNoteById(n.id)).content,'旧正文');assert.equal(files.get(n.path+'.lexinote-interrupted-1'),'新');
 }],
 ['symbolic links never redirect document writes outside a selected folder',async()=>{
 const v=await folderWorkspace();const n=note('linked','正文');n.vaultId=v.id;n.path='/user/work/link.md';symlinks.set(n.path,'/private/secret.md');files.set('/private/secret.md','保留');
 await assert.rejects(S.saveNote(context,n));assert.equal(files.get('/private/secret.md'),'保留');
 }],
 ['backup restores keep project membership while detaching external folder grants',async()=>{
 const p=backup();const project=new LexiProject();project.id='project-a';project.vaultId=p.vaults[0].id;project.name='项目';project.folderUri='file://docs/private';project.permissionUri=project.folderUri;
 p.projects=[project];p.vaults[0].folderUri='file://docs/private';p.notes[0].projectId=project.id;
 await S.restoreFromBackupPackage(context,p);assert.equal((await S.getProjects())[0].folderUri,'');assert.equal((await S.getVaults())[0].folderUri,'');assert.equal((await S.getNoteById('restored')).projectId,project.id);
 }]


 ,['first initialization in independent app and extension processes performs one serialized migration',async()=>{
 const other=isolatedStorage();await Promise.all([S.init(context),other.init(context)]);assert.equal(db.version,2);
 assert.equal(S.notesIndexReady,true);assert.equal(other.notesIndexReady,true);assert.equal((await S.getVaults()).length,1);
 assert.equal(sqlCalls.filter(call=>call.sql==='DELETE FROM kv_store WHERE key = ?'&&call.args[0]==='notes').length,1);
 assert.equal(nativeLocks.size,0);assert.equal(prefs.get('clean_start_v2'),'true');
 }]
 ,['independent app and share processes deduplicate the same capture under one OS lock',async()=>{
 await S.ensureCleanStart(context);await S.migrateNotesIndex(context);const other=isolatedStorage();
 const incoming=note('clip-capture-100','剪藏正文');incoming.properties=[new NoteProperty('capture_id','capture-100'),new NoteProperty('capture_fingerprint','same-fingerprint')];
 const [a,b]=await Promise.all([S.saveCapturedNote(context,incoming),other.saveCapturedNote(context,incoming)]);
 assert.equal(a.note.id,b.note.id);assert.equal([a,b].filter(result=>result.alreadySaved).length,1);assert.equal((await S.getNotes()).length,1);
 assert.equal(insertCalls.filter(call=>call.table==='notes_content').length,1);assert.equal(nativeLocks.size,0);
 }]
 ,['independent share sessions deduplicate matching bodies with distinct capture ids and support an explicit extra copy',async()=>{
 await S.ensureCleanStart(context);await S.migrateNotesIndex(context);const other=isolatedStorage();
 const capture=id=>{const n=note('clip-'+id,'同一段正文');n.properties=[new NoteProperty('capture_id',id),new NoteProperty('capture_fingerprint','content-fingerprint')];return n;};
 const [a,b]=await Promise.all([S.saveCapturedNote(context,capture('capture-a')),other.saveCapturedNote(context,capture('capture-b'))]);
 assert.equal([a,b].filter(result=>result.duplicate).length,1);assert.equal(a.note.id,b.note.id);assert.equal((await S.getNotes()).length,1);
 const extra=await other.saveCapturedNote(context,capture('capture-c'),true);assert.equal(extra.duplicate,false);assert.equal((await S.getNotes()).length,2);
 }]
 ,['capture save revalidates archived scopes, project ownership, trash and conflicting ids',async()=>{
 await S.ensureCleanStart(context);const n=note('clip-valid-capture','正文');n.properties=[new NoteProperty('capture_id','valid-capture'),new NoteProperty('capture_fingerprint','fp')];
 const vault=await S.createVault(context,'第二工作区','');const project=await S.createInternalProject(context,vault.id,'项目');n.projectId=project.id;
 await assert.rejects(S.saveCapturedNote(context,n),/保存位置/);n.projectId='';
 const saved=(await S.saveCapturedNote(context,n)).note;await S.setNoteTrash(context,saved.id,true);await assert.rejects(S.saveCapturedNote(context,n),/回收站/);
 n.id='clip-invalid';await assert.rejects(S.saveCapturedNote(context,n),/标识无效/);
 const other=note('clip-other-capture','正文');other.properties=[new NoteProperty('capture_id','other-capture'),new NoteProperty('capture_fingerprint','fp2')];other.vaultId=vault.id;
 await S.updateScope('workspace',vault.id,'',undefined,true);await assert.rejects(S.saveCapturedNote(context,other),/保存位置/);
 }]
 ,['failed share writes release the process lock and remain retryable with the same capture id',async()=>{
 await S.ensureCleanStart(context);await S.migrateNotesIndex(context);const other=isolatedStorage();const n=note('clip-retry-capture','保留正文');
 n.properties=[new NoteProperty('capture_id','retry-capture'),new NoteProperty('capture_fingerprint','retry-fp')];failInsert='notes_content';
 await assert.rejects(other.saveCapturedNote(context,n));assert.equal(nativeLocks.size,0);assert.equal(await S.getNoteById(n.id),undefined);failInsert=undefined;
 const result=await S.saveCapturedNote(context,n);assert.equal(result.note.id,n.id);assert.equal((await S.getNotes()).length,1);assert.equal(nativeLocks.size,0);
 }]
 ,['queued condition saves recheck the latest body across independently loaded processes',async()=>{
 await S.ensureCleanStart(context);await S.migrateNotesIndex(context);let saved=await S.saveNote(context,note('conditional','原内容'));const other=isolatedStorage();
 const next=structuredClone(saved);next.content='主应用新内容';const stale=structuredClone(saved);stale.content='卡片旧快照修改';
 await Promise.all([S.saveNoteIfCurrent(context,next,saved.title,saved.content),assert.rejects(other.saveNoteIfCurrent(context,stale,saved.title,saved.content),/DOCUMENT_CHANGED_ELSEWHERE/)]);
 assert.equal((await S.getNoteById(saved.id)).content,'主应用新内容');assert.equal(nativeLocks.size,0);
 }]

];
(async()=>{for(const [name,run] of tests){reset();await run();console.log('PASS '+name);}console.log(`${tests.length} core regression checks passed. Mocked filesystem/RDB; no device performance claim.`);})().catch(error=>{console.error(error);process.exitCode=1;});
