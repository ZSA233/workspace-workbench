import { existsSync } from 'node:fs';
import { opendir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, isAbsolute } from 'node:path';
import type { FileBrowserSettings, DirectoryChoices } from '../../shared/file-browser.ts';
import type { Config } from './config.ts';
import { atomicJson, canonical, hash, readJson, stable, WorkbenchError, type Json } from './storage.ts';

// The local config belongs to the project opened by the host. sourceRoot can
// deliberately be much broader to include other repositories; it is not a UI root.
export function automaticFileDirectory(config: Config): string {
  const base = dirname(config.configPath);
  return basename(base) === '.workspace-workbench' ? dirname(base) : config.sourceRoot;
}

export function fileBrowserSettingsPath(config: Config) { return join(config.stateRoot, 'file-browser.json'); }
function validateSettings(value: Json): Json {
  if (!value || value.schemaVersion !== 1 || value.mainDirectory !== null && (typeof value.mainDirectory !== 'string' || !value.mainDirectory.trim()))
    throw new WorkbenchError('file_browser_settings_invalid', 'Invalid file directory settings');
  return value;
}
function stored(config: Config): Json {
  const path = fileBrowserSettingsPath(config);
  if (!existsSync(path)) return { schemaVersion: 1, mainDirectory: null };
  return validateSettings(readJson(path));
}
export function fileBrowserSettings(config: Config, snapshot?: Json | null, pathIdentity = canonical): FileBrowserSettings {
  const value = snapshot === undefined ? stored(config) : validateSettings(snapshot || { schemaVersion: 1, mainDirectory: null });
  const automaticDirectory = pathIdentity(automaticFileDirectory(config));
  const mainDirectory = value.mainDirectory === null ? null : pathIdentity(value.mainDirectory);
  return { revision: hash(stable(value)), mainDirectory, automaticDirectory, effectiveDirectory: mainDirectory || automaticDirectory };
}
export function mainFileDirectory(config: Config, snapshot?: Json | null, pathIdentity = canonical) { return fileBrowserSettings(config, snapshot, pathIdentity).effectiveDirectory; }

export async function configureFileBrowser(config: Config, revision: string, mainDirectory: string | null): Promise<FileBrowserSettings> {
  const value = stored(config);
  if (hash(stable(value)) !== revision) throw new WorkbenchError('selection_conflict', 'Directory settings changed; reopen settings and retry');
  if (mainDirectory !== null) mainDirectory = await directoryPath(mainDirectory);
  atomicJson(fileBrowserSettingsPath(config), { ...value, mainDirectory, updatedAt: new Date().toISOString() });
  return fileBrowserSettings(config);
}

async function directoryPath(path: string) {
  if (!isAbsolute(path) && !path.startsWith('~/')) throw new WorkbenchError('path_invalid', 'Choose an absolute host directory');
  const directory = await realpath(canonical(path));
  if (!(await stat(directory)).isDirectory()) throw new WorkbenchError('path_invalid', 'Choose a directory');
  return directory;
}

/** Browse the connected host, not the browser device's unrelated filesystem. */
export async function browseDirectories(path: string, cursor?: string): Promise<DirectoryChoices> {
  const directory = await directoryPath(path), s = await stat(directory);
  const version = hash(`${directory}:${s.dev}:${s.ino}:${s.mtimeMs}:${s.ctimeMs}`);
  let skip = 0;
  if (cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (parsed.version !== version || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > 100_000) throw Error();
      skip = parsed.offset;
    } catch { throw new WorkbenchError('file_listing_changed', 'Directory changed; reopen it to continue'); }
  }
  const entries: DirectoryChoices['entries'] = [];
  const handle = await opendir(directory);
  let offset = 0, next: string | undefined;
  const deadline = Date.now() + 1500;
  try {
    while (true) {
      const entry = await handle.read();
      if (!entry) break;
      offset++;
      if (offset <= skip) continue;
      if (entry.isDirectory() && entry.name !== '.git') entries.push({ name: entry.name, directory: join(directory, entry.name) });
      if (entries.length >= 100 || offset - skip >= 2000 || Date.now() >= deadline) {
        next = Buffer.from(JSON.stringify({ version, offset })).toString('base64url'); break;
      }
    }
  } finally { await handle.close(); }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { directory, parent: dirname(directory) === directory ? null : dirname(directory), entries, ...(next ? { cursor: next } : {}) };
}
