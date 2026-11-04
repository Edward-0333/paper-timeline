import { MODEL_CHAT_LIMITS, type StoredChatMessage } from '../shared/model-chat';

export interface ReaderChatMessage extends StoredChatMessage { id: string }
export interface ReaderChatSession {
  messages: ReaderChatMessage[];
  draft: string;
  pending: string | null;
  stopping: boolean;
  error: string;
  retryable: boolean;
  model: string;
  loaded: boolean;
  progress: string;
}
const sessions = new Map<string, ReaderChatSession>();
const listeners = new Set<() => void>();
export function readerChatSession(id: string): ReaderChatSession {
  if (!sessions.has(id)) sessions.set(id, { messages: [], draft: '', pending: null, stopping: false, error: '', retryable: false, model: '', loaded: false, progress: '' });
  return sessions.get(id)!;
}
export function subscribeReaderChat(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function update(id: string, change: Partial<ReaderChatSession>) {
  sessions.set(id, { ...readerChatSession(id), ...change });
  listeners.forEach(listener => listener());
}
export function setReaderChatDraft(id: string, draft: string) { update(id, { draft }); }
export async function loadReaderChat(id: string) {
  if (readerChatSession(id).loaded) return;
  try {
    const history = await window.paperApi!.getModelChatHistory(id);
    const state = readerChatSession(id);
    if (!state.loaded && !state.messages.length && !state.pending) update(id, { messages: history.messages.map(message => ({ ...message, id: crypto.randomUUID() })), loaded: true });
  } catch { update(id, { loaded: true, error: '无法恢复已保存的对话，请检查资料文件夹中的 chat.json。' }); }
}
export async function clearReaderChat(id: string) {
  if (readerChatSession(id).pending) return;
  try {
    await window.paperApi!.clearModelChatHistory(id);
    update(id, { messages: [], error: '', retryable: false, model: '', progress: '' });
  } catch { update(id, { error: '清空对话失败，原有记录已保留。' }); }
}
function validateMessages(messages: ReaderChatMessage[]) {
  if (messages.length > MODEL_CHAT_LIMITS.messages || messages.reduce((size, message) => size + message.content.length, 0) > MODEL_CHAT_LIMITS.totalCharacters) return '对话已达到上下文上限，请清空对话后继续。';
  if (messages.some(message => message.content.length > MODEL_CHAT_LIMITS.messageCharacters)) return '单条消息最多 20,000 个字符，请缩短后发送。';
  return '';
}
async function request(id: string, messages: ReaderChatMessage[], draft?: string) {
  if (readerChatSession(id).pending) return;
  const error = validateMessages(messages);
  if (error) { update(id, { error, retryable: false }); return; }
  const requestId = crypto.randomUUID();
  update(id, { messages, pending: requestId, stopping: false, error: '', retryable: false, progress: '正在连接模型…', ...(draft === undefined ? {} : { draft }) });
  const unsubscribe = window.paperApi!.onModelChatProgress(progress => {
    if (progress.paperId === id && progress.requestId === requestId && readerChatSession(id).pending === requestId) update(id, { progress: progress.label });
  });
  try {
    const result = await window.paperApi!.chatModel({ requestId, paperId: id, messages: messages.map(({ role, content }) => ({ role, content })) });
    if (readerChatSession(id).pending !== requestId) return;
    if (result.ok && result.content?.trim()) {
      update(id, { messages: [...messages, { id: crypto.randomUUID(), role: 'assistant', content: result.content, sources: result.sources, activity: result.activity }],
        pending: null, stopping: false, error: result.historyWarning ?? '', retryable: false, model: result.model ?? '', progress: '' });
    } else update(id, { pending: null, stopping: false, progress: '', error: result.message || '模型暂未返回正文，请重试。', retryable: true });
  } catch {
    if (readerChatSession(id).pending === requestId) update(id, { pending: null, stopping: false, error: '发送失败，请检查模型配置和网络后重试。', retryable: true });
  } finally { unsubscribe(); }
}
export async function sendReaderChat(id: string) {
  await loadReaderChat(id);
  const state = readerChatSession(id), content = state.draft.trim();
  if (!content || state.pending) return;
  await request(id, [...state.messages, { id: crypto.randomUUID(), role: 'user', content }], '');
}
export async function retryReaderChat(id: string) {
  const state = readerChatSession(id);
  if (!state.pending && state.retryable && state.messages.at(-1)?.role === 'user') await request(id, state.messages);
}
export async function stopReaderChat(id: string) {
  const state = readerChatSession(id);
  if (!state.pending || state.stopping) return;
  update(id, { stopping: true });
  try { await window.paperApi!.cancelModelChat(state.pending); }
  catch { if (readerChatSession(id).pending === state.pending) update(id, { stopping: false, error: '暂时无法停止请求，请稍后再试。' }); }
}
