import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { Library } from '../electron/library';
import { localMetadata } from '../electron/metadata';
import { zipSync, strToU8 } from 'fflate';
import { createCanvas } from '@napi-rs/canvas';

// All model traffic, files and credentials in this regression are isolated fixtures.
await mkdir('.test-data', { recursive: true });
const directory = await mkdtemp(resolve('.test-data/pdf-chat-ui-'));
const secret = 'fixture-chat-key-not-a-real-credential';
const titles = ['CHAT_PRIVATE_TITLE_ONE', 'CHAT_PRIVATE_TITLE_TWO'];
const markers = ['CHAT_PRIVATE_ABSTRACT', 'CHAT_PRIVATE_PDF_TEXT', 'CHAT_PRIVATE_MD_CONTENT', 'CHAT_PRIVATE_ANNOTATION'];
const library = new Library(join(directory, 'library'), async (_path, name) => ({ title: titles[name === 'first.pdf' ? 0 : 1],
  authors: ['CHAT_PRIVATE_AUTHOR'], year: 2025, doi: '', arxivId: '', abstract: markers[0], firstPageText: markers[1], pageCount: 1 }),
async pdf => ({ metadata: localMetadata(pdf), matched: true, message: 'fixture' }));
await library.initialize();
const stream = 'BT /F1 16 Tf 72 700 Td (CHAT_PRIVATE_PDF_TEXT) Tj ET';
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  '<< /Type /Annot /Subtype /Highlight /Rect [72 696 310 716] /QuadPoints [72 716 310 716 72 696 310 696] /C [1 1 0] /F 4 /NM (fixture-highlight) /Contents (CHAT_PRIVATE_ANNOTATION) /T (Fixture) >>'];
let raw = '%PDF-1.7\n'; const offsets = [0];
for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(raw)); raw += `${index + 1} 0 obj\n${object}\nendobj\n`; }
const xref = Buffer.byteLength(raw);
raw += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const ids: string[] = [];
for (const [index, name] of ['first.pdf', 'second.pdf'].entries()) {
  const source = join(directory, name); await writeFile(source, raw + `\n% fixture ${index}\n`);
  const imported = await library.importPaths([source]); await library.whenIdle(); ids.push(imported.paperIds![0]);
}
const note = join(directory, 'fixture-note.md'); await writeFile(note, '# CHAT_PRIVATE_MD_CONTENT\n');
await library.attachMarkdown(ids[0], note);
const original = await readFile(library.pdfPath(ids[0]));
const requests: { method: string | undefined; path: string | undefined; authorization: string | undefined; body: any }[] = [];
const held = new Set<ServerResponse>(); let failOnce = true;
const markdownPrompt = 'markdown rendering fixture';
const codeFixture = 'def score(x):\n    return x ** 2 + 1\n\n# Keep \\(x\\) literal inside code\nprint("' + 'long_code_'.repeat(35) + '")';
const markdownReply = [
  '## 主要结论', '', '**重点结论**与 *证据解释*，以及 `inline_code`。', '',
  '中文加粗：**“重要结果。”**后续说明。', '',
  '### 数学表达', '', '行内公式 $E=mc^2$，以及 \\(a_i^2\\)；代码中的 `\\(literal\\)` 保持原样。', '',
  '$$', '\\frac{1}{n}\\sum_{i=1}^{n}(y_i-\\hat y_i)^2', '$$', '',
  '\\[', '\\int_0^1 x^2\\,dx=\\frac{1}{3}', '\\]', '',
  '- 第一项', '- 第二项', '', '> 引用原文示例', '',
  '```python', codeFixture, '```', '',
  '| 方法 | 训练数据集 | 验证数据集 | 测试数据集 | 评价指标 | 说明 |', '| --- | --- | --- | --- | --- | --- |',
  '| 基线方法 | Training_dataset | Validation_dataset | Testing_dataset | Accuracy_and_precision | ' + 'very_long_cell_'.repeat(20) + ' |', '',
  '[网页资料](https://example.org/paper) [本地文件](file:///C:/Windows/win.ini) [脚本链接](javascript:alert%281%29)', '',
  '![示意图](https://example.org/do-not-fetch.png)', '',
  '<script>window.markdownFixtureExecuted = true</script>',
  '<img src="https://example.org/do-not-fetch-html.png" onerror="window.markdownFixtureExecuted=true">',
].join('\n');
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
  response.setHeader('Content-Type', 'application/json');
  if (body.model === 'gpt-6-astra') {
    if (request.url !== '/v1/responses') {
      response.writeHead(400); response.end(JSON.stringify({ error: { message: 'Tool calling requires the Responses API.' } })); return;
    }
    const hasResult = body.input.some((part: any) => part.type === 'function_call_output' && part.call_id === 'call_read');
    const output = hasResult ? [{ type: 'message', id: 'msg_result', role: 'assistant', content: [
      { type: 'output_text', text: 'Responses 已根据论文全文作答。', annotations: [] }] }] : [
      { type: 'reasoning', id: 'rs_first', summary: [], encrypted_content: 'opaque-fixture-reasoning' },
      { type: 'function_call', id: 'fc_read', call_id: 'call_read', name: 'read_text', arguments: JSON.stringify({ source: 'fulltext' }) }];
    response.end(JSON.stringify({ id: hasResult ? 'resp_final' : 'resp_first', status: 'completed', model: body.model, output,
      usage: { input_tokens: 140, output_tokens: 30, total_tokens: 170 } }));
    return;
  }
  const last = body.messages?.at(-1)?.content;
  if (last === markdownPrompt) {
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: markdownReply }, finish_reason: 'stop' }] })); return;
  }
  if (body.messages?.some((message: any) => message.role === 'user' && message.content === 'agent analyze current paper')) {
    const toolResult = body.messages.filter((message: any) => message.role === 'tool').at(-1);
    const result = toolResult ? JSON.parse(toolResult.content) : null;
    const call = (name: string, args: unknown) => response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'fixture-call-' + requests.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }));
    if (!result) { call('read_text', { source: 'fulltext' }); return; }
    if (result.content) { call('list_images', {}); return; }
    if (result.images) { call('view_image', { imageId: result.images[0].imageId }); return; }
    if (result.file) { call('view_pdf_page', { page: 1 }); return; }
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: result.page === 1 ? 'Agent checked full text, figure and PDF page 1.' : 'Agent fixture tool failure.' }, finish_reason: 'stop' }] })); return;
  }
  if (last === 'hold request') { held.add(response); response.once('close', () => held.delete(response)); return; }
  if (last === 'retry this request' && failOnce) {
    failOnce = false; response.writeHead(401); response.end(JSON.stringify({ error: { message: `Provider failure ${secret}` } })); return;
  }
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `Fixture answer: ${last}` }, finish_reason: 'stop' }] }));
});
await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const env = Object.fromEntries(Object.entries({ ...process.env, PAPER_TIMELINE_DATA: directory, PAPER_TIMELINE_AI: '0' })
  .filter((item): item is [string, string] => typeof item[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.argv.includes('--packaged');
const app = await electron.launch({ executablePath: resolve(packaged ? 'release/win-unpacked/Paper Timeline.exe' : 'node_modules/electron/dist/electron.exe'),
  ...(packaged ? {} : { args: [resolve('.')] }), env, timeout: 30000 });
const page = await app.firstWindow(), errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', event => { if (event.type() === 'error') console.log('Renderer error:', event.text()); });
await app.evaluate(({ session }) => {
  (globalThis as any).chatFixtureRequests = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => { (globalThis as any).chatFixtureRequests.push(details.url); callback({}); });
});
const viewer = page.locator('embedpdf-container');
const chat = page.getByRole('complementary', { name: 'AI 聊天', exact: true });
const message = chat.getByRole('textbox', { name: '消息', exact: true });
const waitRequest = async (count: number) => {
  const deadline = Date.now() + 10000;
  while (requests.length < count && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 25));
  assert.equal(requests.length, count);
};
const ready = () => page.getByText('标注自动保存到文献库', { exact: true }).waitFor({ timeout: 30000 });
const openChat = async () => {
  if (!await chat.isVisible()) await viewer.getByRole('button', { name: 'AI', exact: true }).click();
  await chat.waitFor(); await chat.getByText('fixture-chat-model', { exact: true }).waitFor();
  await chat.locator('.reader-ai-workdir[title]').waitFor();
};
const checkVisibleContext = async (index: number) => {
  const context = await page.evaluate(id => window.paperApi!.getModelChatContext(id), ids[index]);
  assert.equal(context.paperId, ids[index]); assert.equal(context.paperTitle, titles[index]);
  assert.equal(context.workingDirectory, library.paperDirectory(ids[index]), 'uses the selected paper folder, not the library root or application directory');
  assert.equal(context.files.pdf, library.pdfPath(ids[index]));
  assert.equal(context.files.markdown, index === 0 ? join(library.paperDirectory(ids[0]), 'notes.md') : null);
  assert.equal(context.files.parsedDirectory, null);
  assert.equal(await chat.locator('.reader-ai-workdir').getAttribute('title'), context.workingDirectory);
  const details = chat.locator('details.reader-ai-workspace');
  assert.equal(await details.getAttribute('open'), null, 'file paths are collapsed by default');
  await details.locator('summary').click();
  assert.equal(await chat.getByLabel('工作目录路径', { exact: true }).innerText(), context.workingDirectory);
  assert.equal((await details.innerText()).includes(library.pdfPath(ids[index])), true);
  if (index === 0) assert.equal((await details.innerText()).includes(context.files.markdown!), true);
  assert.equal((await details.innerText()).includes(ids[1 - index]), false, 'only the current paper files are displayed');
  await details.locator('summary').click();
};
const send = async (text: string, count: number) => {
  await message.fill(text); await chat.getByRole('button', { name: '发送', exact: true }).click(); await waitRequest(count);
};
const answer = (text: string) => chat.getByText(`Fixture answer: ${text}`, { exact: true }).waitFor();
const expectWidth = async (width: number) => {
  const deadline = Date.now() + 3000;
  let actual = 0;
  do {
    actual = (await chat.boundingBox())?.width || 0;
    if (Math.abs(actual - width) <= 2) return;
    await new Promise(accept => setTimeout(accept, 25));
  } while (Date.now() < deadline);
  assert.ok(Math.abs(actual - width) <= 2, `sidebar width ${actual} should be ${width}`);
};
try {
  await page.getByRole('button', { name: '打开文献库', exact: true }).click();
  await page.getByRole('button', { name: '打开 PDF：first.pdf', exact: true }).click(); await ready();
  await viewer.getByRole('button', { name: 'AI', exact: true }).click(); await chat.waitFor();
  await chat.getByText('尚未配置大模型', { exact: true }).waitFor();
  await message.fill('not sent without configuration');
  assert.equal(await chat.getByRole('button', { name: '发送', exact: true }).isDisabled(), true);
  assert.equal(requests.length, 0, 'opening a PDF or AI panel never calls a model automatically');
  console.log('PASS: PDF opens offline; AI requires explicit model configuration.');
  await chat.getByRole('button', { name: '关闭 AI 聊天', exact: true }).click();
  await page.getByRole('button', { name: '个人首页', exact: true }).click();
  await page.getByRole('button', { name: '配置大模型', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await page.locator('#model-config-name').fill('Chat fixture'); await page.locator('#model-config-url').fill(base + '/v1');
  await page.locator('#model-config-model').fill('fixture-chat-model'); await page.locator('#model-config-key').fill(secret);
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await dialog.getByRole('button', { name: '选择', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal((await readFile(join(directory, 'llm-config.bin'))).includes(Buffer.from(secret)), false);
  assert.equal(requests.length, 0, 'saving a model configuration does not send a request');
  await page.getByRole('tab', { name: titles[0], exact: true }).click(); await ready(); await openChat();
  await checkVisibleContext(0);
  const rejectedInputs = await page.evaluate(async id => {
    const api = window.paperApi!;
    const inputs = [
      { requestId: 'fixture-forged-directory', paperId: id, workingDirectory: 'C:\\forged-directory', messages: [{ role: 'user', content: 'do not send' }] },
      { requestId: 'fixture-unknown-paper', paperId: 'c'.repeat(64), messages: [{ role: 'user', content: 'do not send' }] },
      { requestId: 'fixture-missing-paper', messages: [{ role: 'user', content: 'do not send' }] },
    ];
    const results: boolean[] = [];
    for (const input of inputs) {
      try { results.push(!(await api.chatModel(input as Parameters<typeof api.chatModel>[0])).ok); } catch { results.push(true); }
    }
    try { await api.getModelChatContext('c'.repeat(64)); results.push(false); } catch { results.push(true); }
    return results;
  }, ids[0]);
  assert.deepEqual(rejectedInputs, [true, true, true, true]);
  assert.equal(requests.length, 0, 'forged directory, missing and unknown paper IDs are rejected before network traffic');
  assert.equal(await message.inputValue(), 'not sent without configuration', 'draft survives leaving the reader');
  await message.fill('first message');
  await message.press('Escape'); await chat.waitFor({ state: 'hidden' });
  assert.equal(await viewer.getByRole('button', { name: 'AI', exact: true }).evaluate(element => element === (element.getRootNode() as ShadowRoot).activeElement), true);
  await openChat();
  assert.equal(await message.inputValue(), 'first message', 'closing the sidebar preserves the draft');
  await chat.getByRole('button', { name: '发送', exact: true }).click(); await waitRequest(1); await answer('first message');
  assert.equal(await message.inputValue(), '');
  assert.deepEqual(requests[0].body.messages.slice(1), [{ role: 'user', content: 'first message' }]);

  // Drag the real sidebar boundary over the PDF; commit, cancel and restore widths without modifying annotations.
  await page.setViewportSize({ width: 1400, height: 900 }); await expectWidth(380);
  const separator = viewer.getByRole('separator', { name: '调整 AI 对话框宽度', exact: true });
  const dragBoundary = async (distance: number, cancel = false) => {
    const edge = await separator.boundingBox(); assert.ok(edge);
    await page.mouse.move(edge.x + 3, edge.y + 40); await page.mouse.down();
    await page.mouse.move(edge.x + 3 - distance, edge.y + 40, { steps: 8 });
    if (cancel) await separator.press('Escape');
    await page.mouse.up();
  };
  await dragBoundary(160); await expectWidth(540);
  await dragBoundary(-120, true); await expectWidth(540);
  await separator.focus(); await separator.press('Home'); await expectWidth(300);
  await separator.press('End'); await expectWidth(1000);
  await page.setViewportSize({ width: 1050, height: 700 });
  const narrowMax = Math.max(280, Math.min(1000, Math.floor((await viewer.boundingBox())!.width) - 320));
  await expectWidth(narrowMax);
  await page.setViewportSize({ width: 1400, height: 900 }); await expectWidth(1000);
  await dragBoundary(-460); await expectWidth(540);
  assert.equal(await viewer.evaluate(element => element.classList.contains('reader-ai-resizing')), false);
  assert.equal(await page.evaluate(() => getSelection()?.toString()), '');
  console.log('PASS: sidebar boundary drag, keyboard limits, cancellation and window resize clamp.');

  // Failed completions expose only a safe error and retry the same user turn once.
  await send('retry this request', 2); await chat.getByRole('alert').waitFor();
  assert.equal((await chat.innerText()).includes(secret), false);
  assert.match(await chat.getByRole('alert').innerText(), /401|密钥|认证|鉴权/);
  await chat.getByRole('button', { name: '重试', exact: true }).click(); await waitRequest(3); await answer('retry this request');
  assert.deepEqual(requests[2].body.messages.slice(1), requests[1].body.messages.slice(1), 'retry does not duplicate the user turn');
  console.log('PASS: explicit chat with authoritative paper directory, rejected forged paths/unknown paper, safe provider failure and retry.');

  // Stop aborts the request without losing the previous conversation or another draft.
  await send('hold request', 4); await message.fill('draft while generating');
  await chat.getByRole('button', { name: '关闭 AI 聊天', exact: true }).click();
  await page.getByRole('button', { name: '文献库', exact: true }).click();
  await page.getByRole('tab', { name: titles[0], exact: true }).click(); await ready(); await openChat();
  assert.equal(await message.inputValue(), 'draft while generating');
  await chat.getByRole('button', { name: '停止生成', exact: true }).click();
  await chat.getByRole('button', { name: '发送', exact: true }).waitFor();
  assert.match(await chat.getByRole('alert').innerText(), /取消|停止/);
  assert.equal(await message.inputValue(), 'draft while generating');
  await message.fill('line one'); await message.press('End'); await message.press('Shift+Enter'); await message.press('l');
  assert.equal(await message.inputValue(), 'line one\nl'); assert.equal(requests.length, 4);
  await message.fill('after cancellation'); await message.press('Enter'); await waitRequest(5); await answer('after cancellation');
  await message.fill('first paper draft');

  // Each document owns its messages and draft, including while its reader is unmounted.
  await page.getByRole('button', { name: '文献库', exact: true }).click();
  await page.getByRole('button', { name: '打开 PDF：second.pdf', exact: true }).click(); await ready(); await openChat();
  await expectWidth(540);
  await checkVisibleContext(1);
  assert.equal(await chat.getByRole('article').count(), 0); assert.equal(await message.inputValue(), '');
  await send('second paper message', 6); await answer('second paper message');
  assert.deepEqual(requests[5].body.messages.slice(1), [{ role: 'user', content: 'second paper message' }]);
  await message.fill('second paper draft');
  await page.getByRole('tab', { name: titles[0], exact: true }).click(); await ready(); await openChat();
  await answer('first message'); assert.equal(await message.inputValue(), 'first paper draft');
  assert.equal((await chat.innerText()).includes('second paper message'), false);
  console.log('PASS: stop generation, background request continuity and independent document conversations/drafts.');

  // The custom panel participates in the same right-hand sidebar as native tools.
  await viewer.getByRole('button', { name: '搜索', exact: true }).click(); await chat.waitFor({ state: 'hidden' });
  await openChat();
  await expectWidth(540);
  await viewer.getByRole('button', { name: '评论', exact: true }).click(); await chat.waitFor({ state: 'hidden' });
  await openChat();
  await page.setViewportSize({ width: 1050, height: 700 });
  const log = await chat.getByRole('log', { name: '聊天记录', exact: true }).elementHandle(); assert.ok(log);
  await page.waitForFunction(element => element.scrollHeight - element.clientHeight - element.scrollTop <= 2, log);
  const bounds = await chat.boundingBox(), inputBounds = await message.boundingBox();
  assert.ok(bounds && bounds.width >= 280 && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1051 && bounds.y + bounds.height <= 701);
  assert.ok(inputBounds && inputBounds.x >= bounds.x && inputBounds.x + inputBounds.width <= bounds.x + bounds.width + 1 && inputBounds.y + inputBounds.height <= 701);
  await page.screenshot({ path: join(directory, 'pdf-chat.png'), fullPage: true });
  await chat.locator('details.reader-ai-workspace > summary').click();
  const expandedInputBounds = await message.boundingBox();
  assert.ok(expandedInputBounds && expandedInputBounds.y + expandedInputBounds.height <= 701, 'expanded paths keep the composer within the window');
  for (const entry of await chat.locator('.reader-ai-workspace dd').all()) {
    const entryBounds = await entry.boundingBox(); assert.ok(entryBounds && entryBounds.x + entryBounds.width <= bounds.x + bounds.width + 1, 'long paths wrap inside the sidebar');
  }
  await page.screenshot({ path: join(directory, 'pdf-chat-workspace-expanded.png'), fullPage: true });
  await chat.locator('details.reader-ai-workspace > summary').click();

  // Chat UI does not interfere with automatic reading-state saves or native annotations.
  await chat.getByRole('button', { name: '关闭 AI 聊天', exact: true }).click();
  await viewer.getByRole('button', { name: '放大', exact: true }).click();
  const zoom = await viewer.evaluate(async (element: any) => (await element.registry).getPlugin('zoom').provides().getState().currentZoomLevel);
  await page.getByRole('button', { name: '文献库', exact: true }).click();
  await page.getByRole('tab', { name: titles[0], exact: true }).click(); await ready(); await openChat();
  const restored = await viewer.evaluate(async (element: any) => {
    const registry = await element.registry;
    return { zoom: registry.getPlugin('zoom').provides().getState().currentZoomLevel,
      annotations: registry.getPlugin('annotation').provides().getAnnotations().map((item: any) => item.object.contents) };
  });
  assert.equal(restored.zoom, zoom); assert.deepEqual(restored.annotations, ['CHAT_PRIVATE_ANNOTATION']);
  assert.equal(await message.inputValue(), 'first paper draft');
  await chat.getByRole('button', { name: '清空对话', exact: true }).click();
  await chat.getByRole('article').first().waitFor({ state: 'hidden' });
  assert.equal(await chat.getByRole('article').count(), 0);
  await page.getByRole('tab', { name: titles[1], exact: true }).click(); await ready(); await openChat();
  await answer('second paper message'); assert.equal(await message.inputValue(), 'second paper draft');

  const includesPath = (text: string, path: string) => text.includes(path) || text.includes(JSON.stringify(path).slice(1, -1));
  for (const [requestIndex, request] of requests.entries()) {
    const index = requestIndex === 5 ? 1 : 0;
    const system = request.body.messages[0]; assert.equal(system.role, 'system'); assert.equal(typeof system.content, 'string');
    assert.ok(system.content.includes(titles[index]) && system.content.includes(ids[index]), 'every send and retry includes the current paper identity');
    assert.ok(includesPath(system.content, library.paperDirectory(ids[index])), 'model receives the selected paper working directory');
    assert.ok(includesPath(system.content, library.pdfPath(ids[index])), 'model receives the current PDF path');
    if (index === 0) assert.ok(includesPath(system.content, join(library.paperDirectory(ids[0]), 'notes.md')));
    assert.equal(system.content.includes(titles[1 - index]), false, 'system context never crosses paper boundaries');
    assert.equal(system.content.includes(ids[1 - index]), false, 'other paper paths are absent');
    assert.equal(request.method, 'POST'); assert.equal(request.path, '/v1/chat/completions'); assert.equal(request.authorization, `Bearer ${secret}`);
    assert.equal(request.body.model, 'fixture-chat-model'); assert.equal(request.body.stream, false);
    assert.ok(request.body.messages.slice(1).every((item: any) => ['user', 'assistant'].includes(item.role) && Object.keys(item).sort().join(',') === 'content,role'));
    for (const marker of [...markers, 'CHAT_PRIVATE_AUTHOR']) assert.equal(JSON.stringify(request.body).includes(marker), false, 'file contents and unrelated metadata are not sent with directory context');
    assert.equal(JSON.stringify(request.body).includes(secret), false, 'credentials are confined to Authorization');
  }
  const urls = await app.evaluate(() => (globalThis as any).chatFixtureRequests as string[]);
  assert.ok(urls.filter(url => /^https?:/.test(url)).every(url => url.startsWith(base + '/')), 'network requests stay on the local fixture');
  assert.deepEqual(errors, []); assert.deepEqual(await readFile(library.pdfPath(ids[0])), original);
  // Publish synthetic MinerU output to this isolated fixture; no real parser/model is called.
  const canvas = createCanvas(120, 80); canvas.getContext('2d').fillStyle = '#3274d8'; canvas.getContext('2d').fillRect(0, 0, 120, 80);
  library.startMineru({ environment: async () => ({ ready: true, message: 'fixture' }), convert: async (_pdf, output) => {
    await writeFile(output, zipSync({ 'markdown.md': strToU8('# Agent fixture\nCURRENT_AGENT_EVIDENCE\n![Figure](images/fixture.png)\n'), 'middle_json.json': strToU8('{}'), 'images/fixture.png': canvas.toBuffer('image/png') })); return 'fixture';
  } });
  await library.convertPdf(ids[0]); await library.whenIdle();
  await page.getByRole('tab', { name: titles[0], exact: true }).click(); await ready(); await openChat();
  const beforeAgent = requests.length;
  await message.fill('agent analyze current paper'); await chat.getByRole('button', { name: '发送', exact: true }).click();
  await chat.getByText('Agent checked full text, figure and PDF page 1.', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(requests.length, beforeAgent + 5);
  const outgoingImages = requests.at(-1)!.body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === 'image_url') : []);
  assert.equal(outgoingImages.length, 2, 'actual image and independently rendered original PDF page reach the fake model');
  const provenance = chat.locator('.reader-ai-evidence').last(); await provenance.locator('summary').click();
  assert.match(await provenance.innerText(), /PDF 第 1 页/); assert.match(await provenance.innerText(), /全文/);
  await page.screenshot({ path: join(directory, 'paper-agent-evidence.png'), fullPage: true });
  const transcript = JSON.parse(await readFile(join(library.paperDirectory(ids[0]), 'chat.json'), 'utf8'));
  assert.equal(transcript.messages.at(-1).activity.length, 4); assert.equal(transcript.messages.at(-1).sources.length, 3);
  assert.equal(JSON.stringify(transcript).includes(secret), false); assert.equal(JSON.stringify(transcript).includes('base64'), false);
  await page.reload();
  await page.getByRole('button', { name: '打开文献库', exact: true }).click();
  await page.getByRole('button', { name: '打开 PDF：first.pdf', exact: true }).click(); await ready(); await openChat();
  await chat.getByText('Agent checked full text, figure and PDF page 1.', { exact: true }).waitFor();
  assert.equal(requests.length, beforeAgent + 5, 'restoring saved conversation does not contact a model');
  await expectWidth(540);
  assert.deepEqual(await readFile(library.pdfPath(ids[0])), original);
  console.log('PASS: scoped AI SDK tools read full text and images, render source PDF, show evidence, save and restore conversation.');

  // Render existing and new Markdown as semantic content; model output cannot load images, execute HTML or open local protocols.
  const beforeMarkdown = requests.length;
  await send(markdownPrompt, beforeMarkdown + 1);
  const markdown = chat.locator('.reader-ai-markdown').last();
  await markdown.getByRole('heading', { name: '主要结论', level: 2, exact: true }).waitFor();
  assert.equal(await markdown.locator('[data-streamdown="strong"]').first().innerText(), '重点结论');
  assert.equal(await markdown.locator('[data-streamdown="strong"]').nth(1).innerText(), '“重要结果。”');
  assert.ok(Number(await markdown.locator('[data-streamdown="strong"]').first().evaluate(element => getComputedStyle(element).fontWeight)) >= 600);
  assert.equal(await markdown.locator('em').innerText(), '证据解释');
  assert.equal(await markdown.locator('li').count(), 2);
  assert.equal(await markdown.locator('li').first().evaluate(element => getComputedStyle(element).listStyleType), 'disc');
  assert.equal(await markdown.locator('blockquote').innerText(), '引用原文示例');
  assert.equal(await markdown.locator('table').count(), 1);
  assert.equal(await markdown.locator('.katex').count(), 4);
  assert.equal(await markdown.locator('.katex-display').count(), 2);
  assert.equal(await markdown.locator('[data-streamdown="inline-code"]').last().innerText(), '\\(literal\\)');
  assert.equal(await page.evaluate(async () => (await document.fonts.load('16px KaTeX_Main')).length > 0), true, 'formula fonts are available from local bundled assets');
  const codeBody = markdown.locator('[data-streamdown="code-block-body"]');
  await codeBody.scrollIntoViewIfNeeded();
  assert.equal(await codeBody.getAttribute('data-language'), 'python');
  assert.equal((await codeBody.locator('code').textContent())?.includes('# Keep \\(x\\) literal inside code'), true);
  // The lazy highlighter replaces its fallback body; follow the locator rather than the old DOM node.
  await codeBody.locator('span[style*="--sdm-c: #"]').first().waitFor();
  assert.ok(await codeBody.evaluate(element => new Set([...element.querySelectorAll('span[style]')].map(item => getComputedStyle(item).color)).size > 1), 'highlight token colors are applied inside the PDF shadow root');
  await page.evaluate("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText(text) { if (window.fixtureClipboardFailure) return Promise.reject(new Error('fixture clipboard failure')); window.fixtureCopiedCode = text; return Promise.resolve(); } } })");
  await markdown.getByRole('button', { name: '复制代码', exact: true }).click();
  assert.equal(await page.evaluate(() => (window as any).fixtureCopiedCode), codeFixture + '\n');
  const copyReply = chat.getByRole('button', { name: '复制 AI 回复', exact: true }).last();
  await copyReply.click();
  assert.equal(await page.evaluate(() => (window as any).fixtureCopiedCode), markdownReply, 'copy the full original reply, including formulas and Markdown');
  await chat.getByRole('button', { name: '复制我的消息', exact: true }).last().click();
  assert.equal(await page.evaluate(() => (window as any).fixtureCopiedCode), markdownPrompt);
  await page.evaluate(() => { (window as any).fixtureClipboardFailure = true; });
  await copyReply.click(); await chat.getByText('复制失败，请重试', { exact: true }).waitFor();
  await page.evaluate(() => { (window as any).fixtureClipboardFailure = false; });
  await copyReply.click(); await chat.getByText('复制失败，请重试', { exact: true }).waitFor({ state: 'hidden' });
  for (const scrollable of [codeBody, markdown.locator('[data-streamdown="table-wrapper"] > div').last()]) {
    assert.equal(await scrollable.evaluate(element => element.scrollWidth > element.clientWidth && getComputedStyle(element).overflowX === 'auto'), true);
  }
  assert.equal(await markdown.locator('img, script').count(), 0);
  assert.equal(await page.evaluate(() => !!(window as any).markdownFixtureExecuted), false);
  assert.equal(await markdown.getByRole('link').count(), 1);
  await app.evaluate(({ shell }) => {
    (globalThis as any).chatFixtureExternalLinks = [];
    shell.openExternal = async url => { (globalThis as any).chatFixtureExternalLinks.push(url); };
  });
  const location = page.url(); await markdown.getByRole('link', { name: '网页资料', exact: true }).click();
  assert.deepEqual(await app.evaluate(() => (globalThis as any).chatFixtureExternalLinks), ['https://example.org/paper']);
  assert.equal(page.url(), location);
  const rejectedLinks = await page.evaluate(async () => {
    const rejected = [];
    for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,unsafe', 'https://user:password@example.org/']) {
      try { await window.paperApi!.openChatLink(url); rejected.push(false); } catch { rejected.push(true); }
    }
    return rejected;
  });
  assert.deepEqual(rejectedLinks, [true, true, true, true]);
  assert.deepEqual(await app.evaluate(() => (globalThis as any).chatFixtureExternalLinks), ['https://example.org/paper']);
  await markdown.getByRole('heading', { name: '主要结论', exact: true }).scrollIntoViewIfNeeded();
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.screenshot({ path: join(directory, 'pdf-chat-markdown.png'), fullPage: true });
  await markdown.getByRole('heading', { name: '数学表达', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(directory, 'streamdown-math.png'), fullPage: true });
  await codeBody.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(directory, 'streamdown-code.png'), fullPage: true });
  assert.equal(JSON.parse(await readFile(join(library.paperDirectory(ids[0]), 'chat.json'), 'utf8')).messages.at(-1).content, markdownReply, 'save the original Markdown, not rendered HTML');
  await page.reload();
  await page.getByRole('button', { name: '打开文献库', exact: true }).click();
  await page.getByRole('button', { name: '打开 PDF：first.pdf', exact: true }).click(); await ready(); await openChat();
  await chat.getByRole('heading', { name: '主要结论', level: 2, exact: true }).waitFor(); await expectWidth(540);
  assert.equal(requests.length, beforeMarkdown + 1, 'Markdown history and width restore without model calls');

  // Use actual mouse selection and wheel input; programmatic DOM selection misses focus/shortcut conflicts.
  const restoredMarkdown = chat.locator('.reader-ai-markdown').last();
  const paragraph = restoredMarkdown.locator('p').filter({ hasText: '中文加粗：' });
  await paragraph.scrollIntoViewIfNeeded();
  const endpoints = await paragraph.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const rects = [...range.getClientRects()]; const first = rects[0], last = rects.at(-1)!;
    return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 };
  });
  await page.mouse.move(endpoints.x1, endpoints.y1); await page.mouse.down();
  await page.mouse.move(endpoints.x2, endpoints.y2, { steps: 12 }); await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() || '');
  assert.ok(selected.includes('重要结果'), 'rendered reply text can be selected with a mouse');
  // Intercept the native copy event so this regression never replaces the user's OS clipboard.
  await page.evaluate(() => document.addEventListener('copy', event => {
    event.preventDefault(); (window as any).fixtureCopiedSelection = window.getSelection()?.toString();
  }, true));
  await page.keyboard.press('Control+c');
  const copiedSelection = await page.evaluate(() => (window as any).fixtureCopiedSelection);
  const pdfScroll = () => viewer.evaluate(element => {
    const viewport = element.shadowRoot?.querySelector('#document-content .bg-bg-app');
    return viewport ? { top: viewport.scrollTop, left: viewport.scrollLeft } : null;
  });
  const pdfBeforeWheel = await pdfScroll(); assert.ok(pdfBeforeWheel);
  const logBox = chat.getByRole('log', { name: '聊天记录', exact: true });
  const wheelOver = async (target: ReturnType<typeof chat.locator>, deltaY = 120) => {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox(); assert.ok(box);
    const before = await logBox.evaluate(element => element.scrollTop);
    await page.mouse.move(box.x + Math.min(60, box.width / 2), box.y + box.height / 2);
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(180);
    return { before, after: await logBox.evaluate(element => element.scrollTop) };
  };
  const restoredCode = restoredMarkdown.locator('[data-streamdown="code-block"]');
  await restoredCode.scrollIntoViewIfNeeded(); await restoredCode.locator('span[style*="--sdm-c: #"]').first().waitFor();
  const codeWheel = await wheelOver(restoredCode);
  const formulaWheel = await wheelOver(restoredMarkdown.locator('.katex-display').first());
  const table = restoredMarkdown.locator('[data-streamdown="table-wrapper"]');
  await table.locator('> div').last().evaluate(element => { element.scrollTop = 0; });
  const tableWheel = await wheelOver(table, -120);
  assert.equal(copiedSelection, selected, 'Ctrl+C copies the chat selection instead of invoking PDF copy');
  assert.ok(codeWheel.after > codeWheel.before, 'vertical wheel over a short code block scrolls the conversation');
  assert.ok(formulaWheel.after > formulaWheel.before, 'vertical wheel over a formula scrolls the conversation');
  assert.ok(tableWheel.after < tableWheel.before, 'vertical wheel at the top of a table continues through the conversation');
  assert.deepEqual(await pdfScroll(), pdfBeforeWheel, 'chat wheel input does not scroll the PDF');
  console.log('PASS: real mouse selection and Ctrl+C, whole-message copy/retry, wheel chaining over code/formulas/tables and isolated PDF scrolling.');
  await chat.getByRole('button', { name: '配置大模型', exact: true }).click();
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await page.locator('#model-config-name').fill('Responses fixture'); await page.locator('#model-config-url').fill(base + '/v1');
  await page.locator('#model-config-model').fill('gpt-6-astra'); await page.locator('#model-config-key').fill(secret);
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await dialog.getByRole('button', { name: '选择', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  const beforeResponses = requests.length;
  await message.fill('阅读这篇论文，总结研究背景和创新点。'); await chat.getByRole('button', { name: '发送', exact: true }).click();
  await chat.getByText('Responses 已根据论文全文作答。', { exact: true }).waitFor({ timeout: 15000 });
  const turns = requests.slice(beforeResponses);
  assert.equal(turns.length, 2);
  for (const turn of turns) {
    assert.equal(turn.path, '/v1/responses'); assert.equal(turn.authorization, 'Bearer ' + secret);
    assert.equal(turn.body.store, false); assert.equal(turn.body.max_output_tokens, 4096);
    assert.equal(turn.body.max_tokens, undefined); assert.equal(turn.body.messages, undefined);
    assert.ok(turn.body.tools.some((tool: any) => tool.type === 'function' && tool.name === 'read_text'));
    assert.ok(turn.body.include.includes('reasoning.encrypted_content'));
  }
  const followup = turns[1].body.input;
  assert.ok(followup.some((p: any) => p.type === 'reasoning' && p.encrypted_content === 'opaque-fixture-reasoning'));
  assert.ok(followup.some((p: any) => p.type === 'function_call_output' && p.call_id === 'call_read' && JSON.stringify(p.output).includes('CURRENT_AGENT_EVIDENCE')));
  assert.ok(!(await readFile(join(library.paperDirectory(ids[0]), 'chat.json'), 'utf8')).includes('opaque-fixture-reasoning'));
  console.log('PASS: GPT-6 Astra PDF chat uses Responses, reads full text, continues reasoning and returns the answer inside the reader.');
  const finalUrls = await app.evaluate(() => (globalThis as any).chatFixtureRequests as string[]);
  assert.ok(finalUrls.filter(url => /^https?:/.test(url)).every(url => url.startsWith(base + '/')), 'Markdown never loads model-supplied remote images');
  assert.deepEqual(errors, []);
  console.log('PASS: Streamdown CJK, formulas and local fonts, Shiki highlighting and copy, table scrolling, safe links and saved Markdown history.');
  console.log(JSON.stringify({ packaged, directory, result: 'passed', requests: requests.length,
    checks: 'native text selection/copy, message copy and retry, wheel chaining over code/formulas/tables without PDF scrolling, sidebar resizing, Markdown rendering/history, safe links and inert HTML/images, scoped paper agent and PDF reading state' }));
} catch (error) {
  await page.screenshot({ path: join(directory, 'pdf-chat-failure.png'), fullPage: true }).catch(() => {});
  console.log('Chat fixture errors:', errors); console.log('Isolated fixture:', directory); throw error;
} finally {
  await app.close();
  for (const response of held) response.destroy();
  server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept()));
}
