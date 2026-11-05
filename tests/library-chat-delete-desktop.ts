import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rmdir } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { Library } from '../electron/library';
import { LibraryChatStore } from '../electron/library-chat-store';
import { LIBRARY_CHAT_ID } from '../shared/library-chat';
import type { ChatCompaction, StoredChatMessage } from '../shared/model-chat';

// All archives, settings and HTTP traffic belong to this disposable fixture.
await mkdir('.test-data', { recursive: true });
const directory = await mkdtemp(resolve('.test-data/library-delete-ui-'));
const library = new Library(join(directory, 'library'), async () => { throw new Error('No PDF access'); }, async () => { throw new Error('No remote metadata'); });
await library.initialize();
await library.createPaper({ title: 'Deletion keeps this paper' }, null, false);
const store = new LibraryChatStore(library.directory);
async function seed(id: string, title: string) {
  const messages: StoredChatMessage[] = [{ role: 'user', content: title }, { role: 'assistant', content: title + ' 的回复' }];
  await store.save(messages, id);
  const memory: ChatCompaction = { version: 1, paperId: id, coveredMessages: messages.length,
    prefixHash: createHash('sha256').update(JSON.stringify(messages)).digest('hex'), summary: title + ' 的摘要', model: 'delete-fixture', updatedAt: new Date().toISOString() };
  await store.saveCompaction(memory, id); await store.saveCompaction({ ...memory, summary: title + ' 的最新摘要' }, id);
  await store.save([...messages, { role: 'user', content: title + ' 的后续问题' }], id);
}
await store.list(); await seed(LIBRARY_CHAT_ID, '保留的历史会话');
const a = await store.create(); await seed(a.id, '要删除的整理计划');
const b = await store.create(); await seed(b.id, '当前正在阅读的会话');
await store.select(b.id);
const beforeLibrary = await readFile(join(library.directory, 'library.json'));
const files = ['chat.json', 'chat.json.bak', 'chat-context.json', 'chat-context.json.bak'];
const targetDirectory = store.conversationDirectory(a.id);
const originalTarget = await Promise.all(files.map(file => readFile(join(targetDirectory, file))));
const originalLegacy = await Promise.all(files.map(file => readFile(join(store.directory, file))));
let requests = 0;
const held = new Set<ServerResponse>();
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests++;
  if (body.messages.some((message: { role: string; content: unknown }) => message.role === 'user' && message.content === 'HOLD_DELETE_FIXTURE')) {
    held.add(response); response.once('close', () => held.delete(response)); return;
  }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '新会话可以正常继续对话。' }, finish_reason: 'stop' }] }));
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, PAPER_TIMELINE_DATA: directory, PAPER_TIMELINE_AI: '0' })
  .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.argv.includes('--packaged');
