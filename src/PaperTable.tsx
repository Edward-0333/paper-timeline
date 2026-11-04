import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, FileText } from 'lucide-react';
import type { Paper } from '../shared/types';
import { hasPaperFile } from '../shared/paper-files';
import { formatPublicationDate, publicationDateOf } from '../shared/publication-date';
import { tagTextColor } from './TagDialog';
import { RatingStars } from './PaperRating';
import { citationCountOf } from '../shared/citation-count';

type SortKey = 'title' | 'authors' | 'date' | 'venue' | 'citations';
type ColumnKey = SortKey | 'tags' | 'rating' | 'pdf' | 'note' | 'status';
type ColumnWidths = Record<ColumnKey, number>;
interface Column { key: ColumnKey; label: string; width: number; min: number; sortKey?: SortKey }
interface Props { papers: Paper[]; selectedId: string | null; onSelect: (id: string) => void; onOpen: (id: string) => void; onOpenNote: (id: string) => void; onOpenCitations: (id: string) => void; renderStatus: (paper: Paper) => ReactNode }
const columns: Column[] = [
  { key: 'title', label: '标题', width: 205, min: 100, sortKey: 'title' },
  { key: 'tags', label: '标签', width: 200, min: 80 },
  { key: 'rating', label: '评分', width: 108, min: 100 },
  { key: 'citations', label: '被引数', width: 96, min: 80, sortKey: 'citations' },
  { key: 'authors', label: '作者', width: 118, min: 70, sortKey: 'authors' },
  { key: 'date', label: '发表日期', width: 103, min: 90, sortKey: 'date' },
  { key: 'venue', label: '期刊 / 会议', width: 126, min: 105, sortKey: 'venue' },
  { key: 'pdf', label: 'PDF', width: 48, min: 44 },
  { key: 'note', label: 'MD 笔记', width: 66, min: 64 },
  { key: 'status', label: '核对状态', width: 34, min: 34 },
];
const widthsKey = 'paper-timeline-column-widths-v1';
const maxWidth = 2000;
const clampWidth = (column: Column, width: number) => Math.round(Math.max(column.min, Math.min(maxWidth, width)));
function savedWidths(): ColumnWidths | null {
  try {
    const saved = JSON.parse(localStorage.getItem(widthsKey) || 'null');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
    // New columns receive defaults without discarding existing width preferences.
    return Object.fromEntries(columns.map(column => [column.key, clampWidth(column,
      typeof saved[column.key] === 'number' && Number.isFinite(saved[column.key]) ? saved[column.key] : column.width)])) as ColumnWidths;
  } catch { return null; }
}
function saveWidths(widths: ColumnWidths) {
  try { localStorage.setItem(widthsKey, JSON.stringify(widths)); } catch { /* Resizing still works when preferences cannot be saved. */ }
}

