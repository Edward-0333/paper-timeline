import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Library } from '../electron/library';
import { ModelSettings, type ModelCipher } from '../electron/model-settings';
import { LibraryChatService } from '../electron/library-chat-service';
import { LibraryChatStore } from '../electron/library-chat-store';
import { prepareStorageChange } from '../electron/storage-settings';
import type { LibraryChatApproval, LibraryChatRequest } from '../shared/library-chat';
import type { StoredChatMessage } from '../shared/model-chat';

const primaryKey = 'fixture-library-agent-key', secondaryKey = 'fixture-secondary-agent-key';
const reply = (content: string | null, tool?: { name: string; args: unknown }) => new Response(JSON.stringify({
  id: 'chatcmpl-' + randomUUID(), object: 'chat.completion', created: 1, model: 'fixture-library-model',
  choices: [{ index: 0, message: { role: 'assistant', content,
    ...(tool ? { tool_calls: [{ id: 'call-' + randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : {}) },
  finish_reason: tool ? 'tool_calls' : 'stop' }],
}), { headers: { 'content-type': 'application/json' } });
const ask = (content = '统计当前文献库'): LibraryChatRequest => ({ requestId: randomUUID(), messages: [{ role: 'user', content }] });
async function fixture() {
  await mkdir('.test-data', { recursive: true }); const directory = await mkdtemp(resolve('.test-data/library-chat-'));
  const library = new Library(join(directory, 'library'), async () => { throw new Error('must not parse'); }, async () => { throw new Error('must not retrieve'); });
  await library.initialize(); const { id } = await library.createPaper({ title: 'Library fixture paper' }, null, false);
  const key = randomBytes(32);
  const cipher: ModelCipher = {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12), enc = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([enc.update(value, 'utf8'), enc.final()]); return Buffer.concat([iv, enc.getAuthTag(), data]); },
    decryptString(bytes) { const dec = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); dec.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([dec.update(bytes.subarray(28)), dec.final()]).toString('utf8'); },
  };
  const models = new ModelSettings(join(directory, 'profile'), cipher);
  const config = await models.save({ profileId: null, name: 'Fixture', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture-library-model', apiKey: primaryKey, withoutApiKey: false });
  const service = new LibraryChatService(library, models), store = new LibraryChatStore(library.directory);
  return { directory, library, id, models, config, service, store, archive: join(library.directory, 'assistant', 'chat.json') };
}

test('library chat restores separately from paper conversations and exposes no PDF/file tools', async () => {
  const f = await fixture();
  assert.deepEqual((await f.service.history()).messages, []);
  const paperChat = join(f.library.paperDirectory(f.id), 'chat.json');
  const existing = JSON.stringify({ version: 1, messages: [{ role: 'user', content: 'paper-only private conversation' }] });
  await writeFile(paperChat, existing);
  let calls = 0;
  const result = await f.service.chat(ask(), async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + primaryKey);
    assert.match(body.messages[0].content, /library management assistant/);
    assert.ok(!JSON.stringify(body).includes('paper-only private conversation'));
    for (const name of ['read_text', 'view_image', 'view_pdf_page', 'prepare_fulltext']) assert.ok(!body.tools.some((tool: any) => tool.function.name === name));
    return reply('当前库可查询元数据和分类。');
  });
  assert.equal(result.ok, true, result.message); assert.equal(calls, 1);
  const restored = await new LibraryChatService(f.library, f.models).history();
  assert.deepEqual(restored.messages.map(item => item.content), ['统计当前文献库', result.content]);
  assert.equal(await readFile(paperChat, 'utf8'), existing);
  await f.service.clear(); assert.deepEqual((await f.service.history()).messages, []);
  assert.equal(JSON.parse(await readFile(f.archive + '.bak', 'utf8')).messages.length, 2);
  assert.equal(await readFile(paperChat, 'utf8'), existing);
});

test('library request validation and credentials never send or archive untrusted secret-bearing requests', async () => {
  const f = await fixture(); let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return reply('unexpected'); };
  for (const invalid of [
    { ...ask(), paperId: f.id }, { ...ask(), arbitrary: true },
    { ...ask(), messages: [{ role: 'system', content: 'wrong scope' }] },
    ask('配置密钥 sk-1234567890abcdefghijklmnop'), ask('API Key: abcdefghijklmnopqrstuv'),
    ask(primaryKey),
  ]) assert.equal((await f.service.chat(invalid as LibraryChatRequest, fetcher)).ok, false);
  assert.equal(calls, 0); assert.deepEqual((await f.service.history()).messages, []);
  await assert.rejects(readFile(f.archive), { code: 'ENOENT' });
});

