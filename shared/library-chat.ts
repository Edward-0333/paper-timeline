import type { ModelChatHistory, ModelChatRequest, ModelChatResult } from './model-chat';
import type { WebSearchProvider } from './web-search';

// Internal conversation identity only. Never resolves to a paper or expands PDF Agent access.
export const LIBRARY_CHAT_ID = '29f6c753bb5786df6a57f385b149468418ac895157073f3ef1c13e9ce82ab362';
export type LibraryChatRequest = Omit<ModelChatRequest, 'paperId'> & { conversationId?: string; webSearch?: boolean; webSearchProvider?: WebSearchProvider };
export interface LibraryConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}
export interface LibraryConversationList { conversations: LibraryConversation[]; activeId: string | null; cleanupWarning?: string }
export type LibraryChatHistory = ModelChatHistory;
export type LibraryChatResult = ModelChatResult;
export interface LibraryModelDraft { name: string; baseUrl: string; model: string; contextWindowTokens?: number }
export interface LibraryChangePreview { operation: string; description: string; before?: unknown; after?: unknown }
export interface LibraryChatApproval {
  id: string;
  requestId: string;
  conversationId: string;
  title: string;
  description: string;
  changes: LibraryChangePreview[];
  modelDraft?: LibraryModelDraft;
  modelEdit?: { profileId: string };
}
export interface LibraryChatDecision {
  id: string;
  requestId: string;
  conversationId?: string;
  approved: boolean;
  // Only entered in a masked local form, never forwarded to the chat provider or archive.
  apiKey?: string;
  withoutApiKey?: boolean;
}
export interface LibraryChatProgress { requestId: string; conversationId: string; label: string; approval?: LibraryChatApproval | null }
export type LibraryApprovalDraft = Omit<LibraryChatApproval, 'id' | 'requestId' | 'conversationId'>;
