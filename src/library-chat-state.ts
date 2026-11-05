import type { LibraryChatApproval, LibraryChatDecision, LibraryConversation, LibraryConversationList } from '../shared/library-chat';
import { MODEL_CHAT_LIMITS, type ChatCompaction, type ChatContextUsage, type StoredChatMessage } from '../shared/model-chat';
import type { WebSearchProvider } from '../shared/web-search';

export interface LibraryChatMessage extends StoredChatMessage { id: string }
export interface LibraryChatSession {
  messages: LibraryChatMessage[]; draft: string; pending: string | null; stopping: boolean;
  loaded: boolean; loading: boolean; clearing: boolean; error: string; retryable: boolean; progress: string;
  compaction: ChatCompaction | null; contextUsage: ChatContextUsage | null; compactOnly: boolean; approval: LibraryChatApproval | null;
  webSearch: boolean; webSearchProvider: WebSearchProvider;
}
export interface LibraryChatWorkspace {
  conversations: LibraryConversation[]; activeId: string | null; sessions: Record<string, LibraryChatSession>;
  loaded: boolean; loading: boolean; changing: boolean; error: string;
}
const emptySession = (): LibraryChatSession => ({ messages: [], draft: '', pending: null, stopping: false, loaded: false, loading: false,
  clearing: false, error: '', retryable: false, progress: '', compaction: null, contextUsage: null, compactOnly: false, approval: null, webSearch: false, webSearchProvider: 'openai' });
