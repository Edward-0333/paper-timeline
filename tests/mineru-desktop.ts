import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { Library } from '../electron/library';
import { localMetadata } from '../electron/metadata';

await mkdir('.test-data', { recursive: true });
const root = await mkdtemp(resolve('.test-data/mineru-desktop-'));
const sourceDirectory = resolve('../pdf'), source = join(sourceDirectory, (await readdir(sourceDirectory)).find(n => n.includes('Learning Based MPC'))!);
const pdf = { title: 'MinerU real conversion fixture', authors: ['Fixture'], year: 2025, pageCount: 9, firstPageText: 'fixture', doi: '', arxivId: '', abstract: '' };
const library = new Library(join(root, 'library'), async () => pdf, async () => ({ metadata: localMetadata(pdf), matched: true, message: '' }));
await library.initialize(); const imported = await library.importPaths([source]); await library.whenIdle(); const id = imported.paperIds![0];
const noPdf = await library.createPaper({ title: 'Metadata without PDF fixture' }, null, false);
const original = await readFile(library.pdfPath(id));
const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, PAPER_TIMELINE_DATA: root, PAPER_TIMELINE_AI: '0' }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')); delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.argv.includes('--packaged');
const app = await electron.launch({ executablePath: resolve(packaged ? 'release/win-unpacked/Paper Timeline.exe' : 'node_modules/electron/dist/electron.exe'), ...(packaged ? {} : { args: [resolve('.')] }), env });
try {
  const page = await app.firstWindow(); await page.getByRole('button', { name: '打开文献库', exact: true }).click();
  await page.getByText(pdf.title, { exact: true }).click();
  const panel = page.getByRole('region', { name: 'AI 可读全文' }); await panel.waitFor();
  await panel.getByRole('button', { name: 'MinerU 环境设置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.mineru-settings')?.textContent?.includes('4.0.12'), { timeout: 60000 });
  await page.getByLabel('MinerU 解析模式').selectOption('flash');
  await panel.getByRole('button', { name: '转换为 AI 可读格式', exact: true }).click();
  let state = await page.evaluate(id => window.paperApi!.conversionState(id), id);
  for (let i = 0; i < 360 && (state.status === 'idle' || state.status === 'running'); i++) {
    await page.waitForTimeout(500); state = await page.evaluate(id => window.paperApi!.conversionState(id), id);
    if (i % 20 === 0) console.log('conversion:', JSON.stringify(state), await panel.innerText());
  }
  assert.equal(state.status, 'succeeded', state.message + '\n' + await panel.innerText());
  assert.equal(state.result!.tier, 'flash'); await panel.getByRole('button', { name: '打开全文 MD', exact: true }).waitFor();
  const dir = join(library.paperDirectory(id), 'parsed', state.result!.runId), md = await readFile(join(dir, state.result!.markdown), 'utf8'), json = JSON.parse(await readFile(join(dir, state.result!.json), 'utf8'));
  assert.ok(md.length > 2000, 'real PDF full text'); assert.ok(json); assert.deepEqual(await readFile(library.pdfPath(id)), original);
  // File opening is verified without launching an editor on the user's desktop.
  await app.evaluate(({ shell }) => { (globalThis as any).openedConversion = ''; shell.openPath = async path => { (globalThis as any).openedConversion = path; return ''; }; });
  await panel.getByRole('button', { name: '打开全文 MD', exact: true }).click();
  assert.equal(await app.evaluate(() => (globalThis as any).openedConversion), join(dir, 'markdown.md'));
  await panel.getByRole('button', { name: '结果文件夹', exact: true }).click(); assert.equal(await app.evaluate(() => (globalThis as any).openedConversion), dir);
  const panelWidth = await panel.evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth })); assert.ok(panelWidth.scroll <= panelWidth.client + 1, JSON.stringify(panelWidth));
  await page.screenshot({ path: join(root, 'mineru-success.png'), fullPage: true });
  await page.getByText('Metadata without PDF fixture', { exact: true }).click(); await page.getByText('添加 PDF 原文后即可转换。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '转换为 AI 可读格式', exact: true }).count(), 0);
  await page.getByText(pdf.title, { exact: true }).first().click(); await panel.getByRole('button', { name: '打开全文 MD', exact: true }).waitFor();
  console.log(JSON.stringify({ packaged, root, markdownCharacters: md.length, images: state.result!.images, noPdf: noPdf.id, result: 'passed' }));
} finally { await app.close(); }
