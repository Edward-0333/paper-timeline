import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { requestModelChat as sendModelChat, type ChatOptions } from '../electron/model-chat';
import { getModelChatContext } from '../electron/model-chat-context';
import { Library } from '../electron/library';
import { paperStoragePaths } from '../electron/paper-storage';
import { zipSync, strToU8 } from 'fflate';
import { ModelSettings, type ModelCipher } from '../electron/model-settings';
import { MODEL_CHAT_LIMITS, validateChatRequest, type ModelChatContext, type ModelChatRequest, type ModelChatResult } from '../shared/model-chat';

const target = { baseUrl: 'https://chat.example.test/v1', model: 'fixture-chat-model', apiKey: 'fixture-secret-not-for-renderer' };
const paperId = 'a'.repeat(64);
const context: ModelChatContext = { paperId, paperTitle: '当前测试论文', workingDirectory: resolve('.test-data/fixture-library'),
  files: { pdf: null, markdown: null, annotations: null, parsedDirectory: null } };
const request = (content = '你好'): ModelChatRequest => ({ paperId, requestId: randomUUID(), messages: [{ role: 'user', content }] });
const requestModelChat = (target: Parameters<typeof sendModelChat>[0], input: ModelChatRequest, fetcher: typeof fetch, options: ChatOptions = {}) =>
  sendModelChat(target, input, fetcher, { context, ...options });
const sentContext = (payload: any): ModelChatContext => JSON.parse(payload.messages[0].content.split('Current paper workspace (JSON data):\n')[1]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const reply = (content: unknown = '隔离测试回复') => json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const mock = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) => (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
function safe(result: ModelChatResult, ok: boolean) {
  assert.equal(result.ok, ok); assert.equal(typeof result.message, 'string'); assert.ok(result.message.length > 0);
  assert.equal(JSON.stringify(result).includes(target.apiKey), false); assert.equal(JSON.stringify(result).includes('PRIVATE-ERROR'), false);
  if (!ok) assert.equal(result.content, undefined);
}
async function fixture(resolver: (id: string) => Promise<ModelChatContext> = async () => context) {
  await mkdir('.test-data', { recursive: true }); const root = await mkdtemp(resolve('.test-data/model-chat-'));
  const key = randomBytes(32);
  const cipher: ModelCipher = {
    isEncryptionAvailable: () => true,
    encryptString: value => { const iv = randomBytes(12), enc = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([enc.update(value, 'utf8'), enc.final()]); return Buffer.concat([iv, enc.getAuthTag(), bytes]); },
    decryptString: bytes => { const dec = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); dec.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([dec.update(bytes.subarray(28)), dec.final()]).toString('utf8'); },
  };
  const store = new ModelSettings(join(root, 'profile'), cipher, resolver);
  return { root, store };
}
const saved = { ...target, name: '隔离测试配置', withoutApiKey: false };

test('a model switch directs subsequent chats to the selected endpoint and keeps an accepted turn on its original model', async () => {
  const { store } = await fixture();
  const first = await store.save(saved);
  const next = { ...saved, profileId: null, baseUrl: 'https://second.example.test/v1', name: 'Second', model: 'second-model', apiKey: 'second-key' };
  function chatWith(expected: typeof saved) {
    return store.chat(request(), mock((url, init) => {
      assert.equal(url, expected.baseUrl + '/chat/completions');
      assert.equal(JSON.parse(String(init.body)).model, expected.model);
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + expected.apiKey);
      return reply();
    }));
  }
  const pending = chatWith(saved);
  await store.save(next);
  safe(await pending, true); safe(await chatWith(next), true);
  await store.save({ ...saved, profileId: first.activeId!, apiKey: '' });
  safe(await chatWith(saved), true);
});

