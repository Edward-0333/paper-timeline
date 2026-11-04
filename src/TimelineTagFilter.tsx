import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import type { TagFilterOption, TagMatchMode } from '../shared/paper-tags';
import TagMatchSwitch from './TagMatchSwitch';
import './TimelineTagFilter.css';

export default function TimelineTagFilter({ options, values, mode, configured = true, onChange, onModeChange, total, matched, top }: {
  options: TagFilterOption[];
  values: string[];
  mode: TagMatchMode;
  configured?: boolean;
  onChange: (values: string[]) => void;
  onModeChange: (mode: TagMatchMode) => void;
  total: number;
  matched: number;
  top: number;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [placement, setPlacement] = useState({ left: 8, top: 8, width: 312, maxHeight: 400 });
  const selected = values.map(key => options.find(option => option.key === key) ?? { key, text: key, color: '#94A3B8', count: 0 });
  const modeLabel = mode === 'all' ? '交集' : '并集';
  const showTags = configured && selected.length > 0;
  const description = !configured ? '请选择标签' : selected.length ? `${modeLabel}：${selected.map(tag => tag.text).join('、')}` : '全部论文';
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return options.filter(option => option.text.toLocaleLowerCase().includes(needle));
  }, [options, query]);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }, []);

  useEffect(() => {
    // The canvas uses a native wheel listener; stop it before React's delegated handlers.
    const button = trigger.current;
    const wheel = (event: WheelEvent) => { event.stopPropagation(); event.preventDefault(); };
    button?.addEventListener('wheel', wheel, { passive: false });
    return () => button?.removeEventListener('wheel', wheel);
  }, []);

  useEffect(() => {
    if (!open) return;
    search.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popup.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    const dismiss = () => close();
    // Filtering may scroll/reflow the canvas. Keep this panel open for the next
    // checkbox; only an intentional wheel gesture outside should dismiss it.
    const wheel = (event: Event) => {
      if (!(event.target instanceof Node) || !popup.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', dismiss);
    window.addEventListener('wheel', wheel, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('wheel', wheel, true);
    };
  }, [open, close]);

  function show() {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(352, window.innerWidth - 16);
    const maxHeight = Math.min(460, window.innerHeight - 16);
    const below = window.innerHeight - rect.bottom - 16;
    const above = rect.top - 16;
    const placeBelow = below >= Math.min(260, maxHeight) || below >= above;
    const available = Math.max(260, placeBelow ? below : above);
    const height = Math.min(maxHeight, available);
    setPlacement({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(placeBelow ? rect.bottom + 8 : rect.top - height - 8, window.innerHeight - height - 8)),
      width,
      maxHeight: height,
    });
    setQuery('');
    setOpen(true);
  }

  function choose(key: string) {
    onChange(!key ? [] : values.includes(key) ? values.filter(value => value !== key) : [...values, key]);
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    const fields = [...popup.current!.querySelectorAll<HTMLElement>('input, button')];
    if (event.key === 'Tab') {
      if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1)?.focus(); }
      if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0]?.focus(); }
      return;
    }
    const items = [...popup.current!.querySelectorAll<HTMLButtonElement>('[data-tag-filter-option]')];
    const index = items.findIndex(item => item === document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (index >= 0 && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault();
      (event.key === 'Home' ? items[0] : items.at(-1))?.focus();
    } else if (event.key === 'Enter' && document.activeElement === search.current) {
      event.preventDefault();
      if (query.trim() && filtered.length) choose(filtered[0].key);
      else items[0]?.focus();
    }
  }

  return <>
    <button ref={trigger} type="button" className={`timeline-tag-filter-trigger ${showTags ? 'has-selected-tags' : ''}`} style={{ top }}
      title={`标签筛选：${description}`} aria-label="时间线标签筛选" aria-describedby={`${id}-current`} aria-haspopup="dialog"
      aria-expanded={open} aria-controls={open ? `${id}-popup` : undefined}
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); if (open) close(); else show(); }}>
      <span className="timeline-tag-filter-heading">标签筛选<ChevronDown size={12} aria-hidden="true" />
        {showTags && selected.length > 1 && <span className="timeline-tag-filter-mode">{modeLabel}</span>}
      </span>
      {showTags ? <span id={`${id}-current`} className="timeline-tag-filter-selected">
        {selected.map(tag => <span key={tag.key} className="timeline-tag-filter-selected-row" title={tag.text}>
          <span className="timeline-tag-filter-selected-dot" style={{ backgroundColor: tag.color }} aria-hidden="true" />
          <span className="timeline-tag-filter-selected-text">{tag.text}</span>
        </span>)}
      </span> : <span id={`${id}-current`} className="timeline-tag-filter-current">{configured ? '全部论文' : '请选择标签'}</span>}
    </button>
    {open && createPortal(<div ref={popup} id={`${id}-popup`} role="dialog" aria-labelledby={`${id}-title`}
      className="timeline-tag-filter-popup" style={placement}
      onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()}
      onPointerUp={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={keyDown}>
      <div className="timeline-tag-filter-popup-heading"><h2 id={`${id}-title`}>按标签筛选</h2>
        <TagMatchSwitch mode={mode} onChange={onModeChange} describedBy={`${id}-logic`} />
        <button type="button" className="icon-button" aria-label="关闭标签筛选" onClick={() => close()}><X size={16} /></button>
      </div>
      <p className="tag-match-help" id={`${id}-logic`}>{mode === 'all' ? '交集：论文须同时包含所有选中的标签' : '并集：论文包含任一选中的标签即可'}</p>
      <label className="timeline-tag-filter-search" htmlFor={`${id}-search`}>
        <Search size={15} aria-hidden="true" /><span className="timeline-tag-filter-sr-only">搜索标签</span>
        <input ref={search} id={`${id}-search`} type="search" placeholder="搜索标签" value={query}
          onChange={event => setQuery(event.target.value)} autoComplete="off" />
      </label>
      <div className="timeline-tag-filter-options" role="group" aria-label="筛选标签">
        <button type="button" className="timeline-tag-filter-option" data-tag-filter-option="" aria-pressed={configured && !values.length}
          onClick={() => choose('')} aria-label={`全部论文，${total} 篇论文`}>
          <span className="timeline-tag-filter-dot timeline-tag-filter-dot-all" aria-hidden="true" />
          <span className="timeline-tag-filter-option-text">全部论文</span><span className="timeline-tag-filter-count" aria-hidden="true">{total}</span>
        </button>
        {filtered.map(option => <button key={option.key} type="button" className="timeline-tag-filter-option"
          role="checkbox" data-tag-filter-option={option.key} aria-checked={values.includes(option.key)} title={option.text}
          aria-label={`${option.text}，${option.count} 篇论文`} onClick={() => choose(option.key)}>
          <span className="tag-filter-checkbox" aria-hidden="true">{values.includes(option.key) && <Check size={11} strokeWidth={2.5} />}</span>
          <span className="timeline-tag-filter-dot" style={{ backgroundColor: option.color }} aria-hidden="true" />
          <span className="timeline-tag-filter-option-text">{option.text}</span><span className="timeline-tag-filter-count" aria-hidden="true">{option.count}</span>
        </button>)}
        {!filtered.length && <p className="timeline-tag-filter-empty" role="status">{options.length ? '没有找到匹配的标签' : '还没有标签'}</p>}
      </div>
      <div className="tag-filter-footer"><span role="status">已选 {values.length} 个 · 显示 {matched} 篇</span>
        <button type="button" className="primary-button" onClick={() => close()}>完成</button>
      </div>
    </div>, document.body)}
  </>;
}
