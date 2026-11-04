import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { _electron as electron } from 'playwright-core';
import { Library } from '../electron/library';
import { localMetadata } from '../electron/metadata';
import { readCitationSnapshot } from '../electron/citation-monitor';

await mkdir('.test-data', { recursive: true });
const directory = await mkdtemp(resolve('.test-data/cloud-desktop-'));
const library = new Library(join(directory, 'library'), async () => { throw Error('no PDF'); }, async p => ({ metadata: localMetadata(p), matched: true, message: '' }));
await library.initialize();
const { id } = await library.createPaper({ title: 'Cloud integration fixture', authors: ['Fixture Author'], publicationDate: '2025', doi: '10.1234/cloud-fixture' }, null, false);
const python = process.env.PAPER_TIMELINE_TEST_PYTHON || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
// Optional, isolated test-only dependencies; never load the real service's settings or database.
const fixturePythonPath = process.env.PAPER_TIMELINE_TEST_PYTHONPATH;
const server = spawn(python, [resolve('tests/cloud-server-fixture.py'), resolve('../paper_monitoring/backend'), join(directory, 'fixture.sqlite3')], {
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  env: { ...process.env, ...(fixturePythonPath ? { PYTHONPATH: [fixturePythonPath, process.env.PYTHONPATH].filter(Boolean).join(delimiter) } : {}) },
});
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
async function closeApp() {
  if (!app) return;
  const current = app; app = undefined;
  const exited = new Promise<void>(resolve => current.process().once('exit', () => resolve()));
  await current.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.close()));
  const timeout = setTimeout(() => current.process().kill(), 15000);
  try { await exited; } finally { clearTimeout(timeout); }
}
let output = '', errors = '';
server.stderr.on('data', b => { errors += b.toString(); });
try {
  const port = await new Promise<number>((resolvePort, reject) => {
    const timeout = setTimeout(() => reject(Error('Fixture startup timed out: ' + errors)), 30000);
    server.once('exit', code => { clearTimeout(timeout); reject(Error('Fixture exited: ' + code + ' ' + errors)); });
    server.stdout.on('data', b => { output += b.toString(); const line = output.match(/\{"port":\s*(\d+)\}/); if (line) { clearTimeout(timeout); resolvePort(Number(line[1])); } });
  });
  const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, PAPER_TIMELINE_DATA: directory, PAPER_TIMELINE_AI: '0' }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.ELECTRON_RUN_AS_NODE;
  const source = !process.argv.includes('--packaged') || process.argv.includes('--source') || !!process.env.PAPER_TIMELINE_TEST_SOURCE;
  const launch = () => electron.launch({ executablePath: resolve(source ? 'node_modules/electron/dist/electron.exe' : 'release/win-unpacked/Paper Timeline.exe'),
    ...(source ? { args: [resolve('.')] } : {}), env, timeout: 30000 });
  app = await launch();
  await writeFile(join(directory, 'test-processes.json'), JSON.stringify({ node: process.pid, electron: app.process().pid, server: server.pid }));
  console.log(`Fixture and ${source ? 'source' : 'packaged'} application started.`);
  const page = await app.firstWindow();
  const pageErrors: string[] = []; page.on('pageerror', e => pageErrors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('main', { name: '个人首页' }).waitFor();
  assert.equal(await page.getByLabel('服务器地址', { exact: true }).count(), 0, 'the home card does not render the large inline login form');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: join(directory, 'compact-cloud-home.png'), fullPage: true });
  const loginDialog = page.getByRole('dialog', { name: '连接云端引用监控', exact: true });
  await page.getByRole('button', { name: '登录并连接', exact: true }).click();
  await loginDialog.waitFor();
  await page.setViewportSize({ width: 1050, height: 700 });
  const loginBounds = await loginDialog.boundingBox();
  assert.ok(loginBounds && loginBounds.x >= 0 && loginBounds.y >= 0 && loginBounds.x + loginBounds.width <= 1050 && loginBounds.y + loginBounds.height <= 700,
    'login remains operable inside the supported minimum window');
  await page.screenshot({ path: join(directory, 'cloud-login-dialog.png'), fullPage: true });
  await page.setViewportSize({ width: 840, height: 520 });
  const shortBounds = await loginDialog.boundingBox();
  assert.ok(shortBounds && shortBounds.x >= 0 && shortBounds.y >= 0 && shortBounds.x + shortBounds.width <= 840 && shortBounds.y + shortBounds.height <= 520,
    'the narrow, short window keeps the login dialog inside its viewport');
  const submitBounds = await loginDialog.getByRole('button', { name: '登录并连接', exact: true }).boundingBox();
  assert.ok(submitBounds && submitBounds.y >= 0 && submitBounds.y + submitBounds.height <= 520, 'short dialogs keep the submit button visible');
  const scrolling = await loginDialog.locator('.modal-fields').evaluate(element => ({ height: element.clientHeight, content: element.scrollHeight }));
  assert.ok(scrolling.content > scrolling.height, 'the short dialog scrolls its fields rather than clipping them');
  await page.screenshot({ path: join(directory, 'cloud-login-short-window.png'), fullPage: true });
  await loginDialog.getByLabel('服务器地址', { exact: true }).fill('http://127.0.0.1:' + port);
  await loginDialog.getByLabel('用户名 / 邮箱', { exact: true }).fill('desktop-fixture');
  await loginDialog.getByLabel('密码', { exact: true }).fill('unsaved-fixture-password');
  await page.keyboard.press('Escape');
  await loginDialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '登录并连接', exact: true }).evaluate(element => element === document.activeElement), true,
    'Escape restores focus to the home card login button');
  assert.equal((await page.evaluate(() => window.paperApi!.cloudStatus())).signedIn, false, 'canceling the dialog cannot log in');
  await page.screenshot({ path: join(directory, 'compact-cloud-home-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '登录并连接', exact: true }).click();
  await loginDialog.waitFor();
  assert.equal(await loginDialog.getByLabel('密码', { exact: true }).inputValue(), '', 'reopening does not restore a canceled password');
  await loginDialog.getByLabel('服务器地址', { exact: true }).fill('http://127.0.0.1:' + port);
  await loginDialog.getByLabel('用户名 / 邮箱', { exact: true }).fill('desktop-fixture');
  await loginDialog.getByLabel('密码', { exact: true }).fill('wrong-fixture-password');
  await loginDialog.getByRole('button', { name: '登录并连接', exact: true }).click();
  await loginDialog.getByRole('alert').waitFor();
  assert.equal((await page.evaluate(() => window.paperApi!.cloudStatus())).signedIn, false);
  assert.equal(await loginDialog.getByLabel('密码', { exact: true }).inputValue(), '', 'failed requests clear the entered password');
  assert.equal(await loginDialog.getByLabel('用户名 / 邮箱', { exact: true }).inputValue(), 'desktop-fixture', 'a failed login preserves nonsensitive fields for retry');
  await loginDialog.getByLabel('密码', { exact: true }).fill('fixture-password');
  await loginDialog.getByRole('button', { name: '登录并连接', exact: true }).click();
  await loginDialog.waitFor({ state: 'hidden' });
  await page.getByText('desktop-fixture，你好').waitFor();
  await page.screenshot({ path: join(directory, 'compact-cloud-home-connected.png'), fullPage: true });
  await page.getByRole('button', { name: '管理连接', exact: true }).click();
  await loginDialog.waitFor();
  await loginDialog.getByText('desktop-fixture', { exact: true }).waitFor();
  assert.equal(await loginDialog.getByLabel('密码', { exact: true }).count(), 0, 'signed-in management never displays login secrets');
  await page.screenshot({ path: join(directory, 'cloud-management-dialog.png'), fullPage: true });
  await loginDialog.getByRole('button', { name: '关闭云端连接', exact: true }).click();
  await loginDialog.waitFor({ state: 'hidden' });
  console.log('Compact cloud entry, modal cancel, failed login/retry and successful state update passed.');
  await page.getByRole('button', { name: '打开文献库', exact: true }).click();
  await page.getByRole('switch', { name: '引用监控开关' }).click();
  await page.getByText('已保存 1 篇', { exact: true }).waitFor({ timeout: 30000 });
  console.log('Authenticated subscription and citation sync passed.');
  assert.equal((await readCitationSnapshot(library.directory, id, library.get(id).storageFolder))?.citations.length, 1);
  assert.equal(JSON.parse(await readFile(library.file, 'utf8')).papers.length, 1);
  await page.getByRole('button', { name: '个人首页', exact: true }).click();
  await page.getByRole('region', { name: '云端引用监控', exact: true }).getByText('已连接', { exact: true }).waitFor();
  // Simulate an external change in this disposable account, then exercise the real repair button.
  const base = 'http://127.0.0.1:' + port + '/api/desktop/v1/';
  const session = await (await fetch(base + 'login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'desktop-fixture', password: 'fixture-password', device: 'isolated-test-control' }) })).json();
  const controlHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.token };
  const sync = JSON.parse(await readFile(join(library.directory, 'sync/cloud.json'), 'utf8'));
  const bindings = await (await fetch(base + 'bindings?library=' + sync.libraryId, { headers: controlHeaders })).json();
  const binding = bindings.bindings.find((b: any) => b.localId === id);
  const changed = await fetch(base + `bindings/${binding.id}/pause`, { method: 'POST', headers: controlHeaders,
    body: JSON.stringify({ library: sync.libraryId, revision: binding.revision }) });
  assert.equal(changed.status, 200);
  await fetch(base + 'logout', { method: 'POST', headers: controlHeaders, body: '{}' });
  await page.getByRole('button', { name: '检查监控差异', exact: true }).click();
  await page.getByRole('heading', { name: '旧网页监控 · 2 项待处理', exact: true }).waitFor();
  await page.getByRole('heading', { name: '当前库差异 · 1 项', exact: true }).waitFor();
  await page.getByRole('button', { name: '按本库开关对齐', exact: true }).click();
  await page.getByText('当前库开关与云端一致。', { exact: true }).waitFor();
  await mkdir('test-results', { recursive: true });
  await page.locator('.monitor-review').screenshot({ path: resolve('test-results/monitor-reconciliation.png') });
  const transfer = page.locator('.legacy-monitors article').filter({ hasText: 'Legacy transfer fixture' });
  await transfer.getByRole('button', { name: '转入本库', exact: true }).click();
  await page.getByRole('heading', { name: '旧网页监控 · 1 项待处理', exact: true }).waitFor();
  const imported = JSON.parse(await readFile(library.file, 'utf8')).papers;
  assert.equal(imported.length, 2); assert.equal(imported.find((p: any) => p.title === 'Legacy transfer fixture').pdfHash, null);
  assert.equal(imported.find((p: any) => p.title === 'Legacy transfer fixture').citationMonitoring, true);
  const stop = page.locator('.legacy-monitors article').filter({ hasText: 'Legacy stop fixture' });
  await stop.getByRole('button', { name: '停止旧订阅', exact: true }).click();
  await page.getByRole('heading', { name: '旧网页监控 · 0 项待处理', exact: true }).waitFor();
  await page.getByText('当前库开关与云端一致。', { exact: true }).waitFor();
  console.log('Reconciliation UI, legacy import without PDF and scoped stop passed.');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: resolve('test-results/cloud-desktop.png') });
  const credentials = await readdir(join(directory, 'cloud-sessions'));
  assert.equal(credentials.length, 1);
  const encrypted = await readFile(join(directory, 'cloud-sessions', credentials[0]));
  assert.equal(encrypted.includes(Buffer.from('ptd_')), false);
  assert.equal(encrypted.includes(Buffer.from('fixture-password')), false);
  await closeApp();
  console.log('First window closed; testing encrypted session restoration.');
  app = await launch();
  const reopened = await app.firstWindow();
  reopened.on('pageerror', e => pageErrors.push(e.message));
  await reopened.getByText('desktop-fixture，你好').waitFor();
  await reopened.getByRole('region', { name: '云端引用监控', exact: true }).getByText('已连接', { exact: true }).waitFor();
  await reopened.getByRole('button', { name: '管理连接', exact: true }).click();
  const reopenedDialog = reopened.getByRole('dialog', { name: '连接云端引用监控', exact: true });
  await reopenedDialog.getByRole('button', { name: '退出登录', exact: true }).click();
  await reopenedDialog.waitFor({ state: 'hidden' });
  await reopened.getByRole('button', { name: '登录并连接' }).waitFor();
  assert.equal((await readdir(join(directory, 'cloud-sessions'))).length, 0);
  assert.equal(JSON.parse(await readFile(library.file, 'utf8')).papers[0].citationMonitoring, true);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ source, directory, screenshots: ['compact-cloud-home.png', 'compact-cloud-home-connected.png', 'cloud-login-dialog.png', 'cloud-management-dialog.png', 'compact-cloud-home-narrow.png', 'cloud-login-short-window.png'] }));
  console.log(`PASS: ${source ? 'source' : 'packaged'} Electron + isolated Django modal login/cancel/retry, subscription, cached citations, reconciliation, encrypted session restore and logout.`);
} finally { await closeApp(); server.kill(); }
