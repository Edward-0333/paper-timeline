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
  /** Most recent authenticated contact, not a persistent socket or a completed sync. */
  lastConnectedAt?: string;
  failure?: CloudFailure;
}

export type CloudStage = 'authentication' | 'subscriptions' | 'local_citations' | 'download' | 'save';
export interface CloudFailure {
  kind: 'network' | 'authentication' | 'server' | 'local_data' | 'local_storage' | 'protocol' | 'sync';
  stage: CloudStage;
  message: string;
  occurredAt: string;
  paperId?: string;
  title?: string;
  file?: string;
  field?: string;
}
export interface CloudProbe {
  state: 'authenticated' | 'unreachable' | 'unauthorized' | 'server_error' | 'protocol_error' | 'not_signed_in' | 'not_checked';
  checkedAt?: string;
  message: string;
}
export interface CloudDiagnosticIssue {
  severity: 'error' | 'warning';
  paperId: string; title: string; file: string; field: string; message: string;
  count?: number;
}
export interface CloudDiagnostics {
  checkedAt: string;
  status: CloudStatus;
  connection: CloudProbe;
  local: { totalPapers: number; offset: number; checkedPapers: number; nextOffset: number | null; issues: CloudDiagnosticIssue[] };
}

/** The same wording in the home card and connection dialog. */
export function cloudConnectionLabel(cloud: CloudStatus, loading = false) {
  if (loading) return '读取中';
  if (cloud.syncing) return '同步中';
  if (cloud.failure?.kind === 'authentication') return '需重新登录';
  if (!cloud.signedIn) return '未登录';
  if (cloud.connected) return cloud.error ? '已连接，同步失败' : '已连接';
  return cloud.error ? '连接失败' : '暂未连接';
}
