import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Library } from '../electron/library';
import { localMetadata } from '../electron/metadata';
import { mergeCitations } from '../electron/citation-data';
import { citationSeed, readCitationSnapshot, writeCitationSnapshot } from '../electron/citation-monitor';
import { serverAddress, validateRecords, type CloudOptions } from '../electron/cloud-client';
import { cloudConnectionLabel } from '../shared/cloud';
import type { CitationRecord } from '../shared/citation-monitor';
import { prepareStorageChange } from '../electron/storage-settings';
import { createDispatcher } from '../electron/ai-api';

const citation = (patch: Partial<CitationRecord> = {}): CitationRecord => ({ id: 'c'.repeat(64), title: 'Citing paper', authors: ['Author'],
  year: 2026, publicationDate: '2026', doi: '10.1234/citing', arxivId: '', abstract: '', venue: '', url: '',
  sources: [{ provider: 'openalex', id: 'W2' }], firstSeenAt: '2026-10-20', lastSeenAt: '2026-10-20', ...patch });
async function fixture() {
  await mkdir('.test-data', { recursive: true });
  const dir = await mkdtemp(resolve('.test-data/cloud-'));
  const make = () => new Library(join(dir, 'library'), async () => { throw Error('no PDF'); }, async p => ({ metadata: localMetadata(p), matched: true, message: '' }));
  const library = make(); await library.initialize();
  const { id } = await library.createPaper({ title: 'Seed', doi: '10.1234/seed' }, null, false);
  let credential: any = null;
  const state = { offline: false, unauthorized: false, account: '1', batch: 1, modern: true, loseResponse: false,
    legacy: [] as any[], bindings: [] as any[], requests: [] as string[], failPage: false, records: [citation()] };
  const overview = (library: string | null) => ({ monitored: new Set([...state.bindings, ...state.legacy].filter(b => b.enabled).map(b => b.paperId)).size,
    queued: 0, failed: 0, lastServerFetchAt: '2026-10-21', legacyMonitored: state.legacy.filter(b => b.enabled).length,
    libraryMonitored: new Set(state.bindings.filter(b => b.enabled && b.library === library).map(b => b.paperId)).size });
  const options: Omit<CloudOptions, 'directory' | 'papers' | 'changed'> = { automatic: false,
    credentials: { read: async () => credential, write: async c => { credential = c; }, clear: async () => { credential = null; } },
    fetch: async (raw, init) => {
      const url = new URL(String(raw)), name = url.pathname.split('/').pop()!; state.requests.push(url.toString());
      assert.equal(url.origin, 'https://monitor.test', 'client must never fetch OpenAlex/S2 directly');
      if (state.offline) throw Error('offline');
      if (name === 'login') return Response.json({ token: 'ptd_test', user: { id: state.account, username: 'researcher' } });
      if (state.unauthorized) return Response.json({}, { status: 401 });
      if (name === 'logout') return Response.json({ ok: true });
      if (name === 'me') return Response.json({ user: { id: state.account }, features: state.modern ? ['monitor-reconciliation-v1'] : [], overview: {} });
      if (name === 'bindings' && init?.method === 'POST') {
        const b = JSON.parse(init.body as string);
        const old = state.bindings.find(p => p.localId === b.localId && p.library === b.library);
        if (old && old.revision > b.revision) return Response.json(old);
        const binding = { ...b, id: old?.id ?? state.bindings.length + 1, paperId: b.paperId ?? '11111111-1111-4111-8111-111111111111', batch: state.batch, status: 'success' };
        state.bindings = [...state.bindings.filter(p => !(p.localId === b.localId && p.library === b.library)), binding];
        if (b.retireLegacy) { const source = state.legacy.find(x => x.id === b.retireLegacy.id)!; if (source.enabled) { source.enabled = false; source.revision++; } }
        if (state.loseResponse) { state.loseResponse = false; throw Error('response lost after commit'); }
        return Response.json(binding);
      }
      if (name === 'bindings') return Response.json({ bindings: state.bindings.filter(b => b.library === url.searchParams.get('library')).map(b => ({ ...b, batch: state.batch })), overview: overview(url.searchParams.get('library')) });
      if (name === 'reconciliation') {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const rows = state.legacy.filter(b => url.searchParams.has('binding') ? b.id === Number(url.searchParams.get('binding')) : b.enabled);
        return Response.json({ version: 1, bindings: state.bindings.filter(b => b.library === url.searchParams.get('library')),
          legacy: rows.slice(offset, offset + 20), total: rows.length, offset, nextOffset: offset + 20 < rows.length ? offset + 20 : null, overview: overview(url.searchParams.get('library')) });
      }
      if (name === 'pause') {
        const b = JSON.parse(init!.body as string), id = Number(url.pathname.split('/').at(-2));
        const source = (b.legacy ? state.legacy : state.bindings).find(x => x.id === id);
        if (!source) return Response.json({}, { status: 404 });
        if (source.revision === b.revision) { source.enabled = false; source.revision++; }
        return Response.json(source);
      }
      if (name === 'results') {
        if (state.failPage && url.searchParams.has('cursor')) return Response.json({}, { status: 503 });
        return Response.json({ batch: state.batch, citations: state.records, providers: [], status: 'success', lastAttemptAt: '2026-10-21',
          next: state.failPage ? 'second' : null, lastSuccessAt: '2026-10-21', nextCheckAt: '' });
      }
      throw Error('unexpected path');
    },
  };
  const cloud = await library.startCloud(options);
  return { library, cloud, state, id, dir, make, options };
}

