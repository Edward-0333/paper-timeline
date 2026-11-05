import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelCipher } from './model-settings';
import { assertRegularFile, assertSafeDirectory } from './paper-storage';
import { emptyWebSearchConfiguration, type WebSearchConfiguration, type WebSearchConfigurationInput, type WebSearchConnectionResult } from '../shared/web-search';

const ENDPOINT = 'https://api.tavily.com/search';
const MAX_CONFIG = 64 * 1024, MAX_RESPONSE = 1024 * 1024;
interface SearchSecret { version: 1; provider: 'tavily'; apiKey: string | null; updatedAt: string }
export interface WebSearchResult { title: string; url: string; content: string; publishedDate?: string }
export interface WebSearchResponse { results: WebSearchResult[]; retrievedAt: string }
type SearchErrorCode = 'invalid-input' | 'http' | 'redirect' | 'invalid-response' | 'response-too-large' | 'network' | 'timeout' | 'cancelled';
export class WebSearchError extends Error {
  constructor(readonly code: SearchErrorCode, message: string) { super(message); this.name = 'WebSearchError'; }
}
function validKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[^\x21-\x7e]/.test(value);
}
function inputKey(input: WebSearchConfigurationInput) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'apiKey')
    || (input.apiKey !== undefined && typeof input.apiKey !== 'string')) throw new Error('搜索配置参数不正确。');
  const value = input.apiKey?.trim() ?? '';
  if (value && !validKey(value)) throw new Error('搜索 API Key 格式不正确。');
  return value;
}
function publicStatus(secret: SearchSecret | null): WebSearchConfiguration {
  return { provider: 'tavily', configured: !!secret?.apiKey, hasApiKey: !!secret?.apiKey };
}
async function safeFile(path: string, allowMissing = true) {
  await assertRegularFile(path, allowMissing);
  try { if ((await lstat(path)).nlink > 1) throw new Error('搜索配置不能使用文件链接。'); }
  catch (error) { if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** Search credentials are encrypted locally and never returned through desktop status APIs. */
export class WebSearchSettings {
  readonly file: string;
  private writes: Promise<unknown> = Promise.resolve();
  private connectionTest?: { controller: AbortController; done: Promise<WebSearchConnectionResult> };
  constructor(private directory: string, private cipher: ModelCipher) { this.file = join(directory, 'web-search-config.bin'); }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writes.catch(() => {}).then(fn); this.writes = next; return next;
  }
  private async check() { await assertSafeDirectory(this.directory); await safeFile(this.file); await safeFile(this.file + '.bak'); }
  private async read(): Promise<SearchSecret | null> {
    await this.check();
    let bytes: Buffer;
    try {
      if ((await lstat(this.file)).size > MAX_CONFIG) throw new Error('oversized');
      bytes = await readFile(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try { await lstat(this.file + '.bak'); }
        catch (backupError) { if ((backupError as NodeJS.ErrnoException).code === 'ENOENT') return null; throw backupError; }
      }
      throw new Error('无法读取搜索配置，原有配置及备份已保留。');
    }
    if (!this.cipher.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法读取搜索配置。');
    try {
      if (bytes.length > MAX_CONFIG) throw new Error('oversized');
      const value: unknown = JSON.parse(this.cipher.decryptString(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('schema');
      const stored = value as Record<string, unknown>;
      if (Object.keys(stored).some(key => !['version', 'provider', 'apiKey', 'updatedAt'].includes(key))
        || stored.version !== 1 || stored.provider !== 'tavily' || (stored.apiKey !== null && !validKey(stored.apiKey))
        || typeof stored.updatedAt !== 'string' || stored.updatedAt.length > 40 || !Number.isFinite(Date.parse(stored.updatedAt))) throw new Error('schema');
      return stored as unknown as SearchSecret;
    } catch { throw new Error('无法读取或解密搜索配置，原有配置及备份已保留。'); }
  }
  status() { return this.serialize(async () => publicStatus(await this.read())); }
  /** Internal main-process snapshot. Do not expose it over IPC or include it in model context. */
  snapshot(): Promise<{ apiKey: string } | null> {
    return this.serialize(async () => { const stored = await this.read(); return stored?.apiKey ? { apiKey: stored.apiKey } : null; });
  }
  private async write(next: SearchSecret) {
    if (!this.cipher.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，未保存搜索配置。');
    let encrypted: Buffer;
    try { encrypted = this.cipher.encryptString(JSON.stringify(next)); }
    catch { throw new Error('无法加密搜索配置，原有配置已保留。'); }
    await this.check(); await mkdir(this.directory, { recursive: true }); await assertSafeDirectory(this.directory);
    const temporary = join(this.directory, 'web-search-' + randomUUID() + '.tmp');
    try {
      await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
      try { await copyFile(this.file, this.file + '.bak'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await rename(temporary, this.file);
    } catch { throw new Error('搜索配置保存失败，原有配置已保留，请检查文件权限。'); }
    finally { await unlink(temporary).catch(() => {}); }
    return publicStatus(next);
  }
  save(input: WebSearchConfigurationInput) {
    return this.serialize(async () => {
      const key = inputKey(input), stored = await this.read(), apiKey = key || stored?.apiKey;
      if (!apiKey) throw new Error('请填写 Tavily 搜索 API Key。');
      return this.write({ version: 1, provider: 'tavily', apiKey, updatedAt: new Date().toISOString() });
    });
  }
  clear() {
    return this.serialize(async () => {
      // Read first so damaged credentials are not silently overwritten by a clear request.
      await this.read();
      await this.write({ version: 1, provider: 'tavily', apiKey: null, updatedAt: new Date().toISOString() });
      // The committed empty file keeps the setting cleared even if backup cleanup is interrupted.
      await safeFile(this.file + '.bak');
      try { await unlink(this.file + '.bak'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('搜索配置已清除，但加密备份尚未清理，请解除文件占用后重试。'); }
      return emptyWebSearchConfiguration();
    });
  }
  async testConnection(input: WebSearchConfigurationInput, fetcher: typeof fetch): Promise<WebSearchConnectionResult> {
    if (this.connectionTest) throw new Error('正在测试搜索连接，请稍候或取消当前测试。');
    const controller = new AbortController(), started = performance.now();
    const result = (ok: boolean, message: string): WebSearchConnectionResult => ({ ok, message, durationMs: Math.max(0, Math.round(performance.now() - started)) });
    const done = (async () => {
      const apiKey = await this.serialize(async () => {
        const draft = inputKey(input), saved = await this.read(), key = draft || saved?.apiKey;
        if (!key) throw new Error('请填写 Tavily 搜索 API Key。');
        return key;
      });
      try {
        await searchWeb('Tavily search API', apiKey, fetcher, controller.signal);
        return result(true, '搜索连接成功，已完成一次测试搜索。');
      } catch (error) { return result(false, error instanceof WebSearchError ? error.message : '搜索连接测试失败，请检查网络和配置。'); }
    })();
    this.connectionTest = { controller, done };
    try { return await done; }
    finally { if (this.connectionTest?.controller === controller) this.connectionTest = undefined; }
  }
  cancelConnectionTest() { this.connectionTest?.controller.abort(); }
  async whenIdle() { await this.writes.catch(() => {}); await this.connectionTest?.done.catch(() => {}); }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('aborted'));
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function responseJson(response: Response, signal: AbortSignal) {
  const type = response.headers.get('content-type');
  if (type && !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(type)) throw new WebSearchError('invalid-response', '搜索服务未返回有效的 JSON 结果。');
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE) throw new WebSearchError('response-too-large', '搜索结果超过单次读取上限，请缩小搜索范围。');
  if (!response.body) throw new WebSearchError('invalid-response', '搜索服务返回了空响应。');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_RESPONSE) throw new WebSearchError('response-too-large', '搜索结果超过单次读取上限，请缩小搜索范围。');
      chunks.push(part.value);
    }
    signal.throwIfAborted();
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new WebSearchError('invalid-response', '搜索服务未返回有效的 JSON 结果。'); }
  } catch (error) { cancel(); throw error; }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
function httpFailure(status: number) {
  if (status === 401 || status === 403) return `搜索 API Key 无效或无访问权限（HTTP ${status}），请检查搜索配置。`;
  if (status === 429) return '搜索请求过于频繁或额度不足（HTTP 429），请稍后重试。';
  if ([432, 433].includes(status)) return `搜索账户额度已达到上限（HTTP ${status}），请检查 Tavily 账户。`;
  if (status >= 500) return `搜索服务暂时不可用（HTTP ${status}），请稍后重试。`;
  return `搜索请求失败（HTTP ${status}），请检查搜索服务状态。`;
}
function resultsOf(body: unknown): WebSearchResult[] {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray((body as any).results)
    || (body as any).error || (body as any).results.length > 20) throw new WebSearchError('invalid-response', '搜索服务未返回有效的搜索结果。');
  const results: WebSearchResult[] = [];
  for (const item of (body as any).results) {
    if (!item || typeof item !== 'object' || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 4000
      || typeof item.url !== 'string' || item.url.length > 4096 || typeof item.content !== 'string' || item.content.length > MAX_RESPONSE
      || (item.published_date != null && (typeof item.published_date !== 'string' || item.published_date.length > 100))) {
      throw new WebSearchError('invalid-response', '搜索服务返回的结果格式不正确。');
    }
    let url: URL;
    try { url = new URL(item.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('url'); }
    catch { continue; }
    if (results.length >= 5) break;
    results.push({ title: item.title.trim().slice(0, 500), url: url.href, content: item.content.slice(0, 8000),
      ...(item.published_date ? { publishedDate: item.published_date } : {}) });
  }
  return results;
}

/** Fixed-provider search: no user data besides the explicit query, no cookies, redirects or raw errors. */
export async function searchWeb(query: string, apiKey: string, fetcher: typeof fetch, signal: AbortSignal,
  options: { timeoutMs?: number } = {}): Promise<WebSearchResponse> {
  if (typeof query !== 'string' || !query.trim() || query.length > 400 || /[\x00-\x1f\x7f]/.test(query) || !validKey(apiKey)) {
    throw new WebSearchError('invalid-input', '搜索词或搜索 API Key 格式不正确。');
  }
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) throw new WebSearchError('invalid-input', '搜索超时设置不正确。');
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let response: Response | undefined;
  try {
    controller.signal.throwIfAborted();
    const pending = Promise.resolve().then(() => fetcher(ENDPOINT, { method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${apiKey}`,
    }, body: JSON.stringify({ query: query.trim(), search_depth: 'basic', topic: 'general', max_results: 5,
      include_answer: false, include_raw_content: false, include_images: false, auto_parameters: false }),
    redirect: 'manual', credentials: 'omit', signal: controller.signal }));
    void pending.then(late => { if (controller.signal.aborted) void late.body?.cancel().catch(() => {}); }, () => {});
    response = await abortable(pending, controller.signal); controller.signal.throwIfAborted();
    if (response.status >= 300 && response.status < 400) throw new WebSearchError('redirect', '搜索服务发生异常重定向，本次请求已停止。');
    if (!response.ok) throw new WebSearchError('http', httpFailure(response.status));
    const redact = (value: string) => value.split(apiKey).join('[已隐藏密钥]');
    const results = resultsOf(await responseJson(response, controller.signal)).filter(item => !item.url.includes(apiKey))
      .map(item => ({ ...item, title: redact(item.title), content: redact(item.content),
        ...(item.publishedDate ? { publishedDate: redact(item.publishedDate) } : {}) }));
    return { results, retrievedAt: new Date().toISOString() };
  } catch (error) {
    if (controller.signal.aborted) throw new WebSearchError(timedOut ? 'timeout' : 'cancelled', timedOut ? '搜索超时，请检查网络或稍后重试。' : '联网搜索已取消。');
    if (error instanceof WebSearchError) throw error;
    throw new WebSearchError('network', '无法连接搜索服务，请检查网络、代理和服务状态。');
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); void response?.body?.cancel().catch(() => {}); }
}
