const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const appRoot = packaged ? path.join(root, 'release/win-unpacked') : root;
const executable = packaged ? path.join(appRoot, 'Paper Timeline.exe') : require('electron');
const data = path.join(root, '.test-data', `ai desktop 中文 ${Date.now()}`);
fs.mkdirSync(data, { recursive: true });
const storage = path.join(data, 'library');
const env = { ...process.env, PAPER_TIMELINE_DATA: data }; delete env.ELECTRON_RUN_AS_NODE; delete env.PAPER_TIMELINE_AI;
let sequence = 0;
async function cli(args, expectedOk = true, overrideEnv = {}) {
  const runtime = packaged ? executable : process.execPath;
  const cliEnv = { ...env, ...overrideEnv, ...(packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
  let stdout, code = 0;
  try { ({ stdout } = await execute(runtime, [path.join(appRoot, 'ai/cli.cjs'), ...args], { env: cliEnv, cwd: data, windowsHide: true, timeout: 15000 })); }
  catch (error) { stdout = error.stdout; code = error.code; }
  const result = JSON.parse(stdout);
  assert.equal(result.ok, expectedOk, JSON.stringify(result)); assert.equal(code, expectedOk ? 0 : 1);
  return result;
}
async function call(operation, params, expectedOk = true) {
  const file = path.join(data, `请求 ${++sequence}.json`);
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify(params || {}), 'utf8');
  return cli(['call', operation, '--file', file], expectedOk);
}

(async () => {
  const manifest = await cli(['capabilities']);
  assert.ok(manifest.result.operations.some(operation => operation.name === 'cloud.status'));
  assert.ok(manifest.result.operations.some(operation => operation.name === 'cloud.sync'));
  assert.ok(manifest.result.operations.some(operation => operation.name === 'notes.attach'));
  assert.ok(manifest.result.operations.some(operation => operation.name === 'timelines.create'));
  assert.equal((await cli(['call', 'app.status'], false)).error.code, 'APP_NOT_RUNNING');
  const app = await electron.launch({ executablePath: executable, args: packaged ? [] : ['.'], env, cwd: root });
  let id;
  try {
    const page = await app.firstWindow();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: '打开文献库', exact: true }).click();
    await page.getByRole('heading', { name: '导入你的第一篇论文' }).waitFor();
    // Keep network deterministic; PDF extraction, queue and matching remain real.
    await app.evaluate(({ net }) => {
      net.fetch = async () => new Response('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>https://arxiv.org/abs/2601.05083v2</id><title>Driving on Registers</title><author><name>Ellington Kirby</name></author><published>2026-01-08</published><summary>Test metadata supplied by the desktop test.</summary></entry></feed>');
    });
    assert.equal((await call('app.status')).result.storagePath, storage);
    const folder = (await call('folders.create', { name: 'AI 测试文件夹' })).result;
    await page.locator('.folder-item[title="AI 测试文件夹"]').waitFor();
    const filename = fs.readdirSync(path.join(root, '../pdf')).find(name => name.includes('Driving on Registers'));
    assert.ok(filename);
    const imported = (await call('papers.import', { paths: [path.resolve(root, '../pdf', filename)], folderId: folder.id })).result;
    assert.equal(imported.imported, 1); id = imported.paperIds[0];
    await page.waitForFunction(() => document.querySelectorAll('.paper-row').length === 1);
    await page.waitForFunction(() => !!document.querySelector('.paper-row .status-matched'), undefined, { timeout: 30000 });
    let paper = (await call('papers.get', { id })).result;
    assert.equal(paper.status, 'matched'); assert.equal(paper.publicationDate, '2026-01-08');
    assert.equal(paper.folderId, folder.id); assert.ok(fs.existsSync(paper.pdfPath));
    const copy = fs.readFileSync(paper.pdfPath);
    assert.equal(await page.locator('.no-note').count(), 1);
    const mdSource = path.join(data, '测试 阅读笔记.md');
    fs.writeFileSync(mdSource, '# 测试笔记\n中文内容', 'utf8');
    await call('notes.attach', { id, path: mdSource });
    const attached = (await call('notes.get', { id })).result;
    assert.deepEqual(fs.readFileSync(attached.path), fs.readFileSync(mdSource));
    await app.evaluate(({ shell }) => { globalThis.noteOpenedPaths = []; shell.openPath = async file => { globalThis.noteOpenedPaths.push(file); return ''; }; });
    const noteButton = page.getByRole('button', { name: '打开 Markdown 笔记：测试 阅读笔记.md', exact: true });
    await noteButton.click();
    await noteButton.focus(); await noteButton.press('Enter'); await noteButton.press('Space');
    await noteButton.dblclick();
    const openedPaths = await app.evaluate(() => globalThis.noteOpenedPaths);
    assert.ok(openedPaths.length >= 4); assert.ok(openedPaths.every(file => file === attached.path), 'Note actions must never open the PDF');
    await call('papers.setReadingRecord', { id, record: { source: '测试表格', fields: [{ label: '重要性', value: '★★★★★' }] } });
    await page.locator('.paper-row').click();
    await page.locator('.reading-record summary').click();
    await page.getByText('★★★★★', { exact: true }).waitFor();
    await app.evaluate(({ shell }) => { shell.openPath = async () => 'No default application'; });
    await noteButton.click(); await page.getByRole('alert').filter({ hasText: '默认打开软件' }).waitFor();
    fs.unlinkSync(attached.path);
    await noteButton.click(); await page.getByRole('alert').filter({ hasText: '笔记文件已丢失' }).waitFor();
    fs.copyFileSync(mdSource, attached.path);
    assert.equal((await call('papers.list', { query: 'Driving', folderId: folder.id })).result.total, 1);
    await page.locator('.paper-row').click();
    await call('metadata.update', { id, fields: { title: 'AI 修改验证', publicationDate: '2025-04' } });
    await page.locator('.detail-title').filter({ hasText: 'AI 修改验证' }).waitFor();
    assert.equal((await call('metadata.refresh', { id }, false)).error.code, 'MANUAL_METADATA');
    assert.equal((await call('metadata.refresh', { id, replaceManual: true })).result.accepted, true);
    await page.locator('.detail-title').filter({ hasText: 'Driving on Registers' }).waitFor();
    await page.waitForFunction(() => !!document.querySelector('.paper-row .status-matched'), undefined, { timeout: 30000 });
    paper = (await call('papers.get', { id })).result; assert.equal(paper.status, 'matched');
    await call('papers.move', { id, folderId: null });
    assert.equal((await call('papers.list', { folderId: null })).result.total, 1);
    await call('folders.rename', { id: folder.id, name: '接口文件夹' });
    await page.locator('.folder-item[title="接口文件夹"]').waitFor();
    await call('folders.delete', { id: folder.id });
    await page.locator('.folder-item[title="接口文件夹"]').waitFor({ state: 'hidden' });
    assert.deepEqual(fs.readFileSync(paper.pdfPath), copy);
    assert.equal((await cli(['call', 'not.available'], false)).error.code, 'UNKNOWN_OPERATION');
    assert.equal((await call('metadata.update', { id, fields: { status: 'matched' } }, false)).error.code, 'INVALID_ARGUMENT');
    assert.equal((await cli(['call', 'app.status', '--library', storage], true, { PAPER_TIMELINE_DATA: '' })).result.total, 1);
    // The public Windows launcher works without Node.js on PATH, including exit codes.
    if (packaged) {
      const command = `""${path.join(appRoot, 'PaperAI.cmd')}" call app.status"`;
      const output = await execute(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { env: { ...env, PATH: process.env.SystemRoot + '\\System32' }, cwd: data, windowsHide: true, timeout: 15000, windowsVerbatimArguments: true });
      assert.equal(JSON.parse(output.stdout).result.total, 1);
      let failed;
      try { await execute(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${path.join(appRoot, 'PaperAI.cmd')}" call unavailable"`], { env, cwd: data, windowsHide: true, timeout: 15000, windowsVerbatimArguments: true }); }
      catch (error) { failed = error; }
      assert.equal(failed?.code, 1); assert.equal(JSON.parse(failed.stdout).error.code, 'UNKNOWN_OPERATION');
      for (const file of ['AGENTS.md', 'ai/README.md', 'ai/capabilities.json', 'ai/examples/refresh-metadata.json']) assert.ok(fs.existsSync(path.join(appRoot, file)));
    }
    assert.deepEqual(errors, []);
    fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results', packaged ? 'desktop-ai-packaged.png' : 'desktop-ai.png') });
  } finally { await app.close(); }
  assert.equal(fs.existsSync(path.join(storage, '.ai-session.json')), false);
  assert.equal((await cli(['call', 'app.status'], false)).error.code, 'APP_NOT_RUNNING');
  const restarted = await electron.launch({ executablePath: executable, args: packaged ? [] : ['.'], env: { ...env, PAPER_TIMELINE_AI: '0' }, cwd: root });
  try {
    const page = await restarted.firstWindow();
    await page.getByRole('button', { name: '打开文献库', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.paper-row').length === 1);
    assert.equal((await cli(['call', 'app.status'], false)).error.code, 'APP_NOT_RUNNING');
    assert.equal((await page.evaluate(() => window.paperApi.getLibrary())).papers[0].id, id);
  } finally { await restarted.close(); }
  console.log(`PASS: ${packaged ? 'packaged' : 'source'} AI discovery, CLI JSON/Unicode paths, imports, metadata refresh, manual protection, folders, UI sync, persisted records, disabled API and session cleanup.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
