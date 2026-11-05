import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Cloud, LoaderCircle, LogIn, LogOut, RefreshCw, X } from 'lucide-react';
import { cloudConnectionLabel, type CloudStatus } from '../shared/cloud';

export default function CloudConnectionDialog({ cloud, busy, error, onLogin, onSync, onLogout, onMigrate, onClose }: {
  cloud: CloudStatus; busy: boolean; error: string;
  onLogin: (server: string, username: string, password: string) => Promise<boolean>;
  onSync: () => Promise<boolean>; onLogout: () => Promise<boolean>; onMigrate: () => Promise<boolean>; onClose: () => void;
}) {
  const [server, setServer] = useState(cloud.server ?? '');
  const [username, setUsername] = useState(cloud.user?.username ?? '');
  const [password, setPassword] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  useLayoutEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    element.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus();
    return () => { element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  function close() { if (!busy && !pending.current) onClose(); }
  async function perform(fn: () => Promise<boolean>, closeAfter = false) {
    if (busy || pending.current) return;
    pending.current = true;
    try { if (await fn() && closeAfter) onClose(); }
    finally { pending.current = false; }
  }
  function login(event: FormEvent) {
    event.preventDefault();
    if (cloud.signedIn || busy || pending.current) return;
    const secret = password; setPassword('');
    void perform(() => onLogin(server.trim(), username.trim(), secret), true);
  }
  return <dialog ref={dialog} className="edit-modal cloud-settings" aria-labelledby="cloud-settings-title" aria-describedby="cloud-settings-intro"
    onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => event.stopPropagation()}
    onDragEnter={event => event.stopPropagation()} onDrop={event => { event.preventDefault(); event.stopPropagation(); }}>
    <form onSubmit={login}>
      <div className="modal-heading"><h2 id="cloud-settings-title"><Cloud size={19} />连接云端引用监控</h2>
        <button type="button" className="icon-button" aria-label="关闭云端连接" disabled={busy} onClick={close}><X size={19} /></button></div>
      <div className="modal-fields">
        <p id="cloud-settings-intro" className="cloud-settings-intro">Paper Monitoring 每天北京时间 08:00 开始依次检查引用，论文之间默认间隔 10 秒。退出桌面软件后，云端监控继续运行。</p>
        {cloud.signedIn ? <div className="cloud-account">
          <div className="cloud-account-heading"><strong>{cloud.user?.username}</strong><span className={`cloud-connection ${cloud.error ? 'warning' : cloud.connected ? 'online' : ''}`}>{cloudConnectionLabel(cloud)}</span></div>
          <span>{cloud.server}</span>
          <p>退出登录只断开这台电脑的同步，服务器上的监控会继续运行。</p>
        </div> : <div className="cloud-login">
          <label htmlFor="cloud-server">服务器地址</label><input id="cloud-server" type="url" required maxLength={2048} placeholder="https://你的服务器地址" autoComplete="url" spellCheck={false} value={server} onChange={event => setServer(event.target.value)} disabled={busy || !!cloud.server} />
          {cloud.server && <small>此文献库已绑定该服务器；更换账户或服务器请使用另一个文献库。</small>}
          <label htmlFor="cloud-username">用户名 / 邮箱</label><input id="cloud-username" required maxLength={254} autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} disabled={busy} />
          <label htmlFor="cloud-password">密码</label><input id="cloud-password" required type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />
          <small>使用 Paper Monitoring 账户登录。换电脑后重新登录即可，密码不会保存在文献库中。</small>
        </div>}
        {(error || cloud.error) && <p className="form-error" role="alert">{error || cloud.error}</p>}
        {cloud.failure?.title && <p className="cloud-failure-detail">相关论文：{cloud.failure.title}{cloud.failure.field && ` · ${cloud.failure.field}`}</p>}
        {!!cloud.legacyPending && <div className="cloud-migration"><strong>{cloud.legacyPending} 篇旧本地监控待迁移</strong><p>确认后，将这些论文提交到当前账户。历史引用文件继续保留。</p>
          <button type="button" className="secondary-button" disabled={!cloud.signedIn || busy || cloud.syncing} onClick={() => void perform(onMigrate)}>迁移到当前账户</button></div>}
      </div>
      <div className="modal-footer">{cloud.signedIn ? <>
        <button type="button" className="text-button cloud-logout" disabled={busy} onClick={() => void perform(onLogout, true)}><LogOut size={15} />退出登录</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={close}>关闭</button>
        <button type="button" className="primary-button" disabled={busy || cloud.syncing} onClick={() => void perform(onSync)}><RefreshCw size={15} className={busy || cloud.syncing ? 'spin' : ''} />{cloud.syncing ? '同步中…' : '立即同步'}</button>
      </> : <>
        <button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <LogIn size={15} />}{busy ? '正在连接…' : '登录并连接'}</button>
      </>}</div>
    </form>
  </dialog>;
}
