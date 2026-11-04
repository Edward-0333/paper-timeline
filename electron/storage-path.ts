import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';

interface StorageLocation {
  isPackaged: boolean;
  appPath: string;
  executablePath: string;
  dataRoot?: string;
}

/** Anchor storage to the project/application location, never the launch directory. */
export function resolveLibraryDirectory(location: StorageLocation): string {
  return readLibraryLocation(resolveDefaultLibraryDirectory(location));
}

export function locationSettingsFile(defaultDirectory: string): string {
  return join(dirname(defaultDirectory), 'library-location.json');
}

export function readLibraryLocation(defaultDirectory: string): string {
  const file = locationSettingsFile(defaultDirectory);
  try {
    const setting = JSON.parse(readFileSync(file, 'utf8'));
    if (setting.version !== 1 || typeof setting.directory !== 'string' || !setting.directory.trim() || /[\x00-\x1f]/.test(setting.directory)) throw new Error('设置格式无效');
    return isAbsolute(setting.directory) ? resolve(setting.directory) : resolve(dirname(file), setting.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultDirectory;
    throw new Error('无法读取文献库位置设置，请重新选择文献库。');
  }
}

export function resolveDefaultLibraryDirectory(location: StorageLocation): string {
  if (location.dataRoot) return join(resolve(location.dataRoot), 'library');
  if (!location.isPackaged) return join(location.appPath, 'library');

  const executableDirectory = dirname(location.executablePath);
  let candidate = executableDirectory;
  for (let level = 0; level < 4; level++) {
    try {
      const manifest = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
      if (manifest.name === 'paper-timeline' && existsSync(join(candidate, 'electron', 'main.ts'))) {
        return join(candidate, 'library');
      }
    } catch { /* A standalone distribution does not include the source project. */ }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  // A copied standalone app keeps its library beside its executable.
  return join(executableDirectory, 'library');
}
