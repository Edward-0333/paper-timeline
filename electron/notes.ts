import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, dirname } from 'node:path';
import type { MarkdownNote, ReadingRecord } from '../shared/types';
import { assertRegularFile, assertSafeDirectory, ensurePaperDirectory, paperStoragePaths } from './paper-storage';
import { MAX_MARKDOWN_BYTES, validateMarkdownUpdate, type MarkdownDocument, type MarkdownUpdate } from '../shared/notes-editor';

export const MAX_NOTE_BYTES = MAX_MARKDOWN_BYTES;
export function validateNote(note: unknown): asserts note is MarkdownNote {
  const n = note as MarkdownNote;
  if (!n || typeof n !== 'object' || typeof n.fileName !== 'string' || n.fileName.length > 255
    || !n.fileName || /[\\/\x00-\x1f]/.test(n.fileName) || extname(n.fileName).toLowerCase() !== '.md'
    || typeof n.importedAt !== 'string' || !Number.isFinite(Date.parse(n.importedAt))
    || typeof n.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(n.sourceHash)) throw new Error('Markdown 笔记信息异常，请保留文献库并检查备份');
}
export function validateReadingRecord(record: unknown): asserts record is ReadingRecord {
  const r = record as ReadingRecord;
  if (!r || typeof r !== 'object' || typeof r.source !== 'string' || !r.source.trim() || r.source.length > 500
    || !Array.isArray(r.fields) || r.fields.length < 1 || r.fields.length > 32
    || r.fields.some(f => !f || typeof f.label !== 'string' || !f.label.trim() || f.label.length > 80
      || typeof f.value !== 'string' || f.value.length > 30000)) throw new Error('阅读记录格式不正确');
}
function noteFile(directory: string, id: string, storageFolder?: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('无效的文献 ID');
  return paperStoragePaths(directory, { id, storageFolder }).markdown;
}
async function noteDirectory(directory: string, id: string, create = false, storageFolder?: string) {
  const folder = dirname(noteFile(directory, id, storageFolder));
  await assertSafeDirectory(folder);
  if (create) {
    if (storageFolder) await ensurePaperDirectory(directory, storageFolder);
    else await mkdir(folder, { recursive: true });
  }
  for (const path of storageFolder ? [join(directory, 'papers'), folder] : [folder]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('笔记文件夹必须是文献库中的本地文件夹');
  }
  return folder;
}
export async function markdownPath(directory: string, id: string, storageFolder?: string): Promise<string> {
  const folder = await noteDirectory(directory, id, false, storageFolder);
  const file = noteFile(directory, id, storageFolder), info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || dirname(await realpath(file)) !== await realpath(folder)) throw new Error('笔记文件必须是文献库中的本地 Markdown 文件');
  return file;
}

/** Read an existing registered note without recovering over missing/corrupt originals. */
export async function readMarkdownDocument(directory: string, id: string, note: MarkdownNote, storageFolder?: string): Promise<MarkdownDocument> {
  validateNote(note);
  const path = await markdownPath(directory, id, storageFolder), before = await lstat(path);
  if (before.nlink !== 1) throw new Error('Markdown 笔记不支持文件链接');
  if (before.size > MAX_NOTE_BYTES) throw new Error('Markdown 笔记不能超过 10 MB');
  const handle = await open(path, 'r');
  let buffer: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('笔记文件正在变化，请重新加载');
    buffer = Buffer.alloc(before.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await handle.stat(), current = await lstat(path);
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1) throw new Error('笔记文件正在变化，请重新加载');
    buffer = buffer.subarray(0, total);
    try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new Error('Markdown 笔记不是有效的 UTF-8 文件，请保留文件并检查备份'); }
    if (buffer.includes(0)) throw new Error('Markdown 笔记含有二进制内容，请保留文件并检查备份');
  } finally { await handle.close(); }
  return { id, content: buffer.toString('utf8'), revision: createHash('sha256').update(buffer).digest('hex'), fileName: note.fileName, path };
}

