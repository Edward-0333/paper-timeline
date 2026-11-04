import type { Paper } from '../shared/types';

export type PaperCollectionKind = 'pdf' | 'md' | 'monitoring';
export type HomeMetric = 'all' | PaperCollectionKind;
export const collectionLabels: Record<PaperCollectionKind, string> = {
  pdf: 'PDF 原文', md: 'Markdown 笔记', monitoring: '本库监控已开启',
};

// Use the same runtime attachment checks for the home count and its list.
export function paperInCollection(paper: Paper, kind: HomeMetric): boolean {
  if (kind === 'all') return true;
  if (kind === 'pdf' || kind === 'md') return !!paper.availableFiles?.[kind];
  return !!(paper.citationMonitoring && paper.citationSubscription);
}
