#!/usr/bin/env node
// lexinote-releases 索引校验:结构校验始终执行;--remote 额外校验 GitHub 仓库与 Release 资产。
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const indexPath = path.join(root, '..', 'community-plugins.json');
const remote = process.argv.includes('--remote');
const errors = [];

const entries = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
if (!Array.isArray(entries)) { errors.push('community-plugins.json 必须是数组'); }
const seen = new Set();
for (const entry of entries) {
  const label = entry && entry.id ? entry.id : '(missing id)';
  if (!entry || typeof entry !== 'object') { errors.push('条目必须是对象'); continue; }
  for (const key of ['id', 'name', 'author', 'description', 'repo']) {
    if (typeof entry[key] !== 'string' || entry[key].trim().length === 0) {
      errors.push(`${label}: 缺少字段 ${key}`);
    }
  }
  if (typeof entry.id === 'string' && !/^[a-z0-9][a-z0-9-]{0,99}$/.test(entry.id)) {
    errors.push(`${label}: id 只允许小写字母、数字与连字符`);
  }
  if (seen.has(entry.id)) { errors.push(`${label}: id 重复`); }
  seen.add(entry.id);
  if (typeof entry.repo === 'string' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.repo)) {
    errors.push(`${label}: repo 必须是 owner/name`);
  }
  if (entry.zipUrl !== undefined && typeof entry.zipUrl !== 'string') {
    errors.push(`${label}: zipUrl 必须是字符串`);
  }
}

if (remote) {
  const headers = { 'User-Agent': 'lexinote-releases-validator', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) { headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`; }
  for (const entry of entries) {
    if (!entry || typeof entry.repo !== 'string') { continue; }
    try {
      const response = await fetch(`https://api.github.com/repos/${entry.repo}/releases/latest`, { headers });
      if (!response.ok) { errors.push(`${entry.id}: 仓库 ${entry.repo} 无 latest release (HTTP ${response.status})`); continue; }
      const release = await response.json();
      const assets = (release.assets || []).map((a) => a.name);
      if (!assets.includes('main.js')) { errors.push(`${entry.id}: Release 缺少 main.js`); }
      if (!assets.includes('manifest.json')) { errors.push(`${entry.id}: Release 缺少 manifest.json`); }
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
console.log(`校验通过:${entries.length} 个插件条目${remote ? '(含远程)' : ''}`);
