const fs=require('node:fs'); const vm=require('node:vm'); const assert=require('node:assert/strict');
const ts=require('/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const root=require('node:path').resolve(__dirname,'../../entry/src/main/ets')+'/';
function method(source,start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}
async function exercise(kind,concurrent,frameState='visible'){
 const workspace=kind==='workspace';const source=fs.readFileSync(root+(workspace?'components/LexiWorkspaceEditor.ets':'pages/NoteEditorPage.ets'),'utf8');
 const save=workspace?method(source,'  private async saveSnapshot(','  private async saveConflictCopy('):method(source,'  private async persistNow(','  private refreshDerived(');
 const cursor=method(source,'  private mapSavedCursor(','  private refreshCompletion(');
 const frameClass=workspace?method(source,'class LexiWorkspaceSourceFrame extends FrameCallback','interface LexiWorkspacePopupState'):
  method(source,'class LexiNoteEditorFrame extends FrameCallback','interface LexiNotePopupState');
 const restore=workspace?method(source,'  private restoreEditorSelection(','  private openTools('):
  method(source,'  private sourceInputId(', '  private finishLoadingRoute(');
 const js=ts.transpileModule(frameClass+'\nclass Subject { '+save+cursor+restore+' }; globalThis.Subject=Subject',{compilerOptions:{target:ts.ScriptTarget.ES2021}}).outputText;
 let finish;const pending=new Promise(r=>finish=r); const callbacks=[];
 const saved={id:'n',title:'T',content:'---\ntags: [new]\n---\nBody',updatedAt:Date.now(),vaultId:'v',notebook:'N',editorLevel:'pro',tags:[],properties:[]};
 const service={saveNoteIfCurrent:async(_ctx,snapshot)=>{await pending;snapshot.content=saved.content;return saved;},saveNote:async()=>{await pending;return saved;},getNotes:async()=>[saved]};
 const sandbox={FrameCallback:class {},LexiStorageService:service,console,setTimeout:fn=>callbacks.push(fn)};vm.createContext(sandbox);vm.runInContext(js,sandbox);
 const nodeIds=workspace?['workspace-editor-n-owner','workspace-body-input-n-owner']:
  ['note-writing-surface-n-owner','note-body-textarea-n-owner'];
 const ui={postFrameCallback(frame){callbacks.push(()=>frame.onIdle(1));},getAttachedFrameNodeById(id){return nodeIds.includes(id)?{isAttached:()=>frameState!=='detached',isVisible:()=>frameState!=='hidden'}:undefined;}};
 const subject=new sandbox.Subject();Object.assign(subject,{note:{id:'n',title:'T',content:'Before',notebook:'N',editorLevel:'pro',tags:[],properties:[],vaultId:'v'},noteId:'n',continuationOwner:'owner',titleText:'T',contentText:'Body',bodyText:'Body',notebookText:'N',editorTier:'pro',editRevision:3,savedEditRevision:0,baseTitle:'T',baseContent:'Before',revision:3,selectionStart:4,selectionEnd:4,editing:true,viewMode:'edit',editorAttached:true,pageAttached:true,pageVisible:true,pageLoaded:true,showAssistantPanel:frameState==='assistant',showCaptureAssistant:frameState==='assistant',focusRevision:0,loaded:true,conflictResolving:false,context(){return {};},getUIContext:()=>ui,refreshDocument(){},refreshDerived(){},onSaved(){},bodyController:{setTextSelection(a,b){subject.restored=[a,b];}}});
 const call=workspace?subject.saveSnapshot({title:'T',content:'Body'},3):subject.persistNow();
 if(concurrent){subject.bodyText='Body plus new input';subject.contentText='Body plus new input';subject.revision=4;subject.editRevision=4;}
 finish();await call;
 if(frameState==='unmounted'){subject.editorAttached=false;subject.pageAttached=false;}
 // Caret restoration must wait for the scheduled idle frame and must not touch hidden resident tabs.
 assert.equal(subject.restored,undefined);
 for(const cb of callbacks)cb();
 assert.equal(workspace?subject.bodyText:subject.contentText,concurrent?'Body plus new input':saved.content);
 if(!concurrent&&frameState==='visible')assert.equal(subject.restored[0],saved.content.length);else assert.equal(subject.restored,undefined);
 console.log('PASS '+kind+' canonical YAML sync '+(concurrent?'preserves concurrent input':frameState==='visible'?'preserves body cursor':`skips ${frameState} source focus`));
}
(async()=>{
 for(const kind of ['workspace','phone'])for(const concurrent of [false,true])await exercise(kind,concurrent);
 for(const kind of ['workspace','phone'])for(const state of ['hidden','detached','unmounted','assistant'])await exercise(kind,false,state);
})().catch(error=>{console.error(error);process.exitCode=1;});
