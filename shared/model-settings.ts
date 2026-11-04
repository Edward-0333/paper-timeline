export interface ModelProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  updatedAt: string;
}
export interface ModelConfiguration extends Omit<ModelProfile, 'id' | 'updatedAt'> {
  configured: boolean;
  updatedAt: string | null;
  activeId: string | null;
  profiles: ModelProfile[];
}
export interface ModelConfigurationInput {
  /** null starts a new profile. Older callers omit this to edit the active profile. */
  profileId?: string | null;
  name: string;
  baseUrl: string;
  model: string;
  /** Empty/omitted preserves the existing key only when the API address is unchanged. */
  apiKey?: string;
  withoutApiKey: boolean;
}
export interface ModelConnectionResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  testedAt: string;
}
export const emptyModelConfiguration = (): ModelConfiguration => ({ configured: false, name: '', baseUrl: '', model: '', hasApiKey: false, updatedAt: null, activeId: null, profiles: [] });
export function modelBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\x00-\x20\x7f]/.test(value.trim())) throw new Error('请填写有效的 API 接口地址');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('请填写完整的 http:// 或 https:// 接口地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('接口地址仅支持 HTTP 或 HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new Error('接口地址不能包含账号密码、查询参数或片段');
  return url.toString().replace(/\/+$/, '');
}
