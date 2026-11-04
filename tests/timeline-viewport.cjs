// Built renderer with an in-memory library. All preferences live in an isolated
// browser context; no personal library or desktop preferences are touched.
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..'), dist = path.join(root, 'dist');
const key = 'paper-timeline-viewport-v1:f:/fixtures/library-a';
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));

async function snapshot(page) {
  await settle(page);
  return page.locator('.map-viewport').evaluate(viewport => {
    const view = viewport.getBoundingClientRect();
    const card = viewport.querySelector('[data-timeline-id="second"] .timeline-paper-body').getBoundingClientRect();
    const zoom = new DOMMatrix(getComputedStyle(viewport.querySelector('.map-scene')).transform).a;
    // A stable paper relative to the viewport center tests the restored location
    // independently of the preference serializer or the canvas scroll offsets.
    return { zoom, dx: card.left - view.left - viewport.clientWidth / 2,
      dy: card.top - view.top - viewport.clientHeight / 2 };
  });
}
async function assertView(page, expected, label) {
  const actual = await snapshot(page);
  assert.ok(Math.abs(actual.zoom - expected.zoom) < 0.00001, `${label}: zoom ${actual.zoom} != ${expected.zoom}`);
  assert.ok(Math.abs(actual.dx - expected.dx) < 3 && Math.abs(actual.dy - expected.dy) < 3,
    `${label}: location ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
async function installFixture(context) {
  await context.addInitScript(() => {
    if (location.protocol !== 'http:') return;
    const papers = Array.from({ length: 12 }, (_, index) => ({ id: String(index).padStart(64, '0'),
      title: index % 2 ? 'A longer paper title with adaptive card dimensions and a coloured tag' : `Paper ${index}`,
      authors: ['Test Author'], publicationDate: String(2000 + index), year: 2000 + index,
      venue: '', doi: '', arxivId: '', abstract: '', url: '', source: '导入', matchMethod: '', pdfHash: null,
      fileName: '', fileSize: 0, pageCount: 0, importedAt: '', status: 'matched', message: '',
      tags: [{ id: `tag-${index}`, text: '测试标签', color: '#AADDCC' }], availableFiles: { pdf: false, md: false } }));
    const library = new URL(location.href).searchParams.get('library') || 'a';
    const state = { papers, folders: [], storagePath: library === 'a' ? 'F:\\Fixtures\\Library-A' : 'F:/fixtures/library-b',
      timelines: [{ id: 'first', tags: [], tagMode: 'all', configured: true, position: { x: -300, y: -220 } },
        { id: 'second', tags: ['测试标签'], tagMode: 'all', configured: true, position: { x: 1800, y: 1900 } }] };
    let listener = () => {};
    window.paperApi = { getLibrary: async () => structuredClone(state),
      onLibraryChanged: callback => { listener = callback; return () => {}; },
      setRating: async (id, rating) => { state.papers.find(p => p.id === id).rating = rating; listener(structuredClone(state)); },
    };
    if (!localStorage.getItem('paper-timeline-view')) localStorage.setItem('paper-timeline-view', 'timeline');
  });
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
  const url = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch(process.env.PAPER_TIMELINE_BROWSER
      ? { executablePath: process.env.PAPER_TIMELINE_BROWSER, headless: true } : { channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await installFixture(context);
    let page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.locator('[data-timeline-id="second"] .timeline-paper-body').first().waitFor();
    await page.waitForFunction(() => Number(document.querySelector('.zoom-value')?.textContent.replace('%', '')) < 100);
    const initialFit = await snapshot(page);
    await page.getByLabel('恢复百分之百').click();
    await page.getByLabel('放大', { exact: true }).click();
    await page.getByLabel('放大', { exact: true }).click();
    await page.locator('[data-timeline-id="second"] .timeline-paper-body').first().evaluate(el => {
      const viewport = el.closest('.map-viewport'), rect = el.getBoundingClientRect(), view = viewport.getBoundingClientRect();
      viewport.scrollBy(rect.left - view.left - 350, rect.top - view.top - 320);
    });
    const preferred = await snapshot(page);
    assert.ok(preferred.zoom > 1);
    await page.getByRole('button', { name: '列表', exact: true }).click();
    await page.getByRole('button', { name: '时间线', exact: true }).click();
    await assertView(page, preferred, 'switch views');
    await page.getByRole('button', { name: '个人首页', exact: true }).click();
    await page.getByRole('main', { name: '个人首页' }).waitFor();
    await page.getByRole('button', { name: '打开文献库', exact: true }).click();
    await assertView(page, preferred, 'return from personal home');

    // Flush a scroll immediately followed by unmount in the very same frame.
    const quick = await page.locator('.map-viewport').evaluate(el => {
      el.scrollBy(85, 65);
      const rect = el.getBoundingClientRect(), card = el.querySelector('[data-timeline-id="second"] .timeline-paper-body').getBoundingClientRect();
      const result = { zoom: new DOMMatrix(getComputedStyle(el.querySelector('.map-scene')).transform).a,
        dx: card.left - rect.left - el.clientWidth / 2, dy: card.top - rect.top - el.clientHeight / 2 };
      [...document.querySelectorAll('.view-switch button')].find(button => button.textContent === '列表').click();
      return result;
    });
    await page.getByRole('button', { name: '时间线', exact: true }).click();
    await assertView(page, quick, 'immediate unmount');
    await page.reload();
    await page.locator('[data-timeline-id="second"] .timeline-paper-body').first().waitFor();
    await assertView(page, quick, 'reload');

    // A larger window should keep the same world point at its center.
    await page.close({ runBeforeUnload: true });
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1660, height: 1000 });
    await page.goto(url);
    await page.locator('[data-timeline-id="second"] .timeline-paper-body').first().waitFor();
    await assertView(page, quick, 'reopened window with different dimensions');

    // Persisted preferences survive a fresh browser context (desktop restart).
    await page.goto('about:blank');
    const storageState = await context.storageState();
    const restarted = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState });
    await installFixture(restarted);
    const restored = await restarted.newPage();
    restored.on('pageerror', error => errors.push(error.message));
    await restored.goto(url);
    await restored.locator('[data-timeline-id="second"] .timeline-paper-body').first().waitFor();
    await assertView(restored, quick, 'fresh context');

    // Different libraries must not share the saved zoom or position.
    await restored.goto(url + '/?library=b');
    await restored.locator('[data-timeline-id="second"] .timeline-paper-body').first().waitFor();
    await restored.waitForFunction(() => Number(document.querySelector('.zoom-value')?.textContent.replace('%', '')) < 100);
    await assertView(restored, initialFit, 'new library fits independently');
    await restored.goto(url);
    await restored.locator('[data-timeline-id="second"] .timeline-paper-body').first().waitFor();
    await assertView(restored, quick, 'return to original library');

    // Explicit fit still works and becomes the next remembered view.
    await restored.getByLabel('适应画布', { exact: true }).click();
    const fitted = await snapshot(restored);
    assert.ok(fitted.zoom < quick.zoom);
    await restored.reload();
    await restored.locator('[data-timeline-id="second"] .timeline-paper-body').first().waitFor();
    await assertView(restored, fitted, 'manual fit is remembered');

    // Malformed/unusable preferences fall back to a usable fit.
    await restored.getByRole('button', { name: '列表', exact: true }).click();
    await restored.evaluate(key => localStorage.setItem(key, '{broken'), key);
    await restored.getByRole('button', { name: '时间线', exact: true }).click();
    await assertView(restored, initialFit, 'invalid preference fallback');
    await restored.getByRole('button', { name: '列表', exact: true }).click();
    await restored.evaluate(key => localStorage.setItem(key, JSON.stringify({ zoom: 0, centerX: 0, centerY: 0 })), key);
    await restored.getByRole('button', { name: '时间线', exact: true }).click();
    await assertView(restored, initialFit, 'invalid scale fallback');
    assert.deepEqual(errors, []);
    console.log('PASS: zoom and world position survive view switches, immediate unmount, reload, reopened/resized windows and a fresh context; libraries remain independent, explicit fit and invalid-preference fallback work.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
