import { lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import type { Paper } from '../shared/types';

type StoragePaper = Pick<Paper, 'id' | 'pdfHash' | 'storageFolder'>;
const ID = /^[a-f0-9]{64}$/;
export function validateStorageFolder(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 120 || value !== value.trim()
    || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(value) || /[. ]$/.test(value)
    || value === '.' || value === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new Error('文献资料文件夹名称异常，请保留文献库并检查备份');
  }
}
export function storageFolderName(title: string, id: string, occupied: Iterable<string> = []): string {
  if (!ID.test(id)) throw new Error('无效的文献 ID');
  const names = new Set([...occupied].map(name => name.toLowerCase()));
  let slug = [...title.normalize('NFKC').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()]
    .slice(0, 40).join('').replace(/[. ]+$/, '') || 'Paper';
  while (slug.length > 40) slug = [...slug].slice(0, -1).join('');
  for (const length of [12, 20, 32, 64]) {
    const candidate = `${slug}__${id.slice(0, length)}`;
    validateStorageFolder(candidate);
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error('文献资料文件夹发生重名，请检查文献库');
}
export function paperStoragePaths(directory: string, paper: StoragePaper) {
  if (!ID.test(paper.id)) throw new Error('无效的文献 ID');
  const hash = paper.pdfHash === undefined ? paper.id : paper.pdfHash;
  if (hash !== null && !ID.test(hash)) throw new Error('无效的 PDF 哈希');
  if (paper.storageFolder !== undefined) {
    validateStorageFolder(paper.storageFolder);
    const folder = join(directory, 'papers', paper.storageFolder);
    return { directory: folder, pdf: hash === null ? null : join(folder, 'original.pdf'), markdown: join(folder, 'notes.md'),
      annotations: join(folder, 'annotations.json'), parsed: join(folder, 'parsed'), citations: join(folder, 'citations') };
  }
  return { directory, pdf: hash === null ? null : join(directory, 'pdfs', `${hash}.pdf`), markdown: join(directory, 'notes', `${paper.id}.md`),
    annotations: join(directory, 'annotations', `${paper.id}.json`), parsed: join(directory, 'parsed', paper.id), citations: join(directory, 'citations', paper.id) };
}
function ancestors(path: string) {
  const list: string[] = []; let current = resolve(path);
  while (current !== parse(current).root) { list.unshift(current); current = dirname(current); }
  list.unshift(current); return list;
}
/** Validate existing ancestors before recursive mkdir/read; missing paths remain allowed. */
export async function assertSafeDirectory(path: string) {
  for (const part of ancestors(path)) {
    try {
      const info = await lstat(part);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('文献库路径必须是本地文件夹，不能包含链接');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export function assertSafeDirectorySync(path: string) {
  for (const part of ancestors(path)) {
    try {
      const info = lstatSync(part);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('文献库路径必须是本地文件夹，不能包含链接');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export async function ensurePaperDirectory(directory: string, storageFolder: string) {
  validateStorageFolder(storageFolder);
  const path = join(directory, 'papers', storageFolder);
  await assertSafeDirectory(path); await mkdir(path, { recursive: true }); await assertSafeDirectory(path);
  return path;
}
export async function assertRegularFile(path: string, allowMissing = false) {
  await assertSafeDirectory(dirname(path));
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('文献资料必须是本地文件，不能包含链接');
  } catch (error) { if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
/** Publish a complete new attachment; failed writes cannot strand a partial original.pdf. */
export async function writeNewPaperFile(destination: string, buffer: Buffer) {
  await assertRegularFile(destination, true);
  const absent = async () => {
    try { await lstat(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    throw new Error('论文资料文件已存在，不能覆盖');
  };
  await absent();
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try {
    try { await handle.writeFile(buffer); } finally { await handle.close(); }
    await assertSafeDirectory(dirname(destination)); await absent();
    await rename(temporary, destination);
  } finally { await unlink(temporary).catch(() => {}); }
}
