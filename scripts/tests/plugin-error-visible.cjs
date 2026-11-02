#!/usr/bin/env node
// Gate: 装载失败必须是可见的失败态,而且"没失败"必须渲染成正常。
// 判据(每条都固化成断言):
//   errorState 为空          -> normal,界面不得出现任何失败文案(反向断言)
//   版本闸门拒绝(errorState 带"本应用模拟 Obsidian API")
//                            -> compat,摘要里不许重复"插件版本不兼容: <id> —" 前缀
//   运行时装载失败(带"沙箱不支持模块"/"onload")
//                            -> load,摘要保留原因原文
//   其它原因(缺 main.js 等) -> other
//   摘要永远单行且 <= 80 字符(含省略号),完整原因留在 errorState 原文
// 另有静态断言锁住两条真实路径:onload 失败不被"已启用"分支抹掉、市场行渲染失败摘要。
// 设置页与市场必须同一口径:设置页 import 的是市场那三个纯函数(同一模块文件),
// 组合结果按市场纯函数求值逐字符对比,且 errorState 为空时仍是"已启用 · v<版本>"。
// 用法: node scripts/tests/plugin-error-visible.cjs
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..', '..');
const MARKET_SRC = path.join(REPO, 'entry', 'src', 'main', 'ets', 'components', 'plugin', 'LexiPluginMarketSheet.ets');
const RUNTIME_SRC = path.join(REPO, 'entry', 'src', 'main', 'ets', 'core', 'plugin', 'LexiPluginRuntime.ets');
const SETTINGS_SRC = path.join(REPO, 'entry', 'src', 'main', 'ets', 'components', 'LexiSettingsTab.ets');

const TS_CANDIDATES = [
  process.env.LEXI_TYPESCRIPT,
  'E:/dev-tools/harmonyos/command-line-tools/hvigor/hvigor/node_modules/typescript',
  path.join(REPO, 'oh_modules', 'typescript'),
  'typescript'
].filter((candidate) => Boolean(candidate));
function loadTypeScript() {
  for (const candidate of TS_CANDIDATES) {
    try { return require(candidate); } catch { /* next */ }
  }
  throw new Error('找不到 typescript:请设置 LEXI_TYPESCRIPT');
}

const marketText = fs.readFileSync(MARKET_SRC, 'utf8');
const runtimeText = fs.readFileSync(RUNTIME_SRC, 'utf8');
const settingsText = fs.readFileSync(SETTINGS_SRC, 'utf8');

/** 从 .ets 里取出一个顶层函数(按花括号配对),拼成可求值的纯函数单元。 */
function extractFunction(text, name) {
  const head = 'export function ' + name + '(';
  const start = text.indexOf(head);
  if (start < 0) { throw new Error('找不到函数: ' + name); }
  let depth = 0;
  let i = text.indexOf('{', start);
  for (; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '{') { depth += 1; }
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { return text.substring(start, i + 1); }
    }
  }
  throw new Error('函数未闭合: ' + name);
}

const ts = loadTypeScript();
function loadPureFunctions() {
  const names = ['pluginFailureKind', 'pluginFailureLabel', 'pluginFailureSummary'];
  const parts = names.map((name) => extractFunction(marketText, name).replace('export function', 'function'));
  const source = parts.join('\n') + '\nmodule.exports = { ' + names.join(', ') + ' };\n';
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: 'plugin-error-visible.pure.js' })(
    require, mod, mod.exports);
  return mod.exports;
}

const pure = loadPureFunctions();

/** 设置页的失败态组合块(从 failureText 组装到 row.detail 赋值),用于行为等价验证。 */
const COMPOSE_BLOCK = /const failureText: string =[\s\S]*?row\.detail = [^\n]*\n/.exec(settingsText);

/**
 * 用市场那三个纯函数 + 设置页源码里的组合块拼出 settingsDetail(plugin),
 * 这样"设置页给什么文案"是按设置页自己的代码求值,而不是按断言重写一遍。
 */
