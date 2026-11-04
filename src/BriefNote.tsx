import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Check, LoaderCircle, PencilLine, Plus, StickyNote, X } from 'lucide-react';
import type { Paper } from '../shared/types';
import { MAX_BRIEF_NOTE_LENGTH } from '../shared/brief-note';
import './BriefNote.css';

export default function BriefNote({ paper, onEdit }: { paper: Paper; onEdit: () => void }) {
  return <section className="brief-note-section" aria-label="精简笔记">
    <div className="brief-note-heading"><h3><StickyNote size={15} />精简笔记</h3><button className="text-button" onClick={onEdit}>
      {paper.briefNote ? <PencilLine size={13} /> : <Plus size={13} />}{paper.briefNote ? '编辑精简笔记' : '添加精简笔记'}</button></div>
    {paper.briefNote ? <p className="brief-note-text">{paper.briefNote}</p> : <p className="brief-note-empty">用一两句话记下你对这篇论文的评价。</p>}
  </section>;
}

export function BriefNoteDialog({ paper, onSave, onClose }: { paper: Paper; onSave: (text: string) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(false);
  const [text, setText] = useState(paper.briefNote ?? '');
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  useLayoutEffect(() => {
    const element = dialog.current!, previous = document.activeElement as HTMLElement | null;
    element.showModal(); input.current?.focus();
    return () => { element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const close = () => { if (!pending.current) onClose(); };
  async function save(event: FormEvent) {
    event.preventDefault(); if (pending.current) return;
    pending.current = true; setSaving(true); setError('');
    try { await onSave(text); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setSaving(false); }
  }
  return <dialog ref={dialog} className="edit-modal brief-note-dialog" aria-labelledby="brief-note-title"
    onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); dialog.current?.querySelector('form')?.requestSubmit(); }
    }} onDrop={event => { event.preventDefault(); event.stopPropagation(); }}>
    <form onSubmit={save}>
      <div className="modal-heading"><h2 id="brief-note-title">精简笔记</h2><button className="icon-button" type="button" aria-label="关闭精简笔记" disabled={saving} onClick={close}><X size={18} /></button></div>
      <div className="modal-fields"><p className="brief-note-paper" title={paper.title}>{paper.title}</p>
        <label htmlFor="brief-note-text">用最少的话评价这篇论文</label><textarea ref={input} id="brief-note-text" rows={5} maxLength={MAX_BRIEF_NOTE_LENGTH} value={text} disabled={saving} onChange={event => setText(event.target.value)} placeholder="例如：方法简单有效，值得借鉴实验设计。" />
        <p className="brief-note-help"><span>留空保存可清除 · Ctrl+S 保存</span><span>{text.length} / {MAX_BRIEF_NOTE_LENGTH}</span></p>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <div className="modal-footer"><button className="secondary-button" type="button" disabled={saving} onClick={close}>取消</button>
        <button className="primary-button" type="submit" disabled={saving}>{saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{saving ? '保存中…' : '保存精简笔记'}</button></div>
    </form>
  </dialog>;
}
