import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Maximize, Minus, PencilLine, Plus, StickyNote, Tag, Trash2 } from 'lucide-react';
import type { Paper, PaperFileKind, PaperTagPosition, TimelineTrack, TimelineChanges, TimelinePosition } from '../shared/types';
import type { CardSize } from './timeline-layout';
import { layoutTimelineBoard } from './timeline-board';
import TimelineLane from './TimelineLane';
import TagDialog from './TagDialog';
import type { TagFilterOption } from '../shared/paper-tags';
import { MAX_TIMELINE_ZOOM, readTimelineView, saveTimelineView, timelineViewKey, type TimelineView } from './timeline-view';

interface Props {
  storagePath: string;
  selectedTrackId: string | null;
  onSelectTrack: (id: string) => void;
  papers: Paper[]; selectedId: string | null; onSelect: (id: string) => void; renderStatus: (paper: Paper) => ReactNode;
  tagOptions: TagFilterOption[]; tracks: TimelineTrack[];
  onCreateTimeline: (position: TimelinePosition) => Promise<unknown>;
  onUpdateTimeline: (id: string, changes: TimelineChanges) => Promise<unknown>;
  onDeleteTimeline: (id: string) => Promise<unknown>;
  emptyTitle: string; emptyDescription: string; revealSelected: boolean;
  onAddTag: (id: string, text: string, color: string) => Promise<unknown>;
  onUpdateTag: (id: string, tagId: string, text: string, color: string) => Promise<unknown>;
  onMoveTag: (id: string, tagId: string, position: PaperTagPosition) => Promise<unknown>;
  onMoveFileTag: (id: string, kind: PaperFileKind, position: PaperTagPosition) => Promise<unknown>;
  onOpenFile: (id: string, kind: PaperFileKind) => Promise<unknown>;
  onDeleteTag: (id: string, tagId: string) => Promise<unknown>;
}
const MAX_ZOOM = MAX_TIMELINE_ZOOM;

