// Exercise the built renderer with an in-memory API. No personal library is opened.
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const sharedId = 'a'.repeat(64), undatedId = 'b'.repeat(64), uniqueId = 'c'.repeat(64);

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}
const card = (page, trackId, paperId) => page.locator(`[data-timeline-id="${trackId}"] [data-paper-id="${paperId}"]`);
async function centerCard(page, trackId, paperId) {
  await card(page, trackId, paperId).evaluate(element => {
    const viewport = element.closest('.map-viewport');
    const rect = element.getBoundingClientRect(), view = viewport.getBoundingClientRect();
    viewport.scrollBy(rect.left - view.left - (view.width - rect.width) / 2, rect.top - view.top - (view.height - rect.height) / 2);
  });
  await settle(page);
}
async function assertVisible(page, trackId, paperId) {
  const visible = await card(page, trackId, paperId).evaluate(element => {
    const rect = element.getBoundingClientRect(), view = element.closest('.map-viewport').getBoundingClientRect();
    return rect.left >= view.left - 2 && rect.right <= view.right + 2 && rect.top >= view.top - 2 && rect.bottom <= view.bottom + 2;
  });
  assert.equal(visible, true, `opening details must keep ${paperId[0]} on ${trackId} in view`);
}
async function assertSelection(page, trackId, paperId) {
  await settle(page);
  await assertVisible(page, trackId, paperId);
  assert.deepEqual(await page.locator('.timeline-paper.selected').evaluateAll(elements => elements.map(element => ({
    paperId: element.dataset.paperId, trackId: element.closest('.timeline-lane').dataset.timelineId,
  }))), [{ paperId, trackId }], 'only the clicked occurrence should be selected');
  assert.equal(await page.getByLabel('恢复百分之百').innerText(), '100%', 'opening details must preserve zoom');
}
async function selectCard(page, trackId, paperId, keyboard = false) {
  await centerCard(page, trackId, paperId);
  const body = card(page, trackId, paperId).locator('.timeline-paper-body');
  if (keyboard) { await body.focus(); await body.press('Enter'); } else await body.click();
  await page.getByLabel('收起详情').waitFor();
  await assertSelection(page, trackId, paperId);
}
async function assertFocusInLane(page, trackId) {
  await settle(page);
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.timeline-lane')?.dataset.timelineId), trackId,
    'tag menu/dialog must return focus to its original lane');
}

