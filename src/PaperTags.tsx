import { useRef, useState } from 'react';
import { LoaderCircle, Plus, X } from 'lucide-react';
import type { PaperTag } from '../shared/types';
import { tagTextColor } from './TagDialog';

export default function PaperTags({ tags, onEdit, onDelete }: {
  tags: PaperTag[];
  onEdit: (tagId?: string) => void;
  onDelete: (tagId: string) => Promise<unknown>;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const addButton = useRef<HTMLButtonElement>(null);

  async function remove(tagId: string) {
    if (pending.current) return;
    pending.current = true; setDeleting(tagId); setError('');
    try { await onDelete(tagId); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { pending.current = false; setDeleting(null); }
    // Return keyboard focus to a stable control after removing its tag button.
    requestAnimationFrame(() => addButton.current?.focus({ preventScroll: true }));
  }

  return <section className="detail-tags" aria-label="论文标签">
    <div className="detail-tags-heading"><h3>标签 <span>{tags.length}</span></h3>
      <button ref={addButton} className="text-button" disabled={!!deleting || tags.length >= 32} onClick={() => onEdit()}
        title={tags.length >= 32 ? '每篇论文最多添加 32 个标签' : '为这篇论文添加彩色标签'}><Plus size={14} />添加标签</button>
    </div>
    {tags.length ? <ul className="detail-tag-list">{tags.map(tag => <li key={tag.id} className="detail-tag"
      style={{ backgroundColor: tag.color, color: tagTextColor(tag.color) }}>
      <button className="detail-tag-edit" disabled={!!deleting} aria-label={`编辑标签：${tag.text}`} title={`编辑文字和颜色：${tag.text}`} onClick={() => onEdit(tag.id)}>{tag.text}</button>
      <button className="detail-tag-remove" disabled={!!deleting} aria-label={`删除标签：${tag.text}`} title={`从这篇论文移除标签：${tag.text}`} onClick={() => void remove(tag.id)}>
        {deleting === tag.id ? <LoaderCircle size={12} className="spin" /> : <X size={12} />}
      </button>
    </li>)}</ul> : <p className="detail-tags-empty">暂无标签，添加后可用于时间线筛选。</p>}
    {tags.length > 0 && <p className="detail-tags-help">点击标签可编辑文字和颜色</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