let workspace: LibraryChatWorkspace = { conversations: [], activeId: null, sessions: {}, loaded: false, loading: false, changing: false, error: '' };
const listeners = new Set<() => void>();
const views = new Map<string, { scrollTop: number | null; visibleMessages: number }>();
let refreshGeneration = 0;
export function libraryChatWorkspace() { return workspace; }
export function libraryChatSession(id: string) { return workspace.sessions[id]; }
export function subscribeLibraryChat(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function publish(change: Partial<LibraryChatWorkspace>) { workspace = { ...workspace, ...change }; listeners.forEach(listener => listener()); }
function update(id: string, change: Partial<LibraryChatSession>) {
  const previous = workspace.sessions[id];
  if (previous) publish({ sessions: { ...workspace.sessions, [id]: { ...previous, ...change } } });
}
function acceptList(list: LibraryConversationList, restoreSelection = false) {
  const sessions = { ...workspace.sessions };
  for (const conversation of list.conversations) sessions[conversation.id] ??= emptySession();
  publish({ conversations: list.conversations, sessions, loaded: true, error: list.cleanupWarning ?? '',
    activeId: restoreSelection || !workspace.activeId ? list.activeId : workspace.activeId });
}
export function libraryChatView(id: string) { return views.get(id) ?? { scrollTop: null, visibleMessages: 50 }; }
export function saveLibraryChatView(id: string, value: { scrollTop: number | null; visibleMessages: number }) {
  if (workspace.sessions[id]) views.set(id, value);
}
export function setLibraryChatDraft(id: string, draft: string) { update(id, { draft }); }
export function setLibraryChatWebSearch(id: string, enabled: boolean) {
  const state = workspace.sessions[id];
  if (state && !state.pending && !state.approval && !state.clearing && !state.loading) update(id, { webSearch: enabled });
}
export function setLibraryChatWebSearchProvider(id: string, provider: WebSearchProvider) {
  const state = workspace.sessions[id];
  if (state && !state.pending && !state.approval && !state.clearing && !state.loading) update(id, { webSearchProvider: provider, webSearch: false });
}

export async function refreshLibraryConversations() {
  // A background reply may finish while the user is creating/selecting/renaming
  // a conversation. Do not replace that operation's newer index/selection.
  if (workspace.changing) return;
  const generation = ++refreshGeneration;
  try {
    const list = await window.paperApi!.listLibraryConversations();
    if (generation === refreshGeneration && !workspace.changing) acceptList(list);
  } catch { if (generation === refreshGeneration) publish({ error: '无法更新会话历史，原有记录已保留。请重试。' }); }
}
export async function loadLibraryConversations() {
  if (workspace.loaded || workspace.loading) return;
  publish({ loading: true, error: '' }); const generation = ++refreshGeneration;
  try {
    const list = await window.paperApi!.listLibraryConversations();
    if (generation === refreshGeneration) acceptList(list, true);
  } catch { publish({ error: '无法读取会话历史，请检查当前文献库中的 assistant 文件夹后重试。' }); }
  finally { publish({ loading: false }); }
}
export async function createLibraryChat() {
  if (workspace.changing || workspace.loading || !workspace.loaded) return;
  publish({ changing: true, error: '' }); ++refreshGeneration;
  try {
    const conversation = await window.paperApi!.createLibraryConversation();
    publish({ conversations: [conversation, ...workspace.conversations.filter(item => item.id !== conversation.id)], activeId: conversation.id,
      sessions: { ...workspace.sessions, [conversation.id]: emptySession() } });
    await loadLibraryChat(conversation.id);
  } catch { publish({ error: '新建会话失败，已有会话仍保留，请重试。' }); }
  finally { publish({ changing: false }); }
}
export async function selectLibraryChat(id: string) {
  if (workspace.changing || workspace.loading || !workspace.conversations.some(item => item.id === id)) return;
  if (workspace.activeId === id) { await loadLibraryChat(id); return; }
  publish({ changing: true, error: '' }); ++refreshGeneration;
  try { acceptList(await window.paperApi!.selectLibraryConversation(id), true); await loadLibraryChat(id); }
  catch { publish({ error: '切换会话失败，当前对话已保留，请重试。' }); }
  finally { publish({ changing: false }); }
}
export async function renameLibraryChat(id: string, title: string) {
  if (workspace.changing || !workspace.sessions[id]) throw new Error('请等待当前会话操作完成。');
  publish({ changing: true }); ++refreshGeneration;
  try {
    const conversation = await window.paperApi!.renameLibraryConversation(id, title);
    publish({ conversations: workspace.conversations.map(item => item.id === id ? conversation : item), error: '' });
  } finally { publish({ changing: false }); }
}
export async function deleteLibraryChat(id: string) {
  const state = workspace.sessions[id];
  if (workspace.changing || workspace.loading || !workspace.loaded) throw new Error('请等待当前会话操作完成后重试。');
  if (!state || !workspace.conversations.some(conversation => conversation.id === id)) throw new Error('此会话已不在历史列表中，请刷新后重试。');
  if (state.pending || state.approval) throw new Error('请先停止此会话的请求，再删除会话。');
  if (state.clearing || state.loading) throw new Error('此会话正在处理，请稍后再删除。');
  publish({ changing: true }); ++refreshGeneration;
  try {
    const list = await window.paperApi!.deleteLibraryConversation(id);
    const sessions = { ...workspace.sessions };
    delete sessions[id];
    for (const conversation of list.conversations) sessions[conversation.id] ??= emptySession();
    views.delete(id);
    publish({ conversations: list.conversations, activeId: list.activeId, sessions, loaded: true, error: list.cleanupWarning ?? '' });
  } finally { publish({ changing: false }); }
}
export async function loadLibraryChat(id: string) {
  const state = workspace.sessions[id];
  if (!state || state.loaded || state.loading) return;
  update(id, { loading: true, error: '' });
  try {
    const history = await window.paperApi!.getLibraryChatHistory(id), approval = await window.paperApi!.getLibraryChatApproval(id);
    const current = workspace.sessions[id];
    if (current && !current.loaded && !current.pending && !current.clearing) update(id, { messages: history.messages.map(message => ({ ...message, id: crypto.randomUUID() })),
      loaded: true, compaction: history.compaction ?? null, approval, error: history.contextWarning ?? '' });
  } catch { update(id, { error: '无法恢复此会话记录，请检查聊天存档后重试。' }); }
  finally { update(id, { loading: false }); }
}
export async function clearLibraryChat(id: string) {
  const state = workspace.sessions[id];
  if (!state || state.pending || state.approval || state.clearing || state.loading) return;
  update(id, { clearing: true, error: '' });
  try {
    await window.paperApi!.clearLibraryChatHistory(id);
    update(id, { messages: [], compaction: null, contextUsage: null, compactOnly: false, progress: '', error: '', retryable: false, loaded: true });
    views.delete(id); await refreshLibraryConversations();
  } catch { update(id, { error: '清空此会话失败，原有记录已保留。' }); }
  finally { update(id, { clearing: false }); }
}
function validateMessages(messages: LibraryChatMessage[]) {
  if (messages.length > MODEL_CHAT_LIMITS.messages || messages.reduce((size, message) => size + message.content.length, 0) > MODEL_CHAT_LIMITS.totalCharacters) return '聊天存档已达到安全容量上限，本次消息未发送，原始记录已保留。';
  if (messages.some(message => message.content.length > MODEL_CHAT_LIMITS.messageCharacters)) return '单条消息最多 20,000 个字符，请缩短后发送。';
  return '';
}
async function request(id: string, messages: LibraryChatMessage[], draft?: string, compactOnly = false) {
  const state = workspace.sessions[id];
  if (!state || state.pending || state.approval || state.clearing || !state.loaded) return;
  const error = validateMessages(messages);
  if (error) { update(id, { error, retryable: false }); return; }
  const requestId = crypto.randomUUID();
  // A turn uses the switch value captured when it starts; later turns may choose differently.
  const webSearch = !compactOnly && state.webSearch;
  const webSearchProvider = state.webSearchProvider;
  update(id, { messages, pending: requestId, stopping: false, error: '', retryable: false, compactOnly, approval: null,
    progress: compactOnly ? '正在整理历史摘要…' : '正在连接模型…', ...(draft === undefined ? {} : { draft }) });
  let refreshedTitle = false;
  const unsubscribe = window.paperApi!.onLibraryChatProgress(progress => {
    if (progress.conversationId === id && progress.requestId === requestId && workspace.sessions[id]?.pending === requestId) {
      update(id, { progress: progress.label, ...(progress.approval === undefined ? {} : { approval: progress.approval }) });
      if (!refreshedTitle) { refreshedTitle = true; void refreshLibraryConversations(); }
    }
  });
  try {
    const result = await window.paperApi!.chatLibrary({ conversationId: id, requestId, messages: messages.map(({ role, content }) => ({ role, content })), webSearch, webSearchProvider, ...(compactOnly ? { compactOnly: true } : {}) });
    if (workspace.sessions[id]?.pending !== requestId) return;
    const contextUpdate = { ...(result.compaction === undefined ? {} : { compaction: result.compaction }), ...(result.contextUsage === undefined ? {} : { contextUsage: result.contextUsage }) };
    if (result.ok && compactOnly) update(id, { ...contextUpdate, pending: null, stopping: false, approval: null, error: result.historyWarning ?? '', retryable: false, progress: result.message });
    else if (result.ok && result.content?.trim()) update(id, { messages: [...messages, { id: crypto.randomUUID(), role: 'assistant', content: result.content, sources: result.sources, activity: result.activity }],
      ...contextUpdate, pending: null, stopping: false, approval: null, error: result.historyWarning ?? '', retryable: false, progress: '' });
    else {
      const failure = [result.message || '模型暂未返回正文，请重试。', result.historyWarning].filter(Boolean).join(' ');
      const withActivity = result.activity?.length ? messages.map((message, index) => index === messages.length - 1 ? { ...message, activity: result.activity } : message) : messages;
      try {
        const history = await window.paperApi!.getLibraryChatHistory(id);
        const isPrefix = history.messages.length <= messages.length && history.messages.every((message, index) => message.role === messages[index].role && message.content === messages[index].content);
        const unsaved = messages.slice(history.messages.length);
        if (isPrefix && unsaved.length === 1 && unsaved[0].role === 'user') {
          update(id, { messages: history.messages.map((message, index) => ({ ...message, id: messages[index].id })),
            draft: [unsaved[0].content, workspace.sessions[id].draft].filter(Boolean).join('\n\n'), compaction: history.compaction ?? null,
            pending: null, stopping: false, approval: null, progress: '', error: failure + ' 未保存的问题已放回输入框，请修改后发送。', retryable: false });
        } else if (isPrefix && !unsaved.length) {
          const savedMessages = history.messages.map((message, index) => ({ ...message, id: messages[index].id }));
          if (result.activity?.length && savedMessages.length) savedMessages[savedMessages.length - 1] = { ...savedMessages[savedMessages.length - 1], activity: result.activity };
          update(id, { ...contextUpdate, messages: savedMessages, pending: null, stopping: false, approval: null, progress: '', error: failure, retryable: true });
        } else update(id, { messages: withActivity, pending: null, stopping: false, approval: null, progress: '', loaded: false,
          error: failure + ' 对话记录已变化，请复制保留未保存内容，再重新加载记录。', retryable: false });
      } catch { update(id, { messages: withActivity, pending: null, stopping: false, approval: null, progress: '', loaded: false,
        error: failure + ' 无法核对已保存记录，请保留当前内容，检查存档后重新加载。', retryable: false }); }
    }
  } catch {
    if (workspace.sessions[id]?.pending === requestId) update(id, { pending: null, stopping: false, approval: null, progress: '', error: '发送失败，请检查模型配置和网络后重试。', retryable: true });
  } finally { unsubscribe(); await refreshLibraryConversations(); }
}
export async function sendLibraryChat(id: string) {
  await loadLibraryChat(id); const state = workspace.sessions[id];
  if (!state) return;
  const content = state.draft.trim();
  if (/\b(?:sk-|tvly-)[A-Za-z0-9_-]{12,}|(?:api[_ -]?key|authorization)\s*[:=]\s*\S+/i.test(content)) {
    update(id, { error: '请在模型配置或搜索配置的密钥输入框填写 API Key，不要粘贴到聊天中。', retryable: false }); return;
  }
  if (content && state.loaded && !state.pending && !state.approval && !state.clearing) await request(id, [...state.messages, { id: crypto.randomUUID(), role: 'user', content }], '');
}
export async function retryLibraryChat(id: string) {
  const state = workspace.sessions[id];
  if (state?.retryable && (state.compactOnly || state.messages.at(-1)?.role === 'user')) await request(id, state.messages, undefined, state.compactOnly);
}
export async function compactLibraryChat(id: string) {
  await loadLibraryChat(id); const state = workspace.sessions[id];
  if (state?.messages.length) await request(id, state.messages, undefined, true);
}
export async function stopLibraryChat(id: string) {
  const state = workspace.sessions[id], requestId = state?.pending ?? state?.approval?.requestId;
  if (!state || !requestId || state.stopping) return;
  update(id, { stopping: true });
  try {
    await window.paperApi!.cancelLibraryChat(requestId);
    if (!workspace.sessions[id]?.pending) update(id, { stopping: false, approval: null, progress: '', loaded: false });
  } catch { update(id, { stopping: false, error: '停止失败，请重试。' }); }
}
export async function decideLibraryChat(decision: LibraryChatDecision) {
  const id = decision.conversationId, state = id ? workspace.sessions[id] : undefined;
  if (!id || !state?.approval || decision.id !== state.approval.id || decision.requestId !== state.approval.requestId) throw new Error('这项操作已结束，请查看最新对话。');
  await window.paperApi!.resolveLibraryChatApproval(decision);
  if (workspace.sessions[id]?.approval?.id === decision.id) update(id, { approval: null, progress: decision.approved ? '操作已确认，正在继续…' : '已取消这项操作，正在继续…' });
}
export function libraryChatMemory(id: string) {
  const state = workspace.sessions[id];
  return state?.compaction?.paperId === id && state.compaction.coveredMessages <= state.messages.length ? state.compaction : null;
}