(async () => {
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const file = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(dist + path.sep)) { response.writeHead(403).end(); return; }
      response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(await fs.readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  let browser;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    browser = await chromium.launch(process.env.PAPER_TIMELINE_BROWSER
      ? { executablePath: process.env.PAPER_TIMELINE_BROWSER, headless: true } : { channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ sharedId, undatedId, uniqueId }) => {
      const tags = [{ id: 'tag-a', text: '分组甲', color: '#BFE4C4' }, { id: 'tag-b', text: '分组乙', color: '#BDE4E6' }];
      const paper = (id, title, date, paperTags = tags) => ({ id, title, publicationDate: date, year: date ? 2025 : null,
        tags: structuredClone(paperTags), authors: ['测试作者'], venue: '', doi: '', arxivId: '', abstract: '', url: '',
        source: '手动', matchMethod: '', pdfHash: null, fileName: '', fileSize: 0, pageCount: 0,
        importedAt: '2026-09-29T00:00:00Z', status: 'matched', message: '', availableFiles: { pdf: false, md: false } });
      const state = { papers: [paper(sharedId, '两条时间线共有的论文', '2025'), paper(undatedId, '没有日期的共有论文', ''),
        paper(uniqueId, '仅在第二条时间线的论文', '2025', [tags[1]])], folders: [], storagePath: 'in-memory fixture',
        timelines: [{ id: 'first', tags: ['分组甲'], tagMode: 'all', configured: true, position: { x: 32, y: 275 } },
          { id: 'second', tags: ['分组乙'], tagMode: 'all', configured: true, position: { x: 1800, y: 2200 } }] };
      let listener = () => {};
      const emit = () => listener(structuredClone(state));
      window.paperApi = {
        getLibrary: async () => structuredClone(state), onLibraryChanged: callback => { listener = callback; return () => {}; },
        addTag: async (id, text, color) => { const tag = { id: crypto.randomUUID(), text, color }; state.papers.find(p => p.id === id).tags.push(tag); emit(); return tag; },
        updateTag: async (id, tagId, text, color) => { Object.assign(state.papers.find(p => p.id === id).tags.find(t => t.id === tagId), { text, color }); emit(); },
        deleteTag: async (id, tagId) => { const paper = state.papers.find(p => p.id === id); paper.tags = paper.tags.filter(t => t.id !== tagId); emit(); },
        deleteTimeline: async id => { state.timelines = state.timelines.filter(t => t.id !== id); emit(); },
      };
      localStorage.setItem('paper-timeline-view', 'timeline');
    }, { sharedId, undatedId, uniqueId });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await card(page, 'second', sharedId).waitFor();
    await settle(page);
    await page.getByLabel('恢复百分之百').click();
    await settle(page);

    await selectCard(page, 'second', sharedId);
    await page.getByRole('button', { name: '个人首页', exact: true }).click();
    await page.getByRole('button', { name: '打开文献库', exact: true }).click();
    await assertSelection(page, 'second', sharedId);
    await selectCard(page, 'first', sharedId); // Same paper ID, details already open.
    await selectCard(page, 'second', sharedId);
    await page.getByLabel('收起详情').click();
    await selectCard(page, 'second', sharedId);
    await selectCard(page, 'second', undatedId);
    await selectCard(page, 'second', uniqueId);
    await selectCard(page, 'second', sharedId, true);
    await page.setViewportSize({ width: 1050, height: 760 });
    await settle(page);
    await assertSelection(page, 'second', sharedId);

    const source = card(page, 'second', sharedId);
    await source.locator('.timeline-paper-body').click({ button: 'right' });
    await page.getByRole('menu', { name: '论文标签操作' }).press('Escape');
    await assertFocusInLane(page, 'second');
    await assertVisible(page, 'second', sharedId);

    await source.locator('.timeline-paper-body').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '添加标签', exact: true }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await assertFocusInLane(page, 'second');

    await source.locator('.timeline-paper-body').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '添加标签', exact: true }).click();
    await page.getByLabel('标签文字', { exact: true }).fill('位置回归测试');
    await page.getByRole('button', { name: '保存标签', exact: true }).click();
    await assertFocusInLane(page, 'second');
    await assertSelection(page, 'second', sharedId);
    assert.equal(await card(page, 'first', sharedId).locator('.paper-tag').filter({ hasText: '位置回归测试' }).count(), 1,
      'tags still belong to the shared paper, not to a single lane');

    await source.locator('.paper-tag').filter({ hasText: '位置回归测试' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除标签', exact: true }).click();
    const deleteDialog = page.getByRole('dialog', { name: '是否确定删除标签？', exact: true });
    await deleteDialog.getByRole('button', { name: '确认删除', exact: true }).click();
    await deleteDialog.waitFor({ state: 'hidden' });
    await assertFocusInLane(page, 'second');
    await assertSelection(page, 'second', sharedId);
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results/timeline-second-lane-details.png') });

    // Removing the active track must safely resolve any remaining occurrence.
    await centerCard(page, 'second', sharedId);
    await page.getByLabel('删除时间线 2', { exact: true }).click();
    await page.locator('[data-timeline-id="second"]').waitFor({ state: 'detached' });
    await settle(page);
    assert.equal(await page.locator('.timeline-paper.selected').count(), 1);
    assert.equal(await page.locator('.timeline-paper.selected').evaluate(el => el.closest('.timeline-lane').dataset.timelineId), 'first');
    assert.deepEqual(errors, []);
    console.log('PASS: duplicate-paper lane selection, details reopen, same-ID cross-lane switching, undated/unique papers, keyboard selection, window resize, context-menu/dialog focus, shared tag updates and removed-track recovery.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
