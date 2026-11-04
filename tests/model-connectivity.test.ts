import test from 'node:test';
import assert from 'node:assert/strict';
import { probeModelConnection } from '../electron/model-connectivity';

const target = { baseUrl: 'https://models.example.test/v1', model: 'fixture-chat-model', apiKey: 'fixture-secret-never-return' };
const complete = { choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const mock = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) => (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
function assertResult(result: Awaited<ReturnType<typeof probeModelConnection>>, ok: boolean) {
  assert.equal(result.ok, ok);
  assert.equal(typeof result.message, 'string'); assert.ok(result.message.length > 0);
  assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
  assert.ok(Number.isFinite(Date.parse(result.testedAt)));
  assert.equal(JSON.stringify(result).includes(target.apiKey), false);
}

test('model connection probes the configured chat endpoint with a tiny, nonstreaming request and never returns its key', async () => {
  let calls = 0;
  const result = await probeModelConnection(target, mock((url, init) => {
    calls += 1; assert.equal(url, `${target.baseUrl}/chat/completions`);
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), `Bearer ${target.apiKey}`);
    assert.match(headers.get('content-type') ?? '', /application\/json/);
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, target.model); assert.equal(body.stream, false);
    assert.equal(body.max_completion_tokens, 16); assert.equal(body.max_tokens, undefined);
    assert.ok(Array.isArray(body.messages) && body.messages.length > 0);
    assert.ok(JSON.stringify(body.messages).length < 1024);
    assert.equal(JSON.stringify(body).includes(target.apiKey), false);
    assert.ok(init.signal instanceof AbortSignal);
    return json(complete);
  }));
  assert.equal(calls, 1); assertResult(result, true);
});

test('a keyless local endpoint omits authorization, and a reasoning response exhausted by its tiny budget still proves connectivity', async () => {
  const result = await probeModelConnection({ ...target, baseUrl: 'http://localhost:11434/v1', apiKey: '' }, mock((_url, init) => {
    assert.equal(new Headers(init.headers).has('authorization'), false);
    return json({ choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'length' }] });
  }));
  assertResult(result, true);
});

test('only an explicit unsupported max_completion_tokens error retries once with max_tokens', async () => {
  const bodies: Record<string, unknown>[] = [];
  const result = await probeModelConnection(target, mock((_url, init) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    return bodies.length === 1
      ? json({ error: { code: 'unsupported_parameter', param: 'max_completion_tokens', message: "Unsupported parameter: 'max_completion_tokens'; use 'max_tokens' instead." } }, 400)
      : json(complete);
  }));
  assertResult(result, true); assert.equal(bodies.length, 2);
  assert.equal(bodies[0].max_completion_tokens, 16); assert.equal(bodies[0].max_tokens, undefined);
  assert.equal(bodies[1].max_tokens, 16); assert.equal(bodies[1].max_completion_tokens, undefined);
  assert.deepEqual(bodies[1].messages, bodies[0].messages);
  let calls = 0;
  const failed = await probeModelConnection(target, mock(() => {
    calls += 1;
    return json({ error: { code: 'unsupported_parameter', param: calls === 1 ? 'max_completion_tokens' : 'max_tokens', message: 'Unsupported parameter' } }, 400);
  }));
  assertResult(failed, false); assert.equal(calls, 2);
});

test('bad model names, authentication failures and transient server failures are not retried', async () => {
  for (const [status, hint] of [
    [400, /400|请求|参数|模型/], [401, /401|认证|密钥|授权/], [403, /403|权限|授权|访问/],
    [404, /404|地址|路径|模型|接口/], [429, /429|频率|频繁|限流|额度|配额/], [503, /503|服务|稍后|暂时/],
  ] as const) {
    let calls = 0;
    const result = await probeModelConnection(target, mock(() => {
      calls += 1;
      return json({ error: { message: `PRIVATE-PROVIDER-RESPONSE ${target.apiKey}`, code: status === 400 ? 'model_not_found' : 'fixture_error' } }, status);
    }));
    assertResult(result, false); assert.equal(calls, 1); assert.match(result.message, hint);
    assert.equal(JSON.stringify(result).includes('PRIVATE-PROVIDER-RESPONSE'), false);
  }
});

