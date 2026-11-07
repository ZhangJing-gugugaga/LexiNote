#!/usr/bin/env node
// P4-006 兼容性报告生成器：tools/contract/symbols.json → tools/contract/compat-matrix.md
//
// 逐字节可再生：同输入 → 同字节。无时间戳（生成时间不打戳——打了每次重跑必 diff，违背"报告与
// 契约逐字节可再生"的验收）、符号按字典序、节与字段顺序固定、LF 行尾 + 结尾单换行。
// 报告按 unsupported → stub → partial → implemented 分节（缺口优先：排期看的是 unsupported/缺口），
// 全量符号逐条列出。插件"实际用面"报告（夹具驱动、随夹具集变化、带生成时间）见
// tools/plugins-fixtures/api-surface.report.md —— 本文件与它互补不重复（unify：交叉引用，不复制内容）。
//
// 用法：
//   node tools/contract/report.cjs           # 渲染并写入 tools/contract/compat-matrix.md
//   node tools/contract/report.cjs --check   # 与已入库报告逐字节比对：漂移/缺失 → exit 1
//
// 写入前做双重渲染自检（同一输入渲染两次必须逐字节相同）——渲染器一旦混入非确定源
// （时间、遍历序、Map 序）就地红灯，不产出半确定性的报告。
// 门禁：scripts/tests/plugin-contract-matrix.cjs 会重新渲染并与入库文件逐字节比对
// （漂移检测：改了 symbols.json 不重跑 report.cjs 即红）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SYMBOLS_FILE = path.join(__dirname, 'symbols.json');
const OUT_FILE = path.join(__dirname, 'compat-matrix.md');

// 节顺序：缺口优先（P4-006 的核心是"报告 unsupported"），implemented 收尾。
const SECTIONS = [
  ['unsupported', '完全没导出或明确不做；插件调用会 TypeError 或走 undefined'],
  ['stub', '有导出、能构造，但内部空转或只打日志，插件以为成功实则无效果'],
  ['partial', '主路径通，但有明确缺失点（缺成员、返回值语义不同、只支持部分参数）'],
  ['implemented', '官方签名上的主要用途可用，插件按文档写就能跑通']
];
const OWNERS = ['运行时轨', '宿主轨', '分发轨', '未排期'];
const GAPS = ['low-risk', 'needs-architecture', 'out-of-scope'];
const STATUSES = SECTIONS.map(([status]) => status);
const bySymbol = (a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);

// note 里的换行压成单空格、表格竖线转义——note 文本只影响单元格内容，不许破坏表格结构或引入顺序敏感的字节。
function cell(text) {
  return String(text).replace(/\r\n?/g, '\n').replace(/\n\s*/g, ' ').trim().replace(/\|/g, '\\|');
}

