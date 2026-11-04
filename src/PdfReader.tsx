import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Check, CircleAlert, FolderOpen, LoaderCircle, RotateCw, StickyNote, Tags, X } from 'lucide-react';
import { PDFViewer, AnnotationPlugin, DocumentManagerPlugin, ScrollPlugin, ZoomPlugin, ZoomMode, HistoryPlugin,
  type PDFViewerConfig, type PluginRegistry, type AnnotationScope, type ScrollScope, type ZoomScope, type AnnotationTransferItem, type EmbedPdfContainer } from '@embedpdf/react-pdf-viewer';
import type { Paper } from '../shared/types';
import type { ReaderDocument, ReaderJson, ReaderState } from '../shared/reader';
import { packReaderValue, unpackReaderValue } from './reader-transfer';
import { bindReaderWheelZoom, READER_MIN_ZOOM, READER_MAX_ZOOM, READER_ZOOM_STEP } from './reader-zoom';
import { installReaderAiSidebar, type ReaderAiSidebar } from './reader-ai-sidebar';
import ReaderChat from './ReaderChat';
import './PdfReader.css';

export interface PdfReaderHandle { flush(): Promise<void> }
interface Session {
  state: ReaderState; ann?: AnnotationScope; scroll?: ScrollScope; zoom?: ZoomScope;
  seq: number; saved: number; annotationSeq: number; annotationSaved: number; ready: boolean;
  queue: Promise<void>; timer?: ReturnType<typeof setTimeout>;
}
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export default forwardRef<PdfReaderHandle, { paper: Paper; onManageTags: () => void; onEditBriefNote: () => void }>(function PdfReader({ paper, onManageTags, onEditBriefNote }, ref) {
  const [document, setDocument] = useState<ReaderDocument | null>(null);
  const [status, setStatus] = useState('正在打开 PDF…');
  const [error, setError] = useState('');
  const [directoryError, setDirectoryError] = useState('');
  const [openingDirectory, setOpeningDirectory] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const session = useRef<Session | null>(null);
  const disposers = useRef<(() => void)[]>([]);
  const mounted = useRef(true);
  const initialize = useRef<Promise<void> | null>(null);
  const viewerElement = useRef<HTMLDivElement>(null);
  const viewerContainer = useRef<EmbedPdfContainer | null>(null);
  const aiSidebar = useRef<ReaderAiSidebar | null>(null);
  const [aiHost, setAiHost] = useState<HTMLElement | null>(null);

  async function openDirectory() {
    if (openingDirectory) return;
    setOpeningDirectory(true); setDirectoryError('');
    try { await window.paperApi!.openPaperDirectory(paper.id); }
    catch (e) { if (mounted.current) setDirectoryError('无法打开资料文件夹：' + errorText(e)); }
    finally { if (mounted.current) setOpeningDirectory(false); }
  }

  useEffect(() => {
    const element = viewerElement.current;
    if (element) return bindReaderWheelZoom(element, () => session.current?.ready ? session.current.zoom : undefined);
  }, []);

  useEffect(() => {
    mounted.current = true;
    let alive = true;
    window.paperApi!.readerDocument(paper.id).then(doc => {
      if (!alive) return;
      session.current = { state: doc.state, seq: 0, saved: 0, annotationSeq: 0, annotationSaved: 0, ready: false, queue: Promise.resolve() };
      setDocument(doc);
    }).catch(e => { if (alive) { setError(errorText(e)); setStatus('无法打开'); } });
    return () => { alive = false; mounted.current = false; clearTimeout(session.current?.timer); disposers.current.forEach(off => off()); disposers.current = []; };
  }, [paper.id]);

  function flush(): Promise<void> {
    const s = session.current;
    if (!s) return Promise.resolve();
    clearTimeout(s.timer);
    const next = s.queue.catch(() => {}).then(async () => {
      if (!s.ready) return;
      if (mounted.current) setSaving(true);
      try {
        while (s.saved < s.seq) {
          const seq = s.seq, annotationSeq = s.annotationSeq;
          let annotations: ReaderJson[] | undefined;
          if (annotationSeq > s.annotationSaved && s.ann) {
            await s.ann.commit().toPromise();
            annotations = packReaderValue(await s.ann.exportAnnotations().toPromise()) as ReaderJson[];
          }
          const position = { page: Math.max(1, s.scroll?.getCurrentPage() ?? s.state.position.page),
            zoom: s.zoom?.getState().currentZoomLevel ?? s.state.position.zoom };
          s.state = await window.paperApi!.saveReaderState(paper.id, { pdfHash: s.state.pdfHash, revision: s.state.revision, position,
            ...(annotations === undefined ? {} : { annotations }) });
          s.saved = seq; s.annotationSaved = annotationSeq;
        }
        if (mounted.current) { setStatus('已自动保存'); setError(''); }
      } catch (e) {
        if (mounted.current) { setError('保存失败：' + errorText(e)); setStatus('尚未保存'); }
        throw e;
      } finally { if (mounted.current) setSaving(false); }
    });
    s.queue = next; return next;
  }
  useImperativeHandle(ref, () => ({ flush }));
  function changed(annotations = false) {
    const s = session.current;
    if (!s?.ready) return;
    s.seq++; if (annotations) s.annotationSeq++;
    setStatus('正在保存…');
    clearTimeout(s.timer); s.timer = setTimeout(() => { void flush().catch(() => {}); }, annotations ? 180 : 500);
  }

  async function onReady(registry: PluginRegistry) {
    const current = session.current;
    if (!current || !document || !mounted.current) return;
    const s: Session = current;
    if (viewerContainer.current) {
      aiSidebar.current = installReaderAiSidebar(registry, viewerContainer.current, paper.id, host => {
        if (mounted.current) setAiHost(host);
      });
      disposers.current.push(() => { aiSidebar.current?.dispose(); aiSidebar.current = null; });
    }
    const ann = registry.getPlugin<AnnotationPlugin>('annotation')!.provides();
    const dm = registry.getPlugin<DocumentManagerPlugin>('document-manager')!.provides();
    const scroll = registry.getPlugin<ScrollPlugin>('scroll')!.provides();
    const zoom = registry.getPlugin<ZoomPlugin>('zoom')!.provides();
    let restored = false, layoutReady = false;
    function restorePosition() {
      if (!restored || !layoutReady || !mounted.current || s.ready) return;
      s.zoom!.requestZoom(s.state.position.zoom);
      s.scroll!.scrollToPage({ pageNumber: Math.min(s.state.position.page, s.scroll!.getTotalPages()), behavior: 'instant' });
      requestAnimationFrame(() => requestAnimationFrame(() => { if (mounted.current) { s.ready = true; setReady(true); setStatus('标注自动保存到文献库'); } }));
    }
    disposers.current.push(scroll.onLayoutReady(e => { if (e.documentId === paper.id) { layoutReady = true; restorePosition(); } }));
    disposers.current.push(ann.onAnnotationEvent(e => {
      if (e.documentId !== paper.id) return;
      if (e.type === 'loaded' && !restored) {
        initialize.current = (async () => {
          s.ann = ann.forDocument(paper.id); s.scroll = scroll.forDocument(paper.id); s.zoom = zoom.forDocument(paper.id);
          if (s.state.annotations !== null) {
            s.ann.deleteAllAnnotations(); await s.ann.commit().toPromise();
            s.ann.importAnnotations(unpackReaderValue(s.state.annotations) as AnnotationTransferItem[]);
            await s.ann.commit().toPromise();
            registry.getPlugin<HistoryPlugin>('history')?.provides().forDocument(paper.id).purgeByMetadata(() => true);
          }
          restored = true; restorePosition();
        })();
        void initialize.current.catch(e => { if (mounted.current) setError('无法恢复标注：' + errorText(e)); });
      } else if (e.type !== 'loaded' && !e.committed) changed(true);
    }));
    disposers.current.push(scroll.onPageChange(e => { if (e.documentId === paper.id) changed(); }));
    disposers.current.push(zoom.onZoomChange(e => { if (e.documentId === paper.id) changed(); }));
    disposers.current.push(dm.onDocumentError(e => { if (e.documentId === paper.id && mounted.current) { setError(e.message); setStatus('PDF 未打开'); } }));
    try {
      const response = await dm.openDocumentBuffer({ documentId: paper.id, name: paper.title + '.pdf', buffer: document.data.slice().buffer }).toPromise();
      await response.task.toPromise();
    } catch (e) { if (mounted.current) { setError('无法打开 PDF：' + errorText(e)); setStatus('PDF 未打开'); } }
  }
  const config = useMemo<PDFViewerConfig>(() => ({
    wasmUrl: 'paper-reader://assets/pdfium.wasm', worker: true, tabBar: 'never',
    stamp: { manifests: [], libraries: [], defaultLibrary: false },
    fonts: { ui: null, signature: null },
    fontFallback: { fonts: { 134: 'paper-reader://assets/NotoSansHans-Regular.otf', 136: 'paper-reader://assets/NotoSansHans-Regular.otf' }, defaultFont: 'paper-reader://assets/NotoSansHans-Regular.otf' },
    theme: { preference: 'light' }, i18n: { defaultLocale: 'zh-CN' },
    // EmbedPDF 2.15 initializes its viewport gate through an automatic zoom mode.
    // Restore the saved numeric zoom once that initial layout is available.
    zoom: { defaultZoomLevel: ZoomMode.FitPage, minZoom: READER_MIN_ZOOM, maxZoom: READER_MAX_ZOOM,
      zoomStep: READER_ZOOM_STEP, zoomRanges: [] },
    annotations: { autoCommit: false, autoOpenLinks: false, annotationAuthor: 'Paper Timeline',
      colorPresets: ['#FFE066', '#A9E5B1', '#A9D8FF', '#F7B3CF', '#D0BFFF'] },
    disabledCategories: ['document-open', 'document-close', 'document-export', 'document-print', 'document-protect', 'form', 'redaction', 'insert',
      'annotation-stamp', 'annotation-signature', 'annotation-strikeout', 'annotation-squiggly', 'annotation-ink', 'annotation-shape', 'document-capture'],
  }), [document]);
  const readyCallback = useMemo(() => (registry: PluginRegistry) => void onReady(registry), [document, paper.id]);

  return <main className="pdf-reader" aria-label="PDF 阅读器">
    <div className="reader-heading"><div><strong title={paper.title}>{paper.title}</strong><span>选中文字可高亮或添加下划线，标注随文献库保存。</span></div>
      <div className="reader-paper-tools"><button className="secondary-button" aria-label="管理论文标签" onClick={onManageTags}><Tags size={15} />标签{paper.tags?.length ? ` · ${paper.tags.length}` : ''}</button>
        <button className="secondary-button" onClick={onEditBriefNote} title={paper.briefNote || '用一两句话评价这篇论文'}><StickyNote size={15} />精简笔记{paper.briefNote && <i className="reader-note-present" aria-label="已添加" />}</button>
        <button className="secondary-button" onClick={() => void openDirectory()} disabled={openingDirectory} title="打开当前论文的资料文件夹"><FolderOpen size={15} />打开资料文件夹</button>
        <button className="secondary-button" onClick={() => window.paperApi!.openPdf(paper.id).catch(e => setError(errorText(e)))}><ArrowUpRight size={15} />默认软件打开</button></div></div>
    {directoryError && <div className="reader-error" role="alert"><CircleAlert size={16} /><span>{directoryError}</span>
      <button className="text-button" onClick={() => void openDirectory()} disabled={openingDirectory}>重试打开文件夹</button>
      <button className="icon-button" aria-label="关闭文件夹错误提示" onClick={() => setDirectoryError('')}><X size={14} /></button></div>}
    {error && <div className="reader-error" role="alert"><CircleAlert size={16} /><span>{error}</span>
      {ready && <button className="text-button" onClick={() => void flush().catch(() => {})}><RotateCw size={14} />重试保存</button>}</div>}
    <div className="reader-viewer" ref={viewerElement}>{document && <PDFViewer config={config} onInit={container => { viewerContainer.current = container; }} onReady={readyCallback} />}
      {!ready && <div className="reader-loading reader-opening">{!error && <LoaderCircle className="spin" size={22} />}<span>{error ? '请检查 PDF 或使用默认软件打开' : '正在加载阅读器…'}</span></div>}</div>
    {aiHost && createPortal(<ReaderChat paper={paper} onClose={() => aiSidebar.current?.close()} />, aiHost)}
    <footer className={`reader-status ${error ? 'has-error' : ''}`} role="status">{saving ? <LoaderCircle size={13} className="spin" /> : error ? <CircleAlert size={13} /> : <Check size={13} />}<span>{status}</span></footer>
  </main>;
});
