export interface CloudUser { id: string; username: string }
export interface CloudOverview { monitored: number; queued: number; failed: number; lastServerFetchAt?: string | null; libraryMonitored?: number; legacyMonitored?: number }
export interface CloudSeed { title: string; authors: string[]; year: number | null; doi: string; arxivId: string }
export interface LegacyMonitor { id: number; revision: number; enabled: boolean; paperId: string; seed: CloudSeed }
export interface CloudBinding { id: number; localId: string; enabled: boolean; revision: number; paperId: string; title?: string }
export interface CloudDifference {
  localId: string; title: string; kind: 'missing' | 'state' | 'version' | 'orphan';
  localEnabled: boolean; remote?: CloudBinding;
}
export interface CloudReview {
  checkedAt: string; differences: CloudDifference[]; bindings: CloudBinding[]; overview: CloudOverview;
  legacy: LegacyMonitor[]; total: number; offset: number; nextOffset: number | null;
}
export interface CloudStatus {
  server?: string;
  user?: CloudUser;
  signedIn: boolean;
  connected: boolean;
  syncing: boolean;
  pending: number;
  legacyPending: number;
  lastSyncAt?: string;
  newCitations: number;
  overview?: CloudOverview;
  reconciliationSupported?: boolean;
  error?: string;
}
