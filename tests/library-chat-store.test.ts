import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, link, mkdir, mkdtemp, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LibraryChatStore } from '../electron/library-chat-store';
import { LIBRARY_CHAT_ID } from '../shared/library-chat';
import type { ChatCompaction, StoredChatMessage } from '../shared/model-chat';

async function fixture() {
  await mkdir('.test-data', { recursive: true });
  const directory = await mkdtemp(resolve('.test-data/library-sessions-'));
  const library = join(directory, 'library'); await mkdir(library);
  const store = new LibraryChatStore(library);
  return { directory, library, store, root: join(library, 'assistant') };
}
const messages = (question: string): StoredChatMessage[] => [{ role: 'user', content: question }, { role: 'assistant', content: '答复：' + question,
  activity: [{ tool: 'library_info', label: '查询文献库', status: 'succeeded' }] }];
const summary = (paperId: string, transcript: StoredChatMessage[]): ChatCompaction => ({ version: 1, paperId, coveredMessages: transcript.length,
  prefixHash: createHash('sha256').update(JSON.stringify(transcript.map(({ role, content }) => ({ role, content })))).digest('hex'),
  summary: '已保留用户目标与确认结果。', model: 'fixture-model', updatedAt: new Date().toISOString() });

test('legacy full archive, summary and backups register in place without rewriting any original bytes', async () => {
  const f = await fixture(); await mkdir(f.root);
  const transcript = messages('之前的文献库整理目标'), raw = JSON.stringify({ version: 1, messages: transcript }, null, 4);
  const memory = JSON.stringify(summary(LIBRARY_CHAT_ID, transcript), null, 4);
  await writeFile(join(f.root, 'chat.json'), raw); await writeFile(join(f.root, 'chat-context.json'), memory);
  await writeFile(join(f.root, 'chat.json.bak'), 'older transcript backup'); await writeFile(join(f.root, 'chat-context.json.bak'), 'older summary backup');
  const list = await f.store.list(); assert.equal(list.activeId, LIBRARY_CHAT_ID); assert.equal(list.conversations.length, 1);
  assert.equal(list.conversations[0].title, transcript[0].content); assert.equal(list.conversations[0].messageCount, 2);
  assert.deepEqual((await f.store.load()).messages, transcript); assert.equal((await f.store.loadCompaction())?.summary, '已保留用户目标与确认结果。');
  assert.equal(await readFile(join(f.root, 'chat.json'), 'utf8'), raw); assert.equal(await readFile(join(f.root, 'chat-context.json'), 'utf8'), memory);
  assert.equal(await readFile(join(f.root, 'chat.json.bak'), 'utf8'), 'older transcript backup');
  assert.equal(await readFile(join(f.root, 'chat-context.json.bak'), 'utf8'), 'older summary backup');
  assert.deepEqual(await new LibraryChatStore(f.library).list(), list);
});

test('new sessions have independent transcripts, summaries, first-question titles and persistent selection', async () => {
  const f = await fixture(), original = await f.store.list(); assert.equal(original.conversations[0].title, '新会话');
  const a = await f.store.create(), b = await f.store.create(); assert.notEqual(a.id, b.id); assert.notEqual(a.id, LIBRARY_CHAT_ID);
  assert.match(a.id, /^[a-f0-9]{64}$/);
  const aMessages = messages('  整理\n 强化学习 文献  '), bMessages = messages('配置新的阅读模型');
  await f.store.save(aMessages, a.id); await f.store.save(bMessages, b.id);
  await f.store.saveCompaction(summary(a.id, aMessages), a.id); await f.store.saveCompaction(summary(b.id, bMessages), b.id);
  const selected = await f.store.select(a.id); assert.equal(selected.activeId, a.id);
  assert.equal(selected.conversations.find(item => item.id === a.id)?.title, '整理 强化学习 文献');
  assert.deepEqual((await f.store.load(a.id)).messages, aMessages); assert.deepEqual((await f.store.load(b.id)).messages, bMessages);
  assert.deepEqual((await f.store.load()).messages, []);
  assert.equal((await f.store.loadCompaction(a.id))?.paperId, a.id); assert.equal((await f.store.loadCompaction(b.id))?.paperId, b.id);
  assert.equal(await readFile(join(f.root, 'conversations', a.id, 'chat.json'), 'utf8'), JSON.stringify({ version: 1, messages: aMessages }, null, 2));
  assert.equal((await new LibraryChatStore(f.library).list()).activeId, a.id);
});

