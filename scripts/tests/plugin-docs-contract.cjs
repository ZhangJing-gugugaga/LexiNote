'use strict';
// RFC §14 T5.4 文档 · 门禁（对应 §10.4 文档对账）。
//
// 验收目标：外部开发者不修改主仓库即可完成开发/测试/打包/提交——文档与实现逐项对账。
//   D1 八篇文档在库(P0-004:八篇公开开发者文档已纳入 git——.gitignore 逐文件白名单;
//      docs/ 其余内部账面 round 日志/handoff 等仍不入库)。
//   D2 API 参考逐方法覆盖 stable 面(生成物,真源 api-surface.json)。
//   D3 各篇与实现锚点对账(manifest v2 规则/安全错误码/信任链/隐私边界)。
//   D4 桥接规范(lexinote_plugin_bridge_spec)在库。
//
// 用法：node scripts/tests/plugin-docs-contract.cjs

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DOCS = path.join(ROOT, 'docs');

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

section('D1 文档在库');
const docs = ['plugin-api-reference.md', 'plugin-manifest-v2.md', 'plugin-security.md',
  'plugin-marketplace.md', 'plugin-development.md', 'plugin-testing.md',
  'obsidian-compatibility.md', 'plugin-inspector.md'];
for (const doc of docs) {
  ok('D1 ' + doc, fs.existsSync(path.join(DOCS, doc)), '缺少 docs/' + doc);
}

section('D2 API 参考覆盖');
{
  const reference = fs.existsSync(path.join(DOCS, 'plugin-api-reference.md'))
    ? fs.readFileSync(path.join(DOCS, 'plugin-api-reference.md'), 'utf8') : '';
  let surface = null;
  try { surface = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/plugin-contract/api-surface.json'), 'utf8')); }
  catch (e) { surface = null; }
  ok('D2.1 契约快照可解析', surface !== null);
  if (surface !== null) {
    const stable = surface.methods.filter((m) => m.status === 'stable');
    const missing = stable.filter((m) => reference.indexOf('`' + m.method + '`') < 0);
    ok('D2.2 全部 stable 方法入文档(' + stable.length + ' 条)', missing.length === 0,
      '缺: ' + missing.slice(0, 6).map((m) => m.method).join(', '));
    const domains = Object.keys(byDomainOf(surface));
    const missingDomains = domains.filter((d) => reference.indexOf('## ' + d) < 0);
    ok('D2.3 域分节齐备', missingDomains.length === 0, '缺: ' + missingDomains.join(', '));
  }
}
function byDomainOf(surface) {
  const map = {};
  for (const m of surface.methods) { map[m.domain] = true; }
  return map;
}

section('D3 实现锚点对账');
{
  const manifestDoc = fs.existsSync(path.join(DOCS, 'plugin-manifest-v2.md'))
    ? fs.readFileSync(path.join(DOCS, 'plugin-manifest-v2.md'), 'utf8') : '';
  ok('D3.1 manifest v2 文档覆盖关键规则', /manifestVersion/.test(manifestDoc) &&
    /capabilities/.test(manifestDoc) && /sha256/.test(manifestDoc) &&
    /legacyProfile|legacy/.test(manifestDoc));
  const securityDoc = fs.existsSync(path.join(DOCS, 'plugin-security.md'))
    ? fs.readFileSync(path.join(DOCS, 'plugin-security.md'), 'utf8') : '';
  ok('D3.2 安全文档覆盖错误码与信任链', /ERR_PERMISSION_DENIED/.test(securityDoc) &&
    /ERR_SIGNATURE_INVALID/.test(securityDoc) && /root/.test(securityDoc) &&
    /targets/.test(securityDoc));
  const marketplaceDoc = fs.existsSync(path.join(DOCS, 'plugin-marketplace.md'))
    ? fs.readFileSync(path.join(DOCS, 'plugin-marketplace.md'), 'utf8') : '';
  ok('D3.3 市场文档覆盖 targets 与撤销', /targets/.test(marketplaceDoc) && /撤销/.test(marketplaceDoc));
  const inspectorDoc = fs.existsSync(path.join(DOCS, 'plugin-inspector.md'))
    ? fs.readFileSync(path.join(DOCS, 'plugin-inspector.md'), 'utf8') : '';
  ok('D3.4 Inspector 文档声明隐私边界', /session token/.test(inspectorDoc) || /token/.test(inspectorDoc));
  const devDoc = fs.existsSync(path.join(DOCS, 'plugin-development.md'))
    ? fs.readFileSync(path.join(DOCS, 'plugin-development.md'), 'utf8') : '';
  ok('D3.5 开发指南覆盖 CLI 三命令与乐观锁', /lexi plugin create/.test(devDoc) &&
    /lexi plugin validate/.test(devDoc) && /vault_conflict/.test(devDoc));
}

section('D4 桥接规范');
ok('D4.1 lexinote_plugin_bridge_spec 在库', fs.existsSync(path.join(DOCS, 'lexinote_plugin_bridge_spec.md')));

// D5 = P6-001 审核分级清单真源对账：rfcs/plugin-review-tiers.md 的门禁清单必须只引用真实
// release-gate --ci 步骤——清单与 release-gate.cjs gates 数组双向集合对账（门禁改名/增删而
// 清单未跟上 = name drift → 红），步骤数行与实际门禁数一致。清单标记块内的脚本引用是唯一
// 对账面；块外提及不受约束（文档叙事可自由引用手工批次脚本）。
section('D5 审核分级清单对账(P6-001)');
{
  const tiersPath = path.join(ROOT, 'rfcs', 'plugin-review-tiers.md');
  const tiersExists = fs.existsSync(tiersPath);
  ok('D5.1 审核分级文档在库(rfcs/plugin-review-tiers.md)', tiersExists);
  if (tiersExists) {
    const doc = fs.readFileSync(tiersPath, 'utf8');
    const begin = doc.indexOf('<!-- gate-inventory-begin -->');
    const end = doc.indexOf('<!-- gate-inventory-end -->');
    ok('D5.2 清单标记块齐备(gate-inventory-begin/end)', begin >= 0 && end > begin);
    if (begin >= 0 && end > begin) {
      const block = doc.slice(begin, end);
      const releaseGateSrc = fs.readFileSync(path.join(ROOT, 'tools', 'plugin-dist', 'release-gate.cjs'), 'utf8');
      // release-gate.cjs gates 数组条目形如 ['name', 'scripts/tests/x.cjs', ...]；name 元素
      // 可能含字符串拼接（contract-matrix 的 --fixtures-required 后缀），所以先取数组区间再提字面量。
      const arrayStart = releaseGateSrc.indexOf('const gates = [');
      const arrayEnd = arrayStart >= 0 ? releaseGateSrc.indexOf('\n  ];', arrayStart) : -1;
      const gateBody = arrayStart >= 0 && arrayEnd > arrayStart ? releaseGateSrc.slice(arrayStart, arrayEnd) : '';
      const gateSet = new Set();
      const reGate = /'(scripts\/tests\/[^']+\.cjs)'/g;
      let m;
      while ((m = reGate.exec(gateBody)) !== null) { gateSet.add(m[1]); }
      ok('D5.3 门禁数组解析非空(release-gate.cjs gates)', gateSet.size > 0);
      const docSet = new Set();
      const reDoc = /`((?:scripts|tools)\/tests\/[a-z0-9-]+\.cjs)`/g;
      while ((m = reDoc.exec(block)) !== null) { docSet.add(m[1]); }
      const invented = [...docSet].filter((x) => !gateSet.has(x));
      const omitted = [...gateSet].filter((x) => !docSet.has(x));
      ok('D5.4 清单无发明门禁(引用全部真实在库)', invented.length === 0,
        invented.length ? '清单引用但 gates 数组没有: ' + invented.join(', ') : 'ok');
      ok('D5.5 清单无遗漏门禁(gates 数组 ' + gateSet.size + ' 条全部在列)', omitted.length === 0,
        omitted.length ? 'gates 数组有但清单没列: ' + omitted.join(', ') : 'ok');
      const stepLine = (block.match(/release-gate --ci 步骤数: (\d+)/) || [])[1];
      ok('D5.6 步骤数行与实际一致(' + gateSet.size + ' 门禁 + 2 固定步 = ' + (gateSet.size + 2) + ')',
        stepLine === String(gateSet.size + 2), '文档声明: ' + stepLine);
    }
    ok('D5.7 三级定义在文档(Community/Verified/Trusted)', doc.indexOf('Community') >= 0 &&
      doc.indexOf('Verified') >= 0 && doc.indexOf('Trusted') >= 0);
    ok('D5.8 ADR-015 纪律行在(plugins[] 空 + P5-002 + P5-004)', doc.indexOf('ADR-015') >= 0 &&
      doc.indexOf('P5-002') >= 0 && doc.indexOf('P5-004') >= 0 && doc.indexOf('plugins[]') >= 0);
    ok('D5.9 SEC 覆盖矩阵映射节在(SEC 编号锚)', doc.indexOf('SEC-001') >= 0 && doc.indexOf('plugin-sec-coverage.cjs') >= 0);
  }
}

