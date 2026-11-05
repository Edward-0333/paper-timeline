import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Bot, Check, Copy, ExternalLink, Globe, KeyRound, LoaderCircle, MessageSquare, Pencil, Plus, RotateCw, Search, Send, Settings2, ShieldCheck, Square, Trash2, X } from 'lucide-react';
import { chatInputBudget, contextWindowTokens, estimateTextTokens, type AgentSource } from '../shared/model-chat';
import type { LibraryChatApproval, LibraryConversation } from '../shared/library-chat';
import { emptyModelConfiguration } from '../shared/model-settings';
import { emptyWebSearchConfiguration, type WebSearchProvider } from '../shared/web-search';
import { ModelSettingsDialog } from './ModelSettings';
import WebSearchSettingsDialog from './WebSearchSettings';
import ChatMarkdown from './ChatMarkdown';
import { clearLibraryChat, compactLibraryChat, createLibraryChat, decideLibraryChat, deleteLibraryChat, libraryChatMemory, libraryChatSession, libraryChatView, libraryChatWorkspace,
  loadLibraryChat, loadLibraryConversations, refreshLibraryConversations, renameLibraryChat, retryLibraryChat, saveLibraryChatView, selectLibraryChat,
  sendLibraryChat, setLibraryChatDraft, setLibraryChatWebSearch, setLibraryChatWebSearchProvider, stopLibraryChat, subscribeLibraryChat } from './library-chat-state';
import '../.generated/streamdown.css';
import 'streamdown/styles.css';
import './ReaderChat.css';
import './LibraryChat.css';

function CopyMessage({ content }: { content: string }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <span className="reader-ai-copy-action"><button type="button" className="reader-ai-icon" aria-label="复制消息" title={copied ? '已复制' : '复制原文'} onClick={async () => {
    setError(false);
    try { await navigator.clipboard.writeText(content); setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1800); }
    catch { setError(true); }
  }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>{copied && <span className="reader-ai-sr-only" role="status">已复制</span>}{error && <small role="alert">复制失败，请重试</small>}</span>;
}
function preview(value: unknown) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }

function sourceUrl(value?: string) {
  try { const url = new URL(value ?? ''); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null; }
  catch { return null; }
}
function MessageSources({ sources }: { sources: AgentSource[] }) {
  const [error, setError] = useState('');
  return <details className="library-ai-sources" open><summary>来源 · {sources.length}</summary><ul>{sources.map((source, index) => {
    const url = sourceUrl(source.url), date = source.retrievedAt ? new Date(source.retrievedAt) : null;
    return <li key={`${source.id}-${index}`}>{url ? <a href={url.href} title={url.href} rel="noreferrer" onAuxClick={event => event.preventDefault()} onClick={event => {
      event.preventDefault(); setError(''); void window.paperApi!.openChatLink(url.href).catch(() => setError('无法打开来源链接，请复制地址后在浏览器打开。'));
    }}><span>{source.label}</span><ExternalLink size={12} /></a> : <span>{source.label}</span>}
      {url && <small>{url.hostname}{source.kind === 'web-search' ? ' · 搜索摘要' : source.kind === 'web-page' ? ' · 已读取网页' : ''}
        {date && Number.isFinite(date.getTime()) && ` · ${source.kind === 'web-page' ? '读取于' : '检索于'} ${date.toLocaleString()}`}</small>}</li>;
  })}</ul>{error && <p role="alert">{error}</p>}</details>;
}

function DeleteConversationDialog({ conversation, onClose, focusFallback }: {
  conversation: LibraryConversation; onClose: () => void; focusFallback: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  useLayoutEffect(() => {
    const element = dialog.current!, previous = document.activeElement as HTMLElement | null;
    element.showModal(); cancel.current?.focus();
    return () => { element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); else focusFallback(); };
  }, []);
  const close = () => { if (!pending.current) onClose(); };
  async function confirm() {
    if (pending.current) return;
    pending.current = true; setSaving(true); setError('');
    try { await deleteLibraryChat(conversation.id); onClose(); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法删除此会话，请稍后重试。');
      requestAnimationFrame(() => cancel.current?.focus());
    } finally { pending.current = false; setSaving(false); }
  }
  return <dialog ref={dialog} className="edit-modal library-ai-delete-dialog" aria-labelledby="library-ai-delete-title" aria-describedby="library-ai-delete-description"
    onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => event.stopPropagation()}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}>
    <div className="modal-heading"><h2 id="library-ai-delete-title">是否确定删除会话？</h2>
      <button type="button" className="icon-button" aria-label="关闭删除会话确认" disabled={saving} onClick={close}><X size={18} /></button></div>
    <div className="modal-fields"><p className="library-ai-delete-name">{conversation.title}</p>
      <p id="library-ai-delete-description">将删除此会话的聊天记录和上下文摘要。已通过此会话执行的文献库或配置修改不会撤销。</p>
      {error && <p className="form-error" role="alert">删除失败：{error}</p>}
    </div>
    <div className="modal-footer"><button ref={cancel} type="button" className="secondary-button" disabled={saving} onClick={close}>取消</button>
      <button type="button" className="primary-button library-ai-delete-confirm" disabled={saving} onClick={() => void confirm()}>
        {saving ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}{saving ? '删除中…' : '确认删除'}
      </button></div>
  </dialog>;
}

