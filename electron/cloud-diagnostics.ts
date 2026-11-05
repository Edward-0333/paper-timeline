import { join, relative } from 'node:path';
import type { Paper } from '../shared/types';
import type { CloudDiagnostics, CloudProbe, CloudStatus } from '../shared/cloud';
import { citationDirectory, CitationFileError, inspectCitationSnapshot } from './citation-monitor';

export interface CloudDiagnosticOptions { offset?: number; limit?: number; checkConnection?: boolean }

/** Bounded, read-only inspection of registered citation files, never arbitrary paths. */
export async function diagnoseCloud(directory: string, papers: Paper[], status: CloudStatus,
  probe: (signal?: AbortSignal) => Promise<CloudProbe>, options: CloudDiagnosticOptions = {}, signal?: AbortSignal): Promise<CloudDiagnostics> {
  const { offset = 0, limit = 20, checkConnection = true } = options;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || typeof checkConnection !== 'boolean' || Object.keys(options).some(k => !['offset', 'limit', 'checkConnection'].includes(k))) throw new Error('无效诊断参数');
  signal?.throwIfAborted();
  const connection: CloudProbe = checkConnection ? await probe(signal) : { state: 'not_checked', message: '本次未主动检查连接；status 仅为同步缓存状态。' };
  const selected = papers.slice(offset, offset + limit), issues: CloudDiagnostics['local']['issues'] = [];
  for (const paper of selected) {
    signal?.throwIfAborted();
    const target = { paperId: paper.id, title: paper.title.slice(0, 300),
      file: relative(directory, join(citationDirectory(directory, paper.id, paper.storageFolder), 'citations.json')).replace(/\\/g, '/') };
    try {
      const inspected = await inspectCitationSnapshot(directory, paper.id, paper.storageFolder);
      if (inspected.missingYears) issues.push({ ...target, severity: 'warning', field: inspected.firstMissingYear!, count: inspected.missingYears,
        message: '历史引用缺少年份，已兼容为未知（null），不会阻断同步；检查未改写原文件。' });
    } catch (error) {
      issues.push({ ...target, severity: 'error', field: error instanceof CitationFileError ? error.field : '$',
        message: error instanceof CitationFileError ? error.reason : '引用文件无法安全读取，请检查文件与权限。' });
    }
  }
  return { checkedAt: new Date().toISOString(), status, connection,
    local: { totalPapers: papers.length, offset, checkedPapers: selected.length, nextOffset: offset + limit < papers.length ? offset + limit : null, issues } };
}
