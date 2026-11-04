import { useEffect, useMemo, useRef, type ReactNode, type Ref } from 'react';
import { FileText, Search, X } from 'lucide-react';
import type { Paper } from '../shared/types';
import { publicationDateOf } from '../shared/publication-date';
import { collectionLabels, paperInCollection, type PaperCollectionKind } from './home-collections';
import PaperTable from './PaperTable';
import './PaperCollection.css';

export interface PaperCollectionState { query: string; selectedId: string | null }

export default function PaperCollection({ kind, papers, state, onChange, onSelect, onOpen, onOpenNote, onOpenCitations, renderStatus, renderDetails, searchRef }: {
  kind: PaperCollectionKind; papers: Paper[]; state: PaperCollectionState;
  onChange: (changes: Partial<PaperCollectionState>) => void;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void; onOpenNote: (id: string) => void; onOpenCitations: (id: string) => void;
  renderStatus: (paper: Paper) => ReactNode; renderDetails: (paper: Paper) => ReactNode; searchRef: Ref<HTMLInputElement>;
}) {
  const list = useRef<HTMLDivElement>(null);
  const members = useMemo(() => papers.filter(paper => paperInCollection(paper, kind)), [papers, kind]);
  const filtered = useMemo(() => members.filter(paper =>
    [paper.title, ...paper.authors, paper.doi, paper.arxivId, paper.venue, paper.fileName, publicationDateOf(paper)]
      .join(' ').toLowerCase().includes(state.query.trim().toLowerCase()))
    .sort((a, b) => b.importedAt.localeCompare(a.importedAt)), [members, state.query]);
  const selected = filtered.find(paper => paper.id === state.selectedId) ?? filtered[0];
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (state.selectedId !== selectedId) onChange({ selectedId });
  }, [state.selectedId, selectedId, onChange]);
  useEffect(() => { list.current?.scrollTo({ top: 0 }); }, [state.query]);
  return <main className="collection-page" aria-label={`${collectionLabels[kind]}列表`}>
    <section className="collection-panel" id={`collection-panel-${kind}`} role="tabpanel" aria-labelledby={`collection-tab-${kind}`}>
      <div className="list-tools">
        <div className="list-heading"><h1>{collectionLabels[kind]}<span>{state.query ? `${filtered.length} / ${members.length}` : members.length} 篇</span></h1></div>
        <div className="search-wrap"><Search size={16} /><input ref={searchRef} aria-label="搜索此列表" placeholder="搜索标题、作者…"
          value={state.query} onChange={event => onChange({ query: event.target.value })} />
          {state.query && <button className="icon-button" aria-label="清空搜索" onClick={() => onChange({ query: '' })}><X size={14} /></button>}
        </div>
      </div>
      <div className="paper-list" ref={list} aria-label="文献列表">
        {filtered.length ? <PaperTable papers={filtered} selectedId={selectedId} onSelect={id => { onChange({ selectedId: id }); onSelect(id); }}
          onOpen={onOpen} onOpenNote={onOpenNote} onOpenCitations={onOpenCitations} renderStatus={renderStatus} />
          : <div className="empty-state"><FileText size={27} strokeWidth={1.4} /><h2>{state.query ? '没有匹配的文献' : '此列表暂无文献'}</h2>
            <p>{state.query ? '换个关键词再试试。' : kind === 'pdf' ? '添加 PDF 原文后，文献会显示在这里。' : kind === 'md' ? '添加 Markdown 笔记后，文献会显示在这里。' : '开启论文的引用监控后，文献会显示在这里。'}</p>
            {state.query && <button className="text-button" onClick={() => onChange({ query: '' })}>清空搜索</button>}
          </div>}
      </div>
      <aside className="detail-panel" aria-label="文献详情">
        {selected ? renderDetails(selected) : <div className="detail-placeholder"><FileText size={30} strokeWidth={1.3} /><p>选择一篇文献，查看详情</p></div>}
      </aside>
    </section>
  </main>;
}
