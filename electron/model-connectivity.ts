import { modelBaseUrl, type ModelConnectionResult } from '../shared/model-settings';

interface ConnectionTarget { baseUrl: string; model: string; apiKey: string }
export interface ConnectionOptions { timeoutMs?: number; signal?: AbortSignal }
const MAX_RESPONSE = 256 * 1024;
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('aborted'));
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function readBody(response: Response, signal: AbortSignal) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE) { void response.body?.cancel().catch(() => {}); throw new Error('response-too-large'); }
  if (!response.body) throw new Error('invalid-response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE) throw new Error('response-too-large');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { cancel(); throw error; }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
export type CompletionLimit = 'max_completion_tokens' | 'max_tokens';
export function unsupportedLimit(body: any, field: CompletionLimit = 'max_completion_tokens') {
  const error = body?.error;
  if (!error || typeof error !== 'object' || (error.param != null && error.param !== field)) return false;
  if (error.param === field && ['unsupported_parameter', 'unknown_parameter', 'unrecognized_parameter'].includes(error.code)) return true;
  const message = typeof error.message === 'string' ? error.message.slice(0, 4096) : '';
  const rejectedField = message.match(/\b(max_completion_tokens|max_tokens)\b/i)?.[1];
  return (error.param === field || rejectedField === field) && /unsupported|not supported|unrecognized|unknown (?:argument|parameter)|不支持|未知参数/i.test(message);
}
function httpError(status: number, body: any) {
  // Never display arbitrary provider text: it may echo Authorization headers or HTML.
  const code = body?.error?.code;
  if (['insufficient_quota', 'quota_exceeded', 'insufficient_balance'].includes(code)) return `测试失败：账户额度或余额不足（HTTP ${status}），请检查服务商账户。`;
  if (code === 'model_not_found') return `测试失败：模型不存在或当前账号无权使用（HTTP ${status}），请检查模型名称。`;
  if (status === 401) return '测试失败：API Key 无效或已失效（HTTP 401）。';
  if (status === 403) return '测试失败：访问被拒绝（HTTP 403），请检查账号和模型权限。';
  if (status === 404) return '测试失败：未找到模型或接口（HTTP 404），请检查 Base URL 和模型名称。';
  if (status === 429) return '测试失败：请求限流或账户额度不足（HTTP 429），请检查服务商账户后重试。';
  if (status === 400 || status === 422) return `测试失败：服务拒绝了测试请求（HTTP ${status}），请检查模型是否支持 Chat Completions 及请求参数。`;
  if (status >= 500) return `测试失败：模型服务暂时不可用（HTTP ${status}），请稍后重试。`;
  return `测试失败：服务返回 HTTP ${status}，请检查接口配置。`;
}
function validCompletion(body: any) {
  if (!body || body.error || !Array.isArray(body.choices)) return false;
  return body.choices.some((choice: any) => {
    const message = choice?.message;
    if (!message || typeof message !== 'object' || Array.isArray(message) || (message.role !== undefined && message.role !== 'assistant')) return false;
    return (typeof message.content === 'string' && !!message.content.trim())
      || (Array.isArray(message.content) && message.content.some((part: any) => part?.type === 'text' && typeof part.text === 'string' && !!part.text.trim()))
      || (typeof message.refusal === 'string' && !!message.refusal.trim()) || choice.finish_reason === 'length';
  });
}

/** A bounded, explicit probe. No paper data, raw provider replies or credentials leave this module as results. */
export async function probeModelConnection(target: ConnectionTarget, fetcher: typeof fetch, options: ConnectionOptions = {}): Promise<ModelConnectionResult> {
  const started = performance.now(), controller = new AbortController(); let timedOut = false;
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('无效测试超时设置');
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const result = (ok: boolean, message: string): ModelConnectionResult => ({ ok, message, latencyMs: Math.max(0, Math.round(performance.now() - started)), testedAt: new Date().toISOString() });
  try {
    const baseUrl = modelBaseUrl(target.baseUrl);
    if (typeof target.model !== 'string' || !target.model.trim() || target.model.length > 256 || /[\x00-\x1f\x7f]/.test(target.model)
      || typeof target.apiKey !== 'string' || target.apiKey.length > 8192 || /[\x00-\x1f\x7f]/.test(target.apiKey)) return result(false, '测试失败：模型名称或 API Key 格式不正确。');
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (controller.signal.aborted) throw new Error('aborted');
      const payload = { model: target.model.trim(), messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false,
        ...(attempt === 0 ? { max_completion_tokens: 16 } : { max_tokens: 16 }) };
      const response = await abortable(fetcher(baseUrl + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(payload),
        signal: controller.signal, redirect: 'manual', credentials: 'omit' }), controller.signal);
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error('aborted'); }
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {});
        return result(false, '测试失败：接口发生重定向，请填写最终的 API 地址后重试。');
      }
      let body: any;
      try { body = await readBody(response, controller.signal); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        if (!response.ok) return result(false, httpError(response.status, null));
        return result(false, error instanceof Error && error.message === 'response-too-large' ? '测试失败：服务响应过大，请检查是否填写了正确的 API 地址。'
          : '测试失败：服务未返回有效的模型 JSON 响应，请检查是否误填了网页地址。');
      }
      if (response.status === 400 && attempt === 0 && unsupportedLimit(body)) continue;
      if (!response.ok) return result(false, httpError(response.status, body));
      if (!validCompletion(body)) return result(false, '测试失败：服务未返回有效的 Chat Completions 模型响应，请检查 API 地址和模型名称。');
      return result(true, '连接成功，所选模型已响应。');
    }
    return result(false, '测试失败：模型服务不支持测试请求。');
  } catch (error) {
    if (controller.signal.aborted) return result(false, timedOut ? '测试超时，请检查网络、代理及模型服务状态后重试。' : '测试已取消。');
    const code = (error as any)?.cause?.code ?? (error as any)?.code;
    if ((typeof code === 'string' && /CERT|SSL|TLS/.test(code)) || (error instanceof Error && /ERR_CERT_|CERT_|SSL_|TLS_/.test(error.message))) return result(false, '测试失败：HTTPS 证书验证失败，请检查服务证书或网络代理。');
    return result(false, '测试失败：无法连接模型服务，请检查 API 地址、网络和代理设置。');
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
