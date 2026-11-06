// Execute the actual workspace tool insertion and frame guards without a UI runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// typescript 解析：与 manifest-compat.cjs:24-35 同一套候选约定（env 优先，再平台本机 hvigor，
// 再仓库 oh_modules，最后裸名）。旧实现把 macOS 的 /Applications/DevEco-Studio.app 路径写死成
// 兜底，在 Windows/Linux 上加载即 MODULE_NOT_FOUND —— 是平台写死，不是断言漂移。
const TS_CANDIDATES = [
  process.env.LEXI_TYPESCRIPT,
  'E:/dev-tools/harmonyos/command-line-tools/hvigor/hvigor/node_modules/typescript',
  path.resolve(__dirname, '../../oh_modules/typescript'),
  'typescript'
].filter((candidate) => Boolean(candidate));
function loadTypeScript() {
  for (const candidate of TS_CANDIDATES) {
    try { return require(candidate); } catch { /* next candidate */ }
  }
  throw new Error('找不到 typescript:请设置 LEXI_TYPESCRIPT 指向 typescript 模块');
}
const ts = loadTypeScript();
const file = path.resolve(__dirname, '../../entry/src/main/ets/components/LexiWorkspaceEditor.ets');
// 行尾归一：仓库索引里该文件是 LF(i/lf)，但 core.autocrlf=true 的 Windows 检出是 CRLF。
// 下面的 section() 切片标记写死了 '\n'（如 '  @Builder\n  private formatTool('），
// 不归一会让门禁在 Windows 检出上加载即红，而代码结构契约本身没变。
const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
function section(start, end) { const i=source.indexOf(start); assert.ok(i>=0,start); const j=source.indexOf(end,i); assert.ok(j>i,end); return source.slice(i,j); }
const methods = section('  private restoreEditorSelection(', '  @Builder\n  private formatTool(') +
 section('  private mapSavedCursor(', '  private refreshCompletion(') + section('  private updateBody(', '  private undo(');
const focusClass = section('class LexiWorkspaceSourceFrame extends FrameCallback', 'interface LexiWorkspacePopupState');
const sandbox = {FrameCallback: class {}, console}; vm.createContext(sandbox);
const compiled = ts.transpileModule(focusClass + '\nclass Workspace {' + methods + '\n}; globalThis.Workspace = Workspace;',
 {compilerOptions:{target:ts.ScriptTarget.ES2021}}).outputText;