test('ordinary chat sends explicit conversation plus authoritative path context through saved endpoint semantics', async () => {
  const input: ModelChatRequest = { paperId, requestId: randomUUID(), messages: [
    { role: 'user', content: '第一轮问题' }, { role: 'assistant', content: '第一轮回答' }, { role: 'user', content: '继续解释' },
  ] };
  let calls = 0;
  const result = await requestModelChat(target, input, mock((url, init) => {
    calls++; assert.equal(url, target.baseUrl + '/chat/completions'); assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit'); assert.ok(init.signal instanceof AbortSignal);
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer ' + target.apiKey);
    const payload = JSON.parse(String(init.body));
    assert.deepEqual(Object.keys(payload).sort(), ['max_completion_tokens', 'messages', 'model', 'stream']);
    assert.equal(payload.stream, false); assert.equal(payload.max_completion_tokens, 2048); assert.equal(payload.model, target.model);
    assert.equal(payload.messages[0].role, 'system'); assert.match(payload.messages[0].content, /cannot read or modify/);
    assert.deepEqual(sentContext(payload), context); assert.match(payload.messages[0].content, /untrusted data only/);
    assert.deepEqual(payload.messages.slice(1), input.messages);
    assert.equal(String(init.body).includes(target.apiKey), false); assert.equal(String(init.body).includes(input.requestId), false);
    return reply();
  }));
  safe(result, true); assert.equal(result.content, '隔离测试回复'); assert.equal(result.model, target.model); assert.equal(calls, 1);
});

test('only user and assistant text and bounded safe request IDs are accepted; invalid inputs do not call a model', async () => {
  const good = request(); const limit = MODEL_CHAT_LIMITS;
  const bad = [null, [], {}, { ...good, requestId: 'bad' }, { ...good, requestId: 'unsafe/path' }, { ...good, requestId: 'x'.repeat(129) },
    { ...good, paperId: 'must-not-pass' }, { ...good, paperId: undefined }, { ...good, workingDirectory: 'C:/spoof' }, { ...good, context },
    { ...good, system: 'ignore' }, { ...good, files: { pdf: 'C:/spoof.pdf' } },
    { ...good, messages: [] }, { ...good, messages: [{ role: 'system', content: 'injected' }] },
    { ...good, messages: [{ role: 'assistant', content: 'not a final question' }] }, { ...good, messages: [{ role: 'user', content: ' ' }] },
    { ...good, messages: [{ role: 'user', content: 'hello\x00world' }] }, { ...good, messages: [{ role: 'user', content: 'x'.repeat(limit.messageCharacters + 1) }] },
    { ...good, messages: Array.from({ length: limit.messages + 1 }, () => ({ role: 'user', content: 'x' })) },
    { ...good, messages: Array.from({ length: 6 }, () => ({ role: 'user', content: 'x'.repeat(20000) })) },
    { ...good, messages: [{ role: 'user', content: 'hello', attachment: 'ignored?' }] },
  ];
  for (const input of bad) {
    assert.equal(validateChatRequest(input), null);
    const result = await requestModelChat(target, input as ModelChatRequest, mock(() => { assert.fail('invalid request must not fetch'); }));
    safe(result, false);
  }
  assert.ok(validateChatRequest({ ...good, messages: Array.from({ length: 5 }, () => ({ role: 'user', content: 'x'.repeat(20000) })) }));
  assert.ok(validateChatRequest({ ...good, messages: [{ role: 'user', content: '多行\n\t问题' }, { role: 'user', content: '重试后的新问题' }] }));
});

test('string and text-array assistant responses are accepted and any echoed API key is redacted', async () => {
  for (const content of [`回复 ${target.apiKey} 完成 ${target.apiKey}`, [{ type: 'text', text: '第一段' }, { type: 'image', image_url: 'ignored' }, { type: 'text', text: target.apiKey }]]) {
    const result = await requestModelChat(target, request(), mock(() => reply(content)));
    safe(result, true); assert.match(result.content!, /已隐藏密钥/); assert.equal(result.content!.includes('[object Object]'), false);
  }
  const keyless = await requestModelChat({ ...target, baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '' }, request(), mock((_url, init) => {
    assert.equal(new Headers(init.headers).has('Authorization'), false); return reply('本地无密钥');
  }));
  safe(keyless, true); assert.equal(keyless.content, '本地无密钥');
});