// D6 = P6-003 安全公告与漏洞处理流程对账：rfcs/plugin-security-rfc.md 的模板字段与流程关键
// 语义（embargo/人工发布门/SEC 映射）必须齐备；文档引用的 scripts/tests/*.cjs 必须真实在库。
section('D6 安全流程文档对账(P6-003)');
{
  const secPath = path.join(ROOT, 'rfcs', 'plugin-security-rfc.md');
  const secExists = fs.existsSync(secPath);
  ok('D6.1 安全流程文档在库(rfcs/plugin-security-rfc.md)', secExists);
  if (secExists) {
    const doc = fs.readFileSync(secPath, 'utf8');
    const templateFields = ['LEXINOTE-SEC-', '严重级', 'CVSS', '受影响版本', '缓解措施', '修复版本',
      '时间线', '致谢', '利用状态'];
    const missingFields = templateFields.filter((f) => doc.indexOf(f) < 0);
    ok('D6.2 公告模板字段齐备(' + templateFields.length + ' 项)', missingFields.length === 0,
      '缺: ' + missingFields.join(', '));
    ok('D6.3 embargo 与披露时限在(默认 90 天)', /embargo/i.test(doc) && doc.indexOf('90') >= 0);
    ok('D6.4 发布为人工门(代理不自动 push)', doc.indexOf('人工') >= 0 && doc.indexOf('git push') >= 0);
    ok('D6.5 SEC 编号映射在(RFC §13.4 锚)', doc.indexOf('SEC-001') >= 0 && doc.indexOf('SEC-018') >= 0);
    const reScript = /`((?:scripts|tools)\/tests\/[a-z0-9-]+\.cjs)`/g;
    let m;
    const missingScripts = [];
    while ((m = reScript.exec(doc)) !== null) {
      if (!fs.existsSync(path.join(ROOT, m[1]))) { missingScripts.push(m[1]); }
    }
    ok('D6.6 文档引用的门禁脚本全部在库', missingScripts.length === 0, missingScripts.join(', '));
  }
}

console.log('\n[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
for (const f of failures) { console.log('  ✗ ' + f); }
console.log(failures.length === 0
  ? 'plugin-docs-contract: PASS'
  : 'plugin-docs-contract: FAIL (' + failures.length + ')');
process.exit(failures.length === 0 ? 0 : 1);
