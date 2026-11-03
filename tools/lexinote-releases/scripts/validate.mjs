#!/usr/bin/env node
// lexinote-releases 索引校验(schemaVersion=1 严格口径)。
//
// 规则与 LexiNote 客户端逐条对齐(entry/src/main/ets/core/plugin/LexiPluginMarketModel.ets):
//   * 索引必须是 { schemaVersion: 1, plugins: [...] } 对象;裸数组旧形状在本仓库永久停用;
//   * 每条必填 id/name/version/author/sha256/zipUrl;
//   * id ^[a-z0-9][a-z0-9-]{0,99}$;sha256 为 64 位小写十六进制;zipUrl 必须 https;
//   * 客户端信任闸门(P5-001)对缺哈希条目一律拒绝远程安装——这里在源头同口径拦截,
//     不允许"能过本仓 CI 但装不上"的条目存在。
// --remote 额外下载 zipUrl 实测字节并比对声明 sha256(完整性;来源真实性/TUF 属 P5-002)。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const indexPath = path.join(root, '..', 'community-plugins.json');
const remote = process.argv.includes('--remote');
const errors = [];

const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
if (!index || typeof index !== 'object' || Array.isArray(index)) {
  errors.push('索引必须是对象;裸数组旧形状已停用(客户端仅兼容展示且禁止安装)');
} else if (index.schemaVersion !== 1) {
  errors.push(`schemaVersion 必须为 1(实际 ${String(index.schemaVersion)})`);
}
if (index && !Array.isArray(index.plugins)) { errors.push('缺少 plugins 数组'); }
const entries = index && Array.isArray(index.plugins) ? index.plugins : [];
const seen = new Set();
entries.forEach((entry, position) => {
  const label = entry && typeof entry.id === 'string' && entry.id ? entry.id : `第 ${position} 条`;
  if (!entry || typeof entry !== 'object') { errors.push(`${label}: 条目必须是对象`); return; }
  if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(entry.id)) {
    errors.push(`${label}: id 只允许小写字母、数字与连字符,且不能为空`);
  }
  for (const key of ['name', 'version', 'author']) {
    if (typeof entry[key] !== 'string' || entry[key].trim().length === 0) errors.push(`${label}: 缺少 ${key}`);
  }
  if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    errors.push(`${label}: sha256 必须是 64 位小写十六进制(客户端信任闸门据此拒绝远程安装)`);
  }
  if (typeof entry.zipUrl !== 'string' || !/^https:\/\//i.test(entry.zipUrl)) {
    errors.push(`${label}: zipUrl 必须是 https 地址`);
  }
  if (entry.description !== undefined && typeof entry.description !== 'string') errors.push(`${label}: description 必须是字符串`);
  if (entry.capabilities !== undefined && (typeof entry.capabilities !== 'object' || entry.capabilities === null)) {
    errors.push(`${label}: capabilities 必须是对象`);
  }
  if (entry.capabilities && Array.isArray(entry.capabilities.network)) {
    for (const host of entry.capabilities.network) {
      if (typeof host !== 'string' || !host.trim()) errors.push(`${label}: capabilities.network 必须是非空字符串数组`);
    }
  }
  if (seen.has(entry.id)) errors.push(`${label}: id 重复`);
  seen.add(entry.id);
});

if (remote) {
  for (const entry of entries) {
    if (!entry || typeof entry.zipUrl !== 'string' || !/^[0-9a-f]{64}$/.test(String(entry.sha256))) { continue; }
    try {
      const response = await fetch(entry.zipUrl, { headers: { 'User-Agent': 'lexinote-releases-validator' } });
      if (!response.ok) { errors.push(`${entry.id}: zipUrl 不可达 (HTTP ${response.status})`); continue; }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const actual = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actual !== entry.sha256) { errors.push(`${entry.id}: zip 实测哈希与声明不一致 ${actual} != ${entry.sha256}`); }
    } catch (error) {
      errors.push(`${entry.id}: 远程校验失败 ${String(error)}`);
    }
  }
}

if (errors.length > 0) {
  console.error(`校验失败(${errors.length}):`);
  for (const error of errors) { console.error(' - ' + error); }
  process.exit(1);
}
console.log(`校验通过:${entries.length} 个插件条目(schemaVersion=1${remote ? ',含远程哈希实测' : ''})`);
