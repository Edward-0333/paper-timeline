import { useEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { GripHorizontal, Trash2 } from 'lucide-react';
import type { Paper, PaperFileKind, PaperTagPosition, TimelinePosition, TimelineChanges } from '../shared/types';
import { POSITION_LIMIT } from '../shared/timelines';
import type { TagFilterOption } from '../shared/paper-tags';
import { formatPublicationDate } from '../shared/publication-date';
import type { TimelineNode } from './timeline-layout';
import type { TimelineLaneLayout } from './timeline-board';
import TimelinePaper from './TimelinePaper';
import TimelineTagFilter from './TimelineTagFilter';

interface Props {
  lane: TimelineLaneLayout; index: number; left: number; top: number; zoom: number;
  selectedId: string | null; tagOptions: TagFilterOption[]; total: number;
  showBriefNotes: boolean;
  onSelect: (id: string) => void; renderStatus: (paper: Paper) => ReactNode;
  onMenu: (event: MouseEvent, id: string, tagId?: string) => void;
  onMoveTag: (id: string, tagId: string, position: PaperTagPosition) => Promise<unknown>;
  onMoveFileTag: (id: string, kind: PaperFileKind, position: PaperTagPosition) => Promise<unknown>;
  onOpenFile: (id: string, kind: PaperFileKind) => Promise<unknown>;
  onTagDragging: (dragging: boolean) => void; onError: (error: string) => void;
  onChange: (id: string, changes: TimelineChanges) => Promise<unknown>; onDelete: (id: string) => Promise<unknown>;
  onPreview: (id: string, position: TimelinePosition | null) => void;
  onDragging: (dragging: boolean) => void;
  emptyTitle: string; emptyDescription: string;
}

export default function TimelineLane({ lane, index, left, top, zoom, selectedId, tagOptions, total, showBriefNotes, onSelect, renderStatus,
  onMenu, onMoveTag, onMoveFileTag, onOpenFile, onTagDragging, onError, onChange, onDelete, onPreview, onDragging, emptyTitle, emptyDescription }: Props) {
  const { track, layout, papers, filterTop, filterWidth, contentOffsetX } = lane;
  const drag = useRef<{ pointerId: number; x: number; y: number; start: TimelinePosition; next: TimelinePosition; moved: boolean; target: HTMLElement } | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => () => { if (drag.current?.moved) onDragging(false); }, [onDragging]);
  const clamp = (value: number) => Math.max(-POSITION_LIMIT, Math.min(POSITION_LIMIT, value));
  const cancelDrag = () => {
    if (!drag.current) return;
    drag.current = null; onPreview(track.id, null); onDragging(false);
  };
  const finishDrag = () => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
    if (!current.moved) return;
    suppressClick.current = true;
    onDragging(false);
    void onChange(track.id, { position: current.next }).catch(error => onError(String(error)))
      .finally(() => onPreview(track.id, null));
  };
  const card = (node: TimelineNode) => <TimelinePaper key={node.paper.id} node={node} selected={selectedId === node.paper.id}
    showBriefNotes={showBriefNotes}
    onSelect={onSelect} renderStatus={renderStatus} onMenu={onMenu} onMoveTag={onMoveTag} onMoveFileTag={onMoveFileTag} onOpenFile={onOpenFile}
    onDraggingChange={onTagDragging} onError={onError} />;

  return <section className="timeline-lane" data-timeline-id={track.id} aria-label={`时间线 ${index + 1}`}
    style={{ left, top, width: layout.width, height: layout.height }}>
    {layout.nodes.length > 0 && <>
      <svg className="map-lines" width={layout.width} height={layout.height} aria-hidden="true">
        <defs><marker id={`time-arrow-${track.id}`} markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="none" stroke="var(--axis)" strokeWidth="1.3" /></marker></defs>
        <line className="map-axis" x1={34 + filterWidth} y1={layout.axisY} x2={layout.axisEnd} y2={layout.axisY} markerEnd={`url(#time-arrow-${track.id})`} />
        {layout.nodes.map(node => <g key={node.paper.id} className={selectedId === node.paper.id ? 'map-branch selected' : 'map-branch'}>
          <line x1={node.anchorX} y1={layout.axisY} x2={node.x + (node.frame?.x ?? 0) + (node.frame?.width ?? node.width) / 2} y2={node.y + (node.frame?.y ?? 0) + (node.above ? node.frame?.height ?? node.height : 0)} />
          <circle cx={node.anchorX} cy={layout.axisY} r="4" />
        </g>)}
      </svg>
      {layout.nodes.map(node => <span key={node.paper.id} className={`map-axis-date ${selectedId === node.paper.id ? 'selected' : ''}`}
        style={{ left: node.anchorX, top: layout.axisY + (node.above ? 15 : -33) }} title={formatPublicationDate(node.date)}>{node.date.replaceAll('-', '.')}</span>)}
      {layout.nodes.map(card)}
    </>}
    <div className="timeline-lane-handle" style={{ top: filterTop }}
      onPointerDownCapture={event => {
        if (event.button !== 0 || !event.isPrimary || drag.current || !(event.target instanceof Element)) return;
        const target = event.target.closest<HTMLElement>('[data-timeline-drag], .timeline-tag-filter-trigger');
        if (!target) return;
        suppressClick.current = false;
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: { ...track.position }, next: { ...track.position }, moved: false, target };
        target.setPointerCapture(event.pointerId);
      }}
      onPointerMoveCapture={event => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const dx = event.clientX - current.x, dy = event.clientY - current.y;
        if (!current.moved && Math.hypot(dx, dy) < 5) return;
        if (!current.moved) { current.moved = true; onDragging(true); }
        event.stopPropagation();
        current.next = { x: clamp(current.start.x + dx / zoom), y: clamp(current.start.y + dy / zoom) };
        onPreview(track.id, current.next);
      }}
      onPointerUpCapture={finishDrag} onPointerCancelCapture={cancelDrag} onLostPointerCapture={cancelDrag}
      onClickCapture={event => { if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); } }}>
      <div className="timeline-lane-toolbar">
        <button className="timeline-lane-grip" data-timeline-drag title="拖动移动时间线，也可使用方向键" aria-label={`移动时间线 ${index + 1}`}
          onPointerDown={event => event.stopPropagation()}
          onKeyDown={event => {
            if (event.key === 'Escape') { cancelDrag(); return; }
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            const step = event.shiftKey ? 50 : 10;
            void onChange(track.id, { position: { x: clamp(track.position.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0)),
              y: clamp(track.position.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0)) } }).catch(error => onError(String(error)));
          }}><GripHorizontal size={13} />时间线 {index + 1}</button>
        <button className="timeline-lane-delete" title="删除此时间线，保留论文" aria-label={`删除时间线 ${index + 1}`}
          onClick={() => { void onDelete(track.id).catch(error => onError(String(error))); }}><Trash2 size={12} /></button>
      </div>
      <TimelineTagFilter options={tagOptions} values={track.tags} mode={track.tagMode} configured={track.configured}
        onChange={tags => { void onChange(track.id, { tags }).catch(error => onError(String(error))); }}
        onModeChange={tagMode => { void onChange(track.id, { tagMode }).catch(error => onError(String(error))); }}
        total={total} matched={papers.length} top={0} />
    </div>
    {layout.undated.length > 0 && <section className="map-undated" aria-label="日期待补充">
      <div className="map-undated-heading" style={{ top: layout.undatedY, left: 70 + contentOffsetX }}><span>日期待补充</span><span>{layout.undated.length} 篇 · 补充日期后进入时间轴</span></div>
      {layout.undated.map(card)}
    </section>}
    {track.configured && !papers.length && <div className="timeline-lane-empty" role="status" style={{ left: Math.max(174, filterWidth + 56) }}>
      <h2>{track.tags.length ? '没有符合所选标签的论文' : emptyTitle}</h2>
      <p>{track.tags.length ? '调整标签或切换交集、并集。' : emptyDescription}</p>
    </div>}
  </section>;
}