test('renaming survives future answers and does not alter transcript or summary', async () => {
  const f = await fixture(), entry = await f.store.create(), before = messages('默认标题');
  await f.store.save(before, entry.id); await f.store.saveCompaction(summary(entry.id, before));
  await f.store.rename(entry.id, '  我的文献整理  ');
  await f.store.save([...before, { role: 'user', content: '继续上次内容' }], entry.id);
  const restored = new LibraryChatStore(f.library), list = await restored.list();
  assert.equal(list.conversations.find(item => item.id === entry.id)?.title, '我的文献整理');
  assert.equal((await restored.load(entry.id)).messages.length, 3); assert.ok(await restored.loadCompaction(entry.id));
  await assert.rejects(restored.rename(entry.id, '  ')); await assert.rejects(restored.rename(entry.id, 'bad\nname'));
});

test('concurrent session creation and saves preserve every entry and selected identity', async () => {
  const f = await fixture(); const entries = await Promise.all(Array.from({ length: 12 }, () => f.store.create()));
  assert.equal(new Set(entries.map(entry => entry.id)).size, 12);
  await Promise.all(entries.map((entry, index) => f.store.save(messages('会话 ' + index), entry.id)));
  await f.store.select(entries[4].id); await f.store.whenIdle();
  const list = await f.store.list(); assert.equal(list.conversations.length, 13); assert.equal(list.activeId, entries[4].id);
  for (const [index, entry] of entries.entries()) assert.deepEqual((await f.store.load(entry.id)).messages, messages('会话 ' + index));
});

test('prefix and summary ownership checks prevent cross-session replacement', async () => {
  const f = await fixture(), a = await f.store.create(), b = await f.store.create();
  await f.store.save(messages('Session A'), a.id); await f.store.save(messages('Session B'), b.id);
  const original = await readFile(join(f.root, 'conversations', a.id, 'chat.json'));
  await assert.rejects(f.store.save(messages('Session B'), a.id), /记录已更新/);
  await assert.rejects(f.store.saveCompaction(summary(b.id, messages('Session B')), a.id), /不属于/);
  await assert.rejects(f.store.saveCompaction(summary(a.id, messages('Session B')), a.id), /不一致/);
  assert.deepEqual(await readFile(join(f.root, 'conversations', a.id, 'chat.json')), original);
});

test('clear affects only the selected session and preserves its recovery backups', async () => {
  const f = await fixture(), a = await f.store.create(), b = await f.store.create();
  const transcript = messages('Will clear'); await f.store.save(transcript, a.id); await f.store.saveCompaction(summary(a.id, transcript));
  await f.store.save(messages('Will preserve'), b.id); await f.store.clear(a.id);
  assert.deepEqual((await f.store.load(a.id)).messages, []); assert.equal(await f.store.loadCompaction(a.id), null);
  assert.deepEqual((await f.store.load(b.id)).messages, messages('Will preserve'));
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'conversations', a.id, 'chat.json.bak'), 'utf8')).messages, transcript);
  const entry = (await f.store.list()).conversations.find(item => item.id === a.id)!; assert.equal(entry.messageCount, 0); assert.equal(entry.title, '新会话');
});

test('corrupt legacy archive or summary stays untouched while new sessions remain usable', async () => {
  const f = await fixture(); await mkdir(f.root); await writeFile(join(f.root, 'chat.json'), '{damaged archive');
  await writeFile(join(f.root, 'chat-context.json'), '{damaged memory');
  const list = await f.store.list(); assert.match(list.conversations[0].title, /历史会话/);
  await assert.rejects(f.store.load(), /无法读取/); await assert.rejects(f.store.loadCompaction(), /无法读取/);
  const entry = await f.store.create(); await f.store.save(messages('New independent conversation'), entry.id);
  assert.equal((await f.store.load(entry.id)).messages.length, 2);
  assert.equal(await readFile(join(f.root, 'chat.json'), 'utf8'), '{damaged archive');
  assert.equal(await readFile(join(f.root, 'chat-context.json'), 'utf8'), '{damaged memory');
});

