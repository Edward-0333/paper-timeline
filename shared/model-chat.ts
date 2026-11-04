export interface ModelChatMessage { role: 'user' | 'assistant'; content: string }
export interface ModelChatRequest { paperId: string; requestId: string; messages: ModelChatMessage[] }
export interface ModelChatContext {
  paperId: string;
  paperTitle: string;
  workingDirectory: string;
  files: { pdf: string | null; markdown: string | null; annotations: string | null; parsedDirectory: string | null };
}
export interface AgentSource { id: string; label: string }
export interface AgentActivity { tool: string; label: string; status: 'succeeded' | 'failed' }
export interface ModelChatProgress { paperId: string; requestId: string; label: string }
export interface StoredChatMessage extends ModelChatMessage { sources?: AgentSource[]; activity?: AgentActivity[] }
export interface ModelChatHistory { messages: StoredChatMessage[] }
export interface ModelChatResult {
  ok: boolean; content?: string; message: string; cancelled?: boolean; model?: string;
  sources?: AgentSource[]; activity?: AgentActivity[]; historyWarning?: string;
}
export const MODEL_CHAT_LIMITS = { messages: 64, messageCharacters: 20000, totalCharacters: 100000 } as const;

export function validChatRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value);
}

/** Accept a paper identity and conversation only. Paths and system messages are resolved by the desktop. */
export function validateChatRequest(value: unknown): ModelChatRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some(key => !['paperId', 'requestId', 'messages'].includes(key)) || !validChatRequestId(request.requestId)
    || typeof request.paperId !== 'string' || !/^[a-f0-9]{64}$/.test(request.paperId)
    || !Array.isArray(request.messages) || !request.messages.length || request.messages.length > MODEL_CHAT_LIMITS.messages) return null;
  const messages: ModelChatMessage[] = []; let size = 0;
  for (const item of request.messages) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['role', 'content'].includes(key))
      || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || !item.content.trim()
      || item.content.length > MODEL_CHAT_LIMITS.messageCharacters || /\x00/.test(item.content)) return null;
    size += item.content.length;
    if (size > MODEL_CHAT_LIMITS.totalCharacters) return null;
    messages.push({ role: item.role, content: item.content });
  }
  if (messages[messages.length - 1].role !== 'user') return null;
  return { paperId: request.paperId, requestId: request.requestId, messages };
}
