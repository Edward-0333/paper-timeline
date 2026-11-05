import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { Library } from '../electron/library';

await mkdir('.test-data', { recursive: true });
const directory = await mkdtemp(resolve('.test-data/library-model-edit-ui-'));
const library = new Library(join(directory, 'library'), async () => { throw new Error('no PDF'); }, async () => { throw new Error('no lookup'); });
await library.initialize(); await library.createPaper({ title: 'Preserved model edit fixture' }, null, false);
const beforeLibrary = await readFile(library.file);
const oldKey = 'fixture-edit-original-private', newKey = 'fixture-edit-replacement-private';
let profileId = '', baseUrl = '';
const requests: { command: string; body: any; endpoint: string; authorization?: string }[] = [], modelErrors: string[] = [];
const server = createServer(async (request, response) => {
  try {
    const buffers: Buffer[] = []; for await (const chunk of request) buffers.push(Buffer.from(chunk));
    const raw = Buffer.concat(buffers).toString('utf8'), body = JSON.parse(raw);
    assert.ok(!raw.includes(oldKey) && !raw.includes(newKey));
    const messages = body.messages as any[]; let index = messages.length - 1;
    while (index >= 0 && messages[index].role !== 'user') index--;
    const command = messages[index].content as string, results = messages.slice(index + 1).filter(item => item.role === 'tool');
    requests.push({ command, body, endpoint: request.url!, authorization: request.headers.authorization });
    assert.ok(['/v1/chat/completions', '/v2/chat/completions'].includes(request.url!));
    const changes = command === 'EDIT_FIELDS' ? { name: 'Adjusted fixture', model: 'edited-model' }
      : command === 'EDIT_ENDPOINT' ? { baseUrl: baseUrl.replace('/v1', '/v2') }
      : { contextWindowTokens: command === 'EDIT_CAPACITY' ? 128000 : 262144 };
    const tool = results.length === 0 ? { name: 'list_models', args: {} }
      : results.length === 1 && command !== 'NEXT_TURN' ? { name: 'edit_model', args: { id: profileId, changes } } : null;
    const result = results.length ? JSON.parse(results.at(-1).content) : {};
    const message = tool ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-' + requests.length, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
      : { role: 'assistant', content: `RESULT_${command}: ${result.stale ? 'stale' : result.cancelled ? 'cancelled' : result.ok === false ? 'failed' : 'done'}` };
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }] }));
  } catch (error) { modelErrors.push(String(error)); response.writeHead(500); response.end(JSON.stringify({ error: { message: 'fixture error' } })); }
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address(); assert.ok(address && typeof address !== 'string'); baseUrl = `http://127.0.0.1:${address.port}/v1`;
const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, PAPER_TIMELINE_DATA: directory, PAPER_TIMELINE_AI: '0' })
  .filter((entry): entry is [string, string] => typeof entry[1] === 'string')); delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.argv.includes('--packaged');