export default function PaperTable({ papers, selectedId, onSelect, onOpen, onOpenNote, onOpenCitations, renderStatus }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean } | null>(null);
  const table = useRef<HTMLTableElement>(null);
  const [widths, setWidths] = useState<ColumnWidths | null>(savedWidths);
  const currentWidths = useRef(widths);
  const [resizing, setResizing] = useState<ColumnKey | null>(null);
  const drag = useRef<{ column: Column; pointerId: number; startX: number; initial: ColumnWidths; handle: HTMLElement } | null>(null);

  function measuredWidths(): ColumnWidths {
    return Object.fromEntries(columns.map((column, index) => [column.key,
      Math.round(table.current?.tHead?.rows[0].cells[index].getBoundingClientRect().width || column.width),
    ])) as ColumnWidths;
  }
  function applyWidths(next: ColumnWidths) { currentWidths.current = next; setWidths(next); }
  useLayoutEffect(() => { if (!currentWidths.current) applyWidths(measuredWidths()); }, []);

  function finishResize(commit: boolean) {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (commit && currentWidths.current) saveWidths(currentWidths.current);
    else applyWidths(active.initial);
    setResizing(null);
    if (active.handle.hasPointerCapture(active.pointerId)) active.handle.releasePointerCapture(active.pointerId);
    if (document.activeElement === active.handle) active.handle.blur();
  }
  useEffect(() => {
    if (!resizing) return;
    document.body.classList.add('resizing-paper-column');
    const cancel = () => finishResize(false);
    window.addEventListener('blur', cancel);
    return () => { document.body.classList.remove('resizing-paper-column'); window.removeEventListener('blur', cancel); };
  }, [resizing]);

  function startResize(event: PointerEvent<HTMLSpanElement>, column: Column) {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    const initial = currentWidths.current || measuredWidths();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { column, pointerId: event.pointerId, startX: event.clientX, initial, handle: event.currentTarget };
    setResizing(column.key);
  }
  function moveResize(event: PointerEvent<HTMLSpanElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    applyWidths({ ...active.initial, [active.column.key]: clampWidth(active.column, active.initial[active.column.key] + event.clientX - active.startX) });
  }
  function setColumnWidth(column: Column, value: number) {
    if (drag.current) return;
    const next = { ...(currentWidths.current || measuredWidths()), [column.key]: clampWidth(column, value) };
    applyWidths(next); saveWidths(next);
  }
  const sorted = useMemo(() => {
    if (!sort) return papers;
    const { key, ascending } = sort;
    if (key === 'citations') return [...papers].sort((a, b) => {
      const left = citationCountOf(a), right = citationCountOf(b);
      if (left === null || right === null) return left === null ? right === null ? a.id.localeCompare(b.id) : 1 : -1;
      return (left - right) * (ascending ? 1 : -1) || a.id.localeCompare(b.id);
    });
    const value = (paper: Paper) => key === 'date' ? publicationDateOf(paper) : key === 'authors' ? paper.authors.join(', ') : paper[key];
    return [...papers].sort((a, b) => {
      const left = value(a), right = value(b);
      if (!left || !right) return left ? -1 : right ? 1 : a.id.localeCompare(b.id);
      return left.localeCompare(right, 'zh-CN', { numeric: true }) * (sort.ascending ? 1 : -1) || a.id.localeCompare(b.id);
    });
  }, [papers, sort]);
  return <table ref={table} className="paper-table" aria-label="文献条目" style={widths ? { width: Object.values(widths).reduce((sum, width) => sum + width, 0), minWidth: 0 } : undefined}>
    <colgroup>{columns.map(column => <col key={column.key} style={{ width: widths?.[column.key] ?? column.width }} />)}</colgroup>
    <thead><tr>{columns.map(column => {
      const { key, label, sortKey } = column;
      return <th key={key} scope="col" data-column={key} className={key === 'pdf' || key === 'note' ? 'table-note-heading' : undefined}
        aria-sort={sortKey ? sort?.key === sortKey ? sort.ascending ? 'ascending' : 'descending' : 'none' : undefined}>
        {sortKey ? <button onClick={() => setSort({ key: sortKey, ascending: sort?.key === sortKey ? !sort.ascending : true })}>{label}{sort?.key === sortKey && (sort.ascending ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}</button>
          : <span className={key === 'status' ? 'visually-hidden' : 'table-heading-label'}>{label}</span>}
        <span className={`column-resize-handle ${resizing === key ? 'active' : ''}`} role="separator" tabIndex={0}
          aria-label={`调整${label}列宽`} aria-orientation="vertical" aria-valuemin={column.min} aria-valuemax={maxWidth} aria-valuenow={widths?.[key] ?? column.width}
          title={`拖动调整${label}列宽，双击恢复默认；方向键微调`}
          onPointerDown={event => startResize(event, column)} onPointerMove={moveResize}
          onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) { moveResize(event); finishResize(true); } }}
          onPointerCancel={() => finishResize(false)} onLostPointerCapture={() => finishResize(false)}
          onClick={event => event.stopPropagation()} onDoubleClick={event => { event.stopPropagation(); setColumnWidth(column, column.width); }}
          onKeyDown={event => {
            if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finishResize(false); }
            if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            setColumnWidth(column, event.key === 'Home' ? column.width : (currentWidths.current?.[key] ?? column.width) + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 50 : 10));
          }} />
      </th>;
    })}</tr></thead>
    <tbody>{sorted.map((paper, index) => {
      const citationCount = citationCountOf(paper);
      return <tr key={paper.id} className={`paper-row ${selectedId === paper.id ? 'selected' : ''}`} aria-selected={selectedId === paper.id}
      tabIndex={selectedId === paper.id || (!selectedId && index === 0) ? 0 : -1} data-paper-id={paper.id}
      onClick={() => onSelect(paper.id)} onDoubleClick={() => hasPaperFile(paper, 'pdf') ? onOpen(paper.id) : onSelect(paper.id)}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter') { event.preventDefault(); hasPaperFile(paper, 'pdf') ? onOpen(paper.id) : onSelect(paper.id); }
        if (event.key === ' ') { event.preventDefault(); onSelect(paper.id); }
        const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? sorted.length - 1 : null;
        if (next === null) return;
        event.preventDefault();
        const item = sorted[Math.max(0, Math.min(sorted.length - 1, next))];
        onSelect(item.id);
        const row = event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-paper-id="${item.id}"]`);
        row?.focus({ preventScroll: true }); row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }}>
      <td title={paper.title}><div className="table-title">{paper.unread === true && <i className="paper-unread-dot" role="img" aria-label="未打开" title="新文献，尚未打开" />}<FileText size={14} /><span>{paper.title}</span></div></td>
      <td className="table-tags" title={paper.tags?.map(tag => tag.text).join('、') || undefined}>{paper.tags?.length ? <ul className="table-tag-list" aria-label="论文标签">{paper.tags.map(tag =>
        <li key={tag.id} style={{ backgroundColor: tag.color, color: tagTextColor(tag.color) }}>{tag.text}</li>
      )}</ul> : <span aria-label="无标签">—</span>}</td>
      <td className="table-rating">{paper.rating ? <RatingStars rating={paper.rating} /> : <span aria-label="未评分">—</span>}</td>
      <td className="table-citations" title={citationCount === null ? '暂无引用数据' : `本地已同步、去重的引用文献数：${citationCount}`}>
        {citationCount === null ? <span aria-label="暂无引用数据">—</span> : <button className="citation-count-button"
          aria-label={`查看《${paper.title}》的 ${citationCount} 条引用`}
          onClick={event => { event.stopPropagation(); onOpenCitations(paper.id); }}
          onDoubleClick={event => event.stopPropagation()}>{citationCount.toLocaleString('zh-CN')}</button>}
      </td>
      <td title={paper.authors.join(', ')}>{paper.authors.length ? `${paper.authors[0]}${paper.authors.length > 1 ? ' 等' : ''}` : '—'}</td>
      <td title={formatPublicationDate(publicationDateOf(paper))}><time dateTime={publicationDateOf(paper) || undefined}>{publicationDateOf(paper) || '—'}</time></td>
      <td title={paper.venue}>{paper.venue || '—'}</td>
      <td className="table-note">{hasPaperFile(paper, 'pdf') ? <button className="note-document-button pdf-document-button" title={`打开 PDF：${paper.fileName}（内置阅读器）`} aria-label={`打开 PDF：${paper.fileName}`}
        onClick={event => { event.stopPropagation(); onOpen(paper.id); }} onDoubleClick={event => event.stopPropagation()}><FileText size={19} strokeWidth={1.5} /></button> : <span className="no-pdf" aria-label="无 PDF 文件">—</span>}</td>
      <td className="table-note">{hasPaperFile(paper, 'md') && paper.markdownNote ? <button className="note-document-button" title={`打开笔记：${paper.markdownNote.fileName}（内置阅读与编辑）`} aria-label={`打开 Markdown 笔记：${paper.markdownNote.fileName}`}
        onClick={event => { event.stopPropagation(); onOpenNote(paper.id); }} onDoubleClick={event => event.stopPropagation()}><FileText size={19} strokeWidth={1.5} /></button> : <span className="no-note" aria-label="无 Markdown 笔记">—</span>}</td>
      <td className="table-status">{renderStatus(paper)}</td>
    </tr>; })}</tbody>
  </table>;
}
