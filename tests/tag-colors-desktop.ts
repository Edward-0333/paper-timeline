import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Locator } from 'playwright-core';
import { Library } from '../electron/library';

// Only this freshly created, stopped fixture is edited to simulate an old index.
await mkdir('.test-data', { recursive: true });
const directory = await mkdtemp(resolve('.test-data/tag-colors-desktop-'));
const packaged = process.argv.includes('--packaged');
const library = new Library(join(directory, 'library'), async () => { throw new Error('No PDF extraction in tag fixtures'); },
  async () => { throw new Error('No metadata requests in tag fixtures'); });
await library.initialize();
const ids: Record<string, string> = {};
for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']) {
  ids[name] = (await library.createPaper({ title: `${name} global tag color fixture`, authors: [`${name} Author`], publicationDate: '2025' }, null, false)).id;
}
const alphaTag = await library.addTag(ids.Alpha, 'Research', '#7BC58C');
const betaTag = await library.addTag(ids.Beta, 'research', '#7BC58C');
const gammaTag = await library.addTag(ids.Gamma, 'RESEARCH', '#7BC58C');
const alphaTie = await library.addTag(ids.Alpha, '平票标签', '#112233');
const betaTie = await library.addTag(ids.Beta, '平票标签', '#112233');
const deltaTag = await library.addTag(ids.Delta, '待重命名', '#DED0F4');
await library.moveTag(ids.Alpha, alphaTag.id, { side: 'top', offset: 0.25 });
await library.moveTag(ids.Beta, betaTag.id, { side: 'right', offset: 0.6 });
await library.moveTag(ids.Gamma, gammaTag.id, { side: 'left', offset: 0.8 });
await library.moveTag(ids.Delta, deltaTag.id, { side: 'bottom', offset: 0.4 });
const noteSource = join(directory, 'alpha.md'), pdfSource = join(directory, 'alpha.pdf');
await writeFile(noteSource, '# Offline color fixture\nNotes must remain byte-for-byte unchanged.\n');
await writeFile(pdfSource, '%PDF-1.7\n%%EOF\n');
await library.attachMarkdown(ids.Alpha, noteSource); await library.attachPdf(ids.Alpha, pdfSource);
const tracks = [...library.state().timelines];
const firstTrack = tracks[0] ?? await library.createTimeline({ x: 32, y: 275 });
await library.updateTimeline(firstTrack.id, { tags: [], position: { x: 32, y: 275 } });
const secondTrack = await library.createTimeline({ x: 32, y: 950 });
await library.updateTimeline(secondTrack.id, { tags: ['research'] });
const fixture = JSON.parse(await readFile(library.file, 'utf8'));
fixture.papers.find((paper: any) => paper.id === ids.Alpha).tags.find((tag: any) => tag.id === alphaTag.id).color = '#E53935';
fixture.papers.find((paper: any) => paper.id === ids.Beta).tags.find((tag: any) => tag.id === betaTie.id).color = '#445566';
await writeFile(library.file, JSON.stringify(fixture, null, 2));
const pdfBefore = await readFile(library.pdfPath(ids.Alpha));
const noteBefore = await readFile(await library.markdownPath(ids.Alpha));
const unchangedFields = (index: any) => ({ ...index, papers: index.papers.map(({ tags: _tags, ...paper }: any) => paper) });
const tagIdentity = (index: any) => index.papers.flatMap((paper: any) => (paper.tags ?? []).map(({ color: _color, ...tag }: any) => ({ paperId: paper.id, ...tag })));
const readIndex = async () => JSON.parse(await readFile(library.file, 'utf8'));
const rgb = (hex: string) => `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ')})`;
const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, PAPER_TIMELINE_DATA: directory, PAPER_TIMELINE_AI: '0' })
  .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE;
