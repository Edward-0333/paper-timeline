import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ArrowUpRight, BookOpen, Check, CircleAlert, Code2, FileText, LoaderCircle, Pencil, RotateCw, Save } from 'lucide-react';
import type Vditor from 'vditor';
import type { Paper } from '../shared/types';
import type { MarkdownDocument } from '../shared/notes-editor';
import NoteMarkdown from './NoteMarkdown';
import './MarkdownNote.css';

export interface MarkdownNoteHandle { flush(): Promise<void> }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const assets = new Map<string, Promise<void>>();
function loadEditorAsset(url: string, id: string): Promise<void> {
  const existing = assets.get(id); if (existing) return existing;
  const task = new Promise<void>((resolve, reject) => {
    const script = window.document.createElement('script');
    script.id = id; script.src = url; script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { script.remove(); reject(new Error('无法加载本地编辑器资源')); };
    window.document.head.appendChild(script);
  }).catch(error => { assets.delete(id); throw error; });
  assets.set(id, task); return task;
}

/** Vditor edits Markdown source; the adjacent preview uses the same restricted renderer as reading mode. */
function SourceEditor({ initialValue, onChange, onReady }: {
  initialValue: string; onChange(value: string): void; onReady(editor: Vditor | null): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const changed = useRef(onChange); changed.current = onChange;
  const ready = useRef(onReady); ready.current = onReady;
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true, editor: Vditor | null = null, initialized = false;
    setError('');
    void (async () => {
      const cdn = new URL('./vendor/vditor', window.document.baseURI).href.replace(/\/$/, '');
      const [{ default: VditorConstructor }] = await Promise.all([import('vditor'), import('vditor/dist/index.css'),
        loadEditorAsset(`${cdn}/dist/js/i18n/zh_CN.js`, 'vditorI18nScriptzh_CN'),
        loadEditorAsset(`${cdn}/dist/js/lute/lute.min.js`, 'vditorLuteScript'),
        // Vditor's own icon loader uses inline script text; load the packaged script by src instead.
        loadEditorAsset(`${cdn}/dist/js/icons/ant.js`, 'paperNoteVditorIcons'),
      ]);
      if (!alive || !host.current) return;
      editor = new VditorConstructor(host.current, {
        cdn, icon: undefined,
        lang: 'zh_CN', mode: 'sv', value: initialValue, height: '100%', width: '100%',
        cache: { enable: false },
        counter: { enable: false },
        outline: { enable: false, position: 'left' },
        // No Vditor HTML preview, image loading, uploads, export, external themes, or mode switch.
        preview: { mode: 'editor', actions: [], theme: { current: '', path: '', list: {} }, markdown: { autoSpace: false, fixTermTypo: false } },
        hint: { emoji: {} },
        toolbar: ['headings', 'bold', 'italic', 'strike', '|', 'list', 'ordered-list', 'check', 'quote', 'line',
          'code', 'inline-code', 'table', '|', 'undo', 'redo'],
        toolbarConfig: { pin: false },
        input(value) { if (initialized && alive) changed.current(editor?.vditor.sv?.element.value ?? value); },
        after() {
          if (!alive || !editor) return;
          initialized = true;
          editor.vditor.sv?.element.setAttribute('aria-label', 'Markdown 笔记源码');
          editor.vditor.sv?.element.setAttribute('role', 'textbox');
          editor.vditor.sv?.element.setAttribute('aria-multiline', 'true');
          ready.current(editor);
        },
      });
    })().catch(error => { if (alive) setError('编辑器加载失败：' + errorText(error)); });
    return () => {
      alive = false; initialized = false; ready.current(null);
      try { editor?.destroy(); } catch { /* An interrupted initialization has no editor state to release. */ }
    };
  }, [attempt]);
  return <div className="note-source-editor" onInputCapture={event => {
    if (event.target instanceof HTMLTextAreaElement) changed.current(event.target.value);
  }} onClickCapture={event => {
    // The source editor must never navigate the application to a pasted link.
    if ((event.target as HTMLElement).closest('a')) event.preventDefault();
  }} onDropCapture={event => { event.preventDefault(); event.stopPropagation(); }} onPasteCapture={event => {
    const target = event.target;
    if (target instanceof HTMLTextAreaElement) {
      // Paste plain text directly. Never create a DOM from clipboard HTML or upload clipboard images.
      event.preventDefault(); event.stopPropagation();
      const text = event.clipboardData.getData('text/plain');
      if (text) {
        target.setRangeText(text, target.selectionStart, target.selectionEnd, 'end');
        target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
      }
    }
  }}>
    <div ref={host} className="note-vditor-host" />
    {error && <div className="note-editor-error" role="alert"><CircleAlert size={16} /><span>{error}</span><button className="text-button" onClick={() => setAttempt(value => value + 1)}>重新加载编辑器</button></div>}
  </div>;
}