test('corrupt or invalid session indexes reject reads and writes without replacing records', async () => {
  const f = await fixture(); await f.store.save(messages('Keep originals'));
  const archive = await readFile(join(f.root, 'chat.json'));
  await writeFile(f.store.indexPath, '{damaged index');
  for (const operation of [() => f.store.list(), () => f.store.create(), () => f.store.save(messages('Overwrite?')), () => f.store.clear()]) await assert.rejects(operation(), /会话列表无法读取/);
  assert.equal(await readFile(f.store.indexPath, 'utf8'), '{damaged index'); assert.deepEqual(await readFile(join(f.root, 'chat.json')), archive);
  const invalid = { version: 1, activeId: '../outside', conversations: [] }; await writeFile(f.store.indexPath, JSON.stringify(invalid));
  await assert.rejects(f.store.list(), /会话列表无法读取/); assert.deepEqual(JSON.parse(await readFile(f.store.indexPath, 'utf8')), invalid);
});

test('unsafe, unknown and unregistered conversation identities cannot read or create archives', async () => {
  const f = await fixture(); await f.store.list();
  for (const id of ['../outside', 'a'.repeat(63), 'A'.repeat(64), '']) {
    assert.throws(() => f.store.load(id), /无效/); assert.throws(() => f.store.save(messages('test'), id), /无效/);
  }
  await assert.rejects(f.store.load('f'.repeat(64)), /找不到/);
  await assert.rejects(f.store.save(messages('test'), 'f'.repeat(64)), /找不到/);
  await assert.rejects(f.store.select('f'.repeat(64)), /找不到/);
  assert.equal((await f.store.list()).conversations.length, 1);
});

test('failed index publication and linked indexes preserve previous list and archives', async () => {
  const f = await fixture(); await f.store.list(); const before = await readFile(f.store.indexPath);
  await mkdir(f.store.indexPath + '.bak');
  await assert.rejects(f.store.create()); assert.deepEqual(await readFile(f.store.indexPath), before);
  assert.equal((await f.store.list()).conversations.length, 1);
  const g = await fixture(); await g.store.list(); const preserved = join(g.directory, 'original-index.json');
  await rename(g.store.indexPath, preserved); await link(preserved, g.store.indexPath);
  await assert.rejects(g.store.list(), /会话列表无法读取/); await assert.rejects(g.store.create(), /会话列表无法读取/);
  assert.deepEqual(await readFile(preserved), await readFile(g.store.indexPath));
});

test('missing published index never silently resets an existing multi-session library', async () => {
  const f = await fixture(); await f.store.create(); await rename(f.store.indexPath, join(f.directory, 'saved-index.json'));
  await assert.rejects(new LibraryChatStore(f.library).list(), /会话列表缺失/);
  await assert.rejects(readFile(f.store.indexPath), { code: 'ENOENT' });
});

test('missing nonempty archive cannot be replaced by a new empty history or overwrite its backup', async () => {
  const f = await fixture(), entry = await f.store.create(), original = messages('Existing important conversation');
  await f.store.save(original, entry.id);
  await f.store.save([...original, { role: 'user', content: 'One further question' }], entry.id);
  const chat = join(f.store.conversationDirectory(entry.id), 'chat.json');
  const backup = await readFile(chat + '.bak'); await rename(chat, join(f.directory, 'saved-chat.json'));
  for (const operation of [() => f.store.load(entry.id), () => f.store.loadCompaction(entry.id), () => f.store.save(messages('new'), entry.id),
    () => f.store.saveCompaction(summary(entry.id, original)), () => f.store.clear(entry.id)]) await assert.rejects(operation(), /会话记录缺失/);
  assert.deepEqual(await readFile(chat + '.bak'), backup); await assert.rejects(readFile(chat), { code: 'ENOENT' });
  const fresh = await f.store.create(); assert.deepEqual((await f.store.load(fresh.id)).messages, []);
});

