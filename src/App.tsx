import { lazy, Suspense, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { PdfReaderHandle } from './PdfReader';
import type { MarkdownNoteHandle } from './MarkdownNote';
import WorkspaceTabs, { workspaceTabId, type WorkspaceTab } from './WorkspaceTabs';
import PaperCollection, { type PaperCollectionState } from './PaperCollection';
import CitationList, { type CitationListState } from './CitationList';
import { collectionLabels, type HomeMetric, type PaperCollectionKind } from './home-collections';
const PdfReader = lazy(() => import('./PdfReader'));
const MarkdownNote = lazy(() => import('./MarkdownNote'));
import { ArrowUpRight, BookOpen, CalendarDays, Check, CircleAlert, FileText, FolderOpen, Settings, List, LoaderCircle, MoreHorizontal, PencilLine, Plus, RefreshCw, Search, X } from 'lucide-react';
import type { ImportResult, Paper, PaperApi, PaperMetadata, PaperRating, LibraryFolder, LibraryState, TimelineTrack, TimelineChanges, TimelinePosition } from '../shared/types';
import { formatPublicationDate, publicationDateOf } from '../shared/publication-date';
import { collectTagOptions } from '../shared/paper-tags';
import { timelinePapers as papersForTrack } from '../shared/timelines';
import TimelineCanvas from './TimelineCanvas';
import { layoutTimeline } from './timeline-layout';
import FolderSidebar, { FolderDialog, type FolderAction } from './FolderSidebar';
import PaperTable from './PaperTable';
import CreateCitationDialog from './CreateCitationDialog';
import { hasPaperFile, paperPdfHash } from '../shared/paper-files';
import LibrarySettings from './LibrarySettings';
import PaperTags from './PaperTags';
import PaperRatingEditor from './PaperRating';
import TagDialog from './TagDialog';
import TagDeleteDialog from './TagDeleteDialog';
import BriefNote, { BriefNoteDialog } from './BriefNote';
import ReaderTagsDialog from './ReaderTagsDialog';

import CitationMonitorPanel from './CitationMonitorPanel';
import PersonalHome from './PersonalHome';
import MineruPanel from './MineruPanel';
declare global { interface Window { paperApi?: PaperApi } }
type Filter = 'all' | 'matched' | 'review';
type View = 'list' | 'timeline';
const busy = (paper: Paper) => ['queued', 'extracting', 'searching'].includes(paper.status);
const sizeLabel = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
const labels = { queued: '等待处理', extracting: '读取 PDF', searching: '检索中', matched: '已核对', review: '待核对', error: '处理失败' };

function Status({ paper, compact = false }: { paper: Paper; compact?: boolean }) {
  return <span className={`status status-${paper.status}`} title={labels[paper.status]} aria-label={labels[paper.status]}>
    {busy(paper) ? <LoaderCircle size={13} className="spin" /> : paper.status === 'matched' ? <Check size={13} /> : <CircleAlert size={13} />}
    {(!compact || paper.status !== 'matched') && labels[paper.status]}
  </span>;
}

export default function App() {
  const [page, setPage] = useState<'home' | 'library' | 'reader' | 'md' | 'collection' | 'citations'>(() => window.paperApi?.cloudStatus ? 'home' : 'library');
  const [readerId, setReaderId] = useState<string | null>(null);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTab[]>([]);
  const [collectionKind, setCollectionKind] = useState<PaperCollectionKind | null>(null);
  const [citationId, setCitationId] = useState<string | null>(null);
  const [citationStates, setCitationStates] = useState<Record<string, CitationListState>>({});
  const [collectionStates, setCollectionStates] = useState<Record<PaperCollectionKind, PaperCollectionState>>({
    pdf: { query: '', selectedId: null }, md: { query: '', selectedId: null }, monitoring: { query: '', selectedId: null },
  });
  const [readerSwitching, setReaderSwitching] = useState(false);
  const readerOperation = useRef<Promise<void> | null>(null);
  const [readerClosing, setReaderClosing] = useState(false);
  const readerRef = useRef<PdfReaderHandle>(null);
  const noteRef = useRef<MarkdownNoteHandle>(null);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [activeFolder, setActiveFolder] = useState('all');
  const [folderAction, setFolderAction] = useState<FolderAction | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<View>(() => {
    try { return localStorage.getItem('paper-timeline-view') === 'timeline' ? 'timeline' : 'list'; }
    catch { return 'list'; }
  });
  const [query, setQuery] = useState('');
  const [timelines, setTimelines] = useState<TimelineTrack[]>([]);
  const timelineWrites = useRef(0);
  const timelineRevision = useRef(0);
  const [timelineDetailsOpen, setTimelineDetailsOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [edit, setEdit] = useState<Paper | null>(null);
  const [detailTagEdit, setDetailTagEdit] = useState<{ id: string; tagId?: string } | null>(null);
  const [briefNoteId, setBriefNoteId] = useState<string | null>(null);
  const [readerTagsId, setReaderTagsId] = useState<string | null>(null);
  const [tagDelete, setTagDelete] = useState<{ id: string; tagId: string; tagText: string; paperTitle: string } | null>(null);
  const tagDeleteRequest = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  const tagReturnFocus = useRef<HTMLElement | null>(null);
  const [storagePath, setStoragePath] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const collectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => { try { localStorage.setItem('paper-timeline-view', view); } catch { /* A view preference must not block the library. */ } }, [view]);

  useEffect(() => {
    const api = window.paperApi;
    if (!api) { setLoadError('请通过桌面程序打开文献库。'); return; }
    let alive = true;
    const update = (next: LibraryState) => { if (alive) { setPapers(next.papers); setFolders(next.folders); if (!timelineWrites.current) setTimelines(next.timelines); } };
    const off = api.onLibraryChanged(update);
    api.getLibrary().then(state => {
      update(state);
      if (alive) { setStoragePath(state.storagePath); setReady(true); }
    }).catch(error => { if (alive) setLoadError(String(error)); });
    return () => { alive = false; off(); };
  }, []);

  useEffect(() => {
    if (!toast || toast.error) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'k' && !edit && !folderAction && !settingsOpen && !creating && !detailTagEdit && !tagDelete && !briefNoteId && !readerTagsId) {
        event.preventDefault(); searchRef.current?.focus();
      }
      if (event.key === 'Escape') { dragDepth.current = 0; setDragging(false); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [edit, folderAction, settingsOpen, creating, detailTagEdit, tagDelete, briefNoteId, readerTagsId]);

  useEffect(() => {
    if (activeFolder !== 'all' && activeFolder !== 'unfiled' && !folders.some(f => f.id === activeFolder)) setActiveFolder('all');
  }, [activeFolder, folders]);

  const folderPapers = useMemo(() => papers.filter(p => activeFolder === 'all' || (activeFolder === 'unfiled' ? !p.folderId : p.folderId === activeFolder)), [papers, activeFolder]);
  const currentFolder = folders.find(f => f.id === activeFolder);
  const scopeLabel = currentFolder?.name || (activeFolder === 'unfiled' ? '未分类' : '文献');

  const filtered = useMemo(() => folderPapers.filter(paper => {
    const inFilter = filter === 'all' || (filter === 'matched' ? paper.status === 'matched' : ['review', 'error'].includes(paper.status));
    return inFilter && [paper.title, ...paper.authors, paper.doi, paper.arxivId, paper.venue, paper.fileName, publicationDateOf(paper)]
      .join(' ').toLowerCase().includes(query.trim().toLowerCase());
  }).sort((a, b) => b.importedAt.localeCompare(a.importedAt)), [folderPapers, filter, query]);
  const timelineTagOptions = useMemo(() => {
    const counts = new Map(collectTagOptions(filtered).map(tag => [tag.key, tag.count]));
    return collectTagOptions(papers).map(tag => ({ ...tag, count: counts.get(tag.key) ?? 0 }));
  }, [papers, filtered]);
  const timelinePapers = useMemo(() => {
    const visible = new Map(timelines.flatMap(track => papersForTrack(filtered, track)).map(paper => [paper.id, paper]));
    return [...visible.values()];
  }, [filtered, timelines]);
  const visiblePapers = useMemo(() => {
    if (view === 'list') return filtered;
    const layout = layoutTimeline(timelinePapers);
    return [...layout.nodes, ...layout.undated].map(node => node.paper);
  }, [view, filtered, timelinePapers]);

  useEffect(() => {
    if (!visiblePapers.some(paper => paper.id === selectedId)) setSelectedId(visiblePapers[0]?.id || null);
  }, [visiblePapers, selectedId]);

  useEffect(() => { collectionRef.current?.scrollTo({ top: 0 }); }, [view, query, filter, activeFolder]);

  const selected = visiblePapers.find(paper => paper.id === selectedId);
  const processing = papers.filter(busy).length;

  async function action(fn: () => Promise<unknown>) {
    try { await fn(); }
    catch (error) { setToast({ text: error instanceof Error ? error.message : String(error), error: true }); }
  }
  function markPaperOpened(id: string) {
    if (papers.find(paper => paper.id === id)?.unread === true) void action(() => window.paperApi!.markOpened(id));
  }
  function selectPaper(id: string) { setSelectedId(id); markPaperOpened(id); }
  function requestDeleteTag(id: string, tagId: string): Promise<void> {
    if (tagDeleteRequest.current) return tagDeleteRequest.current.promise;
    const paper = papers.find(item => item.id === id);
    const tag = paper?.tags?.find(item => item.id === tagId);
    if (!paper || !tag) return Promise.reject(new Error('标签已变化，请刷新后重试。'));
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    tagDeleteRequest.current = { promise, resolve };
    setTagDelete({ id, tagId, tagText: tag.text, paperTitle: paper.title });
    return promise;
  }
  function closeTagDelete() {
    const request = tagDeleteRequest.current;
    tagDeleteRequest.current = null;
    setTagDelete(null);
    request?.resolve();
  }
  useEffect(() => () => { tagDeleteRequest.current?.resolve(); tagDeleteRequest.current = null; }, []);
  function renderPaperDetails(paper: Paper, onClose?: () => void) {
    return <PaperDetails key={paper.id} paper={paper} folders={folders}
      onEditBriefNote={() => setBriefNoteId(paper.id)}
      onMoveFolder={id => action(() => window.paperApi!.movePaper(paper.id, id))} onEdit={() => setEdit(paper)}
      onEditTag={tagId => { tagReturnFocus.current = document.activeElement as HTMLElement; setDetailTagEdit({ id: paper.id, tagId }); }}
      onDeleteTag={tagId => requestDeleteTag(paper.id, tagId)}
      onSetRating={rating => window.paperApi!.setRating(paper.id, rating)} onClose={onClose}
      onOpen={() => action(() => openPdf(paper.id))}
      onOpenDirectory={() => action(() => window.paperApi!.openPaperDirectory(paper.id))}
      onAttachPdf={() => action(async () => { await window.paperApi!.choosePaperPdf(paper.id); })}
      onOpenNote={() => action(() => openMarkdown(paper.id))}
      onAttachNote={() => action(async () => { await window.paperApi!.chooseMarkdown(paper.id); })}
      onRetry={() => action(() => window.paperApi!.retry(paper.id))}
      onSource={() => action(() => window.paperApi!.openSource(paper.id))} />;
  }
  async function navigate(next: typeof page) {
    if (page === next) return;
    await changeReader(() => setPage(next));
  }
  function changeReader(change: () => void): Promise<void> {
    if (readerOperation.current) return readerOperation.current;
    setReaderSwitching(true);
    const operation = (async () => {
      try { await readerRef.current?.flush(); await noteRef.current?.flush(); change(); }
      finally { readerOperation.current = null; setReaderSwitching(false); }
    })();
    readerOperation.current = operation;
    return operation;
  }
  async function openPdf(id: string) {
    markPaperOpened(id);
    if (page === 'reader' && readerId === id) return;
    await changeReader(() => {
      setWorkspaceTabs(previous => previous.some(tab => tab.kind === 'pdf' && tab.id === id) ? previous : [...previous, { kind: 'pdf', id }]);
      setReaderId(id); setPage('reader');
    });
  }
  async function openMarkdown(id: string) {
    markPaperOpened(id);
    if (page === 'md' && noteId === id) return;
    await changeReader(() => {
      setWorkspaceTabs(previous => previous.some(tab => tab.kind === 'md' && tab.id === id) ? previous : [...previous, { kind: 'md', id }]);
      setNoteId(id); setPage('md');
    });
  }
  async function openCollection(kind: PaperCollectionKind) {
    if (page === 'collection' && collectionKind === kind) return;
    await changeReader(() => {
      setWorkspaceTabs(previous => previous.some(tab => tab.kind === 'collection' && tab.id === kind) ? previous : [...previous, { kind: 'collection', id: kind }]);
      setCollectionKind(kind); setPage('collection');
    });
  }
  async function openCitations(id: string) {
    if (page === 'citations' && citationId === id) return;
    await changeReader(() => {
      setWorkspaceTabs(previous => previous.some(tab => tab.kind === 'citations' && tab.id === id) ? previous : [...previous, { kind: 'citations', id }]);
      setCitationId(id); setPage('citations');
    });
  }
  async function openHomeMetric(kind: HomeMetric) {
    if (kind !== 'all') return openCollection(kind);
    await changeReader(() => {
      setActiveFolder('all'); setFilter('all'); setQuery(''); setPage('library');
    });
  }
  const activeTabId = page === 'reader' && readerId ? `pdf-tab-${readerId}`
    : page === 'md' && noteId ? `md-tab-${noteId}`
    : page === 'collection' && collectionKind ? `collection-tab-${collectionKind}`
    : page === 'citations' && citationId ? `citations-tab-${citationId}` : null;
  async function closeTab(tab: WorkspaceTab) {
    await changeReader(() => {
      const id = workspaceTabId(tab);
      const index = workspaceTabs.findIndex(item => workspaceTabId(item) === id);
      const remaining = workspaceTabs.filter(item => workspaceTabId(item) !== id);
      setWorkspaceTabs(remaining);
      if (tab.kind === 'pdf' && readerId === tab.id) setReaderId(remaining.find(item => item.kind === 'pdf')?.id ?? null);
      if (tab.kind === 'md' && noteId === tab.id) setNoteId(null);
      if (tab.kind === 'collection') setCollectionStates(previous => ({ ...previous, [tab.id]: { query: '', selectedId: null } }));
      if (tab.kind === 'citations') {
        setCitationStates(previous => { const next = { ...previous }; delete next[tab.id]; return next; });
        if (citationId === tab.id) setCitationId(null);
      }
      let focusId = activeTabId;
      if (activeTabId === id) {
        const next = remaining[Math.min(index, remaining.length - 1)];
        focusId = next ? workspaceTabId(next) : null;
        if (!next) setPage('library');
        else if (next.kind === 'pdf') { setReaderId(next.id); setPage('reader'); }
        else if (next.kind === 'md') { setNoteId(next.id); setPage('md'); }
        else if (next.kind === 'citations') { setCitationId(next.id); setPage('citations'); }
        else { setCollectionKind(next.id); setPage('collection'); }
      }
      requestAnimationFrame(() => {
        if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
        else if (activeTabId === id) document.querySelector<HTMLElement>('.home-nav button[aria-pressed="true"]')?.focus({ preventScroll: true });
      });
    });
  }
  useEffect(() => { void window.paperApi?.setReaderActive?.(page === 'reader' || page === 'md').catch(() => {}); }, [page]);
  useEffect(() => window.paperApi?.onReaderFlush?.(() => {
    setReaderClosing(true);
    void (async () => {
      try { await readerOperation.current; await readerRef.current?.flush(); await noteRef.current?.flush(); await window.paperApi!.readerCloseReady(); }
      catch (e) { await window.paperApi!.readerCloseReady(e instanceof Error ? e.message : String(e)); }
      finally { setReaderClosing(false); }
    })();
  }), []);

  async function changeTimeline<T>(operation: () => Promise<T>): Promise<T> {
    timelineWrites.current++;
    timelineRevision.current++;
    try { return await operation(); }
    finally {
      timelineWrites.current--;
      if (!timelineWrites.current) {
        const revision = timelineRevision.current;
        const state = await window.paperApi!.getLibrary();
        if (!timelineWrites.current && revision === timelineRevision.current) setTimelines(state.timelines);
      }
    }
  }
  function updateTimeline(id: string, changes: TimelineChanges) {
    setTimelineDetailsOpen(false);
    setTimelines(previous => previous.map(track => track.id === id
      ? { ...track, ...changes, configured: changes.tags !== undefined ? true : track.configured } : track));
    return changeTimeline(() => window.paperApi!.updateTimeline(id, changes));
  }
  function createTimeline(position: TimelinePosition) {
    setTimelineDetailsOpen(false);
    return changeTimeline(() => window.paperApi!.createTimeline(position));
  }
  function deleteTimeline(id: string) {
    setTimelineDetailsOpen(false);
    return changeTimeline(() => window.paperApi!.deleteTimeline(id));
  }

  function reportImport(result: ImportResult | null) {
    if (!result) return;
    const parts = [result.imported ? `已导入 ${result.imported} 篇，正在检索元数据` : '', result.duplicates ? `${result.duplicates} 个重复文件已跳过` : '', ...result.errors.slice(0, 3)].filter(Boolean);
    setToast({ text: parts.join('。') || '未选择 PDF 文件', error: result.errors.length > 0 });
    if (result.imported) { setFilter('all'); setQuery(''); }
  }

  async function importPdfs(files?: File[]) {
    if (!window.paperApi || importing || settingsOpen || detailTagEdit || tagDelete || briefNoteId || readerTagsId) return;
    setImporting(true);
    try { reportImport(files ? await window.paperApi.importFiles(files, currentFolder?.id || null) : await window.paperApi.choosePdfs(currentFolder?.id || null)); }
    catch (error) { setToast({ text: String(error), error: true }); }
    finally { setImporting(false); }
  }

  function drop(event: DragEvent) {
    event.preventDefault(); dragDepth.current = 0; setDragging(false);
    void importPdfs(Array.from(event.dataTransfer.files));
  }

  return <div className="app-shell"
    onDragEnter={event => { if (!settingsOpen && !detailTagEdit && !tagDelete && !briefNoteId && !readerTagsId && event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
    onDragOver={event => event.preventDefault()}
    onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
    onDrop={drop}>
    <header className="app-header">
      <div className="header-navigation">
        <nav className="home-nav" aria-label="主导航"><button disabled={readerSwitching} aria-pressed={page === 'home'} onClick={() => action(() => navigate('home'))}>个人首页</button><button disabled={readerSwitching} aria-pressed={page === 'library'} onClick={() => action(() => navigate('library'))}>文献库</button></nav>
        {workspaceTabs.length > 0 && <WorkspaceTabs tabs={workspaceTabs.flatMap(tab => {
          const paperTitle = tab.kind !== 'collection' ? papers.find(paper => paper.id === tab.id)?.title : undefined;
          const title = tab.kind === 'collection' ? collectionLabels[tab.id] : paperTitle ? tab.kind === 'citations' ? `引用详情：${paperTitle}` : tab.kind === 'md' ? `MD：${paperTitle}` : paperTitle : undefined;
          return title ? [{ ...tab, title }] : [];
        })} activeId={activeTabId} disabled={readerSwitching || readerClosing}
          onSelect={tab => action(() => tab.kind === 'pdf' ? openPdf(tab.id) : tab.kind === 'md' ? openMarkdown(tab.id) : tab.kind === 'citations' ? openCitations(tab.id) : openCollection(tab.id))}
          onClose={tab => action(() => closeTab(tab))} />}
      </div>
      <div className="header-actions">
        {processing > 0 && <span className="processing" role="status"><LoaderCircle size={14} className="spin" />正在处理 {processing} 篇</span>}
        <button className="icon-button" aria-label="本地文献库" title={`本地文献库\n${storagePath}`} disabled={!ready} onClick={() => action(() => window.paperApi!.revealLibrary())}><FolderOpen size={19} /></button>
        <button className="secondary-button" disabled={!ready || importing || readerSwitching} onClick={() => action(() => changeReader(() => setSettingsOpen(true)))}><Settings size={16} />文献库设置</button>
        <button className="secondary-button" disabled={!ready || importing} onClick={() => setCreating(true)}><Plus size={16} />添加文献</button>
        <button className="primary-button" disabled={!ready || importing} onClick={() => importPdfs()}>
          {importing ? <LoaderCircle size={16} className="spin" /> : <Plus size={17} />}导入 PDF
        </button>
      </div>
      <input className="visually-hidden" type="file" multiple accept=".pdf,application/pdf" aria-label="选择 PDF 文件"
        onChange={event => { if (event.target.files?.length) void importPdfs(Array.from(event.target.files)); event.target.value = ''; }} />
    </header>

    {page === 'home' && <PersonalHome papers={papers} storagePath={storagePath} disabled={!ready || readerSwitching || readerClosing}
      onLibrary={() => action(() => navigate('library'))} onMetric={kind => action(() => openHomeMetric(kind))} />}
    {page === 'collection' && collectionKind && <PaperCollection key={collectionKind} kind={collectionKind} papers={papers}
      state={collectionStates[collectionKind]} searchRef={searchRef}
      onChange={changes => setCollectionStates(previous => ({ ...previous, [collectionKind]: { ...previous[collectionKind], ...changes } }))}
      onSelect={markPaperOpened}
      onOpen={id => action(() => openPdf(id))} onOpenNote={id => action(() => openMarkdown(id))}
      onOpenCitations={id => action(() => openCitations(id))}
      renderStatus={paper => <Status paper={paper} compact />} renderDetails={paper => renderPaperDetails(paper)} />}
    {page === 'citations' && citationId && papers.find(paper => paper.id === citationId) && <CitationList key={citationId}
      paper={papers.find(paper => paper.id === citationId)!} papers={papers} state={citationStates[citationId] ?? { offset: 0, selectedId: null }}
      onChange={changes => setCitationStates(previous => ({ ...previous, [citationId]: { ...(previous[citationId] ?? { offset: 0, selectedId: null }), ...changes } }))} />}
    {page === 'reader' && readerId && papers.find(p => p.id === readerId) && <section className="reader-panel" id="pdf-reader-panel" role="tabpanel" aria-labelledby={`pdf-tab-${readerId}`}><Suspense fallback={<div className="empty-state"><LoaderCircle className="spin" /><p>正在加载阅读器…</p></div>}><PdfReader key={readerId} ref={readerRef} paper={papers.find(p => p.id === readerId)!}
      onEditBriefNote={() => setBriefNoteId(readerId)} onManageTags={() => { tagReturnFocus.current = document.activeElement as HTMLElement; setReaderTagsId(readerId); }} /></Suspense></section>}
    {page === 'md' && noteId && papers.find(paper => paper.id === noteId) && <section className="reader-panel" id="markdown-note-panel" role="tabpanel" aria-labelledby={`md-tab-${noteId}`}><Suspense fallback={<div className="empty-state"><LoaderCircle className="spin" /><p>正在加载笔记…</p></div>}><MarkdownNote key={noteId} ref={noteRef} paper={papers.find(paper => paper.id === noteId)!} /></Suspense></section>}
    {page === 'library' && <main className={`library-layout ${view === 'timeline' ? `timeline-layout ${timelineDetailsOpen && selected ? 'timeline-detail-open' : ''}` : ''}`}>
      {view === 'list' && <FolderSidebar folders={folders} papers={papers} active={activeFolder} ready={ready}
        onSelect={id => { setActiveFolder(id); setFilter('all'); setQuery(''); }} onAction={setFolderAction} />}
      <section className="library-list" aria-label="文献库">
        <div className="list-tools">
          <div className="list-heading"><h1 title={scopeLabel}><span className="scope-name">{scopeLabel}</span><span>{folderPapers.length}</span></h1>
            <select aria-label="文献筛选" value={filter} onChange={event => setFilter(event.target.value as Filter)}>
              <option value="all">全部</option><option value="review">待核对</option><option value="matched">已核对</option>
            </select>
          </div>
          <div className="search-wrap"><Search size={16} /><input ref={searchRef} aria-label="搜索文献" placeholder="搜索标题、作者…" value={query} onChange={event => setQuery(event.target.value)} />
            {query && <button className="icon-button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={14} /></button>}
          </div>
          <div className="view-toolbar">
            <div className="view-switch" role="group" aria-label="文献视图">
              <button aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={14} />列表</button>
              <button aria-pressed={view === 'timeline'} onClick={() => { setView('timeline'); setTimelineDetailsOpen(false); }}><CalendarDays size={14} />时间线</button>
            </div>
            <span className="view-caption" title={view === 'timeline' ? '按发表时间从左到右排列；间距根据阅读需要调整。arXiv 使用首次提交时间，缺少日期的文献单独放置。' : undefined}>{view === 'timeline' ? '发表时间 · 早 → 晚' : '文献列表'}</span>
          </div>
        </div>
        <div ref={collectionRef} className={`paper-list ${view === 'timeline' ? 'timeline-container' : ''}`} aria-label={view === 'timeline' ? '发表时间线' : '文献列表'}>
          {loadError ? <div className="empty-state"><CircleAlert size={25} /><h2>无法打开文献库</h2><p>{loadError}</p></div>
            : !ready ? <div className="empty-state"><LoaderCircle className="spin" size={22} /><p>正在读取文献库…</p></div>
            : view === 'timeline' ? <TimelineCanvas key={storagePath} storagePath={storagePath} papers={filtered} selectedId={selectedId}
              selectedTrackId={selectedTrackId} onSelectTrack={setSelectedTrackId}
              tagOptions={timelineTagOptions} tracks={timelines}
              revealSelected={timelineDetailsOpen}
              onCreateTimeline={createTimeline} onUpdateTimeline={updateTimeline} onDeleteTimeline={deleteTimeline}
              emptyTitle={currentFolder && !folderPapers.length ? '文件夹中还没有论文' : papers.length ? '没有匹配的文献' : '导入你的第一篇论文'}
              emptyDescription={papers.length ? '换个关键词，或切换筛选。' : '将 PDF 拖入窗口，或点击右上角「导入 PDF」。'}
              onSelect={id => { selectPaper(id); setTimelineDetailsOpen(true); }} renderStatus={paper => paper.status === 'matched' ? null : <Status paper={paper} compact />}
              onAddTag={(id, text, color) => window.paperApi!.addTag(id, text, color)}
              onUpdateTag={(id, tagId, text, color) => window.paperApi!.updateTag(id, tagId, text, color)}
              onMoveTag={(id, tagId, position) => window.paperApi!.moveTag(id, tagId, position)}
              onMoveFileTag={(id, kind, position) => window.paperApi!.moveFileTag(id, kind, position)}
              onOpenFile={(id, kind) => kind === 'pdf' ? openPdf(id) : openMarkdown(id)}
              onDeleteTag={requestDeleteTag} />
              : filtered.length ? <PaperTable papers={filtered} selectedId={selectedId} onSelect={selectPaper} onOpen={id => action(() => openPdf(id))} onOpenNote={id => action(() => openMarkdown(id))} onOpenCitations={id => action(() => openCitations(id))} renderStatus={paper => <Status paper={paper} compact />} />
              : <div className="empty-state"><FileText size={27} strokeWidth={1.4} /><h2>{currentFolder && !folderPapers.length ? '文件夹中还没有论文' : papers.length ? '没有匹配的文献' : '导入你的第一篇论文'}</h2>
                <p>{currentFolder && !folderPapers.length ? '点击「导入 PDF」添加论文，\n或在文献详情中更改所属文件夹。' : papers.length ? '换个关键词，或切换筛选。' : '将 PDF 拖入窗口，\n或点击右上角「导入 PDF」。'}</p>
                {(papers.length > 0 || currentFolder) && <button className="text-button" onClick={() => { setActiveFolder('all'); setFilter('all'); setQuery(''); }}>查看全部文献</button>}
              </div>}
        </div>
      </section>

      {(view === 'list' || (timelineDetailsOpen && selected)) && <aside className="detail-panel" aria-label="文献详情">
        {selected ? renderPaperDetails(selected, view === 'timeline' ? () => setTimelineDetailsOpen(false) : undefined)
          : <div className="detail-placeholder"><BookOpen size={30} strokeWidth={1.3} /><p>选择一篇文献，查看详情</p></div>}
      </aside>}
    </main>}

    {(readerClosing || readerSwitching) && <div className="reader-closing"><span>正在保存阅读内容…</span></div>}
    {dragging && <div className="drop-overlay"><div><Plus size={30} /><h2>松开鼠标，导入 PDF</h2></div></div>}
    {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role="alert">{toast.error ? <CircleAlert size={17} /> : <Check size={17} />}<span>{toast.text}</span><button className="icon-button" aria-label="关闭通知" onClick={() => setToast(null)}><X size={16} /></button></div>}
    {settingsOpen && <LibrarySettings path={storagePath} count={papers.length} processing={processing > 0 || importing} onBeforeApply={async () => { await readerRef.current?.flush(); await noteRef.current?.flush(); }} onClose={() => setSettingsOpen(false)} />}
    {tagDelete && <TagDeleteDialog key={`${tagDelete.id}:${tagDelete.tagId}`} tagText={tagDelete.tagText} paperTitle={tagDelete.paperTitle}
      onDelete={() => window.paperApi!.deleteTag(tagDelete.id, tagDelete.tagId)} onClose={closeTagDelete} />}
    {briefNoteId && papers.find(paper => paper.id === briefNoteId) && <BriefNoteDialog key={briefNoteId} paper={papers.find(paper => paper.id === briefNoteId)!}
      onSave={text => window.paperApi!.setBriefNote(briefNoteId, text)} onClose={() => setBriefNoteId(null)} />}
    {readerTagsId && papers.find(paper => paper.id === readerTagsId) && <ReaderTagsDialog key={readerTagsId} paper={papers.find(paper => paper.id === readerTagsId)!}
      onEdit={tagId => { setDetailTagEdit({ id: readerTagsId, tagId }); setReaderTagsId(null); }} onDelete={tagId => requestDeleteTag(readerTagsId, tagId)} onClose={() => setReaderTagsId(null)} />}
    {detailTagEdit && <TagDialog key={`${detailTagEdit.id}:${detailTagEdit.tagId ?? 'new'}`}
      tag={papers.find(paper => paper.id === detailTagEdit.id)?.tags?.find(tag => tag.id === detailTagEdit.tagId)}
      tagOptions={timelineTagOptions}
      onClose={() => { setDetailTagEdit(null); requestAnimationFrame(() => { if (tagReturnFocus.current?.isConnected) tagReturnFocus.current.focus({ preventScroll: true }); }); }}
      onSave={(text, color) => detailTagEdit.tagId
        ? window.paperApi!.updateTag(detailTagEdit.id, detailTagEdit.tagId, text, color)
        : window.paperApi!.addTag(detailTagEdit.id, text, color)} />}
    {creating && <CreateCitationDialog onClose={() => setCreating(false)} onSave={async fields => {
      const result = await window.paperApi!.createPaper(fields, currentFolder?.id || null);
      setCreating(false); setActiveFolder('all'); setFilter('all'); setQuery(''); setView('list'); setSelectedId(result.id);
      setToast({ text: result.created ? '已添加文献，正在检索元数据' : '文献已存在，已打开已有条目' });
    }} />}
    {edit && <EditDialog paper={edit} onClose={() => setEdit(null)} onSave={async metadata => {
      await window.paperApi!.saveMetadata(edit.id, metadata);
      setEdit(null); setToast({ text: '元数据已保存' });
    }} />}
    {folderAction && <FolderDialog action={folderAction} onClose={() => setFolderAction(null)} onSave={async name => {
      if (folderAction.mode === 'create') {
        const folder = await window.paperApi!.createFolder(name);
        // The IPC reply and change event can be delivered in either order. Keep
        // the newly selected folder available before rendering the import action.
        setFolders(previous => previous.some(item => item.id === folder.id) ? previous : [...previous, folder]);
        setActiveFolder(folder.id); setFilter('all'); setQuery('');
      } else if (folderAction.mode === 'rename') await window.paperApi!.renameFolder(folderAction.folder.id, name);
      else {
        await window.paperApi!.deleteFolder(folderAction.folder.id);
        if (activeFolder === folderAction.folder.id) setActiveFolder('unfiled');
      }
    }} />}
  </div>;
}

function PaperDetails({ paper, folders, onMoveFolder, onEdit, onEditTag, onEditBriefNote, onDeleteTag, onSetRating, onOpen, onOpenDirectory, onAttachPdf, onOpenNote, onAttachNote, onRetry, onSource, onClose }: {
  paper: Paper; folders: LibraryFolder[]; onMoveFolder: (id: string | null) => Promise<void>; onEdit: () => void; onOpen: () => void; onOpenDirectory: () => void; onAttachPdf: () => void; onOpenNote: () => void; onAttachNote: () => void; onRetry: () => void; onSource: () => void; onClose?: () => void;
  onEditTag: (tagId?: string) => void; onDeleteTag: (tagId: string) => Promise<unknown>;
  onSetRating: (rating: PaperRating | null) => Promise<void>;
  onEditBriefNote: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenuOpen(false); menuButton.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [menuOpen]);
  const choose = (fn: () => void) => { setMenuOpen(false); fn(); };
  return <div className="detail-scroll">
    <article className="paper-details">
      <div className="detail-toolbar"><span className="detail-label">文献详情</span><div className="detail-actions">
        {hasPaperFile(paper, 'pdf') ? <button className="secondary-button" onClick={onOpen}>打开 PDF<ArrowUpRight size={15} /></button> : paperPdfHash(paper) === null ? <button className="secondary-button" disabled={busy(paper)} onClick={onAttachPdf}><Plus size={15} />添加 PDF</button> : <span className="field-help">PDF 文件缺失</span>}
        <div className="more-menu" ref={menuRef}><button ref={menuButton} className="icon-button" aria-label="更多操作" title="更多操作" aria-expanded={menuOpen} aria-haspopup="true" onClick={() => setMenuOpen(!menuOpen)}><MoreHorizontal size={21} /></button>
          {menuOpen && <div className="menu-items">
            <button onClick={() => choose(onOpenDirectory)}><FolderOpen size={15} />打开资料文件夹</button>
            <button aria-label="编辑元数据" disabled={busy(paper)} onClick={() => choose(onEdit)}><PencilLine size={15} />编辑元数据</button>
            <button disabled={busy(paper)} onClick={() => choose(onRetry)}><RefreshCw size={15} />重新检索</button>
            {(paper.url || paper.doi || paper.arxivId) && <button onClick={() => choose(onSource)}><ArrowUpRight size={15} />查看来源</button>}
          </div>}
        </div>
        {onClose && <button className="icon-button" aria-label="收起详情" title="收起详情" onClick={onClose}><X size={17} /></button>}
      </div></div>

      <h2 className="detail-title">{paper.title}</h2>
      <p className="authors">{paper.authors.join(', ') || '作者待补充'}</p>
      <p className="publication"><time dateTime={publicationDateOf(paper) || undefined}>{formatPublicationDate(publicationDateOf(paper))}</time>{paper.source === 'arXiv' ? ' 首次提交' : ''} · {paper.venue || '发表信息待补充'}</p>
      <div className={`match-notice ${paper.status === 'matched' ? 'verified' : ''}`}>
        {paper.status === 'matched' ? <><Check size={14} /><span>{paper.source} · {paper.matchMethod}</span></> : <><Status paper={paper} /><span>{paper.message}</span></>}
      </div>

      {(paper.doi || paper.arxivId) && <dl className="identifiers">
        {paper.doi && <div><dt>DOI</dt><dd>{paper.doi}</dd></div>}
        {paper.arxivId && <div><dt>arXiv</dt><dd>{paper.arxivId}</dd></div>}
      </dl>}

      <div className="paper-folder-field"><label htmlFor="paper-folder">所属文件夹</label><select id="paper-folder" value={paper.folderId || ''} disabled={moving} onChange={async event => {
        setMoving(true); try { await onMoveFolder(event.target.value || null); } finally { setMoving(false); }
      }}><option value="">未分类</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></div>

      <PaperTags tags={paper.tags ?? []} onEdit={onEditTag} onDelete={onDeleteTag} />
      <PaperRatingEditor rating={paper.rating} onChange={onSetRating} />
      <BriefNote paper={paper} onEdit={onEditBriefNote} />
      <CitationMonitorPanel paper={paper}
        onChange={enabled => window.paperApi!.setCitationMonitoring(paper.id, enabled)}
        onOpen={() => window.paperApi!.openCitationDirectory(paper.id)} />

      <section className="markdown-note-section" aria-label="Markdown 笔记">
        <h3>Markdown 笔记</h3>
        {paper.markdownNote ? <button className="note-open-button" onClick={onOpenNote} title="在软件内阅读与编辑笔记"><FileText size={20} /><span>{paper.markdownNote.fileName}</span><ArrowUpRight size={14} /></button>
          : <button className="text-button" onClick={onAttachNote}><Plus size={14} />添加笔记</button>}
        <p>{paper.markdownNote ? '已保存在文献库中 · 点击阅读与编辑' : '选择 .md 文件，将独立副本保存在文献库中'}</p>
      </section>
      <MineruPanel paper={paper} />
      {paper.readingRecord && <details className="reading-record"><summary>阅读记录 · {paper.readingRecord.source}</summary><dl>{paper.readingRecord.fields.map((field, index) => <div key={index}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl></details>}

      <section className="abstract-section"><h3>摘要{paper.abstract && <span className="field-source">{paper.abstractSource === 'PDF' ? 'PDF 提取' : paper.abstractSource || paper.source}</span>}</h3>
        <p>{paper.abstract || (busy(paper) ? '正在检索摘要…' : '暂无摘要')}</p>
      </section>

      <details className="file-details"><summary>文件信息</summary><div className="file-info">
        {paper.thumbnail && <img src={paper.thumbnail} alt="PDF 首页预览" />}
        <div>{paperPdfHash(paper) === null ? <p>尚未添加 PDF 原文</p> : <><p>{paper.fileName}</p><p>{paper.pageCount ? `${paper.pageCount} 页 · ` : ''}{sizeLabel(paper.fileSize)}</p></>}<p>导入于 {new Date(paper.importedAt).toLocaleString('zh-CN', { hour12: false })}</p></div>
      </div></details>
    </article>
  </div>;
}

function EditDialog({ paper, onClose, onSave }: { paper: Paper; onClose: () => void; onSave: (metadata: PaperMetadata) => Promise<void> }) {
  const [title, setTitle] = useState(paper.title);
  const [authors, setAuthors] = useState(paper.authors.join('\n'));
  const [publicationDate, setPublicationDate] = useState(publicationDateOf(paper));
  const [venue, setVenue] = useState(paper.venue);
  const [doi, setDoi] = useState(paper.doi);
  const [abstract, setAbstract] = useState(paper.abstract);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  return <div className="modal-backdrop"><form ref={formRef} className="edit-modal" role="dialog" aria-modal="true" aria-labelledby="edit-title"
    onKeyDown={event => {
      if (event.key === 'Escape' && !saving) onClose();
      if (event.key !== 'Tab') return;
      const fields = [...formRef.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea')];
      const first = fields[0], last = fields[fields.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}
    onSubmit={async event => {
      event.preventDefault(); setSaving(true); setError('');
      try { await onSave({ ...paper, title, authors: authors.split('\n').map(a => a.trim()).filter(Boolean), publicationDate: publicationDate.trim(), year: publicationDate.trim() ? Number(publicationDate.trim().slice(0, 4)) : null, venue, doi, abstract }); }
      catch (err) { setError(String(err)); }
      finally { setSaving(false); }
    }}>
    <div className="modal-heading"><h2 id="edit-title">编辑元数据</h2><button type="button" className="icon-button" aria-label="关闭编辑" disabled={saving} onClick={onClose}><X size={19} /></button></div>
    <div className="modal-fields">
      <label htmlFor="edit-paper-title">标题</label><textarea id="edit-paper-title" autoFocus required rows={2} value={title} onChange={event => setTitle(event.target.value)} />
      <label htmlFor="edit-paper-authors">作者 <span>每行一位</span></label><textarea id="edit-paper-authors" rows={2} value={authors} onChange={event => setAuthors(event.target.value)} />
      <div className="form-row"><div><label htmlFor="edit-paper-date">发表日期</label><input id="edit-paper-date" placeholder="2025-04-02" aria-describedby="date-help" maxLength={10} value={publicationDate} onChange={event => setPublicationDate(event.target.value)} /></div><div><label htmlFor="edit-paper-venue">发表载体</label><input id="edit-paper-venue" value={venue} onChange={event => setVenue(event.target.value)} /></div></div>
      <p id="date-help" className="field-help">可只填年份或年-月；arXiv 论文填写首次提交日期。</p>
      <label htmlFor="edit-paper-doi">DOI</label><input id="edit-paper-doi" value={doi} onChange={event => setDoi(event.target.value)} />
      <label htmlFor="edit-paper-abstract">摘要</label><textarea id="edit-paper-abstract" rows={5} value={abstract} onChange={event => setAbstract(event.target.value)} />
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <div className="modal-footer"><button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存</button></div>
  </form></div>;
}