export default function TimelineCanvas({ papers, selectedId, onSelect, renderStatus, onAddTag, onUpdateTag, onDeleteTag, onMoveTag, onMoveFileTag, onOpenFile,
  storagePath, selectedTrackId, onSelectTrack, tagOptions, tracks, onCreateTimeline, onUpdateTimeline, onDeleteTimeline, emptyTitle, emptyDescription, revealSelected }: Props) {
  const viewKey = timelineViewKey(storagePath);
  const noteKey = `${viewKey}:brief-notes`;
  const [showBriefNotes, setShowBriefNotes] = useState(() => { try { return localStorage.getItem(noteKey) === 'true'; } catch { return false; } });
  const [savedView] = useState(() => readTimelineView(viewKey));
  const viewInitialized = useRef(false);
  const latestView = useRef<TimelineView | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [measurements, setMeasurements] = useState<{ key: string; sizes: Map<string, CardSize>; filters: Map<string, CardSize> }>(() => ({ key: '', sizes: new Map(), filters: new Map() }));
  const [draftPositions, setDraftPositions] = useState<Record<string, TimelinePosition>>({});
  const layout = useMemo(() => layoutTimelineBoard(papers, tracks.map(track => draftPositions[track.id] ? { ...track, position: draftPositions[track.id] } : track), measurements.sizes, measurements.filters), [papers, tracks, draftPositions, measurements.sizes, measurements.filters]);
  const [laneDragging, setLaneDragging] = useState(false);
  const [creating, setCreating] = useState(false);
  // A paper may occur in several lanes; its active card is identified by both
  // the paper and the lane that was clicked, not by the paper ID alone.
  const selectedLane = layout.lanes.find(lane => lane.track.id === selectedTrackId && lane.papers.some(paper => paper.id === selectedId))
    ?? layout.lanes.find(lane => lane.papers.some(paper => paper.id === selectedId));
  const activeTrackId = selectedLane?.track.id;
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(savedView?.zoom ?? 1);
  const [tagDragging, setTagDragging] = useState(false);
  const [panning, setPanning] = useState(false);
  const pan = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const [tagMenu, setTagMenu] = useState<{ id: string; trackId: string; tagId?: string; x: number; y: number } | null>(null);
  const [tagEdit, setTagEdit] = useState<{ id: string; trackId: string; tagId?: string } | null>(null);
  const [deletingTag, setDeletingTag] = useState(false);
  const [tagError, setTagError] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const trackKey = tracks.map(track => track.id).join('|');
  const previousTrackKey = useRef(trackKey);
  const contentKey = JSON.stringify([showBriefNotes, layout.lanes.map(lane => [lane.track.id, [...lane.layout.nodes, ...lane.layout.undated].map(n => [n.paper.id, n.date, n.paper.title, showBriefNotes ? n.paper.briefNote : null, n.paper.tags?.map(tag => [tag.id, tag.text])])])]);
  // Leave a viewport of scroll space around the board so its world origin can
  // stay fixed while a lane expands, shrinks, or moves past the current bounds.
  const offsetX = Math.max(256, size.width);
  const offsetY = Math.max(256, size.height);
  const stageWidth = layout.width * zoom + offsetX * 2;
  const stageHeight = layout.height * zoom + offsetY * 2;
  const worldOrigin = { x: offsetX - layout.left * zoom, y: offsetY - layout.top * zoom };
  const previousOrigin = useRef(worldOrigin);
  const viewGeometry = useRef({ zoom, origin: worldOrigin });
  const minZoom = Math.max(0.01, Math.min(0.2, (size.width - 48) / layout.width, (size.height - 48) / layout.height));

  function captureView(element = viewport.current) {
    if (!element || !viewInitialized.current || pendingScroll.current || !element.clientWidth || !element.clientHeight) return;
    const { zoom: scale, origin } = viewGeometry.current;
    // World coordinates survive changed canvas bounds and window/detail widths.
    latestView.current = { zoom: scale,
      centerX: (element.scrollLeft + element.clientWidth / 2 - origin.x) / scale,
      centerY: (element.scrollTop + element.clientHeight / 2 - origin.y) / scale };
  }
  function flushView() {
    if (saveTimer.current !== null) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (latestView.current) saveTimelineView(viewKey, latestView.current);
  }
  function rememberView() {
    captureView();
    if (latestView.current && saveTimer.current === null) saveTimer.current = setTimeout(flushView, 150);
  }
  useLayoutEffect(() => {
    const element = viewport.current;
    const flush = () => { captureView(element); flushView(); };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      // Capture before React detaches the viewport, including a final scroll
      // whose browser scroll event or debounced save has not run yet.
      flush();
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, [viewKey]);

  function focusPaper(id: string, trackId: string) {
    const card = viewport.current?.querySelector<HTMLElement>(`[data-timeline-id="${CSS.escape(trackId)}"] [data-paper-id="${CSS.escape(id)}"]`);
    (card ?? viewport.current)?.focus({ preventScroll: true });
  }
  function openTagMenu(event: MouseEvent, trackId: string, id: string, tagId?: string) {
    event.preventDefault(); event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setTagError('');
    setTagMenu({ id, trackId, tagId, x: event.clientX || rect.left + rect.width / 2, y: event.clientY || rect.bottom });
  }
  useLayoutEffect(() => {
    if (!tagMenu || !menuRef.current) return;
    const element = menuRef.current;
    element.style.left = `${Math.max(8, Math.min(tagMenu.x, window.innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(tagMenu.y, window.innerHeight - element.offsetHeight - 8))}px`;
    element.querySelector<HTMLButtonElement>('button')?.focus();
  }, [tagMenu]);
  useEffect(() => {
    if (!tagMenu || deletingTag) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setTagMenu(null); };
    const dismiss = () => setTagMenu(null);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', dismiss);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', dismiss); };
  }, [tagMenu, deletingTag]);

  useLayoutEffect(() => {
    const element = viewport.current!;
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Measure natural, unscaled card boxes so fonts and wrapping drive the layout.
  // Reading offset sizes keeps zoom changes from feeding back into card dimensions.
  useLayoutEffect(() => {
    const cards = [...viewport.current!.querySelectorAll<HTMLElement>('.timeline-paper')];
    const filterButtons = [...viewport.current!.querySelectorAll<HTMLButtonElement>('.timeline-tag-filter-trigger')];
    const measure = () => {
      const sizes = new Map(cards.map(card => {
        const frame = card.querySelector<HTMLElement>('.timeline-paper-body')!;
        return [card.dataset.paperId!, { width: card.offsetWidth, height: card.offsetHeight, frame: { x: frame.offsetLeft, y: frame.offsetTop, width: frame.offsetWidth, height: frame.offsetHeight } }];
      }));
      const filters = new Map(filterButtons.map(button => [button.closest<HTMLElement>('.timeline-lane')!.dataset.timelineId!, { width: button.offsetWidth, height: button.offsetHeight }]));
      setMeasurements(previous => previous.key === contentKey && previous.sizes.size === sizes.size && previous.filters.size === filters.size
        && [...sizes].every(([id, box]) => JSON.stringify(previous.sizes.get(id)) === JSON.stringify(box))
        && [...filters].every(([id, box]) => JSON.stringify(previous.filters.get(id)) === JSON.stringify(box))
        ? previous : { key: contentKey, sizes, filters });
    };
    measure();
    const observer = new ResizeObserver(measure);
    const mutations = new MutationObserver(measure);
    cards.forEach(card => { observer.observe(card); mutations.observe(card, { attributes: true, attributeFilter: ['style'], subtree: true, childList: true }); });
    filterButtons.forEach(button => observer.observe(button));
    return () => { observer.disconnect(); mutations.disconnect(); };
  }, [papers, contentKey]);

  function fit() {
    if (tagDragging || laneDragging) return;
    const element = viewport.current;
    if (!element) return;
    const next = Math.max(0.01, Math.min(1, (element.clientWidth - 48) / layout.width, (element.clientHeight - 48) / layout.height));
    pendingScroll.current = { left: offsetX + (layout.width * next - element.clientWidth) / 2, top: offsetY + (layout.height * next - element.clientHeight) / 2 };
    setZoom(next);
    element.scrollTo(pendingScroll.current.left, pendingScroll.current.top);
    if (next === zoom) pendingScroll.current = null;
  }

  // Keep the existing add/remove behavior so a newly created lane is visible.
  // Merely mounting this component must not trigger another fit.
  useEffect(() => {
    if (viewInitialized.current && measurements.key === contentKey && previousTrackKey.current !== trackKey && !laneDragging) {
      previousTrackKey.current = trackKey; fit();
    }
  }, [contentKey, trackKey, measurements, laneDragging]);

  function zoomAt(value: number, point?: { x: number; y: number }) {
    const element = viewport.current;
    if (!element || tagDragging || laneDragging) return;
    const next = Math.max(minZoom, Math.min(MAX_ZOOM, value));
    if (next === zoom) return;
    const x = point?.x ?? size.width / 2, y = point?.y ?? size.height / 2;
    const worldX = (element.scrollLeft + x - worldOrigin.x) / zoom;
    const worldY = (element.scrollTop + y - worldOrigin.y) / zoom;
    const nextOffsetX = offsetX - layout.left * next;
    const nextOffsetY = offsetY - layout.top * next;
    pendingScroll.current = { left: worldX * next + nextOffsetX - x, top: worldY * next + nextOffsetY - y };
    setZoom(next);
  }

  useLayoutEffect(() => {
    const element = viewport.current;
    viewGeometry.current = { zoom, origin: worldOrigin };
    if (element) {
      if (!viewInitialized.current) {
        previousOrigin.current = worldOrigin;
        // Wait for real viewport/card sizes before restoring. Initial layout
        // estimates must never overwrite a saved view or clamp it prematurely.
        if (!size.width || !size.height || measurements.key !== contentKey) return;
        viewInitialized.current = true;
        if (savedView) element.scrollTo(worldOrigin.x + savedView.centerX * zoom - element.clientWidth / 2,
          worldOrigin.y + savedView.centerY * zoom - element.clientHeight / 2);
        else fit();
      }
      else if (pendingScroll.current) { element.scrollTo(pendingScroll.current.left, pendingScroll.current.top); pendingScroll.current = null; }
      else element.scrollBy(worldOrigin.x - previousOrigin.current.x, worldOrigin.y - previousOrigin.current.y);
    }
    previousOrigin.current = worldOrigin;
    rememberView();
  }, [zoom, size, stageWidth, stageHeight, worldOrigin.x, worldOrigin.y, measurements.key, contentKey]);

  useEffect(() => {
    const element = viewport.current!;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoomAt(zoom * Math.exp(-event.deltaY * 0.002), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [zoom, size, worldOrigin.x, worldOrigin.y, layout.width, layout.height, tagDragging, laneDragging]);

  // Keep the active paper reachable when the detail panel reduces the canvas width.
  useEffect(() => {
    if (!revealSelected) return;
    const card = viewport.current?.querySelector<HTMLElement>('.timeline-paper.selected');
    if (!card || !viewport.current) return;
    const rect = card.getBoundingClientRect(), view = viewport.current.getBoundingClientRect();
    if (rect.left < view.left || rect.right > view.right || rect.top < view.top || rect.bottom > view.bottom) {
      viewport.current.scrollBy({ left: rect.left - view.left - (view.width - rect.width) / 2, top: rect.top - view.top - (view.height - rect.height) / 2 });
    }
  }, [size.width, size.height, selectedId, activeTrackId, revealSelected]);

  function finishPan() {
    const current = pan.current;
    pan.current = null;
    if (current && viewport.current?.hasPointerCapture(current.id)) viewport.current.releasePointerCapture(current.id);
    setPanning(false);
  }
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && pan.current) { event.preventDefault(); event.stopPropagation(); finishPan(); }
    };
    window.addEventListener('blur', finishPan);
    window.addEventListener('keydown', cancel, true);
    return () => {
      window.removeEventListener('blur', finishPan);
      window.removeEventListener('keydown', cancel, true);
    };
  }, []);
  async function addTimeline() {
    if (creating) return;
    setCreating(true); setTagError('');
    try { await onCreateTimeline({ x: 32, y: tracks.length ? Math.min(100000, layout.bottom + 330) : 275 }); }
    catch (error) { setTagError(String(error)); }
    finally { setCreating(false); }
  }
  function previewPosition(id: string, position: TimelinePosition | null) {
    setDraftPositions(previous => {
      const next = { ...previous };
      if (position) next[id] = position; else delete next[id];
      return next;
    });
  }

  return <div className="timeline-canvas">
    <div className={`map-viewport ${panning ? 'panning' : ''}`} ref={viewport} tabIndex={0} aria-label="论文时间线画布"
      aria-describedby="map-help"
      onScroll={rememberView}
      onPointerDownCapture={event => {
        if (event.button !== 1) return;
        // Capture before card, tag and filter handlers so the same gesture pans
        // everywhere, without selecting a paper, moving a tag or opening a file.
        event.preventDefault(); event.stopPropagation();
        if (tagDragging || laneDragging || pan.current) return;
        const element = event.currentTarget;
        pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
        element.setPointerCapture(event.pointerId); setPanning(true); element.focus({ preventScroll: true });
      }}
      onMouseDownCapture={event => { if (event.button === 1) { event.preventDefault(); event.stopPropagation(); } }}
      onAuxClickCapture={event => { if (event.button === 1) { event.preventDefault(); event.stopPropagation(); } }}
      onPointerMoveCapture={event => {
        if (!pan.current || event.pointerId !== pan.current.id) return;
        event.preventDefault(); event.stopPropagation();
        if (!(event.buttons & 4)) { finishPan(); return; }
        event.currentTarget.scrollTo(pan.current.left - (event.clientX - pan.current.x), pan.current.top - (event.clientY - pan.current.y));
      }}
      onPointerUpCapture={event => {
        if (pan.current?.id !== event.pointerId) return;
        event.preventDefault(); event.stopPropagation(); finishPan();
      }}
      onPointerCancelCapture={event => { if (pan.current?.id === event.pointerId) finishPan(); }}
      onLostPointerCapture={event => { if (pan.current?.id === event.pointerId) finishPan(); }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomAt(zoom + 0.1); }
        if (event.key === '-') { event.preventDefault(); zoomAt(zoom - 0.1); }
        if (event.key === '0') { event.preventDefault(); fit(); }
      }}>
      <div className="map-stage" style={{ width: stageWidth, height: stageHeight }}>
        <div className="map-scene" style={{ width: layout.width, height: layout.height, left: offsetX, top: offsetY, transform: `scale(${zoom})` }}>
          {layout.lanes.map((lane, index) => <TimelineLane key={lane.track.id} lane={lane} index={index}
            left={lane.x - layout.left} top={lane.y - layout.top} zoom={zoom} selectedId={lane.track.id === activeTrackId ? selectedId : null}
            showBriefNotes={showBriefNotes}
            tagOptions={tagOptions} total={papers.length} onSelect={id => { onSelectTrack(lane.track.id); onSelect(id); }} renderStatus={renderStatus}
            onMenu={(event, id, tagId) => openTagMenu(event, lane.track.id, id, tagId)} onMoveTag={onMoveTag} onMoveFileTag={onMoveFileTag} onOpenFile={onOpenFile} onTagDragging={setTagDragging} onError={setTagError}
            onChange={onUpdateTimeline} onDelete={onDeleteTimeline} onPreview={previewPosition} onDragging={setLaneDragging}
            emptyTitle={emptyTitle} emptyDescription={emptyDescription} />)}
          {!tracks.length && <div className="map-empty-state" role="status"><Tag size={26} strokeWidth={1.4} />
            <h2>还没有时间线</h2><p>点击「新增时间线」，再选择要展示的标签。</p>
          </div>}
        </div>
      </div>
    </div>
    <footer className="map-controls"><div className="map-track-actions"><button className="secondary-button" disabled={creating || tracks.length >= 100} onClick={() => void addTimeline()}><Plus size={15} />{creating ? '正在新增…' : '新增时间线'}</button>
      <button className="secondary-button" aria-pressed={showBriefNotes} disabled={tagDragging || laneDragging} onClick={() => { const next = !showBriefNotes; setShowBriefNotes(next); try { localStorage.setItem(noteKey, String(next)); } catch {} }}><StickyNote size={15} />{showBriefNotes ? '关闭精简笔记' : '打开精简笔记'}</button>
      <p id="map-help" title="按住鼠标中键（滚轮键）可从画布任意位置平移；左键拖动左侧方框移动单条时间线">中键拖动画布 <span>·</span> Ctrl + 滚轮缩放</p></div>
      <div className="map-zoom" role="group" aria-label="画布缩放">
        <button className="icon-button" aria-label="缩小" title="缩小" disabled={zoom <= minZoom} onClick={() => zoomAt(zoom - 0.1)}><Minus size={16} /></button>
        <button className="zoom-value" aria-label="恢复百分之百" title="恢复 100%" onClick={() => zoomAt(1)}>{Math.round(zoom * 100)}%</button>
        <button className="icon-button" aria-label="放大" title="放大" disabled={zoom >= MAX_ZOOM} onClick={() => zoomAt(zoom + 0.1)}><Plus size={16} /></button>
        <span className="control-divider" /><button className="icon-button" aria-label="适应画布" title="适应画布" onClick={fit}><Maximize size={16} /></button>
      </div>
    </footer>
    {tagError && !tagMenu && <div className="tag-move-error" role="alert">{tagError}<button onClick={() => setTagError('')}>关闭</button></div>}
    {tagMenu && <div ref={menuRef} className="menu-items tag-context-menu" role="menu" aria-label="论文标签操作" style={{ left: tagMenu.x, top: tagMenu.y }}
      onKeyDown={event => {
        if (event.key === 'Escape' && !deletingTag) { event.preventDefault(); event.stopPropagation(); focusPaper(tagMenu.id, tagMenu.trackId); setTagMenu(null); }
        if (event.key === 'Tab' && !deletingTag) { setTagMenu(null); focusPaper(tagMenu.id, tagMenu.trackId); }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...menuRef.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        if (!buttons.length) return;
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus();
      }}>
      <button role="menuitem" disabled={deletingTag} onClick={() => { setTagEdit({ id: tagMenu.id, trackId: tagMenu.trackId }); setTagMenu(null); }}><Tag size={14} />添加标签</button>
      {tagMenu.tagId && <>
        <button role="menuitem" disabled={deletingTag} onClick={() => { setTagEdit({ id: tagMenu.id, trackId: tagMenu.trackId, tagId: tagMenu.tagId }); setTagMenu(null); }}><PencilLine size={14} />编辑标签</button>
        <button role="menuitem" disabled={deletingTag} onClick={async () => {
          setDeletingTag(true); setTagError('');
          try { await onDeleteTag(tagMenu.id, tagMenu.tagId!); focusPaper(tagMenu.id, tagMenu.trackId); setTagMenu(null); }
          catch (error) { setTagError(error instanceof Error ? error.message : String(error)); }
          finally { setDeletingTag(false); }
        }}><Trash2 size={14} />{deletingTag ? '删除中…' : '删除标签'}</button>
      </>}
      {tagError && <p className="form-error" role="alert">{tagError}</p>}
    </div>}
    {tagEdit && <TagDialog tag={papers.find(paper => paper.id === tagEdit.id)?.tags?.find(tag => tag.id === tagEdit.tagId)}
      tagOptions={tagOptions}
      onClose={() => { focusPaper(tagEdit.id, tagEdit.trackId); setTagEdit(null); }}
      onSave={(text, color) => tagEdit.tagId ? onUpdateTag(tagEdit.id, tagEdit.tagId, text, color) : onAddTag(tagEdit.id, text, color)} />}
  </div>;
}
