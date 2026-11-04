import { createHash } from 'node:crypto';
import type { CitationRecord, CitationSeed } from '../shared/citation-monitor';
const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';
export const normalizedDoi = (v: unknown) => text(v).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
export const normalizedArxiv = (v: unknown) => text(v).replace(/^https?:\/\/arxiv\.org\/abs\//i, '').replace(/v\d+$/i, '').toLowerCase();
const titleKey = (v: string) => v.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export const seedKey = (s: CitationSeed) => normalizedDoi(s.doi) ? `doi:${normalizedDoi(s.doi)}`
  : normalizedArxiv(s.arxivId) ? `arxiv:${normalizedArxiv(s.arxivId)}` : `title:${titleKey(s.title)}:${s.year ?? ''}`;

function samePaper(a: CitationRecord, b: CitationRecord) {
  if (a.doi && b.doi && a.doi === b.doi) return true;
  if (a.arxivId && b.arxivId && a.arxivId === b.arxivId) return true;
  if (a.sources.some(x => b.sources.some(y => x.provider === y.provider && x.id === y.id))) return true;
  if ((a.doi && b.doi && a.doi !== b.doi) || (a.arxivId && b.arxivId && a.arxivId !== b.arxivId)) return false;
  return titleKey(a.title) === titleKey(b.title) && !!a.year && a.year === b.year
    && a.authors.some(author => b.authors.some(other => titleKey(author) === titleKey(other)));
}

/** Preserve stable IDs and history; a temporarily missing source never removes stored citations. */
export function mergeCitations(previous: CitationRecord[], incoming: CitationRecord[], at: string) {
  const result = structuredClone(previous);
  for (const next of incoming) {
    if (!next.title.trim()) continue;
    // A richer record can bridge two previously unconnected provider records.
    const matches = result.filter(item => samePaper(item, next));
    const target = matches.shift();
    if (!target) { result.push({ ...structuredClone(next), firstSeenAt: next.firstSeenAt || at, lastSeenAt: next.lastSeenAt || at }); continue; }
    for (const item of [...matches, next]) {
      for (const field of ['doi', 'arxivId', 'venue', 'url', 'publicationDate'] as const) if (!target[field]) target[field] = item[field];
      if (!target.year) target.year = item.year;
      if (item.authors.length > target.authors.length) target.authors = [...item.authors];
      if (item.abstract.length > target.abstract.length) target.abstract = item.abstract;
      for (const source of item.sources) if (!target.sources.some(s => s.provider === source.provider && s.id === source.id)) target.sources.push({ ...source });
      if (item.firstSeenAt && item.firstSeenAt < target.firstSeenAt) target.firstSeenAt = item.firstSeenAt;
    }
    for (const duplicate of matches) result.splice(result.indexOf(duplicate), 1);
    target.lastSeenAt = at;
  }
  return result;
}
