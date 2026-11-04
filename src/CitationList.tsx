import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, CircleAlert, FileText, LoaderCircle, Plus, RefreshCw, X } from 'lucide-react';
import type { Paper } from '../shared/types';
import type { CitationPage, CitationRecord } from '../shared/citation-monitor';
import { createCitationLibraryMatcher } from '../shared/citation-library';
import './CitationList.css';

export interface CitationListState { offset: number; selectedId: string | null }
const pageSize = 50;
const dateOf = (citation: CitationRecord) => citation.publicationDate || (citation.year ? String(citation.year) : '—');
const providerName = { openalex: 'OpenAlex', semantic_scholar: 'Semantic Scholar' };

export default function CitationList({ paper, papers, state, onChange }: {
  paper: Paper; papers: Paper[]; state: CitationListState; onChange: (changes: Partial<CitationListState>) => void;
}) {
  const [result, setResult] = useState<CitationPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [adding, setAdding] = useState<Set<string>>(() => new Set());
  const [added, setAdded] = useState<Set<string>>(() => new Set());
  const [addError, setAddError] = useState('');
  const [confirmCitation, setConfirmCitation] = useState<CitationRecord | null>(null);
  const pending = useRef(new Set<string>());
  const alive = useRef(true);
  const findInLibrary = useMemo(() => createCitationLibraryMatcher(papers), [papers]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function addCitation(citation: CitationRecord) {
    if (pending.current.has(citation.id) || added.has(citation.id) || findInLibrary(citation)) return;
    pending.current.add(citation.id); setAdding(new Set(pending.current)); setAddError('');
    try {
      await window.paperApi!.addCitation(paper.id, citation.id);
      if (alive.current) setAdded(previous => new Set(previous).add(citation.id));
    } catch (reason) {
      if (alive.current) setAddError(`未能加入文献库：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      pending.current.delete(citation.id);
      if (alive.current) setAdding(new Set(pending.current));
    }
  }
  const list = useRef<HTMLDivElement>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const monitor = paper.citationMonitor;
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(''); setResult(null);
    window.paperApi!.getCitations(paper.id, state.offset, pageSize).then(next => {
      if (!alive) return;
      const offset = Math.max(0, Math.floor((next.total - 1) / pageSize) * pageSize);
      if (state.offset > offset) { change.current({ offset, selectedId: null }); return; }
      setResult(next);
    }).catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [paper.id, state.offset, revision, monitor?.count, monitor?.lastSuccessAt, monitor?.lastAttemptAt, monitor?.status]);
  const selected = result?.citations.find(item => item.id === state.selectedId) ?? result?.citations[0];
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (result && state.selectedId !== selectedId) change.current({ selectedId });
  }, [result, state.selectedId, selectedId]);
  useEffect(() => { list.current?.scrollTo({ top: 0 }); }, [paper.id, state.offset]);
  const timestamp = result?.state?.lastSuccessAt;
  const formattedTime = timestamp && !Number.isNaN(Date.parse(timestamp)) ? new Date(timestamp).toLocaleString('zh-CN') : null;
  const hasSuccessfulResult = !!timestamp || result?.state?.status === 'success' || result?.state?.status === 'partial';
  return <main className="citations-page" id={`citations-panel-${paper.id}`} role="tabpanel" aria-labelledby={`citations-tab-${paper.id}`}>
    <div className="list-tools citations-tools">
      <div className="citations-heading"><h1>引用此论文的文献{result && <span>{result.total.toLocaleString('zh-CN')} 篇</span>}</h1>
        <p title={paper.title}>{paper.title}</p></div>
      <button className="secondary-button" disabled={loading} onClick={() => setRevision(value => value + 1)} title="重新读取本地已同步的引用记录"><RefreshCw size={14} />刷新列表</button>
    </div>
    <div className="citations-content" ref={list} aria-busy={loading}>
      {addError && <p className="citation-add-error" role="alert"><CircleAlert size={15} /><span>{addError}</span></p>}
      {loading ? <div className="empty-state"><LoaderCircle className="spin" size={22} /><p>正在读取引用记录…</p></div>
        : error ? <div className="empty-state" role="alert"><CircleAlert size={25} /><h2>无法读取引用记录</h2><p>{error}</p><button className="text-button" onClick={() => setRevision(value => value + 1)}>重试</button></div>
        : result?.citations.length ? <table className="citations-table" aria-label="引用文献条目">
          <colgroup><col className="citation-title-col" /><col className="citation-authors-col" /><col className="citation-date-col" /><col className="citation-venue-col" /><col className="citation-library-col" /></colgroup>
          <thead><tr><th scope="col">标题</th><th scope="col">作者</th><th scope="col">发表日期</th><th scope="col">期刊 / 会议</th><th scope="col">文献库</th></tr></thead>
          <tbody>{result.citations.map((citation, index) => <tr key={citation.id} data-citation-id={citation.id}
            aria-selected={selectedId === citation.id} tabIndex={selectedId === citation.id ? 0 : -1}
            onClick={() => onChange({ selectedId: citation.id })} onKeyDown={event => {
              if (event.target !== event.currentTarget) return;
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onChange({ selectedId: citation.id }); }
              const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? result.citations.length - 1 : null;
              if (next === null) return;
              event.preventDefault();
              const item = result.citations[Math.max(0, Math.min(result.citations.length - 1, next))];
              onChange({ selectedId: item.id });
              const row = event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-citation-id="${item.id}"]`);
              row?.focus({ preventScroll: true }); row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }}>
            <td title={citation.title}><span className="citation-title">{citation.title || '未命名文献'}</span></td>
            <td title={citation.authors.join(', ')}>{citation.authors.join(', ') || '—'}</td>
            <td>{dateOf(citation)}</td><td title={citation.venue}>{citation.venue || '—'}</td>
            <td className="citation-library-action">{added.has(citation.id) || findInLibrary(citation)
              ? <span className="citation-in-library" aria-label={`已入库：${citation.title}`}><Check size={14} />已入库</span>
              : <button className="citation-add-button" disabled={adding.has(citation.id)} aria-label={`加入文献库：${citation.title}`}
                title="保存书目信息到本地文献库，PDF 可稍后添加"
                onClick={event => { event.stopPropagation(); setConfirmCitation(citation); }} onDoubleClick={event => event.stopPropagation()}>
                {adding.has(citation.id) ? <LoaderCircle size={13} className="spin" /> : <Plus size={13} />}{adding.has(citation.id) ? '正在加入…' : '加入文献库'}
              </button>}</td>
          </tr>)}</tbody>
        </table> : <div className="empty-state"><FileText size={27} strokeWidth={1.4} /><h2>暂无引用记录</h2><p>{hasSuccessfulResult ? '当前已同步结果中暂无引用此论文的文献。' : '本地尚未保存引用此论文的文献。服务器同步后会显示在这里。'}</p></div>}
    </div>
    <aside className="citation-details" aria-label="引用文献详情">
      {selected && !loading && !error ? <><span className="eyebrow">引用文献</span><h2>{selected.title || '未命名文献'}</h2>
        <p className="citation-detail-authors">{selected.authors.join(', ') || '作者未知'}</p>
        <dl><dt>发表日期</dt><dd>{dateOf(selected)}</dd><dt>期刊 / 会议</dt><dd>{selected.venue || '—'}</dd>
          {selected.doi && <><dt>DOI</dt><dd>{selected.doi}</dd></>}{selected.arxivId && <><dt>arXiv</dt><dd>{selected.arxivId}</dd></>}
          <dt>数据来源</dt><dd>{[...new Set(selected.sources.map(source => providerName[source.provider]))].join('、') || '—'}</dd>
          {selected.url && <><dt>原文链接</dt><dd>{selected.url}</dd></>}
        </dl><h3>摘要</h3><p className="citation-abstract">{selected.abstract || '暂无摘要'}</p></>
        : <div className="detail-placeholder"><FileText size={30} strokeWidth={1.3} /><p>选择一篇引用文献，查看详情</p></div>}
    </aside>
    <footer className="citations-footer"><span>{formattedTime ? `本地缓存 · 最近成功抓取 ${formattedTime}` : '本地已同步的引用记录'}</span>
      <div className="citations-pagination" aria-label="引用列表分页"><span>{result ? result.total ? `${result.offset + 1}–${Math.min(result.offset + result.limit, result.total)} / ${result.total}` : '0 / 0' : '—'}</span>
        <button className="icon-button" aria-label="上一页引用" disabled={loading || !!error || !result || state.offset === 0} onClick={() => onChange({ offset: Math.max(0, state.offset - pageSize), selectedId: null })}><ChevronLeft size={17} /></button>
        <button className="icon-button" aria-label="下一页引用" disabled={loading || !!error || !result || result.offset + result.limit >= result.total} onClick={() => onChange({ offset: state.offset + pageSize, selectedId: null })}><ChevronRight size={17} /></button>
      </div>
    </footer>
    {confirmCitation && <CitationAddConfirmation citation={confirmCitation} onClose={() => setConfirmCitation(null)}
      onConfirm={() => { setConfirmCitation(null); void addCitation(confirmCitation); }} />}
  </main>;
}

function CitationAddConfirmation({ citation, onClose, onConfirm }: {
  citation: CitationRecord; onClose: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const submitted = useRef(false);
  useLayoutEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    cancel.current?.focus();
    return () => {
      element.close();
      if (previous?.isConnected) {
        const target = previous.matches(':disabled') ? previous.closest<HTMLElement>('tr') : previous;
        target?.focus({ preventScroll: true });
      }
    };
  }, []);
  return <dialog ref={dialog} className="edit-modal citation-confirm" aria-labelledby="citation-confirm-title" aria-describedby="citation-confirm-description"
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <div className="modal-heading"><h2 id="citation-confirm-title">是否确定加入文献库？</h2>
      <button className="icon-button" aria-label="关闭加入确认" onClick={onClose}><X size={18} /></button></div>
    <div className="modal-fields"><p className="citation-confirm-paper">{citation.title || '未命名文献'}</p>
      <p id="citation-confirm-description">仅加入书目信息，PDF 原文可稍后添加。</p></div>
    <div className="modal-footer"><button ref={cancel} className="secondary-button" onClick={onClose}>取消</button>
      <button className="primary-button" onClick={() => { if (submitted.current) return; submitted.current = true; onConfirm(); }}>确认加入</button></div>
  </dialog>;
}
