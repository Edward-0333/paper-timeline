import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import type { CloudStatus } from '../shared/cloud';

// UI-only states come through the application's existing cloud event. This empty,
// disposable profile never signs in, contacts an account, or changes a real library.
await mkdir('.test-data', { recursive: true });
const directory = await mkdtemp(resolve('.test-data/sync-overview-'));
const packaged = process.argv.includes('--packaged');
const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env,
  PAPER_TIMELINE_DATA: directory, PAPER_TIMELINE_AI: '0' }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: resolve(packaged ? 'release/win-unpacked/Paper Timeline.exe' : 'node_modules/electron/dist/electron.exe'),
  ...(packaged ? {} : { args: [resolve('.')] }), env, timeout: 30000 });
const page = await app.firstWindow();
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
const overview = page.getByRole('region', { name: '同步概况', exact: true });
const labels = ['本库云端已确认监控', '账户全部云端监控', '云端待抓取', '云端未完整更新'] as const;
const numberLabels = ['本轮同步新增引用', '本库待同步开关', '旧网页监控待处理'] as const;
const unsigned: CloudStatus = { signedIn: false, connected: false, syncing: false, pending: 0, legacyPending: 0, newCitations: 0 };
const stamp = '2026-10-23T08:30:00.000Z';
const connected: CloudStatus = { ...unsigned, signedIn: true, connected: true, lastSyncAt: stamp,
  user: { id: 'isolated-chart-account', username: 'Chart fixture' }, server: 'https://chart-fixture.invalid',
  overview: { monitored: 0, libraryMonitored: 0, queued: 0, failed: 0, legacyMonitored: 0, lastServerFetchAt: stamp } };