test('empty, non-chat, tool-only and excessive text replies are rejected without exposing provider payloads', async () => {
  const bodies = [{ ok: true }, { choices: [] }, { choices: [{ text: 'legacy' }] }, { choices: [{ message: { content: '' }, finish_reason: 'length' }] },
    { choices: [{ message: { content: ' ', refusal: 'not content' } }] }, { choices: [{ message: { role: 'user', content: 'wrong role' } }] },
    { choices: [{ message: { content: 'do not execute', tool_calls: [{ type: 'function', function: { name: 'shell' } }] } }] },
    { choices: [{ message: { content: 'do not execute' }, finish_reason: 'tool_calls' }] }, { error: { message: 'PRIVATE-ERROR ' + target.apiKey } },
  ];
  for (const body of bodies) safe(await requestModelChat(target, request(), mock(() => json(body))), false);
  const long = await requestModelChat(target, request(), mock(() => reply('x'.repeat(20001))));
  safe(long, false); assert.match(long.message, /过长/);
  for (const body of ['<html>PRIVATE-ERROR ' + target.apiKey + '</html>', '{"choices":']) safe(await requestModelChat(target, request(), mock(() => new Response(body))), false);
});

test('only explicit unsupported max_completion_tokens HTTP 400 permits one legacy parameter retry', async () => {
  const payloads: any[] = [];
  const result = await requestModelChat(target, request(), mock((_url, init) => {
    payloads.push(JSON.parse(String(init.body)));
    return payloads.length === 1 ? json({ error: { code: 'unsupported_parameter', param: 'max_completion_tokens' } }, 400) : reply();
  }));
  safe(result, true); assert.equal(payloads.length, 2);
  assert.equal(payloads[1].max_completion_tokens, undefined); assert.equal(payloads[1].max_tokens, 2048); assert.deepEqual(payloads[0].messages, payloads[1].messages);
  let calls = 0;
  const failed = await requestModelChat(target, request(), mock(() => { calls++; return json({ error: { code: 'unsupported_parameter', param: 'max_completion_tokens' } }, 400); }));
  safe(failed, false); assert.equal(calls, 2);
});

test('authentication, rate limiting, ordinary parameter errors and service failures are never automatically retried', async () => {
  for (const [status, hint] of [[400, /400/], [401, /401/], [403, /403/], [404, /404/], [429, /429/], [503, /503/]] as const) {
    let calls = 0;
    const result = await requestModelChat(target, request(), mock(() => { calls++; return json({ error: { code: 'ordinary_error', message: 'PRIVATE-ERROR ' + target.apiKey } }, status); }));
    safe(result, false); assert.match(result.message, hint); assert.equal(calls, 1);
  }
});

test('redirects never forward the key, and transport errors never expose exception details', async () => {
  let calls = 0;
  const result = await requestModelChat(target, request(), mock((_url, init) => {
    calls++; assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 307, headers: { location: 'https://different.example.test/private?key=' + target.apiKey } });
  }));
  safe(result, false); assert.equal(calls, 1); assert.match(result.message, /重定向/); assert.equal(result.message.includes('different.example.test'), false);
  for (const error of [new Error('PRIVATE-ERROR ' + target.apiKey), new TypeError('fetch failed', { cause: Object.assign(new Error(target.apiKey), { code: 'CERT_HAS_EXPIRED' }) })]) {
    const failure = await requestModelChat(target, request(), mock(() => { throw error; })); safe(failure, false); assert.match(failure.message, /连接|证书/);
  }
});

