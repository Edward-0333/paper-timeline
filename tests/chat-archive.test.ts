import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PaperChatStore } from '../electron/paper-chat-store';
import type { Library } from '../electron/library';
import { MODEL_CHAT_LIMITS, type ChatCompaction, type StoredChatMessage } from '../shared/model-chat';

const id = 'a'.repeat(64), otherId = 'b'.repeat(64);
async function fixture() {
  await mkdir('.test-data', { recursive: true });
  const directory = await mkdtemp(resolve('.test-data/chat-archive-'));
  const folders = new Map([[id, join(directory, 'paper-a')], [otherId, join(directory, 'paper-b')]]);
  for (const path of folders.values()) await mkdir(path);
  let refreshes = 0;
  const library = {
    get(paperId: string) { if (!folders.has(paperId)) throw new Error('unknown-paper'); return { id: paperId }; },
    paperDirectory(paperId: string) { const folder = folders.get(paperId); if (!folder) throw new Error('unknown-paper'); return folder; },
    async refreshAiIndex() { refreshes++; },
  } as unknown as Pick<Library, 'get' | 'paperDirectory' | 'refreshAiIndex'>;
  return { directory, library, store: new PaperChatStore(library), path: join(folders.get(id)!, 'chat.json'),
    contextPath: join(folders.get(id)!, 'chat-context.json'), refreshes: () => refreshes };
}
const conversation = (count = 10): StoredChatMessage[] => Array.from({ length: count }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user', content: `message-${index} ` + 'fixture text '.repeat(100),
}));
function compaction(messages: StoredChatMessage[], coveredMessages = messages.length - 2): ChatCompaction {
  return { version: 1, paperId: id, summary: '关注实验结果；结论见全文 L12–L20；待确认样本量。', coveredMessages,
    prefixHash: createHash('sha256').update(JSON.stringify(messages.slice(0, coveredMessages).map(({ role, content }) => ({ role, content })))).digest('hex'),
    updatedAt: '2026-11-05T00:00:00.000Z', model: 'fixture-model-a' };
}

test('complete archive retains old v1 turns and provenance beyond the former 64-message/100000-character limits', async () => {
  const f = await fixture(), messages = conversation(120);
  messages[1].sources = [{ id: 'fulltext:revision:L12-L20', label: '全文 L12–L20' }];
  messages[1].activity = [{ tool: 'read_text', label: '读取全文', status: 'succeeded' }];
  await writeFile(f.path, JSON.stringify({ version: 1, messages: messages.slice(0, 2) }));
  await f.store.save(id, messages.map(({ role, content }) => ({ role, content })));
  const restored = await new PaperChatStore(f.library).load(id);
  assert.deepEqual(restored.messages, messages);
  assert.equal(restored.messages.length, 120);
  assert.equal(JSON.parse(await readFile(f.path + '.bak', 'utf8')).messages.length, 2);
  assert.equal(f.refreshes(), 1);
});

