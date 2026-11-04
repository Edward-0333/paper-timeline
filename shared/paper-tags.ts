import type { Paper } from './types';

export type TagMatchMode = 'all' | 'any';

export interface TagFilterOption {
  key: string;
  text: string;
  color: string;
  count: number;
}

/** Tag names, rather than per-paper tag IDs or colors, identify a filter. */
export function tagKey(text: string): string {
  return text.trim().toLowerCase();
}

/** Reuse the most common color for a name; a lexical tie makes legacy migration independent of paper order. */
export function collectTagColors(papers: readonly Pick<Paper, 'tags'>[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const paper of papers) for (const tag of paper.tags ?? []) {
    const key = tagKey(tag.text), color = tag.color.toUpperCase();
    if (!key) continue;
    let colors = counts.get(key);
    if (!colors) { colors = new Map(); counts.set(key, colors); }
    colors.set(color, (colors.get(color) ?? 0) + 1);
  }
  const result = new Map<string, string>();
  for (const [key, colors] of counts) {
    const selected = [...colors].sort(([colorA, countA], [colorB, countB]) => countB - countA
      || (colorA < colorB ? -1 : colorA > colorB ? 1 : 0))[0];
    result.set(key, selected[0]);
  }
  return result;
}

export function paperHasTag(paper: Paper, text: string): boolean {
  const key = tagKey(text);
  return key !== '' && !!paper.tags?.some(tag => tagKey(tag.text) === key);
}

/** No selection means no tag restriction, for both intersection and union. */
export function paperMatchesTags(paper: Paper, texts: readonly string[], mode: TagMatchMode = 'all'): boolean {
  const selected = [...new Set(texts.map(tagKey).filter(Boolean))];
  if (!selected.length) return true;
  const names = new Set((paper.tags ?? []).map(tag => tagKey(tag.text)));
  return mode === 'any' ? selected.some(key => names.has(key)) : selected.every(key => names.has(key));
}

const tagNames = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export function collectTagOptions(papers: readonly Paper[]): TagFilterOption[] {
  const options = new Map<string, TagFilterOption>();
  const colors = collectTagColors(papers);
  for (const paper of papers) {
    const seen = new Set<string>();
    for (const tag of paper.tags ?? []) {
      const key = tagKey(tag.text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const option = options.get(key);
      if (option) option.count += 1;
      else options.set(key, { key, text: tag.text.trim(), color: colors.get(key)!, count: 1 });
    }
  }
  return [...options.values()].sort((a, b) => tagNames.compare(a.text, b.text)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
