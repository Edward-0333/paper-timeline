export type WebSearchProvider = 'openai' | 'tavily';
export interface WebSearchConfiguration { provider: 'tavily'; configured: boolean; hasApiKey: boolean }
export interface WebSearchConfigurationInput { apiKey?: string }
export interface WebSearchConnectionResult { ok: boolean; message: string; durationMs: number }
export const emptyWebSearchConfiguration = (): WebSearchConfiguration => ({ provider: 'tavily', configured: false, hasApiKey: false });
