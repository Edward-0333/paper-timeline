import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { Library } from '../electron/library';
import { localMetadata } from '../electron/metadata';
import { citationSeed, writeCitationSnapshot } from '../electron/citation-monitor';

// Only disposable papers/settings and a local fake provider. Never open the
// production library, model credentials, or an external model endpoint.
await mkdir('.test-data', { recursive: true });
const directory = await mkdtemp(resolve('.test-data/library-chat-ui-'));
const library = new Library(join(directory, 'library'), async () => { throw new Error('PDF reading is outside this fixture'); },
  async pdf => ({ metadata: localMetadata(pdf), matched: true, message: 'fixture' }));
await library.initialize();
const paperId = (await library.createPaper({ title: 'Library assistant fixture', authors: ['Fixture Author'], publicationDate: '2025' }, null, false)).id;
await library.createPaper({ title: 'Other fixture preserved', authors: ['Second Author'] }, null, false);
const seed = library.get(paperId);
await writeCitationSnapshot(library.directory, { version: 1, seed: citationSeed(seed), citations: [], providers: [], lastAttemptAt: '', nextCheckAt: '' }, seed.storageFolder);
const brokenCitationFile = join(library.citationDirectory(paperId), 'citations.json');
const brokenCitation = JSON.stringify({ version: 1, seed: citationSeed(seed), citations: [{ id: 'invalid-id' }], providers: [], lastAttemptAt: '', nextCheckAt: '' });
await writeFile(brokenCitationFile, brokenCitation);
const requests: any[] = [];
let addedId = '', baseUrl = '';
const secondaryKey = 'sk-fixture-local-secret-123456789';
const primaryKey = 'fixtureSavedCredential847291046';
type Call = { name: string; arguments: Record<string, unknown> };
function plan(command: string): Call[] {
  if (command === 'DIAGNOSE_CLOUD') return [{ name: 'diagnose_cloud', arguments: {} }];
  if (command === 'READ_LIBRARY') return [{ name: 'library_info', arguments: {} }, { name: 'list_papers', arguments: { limit: 20 } }];
  if (command.startsWith('RENAME_')) return [{ name: 'get_paper', arguments: { id: paperId } }, { name: 'change_library', arguments: {
    operation: 'metadata.update', params: { id: paperId, fields: { title: command === 'RENAME_CONFIRM' ? 'Confirmed managed title' : command === 'RENAME_REJECT' ? 'Rejected title' : 'Stopped title' } },
  } }];
  if (command === 'ADD_MODEL') return [{ name: 'list_models', arguments: {} }, { name: 'add_model', arguments: { name: 'Secondary fixture', baseUrl, model: 'library-second', contextWindowTokens: 32768 } }];
  if (command === 'SELECT_MODEL') return [{ name: 'list_models', arguments: {} }, { name: 'select_model', arguments: { id: addedId } }];
  if (command === 'WRITE_THEN_FAIL') return [{ name: 'get_paper', arguments: { id: paperId } }, { name: 'change_library', arguments: {
    operation: 'papers.setBriefNote', params: { id: paperId, text: 'Confirmed note survives model error' },
  } }];
  return [{ name: 'library_info', arguments: {} }];
}
const server = createServer(async (request, response) => {
  try {
    const buffers: Buffer[] = []; for await (const chunk of request) buffers.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(buffers).toString('utf8')); requests.push(body);
    assert.equal(request.url, '/v1/chat/completions');
    const messages = body.messages as any[];
    let userAt = messages.length - 1;
    while (userAt >= 0 && messages[userAt].role !== 'user') userAt--;
    const command = messages[userAt]?.content;
    assert.equal(typeof command, 'string');
    const completed = messages.slice(userAt + 1).filter(message => message.role === 'tool').length;
    const call = plan(command)[completed];
    if (command === 'DIAGNOSE_CLOUD' && !call) {
      const diagnostic = JSON.parse(messages.at(-1).content);
      assert.equal(diagnostic.connection.state, 'not_signed_in');
      assert.equal(diagnostic.local.issues[0].paperId, paperId);
      assert.equal(diagnostic.local.issues[0].field, 'citations[0].id');
      assert.equal(diagnostic.local.issues[0].severity, 'error');
    }
    if (command === 'WRITE_THEN_FAIL' && !call) { response.writeHead(503); response.end(JSON.stringify({ error: { message: 'Fixture response failure after confirmed write' } })); return; }
    const message = call ? { role: 'assistant', content: null, tool_calls: [{ id: `fixture-${requests.length}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: 'assistant', content: `## 管理结果\n\n**${command}** 已处理。\n\n|项目|状态|\n|---|---|\n|文献库|已检查|\n\n这是一条隔离测试回复。` };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }));
  } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: { message: String(error) } })); }
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address(); assert.ok(address && typeof address !== 'string');
baseUrl = `http://127.0.0.1:${address.port}/v1`;
const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, PAPER_TIMELINE_DATA: directory, PAPER_TIMELINE_AI: '0' })
  .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.argv.includes('--packaged');