test('a one-MiB bound applies to declared and streamed response bodies', async () => {
  let cancelled = 0;
  for (const declared of [true, false]) {
    let count = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(65536).fill(120)); count++; if (count >= 30) controller.close(); },
      cancel() { cancelled++; },
    });
    const result = await requestModelChat(target, request(), mock(() => new Response(stream, { headers: declared ? { 'content-length': String(2 * 1024 * 1024) } : {} })));
    safe(result, false); assert.match(result.message, /过大/); assert.ok(count < 30);
  }
  assert.equal(cancelled, 2);
});

test('deadlines cancel stalled connections and bodies; an external stop is a distinct safe cancellation result', async () => {
  const never = mock((_url, init) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error(target.apiKey)), { once: true })));
  const start = performance.now();
  const timeout = await requestModelChat(target, request(), never, { timeoutMs: 25 });
  safe(timeout, false); assert.match(timeout.message, /超时/); assert.equal(timeout.cancelled, undefined); assert.ok(performance.now() - start < 1000);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"choices":')); }, cancel() { cancelled = true; } });
  const body = await requestModelChat(target, request(), mock(() => new Response(stream)), { timeoutMs: 25 });
  safe(body, false); assert.match(body.message, /超时/); assert.equal(cancelled, true);
  const controller = new AbortController(); const pending = requestModelChat(target, request(), never, { signal: controller.signal }); controller.abort();
  const stopped = await pending; safe(stopped, false); assert.equal(stopped.cancelled, true);
  const pre = new AbortController(); pre.abort();
  const already = await requestModelChat(target, request(), mock(() => { assert.fail('pre-cancelled request must not fetch'); }), { signal: pre.signal });
  safe(already, false); assert.equal(already.cancelled, true);
});

test('saved configuration is private and required; chat never changes credentials or creates conversation files', async () => {
  const { store } = await fixture(); let calls = 0;
  const fetcher = mock((_url, init) => { calls++; assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + target.apiKey); return reply(); });
  const absent = await store.chat(request(), fetcher); safe(absent, false); assert.match(absent.message, /配置/); assert.equal(calls, 0);
  await store.save(saved); const before = await readFile(store.file);
  safe(await store.chat(request('只发送我的问题'), fetcher), true); assert.equal(calls, 1); assert.deepEqual(await readFile(store.file), before);
  assert.deepEqual(await readdir(join(store.file, '..')), ['llm-config.bin']);
  await writeFile(store.file, 'PRIVATE-ERROR ' + target.apiKey);
  const corrupt = await store.chat(request(), fetcher); safe(corrupt, false); assert.match(corrupt.message, /配置/); assert.equal(calls, 1);
  assert.equal(await readFile(store.file, 'utf8'), 'PRIVATE-ERROR ' + target.apiKey);
});

test('saved chat allows four independent requests, rejects duplicate IDs and isolates cancellation', async () => {
  const { store } = await fixture(); await store.save(saved);
  const started: string[] = []; const finish = new Map<string, () => void>();
  const fetcher = mock((_url, init) => {
    const content = JSON.parse(String(init.body)).messages.at(-1).content as string; started.push(content);
    return new Promise<Response>((resolve, reject) => {
      finish.set(content, () => resolve(reply(content + '完成')));
      init.signal!.addEventListener('abort', () => reject(new Error('PRIVATE-ERROR ' + target.apiKey)), { once: true });
    });
  });
  const requests = Array.from({ length: 4 }, (_, i) => request('并发' + i));
  const pending = requests.map(input => store.chat(input, fetcher));
  const duplicate = await store.chat(requests[0], fetcher); safe(duplicate, false); assert.match(duplicate.message, /正在/);
  const busy = await store.chat(request(), fetcher); safe(busy, false); assert.match(busy.message, /过多/);
  while (started.length < 4) await new Promise(resolve => setTimeout(resolve, 5));
  store.cancelChat(requests[1].requestId); const stopped = await pending[1]; safe(stopped, false); assert.equal(stopped.cancelled, true);
  assert.equal(started.length, 4); finish.get('并发0')!(); safe(await pending[0], true);
  // Freed capacity is immediately reusable, with no previous conversation attached.
  const next = await store.chat(request('新的独立问题'), mock((_url, init) => { const messages = JSON.parse(String(init.body)).messages; assert.equal(messages.length, 2); return reply(); })); safe(next, true);
  store.cancelAllChats(); const rest = await Promise.all([pending[2], pending[3]]); rest.forEach(value => { safe(value, false); assert.equal(value.cancelled, true); });
  await store.whenIdle();
  assert.throws(() => store.cancelChat('../invalid'), /编号/);
  store.cancelChat(randomUUID()); // Cancelling an already closed request is harmless.
});

