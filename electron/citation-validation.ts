import type { CitationRecord } from '../shared/citation-monitor';

/** Field names and fixed reasons only: never echo external record contents in errors. */
export class CitationDataError extends Error {
  constructor(readonly field: string, readonly reason: string) {
    super(`引用数据格式异常：${field} ${reason}；请保留原文件并检查备份`);
  }
}

export function normalizeCitationRecords(value: unknown, maxRecords = Infinity): CitationRecord[] {
  const fail = (field: string, reason: string): never => { throw new CitationDataError(field, reason); };
  if (!Array.isArray(value)) return fail('citations', '必须是数组');
  if (value.length > maxRecords) return fail('citations', '超过单页数量上限');
  return value.map((item, index) => {
    const path = `citations[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail(path, '必须是对象');
    if (typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.id)) fail(path + '.id', '必须是有效引用 ID');
    for (const key of ['title', 'venue', 'publicationDate', 'url', 'doi', 'arxivId', 'abstract', 'firstSeenAt', 'lastSeenAt']) {
      if (typeof item[key] !== 'string') fail(path + '.' + key, '必须是字符串');
    }
    // Older server responses omit unknown years. Do not invent a year from other metadata.
    if (item.year !== undefined && item.year !== null && !Number.isSafeInteger(item.year)) fail(path + '.year', '必须是整数或 null（未知）');
    if (!Array.isArray(item.authors) || item.authors.some((author: unknown) => typeof author !== 'string')) fail(path + '.authors', '必须是字符串数组');
    if (!Array.isArray(item.sources)) fail(path + '.sources', '必须是数组');
    item.sources.forEach((source: any, sourceIndex: number) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)
        || !['openalex', 'semantic_scholar'].includes(source.provider) || typeof source.id !== 'string') {
        fail(`${path}.sources[${sourceIndex}]`, '来源格式无效');
      }
    });
    return { ...item, year: item.year ?? null } as CitationRecord;
  });
}
