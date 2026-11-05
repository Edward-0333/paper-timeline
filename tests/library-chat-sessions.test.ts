import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Library } from '../electron/library';
import { ModelSettings, type ModelCipher } from '../electron/model-settings';
import { LibraryChatService } from '../electron/library-chat-service';
import { prepareStorageChange } from '../electron/storage-settings';
import { LIBRARY_CHAT_ID, type LibraryChatApproval, type LibraryChatRequest } from '../shared/library-chat';
import type { StoredChatMessage } from '../shared/model-chat';

const reply = (content: string | null, tool?: { name: string; args: unknown }) => new Response(JSON.stringify({
  id: 'chatcmpl-' + randomUUID(), object: 'chat.completion', created: 1, model: 'sessions-fixture',
  choices: [{ index: 0, message: { role: 'assistant', content,
    ...(tool ? { tool_calls: [{ id: 'call-' + randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : {}) },
  finish_reason: tool ? 'tool_calls' : 'stop' }],
}), { headers: { 'content-type': 'application/json' } });
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const ask = (conversationId: string, content: string, history: StoredChatMessage[] = []): LibraryChatRequest => ({
  conversationId, requestId: randomUUID(), messages: [...history.map(({ role, content }) => ({ role, content })), { role: 'user', content }],
});
async function fixture(t: TestContext) {
  await mkdir('.test-data', { recursive: true });
  const directory = await mkdtemp(resolve('.test-data/library-sessions-'));
  const library = new Library(join(directory, 'library'), async () => { throw new Error('no PDFs in this fixture'); }, async () => { throw new Error('no external lookups'); });
  await library.initialize();
  const first = (await library.createPaper({ title: 'First session paper' }, null, false)).id;
  const second = (await library.createPaper({ title: 'Second session paper' }, null, false)).id;
  const key = randomBytes(32);
  const cipher: ModelCipher = {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12), enc = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([enc.update(value, 'utf8'), enc.final()]); return Buffer.concat([iv, enc.getAuthTag(), data]); },
    decryptString(bytes) { const dec = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); dec.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([dec.update(bytes.subarray(28)), dec.final()]).toString('utf8'); },
  };
  const models = new ModelSettings(join(directory, 'profile'), cipher);
  await models.save({ profileId: null, name: 'Session fixture', baseUrl: 'http://127.0.0.1:9999/v1', model: 'sessions-fixture', withoutApiKey: true });
  const service = new LibraryChatService(library, models);
  t.after(async () => { service.cancelAll(); await service.whenIdle(); });
  return { directory, library, models, service, first, second,
    archive: (id: string) => join(library.directory, 'assistant', ...(id === LIBRARY_CHAT_ID ? [] : ['conversations', id]), 'chat.json') };
}

test('legacy history remains byte-exact on discovery and can continue alongside a fresh conversation', async t => {
  const f = await fixture(t);
  const legacy: StoredChatMessage[] = [{ role: 'user', content: 'LEGACY_TOPIC old research plan' }, { role: 'assistant', content: 'LEGACY_ANSWER retained' }];
  const bytes = JSON.stringify({ version: 1, messages: legacy }, null, 2);
  await mkdir(join(f.library.directory, 'assistant')); await writeFile(f.archive(LIBRARY_CHAT_ID), bytes);
  const listed = await f.service.list();
  assert.ok(listed.conversations.some(item => item.id === LIBRARY_CHAT_ID));
  assert.equal(await readFile(f.archive(LIBRARY_CHAT_ID), 'utf8'), bytes);
  assert.deepEqual((await f.service.history(LIBRARY_CHAT_ID)).messages, legacy);
  const fresh = await f.service.create();
  assert.notEqual(fresh.id, LIBRARY_CHAT_ID);
  assert.deepEqual((await f.service.history(fresh.id)).messages, []);
  const newResult = await f.service.chat(ask(fresh.id, 'NEW_TOPIC only'), async (_url, init) => {
    const body = String(init?.body); assert.ok(body.includes('NEW_TOPIC')); assert.ok(!body.includes('LEGACY_TOPIC'));
    return reply('NEW_ANSWER only');
  });
  assert.equal(newResult.ok, true, newResult.message);
  assert.equal(await readFile(f.archive(LIBRARY_CHAT_ID), 'utf8'), bytes);
  const continued = await f.service.chat(ask(LIBRARY_CHAT_ID, 'LEGACY_FOLLOW_UP', legacy), async (_url, init) => {
    const body = String(init?.body); assert.ok(body.includes('LEGACY_TOPIC')); assert.ok(body.includes('LEGACY_ANSWER'));
    assert.ok(!body.includes('NEW_TOPIC')); assert.ok(!body.includes('NEW_ANSWER'));
    return reply('LEGACY_CONTINUED');
  });
  assert.equal(continued.ok, true, continued.message);
  assert.equal((await f.service.history(LIBRARY_CHAT_ID)).messages.length, 4);
  assert.deepEqual((await f.service.history(fresh.id)).messages.map(item => item.content), ['NEW_TOPIC only', 'NEW_ANSWER only']);
});