test('copying the complete assistant directory restores names, selection, transcripts and independent summaries', async () => {
  const f = await fixture(), a = await f.store.create(), b = await f.store.create();
  await f.store.save(messages('Copy A'), a.id); await f.store.saveCompaction(summary(a.id, messages('Copy A')));
  await f.store.save(messages('Copy B'), b.id); await f.store.rename(a.id, '自定义会话'); await f.store.select(a.id); await f.store.whenIdle();
  const destination = join(f.directory, 'copied-library'); await mkdir(destination);
  await cp(f.root, join(destination, 'assistant'), { recursive: true, errorOnExist: true, force: false });
  const copied = new LibraryChatStore(destination); assert.deepEqual(await copied.list(), await f.store.list());
  assert.deepEqual(await copied.load(a.id), await f.store.load(a.id)); assert.deepEqual(await copied.loadCompaction(a.id), await f.store.loadCompaction(a.id));
  await copied.save([...messages('Copy B'), { role: 'user', content: '继续副本中的会话' }], b.id);
  assert.equal((await f.store.load(b.id)).messages.length, 2); assert.equal((await copied.load(b.id)).messages.length, 3);
});

const archiveFiles = ['chat.json', 'chat.json.bak', 'chat-context.json', 'chat-context.json.bak'];
async function filledSession(store: LibraryChatStore, id: string, question = 'A conversation to delete') {
  const transcript = messages(question);
  await store.save(transcript, id); await store.saveCompaction(summary(id, transcript), id);
  const directory = store.conversationDirectory(id);
  await writeFile(join(directory, 'chat.json.bak'), 'Previous transcript');
  await writeFile(join(directory, 'chat-context.json.bak'), 'Previous summary');
  return directory;
}
async function assertArchivesMissing(directory: string) {
  for (const name of archiveFiles) await assert.rejects(readFile(join(directory, name)), { code: 'ENOENT' });
}

test('deleting an inactive session removes only its four archives and preserves selection and all unrelated files', async () => {
  const f = await fixture(), a = await f.store.create(), b = await f.store.create();
  const directory = await filledSession(f.store, a.id);
  await f.store.save(messages('Keep another history'), b.id); await f.store.select(b.id);
  const otherArchive = await readFile(join(f.store.conversationDirectory(b.id), 'chat.json'));
  await writeFile(join(directory, 'my-notes.md'), 'User extra file');
  await mkdir(join(directory, 'attachments')); await writeFile(join(directory, 'attachments', 'example.txt'), 'Keep nested extra');
  await writeFile(join(f.root, 'preferences.json'), 'Assistant extra');
  await mkdir(join(f.library, 'papers')); await writeFile(join(f.library, 'papers', 'original.pdf'), 'Keep paper');
  await writeFile(join(f.library, 'library.json'), 'Keep metadata');
  const result = await f.store.remove(a.id);
  assert.equal(result.activeId, b.id); assert.equal(result.cleanupWarning, undefined);
  assert.equal(result.conversations.some(entry => entry.id === a.id), false);
  await assertArchivesMissing(directory);
  assert.deepEqual(await readFile(join(f.store.conversationDirectory(b.id), 'chat.json')), otherArchive);
  assert.equal(await readFile(join(directory, 'my-notes.md'), 'utf8'), 'User extra file');
  assert.equal(await readFile(join(directory, 'attachments', 'example.txt'), 'utf8'), 'Keep nested extra');
  assert.equal(await readFile(join(f.root, 'preferences.json'), 'utf8'), 'Assistant extra');
  assert.equal(await readFile(join(f.library, 'papers', 'original.pdf'), 'utf8'), 'Keep paper');
  assert.equal(await readFile(join(f.library, 'library.json'), 'utf8'), 'Keep metadata');
  assert.deepEqual(await new LibraryChatStore(f.library).list(), result);
  await assert.rejects(f.store.load(a.id), /找不到/); await assert.rejects(f.store.save(messages('Do not resurrect'), a.id), /找不到/);
});

test('deleting the selected session chooses the adjacent displayed row, then permits an empty list', async () => {
  const f = await fixture(); await f.store.create(); await f.store.create();
  let rows = (await f.store.list()).conversations;
  await f.store.select(rows[1].id);
  let result = await f.store.remove(rows[1].id); assert.equal(result.activeId, rows[2].id);
  rows = result.conversations; await f.store.select(rows[1].id);
  result = await f.store.remove(rows[1].id); assert.equal(result.activeId, rows[0].id);
  result = await f.store.remove(rows[0].id); assert.deepEqual(result, { activeId: null, conversations: [] });
  assert.deepEqual(await new LibraryChatStore(f.library).list(), result);
  const next = await f.store.create(); assert.equal((await f.store.list()).activeId, next.id);
  assert.equal((await f.store.list()).conversations.length, 1); assert.deepEqual((await f.store.load(next.id)).messages, []);
});

