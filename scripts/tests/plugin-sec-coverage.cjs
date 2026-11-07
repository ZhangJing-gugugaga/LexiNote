#!/usr/bin/env node
'use strict';
// P1-009(R33) · RFC §13.4 SEC 覆盖矩阵门禁(机器可对账)。
//
//   node scripts/tests/plugin-sec-coverage.cjs
//
// 把 RFC §13.4 的 SEC-001..018 逐条映射到当前证据并逐条复核:
//   offline = { 门禁脚本, 用例 needle 数组 }——每个 needle 必须仍出现在该门禁源码里
//             (断言被删/改名 = 矩阵红,这就是「已覆盖项回归即红」的机制);
//   device  = { label, probe needle 数组 }——每个 probe 必须仍出现在工程记录
//             (PROGRESS/TEST_MATRIX/RELEASE_READINESS/EXECUTION_PLAN)里,证据指针
//             不许静默腐烂。
// verdict 语义(诚实优先,不许Fake覆盖):
//   covered  = 离线正/负用例进门禁 + 该攻击场景在设备上有「实际攻击被拒」的负例证据;
//   partial  = 离线证据在案,但设备证据缺失/不全 或 某执行面未收敛——必须写明 blocker
//              (指名待办任务或 B-编号),不允许空泛的「待办」;
//   uncovered= 完全没有离线用例——本门禁直接红(P1-009 验收行:每条 SEC 有正/负用例,
//              进 release-gate;若未来 RFC 新增 SEC 且确实无离线面,应显式改本门禁的
//              验收语义,而不是静默吞掉)。
// 本门禁不重新执行各门禁(它们由 release-gate --ci 的独立步骤跑);这里对账的是
// 「SEC→证据」这张映射本身,防两头漂移:门禁删用例、工程记录删证据,任一侧动了都红。
//
// 真机口径(2026-11-07,R33/P1-010 审计):设备证据=Round 9 PoC verdict(contexts=2/2,
// vectors blocked, credentialHits=0)、Round 24 双插件并发、Round 26 flows 安装链、
// Round 28 业务路径 SEC 探针 10/10 blocked;其余各 SEC 的设备负例待批次(逐条写明)。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const GATES = path.join(ROOT, 'scripts', 'tests');
const RFC = path.join(ROOT, 'rfcs', 'third-party-plugin-ecosystem-rfc.md');
const IMPL = path.join(ROOT, 'rfcs', 'implementation');
const EVIDENCE_DOCS = ['PROGRESS.md', 'TEST_MATRIX.md', 'RELEASE_READINESS.md', 'EXECUTION_PLAN.md']
  .map((name) => path.join(IMPL, name));

let passed = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) { passed++; return; }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function section(name) { console.log('== ' + name + ' =='); }

// ---------------------------------------------------------------- RFC §13.4 全集(活体解析)
function rfcSecIds() {
  const text = fs.readFileSync(RFC, 'utf8');
  const start = text.indexOf('## 13.4 安全测试');
  const end = text.indexOf('## 13.5 兼容性测试');
  if (start < 0 || end < 0 || end <= start) { throw new Error('RFC §13.4 定位失败'); }
  const ids = [];
  const re = /\|\s*(SEC-\d{3})\s*\|/g;
  let m;
  while ((m = re.exec(text.slice(start, end)) ) !== null) {
    if (ids.indexOf(m[1]) < 0) { ids.push(m[1]); }
  }
  return ids;
}