async function launch() {
  const instance = await electron.launch({ executablePath: resolve(packaged ? 'release/win-unpacked/Paper Timeline.exe' : 'node_modules/electron/dist/electron.exe'),
    ...(packaged ? {} : { args: [resolve('.')] }), env, timeout: 30000 });
  await instance.evaluate(({ session }) => {
    (globalThis as any).tagRequests = [];
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (/^https?:/.test(details.url)) { (globalThis as any).tagRequests.push(details.url); callback({ cancel: true }); }
      else callback({});
    });
  });
  return instance;
}
async function closeApp(instance: ElectronApplication) {
  if (instance.process().exitCode !== null) return;
  const exited = new Promise<void>(done => instance.process().once('exit', () => done()));
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.close()));
  const timeout = setTimeout(() => instance.process().kill(), 15000);
  try { await exited; } finally { clearTimeout(timeout); }
}
let app = await launch();
let page = await app.firstWindow();
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
const details = () => page.getByRole('complementary', { name: '文献详情', exact: true });
const dialog = (name: '编辑标签' | '添加标签' = '编辑标签') => page.getByRole('dialog', { name, exact: true });
const row = (id: string) => page.locator(`.paper-table tr[data-paper-id="${id}"]`);
const card = (trackId: string, id = ids.Alpha) => page.locator(`[data-timeline-id="${trackId}"] .timeline-paper[data-paper-id="${id}"]`);
async function checkColor(element: Locator, color: string) {
  await element.waitFor();
  const started = Date.now();
  while (await element.evaluate(target => getComputedStyle(target).backgroundColor) !== rgb(color) && Date.now() - started < 5000) {
    await page.waitForTimeout(50);
  }
  assert.equal(await element.evaluate(target => getComputedStyle(target).backgroundColor), rgb(color));
}
async function tableColors(color: string, names = ['Alpha', 'Beta', 'Gamma']) {
  for (const name of names) await checkColor(row(ids[name]).locator('.table-tag-list li').filter({ hasText: /^research$/i }), color);
}
async function saveTag(name: '编辑标签' | '添加标签' = '编辑标签') {
  await dialog(name).getByRole('button', { name: '保存标签', exact: true }).click();
  await dialog(name).waitFor({ state: 'hidden' });
}
async function centerCard(trackId: string, id = ids.Alpha) {
  await card(trackId, id).evaluate(element => {
    const viewport = element.closest('.map-viewport')!;
    const rect = element.getBoundingClientRect(), view = viewport.getBoundingClientRect();
    viewport.scrollBy(rect.left - view.left - (view.width - rect.width) / 2, rect.top - view.top - (view.height - rect.height) / 2);
  });
}
try {
  await page.getByRole('button', { name: '打开文献库', exact: true }).click();
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await row(ids.Alpha).waitFor();
  const normalized = await readIndex();
  assert.deepEqual(unchangedFields(normalized), unchangedFields(fixture), 'startup color normalization preserves every non-tag index field');
  assert.deepEqual(tagIdentity(normalized), tagIdentity(fixture), 'startup normalization preserves tag IDs, names and edge positions');
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    assert.equal(normalized.papers.find((paper: any) => paper.id === ids[name]).tags.find((tag: any) => tag.text.toLowerCase() === 'research').color, '#7BC58C');
  }
  assert.equal(normalized.papers.find((paper: any) => paper.id === ids.Beta).tags.find((tag: any) => tag.id === betaTie.id).color, '#112233', 'equal-frequency legacy colors use stable hexadecimal ordering');
  await tableColors('#7BC58C');
  await row(ids.Alpha).click();
  await checkColor(details().getByRole('button', { name: '编辑标签：Research', exact: true }).locator('..'), '#7BC58C');
  await details().getByRole('button', { name: '编辑标签：Research', exact: true }).click();
  assert.equal(await dialog().getByLabel('自定义颜色', { exact: true }).isEnabled(), true, 'editing the existing class can change its global color');
  await dialog().getByRole('button', { name: '青色背景', exact: true }).click();
  await saveTag();
  await tableColors('#BDE4E6');
  assert.deepEqual(tagIdentity(await readIndex()), tagIdentity(fixture), 'global recoloring keeps individual tag identities and positions');

  await row(ids.Delta).click();
  await details().getByRole('button', { name: '编辑标签：待重命名', exact: true }).click();
  await dialog().getByLabel('标签文字', { exact: true }).fill('Research');
  await checkColor(dialog().locator('.tag-preview .paper-tag'), '#BDE4E6');
  assert.equal(await dialog().getByLabel('自定义颜色', { exact: true }).isDisabled(), true, 'renaming into an existing class adopts its global color');
  await saveTag();
  await tableColors('#BDE4E6', ['Alpha', 'Beta', 'Gamma', 'Delta']);
  const renamed = (await readIndex()).papers.find((paper: any) => paper.id === ids.Delta).tags[0];
  assert.equal(renamed.id, deltaTag.id); assert.deepEqual(renamed.position, { side: 'bottom', offset: 0.4 });

  await row(ids.Epsilon).click();
  await details().getByRole('button', { name: '添加标签', exact: true }).click();
  await dialog('添加标签').getByLabel('标签文字', { exact: true }).fill(' research ');
  await checkColor(dialog('添加标签').locator('.tag-preview .paper-tag'), '#BDE4E6');
  assert.equal(await dialog('添加标签').getByLabel('自定义颜色', { exact: true }).isDisabled(), true, 'adding an existing label cannot accidentally recolor the class');
  assert.equal(await dialog('添加标签').getByRole('button', { name: '绿色背景', exact: true }).isDisabled(), true);
  await page.screenshot({ path: join(directory, 'existing-tag-color.png'), fullPage: true });
  await saveTag('添加标签');
  await tableColors('#BDE4E6', ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']);

  // The same global state is used in the home collection's detail panel.
  await page.getByRole('button', { name: '个人首页', exact: true }).click();
  await page.getByRole('button', { name: 'Markdown 笔记', exact: true }).click();
  await page.getByRole('main', { name: 'Markdown 笔记列表', exact: true }).waitFor();
  await row(ids.Alpha).click();
  await checkColor(details().getByRole('button', { name: '编辑标签：Research', exact: true }).locator('..'), '#BDE4E6');
  await page.getByRole('button', { name: '文献库', exact: true }).click();
  await page.getByRole('button', { name: '时间线', exact: true }).click();
  await card(secondTrack.id).waitFor();
  await page.getByLabel('恢复百分之百', { exact: true }).click();
  await centerCard(secondTrack.id);
  await card(secondTrack.id).locator('.timeline-paper-body').click();
  await centerCard(secondTrack.id);
  await card(secondTrack.id).locator(`.paper-tag[data-tag-id="${alphaTag.id}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑标签', exact: true }).click();
  await dialog().getByRole('button', { name: '黄色背景', exact: true }).click();
  await saveTag();
  for (const track of [firstTrack, secondTrack]) for (const [name, tagId] of [['Alpha', alphaTag.id], ['Beta', betaTag.id], ['Gamma', gammaTag.id], ['Delta', deltaTag.id]]) {
    await checkColor(card(track.id, ids[name]).locator(`.paper-tag[data-tag-id="${tagId}"]`), '#F5E5AD');
  }
  const legend = page.locator(`[data-timeline-id="${secondTrack.id}"] .timeline-tag-filter-selected-row`).filter({ hasText: /^research$/i });
  await checkColor(legend.locator('.timeline-tag-filter-selected-dot'), '#F5E5AD');
  await centerCard(secondTrack.id);
  // Bring the filter button into view without relying on the zoom or a fixed screen coordinate.
  const filter = page.locator(`[data-timeline-id="${secondTrack.id}"] .timeline-tag-filter-trigger`);
  await filter.scrollIntoViewIfNeeded(); await filter.click();
  const popup = page.getByRole('dialog', { name: '按标签筛选', exact: true });
  await checkColor(popup.getByRole('checkbox', { name: /^Research，5 篇论文$/i }).locator('.timeline-tag-filter-dot'), '#F5E5AD');
  await page.screenshot({ path: join(directory, 'timeline-global-tag-color.png'), fullPage: true });
  await popup.getByRole('button', { name: '完成', exact: true }).click();
  const afterEdits = await readIndex();
  const expectedAfterOpening = structuredClone(fixture);
  // Only these papers were explicitly selected; the other two retain their markers.
  for (const name of ['Alpha', 'Delta', 'Epsilon']) delete expectedAfterOpening.papers.find((paper: any) => paper.id === ids[name]).unread;
  assert.deepEqual(unchangedFields(afterEdits), unchangedFields(expectedAfterOpening), 'tag edits preserve all fields except the explicitly opened marker');
  assert.deepEqual(await readFile(library.pdfPath(ids.Alpha)), pdfBefore); assert.deepEqual(await readFile(await library.markdownPath(ids.Alpha)), noteBefore);
  assert.deepEqual(await app.evaluate(() => (globalThis as any).tagRequests), [], 'all tag color operations remain offline');
  const finalIndex = await readIndex();
  await closeApp(app);
  app = await launch(); page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: '打开文献库', exact: true }).click();
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await tableColors('#F5E5AD', ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']);
  assert.deepEqual(await readIndex(), finalIndex, 'a second startup retains the canonical colors without rewriting index content');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ packaged, directory, result: 'passed', checks: 'legacy majority and stable tie normalization, global detail and timeline recoloring, list/detail/collection/filter legends, existing-name add and rename adoption with disabled color controls, tag IDs and edge positions, restart persistence, unchanged PDF/MD and all non-tag index fields, offline fixture' }));
} catch (error) {
  if (!page.isClosed()) { await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }); console.log(await page.locator('body').innerText()); }
  throw error;
} finally { await closeApp(app); }
