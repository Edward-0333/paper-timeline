import { app, BrowserWindow, dialog, ipcMain, net, shell, protocol, safeStorage } from 'electron';
import { ModelSettings } from './model-settings';
import { getModelChatContext } from './model-chat-context';
import { PaperChatStore } from './paper-chat-store';
import type { ModelConfigurationInput } from '../shared/model-settings';
import type { ModelChatRequest } from '../shared/model-chat';
import { readFile } from 'node:fs/promises';
import type { ReaderUpdate } from '../shared/reader';
import type { MarkdownUpdate } from '../shared/notes-editor';
import { dirname, join, resolve } from 'node:path';
import { LocalMineru } from './mineru';
import type { MineruTier } from '../shared/mineru';
import { Worker } from 'node:worker_threads';
import { Library } from './library';
import { cloudCredentials } from './cloud-credentials';
import { lookupMetadata } from './metadata';
import { readLibraryLocation, resolveDefaultLibraryDirectory } from './storage-path';
import { inspectStorageSelection, prepareStorageChange, saveLibraryLocation } from './storage-settings';
import { startAiApi } from './ai-api';
import type { CitationInput, ExtractedPdf, PaperMetadata, PaperTagPosition, PaperFileKind, TimelinePosition, TimelineChanges, StorageAction } from '../shared/types';

