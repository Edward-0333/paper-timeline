import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Library } from '../electron/library';
import { LibraryChatService } from '../electron/library-chat-service';
import { LibraryChatStore } from '../electron/library-chat-store';
import { ModelSettings, type ModelCipher } from '../electron/model-settings';
import { LIBRARY_CHAT_ID, type LibraryChatApproval, type LibraryChatRequest } from '../shared/library-chat';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const ask = (conversationId: string, content: string): LibraryChatRequest => ({ conversationId, requestId: randomUUID(), messages: [{ role: 'user', content }] });
const reply = (content: string | null, tool?: { name: string; args: unknown }) => new Response(JSON.stringify({
  choices: [{ index: 0, message: { role: 'assistant', content,
    ...(tool ? { tool_calls: [{ id: 'call-' + randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : {}) },
  finish_reason: tool ? 'tool_calls' : 'stop' }],
}), { headers: { 'content-type': 'application/json' } });

async function fixture(t: TestContext) {
  await mkdir('.test-data', { recursive: true });
  const directory = await mkdtemp(resolve('.test-data/library-delete-'));
  const library = new Library(join(directory, 'library'), async () => { throw new Error('No PDF access in deletion tests'); }, async () => { throw new Error('No metadata lookup'); });
  await library.initialize();
  const paperId = (await library.createPaper({ title: 'Deletion isolation fixture' }, null, false)).id;
  const key = randomBytes(32);
  const cipher: ModelCipher = {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12), enc = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([enc.update(value, 'utf8'), enc.final()]); return Buffer.concat([iv, enc.getAuthTag(), data]); },
    decryptString(bytes) { const dec = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); dec.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([dec.update(bytes.subarray(28)), dec.final()]).toString('utf8'); },
  };
  const models = new ModelSettings(join(directory, 'profile'), cipher);
  await models.save({ profileId: null, name: 'Deletion fixture', baseUrl: 'http://127.0.0.1:9999/v1', model: 'deletion-fixture', withoutApiKey: true });
  const service = new LibraryChatService(library, models);
  t.after(async () => { service.cancelAll(); await service.whenIdle(); });
  return { directory, library, models, service, paperId };
}

test('deletion selects a remaining conversation, persists empty history and blocks stale requests without a model call', async t => {
  const f = await fixture(t), a = await f.service.create(), b = await f.service.create();
  assert.equal((await f.service.chat(ask(a.id, 'Delete this conversation'), async () => reply('Saved answer'))).ok, true);
  const beforeLibrary = await readFile(join(f.library.directory, 'library.json'));
  const removed = await f.service.remove(a.id);
  assert.equal(removed.activeId, b.id); assert.ok(!removed.conversations.some(entry => entry.id === a.id));
  let calls = 0;
  assert.equal((await f.service.chat(ask(a.id, 'Stale draft'), async () => { calls++; return reply('must not send'); })).ok, false);
  await assert.rejects(f.service.history(a.id)); await assert.rejects(f.service.remove(a.id));
  assert.equal(calls, 0); assert.deepEqual(await readFile(join(f.library.directory, 'library.json')), beforeLibrary);
  assert.equal((await f.service.remove(b.id)).activeId, LIBRARY_CHAT_ID);
  assert.deepEqual(await f.service.remove(LIBRARY_CHAT_ID), { conversations: [], activeId: null });
  const restored = new LibraryChatService(f.library, f.models);
  assert.deepEqual(await restored.list(), { conversations: [], activeId: null });
  const fresh = await restored.create(); assert.notEqual(fresh.id, a.id); assert.notEqual(fresh.id, LIBRARY_CHAT_ID);
  assert.equal((await restored.chat(ask(fresh.id, 'Fresh independent question'), async () => reply('New answer'))).ok, true);
  assert.deepEqual((await restored.history(fresh.id)).messages.map(message => message.content), ['Fresh independent question', 'New answer']);
});

