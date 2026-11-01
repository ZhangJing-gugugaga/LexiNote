const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const ts=require('/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const source=fs.readFileSync(path.resolve(__dirname,'../../entry/src/main/ets/pages/NoteEditorPage.ets'),'utf8');
function section(start,end){const at=source.indexOf(start);return source.slice(at,source.indexOf(end,at));}
const methods=section('  private async persistNow(','  private refreshDerived(')+section('  private mapSavedCursor(','  private refreshCompletion(');
const js=ts.transpileModule('class Subject {'+methods+'};module.exports=Subject;',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
let current,writes,reads,dialogs,failSave,beforeSave,beforeRead,copies;
const clone=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
const service={
 async saveNoteIfCurrent(_context,snapshot,title,content){
  if(beforeSave)await beforeSave();
  if(failSave)throw Error('disk failure');
  if(!current||current.title!==title||current.content!==content||current.trashedAt>0)throw Error('DOCUMENT_CHANGED_ELSEWHERE');
  writes.push({snapshot:clone(snapshot),title,content});current=clone(snapshot);current.updatedAt++;return clone(current);
 },
 async saveNote(_context,snapshot){if(failSave)throw Error('disk failure');const saved=clone(snapshot);saved.id='copy-'+(++copies);saved.updatedAt=100;return saved;},
 async getNoteById(){reads++;if(beforeRead)return beforeRead();return clone(current);},
 async getNotes(){return current?[clone(current)]:[];}
};
class Prop{constructor(key,propValue){this.key=key;this.propValue=propValue;}}
const moduleScope={exports:{}};
vm.runInThisContext('(function(module,LexiStorageService,NoteProperty){'+js+'})')(moduleScope,service,Prop);
function subject(){
 current={id:'n',vaultId:'v',title:'T',content:'原文\n- [ ] 事项',notebook:'笔记',editorLevel:'pro',tags:[],properties:[],updatedAt:1,trashedAt:0,path:'/n.md'};
 writes=[];reads=0;dialogs=[];copies=0;failSave=false;beforeSave=undefined;beforeRead=undefined;
 const p=new moduleScope.exports();
 Object.assign(p,{note:clone(current),baseTitle:current.title,baseContent:current.content,titleText:current.title,contentText:current.content,
  notebookText:current.notebook,editorTier:'pro',editRevision:0,savedEditRevision:0,pendingSave:undefined,
  pageAttached:true,pageVisible:true,pageLoaded:true,abilityForeground:true,templateMode:false,conflictVisible:false,conflictResolving:false,
  externalReadRevision:0,selectionStart:4,selectionEnd:4,viewMode:'live',undoStack:[{title:'旧历史',content:'历史正文'}],redoStack:[],
  liveController:{finishEditing(){}},context:()=>({}),getUIContext:()=>({showAlertDialog:d=>dialogs.push(d)}),
  refreshDerived(){this.refreshed=(this.refreshed||0)+1;},restoreEditorSelection(a,b,body,focus){this.restored={a,b,body,focus};},
  scheduleSave(){this.scheduled=(this.scheduled||0)+1;},toast(text){this.toastText=text;}});
 return p;
}
function dirty(p,text='本机未保存草稿'){p.contentText=text;p.editRevision++;}
const tests=[];function test(name,run){tests.push([name,run]);}
test('a clean page never writes stale content after a background card changed the note',async()=>{
 const p=subject();current.content='原文\n- [x] 事项';await p.persistNow();assert.equal(writes.length,0);assert.equal(current.content,'原文\n- [x] 事项');
});
test('a dirty conflict preserves both versions and offers an explicit copy without overwriting',async()=>{
 const p=subject();dirty(p);current.content='卡片勾选后的正文';await assert.rejects(p.persistNow(),/DOCUMENT_CHANGED_ELSEWHERE/);
 assert.equal(current.content,'卡片勾选后的正文');assert.equal(p.contentText,'本机未保存草稿');assert.equal(writes.length,0);assert.equal(dialogs.length,1);
 await p.saveConflictCopy();assert.equal(current.content,'卡片勾选后的正文');assert.equal(p.note.id,'copy-1');assert.equal(p.contentText,'本机未保存草稿');assert.match(p.titleText,/冲突副本/);assert.equal(p.hasUnsavedChanges(),false);
});
test('background conflicts and unavailable native dialogs do not mask the original conditional-save error',async()=>{
 const p=subject();dirty(p);current.content='远端修改';p.abilityForeground=false;await assert.rejects(p.persistNow(),/DOCUMENT_CHANGED_ELSEWHERE/);assert.equal(dialogs.length,0);
 p.abilityForeground=true;p.getUIContext=()=>({showAlertDialog(){throw Error('no native window');}});await assert.rejects(p.persistNow(),/DOCUMENT_CHANGED_ELSEWHERE/);assert.equal(p.conflictVisible,false);
});
test('overlapping saves are serialized and the next draft uses the newly saved baseline',async()=>{
 const p=subject();dirty(p,'第一份草稿');let release;let calls=0;beforeSave=async()=>{if(++calls===1)await new Promise(r=>release=r);};
 const first=p.persistNow();while(!release)await new Promise(r=>setImmediate(r));dirty(p,'第二份草稿');const second=p.persistNow();release();await Promise.all([first,second]);
 assert.equal(writes.length,2);assert.equal(writes[1].content,'第一份草稿');assert.equal(writes[1].snapshot.content,'第二份草稿');assert.equal(current.content,'第二份草稿');assert.equal(p.hasUnsavedChanges(),false);
});
test('a later save completion cannot erase concurrent text or metadata edits',async()=>{
 const p=subject();dirty(p,'正在保存');let release;beforeSave=()=>new Promise(r=>release=r);const saving=p.persistNow();while(!release)await new Promise(r=>setImmediate(r));
 dirty(p,'保存中的新输入');p.note.tags=['新标签'];p.note.properties=[new Prop('key','new')];release();await saving;
 assert.equal(current.content,'正在保存');assert.equal(p.contentText,'保存中的新输入');assert.deepEqual(p.note.tags,['新标签']);assert.equal(p.note.properties[0].propValue,'new');assert.equal(p.hasUnsavedChanges(),true);
});
test('foreground refresh updates a clean note while preserving mode, history and mapped caret without requesting focus',async()=>{
 const p=subject();const undo=p.undoStack;current.content='原文\n- [x] 事项';current.updatedAt=2;await p.refreshExternalNote();
 assert.equal(p.contentText,current.content);assert.equal(p.baseContent,current.content);assert.equal(p.viewMode,'live');assert.equal(p.undoStack,undo);assert.equal(p.restored.focus,false);assert.equal(p.hasUnsavedChanges(),false);
});
test('a refresh response cannot overwrite typing begun while its read was pending',async()=>{
 const p=subject();let release;beforeRead=()=>new Promise(r=>release=r);const refreshing=p.refreshExternalNote();while(!release)await new Promise(r=>setImmediate(r));dirty(p,'读取期间的新输入');release({...current,content:'旧响应',updatedAt:2});await refreshing;
 assert.equal(p.contentText,'读取期间的新输入');assert.equal(p.baseContent,'原文\n- [ ] 事项');assert.equal(p.restored,undefined);
});
test('the latest foreground refresh wins when reads finish out of order',async()=>{
 const p=subject();let release;beforeRead=()=>new Promise(r=>release=r);const old=p.refreshExternalNote();while(!release)await new Promise(r=>setImmediate(r));
 beforeRead=undefined;current.content='较新的外部正文';current.updatedAt=3;await p.refreshExternalNote();release({...current,content:'较旧响应',updatedAt:2});await old;assert.equal(p.contentText,'较新的外部正文');
});
test('template, hidden, detached, loading, dirty and pending-save pages do not refresh their draft',async()=>{
 for(const field of ['templateMode','pageVisible','pageAttached','abilityForeground','pageLoaded','pendingSave','dirty']){
  const p=subject();if(field==='dirty')dirty(p);else p[field]=field==='templateMode'?true:field==='pendingSave'?Promise.resolve():false;
  await p.refreshExternalNote();assert.equal(reads,0,field);assert.equal(p.restored,undefined,field);
 }
});
test('deleted or trashed external notes are not silently recreated by a clean editor',async()=>{
 for(const missing of [true,false]){const p=subject();if(missing)current=undefined;else current.trashedAt=10;await p.refreshExternalNote();await p.persistNow();assert.equal(writes.length,0);assert.match(p.saveStatus,/移除/);}
});
test('a failed save leaves the old baseline and dirty draft available for a real retry',async()=>{
 const p=subject();dirty(p);failSave=true;await assert.rejects(p.persistNow(),/disk failure/);assert.equal(p.pendingSave,undefined);assert.equal(p.baseContent,'原文\n- [ ] 事项');assert.equal(p.hasUnsavedChanges(),true);
 failSave=false;await p.persistNow();assert.equal(current.content,'本机未保存草稿');assert.equal(p.hasUnsavedChanges(),false);
});
(async()=>{for(const[name,run]of tests){await run();console.log('PASS '+name);}console.log(`${tests.length} phone external-save regression groups passed.`);})().catch(error=>{console.error(error);process.exitCode=1;});