test('parallel conversations bind replies and progress to their own histories without changing selection', async t => {
  const f = await fixture(t), a = await f.service.create(), b = await f.service.create();
  const started = deferred(), release = deferred<Response>();
  await f.service.select(b.id);
  const progressA: string[] = [], progressB: string[] = [];
  const pendingA = f.service.chat(ask(a.id, 'A_PENDING_QUESTION'), async (_url, init) => {
    started.resolve(); init?.signal?.addEventListener('abort', () => release.resolve(reply('unused cancelled response')), { once: true });
    return release.promise;
  }, { progress: event => { progressA.push(event.conversationId); } });
  await started.promise;
  const resultB = await f.service.chat(ask(b.id, 'B_IMMEDIATE_QUESTION'), async (_url, init) => {
    assert.ok(!String(init?.body).includes('A_PENDING_QUESTION')); return reply('B_IMMEDIATE_ANSWER');
  }, { progress: event => { progressB.push(event.conversationId); } });
  assert.equal(resultB.ok, true, resultB.message);
  release.resolve(reply('A_DELAYED_ANSWER')); assert.equal((await pendingA).ok, true);
  assert.deepEqual((await f.service.history(a.id)).messages.map(item => item.content), ['A_PENDING_QUESTION', 'A_DELAYED_ANSWER']);
  assert.deepEqual((await f.service.history(b.id)).messages.map(item => item.content), ['B_IMMEDIATE_QUESTION', 'B_IMMEDIATE_ANSWER']);
  assert.equal((await f.service.list()).activeId, b.id);
  assert.ok(progressA.length && progressA.every(id => id === a.id));
  assert.ok(progressB.length && progressB.every(id => id === b.id));
});

test('approval identity includes conversation, and confirming or rejecting one cannot resolve another', async t => {
  const f = await fixture(t), a = await f.service.create(), b = await f.service.create();
  const readyA = deferred<LibraryChatApproval>(), readyB = deferred<LibraryChatApproval>();
  let callsA = 0, callsB = 0;
  const requestA = ask(a.id, 'Set first note'), requestB = ask(b.id, 'Set second note');
  const runA = f.service.chat(requestA, async () => ++callsA === 1
    ? reply(null, { name: 'change_library', args: { operation: 'papers.setBriefNote', params: { id: f.first, text: 'approved in A' } } }) : reply('A finished'),
  { progress: event => { if (event.approval) readyA.resolve(event.approval); } });
  const runB = f.service.chat(requestB, async () => ++callsB === 1
    ? reply(null, { name: 'change_library', args: { operation: 'papers.setBriefNote', params: { id: f.second, text: 'rejected in B' } } }) : reply('B cancelled by user'),
  { progress: event => { if (event.approval) readyB.resolve(event.approval); } });
  const [approvalA, approvalB] = await Promise.all([readyA.promise, readyB.promise]);
  assert.equal(approvalA.conversationId, a.id); assert.equal(approvalB.conversationId, b.id);
  assert.equal(f.service.approval(a.id)?.id, approvalA.id); assert.equal(f.service.approval(b.id)?.id, approvalB.id);
  assert.throws(() => f.service.resolveApproval({ id: approvalA.id, requestId: requestA.requestId, conversationId: b.id, approved: true }));
  assert.throws(() => f.service.resolveApproval({ id: approvalA.id, requestId: requestA.requestId, approved: true }));
  assert.equal(f.library.get(f.first).briefNote, undefined); assert.equal(f.library.get(f.second).briefNote, undefined);
  f.service.resolveApproval({ id: approvalB.id, requestId: requestB.requestId, conversationId: b.id, approved: false });
  assert.equal((await runB).ok, true); assert.equal(f.service.approval(a.id)?.id, approvalA.id);
  f.service.resolveApproval({ id: approvalA.id, requestId: requestA.requestId, conversationId: a.id, approved: true });
  assert.equal((await runA).ok, true); assert.equal(f.library.get(f.first).briefNote, 'approved in A');
  assert.equal(f.library.get(f.second).briefNote, undefined);
  assert.throws(() => f.service.resolveApproval({ id: approvalA.id, requestId: requestA.requestId, conversationId: a.id, approved: true }));
  assert.ok((await f.service.history(a.id)).messages.at(-1)?.activity?.some(item => item.status === 'succeeded'));
  assert.ok((await f.service.history(b.id)).messages.at(-1)?.activity?.some(item => item.status === 'failed'));
});

