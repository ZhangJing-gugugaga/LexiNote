const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const modules = new Map();
let workerFails = false, workerCalls = 0, latestPayload = '';
const taskpool = {execute(fn,payload) {
  workerCalls++; latestPayload=payload;
  return new Promise((resolve,reject)=>setImmediate(()=> {
    if (workerFails) reject(new Error('worker unavailable')); else {try {resolve(fn(payload));} catch(e) {reject(e);} }
  }));
}};
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const filename = path.resolve(__dirname,'../../entry/src/main/ets/core',name+'.ets');
  const source = fs.readFileSync(filename,'utf8').replace(/^@Concurrent\s*$/gm,'');
  const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
  const mod={exports:{}};
  vm.runInThisContext('(function(require,module,exports){'+js+'\n})',{filename})(spec=> {
    if(spec.startsWith('./')) return load(spec.slice(2));
    if(spec==='@kit.ArkTS') return {taskpool};
    throw new Error('Unexpected import '+spec);
  },mod,mod.exports);
  modules.set(name,mod.exports);return mod.exports;
}
const {GraphLayout:G}=load('GraphLayout');
const {LexiGraphForce:Force}=load('LexiGraphForce');
const {NoteItem,NoteLink,GraphNode,MindMapDoc,MindMapNode}=load('LexiModels');
function note(id){const n=new NoteItem();n.id=id;n.title=id;n.content='正文不可跨线程';return n;}
function link(a,b){const l=new NoteLink();l.sourceId=a;l.targetId=b;return l;}
function finite(data){for(const n of data.nodes){assert.ok(Number.isFinite(n.x)&&n.x>=0&&n.x<=1);assert.ok(Number.isFinite(n.y)&&n.y>=0&&n.y<=1);}}
(async()=>{
  const notes=[note('a'),note('b'),note('c')];notes[0].tags=['共同'];notes[1].tags=['共同'];
  const links=[link('a','b'),link('b','a'),link('b','c')];
  const map=new MindMapDoc();map.id='m';map.title='导图';const root=new MindMapNode();root.id='r';root.noteRefId='a';map.nodes=[root];
  const sync=G.build(notes,[map],links,true,true);
  const pending=G.buildAsync(notes,[map],links,true,true);
  assert.equal(workerCalls,1); // Scheduling happens before any asynchronous force result.
  const asyncData=await pending;
  assert.deepEqual(asyncData,sync);finite(asyncData);
  assert.ok(!latestPayload.includes('正文不可跨线程'));
  assert.equal(asyncData.edges.filter(e=>e.kind==='link').length,2);
  console.log('PASS async graph matches synchronous topology and deterministic positions, only IDs/endpoints cross boundary');
  const local=await G.localAsync(asyncData,'a');
  assert.deepEqual(local.nodes.map(n=>n.id),['a','b','map:m','tag:共同']);
  assert.deepEqual(asyncData,sync);finite(local);
  console.log('PASS local async graph restricts direct neighbours without mutating the full graph');
  workerFails=true;
  const originalLayout=Force.layout;
  Force.layout=()=>{throw new Error('Main-thread force fallback is forbidden');};
  const fallback=await G.buildAsync(notes,[],links,false,false);
  finite(fallback);assert.equal(fallback.nodes.length,3);
  const missing=await G.localAsync(asyncData,'does-not-exist');assert.equal(missing.nodes.length,0);
  const single=await G.buildAsync([note('single')],[],[],false,false);assert.equal(single.nodes[0].x,0.5);assert.equal(single.nodes[0].y,0.5);
  Force.layout=originalLayout;workerFails=false;
  console.log('PASS worker failure uses linear golden-angle fallback, empty/single graphs need no force work');
  const many=Array.from({length:2000},(_,i)=>note('n'+i));
  const chain=Array.from({length:1999},(_,i)=>link('n'+i,'n'+(i+1)));
  const started=Date.now();const large=await G.buildAsync(many,[],chain,false,false);const duration=Date.now()-started;
  finite(large);assert.equal(large.nodes.length,2000);assert.equal(large.edges.length,1999);
  const repeats=G.build(many,[],chain,false,false);
  assert.deepEqual(large.nodes.map(n=>[n.x,n.y]),repeats.nodes.map(n=>[n.x,n.y]));
  console.log('PASS 2000-node sampled force layout is finite and repeatable ('+duration+'ms in Node test harness; not a device benchmark)');
  console.log('4 Graph 1.1.0 regression cases passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
