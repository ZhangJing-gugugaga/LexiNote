const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const ts=require(process.env.LEXI_TYPESCRIPT||'/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');const cache=new Map();
function load(name){if(cache.has(name))return cache.get(name);const filename=path.resolve(__dirname,'../../entry/src/main/ets/core/'+name+'.ets');const js=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;const mod={exports:{}};vm.runInThisContext('(function(require,module,exports){'+js+'})',{filename})(spec=>{if(spec.startsWith('./'))return load(spec.slice(2));throw new Error('Unexpected external dependency '+spec);},mod,mod.exports);cache.set(name,mod.exports);return mod.exports;}
const {LexiLocalAssistant:A}=load('LexiLocalAssistant');const {NoteItem}=load('LexiModels');
function note(id,title,content,tags=[]){const n=new NoteItem();Object.assign(n,{id,title,content,tags});return n;}
const tests=[
 ['summary is an extractive local result, excluding YAML, fenced code and Markdown markers',()=>{
  const content='---\nsecret: 私有属性\ntags: [已有]\n---\n# 会议\n\n**本次会议讨论项目迁移的实施范围**。下一阶段需要先完成数据导出和验证。\n```ts\nconst secret="不应出现在摘要";\n```';const result=A.arrange(content,[]);
  assert.ok(result.summary.includes('本次会议讨论项目迁移的实施范围'));assert.ok(!result.summary.includes('私有属性'));assert.ok(!result.summary.includes('不应出现在摘要'));assert.ok(!result.summary.includes('**'));assert.ok(result.method.includes('不调用生成式模型'));
 }],
 ['actions extract unfinished tasks and explicit action language, deduplicate and exclude done tasks',()=>{
  const result=A.arrange('- [ ] 提交报告\n- [x] 已完成工作\nTODO: 提交报告\n下一步：核对统计数字\n计划 安排评审\n普通描述',[''].filter(Boolean));
  assert.deepEqual(result.actions.map(x=>x.label),['提交报告','核对统计数字','安排评审']);assert.ok(result.actions.every(x=>x.markdown.startsWith('- [ ] ')));
 }],
 ['links use existing titles, exclude already linked, trashed, self and unsafe titles',()=>{
  const content='这段正文提到架构设计与数据安全，也提到旧笔记。[[数据安全]]';const notes=[note('a','架构设计','其他正文'),note('b','数据安全','其他'),note('c','旧笔记','其他'),note('d','本页',content)];notes[2].trashedAt=1;const before=JSON.stringify(notes);const result=A.arrange(content,notes);
  assert.deepEqual(result.links.map(x=>x.markdown),['[[架构设计]]']);assert.equal(JSON.stringify(notes),before);
 }],
 ['tag suggestions reuse matching tags and avoid tags already in frontmatter or body',()=>{
  const result=A.arrange('---\ntags: [会议]\n---\n项目会议需要安排复习计划 #学习',[note('a','记录','其他',['项目','会议','学习','不相关'])]);
  assert.ok(result.tags.some(x=>x.markdown==='#项目'));assert.ok(result.tags.some(x=>x.markdown==='#计划'));assert.ok(!result.tags.some(x=>x.markdown==='#会议'));assert.ok(!result.tags.some(x=>x.markdown==='#学习'));assert.ok(!result.tags.some(x=>x.markdown==='#不相关'));
 }],
 ['only explicit selected suggestions become Markdown and an edited summary is honored',()=>{
  const result=A.arrange('这是具有足够长度的摘要原文。\nTODO: 提交报告\n架构设计\n项目计划',[note('n','架构设计','独立正文',['项目'])]);assert.equal(A.selectedMarkdown(result,[],'',false),'');
  const text=A.selectedMarkdown(result,[result.actions[0].id,result.links[0].id],'用户修订摘要',true);assert.ok(text.includes('用户修订摘要'));assert.ok(text.includes('- [ ] 提交报告'));assert.ok(text.includes('[[架构设计]]'));assert.ok(!text.includes('#项目'));assert.ok(!text.includes(result.summary));
 }],
 ['empty and very large content produce bounded results without mutating inputs',()=>{
  assert.equal(A.arrange('',[]).summary,'');const content='完整项目计划需要逐项校验数据一致性。\nTODO: 校验资料\n'.repeat(4000);const result=A.arrange(content,[]);assert.ok(result.summary.length<=360);assert.ok(result.actions.length<=8);assert.ok(result.links.length<=8);assert.ok(result.tags.length<=8);
 }]
];
for(const [name,run]of tests){run();console.log('PASS '+name);}console.log(`${tests.length} local-assistant regression groups passed.`);
