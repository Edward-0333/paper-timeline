import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { Library } from '../electron/library';
import { localMetadata } from '../electron/metadata';
import type { Paper } from '../shared/types';
import { citationSeed, writeCitationSnapshot } from '../electron/citation-monitor';

await mkdir('.test-data', { recursive: true });
const directory = await mkdtemp(resolve('.test-data/home-collections-'));
const packaged = process.argv.includes('--packaged');
const names = { pdf: 'PDF 原文', md: 'Markdown 笔记', monitoring: '本库监控已开启' } as const;
type Category = keyof typeof names;
const titles = {
  alpha: 'Alpha research with PDF and Markdown', beta: 'Beta PDF-only research',
  gamma: 'Gamma Markdown-only research', delta: 'Delta metadata-only research',
  stale: 'Stale missing attachments research', legacy: 'Legacy monitoring without subscription',
  inactive: 'Inactive subscribed research',
};
const library = new Library(join(directory, 'library'), async () => { throw new Error('No fixture should retrieve PDF metadata'); },
  async pdf => ({ metadata: localMetadata(pdf), matched: true, message: 'isolated fixture' }));
await library.initialize();
const folder = await library.createFolder('Library scope fixture');
const ids: Record<string, string> = {};
for (const [key, title] of Object.entries(titles)) {
  ids[key] = (await library.createPaper({ title, authors: ['Fixture Author'], publicationDate: '2025' }, key === 'beta' ? folder.id : null, false)).id;
}
// Valid, independent tiny PDFs keep the test fully offline, including the actual reader.
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
for (const key of ['alpha', 'beta', 'stale']) {
  const path = join(directory, `${key}.pdf`); await writeFile(path, tinyPdf(titles[key as keyof typeof titles]));
  await library.attachPdf(ids[key], path);
}
for (const key of ['alpha', 'gamma', 'stale']) {
  const path = join(directory, `${key}.md`); await writeFile(path, '# Isolated Markdown fixture\n' + key);
  await library.attachMarkdown(ids[key], path);
}
// Missing files must not be counted just because their historical metadata survives.
await unlink(library.pdfPath(ids.stale)); await unlink(await library.markdownPath(ids.stale));
// Only edit this disposable, stopped fixture. Real application changes below use IPC.
const stored = JSON.parse(await readFile(library.file, 'utf8'));
const fixtureAccount = { server: 'https://home-collections.invalid', user: { id: 'isolated-fixture-account', username: 'fixture' } };
for (const paper of stored.papers as Paper[]) {
  if ([ids.alpha, ids.gamma, ids.legacy].includes(paper.id)) paper.citationMonitoring = true;
  if ([ids.alpha, ids.gamma, ids.inactive].includes(paper.id)) paper.citationSubscription = { account: fixtureAccount.server + '|' + fixtureAccount.user.id, revision: 1 };
  if (paper.id === ids.inactive) paper.citationMonitoring = false;
  if (paper.id === ids.alpha) paper.status = 'matched';
}
await writeFile(library.file, JSON.stringify(stored, null, 2));
// Citation snapshots are local, offline fixtures, including a confirmed zero
// and cached counts for a monitor that has since been disabled.
const citationAt = '2026-10-23T08:00:00.000Z';
for (const [key, count] of [['alpha', 12], ['beta', 0], ['inactive', 3]] as const) {
  const paper = library.get(ids[key]);
  await writeCitationSnapshot(library.directory, { version: 1, seed: citationSeed(paper),
    lastAttemptAt: citationAt, lastSuccessAt: citationAt, nextCheckAt: '',
    providers: [{ provider: 'openalex', status: 'success', count, seedIds: [], message: '' }],
    citations: Array.from({ length: count }, (_, index) => ({
      id: (index + 1).toString(16).padStart(64, '0'), title: `Citing fixture ${index + 1}`, authors: [], year: 2025,
      publicationDate: '2025', venue: '', doi: '', arxivId: '', abstract: '', url: '',
      sources: [{ provider: 'openalex', id: `W${index + 1}` }], firstSeenAt: citationAt, lastSeenAt: citationAt,
    })),
  }, paper.storageFolder);
}
// A stopped, disposable account binding enables an offline monitor-off intent without a login token.
// The application may queue the intent, but cannot contact any server while this fixture is signed out.
await mkdir(join(library.directory, 'sync'), { recursive: true });
await writeFile(join(library.directory, 'sync', 'cloud.json'), JSON.stringify({ version: 1,
  libraryId: '44444444-4444-4444-8444-444444444444', account: fixtureAccount,
  acknowledgements: {}, cursors: {}, newCitations: 0 }));

