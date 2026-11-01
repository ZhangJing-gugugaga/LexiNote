const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

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
const calls=[];
const savedData=[];
let hostEventRef=0;
function makeHost(){
 const files=[
  {kind:'file',path:'/我的工作区/日常记录 / 日记/日记.md',name:'日记.md',basename:'日记',extension:'md',noteId:'a1',vaultId:'v1',stat:{ctime:1,mtime:2,size:10}},
  {kind:'file',path:'/我的工作区/学习笔记/读书笔记.md',name:'读书笔记.md',basename:'读书笔记',extension:'md',noteId:'a2',vaultId:'v1',stat:{ctime:1,mtime:3,size:20}}
 ];
 return {
  call(callId,method,payloadJson){
   const payload=safeParse(payloadJson,{});
   calls.push({method,payload});
   let result=null;
   if(method==='vault.files'){result=files;}
   else if(method==='data.save'){savedData.push(payload.dataJson);}
   else if(method==='events.on'){result=++hostEventRef;}
   else if(method==='app.isDarkMode'){result=true;}
   return Promise.resolve(JSON.stringify({ok:true,result}));
  }
 };
}
function safeParse(text,fallback){try{return JSON.parse(text);}catch(err){return fallback;}}

const clearedIntervals=[];
const originalClearInterval=global.clearInterval;
global.clearInterval=id=>{clearedIntervals.push(id);return originalClearInterval(id);};

global.window=global;
vm.runInThisContext(shimSource,{filename:'lexinote_plugin_shim.js'});
const runtime=global.window.lexiRuntime;
assert.ok(runtime,'shim 必须注册 window.lexiRuntime');

global.window.lexiHost=makeHost();

async function dispatch(method,payload){
 runtime.__receive(method,JSON.stringify(payload));
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
  const addCall=calls.find(c=>c.method==='commands.add');
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
  let received=null;
  global.__capture=(value)=>{received=value;};
  const probe=`module.exports = class extends require('obsidian').Plugin {
    async onload(){
      const ref = this.app.vault.on('modify', (payload) => { global.__capture(payload); });
      this.registerEvent(ref);
    }
  };`;
  const before=calls.filter(c=>c.method==='events.on').length;
  await dispatch('load.plugin',{manifest:{id:'event-probe'},code:probe});
  await until(()=>calls.filter(c=>c.method==='events.on').length>before,'events.on');
  await dispatch('event',{topic:'vault',name:'modify',payload:{file:{kind:'file',path:'/p/n.md',name:'n.md',basename:'n',extension:'md',noteId:'a1',vaultId:'v1',stat:{ctime:1,mtime:2,size:3}},oldPath:'/old.md'}});
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
  const registerCall=calls.find(c=>c.method==='codeblocks.register');
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
 }]
];
(async()=>{
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
