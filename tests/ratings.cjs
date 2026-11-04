// Built renderer + in-memory API; never opens or edits a personal library.
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..'), dist = path.join(root, 'dist');
const id = 'a'.repeat(64);
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

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
    await page.addInitScript(id => {
      const paper = { id, title: 'Learning to Drive', authors: ['A very long author name', 'Second Author'], year: 2025,
        publicationDate: '2025', venue: '', doi: '', arxivId: '', abstract: '', url: '', source: '导入', matchMethod: '',
        pdfHash: null, fileName: '', fileSize: 0, pageCount: 0, importedAt: '2026-09-29T00:00:00Z',
        status: 'matched', message: '', availableFiles: { pdf: false, md: false },
        tags: [{ id: 'tag-a', text: '视觉-动作', color: '#9AD4D6' }] };
      const state = { papers: [paper, { ...paper, id: 'b'.repeat(64), title: 'A much longer paper title for comparison', rating: 2 }],
        folders: [], storagePath: 'in-memory fixture', timelines: [
          { id: 'first', tags: [], tagMode: 'all', configured: true, position: { x: 32, y: 275 } },
          { id: 'second', tags: [], tagMode: 'all', configured: true, position: { x: 1800, y: 2200 } },
        ] };
      let listener = () => {};
      window.ratingFixture = { failNext: false, calls: [] };
      window.paperApi = {
        getLibrary: async () => structuredClone(state),
        onLibraryChanged: callback => { listener = callback; return () => {}; },
        setRating: async (paperId, rating) => {
          window.ratingFixture.calls.push({ id: paperId, rating });
          if (window.ratingFixture.failNext) { window.ratingFixture.failNext = false; throw new Error('测试保存失败'); }
          const item = state.papers.find(p => p.id === paperId);
          if (rating === null) delete item.rating; else item.rating = rating;
          listener(structuredClone(state));
        },
      };
      localStorage.setItem('paper-timeline-view', 'list');
      localStorage.setItem('paper-timeline-column-widths-v1', JSON.stringify({ title: 572, tags: 296,
        authors: 118, date: 103, venue: 126, pdf: 48, note: 66, status: 34 }));
    }, id);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const row = page.locator(`.paper-row[data-paper-id="${id}"]`);
    await row.click();
    const editor = page.getByRole('region', { name: '论文评分' });
    await editor.getByText('未评分', { exact: true }).waitFor();
    assert.deepEqual(await page.locator('th').evaluateAll(els => els.map(el => el.dataset.column)),
      ['title', 'tags', 'rating', 'citations', 'authors', 'date', 'venue', 'pdf', 'note', 'status']);
    assert.equal(await page.locator('th[data-column="title"]').evaluate(el => Math.round(el.getBoundingClientRect().width)), 572);
    assert.equal(await page.locator('th[data-column="tags"]').evaluate(el => Math.round(el.getBoundingClientRect().width)), 296);
    assert.equal(await page.locator('th[data-column="citations"]').evaluate(el => Math.round(el.getBoundingClientRect().width)), 96);
    assert.equal(await page.locator('.table-tag-list').first().evaluate(el => getComputedStyle(el).flexWrap), 'nowrap');
    for (const rating of [1, 5, 3]) {
      await editor.getByRole('button', { name: `评为 ${rating} 星`, exact: true }).click();
      await row.getByRole('img', { name: `${rating} 星`, exact: true }).waitFor();
      assert.equal(await row.locator('.rating-stars svg').count(), rating);
    }
    await page.evaluate(() => { window.ratingFixture.failNext = true; });
    await editor.getByRole('button', { name: '评为 4 星', exact: true }).click();
    await editor.getByRole('alert').waitFor();
    assert.equal(await row.locator('.rating-stars svg').count(), 3, 'failed saves must retain the previous display');
    await editor.getByRole('button', { name: '评为 5 星', exact: true }).focus();
    await page.keyboard.press('Enter');
    await row.getByRole('img', { name: '5 星', exact: true }).waitFor();
    assert.equal(await editor.getByRole('alert').count(), 0);
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
    await row.locator('.table-rating').scrollIntoViewIfNeeded();
    await page.mouse.move(700, 100);
    await page.screenshot({ path: path.join(root, 'test-results/ratings-list.png') });
    await editor.getByRole('button', { name: '清除评分', exact: true }).click();
    await row.getByLabel('未评分', { exact: true }).waitFor();
    await page.getByRole('button', { name: '时间线', exact: true }).click();
    await page.getByLabel('恢复百分之百').click();
    const card = page.locator(`[data-timeline-id="second"] [data-paper-id="${id}"]`);
    await card.evaluate(el => {
      const viewport = el.closest('.map-viewport'), view = viewport.getBoundingClientRect(), rect = el.getBoundingClientRect();
      viewport.scrollBy(rect.left - view.left - (view.width - rect.width) / 2, rect.top - view.top - (view.height - rect.height) / 2);
    });
    await settle(page);
    await card.locator('.timeline-paper-body').click();
    await editor.waitFor();
    const before = await card.locator('.timeline-paper-body').boundingBox();
    await editor.getByRole('button', { name: '评为 5 星', exact: true }).click();
    await card.getByRole('img', { name: '5 星', exact: true }).waitFor();
    await settle(page);
    assert.equal(await page.locator(`[data-paper-id="${id}"] .rating-stars`).count(), 2, 'all occurrences share the rating');
    assert.equal(await page.locator('.timeline-paper.selected').evaluate(el => el.closest('.timeline-lane').dataset.timelineId), 'second');
    const geometry = await card.evaluate(el => {
      const body = el.querySelector('.timeline-paper-body').getBoundingClientRect();
      const stars = el.querySelector('.rating-stars').getBoundingClientRect();
      const authors = el.querySelector('.map-card-authors').getBoundingClientRect();
      const view = el.closest('.map-viewport').getBoundingClientRect();
      return { starsInside: stars.right <= body.right && stars.bottom <= body.bottom,
        afterAuthors: stars.left >= authors.right, aligned: Math.abs((stars.top + stars.height / 2) - (authors.top + authors.height / 2)) < 1,
        visible: body.left >= view.left && body.right <= view.right && body.top >= view.top && body.bottom <= view.bottom,
        width: body.width, height: body.height, starFill: getComputedStyle(el.querySelector('.rating-stars svg')).fill };
    });
    assert.ok(geometry.starsInside && geometry.afterAuthors && geometry.aligned && geometry.visible, JSON.stringify(geometry));
    assert.equal(geometry.width, before.width); assert.equal(geometry.height, before.height);
    assert.equal(geometry.starFill, 'rgb(246, 199, 68)');
    await page.screenshot({ path: path.join(root, 'test-results/ratings-timeline.png') });
    await editor.getByRole('button', { name: '清除评分', exact: true }).click();
    await settle(page);
    assert.equal(await page.locator(`[data-paper-id="${id}"] .rating-stars`).count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: rating creation/edit/clear, error recovery, keyboard input, yellow stars, retained column widths, single-line tags, duplicate timeline updates and stable frame/lane.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
