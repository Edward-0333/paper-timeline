import { useEffect, useRef, useState } from 'react';
import { BookOpen, Folder, FolderOpen, Inbox, MoreHorizontal, PencilLine, Plus, Trash2, X } from 'lucide-react';
import type { LibraryFolder, Paper } from '../shared/types';

export type FolderAction = { mode: 'create' } | { mode: 'rename' | 'delete'; folder: LibraryFolder };
interface Props { folders: LibraryFolder[]; papers: Paper[]; active: string; ready: boolean; onSelect: (id: string) => void; onAction: (action: FolderAction) => void }

export default function FolderSidebar({ folders, papers, active, ready, onSelect, onAction }: Props) {
  const [menu, setMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { menuRef.current?.querySelector<HTMLButtonElement>('.folder-more')?.focus(); setMenu(null); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [menu]);
  const pick = (id: string) => { setMenu(null); onSelect(id); };
  const counts = new Map<string, number>();
  for (const paper of papers) counts.set(paper.folderId || 'unfiled', (counts.get(paper.folderId || 'unfiled') || 0) + 1);
  return <nav className="folder-sidebar" aria-label="文献文件夹">
    <div className="folder-library-label">我的文献库</div>
    <button className={`folder-item ${active === 'all' ? 'selected' : ''}`} aria-current={active === 'all' ? 'page' : undefined} onClick={() => pick('all')}><BookOpen size={16} /><span>全部文献</span><small>{papers.length}</small></button>
    <button className={`folder-item ${active === 'unfiled' ? 'selected' : ''}`} aria-current={active === 'unfiled' ? 'page' : undefined} onClick={() => pick('unfiled')}><Inbox size={16} /><span>未分类</span><small>{counts.get('unfiled') || 0}</small></button>
    <div className="folder-section-heading"><span>文件夹</span><button className="icon-button" aria-label="新建文件夹" title="新建文件夹" disabled={!ready} onClick={() => onAction({ mode: 'create' })}><Plus size={15} /></button></div>
    <div className="custom-folders">{folders.length ? folders.map(folder => <div key={folder.id} className={`folder-row ${active === folder.id ? 'selected' : ''}`}>
      <button className="folder-item" aria-current={active === folder.id ? 'page' : undefined} title={folder.name} onClick={() => pick(folder.id)}>
        {active === folder.id ? <FolderOpen size={16} /> : <Folder size={16} />}<span>{folder.name}</span><small>{counts.get(folder.id) || 0}</small>
      </button>
      <div className="folder-menu" ref={menu === folder.id ? menuRef : undefined}>
        <button className="icon-button folder-more" aria-label={`${folder.name}的文件夹操作`} title="文件夹操作" aria-expanded={menu === folder.id} onClick={() => setMenu(menu === folder.id ? null : folder.id)}><MoreHorizontal size={16} /></button>
        {menu === folder.id && <div className="menu-items"><button onClick={() => { setMenu(null); onAction({ mode: 'rename', folder }); }}><PencilLine size={14} />重命名</button><button onClick={() => { setMenu(null); onAction({ mode: 'delete', folder }); }}><Trash2 size={14} />删除文件夹</button></div>}
      </div>
    </div>) : <p className="folder-empty">点击 + 创建文件夹，<br />按主题整理你的论文。</p>}</div>
  </nav>;
}

export function FolderDialog({ action, onClose, onSave }: { action: FolderAction; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(action.mode === 'create' ? '' : action.folder.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const heading = action.mode === 'create' ? '新建文件夹' : action.mode === 'rename' ? '重命名文件夹' : '删除文件夹';
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) { event.preventDefault(); onClose(); } };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [saving, onClose]);
  useEffect(() => { if (error && !saving) form.current?.querySelector<HTMLInputElement>('input')?.focus(); }, [error, saving]);
  return <div className="modal-backdrop"><form ref={form} className="edit-modal folder-dialog" role="dialog" aria-modal="true" aria-labelledby="folder-dialog-title"
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const fields = [...form.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
      if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1)!.focus(); }
      if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0].focus(); }
    }}
    onSubmit={async event => {
      event.preventDefault(); setSaving(true); setError('');
      try { await onSave(name); onClose(); }
      catch (error) { setError(error instanceof Error ? error.message : String(error)); }
      finally { setSaving(false); }
    }}>
    <div className="modal-heading"><h2 id="folder-dialog-title">{heading}</h2><button type="button" className="icon-button" aria-label="关闭文件夹编辑" disabled={saving} onClick={onClose}><X size={18} /></button></div>
    <div className="modal-fields">{action.mode === 'delete' ? <p className="folder-delete-message">删除“{action.folder.name}”后，其中的论文会移到“未分类”。论文和 PDF 文件会保留。</p>
      : <><label htmlFor="folder-name">文件夹名称</label><input id="folder-name" autoFocus required maxLength={80} disabled={saving} placeholder="例如：世界模型" value={name} onChange={event => setName(event.target.value)} /></>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <div className="modal-footer"><button type="button" className="secondary-button" autoFocus={action.mode === 'delete'} disabled={saving} onClick={onClose}>取消</button><button className={action.mode === 'delete' ? 'primary-button danger-button' : 'primary-button'} disabled={saving} type="submit">{saving ? '保存中…' : action.mode === 'delete' ? '删除文件夹' : '保存文件夹'}</button></div>
  </form></div>;
}
