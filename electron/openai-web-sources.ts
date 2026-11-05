import { createHash } from 'node:crypto';
import type { AgentActivity, AgentSource } from '../shared/model-chat';

const MAX_SOURCES = 100;
const marker = /^\uE200cite\uE202[^\uE201]*\uE201$/u;
const markdownLabel = (value: string) => value.replace(/[\\`*_[\]{}()<>#!|]/g, '\\$&');

/** Validate provider-supplied links before they enter Markdown or the saved source list. */
export function openaiSourceUrl(value: unknown, redact: (text: string) => string): string | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f<>\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    let decoded = value;
    for (let depth = 0; depth < 4; depth++) {
      if (redact(decoded) !== decoded || /\b(?:sk|tvly)-[A-Za-z0-9_-]{8,}/i.test(decoded)) return null;
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
      if (depth === 3) return null;
    }
    if ([...url.searchParams].some(([key, token]) => token && /^(?:api[_-]?key|access[_-]?token|auth(?:orization)?|secret|password|token)$/i.test(key))) return null;
    return url.href;
  } catch { return null; }
}

/** Keeps only actual provider citations, preserves cited prose, and makes citations clickable inline. */
export function prepareOpenaiWebResponse(body: unknown, redact: (text: string) => string, retrievedAt = new Date().toISOString()) {
  const sources: AgentSource[] = [], activity: AgentActivity[] = [];
  let calls = 0;
  if (!body || typeof body !== 'object' || !Array.isArray((body as any).output)) return { sources, activity, calls };
  const output: any[] = (body as any).output;
  const readPages = new Set<string>();
  for (const item of output) {
    if (item?.type !== 'web_search_call') continue;
    calls++;
    const action = item.action?.type;
    activity.push({ tool: 'web_search', label: action === 'open_page' ? 'OpenAI 已读取网页' : action === 'find_in_page' ? 'OpenAI 已查找网页内容' : 'OpenAI 联网搜索', status: item.status === 'completed' ? 'succeeded' : 'failed' });
    if (item.status === 'completed' && action === 'open_page') {
      const url = openaiSourceUrl(item.action.url, redact); if (url) readPages.add(url);
    }
    // Search results are untrusted input to the next model step as well as to the UI.
    if (Array.isArray(item.action?.sources)) item.action.sources = item.action.sources.filter((source: any) => source?.type === 'url' && openaiSourceUrl(source.url, redact));
  }
  const seen = new Set<string>();
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type !== 'output_text' || typeof part.text !== 'string' || !Array.isArray(part.annotations)) continue;
      const original: string = part.text;
      const edits: { start: number; end: number; link: string }[] = [];
      const validAnnotations: any[] = [];
      for (const annotation of part.annotations.slice(0, MAX_SOURCES)) {
        if (annotation?.type !== 'url_citation') { validAnnotations.push(annotation); continue; }
        const url = openaiSourceUrl(annotation.url, redact);
        if (!url) continue;
        const label = redact(typeof annotation.title === 'string' ? annotation.title : '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 500) || new URL(url).hostname;
        const start = annotation.start_index, end = annotation.end_index;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > original.length) continue;
        if (!seen.has(url) && sources.length < MAX_SOURCES) {
          seen.add(url); sources.push({ id: 'openai-web:' + createHash('sha256').update(url).digest('hex'), label, url, retrievedAt, kind: readPages.has(url) ? 'web-page' : 'web-search' });
        }
        validAnnotations.push({ ...annotation, url, title: label });
        const citation = original.slice(start, end);
        const link = ` [${markdownLabel(label)}](<${url}>)`;
        const existing = edits.find(edit => edit.end === end);
        if (existing) { if (!existing.link.includes(link)) existing.link += link; }
        else edits.push({ start: marker.test(citation) ? start : end, end, link });
      }
      // Right-to-left edits use original provider offsets; overlapping or duplicate citations never delete prose.
      let boundary = original.length + 1;
      let text = original;
      for (const edit of edits.sort((a, b) => b.end - a.end || b.start - a.start)) {
        if (edit.end >= boundary) continue;
        text = text.slice(0, edit.start) + edit.link + text.slice(edit.end);
        boundary = edit.start;
      }
      part.text = text;
      // SDK source mapping does not need the old offsets after our inline rendering.
      part.annotations = validAnnotations.map(annotation => annotation.type === 'url_citation'
        ? { ...annotation, start_index: 0, end_index: 0 } : annotation);
    }
  }
  return { sources, activity, calls };
}