app.setName('Paper Timeline');
protocol.registerSchemesAsPrivileged([{ scheme: 'paper-reader', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
if (process.env.PAPER_TIMELINE_DATA) app.setPath('userData', resolve(process.env.PAPER_TIMELINE_DATA));
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
let window: BrowserWindow | null = null;
let library: Library;
let modelSettings: ModelSettings;
let paperChats: PaperChatStore;
let aiApi: Awaited<ReturnType<typeof startAiApi>> | null = null;
let changingStorage = false;
let restarting = false;
let cloudControl: Promise<unknown> = Promise.resolve();
let readerActive = false, waitingReaderClose = false, readerCloseAllowed = false;
let readerCloseTimer: ReturnType<typeof setTimeout> | undefined;

async function startupLibraryDirectory(defaultDirectory: string) {
  try {
    const directory = readLibraryLocation(defaultDirectory);
    if (directory !== defaultDirectory) await inspectStorageSelection('open', directory);
    return directory;
  } catch (error) {
    let detail = error instanceof Error ? error.message : String(error);
    while (true) {
      const answer = await dialog.showMessageBox({ type: 'warning', title: '文献库位置不可用', message: '请重新选择文献库',
        detail: `${detail}\n如果更换了电脑或磁盘，请选择已复制的 library 文件夹。`, buttons: ['选择已有文献库', '使用默认位置', '退出'], defaultId: 0, cancelId: 2 });
      if (answer.response === 2) return null;
      try {
        if (answer.response === 1) { await saveLibraryLocation(defaultDirectory, defaultDirectory); return defaultDirectory; }
        const selected = await dialog.showOpenDialog({ title: '选择包含 library.json 的文献库文件夹', properties: ['openDirectory'] });
        if (selected.canceled) continue;
        const result = await inspectStorageSelection('open', selected.filePaths[0]);
        await saveLibraryLocation(defaultDirectory, result.directory);
        return result.directory;
      } catch (nextError) { detail = nextError instanceof Error ? nextError.message : String(nextError); }
    }
  }
}

function extract(path: string, fileName: string): Promise<ExtractedPdf> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'pdf-worker.cjs'), { workerData: { path, fileName } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('PDF 解析超时，请检查文件后重试')); }, 45000);
    worker.once('message', result => { clearTimeout(timer); void worker.terminate(); result.ok ? resolve(result.value) : reject(new Error(result.error)); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('PDF 解析进程已退出')); });
  });
}
function createWindow() {
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 1050, minHeight: 700, title: 'Paper Timeline', backgroundColor: '#ffffff', autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  void window.loadFile(join(__dirname, '../dist/index.html'));
  window.on('close', event => {
    if (changingStorage) { event.preventDefault(); return; }
    // Storage changes already flushed the reader before copying and locked writes.
    if (!readerActive || readerCloseAllowed || restarting) return;
    event.preventDefault();
    if (waitingReaderClose) return;
    waitingReaderClose = true;
    window!.webContents.send('reader:flush-before-close');
    readerCloseTimer = setTimeout(async () => {
      if (!window || !waitingReaderClose) return;
      const result = await dialog.showMessageBox(window, { type: 'warning', title: '阅读内容尚未保存', message: '保存阅读记录或笔记尚未完成',
        detail: '返回阅读可继续等待或重试。仍然退出可能丢失最近的修改。', buttons: ['返回阅读', '仍然退出'], defaultId: 0, cancelId: 0 });
      waitingReaderClose = false;
      if (result.response === 1 && window) { readerCloseAllowed = true; window.close(); }
    }, 15000);
  });
  window.on('closed', () => { window = null; });
}
if (lock) {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.whenReady().then(async () => {
    protocol.handle('paper-reader', async request => {
      const url = new URL(request.url);
      const name = url.pathname.slice(1);
      if (request.method !== 'GET' || url.hostname !== 'assets' || !['pdfium.wasm', 'NotoSansHans-Regular.otf'].includes(name)) return new Response('Not found', { status: 404 });
      return new Response(new Uint8Array(await readFile(join(__dirname, '../dist/reader-assets', name))), { headers: {
        'Content-Type': name.endsWith('.wasm') ? 'application/wasm' : 'font/otf', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
    });
    const defaultDirectory = resolveDefaultLibraryDirectory({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      executablePath: app.getPath('exe'),
      dataRoot: process.env.PAPER_TIMELINE_DATA,
    });
    const libraryDirectory = await startupLibraryDirectory(defaultDirectory);
    if (!libraryDirectory) { app.quit(); return; }
    library = new Library(libraryDirectory, extract, (pdf) => lookupMetadata(pdf, (url, options) => net.fetch(url, options)));
    library.on('changed', state => { if (window && !window.isDestroyed()) window.webContents.send('library:changed', state); });
    library.on('storage-error', error => { dialog.showErrorBox('文献库保存失败', String(error)); });
    await library.initialize();
    const mineru = new LocalMineru(app.getPath('userData'), [dirname(defaultDirectory), app.isPackaged ? dirname(app.getPath('exe')) : app.getAppPath(),
      ...(app.isPackaged ? [resolve(dirname(app.getPath('exe')), '../..')] : [])]);
    library.startMineru(mineru);
    paperChats = new PaperChatStore(library);
    modelSettings = new ModelSettings(app.getPath('userData'), {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
      encryptString: value => safeStorage.encryptString(value), decryptString: value => safeStorage.decryptString(value),
    }, paperId => getModelChatContext(library, paperId), paperId => ({ library, paperId }), (paperId, messages) => paperChats.save(paperId, messages));
    library.on('cloud-changed', state => { if (window && !window.isDestroyed()) window.webContents.send('cloud:changed', state); });
    await library.startCloud({ fetch: (url, options) => net.fetch(url instanceof URL ? url.toString() : url, options), credentials: cloudCredentials(app.getPath('userData'), library.directory) });
    if (process.env.PAPER_TIMELINE_AI !== '0') aiApi = await startAiApi(library);
    function handle(channel: string, fn: (...args: any[]) => unknown) {
      ipcMain.handle(channel, (event, ...args) => {
        if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效请求来源');
        if (changingStorage || restarting) throw new Error('正在切换文献库，请稍候');
        return fn(...args);
      });
    }
    handle('library:get', () => library.state());
    handle('model:config', () => modelSettings.status());
    handle('model:test-connection', (input: ModelConfigurationInput) => modelSettings.testConnection(input, (url, options) => net.fetch(url instanceof URL ? url.toString() : url, options)));
    handle('model:cancel-test', () => modelSettings.cancelConnectionTest());
    handle('model:chat-context', (paperId: string) => getModelChatContext(library, paperId));
    handle('model:open-link', async (value: string) => {
      if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) throw new Error('无效链接');
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持网页链接');
      await shell.openExternal(url.toString());
    });
    handle('model:chat', (input: ModelChatRequest) => modelSettings.chat(input, (url, options) => net.fetch(url instanceof URL ? url.toString() : url, options), {
      progress: label => { if (window && !window.isDestroyed()) window.webContents.send('model:chat-progress', { paperId: input.paperId, requestId: input.requestId, label }); },
    }));
    handle('model:chat-history', (paperId: string) => paperChats.load(paperId));
    handle('model:clear-chat', async (paperId: string) => {
      if (modelSettings.hasActiveChat(paperId)) throw new Error('请先停止当前对话，再清空记录。');
      await paperChats.save(paperId, []);
    });
    handle('model:cancel-chat', (requestId: string) => modelSettings.cancelChat(requestId));
    handle('model:save-config', (input: ModelConfigurationInput, activate?: boolean) => modelSettings.save(input, activate));
    handle('model:select-config', (id: string) => modelSettings.select(id));
    handle('model:clear-config', (profileId?: string) => modelSettings.clear(profileId));
    handle('mineru:environment', () => library.mineruEnvironment());
    handle('mineru:choose', async () => {
      const choice = await dialog.showOpenDialog(window!, { title: '选择 MinerU 4.x 的 mineru-kit 可执行文件', properties: ['openFile'],
        ...(process.platform === 'win32' ? { filters: [{ name: 'MinerU 可执行文件', extensions: ['exe'] }] } : {}) });
      return choice.canceled ? null : mineru.chooseExecutable(choice.filePaths[0]);
    });
    handle('mineru:state', (id: string) => library.conversionState(id));
    handle('mineru:convert', (id: string, tier: MineruTier) => library.convertPdf(id, tier));
    handle('mineru:cancel', (id: string) => library.cancelConversion(id));
    handle('mineru:open', async (id: string, kind: 'markdown' | 'json' | 'directory') => {
      const error = await shell.openPath(await library.conversionPath(id, kind)); if (error) throw new Error(error);
    });
    handle('reader:document', (id: string) => library.readerDocument(id));
    handle('reader:save', (id: string, update: ReaderUpdate) => library.saveReaderState(id, update));
    handle('notes:document', (id: string) => library.getMarkdownDocument(id));
    handle('notes:save', (id: string, update: MarkdownUpdate) => library.saveMarkdownDocument(id, update));
    handle('reader:active', (active: boolean) => { if (typeof active !== 'boolean') throw new Error('无效阅读状态'); readerActive = active; });
    handle('reader:close-ready', (error?: string) => {
      if (!waitingReaderClose) return;
      clearTimeout(readerCloseTimer); waitingReaderClose = false;
      if (error) { dialog.showErrorBox('阅读内容保存失败', String(error)); return; }
      readerCloseAllowed = true; window?.close();
    });
    const control = <T,>(fn: () => Promise<T>) => { const next = cloudControl.catch(() => {}).then(fn); cloudControl = next; return next; };
    handle('cloud:status', () => library.cloudStatus());
    handle('cloud:login', (server: string, username: string, password: string) => control(() => library.cloudLogin(server, username, password)));
    handle('cloud:logout', () => control(() => library.cloudLogout()));
    handle('cloud:sync', () => library.cloudSync());
    handle('cloud:migrate', () => library.migrateCloudMonitoring());
    handle('cloud:review', (offset?: number) => control(() => library.cloudReview(offset)));
    handle('cloud:reconcile', () => control(() => library.cloudReconcile()));
    handle('cloud:import-legacy', (id: number, revision: number) => control(() => library.cloudImportLegacy(id, revision)));
    handle('cloud:stop-legacy', (id: number, revision: number) => control(() => library.cloudStopLegacy(id, revision)));
    handle('storage:choose', async (mode: StorageAction) => {
      if (!['open', 'copy', 'create'].includes(mode)) throw new Error('无效操作');
      const selected = await dialog.showOpenDialog(window!, { title: mode === 'open' ? '选择包含 library.json 的文献库文件夹' : '选择空文件夹',
        defaultPath: library.directory, properties: ['openDirectory', 'createDirectory'] });
      return selected.canceled ? null : inspectStorageSelection(mode, selected.filePaths[0], library.directory);
    });
    handle('storage:apply', async (mode: StorageAction, directory: string) => {
      changingStorage = true;
      try {
        await cloudControl.catch(() => {});
        modelSettings.cancelAllChats(); await modelSettings.whenIdle(); await paperChats.whenIdle();
        await prepareStorageChange(library, defaultDirectory, mode, directory);
        restarting = true;
        // Let the renderer receive success before closing its IPC connection.
        setTimeout(() => { app.relaunch(); app.quit(); }, 250);
      } finally { changingStorage = false; }
    });
    handle('library:create-timeline', (position?: TimelinePosition) => library.createTimeline(position));
    handle('library:update-timeline', (id: string, changes: TimelineChanges) => library.updateTimeline(id, changes));
    handle('library:delete-timeline', (id: string) => library.deleteTimeline(id));
    handle('library:create-folder', (name: string) => library.createFolder(name));
    handle('library:rename-folder', (id: string, name: string) => library.renameFolder(id, name));
    handle('library:delete-folder', (id: string) => library.deleteFolder(id));
    handle('library:move-paper', (id: string, folderId: string | null) => library.movePaper(id, folderId));
    handle('library:set-rating', (id: string, rating: Parameters<Library['setRating']>[1]) => library.setRating(id, rating));
    handle('library:set-brief-note', (id: string, text: string) => library.setBriefNote(id, text));
    handle('library:mark-opened', (id: string) => library.markOpened(id));
    handle('library:set-citation-monitoring', (id: string, enabled: boolean) => library.setCitationMonitoring(id, enabled));
    handle('library:get-citations', (id: string, offset?: number, limit?: number) => library.getCitations(id, offset, limit));
    handle('library:add-citation', (seedId: string, citationId: string) => library.addCitation(seedId, citationId));
    handle('library:open-citation-directory', async (id: string) => {
      const error = await shell.openPath(library.citationDirectory(id)); if (error) throw new Error(error);
    });
    handle('library:add-tag', (id: string, text: string, color: string) => library.addTag(id, text, color));
    handle('library:update-tag', (id: string, tagId: string, text: string, color: string) => library.updateTag(id, tagId, text, color));
    handle('library:move-tag', (id: string, tagId: string, position: PaperTagPosition) => library.moveTag(id, tagId, position));
    handle('library:move-file-tag', (id: string, kind: PaperFileKind, position: PaperTagPosition) => library.moveFileTag(id, kind, position));
    handle('library:delete-tag', (id: string, tagId: string) => library.deleteTag(id, tagId));
    handle('library:choose', async (folderId: string | null = null) => {
      const result = await dialog.showOpenDialog(window!, { title: '导入论文 PDF', filters: [{ name: 'PDF 文档', extensions: ['pdf'] }], properties: ['openFile', 'multiSelections'] });
      return result.canceled ? null : library.importPaths(result.filePaths, folderId);
    });
    handle('library:import', (paths: unknown, folderId: string | null = null) => {
      if (!Array.isArray(paths) || paths.length > 200 || paths.some(p => typeof p !== 'string')) throw new Error('单次最多导入 200 个 PDF');
      return library.importPaths(paths, folderId);
    });
    handle('library:retry', (id: string) => library.retry(id));
    handle('library:create-paper', (fields: CitationInput, folderId: string | null = null) => library.createPaper(fields, folderId));
    handle('library:choose-paper-pdf', async (id: string) => {
      library.get(id);
      const result = await dialog.showOpenDialog(window!, { title: '为文献添加 PDF 原文', filters: [{ name: 'PDF 文档', extensions: ['pdf'] }], properties: ['openFile'] });
      if (result.canceled) return false;
      await library.attachPdf(id, result.filePaths[0]); return true;
    });
    handle('library:save', (id: string, metadata: PaperMetadata) => library.saveMetadata(id, metadata));
    handle('library:open-pdf', async (id: string) => { const error = await shell.openPath(library.pdfPath(id)); if (error) throw new Error(error); });
    handle('library:open-paper-directory', async (id: string) => { const error = await shell.openPath(library.paperDirectory(id)); if (error) throw new Error(error); });
    handle('library:choose-markdown', async (id: string) => {
      library.get(id);
      const result = await dialog.showOpenDialog(window!, { title: '添加 Markdown 笔记（复制到文献库）', filters: [{ name: 'Markdown 笔记', extensions: ['md'] }], properties: ['openFile'] });
      return result.canceled ? null : library.attachMarkdown(id, result.filePaths[0]);
    });
    handle('library:open-markdown', async (id: string) => {
      const error = await shell.openPath(await library.markdownPath(id));
      if (error) throw new Error(`无法打开笔记，请设置 .md 文件的默认打开软件。${error}`);
    });
    handle('library:open-source', async (id: string) => {
      const paper = library.get(id);
      const url = new URL(paper.url || (paper.doi ? `https://doi.org/${paper.doi}` : `https://arxiv.org/abs/${paper.arxivId}`));
      if (url.protocol !== 'https:' || !['doi.org', 'arxiv.org', 'www.crossref.org'].includes(url.hostname)) throw new Error('不支持打开该来源链接');
      await shell.openExternal(url.toString());
    });
    handle('library:reveal', async () => { const error = await shell.openPath(library.directory); if (error) throw new Error(error); });
    createWindow();
    app.on('activate', () => { if (!window) createWindow(); });
  }).catch(error => { dialog.showErrorBox('启动失败', `无法读取文献库。已有文件不会被覆盖。\n${String(error)}`); app.quit(); });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => { if (changingStorage) event.preventDefault(); });
let shuttingDown = false;
app.on('will-quit', event => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  modelSettings?.cancelConnectionTest();
  modelSettings?.cancelAllChats();
  void (async () => {
    await cloudControl.catch(() => {});
    await library?.stopCitationMonitoring();
    await library?.stopConversions();
    await aiApi?.close();
    await library?.whenIdle();
    await modelSettings?.whenIdle();
    await paperChats?.whenIdle();
  // Finalize only after storage and background work have drained. Re-entering
  // quit during an automatic relaunch can leave a windowless process on Windows.
  })().finally(() => app.exit(0));
});