function ApprovalCard({ approval, stopping }: { approval: LibraryChatApproval; stopping: boolean }) {
  const [apiKey, setApiKey] = useState(''), [withoutApiKey, setWithoutApiKey] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), cancel = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    if (!approval.modelEdit) return;
    const element = dialog.current!, previous = document.activeElement as HTMLElement | null;
    element.showModal(); cancel.current?.focus();
    return () => { element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [approval.id]);
  useEffect(() => {
    const button = cancel.current, scroll = button?.closest<HTMLElement>('.reader-ai-messages');
    if (!button || !scroll) return;
    const revealFooter = () => {
      const bottom = button.getBoundingClientRect().bottom, visibleBottom = scroll.getBoundingClientRect().bottom;
      if (bottom > visibleBottom - 12) scroll.scrollTop += bottom - visibleBottom + 12;
    };
    const observer = new ResizeObserver(revealFooter);
    observer.observe(scroll);
    const frame = requestAnimationFrame(() => { button.focus({ preventScroll: true }); revealFooter(); });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  async function decide(approved: boolean) {
    if (pending.current || stopping) return;
    pending.current = true; setBusy(true); setError('');
    try {
      await decideLibraryChat({ id: approval.id, requestId: approval.requestId, conversationId: approval.conversationId, approved,
        ...(approved && approval.modelDraft ? { withoutApiKey, ...(withoutApiKey ? {} : { apiKey }) } : {}) });
      setApiKey('');
    } catch { setError('操作未完成，请检查填写内容后重试，或取消这项操作。'); }
    finally { pending.current = false; setBusy(false); }
  }
  const form = <form className="library-ai-approval" aria-label="待确认操作" onSubmit={event => { event.preventDefault(); void decide(true); }}>
    <div className="library-ai-approval-heading"><ShieldCheck size={18} /><h3>{approval.title}</h3><span>等待确认</span></div>
    <p>{approval.description}</p>
    <ol className="library-ai-changes">{approval.changes.map((change, index) => <li key={index}>
      <strong>{change.description}</strong>
      {(change.before !== undefined || change.after !== undefined) && <div className="library-ai-before-after">
        {change.before !== undefined && <div><span>当前</span><pre>{preview(change.before)}</pre></div>}
        {change.after !== undefined && <div><span>修改后</span><pre>{preview(change.after)}</pre></div>}
      </div>}
    </li>)}</ol>
    {approval.modelDraft && <fieldset className="library-ai-secure-model" disabled={busy || stopping}>
      <legend><KeyRound size={14} />{approval.modelEdit ? '更新接口密钥' : '添加大模型'}</legend>
      <dl><div><dt>配置名称</dt><dd>{approval.modelDraft.name}</dd></div><div><dt>接口地址</dt><dd>{approval.modelDraft.baseUrl}</dd></div>
        <div><dt>模型名称</dt><dd>{approval.modelDraft.model}</dd></div>
        {approval.modelDraft.contextWindowTokens && <div><dt>上下文预算</dt><dd>{approval.modelDraft.contextWindowTokens.toLocaleString()} token</dd></div>}</dl>
      {!withoutApiKey && <><label htmlFor="library-agent-api-key">API Key</label><input id="library-agent-api-key" type="password" autoComplete="new-password" spellCheck={false} maxLength={8192} required value={apiKey}
        placeholder="在此安全表单中填写，不要粘贴到聊天框" onChange={event => setApiKey(event.target.value)} /></>}
      <label className="library-ai-no-key"><input type="checkbox" checked={withoutApiKey} onChange={event => { setWithoutApiKey(event.target.checked); setApiKey(''); }} />此接口无需 API Key（例如本地模型）</label>
      <small>密钥直接交给软件加密保存，不进入聊天记录或发送给当前对话模型。{approval.modelEdit ? '更新后保留当前模型选择。' : '保存后可在模型配置列表中选择。'}</small>
    </fieldset>}
    {error && <p className="library-ai-approval-error" role="alert">{error}</p>}
    <div className="library-ai-approval-actions"><button ref={cancel} type="button" disabled={busy || stopping} onClick={() => void decide(false)}>取消这项操作</button>
      <button type="submit" className="reader-ai-send" disabled={busy || stopping || (!!approval.modelDraft && !withoutApiKey && !apiKey.trim())}>{busy && <LoaderCircle size={14} className="reader-ai-spin" />}{approval.modelEdit ? '确认保存修改' : approval.modelDraft ? '确认添加模型' : '确认执行'}</button></div>
  </form>;
  return approval.modelEdit ? <dialog ref={dialog} className="edit-modal library-ai-model-edit-dialog" aria-label="确认修改大模型配置"
    onCancel={event => { event.preventDefault(); void decide(false); }} onKeyDown={event => event.stopPropagation()}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) void decide(false);
    }}>{form}</dialog> : form;
}

