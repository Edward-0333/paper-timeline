import { EventEmitter } from 'node:events';
import { lstatSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, copyFile, stat, unlink, lstat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import type { ExtractedPdf, ImportResult, Paper, PaperMetadata, PaperTag, PaperTagPosition, LibraryFolder, LibraryState, TimelineTrack, TimelineChanges, TimelinePosition } from '../shared/types';
import { defaultTimelines, MAX_TIMELINES, timelineChanges, timelinePosition, validateTimelines } from '../shared/timelines';
import { filenameTitle, cleanText, normalizeDoi } from './pdf';
import { localMetadata, type LookupResult } from './metadata';
import { parsePublicationDate, dateFromParts } from '../shared/publication-date';
import { copyMarkdown, markdownPath, readMarkdownDocument, writeMarkdownDocument, validateNote, validateReadingRecord } from './notes';
import type { MarkdownUpdate } from '../shared/notes-editor';
import { mineruPaperDirectory, mineruResultPath, readMineruResult, saveMineruResult, unpackMineruResult, validateMineruTier, type MineruRunner } from './mineru';
import type { MineruState, MineruTier } from '../shared/mineru';
import type { MarkdownNote, ReadingRecord, PaperFileKind, PaperRating } from '../shared/types';
import type { CitationInput, CreatePaperResult } from '../shared/types';
import { paperPdfHash } from '../shared/paper-files';
import { catalogKey, citationMetadata, citationQuery, mergeCitationMetadata } from './citations';
import { citationSeed, citationDirectory, readCitationSnapshot, writeCitationSnapshot } from './citation-monitor';
import type { CitationPage } from '../shared/citation-monitor';
import { citationLibraryArxiv, citationLibraryDoi, createCitationLibraryIndex } from '../shared/citation-library';
import { CloudClient, type CloudOptions } from './cloud-client';
import { readerPdf, readerHash, readReaderState, writeReaderState } from './reader';
import type { ReaderUpdate } from '../shared/reader';
import { assertRegularFile, assertSafeDirectory, assertSafeDirectorySync, ensurePaperDirectory, paperStoragePaths, storageFolderName, validateStorageFolder, writeNewPaperFile } from './paper-storage';
import { migratePaperStorage, validatedLibrarySnapshot, type StoredLibrary } from './paper-migration';
import { collectTagColors, tagKey } from '../shared/paper-tags';
import { briefNoteText } from '../shared/brief-note';
import { LibraryAiIndex } from './library-ai-index';

const MAX_PAPER_TAGS = 32;
const TAG_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TAG_COLOR = /^#[a-f0-9]{6}$/i;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;
function validateRating(value: unknown): asserts value is PaperRating {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) throw new Error('论文评分须为 1–5 的整数');
}
function tagText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || CONTROL_CHARACTERS.test(value)) throw new Error('标签文字需为 1–80 个字符，不能包含控制字符');
  return value.trim();
}
function tagColor(value: unknown): string {
  if (typeof value !== 'string' || !TAG_COLOR.test(value)) throw new Error('标签背景颜色需为 #RRGGBB 格式');
  return value.toUpperCase();
}
function tagPosition(value: unknown): PaperTagPosition {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'side' && key !== 'offset')) throw new Error('标签位置需指定边框及 0–1 之间的偏移量');
  const { side, offset } = value as PaperTagPosition;
  if (!['top', 'right', 'bottom', 'left'].includes(side) || typeof offset !== 'number'
    || !Number.isFinite(offset) || offset < 0 || offset > 1) throw new Error('标签位置需指定边框及 0–1 之间的偏移量');
  return { side, offset };
}
function validateStoredTags(papers: Paper[]) {
  const ids = new Set<string>();
  for (const paper of papers) {
    if (paper.tags === undefined) continue;
    if (!Array.isArray(paper.tags) || paper.tags.length > MAX_PAPER_TAGS) throw new Error('标签信息异常，请保留 library.json 并恢复备份');
    const names = new Set<string>();
    for (const tag of paper.tags) {
      if (!tag || typeof tag !== 'object' || typeof tag.id !== 'string' || !TAG_ID.test(tag.id)
        || typeof tag.text !== 'string' || !tag.text || tag.text !== tag.text.trim() || tag.text.length > 80 || CONTROL_CHARACTERS.test(tag.text)
        || typeof tag.color !== 'string' || !TAG_COLOR.test(tag.color)
        || ids.has(tag.id.toLowerCase()) || names.has(tagKey(tag.text))) throw new Error('标签信息异常，请保留 library.json 并恢复备份');
      if (tag.position !== undefined) {
        try { tagPosition(tag.position); } catch { throw new Error('标签信息异常，请保留 library.json 并恢复备份'); }
      }
      ids.add(tag.id.toLowerCase());
      names.add(tagKey(tag.text));
    }
  }
}

