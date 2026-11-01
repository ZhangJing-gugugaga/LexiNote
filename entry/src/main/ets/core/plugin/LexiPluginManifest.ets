// Plugin manifest model, compatible with the Obsidian manifest.json field set.

export class LexiPluginManifest {
  id: string = '';
  name: string = '';
  author: string = '';
  version: string = '';
  minAppVersion: string = '';
  description: string = '';
  authorUrl: string = '';
  isDesktopOnly: boolean = false;
}

export class LexiInstalledPlugin {
  manifest: LexiPluginManifest = new LexiPluginManifest();
  dir: string = '';
  enabled: boolean = false;
  errorState: string = '';
}

const APP_VERSION: string = '1.1.0';

/** Parses and validates a manifest.json payload; throws with a user-facing message when invalid. */
export function parsePluginManifest(json: string): LexiPluginManifest {
  const raw = JSON.parse(json) as LexiPluginManifest;
  if (!raw || typeof raw.id !== 'string' || raw.id.length === 0) { throw new Error('插件 manifest 缺少 id'); }
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(raw.id)) { throw new Error('插件 id 只允许小写字母、数字与连字符'); }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) { throw new Error('插件 manifest 缺少 name'); }
  if (typeof raw.version !== 'string' || raw.version.trim().length === 0) { throw new Error('插件 manifest 缺少 version'); }
  if (typeof raw.author !== 'string' || raw.author.trim().length === 0) { throw new Error('插件 manifest 缺少 author'); }
  const manifest = new LexiPluginManifest();
  manifest.id = raw.id;
  manifest.name = raw.name.trim();
  manifest.author = raw.author.trim();
  manifest.version = raw.version.trim();
  manifest.minAppVersion = typeof raw.minAppVersion === 'string' ? raw.minAppVersion : '0.0.0';
  manifest.description = typeof raw.description === 'string' ? raw.description : '';
  manifest.authorUrl = typeof raw.authorUrl === 'string' ? raw.authorUrl : '';
  manifest.isDesktopOnly = raw.isDesktopOnly === true;
  return manifest;
}

function versionParts(version: string): number[] {
  const parts: number[] = [];
  for (const piece of version.split('.')) {
    const numeric = parseInt(piece, 10);
    parts.push(Number.isNaN(numeric) ? 0 : numeric);
  }
  while (parts.length < 3) { parts.push(0); }
  return parts;
}

/** Obsidian-compatible compatibility check against the running app version. */
export function manifestCompatible(manifest: LexiPluginManifest): boolean {
  const required = versionParts(manifest.minAppVersion);
  const current = versionParts(APP_VERSION);
  for (let i = 0; i < 3; i++) {
    if (required[i] < current[i]) { return true; }
    if (required[i] > current[i]) { return false; }
  }
  return true;
}
