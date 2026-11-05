import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ModelCipher } from '../electron/model-settings';
import { searchWeb, WebSearchError, WebSearchSettings } from '../electron/web-search-settings';
import { emptyWebSearchConfiguration } from '../shared/web-search';

const secret = 'tvly-fixture-secret-not-real';
const hit = { title: 'Research source', url: 'https://example.org/paper', content: 'Verified fixture information.', published_date: '2026-11-05' };
const response = (body: unknown = { results: [hit] }, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noSignal = () => new AbortController().signal;
const mock = (fn: (url: string, init: RequestInit) => Response | Promise<Response>) => (async (url, init) => fn(String(url), init ?? {})) as typeof fetch;

async function fixture() {
  await mkdir('.test-data', { recursive: true }); const root = await mkdtemp(resolve('.test-data/web-search-settings-'));
  const key = randomBytes(32);
  const cipher: ModelCipher = {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12), enc = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([enc.update(value, 'utf8'), enc.final()]); return Buffer.concat([iv, enc.getAuthTag(), bytes]); },
    decryptString(bytes) { const dec = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); dec.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([dec.update(bytes.subarray(28)), dec.final()]).toString('utf8'); },
  };
  const directory = join(root, 'profile'), store = new WebSearchSettings(directory, cipher); return { root, directory, cipher, store };
}
function safeError(error: unknown) { return error instanceof Error && !error.message.includes(secret) && !error.message.includes('PRIVATE_PROVIDER'); }

test('search configuration encrypts a separate key, preserves it on blank edits, and survives restart with public status only', async () => {
  const f = await fixture(); assert.deepEqual(await f.store.status(), emptyWebSearchConfiguration());
  assert.equal(await f.store.snapshot(), null);
  const status = await f.store.save({ apiKey: secret });
  assert.deepEqual(status, { provider: 'tavily', configured: true, hasApiKey: true });
  assert.ok(!JSON.stringify(status).includes(secret));
  const firstBytes = await readFile(f.store.file); assert.ok(!firstBytes.includes(Buffer.from(secret)));
  assert.equal(JSON.parse(f.cipher.decryptString(firstBytes)).apiKey, secret);
  await f.store.save({ apiKey: '' });
  assert.equal((await new WebSearchSettings(f.directory, f.cipher).snapshot())?.apiKey, secret);
  assert.deepEqual(await readFile(f.store.file + '.bak'), firstBytes);
  assert.deepEqual((await readdir(f.directory)).sort(), ['web-search-config.bin', 'web-search-config.bin.bak']);
});

test('invalid configuration values never replace the key and encryption or backup path failures preserve the current file', async () => {
  const f = await fixture(); await f.store.save({ apiKey: secret }); const bytes = await readFile(f.store.file);
  for (const input of [null, [], { apiKey: 42 }, { apiKey: 'bad\nheader' }, { apiKey: 'a b' }, { apiKey: 'x'.repeat(8193) }, { apiKey: secret, baseUrl: 'https://evil.test' }]) {
    await assert.rejects(f.store.save(input as any), safeError); assert.deepEqual(await readFile(f.store.file), bytes);
  }
  f.cipher.isEncryptionAvailable = () => false;
  await assert.rejects(f.store.save({ apiKey: 'changed' }), /加密不可用/); assert.deepEqual(await readFile(f.store.file), bytes);
  f.cipher.isEncryptionAvailable = () => true; const encrypt = f.cipher.encryptString;
  f.cipher.encryptString = () => { throw new Error(secret); };
  await assert.rejects(f.store.save({ apiKey: 'changed' }), safeError); assert.deepEqual(await readFile(f.store.file), bytes);
  f.cipher.encryptString = encrypt;
  await mkdir(f.store.file + '.bak');
  await assert.rejects(f.store.save({ apiKey: 'changed' }), safeError); assert.deepEqual(await readFile(f.store.file), bytes);
  assert.ok(!(await readdir(f.directory)).some(name => name.endsWith('.tmp')));
});

