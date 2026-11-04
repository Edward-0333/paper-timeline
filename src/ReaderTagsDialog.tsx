import { useLayoutEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { Paper } from '../shared/types';
import PaperTags from './PaperTags';

export default function ReaderTagsDialog({ paper, onEdit, onDelete, onClose }: {
  paper: Paper; onEdit: (tagId?: string) => void; onDelete: (tagId: string) => Promise<unknown>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!, previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="edit-modal reader-tags-dialog" aria-labelledby="reader-tags-title" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}
    onDrop={event => { event.preventDefault(); event.stopPropagation(); }}>
    <div className="modal-heading"><h2 id="reader-tags-title">论文标签</h2><button className="icon-button" aria-label="关闭论文标签" onClick={onClose}><X size={18} /></button></div>
    <div className="modal-fields"><p className="brief-note-paper">{paper.title}</p><PaperTags tags={paper.tags ?? []} onEdit={onEdit} onDelete={onDelete} /></div>
    <div className="modal-footer"><button className="secondary-button" onClick={onClose}>关闭</button></div>
  </dialog>;
}
