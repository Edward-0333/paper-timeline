import type { CitationInput, ExtractedPdf, PaperMetadata } from '../shared/types';
import { cleanText, normalizeDoi } from './pdf';
import { parsePublicationDate } from '../shared/publication-date';

export function catalogKey(title: string) {
  return title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
export function citationMetadata(fields: CitationInput): PaperMetadata {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)
    || Object.keys(fields).some(k => !['title', 'authors', 'publicationDate', 'venue', 'doi', 'arxivId', 'abstract'].includes(k))) throw new Error('文献信息格式不正确');
  if (typeof fields.title !== 'string' || !fields.title.trim() || fields.title.length > 2000) throw new Error('请输入文献标题');
  for (const field of ['publicationDate', 'venue', 'doi', 'arxivId', 'abstract'] as const) {
    if (fields[field] !== undefined && (typeof fields[field] !== 'string' || fields[field].length > 30000)) throw new Error('文献信息格式不正确');
  }
  if (fields.authors !== undefined && (!Array.isArray(fields.authors) || fields.authors.length > 2000 || fields.authors.some(a => typeof a !== 'string' || a.length > 500))) throw new Error('作者格式不正确');
  const publicationDate = (fields.publicationDate ?? '').trim();
  if (publicationDate && !parsePublicationDate(publicationDate)) throw new Error('日期请填写年、年-月或年-月-日');
  const doi = normalizeDoi(fields.doi ?? '');
  if (doi && !/^10\.\d{4,9}\/\S+$/i.test(doi)) throw new Error('DOI 格式不正确');
  const arxivId = (fields.arxivId ?? '').trim() || doi.match(/^10\.48550\/arxiv\.(.+)$/i)?.[1] || '';
  if (arxivId && !/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.test(arxivId)) throw new Error('arXiv 编号格式不正确');
  return { title: cleanText(fields.title), authors: (fields.authors ?? []).map(cleanText).filter(Boolean), publicationDate,
    year: publicationDate ? Number(publicationDate.slice(0, 4)) : null, venue: fields.venue?.trim() ?? '', doi, arxivId,
    abstract: fields.abstract ?? '', abstractSource: '导入', source: '导入', matchMethod: '导入的书目信息，尚未完成在线核对',
    url: doi ? `https://doi.org/${doi}` : arxivId ? `https://arxiv.org/abs/${arxivId}` : '' };
}
export function citationQuery(paper: PaperMetadata): ExtractedPdf {
  return { title: paper.title, authors: paper.authors, year: paper.year, doi: paper.doi, arxivId: paper.arxivId,
    abstract: paper.abstract, firstPageText: '', pageCount: 0 };
}
/** Incomplete online records must not erase known fields from the imported citation. */
export function mergeCitationMetadata(previous: PaperMetadata, found: PaperMetadata): PaperMetadata {
  return { ...found, title: found.title || previous.title, authors: found.authors.length ? found.authors : previous.authors,
    publicationDate: found.publicationDate || previous.publicationDate, year: found.year ?? previous.year,
    venue: found.venue || previous.venue, doi: found.doi || previous.doi, arxivId: found.arxivId || previous.arxivId,
    url: found.url || previous.url, abstract: found.abstract || previous.abstract,
    abstractSource: found.abstractSource === 'PDF' || !found.abstract ? previous.abstractSource ?? previous.source : found.abstractSource ?? found.source };
}
