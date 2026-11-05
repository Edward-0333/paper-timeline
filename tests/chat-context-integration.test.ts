import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Library } from '../electron/library';
import { PaperChatStore } from '../electron/paper-chat-store';
import { ModelSettings, type ModelCipher } from '../electron/model-settings';
import { getModelChatContext } from '../electron/model-chat-context';
import { SUMMARY_MARKER } from '../electron/chat-compaction';
import type { ModelChatRequest, StoredChatMessage } from '../shared/model-chat';

function messages(count: number, start = 0): StoredChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({ role: (start + index) % 2 ? 'assistant' : 'user',
    content: `ARCHIVE_TURN_${start + index} ` + 'This is detailed evidence from a long discussion. '.repeat(60) }));
}
const reply = (content: string, model = 'fixture-a') => new Response(JSON.stringify({
  id: 'chatcmpl-' + randomUUID(), object: 'chat.completion', created: 1, model,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
}), { headers: { 'content-type': 'application/json' } });
const mock = (handler: (payload: any, init: RequestInit, url: string) => Response | Promise<Response>) =>
  (async (url: string | URL | Request, init?: RequestInit) => handler(JSON.parse(String(init?.body)), init!, String(url))) as typeof fetch;
const isSummary = (payload: any) => String(payload.messages?.[0]?.content).includes('Summarize the supplied earlier conversation');

async function fixture() {
  await mkdir('.test-data', { recursive: true }); const directory = await mkdtemp(resolve('.test-data/chat-context-integration-'));
  const library = new Library(join(directory, 'library'), async () => { throw new Error('fixture must not parse'); }, async () => { throw new Error('fixture must not query'); });
  await library.initialize(); const { id } = await library.createPaper({ title: 'Context integration fixture' }, null, false);
  const archive = new PaperChatStore(library), key = randomBytes(32);
  const cipher: ModelCipher = {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12), enc = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([enc.update(value, 'utf8'), enc.final()]); return Buffer.concat([iv, enc.getAuthTag(), data]); },
    decryptString(bytes) { const dec = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); dec.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([dec.update(bytes.subarray(28)), dec.final()]).toString('utf8'); },
  };
  // Only this fresh test profile is read/written. No production model configuration is opened.
  const createSettings = () => new ModelSettings(join(directory, 'profile'), cipher, paperId => getModelChatContext(library, paperId),
    paperId => ({ library, paperId }), (paperId, history) => archive.save(paperId, history), archive);
  const settings = createSettings();
  const config = await settings.save({ profileId: null, name: 'Fixture A', baseUrl: 'http://127.0.0.1:9123/v1', model: 'fixture-a',
    apiKey: 'fixture-integration-key', withoutApiKey: false, contextWindowTokens: 32768 });
  const input = (history: StoredChatMessage[], compactOnly = false): ModelChatRequest => ({ paperId: id, requestId: randomUUID(),
    messages: history.map(({ role, content }) => ({ role, content })), ...(compactOnly ? { compactOnly: true } : {}) });
  return { directory, library, id, archive, settings, createSettings, config, input,
    archivePath: join(library.paperDirectory(id), 'chat.json'), contextPath: join(library.paperDirectory(id), 'chat-context.json') };
}

test('manual summary survives restart and switching model while all transcript text and source references remain intact', async () => {
  const f = await fixture(), history = messages(12);
  history[1].sources = [{ id: 'fulltext:fixture:L12-L20', label: '全文 L12–L20' }];
  history[1].activity = [{ tool: 'read_text', label: '读取全文', status: 'succeeded' }];
  await f.archive.save(f.id, history);
  let summaryCalls = 0;
  const compacted = await f.settings.chat(f.input(history, true), mock((payload, init) => {
    assert.ok(isSummary(payload)); assert.equal(payload.tools, undefined);
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-integration-key');
    summaryCalls++; return reply('SAVED_PORTABLE_SUMMARY：关注实验效果，已确认结论需回查全文 L12–L20，尚需确认样本量。');
  }));
  assert.equal(compacted.ok, true, compacted.message); assert.ok(summaryCalls > 0);
  assert.equal(compacted.content, undefined); assert.ok(compacted.compaction);
  assert.deepEqual((await f.archive.load(f.id)).messages, history);
  assert.deepEqual(await f.archive.loadCompaction(f.id), compacted.compaction);
  const restarted = f.createSettings();
  await restarted.save({ profileId: null, name: 'Fixture DeepSeek', baseUrl: 'http://127.0.0.1:9456/v1', model: 'deepseek-flash',
    apiKey: 'fixture-other-key', withoutApiKey: false, contextWindowTokens: 65536 });
  const next = [...history, { role: 'user' as const, content: '继续分析上一轮尚未确认的内容' }];
  let modelCalls = 0;
  const result = await restarted.chat(f.input(next), mock((payload, init, url) => {
    modelCalls++; assert.equal(isSummary(payload), false);
    assert.equal(url, 'http://127.0.0.1:9456/v1/chat/completions'); assert.equal(payload.model, 'deepseek-flash');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-other-key');
    const text = JSON.stringify(payload.messages); assert.ok(text.includes(SUMMARY_MARKER)); assert.ok(text.includes('SAVED_PORTABLE_SUMMARY'));
    assert.equal(text.includes('ARCHIVE_TURN_0 '), false); assert.equal(text.includes('fixture-integration-key'), false);
    return reply('继续分析完成，具体证据仍需重读原文。', payload.model);
  }));
  assert.equal(result.ok, true, result.message); assert.equal(modelCalls, 1);
  assert.equal(result.contextUsage?.contextWindowTokens, 65536);
  const restored = await f.archive.load(f.id);
  assert.equal(restored.messages.length, history.length + 2);
  assert.deepEqual(restored.messages.slice(0, history.length), history);
  assert.equal(restored.messages.at(-1)?.content, result.content);
});

