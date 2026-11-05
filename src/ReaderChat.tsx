import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Check, Copy, LoaderCircle, RotateCw, Send, Settings2, Square, Trash2, X } from 'lucide-react';
import type { Paper } from '../shared/types';
import { chatInputBudget, contextWindowTokens, estimateTextTokens, type ModelChatContext } from '../shared/model-chat';
import { emptyModelConfiguration } from '../shared/model-settings';
import { ModelSettingsDialog } from './ModelSettings';
import ChatMarkdown from './ChatMarkdown';
import { clearReaderChat, compactReaderChat, loadReaderChat, readerChatSession, retryReaderChat, sendReaderChat, setReaderChatDraft, stopReaderChat, subscribeReaderChat } from './reader-chat-state';
import styles from './ReaderChat.css?inline';
import streamdownStyles from '../.generated/streamdown.css?inline';
import katexStyles from 'katex/dist/katex.min.css?inline';
import streamdownMotion from 'streamdown/styles.css?inline';

function MessageCopyButton({ content, role }: { content: string; role: 'user' | 'assistant' }) {
  const [copied, setCopied] = useState(false), [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <span className="reader-ai-copy-action">
    <button type="button" className="reader-ai-icon" aria-label={role === 'assistant' ? '复制 AI 回复' : '复制我的消息'}
      title={copied ? '已复制' : role === 'assistant' ? '复制全文（Markdown）' : '复制消息'} onClick={async () => {
        setCopied(false); setFailed(false);
        try {
          await navigator.clipboard.writeText(content); setCopied(true); clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1800);
        } catch { setFailed(true); }
      }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
    {copied && <span className="reader-ai-sr-only" role="status">已复制</span>}
    {failed && <span className="reader-ai-copy-error" role="alert">复制失败，请重试</span>}
  </span>;
}

export default function ReaderChat({ paper, onClose }: { paper: Paper; onClose: () => void }) {
  const state = useSyncExternalStore(subscribeReaderChat, () => readerChatSession(paper.id));
  const [config, setConfig] = useState(emptyModelConfiguration);
  const [loading, setLoading] = useState(true), [configError, setConfigError] = useState(''), [settings, setSettings] = useState(false);
  const [context, setContext] = useState<ModelChatContext | null>(null), [contextError, setContextError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null), log = useRef<HTMLDivElement>(null);
  const [visibleMessages, setVisibleMessages] = useState(50);
  const olderScroll = useRef<{ height: number; top: number } | null>(null);
  useEffect(() => { setVisibleMessages(50); olderScroll.current = null; }, [paper.id]);
  useLayoutEffect(() => {
    if (olderScroll.current && log.current) {
      log.current.scrollTop = olderScroll.current.top + log.current.scrollHeight - olderScroll.current.height;
      olderScroll.current = null;
    }
  }, [visibleMessages]);
  useEffect(() => { void loadReaderChat(paper.id); }, [paper.id]);
  useEffect(() => {
    let active = true;
    window.paperApi!.getModelConfig().then(next => { if (active) setConfig(next); })
      .catch(() => { if (active) setConfigError('无法读取模型配置，请打开设置重新配置。'); })
      .finally(() => { if (active) setLoading(false); });
    input.current?.focus({ preventScroll: true });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    setContext(null); setContextError('');
    window.paperApi!.getModelChatContext(paper.id).then(next => { if (active) setContext(next); })
      .catch(() => { if (active) setContextError('无法读取论文目录，请重新打开聊天面板。'); });
    return () => { active = false; };
  }, [paper.id, paper.title, paper.pdfHash, paper.markdownNote?.importedAt, state.pending]);
  useEffect(() => {
    const element = log.current;
    if (!element) return;
    const revealLatest = () => { element.scrollTop = element.scrollHeight; };
    revealLatest();
    // The native sidebar may still be sizing when its React portal mounts.
    const observer = new ResizeObserver(revealLatest);
    observer.observe(element);
    const frame = requestAnimationFrame(revealLatest);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [paper.id, state.messages.length, state.pending, state.error]);
  const currentContext = context?.paperId === paper.id ? context : null;
  const canSend = config.configured && !loading && state.loaded && !!currentContext && !state.pending && !state.clearing && !!state.draft.trim();
  const memory = state.compaction?.paperId === paper.id && state.compaction.coveredMessages <= state.messages.length ? state.compaction : null;
  const windowTokens = contextWindowTokens(config.contextWindowTokens);
  const historyTokens = useMemo(() => estimateTextTokens(memory?.summary ?? '') + state.messages.slice(memory?.coveredMessages ?? 0).reduce((sum, item) => sum + estimateTextTokens(item.content) + 8, 0), [memory, state.messages]);
  const estimatedTokens = historyTokens + estimateTextTokens(state.draft);
  const contextPercent = Math.min(100, Math.round(estimatedTokens / windowTokens * 100));
  const autoCompactNext = estimatedTokens >= chatInputBudget(windowTokens);
  const hiddenMessages = Math.max(0, state.messages.length - visibleMessages);
  // Clicking selectable prose must leave keyboard focus in this panel; otherwise
  // EmbedPDF's document-level Ctrl+C handler consumes the browser's native copy.
  return <aside className="reader-ai-chat" aria-label="AI 聊天" tabIndex={-1} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); onClose(); }
  }}>
    <style>{streamdownStyles + katexStyles + streamdownMotion + styles}</style>
    <header className="reader-ai-heading"><h2><Bot size={17} />AI 聊天</h2><div>
      <button className="reader-ai-icon" aria-label="配置大模型" title="配置大模型" disabled={!!state.pending || loading} onClick={() => setSettings(true)}><Settings2 size={16} /></button>
      <button className="reader-ai-icon" aria-label="清空对话" title="清空对话" disabled={!!state.pending || state.clearing || !state.messages.length} onClick={() => clearReaderChat(paper.id)}><Trash2 size={15} /></button>
      <button className="reader-ai-icon" aria-label="关闭 AI 聊天" title="关闭 AI 聊天" onClick={onClose}><X size={17} /></button>
    </div></header>
    <div className="reader-ai-model"><span>{loading ? '正在读取配置…' : config.configured ? config.name : config.profiles.length ? '请选择已保存的模型' : '尚未配置大模型'}</span>
      {config.configured && <small title={config.model}>{config.model}</small>}</div>
    <div className="reader-ai-context" title={paper.title}>当前阅读：{paper.title}</div>
    <details className="reader-ai-workspace" key={paper.id}>
      <summary aria-label="当前工作目录"><span>工作目录</span><span className="reader-ai-workdir" title={currentContext?.workingDirectory}>
        {currentContext?.workingDirectory || (contextError ? '读取失败' : '正在读取…')}</span></summary>
      <div className="reader-ai-workspace-details">
        {contextError ? <p role="alert">{contextError}</p> : currentContext && <>
          <p className="reader-ai-directory" aria-label="工作目录路径">{currentContext.workingDirectory}</p>
          <dl>{([
            ['PDF 原文', currentContext.files.pdf], ['Markdown 笔记', currentContext.files.markdown],
            ['阅读标注', currentContext.files.annotations], ['解析结果目录', currentContext.files.parsedDirectory],
          ] as const).map(([label, path]) => <div key={label}><dt>{label}</dt><dd>{path || '暂无文件'}</dd></div>)}</dl>
          <p>论文阅读 Agent 可按问题读取当前论文的全文、笔记和图片，或运行本机 MinerU。读取的内容会发送到已配置模型。</p>
        </>}
      </div>
    </details>
    {config.configured && <section className="reader-ai-memory" aria-label="对话上下文">
      <div className="reader-ai-memory-row"><span title="对话文字的估算；论文资料、工具说明和回答另需预留容量。">对话预计 {estimatedTokens.toLocaleString()} / {windowTokens.toLocaleString()} token</span>
        <button type="button" disabled={!!state.pending || state.clearing || !state.loaded || !currentContext || !state.messages.length} onClick={() => void compactReaderChat(paper.id)}>立即压缩</button></div>
      <progress aria-label="预计上下文占用" max={100} value={contextPercent} />
      <div className="reader-ai-memory-status" role="status">{memory ? `已摘要压缩 ${memory.coveredMessages} 条早期消息 · 原始记录保留` : '长对话会自动生成摘要 · 原始记录保留'}{autoCompactNext && ' · 发送时将检查并压缩'}</div>
      {memory && <details className="reader-ai-memory-details"><summary>查看历史摘要</summary><p>{memory.summary}</p><small>更新于 {new Date(memory.updatedAt).toLocaleString()}</small></details>}
      {!state.pending && state.compactOnly && state.progress && <p className="reader-ai-memory-status" role="status">{state.progress}</p>}
    </section>}
    {(configError || (!loading && !config.configured)) && <div className="reader-ai-config-help"><p>{configError || '配置 API 大模型后即可开始聊天。'}</p><button onClick={() => setSettings(true)}>配置大模型</button></div>}
    <div className="reader-ai-messages" ref={log} role="log" aria-label="聊天记录" aria-live="polite" aria-relevant="additions text">
      {hiddenMessages > 0 && <button type="button" className="reader-ai-load-older" onClick={() => {
        if (log.current) olderScroll.current = { height: log.current.scrollHeight, top: log.current.scrollTop };
        setVisibleMessages(count => count + 50);
      }}>查看更早消息（还有 {hiddenMessages} 条）</button>}
      {!state.messages.length && <div className="reader-ai-empty"><Bot size={30} /><h3>论文阅读 Agent</h3><p>可分析全文、查看图片与核对原始页面。<br />缺少全文时可自动调用 MinerU。</p></div>}
      {state.messages.slice(-visibleMessages).map(message => <article className={`reader-ai-message ${message.role}`} key={message.id} aria-label={message.role === 'user' ? '我的消息' : 'AI 回复'}>
        <div className="reader-ai-message-author"><span>{message.role === 'user' ? '你' : 'AI'}</span><MessageCopyButton content={message.content} role={message.role} /></div>
        <div className="reader-ai-message-text">{message.role === 'assistant' ? <ChatMarkdown content={message.content} /> : message.content}</div>
        {!!message.activity?.length && <details className="reader-ai-evidence"><summary>资料查阅记录 · {message.activity.length} 步</summary>
          <ul>{message.activity.map((item, index) => <li key={index}>{item.label} · {item.status === 'succeeded' ? '完成' : '未完成'}</li>)}</ul>
          {!!message.sources?.length && <ul>{message.sources.map(source => <li key={source.id} title={source.id}>{source.label}</li>)}</ul>}
        </details>}
      </article>)}
      {state.clearing && <div className="reader-ai-thinking" role="status"><LoaderCircle size={15} className="reader-ai-spin" />正在清空对话…</div>}
      {state.pending && <div className="reader-ai-thinking" role="status"><LoaderCircle size={15} className="reader-ai-spin" />{state.stopping ? '正在停止…' : state.progress || '正在思考…'}</div>}
      {state.error && <div className="reader-ai-error" role="alert"><p>{state.error}</p>{state.retryable && !state.pending && <button onClick={() => void retryReaderChat(paper.id)}><RotateCw size={13} />重试</button>}</div>}
    </div>
    <form className="reader-ai-compose" onSubmit={event => { event.preventDefault(); if (canSend) void sendReaderChat(paper.id); }}>
      <textarea ref={input} aria-label="消息" placeholder={config.configured ? '输入消息…' : '请先配置大模型'} rows={3} maxLength={20000}
        value={state.draft} onChange={event => setReaderChatDraft(paper.id, event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canSend) void sendReaderChat(paper.id); } }} />
      <div className="reader-ai-compose-actions"><span>Enter 发送 · Shift+Enter 换行</span>
        {state.pending ? <button type="button" className="reader-ai-send" aria-label="停止生成" disabled={state.stopping} onClick={() => void stopReaderChat(paper.id)}><Square size={13} />停止</button>
          : <button type="submit" className="reader-ai-send" aria-label="发送" disabled={!canSend}><Send size={14} />发送</button>}</div>
      <p className="reader-ai-note">资料与摘要会发送到当前模型 · 自动摘要可能增加 API 调用 · 对话保存在资料文件夹</p>
    </form>
    {settings && createPortal(<ModelSettingsDialog config={config} loadError={configError} onClose={() => { setSettings(false); requestAnimationFrame(() => input.current?.focus()); }}
      onSaved={next => { setConfig(next); setConfigError(''); }} />, window.document.body)}
  </aside>;
}