test('corrupt, oversized, unexpected-schema and missing-primary configuration are not silently overwritten', async () => {
  const f = await fixture(); await f.store.save({ apiKey: secret });
  for (const bytes of [Buffer.from('corrupt encrypted bytes'), Buffer.alloc(65537),
    f.cipher.encryptString(JSON.stringify({ version: 1, provider: 'other', apiKey: secret, updatedAt: new Date().toISOString() }))]) {
    await writeFile(f.store.file, bytes);
    await assert.rejects(f.store.status(), safeError); await assert.rejects(f.store.save({ apiKey: 'new' }), safeError);
    await assert.rejects(f.store.clear(), safeError); assert.deepEqual(await readFile(f.store.file), bytes);
  }
  await rename(f.store.file, f.store.file + '.bak');
  await assert.rejects(f.store.save({ apiKey: 'new' }), /无法读取/);
  await assert.rejects(readFile(f.store.file), { code: 'ENOENT' });
});

test('linked settings directories and hardlinked credential files are rejected without touching their targets', async () => {
  const f = await fixture(); const outside = join(f.root, 'outside'), linked = join(f.root, 'linked');
  await mkdir(outside); await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new WebSearchSettings(linked, f.cipher).save({ apiKey: secret }), /链接/);
  assert.deepEqual(await readdir(outside), []);
  await f.store.save({ apiKey: secret }); const target = join(f.root, 'duplicate.bin'); await link(f.store.file, target);
  const bytes = await readFile(target); await assert.rejects(f.store.save({ apiKey: 'changed' }), /链接/);
  assert.deepEqual(await readFile(target), bytes);
});

test('serialized saves and explicit clear leave no active or backup search credential', async () => {
  const f = await fixture();
  await assert.rejects(f.store.save({ apiKey: ' ' }), /填写/);
  await Promise.all([f.store.save({ apiKey: secret }), f.store.save({ apiKey: 'second-secret' }), f.store.save({})]);
  assert.equal((await f.store.snapshot())?.apiKey, 'second-secret');
  assert.deepEqual(await f.store.clear(), emptyWebSearchConfiguration());
  assert.equal((await new WebSearchSettings(f.directory, f.cipher).snapshot()), null);
  assert.equal(JSON.parse(f.cipher.decryptString(await readFile(f.store.file))).apiKey, null);
  await assert.rejects(readFile(f.store.file + '.bak'), { code: 'ENOENT' });
});

test('connectivity uses an explicit small search with draft or retained key without saving or returning its result', async () => {
  const f = await fixture(); let calls = 0, auth = '';
  const fetcher = mock((url, init) => {
    calls++; assert.equal(url, 'https://api.tavily.com/search'); auth = new Headers(init.headers).get('authorization')!;
    assert.equal(JSON.parse(String(init.body)).query, 'Tavily search API'); return response();
  });
  const draft = await f.store.testConnection({ apiKey: secret }, fetcher); assert.equal(draft.ok, true); assert.ok(draft.durationMs >= 0);
  assert.equal(auth, 'Bearer ' + secret); await assert.rejects(readFile(f.store.file), { code: 'ENOENT' });
  await f.store.save({ apiKey: secret }); const bytes = await readFile(f.store.file);
  assert.equal((await f.store.testConnection({}, fetcher)).ok, true); assert.equal(auth, 'Bearer ' + secret);
  assert.deepEqual(await readFile(f.store.file), bytes); assert.equal(calls, 2);
  assert.ok(!JSON.stringify(draft).includes(secret) && !JSON.stringify(draft).includes(hit.content));
});

test('one connectivity test at a time, cancellation and whenIdle do not leave a network request running', async () => {
  const f = await fixture(); let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const pending = f.store.testConnection({ apiKey: secret }, mock((_url, init) => {
    ready(); return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error(secret)), { once: true }));
  }));
  await assert.rejects(f.store.testConnection({ apiKey: secret }, async () => response()), /正在测试/);
  await started; f.store.cancelConnectionTest(); await f.store.whenIdle();
  const cancelled = await pending; assert.equal(cancelled.ok, false); assert.match(cancelled.message, /取消/);
  assert.equal((await f.store.testConnection({ apiKey: secret }, async () => response())).ok, true);
});

test('search sends a fixed bounded Tavily request with bearer authorization only and returns structured sources', async () => {
  const output = await searchWeb('  Example research  ', secret, mock((url, init) => {
    assert.equal(url, 'https://api.tavily.com/search'); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit');
    const headers = new Headers(init.headers); assert.equal(headers.get('authorization'), 'Bearer ' + secret); assert.equal(headers.has('cookie'), false);
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body, { query: 'Example research', search_depth: 'basic', topic: 'general', max_results: 5,
      include_answer: false, include_raw_content: false, include_images: false, auto_parameters: false });
    assert.ok(!JSON.stringify(body).includes(secret)); return response();
  }), noSignal());
  assert.deepEqual(output.results, [{ title: hit.title, url: hit.url, content: hit.content, publishedDate: hit.published_date }]);
  assert.ok(Number.isFinite(Date.parse(output.retrievedAt)));
});

