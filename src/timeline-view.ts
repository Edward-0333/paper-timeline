export interface TimelineView { zoom: number; centerX: number; centerY: number }
export const MIN_TIMELINE_ZOOM = 0.01;
export const MAX_TIMELINE_ZOOM = 1.6;

export function timelineViewKey(storagePath: string) {
  const path = storagePath.replaceAll('\\', '/').replace(/\/+$/, '');
  return `paper-timeline-viewport-v1:${/^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path}`;
}

export function readTimelineView(key: string): TimelineView | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)
      || ![saved.zoom, saved.centerX, saved.centerY].every(value => typeof value === 'number' && Number.isFinite(value))
      || saved.zoom < MIN_TIMELINE_ZOOM || saved.zoom > MAX_TIMELINE_ZOOM
      || Math.abs(saved.centerX) > 1e9 || Math.abs(saved.centerY) > 1e9) return null;
    return { zoom: saved.zoom, centerX: saved.centerX, centerY: saved.centerY };
  } catch { return null; }
}

export function saveTimelineView(key: string, view: TimelineView) {
  try { localStorage.setItem(key, JSON.stringify(view)); }
  catch { /* Unavailable preferences must not block the canvas. */ }
}