function loadSettingsComposer() {
  if (!COMPOSE_BLOCK) { throw new Error('设置页找不到 failureText/row.detail 组合块'); }
  const names = ['pluginFailureKind', 'pluginFailureLabel', 'pluginFailureSummary'];
  const parts = names.map((name) => extractFunction(marketText, name).replace('export function', 'function'));
  const source = parts.join('\n') + '\n' +
    'function settingsDetail(plugin) {\n' +
    '  const row = { detail: "" };\n' +
    COMPOSE_BLOCK[0] +
    '  return row.detail;\n' +
    '}\n' +
    'module.exports = { settingsDetail };\n';
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + js + '\n})', { filename: 'plugin-error-visible.settings.js' })(
    require, mod, mod.exports);
  return mod.exports.settingsDetail;
}

const COMPAT = '本应用模拟 Obsidian API 1.14.4，该插件要求 1.15.0';
const LOAD = 'Error: 插件沙箱不支持模块: @codemirror/view(依赖请随 main.js 打包)';

let failed = 0;
let total = 0;
function check(name, fn) {
  total += 1;
  try {
    fn();
    console.log('  ok   #' + total + ' ' + name);
  } catch (error) {
    failed += 1;
    console.log('  FAIL #' + total + ' ' + name);
    console.log('       ' + String((error && error.message) || error).split('\n').join('\n       '));
  }
}

console.log('plugin-error-visible: 纯函数行为(errorState -> 失败态)');
check('空串判为 normal（反向断言：没失败就不许显示失败态）', () => {
  assert.equal(pure.pluginFailureKind(''), 'normal');
  assert.equal(pure.pluginFailureLabel(''), '');
  assert.equal(pure.pluginFailureSummary(''), '');
});
check('纯空白串同样判为 normal', () => {
  assert.equal(pure.pluginFailureKind('  \n\t '), 'normal');
  assert.equal(pure.pluginFailureSummary('  \n\t '), '');
});
check('版本闸门拒绝 -> compat,标签不自称"启用"', () => {
  assert.equal(pure.pluginFailureKind(COMPAT), 'compat');
  const label = pure.pluginFailureLabel(COMPAT);
  assert.ok(label.length > 0);
  assert.ok(!/启用|正常/.test(label), '标签不得含"启用/正常": ' + label);
});
check('版本闸门摘要去掉"插件版本不兼容: <id> —"重复前缀', () => {
  const logStyle = '插件版本不兼容: obsidian-tasks — ' + COMPAT;
  assert.equal(pure.pluginFailureSummary(logStyle), COMPAT);
  assert.ok(!/^插件版本不兼容/.test(pure.pluginFailureSummary(logStyle)));
});
check('运行时装载失败 -> load,标签是"加载失败"', () => {
  assert.equal(pure.pluginFailureKind(LOAD), 'load');
  assert.equal(pure.pluginFailureLabel(LOAD), '加载失败');
});
check('装载失败摘要保留原因原文（沙箱不支持模块）', () => {
  assert.ok(pure.pluginFailureSummary(LOAD).indexOf('沙箱不支持模块') >= 0);
});
check('其它失败原因（缺 main.js）落到 other,也有可见标签', () => {
  assert.equal(pure.pluginFailureKind('插件缺少 main.js'), 'other');
  assert.equal(pure.pluginFailureLabel('插件缺少 main.js'), '不可用');
});
check('摘要单行且 <= 80 字符（超长截断带省略号）', () => {
  const long = 'Error: ' + '沙箱不支持模块:'.repeat(40);
  const summary = pure.pluginFailureSummary(long);
  assert.ok(summary.length <= 80, '摘要长度 ' + summary.length + ' > 80');
  assert.ok(/\n/.test(pure.pluginFailureSummary('Error: a\nb\r\nc')) === false, '摘要不得含换行');
  assert.equal(pure.pluginFailureSummary('Error: a\nb\r\nc'), 'a b c');
});

