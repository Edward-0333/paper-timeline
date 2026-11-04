import { useEffect, useRef, useState } from 'react';
import { Copy, FolderOpen, LoaderCircle, Plus, X } from 'lucide-react';
import type { StorageAction, StorageSelection } from '../shared/types';
import './LibrarySettings.css';

const actions = [
  { mode: 'open', title: '选择已有文献库', help: '换电脑后，选择已复制过来的 library 文件夹。', icon: FolderOpen },
  { mode: 'copy', title: '复制当前文献库到新位置', help: '复制全部论文、笔记、标签和时间线，随后改用新位置；原文件保留。', icon: Copy },
  { mode: 'create', title: '新建空白文献库', help: '选择空文件夹，开始一个独立的文献库。', icon: Plus },
] as const;

export default function LibrarySettings({ path, count, processing, onClose, onBeforeApply }: { path: string; count: number; processing: boolean; onClose: () => void; onBeforeApply?: () => Promise<void> }) {
  const modal = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<StorageSelection | null>(null);
  const [working, setWorking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    modal.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => previous?.focus();
  }, []);
  async function choose(mode: StorageAction) {
    setWorking(true); setError('');
    try {
      const next = await window.paperApi!.chooseLibraryLocation(mode);
      if (next) setSelection(next);
    } catch (err) { setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(err)); }
    finally { setWorking(false); }
  }
  async function apply() {
    if (!selection) return;
    setWorking(true); setError('');
    try { await onBeforeApply?.(); await window.paperApi!.applyLibraryLocation(selection.mode, selection.directory); setRestarting(true); }
    catch (err) { setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(err)); setWorking(false); }
  }
  return <div className="modal-backdrop" onDragEnter={event => event.stopPropagation()} onDrop={event => { event.preventDefault(); event.stopPropagation(); }}>
    <div ref={modal} className="edit-modal library-settings" role="dialog" aria-modal="true" aria-labelledby="library-settings-title"
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape' && !working) onClose();
        if (event.key !== 'Tab') return;
        const fields = [...modal.current!.querySelectorAll<HTMLElement>('button:not(:disabled), textarea')];
        if (!fields.length) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1)?.focus(); }
        if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0].focus(); }
      }}>
      <div className="modal-heading"><h2 id="library-settings-title">文献库设置</h2><button className="icon-button" aria-label="关闭文献库设置" disabled={working} onClick={onClose}><X size={19} /></button></div>
      <div className="modal-fields">
        <div className="storage-heading"><label htmlFor="current-library-path">当前文献库位置</label><span>{count} 篇论文</span></div>
        <textarea id="current-library-path" readOnly rows={2} value={path} spellCheck={false} />
        <button className="secondary-button" disabled={working} onClick={async () => {
          try { await window.paperApi!.revealLibrary(); } catch (err) { setError(String(err)); }
        }}><FolderOpen size={15} />打开文件夹</button>
        <p className="storage-transfer-help">换电脑时，请复制整个文献库文件夹，包含 library.json、pdfs、notes、annotations、citations 和 sync。然后在新电脑上选择它，即可继续使用论文、笔记、阅读标注、标签和时间线。</p>
        <div className="storage-options">
          {actions.map(({ mode, title, help, icon: Icon }) => <button key={mode} className="storage-option" disabled={working || processing} aria-pressed={selection?.mode === mode} onClick={() => choose(mode)}>
            <Icon size={19} /><span><strong>{title}</strong><small>{help}</small></span>
          </button>)}
        </div>
        {processing && <p className="storage-note" role="status">论文处理完成后，即可更改文献库位置。</p>}
        {selection && <div className="storage-selection" role="status">
          <strong>{selection.mode === 'open' ? `将使用此文献库（${selection.paperCount} 篇论文）` : selection.mode === 'copy' ? `将复制当前文献库（${count} 篇论文）到` : '将在此位置新建空白文献库'}</strong>
          <p>{selection.directory}</p><small>应用后软件会自动重启，并记住此位置。</small>
        </div>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <div className="modal-footer"><button className="secondary-button" disabled={working} onClick={onClose}>关闭</button>
        <button className="primary-button" disabled={!selection || working || processing} onClick={apply}>
          {working && <LoaderCircle size={15} className="spin" />}{restarting ? '正在重启…' : working ? '正在处理…' : '应用并重启'}
        </button>
      </div>
    </div>
  </div>;
}