function ConversationPane({ conversation, storagePath, onClose, globalPending, changing }: {
  conversation: LibraryConversation; storagePath: string; onClose: () => void; globalPending: number; changing: boolean;
}) {
  const conversationId = conversation.id;
  const state = useSyncExternalStore(subscribeLibraryChat, () => libraryChatSession(conversationId));
  const [config, setConfig] = useState(emptyModelConfiguration), [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState(''), [settings, setSettings] = useState(false);
  const [webConfig, setWebConfig] = useState(emptyWebSearchConfiguration), [webLoading, setWebLoading] = useState(true);
  const [webError, setWebError] = useState(''), [searchSettings, setSearchSettings] = useState(false);
  const enableAfterSave = useRef(false), checkingWeb = useRef(false);
  const [renaming, setRenaming] = useState(false), [name, setName] = useState(''), [renameError, setRenameError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null), log = useRef<HTMLDivElement>(null);
  const initialView = useRef(libraryChatView(conversationId));
  const [visibleMessages, setVisibleMessages] = useState(initialView.current.visibleMessages);
  const visibleCount = useRef(visibleMessages); visibleCount.current = visibleMessages;
  const restoredView = useRef(false);
  const scrollState = `${state.messages.length}:${state.pending ?? ''}:${state.error}:${state.approval?.id ?? ''}`;
  const lastAutoScroll = useRef(scrollState);
  const olderScroll = useRef<{ height: number; top: number } | null>(null);
  useEffect(() => { void loadLibraryChat(conversationId); input.current?.focus({ preventScroll: true }); }, [conversationId]);
  useLayoutEffect(() => {
    const element = log.current;
    return () => { if (element) saveLibraryChatView(conversationId, { scrollTop: element.scrollTop, visibleMessages: visibleCount.current }); };
  }, [conversationId]);
  useEffect(() => {
    let alive = true;
    window.paperApi!.getModelConfig().then(next => { if (alive) { setConfig(next); setConfigError(''); } })
      .catch(() => { if (alive) setConfigError('无法读取模型配置，请打开设置重新配置。'); }).finally(() => { if (alive) setConfigLoading(false); });
    return () => { alive = false; };
  }, [state.pending, globalPending]);
  useEffect(() => {
    if (state.webSearchProvider !== 'tavily') { setWebLoading(false); return; }
    let alive = true;
    setWebLoading(true);
    window.paperApi!.getWebSearchConfig().then(next => {
      if (alive) { setWebConfig(next); setWebError(''); if (!next.configured) setLibraryChatWebSearch(conversationId, false); }
    }).catch(() => { if (alive) setWebError('无法读取搜索配置，请打开「搜索配置」重试。'); })
      .finally(() => { if (alive) setWebLoading(false); });
    return () => { alive = false; };
  }, [conversationId, state.pending, globalPending, state.webSearchProvider]);
  useLayoutEffect(() => {
    if (!restoredView.current && state.loaded && !configLoading && log.current) {
      log.current.scrollTop = initialView.current.scrollTop ?? log.current.scrollHeight;
      lastAutoScroll.current = scrollState;
      restoredView.current = true;
    }
  }, [state.loaded, configLoading, scrollState]);
  useLayoutEffect(() => {
    if (olderScroll.current && log.current) { log.current.scrollTop = olderScroll.current.top + log.current.scrollHeight - olderScroll.current.height; olderScroll.current = null; }
  }, [visibleMessages]);
  useEffect(() => {
    const element = log.current;
    if (!element || !restoredView.current || lastAutoScroll.current === scrollState) return;
    lastAutoScroll.current = scrollState;
    const reveal = () => { element.scrollTop = element.scrollHeight; };
    const frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [scrollState]);
  const memory = libraryChatMemory(conversationId);
  const windowTokens = contextWindowTokens(config.contextWindowTokens);
  const historyTokens = useMemo(() => estimateTextTokens(memory?.summary ?? '') + state.messages.slice(memory?.coveredMessages ?? 0).reduce((sum, message) => sum + estimateTextTokens(message.content) + 8, 0), [memory, state.messages]);
  const estimatedTokens = historyTokens + estimateTextTokens(state.draft);
  const busy = !!state.pending || !!state.approval || state.clearing || state.loading;
  const canSend = config.configured && !configLoading && state.loaded && !busy && globalPending < 4 && !!state.draft.trim()
    && (!state.webSearch || state.webSearchProvider === 'openai' || (!webLoading && webConfig.configured && !webError));
  async function toggleWebSearch() {
    if (busy || checkingWeb.current) return;
    if (state.webSearch) { setLibraryChatWebSearch(conversationId, false); return; }
    if (state.webSearchProvider === 'openai') {
      if (config.configured && !configLoading) setLibraryChatWebSearch(conversationId, true);
      return;
    }
    checkingWeb.current = true; setWebLoading(true); setWebError('');
    try {
      const next = await window.paperApi!.getWebSearchConfig(); setWebConfig(next);
      if (next.configured) setLibraryChatWebSearch(conversationId, true);
      else { enableAfterSave.current = true; setSearchSettings(true); }
    } catch { setWebError('无法读取搜索配置，请打开「搜索配置」重试。'); }
    finally { checkingWeb.current = false; setWebLoading(false); }
  }
  const hiddenMessages = Math.max(0, state.messages.length - visibleMessages);
  return <><div className="reader-ai-chat library-ai-chat" data-active-conversation-id={conversationId} aria-label="文献库助手" onKeyDown={event => event.stopPropagation()}>
      <header className="reader-ai-heading"><h2 title={conversation.title}><MessageSquare size={18} /><span>{conversation.title}</span></h2><div>
        <button className="reader-ai-icon" aria-label="重命名会话" title="重命名会话" disabled={changing} onClick={() => { setName(conversation.title); setRenameError(''); setRenaming(value => !value); }}><Pencil size={16} /></button>
        <button className="reader-ai-icon" aria-label="配置大模型" title="配置大模型" disabled={busy || configLoading} onClick={() => setSettings(true)}><Settings2 size={17} /></button>
        <button className="reader-ai-icon" aria-label="清空对话" title="清空当前会话" disabled={busy || !state.messages.length} onClick={() => void clearLibraryChat(conversationId)}><Trash2 size={16} /></button>
        <button className="reader-ai-icon" aria-label="关闭文献库助手" title="关闭文献库助手" onClick={onClose}><X size={18} /></button>
      </div></header>
      {renaming && <form className="library-ai-rename" aria-label="重命名会话" onSubmit={async event => {
        event.preventDefault(); if (changing || !name.trim()) return;
        try { await renameLibraryChat(conversationId, name.trim()); setRenaming(false); }
        catch { setRenameError('会话名称保存失败，请重试。'); }
      }}><label htmlFor="library-conversation-name">会话名称</label><input id="library-conversation-name" autoFocus maxLength={80} value={name} disabled={changing}
        onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setRenaming(false); }} />
        <button type="submit" disabled={changing || !name.trim()}>保存名称</button><button type="button" disabled={changing} onClick={() => setRenaming(false)}>取消</button>
        {renameError && <p role="alert">{renameError}</p>}</form>}
      <div className="reader-ai-model"><span>{configLoading ? '正在读取配置…' : config.configured ? config.name : '尚未选择大模型'}</span>{config.configured && <small title={config.model}>{config.model}</small>}</div>
      <div className="library-ai-scope"><span title={storagePath}>当前文献库：{storagePath || '正在读取…'}</span><small>管理分类、元数据、模型配置和云端监控 · 不读取 PDF 全文</small></div>
      {config.configured && <section className="reader-ai-memory" aria-label="对话上下文"><div className="reader-ai-memory-row"><span title="对话文字估算；工具说明、返回资料和回答另需预留容量。">对话预计 {estimatedTokens.toLocaleString()} / {windowTokens.toLocaleString()} token</span>
        <button type="button" disabled={busy || globalPending >= 4 || !state.loaded || !state.messages.length} onClick={() => void compactLibraryChat(conversationId)}>立即压缩</button></div>
        <progress aria-label="预计上下文占用" max={100} value={Math.min(100, Math.round(estimatedTokens / windowTokens * 100))} />
        <div className="reader-ai-memory-status" role="status">{memory ? `已摘要压缩 ${memory.coveredMessages} 条早期消息 · 原始记录保留` : '长对话会自动生成摘要 · 原始记录保留'}{estimatedTokens >= chatInputBudget(windowTokens) && ' · 发送时将检查并压缩'}</div>
        {memory && <details className="reader-ai-memory-details"><summary>查看历史摘要</summary><p>{memory.summary}</p><small>更新于 {new Date(memory.updatedAt).toLocaleString()}</small></details>}
        {!state.pending && state.compactOnly && state.progress && <p className="reader-ai-memory-status" role="status">{state.progress}</p>}
      </section>}
      {(configError || (!configLoading && !config.configured)) && <div className="reader-ai-config-help"><p>{configError || '选择一个 API 大模型，即可使用文献库助手。'}</p><button onClick={() => setSettings(true)}>配置大模型</button></div>}
      <div className="reader-ai-messages" ref={log} role="log" aria-label="文献库聊天记录" aria-live="polite" aria-relevant="additions text">
        {hiddenMessages > 0 && <button className="reader-ai-load-older" type="button" onClick={() => { if (log.current) olderScroll.current = { height: log.current.scrollHeight, top: log.current.scrollTop }; setVisibleMessages(count => count + 50); }}>查看更早消息（还有 {hiddenMessages} 条）</button>}
        {!state.messages.length && <div className="reader-ai-empty"><Bot size={36} /><h3>让文献库整理更轻松</h3><p>查找文献、整理分类和标签、核对元数据，<br />也可以添加或修改模型配置、调整引用监控。</p>
          <div className="library-ai-suggestions">{['统计当前文献库的分类和标签', '查看哪些论文已开启引用监控', '帮我添加一个 API 大模型'].map(text => <button type="button" key={text} disabled={busy} onClick={() => { setLibraryChatDraft(conversationId, text); input.current?.focus(); }}>{text}</button>)}</div>
          <small>读取到的书目信息会发送给当前模型；修改前展示具体操作。</small></div>}
        {state.messages.slice(-visibleMessages).map(message => <article className={`reader-ai-message ${message.role}`} key={message.id} aria-label={message.role === 'user' ? '我的消息' : 'AI 回复'}>
          <div className="reader-ai-message-author"><span>{message.role === 'user' ? '你' : 'AI'}</span><CopyMessage content={message.content} /></div>
          <div className="reader-ai-message-text">{message.role === 'assistant' ? <ChatMarkdown content={message.content} /> : message.content}</div>
          {!!message.sources?.length && <MessageSources sources={message.sources} />}
          {!!message.activity?.length && <details className="reader-ai-evidence"><summary>执行记录 · {message.activity.length} 步</summary><ul>{message.activity.map((activity, index) => <li key={index}>{activity.label} · {activity.status === 'succeeded' ? '完成' : '未完成'}</li>)}</ul></details>}
        </article>)}
        {state.loading && <div className="reader-ai-thinking" role="status"><LoaderCircle size={15} className="reader-ai-spin" />正在恢复对话…</div>}
        {state.clearing && <div className="reader-ai-thinking" role="status"><LoaderCircle size={15} className="reader-ai-spin" />正在清空对话…</div>}
        {state.pending && <div className="reader-ai-thinking" role="status"><LoaderCircle size={15} className="reader-ai-spin" />{state.stopping ? '正在停止…' : state.progress || '正在思考…'}</div>}
        {state.approval && <ApprovalCard key={state.approval.id} approval={state.approval} stopping={state.stopping} />}
        {state.error && <div className="reader-ai-error" role="alert"><p>{state.error}</p>{state.retryable && !busy && <button disabled={globalPending >= 4} onClick={() => void retryLibraryChat(conversationId)}><RotateCw size={13} />重试</button>}{!state.loaded && !state.loading && <button onClick={() => void loadLibraryChat(conversationId)}><RotateCw size={13} />重新加载记录</button>}</div>}
      </div>
      <form className="reader-ai-compose" onSubmit={event => { event.preventDefault(); if (canSend) void sendLibraryChat(conversationId); }}>
        <div className="library-ai-web-controls">
          <button type="button" role="switch" aria-label="联网搜索" aria-checked={state.webSearch} className={`library-ai-web-toggle ${state.webSearch ? 'is-on' : ''}`}
            disabled={busy || changing || (state.webSearchProvider === 'tavily' ? webLoading : configLoading || !config.configured)} onClick={() => void toggleWebSearch()} title={state.webSearch ? '本轮可按需搜索公开网页' : '开启后允许助手联网查找资料'}>
            <Globe size={14} /><span>联网搜索</span><span className="library-ai-switch-track" aria-hidden="true"><span /></span>
          </button>
          <select className="library-ai-web-provider" aria-label="联网搜索来源" value={state.webSearchProvider} disabled={busy || changing}
            onChange={event => setLibraryChatWebSearchProvider(conversationId, event.target.value as WebSearchProvider)}>
            <option value="openai">OpenAI 内置</option><option value="tavily">Tavily</option>
          </select>
          {state.webSearchProvider === 'tavily'
            ? <><button type="button" className="library-ai-web-settings" onClick={() => { enableAfterSave.current = false; setSearchSettings(true); }}><Settings2 size={13} />搜索配置</button>
              {state.webSearch && <small>搜索词发送至 Tavily · 网页资料发送至当前模型</small>}</>
            : <small title="需要支持 Responses 联网搜索的接口；服务商可能收取工具费用。">使用当前模型 · 无需额外搜索密钥</small>}
        </div>
        {state.webSearchProvider === 'tavily' && webError && <p className="library-ai-web-error" role="alert">{webError}</p>}
        <textarea ref={input} aria-label="文献库助手消息" placeholder={config.configured ? '告诉我想如何整理文献库…（API Key 请在安全表单中填写）' : '请先配置大模型'} rows={3} maxLength={20000} value={state.draft} onChange={event => setLibraryChatDraft(conversationId, event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canSend) void sendLibraryChat(conversationId); } }} />
        <div className="reader-ai-compose-actions"><span>Enter 发送 · Shift+Enter 换行</span>{state.pending || state.approval
          ? <button type="button" className="reader-ai-send" aria-label="停止生成" disabled={state.stopping} onClick={() => void stopLibraryChat(conversationId)}><Square size={13} />停止</button>
          : <button type="submit" className="reader-ai-send" aria-label="发送" disabled={!canSend}><Send size={14} />发送</button>}</div>
        <p className="reader-ai-note">{globalPending >= 4 && !state.pending ? '已有 4 个会话正在处理，请等待其中一个完成。' : '当前会话独立保存 · 自动摘要可能增加 API 调用 · 密钥请勿写入消息'}</p>
      </form>
    </div>
    {settings && <ModelSettingsDialog config={config} loadError={configError} onClose={() => { setSettings(false); requestAnimationFrame(() => input.current?.focus()); }} onSaved={next => { setConfig(next); setConfigError(''); }} />}
    {searchSettings && <WebSearchSettingsDialog onClose={() => { setSearchSettings(false); enableAfterSave.current = false; requestAnimationFrame(() => input.current?.focus()); }} onSaved={next => {
      setWebConfig(next); setWebError('');
      if (state.webSearchProvider === 'tavily') {
        if (!next.configured) setLibraryChatWebSearch(conversationId, false);
        else if (enableAfterSave.current) setLibraryChatWebSearch(conversationId, true);
      }
    }} />}
  </>;
}

