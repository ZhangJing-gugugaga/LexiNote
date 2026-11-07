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
// --- P1-011(R29/S1) Track2 装载门:形状锚(行为级真跑在 plugin-dist-regression §9) ------------
// WorkspaceBridge.plugin.load 此前无轨政策查阅、无授权同意检查(ADR-R29-01 勘察的核心事实)。
// 这里钉住桥面源形状:两道已定案闸门(ADR-R28-01 轨政策 / ADR-R26-01 同意门)必须接到这条旁路。
const bridgeSrc = fs.readFileSync(path.resolve(__dirname, '../../entry/src/main/ets/workspace/WorkspaceBridge.ets'), 'utf8').replace(/\r\n/g, '\n');
const onLoadSlice = bridgeSrc.slice(bridgeSrc.indexOf('private async onPluginLoad('), bridgeSrc.indexOf('private onPluginUnload('));
assert.ok(onLoadSlice.length > 0, 'P1-011: onPluginLoad 必须存在');
assert.ok(onLoadSlice.includes('pluginLoadRefusal('), 'P1-011: onPluginLoad 必须过 Track2 装载门');
assert.ok(onLoadSlice.indexOf('pluginLoadRefusal(') < onLoadSlice.indexOf("this.mint('tk')"),
  'P1-011: 装载门必须先于令牌铸造/源码下发');
assert.ok(bridgeSrc.includes('resolvePluginTrack('), 'P1-011: 轨判定必须走 LexiPluginTrackPolicy 单一真源');
assert.ok(bridgeSrc.includes('manager.isLegacyTrackEnabled()'), 'P1-011: legacy 开关状态取自 manager(与设置页同一份)');
assert.ok(bridgeSrc.includes('manifest.sandboxService'), 'P1-011: 沙箱声明插件必须显式拒发(工作区页无 iframe,ADR-R21-02)');
assert.ok(bridgeSrc.includes('record.enabled'), 'P1-011: 未启用插件不得下发(P5-004)');
assert.ok(/manifest\.capabilitiesDeclared[\s\S]{0,200}manager\.permissionStateOf\(id\)/.test(bridgeSrc),
  'P1-011: 声明型清单必须查授权态(与 manager 同一判定面)');
assert.ok(bridgeSrc.includes("ERR_PLUGIN_TRACK_REFUSED: string = 'plugin_track_refused'"),
  'P1-011: 轨拒绝必须带机器可读错误码');
assert.ok(bridgeSrc.includes("ERR_PLUGIN_CONSENT_REQUIRED: string = 'plugin_consent_required'"),
  'P1-011: 同意拒绝必须带机器可读错误码');
assert.ok(bridgeSrc.includes('P4-005'), 'P1-011: 沙箱拒绝信息必须指明视图载体收敛去向(P4-005)');

// --- P2-013(R37-B) 设置页 Toggle 单击多次触发门:单发射路径形状 + 守卫行为级真跑 -----------
// R28 设备事实:对插件启用/legacy 轨 Toggle 的一次 uitest 单击产生 2-3 次 onChange
// (legacy 轨观测 false→true→false,偶数次净零变化,开关无法经 UI 稳定置位)。
// 根因面(源码审查结论):
//   ① Toggle 所在 Row/父容器没有 onClick —— "行点击 + 开关 onChange 双注册"不成立,排除;
//   ② 受控 Toggle 的 isOn 绑定 @State,而 handler 在 await 窗口内不更新绑定值
//      (pluginSafeMode/pluginLegacyTrack 停留旧值),finally 里 refreshPlugins 才重绑;
//      在途重渲染/禁用-重启用(.enabled(!pluginBusy))把开关往旧值拉 → 补发反向 onChange;
//   ③ toggleSafeMode/toggleLegacyTrack 完全无守卫,togglePlugin 只有值幂等没有重入守卫
//      → 每次补发都是一次真实 manager 调用,偶数次净零。
// 修复(LexiSettingsTab/LexiSettingsWindow 同一纪律):handler 入口
//   1) pluginBusy 重入吞没(在途补发事件丢弃,不触发 manager 调用、不 stomping 乐观态);
//   2) manager 现值幂等短路(落定后的同值重放不发第二次调用);
//   3) await 前乐观同步绑定值(在途窗口内 isOn 恒等于用户意图,旧值拉回机制消失)。
// 门禁钉住:每个 Toggle 恰有一条 onChange 发射路径(链上无 onClick 双注册、单点委托),
// 且守卫行为级真跑:一次单击 + 在途反向补发 = 恰好一次 manager 调用。
// (设备真机触摸复验仍待主线程批次 —— 本门禁只证明接线与守卫逻辑,不证明框架事件面。)
const TAB_ETS = fs.readFileSync(path.resolve(__dirname, '../../entry/src/main/ets/components/LexiSettingsTab.ets'), 'utf8').replace(/\r\n/g, '\n');
const WIN_ETS = fs.readFileSync(path.resolve(__dirname, '../../entry/src/main/ets/components/LexiSettingsWindow.ets'), 'utf8').replace(/\r\n/g, '\n');

