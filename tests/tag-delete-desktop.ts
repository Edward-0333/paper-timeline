import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { Library } from '../electron/library';

// Always use a new stopped fixture, never the user's running or saved library.
await mkdir('.test-data', { recursive: true });
const directory = await mkdtemp(resolve('.test-data/tag-delete-desktop-'));
const packaged = process.argv.includes('--packaged');
const library = new Library(join(directory, 'library'), async () => { throw new Error('No PDF extraction in tag fixtures'); },
  async () => { throw new Error('No metadata requests in tag fixtures'); });
await library.initialize();
const titles = { alpha: 'Alpha tag deletion confirmation fixture', beta: 'Beta retains the same shared tag' };
const alpha = (await library.createPaper({ title: titles.alpha, authors: ['Offline Author'], publicationDate: '2025' }, null, false)).id;
const beta = (await library.createPaper({ title: titles.beta, publicationDate: '2025' }, null, false)).id;
const shared = await library.addTag(alpha, '共有标签', '#7BC58C');
const retained = await library.addTag(beta, '共有标签', '#7BC58C');
const retry = await library.addTag(alpha, '失败后重试', '#8DD1D7');
const rapid = await library.addTag(alpha, '防止重复确认', '#F5D681');
const timeline = await library.addTag(alpha, '时间线确认', '#7BC58C');
await library.addTag(beta, '时间线确认', '#7BC58C');
const noteSource = join(directory, 'alpha.md'), pdfSource = join(directory, 'alpha.pdf');
await writeFile(noteSource, '# Fixture note\nThis file must survive label deletion.\n');
// The PDF is never opened; only its independent attachment and file tag matter.
await writeFile(pdfSource, '%PDF-1.7\n%%EOF\n');
await library.attachMarkdown(alpha, noteSource); await library.attachPdf(alpha, pdfSource);
const tracks = [...library.state().timelines];
for (const track of tracks) await library.updateTimeline(track.id, { tags: [] });
const firstTrack = tracks[0] ?? await library.createTimeline({ x: 32, y: 275 });
await library.updateTimeline(firstTrack.id, { tags: [], position: { x: 32, y: 275 } });
const secondTrack = await library.createTimeline({ x: 32, y: 900 });
await library.updateTimeline(secondTrack.id, { tags: [] });
const pdfBefore = await readFile(library.pdfPath(alpha));
const noteBefore = await readFile(await library.markdownPath(alpha));

const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, PAPER_TIMELINE_DATA: directory, PAPER_TIMELINE_AI: '0' })
  .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: resolve(packaged ? 'release/win-unpacked/Paper Timeline.exe' : 'node_modules/electron/dist/electron.exe'),
  ...(packaged ? {} : { args: [resolve('.')] }), env, timeout: 30000 });
