import type { CitationRecord } from './citation-monitor';
import type { Paper } from './types';

export type CitationLibraryIdentity = Pick<CitationRecord, 'title' | 'doi' | 'arxivId'> & Partial<Pick<CitationRecord, 'id' | 'sources'>>;
export interface CitationOrigin { id: string; sources: CitationRecord['sources'] }
export function citationLibraryDoi(value: string) {
  let result = (value ?? '').trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:\s*)/i, '');
  try { result = decodeURIComponent(result); } catch { /* Keep a literal, unencoded identifier. */ }
  return result.toLowerCase();
}
export function citationLibraryArxiv(value: string) {
  return (value ?? '').trim().replace(/^(?:arxiv\s*:\s*|https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/)/i, '')
    .replace(/\.pdf$/i, '').replace(/v\d+$/i, '').toLowerCase();
}
function titleKey(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
function identities(value: Pick<CitationLibraryIdentity, 'doi' | 'arxivId'>) {
  const doi = citationLibraryDoi(value.doi);
  return { doi, arxiv: citationLibraryArxiv(value.arxivId || doi.match(/^10\.48550\/arxiv\.(.+)$/i)?.[1] || '') };
}
function sourceKey(source: CitationRecord['sources'][number]) {
  const id = source.id.trim().replace(/^https?:\/\/openalex\.org\//i, '');
  return id ? `${source.provider}:${id.toLowerCase()}` : '';
}
export type CitationLibraryMatch = { status: 'missing' | 'ambiguous' | 'conflict' } | { status: 'matched'; paper: Paper };
/** Build once per library change so a long citing list needs no repeated full-library scans. */
export function createCitationLibraryIndex(papers: readonly Paper[]) {
  const indexes = { origin: new Map<string, Paper[]>(), source: new Map<string, Paper[]>(), doi: new Map<string, Paper[]>(), arxiv: new Map<string, Paper[]>(), title: new Map<string, Paper[]>() };
  const add = (index: Map<string, Paper[]>, key: string, paper: Paper) => {
    if (!key) return;
    const entries = index.get(key) ?? [];
    if (!entries.includes(paper)) entries.push(paper);
    index.set(key, entries);
  };
  const keys = new Map<Paper, ReturnType<typeof identities>>();
  for (const paper of papers) {
    const identity = identities(paper); keys.set(paper, identity);
    add(indexes.doi, identity.doi, paper); add(indexes.arxiv, identity.arxiv, paper);
    add(indexes.title, titleKey(paper.title), paper);
    if (paper.catalogKey) add(indexes.title, paper.catalogKey, paper);
    for (const origin of paper.citationOrigins ?? []) {
      add(indexes.origin, origin.id, paper);
      for (const source of origin.sources) add(indexes.source, sourceKey(source), paper);
    }
  }
  return (citation: CitationLibraryIdentity): CitationLibraryMatch => {
    const identity = identities(citation);
    const conflicts = (paper: Paper) => {
      const known = keys.get(paper)!;
      return !!((identity.doi && known.doi && identity.doi !== known.doi) || (identity.arxiv && known.arxiv && identity.arxiv !== known.arxiv));
    };
    const result = (candidates: Paper[]): CitationLibraryMatch => candidates.length > 1 ? { status: 'ambiguous' }
      : candidates.length === 1 ? { status: 'matched', paper: candidates[0] } : { status: 'missing' };
    // Explicit import provenance survives later manual corrections to title and identifiers.
    const origins = citation.id ? indexes.origin.get(citation.id) ?? [] : [];
    if (origins.length) return result(origins);
    const strong = [...new Set([
      ...(indexes.doi.get(identity.doi) ?? []), ...(indexes.arxiv.get(identity.arxiv) ?? []),
      ...(citation.sources ?? []).flatMap(source => indexes.source.get(sourceKey(source)) ?? []),
    ])];
    if (strong.some(conflicts)) return { status: 'conflict' };
    if (strong.length) return result(strong);
    return result((indexes.title.get(titleKey(citation.title)) ?? []).filter(paper => !conflicts(paper)));
  };
}
export function createCitationLibraryMatcher(papers: readonly Paper[]) {
  const match = createCitationLibraryIndex(papers);
  return (citation: CitationLibraryIdentity): Paper | undefined => {
    const result = match(citation);
    return result.status === 'matched' ? result.paper : undefined;
  };
}