function toggleChains(src) {
  const lines = src.split('\n');
  const chains = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('Toggle({') < 0) { continue; }
    let chain = lines[i];
    let j = i + 1;
    let inChangeBody = false; // .onChange( ... }) 多行体也要算进同一条发射链
    while (j < lines.length) {
      const line = lines[j];
      if (!inChangeBody && /^\s*\.[A-Za-z]+\(/.test(line)) {
        chain += '\n' + line;
        if (/\{\s*$/.test(line)) { inChangeBody = true; }
        j++;
        continue;
      }
      if (inChangeBody) {
        chain += '\n' + line;
        if (/^\s*\}\)\s*$/.test(line)) { break; }
        j++;
        continue;
      }
      break;
    }
    chains.push(chain);
  }
  return chains;
}

function handlerSlice(src, name) {
  const marker = 'private async ' + name + '(';
  const start = src.indexOf(marker);
  assert.ok(start >= 0, 'P2-013: ' + name + ' 必须存在');
  const end = src.indexOf('\n  }', start); // 方法收尾大括号恰在 2 空格缩进,内层嵌套均 ≥4 空格
  assert.ok(end > start, 'P2-013: ' + name + ' 方法切片失败');
  return src.slice(start, end);
}

for (const [label, src, minChains] of [['LexiSettingsTab', TAB_ETS, 3], ['LexiSettingsWindow', WIN_ETS, 4]]) {
  const chains = toggleChains(src);
  assert.ok(chains.length >= minChains,
    'P2-013(' + label + '): Toggle 链提取异常,期望≥' + minChains + ' 实得 ' + chains.length);
  for (const chain of chains) {
    assert.equal((chain.match(/\.onChange\(/g) || []).length, 1,
      'P2-013(' + label + '): 每个 Toggle 必须恰有一条 onChange 发射路径(不得双注册)');
    assert.ok(!chain.includes('.onClick('),
      'P2-013(' + label + '): Toggle 链上禁止 onClick 双注册(R28 多触发怀疑面之一)');
    assert.equal((chain.match(/this\.(togglePlugin|toggleSafeMode|toggleLegacyTrack|onToggleRow|onToggleArkuiEditor)\(/g) || []).length, 1,
      'P2-013(' + label + '): onChange 必须单点委托给唯一 handler');
  }
  // 三个插件开关 handler 的守卫形状:重入吞没 → 值幂等 → 乐观同步
  const pluginSlice = handlerSlice(src, 'togglePlugin');
  assert.ok(pluginSlice.includes('if (this.pluginBusy) { return; }'),
    'P2-013(' + label + '): togglePlugin 必须有重入守卫(在途反向补发事件必须被丢弃)');
  assert.ok(pluginSlice.includes('current.enabled === enabled'),
    'P2-013(' + label + '): togglePlugin 必须有值幂等守卫');
  assert.ok(pluginSlice.includes('row.enabled = enabled'),
    'P2-013(' + label + '): togglePlugin 必须乐观同步行绑定值');
  const safeSlice = handlerSlice(src, 'toggleSafeMode');
  assert.ok(safeSlice.includes('if (this.pluginBusy) { return; }'),
    'P2-013(' + label + '): toggleSafeMode 必须有重入守卫');
  assert.ok(safeSlice.includes('manager.isSafeMode() === safeMode'),
    'P2-013(' + label + '): toggleSafeMode 必须有值幂等守卫');
  assert.ok(safeSlice.indexOf('this.pluginSafeMode = safeMode;') >= 0 &&
    safeSlice.indexOf('this.pluginSafeMode = safeMode;') < safeSlice.indexOf('await manager.setSafeMode'),
    'P2-013(' + label + '): toggleSafeMode 必须在 await 前乐观同步绑定值');
  const legacySlice = handlerSlice(src, 'toggleLegacyTrack');
  assert.ok(legacySlice.includes('if (this.pluginBusy) { return; }'),
    'P2-013(' + label + '): toggleLegacyTrack 必须有重入守卫');
  assert.ok(legacySlice.includes('manager.isLegacyTrackEnabled() === enabled'),
    'P2-013(' + label + '): toggleLegacyTrack 必须有值幂等守卫');
  assert.ok(legacySlice.indexOf('this.pluginLegacyTrack = enabled;') >= 0 &&
    legacySlice.indexOf('this.pluginLegacyTrack = enabled;') < legacySlice.indexOf('await manager.setLegacyTrackEnabled'),
    'P2-013(' + label + '): toggleLegacyTrack 必须在 await 前乐观同步绑定值');
}

// 行为级真跑:从 LexiSettingsTab 切出三个 handler,注入假 manager,重放 R28 设备事件序
// (一次合成单击 + 在途到达的反向补发)。LexiSettingsWindow 与 Tab 是同一份守卫文本,
// 上面已按形状逐条钉住,这里不必重复跑两遍。
const toggleHarnessSrc = `
class ToggleHarness {
  pluginBusy = false;
  pluginSafeMode = false;
  pluginLegacyTrack = true;
  pluginRows = [];
  refreshCount = 0;
  refreshPlugins() { this.refreshCount++; }
  ${handlerSlice(TAB_ETS, 'togglePlugin')}
  }
  ${handlerSlice(TAB_ETS, 'toggleSafeMode')}
  }
  ${handlerSlice(TAB_ETS, 'toggleLegacyTrack')}
  }
}
globalThis.ToggleHarness = ToggleHarness;`;
const toggleSandbox = { console, LexiPluginManager: { shared: null } };
vm.createContext(toggleSandbox);
vm.runInContext(ts.transpileModule(toggleHarnessSrc, { compilerOptions: { target: ts.ScriptTarget.ES2021 } }).outputText, toggleSandbox);

function fakePluginManager() {
  const state = { safeMode: false, legacyTrack: false, calls: [], permission: 'granted' };
  const plugin = { manifest: { id: 'p1', name: 'P1', version: '1.0', capabilitiesDeclared: false }, enabled: false, errorState: '' };
  return {
    state, plugin,
    installedPlugins() { return [plugin]; },
    permissionStateOf(_id) { return state.permission; },
    permissionTagsOf(_id) { return []; },
    hasPluginSettings(_id) { return false; },
    isSafeMode() { return state.safeMode; },
    async setSafeMode(v) { state.safeMode = v; state.calls.push(['setSafeMode', v]); },
    isLegacyTrackEnabled() { return state.legacyTrack; },
    async setLegacyTrackEnabled(v) { state.legacyTrack = v; state.calls.push(['setLegacyTrack', v]); },
    async enablePlugin(id) { plugin.enabled = true; state.calls.push(['enablePlugin', id]); return true; },
    async disablePlugin(id) { plugin.enabled = false; state.calls.push(['disablePlugin', id]); },
    async consentEnablePlugin(id) { plugin.enabled = true; state.calls.push(['consentEnablePlugin', id]); }
  };
}
function newToggleHarness(manager) {
  toggleSandbox.LexiPluginManager.shared = manager;
  return new toggleSandbox.ToggleHarness();
}

const toggleBehaviorTests = [];
function toggleBehaviorTest(name, fn) { toggleBehaviorTests.push([name, fn]); count++; }

toggleBehaviorTest('P2-013 行为真跑(legacy 轨):一次单击 + 在途反向补发(R28 设备序)= 恰好一次 manager 调用', async () => {
  const manager = fakePluginManager(); // legacyTrack=false 起步,同 R28 观测初值
  const h = newToggleHarness(manager);
  const first = h.toggleLegacyTrack(true);
  const replay = h.toggleLegacyTrack(false); // 在途到达的合成反向补发(真实现象:偶数次净零)
  await first;
  await replay;
  assert.deepEqual(manager.state.calls, [['setLegacyTrack', true]],
    '在途补发必须被重入守卫吞掉,不得产生第二次 manager 调用');
  assert.equal(manager.isLegacyTrackEnabled(), true, '开关必须能经 UI 稳定置位(单次交互净 +1)');
  assert.equal(h.pluginLegacyTrack, true, '绑定值必须乐观同步为用户意图');
});

toggleBehaviorTest('P2-013 行为真跑(安全模式):在途反向补发同样单发,不吞真实的后续切换', async () => {
  const manager = fakePluginManager();
  const h = newToggleHarness(manager);
  const first = h.toggleSafeMode(true);
  h.toggleSafeMode(false); // 在途补发 → 丢弃
  await first;
  assert.deepEqual(manager.state.calls, [['setSafeMode', true]]);
  await h.toggleSafeMode(false); // 落定后的真实第二次交互 → 必须照常生效(快速连点不坏)
  assert.deepEqual(manager.state.calls, [['setSafeMode', true], ['setSafeMode', false]]);
  assert.equal(manager.isSafeMode(), false);
});

toggleBehaviorTest('P2-013 行为真跑(插件启用):在途反向补发单发,consent 路径同纪律', async () => {
  const manager = fakePluginManager();
  manager.state.permission = 'pending';
  manager.plugin.manifest.capabilitiesDeclared = true;
  const h = newToggleHarness(manager);
  const first = h.togglePlugin('p1', true);
  h.togglePlugin('p1', false); // 在途补发 → 丢弃
  await first;
  assert.deepEqual(manager.state.calls, [['consentEnablePlugin', 'p1']],
    '未授权声明型插件的启用必须走 consent 通路且只发一次');
  assert.equal(manager.plugin.enabled, true);
});

toggleBehaviorTest('P2-013 行为真跑(幂等重放):落定后同值重放不发第二次调用;快速顺序切换不吞', async () => {
  const manager = fakePluginManager();
  const h = newToggleHarness(manager);
  await h.toggleLegacyTrack(true);
  await h.toggleLegacyTrack(true); // 同值重放 → 值幂等短路
  assert.deepEqual(manager.state.calls, [['setLegacyTrack', true]]);
  await h.toggleLegacyTrack(false); // 真实第二次交互 → 照常生效
  assert.deepEqual(manager.state.calls, [['setLegacyTrack', true], ['setLegacyTrack', false]]);
  assert.equal(manager.isLegacyTrackEnabled(), false);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of toggleBehaviorTests) {
    try {
      await fn();
      console.log('PASS ' + name);
    } catch (error) {
      failed++;
      console.error('FAIL - ' + name + '\n  ' + ((error && error.stack) || error));
    }
  }
  if (failed > 0) {
    console.error('workspace tool regression: ' + failed + ' P2-013 behavioral group(s) failed');
    process.exitCode = 1;
  }
  console.log(`${count - failed} workspace tool regression groups passed`);
})();