test('invalid or unknown conversation IDs cannot read, clear, rename, select or start a model request', async t => {
  const f = await fixture(t); await f.service.list(); let calls = 0;
  for (const id of ['../chat', '', 'a'.repeat(64), 'A'.repeat(64), 'conversations/path']) {
    await assert.rejects(async () => f.service.history(id)); await assert.rejects(async () => f.service.clear(id));
    await assert.rejects(async () => f.service.select(id)); await assert.rejects(async () => f.service.rename(id, 'Changed'));
    const result = await f.service.chat(ask(id, 'not sent'), async () => { calls++; return reply('unexpected'); });
    assert.equal(result.ok, false);
  }
  assert.equal(calls, 0);
});

test('same-session overlap is blocked while other conversations can complete or clear independently', async t => {
  const f = await fixture(t), a = await f.service.create(), b = await f.service.create();
  const began = deferred(), input = ask(a.id, 'Waiting A');
  const pending = f.service.chat(input, async (_url, init) => {
    began.resolve(); return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  });
  await began.promise;
  assert.equal((await f.service.chat(ask(a.id, 'Conflicting A'), async () => reply('must not happen'))).ok, false);
  await assert.rejects(f.service.clear(a.id));
  const resultB = await f.service.chat(ask(b.id, 'Allowed B'), async () => reply('B answer'));
  assert.equal(resultB.ok, true); await f.service.clear(b.id);
  assert.deepEqual((await f.service.history(b.id)).messages, []);
  f.service.cancel(input.requestId); assert.equal((await pending).cancelled, true);
  assert.deepEqual((await f.service.history(a.id)).messages.map(item => item.content), ['Waiting A']);
  assert.equal((await f.service.chat(input, async () => reply('Retried A'))).ok, true);
});

test('conversation summaries, names, selection and archives survive copy without sharing context', async t => {
  const f = await fixture(t), a = await f.service.create(), b = await f.service.create();
  const messages: StoredChatMessage[] = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `ONLY_A_${index} ` + 'Research notes and questions. '.repeat(50) }));
  const compacted = await f.service.chat({ conversationId: a.id, requestId: randomUUID(), messages, compactOnly: true }, async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).tools, undefined); return reply('ONLY_A_MEMORY: classify papers by their research questions.');
  });
  assert.equal(compacted.ok, true, compacted.message); assert.ok(compacted.compaction);
  assert.equal(compacted.compaction.paperId, a.id);
  assert.equal((await f.service.history(b.id)).compaction, null);
  const resultB = await f.service.chat(ask(b.id, 'ONLY_B_TOPIC'), async (_url, init) => {
    assert.ok(!String(init?.body).includes('ONLY_A')); return reply('ONLY_B_ANSWER');
  });
  assert.equal(resultB.ok, true); await f.service.rename(a.id, 'Saved research discussion'); await f.service.select(a.id);
  const before = await f.service.list();
  const copy = join(f.directory, 'copied'); await mkdir(copy);
  await f.service.whenIdle(); await prepareStorageChange(f.library, f.library.directory, 'copy', copy);
  const copiedLibrary = new Library(copy, async () => { throw new Error('no PDFs'); }, async () => { throw new Error('no retrieval'); });
  await copiedLibrary.initialize(); const restored = new LibraryChatService(copiedLibrary, f.models);
  assert.deepEqual(await restored.list(), before);
  assert.deepEqual((await restored.history(a.id)).messages, messages);
  assert.deepEqual((await restored.history(a.id)).compaction, compacted.compaction);
  assert.deepEqual((await restored.history(b.id)).messages.map(item => item.content), ['ONLY_B_TOPIC', 'ONLY_B_ANSWER']);
  await restored.clear(a.id);
  assert.equal((await restored.history(a.id)).compaction, null);
  assert.deepEqual((await restored.history(a.id)).messages, []);
  assert.equal((await restored.history(b.id)).messages.length, 2);
  assert.deepEqual((await f.service.history(a.id)).messages, messages, 'copy operations do not alter the source archive');
});
