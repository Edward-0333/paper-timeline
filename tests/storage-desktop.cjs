const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const execute = require('node:util').promisify(execFile);
const root = path.resolve(__dirname, '..');
const storage = path.join(root, 'library');
const before = fs.readFileSync(path.join(storage, 'library.json'), 'utf8');
const records = JSON.parse(before).papers;
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.PAPER_TIMELINE_DATA;
(async () => {
  // Launch from outside the project to verify that the working directory is irrelevant.
  const app = await electron.launch({ executablePath: path.join(root, 'release/win-unpacked/Paper Timeline.exe'), env, cwd: path.dirname(root) });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.paperApi && !document.querySelector('.primary-button')?.disabled);
    const library = await page.evaluate(() => window.paperApi.getLibrary());
    assert.equal(await page.locator('.app-header').count(), 1);
    assert.equal(await page.locator('.sidebar, .import-zone').count(), 0);
    assert.equal(library.storagePath, storage);
    const cli = await execute(path.join(root, 'release/win-unpacked/Paper Timeline.exe'), [path.join(root, 'release/win-unpacked/ai/cli.cjs'), 'call', 'app.status'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, cwd: path.dirname(root), windowsHide: true, timeout: 15000 });
    const status = JSON.parse(cli.stdout);
    assert.equal(status.ok, true); assert.equal(status.result.storagePath, storage); assert.equal(status.result.total, records.length);
    assert.deepEqual(library.papers.map(p => p.id), records.map(p => p.id));
    await page.getByRole('button', { name: '列表', exact: true }).click();
    assert.equal(await page.getByRole('navigation', { name: '文献文件夹' }).count(), 1);
    assert.equal(await page.locator('.paper-row').count(), records.length);
    await page.screenshot({ path: path.join(root, 'test-results/desktop-three-columns-current.png') });
    await app.evaluate(({ shell }) => { shell.openPath = async file => { globalThis.openedStoragePath = file; return ''; }; });
    await page.getByRole('button', { name: /本地文献库/ }).click();
    assert.equal(await app.evaluate(() => globalThis.openedStoragePath), storage);
    if (records.length) {
      await page.getByRole('button', { name: '打开 PDF' }).click();
      assert.ok((await app.evaluate(() => globalThis.openedStoragePath)).startsWith(path.join(storage, 'papers')));
    }
    assert.equal(fs.readFileSync(path.join(storage, 'library.json'), 'utf8'), before);
    await page.getByRole('button', { name: '时间线', exact: true }).click();
    assert.equal(await page.locator('.timeline-paper').count(), records.length);
    if (records.length) await page.getByLabel('适应画布', { exact: true }).click();
    await page.screenshot({ path: path.join(root, 'test-results/desktop-mindmap-current.png') });
    if (records.length) {
      await page.locator('.timeline-paper').first().click();
      await page.getByLabel('收起详情').click();
    }
    assert.equal(fs.readFileSync(path.join(storage, 'library.json'), 'utf8'), before);
    console.log(JSON.stringify({ library: storage, papers: records.length, projectStorage: 'verified', aiDefaultLibrary: 'verified', libraryButton: 'verified', copiedPdfPath: 'verified', records: 'unchanged' }, null, 2));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
