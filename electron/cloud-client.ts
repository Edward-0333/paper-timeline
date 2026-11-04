import { mkdir, lstat, readFile, writeFile, rename, copyFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Paper } from '../shared/types';
import type { CloudStatus, CloudUser, CloudOverview, CloudBinding, CloudReview, LegacyMonitor } from '../shared/cloud';
import type { CitationMonitorState, CitationRecord, CitationSnapshot } from '../shared/citation-monitor';
import { citationSeed, readCitationSnapshot, writeCitationSnapshot } from './citation-monitor';
import { mergeCitations, seedKey } from './citation-data';

type Credential = { server: string; user: CloudUser; token: string };
interface SyncStore {
  version: 1; libraryId: string; account?: { server: string; user: CloudUser };
  acknowledgements: Record<string, number>; cursors: Record<string, number>;
  lastSyncAt?: string; newCitations: number; overview?: CloudOverview;
}
export interface CloudOptions {
  directory: string; papers: () => Paper[]; changed: () => void; fetch: typeof fetch;
  credentials: { read(): Promise<Credential | null>; write(value: Credential): Promise<void>; clear(): Promise<void> };
  automatic?: boolean;
}
export function serverAddress(value: string) {
  const url = new URL(value.trim());
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash) throw new Error('请输入 HTTPS 服务器地址（本机测试可使用 HTTP）');
  return url.toString().replace(/\/+$/, '');
}
const accountKey = (account: { server: string; user: CloudUser }) => account.server + '|' + account.user.id;
const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9-]{36}$/i.test(v);
const positive = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
function validLegacy(b: any): b is LegacyMonitor {
  return b && positive(b.id) && positive(b.revision) && typeof b.enabled === 'boolean' && uuid(b.paperId)
    && b.seed && typeof b.seed.title === 'string' && b.seed.title.trim().length > 0 && b.seed.title.length <= 1000
    && Array.isArray(b.seed.authors) && b.seed.authors.length <= 300 && b.seed.authors.every((a: unknown) => typeof a === 'string' && a.length <= 300)
    && (b.seed.year === null || (Number.isInteger(b.seed.year) && b.seed.year >= 1000 && b.seed.year <= 3000))
    && typeof b.seed.doi === 'string' && typeof b.seed.arxivId === 'string';
}
async function plain(path: string, directory = false) {
  try { const s = await lstat(path); if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) throw new Error('同步存储不能使用文件链接'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}
export function validateRecords(records: unknown): asserts records is CitationRecord[] {
  if (!Array.isArray(records) || records.length > 200 || records.some(r => !r || !/^[a-f0-9]{64}$/.test(r.id)
    || !['title', 'doi', 'arxivId', 'abstract', 'venue', 'url', 'publicationDate', 'firstSeenAt', 'lastSeenAt'].every(k => typeof r[k] === 'string')
    || !Array.isArray(r.authors) || r.authors.some((a: unknown) => typeof a !== 'string')
    || !Array.isArray(r.sources) || r.sources.some((s: any) => !['openalex', 'semantic_scholar'].includes(s.provider) || typeof s.id !== 'string')))
    throw new Error('服务器引用数据格式异常，未推进同步进度');
}

/** No bibliographic network access: this client only talks to the chosen account server. */
export class CloudClient {
  private store: SyncStore = { version: 1, libraryId: randomUUID(), acknowledgements: {}, cursors: {}, newCitations: 0 };
  private credential: Credential | null = null;
  private states = new Map<string, CitationMonitorState>();
  private connected = false;
  private error?: string;
  private reconciliationSupported?: boolean;
  private paused = true;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private controller?: AbortController;
  constructor(private options: CloudOptions) {}
  private get directory() { return join(this.options.directory, 'sync'); }
  private get file() { return join(this.directory, 'cloud.json'); }
  async initialize() {
    await plain(this.directory, true);
    await mkdir(this.directory, { recursive: true });
    await plain(this.file);
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (value.version !== 1 || typeof value.libraryId !== 'string' || !value.acknowledgements || !value.cursors) throw new Error('同步配置异常，请检查备份');
      this.store = value;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; await this.save(); }
    try { this.credential = await this.options.credentials.read(); }
    catch { this.error = '无法解密本机登录信息，请重新登录'; }
    if (!this.store.account || !this.credential || accountKey(this.store.account) !== accountKey(this.credential)) this.credential = null;
    for (const p of this.options.papers()) {
      try {
        const s = await readCitationSnapshot(this.options.directory, p.id, p.storageFolder);
        if (s) this.states.set(p.id, { status: 'idle', count: s.citations.length, lastAttemptAt: s.lastAttemptAt, lastSuccessAt: s.lastSuccessAt });
      } catch { this.states.set(p.id, { status: 'error', count: 0, message: '历史引用文件异常，请检查备份' }); }
    }
    this.resume();
  }
  private async save() {
    await plain(this.directory, true); await plain(this.file); await plain(this.file + '.bak');
    const temp = join(this.directory, '.' + randomUUID() + '.tmp');
    try {
      await writeFile(temp, JSON.stringify(this.store, null, 2), { flag: 'wx' });
      try { await copyFile(this.file, this.file + '.bak'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      await rename(temp, this.file);
    } finally { await unlink(temp).catch(() => {}); }
  }
  status(): CloudStatus {
    const papers = this.options.papers();
    return structuredClone({ ...this.store.account, signedIn: !!this.credential, connected: this.connected, syncing: !!this.running,
      pending: papers.filter(p => this.pending(p)).length,
      legacyPending: papers.filter(p => p.citationMonitoring && !p.citationSubscription).length,
      lastSyncAt: this.store.lastSyncAt, newCitations: this.store.newCitations, overview: this.store.overview,
      reconciliationSupported: this.reconciliationSupported, error: this.error });
  }
  private pending(p: Paper) { return !!p.citationSubscription && p.citationSubscription.revision > (this.store.acknowledgements[p.id] ?? 0); }
  state(id: string): CitationMonitorState | undefined { return structuredClone(this.states.get(id)); }
  paperState(p: Paper): CitationMonitorState | undefined {
    const state = this.state(p.id) ?? { status: 'idle' as const, count: 0 };
    if (p.citationMonitoring && !p.citationSubscription) return { ...state, status: 'migration', message: '旧本地监控尚未迁移。请在个人首页登录后确认迁移。' };
    if (this.pending(p)) return { ...state, status: 'pending', message: p.citationMonitoring ? '开启请求待同步到服务器' : '暂停请求待同步，服务器可能仍在监控' };
    return p.citationMonitoring || this.states.has(p.id) ? state : undefined;
  }
  intent(paper: Paper, after = 0) {
    if (!this.store.account) throw new Error('请先到个人首页登录 Paper Monitoring，再开启云端引用监控');
    const revision = Math.max(Date.now(), (paper.citationSubscription?.revision ?? 0) + 1, after + 1);
    if (!Number.isSafeInteger(revision)) throw new Error('订阅版本异常，请检查对账数据');
    return { account: accountKey(this.store.account), revision,
      ...(paper.citationSubscription?.paperId ? { paperId: paper.citationSubscription.paperId } : {}) };
  }
  owns(paper: Paper) { return !!this.store.account && paper.citationSubscription?.account === accountKey(this.store.account); }
  private async authenticated() {
    if (!this.credential) throw new Error('请先登录云端账户');
    const c = this.credential;
    const me = await this.request(c.server, 'me', c.token);
    if (me.user?.id !== c.user.id) throw new Error('服务器账户不匹配，已停止对账');
    this.reconciliationSupported = me.features?.includes('monitor-reconciliation-v1') === true;
    if (!this.reconciliationSupported) throw new Error('服务器尚未支持监控对账，请先部署新版 Paper Monitoring；原有同步仍可使用');
    return (path: string, body?: unknown) => this.request(c.server, path, c.token, body);
  }
  async review(offset = 0): Promise<CloudReview> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('无效分页位置');
    const raw = await (await this.authenticated())('reconciliation?library=' + this.store.libraryId + '&offset=' + offset);
    if (raw.version !== 1 || !Array.isArray(raw.bindings) || raw.bindings.some((b: any) => !b || !positive(b.id)
      || !positive(b.revision) || typeof b.enabled !== 'boolean' || typeof b.localId !== 'string' || !uuid(b.paperId))
      || !Array.isArray(raw.legacy) || raw.legacy.length > 20 || !raw.legacy.every(validLegacy)
      || !Number.isSafeInteger(raw.total) || raw.total < 0 || raw.offset !== offset
      || (raw.nextOffset !== null && raw.nextOffset !== offset + 20)
      || !raw.overview || !Number.isSafeInteger(raw.overview.monitored)) throw new Error('服务器对账协议不兼容');
    const bindings = raw.bindings as CloudBinding[], differences: CloudReview['differences'] = [];
    const papers = this.options.papers();
    for (const p of papers.filter(p => this.owns(p))) {
      const b = bindings.find(b => b.localId === p.id);
      const enabled = p.citationMonitoring === true;
      const kind = !b ? 'missing' : b.enabled !== enabled ? 'state' : b.revision !== p.citationSubscription!.revision ? 'version' : null;
      if (kind) differences.push({ localId: p.id, title: p.title, kind, localEnabled: enabled, remote: b });
    }
    for (const b of bindings.filter(b => b.enabled && !papers.some(p => this.owns(p) && p.id === b.localId))) {
      differences.push({ localId: b.localId, title: papers.find(p => p.id === b.localId)?.title ?? b.title ?? '本库没有对应订阅的论文', kind: 'orphan', localEnabled: false, remote: b });
    }
    this.store.overview = raw.overview; await this.save(); this.options.changed();
    return { ...raw, differences, checkedAt: new Date().toISOString() };
  }
  async legacy(id: number, revision: number): Promise<LegacyMonitor> {
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(revision) || revision <= 0) throw new Error('无效旧订阅编号');
    const raw = await (await this.authenticated())(`reconciliation?library=${this.store.libraryId}&binding=${id}`);
    const row = raw.legacy?.find((b: LegacyMonitor) => b.id === id);
    if (!validLegacy(row) || !row.enabled || row.revision !== revision) throw new Error('旧订阅已变化或格式无效，请刷新对账清单');
    return row;
  }
  async pauseBinding(b: CloudBinding | LegacyMonitor, legacy: boolean) {
    return (await this.authenticated())(`bindings/${b.id}/pause`, { library: this.store.libraryId, revision: b.revision, legacy });
  }
  changed() { this.options.changed(); if (!this.paused && this.options.automatic !== false) void this.sync(); }
  async pause() {
    this.paused = true; clearInterval(this.timer); this.timer = undefined;
    this.controller?.abort(); await this.running;
  }
  resume() {
    this.paused = false;
    if (this.options.automatic !== false) {
      if (!this.timer) { this.timer = setInterval(() => void this.sync(), 60000); this.timer.unref(); }
      void this.sync();
    }
  }
  async login(server: string, username: string, password: string) {
    server = serverAddress(server);
    if (!username.trim() || !password) throw new Error('请输入用户名和密码');
    if (this.store.account && server !== this.store.account.server) throw new Error('此文献库已绑定另一服务器，请使用独立文献库连接其他服务器');
    await this.pause();
    try {
      const session = await this.request(server, 'login', '', { username, password, device: 'Paper Timeline' });
      if (typeof session.token !== 'string' || !session.token.startsWith('ptd_') || typeof session.user?.id !== 'string' || typeof session.user?.username !== 'string') throw new Error('服务器登录协议不兼容');
      const credential = { server, user: session.user as CloudUser, token: session.token };
      if (this.store.account && accountKey(this.store.account) !== accountKey(credential)) {
        await this.request(server, 'logout', credential.token, {}).catch(() => {});
        throw new Error('此文献库属于另一账户，请切换文献库后登录，避免混合个人数据');
      }
      // Save the account binding before the OS-encrypted credential. Never store the password.
      this.store.account = { server, user: credential.user };
      await this.save(); await this.options.credentials.write(credential);
      this.credential = credential; this.connected = true; this.error = undefined;
    } finally { this.resume(); this.options.changed(); }
    return this.status();
  }
  async logout() {
    await this.pause();
    let failed = false;
    if (this.credential) await this.request(this.credential.server, 'logout', this.credential.token, {}).catch(() => { failed = true; });
    await this.options.credentials.clear(); this.credential = null; this.connected = false;
    this.error = failed ? '本机已退出；服务器未连接，远程会话尚未撤销，可在网页服务概览中撤销。云端监控继续运行。' : undefined;
    this.resume(); this.options.changed(); return this.status();
  }
  private async request(server: string, path: string, token: string, body?: unknown, signal?: AbortSignal): Promise<any> {
    const response = await this.options.fetch(server + '/api/desktop/v1/' + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) throw Object.assign(new Error('登录失效或账号密码错误，请重新登录'), { unauthorized: true });
    const text = await response.text();
    if (text.length > 20 * 1024 * 1024) throw new Error('服务器响应过大');
    let value; try { value = JSON.parse(text); } catch { throw new Error('服务器未提供兼容的引用同步 API'); }
    if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : `同步请求失败（HTTP ${response.status}）`);
    return value;
  }
  async sync() {
    if (this.running) { await this.running; return this.status(); }
    if (this.paused || !this.credential) return this.status();
    const credential = this.credential, controller = new AbortController();
    this.controller = controller;
    this.running = this.synchronize(credential, controller.signal).catch(async e => {
      if (controller.signal.aborted) return;
      this.connected = false; this.error = e instanceof Error ? e.message : '同步失败';
      if (e?.unauthorized) { this.credential = null; await this.options.credentials.clear(); }
    }).finally(() => { this.running = undefined; this.controller = undefined; this.options.changed(); });
    this.options.changed(); await this.running; return this.status();
  }
  private async synchronize(credential: Credential, signal: AbortSignal) {
    const call = (path: string, body?: unknown) => this.request(credential.server, path, credential.token, body, signal);
    const me = await call('me');
    if (me.user?.id !== credential.user.id) throw new Error('服务器账户不匹配，已停止同步');
    this.connected = true; this.error = undefined;
    this.reconciliationSupported = Array.isArray(me.features) && me.features.includes('monitor-reconciliation-v1');
    for (const p of this.options.papers()) {
      if (!this.pending(p) || p.citationSubscription?.account !== accountKey(credential)) continue;
      if ((p.citationSubscription.paperId || p.citationSubscription.retireLegacy) && !this.reconciliationSupported) throw new Error('当前订阅需要新版服务器支持监控对账，请先升级服务器');
      const ack = await call('bindings', { library: this.store.libraryId, localId: p.id, revision: p.citationSubscription.revision,
        enabled: p.citationMonitoring === true, seed: citationSeed(p),
        ...(p.citationSubscription.paperId ? { paperId: p.citationSubscription.paperId } : {}),
        ...(p.citationSubscription.retireLegacy && p.citationMonitoring ? { retireLegacy: p.citationSubscription.retireLegacy } : {}) });
      signal.throwIfAborted();
      if (ack.revision !== p.citationSubscription.revision || ack.enabled !== (p.citationMonitoring === true)) throw new Error('服务器订阅版本较新，请勿在两台电脑同时操作同一个文献库副本');
      this.store.acknowledgements[p.id] = ack.revision; await this.save();
    }
    const response = await call('bindings?library=' + encodeURIComponent(this.store.libraryId));
    if (!Array.isArray(response.bindings)) throw new Error('服务器订阅格式异常');
    const before: CitationRecord[] = [], incoming: CitationRecord[] = [];
    for (const p of this.options.papers()) {
      const old = await readCitationSnapshot(this.options.directory, p.id, p.storageFolder);
      if (old) before.push(...old.citations);
    }
    for (const b of response.bindings) {
      const current = () => this.options.papers().find(p => p.id === b.localId && p.citationMonitoring && p.citationSubscription?.account === accountKey(credential)
        && p.citationSubscription.revision === b.revision);
      const p = current();
      if (!p || !b.enabled) continue;
      this.states.set(p.id, { ...this.states.get(p.id), count: this.states.get(p.id)?.count ?? 0, status: b.status, lastAttemptAt: b.lastAttemptAt || undefined,
        lastSuccessAt: b.lastSuccessAt || undefined, nextCheckAt: b.nextCheckAt || undefined });
      if (!b.batch || this.store.cursors[p.id] === b.batch) continue;
      let snapshot = await readCitationSnapshot(this.options.directory, p.id, p.storageFolder);
      if (snapshot?.citations.length && seedKey(snapshot.seed) !== seedKey(citationSeed(p))) throw new Error('论文标识与历史引用不一致，请先核对元数据');
      let cursor: string | null = null, revision = 0;
      const visited = new Set<string>();
      do {
        const page = await call(`bindings/${b.id}/results?library=${this.store.libraryId}` + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
        signal.throwIfAborted();
        if (!current()) break;
        validateRecords(page.citations);
        if (!Number.isSafeInteger(page.batch) || page.batch <= 0 || (revision && revision !== page.batch) || !Array.isArray(page.providers)
          || (page.next !== null && typeof page.next !== 'string')) throw new Error('服务器分页版本异常');
        revision = page.batch;
        const at = new Date().toISOString();
        snapshot = { version: 1, seed: citationSeed(p), providers: page.providers, lastAttemptAt: page.lastAttemptAt || '',
          lastSuccessAt: page.lastSuccessAt || snapshot?.lastSuccessAt, nextCheckAt: page.nextCheckAt || '',
          citations: mergeCitations(snapshot?.citations ?? [], page.citations, at) } satisfies CitationSnapshot;
        await writeCitationSnapshot(this.options.directory, snapshot, p.storageFolder);
        incoming.push(...page.citations);
        this.states.set(p.id, { status: page.status, count: snapshot.citations.length, lastAttemptAt: snapshot.lastAttemptAt,
          lastSuccessAt: snapshot.lastSuccessAt, nextCheckAt: snapshot.nextCheckAt,
          message: page.providers.filter((r: any) => r.status !== 'success').map((r: any) => r.provider + '：' + r.message).join('；') });
        cursor = page.next;
        if (cursor) { if (visited.has(cursor)) throw new Error('分页游标重复'); visited.add(cursor); }
        this.options.changed();
      } while (cursor);
      if (current() && !cursor) { this.store.cursors[p.id] = revision; await this.save(); }
    }
    signal.throwIfAborted();
    const uniqueBefore = mergeCitations([], before, '');
    this.store.newCitations = Math.max(0, mergeCitations(uniqueBefore, incoming, '').length - uniqueBefore.length);
    this.store.overview = response.overview; this.store.lastSyncAt = new Date().toISOString();
    await this.save();
  }
}
