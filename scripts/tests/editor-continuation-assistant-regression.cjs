// Exercise real editor lifecycle, native restoration and modal insertion methods without a device.
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const crypto=require('node:crypto');
const ts=require(process.env.LEXI_TYPESCRIPT||'/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const root=path.resolve(__dirname,'../../entry/src/main/ets');const cache=new Map();
function load(name){if(cache.has(name))return cache.get(name);const m={exports:{}};cache.set(name,m.exports);const js=ts.transpileModule(fs.readFileSync(path.join(root,'core',name+'.ets'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;const req=s=>s.startsWith('./')?load(s.slice(2)):s==='@kit.ArkTS'?{util:{generateRandomUUID:()=>crypto.randomUUID()}}:s==='@kit.AbilityKit'?{AbilityConstant:{ContinueState:{ACTIVE:1,INACTIVE:0}}}:{};vm.runInThisContext('(function(require,module,exports){'+js+'\n})')(req,m,m.exports);cache.set(name,m.exports);return m.exports;}
const {LexiContinuationSession:Session}=load('LexiContinuationSession');const {LexiContinuationData:Data}=load('LexiContinuationData');const {NoteItem}=load('LexiModels');
const source=fs.readFileSync(path.join(root,'pages/NoteEditorPage.ets'),'utf8');
function section(start,end){const i=source.indexOf(start);assert.ok(i>=0,start);const j=source.indexOf(end,i);assert.ok(j>i,end);return source.slice(i,j);}
const selected=section('  private sourceInputId(','  @Builder\n  private assistantSheet(')+section('  private mapSavedCursor(','  private refreshCompletion(')+section('  private insertPendingToolSnippet(','  private insertWikiLink(');
const frame=section('class LexiNoteEditorFrame extends FrameCallback','interface LexiNotePopupState');
const sandbox={FrameCallback:class{},LexiContinuationSession:Session,LexiContinuationData:Data};vm.createContext(sandbox);vm.runInContext(ts.transpileModule(frame+'\nclass Editor {'+selected+'};globalThis.Editor=Editor;',{compilerOptions:{target:ts.ScriptTarget.ES2021}}).outputText,sandbox);
function editor(id='noteA'){
 const p=new sandbox.Editor();const frames=[];const calls=[];const nodeState={attached:true,visible:true};
 const ui={postFrameCallback:f=>frames.push(f),getAttachedFrameNodeById:id=>({isAttached:()=>nodeState.attached,isVisible:()=>nodeState.visible}),getFocusController:()=>({requestFocus:id=>calls.push(['focus',id])})};
 const context={abilityInfo:{name:'EntryAbility'},setMissionContinueState:async state=>calls.push(['continuation',state])};const note=new NoteItem();note.id=id;note.title='Saved title';note.content='abc SELECT xyz';
 Object.assign(p,{note,continuationOwner:Session.newOwner(),titleText:'Draft title',contentText:note.content,notebookText:'当前分类',editorTier:'study',selectionStart:4,selectionEnd:10,viewMode:'live',pageAttached:true,pageVisible:true,pageLoaded:true,templateMode:false,focusRevision:0,pendingRouteRestore:false,pendingAssistantOpen:false,pendingAssistantSnippet:'',pendingToolSnippet:'',showToolsPanel:false,showAssistantPanel:false,context:()=>context,getUIContext:()=>ui,refreshDerived(){},pushHistory(force){calls.push(['history',force]);},scheduleSave(){calls.push(['save']);},bodyController:{setTextSelection:(a,b)=>calls.push(['source',a,b])},liveController:{finishEditing(){calls.push(['finish']);},setTextSelection(a,b){calls.push(['live',a,b]);}}});
 return{p,frames,calls,nodeState,flush(){while(frames.length)frames.shift().onIdle(1);}};
}
let count=0;function test(name,run){Session.owner='';Session.getter=undefined;run();count++;console.log('PASS '+name);}
test('visible ordinary editor exports the latest unsaved title/body/cursor and current metadata',()=>{
 const {p}=editor();p.activateContinuation();p.titleText='Unsaved';p.contentText='unsaved draft';p.selectionStart=2;p.selectionEnd=6;p.viewMode='split';
 const transfer=JSON.parse(Session.export());assert.equal(transfer.title,'Unsaved');assert.equal(transfer.content,'unsaved draft');assert.equal(transfer.cursorStart,2);assert.equal(transfer.cursorEnd,6);assert.equal(transfer.notebook,'当前分类');assert.equal(transfer.editorLevel,'study');assert.equal(transfer.sourceMode,true);
});
test('hiding an older page cannot deactivate the newer owner',()=>{
 const old=editor('oldNote').p;const latest=editor('latestNote').p;old.activateContinuation();latest.activateContinuation();old.editorHidden();assert.equal(JSON.parse(Session.export()).sourceNoteId,'latestNote');latest.editorHidden();assert.throws(()=>Session.export(),/打开/);
});
test('templates never activate continuation or open the capture assistant',()=>{
 const {p,calls}=editor();p.templateMode=true;p.activateContinuation();p.requestAssistant();assert.throws(()=>Session.export());assert.equal(p.showAssistantPanel,false);assert.equal(calls.length,0);
});
test('native route selection restores directly against saved Markdown on a visible mounted frame',()=>{
 const {p,calls,flush}=editor();p.contentText='---\ntags: [a]\n---\n正文';p.finishLoadingRoute({restoreSelectionStart:19,restoreSelectionEnd:20,restoreSourceMode:true});assert.equal(p.viewMode,'edit');assert.equal(calls.some(c=>c[0]==='source'),false);flush();assert.ok(calls.some(c=>c[0]==='source'&&c[1]===19&&c[2]===20));assert.ok(calls.some(c=>c[0]==='focus'&&c[1].includes('note-body-textarea-noteA-')));assert.equal(p.pendingRouteRestore,false);
});
test('hidden or detached restored pages never touch the native input controller',()=>{
 for(const state of ['hidden','detached']){const {p,calls,nodeState,flush}=editor();p.finishLoadingRoute({restoreSelectionStart:3,restoreSelectionEnd:3,restoreSourceMode:true});if(state==='hidden')p.pageVisible=false;else nodeState.attached=false;flush();assert.equal(calls.some(c=>c[0]==='source'),false);}
});
test('assistant opens only after popup disappearance and never starts recording by itself',()=>{
 const {p,calls,flush}=editor();p.showToolsPanel=true;p.requestAssistant();assert.equal(p.showToolsPanel,false);assert.equal(p.showAssistantPanel,false);flush();assert.equal(p.showAssistantPanel,false);p.insertPendingToolSnippet();assert.equal(p.showAssistantPanel,false);flush();assert.equal(p.showAssistantPanel,true);assert.ok(calls.every(c=>['finish'].includes(c[0])));
});
test('assistant insertion waits for sheet disappearance and maps selection past a new YAML header',()=>{
 const {p,calls,flush}=editor();p.viewMode='edit';p.requestAssistant();flush();p.contentText='---\ntags: [a]\n---\n'+p.contentText;p.queueAssistantInsertion('Inserted');assert.equal(p.contentText,'---\ntags: [a]\n---\nabc SELECT xyz');p.assistantDisappeared();assert.equal(p.contentText,'---\ntags: [a]\n---\nabc Inserted xyz');assert.equal(p.viewMode,'edit');assert.equal(calls.filter(c=>c[0]==='save').length,1);flush();assert.ok(calls.some(c=>c[0]==='source'));assert.equal(calls.filter(c=>c[0]==='history').length,1);
});
test('closing the assistant without insertion leaves the draft and save history unchanged',()=>{
 const {p,calls,flush}=editor();p.requestAssistant();flush();p.showAssistantPanel=false;p.assistantDisappeared();assert.equal(p.contentText,'abc SELECT xyz');assert.equal(calls.filter(c=>c[0]==='save').length,0);
});
test('navigation away while the sheet is closing cancels pending insertion',()=>{
 const {p,calls,flush}=editor();p.requestAssistant();flush();p.queueAssistantInsertion('Insert');p.editorHidden();p.assistantDisappeared();assert.equal(p.contentText,'abc SELECT xyz');assert.equal(calls.filter(c=>c[0]==='save').length,0);
});
test('a card launch opens the assistant after loading without forcing source focus',()=>{
 const {p,calls,flush}=editor();p.finishLoadingRoute({restoreSelectionStart:4,restoreSelectionEnd:10,restoreSourceMode:false,launchAssistant:true});assert.equal(p.showAssistantPanel,false);flush();assert.equal(p.showAssistantPanel,true);assert.equal(calls.some(c=>c[0]==='source'||c[0]==='focus'),false);p.queueAssistantInsertion('Card');p.assistantDisappeared();assert.equal(p.contentText,'abc Card xyz');
});
assert.ok(source.includes("this.popupAction('语音 / 整理'"));assert.ok(source.includes("availableNotes: this.allVaultNotes.filter((note: NoteItem): boolean => note.id !== this.note.id)"));
console.log(`${count} editor continuation and capture assistant regression groups passed`);
