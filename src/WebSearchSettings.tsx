import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ExternalLink, Globe, LoaderCircle, Wifi, X } from 'lucide-react';
import { emptyWebSearchConfiguration, type WebSearchConfiguration, type WebSearchConnectionResult } from '../shared/web-search';
import './WebSearchSettings.css';

const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '搜索配置操作失败，请重试。';

export default function WebSearchSettingsDialog({ onClose, onSaved }: {
  onClose: () => void; onSaved: (config: WebSearchConfiguration) => void;
}) {
  const [config, setConfig] = useState(emptyWebSearchConfiguration), [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState(''), [error, setError] = useState(''), [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false), [testing, setTesting] = useState(false), [confirmClear, setConfirmClear] = useState(false);
  const [result, setResult] = useState<WebSearchConnectionResult | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), keyInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false), testPending = useRef(false), alive = useRef(true);
  const working = saving || testing;
  useLayoutEffect(() => {
    const element = dialog.current!, previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => { element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; if (testPending.current) void window.paperApi!.cancelWebSearchConnectionTest().catch(() => {}); };
  }, []);
  async function load() {
    setLoading(true); setError(''); setLoadError(false);
    try { const value = await window.paperApi!.getWebSearchConfig(); if (alive.current) setConfig(value); }
    catch (reason) { if (alive.current) { setError(message(reason)); setLoadError(true); } }
    finally { if (alive.current) { setLoading(false); requestAnimationFrame(() => keyInput.current?.focus()); } }
  }
  function close() {
    if (saving) return;
    if (testPending.current) void window.paperApi!.cancelWebSearchConnectionTest().catch(() => {});
    setApiKey(''); onClose();
  }
  async function save() {
    if (pending.current || loading || loadError || !keyInput.current?.reportValidity()) return;
    pending.current = true; setSaving(true); setError('');
    try {
      const value = await window.paperApi!.saveWebSearchConfig({ apiKey });
      if (alive.current) { setApiKey(''); onSaved(value); onClose(); }
    } catch (reason) { if (alive.current) setError(message(reason)); }
    finally { pending.current = false; if (alive.current) setSaving(false); }
  }
  async function test() {
    if (pending.current || loading || loadError || !keyInput.current?.reportValidity()) return;
    pending.current = true; testPending.current = true; setTesting(true); setResult(null); setError('');
    try { const value = await window.paperApi!.testWebSearchConnection({ apiKey }); if (alive.current) setResult(value); }
    catch (reason) { if (alive.current) setError(message(reason)); }
    finally { pending.current = false; testPending.current = false; if (alive.current) setTesting(false); }
  }
  async function clear() {
    if (pending.current || loading) return;
    pending.current = true; setSaving(true); setError('');
    try {
      const value = await window.paperApi!.clearWebSearchConfig();
      if (alive.current) { setApiKey(''); setResult(null); setConfirmClear(false); setLoadError(false); setConfig(value); onSaved(value); }
    } catch (reason) { if (alive.current) setError(message(reason)); }
    finally { pending.current = false; if (alive.current) setSaving(false); }
  }
  return <dialog ref={dialog} className="edit-modal web-search-settings" aria-labelledby="web-search-settings-title"
    onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => event.stopPropagation()}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }} onDragEnter={event => event.stopPropagation()} onDrop={event => { event.preventDefault(); event.stopPropagation(); }}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="modal-heading"><h2 id="web-search-settings-title"><Globe size={18} />搜索配置</h2>
        <button type="button" className="icon-button" aria-label="关闭搜索配置" disabled={saving} onClick={close}><X size={18} /></button></div>
      <div className="modal-fields">
        <div className="web-search-provider"><strong>Tavily</strong><span>{loading ? '正在读取…' : config.configured ? '已配置' : '未配置'}</span></div>
        <p className="web-search-help">独立的联网搜索服务，可与当前聊天模型搭配使用。</p>
        <label htmlFor="web-search-api-key">搜索 API Key {config.hasApiKey && <span>已保存，留空保持不变</span>}</label>
        <input ref={keyInput} id="web-search-api-key" type="password" required={!config.hasApiKey} maxLength={8192} autoComplete="new-password" spellCheck={false}
          placeholder={config.hasApiKey ? '已保存密钥，留空保持不变' : '填写 Tavily API Key'} value={apiKey} disabled={working || loading || loadError}
          onChange={event => { setApiKey(event.target.value); setResult(null); }} />
        <button type="button" className="web-search-account" onClick={() => {
          void window.paperApi!.openChatLink('https://app.tavily.com').catch(() => setError('无法打开 Tavily 网站，请在浏览器访问 app.tavily.com。'));
        }}>获取 Tavily API Key <ExternalLink size={12} /></button>
        <p className="web-search-help">密钥由系统加密保存在本机，不进入聊天记录。保存后，在聊天框开启「联网搜索」即可使用。</p>
        <p className="web-search-help">测试连通性会执行一次通用搜索，可能消耗搜索额度；不会发送文献或聊天内容，也不会保存本次填写。</p>
        {result && <p className={`web-search-test-result ${result.ok ? 'success' : 'failure'}`} role="status">{result.message}{result.ok && <span>耗时 {result.durationMs} ms</span>}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {loadError && <button type="button" className="secondary-button" disabled={working} onClick={() => void load()}>重新读取配置</button>}
        {confirmClear && <div className="web-search-clear-confirm" role="group" aria-label="确认清除搜索配置">
          <p>是否清除本机保存的搜索密钥？之后使用联网搜索需要重新配置。</p>
          <button type="button" className="secondary-button" disabled={working} onClick={() => setConfirmClear(false)}>保留配置</button>
          <button type="button" className="text-button" disabled={working} onClick={() => void clear()}>确认清除</button>
        </div>}
      </div>
      <div className="modal-footer">
        {(config.hasApiKey || loadError) && <button type="button" className="text-button web-search-clear" disabled={working || loading || confirmClear} onClick={() => setConfirmClear(true)}>清除配置</button>}
        <button type="button" className="secondary-button" disabled={working || loading || loadError} onClick={() => void test()}>{testing ? <LoaderCircle size={14} className="spin" /> : <Wifi size={14} />}{testing ? '测试中…' : '测试连通性'}</button>
        <button type="button" className="secondary-button" disabled={saving} onClick={close}>取消</button>
        <button type="submit" className="primary-button" disabled={working || loading || loadError}>{saving ? '正在保存…' : '保存配置'}</button>
      </div>
    </form>
  </dialog>;
}
