import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';

// Every request stays on this loopback fixture; never use a real model key or library.
await mkdir('.test-data', { recursive: true });
const root = await mkdtemp(resolve('.test-data/model-connectivity-ui-'));
const draftKey = 'fixture-connectivity-draft-key', savedKey = 'fixture-connectivity-saved-key';
const requests: { method: string | undefined; path: string | undefined; authorization: string | undefined; body: any }[] = [];
const held = new Set<ServerResponse>();
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  const body = raw ? JSON.parse(raw) : null;
  requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
  response.setHeader('Content-Type', 'application/json');
  if (body?.model === 'held-model') {
    held.add(response); response.once('close', () => held.delete(response)); return;
  }
  if (body?.model === 'denied-model') {
    response.writeHead(401); response.end(JSON.stringify({ error: { message: `Rejected secret ${draftKey}`, code: 'invalid_api_key' } })); return;
  }
  if (body?.model === 'redirect-model') {
    response.writeHead(302, { Location: '/redirect-target' }); response.end('{}'); return;
  }
  // The provider deliberately echoes a fake secret: raw completions must never appear in UI.
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `OK ${draftKey} ${savedKey}` }, finish_reason: 'stop' }] }));
});
await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, PAPER_TIMELINE_DATA: root, PAPER_TIMELINE_AI: '0' })
  .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.argv.includes('--packaged');
const app = await electron.launch({ executablePath: resolve(packaged ? 'release/win-unpacked/Paper Timeline.exe' : 'node_modules/electron/dist/electron.exe'),
  ...(packaged ? {} : { args: [resolve('.')] }), env });