/** Library serializes this compare-and-save operation with other accepted edits. */
export async function writeMarkdownDocument(directory: string, id: string, note: MarkdownNote, update: MarkdownUpdate, storageFolder?: string): Promise<MarkdownDocument> {
  validateMarkdownUpdate(update);
  const current = await readMarkdownDocument(directory, id, note, storageFolder);
  // An IPC response can be lost after publish. Retrying identical content is safe.
  if (current.content === update.content) return current;
  if (current.revision !== update.revision) throw new Error('笔记已被外部修改，请保留当前草稿并重新加载文件后核对，未覆盖文件');
  const file = current.path, backup = file + '.bak', folder = dirname(file);
  await assertRegularFile(backup, true);
  try { if ((await lstat(backup)).nlink !== 1) throw new Error('Markdown 备份不支持文件链接'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(folder, '.' + randomUUID() + '.md.tmp'), backupTemporary = join(folder, '.' + randomUUID() + '.md.bak.tmp');
  const stage = async (path: string, content: string) => {
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  };
  try {
    await stage(temporary, update.content); await stage(backupTemporary, current.content);
    const latest = await readMarkdownDocument(directory, id, note, storageFolder);
    if (latest.revision !== current.revision) throw new Error('笔记已被外部修改，请保留当前草稿并重新加载文件后核对，未覆盖文件');
    await assertRegularFile(backup, true);
    try { if ((await lstat(backup)).nlink !== 1) throw new Error('Markdown 备份不支持文件链接'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Publish complete files only. If original publish fails, its bytes remain intact
    // and the backup still contains a complete, recoverable copy of those bytes.
    await rename(backupTemporary, backup);
    const checked = await readMarkdownDocument(directory, id, note, storageFolder);
    if (checked.revision !== current.revision) throw new Error('笔记已被外部修改，请保留当前草稿并重新加载文件后核对，未覆盖文件');
    await rename(temporary, file);
  } finally { await Promise.all([unlink(temporary).catch(() => {}), unlink(backupTemporary).catch(() => {})]); }
  return { ...current, content: update.content, revision: createHash('sha256').update(update.content, 'utf8').digest('hex') };
}
/** Keep Markdown bytes unchanged, including frontmatter and line endings. */
export async function copyMarkdown(directory: string, id: string, source: string, existing?: MarkdownNote, storageFolder?: string) {
  if (typeof source !== 'string' || !isAbsolute(source) || extname(source).toLowerCase() !== '.md') throw new Error('请选择绝对路径的 Markdown（.md）文件');
  const handle = await open(source, 'r');
  let buffer: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_NOTE_BYTES) throw new Error('请选择小于 10 MB 的 Markdown 文件');
    buffer = Buffer.alloc(info.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== info.size) throw new Error('笔记正在变化，请保存后重试');
    buffer = buffer.subarray(0, total);
    try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new Error('请先将 Markdown 文件保存为 UTF-8 编码'); }
    if (buffer.includes(0)) throw new Error('文件内容不是 Markdown 文本');
  } finally { await handle.close(); }
  const sourceHash = createHash('sha256').update(buffer).digest('hex');
  if (existing) {
    await markdownPath(directory, id, storageFolder);
    if (existing.sourceHash === sourceHash) return { note: existing, rollback: async () => {} };
    throw new Error('这篇文献已有笔记，请点击笔记图标编辑库中副本，避免覆盖现有内容');
  }
  const note: MarkdownNote = { fileName: basename(source), importedAt: new Date().toISOString(), sourceHash };
  validateNote(note);
  await noteDirectory(directory, id, true, storageFolder);
  const destination = noteFile(directory, id, storageFolder);
  await writeFile(destination, buffer, { flag: 'wx' });
  return { note, rollback: () => unlink(destination) };
}