function conversationTime(value: string) {
  const date = new Date(value), now = new Date();
  return date.toDateString() === now.toDateString() ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

export default function LibraryChat({ storagePath, onClose }: { storagePath: string; onClose: () => void }) {
  const workspace = useSyncExternalStore(subscribeLibraryChat, libraryChatWorkspace);
  const [query, setQuery] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<LibraryConversation | null>(null);
  const newConversation = useRef<HTMLButtonElement>(null);
  useEffect(() => { void loadLibraryConversations(); }, []);
  const active = workspace.conversations.find(item => item.id === workspace.activeId);
  const conversations = workspace.conversations.filter(item => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const globalPending = Object.values(workspace.sessions).filter(session => session.pending || session.approval).length;
  return <section className="library-ai-page" id="assistant-panel-library" role="tabpanel" aria-labelledby="assistant-tab-library">
    <aside className="library-ai-history" aria-label="会话历史">
      <div className="library-ai-history-heading"><Bot size={20} /><h2>文献库助手</h2></div>
      <button ref={newConversation} className="library-ai-new" type="button" disabled={!workspace.loaded || workspace.loading || workspace.changing} onClick={() => { setQuery(''); void createLibraryChat(); }}><Plus size={17} />新建会话</button>
      <label className="library-ai-history-search"><Search size={14} /><input aria-label="搜索会话" placeholder="搜索会话" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="library-ai-history-label"><span>历史会话</span><span>{workspace.conversations.length}</span></div>
      {workspace.error && <div className="library-ai-history-error" role="alert"><p>{workspace.error}</p><button onClick={() => void (workspace.loaded ? refreshLibraryConversations() : loadLibraryConversations())}><RotateCw size={12} />重试</button></div>}
      <div className="library-ai-history-list">
        {workspace.loading && <p className="library-ai-history-empty"><LoaderCircle size={14} className="reader-ai-spin" />正在读取会话…</p>}
        {workspace.loaded && !conversations.length && <p className="library-ai-history-empty">{query.trim() ? '没有匹配的会话' : '还没有会话'}</p>}
        {conversations.map(conversation => {
          const session = workspace.sessions[conversation.id], selected = conversation.id === workspace.activeId;
          const status = session?.approval ? '等待确认' : session?.pending ? '正在回复' : session?.error ? '需要处理' : '';
          const deletingDisabled = !!(session?.pending || session?.approval || session?.clearing || session?.loading);
          const deleteHint = session?.pending || session?.approval ? '请先停止此会话的请求，再删除会话' : session?.clearing || session?.loading ? '请等待此会话处理完成后再删除' : '删除会话';
          return <div key={conversation.id} className={`library-ai-history-row ${selected ? 'is-current' : ''}`}>
            <button type="button" data-conversation-id={conversation.id} className={`library-ai-history-item ${selected ? 'is-current' : ''}`}
            aria-label={`打开会话：${conversation.title}`} aria-current={selected ? 'page' : undefined} title={conversation.title} disabled={workspace.changing || workspace.loading}
            onClick={() => void selectLibraryChat(conversation.id)}>
            <span className="library-ai-history-title"><MessageSquare size={14} /><span>{conversation.title}</span>{session?.pending && <LoaderCircle size={12} className="reader-ai-spin" />}</span>
            <span className="library-ai-history-meta"><span className={session?.approval ? 'needs-confirmation' : ''}>{status || `${conversation.messageCount} 条消息`}</span><time dateTime={conversation.updatedAt}>{conversationTime(conversation.updatedAt)}</time></span>
            </button>
            <button type="button" className="library-ai-history-delete" aria-label={`删除会话：${conversation.title}`} title={deleteHint}
              disabled={deletingDisabled || workspace.changing || workspace.loading} onClick={() => setDeleteTarget(conversation)}><Trash2 size={14} /></button>
          </div>;
        })}
      </div>
      <p className="library-ai-history-footnote">会话保存在当前文献库中</p>
    </aside>
    <div className="library-ai-conversation">
      {active && workspace.sessions[active.id] ? <ConversationPane key={active.id} conversation={active} storagePath={storagePath} onClose={onClose} globalPending={globalPending} changing={workspace.changing} />
        : <div className="library-ai-no-conversation"><Bot size={36} /><h2>文献库助手</h2><p>{workspace.loading ? '正在读取会话历史…' : workspace.error ? '请在左侧重新加载会话历史。' : '点击左侧“新建会话”开始聊天。'}</p></div>}
    </div>
    {deleteTarget && <DeleteConversationDialog conversation={deleteTarget} onClose={() => setDeleteTarget(null)} focusFallback={() => newConversation.current?.focus({ preventScroll: true })} />}
  </section>;
}
