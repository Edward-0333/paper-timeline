import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rename, rmdir, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { Paper, LibraryFolder, TimelineTrack } from '../shared/types';
import { assertRegularFile, assertSafeDirectory, paperStoragePaths, storageFolderName } from './paper-storage';

export interface StoredLibrary { version: 1 | 2; papers: Paper[]; folders: LibraryFolder[]; timelines: TimelineTrack[] }
const validatedIndexes = new WeakMap<StoredLibrary, string>();
/** Keep the validated source identity internal; never persist it as library metadata. */
export function validatedLibrarySnapshot(data: StoredLibrary, source: string): StoredLibrary {
  validatedIndexes.set(data, createHash('sha256').update(source).digest('hex'));
  return data;
}
export const LEGACY_INDEX_BACKUP = 'library.pre-paper-folders-v1.json';
async function hash(path: string) {
  const digest = createHash('sha256');
  for await (const part of createReadStream(path)) digest.update(part);
  return digest.digest('hex');
}
async function exists(path: string) {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
/** Walk without following links, including unknown files so migrations never silently discard them. */
async function tree(path: string): Promise<{ files: string[]; directories: string[] }> {
  if (!await exists(path)) return { files: [], directories: [] };
  await assertSafeDirectory(path);
  const result = { files: [] as string[], directories: [path] };
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error('文献库资料中包含链接，迁移已停止，原文件保持不变');
    if (entry.isDirectory()) { const nested = await tree(child); result.files.push(...nested.files); result.directories.push(...nested.directories); }
    else if (entry.isFile()) { await assertRegularFile(child); result.files.push(child); }
    else throw new Error('文献库资料中包含不支持的特殊文件，迁移已停止');
  }
  return result;
}
async function copyVerified(source: string, destination: string) {
  await assertRegularFile(source); await assertRegularFile(destination, true);
  const sourceHash = await hash(source);
  if (await exists(destination)) {
    if (await hash(destination) !== sourceHash) throw new Error('迁移目标已有不同内容，未覆盖文件；请保留文献库并检查备份');
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await assertSafeDirectory(dirname(destination));
  const temporary = `${destination}.migration-${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    if (await hash(temporary) !== sourceHash || await hash(source) !== sourceHash) throw new Error('资料复制校验失败，原文献库保持不变');
    // A retry may find a fully published destination; never replace a different existing file.
    if (await exists(destination)) {
      await assertRegularFile(destination);
      if (await hash(destination) !== sourceHash) throw new Error('迁移目标内容发生变化，已停止');
    } else await rename(temporary, destination);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Index-last migration: old trees and the exact original index are permanent recovery copies. */
export async function migratePaperStorage(directory: string, data: StoredLibrary): Promise<StoredLibrary> {
  if (data.version === 2) return data;
  await assertSafeDirectory(directory);
  const index = join(directory, 'library.json'); await assertRegularFile(index);
  const original = await readFile(index, 'utf8'), originalHash = createHash('sha256').update(original).digest('hex');
  if (validatedIndexes.get(data) !== originalHash) throw new Error('文献索引在校验后发生变化，迁移尚未开始，请重新打开文献库');
  const raw = JSON.parse(original);
  const occupied: string[] = data.papers.flatMap(paper => paper.storageFolder ? [paper.storageFolder] : []);
  const papers = data.papers.map(paper => {
    const storageFolder = paper.storageFolder ?? storageFolderName(paper.title, paper.id, occupied);
    occupied.push(storageFolder); return { ...paper, storageFolder };
  });
  const next: StoredLibrary = { ...data, version: 2, papers };
  const backup = join(directory, LEGACY_INDEX_BACKUP), stage = join(directory, '.paper-migration', originalHash.slice(0, 16));
  const transfers: { source: string; target: string }[] = [], directories = new Set<string>();
  // Validate the entire legacy area before the first write, including unknown files left as backups.
  for (const name of ['pdfs', 'notes', 'annotations', 'parsed', 'citations']) await tree(join(directory, name));
  await assertSafeDirectory(join(directory, 'papers')); await assertSafeDirectory(stage); await assertRegularFile(backup, true);
  for (let i = 0; i < papers.length; i++) {
    const legacy = paperStoragePaths(directory, { ...data.papers[i], storageFolder: undefined }), target = paperStoragePaths(directory, papers[i]);
    directories.add(target.directory);
    for (const name of ['pdf', 'markdown', 'annotations'] as const) {
      if (!legacy[name] || !target[name]) continue;
      for (const suffix of ['', '.bak']) {
        const source = legacy[name]! + suffix;
        if (await exists(source)) { await assertRegularFile(source); transfers.push({ source, target: target[name]! + suffix }); }
      }
    }
    for (const name of ['parsed', 'citations'] as const) {
      const sourceTree = await tree(legacy[name]);
      for (const path of sourceTree.directories) directories.add(join(target[name], relative(legacy[name], path)));
      for (const path of sourceTree.files) transfers.push({ source: path, target: join(target[name], relative(legacy[name], path)) });
    }
    await tree(target.directory);
  }
  for (const path of directories) await assertSafeDirectory(path);
  for (const transfer of transfers) {
    await assertRegularFile(transfer.target, true);
    if (await exists(transfer.target) && await hash(transfer.source) !== await hash(transfer.target)) throw new Error('迁移目标已有不同内容，未覆盖文件');
  }
  if (await exists(backup) && await hash(backup) !== originalHash) throw new Error('已有迁移备份与当前旧库不一致，请保留文件并检查备份');
  await copyVerified(index, backup);
  // Stage and verify all bytes before publishing any live paper file.
  for (const transfer of transfers) await copyVerified(transfer.source, join(stage, relative(directory, transfer.target)));
  for (const path of directories) { await mkdir(path, { recursive: true }); await assertSafeDirectory(path); }
  for (const transfer of transfers) await copyVerified(join(stage, relative(directory, transfer.target)), transfer.target);
  if (await hash(index) !== originalHash) throw new Error('迁移期间文献索引发生变化，未更新索引');
  for (const transfer of transfers) if (await hash(transfer.source) !== await hash(transfer.target)) throw new Error('迁移校验失败，未更新索引');
  const temporary = index + '.migration-' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify({ ...raw, ...next }, null, 2), { flag: 'wx' });
    await rename(temporary, index);
  } finally { await unlink(temporary).catch(() => {}); }
  // Remove only this migration's verified staging files and empty directories after commit.
  // Unknown staging material and every original source file remain untouched.
  const emptyDirectories = new Set<string>([stage, dirname(stage)]);
  for (const transfer of transfers) {
    const staged = join(stage, relative(directory, transfer.target));
    try {
      await assertRegularFile(staged);
      if (await hash(staged) === await hash(transfer.target)) await unlink(staged);
      let path = dirname(staged);
      while (path !== stage) { emptyDirectories.add(path); path = dirname(path); }
    } catch { /* A cleanup failure does not invalidate the committed, verified library. */ }
  }
  for (const path of [...emptyDirectories].sort((a, b) => b.length - a.length)) {
    try { await assertSafeDirectory(path); await rmdir(path); } catch { /* Never recursively remove unknown files. */ }
  }
  return next;
}
