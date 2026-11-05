import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { Library } from '../electron/library';
import { LIBRARY_CHAT_ID } from '../shared/library-chat';

// Only a disposable library, an isolated Electron profile and a local fake API.
await mkdir('.test-data', { recursive: true });
const directory = await mkdtemp(resolve('.test-data/library-sessions-ui-'));
const library = new Library(join(directory, 'library'), async () => { throw new Error('No PDFs in this test'); }, async () => { throw new Error('No external lookup'); });
await library.initialize();
const paperId = (await library.createPaper({ title: 'Session approval fixture' }, null, false)).id;
const legacyMessages = [{ role: 'user', content: 'LEGACY_QUESTION classification plan' }, { role: 'assistant', content: 'LEGACY_ANSWER existing notes' }];
const legacyBytes = JSON.stringify({ version: 1, messages: legacyMessages }, null, 2);
await mkdir(join(library.directory, 'assistant'));
await writeFile(join(library.directory, 'assistant', 'chat.json'), legacyBytes);
const requests: any[] = [], held = new Set<ServerResponse>();
function respond(response: ServerResponse, content: string | null, tool?: { name: string; args: unknown }) {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content,
    ...(tool ? { tool_calls: [{ id: `fixture-call-${requests.length}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : {}) },
  finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 } }));
}
const server = createServer(async (request, response) => {
  try {
    const buffers: Buffer[] = []; for await (const part of request) buffers.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(buffers).toString('utf8')); requests.push(body);
    assert.equal(request.url, '/v1/chat/completions');
    if (!body.tools?.length) { respond(response, 'ONLY_A_MEMORY: the user is organizing the current library and checking the confirmed note.'); return; }
    const messages: any[] = body.messages;
    let lastUser = messages.length - 1; while (lastUser >= 0 && messages[lastUser].role !== 'user') lastUser--;
    const command = messages[lastUser]?.content; assert.equal(typeof command, 'string');
    const completed = messages.slice(lastUser + 1).some(message => message.role === 'tool');
    if (command === 'HOLD_A') { held.add(response); response.once('close', () => held.delete(response)); return; }
    if (command === 'APPROVE_A' && !completed) {
      respond(response, null, { name: 'change_library', args: { operation: 'papers.setBriefNote', params: { id: paperId, text: 'Confirmed only in session A' } } }); return;
    }
    respond(response, `## 会话回复\n\n${command}_ANSWER\n\n这是一条隔离测试回复。`);
  } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: { message: String(error) } })); }
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}/v1`;
const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, PAPER_TIMELINE_DATA: directory, PAPER_TIMELINE_AI: '0' })
  .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.argv.includes('--packaged');
const launch = () => electron.launch({ executablePath: resolve(packaged ? 'release/win-unpacked/Paper Timeline.exe' : 'node_modules/electron/dist/electron.exe'), ...(packaged ? {} : { args: [resolve('.')] }), env });
let app = await launch(), page = await app.firstWindow();
const errors: string[] = [], watch = () => page.on('pageerror', error => errors.push(error.message)); watch();
const chat = () => page.locator('.library-ai-chat');
const sidebar = () => page.getByRole('complementary', { name: '会话历史', exact: true });
const input = () => chat().getByRole('textbox', { name: '文献库助手消息', exact: true });
const row = (id: string) => sidebar().locator(`[data-conversation-id="${id}"]`);
const openConversation = async (id: string) => {
  await sidebar().locator(`[data-conversation-id="${id}"] [aria-label^="打开会话："], [data-conversation-id="${id}"][aria-label^="打开会话："]`).click();
  await page.waitForFunction(async selected => (await window.paperApi!.listLibraryConversations()).activeId === selected, id);
};
const selected = async () => (await page.evaluate(() => window.paperApi!.listLibraryConversations())).activeId!;
const createConversation = async () => {
  const previous = (await page.evaluate(() => window.paperApi!.listLibraryConversations())).conversations.map(item => item.id);
  await sidebar().getByRole('button', { name: '新建会话', exact: true }).click();
  await page.waitForFunction(async old => {
    const next = await window.paperApi!.listLibraryConversations(); return !!next.activeId && !old.includes(next.activeId);
  }, previous);
  return selected();
};
const send = async (content: string) => { await input().fill(content); await chat().getByRole('button', { name: '发送', exact: true }).click(); };
const idle = async (content: string) => {
  await chat().locator('.reader-ai-message.assistant').filter({ hasText: content + '_ANSWER' }).last().waitFor({ timeout: 30000 });
  await chat().getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' });
};
try {
  await page.evaluate(async url => { await window.paperApi!.saveModelConfig({ profileId: null, name: 'Sessions fixture', baseUrl: url, model: 'sessions-fixture', withoutApiKey: true }, true); }, baseUrl);
  await page.getByRole('button', { name: '开始聊天', exact: true }).click();
  await sidebar().waitFor(); await chat().getByText('LEGACY_ANSWER existing notes', { exact: true }).waitFor();
  assert.equal(await selected(), LIBRARY_CHAT_ID); assert.equal(requests.length, 0);
  assert.equal(await readFile(join(library.directory, 'assistant', 'chat.json'), 'utf8'), legacyBytes);
  assert.ok((await row(LIBRARY_CHAT_ID).innerText()).includes('LEGACY_QUESTION'));
  assert.equal(await sidebar().getByText('项目', { exact: true }).count(), 0);
  const legacyBox = await sidebar().boundingBox(), chatBox = await chat().boundingBox();
  assert.ok(legacyBox && chatBox && legacyBox.x + legacyBox.width <= chatBox.x + 2, 'history must sit to the left of the conversation');

  const a = await createConversation();
  assert.equal(await chat().getByRole('article').count(), 0); assert.equal(requests.length, 0);
  await send('HOLD_A'); await chat().getByRole('button', { name: '停止生成', exact: true }).waitFor();
  await input().fill('Unsent draft in A');
  const b = await createConversation();
  assert.equal(await input().inputValue(), '');
  await send('ONLY_B_FIRST'); await idle('ONLY_B_FIRST');
  assert.ok((await row(b).innerText()).includes('ONLY_B_FIRST'));
  const bBody = requests.find(body => body.messages.some((message: any) => message.role === 'user' && message.content === 'ONLY_B_FIRST'));
  assert.ok(bBody); assert.ok(!JSON.stringify(bBody).includes('HOLD_A')); assert.ok(!JSON.stringify(bBody).includes('LEGACY_QUESTION'));
  await input().fill('Unsent draft in B');
  assert.ok(held.size, 'session A is still running while B completed');
  for (const response of held) respond(response, '## 后台回复\n\nHOLD_A_ANSWER');
  await page.waitForFunction(async id => (await window.paperApi!.getLibraryChatHistory(id)).messages.some(message => message.role === 'assistant' && message.content.includes('HOLD_A_ANSWER')), a);
  assert.equal(await selected(), b); assert.equal(await input().inputValue(), 'Unsent draft in B');
  assert.equal(await chat().getByText('HOLD_A_ANSWER', { exact: true }).count(), 0, 'background A reply must not appear in B');
  await openConversation(a); await chat().getByText('HOLD_A_ANSWER', { exact: true }).waitFor();
  assert.equal(await input().inputValue(), 'Unsent draft in A');
  await openConversation(b); assert.equal(await input().inputValue(), 'Unsent draft in B');

  await openConversation(LIBRARY_CHAT_ID); await send('LEGACY_CONTINUE'); await idle('LEGACY_CONTINUE');
  const legacyBody = requests.find(body => body.messages.some((message: any) => message.role === 'user' && message.content === 'LEGACY_CONTINUE'));
  assert.ok(JSON.stringify(legacyBody).includes('LEGACY_QUESTION')); assert.ok(!JSON.stringify(legacyBody).includes('ONLY_B_FIRST'));
  assert.ok(!JSON.stringify(legacyBody).includes('HOLD_A'));

  await openConversation(a); await send('APPROVE_A');
  const approval = () => chat().getByRole('form', { name: '待确认操作', exact: true });
  await approval().waitFor({ timeout: 30000 });
  const pending = await page.evaluate(id => window.paperApi!.getLibraryChatApproval(id), a); assert.ok(pending);
  await openConversation(b); assert.equal(await approval().count(), 0);
  const rejectedCrossSession = await page.evaluate(async ({ pending, wrong }) => {
    try { await window.paperApi!.resolveLibraryChatApproval({ id: pending.id, requestId: pending.requestId, conversationId: wrong, approved: true }); return false; }
    catch { return true; }
  }, { pending, wrong: b });
  assert.equal(rejectedCrossSession, true);
  await send('ONLY_B_SECOND'); await idle('ONLY_B_SECOND');
  assert.equal((await page.evaluate(() => window.paperApi!.getLibrary())).papers.find(item => item.id === paperId)!.briefNote, undefined);
  await openConversation(a); await approval().waitFor();
  await approval().getByRole('button', { name: '确认执行', exact: true }).click(); await idle('APPROVE_A');
  assert.equal((await page.evaluate(() => window.paperApi!.getLibrary())).papers.find(item => item.id === paperId)!.briefNote, 'Confirmed only in session A');

  await send('ONLY_A_THIRD'); await idle('ONLY_A_THIRD');
  await chat().getByRole('button', { name: '立即压缩', exact: true }).click();
  await chat().getByText(/已摘要压缩/).waitFor({ timeout: 30000 });
  await chat().getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' });
  const aHistory = await page.evaluate(id => window.paperApi!.getLibraryChatHistory(id), a);
  assert.equal(aHistory.compaction?.paperId, a);
  await openConversation(b); assert.equal(await chat().getByText('查看历史摘要', { exact: true }).count(), 0);
  assert.equal((await page.evaluate(id => window.paperApi!.getLibraryChatHistory(id), b)).compaction, null);
  const beforeNaming = requests.length;
  await chat().getByRole('button', { name: '重命名会话', exact: true }).click();
  await chat().getByLabel('会话名称', { exact: true }).fill('我的文献整理计划');
  await chat().getByRole('button', { name: '保存名称', exact: true }).click();
  await sidebar().getByRole('button', { name: '打开会话：我的文献整理计划', exact: true }).waitFor();
  await sidebar().getByRole('textbox', { name: '搜索会话', exact: true }).fill('整理计划');
  assert.equal(await sidebar().locator('[data-conversation-id]').count(), 1);
  assert.equal(await sidebar().locator('[data-conversation-id]').getAttribute('data-conversation-id'), b);
  await sidebar().getByRole('textbox', { name: '搜索会话', exact: true }).fill('');
  assert.equal(requests.length, beforeNaming, 'renaming and searching do not call a model');
  const layout = await page.evaluate(() => {
    const history = document.querySelector<HTMLElement>('.library-ai-history')!.getBoundingClientRect();
    const conversation = document.querySelector<HTMLElement>('.library-ai-conversation')!.getBoundingClientRect();
    const entries = [...document.querySelectorAll<HTMLElement>('.library-ai-history-item')].map(item => item.getBoundingClientRect());
    return { sidebarWidth: history.width, sidebarRight: history.right, conversationLeft: conversation.left,
      conversationWidth: conversation.width, vertical: entries.every((item, index) => !index || item.top >= entries[index - 1].bottom) };
  });
  assert.ok(layout.sidebarWidth >= 160 && layout.sidebarWidth <= 320, 'history is a compact left sidebar');
  assert.ok(layout.conversationLeft >= layout.sidebarRight - 1 && layout.conversationWidth > layout.sidebarWidth, 'conversation uses the larger right area');
  assert.ok(layout.vertical, 'history entries stack vertically');
  await page.screenshot({ path: join(directory, 'session-history-layout.png'), fullPage: true });

  const beforeRestart = requests.length;
  const names = (await page.evaluate(() => window.paperApi!.listLibraryConversations())).conversations;
  await app.close(); app = await launch(); page = await app.firstWindow(); watch();
  await page.getByRole('button', { name: '开始聊天', exact: true }).click(); await sidebar().waitFor();
  await chat().locator('.reader-ai-message.assistant').filter({ hasText: 'ONLY_B_SECOND_ANSWER' }).waitFor();
  assert.equal(await selected(), b); assert.equal(requests.length, beforeRestart);
  assert.deepEqual((await page.evaluate(() => window.paperApi!.listLibraryConversations())).conversations, names);
  await openConversation(a); await chat().getByText(/已摘要压缩/).waitFor();
  await chat().getByText('查看历史摘要', { exact: true }).click(); await chat().getByText(/ONLY_A_MEMORY/).waitFor();
  await openConversation(LIBRARY_CHAT_ID); await chat().locator('.reader-ai-message.assistant').filter({ hasText: 'LEGACY_CONTINUE_ANSWER' }).waitFor();
  assert.equal(requests.length, beforeRestart, 'history switching remains offline');
  await send('LEGACY_AFTER_RESTART'); await idle('LEGACY_AFTER_RESTART');
  const lastBody = requests.at(-1);
  assert.ok(JSON.stringify(lastBody).includes('LEGACY_QUESTION')); assert.ok(!JSON.stringify(lastBody).includes('ONLY_A_MEMORY'));
  assert.ok(!JSON.stringify(lastBody).includes('ONLY_B_FIRST'));
  await page.screenshot({ path: join(directory, 'continued-history.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, directory, packaged, requests: requests.length, conversations: names.length,
    checks: 'legacy preservation, left history/new sessions, per-session requests/drafts/summaries/approvals, parallel background replies, cross-session approval rejection, offline restart and continued historical chat' }));
} catch (error) {
  await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('Sessions desktop failure', directory, await page.locator('body').innerText().catch(() => 'unavailable'));
  throw error;
} finally {
  for (const response of held) response.destroy();
  if (app.process().exitCode === null) await app.close();
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
}