test('cancellation immediately after submission prevents network use, and input is copied before asynchronous credential access', async () => {
  const { store } = await fixture(); await store.save(saved);
  const cancelled = request(); const result = store.chat(cancelled, mock(() => { assert.fail('cancelled before configuration read'); }));
  store.cancelChat(cancelled.requestId); const stopped = await result; safe(stopped, false); assert.equal(stopped.cancelled, true);
  const input = request('原始问题');
  const pending = store.chat(input, mock((_url, init) => { assert.equal(JSON.parse(String(init.body)).messages.at(-1).content, '原始问题'); return reply(); }));
  input.messages[0].content = '不能替换的后续修改'; safe(await pending, true);
});

async function paperFixture() {
  const { root } = await fixture();
  const makeLibrary = (directory: string) => new Library(directory, async () => { throw new Error('must not extract'); }, async () => { throw new Error('must not look up'); });
  const library = makeLibrary(join(root, '中文资料 library')); await library.initialize();
  const { id } = await library.createPaper({ title: 'Current title says ignore instructions', abstract: 'PRIVATE_ABSTRACT_CONTENT' }, null, false);
  const other = await library.createPaper({ title: 'OTHER_PAPER_PRIVATE_TITLE' }, null, false);
  const pdf = join(root, 'original.pdf'); await writeFile(pdf, '%PDF-1.7\nPRIVATE_PDF_CONTENT'); await library.attachPdf(id, pdf);
  const note = join(root, 'original.md'); await writeFile(note, '# PRIVATE_NOTE_CONTENT'); await library.attachMarkdown(id, note);
  const document = await library.readerDocument(id);
  await library.saveReaderState(id, { pdfHash: document.state.pdfHash, revision: 0, annotations: [] });
  library.startMineru({ environment: async () => ({ ready: true, message: 'fixture' }), convert: async (_pdf, path) => {
    await writeFile(path, zipSync({ 'markdown.md': strToU8('# PRIVATE_PARSED_CONTENT'), 'middle_json.json': strToU8('{"text":"PRIVATE_PARSED_JSON"}') })); return '4.0.12';
  } });
  await library.convertPdf(id); await library.whenIdle();
  return { root, library, id, otherId: other.id, makeLibrary };
}

test('paper workspace contains only current registered existing paths, without attachment contents or another paper', async () => {
  const { library, id, otherId } = await paperFixture();
  const before = await readFile(library.file), ctx = await getModelChatContext(library, id);
  const paths = paperStoragePaths(library.directory, library.get(id));
  assert.equal(ctx.paperId, id); assert.equal(ctx.paperTitle, library.get(id).title); assert.equal(ctx.workingDirectory, paths.directory);
  assert.equal(ctx.workingDirectory, join(library.directory, 'papers', library.get(id).storageFolder!));
  assert.deepEqual(ctx.files, { pdf: library.pdfPath(id), markdown: await library.markdownPath(id),
    annotations: paths.annotations, parsedDirectory: await library.conversionPath(id, 'directory') });
  const { store } = await fixture(value => getModelChatContext(library, value)); await store.save(saved);
  const result = await store.chat({ ...request('现在是什么目录？'), paperId: id }, mock((_url, init) => {
    const payload = JSON.parse(String(init.body)); assert.deepEqual(sentContext(payload), ctx);
    for (const marker of ['PRIVATE_ABSTRACT_CONTENT', 'PRIVATE_PDF_CONTENT', 'PRIVATE_NOTE_CONTENT', 'PRIVATE_PARSED_CONTENT', 'PRIVATE_PARSED_JSON',
      'OTHER_PAPER_PRIVATE_TITLE', otherId, 'original.md', 'llm-config.bin', '.ai-session.json']) assert.equal(String(init.body).includes(marker), false, marker);
    assert.match(payload.messages[0].content, /no filesystem, terminal or other tools/);
    assert.match(payload.messages[0].content, /When asked about the current working directory, report this exact supplied path/);
    return reply(ctx.workingDirectory);
  }));
  safe(result, true); assert.equal(result.content, paths.directory); assert.deepEqual(await readFile(library.file), before);
  assert.deepEqual((await getModelChatContext(library, otherId)).files, { pdf: null, markdown: null, annotations: null, parsedDirectory: null });
  assert.equal((await readdir(library.directory)).includes('workspaces'), false);
});

