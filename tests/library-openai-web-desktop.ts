import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { Library } from '../electron/library';

// No real model/search API or credentials: only this temporary library/profile and localhost fixture.
await mkdir('.test-data', { recursive: true });
const directory = await mkdtemp(resolve('.test-data/library-openai-web-ui-'));
const library = new Library(join(directory, 'library'), async () => { throw new Error('No PDF access'); }, async () => { throw new Error('No metadata network'); });
await library.initialize(); await library.createPaper({ title: 'Native web search preserves this paper' }, null, false);
const beforeLibrary = await readFile(join(library.directory, 'library.json'));
const key = 'fixture-model-native-only', sourceUrl = 'https://example.org/native-research';
const requests: { endpoint: string; body: any }[] = [], modelErrors: string[] = [], held = new Set<ServerResponse>();
const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw), endpoint = request.url ?? '';
    requests.push({ endpoint, body }); assert.equal(request.headers.authorization, 'Bearer ' + key);
    assert.equal(body.model, 'fake-model'); assert.ok(!raw.includes(key), 'the model key belongs in Authorization only');
    response.setHeader('Content-Type', 'application/json');
    if (endpoint === '/v1/responses') {
      assert.equal(body.store, false); assert.equal(body.stream, false); assert.equal(body.max_tool_calls, 3);
      assert.ok(body.tools.some((tool: any) => tool.type === 'web_search'));
      assert.ok(!body.tools.some((tool: any) => ['search_web', 'read_web_page'].includes(tool.name ?? tool.function?.name)));
      if (JSON.stringify(body.input).includes('HOLD_NATIVE')) { held.add(response); response.once('close', () => held.delete(response)); return; }
      const text = '## OpenAI 联网完成\n\n公开资料显示测试结论。 citeturn0search0';
      response.end(JSON.stringify({ id: 'resp_native_fixture', object: 'response', created_at: 1, model: 'fake-model', status: 'completed', output: [
        { id: 'ws_native_fixture', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'public scientific sources' } },
        { id: 'msg_native_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text,
          annotations: [{ type: 'url_citation', start_index: text.indexOf(''), end_index: text.length, url: sourceUrl, title: '原生联网测试来源' }] }] },
      ], usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } })); return;
    }
    assert.equal(endpoint, '/v1/chat/completions');
    assert.ok(!JSON.stringify(body.tools).includes('web_search')); assert.ok(!JSON.stringify(body.tools).includes('search_web'));
    response.end(JSON.stringify({ id: 'chat_native_fixture', object: 'chat.completion', created: 1, model: 'fake-model',
      choices: [{ index: 0, message: { role: 'assistant', content: '关闭联网后继续普通文献库对话。' }, finish_reason: 'stop' }] }));
  } catch (error) {
    modelErrors.push(String(error)); response.writeHead(500); response.end(JSON.stringify({ error: { message: 'fixture assertion failed' } }));
  }
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}/v1`;
const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, PAPER_TIMELINE_DATA: directory, PAPER_TIMELINE_AI: '0' })
  .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.argv.includes('--packaged');
const launch = async () => {
  const application = await electron.launch({ executablePath: resolve(packaged ? 'release/win-unpacked/Paper Timeline.exe' : 'node_modules/electron/dist/electron.exe'), ...(packaged ? {} : { args: [resolve('.')] }), env });
  await application.evaluate(({ net, shell }, allowed) => {
    const original = net.fetch.bind(net);
    const fixture = { unexpected: [] as string[], opened: [] as string[] }; (globalThis as any).__nativeWebFixture = fixture;
    net.fetch = (async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith(allowed + '/')) return original(url, init);
      fixture.unexpected.push(url); throw new Error('External search request blocked in native test');
    }) as typeof net.fetch;
    shell.openExternal = async (url: string) => { fixture.opened.push(url); };
  }, baseUrl);
  return application;
};
let app = await launch(), page = await app.firstWindow();
const errors: string[] = [], watch = () => { page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message)); }; watch();
const chat = () => page.locator('.library-ai-chat');
const sidebar = () => page.getByRole('complementary', { name: '会话历史', exact: true });
const toggle = () => chat().getByRole('switch', { name: '联网搜索', exact: true });
const provider = () => chat().getByRole('combobox', { name: '联网搜索来源', exact: true });
const selected = async () => (await page.evaluate(() => window.paperApi!.listLibraryConversations())).activeId!;
const fixture = () => app.evaluate(() => (globalThis as any).__nativeWebFixture as { unexpected: string[]; opened: string[] });
const send = async (content: string) => { await chat().getByRole('textbox', { name: '文献库助手消息', exact: true }).fill(content); await chat().getByRole('button', { name: '发送', exact: true }).click(); };
const idle = async () => { await chat().getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' }); };
try {
  await page.evaluate(async value => { await window.paperApi!.saveModelConfig({ profileId: null, name: 'Current model fixture', baseUrl: value.baseUrl, model: 'fake-model', apiKey: value.key, withoutApiKey: false }, true); }, { baseUrl, key });
  await page.getByRole('button', { name: '开始聊天', exact: true }).click(); await sidebar().waitFor(); await provider().waitFor();
  assert.equal(await provider().inputValue(), 'openai'); assert.equal(await toggle().getAttribute('aria-checked'), 'false');
  assert.equal(await chat().getByRole('button', { name: '搜索配置', exact: true }).count(), 0);
  assert.equal((await page.evaluate(() => window.paperApi!.getWebSearchConfig())).configured, false);
  const id = await selected(); assert.equal(requests.length, 0);
  await toggle().click(); assert.equal(await toggle().getAttribute('aria-checked'), 'true');
  assert.equal(await page.getByRole('dialog', { name: '搜索配置', exact: true }).count(), 0, 'native mode never prompts for a Tavily key');
  await send('NATIVE_SEARCH'); await chat().getByRole('heading', { name: 'OpenAI 联网完成', exact: true }).waitFor(); await idle();
  assert.deepEqual(requests.map(item => item.endpoint), ['/v1/responses']);
  const card = chat().locator('.library-ai-sources a').filter({ hasText: '原生联网测试来源' }); await card.waitFor();
  const inline = chat().locator('.reader-ai-message-text a').filter({ hasText: '原生联网测试来源' }); await inline.waitFor();
  assert.equal(await card.getAttribute('href'), sourceUrl); assert.equal(await inline.getAttribute('href'), sourceUrl);
  assert.ok(!(await chat().innerText()).includes('cite'));
  await card.click(); for (let i = 0; i < 20 && !(await fixture()).opened.length; i++) await new Promise(done => setTimeout(done, 50));
  assert.ok((await fixture()).opened.includes(sourceUrl));
  const history = await page.evaluate(value => window.paperApi!.getLibraryChatHistory(value), id);
  assert.ok(history.messages.at(-1)?.sources?.some(source => source.url === sourceUrl)); assert.ok(!JSON.stringify(history).includes(key));
  await page.screenshot({ path: join(directory, 'openai-web-sources.png'), fullPage: true });

  await sidebar().getByRole('button', { name: '新建会话', exact: true }).click();
  await page.waitForFunction(async previous => (await window.paperApi!.listLibraryConversations()).activeId !== previous, id);
  assert.equal(await provider().inputValue(), 'openai'); assert.equal(await toggle().getAttribute('aria-checked'), 'false');
  await sidebar().locator(`[data-conversation-id="${id}"]`).click();
  await page.waitForFunction(async value => (await window.paperApi!.listLibraryConversations()).activeId === value, id);
  assert.equal(await toggle().getAttribute('aria-checked'), 'true');
  await send('HOLD_NATIVE'); await chat().getByRole('button', { name: '停止生成', exact: true }).waitFor();
  assert.equal(await toggle().isDisabled(), true); assert.equal(await provider().isDisabled(), true);
  await chat().getByRole('button', { name: '停止生成', exact: true }).click(); await idle();
  await toggle().click(); await send('OFF_WITH_CURRENT_MODEL');
  await chat().getByText('关闭联网后继续普通文献库对话。', { exact: true }).waitFor(); await idle();
  assert.equal(requests.at(-1)?.endpoint, '/v1/chat/completions');
  assert.deepEqual((await fixture()).unexpected, []); assert.deepEqual(modelErrors, []);
  const userData = await app.evaluate(({ app }) => app.getPath('userData')); assert.ok(userData.startsWith(directory));
  await assert.rejects(readFile(join(userData, 'web-search-config.bin')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(library.directory, 'library.json')), beforeLibrary);
  const beforeRestart = requests.length;
  await app.close(); app = await launch(); page = await app.firstWindow(); watch();
  await page.getByRole('button', { name: '开始聊天', exact: true }).click(); await sidebar().waitFor();
  await chat().locator('.library-ai-sources a').filter({ hasText: '原生联网测试来源' }).waitFor();
  await chat().locator('.reader-ai-message-text a').filter({ hasText: '原生联网测试来源' }).waitFor();
  assert.equal(await selected(), id); assert.equal(await provider().inputValue(), 'openai'); assert.equal(await toggle().getAttribute('aria-checked'), 'false');
  assert.equal(requests.length, beforeRestart, 'restoring cited history is offline');
  assert.deepEqual((await fixture()).unexpected, []); assert.deepEqual(errors, []); assert.deepEqual(modelErrors, []);
  await page.screenshot({ path: join(directory, 'openai-web-restored.png'), fullPage: true });
  console.log(JSON.stringify({ ok: true, directory, packaged, modelRequests: requests.length,
    checks: 'default OpenAI provider, current model key only, Responses native tool, clickable inline citation/source card, no Tavily requests/config, per-session/busy switch, stop, offline Chat Completions, persisted cited history' }));
} catch (error) {
  await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('Native web desktop failure', directory, modelErrors, await page.locator('body').innerText().catch(() => 'unavailable')); throw error;
} finally {
  for (const response of held) response.destroy();
  if (app.process().exitCode === null) await app.close();
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
}
