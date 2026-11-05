import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { load, loadBuffer } from 'cheerio';

const MAX_BYTES = 2 * 1024 * 1024, MAX_TEXT = 200000, MAX_REDIRECTS = 4;
const TIMEOUT_MS = 20000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
export class WebReadError extends Error {}
const fail = (message: string): never => { throw new WebReadError(message); };

function ipv6Number(value: string): bigint {
  const sides = value.split('::'), left = sides[0] ? sides[0].split(':') : [], right = sides[1] ? sides[1].split(':') : [];
  const words = sides.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return words.reduce((total, word) => (total << 16n) | BigInt(parseInt(word, 16)), 0n);
}
function inV6(value: bigint, prefix: string, bits: number) { return value >> BigInt(128 - bits) === ipv6Number(prefix) >> BigInt(128 - bits); }

/** Conservative public-unicast check; transition/mapped addresses cannot conceal private IPv4 targets.
 * Special-use ranges: https://www.iana.org/assignments/iana-ipv4-special-registry/
 * and https://www.iana.org/assignments/iana-ipv6-special-registry/ . */
export function isPublicWebAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (version !== 6 || address.includes('%') || address.includes('.')) return false;
  const value = ipv6Number(address);
  return inV6(value, '2000::', 3) && !inV6(value, '2001::', 23) && !inV6(value, '2001:db8::', 32)
    && !inV6(value, '2002::', 16) && !inV6(value, '3fff::', 20);
}

/** Syntax/literal validation only. DNS destinations are revalidated and pinned before every request. */
export function publicWebUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value)) return fail('请输入完整的公开 HTTP(S) 网页地址。');
  let url: URL;
  try { url = new URL(value); } catch { return fail('网页地址格式不正确。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return fail('只允许不含账号密码的标准 HTTP(S) 网页地址。');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || !hostname.includes('.') && !isIP(hostname)
    || /\.(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(hostname)
    || (isIP(hostname) && !isPublicWebAddress(hostname))) return fail('不能读取本机、内网或特殊网络地址。');
  url.hash = '';
  return url;
}

export interface WebAddress { address: string; family: number }
export interface WebHopRequest { url: URL; address: WebAddress; signal: AbortSignal; maxBytes: number }
export interface WebHopResponse { status: number; headers: Record<string, string | string[] | undefined>; body: Uint8Array }
/** Injection is only available to trusted main-process callers/tests; no renderer/env bypass exists. */
export interface WebReaderDependencies {
  resolve?: (hostname: string) => Promise<WebAddress[]>;
  request?: (input: WebHopRequest) => Promise<WebHopResponse>;
}
export interface WebFetchOptions { signal: AbortSignal; maxBytes?: number; timeoutMs?: number }
function header(headers: WebHopResponse['headers'], key: string) {
  const value = headers[key] ?? Object.entries(headers).find(([name]) => name.toLowerCase() === key)?.[1];
  return typeof value === 'string' ? value : Array.isArray(value) ? value.join(',') : '';
}
function textual(headers: WebHopResponse['headers']) {
  if (/attachment/i.test(header(headers, 'content-disposition'))) return fail('此链接是下载附件，请提供公开网页。');
  const type = header(headers, 'content-type').split(';')[0].trim().toLowerCase();
  if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(type)) return fail('此链接不是可读取的网页或纯文本；暂不下载 PDF、图片或其他文件。');
  const encoding = header(headers, 'content-encoding').trim().toLowerCase();
  if (encoding && encoding !== 'identity') return fail('网页返回了不支持的压缩内容，请换一个来源。');
  return type;
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function requestPinned({ url, address, signal, maxBytes }: WebHopRequest): Promise<WebHopResponse> {
  return new Promise((resolve, reject) => {
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      // No second DNS resolution and no pooled socket can silently change the approved destination.
      if (options.all) callback(null, [address]); else callback(null, address.address, address.family);
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', agent: false, lookup: pinnedLookup, family: address.family, signal,
      headers: { 'User-Agent': 'PaperTimeline/0.1 (public-page-reader)', Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9', 'Accept-Encoding': 'identity' },
      maxHeaderSize: 32768,
    }, response => {
      const status = response.statusCode ?? 0, headers = response.headers;
      if (REDIRECTS.has(status)) { resolve({ status, headers, body: new Uint8Array() }); response.destroy(); return; }
      try {
        if (status < 200 || status >= 300) fail(`网页读取失败（HTTP ${status}）。`);
        textual(headers);
        const size = Number(header(headers, 'content-length'));
        if (Number.isFinite(size) && size > maxBytes) fail('网页内容过大，已停止读取。');
      } catch (error) { reject(error); response.destroy(); return; }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { reject(new WebReadError('网页内容过大，已停止读取。')); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.once('end', () => resolve({ status, headers, body: Buffer.concat(chunks) }));
      response.once('error', reject);
      response.once('aborted', () => reject(new WebReadError('网页传输中断，请稍后重试。')));
    });
    request.once('error', reject);
    request.end();
  });
}

export async function fetchPublicWebText(value: string, options: WebFetchOptions, dependencies: WebReaderDependencies = {}) {
  let current = publicWebUrl(value);
  const maxBytes = options.maxBytes ?? MAX_BYTES, timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) fail('网页读取参数不正确。');
  options.signal.throwIfAborted();
  const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), timeoutMs);
  const signal = AbortSignal.any([options.signal, timeout.signal]);
  try {
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted();
      const hostname = current.hostname.replace(/^\[|\]$/g, '');
      const version = isIP(hostname);
      const addresses = version ? [{ address: hostname, family: version }]
        : await abortable((dependencies.resolve ?? (name => lookup(name, { all: true, verbatim: true })))(hostname), signal);
      if (!addresses.length || addresses.some(item => !isPublicWebAddress(item.address) || isIP(item.address) !== item.family)) fail('网页地址未解析为可访问的公网地址。');
      // All answers must be public; prefer IPv4 for networks without working IPv6, without DNS retries.
      const address = addresses.find(item => item.family === 4) ?? addresses[0];
      const response = await abortable((dependencies.request ?? requestPinned)({ url: current, address, signal, maxBytes }), signal);
      if (REDIRECTS.has(response.status)) {
        if (redirects >= MAX_REDIRECTS) fail('网页重定向次数过多，已停止读取。');
        const location = header(response.headers, 'location');
        if (!location) fail('网页重定向地址缺失。');
        let next: URL;
        try { next = new URL(location, current); } catch { return fail('网页重定向地址不正确。'); }
        if (current.protocol === 'https:' && next.protocol !== 'https:') fail('网页重定向到不安全的连接，已停止读取。');
        current = publicWebUrl(next.toString());
        continue;
      }
      if (response.status < 200 || response.status >= 300) fail(`网页读取失败（HTTP ${response.status}）。`);
      const contentType = textual(response.headers);
      if (response.body.byteLength > maxBytes) fail('网页内容过大，已停止读取。');
      const body = Buffer.from(response.body);
      const text = contentType === 'text/plain' ? new TextDecoder('utf-8').decode(body) : loadBuffer(body).html();
      return { url: current.toString(), contentType, text };
    }
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason;
    if (timeout.signal.aborted) return fail('网页读取超时，请稍后重试或换一个来源。');
    if (error instanceof WebReadError) throw error;
    return fail('无法连接此网页，请检查网络或换一个公开来源。');
  } finally { clearTimeout(timer); }
}

