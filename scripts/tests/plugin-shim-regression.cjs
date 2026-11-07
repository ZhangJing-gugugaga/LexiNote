const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const { createDispatchChannel }=require('./plugin-dispatch-channel.cjs');

const root=path.resolve(__dirname,'../../entry/src/main/resources/rawfile');
const shimSource=fs.readFileSync(path.join(root,'lexinote_plugin_shim.js'),'utf8');
const sampleManifest=JSON.parse(fs.readFileSync(path.join(root,'plugins/lexi-sample-plugin/manifest.json'),'utf8'));
const sampleCode=fs.readFileSync(path.join(root,'plugins/lexi-sample-plugin/main.js'),'utf8');

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(condition,label){
 for(let i=0;i<500;i++){
  await tick();
  if(condition()){return;}
 }
 throw new Error('等待超时: '+label);
}

// Mock of the ArkWeb javaScriptProxy host: records every call, scripts every response.
// P2-015:第 4 参(credential)一并记录——卸载清理链的身份断言靠它对账。
const calls=[];
const savedData=[];
let hostEventRef=0;
// P1-006b①:宿主侧 dispatch 通道凭据镜像(一次性,method+payload 绑定;生产实现在
// LexiWebRuntime.mintChannelCredential/admitDispatch)。dispatch 助手凭它走合法链路,
// 负例用例据此钉死裸调/重放/换绑定 fail-closed。
const dispatchChannel=createDispatchChannel();
// 宿主文件清单提到模块级:makeHost 的 vault.files 应答与启动预热的事件回放共用一份事实源。
const hostFiles=[
 {kind:'file',path:'/我的工作区/日常记录 / 日记/日记.md',name:'日记.md',basename:'日记',extension:'md',noteId:'a1',vaultId:'v1',stat:{ctime:1,mtime:2,size:10}},
 {kind:'file',path:'/我的工作区/学习笔记/读书笔记.md',name:'读书笔记.md',basename:'读书笔记',extension:'md',noteId:'a2',vaultId:'v1',stat:{ctime:1,mtime:3,size:20}}
];
function makeHost(){
 return {
  call(callId,method,payloadJson,credential){
   const payload=safeParse(payloadJson,{});
   calls.push({method,payload,credential:typeof credential==='string'?credential:''});
   let result=null;
   if(method==='vault.files'){result=hostFiles;}
   else if(method==='data.save'){savedData.push(payload.dataJson);}
   else if(method==='events.on'){result=++hostEventRef;}
   else if(method==='app.isDarkMode'){result=true;}
   return Promise.resolve(JSON.stringify({ok:true,result}));
  },
  // P1-006b①:__receive 门卫的核销口(生产面 = LexiWebRuntime.admitDispatch 经
  // javaScriptProxy methodList 暴露)。
  admitDispatch(credential,method,payloadJson){
   return dispatchChannel.admitDispatch(credential,method,payloadJson);
  }
 };
}
function safeParse(text,fallback){try{return JSON.parse(text);}catch(err){return fallback;}}

const clearedIntervals=[];
const originalClearInterval=global.clearInterval;
global.clearInterval=id=>{clearedIntervals.push(id);return originalClearInterval(id);};