const page = await app.firstWindow();
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
const modal = () => page.getByRole('dialog', { name: '是否确定删除标签？', exact: true });
const details = () => page.getByRole('complementary', { name: '文献详情', exact: true });
async function storedTags(id: string) {
  return (JSON.parse(await readFile(library.file, 'utf8')).papers.find((paper: any) => paper.id === id).tags ?? []) as { id: string; text: string }[];
}
async function requestCount() { return app.evaluate(() => (globalThis as any).tagDeleteCalls.length as number); }
async function openRemove(text: string) {
  await details().getByRole('button', { name: `删除标签：${text}`, exact: true }).click();
  await modal().getByText(text, { exact: true }).waitFor();
  await modal().getByText(titles.alpha, { exact: true }).waitFor();
}
async function confirm() {
  await modal().getByRole('button', { name: '确认删除', exact: true }).click();
  await modal().waitFor({ state: 'hidden' });
}
const card = (trackId: string, id = alpha) => page.locator(`[data-timeline-id="${trackId}"] .timeline-paper[data-paper-id="${id}"]`);
async function centerCard(trackId: string, id = alpha) {
  await card(trackId, id).evaluate(element => {
    const viewport = element.closest('.map-viewport')!;
    const rect = element.getBoundingClientRect(), view = viewport.getBoundingClientRect();
    viewport.scrollBy(rect.left - view.left - (view.width - rect.width) / 2, rect.top - view.top - (view.height - rect.height) / 2);
  });
}
async function closeApp(instance: ElectronApplication) {
  if (instance.process().exitCode !== null) return;
  const exited = new Promise<void>(done => instance.process().once('exit', () => done()));
  await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.close()));
  const timeout = setTimeout(() => instance.process().kill(), 15000);
  try { await exited; } finally { clearTimeout(timeout); }
}
try {
  await app.evaluate(({ ipcMain, session }) => {
    (globalThis as any).tagRequests = [];
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (/^https?:/.test(details.url)) { (globalThis as any).tagRequests.push(details.url); callback({ cancel: true }); }
      else callback({});
    });
    const original = (ipcMain as any)._invokeHandlers.get('library:delete-tag');
    if (!original) throw new Error('Missing tag deletion IPC');
    (globalThis as any).tagDeleteCalls = [];
    (globalThis as any).tagDeleteMode = 'normal';
    ipcMain.removeHandler('library:delete-tag');
    ipcMain.handle('library:delete-tag', async (event, id, tagId) => {
      (globalThis as any).tagDeleteCalls.push({ id, tagId });
      if ((globalThis as any).tagDeleteMode === 'failure') throw new Error('Isolated tag deletion failure');
      if ((globalThis as any).tagDeleteMode === 'gate') await new Promise<void>(done => { (globalThis as any).releaseTagDelete = done; });
      return original(event, id, tagId);
    });
  });
  await page.getByRole('button', { name: '打开文献库', exact: true }).click();
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await page.locator(`.paper-table tr[data-paper-id="${alpha}"]`).click();
  await details().getByRole('button', { name: '删除标签：共有标签', exact: true }).waitFor();
  const indexBefore = await readFile(library.file, 'utf8');
  for (const cancel of ['button', 'escape', 'enter', 'close', 'backdrop'] as const) {
    await openRemove('共有标签');
    await modal().getByText('仅从这篇论文移除该标签，其他论文的同名标签会保留。', { exact: true }).waitFor();
    assert.equal(await modal().getByRole('button', { name: '取消', exact: true }).evaluate(button => button === document.activeElement), true,
      'the confirmation safely defaults to cancel');
    assert.equal(await requestCount(), 0, 'opening a dialog cannot call the mutation IPC');
    if (cancel === 'button') {
      await page.screenshot({ path: join(directory, 'tag-delete-confirmation.png'), fullPage: true });
      await modal().getByRole('button', { name: '取消', exact: true }).click();
    } else if (cancel === 'escape') await page.keyboard.press('Escape');
    else if (cancel === 'enter') await page.keyboard.press('Enter');
    else if (cancel === 'close') await modal().getByRole('button', { name: '关闭删除标签确认', exact: true }).click();
    else await page.mouse.click(5, 5);
    await modal().waitFor({ state: 'hidden' });
    assert.equal(await requestCount(), 0, `${cancel} does not request deletion`);
    assert.equal(await readFile(library.file, 'utf8'), indexBefore, `${cancel} leaves the fixture index unchanged`);
    await details().getByRole('button', { name: '编辑标签：共有标签', exact: true }).waitFor();
  }
  await openRemove('共有标签'); await confirm();
  await details().getByRole('button', { name: '编辑标签：共有标签', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await requestCount(), 1);
  assert.equal((await storedTags(alpha)).some(tag => tag.id === shared.id), false);
  assert((await storedTags(beta)).some(tag => tag.id === retained.id), 'confirmation removes only this paper’s tag, preserving same-name tags elsewhere');

  // The home collection's reused detail panel has the identical confirmation.
  await page.getByRole('button', { name: '个人首页', exact: true }).click();
  await page.getByRole('button', { name: 'Markdown 笔记', exact: true }).click();
  await page.getByRole('main', { name: 'Markdown 笔记列表', exact: true }).waitFor();
  await page.locator(`.paper-table tr[data-paper-id="${alpha}"]`).click();
  await app.evaluate(() => { (globalThis as any).tagDeleteMode = 'failure'; });
  await openRemove('失败后重试');
  await modal().getByRole('button', { name: '确认删除', exact: true }).click();
  await modal().getByRole('alert').filter({ hasText: 'Isolated tag deletion failure' }).waitFor();
  assert.equal(await requestCount(), 2);
  assert((await storedTags(alpha)).some(tag => tag.id === retry.id), 'a failed save never claims or persists a removal');
  assert.equal(await modal().getByRole('button', { name: '确认删除', exact: true }).isEnabled(), true, 'failed deletion can be retried in the same dialog');
  await page.screenshot({ path: join(directory, 'tag-delete-retry.png'), fullPage: true });
  await app.evaluate(() => { (globalThis as any).tagDeleteMode = 'normal'; });
  await confirm();
  assert.equal(await requestCount(), 3);
  assert.equal((await storedTags(alpha)).some(tag => tag.id === retry.id), false);

  // Hold the first save so a real rapid double activation cannot issue a second one.
  await app.evaluate(() => { (globalThis as any).tagDeleteMode = 'gate'; });
  await openRemove('防止重复确认');
  await modal().getByRole('button', { name: '确认删除', exact: true }).evaluate(button => {
    (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();
  });
  await modal().getByRole('button', { name: '删除中…', exact: true }).waitFor();
  assert.equal(await requestCount(), 4, 'the second activation is suppressed while the first save is pending');
  assert.equal(await modal().getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await modal().isVisible(), true, 'pending deletion cannot be dismissed before its result is known');
  assert((await storedTags(alpha)).some(tag => tag.id === rapid.id), 'the tag remains until the held save completes');
  await app.evaluate(() => { (globalThis as any).tagDeleteMode = 'normal'; (globalThis as any).releaseTagDelete(); });
  await modal().waitFor({ state: 'hidden' });
  assert.equal((await storedTags(alpha)).some(tag => tag.id === rapid.id), false);

  await page.getByRole('button', { name: '文献库', exact: true }).click();
  await page.getByRole('button', { name: '时间线', exact: true }).click();
  await card(secondTrack.id).waitFor();
  await page.getByLabel('恢复百分之百', { exact: true }).click();
  await centerCard(secondTrack.id);
  await card(secondTrack.id).locator('.timeline-paper-body').click();
  await centerCard(secondTrack.id);
  await card(secondTrack.id).locator(`.paper-tag[data-tag-id="${timeline.id}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除标签', exact: true }).click();
  await modal().getByText('时间线确认', { exact: true }).waitFor();
  assert.equal(await requestCount(), 4, 'timeline context-menu deletion also waits for confirmation');
  await page.keyboard.press('Escape'); await modal().waitFor({ state: 'hidden' });
  assert.equal(await page.locator(`.paper-tag[data-tag-id="${timeline.id}"]`).count(), 2, 'cancel retains the tag on both occurrences');
  await centerCard(secondTrack.id);
  await card(secondTrack.id).locator(`.paper-tag[data-tag-id="${timeline.id}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除标签', exact: true }).click();
  await page.screenshot({ path: join(directory, 'timeline-tag-delete-confirmation.png'), fullPage: true });
  await confirm();
  await page.waitForFunction(tagId => document.querySelectorAll(`.paper-tag[data-tag-id="${tagId}"]`).length === 0, timeline.id);
  assert.equal(await requestCount(), 5);
  assert.equal(await page.locator(`.paper-tag[data-tag-id="${timeline.id}"]`).count(), 0, 'shared paper state removes both lane occurrences after confirmation');
  assert.equal(await card(firstTrack.id, beta).locator('.paper-tag').filter({ hasText: '时间线确认' }).count(), 1, 'the other paper keeps its same-name tag');
  assert.equal(await page.getByLabel('恢复百分之百', { exact: true }).innerText(), '100%', 'confirmation preserves timeline zoom');
  assert.equal(await page.locator('.timeline-paper.selected').evaluate(element => element.closest('.timeline-lane')?.getAttribute('data-timeline-id')), secondTrack.id,
    'confirmation preserves the selected occurrence in the second timeline');

  await centerCard(secondTrack.id);
  for (const kind of ['pdf', 'md']) {
    await card(secondTrack.id).locator(`.file-tag-${kind}`).click({ button: 'right' });
    assert.equal(await page.getByRole('menu', { name: '论文标签操作', exact: true }).count(), 0, 'file labels do not expose deletion actions');
    assert.equal(await modal().count(), 0, 'file labels cannot open deletion confirmation');
  }
  assert.equal(await requestCount(), 5);
  assert.deepEqual(await readFile(library.pdfPath(alpha)), pdfBefore, 'label deletion preserves the attached PDF');
  assert.deepEqual(await readFile(await library.markdownPath(alpha)), noteBefore, 'label deletion preserves the attached Markdown');
  assert.deepEqual(await app.evaluate(() => (globalThis as any).tagRequests), [], 'confirmation and deletion stay fully offline');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ packaged, directory, result: 'passed', checks: 'list and home-collection details, timeline context menu, cancel/Escape/default Enter/close/backdrop without IPC or index writes, explicit confirmation, same-name isolation, failure and retry, rapid confirmation guard, same-paper cross-lane update and second-lane selection, PDF/MD undeletable and unchanged, offline fixture' }));
} catch (error) {
  if (!page.isClosed()) { await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }); console.log(await page.locator('body').innerText()); }
  throw error;
} finally { await closeApp(app); }
