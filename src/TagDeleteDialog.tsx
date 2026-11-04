import { useLayoutEffect, useRef, useState } from 'react';
import { LoaderCircle, Trash2, X } from 'lucide-react';
import './TagDeleteDialog.css';

export default function TagDeleteDialog({ tagText, paperTitle, onDelete, onClose }: {
  tagText: string; paperTitle: string; onDelete: () => Promise<unknown>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal(); cancel.current?.focus();
    return () => { element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const close = () => { if (!pending.current) onClose(); };
  async function confirm() {
    if (pending.current) return;
    pending.current = true; setSaving(true); setError('');
    try { await onDelete(); onClose(); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      requestAnimationFrame(() => cancel.current?.focus());
    } finally { pending.current = false; setSaving(false); }
  }
  return <dialog ref={dialog} className="edit-modal tag-delete-dialog" aria-labelledby="tag-delete-title" aria-describedby="tag-delete-description"
    onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => event.stopPropagation()}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}>
    <div className="modal-heading"><h2 id="tag-delete-title">是否确定删除标签？</h2>
      <button className="icon-button" aria-label="关闭删除标签确认" disabled={saving} onClick={close}><X size={18} /></button></div>
    <div className="modal-fields"><p className="tag-delete-name">{tagText}</p><p className="tag-delete-paper" title={paperTitle}>{paperTitle}</p>
      <p id="tag-delete-description">仅从这篇论文移除该标签，其他论文的同名标签会保留。</p>
      {error && <p className="form-error" role="alert">删除失败：{error}</p>}
    </div>
    <div className="modal-footer"><button ref={cancel} className="secondary-button" disabled={saving} onClick={close}>取消</button>
      <button className="primary-button danger-button" disabled={saving} onClick={() => void confirm()}>
        {saving ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}{saving ? '删除中…' : '确认删除'}
      </button></div>
  </dialog>;
}
