import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { FileText, StickyNote } from 'lucide-react';
import type { Paper, PaperFileKind, PaperTagPosition } from '../shared/types';
import { paperFrameTags } from '../shared/paper-files';
import type { TimelineNode } from './timeline-layout';
import { closestTagPosition, defaultTagPositions, tagEnvelope, tagBox, type TagSize } from './tag-layout';
import { tagTextColor } from './TagDialog';
import { RatingStars } from './PaperRating';

interface Props {
  node: TimelineNode;
  showBriefNotes: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  renderStatus: (paper: Paper) => ReactNode;
  onMenu: (event: MouseEvent, id: string, tagId?: string) => void;
  onMoveTag: (id: string, tagId: string, position: PaperTagPosition) => Promise<unknown>;
  onMoveFileTag: (id: string, kind: PaperFileKind, position: PaperTagPosition) => Promise<unknown>;
  onOpenFile: (id: string, kind: PaperFileKind) => Promise<unknown>;
  onDraggingChange: (dragging: boolean) => void;
  onError: (message: string) => void;
}
interface Drag {
  id: string; pointerId: number; target: HTMLSpanElement; startX: number; startY: number;
  grabX: number; grabY: number; size: TagSize; position: PaperTagPosition; moved: boolean;
}

export default function TimelinePaper({ node, showBriefNotes, selected, onSelect, renderStatus, onMenu, onMoveTag, onMoveFileTag, onOpenFile, onDraggingChange, onError }: Props) {
  const { paper } = node;
  const card = useRef<HTMLDivElement>(null), body = useRef<HTMLButtonElement>(null);
  const note = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<{ body: TagSize; tags: Map<string, TagSize>; noteHeight: number }>({ body: { width: 220, height: 100 }, tags: new Map(), noteHeight: 0 });
  const [preview, setPreview] = useState<{ id: string; position: PaperTagPosition } | null>(null);
  const [saving, setSaving] = useState(false);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const mounted = useRef(true);
  const tags = paperFrameTags(paper);
  const tagSizes = tags.map(tag => ({ id: tag.id, ...(sizes.tags.get(tag.id) ?? { width: 60, height: 26 }) }));
  const defaults = defaultTagPositions(sizes.body, tagSizes);
  const positions = new Map(tags.map(tag => [tag.id, preview?.id === tag.id ? preview.position : tag.position ?? defaults.get(tag.id)!]));
  const boxes = tagSizes.map(tag => ({ id: tag.id, ...tagBox(sizes.body, tag, positions.get(tag.id)!) }));
  // The frame's origin and layout footprint must not depend on the active edge,
  // including after the position is saved or restored on startup.
  const bounds = tagEnvelope(sizes.body, tagSizes);
  const showNote = showBriefNotes && !!paper.briefNote;
  const noteSpace = showNote ? sizes.noteHeight + 10 : 0;
  // Put the note on the side away from the axis so the connecting line cannot cross its text.
  const frameOffsetY = bounds.y + (node.above ? noteSpace : 0);

  useLayoutEffect(() => {
    const measure = () => {
      const next = { body: { width: body.current!.offsetWidth, height: body.current!.offsetHeight },
        tags: new Map([...card.current!.querySelectorAll<HTMLElement>('[data-tag-id]')].map(element => [element.dataset.tagId!, { width: element.offsetWidth, height: element.offsetHeight }])), noteHeight: note.current?.offsetHeight ?? 0 };
      setSizes(previous => JSON.stringify([previous.body, [...previous.tags], previous.noteHeight]) === JSON.stringify([next.body, [...next.tags], next.noteHeight]) ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body.current!);
    card.current!.querySelectorAll('[data-tag-id]').forEach(element => observer.observe(element));
    if (note.current) observer.observe(note.current);
    return () => observer.disconnect();
  }, [paper.title, paper.authors, paper.tags, paper.status, paper.markdownNote, paper.availableFiles?.pdf, paper.availableFiles?.md, showNote, paper.briefNote]);

  function clearDrag() {
    const current = drag.current;
    drag.current = null;
    if (current?.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
    setPreview(null); onDraggingChange(false);
  }
  useEffect(() => {
    mounted.current = true;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); clearDrag(); }
    };
    const blur = () => { if (drag.current) clearDrag(); };
    window.addEventListener('keydown', cancel, true); window.addEventListener('blur', blur);
    return () => {
      mounted.current = false;
      window.removeEventListener('keydown', cancel, true); window.removeEventListener('blur', blur);
      if (drag.current) onDraggingChange(false);
    };
  }, []);

  function startDrag(event: PointerEvent<HTMLSpanElement>, tagId: string) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    if (saving || drag.current) return;
    onError('');
    const frameRect = body.current!.getBoundingClientRect(), rect = event.currentTarget.getBoundingClientRect();
    const scale = frameRect.width / sizes.body.width;
    suppressClick.current = true;
    drag.current = { id: tagId, pointerId: event.pointerId, target: event.currentTarget, startX: event.clientX, startY: event.clientY,
      grabX: (event.clientX - rect.left) / scale, grabY: (event.clientY - rect.top) / scale,
      size: sizes.tags.get(tagId)!, position: positions.get(tagId)!, moved: false };
    onDraggingChange(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDrag(event: PointerEvent<HTMLSpanElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 3) return;
    current.moved = true;
    const rect = body.current!.getBoundingClientRect(), scale = rect.width / sizes.body.width;
    current.position = closestTagPosition(sizes.body, current.size, {
      x: (event.clientX - rect.left) / scale - current.grabX + current.size.width / 2,
      y: (event.clientY - rect.top) / scale - current.grabY + current.size.height / 2,
    }, current.position.side);
    setPreview({ id: current.id, position: current.position });
  }
  async function finishDrag(event: PointerEvent<HTMLSpanElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    if (!current.moved) {
      const kind = tags.find(tag => tag.id === current.id)?.fileKind;
      clearDrag();
      if (kind) openFile(kind);
      return;
    }
    drag.current = null;
    if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
    setSaving(true);
    try {
      const kind = tags.find(tag => tag.id === current.id)?.fileKind;
      if (kind) await onMoveFileTag(paper.id, kind, current.position);
      else await onMoveTag(paper.id, current.id, current.position);
    }
    catch (error) { if (mounted.current) onError(`标签位置保存失败：${error instanceof Error ? error.message : String(error)}`); }
    finally {
      if (mounted.current) { setSaving(false); setPreview(null); }
      onDraggingChange(false);
    }
  }
  function openFile(kind: PaperFileKind) {
    void onOpenFile(paper.id, kind).catch(error => onError(`无法打开文件：${error instanceof Error ? error.message : String(error)}`));
  }

  return <div ref={card} role="group" tabIndex={-1} aria-label={paper.title} className={`timeline-paper ${selected ? 'selected' : ''} ${preview ? 'tag-dragging' : ''}`}
    style={{ left: node.x, top: node.y, width: bounds.width, height: bounds.height + noteSpace }}
    data-paper-id={paper.id} data-publication-date={node.date}
    title={`${paper.title}\n右键添加标签`}
    onPointerDown={event => { if (!(event.target as HTMLElement).closest('[data-tag-id]')) suppressClick.current = false; }}
    onContextMenu={event => onMenu(event, paper.id)}
    onClick={event => { if (suppressClick.current || (event.target as HTMLElement).closest('[data-tag-id]')) { suppressClick.current = false; return; } onSelect(paper.id); }}
    onKeyDown={event => { if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); onSelect(paper.id); } }}
    onFocus={event => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })}>
    <button ref={body} type="button" aria-pressed={selected} className="timeline-paper-body" style={{ left: bounds.x, top: frameOffsetY }}>
      <div className="map-card-heading"><h3>{paper.title}</h3>{renderStatus(paper)}</div>
      <div className="map-card-footer">
        <p className="map-card-authors" title={paper.authors.join(', ')}>{paper.authors.length ? `${paper.authors.slice(0, 2).join(', ')}${paper.authors.length > 2 ? ' 等' : ''}` : '作者待补充'}</p>
        {paper.rating && <RatingStars rating={paper.rating} />}
      </div>
    </button>
    {tags.map((tag, index) => <span key={tag.id} className={`${tag.fileKind ? `paper-file-tag file-tag-${tag.fileKind}` : 'paper-tag'} draggable-tag ${preview?.id === tag.id ? 'dragging' : ''}`}
      data-tag-id={tag.id} data-tag-side={positions.get(tag.id)!.side}
      data-file-kind={tag.fileKind} role={tag.fileKind ? 'button' : undefined} tabIndex={tag.fileKind ? 0 : undefined}
      aria-label={tag.fileKind ? `打开 ${tag.text}：${tag.fileKind === 'md' ? paper.markdownNote?.fileName : paper.fileName}` : undefined}
      style={{ left: bounds.x + boxes[index].x, top: frameOffsetY + boxes[index].y, maxWidth: sizes.body.width,
        backgroundColor: tag.color, color: tag.fileKind ? tag.fileKind === 'pdf' ? '#B23C3C' : '#786094' : tagTextColor(tag.color) }}
      title={tag.fileKind ? `${tag.text} · 点击打开 · 拖动调整位置 · 文件标签不能删除` : `${tag.text} · 拖动调整位置 · 右键编辑标签`}
      onPointerDown={event => startDrag(event, tag.id)} onPointerMove={moveDrag} onPointerUp={finishDrag}
      onPointerCancel={() => { if (drag.current) clearDrag(); }} onLostPointerCapture={() => { if (drag.current) clearDrag(); }}
      onClick={event => {
        event.stopPropagation();
        // Pointer activation happens on release; dragging must never open a file.
        if (tag.fileKind && event.detail === 0 && !suppressClick.current) openFile(tag.fileKind);
        suppressClick.current = false;
      }}
      onKeyDown={event => {
        if (!tag.fileKind) return;
        event.stopPropagation();
        if (['Enter', ' '].includes(event.key)) { event.preventDefault(); if (!event.repeat && !saving && !drag.current) openFile(tag.fileKind); }
      }}
      onContextMenu={event => {
        if (tag.fileKind) { event.preventDefault(); event.stopPropagation(); }
        else onMenu(event, paper.id, tag.id);
      }}>{tag.fileKind && <FileText size={13} strokeWidth={1.7} />}{tag.text}</span>)}
    {showNote && <div ref={note} className="timeline-brief-note" aria-label="精简笔记" style={{ left: bounds.x, top: node.above ? 0 : bounds.height + 10, width: sizes.body.width }}>
      <span><StickyNote size={12} />精简笔记</span><p>{paper.briefNote}</p>
    </div>}
  </div>;
}
