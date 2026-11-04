export type CitationProvider = 'openalex' | 'semantic_scholar';
export interface CitationSeed {
  id: string; title: string; authors: string[]; year: number | null; doi: string; arxivId: string;
}
export interface CitationRecord {
  id: string;
  title: string; authors: string[]; year: number | null; publicationDate: string;
  venue: string; doi: string; arxivId: string; abstract: string; url: string;
  sources: { provider: CitationProvider; id: string }[];
  firstSeenAt: string; lastSeenAt: string;
}
export interface CitationProviderResult {
  provider: CitationProvider;
  status: 'success' | 'partial' | 'error' | 'not_found';
  seedIds: string[];
  count: number;
  message: string;
}
export interface CitationFetchResult {
  citations: CitationRecord[];
  providers: CitationProviderResult[];
}
export interface CitationSnapshot {
  version: 1;
  seed: CitationSeed;
  lastAttemptAt: string;
  lastSuccessAt?: string;
  nextCheckAt: string;
  providers: CitationProviderResult[];
  citations: CitationRecord[];
}
export interface CitationMonitorState {
  status: 'idle' | 'queued' | 'fetching' | 'success' | 'partial' | 'error' | 'pending' | 'migration';
  count: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  nextCheckAt?: string;
  message?: string;
}
export interface CitationPage {
  id: string;
  enabled: boolean;
  directory: string;
  state?: CitationMonitorState;
  providers: CitationProviderResult[];
  total: number;
  offset: number;
  limit: number;
  citations: CitationRecord[];
}