// ---------------------------------------------------------------------------
// 最小 DOM 桩(仅测试壳使用;P0-008 bit-rot 修复)。
// Round 10 审计:本用例缺 document/DOM 链 —— load.plugin → mainEditorLeafRef →
// createMarkdownLeaf → new MarkdownViewShim → ViewShim 构造器里
// `document.createElement('div')` 直接 ReferenceError(shim L2430)。
// 这里只补 shim 实际触达的面:
//  - Node/Element/HTMLElement:installDomHelpers()(shim L146-181)往这三个原型挂
//    Obsidian 的 createEl/createDiv/setText/addClass/empty/show/hide/detach,
//    HTMLElement 未定义时它直接 bail,助手就不存在;
//  - document.createElement/getElementById/querySelector/body/createDocumentFragment:
//    视图宿主(#plugin-view-host/#views-tab-headers)、leaf/tab 元素、
//    status-bar/modal 落点、sanitizeHTMLToDom 的 fragment。
class StubClassList{
 constructor(el){this._el=el;this._set=new Set();}
 _replace(text){this._set=new Set(String(text==null?'':text).split(/\s+/).filter(Boolean));}
 _serialize(){return Array.from(this._set).join(' ');}
 add(...names){for(const name of names){if(name){this._set.add(name);}}this._el._syncClassName();}
 remove(...names){for(const name of names){this._set.delete(name);}this._el._syncClassName();}
 toggle(name,force){
  const want=force===undefined?!this._set.has(name):Boolean(force);
  if(want){this._set.add(name);}else{this._set.delete(name);}
  this._el._syncClassName();
  return want;
 }
 contains(name){return this._set.has(name);}
}
class StubNode{
 constructor(tag){
  this.tagName=String(tag||'div').toUpperCase();
  this.nodeType=1;
  this.parentNode=null;
  this.childNodes=[];
  this.style={};
  this._attributes={};
  this._text='';
  this._className='';
  this._listeners=new Map();
  this.classList=new StubClassList(this);
 }
 get className(){return this._className;}
 set className(value){this._className=String(value==null?'':value);this.classList._replace(this._className);}
 get textContent(){return this._text;}
 set textContent(value){
  const detached=this.childNodes;
  this.childNodes=[];
  this._text=String(value==null?'':value);
  for(const child of detached){child.parentNode=null;}
 }
 get innerHTML(){return this._text;}
 set innerHTML(value){this.textContent=String(value==null?'':value);}
 get firstChild(){return this.childNodes[0]||null;}
 get lastChild(){return this.childNodes[this.childNodes.length-1]||null;}
 appendChild(node){
  if(node&&node.parentNode){node.parentNode.removeChild(node);}
  node.parentNode=this;
  this.childNodes.push(node);
  return node;
 }
 insertBefore(node,reference){
  if(node&&node.parentNode){node.parentNode.removeChild(node);}
  let index=reference?this.childNodes.indexOf(reference):this.childNodes.length;
  if(index<0){index=this.childNodes.length;}
  node.parentNode=this;
  this.childNodes.splice(index,0,node);
  return node;
 }
 removeChild(node){
  const index=this.childNodes.indexOf(node);
  if(index>=0){this.childNodes.splice(index,1);node.parentNode=null;}
  return node;
 }
 contains(node){for(let cur=node;cur;cur=cur.parentNode){if(cur===this){return true;}}return false;}
 setAttribute(name,value){this._attributes[String(name)]=String(value);}
 getAttribute(name){const key=String(name);return Object.prototype.hasOwnProperty.call(this._attributes,key)?this._attributes[key]:null;}
 removeAttribute(name){delete this._attributes[String(name)];}
 addEventListener(type,handler){
  let handlers=this._listeners.get(type);
  if(!handlers){handlers=new Set();this._listeners.set(type,handlers);}
  handlers.add(handler);
 }
 removeEventListener(type,handler){const handlers=this._listeners.get(type);if(handlers){handlers.delete(handler);}}
 _syncClassName(){this._className=this.classList._serialize();}
}
class StubElement extends StubNode{}
class StubHTMLElement extends StubElement{}
global.Node=StubNode;
global.Element=StubElement;
global.HTMLElement=StubHTMLElement;
const stubBody=new StubHTMLElement('body');
const stubHead=new StubHTMLElement('head');
function stubWalk(node,visit){
 visit(node);
 const children=node.childNodes.slice();
 for(const child of children){stubWalk(child,visit);}
}
// 只支持单一简单选择器(.cls/#id/tag);shim 只查 '.workspace'/'.status-bar',
// 查不到时 shim 自己会落到 document.body 或新建,语义保持一致。
function stubMatchesSimple(el,selector){
 const sel=String(selector==null?'':selector).trim();
 if(!sel||sel.includes(' ')||sel.includes(',')){return false;}
 if(sel[0]==='.'){return el.classList.contains(sel.slice(1));}
 if(sel[0]==='#'){return el.id===sel.slice(1);}
 return el.tagName===sel.toUpperCase();
}
global.document={
 nodeType:9,
 body:stubBody,
 head:stubHead,
 createElement:tag=>new StubHTMLElement(tag),
 createDocumentFragment:()=>{const frag=new StubNode('#document-fragment');frag.nodeType=11;return frag;},
 getElementById(id){
  let found=null;
  stubWalk(stubBody,el=>{if(found===null&&el.id===String(id)){found=el;}});
  return found;
 },
 querySelector(selector){
  let found=null;
  stubWalk(stubBody,el=>{if(found===null&&stubMatchesSimple(el,selector)){found=el;}});
  return found;
 },
 querySelectorAll(selector){
  const found=[];
  stubWalk(stubBody,el=>{if(stubMatchesSimple(el,selector)){found.push(el);}});
  return found;
 }
};

