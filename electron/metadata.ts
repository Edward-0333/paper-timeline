import { XMLParser } from 'fast-xml-parser';
import { load } from 'cheerio';
import { cleanText, normalizeDoi } from './pdf';
import type { ExtractedPdf, PaperMetadata } from '../shared/types';
import { dateFromParts, parsePublicationDate } from '../shared/publication-date';

export type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;
export interface LookupResult { metadata: PaperMetadata; matched: boolean; message: string }
const plain = (s: string) => cleanText(load(s).text());
export function titleSimilarity(a: string, b: string) {
  const normalize = (s: string) => cleanText(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const x = normalize(a), y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const aa = new Set(x.split(' ')), bb = new Set(y.split(' '));
  const intersection = [...aa].filter(t => bb.has(t)).length;
  return 2 * intersection / (aa.size + bb.size);
}
export function localMetadata(pdf: ExtractedPdf): PaperMetadata {
  return { title: pdf.title, authors: pdf.authors, year: pdf.year, publicationDate: dateFromParts([pdf.year]), venue: '', doi: pdf.doi, arxivId: pdf.arxivId, abstract: pdf.abstract, abstractSource: 'PDF', url: '', source: 'PDF', matchMethod: '从 PDF 提取，尚未完成在线核对' };
}
export function parseArxivFeed(xml: string): PaperMetadata[] {
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: false });
  const feed = parser.parse(xml).feed;
  if (!feed?.entry) return [];
  const entries = Array.isArray(feed.entry) ? feed.entry : [feed.entry];
  return entries.filter((e: Record<string, unknown>) => String(e.id).includes('/abs/')).map((e: Record<string, any>) => {
    const publicationDate = parsePublicationDate(String(e.published || '').slice(0, 10)) || '';
    return {
    title: cleanText(String(e.title || '')), authors: (Array.isArray(e.author) ? e.author : e.author ? [e.author] : []).map((a: { name: string }) => cleanText(a.name)),
    year: Number(publicationDate.slice(0, 4)) || null, publicationDate,
    venue: e.journal_ref ? cleanText(e.journal_ref) : 'arXiv 预印本',
    doi: normalizeDoi(e.doi || ''), arxivId: String(e.id).split('/abs/')[1],
    abstract: cleanText(String(e.summary || '')), url: String(e.id).replace(/^http:/, 'https:'),
    source: 'arXiv', matchMethod: 'arXiv 编号精确匹配', retrievedAt: new Date().toISOString(),
    };
  });
}
export function parseArxivHtml(html: string, id: string): PaperMetadata | null {
  const $ = load(html);
  const meta = (name: string) => $(`meta[name="${name}"]`).attr('content') || '';
  const title = meta('citation_title');
  if (!title) return null;
  const abstract = $('blockquote.abstract').clone(); abstract.find('.descriptor').remove();
  // The version's revision date is not its first publication. Prefer the explicit v1
  // history/dateline; use citation_date only when this is demonstrably a v1 page.
  const history = $('.submission-history').text().match(/\[v1\]\s*(?:[A-Za-z]{3},?\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/i)
    || $('.dateline').text().match(/Submitted on\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/i);
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const publicationDate = history ? dateFromParts([Number(history[3]), months.indexOf(history[2].toLowerCase()) + 1, Number(history[1])])
    : /v1$/.test(id) ? parsePublicationDate(meta('citation_date').replaceAll('/', '-')) || '' : '';
  const year = Number(publicationDate.slice(0, 4)) || null;
  return { title: cleanText(title), authors: $('meta[name="citation_author"]').map((_, e) => $(e).attr('content') || '').get(), year, publicationDate: publicationDate || dateFromParts([year]),
    venue: cleanText($('.jref').first().text()) || 'arXiv 预印本', doi: normalizeDoi(meta('citation_doi')), arxivId: id,
    abstract: cleanText(abstract.text().replace(/^\s*Abstract:\s*/i, '')), url: `https://arxiv.org/abs/${id}`, source: 'arXiv', matchMethod: 'arXiv 编号精确匹配', retrievedAt: new Date().toISOString() };
}
export function parseCrossref(item: Record<string, any>): PaperMetadata {
  // Keep Crossref's published date, falling back only to publication fields, never
  // created/deposited/indexed timestamps or the conference event's schedule.
  const publicationDate = ['published', 'published-online', 'published-print']
    .map(field => dateFromParts(item[field]?.['date-parts']?.[0])).find(Boolean) || '';
  return { title: plain(item.title?.[0] || ''), authors: (item.author || []).map((a: { given?: string; family?: string; name?: string }) => cleanText(a.name || `${a.given || ''} ${a.family || ''}`)), year: Number(publicationDate.slice(0, 4)) || null, publicationDate,
    venue: plain(item['container-title']?.[0] || ''), doi: normalizeDoi(item.DOI || ''), arxivId: '', abstract: plain(item.abstract || ''), url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : ''), source: 'Crossref', matchMethod: 'DOI 精确匹配', retrievedAt: new Date().toISOString() };
}