test('login, persistent offline outbox, idempotent sync, preserved history and no downloaded PDF', async () => {
  const f = await fixture();
  await assert.rejects(f.library.setCitationMonitoring(f.id, true), /登录/);
  await f.library.cloudLogin('https://monitor.test', 'researcher', 'secret');
  f.state.offline = true;
  await f.library.setCitationMonitoring(f.id, true); await f.library.cloudSync();
  assert.equal(f.library.cloudStatus().pending, 1);
  assert.equal(f.library.cloudStatus().lastSyncAt, undefined);
  f.state.offline = false; await f.library.cloudSync();
  assert.equal(f.library.cloudStatus().pending, 0);
  assert.equal(f.library.cloudStatus().newCitations, 1);
  assert.equal((await readCitationSnapshot(f.library.directory, f.id, f.library.get(f.id).storageFolder))?.citations.length, 1);
  assert.equal(f.library.citationDirectory(f.id), join(f.library.directory, 'papers', f.library.get(f.id).storageFolder!, 'citations'));
  const calls = f.state.requests.filter(u => u.includes('/results')).length;
  await f.library.cloudSync();
  assert.equal(f.state.requests.filter(u => u.includes('/results')).length, calls);
  assert.equal(f.library.list().length, 1);
  assert.equal(f.library.get(f.id).pdfHash, null);
  f.state.offline = true; await f.library.setCitationMonitoring(f.id, false);
  assert.equal(f.library.citationState(f.id)?.status, 'pending');
  await f.cloud.pause();
  const restarted = f.make(); await restarted.initialize(); await restarted.startCloud(f.options);
  assert.equal(restarted.cloudStatus().pending, 1);
  f.state.offline = false; await restarted.cloudSync();
  assert.equal(restarted.cloudStatus().pending, 0);
  assert.equal((await readCitationSnapshot(f.library.directory, f.id, f.library.get(f.id).storageFolder))?.citations.length, 1);
  assert.ok(!(await readFile(join(f.library.directory, 'sync/cloud.json'), 'utf8')).includes('ptd_test'));
  const call = createDispatcher(restarted);
  assert.equal((await call('cloud.status', {}) as any).pending, 0);
  assert.ok(!JSON.stringify(await call('cloud.sync', {})).includes('ptd_test'));
});

