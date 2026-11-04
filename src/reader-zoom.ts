import type { ZoomScope } from '@embedpdf/react-pdf-viewer';

export const READER_MIN_ZOOM = 0.1;
export const READER_MAX_ZOOM = 5;
export const READER_ZOOM_STEP = 0.05;

/** One mouse-wheel notch changes at most five percentage points. Small pixel
 * deltas from precision wheels/trackpads keep their finer movement. */
export function readerWheelZoom(current: number, deltaY: number, deltaMode: number) {
  if (!Number.isFinite(deltaY) || !deltaY) return current;
  const unitsPerNotch = deltaMode === 1 ? 3 : deltaMode === 2 ? 1 : 100;
  const notches = Math.max(-1, Math.min(1, deltaY / unitsPerNotch));
  return Math.max(READER_MIN_ZOOM, Math.min(READER_MAX_ZOOM, Math.round((current - notches * READER_ZOOM_STEP) * 1000) / 1000));
}

export function bindReaderWheelZoom(element: HTMLElement, getZoom: () => ZoomScope | undefined) {
  const wheel = (event: WheelEvent) => {
    if ((!event.ctrlKey && !event.metaKey) || event.defaultPrevented || !Number.isFinite(event.deltaY) || !event.deltaY) return;
    const zoom = getZoom();
    if (!zoom) return;
    // EmbedPDF 2.15's native handler multiplies by (1 - deltaY * .01), so a
    // normal 120-pixel notch can immediately shrink to its minimum. Capture
    // only its PDF viewport before that handler; toolbar/sidebar scrolling and
    // touch gestures retain their normal behavior. The SDK is pinned to 2.15.1.
    const viewport = event.composedPath().find((node): node is HTMLElement => node instanceof HTMLElement && node.matches('#document-content .bg-bg-app'));
    if (!viewport) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const current = zoom.getState().currentZoomLevel;
    const next = readerWheelZoom(current, event.deltaY, event.deltaMode);
    if (next === current) return;
    const rect = viewport.getBoundingClientRect();
    zoom.requestZoom(next, { vx: event.clientX - rect.left, vy: event.clientY - rect.top });
  };
  element.addEventListener('wheel', wheel, { capture: true, passive: false });
  return () => element.removeEventListener('wheel', wheel, true);
}