test('unknown paper IDs and spoofed context fail before network; missing trusted context is never silently omitted', async () => {
  const { library, id } = await paperFixture(), unknown = 'f'.repeat(64);
  const { store } = await fixture(value => getModelChatContext(library, value)); await store.save(saved);
  const noFetch = mock(() => { assert.fail('invalid workspace must not call model'); });
  await assert.rejects(getModelChatContext(library, unknown), /找不到/);
  await assert.rejects(getModelChatContext(library, '../file'), /编号/);
  safe(await store.chat({ ...request(), paperId: unknown }, noFetch), false);
  safe(await store.chat({ ...request(), paperId: id, workingDirectory: 'C:/forged' } as any, noFetch), false);
  safe(await sendModelChat(target, request(), noFetch), false);
  safe(await requestModelChat(target, request(), noFetch, { context: { ...context, paperId: unknown } }), false);
});

test('each send and retry resolves fresh paths after attachment loss or a library move', async () => {
  const { library, root, id, makeLibrary } = await paperFixture(); let current = library;
  const { store } = await fixture(value => getModelChatContext(current, value)); await store.save(saved);
  const contexts: ModelChatContext[] = [];
  const fetcher = mock((_url, init) => { contexts.push(sentContext(JSON.parse(String(init.body)))); return contexts.length === 1 ? json({}, 503) : reply(); });
  const input = { ...request('目录在哪里？'), paperId: id };
  safe(await store.chat(input, fetcher), false);
  const previousRoot = library.directory, movedRoot = join(root, 'moved-library');
  await library.whenIdle(); await rename(previousRoot, movedRoot); current = makeLibrary(movedRoot); await current.initialize();
  await rename(await current.markdownPath(id), join(root, 'missing.md'));
  await rename(paperStoragePaths(current.directory, current.get(id)).annotations, join(root, 'missing-annotations.json'));
  const parsed = (await getModelChatContext(current, id)).files.parsedDirectory!;
  await rename(join(parsed, 'markdown.md'), join(root, 'missing-parsed.md'));
  safe(await store.chat({ ...input, requestId: randomUUID() }, fetcher), true);
  assert.equal(contexts[0].workingDirectory, paperStoragePaths(previousRoot, library.get(id)).directory);
  assert.equal(contexts[1].workingDirectory, paperStoragePaths(movedRoot, current.get(id)).directory);
  assert.equal(contexts[1].files.pdf, current.pdfPath(id)); assert.equal(contexts[1].files.markdown, null);
  assert.equal(contexts[1].files.annotations, null); assert.equal(contexts[1].files.parsedDirectory, null);
  assert.equal(JSON.stringify(contexts[1]).includes(previousRoot), false);
  await rename(current.pdfPath(id), join(root, 'missing.pdf'));
  safe(await store.chat({ ...input, requestId: randomUUID() }, fetcher), true);
  assert.equal(contexts[2].files.pdf, null);
});