export interface WebPageReadOptions { signal: AbortSignal; offset?: number; maxCharacters?: number }
export interface PublicWebPage {
  url: string; title: string; content: string; offset: number; nextOffset: number | null;
  totalCharacters: number; truncated: boolean; retrievedAt: string;
}
export async function readPublicWebPage(value: string, options: WebPageReadOptions, dependencies: WebReaderDependencies = {}): Promise<PublicWebPage> {
  const offset = options.offset ?? 0, maximum = options.maxCharacters ?? 12000;
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_TEXT || !Number.isInteger(maximum) || maximum < 1 || maximum > 20000) fail('网页分页参数不正确。');
  const page = await fetchPublicWebText(value, options, dependencies);
  let text = page.text, title = new URL(page.url).hostname;
  if (page.contentType !== 'text/plain') {
    const $ = load(page.text);
    title = $('title').first().text().replace(/\s+/g, ' ').trim().slice(0, 300) || title;
    $('script,style,noscript,template,iframe,svg,canvas,form,nav,header,footer,aside,[hidden],[aria-hidden="true"]').remove();
    $('[style]').each((_index, node) => { if (/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test($(node).attr('style') ?? '')) $(node).remove(); });
    $('br').replaceWith('\n');
    $('p,div,section,article,main,li,blockquote,pre,h1,h2,h3,h4,h5,h6,tr').append('\n');
    const candidates = $('main,article,[role="main"]').toArray().map(node => $(node).text()).sort((a, b) => b.length - a.length);
    text = candidates[0]?.trim().length >= 200 ? candidates[0] : $('body').text();
  }
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/[ \t\r\f\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) fail('没有提取到可读取的正文；该网页可能需要登录或 JavaScript。');
  const sourceTruncated = text.length > MAX_TEXT;
  text = text.slice(0, MAX_TEXT);
  if (offset > text.length) fail('网页分页位置超出正文范围，请从头重新读取。');
  const end = Math.min(text.length, offset + maximum);
  return { url: page.url, title, content: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null,
    totalCharacters: text.length, truncated: sourceTruncated || end < text.length, retrievedAt: new Date().toISOString() };
}
