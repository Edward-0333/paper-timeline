import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { Library } from '../electron/library';
import { localMetadata } from '../electron/metadata';
import type { ModelChatMessage } from '../shared/model-chat';

// No production papers, user settings, credentials or live model services are used.
await mkdir('.test-data', { recursive: true });
const directory = await mkdtemp(resolve('.test-data/chat-compaction-ui-'));
const library = new Library(join(directory, 'library'), async (_path, name) => ({ title: name, authors: ['Fixture Author'], year: 2025,
  doi: '', arxivId: '', abstract: '', firstPageText: 'Isolated paper', pageCount: 1 }),
  async pdf => ({ metadata: localMetadata(pdf), matched: true, message: 'fixture' }));
await library.initialize();
const stream = 'BT /F1 16 Tf 72 700 Td (Isolated compaction fixture) Tj ET';
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
let raw = '%PDF-1.7\n'; const offsets = [0];
for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(raw)); raw += `${index + 1} 0 obj\n${object}\nendobj\n`; }
const xref = Buffer.byteLength(raw);
raw += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const ids: string[] = [], initial: ModelChatMessage[][] = [];
for (const [index, name] of ['auto.pdf', 'manual.pdf'].entries()) {
  const file = join(directory, name); await writeFile(file, raw + `\n% ${index}\n`);
  const imported = await library.importPaths([file]); await library.whenIdle(); const id = imported.paperIds![0]; ids.push(id);
  const messages: ModelChatMessage[] = Array.from({ length: 72 }, (_, number) => ({ role: number % 2 ? 'assistant' : 'user',
    content: `ARCHIVE_${index}_${number} ` + 'Evidence and open research questions. '.repeat(22) }));
  initial.push(messages);
  await writeFile(join(library.paperDirectory(id), 'chat.json'), JSON.stringify({ version: 1, messages }));
}
const requests: any[] = [], held = new Set<ServerResponse>();
let summaryMode: 'normal' | 'fail' | 'hold' = 'normal';
const server = createServer(async (request, response) => {
  const buffers: Buffer[] = []; for await (const chunk of request) buffers.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(buffers).toString('utf8')); requests.push(body);
  response.setHeader('Content-Type', 'application/json');
  assert.equal(request.url, '/v1/chat/completions');
  const summary = !body.tools?.length;
  if (summary && summaryMode === 'hold') { held.add(response); response.once('close', () => held.delete(response)); return; }
  if (summary && summaryMode === 'fail') { response.writeHead(503); response.end(JSON.stringify({ error: { message: 'fixture summary unavailable' } })); return; }
  const content = summary
    ? 'PORTABLE_SUMMARY: Goal is to analyze the paper. Confirmed evidence is at fulltext:L1-L10. Limitations remain unverified. Continue checking original material before drawing conclusions.'
    : '上下文测试回答：已保留摘要和近期问题。';
  response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }));
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}/v1`;
const env = Object.fromEntries(Object.entries({ ...process.env, PAPER_TIMELINE_DATA: directory, PAPER_TIMELINE_AI: '0' }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.argv.includes('--packaged');
let app = await electron.launch({ executablePath: resolve(packaged ? 'release/win-unpacked/Paper Timeline.exe' : 'node_modules/electron/dist/electron.exe'), ...(packaged ? {} : { args: [resolve('.')] }), env });
let page = await app.firstWindow();
const errors: string[] = [];
const watchErrors = () => page.on('pageerror', error => errors.push(error.message)); watchErrors();
const chat = () => page.getByRole('complementary', { name: 'AI 聊天', exact: true });
const dialog = () => page.getByRole('dialog');
const configure = async (model: string, capacity: number) => {
  await dialog().getByRole('button', { name: '添加', exact: true }).click();
  await page.locator('#model-config-name').fill(model); await page.locator('#model-config-url').fill(baseUrl); await page.locator('#model-config-model').fill(model);
  assert.equal(await page.locator('#model-config-context').inputValue(), '32768');
  await page.locator('#model-config-context').fill(String(capacity));
  await dialog().getByLabel('此接口无需 API Key（例如本地模型）').check();
  await dialog().getByRole('button', { name: '保存配置', exact: true }).click();
  await dialog().getByRole('button', { name: '选择', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
};
const openPaper = async (name: string) => {
  const libraryButton = page.getByRole('button', { name: '文献库', exact: true });
  await libraryButton.click();
  await page.getByRole('button', { name: `打开 PDF：${name}`, exact: true }).click();
  await page.getByText('标注自动保存到文献库', { exact: true }).waitFor({ timeout: 30000 });
  if (!await chat().isVisible()) await page.locator('embedpdf-container').getByRole('button', { name: 'AI', exact: true }).click();
  await chat().getByRole('button', { name: '立即压缩', exact: true }).waitFor();
  await chat().locator('.reader-ai-workdir[title]').waitFor();
};
const idle = () => chat().getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 30000 });
const archive = async (index: number) => JSON.parse(await readFile(join(library.paperDirectory(ids[index]), 'chat.json'), 'utf8'));
const memory = async (index: number) => JSON.parse(await readFile(join(library.paperDirectory(ids[index]), 'chat-context.json'), 'utf8'));
try {
  await page.getByRole('button', { name: '配置大模型', exact: true }).click(); await configure('compact-model-a', 32768);
  assert.equal((await page.evaluate(() => window.paperApi!.getModelConfig())).contextWindowTokens, 32768);
  await openPaper('auto.pdf');
  assert.equal(requests.length, 0, 'opening long history does not invoke a model');
  assert.equal(await chat().getByRole('article').count(), 50);
  await chat().getByRole('button', { name: /查看更早消息/ }).click();
  assert.equal(await chat().getByRole('article').count(), 72);
  assert.ok((await chat().getByRole('article').first().innerText()).includes('ARCHIVE_0_0'));
  await chat().getByRole('textbox', { name: '消息', exact: true }).fill('Continue the same research goal.');
  await chat().getByRole('button', { name: '发送', exact: true }).click();
  await chat().getByText('上下文测试回答：已保留摘要和近期问题。', { exact: true }).waitFor({ timeout: 30000 }); await idle();
  assert.ok(requests.some(body => !body.tools?.length), 'automatic summary request occurred');
  const finalRequest = requests.filter(body => body.tools?.length).at(-1);
  assert.ok(JSON.stringify(finalRequest.messages).includes('PORTABLE_SUMMARY'));
  assert.ok(!JSON.stringify(finalRequest.messages).includes('ARCHIVE_0_0'));
  assert.equal((await archive(0)).messages.length, 74);
  assert.deepEqual((await archive(0)).messages.slice(0, 72), initial[0], 'all original history survives automatic compaction');
  assert.ok((await memory(0)).coveredMessages > 0);
  await chat().getByText(/已摘要压缩/).waitFor();
  await chat().getByText('查看历史摘要', { exact: true }).click();
  assert.ok((await chat().locator('.reader-ai-memory-details').innerText()).includes('PORTABLE_SUMMARY'));
  await chat().getByText('查看历史摘要', { exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: join(directory, 'automatic-summary.png'), fullPage: true });

  await openPaper('manual.pdf');
  const draft = chat().getByRole('textbox', { name: '消息', exact: true }); await draft.fill('Keep my unsent draft.');
  summaryMode = 'fail';
  await chat().getByRole('button', { name: '立即压缩', exact: true }).click();
  await chat().getByRole('alert').waitFor(); await idle();
  assert.equal((await archive(1)).messages.length, 72);
  await assert.rejects(readFile(join(library.paperDirectory(ids[1]), 'chat-context.json')), { code: 'ENOENT' });
  assert.equal(await draft.inputValue(), 'Keep my unsent draft.');
  summaryMode = 'hold';
  await chat().getByRole('button', { name: '重试', exact: true }).click();
  await chat().getByRole('button', { name: '停止生成', exact: true }).waitFor();
  const deadline = Date.now() + 10000;
  while (!held.size && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
  assert.ok(held.size); await chat().getByRole('button', { name: '停止生成', exact: true }).click(); await idle();
  assert.equal(await draft.inputValue(), 'Keep my unsent draft.');
  assert.deepEqual((await archive(1)).messages, initial[1]);
  summaryMode = 'normal';
  await chat().getByRole('button', { name: '重试', exact: true }).click();
  await chat().getByText(/已摘要压缩/).waitFor({ timeout: 30000 }); await idle();
  assert.deepEqual((await archive(1)).messages, initial[1], 'manual compaction does not add a pretend answer or remove history');
  assert.equal(await draft.inputValue(), 'Keep my unsent draft.');
  assert.ok((await memory(1)).summary.includes('PORTABLE_SUMMARY'));
  await chat().getByRole('button', { name: '配置大模型', exact: true }).click(); await configure('deepseek-flash', 16384);
  assert.ok((await chat().locator('.reader-ai-memory-row').innerText()).includes('16,384'));
  await draft.fill('Follow up using another provider-compatible model.');
  await chat().getByRole('button', { name: '发送', exact: true }).click();
  await chat().getByText('上下文测试回答：已保留摘要和近期问题。', { exact: true }).waitFor({ timeout: 30000 }); await idle();
  assert.equal(requests.at(-1).model, 'deepseek-flash');
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('PORTABLE_SUMMARY'));
  assert.equal((await archive(1)).messages.length, 74);
  assert.deepEqual((await archive(1)).messages.slice(0, 72), initial[1]);
  await page.screenshot({ path: join(directory, 'manual-summary-switch.png'), fullPage: true });

  const beforeRestart = requests.length;
  await app.close();
  app = await electron.launch({ executablePath: resolve(packaged ? 'release/win-unpacked/Paper Timeline.exe' : 'node_modules/electron/dist/electron.exe'), ...(packaged ? {} : { args: [resolve('.')] }), env });
  page = await app.firstWindow(); watchErrors();
  await openPaper('manual.pdf'); await chat().getByText(/已摘要压缩/).waitFor();
  assert.equal(requests.length, beforeRestart, 'restoring history and summary remains offline');
  assert.equal(await chat().getByRole('article').count(), 50);
  await chat().getByRole('button', { name: /查看更早消息/ }).click();
  assert.equal(await chat().getByRole('article').count(), 74);
  assert.ok((await chat().getByRole('article').first().innerText()).includes('ARCHIVE_1_0'));
  await chat().getByRole('button', { name: '清空对话', exact: true }).click();
  await chat().getByText('论文阅读 Agent', { exact: true }).waitFor();
  assert.equal(await chat().getByText('查看历史摘要', { exact: true }).count(), 0);
  assert.equal((await archive(1)).messages.length, 0);
  assert.equal(requests.length, beforeRestart);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ packaged, directory, requests: requests.length, result: 'passed', checks: '72-message full archives, automatic/manual summary, pagination, failure and cancellation, draft preservation, cross-model budget changes, offline restart, clear summary' }));
} catch (error) {
  await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {});
  console.log(JSON.stringify({ directory, errors, requests: requests.length })); throw error;
} finally {
  await app.close(); for (const response of held) response.destroy(); server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
}