test('deleting the legacy root session preserves the index, newer sessions and extra assistant files', async () => {
  const f = await fixture(); await filledSession(f.store, LIBRARY_CHAT_ID);
  const next = await f.store.create(); await filledSession(f.store, next.id, 'A surviving new session');
  await writeFile(join(f.root, 'extra.txt'), 'Not an archive');
  const otherDirectory = f.store.conversationDirectory(next.id);
  const before = await Promise.all(archiveFiles.map(name => readFile(join(otherDirectory, name))));
  const result = await f.store.remove(LIBRARY_CHAT_ID);
  assert.equal(result.activeId, next.id); assert.deepEqual(result.conversations.map(entry => entry.id), [next.id]);
  await assertArchivesMissing(f.root);
  assert.equal(await readFile(join(f.root, 'extra.txt'), 'utf8'), 'Not an archive');
  assert.deepEqual(await Promise.all(archiveFiles.map(name => readFile(join(otherDirectory, name)))), before);
  assert.deepEqual(await new LibraryChatStore(f.library).list(), result);
  assert.ok(await readFile(f.store.indexPath)); assert.ok(await readFile(f.store.indexPath + '.bak'));
});

test('deleting the only legacy session does not recreate it on subsequent restarts', async () => {
  const f = await fixture(); await filledSession(f.store, LIBRARY_CHAT_ID);
  assert.deepEqual(await f.store.remove(LIBRARY_CHAT_ID), { activeId: null, conversations: [] });
  await assertArchivesMissing(f.root);
  for (let attempt = 0; attempt < 3; attempt++) assert.deepEqual(await new LibraryChatStore(f.library).list(), { activeId: null, conversations: [] });
  const replacement = await new LibraryChatStore(f.library).create(); assert.notEqual(replacement.id, LIBRARY_CHAT_ID);
  assert.deepEqual((await f.store.list()).conversations.map(entry => entry.id), [replacement.id]);
});

test('deletion rejects invalid or unknown IDs and unsafe files before changing the index or any archive', async () => {
  const f = await fixture(), entry = await f.store.create(); const directory = await filledSession(f.store, entry.id);
  const before = await readFile(f.store.indexPath), transcript = await readFile(join(directory, 'chat.json'));
  for (const id of ['../outside', 'a'.repeat(63), 'A'.repeat(64), '']) assert.throws(() => f.store.remove(id), /无效/);
  await assert.rejects(f.store.remove('f'.repeat(64)), /找不到/);
  const backup = join(directory, 'chat-context.json.bak'), extra = join(f.directory, 'linked-summary-backup');
  await rename(backup, extra); await link(extra, backup);
  await assert.rejects(f.store.remove(entry.id), /链接/);
  assert.deepEqual(await readFile(f.store.indexPath), before); assert.deepEqual(await readFile(join(directory, 'chat.json')), transcript);
  assert.equal(await readFile(extra, 'utf8'), 'Previous summary');
});

test('deletion rejects a linked session directory without touching its target', async () => {
  const f = await fixture(), entry = await f.store.create(); const directory = await filledSession(f.store, entry.id);
  const outside = join(f.directory, 'outside-library-session'), before = await readFile(f.store.indexPath);
  await rename(directory, outside); await symlink(outside, directory, 'junction');
  await assert.rejects(f.store.remove(entry.id), /链接/);
  assert.deepEqual(await readFile(f.store.indexPath), before);
  assert.equal((await readdir(outside)).length, 4);
});

test('failed deletion index publication preserves every archive and the existing selection', async () => {
  const f = await fixture(), entry = await f.store.create(); const directory = await filledSession(f.store, entry.id);
  const before = await readFile(f.store.indexPath), archives = await Promise.all(archiveFiles.map(name => readFile(join(directory, name))));
  await rename(f.store.indexPath + '.bak', join(f.directory, 'kept-index-backup'));
  await mkdir(f.store.indexPath + '.bak');
  await assert.rejects(f.store.remove(entry.id));
  assert.deepEqual(await readFile(f.store.indexPath), before);
  assert.deepEqual(await Promise.all(archiveFiles.map(name => readFile(join(directory, name)))), archives);
  assert.equal((await f.store.list()).activeId, entry.id);
  assert.equal((await readdir(f.root)).some(name => name.endsWith('.tmp')), false);
});