test('failed pages cannot advance cursor or last successful sync; retry does not duplicate citations', async () => {
  const f = await fixture(); await f.library.cloudLogin('https://monitor.test', 'a', 'p');
  await f.library.setCitationMonitoring(f.id, true); f.state.failPage = true;
  await f.library.cloudSync();
  assert.equal(f.library.cloudStatus().lastSyncAt, undefined);
  assert.equal(JSON.parse(await readFile(join(f.library.directory, 'sync/cloud.json'), 'utf8')).cursors[f.id], undefined);
  f.state.failPage = false; await f.library.cloudSync();
  assert.ok(f.library.cloudStatus().lastSyncAt);
  assert.equal((await readCitationSnapshot(f.library.directory, f.id, f.library.get(f.id).storageFolder))?.citations.length, 1);
});

test('account isolation, expiry and logout do not pause cloud tasks', async () => {
  const f = await fixture(); await f.library.cloudLogin('https://monitor.test', 'a', 'p');
  await f.library.setCitationMonitoring(f.id, true); await f.library.cloudSync();
  await f.library.cloudLogout();
  assert.equal(f.state.bindings[0].enabled, true);
  f.state.account = '2'; await assert.rejects(f.library.cloudLogin('https://monitor.test', 'b', 'p'), /另一账户/);
  assert.equal(f.library.cloudStatus().signedIn, false);
  f.state.account = '1'; await f.library.cloudLogin('https://monitor.test', 'a', 'p');
  f.state.unauthorized = true; await f.library.cloudSync();
  assert.equal(f.library.cloudStatus().signedIn, false);
  assert.equal(f.library.get(f.id).citationMonitoring, true);
});

test('legacy intent needs explicit migration and copied library keeps cursors but no credentials', async () => {
  const f = await fixture();
  f.library.get(f.id).citationMonitoring = true;
  await f.library.setRating(f.id, 4);
  assert.equal(f.library.citationState(f.id)?.status, 'migration');
  await f.library.cloudLogin('https://monitor.test', 'a', 'p'); await f.library.cloudSync();
  assert.equal(f.state.bindings.length, 0);
  await f.library.migrateCloudMonitoring(); await f.library.cloudSync();
  assert.equal(f.state.bindings.length, 1);
  const target = join(f.dir, 'copied'); await mkdir(target);
  await prepareStorageChange(f.library, f.library.directory, 'copy', target);
  assert.deepEqual(await readFile(join(target, 'sync/cloud.json')), await readFile(join(f.library.directory, 'sync/cloud.json')));
  assert.equal((await readCitationSnapshot(target, f.id, f.library.get(f.id).storageFolder))?.citations.length, 1);
});