const launch = () => electron.launch({ executablePath: resolve(packaged ? 'release/win-unpacked/Paper Timeline.exe' : 'node_modules/electron/dist/electron.exe'), ...(packaged ? {} : { args: [resolve('.')] }), env });
let app = await launch(), page = await app.firstWindow();
const errors: string[] = [], watch = () => page.on('pageerror', error => errors.push(error.message)); watch();
const sidebar = () => page.getByRole('complementary', { name: '会话历史', exact: true });
const chat = () => page.locator('.library-ai-chat');
const dialog = () => page.getByRole('dialog', { name: '是否确定删除会话？', exact: true });
const deleteButton = (title: string) => sidebar().getByRole('button', { name: '删除会话：' + title, exact: true });
const selected = async () => (await page.evaluate(() => window.paperApi!.listLibraryConversations())).activeId;
const verifyUnchanged = async () => {
  assert.equal(await selected(), b.id, 'opening/cancelling an inactive row deletion does not select it');
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(targetDirectory, file)))), originalTarget);
  assert.equal((await page.evaluate(() => window.paperApi!.listLibraryConversations())).conversations.length, 3);
};
try {
  await page.evaluate(async baseUrl => { await window.paperApi!.saveModelConfig({ profileId: null, name: 'Deletion UI fixture', baseUrl, model: 'deletion-fixture', withoutApiKey: true }, true); }, `http://127.0.0.1:${address.port}/v1`);
  await page.getByRole('button', { name: '开始聊天', exact: true }).click(); await sidebar().waitFor();
  await chat().getByText('当前正在阅读的会话 的回复', { exact: true }).waitFor();
  assert.equal(requests, 0);
  await deleteButton('要删除的整理计划').click(); await dialog().waitFor();
  await dialog().getByText('要删除的整理计划', { exact: true }).waitFor();
  assert.equal(await dialog().getByRole('button', { name: '取消', exact: true }).evaluate(element => document.activeElement === element), true);
  await page.screenshot({ path: join(directory, 'delete-confirmation.png'), fullPage: true });
  await dialog().getByRole('button', { name: '取消', exact: true }).click(); await dialog().waitFor({ state: 'hidden' }); await verifyUnchanged();
  await deleteButton('要删除的整理计划').click(); await dialog().waitFor();
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' }); await verifyUnchanged();
  await deleteButton('要删除的整理计划').click(); await dialog().waitFor();
  await page.mouse.click(8, 8); await dialog().waitFor({ state: 'hidden' }); await verifyUnchanged();

  await chat().getByRole('textbox', { name: '文献库助手消息', exact: true }).fill('HOLD_DELETE_FIXTURE');
  await chat().getByRole('button', { name: '发送', exact: true }).click();
  await chat().getByRole('button', { name: '停止生成', exact: true }).waitFor();
  assert.equal(await deleteButton('当前正在阅读的会话').isDisabled(), true, 'running conversation cannot be deleted');
  // A directory where the target archive should be simulates a recoverable filesystem failure.
  const targetArchive = join(targetDirectory, 'chat.json'), heldArchive = join(targetDirectory, 'held-fixture-chat.json');
  await rename(targetArchive, heldArchive); await mkdir(targetArchive);
  await deleteButton('要删除的整理计划').click(); await dialog().waitFor();
  await dialog().getByRole('button', { name: '确认删除', exact: true }).click();
  await dialog().getByRole('alert').waitFor();
  assert.equal((await page.evaluate(() => window.paperApi!.listLibraryConversations())).conversations.length, 3);
  assert.equal(await selected(), b.id);
  await rmdir(targetArchive); await rename(heldArchive, targetArchive);
  // Two synchronous clicks exercise the submit guard without depending on IPC timing.
  await dialog().getByRole('button', { name: '确认删除', exact: true }).evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
  await dialog().waitFor({ state: 'hidden' }); await deleteButton('要删除的整理计划').waitFor({ state: 'hidden' });
  assert.equal(await selected(), b.id); assert.equal((await page.evaluate(() => window.paperApi!.listLibraryConversations())).conversations.length, 2);
  for (const file of files) await assert.rejects(readFile(join(targetDirectory, file)), { code: 'ENOENT' });
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(store.directory, file)))), originalLegacy);
  await chat().getByRole('button', { name: '停止生成', exact: true }).click();
  await chat().getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' });
  await deleteButton('当前正在阅读的会话').click(); await dialog().getByRole('button', { name: '确认删除', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' }); await chat().getByText('保留的历史会话 的回复', { exact: true }).waitFor();
  assert.equal(await selected(), LIBRARY_CHAT_ID);
  await deleteButton('保留的历史会话').click(); await dialog().getByRole('button', { name: '确认删除', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
  await page.waitForFunction(async () => (await window.paperApi!.listLibraryConversations()).activeId === null);
  assert.equal(await sidebar().locator('[data-conversation-id]').count(), 0);
  assert.equal(await chat().getByRole('article').count(), 0);
  for (const file of files) await assert.rejects(readFile(join(store.directory, file)), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(library.directory, 'library.json')), beforeLibrary);
  const beforeRestart = requests;
  await page.screenshot({ path: join(directory, 'empty-history.png'), fullPage: true });
  await app.close(); app = await launch(); page = await app.firstWindow(); watch();
  await page.getByRole('button', { name: '开始聊天', exact: true }).click(); await sidebar().waitFor();
  assert.deepEqual(await page.evaluate(() => window.paperApi!.listLibraryConversations()), { conversations: [], activeId: null });
  assert.equal(requests, beforeRestart, 'restart and deleting histories do not call the model');
  await sidebar().getByRole('button', { name: '新建会话', exact: true }).click();
  await page.waitForFunction(async () => !!(await window.paperApi!.listLibraryConversations()).activeId);
  const fresh = await selected(); assert.ok(fresh && ![a.id, b.id, LIBRARY_CHAT_ID].includes(fresh));
  await chat().getByRole('textbox', { name: '文献库助手消息', exact: true }).fill('Start again');
  await chat().getByRole('button', { name: '发送', exact: true }).click();
  await chat().getByText('新会话可以正常继续对话。', { exact: true }).waitFor({ timeout: 30000 });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, directory, packaged, requests,
    checks: 'cancel-focus/Escape/backdrop preserve files, inactive delete preserves selection, busy protection, failure/retry, duplicate guard, scoped transcript/summary/backup deletion, active fallback, empty restart and fresh continuation' }));
} catch (error) {
  await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('Delete desktop failure', directory, await page.locator('body').innerText().catch(() => 'unavailable'));
  throw error;
} finally {
  for (const response of held) response.destroy();
  if (app.process().exitCode === null) await app.close();
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
}