test('provider faults, redirects and network exceptions never echo private response text or credentials and are not retried', async () => {
  for (const status of [400, 401, 403, 429, 432, 433, 500, 503, 302]) {
    let calls = 0;
    await assert.rejects(searchWeb('query', secret, mock(() => {
      calls++; return response({ error: `PRIVATE_PROVIDER ${secret}` }, status);
    }), noSignal()), error => safeError(error) && error instanceof WebSearchError);
    assert.equal(calls, 1);
  }
  await assert.rejects(searchWeb('query', secret, async () => { throw new Error(`PRIVATE_PROVIDER ${secret}`); }, noSignal()), error => safeError(error) && error instanceof WebSearchError && error.code === 'network');
});

test('non-search JSON, malformed JSON and HTML are rejected, while empty results are valid', async () => {
  for (const fetcher of [() => response({ ok: true }), () => response({ results: [{ title: 'x' }] }),
    () => response({ results: {}, error: secret }), () => new Response('<html>PRIVATE_PROVIDER</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{"results":', { headers: { 'content-type': 'application/json' } })]) {
    await assert.rejects(searchWeb('query', secret, mock(fetcher), noSignal()), error => safeError(error) && error instanceof WebSearchError && error.code === 'invalid-response');
  }
  assert.deepEqual((await searchWeb('query', secret, async () => response({ results: [] }), noSignal())).results, []);
});

test('search bounds result count and excerpt size, strips unsafe protocols, and redacts key echoes', async () => {
  const output = await searchWeb('query', secret, async () => response({ results: [
    { ...hit, url: 'file:///secret' }, { ...hit, url: 'https://user:pass@example.org' }, { ...hit, url: `https://example.org/${secret}` },
    { ...hit, title: secret, content: `echo ${secret}` }, ...Array.from({ length: 9 }, () => ({ ...hit, content: 'x'.repeat(9000) })),
  ] }), noSignal());
  assert.ok(output.results.length <= 5); assert.ok(!JSON.stringify(output).includes(secret));
  assert.ok(output.results.every(item => item.content.length <= 8000)); assert.match(output.results[0].content, /已隐藏密钥/);
});

test('search rejects invalid input before any network request', async () => {
  let calls = 0; const fetcher: typeof fetch = async () => { calls++; return response(); };
  for (const query of ['', ' ', 'x'.repeat(401), 'hello\nworld', null]) await assert.rejects(searchWeb(query as any, secret, fetcher, noSignal()), safeError);
  for (const key of ['', 'space key', secret + '\n', 'x'.repeat(8193)]) await assert.rejects(searchWeb('query', key, fetcher, noSignal()), error => error instanceof WebSearchError && error.code === 'invalid-input');
  assert.equal(calls, 0);
});

test('response limit cancels oversized streams and declared oversized content', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(200000)); }, cancel() { cancelled = true; } });
  await assert.rejects(searchWeb('query', secret, async () => new Response(stream), noSignal()), error => error instanceof WebSearchError && error.code === 'response-too-large');
  assert.equal(cancelled, true);
  await assert.rejects(searchWeb('query', secret, async () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1048577' } }), noSignal()), error => error instanceof WebSearchError && error.code === 'response-too-large');
});

test('deadline and external cancellation stop both stalled fetches and stalled bodies', async () => {
  const hanging = mock((_url, init) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error(secret)), { once: true })));
  await assert.rejects(searchWeb('query', secret, hanging, noSignal(), { timeoutMs: 20 }), error => safeError(error) && error instanceof WebSearchError && error.code === 'timeout');
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"results":')); }, cancel() { cancelled = true; } });
  await assert.rejects(searchWeb('query', secret, async () => new Response(stream), noSignal(), { timeoutMs: 20 }), error => error instanceof WebSearchError && error.code === 'timeout');
  assert.equal(cancelled, true);
  const controller = new AbortController(); const run = searchWeb('query', secret, hanging, controller.signal); controller.abort();
  await assert.rejects(run, error => error instanceof WebSearchError && error.code === 'cancelled');
});