async function state(status: CloudStatus, expected: string) {
  await app.evaluate(({ BrowserWindow }, next) => {
    BrowserWindow.getAllWindows()[0].webContents.send('cloud:changed', next);
  }, status);
  await page.waitForFunction(expected => document.querySelector('.sync-data-state')?.textContent?.trim() === expected, expected);
}
async function chartValue(label: typeof labels[number], value: number | 'unknown') {
  const row = overview.locator(`.sync-chart-row[data-label="${label}"]`);
  await page.waitForFunction(({ label, value }) => document.querySelector(`.sync-chart-row[data-label="${label}"]`)?.getAttribute('data-value') === String(value), { label, value });
  const text = await row.innerText();
  if (value === 'unknown') assert.ok(text.includes('—'), `${label} shows an unknown value rather than zero`);
  else assert.ok(text.replace(/[,，\s]/g, '').includes(`${value}篇`), `${label} displays the actual count and unit`);
}
async function numberValue(label: typeof numberLabels[number], value: number | 'unknown') {
  const text = await overview.locator(`.sync-number-stat[data-label="${label}"] strong`).innerText();
  assert.equal(value === 'unknown' ? text : text.replace(/[,，\s]/g, ''), value === 'unknown' ? '—' : String(value));
}
async function noOverflow() {
  const dimensions = await overview.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth,
    rect: { left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }, viewport: window.innerWidth }));
  assert.ok(dimensions.content <= dimensions.width + 1, 'chart content stays inside its card');
  assert.ok(dimensions.rect.left >= 0 && dimensions.rect.right <= dimensions.viewport, 'chart card stays inside the viewport');
}
async function screenshot(name: string) {
  await overview.scrollIntoViewIfNeeded();
  await overview.screenshot({ path: join(directory, name) });
}
try {
  await app.evaluate(({ session }) => {
    (globalThis as any).syncChartRequests = [];
    session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
      if (/^https?:/.test(request.url)) { (globalThis as any).syncChartRequests.push(request.url); callback({ cancel: true }); }
      else callback({});
    });
  });
  await page.getByRole('main', { name: '个人首页', exact: true }).waitFor();
  // Wait for the real initial status to finish before injecting event fixtures.
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent?.trim() === '登录并连接' && !button.disabled));
  await overview.waitFor();
  const originalIndex = await readFile(join(directory, 'library/library.json'), 'utf8');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await state(unsigned, '尚无云端数据');
  await overview.getByRole('figure', { name: '监控论文数量对比', exact: true }).waitFor();
  await overview.getByRole('figure', { name: '云端抓取状态', exact: true }).waitFor();
  for (const label of labels) await chartValue(label, 'unknown');
  await numberValue('本轮同步新增引用', 'unknown');
  await numberValue('本库待同步开关', 0);
  await numberValue('旧网页监控待处理', 'unknown');
  await screenshot('sync-unknown.png');

  await state(connected, '已连接');
  for (const label of labels) await chartValue(label, 0);
  for (const label of numberLabels) await numberValue(label, 0);
  const dates = await overview.locator('time').allTextContents();
  assert.equal(dates.length, 2, 'both last fetch and last sync remain visible as time nodes');
  assert.ok(dates.every(value => !/Invalid Date|尚无|—/.test(value)));
  await screenshot('sync-zero.png');

  const active: CloudStatus = { ...connected, pending: 3, newCitations: 16,
    overview: { ...connected.overview!, monitored: 80, libraryMonitored: 20, queued: 40, failed: 10, legacyMonitored: 2 } };
  await state(active, '已连接');
  for (const [label, value] of [[labels[0], 20], [labels[1], 80], [labels[2], 40], [labels[3], 10]] as const) await chartValue(label, value);
  await numberValue('本轮同步新增引用', 16); await numberValue('本库待同步开关', 3); await numberValue('旧网页监控待处理', 2);
  const accessibleChart = await overview.getByRole('figure', { name: '监控论文数量对比', exact: true }).getByRole('img').getAttribute('aria-label');
  assert.ok(accessibleChart?.includes(labels[0]) && accessibleChart.includes('20') && accessibleChart.includes(labels[1]) && accessibleChart.includes('80'),
    'the chart also exposes its labels and real counts to assistive technology');
  const libraryBar = await overview.locator(`.sync-chart-row[data-label="${labels[0]}"] .sync-chart-fill`).boundingBox();
  const accountBar = await overview.locator(`.sync-chart-row[data-label="${labels[1]}"] .sync-chart-fill`).boundingBox();
  assert.ok(libraryBar && accountBar && accountBar.width > 0 && Math.abs(libraryBar.width / accountBar.width - 0.25) < 0.01,
    'monitoring rows use the same linear scale instead of normalizing each bar independently');
  await noOverflow(); await screenshot('sync-active.png');

  await state({ ...active, connected: false }, '离线缓存');
  await chartValue(labels[0], 20); await chartValue(labels[1], 80); await numberValue('本轮同步新增引用', 16);
  await screenshot('sync-offline-cache.png');

  const failure: NonNullable<CloudStatus['failure']> = { kind: 'local_data', stage: 'local_citations', occurredAt: stamp,
    message: '引用数据格式异常：citations[0].year 必须是整数或 null（未知）', paperId: 'a'.repeat(64), title: 'Citation validation fixture', field: 'citations[0].year' };
  const failed = { ...active, error: failure.message, failure };
  await state(failed, '同步失败 · 上次完整同步数据');
  const cloudCard = page.getByRole('region', { name: '云端引用监控', exact: true });
  await cloudCard.getByText('已连接，同步失败', { exact: true }).waitFor();
  await cloudCard.getByText(/相关论文：Citation validation fixture/).waitFor();
  await chartValue(labels[0], 20); await numberValue('本轮同步新增引用', 16);
  await page.getByRole('button', { name: '管理连接', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '连接云端引用监控', exact: true });
  await dialog.getByText('已连接，同步失败', { exact: true }).waitFor();
  await dialog.getByText(/相关论文：Citation validation fixture/).waitFor();
  await page.setViewportSize({ width: 840, height: 700 });
  await page.screenshot({ path: join(directory, 'cloud-sync-failure.png'), fullPage: true });
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  await state({ ...failed, connected: false, failure: { ...failure, kind: 'network', stage: 'authentication' }, error: '无法连接云端服务器或请求超时' }, '离线缓存');
  await cloudCard.getByText('连接失败', { exact: true }).waitFor();
  await state({ ...failed, connected: false, signedIn: false, failure: { ...failure, kind: 'authentication', stage: 'authentication' }, error: '登录失效' }, '离线缓存');
  await cloudCard.getByText('需重新登录', { exact: true }).waitFor();

  const large: CloudStatus = { ...active, pending: 12345, newCitations: 54321,
    overview: { ...active.overview!, monitored: 1234567, libraryMonitored: 765432, queued: 88888, failed: 12345, legacyMonitored: 123456 } };
  await state(large, '已连接');
  await chartValue(labels[0], 765432); await chartValue(labels[1], 1234567);
  await numberValue('本轮同步新增引用', 54321); await numberValue('本库待同步开关', 12345); await numberValue('旧网页监控待处理', 123456);
  await page.setViewportSize({ width: 840, height: 1050 });
  await noOverflow(); await screenshot('sync-large-narrow.png');

  await state({ ...active, syncing: true }, '同步中');
  await chartValue(labels[1], 80);
  // Older cloud services can provide totals without the reconciliation fields.
  await state({ ...connected, overview: { monitored: 6, queued: 2, failed: 1, lastServerFetchAt: null } }, '已连接');
  await chartValue(labels[0], 'unknown'); await chartValue(labels[1], 6); await numberValue('旧网页监控待处理', 'unknown');
  assert.equal(await readFile(join(directory, 'library/library.json'), 'utf8'), originalIndex, 'chart updates never modify library records');
  assert.deepEqual(await app.evaluate(() => (globalThis as any).syncChartRequests), [], 'chart rendering does not initiate external requests');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ packaged, directory, result: 'passed', checks: 'unknown versus valid zero, actual counts and units, shared linear scale, offline cached values, latest time nodes, large numbers, narrow layout, syncing, older server fields, no requests or library writes' }));
} finally {
  const exited = new Promise<void>(resolveExit => app.process().once('exit', () => resolveExit()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.close()));
  const timeout = setTimeout(() => app.process().kill(), 15000);
  try { await exited; } finally { clearTimeout(timeout); }
}