console.log('plugin-error-visible: 真实路径（静态锚点）');
check('runtime: onload 失败不会被"已启用"分支抹掉', () => {
  const guard = /await LexiWebRuntime\.withTimeout\(done, LOAD_TIMEOUT_MS, 'onload'\);[\s\S]{0,400}?if \(record\.errorState\.length > 0\)[\s\S]{0,200}?return false;[\s\S]{0,300}?record\.enabled = true;/;
  assert.ok(guard.test(runtimeText), 'onload 等待点之后必须回读 errorState 才能置 enabled=true');
  assert.ok(!/await LexiWebRuntime\.withTimeout\(done, LOAD_TIMEOUT_MS, 'onload'\);\s*record\.enabled = true;/.test(runtimeText),
    'onload 等待之后不得直接置 enabled=true');
});
check('runtime: plugin.onload.error 把垫片原文写进 errorState', () => {
  const handler = /runtime\.registerHandler\('plugin\.onload\.error'[\s\S]{0,400}?record\.errorState = rpcString\(request, 'error'\)/;
  assert.ok(handler.test(runtimeText));
});
check('市场:已安装行渲染失败摘要并单行截断', () => {
  assert.ok(/Text\(pluginFailureSummary\(plugin\.errorState\)\)[\s\S]{0,160}?\.maxLines\(1\)/.test(marketText),
    '失败摘要必须以 maxLines(1) 渲染');
});
check('市场:状态行的失败分支在"已启用"分支之前', () => {
  const body = extractFunctionBody(marketText, 'stateLine');
  const failureAt = body.indexOf("pluginFailureKind(plugin.errorState) !== 'normal'");
  const enabledAt = body.indexOf('已启用');
  assert.ok(failureAt >= 0, '状态行必须有失败分支');
  assert.ok(enabledAt >= 0, '状态行必须保留启用/停用分支');
  assert.ok(failureAt < enabledAt, '失败分支必须先于"已启用"判定');
});
check('市场:安装结果区分"装了但加载失败"', () => {
  assert.ok(marketText.indexOf('已安装但加载失败') >= 0, '安装后的状态文案必须能报失败');
  assert.ok(/pluginFailureSummary\(fresh\.errorState\)/.test(marketText));
});
check('市场:失败态不禁用卸载/回滚', () => {
  const enabledCalls = marketText.match(/\.enabled\(!this\.busy\)/g) || [];
  assert.ok(enabledCalls.length >= 2, '卸载/回滚的可点条件应保持 !this.busy');
  assert.ok(!/\.enabled\([^)]*errorState/.test(marketText), '启用条件不得掺入 errorState');
});
check('市场:类别判定不硬编码"版本不兼容"字样', () => {
  const kindBody = extractFunction(marketText, 'pluginFailureKind');
  assert.ok(kindBody.indexOf('本应用模拟 Obsidian API') >= 0, 'compat 类必须按闸门话术锚点识别');
  assert.ok(kindBody.indexOf('版本不兼容') < 0, 'kind 判定不得依赖"版本不兼容"字样');
});

console.log('plugin-error-visible: 设置页与市场同一口径（复用同一纯函数）');
check('设置页:插件行复用 pluginFailureSummary（同一符号），不再直贴 errorState', () => {
  assert.ok(!/row\.detail\s*=\s*plugin\.errorState\b/.test(settingsText),
    '设置页不得把 plugin.errorState 原文直接赋给 row.detail');
  const assign = /row\.detail = [^\n]*\n/.exec(settingsText);
  assert.ok(assign, '设置页找不到 row.detail 赋值');
  assert.ok(assign[0].indexOf('errorState') < 0,
    'row.detail 赋值语句本身不得直接引用 errorState: ' + assign[0].trim());
  const imports = Array.from(settingsText.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g))
    .filter((m) => m[2].charAt(0) === '.');
  const imported = imports.find((m) =>
    path.resolve(path.dirname(SETTINGS_SRC), m[2] + '.ets') === MARKET_SRC);
  assert.ok(imported, '设置页找不到从市场模块 import 的语句: ' + imports.map((m) => m[2]).join(', '));
  assert.ok(imported[1].indexOf('pluginFailure') >= 0, '市场模块的 import 必须含 pluginFailure* 纯函数');
  ['pluginFailureKind', 'pluginFailureLabel', 'pluginFailureSummary'].forEach((name) => {
    assert.ok(imported[1].indexOf(name) >= 0, '设置页 import 缺少 ' + name);
    assert.ok(marketText.indexOf('export function ' + name + '(') >= 0, '市场模块必须导出同名符号 ' + name);
  });
  assert.equal(path.resolve(path.dirname(SETTINGS_SRC), imported[2] + '.ets'), MARKET_SRC,
    '设置页的 import 必须解析到市场那个模块文件: ' + imported[2]);
  ['pluginFailureKind', 'pluginFailureLabel', 'pluginFailureSummary'].forEach((name) => {
    assert.ok(imported[1].indexOf(name) >= 0, '市场模块 import 缺少 ' + name);
  });
  assert.ok(!/\b(const|let|var|function)\s+pluginFailure(Summary|Label|Kind)\b/.test(settingsText),
    '设置页不得镜像/遮蔽一份同名实现');
  const settingsDetail = loadSettingsComposer();
  assert.equal(settingsDetail({ errorState: LOAD, enabled: true, manifest: { version: '8.6.0' } }),
    pure.pluginFailureLabel(LOAD) + ' · ' + pure.pluginFailureSummary(LOAD),
    '设置页组合结果必须逐字符等于市场纯函数的输出');
});
check('设置页:失败文案不含 Error: 前缀且 <= 80 字符（真机原文喂同一纯函数）', () => {
  const settingsDetail = loadSettingsComposer();
  const text = settingsDetail({ errorState: LOAD, enabled: true, manifest: { version: '8.6.0' } });
  assert.ok(text.indexOf('Error:') < 0, '设置页失败文案仍带 Error: 前缀: ' + text);
  assert.ok(text.length <= 80, '设置页失败文案长度 ' + text.length + ' > 80: ' + text);
  assert.ok(text.indexOf('\n') < 0, '设置页失败文案必须单行');
  assert.equal(text, '加载失败 · ' + pure.pluginFailureSummary(LOAD));
});
check('设置页:errorState 为空时 detail 仍是"已启用 · v<版本>"（反向断言）', () => {
  const settingsDetail = loadSettingsComposer();
  assert.equal(settingsDetail({ errorState: '', enabled: true, manifest: { version: '1.0.0' } }), '已启用 · v1.0.0');
  assert.equal(settingsDetail({ errorState: '  \n\t ', enabled: true, manifest: { version: '1.0.0' } }), '已启用 · v1.0.0');
  assert.equal(settingsDetail({ errorState: '', enabled: false, manifest: { version: '1.0.0' } }), '已停用');
  const failureRow = settingsDetail({ errorState: LOAD, enabled: true, manifest: { version: '8.6.0' } });
  assert.ok(failureRow.indexOf('已启用') < 0, '失败行不得同时出现"已启用": ' + failureRow);
});

function extractFunctionBody(text, name) {
  const head = new RegExp('(private|export function|function)\\s+' + name + '\\s*\\(');
  const m = head.exec(text);
  if (!m) { throw new Error('找不到函数: ' + name); }
  const start = text.indexOf('{', m.index);
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '{') { depth += 1; }
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { return text.substring(start, i + 1); }
    }
  }
  throw new Error('函数未闭合: ' + name);
}

console.log('');
console.log('plugin-error-visible: ' + (total - failed) + '/' + total + ' assertions passed');
if (failed > 0) {
  console.log('plugin-error-visible: FAILED ' + failed + ' assertion(s)');
  process.exit(1);
}
console.log('plugin-error-visible: OK');
