export interface ModelChatMessage { role: 'user' | 'assistant'; content: string }
export interface ModelChatRequest { paperId: string; requestId: string; messages: ModelChatMessage[]; compactOnly?: boolean }
export interface ModelChatContext {
  paperId: string;
  paperTitle: string;
  workingDirectory: string;
  files: { pdf: string | null; markdown: string | null; annotations: string | null; parsedDirectory: string | null };
}
export interface AgentSource { id: string; label: string; url?: string; retrievedAt?: string; kind?: 'web-search' | 'web-page' }
export interface AgentActivity { tool: string; label: string; status: 'succeeded' | 'failed' }
export interface ModelChatProgress { paperId: string; requestId: string; label: string }
export interface StoredChatMessage extends ModelChatMessage { sources?: AgentSource[]; activity?: AgentActivity[] }
export interface ChatCompaction {
  version: 1;
  paperId: string;
  summary: string;
  coveredMessages: number;
  prefixHash: string;
  updatedAt: string;
  model: string;
}
export interface ChatContextUsage {
  estimatedTokens: number;
  contextWindowTokens: number;
  inputBudgetTokens: number;
  coveredMessages: number;
  compacted: boolean;
  updatedAt?: string;
}
export interface ModelChatHistory { messages: StoredChatMessage[]; compaction?: ChatCompaction | null; contextWarning?: string }
export interface ModelChatResult {
  ok: boolean; content?: string; message: string; cancelled?: boolean; model?: string;
  sources?: AgentSource[]; activity?: AgentActivity[]; historyWarning?: string;
  compaction?: ChatCompaction | null; contextUsage?: ChatContextUsage;
}
// Archive/IPC bounds, not the model's context window. Never silently discard old turns.
export const MODEL_CHAT_LIMITS = { messages: 10000, messageCharacters: 20000, totalCharacters: 10000000 } as const;
export const DEFAULT_CONTEXT_WINDOW = 32768;
export function contextWindowTokens(value?: number) { return value ?? DEFAULT_CONTEXT_WINDOW; }
export function validContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 8192 && value <= 2000000;
}
/** Conservative estimate, not a provider tokenizer. Non-ASCII text needs extra room. */
export function estimateTextTokens(text: string): number {
  let ascii = 0, other = 0;
  for (const character of text) character.codePointAt(0)! < 128 ? ascii++ : other++;
  return Math.ceil(ascii / 3 + other * 2);
}
export function chatOutputBudget(window: number): number { return Math.min(4096, Math.floor(window / 4)); }
export function chatInputBudget(window: number): number { return Math.max(2048, Math.floor((window - chatOutputBudget(window)) * 0.75)); }

export function validChatRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value);
}

/** Accept a paper identity and conversation only. Paths and system messages are resolved by the desktop. */
export function validateChatRequest(value: unknown): ModelChatRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some(key => !['paperId', 'requestId', 'messages', 'compactOnly'].includes(key)) || !validChatRequestId(request.requestId)
    || (request.compactOnly !== undefined && typeof request.compactOnly !== 'boolean')
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
  if (!request.compactOnly && messages[messages.length - 1].role !== 'user') return null;
  return { paperId: request.paperId, requestId: request.requestId, messages, ...(request.compactOnly ? { compactOnly: true } : {}) };
}