test('automatic summarization persists a long conversation without dropping old questions or provenance', async () => {
  const f = await fixture(), history = messages(71); let summaries = 0, answers = 0;
  const result = await f.settings.chat(f.input(history), mock(payload => {
    if (isSummary(payload)) { summaries++; return reply('AUTO_SUMMARY：研究目标与实验结论需要原文核查。'); }
    answers++; assert.ok(JSON.stringify(payload.messages).includes('AUTO_SUMMARY'));
    return reply('长会话继续完成。');
  }));
  assert.equal(result.ok, true, result.message); assert.ok(summaries > 1); assert.equal(answers, 1);
  const stored = (await f.archive.load(f.id)).messages;
  assert.equal(stored.length, 72); assert.deepEqual(stored.slice(0, history.length), history);
  assert.ok((await f.archive.loadCompaction(f.id))!.coveredMessages > 0);
});

test('summary failure and cancellation preserve complete submitted history and the last valid summary', async () => {
  const f = await fixture(), initial = messages(12);
  const initialResult = await f.settings.chat(f.input(initial, true), mock(() => reply('EXISTING_SUMMARY：保留研究目标和已确认结论。')));
  assert.equal(initialResult.ok, true, initialResult.message);
  const oldSummary = await readFile(f.contextPath);
  const longer = [...initial, ...messages(61, initial.length)];
  let calls = 0;
  const failed = await f.settings.chat(f.input(longer), mock(payload => {
    calls++; assert.ok(isSummary(payload));
    return new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'content-type': 'application/json' } });
  }));
  assert.equal(failed.ok, false); assert.equal(calls, 1);
  assert.deepEqual((await f.archive.load(f.id)).messages, longer); assert.deepEqual(await readFile(f.contextPath), oldSummary);
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const request = f.input(longer);
  const pending = f.settings.chat(request, mock((payload, init) => {
    assert.ok(isSummary(payload)); started();
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('fixture cancelled')), { once: true }));
  }));
  await ready; f.settings.cancelChat(request.requestId);
  const cancelled = await pending; assert.equal(cancelled.ok, false); assert.equal(cancelled.cancelled, true);
  assert.deepEqual((await f.archive.load(f.id)).messages, longer); assert.deepEqual(await readFile(f.contextPath), oldSummary);
  await f.settings.whenIdle();
});

test('pre-save corruption stops before network, and explicit clear removes summary applicability', async () => {
  const f = await fixture(), history = messages(12);
  assert.equal((await f.settings.chat(f.input(history, true), mock(() => reply('SUMMARY_BEFORE_CLEAR')))).ok, true);
  await f.archive.clear(f.id);
  const fresh = [{ role: 'user' as const, content: '全新问题' }];
  const result = await f.settings.chat(f.input(fresh), mock(payload => {
    assert.equal(JSON.stringify(payload).includes('SUMMARY_BEFORE_CLEAR'), false);
    return reply('新会话回答');
  }));
  assert.equal(result.ok, true, result.message); assert.equal((await f.archive.load(f.id)).messages.length, 2);
  await writeFile(f.archivePath, 'invalid archive');
  const failed = await f.settings.chat(f.input([...fresh, { role: 'assistant', content: result.content! }, { role: 'user', content: '继续' }]), mock(() => {
    assert.fail('failed archive pre-save must prevent network');
  }));
  assert.equal(failed.ok, false); assert.match(failed.message, /尚未发送/); assert.equal(await readFile(f.archivePath, 'utf8'), 'invalid archive');
});
