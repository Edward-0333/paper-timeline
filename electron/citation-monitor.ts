import { mkdir, readFile, writeFile, rename, copyFile, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Paper } from '../shared/types';
import { type CitationSeed, type CitationSnapshot } from '../shared/citation-monitor';
import { ensurePaperDirectory, paperStoragePaths } from './paper-storage';
import { CitationDataError, normalizeCitationRecords } from './citation-validation';

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
export class CitationFileError extends CitationDataError {
  constructor(readonly paperId: string, field: string, reason: string) { super(field, reason); }
}
function normalizeSnapshot(value: any, id: string): CitationSnapshot {
  const fail = (field: string, reason: string): never => { throw new CitationDataError(field, reason); };
  if (!value || value.version !== 1) fail('version', '版本无效');
  if (value.seed?.id !== id) fail('seed.id', '与当前论文不匹配');
  if (!Array.isArray(value.providers)) fail('providers', '必须是数组');
  for (const field of ['lastAttemptAt', 'nextCheckAt']) if (typeof value[field] !== 'string') fail(field, '必须是字符串');
  return { ...value, citations: normalizeCitationRecords(value.citations) };
}
/** Inspect only the registered snapshot; compatibility normalization never rewrites it. */
export async function inspectCitationSnapshot(library: string, id: string, storageFolder?: string): Promise<{ snapshot: CitationSnapshot | null; missingYears: number; firstMissingYear?: string }> {
  const paths = paperStoragePaths(library, { id, storageFolder });
  const dir = citationDirectory(library, id, storageFolder), file = join(dir, 'citations.json');
  try {
    for (const path of storageFolder ? [join(library, 'papers'), paths.directory, dir] : [join(library, 'citations'), dir]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('引用数据目录异常');
    }
    await plainFile(file);
    const value = JSON.parse(await readFile(file, 'utf8'));
    const snapshot = normalizeSnapshot(value, id);
    const first = value.citations.findIndex((record: any) => record.year === undefined);
    return { snapshot, missingYears: value.citations.filter((record: any) => record.year === undefined).length,
      ...(first < 0 ? {} : { firstMissingYear: `citations[${first}].year` }) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { snapshot: null, missingYears: 0 };
    if (error instanceof CitationDataError) throw new CitationFileError(id, error.field, error.reason);
    if (error instanceof SyntaxError) throw new CitationFileError(id, '$', 'JSON 无法解析');
    throw new CitationFileError(id, '$', '文件无法安全读取，请检查目录、文件链接与访问权限');
  }
}
export async function readCitationSnapshot(library: string, id: string, storageFolder?: string): Promise<CitationSnapshot | null> {
  return (await inspectCitationSnapshot(library, id, storageFolder)).snapshot;
}
export async function writeCitationSnapshot(library: string, snapshot: CitationSnapshot, storageFolder?: string) {
  snapshot = normalizeSnapshot(snapshot, snapshot.seed.id);
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

