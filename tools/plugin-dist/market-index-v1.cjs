// The one Node implementation of the v1 plugin index schema.
// Export side (tools/plugin-dist/export-market-index.cjs) and every gate import this file;
// the ArkTS client has a twin in entry/src/main/ets/core/plugin/LexiPluginMarketModel.ets and
// scripts/tests/plugin-dist-regression.cjs fails if the two disagree on any fixture.
'use strict';
const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, 'market-index-v1.schema.json');
const SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

const CODES = {
  invalid: 'index_invalid',
  schemaVersion: 'unsupported_schema_version',
  zcode: 'legacy_zcode_rejected'
};
const WARNINGS = {
  legacyArray: 'legacy_array_schema',
  legacyObject: 'legacy_object_schema'
};

const ID_PATTERN = new RegExp(SCHEMA.definitions.plugin.properties.id.pattern);
const SHA256_PATTERN = new RegExp(SCHEMA.definitions.plugin.properties.sha256.pattern);
const ZIPURL_PATTERN = new RegExp(SCHEMA.definitions.plugin.properties.zipUrl.pattern);
const REQUIRED = SCHEMA.definitions.plugin.required;

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function buildEntry(source) {
  const capabilities = isObject(source.capabilities) ? source.capabilities : null;
  return {
    id: typeof source.id === 'string' ? source.id : '',
    name: typeof source.name === 'string' ? source.name.trim() : '',
    author: typeof source.author === 'string' ? source.author.trim() : '',
    description: typeof source.description === 'string' ? source.description : '',
    repo: typeof source.repo === 'string' ? source.repo : '',
    zipUrl: typeof source.zipUrl === 'string' ? source.zipUrl : '',
    version: typeof source.version === 'string' ? source.version.trim() : '',
    sha256: typeof source.sha256 === 'string' ? source.sha256 : '',
    minApiVersion: typeof source.minApiVersion === 'string' && source.minApiVersion ? source.minApiVersion : '0.0.0',
    isDesktopOnly: source.isDesktopOnly === true,
    capabilitiesDeclared: capabilities !== null,
    capabilities: {
      network: capabilities && Array.isArray(capabilities.network) ? capabilities.network.slice() : [],
      fs: !!(capabilities && capabilities.fs === true),
      clipboard: !!(capabilities && capabilities.clipboard === true)
    },
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : ''
  };
}

function buildLegacyEntry(source) {
  return {
    id: typeof source.id === 'string' ? source.id : '',
    name: typeof source.name === 'string' ? source.name : '',
    author: typeof source.author === 'string' ? source.author : '',
    description: typeof source.description === 'string' ? source.description : '',
    repo: typeof source.repo === 'string' ? source.repo : '',
    zipUrl: typeof source.zipUrl === 'string' ? source.zipUrl : '',
    version: typeof source.version === 'string' ? source.version : '',
    sha256: typeof source.sha256 === 'string' ? source.sha256 : ''
  };
}

function validateEntry(source, index) {
  const at = '\u7b2c ' + index + ' \u6761';
  for (const key of REQUIRED) {
    if (key === 'sha256' || key === 'zipUrl' || key === 'id') { continue; }
    if (typeof source[key] !== 'string' || source[key].trim().length === 0) { return at + ' \u7f3a\u5c11 ' + key; }
  }
  if (typeof source.id !== 'string' || !ID_PATTERN.test(source.id)) { return at + ' id \u975e\u6cd5: ' + (typeof source.id === 'string' && source.id ? source.id : '(\u7f3a\u5931)'); }
  if (typeof source.sha256 !== 'string' || !SHA256_PATTERN.test(source.sha256)) { return at + ' sha256 \u5fc5\u987b\u662f 64 \u4f4d\u5c0f\u5199\u5341\u516d\u8fdb\u5236'; }
  if (typeof source.zipUrl !== 'string' || !ZIPURL_PATTERN.test(source.zipUrl)) { return at + ' zipUrl \u5fc5\u987b\u662f http(s) \u5730\u5740'; }
  if (source.minApiVersion !== undefined && typeof source.minApiVersion !== 'string') { return at + ' minApiVersion \u5fc5\u987b\u662f\u5b57\u7b26\u4e32'; }
  if (source.capabilities !== undefined && !isObject(source.capabilities)) { return at + ' capabilities \u5fc5\u987b\u662f\u5bf9\u8c61'; }
  if (isObject(source.capabilities) && source.capabilities.network !== undefined && !Array.isArray(source.capabilities.network)) {
    return at + ' capabilities.network \u5fc5\u987b\u662f\u6570\u7ec4';
  }
  return '';
}