// ---------------------------------------------------------------- 覆盖矩阵(单一真源)
// needle 约定:原样子串。"ok('S4 " 钉 context-isolation 的 S4 断言名;'"parent-dom"'
// 钉 dist-regression 探针向量清单的字面量;文案 needle 钉行为级断言的可读文本。
const MATRIX = [
  {
    id: 'SEC-001', title: '父窗口 DOM 访问', verdict: 'covered',
    offline: [
      { gate: 'plugin-context-isolation.cjs', cases: ["ok('S4 ", "ok('S5 ", "ok('S6 ", "ok('S14 ", "ok('S11 ", "ok('E1c ", "ok('E1d "] },
      { gate: 'plugin-dist-regression.cjs', cases: ["'parent-dom'", "'window-opener'"] }
    ],
    device: [
      { label: 'R9 PoC verdict(载体)', probes: ['PoC verdict: PASS contexts=2/2', 'credentialHits=0'] },
      { label: 'R28 业务路径探针', probes: ['parent-dom', '"blockedCount":10'] }
    ],
    blocker: '', note: 'sandbox 属性五件套+宿主页全局清零(离线);opaque origin 双真机轮次负例'
  },
  {
    id: 'SEC-002', title: '宿主全局对象访问', verdict: 'partial',
    offline: [
      { gate: 'plugin-bridge-security.cjs', cases: ["ok('R1a ", "ok('R5a ", "ok('R6f ", "ok('R6g ", "ok('R7a ", "ok('R7d ", "ok('R8g.1 "] },
      { gate: 'plugin-context-isolation.cjs', cases: ["ok('S14 ", "ok('S26 ", "ok('S28 ", "ok('S31b "] },
      { gate: 'plugin-identity-delivery.cjs', cases: ['KNOWN_GAPS = []', '--strict'] }
    ],
    device: [
      { label: 'R9+R28 探针(沙箱轨)', probes: ['credentialHits=0', '"blockedCount":10'] }
    ],
    blocker: 'Track2 工作区页执行面收敛前,「宿主对象不可达」仅在沙箱轨+宿主面成立(P1-004/ADR-R29-01 待人工评审;视图/设置叶面切片未完=P1-003b 剩余面)',
    note: '设备负例=沙箱轨探针 parent-globals/function-escape 向量全阻断'
  },
  {
    id: 'SEC-003', title: '跨插件 iframe 访问', verdict: 'covered',
    offline: [
      { gate: 'plugin-context-isolation.cjs', cases: ["ok('S7 ", "ok('S11 ", "ok('S12 ", "ok('S13 ", "ok('S41a "] },
      { gate: 'plugin-dist-regression.cjs', cases: ["'sibling-iframe'"] }
    ],
    device: [
      { label: 'R24 双插件并发', probes: ['双插件并发'] },
      { label: 'R28 业务路径探针', probes: ['sibling-iframe'] },
      { label: 'R9 双上下文', probes: ['PoC verdict: PASS contexts=2/2'] }
    ],
    blocker: '', note: 'per-plugin iframe+独立 MessageChannel;双 iframe 并发真机帧交错零丢失(R24)'
  },
  {
    id: 'SEC-004', title: 'Session Token 获取', verdict: 'covered',
    offline: [
      { gate: 'plugin-bridge-security.cjs', cases: ["ok('R2b ", "ok('R2c ", "ok('R2d ", "ok('R5a ", "ok('R6b ", "ok('R6e ", "ok('R6f ", "ok('R7a ", "ok('R7d ", "ok('R8e "] },
      { gate: 'net-request-url.cjs', cases: ["ok('4.1 ", "ok('5.1 "] },
      { gate: 'plugin-context-isolation.cjs', cases: ["ok('S30c "] },
      { gate: 'plugin-identity-delivery.cjs', cases: ['KNOWN_GAPS = []', '--strict'] }
    ],
    device: [
      { label: 'R28 凭据扫描向量', probes: ['credential-hunt', 'credentialHits=0'] }
    ],
    blocker: '', note: '公共面无令牌读回/WeakMap 归属/CSPRNG(离线);设备 window 凭据扫描 0 命中×2 轮'
  },
  {
    id: 'SEC-005', title: '伪造 pluginId', verdict: 'partial',
    offline: [
      { gate: 'plugin-context-registry.cjs', cases: ["ok('R1.1 ", "ok('R3.1 ", "ok('R3.2 ", "ok('D3 "] },
      { gate: 'plugin-bridge-security.cjs', cases: ["ok('R3a ", "ok('R3b "] },
      { gate: 'plugin-authz-matrix.cjs', cases: ["ok('M2.14 ", "ok('M4.10 "] },
      { gate: 'net-request-url.cjs', cases: ["ok('5.1 ", "ok('5.2 "] }
    ],
    device: [],
    blocker: '设备负例未跑:伪造身份/越权帧的真机拒绝断言待设备批次(R33 登记);离线行为级(registry 反查剥离伪造 id+owner 域拒+网关双闸先于身份解析)已全绿',
    note: 'R28 探针帧全部携带宿主铸造身份,佐证铸造面但不构成伪造负例'
  },
  {
    id: 'SEC-006', title: '跨插件存储读取', verdict: 'partial',
    offline: [
      { gate: 'plugin-authz-matrix.cjs', cases: ["ok('M2.5 ", "ok('M2.32 ", "ok('M2.33 ", "ok('M2.45 "] },
      { gate: 'plugin-context-registry.cjs', cases: ["ok('R3.1b "] },
      { gate: 'plugin-dist-regression.cjs', cases: ['data.* 必须与 vault.write 解绑', 'SEC runtime gates 行为级'] }
    ],
    device: [],
    blocker: '设备负例未跑:跨插件存储归属(他人 data.json 不可达)的真机断言待设备批次;设备现证仅 opaque-origin 存储 API 面(R28 opaque-storage 向量 blocked),RPC 存储面负例不在其中',
    note: '宿主按记录身份归属私有存储、无插件可给 key(R3.1b/R33);data 域与 vault.write 解绑(P2-003)'
  },
  {
    id: 'SEC-007', title: '跨插件命令删除', verdict: 'partial',
    offline: [
      { gate: 'plugin-authz-matrix.cjs', cases: ["ok('M2.14 ", "ok('M2.15 ", "ok('M2.17 ", "ok('M2.18 ", "ok('M2.39 ", "ok('M3.4 "] },
      { gate: 'plugin-bridge-security.cjs', cases: ["ok('R8a ", "ok('R8b ", "ok('R8g.1 ", "ok('R8g.2 ", "ok('R8g.3 ", "ok('R8g.5 "] }
    ],
    device: [],
    blocker: '设备负例未跑:跨插件命令删除/盗用通道凭据的真机拒绝断言待设备批次(R8g 族为 vm 行为级,R30 落地待设备复核)',
    note: 'owner 域归属判定+dispatch 一次性通道凭据(裸调/伪凭据/重放/换绑定 fail-closed)'
  },
  {
    id: 'SEC-008', title: '未授权 Vault 写入', verdict: 'partial',
    offline: [
      { gate: 'plugin-authz-matrix.cjs', cases: ["ok('M2.22 ", "ok('M2.23 ", "ok('M2.24 ", "ok('M2.40 "] },
      { gate: 'plugin-manifest-v2.cjs', cases: ["ok('V5.6 ", "ok('V5.9 "] },
      { gate: 'plugin-dist-regression.cjs', cases: ['SEC runtime gates 行为级'] }
    ],
    device: [],
    blocker: '设备负例未跑:未授权 vault 写的真机拒绝断言待设备批次(fsGate 行为级=R33 新增:无 fs 域拒/白名单外拒/v1 语义放行逐格)',
    note: 'capability 域门+P2-004 写路径白名单两层纵深,离线真跑'
  },
  {
    id: 'SEC-009', title: '路径穿越', verdict: 'partial',
    offline: [
      { gate: 'plugin-package-verifier.cjs', cases: ["ok('A1.2 ", "ok('A1.4 "] },
      { gate: 'plugin-manifest-v2.cjs', cases: ["ok('V5.7 ", "ok('V5.8 "] },
      { gate: 'plugin-context-registry.cjs', cases: ["ok('D3 "] },
      { gate: 'plugin-dist-regression.cjs', cases: ['SEC runtime gates 行为级'] }
    ],
    device: [],
    blocker: '设备负例未跑:穿越路径真机拒绝断言待设备批次;离线四层(包面 A1.2/A1.4、读白名单 V5.7/V5.8、写 gate 穿越形态拒、销毁序「吊销先于路径判定」D3)已绿',
    note: 'P1-008 销毁序把穿越帧挡在身份/fs 层之前(D3)'
  },
  {
    id: 'SEC-010', title: '未授权网络请求', verdict: 'covered',
    offline: [
      { gate: 'net-request-url.cjs', cases: ["ok('1.1 ", "ok('2.1 ", "ok('4.2 ", "ok('5.2 ", "ok('7.1 ", "step('P2-006a ", "ok('8b.1 ", "ok('8b.5 ", "ok('8b.7 ", "ok('10.2 "] },
      { gate: 'plugin-authz-matrix.cjs', cases: ["ok('M2.30 ", "ok('M2.31 "] },
      { gate: 'plugin-dist-regression.cjs', cases: ['network：没声明被拒'] }
    ],
    device: [
      { label: 'R28 直接外传向量', probes: ['network-fetch'] }
    ],
    blocker: '', note: '设备=fetch/XHR 直连被 CSP 拒(R28);宿主代理面 origin/method/size/identity/timeout 全套行为级(离线 83 断言,R33 起进 release-gate)。代理面设备负例随下批设备补(不构成开口:代理面由宿主进程独占执行)'
  },
  {
    id: 'SEC-011', title: '大请求资源耗尽', verdict: 'partial',
    offline: [
      { gate: 'net-request-url.cjs', cases: ["step('P2-006c ", "step('P2-006d ", "ok('8b.5 ", "ok('8b.7 "] },
      { gate: 'plugin-package-verifier.cjs', cases: ["ok('A1.6 ", "ok('A1.7 ", "ok('A1.8 ", "ok('A1.9 ", "ok('A1.14 "] },
      { gate: 'plugin-dist-regression.cjs', cases: ['P2-005: 配额 gate 必须存在', 'SEC runtime gates 行为级'] },
      { gate: 'plugin-manifest-v2.cjs', cases: ["ok('V5.5 "] },
      { gate: 'plugin-permission-store.cjs', cases: ["ok('P5.3 "] }
    ],
    device: [],
    blocker: '设备负例未跑:大载荷/配额超限的真机断言待设备批次;storageQuotaGate 行为级=R33 新增(超限拒/边界放/v1 无配额),设备面未验',
    note: '网络请求/响应字节上限(P2-006c/d 行为级)+包预算双条件+存储配额指纹化(P5.3)'
  },
  {
    id: 'SEC-012', title: 'RPC 超时', verdict: 'partial',
    offline: [
      { gate: 'net-request-url.cjs', cases: ["ok('10.2 ", "ok('11.1 "] },
      { gate: 'plugin-dist-regression.cjs', cases: ['SEC-012 RPC 超时行为级'] },
      { gate: 'plugin-lifecycle-once.cjs', cases: ["ok('L6.7 ", "ok('L9.4 "] }
    ],
    device: [],
    blocker: '设备负例未跑:真机 RPC 超时/挂起恢复断言待设备批次;withTimeout 行为级=R33 新增(永不完成→超时拒绝带标签/慢工作被超时胜出/快工作原样交付)',
    note: 'net_timeout 与 transport_failed 可区分(net-request-url);生命周期等待快速失败=P1-008 清 pending(L9.4)'
  },
  {
    id: 'SEC-013', title: '恶意插件卸载残留', verdict: 'partial',
    offline: [
      { gate: 'plugin-context-registry.cjs', cases: ["ok('D1 ", "ok('D2 ", "ok('D3 ", "ok('D4 ", "ok('D5 ", "ok('D6 ", "ok('D7 ", "ok('D8 "] },
      { gate: 'plugin-context-isolation.cjs', cases: ["ok('S41a ", "ok('S41b ", "ok('S41c ", "ok('S41d "] },
      { gate: 'plugin-lifecycle-once.cjs', cases: ["ok('L9.1 ", "ok('L9.2 ", "ok('L9.5 ", "ok('L9.6 "] }
    ],
    device: [],
    blocker: '设备负例未跑:卸载→旧通道 RPC 真机拒绝(P1-008 验收行的设备半边,R32/R33 登记待批次,归 P4-005/后续设备轮)',
    note: 'D 组在真实 registry+broker+gateway 上重演完整销毁闭环(离线行为级 8 例)'
  },
  {
    id: 'SEC-014', title: '签名篡改', verdict: 'partial',
    offline: [
      { gate: 'plugin-package-verifier.cjs', cases: ["ok('A2.1 ", "ok('A2.2 ", "ok('A2.4 ", "ok('A2.6 ", "ok('A2.5 "] },
      { gate: 'plugin-dist-regression.cjs', cases: ['篡改一个字节 → integrity_mismatch'] },
      { gate: 'plugin-registry-trust.cjs', cases: ["ok('T2.8 "] }
    ],
    device: [
      { label: 'R8 flows 篡改包', probes: ['integrity_mismatch 零残留'] }
    ],
    blocker: 'authenticity 半边=B-002(生产签名密钥/root 信任锚未建立,P5-002/009 未接):哈希完整性(离线真目录+设备 flows)与签名模型(离线 A2)已绿,生产签名链不可测',
    note: '设备负例=篡改包 UI integrity_mismatch 且不留半装目录'
  },
  {
    id: 'SEC-015', title: '元数据回滚', verdict: 'partial',
    offline: [
      { gate: 'plugin-registry-trust.cjs', cases: ["ok('T1.1 ", "ok('T2.2 ", "ok('T2.3 ", "ok('T2.8 "] },
      { gate: 'plugin-update-policy.cjs', cases: ["ok('U1.1 "] }
    ],
    device: [],
    blocker: '发布链未接 TUF/签名快照持久化(P5-002,B-002):设备侧不存在可回滚的真实元数据链;离线模型级负例已绿(targets 版本回滚拒绝 T2.3/过期拒绝 T2.2)',
    note: 'lastSeen 单调推进的模型面在 registry-trust 真跑'
  },
  {
    id: 'SEC-016', title: '插件版本降级', verdict: 'partial',
    offline: [
      { gate: 'plugin-update-policy.cjs', cases: ["ok('U1.3 ", "ok('W1.1 ", "ok('W1.2 "] },
      { gate: 'plugin-dist-regression.cjs', cases: ['降级必须被拦'] }
    ],
    device: [],
    blocker: '设备负例未跑:降级安装的真机拒绝断言待设备批次(设备现证=回滚正向流程 R8/R26,非降级攻击负例);同版本异哈希不对称未修(P5-010,依赖 P5-002)',
    note: 'ERR_DOWNGRADE_BLOCKED 语义+安装器接线离线真跑'
  },
  {
    id: 'SEC-017', title: '发布者密钥撤销', verdict: 'partial',
    offline: [
      { gate: 'plugin-registry-trust.cjs', cases: ["ok('T2.6 "] },
      { gate: 'plugin-update-policy.cjs', cases: ["ok('U1.7 "] }
    ],
    device: [],
    blocker: '撤销数据源未接生产(P5-003;信任链 P5-002/009=B-002):离线模型级负例已绿(撤销列表命中拒绝 T2.6/U1.7),真实发布链的真伪撤销不可测',
    note: '两个消费点(registry 校验+更新策略)都已接模型级撤销判定'
  },
  {
    id: 'SEC-018', title: '恶意依赖与包内容', verdict: 'partial',
    offline: [
      { gate: 'plugin-package-verifier.cjs', cases: ["ok('A1.2 ", "ok('A1.4 ", "ok('A1.9 ", "ok('A1.10 ", "ok('A1.11 ", "ok('A1.12 ", "ok('A1.13 ", "ok('A1.14 "] },
      { gate: 'plugin-dist-audit.cjs', cases: ["id: 'malicious-plugin', dir: MALICIOUS_ROOT, expect: 'critical'"] }
    ],
    device: [
      { label: 'R26 flows 安装链(正向)', probes: ['install 19/0'] }
    ],
    blocker: '包结构负例(zip 炸弹/symlink/非白名单二进制)待设备批次(未单独上真机;设备现证=哈希链四流程 R8/R26+篡改拒绝);插件为单包无外部依赖解析面,RFC §8.4 白名单制离线真跑',
    note: '预算/穿越/symlink/炸弹/扩展名白名单全套行为级(A1 组)'
  }
];