test('redirects are rejected without following their destination or exposing its query', async () => {
  let calls = 0;
  const result = await probeModelConnection(target, mock((_url, init) => {
    calls += 1; assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: `https://other.example.test/login?secret=${target.apiKey}` } });
  }));
  assertResult(result, false); assert.equal(calls, 1); assert.match(result.message, /302|重定向|跳转/);
  assert.equal(JSON.stringify(result).includes('other.example.test'), false);
});

test('HTML, malformed JSON and non-chat JSON are rejected even when HTTP status is successful', async () => {
  const falseResponses = [
    () => new Response(`<html>PRIVATE-PROVIDER-RESPONSE ${target.apiKey}</html>`, { headers: { 'content-type': 'text/html' } }),
    () => new Response('{"choices":', { headers: { 'content-type': 'application/json' } }),
    () => json({ ok: true }),
    () => json({ data: [{ id: target.model }] }),
    () => json({ choices: [] }),
    () => json({ choices: [{ text: 'old completion format' }] }),
    () => json({ choices: [{ message: 'not a message object' }] }),
  ];
  for (const response of falseResponses) {
    const result = await probeModelConnection(target, mock(response));
    assertResult(result, false);
    assert.equal(JSON.stringify(result).includes('PRIVATE-PROVIDER-RESPONSE'), false);
  }
});

test('oversized response bodies are stopped rather than accepted or echoed', async () => {
  let cancelled = false;
  const bytes = new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(270 * 1024) }, finish_reason: 'stop' }] }));
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const end = Math.min(offset + 4096, bytes.length); controller.enqueue(bytes.slice(offset, end)); offset = end;
    },
    cancel() { cancelled = true; },
  });
  const result = await probeModelConnection(target, mock(() => new Response(stream, { headers: { 'content-type': 'application/json' } })));
  assertResult(result, false); assert.ok(offset < bytes.length || cancelled);
  assert.ok(result.message.length < 1024);
});

test('network and certificate failures give safe errors without logging or returning provider exception details', async () => {
  for (const failure of [
    new TypeError(`PRIVATE-PROVIDER-RESPONSE ${target.apiKey}`),
    new TypeError('fetch failed', { cause: Object.assign(new Error(`PRIVATE-PROVIDER-RESPONSE ${target.apiKey}`), { code: 'CERT_HAS_EXPIRED' }) }),
  ]) {
    let calls = 0;
    const result = await probeModelConnection(target, mock(() => { calls += 1; throw failure; }));
    assertResult(result, false); assert.equal(calls, 1);
    assert.match(result.message, /网络|连接|证书|TLS|SSL|失败/);
    assert.equal(JSON.stringify(result).includes('PRIVATE-PROVIDER-RESPONSE'), false);
  }
});

test('the deadline stops a stalled connection and a stalled response body', async () => {
  const connection = mock((_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  }));
  let started = performance.now();
  const result = await probeModelConnection(target, connection, { timeoutMs: 30 });
  assertResult(result, false); assert.match(result.message, /超时/); assert.ok(performance.now() - started < 1000);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"choices":')); }, cancel() { cancelled = true; } });
  started = performance.now();
  const stalled = await probeModelConnection(target, mock(() => new Response(body)), { timeoutMs: 30 });
  assertResult(stalled, false); assert.match(stalled.message, /超时/); assert.ok(performance.now() - started < 1000);
  assert.equal(cancelled, true);
});

test('external cancellation stops a pending probe without treating it as a successful connection', async () => {
  const controller = new AbortController();
  const response = probeModelConnection(target, mock((_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  })), { timeoutMs: 1000, signal: controller.signal });
  controller.abort(); const result = await response;
  assertResult(result, false); assert.match(result.message, /取消|终止|中止/);
});
