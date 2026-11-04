import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { Library } from '../electron/library';
import { localMetadata } from '../electron/metadata';
import { citationSeed, writeCitationSnapshot } from '../electron/citation-monitor';

await mkdir('.test-data', { recursive: true });
const directory = await mkdtemp(resolve('.test-data/citations-desktop-'));
const packaged = process.argv.includes('--packaged');
const titles = {
  alpha: 'Alpha research with a long title to verify fixed width citation workspace tabs',
  beta: 'Beta independent citation research', zero: 'Zero confirmed citation research', unknown: 'Unknown citation research',
};
const library = new Library(join(directory, 'library'), async () => { throw new Error('Fixtures never retrieve metadata'); },
  async pdf => ({ metadata: localMetadata(pdf), matched: true, message: 'isolated fixture' }));
await library.initialize();
const ids: Record<keyof typeof titles, string> = {} as Record<keyof typeof titles, string>;
for (const key of Object.keys(titles) as (keyof typeof titles)[]) {
  ids[key] = (await library.createPaper({ title: titles[key], authors: ['Seed Author'], publicationDate: '2024' }, null, false)).id;
}
const existingCitations = [
  { title: 'Already catalogued by DOI', doi: '10.9999/alpha.003' },
  { title: 'Already catalogued by arXiv', arxivId: '2501.00004' },
  { title: 'Alpha citing paper 005' },
];
for (const fields of existingCitations) await library.createPaper(fields, null, false);
function tinyPdf(text: string) {
  const stream = `BT /F1 16 Tf 72 700 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let raw = '%PDF-1.7\n'; const offsets: number[] = [];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(raw)); raw += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(raw);
  return raw + `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
const pdfPath = join(directory, 'alpha.pdf');
await writeFile(pdfPath, tinyPdf('Offline citation reader fixture'));
await library.attachPdf(ids.alpha, pdfPath);
const at = '2026-10-23T08:00:00.000Z';
for (const [key, count, prefix] of [['alpha', 205, 'Alpha'], ['beta', 2, 'Beta'], ['zero', 0, 'Zero']] as const) {
  const paper = library.get(ids[key]);
  await writeCitationSnapshot(library.directory, { version: 1, seed: citationSeed(paper), lastAttemptAt: at,
    lastSuccessAt: at, nextCheckAt: '', providers: [{ provider: 'openalex', status: 'success', count, seedIds: [], message: '' }],
    citations: Array.from({ length: count }, (_, index) => {
      const n = String(index + 1).padStart(3, '0');
      // Citation identities are global, as real server snapshots require. Beta's
      // first record represents Alpha 201; its other record is a distinct paper.
      const identity = key === 'beta' ? index === 0 ? 201 : 1002 : index + 1;
      return { id: identity.toString(16).padStart(64, '0'), title: `${prefix} citing paper ${n}`,
        authors: [`${prefix} Author ${n}`, 'Coauthor'], year: 2025, publicationDate: '2025-01-02', venue: `${prefix} Journal ${n}`,
        doi: key === 'beta' && index === 0 ? '10.9999/alpha.201' : `10.9999/${prefix.toLowerCase()}.${n}`,
        arxivId: `2501.${String(identity).padStart(5, '0')}`,
        abstract: `The abstract of ${prefix} citation ${n} is local cached text.`, url: '',
        sources: [{ provider: 'openalex' as const, id: `W${identity}` }], firstSeenAt: at, lastSeenAt: at };
    }),
  }, paper.storageFolder);
}
// These are snapshots of this disposable fixture, never the user's library.
const indexBefore = await readFile(library.file, 'utf8');
const snapshotPaths = (['alpha', 'beta', 'zero'] as const).map(key => join(library.paperDirectory(ids[key]), 'citations', 'citations.json'));
const snapshotsBefore = await Promise.all(snapshotPaths.map(path => readFile(path, 'utf8')));
function launch() {
  const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, PAPER_TIMELINE_DATA: directory, PAPER_TIMELINE_AI: '0' })
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({ executablePath: resolve(packaged ? 'release/win-unpacked/Paper Timeline.exe' : 'node_modules/electron/dist/electron.exe'),
    ...(packaged ? {} : { args: [resolve('.')] }), env, timeout: 30000 });
}
const closedApps = new WeakSet<ElectronApplication>();
async function closeApp(app: ElectronApplication) {
  if (closedApps.has(app)) return;
  closedApps.add(app);
  if (app.process().exitCode !== null) return;
  const exited = new Promise<void>(resolveExit => app.process().once('exit', () => resolveExit()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.close()));
  const timeout = setTimeout(() => app.process().kill(), 15000);
  try { await exited; } finally { clearTimeout(timeout); }
}
const errors: string[] = [];
const app = await launch(), page = await app.firstWindow();
page.on('pageerror', error => errors.push(error.message));
function panel(key: keyof typeof titles) { return page.locator(`#citations-panel-${ids[key]}`); }
function tab(key: keyof typeof titles) { return page.locator(`#citations-tab-${ids[key]}`); }
function table(key: keyof typeof titles) { return panel(key).getByRole('table', { name: '引用文献条目', exact: true }); }
function countButton(key: keyof typeof titles, count: number) { return page.getByRole('button', { name: `查看《${titles[key]}》的 ${count} 条引用`, exact: true }); }
function citationTitle(n: number) { return `Alpha citing paper ${String(n).padStart(3, '0')}`; }
function addButton(n: number) { return table('alpha').getByRole('button', { name: `加入文献库：${citationTitle(n)}`, exact: true }); }
function importedMark(n: number) { return table('alpha').getByLabel(`已入库：${citationTitle(n)}`, { exact: true }); }
function addDialog() { return page.getByRole('dialog', { name: '是否确定加入文献库？', exact: true }); }
async function openAdd(n: number) {
  await addButton(n).click();
  await addDialog().getByText(citationTitle(n), { exact: true }).waitFor();
}
async function confirmAdd(n: number) {
  await openAdd(n);
  await addDialog().getByRole('button', { name: '确认加入', exact: true }).click();
  await addDialog().waitFor({ state: 'hidden' });
}
async function listReady(key: keyof typeof titles, count: number) {
  await panel(key).waitFor();
  await page.waitForFunction(({ id, count }) => document.querySelectorAll(`#citations-panel-${id} tbody tr`).length === count, { id: ids[key], count });
}
async function libraryPage() { await page.getByRole('button', { name: '文献库', exact: true }).click(); await page.getByRole('textbox', { name: '搜索文献', exact: true }).waitFor(); }
async function closeActive(key: keyof typeof titles) { await tab(key).focus(); await page.keyboard.press('Delete'); await tab(key).waitFor({ state: 'detached' }); }
try {
  await app.evaluate(({ session }) => {
    (globalThis as any).citationRequests = [];
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (/^https?:/.test(details.url)) { (globalThis as any).citationRequests.push(details.url); callback({ cancel: true }); }
      else callback({});
    });
  });
  await page.getByRole('main', { name: '个人首页', exact: true }).waitFor();
  await page.getByRole('button', { name: '打开文献库', exact: true }).click();
  await countButton('alpha', 205).waitFor();
  assert.equal(await page.locator(`tr[data-paper-id="${ids.unknown}"] .table-citations`).innerText(), '—');
  assert.equal(await page.locator(`tr[data-paper-id="${ids.unknown}"] .table-citations button`).count(), 0, 'unknown counts do not pretend there are zero known citations');
  await countButton('alpha', 205).dispatchEvent('dblclick');
  assert.equal(await page.locator(`#pdf-tab-${ids.alpha}`).count(), 0, 'citation count double-click does not open the seed PDF');
  await countButton('alpha', 205).click();
  await listReady('alpha', 50);
  assert.equal(await tab('alpha').getAttribute('aria-label'), `引用详情：${titles.alpha}`);
  assert.equal(await panel('alpha').getAttribute('role'), 'tabpanel');
  await panel('alpha').getByRole('heading', { name: /^引用此论文的文献/ }).waitFor();
  assert((await panel('alpha').innerText()).includes(titles.alpha), 'citation list names its source paper');
  assert((await panel('alpha').innerText()).includes('205'), 'citation list exposes the complete local total');
  assert.equal(await panel('alpha').getByRole('button', { name: '上一页引用', exact: true }).isDisabled(), true);
  await table('alpha').getByRole('row').filter({ hasText: 'Alpha citing paper 002' }).click();
  const detail = panel('alpha').getByRole('complementary', { name: '引用文献详情', exact: true });
  await detail.getByText('Alpha citing paper 002', { exact: true }).waitFor();
  for (const text of ['Alpha Author 002', 'Alpha Journal 002', '10.9999/alpha.002', '2501.00002', 'The abstract of Alpha citation 002 is local cached text.']) {
    assert((await detail.innerText()).includes(text), `selected citation details show ${text}`);
  }
  assert((await detail.innerText()).includes('OpenAlex'), 'citation provenance remains visible');
  assert.equal(await page.locator('.detail-panel .detail-title').count(), 0, 'citation records do not display the seed paper editor');
  await page.screenshot({ path: join(directory, 'citation-list.png'), fullPage: true });
  // Every record remains reachable, including beyond the public API's maximum page size.
  for (let pageIndex = 1; pageIndex < 5; pageIndex++) {
    await panel('alpha').getByRole('button', { name: '下一页引用', exact: true }).click();
    await listReady('alpha', pageIndex === 4 ? 5 : 50);
    await table('alpha').getByText(`Alpha citing paper ${String(pageIndex * 50 + 1).padStart(3, '0')}`, { exact: true }).waitFor();
  }
  await table('alpha').getByText('Alpha citing paper 205', { exact: true }).waitFor();
  await table('alpha').getByRole('row').filter({ hasText: 'Alpha citing paper 205' }).click();
  await detail.getByText('Alpha citing paper 205', { exact: true }).waitFor();
  assert.equal(await panel('alpha').getByRole('button', { name: '下一页引用', exact: true }).isDisabled(), true);
  await page.screenshot({ path: join(directory, 'citation-last-page.png'), fullPage: true });

  await libraryPage(); await countButton('alpha', 205).click();
  assert.equal(await tab('alpha').count(), 1, 'reopening a source reuses its citation tab');
  await listReady('alpha', 5);
  await detail.getByText('Alpha citing paper 205', { exact: true }).waitFor();
  await libraryPage(); await countButton('beta', 2).click(); await listReady('beta', 2);
  assert.equal(await page.getByRole('tab').count(), 2, 'a different paper opens an independent citation tab');
  assert.equal(await table('beta').getByText('Alpha citing paper 001', { exact: true }).count(), 0);
  await table('beta').getByRole('row').filter({ hasText: 'Beta citing paper 002' }).click();
  await panel('beta').getByRole('complementary', { name: '引用文献详情', exact: true }).getByText('Beta citing paper 002', { exact: true }).waitFor();
  await tab('alpha').click(); await listReady('alpha', 5);
  assert.equal(await panel('alpha').getByText('Beta citing paper 002', { exact: true }).count(), 0, 'switching tabs cannot retain another paper citation');
  await detail.getByText('Alpha citing paper 205', { exact: true }).waitFor();
  await table('alpha').locator('tr[aria-selected="true"]').getByText('Alpha citing paper 205', { exact: true }).waitFor();
  assert.equal(await tab('alpha').locator('..').evaluate(element => element.getBoundingClientRect().width), 200, 'citation tabs match fixed-width PDF paper tabs');
  await tab('beta').click();
  await panel('beta').getByRole('complementary', { name: '引用文献详情', exact: true }).getByText('Beta citing paper 002', { exact: true }).waitFor();
  await closeActive('beta');
  assert.equal(await tab('alpha').getAttribute('aria-selected'), 'true', 'closing the active citation tab selects its neighbor');

  // A local snapshot can shrink after refresh. Clamp the saved last-page offset
  // and refetch the available page without editing the stopped fixture's files.
  await app.evaluate(({ ipcMain }, sourceId) => {
    const original = (ipcMain as any)._invokeHandlers.get('library:get-citations');
    (globalThis as any).citationClampHandler = original;
    (globalThis as any).citationClampOffsets = [];
    ipcMain.removeHandler('library:get-citations');
    ipcMain.handle('library:get-citations', async (event, id, offset = 0, limit = 50) => {
      if (id !== sourceId) return original(event, id, offset, limit);
      (globalThis as any).citationClampOffsets.push(offset);
      const result = await original(event, id, 0, limit);
      return { ...result, offset, total: 2, citations: offset === 0 ? result.citations.slice(0, 2) : [] };
    });
  }, ids.alpha);
  try {
    await panel('alpha').getByRole('button', { name: '刷新列表', exact: true }).click();
    await listReady('alpha', 2);
    await table('alpha').getByText('Alpha citing paper 001', { exact: true }).waitFor();
    await panel('alpha').getByText('1–2 / 2', { exact: true }).waitFor();
    assert.deepEqual(await app.evaluate(() => (globalThis as any).citationClampOffsets), [200, 0], 'refresh refetches page zero after clamping an unavailable saved offset');
    assert.equal(await panel('alpha').getByRole('button', { name: '上一页引用', exact: true }).isDisabled(), true);
    assert.equal(await panel('alpha').getByRole('button', { name: '下一页引用', exact: true }).isDisabled(), true);
    assert.equal(await detail.getByText('Alpha citing paper 205', { exact: true }).count(), 0, 'refresh cannot leave a stale selected citation');
  } finally {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('library:get-citations');
      ipcMain.handle('library:get-citations', (globalThis as any).citationClampHandler);
      delete (globalThis as any).citationClampHandler;
    });
  }
  await panel('alpha').getByRole('button', { name: '刷新列表', exact: true }).click(); await listReady('alpha', 50);
  await libraryPage(); await countButton('zero', 0).click();
  await panel('zero').getByText('暂无引用记录', { exact: true }).waitFor();
  await panel('zero').getByText('当前已同步结果中暂无引用此论文的文献。', { exact: true }).waitFor();
  assert.equal(await panel('zero').locator('tbody tr').count(), 0);
  await closeActive('zero');

  // Read failures are recoverable; fail just this test's IPC without changing any data file.
  await app.evaluate(({ ipcMain }) => {
    (globalThis as any).citationReadHandler = (ipcMain as any)._invokeHandlers.get('library:get-citations');
    if (!(globalThis as any).citationReadHandler) throw new Error('Missing citation IPC');
    ipcMain.removeHandler('library:get-citations');
    ipcMain.handle('library:get-citations', () => { throw new Error('Isolated citation read failure'); });
  });
  try {
    await libraryPage(); await countButton('beta', 2).click();
    await panel('beta').getByText('无法读取引用记录', { exact: true }).waitFor();
  } finally {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('library:get-citations');
      ipcMain.handle('library:get-citations', (globalThis as any).citationReadHandler);
      delete (globalThis as any).citationReadHandler;
    });
  }
  await panel('beta').getByRole('button', { name: '重试', exact: true }).click(); await listReady('beta', 2);
  await closeActive('beta');

  // The same count action is wired in home category lists, and PDF save still precedes navigation.
  await page.getByRole('button', { name: '个人首页', exact: true }).click();
  await page.getByRole('button', { name: 'PDF 原文', exact: true }).click();
  await page.getByRole('main', { name: 'PDF 原文列表', exact: true }).waitFor();
  await countButton('alpha', 205).click();
  assert.equal(await tab('alpha').count(), 1, 'home collection and library reuse the same paper citation tab');
  await page.locator('#collection-tab-pdf').click();
  await page.getByRole('button', { name: '打开 PDF：alpha.pdf', exact: true }).click();
  await page.getByText('标注自动保存到文献库', { exact: true }).waitFor({ timeout: 30000 });
  const viewer = page.locator('embedpdf-container');
  await viewer.getByRole('button', { name: '放大', exact: true }).click();
  const zoom = await viewer.evaluate(async (element: any) => (await element.registry).getPlugin('zoom').provides().getState().currentZoomLevel);
  await tab('alpha').click(); await panel('alpha').waitFor();
  const saved = JSON.parse(await readFile(join(library.paperDirectory(ids.alpha), 'annotations.json'), 'utf8'));
  assert.equal(saved.position.zoom, zoom, 'switching from PDF to citations first saves the reader state');
  assert.equal(await page.locator('embedpdf-container').count(), 0, 'only the active PDF mounts an engine');
  assert.equal(await page.locator(`#pdf-tab-${ids.alpha}`).count(), 1, 'PDF and citation tabs coexist');
  await closeActive('alpha');
  assert.equal(await page.locator('#collection-tab-pdf').getAttribute('aria-selected'), 'true', 'closing a citation tab selects the next collection tab');
  await page.getByRole('button', { name: '关闭列表：PDF 原文', exact: true }).click();
  await page.getByText('标注自动保存到文献库', { exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: `关闭 PDF：${titles.alpha}`, exact: true }).click();
  await page.getByRole('textbox', { name: '搜索文献', exact: true }).waitFor();
  assert.equal(await page.getByRole('tab').count(), 0, 'closing all workspace tabs returns to the library');
  assert.deepEqual(await app.evaluate(() => (globalThis as any).citationRequests), [], 'reading cached citations never accesses HTTP');
  assert.equal(await readFile(library.file, 'utf8'), indexBefore, 'viewing citations never adds or changes main-library papers');
  assert.deepEqual(await Promise.all(snapshotPaths.map(path => readFile(path, 'utf8'))), snapshotsBefore, 'viewing citations preserves original local snapshots');

  // Add only explicitly chosen cached citations. Existing entries are matched by
  // each supported identifier, without changing the original index metadata.
  await countButton('alpha', 205).click(); await listReady('alpha', 50);
  await table('alpha').getByRole('columnheader', { name: '文献库', exact: true }).waitFor();
  for (const n of [3, 4, 5]) {
    await importedMark(n).waitFor();
    assert.equal(await addButton(n).count(), 0, `${citationTitle(n)} is already catalogued and cannot be imported again`);
  }
  await table('alpha').getByRole('row').filter({ hasText: citationTitle(2) }).click();
  const importDetail = panel('alpha').getByRole('complementary', { name: '引用文献详情', exact: true });
  // Opening or dismissing the modal never reaches the mutation IPC. Its safe
  // default also prevents an accidental Enter from confirming the addition.
  await app.evaluate(({ ipcMain }) => {
    const original = (ipcMain as any)._invokeHandlers.get('library:add-citation');
    if (!original) throw new Error('Missing citation import IPC');
    (globalThis as any).citationConfirmHandler = original;
    (globalThis as any).citationConfirmCalls = 0;
    ipcMain.removeHandler('library:add-citation');
    ipcMain.handle('library:add-citation', (event, seedId, citationId) => {
      (globalThis as any).citationConfirmCalls++;
      return original(event, seedId, citationId);
    });
  });
  try {
    await openAdd(1);
    await addDialog().getByText('仅加入书目信息，PDF 原文可稍后添加。', { exact: true }).waitFor();
    assert.equal(await app.evaluate(() => (globalThis as any).citationConfirmCalls), 0, 'opening confirmation does not request an import');
    assert.equal(await addDialog().getByRole('button', { name: '取消', exact: true }).evaluate(button => button === document.activeElement), true, 'cancel has the safe initial keyboard focus');
    await page.screenshot({ path: join(directory, 'citation-add-confirmation.png'), fullPage: true });
    await addDialog().getByRole('button', { name: '取消', exact: true }).click();
    await addDialog().waitFor({ state: 'hidden' });
    await openAdd(1); await page.keyboard.press('Escape'); await addDialog().waitFor({ state: 'hidden' });
    await openAdd(1); await page.keyboard.press('Enter'); await addDialog().waitFor({ state: 'hidden' });
    await openAdd(1);
    await addDialog().getByRole('button', { name: '关闭加入确认', exact: true }).click();
    await addDialog().waitFor({ state: 'hidden' });
    await openAdd(1); await page.mouse.click(5, 5); await addDialog().waitFor({ state: 'hidden' });
    assert.equal(await app.evaluate(() => (globalThis as any).citationConfirmCalls), 0, 'cancel, Escape, default Enter, close, and backdrop dismiss without an import');
    assert.equal(await readFile(library.file, 'utf8'), indexBefore, 'dismissed confirmations leave the library index unchanged');
    assert.equal(await importedMark(1).count(), 0, 'dismissed confirmation does not claim the paper is already added');
    await confirmAdd(1); await importedMark(1).waitFor();
    assert.equal(await app.evaluate(() => (globalThis as any).citationConfirmCalls), 1, 'only explicit confirmation issues an import');
  } finally {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('library:add-citation');
      ipcMain.handle('library:add-citation', (globalThis as any).citationConfirmHandler);
      delete (globalThis as any).citationConfirmHandler;
    });
  }
  await importDetail.getByText(citationTitle(2), { exact: true }).waitFor();
  assert.equal(await table('alpha').locator('tr[aria-selected="true"]').getAttribute('data-citation-id'), '2'.padStart(64, '0'), 'adding a different row preserves selection');
  await panel('alpha').getByText('1–50 / 205', { exact: true }).waitFor();

  // The application keeps the action available after a failed save. Retry the
  // very same citation after restoring this isolated IPC implementation.
  await app.evaluate(({ ipcMain }) => {
    const original = (ipcMain as any)._invokeHandlers.get('library:add-citation');
    if (!original) throw new Error('Missing citation import IPC');
    (globalThis as any).citationAddHandler = original;
    ipcMain.removeHandler('library:add-citation');
    ipcMain.handle('library:add-citation', (_event, _seedId, _citationId) => { throw new Error('Isolated citation import failure'); });
  });
  try {
    await confirmAdd(6);
    await panel('alpha').getByText(/Isolated citation import failure/).waitFor();
    assert.equal(await addButton(6).isEnabled(), true, 'a failed import remains retryable');
    assert.equal(await importedMark(6).count(), 0, 'failure never claims that a citation was added');
    await importDetail.getByText(citationTitle(2), { exact: true }).waitFor();
  } finally {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('library:add-citation');
      ipcMain.handle('library:add-citation', (globalThis as any).citationAddHandler);
      delete (globalThis as any).citationAddHandler;
    });
  }
  await addButton(6).focus(); await page.keyboard.press('Enter');
  await addDialog().getByText(citationTitle(6), { exact: true }).waitFor();
  await addDialog().getByRole('button', { name: '确认加入', exact: true }).click();
  await importedMark(6).waitFor();
  await importDetail.getByText(citationTitle(2), { exact: true }).waitFor();

  // Hold the request until both click events have been delivered. The row must
  // issue a single import, and keyboard row handling must not steal the action.
  await app.evaluate(({ ipcMain }) => {
    const original = (ipcMain as any)._invokeHandlers.get('library:add-citation');
    (globalThis as any).citationAddHandler = original;
    (globalThis as any).citationAddCalls = 0;
    (globalThis as any).citationAddGate = new Promise<void>(release => { (globalThis as any).releaseCitationAdd = release; });
    ipcMain.removeHandler('library:add-citation');
    ipcMain.handle('library:add-citation', async (event, seedId, citationId) => {
      (globalThis as any).citationAddCalls++;
      await (globalThis as any).citationAddGate;
      return original(event, seedId, citationId);
    });
  });
  try {
    await openAdd(7);
    await addDialog().getByRole('button', { name: '确认加入', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await page.waitForFunction(() => !!document.querySelector('.citations-table button:disabled'));
    assert.equal(await app.evaluate(() => (globalThis as any).citationAddCalls), 1, 'rapid repeated clicks submit only one import');
    await app.evaluate(() => (globalThis as any).releaseCitationAdd());
    await importedMark(7).waitFor();
  } finally {
    await app.evaluate(({ ipcMain }) => {
      (globalThis as any).releaseCitationAdd();
      ipcMain.removeHandler('library:add-citation');
      ipcMain.handle('library:add-citation', (globalThis as any).citationAddHandler);
      delete (globalThis as any).citationAddHandler;
      delete (globalThis as any).citationAddGate;
      delete (globalThis as any).releaseCitationAdd;
    });
  }
  for (let pageIndex = 1; pageIndex < 5; pageIndex++) {
    await panel('alpha').getByRole('button', { name: '下一页引用', exact: true }).click();
    await listReady('alpha', pageIndex === 4 ? 5 : 50);
  }
  await table('alpha').getByRole('row').filter({ hasText: citationTitle(205) }).click();
  await confirmAdd(201); await importedMark(201).waitFor();
  await panel('alpha').getByText('201–205 / 205', { exact: true }).waitFor();
  await importDetail.getByText(citationTitle(205), { exact: true }).waitFor();
  await page.screenshot({ path: join(directory, 'citation-import.png'), fullPage: true });
  await libraryPage(); await countButton('beta', 2).click(); await listReady('beta', 2);
  await table('beta').getByLabel('已入库：Beta citing paper 001', { exact: true }).waitFor();
  assert.equal(await table('beta').getByRole('button', { name: '加入文献库：Beta citing paper 001', exact: true }).count(), 0, 'the same paper under a different seed cannot be added twice');
  await tab('alpha').click(); await listReady('alpha', 5); await importedMark(201).waitFor();
  await importDetail.getByText(citationTitle(205), { exact: true }).waitFor();
  assert.deepEqual(await app.evaluate(() => (globalThis as any).citationRequests), [], 'citation imports remain offline and never retrieve metadata or PDFs');
  assert.deepEqual(errors, []);
  await closeApp(app);
  const importedIndex = JSON.parse(await readFile(library.file, 'utf8'));
  const oldIndex = JSON.parse(indexBefore);
  assert.equal(importedIndex.papers.length, oldIndex.papers.length + 4, 'only four explicit, distinct citations become new papers');
  for (const paper of oldIndex.papers) assert.deepEqual(importedIndex.papers.find((item: any) => item.id === paper.id), paper, 'imports preserve every original paper');
  for (const n of [1, 6, 7, 201]) {
    const imported = importedIndex.papers.filter((paper: any) => paper.title === citationTitle(n));
    assert.equal(imported.length, 1, `exactly one persisted entry for ${citationTitle(n)}`);
    const paper = imported[0];
    assert.deepEqual(paper.authors, [`Alpha Author ${String(n).padStart(3, '0')}`, 'Coauthor']);
    assert.equal(paper.publicationDate, '2025-01-02');
    assert.equal(paper.venue, `Alpha Journal ${String(n).padStart(3, '0')}`);
    assert.equal(paper.doi, `10.9999/alpha.${String(n).padStart(3, '0')}`);
    assert.equal(paper.arxivId, `2501.${String(n).padStart(5, '0')}`);
    assert.equal(paper.abstract, `The abstract of Alpha citation ${String(n).padStart(3, '0')} is local cached text.`);
    assert.equal(paper.pdfHash, null, 'citation import creates metadata without fabricating an attachment');
    assert.notEqual(paper.citationMonitoring, true, 'adding a citation does not silently subscribe it');
  }
  assert.deepEqual(await Promise.all(snapshotPaths.map(path => readFile(path, 'utf8'))), snapshotsBefore, 'citation imports preserve original local snapshots');

  // Membership is derived again from the saved library on the next launch.
  const restarted = await launch();
  const restartedErrors: string[] = [];
  try {
    const restartedPage = await restarted.firstWindow();
    restartedPage.on('pageerror', error => restartedErrors.push(error.message));
    await restartedPage.getByRole('button', { name: '打开文献库', exact: true }).click();
    await restartedPage.getByRole('button', { name: `查看《${titles.alpha}》的 205 条引用`, exact: true }).click();
    const restartedPanel = restartedPage.locator(`#citations-panel-${ids.alpha}`);
    for (const n of [1, 3, 4, 5, 6, 7]) await restartedPanel.getByLabel(`已入库：${citationTitle(n)}`, { exact: true }).waitFor();
    assert.equal(await restartedPanel.getByRole('button', { name: `加入文献库：${citationTitle(1)}`, exact: true }).count(), 0, 'restart cannot offer a duplicate import');
    await restartedPage.getByRole('button', { name: '文献库', exact: true }).click();
    await restartedPage.getByRole('button', { name: `查看《${titles.beta}》的 2 条引用`, exact: true }).click();
    await restartedPage.locator(`#citations-panel-${ids.beta}`).getByLabel('已入库：Beta citing paper 001', { exact: true }).waitFor();
    assert.deepEqual(restartedErrors, []);
  } finally { await closeApp(restarted); }
  assert.equal((JSON.parse(await readFile(library.file, 'utf8'))).papers.length, importedIndex.papers.length, 'reopening citation lists does not add more papers');
  console.log(JSON.stringify({ packaged, directory, result: 'passed', checks: 'known/unknown count actions, 205 cached citations across pages, selected details, independent/reused tabs and page state, refresh clamp and retry, confirmed-zero wording, shared home action, PDF save and close, DOI/arXiv/title membership, import modal title and safe cancel focus, no IPC or index mutation on cancel/Escape/default Enter/close/backdrop, explicit offline import with complete metadata, selection/page preservation, failed save retry, rapid confirmation guard, cross-seed and restart deduplication, no HTTP or snapshot writes' }));
} catch (error) {
  if (!page.isClosed()) { await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }); console.log(await page.locator('body').innerText()); }
  throw error;
} finally { await closeApp(app); }
