import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Library, readStoredLibrary } from './library';
import { locationSettingsFile } from './storage-path';
import { defaultTimelines } from '../shared/timelines';
import type { StorageAction, StorageSelection } from '../shared/types';
import { paperStoragePaths } from './paper-storage';

const pathKey = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const contains = (parent: string, child: string) => pathKey(child).startsWith(pathKey(parent) + sep);

function checkAction(mode: unknown): asserts mode is StorageAction {
  if (!['open', 'copy', 'create'].includes(mode as string)) throw new Error('请选择有效的文献库操作');
}

async function canonicalDirectory(path: string) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f]/.test(path)) throw new Error('请选择完整的文件夹路径');
  try {
    const directory = await realpath(path);
    if (!(await lstat(directory)).isDirectory()) throw new Error('请选择文件夹');
    return directory;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`找不到此文件夹：${path}`);
    if (code === 'EACCES' || code === 'EPERM') throw new Error(`无法访问此文件夹，请检查权限：${path}`);
    throw error;
  }
}

async function checkNotInUse(directory: string) {
  let session;
  try { session = JSON.parse(await readFile(join(directory, '.ai-session.json'), 'utf8')); }
  catch { return; }
  if (!Number.isSafeInteger(session.pid) || session.pid <= 0) return;
  try { process.kill(session.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; }
  throw new Error('该文献库正在被另一个程序使用，请先关闭它');
}

async function regularFile(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('文献库中含有不支持的文件链接，请选择完整的本地副本');
}

async function regularDirectory(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('文献库中含有不支持的目录链接，请选择完整的本地副本');
}

export async function inspectStorageSelection(mode: StorageAction, path: string, currentDirectory?: string): Promise<StorageSelection> {
  checkAction(mode);
  const directory = await canonicalDirectory(path);
  if (currentDirectory) {
    const current = await canonicalDirectory(currentDirectory);
    if (pathKey(current) === pathKey(directory)) throw new Error('这就是当前文献库，请选择其他文件夹');
    if (contains(current, directory) || contains(directory, current)) throw new Error('请选择与当前文献库相互独立的文件夹');
  }
  if (mode !== 'open') {
    if ((await readdir(directory)).length) throw new Error('请选择空文件夹，以免覆盖已有文件');
    return { mode, directory, paperCount: 0 };
  }
  await checkNotInUse(directory);
  let stored;
  try { await regularFile(join(directory, 'library.json')); stored = await readStoredLibrary(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('此文件夹没有 library.json，请选择文献库文件夹本身');
    throw error;
  }
  // Selection is read-only, including for a v1 library. Migration runs only on startup.
  for (const paper of stored.papers) {
    const paths = paperStoragePaths(directory, paper);
    if (paper.storageFolder) {
      try { await regularDirectory(join(directory, 'papers')); await regularDirectory(paths.directory); }
      catch { throw new Error(`文献库缺少完整的论文资料文件夹：${paper.title}。请复制整个 library 文件夹。`); }
    }
    if (paths.pdf !== null) {
      try { await regularDirectory(dirname(paths.pdf)); await regularFile(paths.pdf); }
      catch { throw new Error(`文献库缺少 PDF：${paper.fileName}。请复制整个 library 文件夹。`); }
    }
    if (paper.markdownNote) {
      try { await regularDirectory(dirname(paths.markdown)); await regularFile(paths.markdown); }
      catch { throw new Error(`文献库缺少 Markdown 笔记：${paper.markdownNote.fileName}。请复制整个 library 文件夹。`); }
    }
  }
  return { mode, directory, paperCount: stored.papers.length };
}

export async function saveLibraryLocation(defaultDirectory: string, directory: string) {
  const file = locationSettingsFile(defaultDirectory);
  const rel = relative(dirname(file), directory);
  // Libraries next to a portable application keep working when its folder moves.
  const saved = rel && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel) ? rel : directory;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, directory: saved }, null, 2), { flag: 'wx' });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function populateEmptyLibrary(mode: 'copy' | 'create', directory: string, library: Library) {
  const created: string[] = [];
  const directories: string[] = [];
  const createDirectory = async (path: string) => { await mkdir(path); directories.push(path); };
  const copy = async (from: string, to: string) => {
    await regularFile(from);
    await copyFile(from, to, constants.COPYFILE_EXCL);
    created.push(to);
    if (await digest(from) !== await digest(to)) throw new Error('复制校验失败，请检查磁盘后重试');
  };
  const copyDirectory = async (from: string, to: string) => {
    await regularDirectory(from);
    await createDirectory(to);
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (entry.name.endsWith('.tmp') || entry.name === '.ai-session.json' || entry.name === 'llm-config.bin') continue;
      if (entry.isSymbolicLink()) throw new Error('文献库中含有不支持的文件链接，请选择完整的本地副本');
      if (entry.isDirectory()) await copyDirectory(join(from, entry.name), join(to, entry.name));
      else await copy(join(from, entry.name), join(to, entry.name));
    }
  };
  const copyOptionalDirectory = async (name: string) => {
    const source = join(library.directory, name);
    try { await lstat(source); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    await copyDirectory(source, join(directory, name));
  };
  try {
    await createDirectory(join(directory, 'papers'));
    if (mode === 'copy') {
      const papers = library.list();
      if (papers.length) await regularDirectory(join(library.directory, 'papers'));
      for (const paper of papers) {
        if (!paper.storageFolder) throw new Error('文献库尚未完成资料文件夹迁移，请重新打开后复制');
        const source = paperStoragePaths(library.directory, paper);
        const target = paperStoragePaths(directory, paper);
        if (paper.markdownNote) await library.markdownPath(paper.id);
        // Include user-added files, nested outputs and backups within each live paper folder.
        await copyDirectory(source.directory, target.directory);
        if (target.pdf !== null) await regularFile(target.pdf);
        if (paper.markdownNote) await regularFile(target.markdown);
      }
      try {
        const backup = library.file + '.bak';
        await regularFile(backup);
        const backupIndex = JSON.parse(await readFile(backup, 'utf8'));
        // A retained v1 backup references historical trees intentionally left at the source.
        await copy(backupIndex.version === 2 ? backup : library.file, join(directory, 'library.json.bak'));
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // Historical pre-migration trees remain in the source backup, not in a new live copy.
      await copyOptionalDirectory('sync');
    }
    // Write the index last. Session credentials and transient files are excluded.
    const index = join(directory, 'library.json');
    if (mode === 'copy') {
      try { await copy(library.file, index); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || library.list().length) throw error; }
    }
    await writeFile(index, JSON.stringify({ version: 2, papers: [], folders: [], timelines: defaultTimelines() }, null, 2), { flag: 'wx' });
    created.push(index);
  } catch (error) {
    // Remove only the exact files created by this attempt; never recurse into a chosen folder.
    for (const file of created.reverse()) await unlink(file).catch(() => {});
    for (const path of directories.reverse()) await rmdir(path).catch(() => {});
    throw error;
  }
}

/** On success the old library stays frozen until restart; on failure it is usable. */
export async function prepareStorageChange(library: Library, defaultDirectory: string, mode: StorageAction, directory: string) {
  const unlock = await library.lockForStorageChange();
  try {
    const selection = await inspectStorageSelection(mode, directory, library.directory);
    if (mode === 'open') {
      const probe = join(selection.directory, `.paper-timeline-write-${randomUUID()}`);
      await writeFile(probe, '', { flag: 'wx' });
      await unlink(probe);
    } else await populateEmptyLibrary(mode, selection.directory, library);
    await saveLibraryLocation(defaultDirectory, selection.directory);
    return selection;
  } catch (error) {
    unlock();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') throw new Error('无法保存文献库位置或复制文件，请检查文件夹权限。当前文献库未切换。');
    if (code === 'ENOSPC') throw new Error('磁盘空间不足，当前文献库未切换。请清理空间或选择其他磁盘。');
    throw error;
  }
}
