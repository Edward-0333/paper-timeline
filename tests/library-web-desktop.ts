import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { Library } from '../electron/library';

// Disposable library/profile, a local fake model, and intercepted Tavily only.
// Unexpected network requests fail instead of reaching any real external API.
await mkdir('.test-data', { recursive: true });
const directory = await mkdtemp(resolve('.test-data/library-web-ui-'));
const library = new Library(join(directory, 'library'), async () => { throw new Error('No PDF access'); }, async () => { throw new Error('No remote metadata'); });
await library.initialize();
await library.createPaper({ title: 'Unchanged library during web searches' }, null, false);
const beforeLibrary = await readFile(join(library.directory, 'library.json'));
const key = 'tvly-fixture-secret-web-search-only', sourceUrl = 'https://example.org/research';
const requests: any[] = [], modelErrors: string[] = [], held = new Set<ServerResponse>();
function respond(response: ServerResponse, content: string | null, tool?: { name: string; args: unknown }) {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content,
    ...(tool ? { tool_calls: [{ id: `fixture-web-${requests.length}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : {}) },
  finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }));
}
const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw); requests.push(body);
    assert.equal(request.url, '/v1/chat/completions'); assert.ok(!raw.includes(key), 'search credential must never reach the model');
    const messages: any[] = body.messages;
    let lastUser = messages.length - 1; while (lastUser >= 0 && messages[lastUser].role !== 'user') lastUser--;
    const command = messages[lastUser]?.content, completed = messages.slice(lastUser + 1).some(message => message.role === 'tool');
    const webTool = body.tools?.some((tool: any) => tool.function?.name === 'search_web');
    if (command === 'HOLD_WEB_FIXTURE') { assert.equal(webTool, true); held.add(response); response.once('close', () => held.delete(response)); return; }
    if (command === 'SEARCH_FIXTURE') {
      assert.equal(webTool, true);
      if (!completed) { respond(response, null, { name: 'search_web', args: { query: 'paper timeline web fixture' } }); return; }
      assert.ok(JSON.stringify(messages.slice(lastUser + 1)).includes(sourceUrl));
      respond(response, `## 联网搜索完成\n\n已获取公开资料摘要。详见[测试研究来源](${sourceUrl})。`); return;
    }
    assert.equal(webTool, false, 'disabled switch must omit search tools');
    respond(response, `${command}_OFF_ANSWER`);
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
  await application.evaluate(({ net, shell }, data) => {
    const original = net.fetch.bind(net);
    const fixture = { searches: [] as { query: string }[], cancelled: 0, hold: false, opened: [] as string[], unexpected: [] as string[] };
    (globalThis as any).__libraryWebFixture = fixture;
    net.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(data.baseUrl + '/')) return original(url, init);
      if (url !== 'https://api.tavily.com/search') { fixture.unexpected.push(url); throw new Error('Unexpected network request blocked'); }
      const headers = new Headers(init?.headers);
      if (headers.get('authorization') !== `Bearer ${data.key}` || init?.credentials !== 'omit' || init?.redirect !== 'manual') throw new Error('Unsafe search request');
      const body = JSON.parse(String(init?.body)); fixture.searches.push({ query: body.query });
      if (fixture.hold) return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) { fixture.cancelled++; reject(new Error('fixture cancelled')); }
        else init?.signal?.addEventListener('abort', () => { fixture.cancelled++; reject(new Error('fixture cancelled')); }, { once: true });
      });
      return new Response(JSON.stringify({ results: [{ title: '测试研究来源', url: data.sourceUrl,
        content: 'This is a synthetic public research summary for isolated web-search testing.', published_date: '2026-11-01' }] }), { headers: { 'Content-Type': 'application/json' } });
    }) as typeof net.fetch;
    shell.openExternal = async (url: string) => { fixture.opened.push(url); };
  }, { baseUrl, key, sourceUrl });
  return application;
};
let app = await launch(), page = await app.firstWindow();
const errors: string[] = [], watch = () => page.on('pageerror', error => errors.push(error.message)); watch();
const chat = () => page.locator('.library-ai-chat');
const sidebar = () => page.getByRole('complementary', { name: '会话历史', exact: true });
const toggle = () => chat().getByRole('switch', { name: '联网搜索', exact: true });
const dialog = () => page.getByRole('dialog', { name: '搜索配置', exact: true });
const input = () => chat().getByRole('textbox', { name: '文献库助手消息', exact: true });
const selected = async () => (await page.evaluate(() => window.paperApi!.listLibraryConversations())).activeId!;
const fixture = () => app.evaluate(() => (globalThis as any).__libraryWebFixture as { searches: { query: string }[]; cancelled: number; opened: string[]; unexpected: string[] });
const send = async (content: string) => { await input().fill(content); await chat().getByRole('button', { name: '发送', exact: true }).click(); };
const idle = async () => { await chat().getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' }); };
try {
  await page.evaluate(async url => { await window.paperApi!.saveModelConfig({ profileId: null, name: 'Web search fixture', baseUrl: url, model: 'web-search-fixture', withoutApiKey: true }, true); }, baseUrl);
  await page.getByRole('button', { name: '开始聊天', exact: true }).click(); await sidebar().waitFor(); await toggle().waitFor();
  const firstId = await selected(); assert.equal(await toggle().getAttribute('aria-checked'), 'false');
  await chat().getByRole('combobox', { name: '联网搜索来源', exact: true }).selectOption('tavily');
  assert.equal((await fixture()).searches.length, 0); assert.equal(requests.length, 0);
  await send('WITHOUT_SEARCH'); await chat().getByText('WITHOUT_SEARCH_OFF_ANSWER', { exact: true }).waitFor(); await idle();
  assert.equal((await fixture()).searches.length, 0);

  await toggle().click(); await dialog().waitFor();
  assert.equal(await toggle().getAttribute('aria-checked'), 'false'); assert.equal((await fixture()).searches.length, 0);
  await dialog().getByRole('button', { name: '取消', exact: true }).click(); await dialog().waitFor({ state: 'hidden' });
  await toggle().click(); await dialog().waitFor();
  const secretInput = dialog().locator('#web-search-api-key'); assert.equal(await secretInput.getAttribute('type'), 'password');
  await secretInput.fill(key);
  await dialog().getByRole('button', { name: '获取 Tavily API Key', exact: true }).click();
  for (let i = 0; i < 20 && !(await fixture()).opened.length; i++) await new Promise(done => setTimeout(done, 50));
  assert.ok((await fixture()).opened.some(url => new URL(url).origin === 'https://app.tavily.com'));
  await dialog().getByRole('button', { name: '测试连通性', exact: true }).click();
  await dialog().locator('.web-search-test-result.success').waitFor();
  assert.equal((await fixture()).searches.length, 1);
  assert.equal((await page.evaluate(() => window.paperApi!.getWebSearchConfig())).configured, false, 'testing does not save the draft');
  await page.screenshot({ path: join(directory, 'search-settings.png'), fullPage: true });
  await dialog().getByRole('button', { name: '保存配置', exact: true }).click(); await dialog().waitFor({ state: 'hidden' });
  assert.equal(await toggle().getAttribute('aria-checked'), 'true');
  const config = await page.evaluate(() => window.paperApi!.getWebSearchConfig());
  assert.deepEqual(config, { provider: 'tavily', configured: true, hasApiKey: true });
  assert.ok(!JSON.stringify(config).includes(key));
  const userData = await app.evaluate(({ app }) => app.getPath('userData')); assert.ok(userData.startsWith(directory));
  assert.ok(!(await readFile(join(userData, 'web-search-config.bin'))).includes(Buffer.from(key)), 'saved search key is encrypted');

  await send('SEARCH_FIXTURE'); await chat().getByText('联网搜索完成', { exact: true }).waitFor({ timeout: 30000 }); await idle();
  assert.equal((await fixture()).searches.length, 2);
  const source = chat().locator('.library-ai-sources a').filter({ hasText: '测试研究来源' }); await source.waitFor();
  assert.equal(await source.getAttribute('href'), sourceUrl);
  await source.click(); assert.ok((await fixture()).opened.includes(sourceUrl));
  const history = await page.evaluate(id => window.paperApi!.getLibraryChatHistory(id), firstId);
  assert.ok(history.messages.at(-1)?.sources?.some(source => source.url === sourceUrl));
  assert.ok(!JSON.stringify(history).includes(key)); assert.ok(!JSON.stringify(requests).includes(key));
  await page.screenshot({ path: join(directory, 'search-sources.png'), fullPage: true });

  await send('HOLD_WEB_FIXTURE'); await chat().getByRole('button', { name: '停止生成', exact: true }).waitFor();
  assert.equal(await toggle().isDisabled(), true, 'the in-flight turn retains its captured web setting');
  await chat().getByRole('button', { name: '停止生成', exact: true }).click(); await idle();
  await toggle().click(); assert.equal(await toggle().getAttribute('aria-checked'), 'false');
  await send('OFF_AGAIN'); await chat().getByText('OFF_AGAIN_OFF_ANSWER', { exact: true }).waitFor(); await idle();
  assert.equal((await fixture()).searches.length, 2);
  const beforeSecret = requests.length;
  await send(key); await chat().getByRole('alert').filter({ hasText: '不要粘贴到聊天中' }).waitFor();
  assert.equal(requests.length, beforeSecret); assert.ok(!JSON.stringify(await page.evaluate(id => window.paperApi!.getLibraryChatHistory(id), firstId)).includes(key));
  await input().fill('');

  await toggle().click(); assert.equal(await toggle().getAttribute('aria-checked'), 'true');
  await sidebar().getByRole('button', { name: '新建会话', exact: true }).click();
  await page.waitForFunction(async oldId => (await window.paperApi!.listLibraryConversations()).activeId !== oldId, firstId);
  assert.equal(await toggle().getAttribute('aria-checked'), 'false');
  await sidebar().locator(`[data-conversation-id="${firstId}"]`).click();
  await page.waitForFunction(async id => (await window.paperApi!.listLibraryConversations()).activeId === id, firstId);
  assert.equal(await toggle().getAttribute('aria-checked'), 'true', 'conversation switch retains its in-memory choice');
  assert.deepEqual(await readFile(join(library.directory, 'library.json')), beforeLibrary);
  const beforeRestart = requests.length; assert.deepEqual((await fixture()).unexpected, []);
  await app.close(); app = await launch(); page = await app.firstWindow(); watch();
  await page.getByRole('button', { name: '开始聊天', exact: true }).click(); await sidebar().waitFor();
  await chat().locator('.library-ai-sources a').filter({ hasText: '测试研究来源' }).waitFor();
  assert.equal(await toggle().getAttribute('aria-checked'), 'false', 'restart defaults to offline tools');
  assert.equal((await page.evaluate(() => window.paperApi!.getWebSearchConfig())).configured, true);
  assert.equal(requests.length, beforeRestart); assert.equal((await fixture()).searches.length, 0);

  await chat().getByRole('combobox', { name: '联网搜索来源', exact: true }).selectOption('tavily');
  await chat().getByRole('button', { name: '搜索配置', exact: true }).click(); await dialog().waitFor();
  assert.equal(await dialog().locator('#web-search-api-key').inputValue(), '', 'saved key never refills the renderer');
  await app.evaluate(() => { (globalThis as any).__libraryWebFixture.hold = true; });
  await dialog().getByRole('button', { name: '测试连通性', exact: true }).click();
  for (let i = 0; i < 20 && !(await fixture()).searches.length; i++) await new Promise(done => setTimeout(done, 50));
  assert.equal((await fixture()).searches.length, 1, 'the cancellation fixture has entered its held request');
  assert.equal(await dialog().getByRole('button', { name: '测试中…', exact: true }).count(), 1);
  await dialog().getByRole('button', { name: '关闭搜索配置', exact: true }).click(); await dialog().waitFor({ state: 'hidden' });
  for (let i = 0; i < 20 && !(await fixture()).cancelled; i++) await new Promise(done => setTimeout(done, 50));
  assert.equal((await fixture()).cancelled, 1, 'closing search settings cancels its connection test');
  await app.evaluate(() => { (globalThis as any).__libraryWebFixture.hold = false; });
  await chat().getByRole('button', { name: '搜索配置', exact: true }).click(); await dialog().waitFor();
  await dialog().getByRole('button', { name: '清除配置', exact: true }).click();
  await dialog().getByRole('button', { name: '保留配置', exact: true }).click();
  assert.equal((await page.evaluate(() => window.paperApi!.getWebSearchConfig())).configured, true);
  await dialog().getByRole('button', { name: '清除配置', exact: true }).click();
  await dialog().getByRole('button', { name: '确认清除', exact: true }).click();
  await page.waitForFunction(async () => !(await window.paperApi!.getWebSearchConfig()).configured);
  await dialog().getByRole('button', { name: '取消', exact: true }).click(); await dialog().waitFor({ state: 'hidden' });
  assert.equal(await toggle().getAttribute('aria-checked'), 'false');
  assert.deepEqual((await fixture()).unexpected, []); assert.deepEqual(modelErrors, []); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, directory, packaged, modelRequests: requests.length,
    checks: 'masked encrypted search config, explicit test and cancellation, offline/online tool gating, source links and restart, no key in model/history/status, busy switch, per-session choice, confirm-clear' }));
} catch (error) {
  await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('Web desktop failure', directory, modelErrors, await page.locator('body').innerText().catch(() => 'unavailable'));
  throw error;
} finally {
  for (const response of held) response.destroy();
  if (app.process().exitCode === null) await app.close();
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
}
