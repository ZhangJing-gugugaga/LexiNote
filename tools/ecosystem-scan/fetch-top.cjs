#!/usr/bin/env node
// Fetch the top-N Obsidian community plugins BY DOWNLOAD COUNT (not file order).
// Writes .fixtures-out/eco-scan/fetch-manifest-top.json; never touches fetch-manifest.json.
// Idempotent: a cached main.js + manifest.json with status ok is never downloaded again.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.fixtures-out', 'eco-scan');
const CACHE = path.join(OUT, 'cache');
const STATS = path.join(OUT, 'community-plugin-stats.json');
const LIST = path.join(OUT, 'meta', 'community-plugins.json');
const MANIFEST = path.join(OUT, 'fetch-manifest-top.json');
const PROXY = process.env.ECO_SCAN_PROXY || 'http://127.0.0.1:7897';
const SAMPLE = Number((process.argv.find(function (a) { return a.startsWith('--sample='); }) || '').split('=')[1]) || 40;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const BYTE_BUDGET = 20 * 1024 * 1024;
const MAX_ATTEMPTS = 2;

fs.mkdirSync(CACHE, { recursive: true });

function runCurl(args) {
  return new Promise(function (resolve) {
    const p = spawn('curl.exe', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', function (d) { stdout += d.toString(); });
    p.stderr.on('data', function (d) { stderr += d.toString(); });
    p.on('close', function (code) { resolve({ code: code, stdout: stdout, stderr: stderr }); });
    p.on('error', function (e) { resolve({ code: -1, stdout: '', stderr: e.message }); });
  });
}

// downloads desc, ties broken by id ascending (lexicographic, byte order)
function pickSample() {
  const stats = JSON.parse(fs.readFileSync(STATS, 'utf8'));
  const list = JSON.parse(fs.readFileSync(LIST, 'utf8'));
  const byId = new Map(list.map(function (p) { return [p.id, p]; }));
  const rows = Object.keys(stats).map(function (id) { return { id: id, downloads: stats[id].downloads || 0, updated: stats[id].updated || null }; });
  rows.sort(function (a, b) { return b.downloads - a.downloads || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
  return rows.slice(0, SAMPLE).map(function (r) {
    const e = byId.get(r.id);
    return { id: r.id, name: e ? e.name : null, repo: e ? e.repo : null, downloads: r.downloads, updated: r.updated };
  });
}

let bytesUsed = 0;
let downloadsMade = 0;

// Returns { ok, bytes, ... }. kind: 'main' | 'manifest'
async function download(url, target, tmp, kind) {
  const remaining = BYTE_BUDGET - bytesUsed;
  if (remaining <= 0) return { ok: false, status: 'budget_exhausted', error: 'byte budget of ' + BYTE_BUDGET + ' exhausted', bytes: 0 };
  const cap = Math.min(MAX_FILE_BYTES, remaining);
  downloadsMade++;
  try { fs.unlinkSync(tmp); } catch (e) {}
  const r = await runCurl(['-sS', '-L', '-m', '240', '--max-filesize', String(cap), '-x', PROXY,
    '-o', tmp, '--write-out', '%{http_code} %{size_download}', url]);
  const parts = r.stdout.trim().split(' ');
  const httpCode = Number(parts[0]) || 0;
  const sizeDownload = Number(parts[1]) || 0;
  bytesUsed += sizeDownload;
  let status = 'ok';
  let error = null;
  if (r.code === 63) { status = cap < MAX_FILE_BYTES ? 'budget_exceeded' : 'too_large'; error = 'curl exit 63 (max-filesize ' + cap + ')'; }
  else if (r.code !== 0) { status = 'network_error'; error = r.stderr.trim().slice(0, 300) || ('curl exit ' + r.code); }
  else if (httpCode !== 200) { status = 'http_' + httpCode; error = 'HTTP ' + httpCode; }
  else if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) { status = 'empty'; error = 'downloaded 0 bytes'; }
  if (status !== 'ok') { try { fs.unlinkSync(tmp); } catch (e) {} return { ok: false, status: status, httpCode: httpCode, error: error, bytes: sizeDownload }; }
  const buf = fs.readFileSync(tmp);
  fs.writeFileSync(target, buf);
  try { fs.unlinkSync(tmp); } catch (e) {}
  return { ok: true, status: 'ok', httpCode: httpCode, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

function cachedFile(target, metaFile, kind) {
  if (!fs.existsSync(target) || !fs.existsSync(metaFile)) return null;
  try {
    const prev = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (prev.status === 'ok' && prev.bytes > 0 && fs.statSync(target).size === prev.bytes) return prev;
  } catch (e) {}
  return null;
}

async function fetchPlugin(entry) {
  const dir = path.join(CACHE, entry.id);
  fs.mkdirSync(dir, { recursive: true });
  const mainTarget = path.join(dir, 'main.js');
  const mainMeta = path.join(dir, 'fetch-main.json');
  const maniTarget = path.join(dir, 'manifest.json');
  const maniMeta = path.join(dir, 'fetch-manifest.json');
  const out = { id: entry.id, name: entry.name, repo: entry.repo, downloads: entry.downloads, updated: entry.updated, cacheHit: false, downloadsThisRun: 0 };

  let prevMain = cachedFile(mainTarget, mainMeta, 'main');
  if (prevMain) {
    Object.assign(out, { status: 'ok', bytes: prevMain.bytes, sha256: prevMain.sha256, effectiveUrl: prevMain.effectiveUrl, mainCacheHit: true });
  } else {
    const url = 'https://github.com/' + entry.repo + '/releases/latest/download/main.js';
    let last = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const r = await download(url, mainTarget, mainTarget + '.part', 'main');
      out.downloadsThisRun++;
      if (r.ok) {
        const rec = { id: entry.id, repo: entry.repo, url: url, status: 'ok', httpCode: r.httpCode, attempts: attempt, bytes: r.bytes, sha256: r.sha256, downloadedAt: new Date().toISOString() };
        fs.writeFileSync(mainMeta, JSON.stringify(rec, null, 2));
        Object.assign(out, { status: 'ok', bytes: r.bytes, sha256: r.sha256, mainCacheHit: false });
        last = null;
        break;
      }
      last = { status: r.status, error: r.error, bytes: 0, httpCode: r.httpCode };
      if (r.status === 'too_large' || r.status === 'budget_exceeded' || r.status === 'budget_exhausted' || r.status === 'http_404' || r.status === 'http_410') break;
    }
    if (last) {
      const rec = Object.assign({ id: entry.id, repo: entry.repo, downloadedAt: new Date().toISOString() }, last);
      fs.writeFileSync(mainMeta, JSON.stringify(rec, null, 2));
      Object.assign(out, { status: last.status, bytes: 0, error: last.error, mainCacheHit: false });
    }
  }

  // manifest.json carries minAppVersion, which the bundle does not contain.
  let prevMani = cachedFile(maniTarget, maniMeta, 'manifest');
  if (prevMani) {
    out.minAppVersion = prevMani.minAppVersion || null;
    out.manifestCacheHit = true;
  } else {
    const url = 'https://github.com/' + entry.repo + '/releases/latest/download/manifest.json';
    const r = await download(url, maniTarget, maniTarget + '.part', 'manifest');
    out.downloadsThisRun++;
    if (r.ok) {
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(maniTarget, 'utf8')); } catch (e) {}
      const rec = { id: entry.id, url: url, status: 'ok', httpCode: r.httpCode, bytes: r.bytes, minAppVersion: parsed ? parsed.minAppVersion || null : null, version: parsed ? parsed.version || null : null, downloadedAt: new Date().toISOString() };
      fs.writeFileSync(maniMeta, JSON.stringify(rec, null, 2));
      out.minAppVersion = rec.minAppVersion;
      out.pluginVersion = rec.version;
    } else {
      fs.writeFileSync(maniMeta, JSON.stringify({ id: entry.id, url: url, status: r.status, error: r.error, bytes: 0, downloadedAt: new Date().toISOString() }, null, 2));
      out.minAppVersion = null;
    }
  }
  out.cacheHit = out.mainCacheHit === true && out.manifestCacheHit === true;
  return out;
}

(async function () {
  const sample = pickSample();
  const results = [];
  for (let i = 0; i < sample.length; i++) {
    const r = await fetchPlugin(sample[i]);
    results.push(r);
    console.log('[' + (i + 1) + '/' + sample.length + '] ' + r.id + ' ' + r.status + ' ' + (r.bytes || 0) + 'B' + (r.cacheHit ? ' (cache)' : '') + ' minApp=' + (r.minAppVersion || '?') + ' bytesUsed=' + bytesUsed);
  }
  const prev = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : null;
  const run = {
    at: new Date().toISOString(),
    sampleSize: sample.length,
    downloadsMade: downloadsMade,
    cacheHits: results.filter(function (r) { return r.cacheHit; }).length,
    ok: results.filter(function (r) { return r.status === 'ok'; }).length,
    failed: results.filter(function (r) { return r.status !== 'ok'; }).length,
    networkBytes: bytesUsed,
  };
  const runs = ((prev && prev.runs) || []).concat([run]);
  const manifest = {
    generatedAt: run.at,
    sourceStats: 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json',
    listUrl: 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json',
    sampleRule: 'downloads desc from community-plugin-stats.json, ties broken by plugin id ascending (byte order)',
    sampleSize: sample.length,
    byteBudget: BYTE_BUDGET,
    lastRun: run,
    runs: runs,
    totalDownloads: runs.reduce(function (a, r) { return a + r.downloadsMade; }, 0),
    totalNetworkBytes: runs.reduce(function (a, r) { return a + r.networkBytes; }, 0),
    plugins: results,
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log('done: ok=' + run.ok + ' failed=' + run.failed + ' cacheHits=' + run.cacheHits + ' downloadsMade=' + downloadsMade + ' networkBytes=' + bytesUsed + ' run=' + runs.length);
})().catch(function (e) { console.error(e); process.exit(1); });