// ---------------------------------------------------------------- 校验
const docTexts = EVIDENCE_DOCS
  .map((file) => ({ file, text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' }));
function evidenceHit(needle) {
  return docTexts.some((doc) => doc.text.indexOf(needle) >= 0);
}
function gateSource(gate) {
  const file = path.join(GATES, gate);
  if (!fs.existsSync(file)) { return null; }
  return fs.readFileSync(file, 'utf8');
}

function main() {
  let rfcIds = [];
  try {
    rfcIds = rfcSecIds();
  } catch (error) {
    console.error('plugin-sec-coverage: FAIL (RFC 解析) — ' + error.message);
    return 1;
  }
  section('RFC §13.4 对账');
  const matrixIds = MATRIX.map((row) => row.id);
  ok('RFC §13.4 条目全部入矩阵(' + rfcIds.length + ' 条)', rfcIds.length > 0 &&
    rfcIds.every((id) => matrixIds.indexOf(id) >= 0),
    rfcIds.filter((id) => matrixIds.indexOf(id) < 0).join(', ') || 'ok');
  ok('矩阵无 RFC 之外的孤儿条目', matrixIds.every((id) => rfcIds.indexOf(id) >= 0),
    matrixIds.filter((id) => rfcIds.indexOf(id) < 0).join(', ') || 'ok');

  section('证据对账(offline 门禁 needle / device 工程记录 needle)');
  const counts = { covered: 0, partial: 0, uncovered: 0 };
  const uncoveredList = [];
  const rows = [];
  for (const row of MATRIX) {
    counts[row.verdict] = (counts[row.verdict] || 0) + 1;
    if (row.verdict === 'uncovered') { uncoveredList.push(row.id); }
    // verdict 结构规则。
    ok(row.id + ' verdict 合法', ['covered', 'partial', 'uncovered'].indexOf(row.verdict) >= 0, row.verdict);
    ok(row.id + ' 离线证据非空', Array.isArray(row.offline) && row.offline.length > 0);
    if (row.verdict === 'partial') {
      ok(row.id + ' partial 必须写明 blocker(指名任务/B-编号)',
        typeof row.blocker === 'string' && row.blocker.length > 0 && /P\d-\d+|B-\d+|设备批次|待设备/.test(row.blocker),
        row.blocker || '(空)');
    }
    if (row.verdict === 'covered') {
      ok(row.id + ' covered 必须有设备证据条目', Array.isArray(row.device) && row.device.length > 0);
    }
    // offline needle 逐条对账(回归探测核心:断言被删/改名 → 这里红)。
    for (const entry of row.offline || []) {
      const source = gateSource(entry.gate);
      ok(row.id + ' 门禁在库: ' + entry.gate, source !== null, entry.gate + ' 不存在于 scripts/tests/');
      if (source === null) { continue; }
      for (const needle of entry.cases) {
        ok(row.id + ' ' + entry.gate + ' ⇐ ' + JSON.stringify(needle.length > 42 ? needle.slice(0, 42) + '…' : needle),
          source.indexOf(needle) >= 0, 'needle 不在门禁源码中(用例被删/改名?)');
      }
    }
    // device probe 逐条对账(证据指针不许腐烂)。
    for (const entry of row.device || []) {
      for (const probe of entry.probes) {
        ok(row.id + ' 设备证据[' + entry.label + '] ⇐ ' + JSON.stringify(probe),
          evidenceHit(probe), 'probe 不在 PROGRESS/TEST_MATRIX/RELEASE_READINESS/EXECUTION_PLAN 中(证据指针腐烂?)');
      }
    }
    const gateNames = (row.offline || []).map((entry) => entry.gate.replace(/^plugin-/, '').replace(/\.cjs$/, '') + '(' + entry.cases.length + ')').join('+');
    const deviceNames = (row.device || []).map((entry) => entry.label).join('、') || '待批次';
    rows.push({ id: row.id, title: row.title, verdict: row.verdict, gates: gateNames, device: deviceNames, blocker: row.blocker });
  }

  section('SEC 覆盖矩阵(RFC §13.4 全表)');
  for (const row of rows) {
    const mark = row.verdict === 'covered' ? '✔' : (row.verdict === 'partial' ? '◐' : '✘');
    console.log('  ' + mark + ' ' + row.id + ' ' + row.title + ' [' + row.verdict + ']');
    console.log('      离线: ' + row.gates);
    console.log('      设备: ' + row.device);
    if (row.blocker) { console.log('      缺口: ' + row.blocker); }
  }

  section('结论');
  console.log('  covered=' + counts.covered + ' partial=' + counts.partial + ' uncovered=' + (counts.uncovered || 0) +
    ' / RFC §13.4 共 ' + rfcIds.length + ' 条');
  ok('无 uncovered 条目(P1-009 验收:每条 SEC 有正/负用例)', counts.uncovered === 0,
    'uncovered: ' + uncoveredList.join(', '));
  console.log('[summary] 通过 ' + passed + ' 项 / 失败 ' + failures.length + ' 项');
  if (failures.length > 0) {
    console.error('plugin-sec-coverage: FAIL (' + failures.length + ')');
    for (const failure of failures) { console.error('  - ' + failure); }
    return 1;
  }
  console.log('plugin-sec-coverage: PASS');
  return 0;
}

if (require.main === module) { process.exitCode = main(); }
module.exports = { MATRIX, rfcSecIds };