test('a committed deletion with interrupted cleanup reports success and safely resumes after restart', async t => {
  const f = await fixture(), entry = await f.store.create(); const directory = await filledSession(f.store, entry.id);
  await writeFile(join(directory, 'keep.txt'), 'Keep extra during recovery');
  const internal = f.store as unknown as { purgeConversation(id: string): Promise<void> };
  t.mock.method(internal, 'purgeConversation', async () => {
    await unlink(join(directory, 'chat.json')); throw new Error('Simulated locked remaining file after the first unlink');
  });
  const result = await f.store.remove(entry.id);
  assert.equal(result.conversations.some(item => item.id === entry.id), false); assert.match(result.cleanupWarning!, /尚未清理/);
  assert.deepEqual(JSON.parse(await readFile(f.store.indexPath, 'utf8')).pendingDeletionIds, [entry.id]);
  assert.ok(await readFile(join(directory, 'chat-context.json')));
  const reopened = new LibraryChatStore(f.library), recovered = await reopened.list();
  assert.equal(recovered.cleanupWarning, undefined); assert.equal(recovered.conversations.some(item => item.id === entry.id), false);
  await assertArchivesMissing(directory); assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), 'Keep extra during recovery');
  assert.equal(JSON.parse(await readFile(f.store.indexPath, 'utf8')).pendingDeletionIds, undefined);
});

test('failure to retire a cleanup tombstone cannot turn a committed deletion into an operation failure', async t => {
  const f = await fixture(); await filledSession(f.store, LIBRARY_CHAT_ID);
  const internal = f.store as unknown as { writeIndex(index: unknown): Promise<void> }, writeIndex = internal.writeIndex.bind(internal);
  let writes = 0;
  t.mock.method(internal, 'writeIndex', async (index: unknown) => {
    if (++writes === 2) throw new Error('Simulated failure after files were removed');
    await writeIndex(index);
  });
  const result = await f.store.remove(LIBRARY_CHAT_ID);
  assert.equal(result.activeId, null); assert.deepEqual(result.conversations, []); assert.ok(result.cleanupWarning);
  await assertArchivesMissing(f.root);
  assert.deepEqual(await new LibraryChatStore(f.library).list(), { activeId: null, conversations: [] });
});

test('cleanup recovery refuses links and invalid or overlapping tombstones without deleting live data', async () => {
  const f = await fixture(), entry = await f.store.create(); const directory = await filledSession(f.store, entry.id);
  const original = JSON.parse(await readFile(f.store.indexPath, 'utf8'));
  for (const pendingDeletionIds of [[entry.id], ['../outside'], ['e'.repeat(64), 'e'.repeat(64)]]) {
    await writeFile(f.store.indexPath, JSON.stringify({ ...original, pendingDeletionIds }));
    await assert.rejects(new LibraryChatStore(f.library).list(), /会话列表无法读取/);
    assert.ok(await readFile(join(directory, 'chat.json')));
  }
  const pending = { ...original, activeId: LIBRARY_CHAT_ID, conversations: original.conversations.filter((item: { id: string }) => item.id !== entry.id), pendingDeletionIds: [entry.id] };
  await writeFile(f.store.indexPath, JSON.stringify(pending));
  const linkedOriginal = join(f.directory, 'preserved-linked-chat');
  await rename(join(directory, 'chat.json'), linkedOriginal); await link(linkedOriginal, join(directory, 'chat.json'));
  const recovered = await new LibraryChatStore(f.library).list();
  assert.ok(recovered.cleanupWarning); assert.equal(recovered.conversations.some(item => item.id === entry.id), false);
  assert.equal((await readdir(directory)).length, 4); assert.ok(await readFile(linkedOriginal));
  assert.deepEqual(JSON.parse(await readFile(f.store.indexPath, 'utf8')).pendingDeletionIds, [entry.id]);
});
