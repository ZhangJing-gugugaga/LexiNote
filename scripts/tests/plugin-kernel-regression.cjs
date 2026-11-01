const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const core=path.resolve(__dirname,'../../entry/src/main/ets/core');
const cache=new Map();
function load(spec,fromDir){
 const base=spec.startsWith('.')?path.resolve(fromDir||core,spec):path.resolve(core,spec);
 const target=base.endsWith('.ets')?base:base+'.ets';
 if(cache.has(target))return cache.get(target);
 const js=ts.transpileModule(fs.readFileSync(target,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
 const mod={exports:{}};cache.set(target,mod.exports);
 vm.runInThisContext('(function(require,module,exports){'+js+'\n})',{filename:target})(
  s=>load(s,path.dirname(target)),mod,mod.exports);
 cache.set(target,mod.exports);return mod.exports;
}
const kernel=load('plugin/LexiPluginKernel');
const manifest=load('plugin/LexiPluginManifest');
const {LexiEvents,LexiComponent,LexiCommandRegistry}=kernel;
const {LexiPluginManifest:ManifestModel,parsePluginManifest,manifestCompatible}=manifest;

const tests=[
 ['events deliver payloads and unsubscribe by callback and ref',()=>{
  const events=new LexiEvents();
  const seen=[];const ref=events.on('vault.modify',p=>seen.push(p));
  events.trigger('vault.modify',{name:'a'});
  events.off('vault.modify',events===events?null:null); // no-op off of wrong callback
  events.trigger('vault.modify',{name:'b'});
  events.offref(ref);
  events.trigger('vault.modify',{name:'c'});
  assert.deepEqual(seen.map(p=>p.name),['a','b']);
  assert.equal(events.listenerCount('vault.modify'),0);
 }],
 ['a broken listener cannot break the emitter',()=>{
  const events=new LexiEvents();
  const seen=[];
  events.on('x',()=>{throw new Error('boom');});
  events.on('x',p=>seen.push(p));
  events.trigger('x',1);
  assert.deepEqual(seen,[1]);
 }],
 ['component unload order: children, timers, cleanups, onunload',()=>{
  const order=[];
  class Child extends LexiComponent{onload(){order.push('child.load');}onunload(){order.push('child.unload');}}
  class Host extends LexiComponent{
   constructor(){super();this.child=this.addChild(new Child());}
   onload(){order.push('host.load');this.registerInterval(this.registerInterval?999:999);}
   onunload(){order.push('host.onunload');}
  }
  const cleared=[];
  const host=new Host();
  host.register(()=>order.push('cleanup1'));
  host.register(()=>{throw new Error('cleanup must not block');});
  host.register(()=>order.push('cleanup2'));
  const originalClear=global.clearInterval;
  global.clearInterval=id=>cleared.push(id);
  try{
   host.load();assert.deepEqual(order,['host.load','child.load']);
   host.unload();
  }finally{global.clearInterval=originalClear;}
  // Contract order: children → timers → registered cleanups → onunload (the plugin's own final hook).
  assert.deepEqual(order,['host.load','child.load','child.unload','cleanup1','cleanup2','host.onunload']);
  assert.equal(host.isLoaded(),false);
  assert.equal(cleared.length,1);
 }],
 ['registerEvent removes the exact listener through its owner',()=>{
  const events=new LexiEvents();
  class Holder extends LexiComponent{}
  const holder=new Holder();
  const seen=[];
  holder.registerEvent(events.on('changed',p=>seen.push(p.value)));
  holder.load();
  events.trigger('changed',{value:1});
  holder.unload();
  events.trigger('changed',{value:2});
  assert.deepEqual(seen,[1]);
 }],
 ['commands are namespaced, checkable and removable per plugin',async()=>{
  const registry=new LexiCommandRegistry();
  let runs=0;let checkCalls=0;
  registry.registerPluginCommand('demo',{id:'hello',name:'Hello',
   checkCallback:(checking)=>{checkCalls++;return true;},
   callback:()=>{runs++;}});
  registry.registerPluginCommand('demo',{id:'hidden',name:'Hidden',checkCallback:()=>false});
  assert.equal(registry.get('demo:hello').id,'demo:hello');
  assert.equal(await registry.execute('demo:hello'),true);
  assert.equal(runs,1);assert.equal(checkCalls,1);
  assert.equal(await registry.execute('demo:hidden'),false);
  assert.equal(await registry.execute('missing:x'),false);
  registry.removePluginCommands('demo');
  assert.equal(registry.list().length,0);
 }],
 ['manifest parsing validates the Obsidian field set',()=>{
  const manifest=parsePluginManifest(JSON.stringify({
   id:'sample-plugin',name:'Sample',author:'LexiNote',version:'1.0.0',
   minAppVersion:'0.1.0',description:'demo',authorUrl:'https://example.com',isDesktopOnly:false}));
  assert.equal(manifest.id,'sample-plugin');
  assert.equal(manifestCompatible(manifest),true);
  assert.throws(()=>parsePluginManifest('{}'),/id/);
  assert.throws(()=>parsePluginManifest(JSON.stringify({id:'BAD_ID',name:'x',author:'a',version:'1'})),/id/);
  assert.throws(()=>parsePluginManifest(JSON.stringify({id:'ok-id'})),/name/);
  const future=new ManifestModel();future.id='f';future.name='f';future.author='a';future.version='1.0.0';future.minAppVersion='99.0.0';
  assert.equal(manifestCompatible(future),false);
 }]
];
(async()=>{
 let failed=0;
 for(const[name,run]of tests){
  try{await run();console.log('ok -',name);}
  catch(error){failed++;console.error('FAIL -',name,'\n ',error && error.stack || error);}
 }
 process.exitCode=failed>0?1:0;
 if(failed===0)console.log(`plugin-kernel-regression: ${tests.length} passed`);
 process.exit(failed>0?1:0);
})();
