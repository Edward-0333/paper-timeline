const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env = { ...process.env, PAPER_TIMELINE_DATA: path.resolve('.test-data', `packaged-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
(async () => {
  const app = await electron.launch({ executablePath: path.resolve('release/win-unpacked/Paper Timeline.exe'), env, cwd: process.cwd() });
  try {
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    const page = await app.firstWindow();
    await page.waitForFunction(() => !document.querySelector('.primary-button')?.disabled && window.paperApi);
    await page.getByRole('button', { name: '时间线', exact: true }).click();
    const files = fs.readdirSync('../pdf').filter(f => /Driving on Registers|Learning Based MPC/.test(f)).map(f => path.resolve('../pdf', f));
    await page.getByLabel('选择 PDF 文件').setInputFiles(files);
    await page.waitForFunction(n => { const rows = [...document.querySelectorAll('.timeline-paper')]; return rows.length === n && rows.every(row => !row.querySelector('.status-queued, .status-extracting, .status-searching')); }, files.length, { timeout: 120000 });
    const library = await page.evaluate(() => window.paperApi.getLibrary());
    assert.equal(library.papers.filter(p => p.status === 'matched').length, 2, JSON.stringify(library.papers.map(p => p.message)));
    assert.ok(library.papers.every(p => p.thumbnail?.startsWith('data:image/png')));
    assert.equal(library.papers.find(p => p.source === 'arXiv').publicationDate, '2026-01-08');
    assert.match(library.papers.find(p => p.source === 'Crossref').publicationDate, /^2025(?:-\d{2}){0,2}$/);
    assert.match(await page.locator('.timeline-paper').first().innerText(), /Learning Based MPC/);
    await page.getByLabel('适应画布', { exact: true }).click();
    await page.screenshot({ path: 'test-results/packaged-mindmap.png' });
    await page.locator('.timeline-paper').first().click();
    if (await page.getByRole('button', { name: '关闭通知' }).count()) await page.getByRole('button', { name: '关闭通知' }).click();
    await page.getByLabel('收起详情').click();
    fs.writeFileSync('test-results/packaged-timeline-report.json', JSON.stringify(library.papers.map(({ title, source, year, publicationDate }) => ({ title, source, year, publicationDate })), null, 2));
    console.log('Packaged Windows executable passed: timeline PDF import, isolated worker, thumbnails, arXiv first-submission date, Crossref publication date and chronological rendering.');
  } finally { await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
