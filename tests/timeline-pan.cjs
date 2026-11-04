// Real pointer gestures on an isolated renderer fixture; never opens the user's library.
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..'), dist = path.join(root, 'dist');
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function snapshot(page) {
  await settle(page);
  return page.locator('.map-viewport').evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop,
    zoom: new DOMMatrix(getComputedStyle(el.querySelector('.map-scene')).transform).a }));
}
async function center(page, locator) {
  await locator.evaluate(el => {
    const viewport = el.closest('.map-viewport');
    const rect = el.getBoundingClientRect(), view = viewport.getBoundingClientRect();
    viewport.scrollBy(rect.left - view.left - (viewport.clientWidth - rect.width) / 2,
      rect.top - view.top - (viewport.clientHeight - rect.height) / 2);
  });
  await settle(page);
}
async function dragAt(page, point, button = 'middle', dx = -76, dy = -48) {
  await page.mouse.move(point.x, point.y);
  const before = await snapshot(page);
  await page.mouse.down({ button });
  await page.mouse.move(point.x + dx, point.y + dy, { steps: 5 });
  await page.mouse.up({ button });
  const after = await snapshot(page);
  return { before, after };
}
async function checkPan(page, locator, label) {
  await center(page, locator);
  const box = await locator.boundingBox();
  const { before, after } = await dragAt(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  assert.equal(after.left, before.left + 76, label + ': horizontal pan');
  assert.equal(after.top, before.top + 48, label + ': vertical pan');
  assert.equal(after.zoom, before.zoom, label + ': preserves zoom');
  assert.equal(await page.locator('.map-viewport.panning').count(), 0, label + ': releases capture');
  assert.equal(await page.locator('.detail-panel, .pdf-reader, .md-reader').count(), 0, label + ': no details or file opens');
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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch(process.env.PAPER_TIMELINE_BROWSER
      ? { executablePath: process.env.PAPER_TIMELINE_BROWSER, headless: true } : { channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const paper = (id, title, date) => ({ id: id.repeat(64), title, publicationDate: date, year: Number(date),
        authors: ['测试作者'], venue: '', doi: '', arxivId: '', abstract: '', url: '', source: '手动', matchMethod: '',
        pdfHash: id.repeat(64), fileName: title + '.pdf', fileSize: 100, pageCount: 1, importedAt: '', status: 'matched', message: '',
        markdownNote: { fileName: 'notes.md', sourceHash: id.repeat(64), attachedAt: '' },
        availableFiles: { pdf: true, md: true }, tags: [{ id: 'tag-' + id, text: '标签', color: '#BFE4C4' }] });
      const state = { papers: [paper('a', '短论文', '2024'), paper('b', '第二篇论文', '2025')], folders: [], storagePath: 'fixture/timeline-middle',
        timelines: [{ id: 'first', tags: [], tagMode: 'all', configured: true, position: { x: 32, y: 275 } }] };
      let listener = () => {};
      const emit = () => listener(structuredClone(state));
      window.fixture = state;
      window.mutations = [];
      window.paperApi = {
        getLibrary: async () => structuredClone(state), onLibraryChanged: callback => { listener = callback; return () => {}; },
        moveTag: async (id, tagId, position) => { window.mutations.push('tag'); state.papers.find(p => p.id === id).tags.find(t => t.id === tagId).position = position; emit(); },
        moveFileTag: async (id, kind, position) => { window.mutations.push('file-tag'); const paper = state.papers.find(p => p.id === id); paper.fileTagPositions ??= {}; paper.fileTagPositions[kind] = position; emit(); },
        updateTimeline: async (id, changes) => { window.mutations.push('timeline'); Object.assign(state.timelines.find(t => t.id === id), changes); emit(); },
        deleteTimeline: async () => { window.mutations.push('delete'); },
      };
      localStorage.setItem('paper-timeline-view', 'timeline');
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    const viewport = page.locator('.map-viewport');
    const paper = page.locator('.timeline-paper').first();
    await paper.waitFor(); await settle(page);
    await page.getByLabel('恢复百分之百').click(); await settle(page);
    const initial = await page.evaluate(() => structuredClone(window.fixture));

    // Blank area and every interactive item use exactly the same middle-button gesture.
    await viewport.evaluate(el => el.scrollTo(160, 160)); await settle(page);
    const view = await viewport.boundingBox();
    const blank = { x: view.x + 100, y: view.y + 70 };
    let motion = await dragAt(page, blank);
    assert.equal(motion.after.left, motion.before.left + 76);
    assert.equal(motion.after.top, motion.before.top + 48);
    motion = await dragAt(page, blank, 'left');
    assert.deepEqual(motion.after, motion.before, 'left drag on blank no longer pans');
    for (const [selector, label] of [
      ['.timeline-paper-body', 'paper frame'], ['.paper-tag', 'custom tag'],
      ['[data-file-kind="pdf"]', 'PDF tag'], ['[data-file-kind="md"]', 'MD tag'],
    ]) await checkPan(page, paper.locator(selector), label);
    for (const [selector, label] of [
      ['.timeline-lane-grip', 'lane handle'], ['.timeline-tag-filter-trigger', 'filter frame'], ['.timeline-lane-delete', 'delete control'],
    ]) await checkPan(page, page.locator(selector), label);
    assert.deepEqual(await page.evaluate(() => window.fixture), initial, 'middle pan never mutates library objects');
    assert.deepEqual(await page.evaluate(() => window.mutations), []);
    assert.equal(await page.getByRole('dialog', { name: '按标签筛选', exact: true }).count(), 0);

    // Capture remains active outside the viewport and always clears on release/cancel.
    await center(page, paper.locator('.timeline-paper-body'));
    let box = await paper.locator('.timeline-paper-body').boundingBox();
    await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down({ button: 'middle' });
    await page.mouse.move(10, 15); await page.mouse.up({ button: 'middle' });
    assert.equal(await page.locator('.map-viewport.panning').count(), 0);
    const released = await snapshot(page);
    await page.mouse.move(100, 100); assert.deepEqual(await snapshot(page), released);
    for (const cancel of ['escape', 'blur']) {
      await center(page, paper.locator('.timeline-paper-body'));
      box = await paper.locator('.timeline-paper-body').boundingBox();
      await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down({ button: 'middle' });
      if (cancel === 'escape') await page.keyboard.press('Escape');
      else await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      const cancelled = await snapshot(page);
      await page.mouse.move(box.x - 45, box.y - 30); await page.mouse.up({ button: 'middle' });
      assert.deepEqual(await snapshot(page), cancelled, cancel + ' ends panning');
      assert.equal(await page.locator('.map-viewport.panning').count(), 0);
    }

    // Existing left-button tag and lane moves continue to persist, without panning.
    const tag = paper.locator('.paper-tag');
    await center(page, paper.locator('.timeline-paper-body'));
    const beforeTag = await snapshot(page), tagBox = await tag.boundingBox(), frame = await paper.locator('.timeline-paper-body').boundingBox();
    await page.mouse.move(tagBox.x + tagBox.width / 2, tagBox.y + tagBox.height / 2);
    await page.mouse.down(); await page.mouse.move(frame.x + frame.width / 2, frame.y - tagBox.height / 2 + 1, { steps: 5 }); await page.mouse.up();
    await page.waitForFunction(() => window.mutations.includes('tag'));
    assert.deepEqual(await snapshot(page), beforeTag, 'left tag drag never pans canvas');
    assert.equal(await tag.getAttribute('data-tag-side'), 'top');
    const handle = page.locator('.timeline-lane-grip'); await center(page, handle);
    const oldPosition = await page.evaluate(() => structuredClone(window.fixture.timelines[0].position));
    box = await handle.boundingBox();
    await dragAt(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 'left', 50, 30);
    await page.waitForFunction(() => window.mutations.includes('timeline'));
    assert.deepEqual(await page.evaluate(() => window.fixture.timelines[0].position), { x: oldPosition.x + 50, y: oldPosition.y + 30 });
    assert.equal(await page.getByRole('dialog', { name: '按标签筛选', exact: true }).count(), 0);

    await center(page, paper.locator('.timeline-paper-body'));
    await paper.locator('.timeline-paper-body').click();
    await page.getByLabel('收起详情').waitFor();
    assert.equal(await page.locator('.detail-title').innerText(), '短论文', 'left click still opens details');
    await page.getByLabel('收起详情').click();
    const remembered = await snapshot(page);
    await page.getByRole('button', { name: '列表', exact: true }).click();
    await page.getByRole('button', { name: '时间线', exact: true }).click();
    const restored = await snapshot(page);
    assert.ok(Math.abs(restored.left - remembered.left) <= 1 && Math.abs(restored.top - remembered.top) <= 1, 'panned view restored after view switch');
    assert.equal(restored.zoom, remembered.zoom);
    assert.deepEqual(errors, []);
    console.log('PASS: middle pan over blank, paper, tags, PDF/MD tags and lane controls; no accidental opens/mutations; outside capture, Escape/blur cleanup; left tag/lane drags and selection; remembered viewport.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