function looksLikeZcode(root) {
  if (root.owner !== undefined || root.unlistedPlugins !== undefined) { return true; }
  if (!Array.isArray(root.plugins) || root.plugins.length === 0) { return false; }
  const first = root.plugins[0];
  if (!isObject(first)) { return false; }
  return isObject(first.source) || first.componentTypes !== undefined;
}

function failure(code, message) {
  return { ok: false, code, message, schemaVersion: 0, entries: [], warnings: [] };
}

/** Parses an index string. Mirrors parseMarketIndexResult() in the ArkTS model. */
function parseIndex(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return failure(CODES.invalid, '\u5e02\u573a\u7d22\u5f15\u4e0d\u662f\u5408\u6cd5 JSON'); }
  if (Array.isArray(parsed)) {
    const entries = parsed.filter(isObject).map(buildLegacyEntry).filter((entry) => entry.id && entry.name);
    return { ok: true, code: '', message: '', schemaVersion: 0, entries, warnings: [WARNINGS.legacyArray] };
  }
  if (!isObject(parsed)) { return failure(CODES.invalid, '\u5e02\u573a\u7d22\u5f15\u9876\u5c42\u5fc5\u987b\u662f\u5bf9\u8c61\u6216\u6570\u7ec4'); }
  if (parsed.schemaVersion === undefined) {
    if (looksLikeZcode(parsed)) { return failure(CODES.zcode, '\u68c0\u6d4b\u5230 ZCode \u5e02\u573a schema\uff08owner/unlistedPlugins/source\uff09\uff0c\u5df2\u505c\u7528\uff1b\u8bf7\u6539\u7528 schemaVersion=1 \u7d22\u5f15'); }
    if (!Array.isArray(parsed.plugins)) { return failure(CODES.invalid, '\u7f3a\u5c11 schemaVersion \u6216 plugins \u6570\u7ec4'); }
    const entries = parsed.plugins.filter(isObject).map(buildLegacyEntry).filter((entry) => entry.id && entry.name);
    return { ok: true, code: '', message: '', schemaVersion: 0, entries, warnings: [WARNINGS.legacyObject] };
  }
  if (typeof parsed.schemaVersion !== 'number' || parsed.schemaVersion !== 1) {
    return failure(CODES.schemaVersion, '\u4e0d\u652f\u6301\u7684\u5e02\u573a\u7d22\u5f15 schemaVersion: ' + String(parsed.schemaVersion) + '\uff08\u53ea\u63a5\u53d7 1\uff09');
  }
  if (!Array.isArray(parsed.plugins)) { return failure(CODES.invalid, 'schemaVersion=1 \u7684\u7d22\u5f15\u5fc5\u987b\u5e26 plugins \u6570\u7ec4'); }
  const entries = [];
  for (let index = 0; index < parsed.plugins.length; index++) {
    const raw = parsed.plugins[index];
    if (!isObject(raw)) { return failure(CODES.invalid, '\u7b2c ' + index + ' \u6761\u4e0d\u662f\u5bf9\u8c61'); }
    const problem = validateEntry(raw, index);
    if (problem) { return failure(CODES.invalid, problem); }
    entries.push(buildEntry(raw));
  }
  return { ok: true, code: '', message: '', schemaVersion: 1, entries, warnings: [] };
}

/** Builds the machine-checked index document from a list of entries. */
function buildIndex(entries) {
  return {
    schemaVersion: 1,
    plugins: entries.map((entry) => {
      const out = {
        id: entry.id,
        name: entry.name,
        version: entry.version,
        author: entry.author,
        description: entry.description || '',
        repo: entry.repo || '',
        zipUrl: entry.zipUrl,
        sha256: entry.sha256,
        minApiVersion: entry.minApiVersion || '0.0.0',
        isDesktopOnly: entry.isDesktopOnly === true,
        updatedAt: entry.updatedAt || ''
      };
      if (entry.capabilities) { out.capabilities = entry.capabilities; }
      return out;
    })
  };
}

module.exports = { SCHEMA, SCHEMA_PATH, CODES, WARNINGS, REQUIRED, parseIndex, buildIndex, validateEntry, isObject };
