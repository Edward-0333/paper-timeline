import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { Library } from '../electron/library';
import { localMetadata } from '../electron/metadata';

// The running user's library, API settings and original source files are never used.
await mkdir('.test-data', { recursive: true });
const directory = await mkdtemp(resolve('.test-data/notes-desktop-'));
const packaged = process.argv.includes('--packaged');
const titles = { alpha: 'Alpha paper Markdown reading and editing', beta: 'Beta independent Markdown-only paper' };
const library = new Library(join(directory, 'library'), async () => { throw new Error('No fixture PDF metadata retrieval'); },
  async pdf => ({ metadata: localMetadata(pdf), matched: true, message: 'isolated fixture' }));
await library.initialize();
const ids = {} as Record<keyof typeof titles, string>;
for (const key of ['alpha', 'beta'] as const) ids[key] = (await library.createPaper({ title: titles[key], authors: ['Fixture Author'], publicationDate: '2025' }, null, false)).id;
function tinyPdf() {
  const stream = 'BT /F1 16 Tf 72 700 Td (Isolated PDF original must remain unchanged) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let raw = '%PDF-1.7\n'; const offsets: number[] = [];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(raw)); raw += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(raw);
  return raw + `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
const sourcePdf = join(directory, 'alpha.pdf'); await writeFile(sourcePdf, tinyPdf()); await library.attachPdf(ids.alpha, sourcePdf);
const originals = {
  alpha: '\uFEFF---\r\ntitle: 原始笔记格式\r\n---\r\n# Alpha 笔记\r\n\r\n**加粗**与中文正文。\r\n\r\n| 方法 | 结果 |\r\n| --- | --- |\r\n| A | 42 |\r\n\r\n公式 $E=mc^2$。\r\n\r\n![远程图片](https://notes-fixture.invalid/tracking.png)\r\n<script>window.noteFixtureExecuted=true</script>\r\n<img src="https://notes-fixture.invalid/raw.png" onerror="window.noteFixtureExecuted=true">\r\n',
  beta: '# Beta 笔记\n\n独立论文中的原始内容。\n',
};
const sources = {} as Record<keyof typeof titles, string>;
for (const key of ['alpha', 'beta'] as const) {
  sources[key] = join(directory, `${key}.md`); await writeFile(sources[key], originals[key]);
  await library.attachMarkdown(ids[key], sources[key]);
}
const paths = { alpha: await library.markdownPath(ids.alpha), beta: await library.markdownPath(ids.beta) };
const originalPdf = await readFile(library.pdfPath(ids.alpha));
const originalIndex = await readFile(library.file);
function launch() {
  const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, PAPER_TIMELINE_DATA: directory, PAPER_TIMELINE_AI: '0' })
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
async function libraryPage(page: Page) {
  await page.getByRole('button', { name: '文献库', exact: true }).click();
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await page.locator('.paper-table tbody tr').first().waitFor();
}
async function note(page: Page, key: keyof typeof titles) {
  await page.locator('#markdown-note-panel').waitFor();
  assert.equal(await page.locator(`#md-tab-${ids[key]}`).getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: '编辑', exact: true }).waitFor();
}
async function openListNote(page: Page, key: keyof typeof titles) {
  await libraryPage(page);
  await page.locator(`tr[data-paper-id="${ids[key]}"]`).getByRole('button', { name: `打开 Markdown 笔记：${key}.md`, exact: true }).click();
  await note(page, key);
}
async function edit(page: Page, text: string) {
  const editButton = page.getByRole('button', { name: '编辑', exact: true });
  if (await editButton.getAttribute('aria-pressed') !== 'true') await editButton.click();
  const editor = page.getByRole('textbox', { name: 'Markdown 笔记源码', exact: true });
  await editor.waitFor(); await editor.fill(text);
  // Vditor's input callback is debounced; wait for the app's actual dirty/save state.
  await page.getByRole('button', { name: '保存笔记', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent?.trim() === '保存笔记' && !button.disabled));
  return editor;
}
async function waitText(path: string, text: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if ((await readFile(path, 'utf8')).includes(text)) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  assert.fail(`Saved note did not contain ${text}`);
}
async function waitOpened(app: ElectronApplication, expected: string[]) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const actual = await app.evaluate(() => (globalThis as any).noteOpened);
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  assert.deepEqual(await app.evaluate(() => (globalThis as any).noteOpened), expected);
}

