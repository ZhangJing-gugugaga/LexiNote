#!/usr/bin/env node
// Fetch the first N Obsidian community plugin main.js bundles into a local cache.
// Idempotent: a cached main.js with status ok is never downloaded again.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.fixtures-out', 'eco-scan');
const META = path.join(OUT, 'meta');
const CACHE = path.join(OUT, 'cache');
const LIST_URL = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json';
const PROXY = process.env.ECO_SCAN_PROXY || 'http://127.0.0.1:7897';
const SAMPLE = 24;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DOWNLOADS = 30;
const MAX_ATTEMPTS = 2;
const CONCURRENCY = 4;

fs.mkdirSync(META, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });

function runCurl(args) {
  return new Promise((resolve) => {
    const p = spawn('curl.exe', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
    p.on('error', (e) => resolve({ code: -1, stdout: '', stderr: e.message }));
  });
}

async function ensureList() {
  const file = path.join(META, 'community-plugins.json');
  if (fs.existsSync(file) && fs.statSync(file).size > 100000) {
    try { JSON.parse(fs.readFileSync(file, 'utf8')); return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  }
  const r = await runCurl(['-sS', '-L', '-m', '180', '-x', PROXY, '-o', file, LIST_URL]);
  if (r.code !== 0) throw new Error('plugin list download failed: ' + r.stderr.trim());
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

let downloadBudget = MAX_DOWNLOADS;
let downloadsMade = 0;

async function fetchPlugin(entry) {
  const dir = path.join(CACHE, entry.id);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'main.js');
  const meta = path.join(dir, 'fetch.json');
  const prev = fs.existsSync(meta) ? JSON.parse(fs.readFileSync(meta, 'utf8')) : null;
  if (prev && prev.status === 'ok' && fs.existsSync(target) && fs.statSync(target).size === prev.bytes && prev.bytes > 0) {
    return { ...prev, cacheHit: true };
  }
  const url = 'https://github.com/' + entry.repo + '/releases/latest/download/main.js';
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (downloadBudget <= 0) { last = { status: 'budget_exhausted', error: 'download budget of ' + MAX_DOWNLOADS + ' exhausted' }; break; }
    downloadBudget--; downloadsMade++;
    const tmp = target + '.part';
    try { fs.unlinkSync(tmp); } catch {}
    const r = await runCurl(['-sS', '-L', '-m', '240', '--max-filesize', String(MAX_BYTES), '-x', PROXY,
      '-o', tmp, '--write-out', '%{http_code} %{size_download} %{url_effective}', url]);
    const parts = r.stdout.trim().split(' ');
    const httpCode = Number(parts[0]) || 0;
    const sizeDownload = Number(parts[1]) || 0;
    const effectiveUrl = parts.slice(2).join(' ');
    let status = 'ok';
    let error = null;
    if (r.code === 63) { status = 'too_large'; error = 'curl exit 63 (max-filesize exceeded)'; }
    else if (r.code !== 0) { status = 'network_error'; error = r.stderr.trim().slice(0, 300) || ('curl exit ' + r.code); }
    else if (httpCode !== 200) { status = 'http_' + httpCode; error = 'HTTP ' + httpCode; }
    else if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) { status = 'empty'; error = 'downloaded 0 bytes'; }
    else if (fs.statSync(tmp).size > MAX_BYTES) { status = 'too_large'; error = 'size ' + fs.statSync(tmp).size + ' > 8MB'; }
    if (status === 'ok') {
      const buf = fs.readFileSync(tmp);
      fs.writeFileSync(target, buf);
      try { fs.unlinkSync(tmp); } catch {}
      const rec = { id: entry.id, repo: entry.repo, url, effectiveUrl, status, httpCode, attempts: attempt, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), downloadedAt: new Date().toISOString() };
      fs.writeFileSync(meta, JSON.stringify(rec, null, 2));
      return { ...rec, cacheHit: false };
    }
    try { fs.unlinkSync(tmp); } catch {}
    last = { id: entry.id, repo: entry.repo, url, status, httpCode, attempts: attempt, bytes: 0, error };
    if (status === 'too_large' || status === 'http_404' || status === 'http_410') break;
  }
  const rec = { ...last, downloadedAt: new Date().toISOString() };
  fs.writeFileSync(meta, JSON.stringify(rec, null, 2));
  return { ...rec, cacheHit: false };
}

(async () => {
  const list = await ensureList();
  const sample = list.slice(0, SAMPLE).map((p) => ({ id: p.id, name: p.name, repo: p.repo, order: list.indexOf(p) }));
  const results = new Array(sample.length);
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < sample.length) {
      const idx = i++;
      results[idx] = await fetchPlugin(sample[idx]);
      console.log('[' + (idx + 1) + '/' + sample.length + '] ' + sample[idx].id + ' ' + results[idx].status + ' ' + (results[idx].bytes || 0) + 'B' + (results[idx].cacheHit ? ' (cache)' : ''));
    }
  }));
  const manifestPath = path.join(OUT, 'fetch-manifest.json');
  const prevManifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  const run = {
    at: new Date().toISOString(),
    downloadsMade,
    cacheHits: results.filter((r) => r.cacheHit).length,
    ok: results.filter((r) => r.status === 'ok').length,
    failed: results.filter((r) => r.status !== 'ok').length,
    networkBytes: results.filter((r) => !r.cacheHit).reduce((a, r) => a + (r.bytes || 0), 0),
  };
  const prevRuns = (prevManifest && prevManifest.runs) || (prevManifest ? [{
    at: prevManifest.generatedAt,
    downloadsMade: prevManifest.downloadsMade,
    cacheHits: prevManifest.cacheHits,
    networkBytes: prevManifest.plugins.filter((p) => !p.cacheHit).reduce((a, p) => a + (p.bytes || 0), 0),
  }] : []);
  const runs = prevRuns.concat([run]);
  const manifest = {
    generatedAt: run.at,
    listUrl: LIST_URL,
    sampleSize: SAMPLE,
    lastRun: run,
    runs,
    totalDownloads: runs.reduce((a, r) => a + r.downloadsMade, 0),
    totalNetworkBytes: runs.reduce((a, r) => a + r.networkBytes, 0),
    downloadsMade,
    cacheHits: run.cacheHits,
    plugins: results,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('done: ok=' + run.ok + ' failed=' + run.failed + ' cacheHits=' + run.cacheHits + ' downloadsMade=' + downloadsMade + ' run=' + runs.length);
})().catch((e) => { console.error(e); process.exit(1); });
