import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, copyFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensurePaperDirectory, paperStoragePaths } from './paper-storage';
import { validateReaderUpdate, type ReaderState, type ReaderUpdate } from '../shared/reader';
const pdfHashes = new Map<string, { size: number; mtime: number; ctime: number; hash: string }>();

export async function readerPdf(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100 * 1024 * 1024) throw new Error('请选择库内小于 100 MB 的 PDF 文件');
  const data = await readFile(path);
  if (!data.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('原文不是有效的 PDF 文件');
  const hash = createHash('sha256').update(data).digest('hex');
  pdfHashes.set(path, { size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, hash });
  return { data, hash };
}
export async function readerHash(path: string) {
  const stat = await lstat(path), cached = pdfHashes.get(path);
  if (stat.isFile() && !stat.isSymbolicLink() && cached && cached.size === stat.size && cached.mtime === stat.mtimeMs && cached.ctime === stat.ctimeMs) return cached.hash;
  return (await readerPdf(path)).hash;
}
async function plain(path: string, dir = false) {
  try { const s = await lstat(path); if (s.isSymbolicLink() || (dir ? !s.isDirectory() : !s.isFile())) throw new Error('阅读标注目录不支持文件链接'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}
export async function readReaderState(directory: string, id: string, pdfHash: string, storageFolder?: string): Promise<ReaderState> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('无效论文编号');
  const file = paperStoragePaths(directory, { id, storageFolder }).annotations;
  if (storageFolder) await plain(join(directory, 'papers'), true);
  await plain(dirname(file), true);
  await plain(file);
  let state: ReaderState;
  try {
    if ((await lstat(file)).size > 22 * 1024 * 1024) throw new Error('标注文件过大');
    state = JSON.parse(await readFile(file, 'utf8'));
  }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, pdfHash, revision: 0, annotations: null, position: { page: 1, zoom: 1 } };
    throw new Error('阅读标注文件损坏，请保留文件并检查备份');
  }
  if (state.version !== 1 || state.pdfHash !== pdfHash || (state.annotations !== null && !Array.isArray(state.annotations))) throw new Error('PDF 与已保存标注不一致，请保留原文和标注文件并核对');
  validateReaderUpdate({ pdfHash: state.pdfHash, revision: state.revision, position: state.position,
    ...(state.annotations === null ? {} : { annotations: state.annotations }) });
  return state;
}
export async function writeReaderState(directory: string, id: string, pdfHash: string, update: ReaderUpdate, storageFolder?: string): Promise<ReaderState> {
  validateReaderUpdate(update);
  if (update.pdfHash !== pdfHash) throw new Error('PDF 原文已变化，未覆盖原有标注');
  const old = await readReaderState(directory, id, pdfHash, storageFolder);
  if (old.revision !== update.revision) throw new Error('阅读标注已被另一窗口更新，请重新打开论文');
  const next: ReaderState = { ...old, revision: old.revision + 1, updatedAt: new Date().toISOString(),
    ...(update.annotations === undefined ? {} : { annotations: update.annotations }),
    ...(update.position === undefined ? {} : { position: update.position }) };
  const file = paperStoragePaths(directory, { id, storageFolder }).annotations, dir = dirname(file);
  if (storageFolder) await ensurePaperDirectory(directory, storageFolder);
  await plain(dir, true); await mkdir(dir, { recursive: true }); await plain(file); await plain(file + '.bak');
  const temp = join(dir, '.' + randomUUID() + '.tmp');
  try {
    await writeFile(temp, JSON.stringify(next, null, 2), { flag: 'wx' });
    try { await copyFile(file, file + '.bak'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
  return next;
}