test('stale, truncated and divergent sessions cannot overwrite the complete archive', async () => {
  const f = await fixture(), messages = conversation();
  await f.store.save(id, messages);
  const before = await readFile(f.path);
  await assert.rejects(f.store.save(id, messages.slice(2)), /未覆盖历史/);
  await assert.rejects(f.store.save(id, messages.slice(0, -2)), /未覆盖历史/);
  await assert.rejects(f.store.save(id, messages.map((item, i) => i === 0 ? { ...item, content: 'changed' } : item)), /未覆盖历史/);
  await assert.rejects(f.store.save(id, []), /未覆盖历史/);
  assert.deepEqual(await readFile(f.path), before);
  const extension = [...messages, { role: 'user' as const, content: 'new question' }];
  const results = await Promise.allSettled([f.store.save(id, extension), f.store.save(id, messages)]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.deepEqual((await f.store.load(id)).messages, extension);
});

test('summary persists independently, keeps its backup, survives model changes and leaves full history intact', async () => {
  const f = await fixture(), messages = conversation(), state = compaction(messages);
  await f.store.save(id, messages);
  const before = await readFile(f.path);
  await f.store.saveCompaction(id, state);
  assert.deepEqual(await new PaperChatStore(f.library).loadCompaction(id), state);
  const next = { ...state, model: 'fixture-deepseek', summary: '跨模型继续使用文字摘要，仍可回查全文 L12–L20。' };
  await f.store.saveCompaction(id, next);
  assert.deepEqual(await f.store.loadCompaction(id), next);
  assert.deepEqual(JSON.parse(await readFile(f.contextPath + '.bak', 'utf8')), state);
  assert.deepEqual(await readFile(f.path), before);
  assert.equal(await f.store.loadCompaction(otherId), null);
  const refreshes = f.refreshes(), backup = await readFile(f.contextPath + '.bak');
  await f.store.save(id, messages); await f.store.saveCompaction(id, next);
  assert.equal(f.refreshes(), refreshes);
  assert.deepEqual(await readFile(f.contextPath + '.bak'), backup);
});

test('summary validates paper ownership, coverage, prefix integrity and bounds without replacing valid state', async () => {
  const f = await fixture(), messages = conversation(), state = compaction(messages);
  await f.store.save(id, messages); await f.store.saveCompaction(id, state);
  const before = await readFile(f.contextPath);
  for (const candidate of [
    { ...state, paperId: otherId }, { ...state, coveredMessages: messages.length + 1 },
    { ...state, prefixHash: 'c'.repeat(64) }, { ...state, summary: 'x'.repeat(12001) },
    { ...state, updatedAt: 'invalid' }, { ...state, model: 'model\nwrong' },
    { ...state, coveredMessages: -1 }, { ...state, unexpected: true },
  ]) await assert.rejects(f.store.saveCompaction(id, candidate));
  assert.deepEqual(await readFile(f.contextPath), before);
  await assert.rejects(f.store.saveCompaction(id, compaction(messages, 2)), /已有更新/);
  await writeFile(f.contextPath, JSON.stringify({ ...state, prefixHash: 'd'.repeat(64) }));
  assert.equal(await f.store.loadCompaction(id), null);
  assert.deepEqual((await f.store.load(id)).messages, messages);
});

test('explicit clear preserves backups and invalidates summary before starting another conversation', async () => {
  const f = await fixture(), messages = conversation(), state = compaction(messages);
  await f.store.save(id, messages); await f.store.saveCompaction(id, state);
  await f.store.clear(id);
  assert.deepEqual((await f.store.load(id)).messages, []);
  assert.equal(await f.store.loadCompaction(id), null);
  assert.deepEqual(JSON.parse(await readFile(f.path + '.bak', 'utf8')).messages, messages);
  assert.deepEqual(JSON.parse(await readFile(f.contextPath + '.bak', 'utf8')), state);
  // A leftover/restored summary from an interrupted older version cannot describe this empty/new archive.
  await copyFile(f.contextPath + '.bak', f.contextPath);
  assert.equal(await f.store.loadCompaction(id), null);
  await f.store.save(id, [{ role: 'user', content: 'a different new conversation' }]);
  assert.equal(await f.store.loadCompaction(id), null);
  await assert.rejects(f.store.saveCompaction(id, state), /不一致/);
});

test('damaged files are preserved and valid archives remain accessible when only the summary is damaged', async () => {
  const f = await fixture(), messages = conversation(), state = compaction(messages);
  await f.store.save(id, messages);
  await writeFile(f.contextPath, 'damaged context');
  await assert.rejects(f.store.loadCompaction(id), /上下文摘要无法读取/);
  await assert.rejects(f.store.saveCompaction(id, state), /上下文摘要无法读取/);
  assert.equal(await readFile(f.contextPath, 'utf8'), 'damaged context');
  assert.deepEqual((await f.store.load(id)).messages, messages);
  await writeFile(f.path, 'damaged archive');
  await assert.rejects(f.store.save(id, messages), /对话记录无法读取/);
  await assert.rejects(f.store.clear(id), /对话记录无法读取/);
  assert.equal(await readFile(f.path, 'utf8'), 'damaged archive');
});

test('oversized archives reject safely and hard-linked files/backups are not written through', async () => {
  const f = await fixture(), messages = conversation();
  const file = await open(f.path, 'w'); await file.truncate(64 * 1024 * 1024 + 1); await file.close();
  await assert.rejects(f.store.load(id), /对话记录无法读取/);
  await assert.rejects(f.store.save(id, messages), /对话记录无法读取/);
  const g = await fixture(), backing = join(g.directory, 'backing.json');
  await writeFile(backing, JSON.stringify({ version: 1, messages })); await link(backing, g.path);
  const before = await readFile(backing);
  await assert.rejects(g.store.load(id), /对话记录无法读取/);
  await assert.rejects(g.store.save(id, [...messages, { role: 'user', content: 'new' }]));
  assert.deepEqual(await readFile(backing), before);
  const h = await fixture(); await h.store.save(id, messages);
  await link(backing, h.contextPath + '.bak');
  await assert.rejects(h.store.clear(id), /链接/);
  assert.deepEqual((await h.store.load(id)).messages, messages);
});

test('archive limit errors never silently drop turns or replace the previous file', async () => {
  const f = await fixture(), messages = conversation(); await f.store.save(id, messages);
  const before = await readFile(f.path);
  await assert.rejects(f.store.save(id, Array.from({ length: MODEL_CHAT_LIMITS.messages + 1 }, () => ({ role: 'user', content: 'x' }))));
  assert.deepEqual(await readFile(f.path), before);
});
