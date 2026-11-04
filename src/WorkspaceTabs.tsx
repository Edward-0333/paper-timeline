import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { PaperCollectionKind } from './home-collections';
import './PdfReaderTabs.css';

export type WorkspaceTab = { kind: 'pdf'; id: string } | { kind: 'md'; id: string } | { kind: 'citations'; id: string } | { kind: 'collection'; id: PaperCollectionKind };
export const workspaceTabId = (tab: WorkspaceTab) => `${tab.kind}-tab-${tab.id}`;

export default function WorkspaceTabs({ tabs, activeId, disabled, onSelect, onClose }: {
  tabs: (WorkspaceTab & { title: string })[]; activeId: string | null; disabled: boolean;
  onSelect: (tab: WorkspaceTab) => Promise<void>; onClose: (tab: WorkspaceTab) => Promise<void>;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = list.current;
    if (!element || !activeId) return;
    const reveal = () => document.getElementById(activeId)?.closest('.reader-tab')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    return () => observer.disconnect();
  }, [activeId, tabs.length]);
  return <div className="reader-tabs-bar">
    <div className="reader-tabs" role="tablist" aria-label={tabs.some(tab => tab.kind !== 'pdf') ? '工作区标签' : 'PDF 阅读标签'} ref={list}>
      {tabs.map((tab, index) => {
        const id = workspaceTabId(tab);
        const active = activeId === id;
        return <div className={`reader-tab ${tab.kind === 'collection' ? 'is-collection' : ''} ${active ? 'is-active' : ''}`} key={id}>
          <button className="reader-tab-select" id={id} role="tab" aria-label={tab.title}
            aria-selected={active} aria-controls={active ? tab.kind === 'pdf' ? 'pdf-reader-panel' : tab.kind === 'md' ? 'markdown-note-panel' : `${tab.kind}-panel-${tab.id}` : undefined}
            tabIndex={active || (!activeId && index === 0) ? 0 : -1} disabled={disabled} title={tab.title}
            onClick={() => void onSelect(tab)} onKeyDown={event => {
              if (event.key === 'Delete') { event.preventDefault(); void onClose(tab); return; }
              const next = event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
                : event.key === 'ArrowRight' ? (index + 1) % tabs.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault();
              void onSelect(tabs[next]).then(() => requestAnimationFrame(() => document.getElementById(workspaceTabId(tabs[next]))?.focus({ preventScroll: true })));
            }}><span className="reader-tab-title">{tab.title}</span></button>
          <button className="reader-tab-close" aria-label={tab.kind === 'pdf' ? `关闭 PDF：${tab.title}` : tab.kind === 'md' ? `关闭 MD：${tab.title.slice(3)}` : `关闭列表：${tab.title}`}
            title={tab.kind === 'pdf' ? '关闭此 PDF（Delete）' : tab.kind === 'md' ? '关闭此笔记（Delete）' : '关闭此列表（Delete）'} disabled={disabled}
            onClick={() => void onClose(tab)}><X size={13} /></button>
        </div>;
      })}
    </div>
  </div>;
}