export class Library extends EventEmitter {
  private mineru?: MineruRunner;
  private conversionsClosing = false;
  private mineruTasks = new Map<string, { state: MineruState; controller: AbortController; done: Promise<void> }>();
  startMineru(runner: MineruRunner) { this.mineru = runner; this.conversionsClosing = false; }
  mineruEnvironment() {
    if (!this.mineru) return Promise.resolve({ ready: false, message: 'MinerU 尚未初始化' });
    return this.mineru.environment();
  }
  async conversionState(id: string): Promise<MineruState> {
    this.get(id);
    const task = this.mineruTasks.get(id);
    if (task) return structuredClone(task.state);
    const result = await readMineruResult(this.directory, id, this.get(id).storageFolder);
    return { status: result ? 'succeeded' : 'idle', message: result ? '全文解析已完成' : '尚未转换', result };
  }
  convertPdf(id: string, tier: MineruTier = 'basic') {
    return this.organize(async () => {
      if (this.storageLocked || this.conversionsClosing) throw new Error('正在切换文献库或退出，请稍后再转换');
      this.get(id); validateMineruTier(tier);
      const previous = this.mineruTasks.get(id);
      if (previous?.state.status === 'running') return { accepted: true, alreadyProcessing: true };
      if ([...this.mineruTasks.values()].some(task => task.state.status === 'running')) throw new Error('已有论文正在转换，请等待完成或取消后再转换另一篇');
      if (!this.mineru) throw new Error('MinerU 尚未初始化');
      const storageFolder = this.get(id).storageFolder;
      const path = this.pdfPath(id), hash = await readerHash(path), result = await readMineruResult(this.directory, id, storageFolder);
      const dir = await mineruPaperDirectory(this.directory, id, true, storageFolder), runId = randomUUID(), archive = join(dir, runId + '.tmp');
      const controller = new AbortController();
      const task = { state: { status: 'running', startedAt: new Date().toISOString(), message: '正在本机解析全文；首次使用可能需要下载模型', result } as MineruState,
        controller, done: Promise.resolve() };
      this.mineruTasks.set(id, task);
      task.done = (async () => {
        try {
          const mineruVersion = await this.mineru!.convert(path, archive, tier, controller.signal);
          if (controller.signal.aborted) throw new Error('转换已取消');
          const size = (await lstat(archive)).size; if (size > 512 * 1024 * 1024) throw new Error('解析结果超过 512 MB');
          const files = await unpackMineruResult(await readFile(archive), join(dir, runId));
          await this.organize(async () => {
            if (controller.signal.aborted) throw new Error('转换已取消');
            if (hash !== await readerHash(path)) throw new Error('转换期间 PDF 已变化，未覆盖之前的结果');
            const next = { runId, pdfHash: hash, tier, mineruVersion, completedAt: new Date().toISOString(), ...files };
            await saveMineruResult(this.directory, id, next, storageFolder);
            task.state = { status: 'succeeded', message: '全文解析已完成', result: next };
            await this.refreshAiIndex(id);
          });
        } catch (error) {
          task.state = { ...task.state, status: controller.signal.aborted ? 'cancelled' : 'failed', message: error instanceof Error ? error.message : 'MinerU 转换失败' };
        } finally { await unlink(archive).catch(() => {}); }
      })();
      return { accepted: true, alreadyProcessing: false };
    });
  }
  async cancelConversion(id: string) {
    this.get(id); const task = this.mineruTasks.get(id);
    if (task?.state.status === 'running') { task.controller.abort(); await task.done; }
    return this.conversionState(id);
  }
  async stopConversions() {
    this.conversionsClosing = true;
    for (const task of this.mineruTasks.values()) if (task.state.status === 'running') task.controller.abort();
    await Promise.all([...this.mineruTasks.values()].map(task => task.done));
  }
  async conversionPath(id: string, kind: 'markdown' | 'json' | 'directory') {
    if (!['markdown', 'json', 'directory'].includes(kind)) throw new Error('无效解析文件类型');
    const state = await this.conversionState(id); if (!state.result) throw new Error('这篇文献还没有成功的解析结果');
    if (state.result.pdfHash !== await readerHash(this.pdfPath(id))) throw new Error('PDF 与解析结果不一致，请重新转换');
    return mineruResultPath(this.directory, id, state.result, kind, this.get(id).storageFolder);
  }
  private papers: Paper[] = [];
  private folders: LibraryFolder[] = [];
  private timelines: TimelineTrack[] = defaultTimelines();
  private organization: Promise<unknown> = Promise.resolve();
  private queue: string[] = [];
  private processing = false;
  private writes: Promise<unknown> = Promise.resolve();
  private imports: Promise<unknown> = Promise.resolve();
  private storageLocked = false;
  private citationMonitor?: CloudClient;
  private cloudWork: Promise<unknown> = Promise.resolve();
  private manualCloud<T>(fn: (cloud: CloudClient) => Promise<T>): Promise<T> {
    const next = this.cloudWork.catch(() => {}).then(async () => {
      if (this.storageLocked) throw new Error('正在切换文献库，请稍后重试');
      const cloud = this.citationMonitor;
      if (!cloud) throw new Error('云端服务未启动');
      await cloud.pause();
      try { return await fn(cloud); } finally { cloud.resume(); }
    });
    this.cloudWork = next; return next;
  }
  async startCloud(options: Omit<CloudOptions, 'directory' | 'papers' | 'changed'>) {
    if (this.citationMonitor) throw new Error('云端同步已启动');
    this.citationMonitor = new CloudClient({ ...options, directory: this.directory, papers: () => structuredClone(this.papers),
      changed: () => { this.emit('changed', this.state()); this.emit('cloud-changed', this.cloudStatus());
        if (!this.cloudStatus().syncing) void this.refreshAiIndex(undefined, false); } });
    await this.citationMonitor.initialize();
    return this.citationMonitor;
  }
  async stopCitationMonitoring() { await this.citationMonitor?.pause(); }
  cloudStatus() { return this.citationMonitor?.status() ?? { signedIn: false, connected: false, syncing: false, pending: 0, legacyPending: 0, newCitations: 0 }; }
  cloudLogin(server: string, username: string, password: string) {
    if (!this.citationMonitor) throw new Error('云端服务未启动');
    return this.citationMonitor.login(server, username, password);
  }
  cloudLogout() { if (!this.citationMonitor) throw new Error('云端服务未启动'); return this.citationMonitor.logout(); }
  async cloudSync() { await this.citationMonitor?.sync(); return this.cloudStatus(); }
  cloudReview(offset = 0) { return this.manualCloud(cloud => cloud.review(offset)); }
  async cloudStopLegacy(id: number, revision: number) {
    await this.manualCloud(async cloud => { const row = await cloud.legacy(id, revision); await cloud.pauseBinding(row, true); });
    await this.cloudSync();
  }
  async cloudReconcile() {
    await this.manualCloud(async cloud => {
      const report = await cloud.review();
      for (const diff of report.differences) {
        if (diff.kind === 'orphan') {
          // An explicitly reviewed orphan is paused only in this library.
          if (!this.papers.some(p => p.id === diff.localId && cloud.owns(p))) await cloud.pauseBinding(diff.remote!, false);
          continue;
        }
        await this.organize(async () => {
          const p = this.get(diff.localId);
          if (!cloud.owns(p)) throw new Error('订阅范围已经变化，请重新对账');
          const previous = p.citationSubscription;
          // Preserve an unfinished transfer so a repair cannot abandon its old origin.
          p.citationSubscription = { ...cloud.intent(p, diff.remote?.revision ?? 0),
            ...(previous?.retireLegacy ? { retireLegacy: previous.retireLegacy } : {}),
            ...(diff.remote?.paperId ? { paperId: diff.remote.paperId } : {}) };
          try { await this.persist(); } catch (e) { p.citationSubscription = previous; throw e; }
          cloud.changed();
        });
      }
    });
    const status = await this.cloudSync();
    if (status.error) throw new Error('本库开关已保存，仍有同步请求待处理：' + status.error);
    return this.cloudReview();
  }
  async cloudImportLegacy(id: number, revision: number) {
    const result = await this.manualCloud(async cloud => {
      const row = await cloud.legacy(id, revision);
      return this.organize(async () => {
        const seed = row.seed;
        const metadata = citationMetadata({ title: seed.title, authors: seed.authors,
          publicationDate: seed.year ? String(seed.year) : '', doi: seed.doi, arxivId: seed.arxivId });
        const arxiv = (s: string) => s.toLowerCase().replace(/v\d+$/, '');
        const normal = (s: string) => s.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        const matches = this.papers.filter(p => p.citationSubscription?.paperId === row.paperId
          || (metadata.doi && normalizeDoi(p.doi) === metadata.doi)
          || (metadata.arxivId && arxiv(p.arxivId) === arxiv(metadata.arxivId))
          || (!metadata.doi && !metadata.arxivId && !p.doi && !p.arxivId && seed.year && seed.authors[0]
            && p.year === seed.year && normal(p.authors[0] ?? '') === normal(seed.authors[0]) && normal(p.title) === normal(seed.title)));
        if (matches.length > 1) throw new Error('本库有多个可能匹配的论文，请先核对 DOI / arXiv');
        let p = matches[0];
        if (p && ((p.citationSubscription?.paperId && p.citationSubscription.paperId !== row.paperId)
          || (metadata.doi && p.doi && normalizeDoi(p.doi) !== metadata.doi)
          || (metadata.arxivId && p.arxivId && arxiv(p.arxivId) !== arxiv(metadata.arxivId)))) throw new Error('本地与旧订阅的论文编号冲突，请先核对元数据');
        const created = !p;
        if (!p) {
          p = { ...metadata, id: createHash('sha256').update(`cloud:${randomUUID()}`).digest('hex'),
            catalogKey: catalogKey(metadata.title), pdfHash: null, fileName: '', fileSize: 0, pageCount: 0, folderId: null,
            importedAt: new Date().toISOString(), unread: true, status: 'review', source: '导入', message: '从服务器旧监控导入，尚未在线核对' };
          p.storageFolder = storageFolderName(p.title, p.id, this.papers.map(paper => paper.storageFolder!));
          await ensurePaperDirectory(this.directory, p.storageFolder);
          this.papers.unshift(p);
        }
        const previous = { citationMonitoring: p.citationMonitoring, citationSubscription: p.citationSubscription };
        p.citationSubscription = { ...cloud.intent(p), paperId: row.paperId, retireLegacy: { id: row.id, revision: row.revision } };
        p.citationMonitoring = true;
        try { await this.persist(); } catch (e) {
          if (created) this.papers = this.papers.filter(x => x.id !== p.id); else Object.assign(p, previous);
          throw e;
        }
        cloud.changed();
        return { id: p.id, created };
      });
    });
    const status = await this.cloudSync();
    if (status.error) throw new Error('论文已保存到本库，转入请求将继续重试：' + status.error);
    return result;
  }
  async migrateCloudMonitoring() {
    for (const p of this.list().filter(p => p.citationMonitoring && !p.citationSubscription)) await this.setCitationMonitoring(p.id, true);
  }
  citationDirectory(id: string) { return citationDirectory(this.directory, id, this.get(id).storageFolder); }
  citationState(id: string) { return this.citationMonitor?.paperState(this.get(id)); }
  async getCitations(id: string, offset = 0, limit = 50): Promise<CitationPage> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('无效引用分页位置');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('每页引用数量须为 1–200 的整数');
    const paper = this.get(id), snapshot = await readCitationSnapshot(this.directory, id, paper.storageFolder);
    return { id, enabled: paper.citationMonitoring === true, directory: this.citationDirectory(id),
      state: this.citationState(id), providers: snapshot?.providers ?? [], total: snapshot?.citations.length ?? 0,
      offset, limit, citations: snapshot?.citations.slice(offset, offset + limit) ?? [] };
  }
  addCitation(seedId: string, citationId: string): Promise<CreatePaperResult> {
    return this.organize(async () => {
      if (typeof seedId !== 'string' || !/^[a-f0-9]{64}$/.test(seedId)
        || typeof citationId !== 'string' || !/^[a-f0-9]{64}$/.test(citationId)) throw new Error('无效论文或引用记录 ID');
      const seed = this.get(seedId), snapshot = await readCitationSnapshot(this.directory, seedId, seed.storageFolder);
      const citation = snapshot?.citations.find(record => record.id === citationId);
      if (!citation) throw new Error('这条引用已不在本地缓存中，请刷新引用列表后重试');
      const match = createCitationLibraryIndex(this.papers)(citation);
      if (match.status === 'matched') return { id: match.paper.id, created: false, accepted: false };
      if (match.status === 'ambiguous') throw new Error('本库有多篇可能匹配的文献，请先核对标题及 DOI / arXiv 编号');
      if (match.status === 'conflict') throw new Error('引用记录与本库文献的 DOI / arXiv 编号冲突，请先核对元数据');
      const publicationDate = parsePublicationDate(citation.publicationDate) || parsePublicationDate(String(citation.year)) || '';
      const metadata = citationMetadata({ title: citation.title, authors: citation.authors, publicationDate,
        venue: citation.venue, doi: citationLibraryDoi(citation.doi), arxivId: citationLibraryArxiv(citation.arxivId), abstract: citation.abstract });
      if (citation.url && !/[\x00-\x20\x7f]/.test(citation.url)) {
        try {
          const url = new URL(citation.url);
          if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) metadata.url = url.toString();
        } catch { /* Retain the DOI/arXiv URL for malformed external links. */ }
      }
      const id = createHash('sha256').update(`citation:${randomUUID()}`).digest('hex');
      const paper: Paper = { ...metadata, id, catalogKey: catalogKey(metadata.title), pdfHash: null, fileName: '', fileSize: 0, pageCount: 0,
        folderId: null, importedAt: new Date().toISOString(), unread: true, status: 'review', message: '从引用列表加入，尚未在线核对',
        citationOrigins: [{ id: citation.id, sources: structuredClone(citation.sources) }] };
      if (!paper.catalogKey) throw new Error('引用记录缺少有效文献标题');
      paper.storageFolder = storageFolderName(paper.title, id, this.papers.map(existing => existing.storageFolder!));
      await ensurePaperDirectory(this.directory, paper.storageFolder);
      this.papers.unshift(paper);
      try { await this.persist(); } catch (error) { this.papers = this.papers.filter(existing => existing.id !== id); throw error; }
      this.emit('changed', this.state());
      return { id, created: true, accepted: false };
    });
  }
  setCitationMonitoring(id: string, enabled: boolean): Promise<void> {
    return this.organize(async () => {
      if (typeof enabled !== 'boolean') throw new Error('监控开关必须为布尔值');
      const paper = this.get(id), previous = paper.citationMonitoring, previousSubscription = paper.citationSubscription;
      if (previous === enabled && previousSubscription) return;
      if (!this.citationMonitor) throw new Error('请启动桌面程序并登录云端账户');
      const subscription = enabled || previousSubscription ? this.citationMonitor.intent(paper) : undefined;
      if (!await readCitationSnapshot(this.directory, id, paper.storageFolder)) await writeCitationSnapshot(this.directory, {
        version: 1, seed: citationSeed(paper), lastAttemptAt: '', nextCheckAt: '', citations: [], providers: [],
      }, paper.storageFolder);
      paper.citationSubscription = subscription;
      paper.citationMonitoring = enabled;
      try { await this.persist(); } catch (error) {
        if (previous === undefined) delete paper.citationMonitoring; else paper.citationMonitoring = previous;
        if (previousSubscription === undefined) delete paper.citationSubscription; else paper.citationSubscription = previousSubscription;
        throw error;
      }
      this.citationMonitor.changed();
      this.emit('changed', this.state());
    });
  }
  private aiIndex: LibraryAiIndex;
  private aiIndexSnapshot: { papers: Paper[]; folders: LibraryFolder[] } = { papers: [], folders: [] };
  constructor(readonly directory: string, private extract: (path: string, fileName: string) => Promise<ExtractedPdf>, private lookup: (pdf: ExtractedPdf) => Promise<LookupResult>) {
    super(); this.aiIndex = new LibraryAiIndex(directory);
  }
  aiIndexStatus() { return this.aiIndex.status(); }
  paperIndexPath(id: string) { return this.aiIndex.paperPath(this.get(id)); }
  /** Refresh generated navigation after an attachment write or an explicit external-file rescan. */
  refreshAiIndex(id?: string, rescanParsed = true) {
    if (id) this.get(id);
    return this.aiIndex.update(this.aiIndexSnapshot.papers, this.aiIndexSnapshot.folders,
      id ? [id] : rescanParsed ? true : this.aiIndexSnapshot.papers.map(paper => paper.id));
  }
  rebuildAiIndex() { return this.organize(() => this.refreshAiIndex()); }
  get file() { return join(this.directory, 'library.json'); }
  paperDirectory(id: string) { return paperStoragePaths(this.directory, this.get(id)).directory; }
  pdfPath(id: string) {
    const paper = this.get(id), path = paperStoragePaths(this.directory, paper).pdf;
    if (path === null) throw new Error('这篇文献尚未添加 PDF 原文');
    assertSafeDirectorySync(this.paperDirectory(id));
    try { const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('PDF 必须是本地文件，不能包含链接'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return path;
  }
  async readerDocument(id: string) {
    const pdf = await readerPdf(this.pdfPath(id));
    return { data: new Uint8Array(pdf.data), state: await readReaderState(this.directory, id, pdf.hash, this.get(id).storageFolder) };
  }
  async readerState(id: string) { return (await this.readerDocument(id)).state; }
  saveReaderState(id: string, update: ReaderUpdate) {
    return this.organize(async () => {
      const hash = await readerHash(this.pdfPath(id));
      const result = await writeReaderState(this.directory, id, hash, update, this.get(id).storageFolder);
      await this.refreshAiIndex(id); return result;
    });
  }
  get(id: string) { const paper = this.papers.find(p => p.id === id); if (!paper) throw new Error('找不到这篇文献'); return paper; }
  fileAvailability(id: string): Record<PaperFileKind, boolean> {
    const paper = this.get(id);
    const present = (path: string | null) => {
      if (!path) return false;
      try {
        assertSafeDirectorySync(this.paperDirectory(id));
        const file = lstatSync(path);
        return file.isFile() && !file.isSymbolicLink();
      } catch { return false; }
    };
    const paths = paperStoragePaths(this.directory, paper);
    return { pdf: present(paths.pdf), md: !!paper.markdownNote && present(paths.markdown) };
  }
  list() { return structuredClone(this.papers).map(paper => ({ ...paper, availableFiles: this.fileAvailability(paper.id),
    ...(this.citationState(paper.id) ? { citationMonitor: this.citationState(paper.id) } : {}) })); }
  state(): LibraryState { return { papers: this.list(), folders: structuredClone(this.folders), timelines: structuredClone(this.timelines), storagePath: this.directory }; }
  async markdownPath(id: string) {
    if (!this.get(id).markdownNote) throw new Error('这篇文献还没有 Markdown 笔记');
    try { return await markdownPath(this.directory, id, this.get(id).storageFolder); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('库中的笔记文件已丢失，请从备份恢复当前论文资料文件夹中的 notes.md'); throw error; }
  }
  async getMarkdownDocument(id: string) {
    const paper = this.get(id);
    if (!paper.markdownNote) throw new Error('这篇文献还没有 Markdown 笔记');
    try { return await readMarkdownDocument(this.directory, id, paper.markdownNote, paper.storageFolder); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('库中的笔记文件已丢失，请从备份恢复当前论文资料文件夹中的 notes.md'); throw error; }
  }
  saveMarkdownDocument(id: string, update: MarkdownUpdate) {
    return this.organize(async () => {
      const paper = this.get(id);
      if (!paper.markdownNote) throw new Error('这篇文献还没有 Markdown 笔记');
      try {
        const result = await writeMarkdownDocument(this.directory, id, paper.markdownNote, update, paper.storageFolder);
        await this.refreshAiIndex(id); return result;
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('库中的笔记文件已丢失，请从备份恢复当前论文资料文件夹中的 notes.md'); throw error; }
    });
  }
  attachMarkdown(id: string, path: string): Promise<MarkdownNote> {
    return this.organize(async () => {
      const paper = this.get(id), previous = paper.markdownNote;
      const { note, rollback } = await copyMarkdown(this.directory, id, path, previous, paper.storageFolder);
      if (previous) return structuredClone(note);
      paper.markdownNote = note;
      try { await this.persist(); } catch (error) { delete paper.markdownNote; await rollback(); throw error; }
      this.emit('changed', this.state());
      return structuredClone(note);
    });
  }
  setBriefNote(id: string, text: string): Promise<void> {
    return this.organize(async () => {
      const next = briefNoteText(text), paper = this.get(id), previous = paper.briefNote;
      if ((previous ?? '') === next) return;
      if (next) paper.briefNote = next; else delete paper.briefNote;
      try { await this.persist(); } catch (error) {
        if (previous === undefined) delete paper.briefNote; else paper.briefNote = previous;
        throw error;
      }
      this.emit('changed', this.state());
    });
  }
  markOpened(id: string): Promise<void> {
    return this.organize(async () => {
      const paper = this.get(id);
      if (paper.unread !== true) return;
      delete paper.unread;
      try { await this.persist(); } catch (error) { paper.unread = true; throw error; }
      this.emit('changed', this.state());
    });
  }
  setRating(id: string, rating: PaperRating | null): Promise<void> {
    return this.organize(async () => {
      if (rating !== null) validateRating(rating);
      const paper = this.get(id), previous = paper.rating;
      if (rating === null) delete paper.rating; else paper.rating = rating;
      try { await this.persist(); } catch (error) {
        if (previous === undefined) delete paper.rating; else paper.rating = previous;
        throw error;
      }
      this.emit('changed', this.state());
    });
  }
  setReadingRecord(id: string, record: ReadingRecord): Promise<void> {
    return this.organize(async () => {
      validateReadingRecord(record);
      const paper = this.get(id), previous = paper.readingRecord;
      paper.readingRecord = structuredClone(record);
      try { await this.persist(); } catch (error) {
        if (previous === undefined) delete paper.readingRecord; else paper.readingRecord = previous;
        throw error;
      }
      this.emit('changed', this.state());
    });
  }
  createPaper(fields: CitationInput, folderId: string | null = null, retrieve = true): Promise<CreatePaperResult> {
    return this.organize(async () => {
      if (folderId !== null) this.folder(folderId);
      const metadata = citationMetadata(fields), key = catalogKey(metadata.title);
      if (!key) throw new Error('请输入有效文献标题');
      const bareArxiv = (value: string) => value.toLowerCase().replace(/v\d+$/, '');
      const duplicate = this.papers.find(p => (metadata.doi && p.doi.toLowerCase() === metadata.doi.toLowerCase())
        || (metadata.arxivId && bareArxiv(p.arxivId) === bareArxiv(metadata.arxivId))
        || ((!metadata.doi || !p.doi || metadata.doi.toLowerCase() === p.doi.toLowerCase())
          && (!metadata.arxivId || !p.arxivId || bareArxiv(metadata.arxivId) === bareArxiv(p.arxivId))
          && (p.catalogKey === key || catalogKey(p.title) === key)));
      if (duplicate) return { id: duplicate.id, created: false, accepted: false };
      const id = createHash('sha256').update(`citation:${randomUUID()}`).digest('hex');
      const paper: Paper = { ...metadata, id, catalogKey: key, pdfHash: null, fileName: '', fileSize: 0, pageCount: 0,
        folderId, importedAt: new Date().toISOString(), unread: true, status: retrieve ? 'queued' : 'review', message: retrieve ? '等待检索书目信息' : '已保存书目信息，尚未在线核对' };
      paper.storageFolder = storageFolderName(paper.title, id, this.papers.map(p => p.storageFolder!));
      await ensurePaperDirectory(this.directory, paper.storageFolder);
      this.papers.unshift(paper);
      try { await this.persist(); } catch (error) { this.papers = this.papers.filter(p => p.id !== id); throw error; }
      this.emit('changed', this.state());
      if (retrieve) { this.queue.push(id); this.kick(); }
      return { id, created: true, accepted: retrieve };
    });
  }
  attachPdf(id: string, path: string): Promise<void> {
    return this.organize(async () => {
      const paper = this.get(id);
      if (paperPdfHash(paper) !== null) throw new Error('这篇文献已有 PDF 附件，不能覆盖');
      if (['queued', 'extracting', 'searching'].includes(paper.status)) throw new Error('请等待元数据检索完成后再添加 PDF');
      if (typeof path !== 'string' || extname(path).toLowerCase() !== '.pdf') throw new Error('请选择 PDF 文件');
      const info = await stat(path);
      if (!info.isFile() || info.size > 100 * 1024 * 1024) throw new Error('请选择小于 100 MB 的 PDF 文件');
      const buffer = await readFile(path);
      if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('文件内容不是有效 PDF');
      const hash = createHash('sha256').update(buffer).digest('hex');
      if (this.papers.some(p => paperPdfHash(p) === hash)) throw new Error('这份 PDF 已属于库中的另一篇文献');
      await ensurePaperDirectory(this.directory, paper.storageFolder!);
      const destination = paperStoragePaths(this.directory, { ...paper, pdfHash: hash }).pdf!;
      await writeNewPaperFile(destination, buffer);
      const previous = { pdfHash: paper.pdfHash, fileName: paper.fileName, fileSize: paper.fileSize };
      Object.assign(paper, { pdfHash: hash, fileName: basename(path), fileSize: info.size });
      try { await this.persist(); } catch (error) { Object.assign(paper, previous); await unlink(destination); throw error; }
      this.emit('changed', this.state());
    });
  }
  async initialize() {
    await assertSafeDirectory(this.directory);
    await assertRegularFile(this.file, true);
    const hasIndex = await lstat(this.file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
    if (hasIndex) {
      const data = await migratePaperStorage(this.directory, await readStoredLibrary(this.directory));
      this.papers = data.papers;
      this.folders = data.folders;
      this.timelines = data.timelines;
      this.aiIndexSnapshot = structuredClone({ papers: data.papers, folders: data.folders });
      const colors = collectTagColors(this.papers);
      const updates = this.papers.flatMap(paper => {
        if (!paper.tags?.some(tag => tag.color !== colors.get(tagKey(tag.text)))) return [];
        return [{ paper, tags: paper.tags.map(tag => tag.color === colors.get(tagKey(tag.text))
          ? tag : { ...tag, color: colors.get(tagKey(tag.text))! }) }];
      });
      // Commit before starting pending retrieval jobs; a failed migration leaves every loaded tag unchanged.
      if (updates.length) await this.saveTagChanges(updates, false);
    } else {
      await assertSafeDirectory(join(this.directory, 'papers'));
      await mkdir(join(this.directory, 'papers'), { recursive: true });
      await this.persist();
    }
    for (const paper of this.papers) await ensurePaperDirectory(this.directory, paper.storageFolder!);
    await this.refreshAiIndex();
    for (const paper of this.papers) {
      if (['queued', 'extracting', 'searching'].includes(paper.status)) { paper.status = 'queued'; paper.message = '继续上次未完成的检索'; this.queue.push(paper.id); }
    }
    this.kick();
  }
  private persist() {
    const snapshot = JSON.stringify({ version: 2, papers: this.papers, folders: this.folders, timelines: this.timelines }, null, 2);
    const write = this.writes.catch(() => {}).then(async () => {
      const temp = this.file + '.tmp';
      await assertRegularFile(this.file, true);
      await assertRegularFile(temp, true);
      await assertRegularFile(this.file + '.bak', true);
      await writeFile(temp, snapshot, 'utf8');
      try { await copyFile(this.file, this.file + '.bak'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      await rename(temp, this.file);
      const committed = JSON.parse(snapshot);
      this.aiIndexSnapshot = { papers: committed.papers, folders: committed.folders };
      await this.aiIndex.update(committed.papers, committed.folders);
    });
    this.writes = write;
    return write;
  }
  private async update(id: string, update: Partial<Paper>) {
    Object.assign(this.get(id), update);
    await this.persist();
    this.emit('changed', this.state());
  }
  private organize<T>(fn: () => Promise<T>): Promise<T> {
    if (this.storageLocked) return Promise.reject(new Error('正在切换文献库，请稍候'));
    const operation = this.organization.catch(() => {}).then(fn);
    this.organization = operation;
    return operation;
  }
  private folder(id: string) {
    const folder = this.folders.find(f => f.id === id);
    if (!folder) throw new Error('找不到这个文件夹');
    return folder;
  }
  getTimeline(id: string) {
    const track = this.timelines.find(item => item.id === id);
    if (!track) throw new Error('找不到这条时间线');
    return structuredClone(track);
  }
  private async saveTimelines(next: TimelineTrack[]) {
    const previous = this.timelines;
    this.timelines = next;
    try { await this.persist(); } catch (error) { this.timelines = previous; throw error; }
    this.emit('changed', this.state());
  }
  createTimeline(position?: TimelinePosition): Promise<TimelineTrack> {
    return this.organize(async () => {
      if (this.timelines.length >= MAX_TIMELINES) throw new Error('最多可创建 100 条时间线');
      const track: TimelineTrack = { id: randomUUID(), tags: [], tagMode: 'all', configured: false,
        position: timelinePosition(position ?? { x: 32, y: Math.min(100000, Math.max(-425, ...this.timelines.map(item => item.position.y)) + 700) }) };
      await this.saveTimelines([...this.timelines, track]);
      return structuredClone(track);
    });
  }
  updateTimeline(id: string, changes: TimelineChanges): Promise<TimelineTrack> {
    return this.organize(async () => {
      const previous = this.getTimeline(id), fields = timelineChanges(changes);
      const track = { ...previous, ...fields, configured: fields.tags !== undefined ? true : previous.configured };
      await this.saveTimelines(this.timelines.map(item => item.id === id ? track : item));
      return structuredClone(track);
    });
  }
  deleteTimeline(id: string): Promise<void> {
    return this.organize(async () => {
      this.getTimeline(id);
      await this.saveTimelines(this.timelines.filter(item => item.id !== id));
    });
  }
  private folderName(value: unknown, exceptId?: string) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('文件夹名称需为 1–80 个字符');
    const name = value.trim();
    if (this.folders.some(f => f.id !== exceptId && f.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('已存在同名文件夹');
    return name;
  }
  createFolder(name: string): Promise<LibraryFolder> {
    return this.organize(async () => {
      const folder = { id: randomUUID(), name: this.folderName(name) };
      this.folders.push(folder);
      try { await this.persist(); } catch (error) { this.folders = this.folders.filter(f => f.id !== folder.id); throw error; }
      this.emit('changed', this.state());
      return { ...folder };
    });
  }
  renameFolder(id: string, name: string): Promise<void> {
    return this.organize(async () => {
      const folder = this.folder(id), previous = folder.name;
      folder.name = this.folderName(name, id);
      try { await this.persist(); } catch (error) { folder.name = previous; throw error; }
      this.emit('changed', this.state());
    });
  }
  deleteFolder(id: string): Promise<void> {
    return this.organize(async () => {
      this.folder(id);
      const previous = [...this.folders], members = this.papers.filter(p => p.folderId === id);
      this.folders = this.folders.filter(f => f.id !== id);
      for (const paper of members) paper.folderId = null;
      try { await this.persist(); } catch (error) { this.folders = previous; for (const paper of members) paper.folderId = id; throw error; }
      this.emit('changed', this.state());
    });
  }
  movePaper(id: string, folderId: string | null): Promise<void> {
    return this.organize(async () => {
      if (folderId !== null) this.folder(folderId);
      const paper = this.get(id), previous = paper.folderId;
      paper.folderId = folderId;
      try { await this.persist(); } catch (error) { paper.folderId = previous; throw error; }
      this.emit('changed', this.state());
    });
  }
  private async saveTags(paper: Paper, tags: PaperTag[]): Promise<void> {
    return this.saveTagChanges([{ paper, tags }]);
  }
  private async saveTagChanges(updates: { paper: Paper; tags: PaperTag[] }[], notify = true): Promise<void> {
    const previous = updates.map(({ paper }) => ({ paper, tags: paper.tags }));
    for (const { paper, tags } of updates) paper.tags = tags;
    try { await this.persist(); } catch (error) {
      for (const { paper, tags } of previous) {
        if (tags === undefined) delete paper.tags; else paper.tags = tags;
      }
      throw error;
    }
    if (notify) this.emit('changed', this.state());
  }
  private uniqueTagText(paper: Paper, text: string, exceptId?: string): string {
    const value = tagText(text);
    if (paper.tags?.some(tag => tag.id !== exceptId && tagKey(tag.text) === tagKey(value))) throw new Error('这篇文献已存在同名标签');
    return value;
  }
  addTag(id: string, text: string, color: string): Promise<PaperTag> {
    return this.organize(async () => {
      const paper = this.get(id);
      if ((paper.tags?.length ?? 0) >= MAX_PAPER_TAGS) throw new Error('每篇文献最多添加 32 个标签');
      const value = this.uniqueTagText(paper, text), requestedColor = tagColor(color);
      const tag: PaperTag = { id: randomUUID(), text: value,
        color: collectTagColors(this.papers).get(tagKey(value)) ?? requestedColor };
      await this.saveTags(paper, [...(paper.tags ?? []), tag]);
      return { ...tag };
    });
  }
  updateTag(id: string, tagId: string, text: string, color: string): Promise<void> {
    return this.organize(async () => {
      const paper = this.get(id);
      const existing = paper.tags?.find(tag => tag.id === tagId);
      if (!existing) throw new Error('找不到这个标签');
      const value = this.uniqueTagText(paper, text, tagId), requestedColor = tagColor(color);
      const key = tagKey(value), sameName = key === tagKey(existing.text);
      const nextColor = sameName ? requestedColor : collectTagColors(this.papers).get(key) ?? requestedColor;
      const updates = this.papers.flatMap(item => {
        if (item !== paper && (!sameName || !item.tags?.some(tag => tagKey(tag.text) === key && tag.color !== nextColor))) return [];
        return [{ paper: item, tags: item.tags!.map(tag => item === paper && tag.id === tagId
          ? { ...tag, text: value, color: nextColor }
          : sameName && tagKey(tag.text) === key && tag.color !== nextColor ? { ...tag, color: nextColor } : tag) }];
      });
      await this.saveTagChanges(updates);
    });
  }
  moveTag(id: string, tagId: string, position: PaperTagPosition): Promise<void> {
    return this.organize(async () => {
      const paper = this.get(id);
      if (!paper.tags?.some(tag => tag.id === tagId)) throw new Error('找不到这个标签');
      const nextPosition = tagPosition(position);
      await this.saveTags(paper, paper.tags.map(tag => tag.id === tagId ? { ...tag, position: nextPosition } : tag));
    });
  }
  moveFileTag(id: string, kind: PaperFileKind, position: PaperTagPosition): Promise<void> {
    return this.organize(async () => {
      if (kind !== 'pdf' && kind !== 'md') throw new Error('文件类型只能是 PDF 或 MD');
      const paper = this.get(id), nextPosition = tagPosition(position);
      if (!this.fileAvailability(id)[kind]) throw new Error(`这篇文献没有可用的 ${kind.toUpperCase()} 文件`);
      const previous = paper.fileTagPositions;
      paper.fileTagPositions = { ...previous, [kind]: nextPosition };
      try { await this.persist(); } catch (error) {
        if (previous === undefined) delete paper.fileTagPositions; else paper.fileTagPositions = previous;
        throw error;
      }
      this.emit('changed', this.state());
    });
  }
  deleteTag(id: string, tagId: string): Promise<void> {
    return this.organize(async () => {
      const paper = this.get(id);
      if (!paper.tags?.some(tag => tag.id === tagId)) throw new Error('找不到这个标签');
      await this.saveTags(paper, paper.tags.filter(tag => tag.id !== tagId));
    });
  }
  importPaths(paths: string[], folderId: string | null = null): Promise<ImportResult> {
    if (this.storageLocked) return Promise.reject(new Error('正在切换文献库，请稍候'));
    const operation = this.organize(() => this.importSerial(paths, folderId));
    this.imports = operation;
    return operation;
  }
  private async importSerial(paths: string[], folderId: string | null): Promise<ImportResult> {
    if (folderId !== null) this.folder(folderId);
    const result: ImportResult = { imported: 0, duplicates: 0, errors: [], paperIds: [] };
    for (const path of paths) {
      try {
        if (typeof path !== 'string' || extname(path).toLowerCase() !== '.pdf') throw new Error('仅支持 PDF 文件');
        const info = await stat(path);
        if (!info.isFile() || info.size > 100 * 1024 * 1024) throw new Error('请选择小于 100 MB 的 PDF 文件');
        const buffer = await readFile(path);
        if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('文件内容不是有效 PDF');
        const id = createHash('sha256').update(buffer).digest('hex');
        const existing = this.papers.find(p => paperPdfHash(p) === id);
        if (existing) { result.duplicates++; result.paperIds!.push(existing.id); continue; }
        const empty: ExtractedPdf = { title: filenameTitle(basename(path)), authors: [], pageCount: 0, firstPageText: '', doi: '', arxivId: '', abstract: '', year: null };
        const paper: Paper = { ...localMetadata(empty), id, folderId: this.folders.some(f => f.id === folderId) ? folderId : null, fileName: basename(path), fileSize: info.size, pageCount: 0, importedAt: new Date().toISOString(), unread: true, status: 'queued', message: '等待解析 PDF' };
        paper.storageFolder = storageFolderName(paper.title, id, this.papers.map(p => p.storageFolder!));
        await ensurePaperDirectory(this.directory, paper.storageFolder);
        const destination = paperStoragePaths(this.directory, paper).pdf!;
        await writeNewPaperFile(destination, buffer);
        this.papers.unshift(paper);
        try { await this.persist(); } catch (error) { this.papers = this.papers.filter(p => p.id !== id); await unlink(destination); throw error; }
        this.queue.push(id); result.imported++; result.paperIds!.push(id);
        this.emit('changed', this.state());
      } catch (e) { result.errors.push(`${basename(String(path))}：${e instanceof Error ? e.message : '导入失败'}`); }
    }
    this.kick();
    return result;
  }
  async retry(id: string) {
    if (this.storageLocked) throw new Error('正在切换文献库，请稍候');
    const paper = this.get(id);
    if (['queued', 'extracting', 'searching'].includes(paper.status)) return;
    await this.update(id, { status: 'queued', message: '等待重新检索' });
    this.queue.push(id); this.kick();
  }
  async saveMetadata(id: string, metadata: PaperMetadata) {
    if (this.storageLocked) throw new Error('正在切换文献库，请稍候');
    const paper = this.get(id);
    if (['queued', 'extracting', 'searching'].includes(paper.status)) throw new Error('请等待检索完成后再修改');
    if (!metadata || typeof metadata.title !== 'string' || !metadata.title.trim() || metadata.title.length > 2000) throw new Error('请输入有效标题');
    if (!Array.isArray(metadata.authors) || metadata.authors.some(a => typeof a !== 'string' || a.length > 500)) throw new Error('作者格式不正确');
    if (metadata.year !== null && (!Number.isInteger(metadata.year) || metadata.year < 1000 || metadata.year > 2200)) throw new Error('年份格式不正确');
    const publicationDate = metadata.publicationDate === undefined ? dateFromParts([metadata.year]) : metadata.publicationDate;
    if (publicationDate !== '' && !parsePublicationDate(publicationDate)) throw new Error('发表日期格式不正确，请填写年份、年-月或年-月-日，例如 2025-04-02');
    const year = publicationDate ? Number(publicationDate.slice(0, 4)) : null;
    for (const field of ['venue', 'doi', 'arxivId', 'abstract', 'url'] as const) if (typeof metadata[field] !== 'string' || metadata[field].length > 30000) throw new Error('元数据格式不正确');
    const doi = normalizeDoi(metadata.doi);
    if (doi && !/^10\.\d{4,9}\/\S+$/i.test(doi)) throw new Error('DOI 格式不正确，应类似 10.1234/example');
    const url = doi ? `https://doi.org/${doi}` : metadata.arxivId ? `https://arxiv.org/abs/${metadata.arxivId}` : '';
    const clean: PaperMetadata = { title: cleanText(metadata.title), authors: metadata.authors.map(cleanText).filter(Boolean), year, publicationDate, venue: metadata.venue, doi, arxivId: metadata.arxivId, abstract: metadata.abstract, url, source: '手动', matchMethod: '用户已核对', retrievedAt: new Date().toISOString() };
    await this.update(id, { ...clean, abstractSource: '手动', status: 'matched', message: '已保存核对后的元数据' });
  }
  private kick() { void this.process().catch(error => { this.emit('storage-error', error); }); }
  private async process() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        try {
          if (paperPdfHash(this.get(id)) === null) {
            const previous = structuredClone(this.get(id));
            await this.update(id, { status: 'searching', message: previous.doi || previous.arxivId ? '正在通过文献编号检索元数据' : '正在通过标题检索元数据' });
            const result = await this.lookup(citationQuery(previous));
            await this.update(id, { ...(result.matched ? mergeCitationMetadata(previous, result.metadata) : {}),
              status: result.matched ? 'matched' : 'review', message: result.matched ? result.message : result.message.replaceAll('PDF 信息', '导入的书目信息') });
            continue;
          }
          await this.update(id, { status: 'extracting', message: '正在读取 PDF 首页与文档信息' });
          const pdf = await this.extract(this.pdfPath(id), this.get(id).fileName);
          await this.update(id, { ...localMetadata(pdf), pageCount: pdf.pageCount, thumbnail: pdf.thumbnail, status: 'searching', message: pdf.arxivId ? `正在检索 arXiv · ${pdf.arxivId}` : pdf.doi ? '正在通过 DOI 检索元数据' : '正在通过标题检索元数据' });
          if (!pdf.firstPageText.trim()) {
            await this.update(id, { status: 'review', message: '首页未提取到文字，可能是扫描件。当前版本暂不支持 OCR，请手动补充。' });
            continue;
          }
          const result = await this.lookup(pdf);
          await this.update(id, { ...result.metadata, status: result.matched ? 'matched' : 'review', message: result.message });
        } catch (e) {
          const error = e instanceof Error ? e.message : '未知错误';
          await this.update(id, { status: 'error', message: /password/i.test(error) ? 'PDF 已加密，请先解密后重新导入。' : `处理失败：${error}` });
        }
      }
    } finally { this.processing = false; }
  }
  async whenIdle() {
    while (this.processing || this.queue.length) await new Promise(r => setTimeout(r, 20));
    await Promise.all([...this.mineruTasks.values()].map(task => task.done));
    await this.writes;
    await this.aiIndex.whenIdle();
  }
  /** Stop new edits and drain accepted writes before taking a consistent copy. */
  async lockForStorageChange(): Promise<() => void> {
    if (this.storageLocked) throw new Error('正在切换文献库，请稍候');
    if ([...this.mineruTasks.values()].some(task => task.state.status === 'running')) throw new Error('仍有 PDF 正在转换，请完成或取消后再切换文献库');
    this.storageLocked = true;
    try {
      await Promise.all([this.organization.catch(() => {}), this.imports.catch(() => {}), this.cloudWork.catch(() => {})]);
      if ([...this.mineruTasks.values()].some(task => task.state.status === 'running')) throw new Error('仍有 PDF 正在转换，请完成或取消后再切换文献库');
      if (this.processing || this.queue.length || this.papers.some(p => ['queued', 'extracting', 'searching'].includes(p.status))) throw new Error('仍有论文正在导入或检索，请完成后再切换文献库');
      await this.citationMonitor?.pause();
      await this.writes;
      await this.aiIndex.whenIdle();
      return () => { this.storageLocked = false; this.citationMonitor?.resume(); };
    } catch (error) { this.storageLocked = false; this.citationMonitor?.resume(); throw error; }
  }
}

/** Validate without creating directories, starting jobs, or modifying stored data. */
export async function readStoredLibrary(directory: string): Promise<StoredLibrary> {
  await assertRegularFile(join(directory, 'library.json'));
  const source = await readFile(join(directory, 'library.json'), 'utf8');
  const data = JSON.parse(source);
  if (!data || ![1, 2].includes(data.version) || !Array.isArray(data.papers) || data.papers.some((p: Paper) => !p || !/^[a-f0-9]{64}$/.test(p.id) || typeof p.title !== 'string' || !Array.isArray(p.authors))
    || new Set(data.papers.map((p: Paper) => p.id)).size !== data.papers.length) throw new Error('文献库格式异常，请保留 library.json 文件并恢复备份');
  const papers: Paper[] = data.papers;
  validateStoredTags(papers);
  const storageFolders = new Set<string>();
  for (const paper of papers) {
    if (data.version === 2 || paper.storageFolder !== undefined) {
      validateStorageFolder(paper.storageFolder);
      if (storageFolders.has(paper.storageFolder.toLowerCase())) throw new Error('文献资料文件夹重复，请检查备份');
      storageFolders.add(paper.storageFolder.toLowerCase());
      await assertSafeDirectory(paperStoragePaths(directory, paper).directory);
    }
    delete paper.citationMonitor;
    if (paper.citationMonitoring !== undefined && typeof paper.citationMonitoring !== 'boolean') throw new Error('引用监控开关格式异常');
    if (paper.citationSubscription !== undefined && (!paper.citationSubscription || typeof paper.citationSubscription.account !== 'string'
      || !paper.citationSubscription.account || !Number.isSafeInteger(paper.citationSubscription.revision) || paper.citationSubscription.revision <= 0)) throw new Error('云端订阅格式异常，请检查备份');
    const subscription = paper.citationSubscription;
    if (subscription?.paperId !== undefined && (typeof subscription.paperId !== 'string' || !/^[a-f0-9-]{36}$/i.test(subscription.paperId))) throw new Error('云端论文编号异常');
    if (subscription?.retireLegacy !== undefined && (!subscription.retireLegacy || !Number.isSafeInteger(subscription.retireLegacy.id)
      || subscription.retireLegacy.id <= 0 || !Number.isSafeInteger(subscription.retireLegacy.revision) || subscription.retireLegacy.revision <= 0)) throw new Error('旧订阅转入记录异常');
    if (paper.pdfHash !== undefined && paper.pdfHash !== null && (typeof paper.pdfHash !== 'string' || !/^[a-f0-9]{64}$/.test(paper.pdfHash))) throw new Error('PDF 附件信息异常，请保留文献库并检查备份');
    if (paper.catalogKey !== undefined && (typeof paper.catalogKey !== 'string' || !paper.catalogKey || paper.catalogKey.length > 4000)) throw new Error('书目标识异常，请保留文献库并检查备份');
    if (paper.citationOrigins !== undefined && (!Array.isArray(paper.citationOrigins) || paper.citationOrigins.some(origin =>
      !origin || typeof origin !== 'object' || Array.isArray(origin) || typeof origin.id !== 'string' || !/^[a-f0-9]{64}$/.test(origin.id)
      || !Array.isArray(origin.sources) || origin.sources.some(source => !source || typeof source !== 'object' || Array.isArray(source)
        || !['openalex', 'semantic_scholar'].includes(source.provider) || typeof source.id !== 'string')))) {
      throw new Error('引用入库来源异常，请保留文献库并检查备份');
    }
    if (paper.rating !== undefined) validateRating(paper.rating);
    if (paper.briefNote !== undefined && briefNoteText(paper.briefNote) !== paper.briefNote) throw new Error('精简笔记格式异常，请检查文献库备份');
    if (paper.unread !== undefined && typeof paper.unread !== 'boolean') throw new Error('文献打开状态格式异常，请检查文献库备份');
    if (paper.markdownNote !== undefined) validateNote(paper.markdownNote);
    if (paper.readingRecord !== undefined) validateReadingRecord(paper.readingRecord);
    if (paper.fileTagPositions !== undefined) {
      const positions = paper.fileTagPositions;
      if (!positions || typeof positions !== 'object' || Array.isArray(positions)
        || Object.keys(positions).some(key => key !== 'pdf' && key !== 'md')) throw new Error('文件标签位置异常，请保留文献库并检查备份');
      for (const position of Object.values(positions)) tagPosition(position);
    }
  }
  const folders = data.folders === undefined ? [] : data.folders;
  if (!Array.isArray(folders) || folders.some((f: LibraryFolder) => !f || typeof f.id !== 'string' || !/^[a-f0-9-]{36}$/.test(f.id) || typeof f.name !== 'string' || !f.name.trim() || f.name.length > 80)
    || new Set(folders.map((f: LibraryFolder) => f.id)).size !== folders.length
    || papers.some(p => p.folderId != null && !folders.some((f: LibraryFolder) => f.id === p.folderId))) throw new Error('文件夹信息异常，请保留 library.json 并恢复备份');
  return validatedLibrarySnapshot({ version: data.version, papers, folders, timelines: data.timelines === undefined ? defaultTimelines() : validateTimelines(data.timelines) }, source);
}