try {
  const page = await app.firstWindow();
  const open = async (action: '添加' | '编辑' = '添加') => {
    await page.getByRole('button', { name: '配置大模型', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: action, exact: true }).click();
    return dialog;
  };
  let dialog = await open();
  const result = page.locator('.model-test-result');
  const assertSafeResult = async () => {
    assert.equal(await result.getAttribute('role'), 'status');
    const text = await dialog.innerText(); assert.equal(text.includes(draftKey), false); assert.equal(text.includes(savedKey), false);
  };
  const run = async () => {
    await dialog.getByRole('button', { name: '测试连通性', exact: true }).click();
    await result.waitFor({ state: 'visible' }); await assertSafeResult();
  };
  const waitForRequests = async (count: number) => {
    const deadline = Date.now() + 10000;
    while (requests.length < count && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 25));
    assert.equal(requests.length, count);
  };
  const assertProbe = (index: number, path: string, model: string, key: string | null) => {
    const request = requests[index]; assert.equal(request.method, 'POST'); assert.equal(request.path, path);
    assert.equal(request.authorization, key === null ? undefined : `Bearer ${key}`);
    assert.equal(request.body.model, model); assert.equal(request.body.stream, false);
    assert.deepEqual(request.body.messages, [{ role: 'user', content: 'Reply with OK.' }]);
    assert.equal(request.body.max_completion_tokens ?? request.body.max_tokens, 16);
  };

  // Testing uses the current draft before Save, and never creates an encrypted configuration.
  await page.locator('#model-config-name').fill('尚未保存的测试配置');
  await page.locator('#model-config-url').fill(base + '/draft/v1/');
  await page.locator('#model-config-model').fill('draft-model');
  await page.locator('#model-config-key').fill(draftKey);
  await run(); assert.match(await result.innerText(), /连接成功/); assert.match(await result.innerText(), /耗时\s+\d+\s+ms/);
  assert.equal(requests.length, 1); assertProbe(0, '/draft/v1/chat/completions', 'draft-model', draftKey);
  assert.equal((await page.evaluate(() => window.paperApi!.getModelConfig())).configured, false);
  await assert.rejects(readFile(join(root, 'llm-config.bin')), { code: 'ENOENT' });

  // Editing invalidates a prior result; provider errors are actionable and do not echo keys.
  await page.locator('#model-config-model').fill('denied-model'); await result.waitFor({ state: 'hidden' });
  await run(); assert.match(await result.innerText(), /401/); assert.equal(await result.evaluate(el => el.classList.contains('failure')), true);
  assert.equal(requests.length, 2); assertProbe(1, '/draft/v1/chat/completions', 'denied-model', draftKey);

  // A pending request locks form actions, rejects duplicate IPC calls, and can be canceled.
  await page.locator('#model-config-model').fill('held-model'); await result.waitFor({ state: 'hidden' });
  await dialog.getByRole('button', { name: '测试连通性', exact: true }).click(); await waitForRequests(3);
  assert.equal(await dialog.getByRole('button', { name: '测试中…', exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole('button', { name: '保存配置', exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole('button', { name: '关闭大模型配置', exact: true }).isDisabled(), true);
  for (const input of await dialog.locator('input').all()) assert.equal(await input.isDisabled(), true);
  const duplicateDenied = await page.evaluate(async input => {
    try { await window.paperApi!.testModelConnection(input); return false; } catch { return true; }
  }, { name: 'duplicate fixture', baseUrl: base + '/draft/v1', model: 'draft-model', apiKey: draftKey, withoutApiKey: false });
  assert.equal(duplicateDenied, true); assert.equal(requests.length, 3);
  await dialog.getByRole('button', { name: '取消测试', exact: true }).click();
  await result.waitFor({ state: 'visible' }); assert.match(await result.innerText(), /取消/); await assertSafeResult();
  assert.equal(await dialog.getByRole('button', { name: '测试连通性', exact: true }).isEnabled(), true);
  assert.equal(await page.locator('#model-config-url').isEnabled(), true);
  assert.equal((await page.evaluate(() => window.paperApi!.getModelConfig())).configured, false);
  await assert.rejects(readFile(join(root, 'llm-config.bin')), { code: 'ENOENT' });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.getByRole('button', { name: '关闭大模型配置' }).click(); await dialog.waitFor({ state: 'hidden' });

  // Saving is explicit. A later same-address test reuses the saved key without exposing it.
  dialog = await open(); assert.equal(await page.locator('#model-config-url').inputValue(), '');
  await page.locator('#model-config-name').fill('已保存的测试配置');
  await page.locator('#model-config-url').fill(base + '/saved/v1/');
  await page.locator('#model-config-model').fill('saved-model'); await page.locator('#model-config-key').fill(savedKey);
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await dialog.getByRole('button', { name: '选择', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  const configBytes = await readFile(join(root, 'llm-config.bin')); assert.equal(configBytes.includes(Buffer.from(savedKey)), false);
  dialog = await open('编辑'); assert.equal(await page.locator('#model-config-key').inputValue(), '');
  await page.locator('#model-config-model').fill('reused-key-model'); await run(); assert.match(await result.innerText(), /连接成功/);
  assert.equal(requests.length, 4); assertProbe(3, '/saved/v1/chat/completions', 'reused-key-model', savedKey);
  assert.equal((await page.evaluate(() => window.paperApi!.getModelConfig())).model, 'saved-model');
  assert.deepEqual(await readFile(join(root, 'llm-config.bin')), configBytes);

  // Redirects are reported, rather than forwarding credentials to the destination.
  await page.locator('#model-config-model').fill('redirect-model'); await run(); assert.match(await result.innerText(), /重定向|无法连接/);
  assert.equal(requests.length, 5); assert.equal(requests.some(request => request.path === '/redirect-target'), false);

  // A changed address cannot borrow a key from the saved endpoint, in UI or in IPC.
  await page.locator('#model-config-url').fill(base + '/changed/v1'); await result.waitFor({ state: 'hidden' });
  await dialog.getByRole('button', { name: '测试连通性', exact: true }).click();
  assert.equal(await page.locator('#model-config-key').evaluate((input: HTMLInputElement) => input.validity.valueMissing), true);
  const changedDenied = await page.evaluate(async input => {
    try { await window.paperApi!.testModelConnection(input); return false; } catch { return true; }
  }, { name: 'changed fixture', baseUrl: base + '/changed/v1', model: 'changed-model', withoutApiKey: false });
  assert.equal(changedDenied, true); assert.equal(requests.length, 5);

  // Keyless local endpoints are supported; the test still leaves saved settings untouched.
  await dialog.getByLabel('此接口无需 API Key（例如本地模型）', { exact: true }).check();
  await page.locator('#model-config-url').fill(base + '/keyless/v1/'); await page.locator('#model-config-model').fill('keyless-model');
  await run(); assert.match(await result.innerText(), /连接成功/);
  assert.equal(requests.length, 6); assertProbe(5, '/keyless/v1/chat/completions', 'keyless-model', null);
  assert.deepEqual(await readFile(join(root, 'llm-config.bin')), configBytes);
  await page.setViewportSize({ width: 1050, height: 700 });
  const bounds = await dialog.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1050 && bounds.y + bounds.height <= 700);
  await page.screenshot({ path: join(root, 'model-connectivity.png'), fullPage: true });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.getByRole('button', { name: '关闭大模型配置' }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(() => window.paperApi!.getModelConfig())).model, 'saved-model');
  console.log(JSON.stringify({ packaged, root, result: 'passed', requests: requests.length,
    checks: 'draft request, bounded prompt, no implicit save, result reset, safe HTTP error, busy/duplicate/cancel, saved-key reuse, endpoint guard, no redirects, keyless API, minimum-size layout' }));
} finally {
  await app.close();
  for (const response of held) response.destroy();
  server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept()));
}