function tally(symbols, key) {
  const out = {};
  for (const s of symbols) {
    const k = key(s);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function render(matrix) {
  if (!matrix || !Array.isArray(matrix.symbols)) {
    throw new Error('symbols.json 缺少 symbols 数组，先跑 node tools/contract/generate.cjs');
  }
  // 防御性排序：渲染结果不得依赖输入文件里的行序（生成器保证字典序，这里再钉一层）。
  const symbols = matrix.symbols.slice().sort(bySymbol);
  const statusCount = tally(symbols, (s) => s.status);
  const gapCount = tally(symbols, (s) => (s.gap === null || s.gap === undefined ? 'null' : s.gap));
  const ownerCount = tally(symbols, (s) => s.owner);

  const lines = [];
  lines.push('# 兼容性矩阵报告（' + matrix.generatedFrom + '）');
  lines.push('');
  lines.push('> 由 `node tools/contract/report.cjs` 从 `tools/contract/symbols.json` 渲染，逐字节可再生：同输入 → 同字节');
  lines.push('> （无时间戳、符号按字典序、节与字段序固定、LF + 结尾单换行）。改了 symbols.json 必须重跑该命令，');
  lines.push('> 否则 `scripts/tests/plugin-contract-matrix.cjs` 的漂移检查红灯。矩阵口径与字段语义见 `tools/contract/README.md`，');
  lines.push('> 权威约束见 `docs/lexinote_plugin_bridge_spec.md` 第 7 节。');
  lines.push('>');
  lines.push('> 本文件是符号级全量矩阵（官方 `obsidian.d.ts` 逐符号定级）；"插件实际用面"报告（夹具驱动、随夹具集变化、');
  lines.push('> 带生成时间）见 `tools/plugins-fixtures/api-surface.report.md` —— 两者互补不重复。');
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push('- 符号总数：' + symbols.length);
  lines.push('- status：' + ['implemented', 'partial', 'stub', 'unsupported'].map((s) => s + ' ' + (statusCount[s] || 0)).join(' / '));
  lines.push('- gap：' + GAPS.map((g) => g + ' ' + (gapCount[g] || 0)).join(' / ') +
    ' / null ' + (gapCount.null || 0) + '（null = implemented 专属）');
  lines.push('- owner：' + OWNERS.map((o) => o + ' ' + (ownerCount[o] || 0)).join(' / '));
  lines.push('');
  lines.push('### status × owner');
  lines.push('');
  lines.push('| status | ' + OWNERS.join(' | ') + ' | 合计 |');
  lines.push('| --- | ' + OWNERS.map(() => '---').join(' | ') + ' | --- |');
  for (const status of ['implemented', 'partial', 'stub', 'unsupported']) {
    const row = symbols.filter((s) => s.status === status);
    const cells = OWNERS.map((o) => String(row.filter((s) => s.owner === o).length));
    lines.push('| ' + status + ' | ' + cells.join(' | ') + ' | ' + row.length + ' |');
  }
  lines.push('');
  for (const [status, blurb] of SECTIONS) {
    const rows = symbols.filter((s) => s.status === status);
    lines.push('## ' + status + '（' + rows.length + '）——' + blurb);
    lines.push('');
    lines.push('| 符号 | kind | gap | owner | note |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const s of rows) {
      lines.push('| `' + s.symbol + '` | ' + s.kind + ' | ' + (s.gap === null || s.gap === undefined ? '—' : '`' + s.gap + '`') +
        ' | ' + s.owner + ' | ' + cell(s.note) + ' |');
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

// 写入路径与门禁共用的自检：同一矩阵渲染两次必须逐字节相同（渲染器混入非确定源即红）。
function renderTwice(matrix) {
  const first = render(matrix);
  const second = render(matrix);
  if (first !== second) {
    throw new Error('渲染器非确定：同一 symbols.json 两次渲染逐字节不同（检查时间/遍历序/Map 序等非确定源）');
  }
  return first;
}

function loadMatrix() {
  if (!fs.existsSync(SYMBOLS_FILE)) {
    console.error('✗ 缺少 tools/contract/symbols.json；先跑 node tools/contract/generate.cjs');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(SYMBOLS_FILE, 'utf8'));
}

function main(argv) {
  if (argv.includes('--check')) {
    const matrix = loadMatrix();
    const fresh = renderTwice(matrix);
    if (!fs.existsSync(OUT_FILE)) {
      console.error('✗ 缺少 tools/contract/compat-matrix.md；跑 node tools/contract/report.cjs 生成并入库');
      return 1;
    }
    const committed = fs.readFileSync(OUT_FILE, 'utf8');
    if (committed === fresh) {
      console.log('✓ 兼容性报告与 symbols.json 逐字节一致（' + matrix.symbols.length + ' 符号，双重渲染自检通过）');
      return 0;
    }
    const cLine = committed.split('\n').length;
    const fLine = fresh.split('\n').length;
    let divergeAt = 0;
    const c = committed.split('\n');
    const f = fresh.split('\n');
    while (divergeAt < c.length && divergeAt < f.length && c[divergeAt] === f[divergeAt]) divergeAt += 1;
    console.error('✗ 兼容性报告漂移：tools/contract/compat-matrix.md 与 symbols.json 的渲染结果不同' +
      '（入库 ' + cLine + ' 行 vs 渲染 ' + fLine + ' 行，首处分歧在第 ' + (divergeAt + 1) + ' 行）');
    console.error('  重跑 node tools/contract/report.cjs 并把 compat-matrix.md 一并入库。');
    return 1;
  }
  const matrix = loadMatrix();
  const fresh = renderTwice(matrix);
  fs.writeFileSync(OUT_FILE, fresh, 'utf8');
  const statusCount = tally(matrix.symbols, (s) => s.status);
  console.log('兼容性报告已写入 tools/contract/compat-matrix.md');
  console.log('  符号: ' + matrix.symbols.length + '（implemented ' + (statusCount.implemented || 0) +
    ' / partial ' + (statusCount.partial || 0) + ' / stub ' + (statusCount.stub || 0) +
    ' / unsupported ' + (statusCount.unsupported || 0) + '）');
  console.log('  确定性: 双重渲染逐字节一致；再跑一次本命令输出应零 diff，--check 与入库文件逐字节比对。');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { SYMBOLS_FILE, OUT_FILE, render, renderTwice };
