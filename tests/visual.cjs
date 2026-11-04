const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
const report = JSON.parse(fs.readFileSync('test-results/desktop-report.json', 'utf8'));
const data = path.resolve('.test-data', `simple-ui-${Date.now()}`);
fs.mkdirSync(data, { recursive: true });
fs.cpSync(report.storagePath, path.join(data, 'library'), { recursive: true });
const env = { ...process.env, PAPER_TIMELINE_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
(async () => {
  const app = await electron.launch({ executablePath: require('electron'), args: ['.'], env, cwd: root });
  try {
    const page = await app.firstWindow();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.waitForFunction(() => document.querySelectorAll('.paper-row').length === 6);
    await page.waitForFunction(() => !document.querySelector('.paper-row .status-queued, .paper-row .status-extracting, .paper-row .status-searching'), undefined, { timeout: 90000 });
    await page.locator('.paper-row').filter({ hasText: 'Driving on Registers' }).click();
    assert.equal(await page.locator('.sidebar, .import-zone, .library-summary').count(), 0);
    assert.equal(await page.getByRole('button', { name: '导入 PDF', exact: true }).count(), 1);
    assert.equal(await page.locator('.file-details').getAttribute('open'), null);
    await page.screenshot({ path: 'test-results/desktop-simple.png' });

    await page.getByLabel('搜索文献').fill('Learning Based MPC');
    assert.equal(await page.locator('.paper-row').count(), 1);
    assert.match(await page.locator('.detail-title').textContent(), /Learning Based MPC/);
    await page.locator('.field-source').filter({ hasText: 'PDF 提取' }).waitFor();
    await page.getByLabel('搜索文献').fill('no-such-paper-abcdef');
    assert.equal(await page.locator('.paper-row').count(), 0);
    await page.locator('.detail-placeholder').waitFor();
    await page.getByLabel('清空搜索').click();
    await page.getByLabel('文献筛选').selectOption('review');
    assert.equal(await page.locator('.paper-row').count(), 0);
    await page.getByLabel('文献筛选').selectOption('all');
    await page.locator('.paper-row').filter({ hasText: 'Driving on Registers' }).click();

    const duplicate = fs.readdirSync('../pdf').find(f => f.includes('Driving on Registers'));
    const duplicatePath = path.resolve('../pdf', duplicate);
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, duplicatePath);
    await page.getByRole('button', { name: '导入 PDF', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '重复文件已跳过' }).waitFor();
    await page.getByRole('button', { name: '关闭通知' }).click();
    await page.getByLabel('选择 PDF 文件').setInputFiles(duplicatePath);
    await page.getByRole('alert').filter({ hasText: '重复文件已跳过' }).waitFor();
    assert.equal(await page.locator('.paper-row').count(), 6);
    await page.getByRole('button', { name: '关闭通知' }).click();

    await page.getByLabel('更多操作').click();
    await page.getByRole('button', { name: '重新检索', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.menu-items').waitFor({ state: 'hidden' });
    await page.getByLabel('更多操作').click();
    await page.getByLabel('编辑元数据', { exact: true }).click();
    await page.getByLabel('标题', { exact: true }).fill('Driving on Registers — checked');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.detail-title').textContent(), 'Driving on Registers — checked');
    await page.getByLabel('更多操作').click();
    await page.getByLabel('编辑元数据', { exact: true }).click();
    await page.getByLabel('标题', { exact: true }).fill('Driving on Registers');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '关闭通知' }).click();

    await app.evaluate(({ shell }) => { shell.openPath = async file => { globalThis.openedPdf = file; return ''; }; shell.openExternal = async url => { globalThis.openedSource = url; }; });
    await page.getByRole('button', { name: '打开 PDF' }).click();
    assert.match(await app.evaluate(() => globalThis.openedPdf), /papers.*original\.pdf$/);
    await page.getByLabel('更多操作').click();
    await page.getByRole('button', { name: '查看来源', exact: true }).click();
    assert.match(await app.evaluate(() => globalThis.openedSource), /^https:\/\/arxiv.org\/abs\//);
    await page.getByText('文件信息', { exact: true }).click();
    await page.getByAltText('PDF 首页预览').waitFor({ state: 'visible' });
    await page.getByText('文件信息', { exact: true }).click();
    await page.locator('.detail-scroll').evaluate(el => { el.scrollTop = 0; });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 800));
    await page.screenshot({ path: 'test-results/desktop-simple-compact.png' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByLabel('更多操作').click();
    await page.getByLabel('编辑元数据', { exact: true }).click();
    await page.screenshot({ path: 'test-results/desktop-simple-edit.png' });
    const box = await page.getByRole('button', { name: '保存', exact: true }).boundingBox();
    assert.ok(box.y + box.height < (await page.evaluate(() => innerHeight)));
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
  const emptyEnv = { ...env, PAPER_TIMELINE_DATA: data + '-empty' };
  const empty = await electron.launch({ executablePath: require('electron'), args: ['.'], env: emptyEnv, cwd: root });
  try {
    const page = await empty.firstWindow();
    await page.getByRole('heading', { name: '导入你的第一篇论文' }).waitFor();
    await page.screenshot({ path: 'test-results/desktop-simple-empty.png' });
  } finally { await empty.close(); }
  console.log('PASS: simplified layout, search, filter, native import, duplicate File bridge, menu, editing, opening files/sources, compact layout and empty state.');
})().catch(e => { console.error(e); process.exitCode = 1; });