function launch(root = directory) {
  const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, PAPER_TIMELINE_DATA: root, PAPER_TIMELINE_AI: '0' })
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({ executablePath: resolve(packaged ? 'release/win-unpacked/Paper Timeline.exe' : 'node_modules/electron/dist/electron.exe'),
    ...(packaged ? {} : { args: [resolve('.')] }), env, timeout: 30000 });
}
async function closeApp(app: ElectronApplication) {
  if (app.process().exitCode !== null) return;
  const exited = new Promise<void>(resolveExit => app.process().once('exit', () => resolveExit()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.close()));
  const timeout = setTimeout(() => app.process().kill(), 15000);
  try { await exited; } finally { clearTimeout(timeout); }
}
async function rows(page: Page, label: string, expected: string[]) {
  await page.getByRole('main', { name: label, exact: true }).waitFor();
  await page.waitForFunction(({ label, expected }) => {
    const main = [...document.querySelectorAll('main')].find(element => element.getAttribute('aria-label') === label);
    const actual = [...(main?.querySelectorAll('tbody tr[data-paper-id]') || [])].map(row => row.getAttribute('data-paper-id')).sort();
    return !!main && JSON.stringify(actual) === JSON.stringify([...expected].sort());
  }, { label, expected });
}
async function home(page: Page) { await page.getByRole('button', { name: '个人首页', exact: true }).click(); await page.getByRole('main', { name: '个人首页', exact: true }).waitFor(); }
async function metric(page: Page, category: Category) { await home(page); await page.getByRole('button', { name: names[category], exact: true }).click(); }
async function count(page: Page, name: string, expected: number) {
  await page.waitForFunction(({ name, expected }) => [...document.querySelectorAll('.home-metrics button')]
    .some(button => button.getAttribute('aria-label') === name && button.querySelector('strong')?.textContent === String(expected)), { name, expected });
}
async function tabNames(page: Page) { return page.getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label'))); }
async function detail(page: Page, title: string) {
  await page.waitForFunction(title => document.querySelector('.detail-panel .detail-title')?.textContent === title, title);
  await page.getByRole('complementary', { name: '文献详情', exact: true }).waitFor();
}
async function selectPaper(page: Page, id: string, title: string) {
  await page.locator(`.paper-table tr[data-paper-id="${id}"]`).click();
  await detail(page, title);
}
async function noDetail(page: Page) {
  await page.waitForFunction(() => document.querySelectorAll('.detail-panel .detail-title').length === 0);
}
const errors: string[] = [];
let app = await launch(), page = await app.firstWindow();
page.on('pageerror', error => errors.push(error.message));
try {
  // Every HTTP request would be a test failure; no account, model or metadata service is used.
  await app.evaluate(({ session, shell }) => {
    (globalThis as any).homeCollectionRequests = [];
    (globalThis as any).homeCollectionOpened = [];
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (/^https?:/.test(details.url)) { (globalThis as any).homeCollectionRequests.push(details.url); callback({ cancel: true }); }
      else callback({});
    });
    shell.openPath = async path => { (globalThis as any).homeCollectionOpened.push(path); return ''; };
  });
  await page.getByRole('main', { name: '个人首页', exact: true }).waitFor();
  for (const [label, expected] of [['本地论文', 7], ['PDF 原文', 2], ['Markdown 笔记', 2], ['本库监控已开启', 2]] as const) await count(page, label, expected);
  await page.screenshot({ path: join(directory, 'home-metrics.png'), fullPage: true });
  await page.getByRole('button', { name: '打开文献库', exact: true }).click();
  await page.locator('.folder-sidebar .custom-folders .folder-item').filter({ hasText: folder.name }).click();
  await page.getByRole('textbox', { name: '搜索文献', exact: true }).fill('Beta');
  await page.getByRole('combobox', { name: '文献筛选', exact: true }).selectOption('review');
  assert.equal(await page.locator('.paper-table tbody tr').count(), 1);

  await metric(page, 'pdf'); await rows(page, 'PDF 原文列表', [ids.alpha, ids.beta]);
  await page.getByRole('columnheader', { name: /被引数/ }).waitFor();
  assert.equal(await page.locator(`tr[data-paper-id="${ids.alpha}"] .table-citations`).innerText(), '12');
  assert.equal(await page.locator(`tr[data-paper-id="${ids.beta}"] .table-citations`).innerText(), '0');
  assert.equal(await page.locator('.folder-sidebar, .view-switch').count(), 0, 'collection pages keep their list and details without folder or timeline controls');
  await selectPaper(page, ids.beta, titles.beta);
  const details = page.getByRole('complementary', { name: '文献详情', exact: true });
  await details.getByRole('region', { name: '论文标签', exact: true }).waitFor();
  await details.getByRole('region', { name: '引用监控', exact: true }).waitFor();
  await details.getByRole('button', { name: '评为 4 星', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.detail-rating button[aria-label="评为 4 星"]')?.getAttribute('aria-pressed') === 'true');
  await page.locator(`.paper-table tr[data-paper-id="${ids.beta}"]`).getByRole('img', { name: '4 星', exact: true }).waitFor();
  const savedRating = JSON.parse(await readFile(library.file, 'utf8')).papers.find((paper: Paper) => paper.id === ids.beta)?.rating;
  assert.equal(savedRating, 4, 'ratings changed in collection details are persisted through the real library');
  await details.getByRole('button', { name: '添加标签', exact: true }).click();
  const tagDialog = page.getByRole('dialog', { name: '添加标签', exact: true });
  await tagDialog.getByRole('textbox', { name: '标签文字', exact: true }).fill('Collection detail fixture');
  await tagDialog.getByRole('button', { name: '蓝色背景', exact: true }).click();
  await tagDialog.getByRole('button', { name: '保存标签', exact: true }).click();
  await details.getByRole('button', { name: '编辑标签：Collection detail fixture', exact: true }).waitFor();
  await page.locator(`.paper-table tr[data-paper-id="${ids.beta}"]`).getByText('Collection detail fixture', { exact: true }).waitFor();
  const pdfMain = page.getByRole('main', { name: 'PDF 原文列表', exact: true });
  await pdfMain.getByRole('table', { name: '文献条目' }).waitFor();
  await page.getByRole('textbox', { name: '搜索此列表', exact: true }).fill('Alpha'); await rows(page, 'PDF 原文列表', [ids.alpha]);
  await detail(page, titles.alpha);
  await metric(page, 'md'); await rows(page, 'Markdown 笔记列表', [ids.alpha, ids.gamma]);
  await selectPaper(page, ids.gamma, titles.gamma);
  await page.getByRole('textbox', { name: '搜索此列表', exact: true }).fill('Gamma'); await rows(page, 'Markdown 笔记列表', [ids.gamma]);
  await detail(page, titles.gamma);
  await page.getByRole('button', { name: '打开 Markdown 笔记：gamma.md', exact: true }).click();
  await page.locator('#markdown-note-panel').waitFor();
  assert.equal(await page.locator(`#md-tab-${ids.gamma}`).getAttribute('aria-selected'), 'true', 'collection MD icons open an internal note tab');
  assert.deepEqual(await app.evaluate(() => (globalThis as any).homeCollectionOpened), [], 'in-app note reading does not launch the default editor');
  await page.locator(`#md-tab-${ids.gamma}`).locator('..').getByRole('button', { name: /关闭/ }).click();
  await rows(page, 'Markdown 笔记列表', [ids.gamma]);
  await detail(page, titles.gamma);
  await details.getByRole('button', { name: '更多操作', exact: true }).click();
  await details.getByRole('button', { name: '打开资料文件夹', exact: true }).click();
  assert.deepEqual(await app.evaluate(() => (globalThis as any).homeCollectionOpened),
    [library.paperDirectory(ids.gamma)], 'details open the selected paper folder, including papers without a PDF');
  assert.equal(await details.getByRole('button', { name: '更多操作', exact: true }).getAttribute('aria-expanded'), 'false');
  await metric(page, 'monitoring'); await rows(page, '本库监控已开启列表', [ids.alpha, ids.gamma]);
  await selectPaper(page, ids.alpha, titles.alpha);
  assert.deepEqual(await tabNames(page), [names.pdf, names.md, names.monitoring]);
  await page.getByRole('tablist', { name: '工作区标签', exact: true }).waitFor();
  await metric(page, 'pdf'); await rows(page, 'PDF 原文列表', [ids.alpha]);
  assert.equal(await page.getByRole('tab').count(), 3, 'reopening a category reuses its tab');
  assert.equal(await page.getByRole('textbox', { name: '搜索此列表', exact: true }).inputValue(), 'Alpha');
  await detail(page, titles.alpha);
  await page.locator('#collection-tab-md').click(); await rows(page, 'Markdown 笔记列表', [ids.gamma]);
  await detail(page, titles.gamma);
  assert.equal(await page.getByRole('textbox', { name: '搜索此列表', exact: true }).inputValue(), 'Gamma');
  await page.locator('#collection-tab-monitoring').click(); await rows(page, '本库监控已开启列表', [ids.alpha, ids.gamma]);
  await detail(page, titles.alpha);
  assert.equal(await page.getByRole('textbox', { name: '搜索此列表', exact: true }).inputValue(), '', 'queries belong to their own category');

  await page.getByRole('button', { name: '文献库', exact: true }).click();
  await detail(page, titles.beta);
  await details.getByRole('button', { name: '清除评分', exact: true }).waitFor();
  assert.equal(await details.getByRole('button', { name: '评为 4 星', exact: true }).getAttribute('aria-pressed'), 'true', 'collection changes appear in the original library details');
  await details.getByRole('button', { name: '编辑标签：Collection detail fixture', exact: true }).waitFor();
  await details.getByRole('button', { name: '删除标签：Collection detail fixture', exact: true }).click();
  const deleteDialog = page.getByRole('dialog', { name: '是否确定删除标签？', exact: true });
  await deleteDialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await deleteDialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('[aria-label="编辑标签：Collection detail fixture"]'));
  assert.equal(await page.getByRole('textbox', { name: '搜索文献', exact: true }).inputValue(), 'Beta');
  assert.equal(await page.getByRole('combobox', { name: '文献筛选', exact: true }).inputValue(), 'review');
  assert.equal(await page.locator('.folder-sidebar .custom-folders .folder-item[aria-current="page"]').innerText(), `${folder.name}\n1`);
  await home(page); await page.getByRole('button', { name: '本地论文', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '搜索文献', exact: true }).inputValue(), '');
  assert.equal(await page.getByRole('combobox', { name: '文献筛选', exact: true }).inputValue(), 'all');
  assert.equal(await page.locator('.folder-sidebar .folder-item[aria-current="page"] span').innerText(), '全部文献');
  assert.equal(await page.locator('.paper-table tbody tr').count(), 7);
  assert.ok((await page.locator('th[data-column="title"]').boundingBox())!.width >= 100, 'a new column does not collapse the title column in a fresh profile');
  for (const [key, count] of [['alpha', '12'], ['beta', '0'], ['inactive', '3'], ['gamma', '—'], ['delta', '—'], ['legacy', '—']] as const) {
    assert.equal(await page.locator(`tr[data-paper-id="${ids[key]}"] .table-citations`).innerText(), count,
      'show known counts (including disabled history and zero) but no zero for uninitialized monitors');
  }
  await page.getByRole('button', { name: '被引数', exact: true }).click();
  assert.deepEqual(await page.locator('tbody .table-citations').allInnerTexts(), ['0', '3', '12', '—', '—', '—', '—']);
  await page.getByRole('button', { name: '被引数', exact: true }).click();
  assert.deepEqual(await page.locator('tbody .table-citations').allInnerTexts(), ['12', '3', '0', '—', '—', '—', '—']);
  const citationHeader = page.locator('th[data-column="citations"]');
  const oldWidth = Math.round((await citationHeader.boundingBox())!.width);
  await page.getByRole('separator', { name: '调整被引数列宽', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  assert.equal(Math.round((await citationHeader.boundingBox())!.width), oldWidth + 10);
  await page.screenshot({ path: join(directory, 'citation-count-column.png'), fullPage: true });
  console.log('PASS: citation column, confirmed zero vs unknown, disabled cached counts, numeric sorting and column resizing.');
  assert.equal(await page.getByRole('tab').count(), 3, 'local-paper metric opens the original library');

  await page.locator('#collection-tab-pdf').click();
  await page.getByRole('textbox', { name: '搜索此列表', exact: true }).fill(''); await rows(page, 'PDF 原文列表', [ids.alpha, ids.beta]);
  await page.getByRole('button', { name: '打开 PDF：alpha.pdf', exact: true }).click();
  await page.getByRole('main', { name: 'PDF 阅读器', exact: true }).waitFor();
  await page.getByText('标注自动保存到文献库', { exact: true }).waitFor({ timeout: 30000 });
  assert.deepEqual(await tabNames(page), [names.pdf, names.md, names.monitoring, titles.alpha], 'PDF and collection tabs share their opening order');
  const viewer = page.locator('embedpdf-container');
  await viewer.getByRole('button', { name: '放大', exact: true }).click();
  const zoom = await viewer.evaluate(async (element: any) => (await element.registry).getPlugin('zoom').provides().getState().currentZoomLevel);
  await metric(page, 'pdf'); await rows(page, 'PDF 原文列表', [ids.alpha, ids.beta]);
  const readingState = JSON.parse(await readFile(join(library.paperDirectory(ids.alpha), 'annotations.json'), 'utf8'));
  assert.equal(readingState.position.zoom, zoom, 'switching from reader to a metric list first flushes its state');
  assert.equal(await page.locator('embedpdf-container').count(), 0, 'hidden readers do not keep an engine mounted');
  await page.getByRole('tab', { name: titles.alpha, exact: true }).click();
  await page.getByText('标注自动保存到文献库', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await viewer.evaluate(async (element: any) => (await element.registry).getPlugin('zoom').provides().getState().currentZoomLevel), zoom);
  await page.locator('#collection-tab-pdf').click(); await rows(page, 'PDF 原文列表', [ids.alpha, ids.beta]);
  assert.equal(await page.getByRole('tab').count(), 4);

  // A real library event, caused by an actual attachment, must update existing tabs and counts.
  const deltaPdf = join(directory, 'delta.pdf'); await writeFile(deltaPdf, tinyPdf(titles.delta));
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, deltaPdf);
  assert.equal(await page.evaluate(id => window.paperApi!.choosePaperPdf(id), ids.delta), true);
  await rows(page, 'PDF 原文列表', [ids.alpha, ids.beta, ids.delta]);
  const deltaMd = join(directory, 'delta.md'); await writeFile(deltaMd, '# Newly attached note\n');
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, deltaMd);
  await page.evaluate(id => window.paperApi!.chooseMarkdown(id), ids.delta);
  await home(page); await count(page, names.pdf, 3); await count(page, names.md, 3);
  await page.locator('#collection-tab-md').click();
  await page.getByRole('textbox', { name: '搜索此列表', exact: true }).fill(''); await rows(page, 'Markdown 笔记列表', [ids.alpha, ids.gamma, ids.delta]);
  await page.locator('#collection-tab-pdf').click(); await rows(page, 'PDF 原文列表', [ids.alpha, ids.beta, ids.delta]);
  await page.getByRole('textbox', { name: '搜索此列表', exact: true }).fill('No matching fixture'); await rows(page, 'PDF 原文列表', []);
  await pdfMain.locator('.paper-list .empty-state').waitFor();
  await noDetail(page);
  await page.getByRole('textbox', { name: '搜索此列表', exact: true }).fill(''); await rows(page, 'PDF 原文列表', [ids.alpha, ids.beta, ids.delta]);

  // Removing the selected monitored paper must update membership, the details pane and home counts.
  await page.locator('#collection-tab-monitoring').click();
  await page.getByRole('textbox', { name: '搜索此列表', exact: true }).fill('Gamma');
  await rows(page, '本库监控已开启列表', [ids.gamma]); await selectPaper(page, ids.gamma, titles.gamma);
  await details.getByRole('switch', { name: '引用监控开关', exact: true }).click();
  await rows(page, '本库监控已开启列表', []); await noDetail(page);
  await page.getByRole('textbox', { name: '搜索此列表', exact: true }).fill('');
  await rows(page, '本库监控已开启列表', [ids.alpha]); await detail(page, titles.alpha);
  await home(page); await count(page, names.monitoring, 1);
  await page.locator('#collection-tab-pdf').click(); await rows(page, 'PDF 原文列表', [ids.alpha, ids.beta, ids.delta]);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 800));
  const tabDimensions = await page.getByRole('tab').evaluateAll(tabs => tabs.map(tab => {
    const label = tab.querySelector('.reader-tab-title')!;
    const text = document.createRange(); text.selectNodeContents(label);
    return { id: tab.id, width: tab.parentElement!.getBoundingClientRect().width,
      textWidth: text.getBoundingClientRect().width, labelWidth: label.getBoundingClientRect().width };
  }));
  assert.equal(tabDimensions.find(tab => tab.id === `pdf-tab-${ids.alpha}`)?.width, 200, 'PDF paper tabs retain their fixed reading-tab width');
  for (const category of ['pdf', 'md', 'monitoring'] as const) {
    const tab = tabDimensions.find(tab => tab.id === `collection-tab-${category}`)!;
    assert(tab.width < 200 && tab.width - tab.textWidth >= 32 && tab.width - tab.textWidth <= 60,
      `${names[category]} fits its text with only padding and close-button space`);
    assert(tab.labelWidth >= tab.textWidth - 0.5, 'compact collection titles are not truncated');
  }
  assert(tabDimensions.find(tab => tab.id === 'collection-tab-md')!.width > tabDimensions.find(tab => tab.id === 'collection-tab-pdf')!.width + 30,
    'collection tab widths follow their different title lengths');
  const navBounds = await page.getByRole('button', { name: '文献库', exact: true }).boundingBox();
  const tabsBounds = await page.getByRole('tablist', { name: '工作区标签', exact: true }).boundingBox();
  const collectionTabBounds = await page.locator('#collection-tab-pdf').locator('..').boundingBox();
  console.log(JSON.stringify({ navigationBounds: navBounds, collectionTabBounds }));
  assert(navBounds && tabsBounds && tabsBounds.x >= navBounds.x + navBounds.width && Math.abs(tabsBounds.y - navBounds.y) < 20, 'tabs sit immediately to the right of library navigation');
  assert(navBounds && collectionTabBounds && Math.abs(navBounds.y - collectionTabBounds.y) < 0.5,
    'fixed navigation and dynamic tabs align vertically, including when the tab strip scrolls horizontally');
  await page.mouse.move(10, 700);
  const activeCollectionStyle = await page.locator('.reader-tab.is-active').evaluate(element => {
    const style = getComputedStyle(element), label = getComputedStyle(element.querySelector('.reader-tab-select')!);
    return { height: element.getBoundingClientRect().height, fontSize: label.fontSize, fontFamily: label.fontFamily,
      fontWeight: label.fontWeight, color: label.color, background: style.backgroundColor, border: style.borderTopWidth };
  });
  assert.equal(activeCollectionStyle.border, '0px', 'dynamic tabs have no extra bordered frame');
  assert.equal(await page.locator('.reader-tab-select svg, .home-nav button svg').count(), 0, 'navigation items share a text-only label format');
  await home(page); await page.mouse.move(10, 700);
  const activeNavigationStyle = await page.getByRole('button', { name: '个人首页', exact: true }).evaluate(element => {
    const style = getComputedStyle(element);
    return { height: element.getBoundingClientRect().height, fontSize: style.fontSize, fontFamily: style.fontFamily,
      fontWeight: style.fontWeight, color: style.color, background: style.backgroundColor, border: style.borderTopWidth };
  });
  assert.deepEqual(activeCollectionStyle, activeNavigationStyle, 'fixed navigation and collection tabs use consistent dimensions, typography and active styling');
  await page.getByRole('tab', { name: titles.alpha, exact: true }).click();
  await page.getByText('标注自动保存到文献库', { exact: true }).waitFor({ timeout: 30000 });
  await page.mouse.move(10, 700);
  assert.equal(await page.locator('.reader-tab.is-active').evaluate(element => getComputedStyle(element).backgroundColor), activeNavigationStyle.background, 'reader tabs share the same active styling');
  await page.locator('#collection-tab-pdf').click(); await rows(page, 'PDF 原文列表', [ids.alpha, ids.beta, ids.delta]);
  await page.screenshot({ path: join(directory, 'home-collection-tabs.png'), fullPage: true });

  await page.getByRole('button', { name: '关闭列表：Markdown 笔记', exact: true }).click();
  assert.equal(await page.locator('#collection-tab-pdf').getAttribute('aria-selected'), 'true', 'closing a background collection keeps the current page');
  await page.getByRole('button', { name: '关闭列表：PDF 原文', exact: true }).click();
  await rows(page, '本库监控已开启列表', [ids.alpha]); await detail(page, titles.alpha);
  assert.equal(await page.locator('#collection-tab-monitoring').getAttribute('aria-selected'), 'true', 'closing the active collection selects the next tab');
  await page.locator('#collection-tab-monitoring').focus(); await page.keyboard.press('Delete');
  await page.getByText('标注自动保存到文献库', { exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('tablist', { name: 'PDF 阅读标签', exact: true }).waitFor();
  await page.getByRole('button', { name: `关闭 PDF：${titles.alpha}`, exact: true }).click();
  await page.getByRole('textbox', { name: '搜索文献', exact: true }).waitFor();
  assert.equal(await page.getByRole('tab').count(), 0, 'closing the last tab returns to the original library');
  await metric(page, 'md'); await home(page);
  await page.getByRole('button', { name: '关闭列表：Markdown 笔记', exact: true }).click();
  await page.getByRole('main', { name: '个人首页', exact: true }).waitFor();
  assert.deepEqual(await app.evaluate(() => (globalThis as any).homeCollectionRequests), []);
  assert.deepEqual(errors, []);
  await closeApp(app);

  // Zero-count cards remain usable, producing an explicit empty list rather than a disabled card.
  const emptyRoot = await mkdtemp(resolve('.test-data/home-collections-empty-'));
  app = await launch(emptyRoot); page = await app.firstWindow();
  for (const category of ['pdf', 'md', 'monitoring'] as const) {
    await metric(page, category); await rows(page, `${names[category]}列表`, []);
    await page.getByRole('main', { name: `${names[category]}列表`, exact: true }).locator('.paper-list .empty-state').waitFor();
    await noDetail(page);
  }
  await home(page); await page.getByRole('button', { name: '本地论文', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索文献', exact: true }).waitFor();
  console.log(JSON.stringify({ packaged, directory, result: 'passed', checks: 'clickable metrics, exact runtime membership, independently selected collection details and queries, real rating/tag changes shared across views, monitored selection removed without stale details, preserved/reset library filters, MD and per-paper folder opener, actual PDF tab coexistence/save, live attachments/counts, empty details/lists, aligned navigation typography and active style, compact collection tabs with 200px PDF reading tabs, close/keyboard behavior, offline isolated profiles' }));
} catch (error) {
  if (!page.isClosed()) { await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }); console.log(await page.locator('body').innerText()); }
  throw error;
} finally { await closeApp(app); }
