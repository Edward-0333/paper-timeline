import type { Paper, PaperMetadata } from './types';

/** Calendar dates, never timestamps: preserve missing months/days and avoid timezone shifts. */
export function parsePublicationDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1000 || year > 2200) return null;
  if (month !== undefined && (month < 1 || month > 12)) return null;
  if (day !== undefined && (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate())) return null;
  return value;
}

export function dateFromParts(parts: unknown): string {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 3 || parts.some(n => !Number.isInteger(n))) return '';
  return parsePublicationDate(parts.map((n, i) => String(n).padStart(i === 0 ? 4 : 2, '0')).join('-')) || '';
}

export function publicationDateOf(paper: Pick<PaperMetadata, 'year' | 'publicationDate'>): string {
  return parsePublicationDate(paper.publicationDate) || parsePublicationDate(String(paper.year)) || '';
}

export function formatPublicationDate(date: string, omitYear = false): string {
  if (!parsePublicationDate(date)) return '日期待补充';
  const [year, month, day] = date.split('-').map(Number);
  if (omitYear && !month) return '仅年份';
  return `${omitYear ? '' : `${year} 年`}${month ? `${omitYear ? '' : ' '}${month} 月` : ''}${day ? ` ${day} 日` : ''}`;
}

export function groupPapersByPublication(papers: Paper[]): { year: string; papers: Paper[] }[] {
  const groups = new Map<string, Paper[]>();
  // Unknown month/day follows known dates within the same year/month. Equal dates use
  // title and content ID for stable order; import time never determines the timeline.
  const sorted = [...papers].sort((a, b) => publicationDateOf(b).localeCompare(publicationDateOf(a))
    || a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id));
  for (const paper of sorted) {
    const year = publicationDateOf(paper).slice(0, 4);
    if (!groups.has(year)) groups.set(year, []);
    groups.get(year)!.push(paper);
  }
  return [...groups].map(([year, items]) => ({ year, papers: items }));
}
