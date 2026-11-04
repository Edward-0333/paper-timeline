import type { Paper, TimelineChanges, TimelinePosition, TimelineTrack } from './types';
import { paperMatchesTags, tagKey } from './paper-tags';

export const MAX_TIMELINES = 100;
export const POSITION_LIMIT = 100000;
export const DEFAULT_TIMELINE_ID = '00000000-0000-4000-8000-000000000001';
export function defaultTimelines(): TimelineTrack[] {
  return [{ id: DEFAULT_TIMELINE_ID, tags: [], tagMode: 'all', configured: true, position: { x: 32, y: 275 } }];
}
export function timelinePapers(papers: Paper[], track: TimelineTrack): Paper[] {
  return track.configured ? papers.filter(paper => paperMatchesTags(paper, track.tags, track.tagMode)) : [];
}
export function timelinePosition(value: unknown): TimelinePosition {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'x' && key !== 'y')) throw new Error('时间线位置需包含 x、y 坐标');
  const { x, y } = value as TimelinePosition;
  if (![x, y].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= POSITION_LIMIT)) throw new Error('时间线坐标需为 -100000 到 100000 之间的有限数');
  return { x, y };
}
export function timelineChanges(value: unknown): TimelineChanges {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length
    || Object.keys(value).some(key => !['tags', 'tagMode', 'position'].includes(key))) throw new Error('请提供时间线的标签、筛选方式或位置');
  const input = value as TimelineChanges, result: TimelineChanges = {};
  if ('tags' in input) {
    if (!Array.isArray(input.tags) || input.tags.length > 100 || input.tags.some(text => typeof text !== 'string'
      || !text.trim() || text.length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(text))) throw new Error('时间线最多选择 100 个标签，每个标签需为 1–80 个字符');
    result.tags = [...new Set(input.tags.map(tagKey))];
  }
  if ('tagMode' in input) {
    if (input.tagMode !== 'all' && input.tagMode !== 'any') throw new Error('筛选方式需为 all（交集）或 any（并集）');
    result.tagMode = input.tagMode;
  }
  if ('position' in input) result.position = timelinePosition(input.position);
  return result;
}
export function validateTimelines(value: unknown): TimelineTrack[] {
  if (!Array.isArray(value) || value.length > MAX_TIMELINES) throw new Error('时间线信息异常，请保留文献库并恢复备份');
  const ids = new Set<string>();
  return value.map(track => {
    if (!track || typeof track !== 'object' || typeof track.id !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(track.id)
      || ids.has(track.id) || typeof track.configured !== 'boolean') throw new Error('时间线信息异常，请保留文献库并恢复备份');
    const fields = timelineChanges({ tags: track.tags, tagMode: track.tagMode, position: track.position });
    ids.add(track.id);
    return { id: track.id, configured: track.configured, tags: fields.tags!, tagMode: fields.tagMode!, position: fields.position! };
  });
}
