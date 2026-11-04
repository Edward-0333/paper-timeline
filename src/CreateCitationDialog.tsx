import { useRef, useState } from 'react';
import { LoaderCircle, Plus, X } from 'lucide-react';
import type { CitationInput } from '../shared/types';

export default function CreateCitationDialog({ onClose, onSave }: { onClose: () => void; onSave: (fields: CitationInput) => Promise<void> }) {
  const [title, setTitle] = useState(''), [doi, setDoi] = useState(''), [arxivId, setArxivId] = useState('');
  const [authors, setAuthors] = useState(''), [publicationDate, setDate] = useState(''), [venue, setVenue] = useState('');
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  return <div className="modal-backdrop"><form ref={form} className="edit-modal" role="dialog" aria-modal="true" aria-labelledby="create-citation-title"
    onKeyDown={event => {
      if (event.key === 'Escape' && !saving) onClose();
      if (event.key !== 'Tab') return;
      const elements = [...form.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea')];
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }} onSubmit={async event => {
      event.preventDefault(); setSaving(true); setError('');
      try { await onSave({ title, doi, arxivId, authors: authors.split('\n').map(a => a.trim()).filter(Boolean), publicationDate, venue }); }
      catch (err) { setError(err instanceof Error ? err.message : String(err)); }
      finally { setSaving(false); }
    }}>
    <div className="modal-heading"><h2 id="create-citation-title">添加文献</h2><button type="button" className="icon-button" aria-label="关闭添加文献" disabled={saving} onClick={onClose}><X size={19} /></button></div>
    <div className="modal-fields">
      <p className="field-help">填写标题即可添加，无需 PDF。保存后自动检索元数据，原文和笔记可以稍后补充。</p>
      <label htmlFor="citation-title">标题</label><textarea id="citation-title" required autoFocus maxLength={2000} rows={2} value={title} onChange={e => setTitle(e.target.value)} />
      <div className="form-row"><div><label htmlFor="citation-doi">DOI（选填）</label><input id="citation-doi" value={doi} onChange={e => setDoi(e.target.value)} /></div><div><label htmlFor="citation-arxiv">arXiv 编号（选填）</label><input id="citation-arxiv" placeholder="例如 2501.12345" value={arxivId} onChange={e => setArxivId(e.target.value)} /></div></div>
      <label htmlFor="citation-authors">作者（选填，每行一位）</label><textarea id="citation-authors" rows={2} value={authors} onChange={e => setAuthors(e.target.value)} />
      <div className="form-row"><div><label htmlFor="citation-date">发表日期（选填）</label><input id="citation-date" maxLength={10} placeholder="年份、年-月或年-月-日" value={publicationDate} onChange={e => setDate(e.target.value)} /></div><div><label htmlFor="citation-venue">期刊 / 会议（选填）</label><input id="citation-venue" value={venue} onChange={e => setVenue(e.target.value)} /></div></div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <div className="modal-footer"><button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}添加并检索</button></div>
  </form></div>;
}