let lastArxivRequest = 0;
export async function lookupMetadata(pdf: ExtractedPdf, fetcher: Fetcher = fetch): Promise<LookupResult> {
  const errors: string[] = [];
  const local = localMetadata(pdf);
  async function request(url: string): Promise<string> {
    if (url.includes('arxiv.org')) {
      const delay = Math.max(0, 3100 - (Date.now() - lastArxivRequest));
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      lastArxivRequest = Date.now();
    }
    const response = await fetcher(url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'PaperTimeline/0.1 (desktop reference manager)', Accept: 'application/json, application/atom+xml, text/html' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }
  const accept = (m: PaperMetadata): LookupResult => ({ metadata: { ...m, abstract: m.abstract || local.abstract, abstractSource: m.abstract ? m.source : 'PDF', arxivId: m.arxivId || local.arxivId }, matched: true, message: `已从 ${m.source} 获取元数据` });
  // An arXiv identifier in the PDF identifies this preprint more reliably than a DOI mentioned in its body.
  if (pdf.arxivId) {
    const bareId = pdf.arxivId.replace(/v\d+$/, '');
    try {
      const items = parseArxivFeed(await request(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(pdf.arxivId)}`));
      const match = items.find(m => m.arxivId.replace(/v\d+$/, '') === bareId && titleSimilarity(pdf.title, m.title) >= 0.75);
      if (match) return accept(match);
    } catch { errors.push('arXiv API 暂时无法连接'); }
    try {
      const match = parseArxivHtml(await request(`https://arxiv.org/abs/${encodeURIComponent(pdf.arxivId)}`), pdf.arxivId);
      if (match && titleSimilarity(pdf.title, match.title) >= 0.75) return accept(match);
    } catch { errors.push('arXiv 页面暂时无法连接'); }
  }
  if (pdf.doi && !pdf.doi.startsWith('10.48550/arxiv.')) {
    try {
      const item = JSON.parse(await request(`https://api.crossref.org/works/${encodeURIComponent(pdf.doi)}`)).message;
      const match = parseCrossref(item);
      if (titleSimilarity(pdf.title, match.title) >= 0.75) return accept(match);
    } catch { errors.push('DOI 查询暂时不可用'); }
  }
  if (pdf.title.length >= 12) {
    try {
      const data = JSON.parse(await request(`https://api.crossref.org/works?query.title=${encodeURIComponent(pdf.title)}&rows=3`));
      const candidates: PaperMetadata[] = (data.message?.items || []).map(parseCrossref);
      const ranked = candidates.map(m => ({ metadata: m, score: titleSimilarity(pdf.title, m.title) })).sort((a, b) => b.score - a.score);
      // A close runner-up is ambiguous; never silently choose one.
      if (ranked[0]?.score >= 0.88 && (!ranked[1] || ranked[0].score - ranked[1].score >= 0.07)) {
        ranked[0].metadata.matchMethod = '标题高相似匹配';
        return accept(ranked[0].metadata);
      }
    } catch { errors.push('Crossref 暂时无法连接'); }
  }
  return { metadata: local, matched: false, message: errors.length ? `${[...new Set(errors)].join('；')}。已保留 PDF 信息，可稍后重试。` : '未找到足够可靠的在线匹配，请核对或补充元数据。' };
}