vm.runInContext(compiled,sandbox);
function editor(editing=true) {
 const p=new sandbox.Workspace(); const frames=[];
 const nodes=new Map([['workspace-editor-n-owner',{attached:true,visible:true}],['workspace-body-input-n-owner',{attached:true,visible:true}]]);
 const events=[];
 const ui={postFrameCallback(frame){frames.push(frame);},getAttachedFrameNodeById(id){const n=nodes.get(id);return n?{isAttached:()=>n.attached,isVisible:()=>n.visible}:undefined;},getFocusController:()=>({requestFocus:id=>events.push(['focus',id])})};
 Object.assign(p,{noteId:'n',continuationOwner:'owner',loaded:true,conflictResolving:false,editorAttached:true,focusRevision:0,editing,bodyText:'前文 Selected 后文',selectionStart:3,selectionEnd:11,showToolsPopup:false,showCaptureAssistant:false,pendingCaptureOpen:false,pendingToolSnippet:'',undoHistory:[],lastUndoAt:0,historyCount:0,changedCount:0,changed(){this.changedCount++;},getUIContext:()=>ui,bodyController:{setTextSelection:(a,b)=>events.push(['selection',a,b])}});
 p.liveController={finishEditing(){p.finishedLive=true;},setTextSelection(a,b){p.liveSelection=[a,b];},insert(snippet){p.updateBody(p.bodyText.slice(0,p.liveSelection[0])+snippet+p.bodyText.slice(p.liveSelection[1]));}};
 return {p,frames,nodes,events};
}
let count=0;
function test(name, fn){fn();count++;console.log('PASS '+name);}
test('source format waits for popup disappearance and retains both surrounding spans',()=>{
 const {p,frames,events}=editor();p.openTools();p.queueToolAction('bold');
 assert.equal(p.bodyText,'前文 Selected 后文');assert.equal(p.showToolsPopup,false);
 p.insertPendingToolSnippet();assert.equal(p.bodyText,'前文 **Selected** 后文');assert.equal(p.changedCount,1);
 assert.equal(p.undoHistory[0],'前文 Selected 后文');assert.equal(events.length,0);
 frames[0].onIdle(1);assert.deepEqual(events,[['focus','workspace-body-input-n-owner'],['selection',15,15]]);
});
test('live tool delegates selected text and still uses the shared save and undo path',()=>{
 const {p}=editor(false);p.openTools();p.queueToolAction('highlight');assert.equal(p.changedCount,0);
 p.insertPendingToolSnippet();assert.equal(p.bodyText,'前文 ==Selected== 后文');assert.equal(p.changedCount,1);assert.equal(p.historyCount,1);
});
test('empty code fence leaves language detection automatic',()=>{
 const {p}=editor();p.selectionEnd=p.selectionStart;p.openTools();p.queueToolAction('code');
 assert.equal(p.pendingToolSnippet,'\n```\n\n```\n');
});
test('link chooser does not insert until a candidate is chosen',()=>{
 const {p}=editor();p.openTools();p.queueToolAction('link');
 assert.equal(p.toolPage,'links');assert.equal(p.showToolsPopup,true);assert.equal(p.pendingToolSnippet,'');
 p.queueToolSnippet('[[目标笔记]]');p.insertPendingToolSnippet();assert.equal(p.bodyText,'前文 [[目标笔记]] 后文');
});
test('source focus is skipped when the input becomes hidden before the frame',()=>{
 const {p,frames,nodes,events}=editor();p.openTools();p.queueToolAction('italic');p.insertPendingToolSnippet();
 nodes.get('workspace-body-input-n-owner').visible=false;frames[0].onIdle(1);assert.equal(events.length,0);
});
test('source focus is skipped when tab mode or attachment changes before the frame',()=>{
 for(const change of [p=>p.editing=false,p=>p.editorAttached=false,p=>p.focusRevision++]){
  const {p,frames,events}=editor();p.openTools();p.queueToolAction('strike');p.insertPendingToolSnippet();change(p);frames[0].onIdle(1);assert.equal(events.length,0);
 }
});
test('hidden retained tabs never receive delayed popup insertion',()=>{
 const {p,nodes}=editor();p.openTools();p.queueToolAction('h1');nodes.get('workspace-editor-n-owner').visible=false;
 p.insertPendingToolSnippet();assert.equal(p.bodyText,'前文 Selected 后文');assert.equal(p.pendingToolSnippet,'');
});
test('selection survives canonical metadata prefix inserted while tools are open',()=>{
 const {p}=editor();p.openTools();p.queueToolAction('bold');p.bodyText='---\ntags: [课程]\n---\n'+p.bodyText;
 p.insertPendingToolSnippet();assert.equal(p.bodyText,'---\ntags: [课程]\n---\n前文 **Selected** 后文');
});
test('failed loads and conflict resolution cannot queue mutations',()=>{
 const {p}=editor();p.loaded=false;p.queueToolAction('bold');assert.equal(p.pendingToolSnippet,'');
 p.loaded=true;p.conflictResolving=true;p.queueToolAction('bold');assert.equal(p.pendingToolSnippet,'');
});
test('assistant waits for popup dismissal and inserts only after the native sheet disappears',()=>{
 const {p}=editor();p.openTools();p.queueToolAction('assistant');
 assert.equal(p.pendingCaptureOpen,true);assert.equal(p.showToolsPopup,false);assert.equal(p.showCaptureAssistant,false);
 p.toolsPopupDidDisappear();assert.equal(p.showCaptureAssistant,true);assert.equal(p.finishedLive,true);
 p.pendingToolSnippet='识别文字';p.showCaptureAssistant=false;assert.equal(p.bodyText,'前文 Selected 后文');
 p.captureDismissed();assert.equal(p.bodyText,'前文 识别文字 后文');assert.equal(p.changedCount,1);
});
test('assistant cancellation preserves the entire body and hidden tabs do not open it',()=>{
 const {p,nodes}=editor();p.openTools();p.queueToolAction('assistant');nodes.get('workspace-editor-n-owner').visible=false;
 p.toolsPopupDidDisappear();assert.equal(p.showCaptureAssistant,false);assert.equal(p.pendingCaptureOpen,false);
 p.captureDismissed();assert.equal(p.bodyText,'前文 Selected 后文');assert.equal(p.changedCount,0);
});
test('assistant sheet uses the global viewport height and leaves a native margin',()=>{
 const {p}=editor();p.windowViewportHeight=500;assert.equal(p.captureSheetHeight(),404);
 p.windowViewportHeight=1000;assert.equal(p.captureSheetHeight(),720);
 p.windowViewportHeight=180;assert.equal(p.captureSheetHeight(),84);
});
assert.ok(source.includes('.id(`workspace-tools-${this.noteId}`)'));
assert.ok(source.includes('.id(`workspace-tools-popup-${this.noteId}`)'));
assert.ok(source.includes('.id(`workspace-body-input-${this.noteId}-${this.continuationOwner}`)'));
console.log(`${count} workspace tool regression groups passed`);
