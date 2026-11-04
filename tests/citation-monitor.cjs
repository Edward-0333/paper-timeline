// Browser fixture only: no access to the real library or external citation APIs.
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..'), dist = path.join(root, 'dist');
(async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const file = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(dist + path.sep)) return res.writeHead(403).end();
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const paper = { id: 'a'.repeat(64), title: 'Learning to Drive with Visual Representations', authors: ['Example Author'],
        year: 2025, publicationDate: '2025-06', venue: 'Research fixture', doi: '10.1234/fixture', arxivId: '', abstract: 'A local UI fixture.',
        url: '', source: '手动', matchMethod: '用户已核对', pdfHash: null, fileName: '', fileSize: 0, pageCount: 0,
        importedAt: '2026-10-20T00:00:00Z', status: 'matched', message: '', tags: [{ id: 'tag', text: '视觉学习', color: '#9AD4D6' }], rating: 4 };
      const state = { papers: [paper, { ...paper, id: 'b'.repeat(64), title: 'Another paper' }], folders: [], timelines: [], storagePath: 'UI fixture' };
      let listener = () => {};
      window.fixture = { state, fail: false, opened: [] };
      window.paperApi = {
        cloudStatus: async () => ({ signedIn: false, connected: false, syncing: false, pending: 0, legacyPending: 0, newCitations: 0 }),
        onCloudChanged: () => () => {},
        cloudLogin: async (server, username, password) => {
          if (password !== 'fixture') throw Error('测试登录失败');
          window.paperApi.cloudStatus = async () => ({ server, user: { id: '1', username }, signedIn: true, connected: true, syncing: false,
            pending: 0, legacyPending: 0, newCitations: 3, lastSyncAt: '2026-10-21T01:00:00Z',
            overview: { monitored: 2, queued: 1, failed: 1, lastServerFetchAt: '2026-10-21T00:50:00Z' } });
        },
        getLibrary: async () => structuredClone(state),
        onLibraryChanged: callback => { listener = callback; return () => {}; },
        setCitationMonitoring: async (id, enabled) => {
          if (window.fixture.fail) { window.fixture.fail = false; throw Error('测试保存失败'); }
          const p = state.papers.find(p => p.id === id);
          p.citationMonitoring = enabled;
          p.citationMonitor = { status: enabled ? 'success' : 'idle', count: 23, lastSuccessAt: '2026-10-20T01:20:00Z',
            nextCheckAt: enabled ? '2026-10-20T01:30:00Z' : undefined };
          listener(structuredClone(state));
        },
        openCitationDirectory: async id => { window.fixture.opened.push(id); },
      };
      localStorage.setItem('paper-timeline-view', 'list');
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('main', { name: '个人首页' }).waitFor();
    assert.equal(await page.locator('.home-metrics section').first().locator('strong').textContent(), '2');
    await page.getByLabel('服务器地址').fill('https://monitor.test');
    await page.getByLabel('用户名 / 邮箱').fill('Researcher');
    await page.getByLabel('密码', { exact: true }).fill('fixture');
    await page.getByRole('button', { name: '登录并连接' }).click();
    await page.getByText('Researcher，你好').waitFor();
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results/cloud-home.png') });
    await page.setViewportSize({ width: 1050, height: 760 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(root, 'test-results/cloud-home-compact.png') });
    await page.setViewportSize({ width: 1440, height: 940 });
    await page.getByRole('button', { name: '打开文献库', exact: true }).click();
    await page.locator('.paper-row[data-paper-id="' + 'a'.repeat(64) + '"]').click();
    const panel = page.getByRole('region', { name: '引用监控', exact: true });
    const toggle = panel.getByRole('switch', { name: '引用监控开关' });
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'test-results/citation-monitor-off.png') });
    await toggle.click();
    await panel.getByText('已保存 23 篇').waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await panel.getByText('下次检查：', { exact: false }).waitFor();
    await panel.getByRole('button', { name: '数据目录' }).click();
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), ['a'.repeat(64)]);
    await page.screenshot({ path: path.join(root, 'test-results/citation-monitor-on.png') });
    await page.locator('.paper-row[data-paper-id="' + 'b'.repeat(64) + '"]').click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'switches are per paper');
    await page.locator('.paper-row[data-paper-id="' + 'a'.repeat(64) + '"]').click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await page.evaluate(() => { window.fixture.fail = true; });
    await toggle.click(); await panel.getByRole('alert').waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'failed saves preserve checked state');
    await toggle.focus(); await page.keyboard.press('Space');
    await panel.getByText('监控已关闭', { exact: true }).waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    assert.equal(await panel.getByText('已保存 23 篇').count(), 1);
    await page.setViewportSize({ width: 1050, height: 760 });
    await panel.scrollIntoViewIfNeeded();
    const bounds = await panel.boundingBox(), sw = await toggle.boundingBox();
    assert.ok(sw.x >= bounds.x && sw.x + sw.width <= bounds.x + bounds.width);
    assert.deepEqual(errors, []);
    console.log('PASS: individual switches, saved count, directory action, errors, keyboard toggle and compact layout.');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