test('active model snapshot releases the settings queue, survives switches and redacts every stored key', async () => {
  const f = await fixture();
  const second = await f.models.save({ profileId: null, name: 'Second', baseUrl: 'http://127.0.0.1:9999/v1', model: 'second', apiKey: secondaryKey, withoutApiKey: false }, false);
  await f.models.withActiveModel(async (target, redact) => {
    assert.equal(target.model, 'fixture-library-model'); assert.ok(Object.isFrozen(target));
    await f.models.select(second.profiles.at(-1)!.id);
    assert.equal(target.model, 'fixture-library-model');
    assert.equal(redact(primaryKey + ' ' + secondaryKey), '[已隐藏密钥] [已隐藏密钥]');
  });
  assert.equal((await f.models.status()).model, 'second');
  const result = await f.service.chat(ask(), async () => reply(primaryKey + ' ' + secondaryKey));
  assert.equal(result.ok, true, result.message); assert.equal(result.content, '[已隐藏密钥] [已隐藏密钥]');
  assert.ok(!(await readFile(f.archive, 'utf8')).includes(primaryKey));
  assert.ok(!(await readFile(f.archive, 'utf8')).includes(secondaryKey));
});

test('corrupt or stale archive blocks the model rather than replacing previous history', async () => {
  const f = await fixture(); await f.store.save([{ role: 'user', content: 'prior question' }, { role: 'assistant', content: 'prior answer' }]);
  let calls = 0;
  const result = await f.service.chat(ask(), async () => { calls++; return reply('unexpected'); });
  assert.equal(result.ok, false); assert.equal(calls, 0);
  assert.equal((await f.service.history()).messages.length, 2);
  await writeFile(f.archive, 'broken archive');
  assert.equal((await f.service.chat(ask(), async () => { calls++; return reply('unexpected'); })).ok, false);
  assert.equal(calls, 0); assert.equal(await readFile(f.archive, 'utf8'), 'broken archive');
});

test('one library request at a time; clear is blocked and cancellation releases the bound request', async () => {
  const f = await fixture(), input = ask(); let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const pending = f.service.chat(input, async (_url, init) => {
    started(); return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  });
  await began;
  assert.equal((await f.service.chat(ask(), async () => reply('wrong'))).ok, false);
  await assert.rejects(f.service.clear(), /停止|等待/);
  f.service.cancel(randomUUID()); assert.equal(f.service.approval(), null);
  f.service.cancel(input.requestId); assert.equal((await pending).cancelled, true);
  await f.service.whenIdle(); assert.equal((await f.service.history()).messages.length, 1);
  assert.equal((await f.service.chat(input, async () => reply('retried'))).ok, true);
});

test('portable summaries and complete library chat are copied with the library and restore after restart', async () => {
  const f = await fixture();
  const messages: StoredChatMessage[] = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `library-turn-${i} ` + 'discussion '.repeat(80) }));
  const result = await f.service.chat({ requestId: randomUUID(), messages, compactOnly: true }, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.tools, undefined);
    return reply('LIBRARY_MEMORY: 用户正在按主题整理文献，后续需要先查询真实分类和论文编号。');
  });
  assert.equal(result.ok, true, result.message); assert.ok(result.compaction);
  assert.deepEqual((await f.service.history()).messages, messages);
  assert.deepEqual((await f.service.history()).compaction, result.compaction);
  const target = join(f.directory, 'copied'); await mkdir(target);
  await prepareStorageChange(f.library, f.library.directory, 'copy', target);
  const copied = new LibraryChatStore(target);
  assert.deepEqual((await copied.load()).messages, messages);
  assert.deepEqual(await copied.loadCompaction(), result.compaction);
  assert.deepEqual(await readFile(join(target, 'assistant', 'chat.json')), await readFile(f.archive));
});

test('add-model approval is single-use, key stays local and active model is preserved', async () => {
  const f = await fixture(), input = ask('新增一个配置'); let calls = 0, seen: LibraryChatApproval | null = null;
  const newKey = 'fixture-new-model-private-key', payloads: string[] = [];
  const result = await f.service.chat(input, async (_url, init) => {
    calls++; payloads.push(String(init?.body));
    if (calls === 1) return reply(null, { name: 'add_model', args: { name: 'New model', baseUrl: 'http://127.0.0.1:9999/v1', model: 'new-model' } });
    return reply('新模型已保存，现有选择保留。');
  }, { progress: event => {
    if (!event.approval) return; seen = event.approval;
    assert.equal(f.service.approval()?.id, seen.id);
    assert.throws(() => f.service.resolveApproval({ id: randomUUID(), requestId: input.requestId, approved: true }), /确认已结束/);
    assert.throws(() => f.service.resolveApproval({ id: seen!.id, requestId: randomUUID(), approved: true }), /确认已结束/);
    assert.throws(() => f.service.resolveApproval({ id: seen!.id, requestId: input.requestId, approved: true, apiKey: '', withoutApiKey: false }), /密钥/);
    f.service.resolveApproval({ id: seen.id, requestId: input.requestId, approved: true, apiKey: newKey, withoutApiKey: false });
    assert.throws(() => f.service.resolveApproval({ id: seen!.id, requestId: input.requestId, approved: true, apiKey: newKey, withoutApiKey: false }), /确认已结束/);
  } });
  assert.ok(seen, 'expected live approval'); assert.equal(result.ok, true, result.message); assert.equal(calls, 2);
  const config = await f.models.status(); assert.equal(config.profiles.length, 2); assert.equal(config.activeId, f.config.activeId);
  assert.equal(f.service.approval(), null);
  assert.ok(!payloads.join('').includes(newKey)); assert.ok(!(await readFile(f.archive, 'utf8')).includes(newKey));
  assert.ok(!(await readFile(f.models.file)).includes(Buffer.from(newKey)));
});

