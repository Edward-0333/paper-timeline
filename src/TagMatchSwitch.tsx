import { useRef, useState } from 'react';
import type { TagMatchMode } from '../shared/paper-tags';

export default function TagMatchSwitch({ mode, onChange, describedBy }: {
  mode: TagMatchMode; onChange: (mode: TagMatchMode) => void; describedBy: string;
}) {
  const drag = useRef<{ id: number; startX: number; start: number; moved: boolean } | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const suppressClick = useRef(false);
  const value = preview ?? (mode === 'any' ? 1 : 0);
  return <button type="button" className="tag-match-switch" role="switch"
    aria-label="交集与并集" aria-checked={mode === 'any'} aria-describedby={describedBy}
    data-mode={mode} title="向左滑动选交集，向右滑动选并集；也可以点击切换"
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.stopPropagation();
      suppressClick.current = false;
      drag.current = { id: event.pointerId, startX: event.clientX, start: mode === 'any' ? 1 : 0, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const current = drag.current;
      if (!current || current.id !== event.pointerId) return;
      const delta = event.clientX - current.startX;
      if (!current.moved && Math.abs(delta) < 3) return;
      current.moved = true;
      const travel = event.currentTarget.getBoundingClientRect().width / 2 - 3;
      setPreview(Math.max(0, Math.min(1, current.start + delta / travel)));
    }}
    onPointerUp={event => {
      const current = drag.current;
      if (!current || current.id !== event.pointerId) return;
      drag.current = null;
      if (current.moved) {
        const travel = event.currentTarget.getBoundingClientRect().width / 2 - 3;
        onChange(current.start + (event.clientX - current.startX) / travel >= 0.5 ? 'any' : 'all');
        suppressClick.current = true;
      }
      setPreview(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => { drag.current = null; setPreview(null); }}
    onLostPointerCapture={() => { drag.current = null; setPreview(null); }}
    onClick={event => {
      if (suppressClick.current) { suppressClick.current = false; return; }
      if (!event.detail) onChange(mode === 'all' ? 'any' : 'all');
      else {
        const rect = event.currentTarget.getBoundingClientRect();
        onChange(event.clientX < rect.left + rect.width / 2 ? 'all' : 'any');
      }
    }}
    onKeyDown={event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); event.stopPropagation();
        onChange(event.key === 'ArrowLeft' || event.key === 'Home' ? 'all' : 'any');
      }
    }}>
    <span className={`tag-match-thumb ${preview !== null ? 'dragging' : ''}`} style={{ transform: `translateX(${value * 100}%)` }} aria-hidden="true" />
    <span className={value < 0.5 ? 'active' : ''}>交集</span><span className={value >= 0.5 ? 'active' : ''}>并集</span>
  </button>;
}
