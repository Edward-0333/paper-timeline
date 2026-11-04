import { mkdir, readFile, writeFile, rename, copyFile, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Paper } from '../shared/types';
import { type CitationRecord, type CitationSeed, type CitationSnapshot } from '../shared/citation-monitor';
import { ensurePaperDirectory, paperStoragePaths } from './paper-storage';

export function citationSeed(paper: Paper): CitationSeed {
  return { id: paper.id, title: paper.title, authors: [...paper.authors], year: paper.year, doi: paper.doi, arxivId: paper.arxivId };
}
export function citationDirectory(library: string, id: string, storageFolder?: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('无效论文 ID');
  return paperStoragePaths(library, { id, storageFolder }).citations;
}
async function directory(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('引用数据目录不能是文件链接');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(path); }
}
async function plainFile(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('引用数据不能是文件链接');
}
function validCitationRecord(value: unknown): value is CitationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && /^[a-f0-9]{64}$/.test(record.id)
    && ['title', 'venue', 'publicationDate', 'url', 'doi', 'arxivId', 'abstract', 'firstSeenAt', 'lastSeenAt'].every(key => typeof record[key] === 'string')
    && (record.year === null || Number.isSafeInteger(record.year))
    && Array.isArray(record.authors) && record.authors.every(author => typeof author === 'string')
    && Array.isArray(record.sources) && record.sources.every(source => source && typeof source === 'object' && !Array.isArray(source)
      && ['openalex', 'semantic_scholar'].includes(source.provider) && typeof source.id === 'string');
}
export async function readCitationSnapshot(library: string, id: string, storageFolder?: string): Promise<CitationSnapshot | null> {
  const paths = paperStoragePaths(library, { id, storageFolder });
  const dir = citationDirectory(library, id, storageFolder), file = join(dir, 'citations.json');
  try {
    for (const path of storageFolder ? [join(library, 'papers'), paths.directory, dir] : [join(library, 'citations'), dir]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('引用数据目录异常');
    }
    await plainFile(file);
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value?.version !== 1 || value.seed?.id !== id || !Array.isArray(value.citations) || !Array.isArray(value.providers)
      || typeof value.lastAttemptAt !== 'string' || typeof value.nextCheckAt !== 'string'
      || !value.citations.every(validCitationRecord)) throw new Error('引用数据格式异常，请保留原文件并检查备份');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export async function writeCitationSnapshot(library: string, snapshot: CitationSnapshot, storageFolder?: string) {
  if (storageFolder) await ensurePaperDirectory(library, storageFolder);
  else await directory(join(library, 'citations'));
  const dir = citationDirectory(library, snapshot.seed.id, storageFolder);
  await directory(dir);
  const file = join(dir, 'citations.json'), temporary = join(dir, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(snapshot, null, 2), { flag: 'wx' });
    try {
      await plainFile(file);
      try { await plainFile(file + '.bak'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await copyFile(file, file + '.bak');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