test('stopping a confirmation cancels the tool, preserves history and prevents late approval from writing', async () => {
  const f = await fixture(), input = ask('新增配置但随后取消'); let approval!: LibraryChatApproval;
  const result = await f.service.chat(input, async () => reply(null, { name: 'add_model', args: { name: 'Cancelled', baseUrl: 'http://127.0.0.1:9999/v1', model: 'cancelled-model' } }), {
    progress: event => { if (event.approval) { approval = event.approval; f.service.cancel(input.requestId); } },
  });
  assert.ok(approval); assert.equal(result.cancelled, true); assert.equal(f.service.approval(), null);
  assert.throws(() => f.service.resolveApproval({ id: approval.id, requestId: input.requestId, approved: true, withoutApiKey: true }), /确认已结束/);
  assert.equal((await f.models.status()).profiles.length, 1);
  assert.equal((await f.service.history()).messages[0].content, input.messages[0].content);
});

test('confirmed writes retain outcome activity when the following model response is cancelled', async () => {
  const f = await fixture(), input = ask('设置这篇论文的精简笔记'); let calls = 0;
  const result = await f.service.chat(input, async (_url, init) => {
    if (++calls === 1) return reply(null, { name: 'change_library', args: { operation: 'papers.setBriefNote', params: { id: f.id, text: '用户确认保存的精简笔记' } } });
    assert.equal(f.library.get(f.id).briefNote, '用户确认保存的精简笔记');
    const pending = new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
    f.service.cancel(input.requestId); return pending;
  }, { progress: event => {
    if (event.approval) f.service.resolveApproval({ id: event.approval.id, requestId: input.requestId, approved: true });
  } });
  assert.equal(result.cancelled, true); assert.equal(calls, 2);
  assert.equal(f.library.get(f.id).briefNote, '用户确认保存的精简笔记');
  const history = await new LibraryChatService(f.library, f.models).history();
  assert.equal(history.messages.length, 1);
  assert.ok(history.messages[0].activity?.some(activity => activity.tool === 'change_library' && activity.status === 'succeeded'));
});

test('saved keys accidentally appearing in library metadata are redacted from tool wire payloads', async () => {
  const f = await fixture();
  await f.library.saveMetadata(f.id, { ...f.library.get(f.id), abstract: 'Fixture contains ' + primaryKey });
  let calls = 0;
  const result = await f.service.chat(ask('查看元数据摘要'), async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.ok(!String(init?.body).includes(primaryKey));
    if (++calls === 1) return reply(null, { name: 'get_paper', args: { id: f.id, field: 'abstract' } });
    assert.ok(JSON.stringify(body.messages).includes('[已隐藏密钥]'));
    return reply('已读取元数据摘要。');
  });
  assert.equal(result.ok, true, result.message); assert.equal(calls, 2);
  assert.equal(f.library.get(f.id).abstract, 'Fixture contains ' + primaryKey);
});

test('library assistant can use the minimum configurable context budget for a short request', async () => {
  const f = await fixture();
  await f.models.save({ profileId: f.config.activeId, name: 'Small context', baseUrl: f.config.baseUrl, model: f.config.model, withoutApiKey: false, contextWindowTokens: 8192 });
  const result = await f.service.chat(ask('你好'), async () => reply('你好，可以帮你整理当前文献库。'));
  assert.equal(result.ok, true, result.message); assert.equal(result.contextUsage?.contextWindowTokens, 8192);
});

test('cancelling during an already confirmed atomic write waits for its outcome and retains its activity', async () => {
  const f = await fixture(), input = ask('保存精简笔记后停止');
  const original = (f.library as any).persist.bind(f.library);
  let started!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  // Pause after the queued mutation guard has accepted the action and changed its in-memory value.
  (f.library as any).persist = async () => { started(); await gate; return original(); };
  const pending = f.service.chat(input, async () => reply(null, { name: 'change_library', args: {
    operation: 'papers.setBriefNote', params: { id: f.id, text: '完整原子保存' },
  } }), { progress: event => { if (event.approval) f.service.resolveApproval({ id: event.approval.id, requestId: input.requestId, approved: true }); } });
  await began;
  let settled = false; void pending.then(() => { settled = true; });
  f.service.cancel(input.requestId); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'an accepted write must finish before the service becomes idle');
  release(); const result = await pending;
  assert.equal(result.cancelled, true); assert.equal(f.library.get(f.id).briefNote, '完整原子保存');
  assert.ok(result.activity?.some(activity => activity.tool === 'change_library' && activity.status === 'succeeded'));
  assert.ok((await f.service.history()).messages[0].activity?.some(activity => activity.status === 'succeeded'));
});