test('corrupt snapshot and invalid remote records are not overwritten or acknowledged', async () => {
  const f = await fixture(); await f.library.cloudLogin('https://monitor.test', 'a', 'p'); await f.library.setCitationMonitoring(f.id, true);
  f.state.records = [citation({ id: '../bad' })]; await f.library.cloudSync();
  assert.equal(f.library.cloudStatus().lastSyncAt, undefined);
  f.state.records = [citation()]; await f.library.cloudSync();
  const file = join(f.library.citationDirectory(f.id), 'citations.json'); await writeFile(file, '{broken');
  f.state.batch++; await f.library.cloudSync(); assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('dedup bridges provider IDs and preserves histories while conflicts remain separate', () => {
  const a = citation({ doi: '' }), b = citation({ id: 'd'.repeat(64), sources: [{ provider: 'semantic_scholar', id: 's2' }] });
  const merged = mergeCitations([], [a, b], '2026-10-20');
  assert.equal(merged.length, 1); assert.equal(merged[0].sources.length, 2);
  assert.equal(mergeCitations(merged, [b], '2026-10-21')[0].firstSeenAt, '2026-10-20');
  assert.equal(mergeCitations(merged, [citation({ doi: '10.1234/other', sources: [], id: 'e'.repeat(64) })], '').length, 2);
  assert.throws(() => serverAddress('http://remote.test'), /HTTPS/);
  assert.throws(() => serverAddress('https://user:password@remote.test'), /HTTPS/);
  assert.equal(serverAddress('http://127.0.0.1:8081/'), 'http://127.0.0.1:8081');
});

const legacy = (patch: Record<string, unknown> = {}) => ({ id: 50, revision: 1, enabled: true,
  paperId: '11111111-1111-4111-8111-111111111111',
  seed: { title: 'Seed', doi: '10.1234/seed', arxivId: '', authors: [], year: null }, ...patch });

test('review and explicit alignment repair current-library differences without changing other origins', async () => {
  const f = await fixture(); await f.library.cloudLogin('https://monitor.test', 'a', 'p');
  await f.library.setCitationMonitoring(f.id, true); await f.library.cloudSync();
  const original = f.state.bindings[0]; original.enabled = false; original.revision += 10;
  f.state.bindings.push({ ...original, id: 20, localId: 'missing-local', enabled: true });
  f.state.bindings.push({ ...original, id: 21, library: 'other-library', localId: 'other', enabled: true });
  f.state.legacy = [legacy()];
  const review = await f.library.cloudReview();
  assert.deepEqual(review.differences.map(d => d.kind).sort(), ['orphan', 'state']);
  assert.equal(review.total, 1);
  const repaired = await f.library.cloudReconcile();
  assert.deepEqual(repaired.differences, []);
  assert.equal(f.state.bindings.find(b => b.localId === f.id).enabled, true);
  assert.equal(f.state.bindings.find(b => b.localId === 'missing-local').enabled, false);
  assert.equal(f.state.bindings.find(b => b.localId === 'other').enabled, true);
  assert.equal(f.state.legacy[0].enabled, true);
  f.state.bindings = f.state.bindings.filter(b => b.localId !== f.id);
  assert.equal((await f.library.cloudReview()).differences[0].kind, 'missing');
  assert.deepEqual((await f.library.cloudReconcile()).differences, []);
});

test('legacy transfer survives a lost response and restart, reuses existing paper and preserves personal fields', async () => {
  const f = await fixture(); await f.library.cloudLogin('https://monitor.test', 'a', 'p'); await f.library.cloudSync();
  await f.library.setRating(f.id, 5); await f.library.addTag(f.id, 'keep', '#AABBCC');
  f.state.legacy = [legacy()]; f.state.loseResponse = true;
  await assert.rejects(f.library.cloudImportLegacy(50, 1), /已保存到本库/);
  assert.equal(f.library.cloudStatus().pending, 1);
  assert.equal(f.library.list().length, 1);
  assert.equal(f.library.get(f.id).rating, 5); assert.equal(f.library.get(f.id).tags?.[0].text, 'keep');
  assert.equal(f.state.legacy[0].enabled, false);
  await f.cloud.pause();
  const restarted = f.make(); await restarted.initialize(); await restarted.startCloud(f.options); await restarted.cloudSync();
  assert.equal(restarted.cloudStatus().pending, 0);
  assert.equal(restarted.list().length, 1);
  assert.equal(restarted.get(f.id).citationMonitoring, true);
  await assert.rejects(restarted.cloudImportLegacy(50, 1), /已变化/);
});

test('legacy unresolved paper is added without PDF, stopping a different legacy entry preserves local monitoring', async () => {
  const f = await fixture(); await f.library.cloudLogin('https://monitor.test', 'a', 'p'); await f.library.cloudSync();
  f.state.legacy = [legacy({ seed: { title: 'Only on server', doi: '', arxivId: '', authors: [], year: null } }),
    legacy({ id: 51, paperId: '22222222-2222-4222-8222-222222222222' })];
  const result = await f.library.cloudImportLegacy(50, 1);
  assert.equal(result.created, true);
  const p = f.library.get(result.id); assert.equal(p.pdfHash, null); assert.equal(p.citationMonitoring, true);
  assert.equal(p.citationSubscription?.paperId, f.state.legacy[0].paperId);
  assert.equal(f.library.list().length, 2);
  await f.library.cloudStopLegacy(51, 1);
  assert.equal(p.citationMonitoring, true);
  assert.equal(f.state.legacy[1].enabled, false);
  assert.equal(f.library.list().length, 2);
  await f.library.setCitationMonitoring(p.id, false); await f.library.cloudSync();
  assert.equal(f.library.get(p.id).citationSubscription?.paperId, p.citationSubscription?.paperId);
});

test('older server keeps normal sync but rejects unsupported reconciliation before writes', async () => {
  const f = await fixture(); f.state.modern = false;
  await f.library.cloudLogin('https://monitor.test', 'a', 'p');
  await f.library.setCitationMonitoring(f.id, true); await f.library.cloudSync();
  assert.equal(f.library.cloudStatus().pending, 0);
  await assert.rejects(f.library.cloudReview(), /先部署新版/);
  assert.equal(f.library.list().length, 1);
  const call = createDispatcher(f.library);
  await assert.rejects(call('cloud.importLegacy', { id: -1, revision: 1 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(call('cloud.stopLegacy', { id: 1, revision: '1' }), { code: 'INVALID_ARGUMENT' });
});

test('local citation pages preserve all records, work signed out and do not change the library or fetch', async () => {
  const f = await fixture(), paper = f.library.get(f.id);
  const citations = Array.from({ length: 257 }, (_, i) => citation({ id: (i + 1).toString(16).padStart(64, '0'), title: `Citing paper ${i + 1}` }));
  const snapshot = { version: 1 as const, seed: citationSeed(paper), lastAttemptAt: '2026-10-23', lastSuccessAt: '2026-10-23', nextCheckAt: '',
    providers: [{ provider: 'openalex' as const, status: 'success' as const, seedIds: ['W1'], count: citations.length, message: '' }], citations };
  await writeCitationSnapshot(f.library.directory, snapshot, paper.storageFolder);
  const file = join(f.library.citationDirectory(f.id), 'citations.json');
  const originalIndex = await readFile(join(f.library.directory, 'library.json'));
  const originalSnapshot = await readFile(file), originalRequests = [...f.state.requests];
  const page = await f.library.getCitations(f.id);
  assert.equal(page.id, f.id); assert.equal(page.enabled, false);
  assert.equal(page.directory, f.library.citationDirectory(f.id));
  assert.equal(page.total, 257); assert.equal(page.offset, 0); assert.equal(page.limit, 50);
  assert.deepEqual(page.citations, citations.slice(0, 50)); assert.deepEqual(page.providers, snapshot.providers);
  assert.deepEqual((await f.library.getCitations(f.id, 0, 200)).citations, citations.slice(0, 200));
  assert.deepEqual((await f.library.getCitations(f.id, 200, 200)).citations, citations.slice(200));
  assert.deepEqual((await f.library.getCitations(f.id, 300)).citations, []);
  assert.deepEqual(await readFile(join(f.library.directory, 'library.json')), originalIndex);
  const second = await f.library.createPaper({ title: 'Different seed' }, null, false);
  assert.equal((await f.library.getCitations(second.id)).total, 0);
  assert.equal((await f.library.getCitations(second.id)).state, undefined);
  assert.deepEqual(f.state.requests, originalRequests);
  assert.deepEqual(await readFile(file), originalSnapshot);
});

test('local citation pages reject invalid pagination and preserve damaged snapshots', async () => {
  const f = await fixture();
  for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '0']) {
    await assert.rejects(f.library.getCitations(f.id, offset as number), /分页位置/);
  }
  for (const limit of [-1, 0, 201, 0.5, NaN, Infinity, null, '50']) {
    await assert.rejects(f.library.getCitations(f.id, 0, limit as number), /1–200/);
  }
  await assert.rejects(f.library.getCitations('f'.repeat(64)), /找不到/);
  const paper = f.library.get(f.id);
  await writeCitationSnapshot(f.library.directory, { version: 1, seed: citationSeed(paper), lastAttemptAt: '', nextCheckAt: '', providers: [], citations: [] }, paper.storageFolder);
  assert.equal((await f.library.getCitations(f.id)).total, 0);
  const file = join(f.library.citationDirectory(f.id), 'citations.json');
  await writeFile(file, '{broken');
  await assert.rejects(f.library.getCitations(f.id));
  assert.equal(await readFile(file, 'utf8'), '{broken');
  assert.deepEqual(f.state.requests, []);
});

test('local citation pages reject malformed nested fields without overwriting snapshots or backups', async () => {
  const f = await fixture(), paper = f.library.get(f.id), directory = f.library.citationDirectory(f.id);
  const snapshot = { version: 1 as const, seed: citationSeed(paper), lastAttemptAt: '', nextCheckAt: '', providers: [], citations: [citation()] };
  await writeCitationSnapshot(f.library.directory, snapshot, paper.storageFolder);
  const file = join(directory, 'citations.json'), backup = file + '.bak';
  await writeFile(backup, 'keep original backup');
  const malformed: Record<string, unknown>[] = [
    { sources: [null] }, { sources: [[]] }, { sources: ['openalex'] }, { sources: [{ provider: 'unknown', id: 'W1' }] },
    { sources: [{ provider: 'openalex', id: {} }] }, { authors: [null] }, { authors: [{}] },
    { title: {} }, { venue: {} }, { publicationDate: {} }, { url: {} }, { doi: {} }, { arxivId: {} }, { abstract: {} },
    { year: {} }, { year: '2026' }, { year: 2026.5 },
  ];
  for (const patch of malformed) {
    const raw = JSON.stringify({ ...snapshot, citations: [{ ...citation(), ...patch }] });
    await writeFile(file, raw);
    await assert.rejects(f.library.getCitations(f.id), /引用数据格式异常/);
    assert.equal(await readFile(file, 'utf8'), raw);
    assert.equal(await readFile(backup, 'utf8'), 'keep original backup');
  }
  const legacy = citation({ year: null, publicationDate: '', authors: [], sources: [], venue: '', url: '' });
  await writeFile(file, JSON.stringify({ ...snapshot, citations: [legacy] }));
  assert.deepEqual((await f.library.getCitations(f.id)).citations, [legacy]);
  assert.deepEqual(f.state.requests, []);
});

test('missing years are normalized identically on download, local reads and restart without rewriting historical data', async () => {
  const f = await fixture(); await f.library.cloudLogin('https://monitor.test', 'a', 'p');
  await f.library.setCitationMonitoring(f.id, true);
  f.state.records = [citation({ year: undefined })];
  await f.library.cloudSync();
  assert.equal(f.library.cloudStatus().connected, true); assert.equal(f.library.cloudStatus().error, undefined);
  const file = join(f.library.citationDirectory(f.id), 'citations.json');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).citations[0].year, null);
  const old = JSON.parse(await readFile(file, 'utf8')); delete old.citations[0].year;
  const historical = JSON.stringify(old); await writeFile(file, historical);
  await writeFile(file + '.bak', 'preserved backup');
  await f.cloud.pause(); const restarted = f.make(); await restarted.initialize(); await restarted.startCloud(f.options);
  assert.equal(restarted.citationState(f.id)?.count, 1);
  assert.equal((await restarted.getCitations(f.id)).citations[0].year, null);
  await restarted.cloudSync();
  assert.equal(restarted.cloudStatus().error, undefined); assert.ok(restarted.cloudStatus().lastSyncAt);
  assert.equal(await readFile(file, 'utf8'), historical); assert.equal(await readFile(file + '.bak', 'utf8'), 'preserved backup');
});

test('remote validation rejects invalid years and sources before writing or advancing result cursors', async () => {
  const f = await fixture(); await f.library.cloudLogin('https://monitor.test', 'a', 'p'); await f.library.setCitationMonitoring(f.id, true);
  for (const patch of [{ year: '2026' }, { year: 2026.5 }, { sources: [null] }]) {
    f.state.records = [citation(patch as any)]; await f.library.cloudSync();
    const status = f.library.cloudStatus();
    assert.equal(status.connected, true); assert.equal(status.failure?.kind, 'protocol'); assert.equal(status.failure?.stage, 'download');
    assert.equal(status.failure?.paperId, f.id); assert.match(status.failure!.field!, /^citations\[0\]\.(year|sources)/);
    assert.equal(status.lastSyncAt, undefined);
    assert.equal(JSON.parse(await readFile(join(f.library.directory, 'sync/cloud.json'), 'utf8')).cursors[f.id], undefined);
    assert.equal((await f.library.getCitations(f.id)).total, 0);
  }
  assert.equal(validateRecords([{ ...citation(), year: undefined }])[0].year, null);
  f.state.records = [citation()]; await f.library.cloudSync(); assert.equal(f.library.cloudStatus().failure, undefined);
});

test('a local validation failure preserves connection and history, then network failure and expiry get distinct statuses', async () => {
  const f = await fixture(); await f.library.cloudLogin('https://monitor.test', 'a', 'p'); await f.library.setCitationMonitoring(f.id, true); await f.library.cloudSync();
  const before = f.library.cloudStatus(), file = join(f.library.citationDirectory(f.id), 'citations.json');
  const raw = JSON.parse(await readFile(file, 'utf8')); raw.citations[0].authors = null;
  const broken = JSON.stringify(raw); await writeFile(file, broken); await f.library.cloudSync();
  const status = f.library.cloudStatus();
  assert.equal(status.connected, true); assert.equal(status.signedIn, true); assert.equal(status.lastSyncAt, before.lastSyncAt);
  assert.equal(cloudConnectionLabel(status), '已连接，同步失败');
  assert.equal(status.failure?.kind, 'local_data'); assert.equal(status.failure?.stage, 'local_citations');
  assert.equal(status.failure?.paperId, f.id); assert.equal(status.failure?.field, 'citations[0].authors');
  assert.match(status.failure!.file!, /^papers\/.+\/citations\/citations.json$/);
  assert.equal(await readFile(file, 'utf8'), broken);
  f.state.offline = true; await f.library.cloudSync();
  assert.equal(f.library.cloudStatus().failure?.kind, 'network'); assert.equal(f.library.cloudStatus().connected, false);
  assert.equal(cloudConnectionLabel(f.library.cloudStatus()), '连接失败');
  f.state.offline = false; f.state.unauthorized = true; await f.library.cloudSync();
  assert.equal(f.library.cloudStatus().failure?.kind, 'authentication'); assert.equal(f.library.cloudStatus().signedIn, false);
  assert.equal(cloudConnectionLabel(f.library.cloudStatus()), '需重新登录');
});

test('read-only diagnostics probe only the account and page local issues without changing files, cursors, credentials or status', async () => {
  const f = await fixture(); await f.library.cloudLogin('https://monitor.test', 'a', 'p'); await f.library.setCitationMonitoring(f.id, true); await f.library.cloudSync();
  const second = await f.library.createPaper({ title: 'Missing year fixture' }, null, false);
  const file = join(f.library.citationDirectory(f.id), 'citations.json');
  const raw = JSON.parse(await readFile(file, 'utf8')); raw.citations[0].year = 'invalid'; await writeFile(file, JSON.stringify(raw));
  const p = f.library.get(second.id);
  await writeCitationSnapshot(f.library.directory, { ...raw, seed: citationSeed(p), citations: [citation()] }, p.storageFolder);
  const secondFile = join(f.library.citationDirectory(second.id), 'citations.json');
  const old = JSON.parse(await readFile(secondFile, 'utf8')); delete old.citations[0].year; await writeFile(secondFile, JSON.stringify(old));
  const files = [f.library.file, join(f.library.directory, 'sync/cloud.json'), file, secondFile];
  const bytes = await Promise.all(files.map(file => readFile(file)));
  const status = f.library.cloudStatus(), requestCount = f.state.requests.length;
  const dispatch = createDispatcher(f.library);
  const first = await dispatch('cloud.diagnose', { limit: 1 }) as any;
  assert.equal(first.connection.state, 'authenticated'); assert.equal(first.local.nextOffset, 1);
  const next = await dispatch('cloud.diagnose', { offset: 1, limit: 1, checkConnection: false }) as any;
  assert.equal(next.connection.state, 'not_checked'); assert.equal(next.local.nextOffset, null);
  const issues = [...first.local.issues, ...next.local.issues];
  assert.equal(issues.find(issue => issue.paperId === f.id).severity, 'error');
  assert.equal(issues.find(issue => issue.paperId === f.id).field, 'citations[0].year');
  assert.equal(issues.find(issue => issue.paperId === second.id).severity, 'warning');
  assert.equal(issues.find(issue => issue.paperId === second.id).count, 1);
  assert.deepEqual(f.state.requests.slice(requestCount).map(url => new URL(url).pathname), ['/api/desktop/v1/me']);
  assert.deepEqual(f.library.cloudStatus(), status);
  assert.deepEqual(await Promise.all(files.map(file => readFile(file))), bytes);
  assert.equal(JSON.stringify(first).includes('ptd_test'), false);
  f.state.unauthorized = true;
  assert.equal((await f.library.cloudDiagnose()).connection.state, 'unauthorized');
  assert.equal(f.library.cloudStatus().signedIn, true, 'diagnostic probe must not clear the cached session');
  f.state.offline = true;
  assert.equal((await f.library.cloudDiagnose()).connection.state, 'unreachable');
  for (const params of [{ path: 'anywhere' }, { offset: -1 }, { limit: 101 }, { checkConnection: 'yes' }]) {
    await assert.rejects(dispatch('cloud.diagnose', params), { code: 'INVALID_ARGUMENT' });
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.library.cloudDiagnose({}, controller.signal), { name: 'AbortError' });
});

test('failed sync persistence keeps pending work, cursors and last complete sync until retry succeeds', async () => {
  const f = await fixture(); await f.library.cloudLogin('https://monitor.test', 'a', 'p'); await f.library.setCitationMonitoring(f.id, true);
  const client = f.cloud as any, save = client.save.bind(client);
  const failSave = async () => { throw Object.assign(new Error('private filesystem detail'), { code: 'EACCES' }); };
  client.save = failSave;
  await f.library.cloudSync();
  assert.equal(f.library.cloudStatus().pending, 1); assert.equal(f.library.cloudStatus().lastSyncAt, undefined);
  assert.equal(f.library.cloudStatus().connected, true); assert.equal(f.library.cloudStatus().failure?.kind, 'local_storage');
  assert.equal(f.library.cloudStatus().failure?.stage, 'save');
  assert.ok(!JSON.stringify(f.library.cloudStatus()).includes('private filesystem detail'));
  client.save = save; await f.library.cloudSync();
  const before = f.library.cloudStatus(), persisted = await readFile(join(f.library.directory, 'sync/cloud.json'), 'utf8');
  assert.equal(before.pending, 0);
  f.state.batch++; client.save = failSave;
  await f.library.cloudSync();
  assert.equal(client.store.cursors[f.id], 1); assert.equal(f.library.cloudStatus().lastSyncAt, before.lastSyncAt);
  assert.equal(await readFile(join(f.library.directory, 'sync/cloud.json'), 'utf8'), persisted);
  client.save = save; await f.library.cloudSync(); assert.equal(client.store.cursors[f.id], 2);
  const success = f.library.cloudStatus(); client.save = failSave;
  await f.library.cloudSync();
  assert.equal(f.library.cloudStatus().lastSyncAt, success.lastSyncAt);
  assert.equal(f.library.cloudStatus().newCitations, success.newCitations);
  client.save = save; await f.library.cloudSync(); assert.equal(f.library.cloudStatus().failure, undefined);
});