const launch = () => electron.launch({ executablePath: resolve(packaged ? 'release/win-unpacked/Paper Timeline.exe' : 'node_modules/electron/dist/electron.exe'), ...(packaged ? {} : { args: [resolve('.')] }), env });
let app = await launch(), page = await app.firstWindow();
const errors: string[] = [];
const watchErrors = () => page.on('pageerror', error => errors.push(error.message)); watchErrors();
const chat = () => page.locator('.library-ai-chat');
const approval = () => chat().getByRole('form', { name: '待确认操作', exact: true });
const send = async (command: string) => {
  await chat().getByRole('textbox', { name: '文献库助手消息', exact: true }).fill(command);
  await chat().getByRole('button', { name: '发送', exact: true }).click();
};
const idle = async (command: string) => {
  await chat().locator('.reader-ai-message.assistant').filter({ hasText: command }).last().waitFor({ timeout: 30000 });
  await chat().getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 30000 });
};
const getTitle = async () => (await page.evaluate(() => window.paperApi!.getLibrary())).papers.find(paper => paper.id === paperId)!.title;
const archiveText = () => readFile(join(library.directory, 'assistant', 'chat.json'), 'utf8');
try {
  // Configure the first fake model using the real, existing UI.
  await page.getByRole('button', { name: '配置大模型', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await page.locator('#model-config-name').fill('Primary fixture');
  await page.locator('#model-config-url').fill(baseUrl); await page.locator('#model-config-model').fill('library-first');
  await page.locator('#model-config-key').fill(primaryKey);
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await dialog.getByRole('button', { name: '选择', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  const primary = await page.evaluate(() => window.paperApi!.getModelConfig());

  await page.getByRole('button', { name: '开始聊天', exact: true }).click();
  await chat().getByRole('textbox', { name: '文献库助手消息', exact: true }).waitFor();
  assert.equal(requests.length, 0, 'opening the assistant must stay offline');
  await page.getByRole('button', { name: '个人首页', exact: true }).click();
  await page.getByRole('button', { name: '开始聊天', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: '文献库助手', exact: true }).count(), 1);
  const rejectedDraft = `Do not transmit the saved credential ${primaryKey}`;
  await send(rejectedDraft);
  await chat().getByRole('alert').filter({ hasText: '消息中包含已保存的 API Key' }).waitFor();
  await chat().getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await chat().getByRole('textbox', { name: '文献库助手消息', exact: true }).inputValue(), rejectedDraft);
  assert.equal((await page.evaluate(() => window.paperApi!.getLibraryChatHistory())).messages.length, 0);
  assert.equal(await chat().getByRole('article').count(), 0, 'an unsaved rejected message returns to the draft instead of poisoning later history');
  assert.equal(requests.length, 0);
  await send('READ_LIBRARY'); await idle('READ_LIBRARY');
  assert.equal(await approval().count(), 0);
  assert.equal(await getTitle(), 'Library assistant fixture');
  for (const body of requests) {
    const names = body.tools.map((entry: any) => entry.function.name);
    assert.ok(names.includes('list_papers'));
    for (const forbidden of ['read_text', 'prepare_fulltext', 'view_image', 'view_pdf_page']) assert.ok(!names.includes(forbidden));
  }
  assert.equal(await chat().getByRole('heading', { name: '管理结果', exact: true }).count(), 1);
  assert.equal(await chat().getByRole('table').count(), 1);
  await chat().locator('.reader-ai-message.assistant').last().getByRole('button', { name: '复制消息', exact: true }).click();
  await chat().getByRole('status').filter({ hasText: '已复制' }).waitFor();
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.ok(copied.includes('## 管理结果') && copied.includes('**READ_LIBRARY**'));

  await send('DIAGNOSE_CLOUD'); await idle('DIAGNOSE_CLOUD');
  assert.equal(await approval().count(), 0, 'read-only diagnosis needs no mutation confirmation');
  assert.equal(await readFile(brokenCitationFile, 'utf8'), brokenCitation, 'assistant diagnosis preserves the damaged file');
  assert.ok((await page.evaluate(() => window.paperApi!.getLibraryChatHistory())).messages.at(-1)!.activity?.some(item => item.tool === 'diagnose_cloud' && item.status === 'succeeded'));

  await send('RENAME_REJECT'); await approval().waitFor({ timeout: 30000 });
  assert.equal(await getTitle(), 'Library assistant fixture', 'preview must not modify metadata');
  await approval().getByRole('button', { name: '取消这项操作', exact: true }).click(); await idle('RENAME_REJECT');
  assert.equal(await getTitle(), 'Library assistant fixture');

  await send('RENAME_CONFIRM'); await approval().waitFor({ timeout: 30000 });
  assert.ok((await approval().innerText()).includes('Confirmed managed title'));
  // The active confirmation and pending model turn survive leaving/closing/reopening the tab.
  await page.getByRole('button', { name: '个人首页', exact: true }).click();
  await page.getByRole('button', { name: '关闭文献库助手标签', exact: true }).click();
  await page.getByRole('button', { name: '开始聊天', exact: true }).click(); await approval().waitFor();
  assert.equal(await getTitle(), 'Library assistant fixture');
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLElement>('.library-ai-approval button[type="submit"]');
    const log = document.querySelector<HTMLElement>('.library-ai-chat .reader-ai-messages');
    if (!button || !log) return false;
    const a = button.getBoundingClientRect(), b = log.getBoundingClientRect();
    return a.top >= b.top && a.bottom <= b.bottom;
  });
  await page.screenshot({ path: join(directory, 'change-preview.png'), fullPage: true });
  await approval().getByRole('button', { name: '确认执行', exact: true }).click(); await idle('RENAME_CONFIRM');
  assert.equal(await getTitle(), 'Confirmed managed title');
  await page.getByRole('button', { name: '文献库', exact: true }).click();
  await page.getByText('Confirmed managed title', { exact: true }).first().waitFor();
  await page.getByRole('tab', { name: '文献库助手', exact: true }).click();

  await send('RENAME_STOP'); await approval().waitFor({ timeout: 30000 });
  await chat().getByRole('button', { name: '停止生成', exact: true }).click();
  await chat().getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 30000 });
  assert.equal(await approval().count(), 0); assert.equal(await getTitle(), 'Confirmed managed title');

  await send('WRITE_THEN_FAIL'); await approval().waitFor({ timeout: 30000 });
  await approval().getByRole('button', { name: '确认执行', exact: true }).click();
  await chat().getByRole('alert').waitFor({ timeout: 30000 });
  await chat().getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(() => window.paperApi!.getLibrary())).papers.find(paper => paper.id === paperId)!.briefNote, 'Confirmed note survives model error');
  const failedTurn = chat().locator('.reader-ai-message.user').filter({ hasText: 'WRITE_THEN_FAIL' }).last();
  await failedTurn.locator('summary').click();
  assert.ok((await failedTurn.locator('.reader-ai-evidence').innerText()).includes('完成'), 'confirmed tool work remains visible after a later model failure');
  const failedHistory = await page.evaluate(() => window.paperApi!.getLibraryChatHistory());
  assert.ok(failedHistory.messages.at(-1)!.activity?.some(item => item.tool === 'change_library' && item.status === 'succeeded'));

  const beforeSecret = requests.length;
  await send(secondaryKey);
  await chat().getByText('请在模型配置或搜索配置的密钥输入框填写 API Key，不要粘贴到聊天中。', { exact: true }).waitFor();
  assert.equal(requests.length, beforeSecret); assert.ok(!(await archiveText()).includes(secondaryKey));
  await send('ADD_MODEL'); await approval().waitFor({ timeout: 30000 });
  assert.equal(await approval().locator('#library-agent-api-key').getAttribute('type'), 'password');
  await approval().locator('#library-agent-api-key').fill(secondaryKey);
  await page.screenshot({ path: join(directory, 'secure-model-form.png'), fullPage: true });
  await approval().getByRole('button', { name: '确认添加模型', exact: true }).click(); await idle('ADD_MODEL');
  const afterAdd = await page.evaluate(() => window.paperApi!.getModelConfig());
  assert.equal(afterAdd.profiles.length, 2); assert.equal(afterAdd.activeId, primary.activeId);
  assert.ok(afterAdd.profiles.some(profile => profile.id === primary.activeId));
  const secondary = afterAdd.profiles.find(profile => profile.model === 'library-second')!;
  assert.ok(secondary.hasApiKey); addedId = secondary.id;
  assert.ok(!JSON.stringify(requests).includes(secondaryKey)); assert.ok(!(await archiveText()).includes(secondaryKey));

  const beforeSwitch = requests.length;
  await send('SELECT_MODEL'); await approval().waitFor({ timeout: 30000 });
  assert.equal((await page.evaluate(() => window.paperApi!.getModelConfig())).activeId, primary.activeId);
  await approval().getByRole('button', { name: '确认执行', exact: true }).click(); await idle('SELECT_MODEL');
  assert.equal((await page.evaluate(() => window.paperApi!.getModelConfig())).activeId, addedId);
  assert.ok(requests.slice(beforeSwitch).every(body => body.model === 'library-first'), 'selection cannot change the model mid-turn');
  await send('NEXT_MODEL'); await idle('NEXT_MODEL');
  assert.equal(requests.at(-1).model, 'library-second');
  assert.ok(!JSON.stringify(requests).includes(secondaryKey));
  assert.ok(!(await archiveText()).includes(secondaryKey));
  await page.screenshot({ path: join(directory, 'library-chat.png'), fullPage: true });

  const previousArchive = await archiveText(), beforeRestart = requests.length;
  await app.close(); app = await launch(); page = await app.firstWindow(); watchErrors();
  await page.getByRole('button', { name: '开始聊天', exact: true }).click();
  await chat().locator('.reader-ai-message.assistant').filter({ hasText: 'NEXT_MODEL' }).last().waitFor();
  assert.equal(requests.length, beforeRestart, 'restart and history restoration must stay offline');
  assert.equal(await archiveText(), previousArchive);
  assert.equal((await page.evaluate(() => window.paperApi!.getLibraryChatHistory())).messages.length, JSON.parse(previousArchive).messages.length);
  assert.equal((await page.evaluate(() => window.paperApi!.getLibrary())).papers.length, 2);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, directory, requests: requests.length, packaged }));
} catch (error) {
  await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('Desktop failure in', directory, 'Visible text:', await page.locator('body').innerText().catch(() => 'unavailable'));
  throw error;
} finally {
  if (app.process().exitCode === null) await app.close();
  await new Promise<void>(done => server.close(() => done()));
}