const launch = async () => {
  const app = await electron.launch({ executablePath: resolve(packaged ? 'release/win-unpacked/Paper Timeline.exe' : 'node_modules/electron/dist/electron.exe'), ...(packaged ? {} : { args: [resolve('.')] }), env });
  await app.evaluate(({ net }, allowed) => {
    const original = net.fetch.bind(net);
    net.fetch = (async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith(allowed + '/')) throw new Error('External fixture request blocked');
      return original(url, init);
    }) as typeof net.fetch;
  }, `http://127.0.0.1:${address.port}`);
  return app;
};
let app = await launch(), page = await app.firstWindow(); const errors: string[] = [];
const watch = () => { page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message)); }; watch();
const chat = () => page.locator('.library-ai-chat');
const modal = () => page.getByRole('dialog', { name: '确认修改大模型配置', exact: true });
const config = () => page.evaluate(() => window.paperApi!.getModelConfig());
const send = async (content: string) => { await chat().getByRole('textbox', { name: '文献库助手消息', exact: true }).fill(content); await chat().getByRole('button', { name: '发送', exact: true }).click(); };
const idle = async (command: string, status = 'done') => {
  await chat().getByText(`RESULT_${command}: ${status}`, { exact: true }).waitFor();
  await chat().getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' });
};
try {
  await page.evaluate(async value => {
    await window.paperApi!.saveModelConfig({ profileId: null, name: 'Primary fixture', baseUrl: value.baseUrl, model: 'fixture-model', apiKey: value.oldKey, withoutApiKey: false }, true);
    await window.paperApi!.saveModelConfig({ profileId: null, name: 'Other fixture', baseUrl: value.baseUrl, model: 'other-model', withoutApiKey: true, contextWindowTokens: 65536 }, false);
  }, { baseUrl, oldKey });
  const initial = await config(); profileId = initial.activeId!;
  await page.getByRole('button', { name: '开始聊天', exact: true }).click();
  await chat().getByRole('textbox', { name: '文献库助手消息', exact: true }).waitFor(); assert.equal(requests.length, 0);
  await send('CANCEL_CAPACITY'); await modal().waitFor();
  assert.equal(await modal().getByRole('button', { name: '取消这项操作', exact: true }).evaluate(button => button === document.activeElement), true);
  assert.deepEqual(await config(), initial); await page.keyboard.press('Escape'); await idle('CANCEL_CAPACITY', 'cancelled');
  assert.deepEqual(await config(), initial);
  await send('EDIT_CAPACITY'); await modal().waitFor();
  assert.match(await modal().innerText(), /32,768 token（默认）/); assert.match(await modal().innerText(), /128,000 token/);
  assert.equal(await modal().locator('input[type=password]').count(), 0); assert.deepEqual(await config(), initial);
  await page.screenshot({ path: join(directory, 'context-confirmation.png'), fullPage: true });
  await modal().getByRole('button', { name: '确认保存修改', exact: true }).click(); await idle('EDIT_CAPACITY');
  assert.equal((await config()).contextWindowTokens, 128000);
  assert.ok(requests.filter(item => item.command === 'EDIT_CAPACITY').every(item => item.authorization === 'Bearer ' + oldKey));
  await send('EDIT_FIELDS'); await modal().waitFor();
  assert.match(await modal().innerText(), /Adjusted fixture/); assert.match(await modal().innerText(), /edited-model/);
  await modal().getByRole('button', { name: '确认保存修改', exact: true }).click(); await idle('EDIT_FIELDS');
  assert.ok(requests.filter(item => item.command === 'EDIT_FIELDS').every(item => item.body.model === 'fixture-model'));
  await send('EDIT_ENDPOINT'); await modal().waitFor();
  assert.equal(await modal().locator('#library-agent-api-key').getAttribute('type'), 'password');
  assert.equal(await modal().getByRole('button', { name: '确认保存修改', exact: true }).isDisabled(), true);
  await modal().locator('#library-agent-api-key').fill(newKey);
  await page.screenshot({ path: join(directory, 'endpoint-confirmation.png'), fullPage: true });
  await modal().getByRole('button', { name: '确认保存修改', exact: true }).click(); await idle('EDIT_ENDPOINT');
  assert.ok(requests.filter(item => item.command === 'EDIT_ENDPOINT').every(item => item.endpoint.startsWith('/v1/') && item.authorization === 'Bearer ' + oldKey));
  await send('NEXT_TURN'); await idle('NEXT_TURN');
  assert.equal(requests.at(-1)!.endpoint, '/v2/chat/completions'); assert.equal(requests.at(-1)!.authorization, 'Bearer ' + newKey);
  assert.equal(requests.at(-1)!.body.model, 'edited-model');
  await send('STALE_EDIT'); await modal().waitFor();
  await page.evaluate(async () => { const current = await window.paperApi!.getModelConfig();
    await window.paperApi!.saveModelConfig({ profileId: current.activeId, name: 'Edited elsewhere', baseUrl: current.baseUrl,
      model: current.model, withoutApiKey: false, contextWindowTokens: 131072 }, false); });
  await modal().getByRole('button', { name: '确认保存修改', exact: true }).click(); await idle('STALE_EDIT', 'stale');
  assert.equal((await config()).contextWindowTokens, 131072);
  await send('STOP_EDIT'); await modal().waitFor();
  await page.evaluate(async () => { const list = await window.paperApi!.listLibraryConversations(); const approval = await window.paperApi!.getLibraryChatApproval(list.activeId!);
    await window.paperApi!.cancelLibraryChat(approval!.requestId); });
  await modal().waitFor({ state: 'hidden' }); await chat().getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' });
  const final = await config(); assert.equal(final.contextWindowTokens, 131072); assert.equal(final.activeId, profileId); assert.equal(final.profiles.length, 2);
  assert.deepEqual(final.profiles[1], initial.profiles[1]); assert.deepEqual(await readFile(library.file), beforeLibrary);
  const history = await page.evaluate(() => window.paperApi!.getLibraryChatHistory());
  assert.ok(!JSON.stringify(history).includes(newKey) && !JSON.stringify(history).includes(oldKey));
  const beforeRestart = requests.length;
  await app.close(); app = await launch(); page = await app.firstWindow(); watch();
  assert.deepEqual(await config(), final);
  await page.getByRole('button', { name: '开始聊天', exact: true }).click();
  await chat().getByText('RESULT_EDIT_CAPACITY: done', { exact: true }).waitFor();
  assert.equal(requests.length, beforeRestart); assert.equal(await modal().count(), 0); assert.deepEqual(errors, []); assert.deepEqual(modelErrors, []);
  console.log(JSON.stringify({ ok: true, directory, packaged, modelRequests: requests.length,
    checks: 'modal before/after, default cancel/Esc, capacity/name/model/address edits, local key form, next-turn binding, stale/stop protection, encrypted restart, preserved library/other profiles' }));
} catch (error) {
  await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(directory, modelErrors, await page.locator('body').innerText().catch(() => 'unavailable')); throw error;
} finally {
  if (app.process().exitCode === null) await app.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
}