function ReloadConfirmation({ onClose, onConfirm }: { onClose(): void; onConfirm(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = window.document.activeElement;
    dialog.current?.showModal(); cancel.current?.focus();
    return () => { dialog.current?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="edit-modal note-reload-dialog" aria-labelledby="note-reload-title" aria-describedby="note-reload-description"
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <div className="modal-heading"><h2 id="note-reload-title">重新读取笔记？</h2></div>
    <div className="modal-fields"><p id="note-reload-description">当前有未保存的修改。重新读取会放弃当前草稿，并加载文献库中的文件。请先复制需要保留的内容。</p></div>
    <div className="modal-footer"><button className="secondary-button" ref={cancel} onClick={onClose}>取消</button><button className="primary-button" onClick={onConfirm}>放弃草稿并重新读取</button></div>
  </dialog>;
}

export default forwardRef<MarkdownNoteHandle, { paper: Paper }>(function MarkdownNote({ paper }, ref) {
  const [document, setDocument] = useState<MarkdownDocument | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [status, setStatus] = useState('正在读取笔记…');
  const [editorGeneration, setEditorGeneration] = useState(0);
  const session = useRef<{ document: MarkdownDocument; draft: string } | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const editor = useRef<Vditor | null>(null);
  const editorEdited = useRef(false);
  const reloadTask = useRef<Promise<void> | null>(null);

  useEffect(() => {
    mounted.current = true;
    let alive = true;
    setLoading(true); setError('');
    void window.paperApi!.getMarkdownDocument(paper.id).then(next => {
      if (!alive) return;
      session.current = { document: next, draft: next.content };
      setDocument(next); setDraft(next.content); setStatus('已从文献库读取');
    }).catch(error => { if (alive) { setError(errorText(error)); setStatus('无法打开笔记'); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; mounted.current = false; };
  }, [paper.id]);

  function change(value: string) {
    const current = session.current; if (!current) return;
    editorEdited.current = true;
    current.draft = value; setDraft(value);
    setStatus(value === current.document.content ? '已保存' : '有未保存修改');
  }
  function captureDraft() {
    const source = editor.current?.vditor.sv?.element;
    const current = session.current;
    // Untouched textarea normalization (e.g. CRLF) must not rewrite the original note.
    if (current && source && editorEdited.current && source.value !== current.draft) change(source.value);
  }
  function flush(): Promise<void> {
    if (reloadTask.current) return reloadTask.current.then(() => flush());
    captureDraft();
    const next = queue.current.catch(() => {}).then(async () => {
      const current = session.current;
      if (!current || current.draft === current.document.content) return;
      if (mounted.current) { setSaving(true); setStatus('正在保存…'); }
      try {
        while (current.draft !== current.document.content) {
          const content = current.draft;
          const saved = await window.paperApi!.saveMarkdownDocument(paper.id, { content, revision: current.document.revision });
          current.document = saved;
          if (mounted.current) setDocument(saved);
        }
        if (mounted.current) { setError(''); setConflict(false); setStatus('已保存到文献库'); }
      } catch (error) {
        if (mounted.current) {
          const message = errorText(error);
          setError('保存失败：' + message); setConflict(message.includes('外部修改')); setStatus('尚未保存，草稿已保留');
        }
        throw error;
      } finally { if (mounted.current) setSaving(false); }
    });
    queue.current = next; return next;
  }
  useImperativeHandle(ref, () => ({ flush }));

  function reload(): Promise<void> {
    if (reloadTask.current) return reloadTask.current;
    if (saving) return queue.current;
    const previous = queue.current;
    setConfirmReload(false); setLoading(true);
    const task = (async () => {
      try {
        await previous.catch(() => {});
        const next = await window.paperApi!.getMarkdownDocument(paper.id);
        if (!mounted.current) return;
        // Navigation may resume before React replaces the old textarea. Never
        // recapture discarded text from that previous editor into the new file.
        editor.current = null;
        editorEdited.current = false;
        session.current = { document: next, draft: next.content };
        setDocument(next); setDraft(next.content); setError(''); setConflict(false);
        setEditorGeneration(value => value + 1); setStatus('已重新读取文件');
      } catch (error) { if (mounted.current) { setError('重新读取失败：' + errorText(error)); setStatus('当前草稿已保留'); } }
      finally { reloadTask.current = null; if (mounted.current) setLoading(false); }
    })();
    reloadTask.current = task; return task;
  }
  const dirty = document !== null && draft !== document.content;
  return <main className="markdown-note-reader" aria-label="Markdown 笔记阅读器" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopPropagation(); void flush().catch(() => {});
    }
  }}>
    <div className="note-reader-heading"><div className="note-reader-title"><FileText size={18} /><div><strong title={paper.title}>{paper.title}</strong><span title={document?.path}>{document?.fileName || 'Markdown 笔记'}</span></div></div>
      <div className="note-reader-actions">
        <div className="note-mode-switch" aria-label="笔记模式"><button className={!editing ? 'active' : ''} disabled={!document || loading} aria-pressed={!editing} onClick={() => { captureDraft(); setEditing(false); }}><BookOpen size={14} />阅读</button><button className={editing ? 'active' : ''} disabled={!document || loading} aria-pressed={editing} onClick={() => setEditing(true)}><Pencil size={14} />编辑</button></div>
        <button className="secondary-button" disabled={!document || saving || loading} onClick={() => dirty ? setConfirmReload(true) : void reload()} title="重新读取文献库中的笔记"><RotateCw size={14} />重新读取</button>
        <button className="secondary-button" disabled={loading || saving} onClick={() => void flush().then(() => window.paperApi!.openMarkdown(paper.id)).catch(error => setError('无法打开笔记：' + errorText(error)))}><ArrowUpRight size={14} />默认软件打开</button>
        <button className="primary-button" disabled={!dirty || saving || loading} onClick={() => void flush().catch(() => {})}>{saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存笔记</button>
      </div>
    </div>
    {error && <div className="note-reader-error" role="alert"><CircleAlert size={16} /><span>{error}</span>{document && !conflict && <button className="text-button" disabled={saving} onClick={() => void flush().catch(() => {})}>重试保存</button>}</div>}
    <div className={`note-reader-workspace ${editing ? 'is-editing' : ''}`}>
      {loading && !document ? <div className="note-loading" role="status"><LoaderCircle className="spin" size={20} />正在读取笔记…</div> : document ? <>
        <section className="note-preview-pane markdown-note-preview" aria-label="笔记预览">{editing && <div className="note-pane-label"><BookOpen size={13} />实时预览</div>}<div className="note-preview-scroll">{draft.trim() ? <NoteMarkdown content={draft} /> : <p className="note-empty">笔记暂无内容，点击「编辑」开始记录。</p>}</div></section>
        {editing && <section className="note-source-pane" aria-label="编辑 Markdown" inert={loading}><div className="note-pane-label"><Code2 size={13} />Markdown 源码<span>Ctrl+S 保存</span></div><SourceEditor key={editorGeneration} initialValue={draft} onChange={change} onReady={value => { editor.current = value; if (value) editorEdited.current = false; }} /></section>}
      </> : <div className="note-loading"><FileText size={26} /><span>无法读取笔记，请检查文件后重新打开。</span><button className="secondary-button" onClick={() => void reload()}>重新读取</button></div>}
      {loading && document && <div className="note-reload-overlay" role="status"><LoaderCircle size={20} className="spin" />正在重新读取笔记…</div>}
    </div>
    <footer className={`note-reader-status ${error ? 'has-error' : ''}`} role="status">{saving ? <LoaderCircle className="spin" size={13} /> : dirty ? <Pencil size={13} /> : <Check size={13} />}<span>{status}</span><span className="note-status-help">图片附件暂不加载 · 修改保存在当前论文资料文件夹</span></footer>
    {confirmReload && <ReloadConfirmation onClose={() => setConfirmReload(false)} onConfirm={() => void reload()} />}
  </main>;
});
