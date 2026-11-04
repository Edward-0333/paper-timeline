import type { Paper } from './types';

/** Same deduplicated, locally saved citing-paper count as the details panel.
 * A new/pending monitor's default zero is not evidence of zero citations. */
export function citationCountOf(paper: Pick<Paper, 'citationMonitor'>): number | null {
  const state = paper.citationMonitor;
  if (!state || !Number.isSafeInteger(state.count) || state.count < 0) return null;
  return state.count > 0 || state.lastSuccessAt || state.status === 'success' || state.status === 'partial' ? state.count : null;
}