test('a running reply cannot be deleted while another idle conversation can be removed', async t => {
  const f = await fixture(t), active = await f.service.create(), idle = await f.service.create();
  const began = deferred(), request = ask(active.id, 'Keep this running reply');
  const run = f.service.chat(request, async (_url, init) => {
    began.resolve(); return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  });
  await began.promise;
  await assert.rejects(f.service.remove(active.id), /正在处理/);
  assert.ok(!(await f.service.remove(idle.id)).conversations.some(entry => entry.id === idle.id));
  assert.equal((await f.service.history(active.id)).messages[0].content, 'Keep this running reply');
  f.service.cancel(request.requestId); assert.equal((await run).cancelled, true);
  await f.service.remove(active.id); await assert.rejects(f.service.history(active.id));
});

test('pending approval blocks deletion until explicitly stopped and never applies its proposed library change', async t => {
  const f = await fixture(t), entry = await f.service.create(), ready = deferred<LibraryChatApproval>();
  const request = ask(entry.id, 'Propose a note');
  const run = f.service.chat(request, async () => reply(null, { name: 'change_library', args: {
    operation: 'papers.setBriefNote', params: { id: f.paperId, text: 'Must remain unconfirmed' },
  } }), { progress: event => { if (event.approval) ready.resolve(event.approval); } });
  const pending = await ready.promise;
  await assert.rejects(f.service.remove(entry.id), /正在处理/);
  assert.equal(f.service.approval(entry.id)?.id, pending.id);
  assert.equal(f.library.get(f.paperId).briefNote, undefined);
  f.service.cancel(request.requestId); await run; await f.service.remove(entry.id);
  assert.equal(f.service.approval(entry.id), null);
  assert.throws(() => f.service.resolveApproval({ id: pending.id, requestId: request.requestId, conversationId: entry.id, approved: true }));
  assert.equal(f.library.get(f.paperId).briefNote, undefined);
});

test('clear and delete operations are mutually exclusive and duplicate delete cannot erase another conversation', async t => {
  const f = await fixture(t), a = await f.service.create(), b = await f.service.create();
  const clearEntered = deferred(), clearRelease = deferred(), originalClear = LibraryChatStore.prototype.clear;
  const heldClear = t.mock.method(LibraryChatStore.prototype, 'clear', async function(this: LibraryChatStore, id?: string) {
    clearEntered.resolve(); await clearRelease.promise; return originalClear.call(this, id);
  });
  const clearing = f.service.clear(a.id); await clearEntered.promise;
  await assert.rejects(f.service.remove(a.id), /正在处理/);
  clearRelease.resolve(); await clearing; heldClear.mock.restore();

  const deleteEntered = deferred(), deleteRelease = deferred(), originalRemove = LibraryChatStore.prototype.remove;
  const heldDelete = t.mock.method(LibraryChatStore.prototype, 'remove', async function(this: LibraryChatStore, id: string) {
    deleteEntered.resolve(); await deleteRelease.promise; return originalRemove.call(this, id);
  });
  const deleting = f.service.remove(a.id); await deleteEntered.promise;
  await assert.rejects(f.service.remove(a.id), /正在处理/); await assert.rejects(f.service.clear(a.id));
  let calls = 0;
  assert.equal((await f.service.chat(ask(a.id, 'must not start while deleting'), async () => { calls++; return reply('not sent'); })).ok, false);
  assert.equal(calls, 0);
  deleteRelease.resolve(); const result = await deleting; heldDelete.mock.restore();
  assert.ok(result.conversations.some(entry => entry.id === b.id));
  assert.deepEqual((await f.service.history(b.id)).messages, []);
});

test('failed deletion releases its lock for retry and malformed identifiers cannot delete existing history', async t => {
  const f = await fixture(t), entry = await f.service.create();
  const before = await f.service.list();
  for (const id of ['', '../assistant', 'A'.repeat(64), 'f'.repeat(64)]) await assert.rejects(f.service.remove(id));
  assert.deepEqual(await f.service.list(), before);
  const failure = t.mock.method(LibraryChatStore.prototype, 'remove', async () => { throw new Error('fixture save failure'); });
  await assert.rejects(f.service.remove(entry.id), /fixture save failure/); failure.mock.restore();
  assert.deepEqual(await f.service.list(), before);
  assert.ok(!(await f.service.remove(entry.id)).conversations.some(item => item.id === entry.id));
});