global.window=global;
// 生产序(P0-008):ArkWeb 的 javaScriptProxy(lexiHost)在页面脚本执行前就已注册
// (LexiPluginRuntimeHost.ets build():.javaScriptProxy 声明先于 rawfile 页面加载),
// 所以这里先挂宿主再跑 shim。若反序,shim 的 whenHostReady()(L2758)会进入 40ms
// 轮询,而轮询定时器自清时的 clearInterval 会被下方 spy 捕获,污染 clearedIntervals 断言。
global.window.lexiHost=makeHost();
vm.runInThisContext(shimSource,{filename:'lexinote_plugin_shim.js'});
const runtime=global.window.lexiRuntime;
assert.ok(runtime,'shim 必须注册 window.lexiRuntime');

// P1-006b①:合法派发 = 宿主铸造一次性通道凭据(绑定 method+payload)随帧进 __receive 门卫。
async function dispatch(method,payload){
 const frame=JSON.stringify(payload);
 runtime.__receive(method,frame,dispatchChannel.mint(method,frame));
 await tick();
}

const tests=[
 ['require("obsidian") and require("lexinote") are the same namespace',async()=>{
  let identity=null;
  global.__capture=(value)=>{identity=value;};
  const probe=`module.exports = class extends require('obsidian').Plugin {
    async onload(){ global.__capture(require('obsidian') === require('lexinote')); }
  };`;
  await dispatch('load.plugin',{manifest:{id:'probe-plugin'},code:probe});
  await until(()=>identity!==null,'require alias');
  assert.equal(identity,true);
  await dispatch('unload.plugin',{id:'probe-plugin'});
 }],
 ['sample plugin loads, registers a namespaced command and answers execution end-to-end',async()=>{
  await dispatch('load.plugin',{manifest:sampleManifest,code:sampleCode});
  await until(()=>calls.some(c=>c.method==='commands.add'&&c.payload.pluginId==='lexi-sample-plugin'),'commands.add');
  const addCall=calls.find(c=>c.method==='commands.add'&&c.payload.command&&c.payload.command.id==='sample-notice');
  assert.equal(addCall.payload.command.id,'sample-notice');
  assert.equal(addCall.payload.command.name,'示例:统计当前笔记库');
  assert.equal(calls.filter(c=>c.method==='data.load').length,1);

  await dispatch('invoke.command',{fullId:'lexi-sample-plugin:sample-notice'});
  await until(()=>calls.some(c=>c.method==='ui.notice'),'notice');
  const notice=calls.find(c=>c.method==='ui.notice');
  assert.ok(notice.payload.message.includes('当前笔记数:2'));
  assert.ok(notice.payload.message.includes(String(new Date().getFullYear())),'moment 格式化日期应出现在通知里');
  assert.equal(notice.payload.duration,0);
  await until(()=>calls.some(c=>c.method==='data.save'),'saveData');
  assert.equal(savedData.length,1);
  assert.ok(JSON.parse(savedData[0]).lastRunAt>0);
 }],
 ['moment covers daily-plugin formatting and arithmetic',async()=>{
  let rendered=null;let shifted=null;
  global.__capture=(value)=>{if(rendered===null){rendered=value;}else{shifted=value;}};
  const probe=`module.exports = class extends require('obsidian').Plugin {
    async onload(){
      const { moment } = require('obsidian');
      global.__capture(moment('2026-03-05T14:08:09').format('YYYY/MM/DD dddd HH:mm:ss A'));
      global.__capture(moment('2026-01-31').add(1,'month').format('YYYY-MM-DD'));
    }
  };`;
  await dispatch('load.plugin',{manifest:{id:'moment-probe'},code:probe});
  await until(()=>shifted!==null,'moment probe');
  assert.equal(rendered,'2026/03/05 Thursday 14:08:09 PM');
  assert.equal(shifted,'2026-02-28'); // moment 的月末钳制语义
  await dispatch('unload.plugin',{id:'moment-probe'});
 }],
 ['host events rehydrate TFile payloads for vault subscriptions',async()=>{
  // 现行 shim 契约(L274-276)对齐 Obsidian 官方回调签名:vault 事件回调收位置参数,
  // rename → (file, oldPath),file 已由 rehydrateFileEvent 从 JSON 重建为 TFile。
  let received=null;
  global.__capture=(value)=>{received=value;};
  const probe=`module.exports = class extends require('obsidian').Plugin {
    async onload(){
      const ref = this.app.vault.on('rename', (file, oldPath) => { global.__capture({ file: file, oldPath: oldPath }); });
      this.registerEvent(ref);
    }
  };`;
  const before=calls.filter(c=>c.method==='events.on').length;
  await dispatch('load.plugin',{manifest:{id:'event-probe'},code:probe});
  await until(()=>calls.filter(c=>c.method==='events.on').length>before,'events.on');
  await dispatch('event',{topic:'vault',name:'rename',payload:{file:{kind:'file',path:'/p/n.md',name:'n.md',basename:'n',extension:'md',noteId:'a1',vaultId:'v1',stat:{ctime:1,mtime:2,size:3}},oldPath:'/old.md'}});
  await until(()=>received!==null,'event dispatch');
  assert.equal(received.file.path,'/p/n.md');
  assert.equal(received.file.basename,'n');
  assert.equal(received.oldPath,'/old.md');
  const unloadCalls=calls.length;
  await dispatch('unload.plugin',{id:'event-probe'});
  await until(()=>calls.some((c,i)=>i>=unloadCalls&&c.method==='events.off'),'events.off cleanup');
 }],
 ['editor commands receive a working Editor proxy and route writes through editor.replace',async()=>{
  let captured=null;
  global.__capture=(value)=>{captured=value;};
  const probe=`module.exports = class extends require('obsidian').Plugin {
    async onload(){
      this.addCommand({
        id: 'editor-probe',
        name: '编辑器探针',
        editorCallback: (editor) => {
          global.__capture({
            text: editor.getValue(),
            selection: editor.getSelection(),
            cursor: editor.getCursor(),
            lines: editor.lineCount()
          });
        }
      });
    }
  };`;
  await dispatch('load.plugin',{manifest:{id:'editor-probe'},code:probe});
  await until(()=>calls.some(c=>c.method==='commands.add'&&c.payload.command.editorOnly===true),'editorOnly flag');
  await dispatch('invoke.editorCommand',{
    fullId:'editor-probe:editor-probe',
    editor:{active:true,noteId:'n1',text:'第一行\n第二行',selection:{start:4,end:7}}
  });
  await until(()=>captured!==null,'editor callback');
  assert.equal(captured.text,'第一行\n第二行');
  assert.equal(captured.selection,'第二行');
  assert.deepEqual(captured.cursor,{line:1,ch:3});
  assert.equal(captured.lines,2);
  await dispatch('unload.plugin',{id:'editor-probe'});
 }],
 ['editor.replaceSelection sends exact offsets and refreshes the snapshot',async()=>{
  let applied=null;
  const originalCall=global.window.lexiHost.call;
  global.window.lexiHost.call=function(callId,method,payloadJson){
    const payload=safeParse(payloadJson,{});
    if(method==='editor.replace'){
      applied={start:payload.start,end:payload.end,text:payload.text};
      const merged={active:true,noteId:'n1'};
      merged.text=payloadJson===undefined?'':('第一行\n==第二行==');
      merged.selection={start:4,end:4};
      return Promise.resolve(JSON.stringify({ok:true,result:merged}));
    }
    return originalCall.apply(this,arguments);
  };
  let snapshot={};
  global.__capture=(value)=>{ if(value&&value.textAfter!==undefined){snapshot=value;} };
  try{
   const probe=`module.exports = class extends require('obsidian').Plugin {
     async onload(){
       this.addCommand({
         id: 'wrap',
         name: '包裹',
         editorCallback: (editor) => {
           editor.replaceSelection('==第二行==').then(function(){
             global.__capture({ textAfter: editor.getValue(), selectionAfter: editor.listSelections() });
           });
         }
       });
     }
   };`;
   await dispatch('load.plugin',{manifest:{id:'wrap-probe'},code:probe});
   await dispatch('invoke.editorCommand',{
     fullId:'wrap-probe:wrap',
     editor:{active:true,noteId:'n1',text:'第一行\n第二行',selection:{start:4,end:7}}
   });
   await until(()=>applied!==null,'editor.replace call');
   assert.deepEqual(applied,{start:4,end:7,text:'==第二行=='});
   await until(()=>snapshot.textAfter!==undefined,'snapshot refresh');
   assert.equal(snapshot.textAfter,'第一行\n==第二行==');
   await dispatch('unload.plugin',{id:'wrap-probe'});
  }finally{
   global.window.lexiHost.call=originalCall;
  }
 }],
 ['code block processors register a language and clean up on unload',async()=>{
  const probe=`module.exports = class extends require('obsidian').Plugin {
    async onload(){
      this.registerMarkdownCodeBlockProcessor('Demo-Lang', (source, el) => { el.setText(source); });
    }
  };`;
  await dispatch('load.plugin',{manifest:{id:'codeblock-probe'},code:probe});
  await until(()=>calls.some(c=>c.method==='codeblocks.register'&&c.payload.pluginId==='codeblock-probe'),'codeblocks.register');
  const registerCall=calls.find(c=>c.method==='codeblocks.register'&&c.payload.pluginId==='codeblock-probe');
  assert.equal(registerCall.payload.language,'demo-lang');
  await dispatch('unload.plugin',{id:'codeblock-probe'});
  await until(()=>calls.some(c=>c.method==='codeblocks.unregister'&&c.payload.language==='demo-lang'),'codeblocks.unregister');
 }],
 ['unloading clears registered intervals and command table',async()=>{
  await dispatch('load.plugin',{manifest:sampleManifest,code:sampleCode});
  const removeCount=calls.filter(c=>c.method==='commands.remove').length;
  await dispatch('unload.plugin',{id:'lexi-sample-plugin'});
  await until(()=>calls.filter(c=>c.method==='commands.remove').length>removeCount,'commands.remove');
  assert.equal(clearedIntervals.length,1,'registerInterval 必须随卸载清理');
  // Re-dispatching the command after unload must be a no-op.
  const noticeBefore=calls.filter(c=>c.method==='ui.notice').length;
  await dispatch('invoke.command',{fullId:'lexi-sample-plugin:sample-notice'});
  await tick();await tick();
  assert.equal(calls.filter(c=>c.method==='ui.notice').length,noticeBefore);
 }],
 // P2-015:卸载清理链必须携带原插件身份。生产序里宿主随 load.plugin 载荷下发铸造令牌,
 // onunload 的 views.remove/commands.remove/settings.unregister/events.off 若不带身份,
 // 会以匿名被宿主 fail-closed(设备证据 P4-005 cal_off:calendar 停用 7 条 authz.denied,
 // 清理整体失效)。unload 路径必须与 loadPlugin 的 withToken(pluginToken,…load) 对称。
 ['unload teardown RPCs carry the plugin credential (P2-015: cleanup is not anonymous)',async()=>{
  const token='tk-p2015unit000042';
  const teardown=[
    "module.exports = class extends require('obsidian').Plugin {",
    "  async onload(){",
    "    this.registerView('p2015-view', () => ({}));",
    "    this.addCommand({ id:'p2015-cmd', name:'p2015', callback: () => {} });",
    "    this.addSettingTab({ getSettingDefinitions: () => [] });",
    "    this.registerEvent(this.app.vault.on('rename', () => {}));",
    "  }",
    "};"
  ].join('\n');
  await dispatch('load.plugin',{manifest:{id:'p2015-probe'},code:teardown,token:token});
  await until(()=>calls.some(c=>c.method==='views.add'&&c.payload.pluginId==='p2015-probe'),'views.add');
  const mark=calls.length;
  await dispatch('unload.plugin',{id:'p2015-probe'});
  await until(()=>calls.slice(mark).some(c=>c.method==='plugin.unload.done'),'plugin.unload.done');
  const teardownCalls=calls.slice(mark);
  for(const expected of ['views.remove','commands.remove','settings.unregister','events.off','plugin.unload.done']){
    const hit=teardownCalls.find(c=>c.method===expected);
    assert.ok(hit,expected+' 必须在卸载清理链上发出');
    assert.equal(hit.credential,token,
      expected+' 必须携带装载时下发的插件令牌(匿名=宿主 fail-closed,清理失效)');
  }
 }],
 // P2-014:命令回调失败必须可见(fail-visible)。页面侧 catch 以命令归属插件的身份发
 // ui.notice——不带令牌的匿名 ui.notice 会被宿主 fail-closed 拒绝,失败退化成静默无操作
 // (设备证据:open-weekly-note 零通知零日志)。
 ['failing command produces a visible, identity-carrying notice (P2-014)',async()=>{
  const token='tk-p2014unit000042';
  const probe=[
    "module.exports = class extends require('obsidian').Plugin {",
    "  async onload(){",
    "    this.addCommand({ id:'p2014-boom', name:'boom', callback: () => { throw new Error('weekly-note 依赖缺失'); } });",
    "  }",
    "};"
  ].join('\n');
  await dispatch('load.plugin',{manifest:{id:'p2014-probe'},code:probe,token:token});
  await until(()=>calls.some(c=>c.method==='commands.add'&&c.payload.pluginId==='p2014-probe'),'commands.add');
  const noticeBefore=calls.filter(c=>c.method==='ui.notice').length;
  await dispatch('invoke.command',{fullId:'p2014-probe:p2014-boom'});
  await until(()=>calls.filter(c=>c.method==='ui.notice').length>noticeBefore,'ui.notice');
  const notice=calls.filter(c=>c.method==='ui.notice').pop();
  assert.ok(notice.payload.message.indexOf('p2014-probe:p2014-boom')>=0,'失败通知必须点明是哪条命令');
  assert.ok(notice.payload.message.indexOf('weekly-note 依赖缺失')>=0,'失败通知必须带出错误原因');
  assert.equal(notice.credential,token,'失败通知必须携带命令归属插件的令牌(匿名会被宿主拒收)');
  await dispatch('unload.plugin',{id:'p2014-probe'});
 }],
 // P1-003c:注入通道(真机 runtime 页通道)行为级验证。上面的用例都在"无 document"环境,
 // 走的是过渡通道(new Function,工作区页同款);本用例在独立 vm 沙箱里安装"会执行脚本文本"
 // 的 document 桩,能力探测据此判注入可用 —— loadPlugin 必须走 wrapPluginSource →
 // <script> 注入 → 注册表交付,且 require 闭包(令牌绑定)在装载完成后依然可用。
 ['plugin code evaluates through the script-injection channel (P1-003c)',async()=>{
  const injected=[];
  const sandbox={
    console:{log:()=>{},warn:()=>{},error:()=>{}},
    setTimeout:(fn)=>{ if(typeof fn==='function'){fn();} return 0; },
    clearTimeout:()=>{}, setInterval:()=>0, clearInterval:()=>{},
    Promise,JSON,Math,Date,Map,Set,
    location:{href:'https://lexinote.local/runtime'}
  };
  sandbox.window=sandbox;
  const mount={appendChild:(el)=>{
    injected.push(String(el.textContent||''));
    try{ vm.runInContext(String(el.textContent||''),sandbox,{filename:'lexinote-plugin-injected.js'}); }
    catch(err){ /* 浏览器语义:脚本异常走 window error,不冒泡进 appendChild */ }
  }};
  sandbox.document={
    createElement:()=>({textContent:'',setAttribute(){},parentNode:null}),
    getElementById:()=>null,
    head:mount
  };
  const injectChannel=createDispatchChannel();
  sandbox.window.lexiHost={
    call(){return Promise.resolve(JSON.stringify({ok:true,result:null}));},
    admitDispatch(credential,method,payloadJson){
      return injectChannel.admitDispatch(credential,method,payloadJson);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(shimSource,sandbox,{filename:'lexinote_plugin_shim.js'});
  const injectedRuntime=sandbox.window.lexiRuntime;
  assert.ok(injectedRuntime,'注入沙箱:shim 必须注册 window.lexiRuntime');
  let captured=null;
  sandbox.__capture=(value)=>{captured=value;};
  const injectProbe="const { Plugin } = require('obsidian');\n"+
    "module.exports = class InjectProbe extends Plugin {\n"+
    "  async onload(){ __capture(require('obsidian') === require('lexinote')); }\n"+
    "};";
  const injectFrame=JSON.stringify({manifest:{id:'inject-probe'},code:injectProbe});
  injectedRuntime.__receive('load.plugin',injectFrame,injectChannel.mint('load.plugin',injectFrame));
  await until(()=>captured!==null,'injection channel onload');
  assert.equal(captured,true,'require 闭包必须在装载完成后依然可用(obsidian===lexinote)');
  const wrapped=injected.filter((text)=>text.indexOf('/* lexi-iife:v1 */')===0);
  assert.equal(wrapped.length,1,'插件源码必须以 lexi-iife:v1 包装注入,实际 '+wrapped.length);
  assert.ok(wrapped[0].indexOf('//# sourceURL=lexinote-plugin-inject-probe.js')>=0,'包装文本必须带 sourceURL');
  assert.ok(!sandbox.window.__lexiPluginRegistry || !sandbox.window.__lexiPluginRegistry['inject-probe'],
    '注册表交付项必须在装载后被消费(不残留)');
  assert.ok(!sandbox.window.__lexiScriptInjectOk,
    '探测标记必须被清理');
 }],
 // P1-006b①(ADR-R10-01 残余风险①/SEC-007 负例族):__receive 门卫。同 realm 插件
 // 裸调 __receive 触发 invoke.command 跨插件回调执行的历史攻击面,在通道鉴权后必须
 // 全部 fail-closed —— 裸调(无凭据)、伪凭据、重放(已核销)、换方法/换载荷(绑定不符)。
 ['dispatch channel: forged __receive without or with fake credential is fail-closed (P1-006b① SEC-007)',async()=>{
  let ran=false;
  global.__capture=(value)=>{ if(value==='forged-cmd') { ran=true; } };
  const probe=`module.exports = class extends require('obsidian').Plugin {
    async onload(){
      this.addCommand({ id:'forged', name:'forged', callback: () => { __capture('forged-cmd'); } });
    }
  };`;
  await dispatch('load.plugin',{manifest:{id:'forge-probe'},code:probe});
  await until(()=>calls.some(c=>c.method==='commands.add'&&c.payload.pluginId==='forge-probe'),'commands.add');
  runtime.__receive('invoke.command',JSON.stringify({fullId:'forge-probe:forged'}));
  await tick();await tick();
  assert.equal(ran,false,'无凭据裸调 __receive 不得执行任何命令回调');
  runtime.__receive('invoke.command',JSON.stringify({fullId:'forge-probe:forged'}),'dc-forged-not-host-minted');
  await tick();await tick();
  assert.equal(ran,false,'非宿主铸造的伪凭据同样 fail-closed');
  await dispatch('unload.plugin',{id:'forge-probe'});
 }],
 ['dispatch channel: one-shot credential burns on admit; replay and re-binding fail (P1-006b①)',async()=>{
  let runs=0;
  global.__capture=(value)=>{ if(value==='oneshot-cmd') { runs+=1; } };
  const probe=`module.exports = class extends require('obsidian').Plugin {
    async onload(){
      this.addCommand({ id:'oneshot', name:'oneshot', callback: () => { __capture('oneshot-cmd'); } });
    }
  };`;
  await dispatch('load.plugin',{manifest:{id:'oneshot-probe'},code:probe});
  await until(()=>calls.some(c=>c.method==='commands.add'&&c.payload.pluginId==='oneshot-probe'),'commands.add');
  const frame=JSON.stringify({fullId:'oneshot-probe:oneshot'});
  const credential=dispatchChannel.mint('invoke.command',frame);
  runtime.__receive('invoke.command',frame,credential);
  await until(()=>runs===1,'合法派发执行一次');
  runtime.__receive('invoke.command',frame,credential);
  await tick();await tick();
  assert.equal(runs,1,'已核销凭据重放必须 fail-closed(单次有效)');
  const eventFrame=JSON.stringify({topic:'vault',name:'x',payload:null});
  const eventCredential=dispatchChannel.mint('event',eventFrame);
  runtime.__receive('invoke.command',frame,eventCredential);
  await tick();await tick();
  assert.equal(runs,1,'换方法盗用凭据必须 fail-closed(绑定不符)');
  runtime.__receive('event',eventFrame,eventCredential);
  await tick();
  assert.equal(runs,1,'换方法盗用即烧毁,凭据回正确方法也不得再通过');
  await dispatch('unload.plugin',{id:'oneshot-probe'});
 }],
 // P1-006b②(ADR-R10-01 残余风险②):setSessionToken 作用域收口 —— 页面会话作用域
 // 写一次定死,绑定后的异值后写(同 realm 插件乱写/清空,DoS 宿主回话)fail-closed 拒绝。
 ['setSessionToken scope: cross-context overwrite fails, same-value idempotent (P1-006b②)',async()=>{
  const face=global.window.LexiObsidian;
  assert.equal(face.setSessionToken('st-unit-abcdef12'),true,'首次注入放行');
  assert.equal(face.setSessionToken('st-evil-000000'),false,'绑定后异值后写必须拒绝');
  assert.equal(face.stats().sessionTokenTail,'cdef12','拒绝后原会话凭据保持不变(尾部 6 位)');
  assert.equal(face.setSessionToken('st-unit-abcdef12'),true,'同值幂等重放放行');
  assert.equal(face.setSessionToken(''),false,'清空(异值)同样拒绝');
  assert.equal(face.stats().sessionTokenTail,'cdef12','清空被拒后原值仍在');
 }]
];
(async()=>{
 // 启动预热(P0-008):shim 的门禁锚点注释(L815-816)承诺"启动拉一次 vault.files",
 // 但现行 shim 只有 knownMarkdownFiles 的懒拉取(L842):首次调用同步返回空索引,
 // 异步拉取落地后才有数据。生产会话里插件运行前索引早已被 vault 事件焐热;这里
 // 经宿主→运行时的公共事件通道回放两笔记(L296-308:topic=vault 事件同步维护
 // knownFiles),让 sample-notice 的统计断言有确定输入。
 for(const file of hostFiles){
  const warmFrame=JSON.stringify({topic:'vault',name:'create',payload:{file:file}});
  runtime.__receive('event',warmFrame,dispatchChannel.mint('event',warmFrame));
 }
 let failed=0;
 for(const[name,run]of tests){
  try{await run();console.log('ok -',name);}
  catch(error){failed++;console.error('FAIL -',name,'\n ',error && error.stack || error);}
 }
 global.clearInterval=originalClearInterval;
 process.exitCode=failed>0?1:0;
 if(failed===0)console.log(`plugin-shim-regression: ${tests.length} passed`);
 process.exit(failed>0?1:0);
})();
