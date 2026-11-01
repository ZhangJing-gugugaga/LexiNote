// Execute the real ArkTS parser through the same DevEco TypeScript loader as core-regression.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.LEXI_TYPESCRIPT || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor/node_modules/typescript');
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const filename = path.resolve(__dirname, '../../entry/src/main/ets/core', name + '.ets');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  const mod = {exports:{}};
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', {filename})(spec => {
    if (spec.startsWith('./')) return load(spec.slice(2));
    throw new Error('Unexpected import ' + spec);
  }, mod, mod.exports);
  modules.set(name, mod.exports); return mod.exports;
}
const {MarkdownEngine:M} = load('MarkdownEngine');
const {NoteItem} = load('LexiModels');
const cases = [
  ['note-card previews render inline styles without exposing Markdown source', () => {
    const note=new NoteItem();note.title='复习';note.content='# 复习\n**结论**、*强调*、==重点==、~~旧结论~~、`代码`、[[目标|别名]]、[官网](https://example.com)';
    const spans=M.previewSpans(note);const text=spans.map(s=>s.text).join('');
    assert.equal(text,'结论、强调、重点、旧结论、代码、别名、官网');
    for(const kind of ['bold','italic','highlight','strike','code','link','url'])assert.ok(spans.some(s=>s.kind===kind));
    assert.equal(M.extractSnippet(note),text);
  }],
  ['note-card table and task previews contain content rather than delimiters', () => {
    const note=new NoteItem();note.content='| 项目 | 进度 |\n| :--- | ---: |\n| **数学** | 80% |\n\n- [ ] 复习\n- [x] 阅读';
    assert.equal(M.extractSnippet(note),'项目 · 进度；数学 · 80% ☐ 复习 ☑ 阅读');
    assert.ok(!M.extractSnippet(note).includes('|'));assert.ok(!M.extractSnippet(note).includes('---'));
  }],
  ['note-card search snippets retain matched text and styling after long prefixes', () => {
    const note=new NoteItem();note.content='前文'.repeat(100)+'\n\n**搜索目标**后文';
    assert.ok(M.extractSnippet(note,'搜索目标').includes('搜索目标'));assert.ok(M.previewSpans(note,'搜索目标').some(s=>s.kind==='bold'));
    const original=note.content;M.previewSpans(note);assert.equal(note.content,original);
  }],
  ['empty daily-note task placeholders render as interactive checkboxes', () => {
    const blocks=M.parseBlocks('- [ ] \n* [x]\n+ [ ] 待办');
    assert.deepEqual(blocks.map(b=>[b.kind,b.checked,b.text]),[['todo',false,''],['todo',true,''],['todo',false,'待办']]);
  }],
  ['tables preserve escaped pipes, inline code pipes, alignment, and source lines', () => {
    const blocks = M.parseBlocks('# 前言\n\n| 名称 | 说明 | 数值 |\n| :--- | :---: | ---: |\n| a\\|b | `x|y` | 8 |\n| **学习** | ==重点== | 9 |\n\n下一行');
    assert.deepEqual(blocks.map(b => b.kind), ['h1','table','paragraph']);
    const table = M.tableData(blocks[1]);
    assert.deepEqual(table.alignments, ['left','center','right']);
    assert.deepEqual(table.rows[1], ['a|b','`x|y`','8']);
    assert.equal(blocks[1].lineIndex, 2); assert.equal(blocks[2].lineIndex, 7);
  }],
  ['tables without outer pipes and ragged rows remain usable', () => {
    const blocks = M.parseBlocks('项目 | 数量\n--- | ---:\n苹果 | 3\n香蕉 |\n');
    assert.equal(blocks.length,1); assert.equal(blocks[0].kind,'table');
    assert.deepEqual(M.tableData(blocks[0]).rows[2],['香蕉','']);
    assert.equal(M.parseBlocks('a | b\n---\n')[0].kind,'paragraph');
  }],
  ['ordered lists and horizontal rules are distinct from bullets', () => {
    const blocks = M.parseBlocks('1. 第一步\n7) 第七步\n- 项目\n---\n* * *\n___');
    assert.deepEqual(blocks.map(b => b.kind),['ordered','ordered','bullet','hr','hr','hr']);
    assert.equal(blocks[1].meta,'7'); assert.equal(blocks[1].text,'第七步');
  }],
  ['inline styles retain labels and navigable anchors', () => {
    const spans = M.inlineSpans('**粗体** *斜体* ==重点== ~~完成~~ `[[源码]]` [[目标#章节|别名]] [官网](https://example.com)');
    const marked = spans.filter(s => s.kind !== 'text');
    assert.deepEqual(marked.map(s => s.kind),['bold','italic','highlight','strike','code','link','url']);
    assert.equal(marked[4].text,'[[源码]]'); assert.equal(marked[5].text,'别名');
    assert.equal(marked[5].target,'目标#章节'); assert.equal(marked[6].target,'https://example.com');
    assert.equal(marked[6].text,'官网');
  }],
  ['image blocks support Markdown and Obsidian attachment syntax', () => {
    const blocks = M.parseBlocks('![图示](assets/a.png "说明")\n![[assets/b.jpg]]\n![[目标#章节|摘要]]');
    assert.deepEqual(blocks.map(b => b.kind),['image','image','embed']);
    assert.equal(blocks[0].meta,'assets/a.png'); assert.equal(blocks[2].meta,'目标#章节');
    assert.equal(blocks[2].text,'摘要');
  }],
  ['images resolve relative to the note and reject executable URI schemes', () => {
    assert.equal(M.resolveImageSource('../附件/a%20b.png','/vault/project/笔记.md'),'file:///vault/附件/a b.png');
    assert.equal(M.resolveImageSource('images/a.png','file:///vault/笔记.md'),'file:///vault/images/a.png');
    assert.equal(M.resolveImageSource('https://example.com/a.png',''),'https://example.com/a.png');
    assert.equal(M.resolveImageSource('javascript:alert(1)','/vault/a.md'),'');
    assert.equal(M.resolveImageSource('a.png',''),'');
  }],
  ['frontmatter is hidden without losing outline and task source offsets', () => {
    const source = '---\ntags: [学习]\ntitle: 标题\n---\n# 正文\n- [ ] 待办';
    const blocks = M.parseBlocks(source);
    assert.deepEqual(blocks.map(b => b.kind),['h1','todo']);
    assert.equal(blocks[0].lineIndex,4); assert.equal(blocks[1].lineIndex,5);
    assert.equal(M.extractOutline(source)[0].lineIndex,4);
  }],
  ['untitled notes and snippets use body text rather than YAML metadata', () => {
    const note = new NoteItem();note.content='---\nsecret: 不应出现在摘要\ntags: [学习]\n---\n# 真正标题\n正文';
    assert.equal(M.displayTitle(note),'真正标题');assert.ok(!M.extractSnippet(note).includes('secret'));
    assert.ok(!M.extractSnippet(note).includes('不应出现在摘要'));
  }],
  ['embedded sections stop at the next peer heading and never recurse', () => {
    const source = '# 总览\n概述\n## 关键 概念\n第一段\n### 细节\n第二段\n## 下节\n不应出现';
    assert.equal(M.extractEmbeddedSection(source,'关键-概念'),'第一段\n### 细节\n第二段');
    assert.equal(M.extractEmbeddedSection(source,'缺失'),'');
    assert.ok(!M.extractEmbeddedSection('![[自身]]','').includes('undefined'));
  }],
  ['code blocks remain literal and headings H4 through H6 enter the outline', () => {
    const blocks = M.parseBlocks('```ts\n**raw**\n1. code\n```\n#### 四级 #\n###### 六级');
    assert.equal(blocks[0].text,'**raw**\n1. code'); assert.equal(blocks[0].kind,'code');
    assert.deepEqual(M.extractOutline('#### 四级 #\n###### 六级').map(h => [h.level,h.title]),[[4,'四级'],[6,'六级']]);
  }],
];
for (const [name,run] of cases) { run(); console.log('PASS '+name); }
console.log(`${cases.length} Markdown 1.1.0 regression cases passed.`);