let app = await launch(), page = await app.firstWindow();
const errors: string[] = []; const requests: string[] = [];
async function instrument() {
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { void dialog.dismiss(); });
  await app.evaluate(({ shell, session }) => {
    (globalThis as any).noteOpened = []; (globalThis as any).noteRequests = [];
    shell.openPath = async path => { (globalThis as any).noteOpened.push(path); return ''; };
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (/^https?:/.test(details.url)) { (globalThis as any).noteRequests.push(details.url); callback({ cancel: true }); }
      else callback({});
    });
  });
}
try {
  await instrument();
  await openListNote(page, 'alpha');
  await page.locator('.note-markdown').getByRole('heading', { name: 'Alpha 笔记', exact: true }).waitFor();
  const properties = page.locator('.note-frontmatter');
  await properties.locator('summary').getByText('文档属性（YAML）', { exact: true }).waitFor();
  assert.equal(await properties.getAttribute('open'), null, 'YAML properties are collapsed while reading');
  await properties.locator('summary').click();
  assert.match(await properties.locator('pre').innerText(), /title: 原始笔记格式/, 'the unmodified YAML metadata remains available for inspection');
  await properties.locator('summary').click();
  assert.equal(await page.locator('.note-markdown table').count(), 1, 'the in-app reader renders Markdown tables');
  assert.equal(await page.evaluate(() => Boolean((window as any).noteFixtureExecuted)), false, 'raw note HTML is never executable');
  assert.equal(await page.locator('.note-markdown script, .note-markdown [onerror]').count(), 0);
  assert.equal(await page.locator('.note-markdown img[src^="http"]').count(), 0, 'remote note images do not auto-load');
  await page.screenshot({ path: join(directory, 'markdown-note-reader.png'), fullPage: true });
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown 笔记源码', exact: true }).waitFor();
  await page.screenshot({ path: join(directory, 'markdown-note-editor.png'), fullPage: true });
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await libraryPage(page);
  assert.deepEqual(await readFile(paths.alpha), Buffer.from(originals.alpha), 'read and edit/read toggles preserve BOM, CRLF, frontmatter and original Markdown bytes');
  assert.equal((await readdir(library.paperDirectory(ids.alpha))).some(name => /^notes\.md.*bak/.test(name)), false, 'reading creates no spurious note backup');

  // All existing MD entry points open the same internal paper tab.
  await page.locator(`tr[data-paper-id="${ids.alpha}"]`).click();
  await page.getByRole('complementary', { name: '文献详情', exact: true }).getByRole('button', { name: 'alpha.md', exact: true }).click();
  await note(page, 'alpha');
  assert.equal(await page.locator(`#md-tab-${ids.alpha}`).count(), 1, 'details reuse the already opened note');
  await page.getByRole('button', { name: '默认软件打开', exact: true }).click();
  await waitOpened(app, [paths.alpha]);
  assert.deepEqual(await app.evaluate(() => (globalThis as any).noteOpened), [paths.alpha], 'external opening remains an explicit optional action');
  await page.getByRole('button', { name: '个人首页', exact: true }).click();
  await page.getByRole('button', { name: 'Markdown 笔记', exact: true }).click();
  await page.locator(`tr[data-paper-id="${ids.beta}"]`).getByRole('button', { name: '打开 Markdown 笔记：beta.md', exact: true }).click();
  await note(page, 'beta');
  assert.equal(await page.locator('#markdown-note-panel').getByText('独立论文中的原始内容。', { exact: true }).count(), 1, 'a paper without PDF has its own editable note');
  await libraryPage(page); await page.getByRole('button', { name: '时间线', exact: true }).click();
  await page.locator(`.timeline-paper[data-paper-id="${ids.alpha}"] .file-tag-md`).click(); await note(page, 'alpha');
  assert.equal(await page.locator(`[id^="md-tab-"]`).count(), 2, 'timeline entry reuses the note tab without replacing another paper');
  await libraryPage(page);
  await page.locator(`tr[data-paper-id="${ids.alpha}"]`).getByRole('button', { name: '打开 PDF：alpha.pdf', exact: true }).click();
  await page.getByText('标注自动保存到文献库', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator(`#md-tab-${ids.alpha}, #md-tab-${ids.beta}, #pdf-tab-${ids.alpha}`).count(), 3, 'PDF and independent Markdown tabs coexist');
  for (const id of [`md-tab-${ids.alpha}`, `md-tab-${ids.beta}`, `pdf-tab-${ids.alpha}`])
    assert.equal(await page.locator(`[id="${id}"]`).locator('..').evaluate(element => element.getBoundingClientRect().width), 200, 'paper reading tabs use a consistent fixed width');
  await page.locator(`#md-tab-${ids.beta}`).click(); await note(page, 'beta');
  assert.equal(await page.locator('embedpdf-container').count(), 0, 'hidden PDF readers are flushed and unmounted');

  const firstEdit = '# Beta edited\n\nCtrl+S saved fixture.\n';
  await edit(page, firstEdit); await page.keyboard.press('Control+s'); await waitText(paths.beta, 'Ctrl+S saved fixture.');
  assert.equal(await readFile(paths.beta + '.bak', 'utf8'), originals.beta, 'the previous note version is backed up');
  const fastEditor = page.getByRole('textbox', { name: 'Markdown 笔记源码', exact: true });
  await fastEditor.press('Control+End'); await fastEditor.press('Enter');
  await fastEditor.pressSequentially('Immediate Ctrl+S tail'); await fastEditor.press('Control+s');
  await waitText(paths.beta, 'Immediate Ctrl+S tail');
  await edit(page, '# Beta edited\n\nSave before external open fixture.\n');
  await page.getByRole('button', { name: '默认软件打开', exact: true }).click();
  await waitText(paths.beta, 'Save before external open fixture.');
  await waitOpened(app, [paths.alpha, paths.beta]);
  assert.deepEqual(await app.evaluate(() => (globalThis as any).noteOpened), [paths.alpha, paths.beta], 'default-software opening first saves the current draft');
  const navigationEdit = '# Beta edited\n\nNavigation saves fixture.\n';
  await edit(page, navigationEdit); await page.getByRole('button', { name: '个人首页', exact: true }).click();
  await page.getByRole('main', { name: '个人首页', exact: true }).waitFor(); await waitText(paths.beta, 'Navigation saves fixture.');
  await page.locator(`#md-tab-${ids.beta}`).click(); await note(page, 'beta');
  await edit(page, '# Beta edited\n\nClosing tab saves fixture.\n');
  await page.locator(`#md-tab-${ids.beta}`).locator('..').getByRole('button', { name: /关闭/ }).click();
  await page.locator(`#md-tab-${ids.beta}`).waitFor({ state: 'detached' }); await waitText(paths.beta, 'Closing tab saves fixture.');

  await openListNote(page, 'beta');
  const draft = '# Beta draft\n\nUnsaved conflict draft must survive.\n';
  await edit(page, draft);
  const external = '# External editor\n\nExternal change must not be overwritten.\n';
  await writeFile(paths.beta, external);
  await page.getByRole('button', { name: '保存笔记', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /外部|变化|冲突|重新读取/ }).first().waitFor();
  assert.equal(await readFile(paths.beta, 'utf8'), external);
  await page.getByRole('button', { name: '个人首页', exact: true }).click();
  await note(page, 'beta');
  assert.match(await page.getByRole('textbox', { name: 'Markdown 笔记源码', exact: true }).inputValue(), /Unsaved conflict draft must survive/, 'failed navigation preserves the local draft');
  assert.equal(await readFile(paths.beta, 'utf8'), external, 'conflict retry preserves external changes');
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  const reloadDialog = page.getByRole('dialog', { name: '重新读取笔记？', exact: true });
  await reloadDialog.waitFor();
  assert.equal(await reloadDialog.getByRole('button', { name: '取消', exact: true }).evaluate(element => document.activeElement === element), true, 'discard confirmation defaults to cancel');
  await page.keyboard.press('Escape');
  await reloadDialog.waitFor({ state: 'detached' });
  assert.match(await page.getByRole('textbox', { name: 'Markdown 笔记源码', exact: true }).inputValue(), /Unsaved conflict draft must survive/, 'canceling discard retains the draft');
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await reloadDialog.getByRole('button', { name: '放弃草稿并重新读取', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#markdown-note-panel')?.textContent?.includes('External change must not be overwritten.'));
  await edit(page, '# Beta merged\n\nNew edit after explicit reload.\n');
  await page.getByRole('button', { name: '保存笔记', exact: true }).click(); await waitText(paths.beta, 'New edit after explicit reload.');
  assert.equal(await readFile(paths.beta + '.bak', 'utf8'), external, 'save after reload backs up the external revision');
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await page.screenshot({ path: join(directory, 'markdown-note-saved.png'), fullPage: true });

  // Freeze and serialize a delayed reread against navigation, rather than
  // letting an older textarea save over the just-read external revision.
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown 笔记源码', exact: true }).waitFor();
  await edit(page, '# Stale draft explicitly discarded\n\nDo not resurrect this draft after reread.\n');
  const delayedExternal = '# Delayed external reload\n\nKeep the newly reread external revision.\n';
  await writeFile(paths.beta, delayedExternal);
  await app.evaluate(({ ipcMain }) => {
    const original = (ipcMain as any)._invokeHandlers.get('notes:document');
    (globalThis as any).noteDocumentHandler = original;
    const gate = new Promise<void>(resolveRead => { (globalThis as any).noteReloadRelease = resolveRead; });
    ipcMain.removeHandler('notes:document');
    ipcMain.handle('notes:document', async (event, ...args) => { await gate; return original(event, ...args); });
  });
  try {
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await page.getByRole('dialog', { name: '重新读取笔记？', exact: true }).getByRole('button', { name: '放弃草稿并重新读取', exact: true }).click();
    await page.locator('.note-reload-overlay').waitFor();
    const frozenEditor = page.getByRole('textbox', { name: 'Markdown 笔记源码', exact: true, includeHidden: true });
    assert.ok(await frozenEditor.isDisabled() || !await frozenEditor.isEditable()
      || await frozenEditor.evaluate(element => Boolean(element.closest('[inert]'))), 'editor input is frozen throughout reload');
    await page.getByRole('button', { name: '个人首页', exact: true }).click();
    await page.locator('.reader-closing').waitFor();
    assert.equal(await page.locator('#markdown-note-panel').count(), 1, 'navigation waits for the active reread');
    await app.evaluate(() => (globalThis as any).noteReloadRelease());
    await page.getByRole('main', { name: '个人首页', exact: true }).waitFor();
    assert.equal(await readFile(paths.beta, 'utf8'), delayedExternal, 'navigation after reread does not overwrite external content with the old editor text');
  } finally {
    await app.evaluate(({ ipcMain }) => {
      (globalThis as any).noteReloadRelease();
      ipcMain.removeHandler('notes:document'); ipcMain.handle('notes:document', (globalThis as any).noteDocumentHandler);
    });
  }

  await page.locator(`#md-tab-${ids.alpha}`).click(); await note(page, 'alpha');
  await edit(page, '# Alpha modified\n\nQuit saves fixture.\n');
  requests.push(...await app.evaluate(() => (globalThis as any).noteRequests));
  await closeApp(app); await waitText(paths.alpha, 'Quit saves fixture.');
  assert.deepEqual(await readFile(paths.alpha + '.bak'), Buffer.from(originals.alpha), 'first real edit backs up the exact imported bytes');
  app = await launch(); page = await app.firstWindow(); await instrument();
  await openListNote(page, 'alpha');
  await page.locator('.note-markdown').getByText('Quit saves fixture.', { exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.screenshot({ path: join(directory, 'markdown-note-reopened.png'), fullPage: true });
  requests.push(...await app.evaluate(() => (globalThis as any).noteRequests));
  assert.deepEqual(requests, [], 'Markdown viewing/editing and formula assets remain fully local');
  assert.deepEqual(errors, []);
  for (const key of ['alpha', 'beta'] as const) assert.deepEqual(await readFile(sources[key]), Buffer.from(originals[key]), 'source notes remain unchanged');
  assert.deepEqual(await readFile(library.pdfPath(ids.alpha)), originalPdf, 'note edits never modify the original PDF');
  assert.deepEqual(await readFile(library.file), originalIndex, 'reading and editing note content does not change bibliographic metadata');
  console.log(JSON.stringify({ packaged, directory, result: 'passed', checks: 'in-app Markdown reading/editing via list, details, home and timeline; independent/reused paper tabs with PDF coexistence; exact no-op bytes; Ctrl+S, navigation, tab-close and app-quit save; backup and external-edit conflict handling; restart, source/PDF/index preservation; local assets and inert HTML' }));
} catch (error) {
  if (!page.isClosed()) { await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }); console.log(await page.locator('body').innerText()); }
  throw error;
} finally { await closeApp(app); }
