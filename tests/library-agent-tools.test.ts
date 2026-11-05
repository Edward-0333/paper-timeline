import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Library } from '../electron/library';
import { createLibraryTools, type LibraryToolAccess, type LibraryToolOptions } from '../electron/library-agent-tools';
import type { LibraryApprovalDraft, LibraryChatDecision } from '../shared/library-chat';
import { emptyModelConfiguration, type ModelConfiguration, type ModelConfigurationInput } from '../shared/model-settings';
import { citationSeed, writeCitationSnapshot } from '../electron/citation-monitor';

async function fixture() {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(resolve('.test-data/library-agent-tools-'));
  const library = new Library(join(root, 'library'), async () => { throw new Error('PDF parsing forbidden'); }, async () => { throw new Error('retrieval forbidden'); });
  await library.initialize();
  const first = await library.createPaper({ title: 'First known paper', authors: ['Known Author'], abstract: 'Verified abstract' }, null, false);
  const second = await library.createPaper({ title: 'Second known paper' }, null, false);
  let modelState: ModelConfiguration = { ...emptyModelConfiguration(), configured: true, name: 'Existing', model: 'fixture-model', baseUrl: 'https://fixture.invalid/v1',
    activeId: 'legacy', hasApiKey: true, profiles: [{ id: 'legacy', name: 'Existing', model: 'fixture-model', baseUrl: 'https://fixture.invalid/v1', hasApiKey: true, updatedAt: '2026-01-01T00:00:00.000Z' }] };
  const saves: { input: ModelConfigurationInput; activate: boolean | undefined }[] = [];
  const models: LibraryToolAccess['models'] = {
    status: async () => structuredClone(modelState),
    save: async (input, activate) => {
      saves.push({ input, activate });
      const profile = { id: '00000000-0000-4000-8000-000000000001', name: input.name, baseUrl: input.baseUrl, model: input.model, hasApiKey: !!input.apiKey, updatedAt: '2026-01-02T00:00:00.000Z' };
      modelState = { ...modelState, profiles: [...modelState.profiles, profile] }; return structuredClone(modelState);
    },
    select: async id => { const profile = modelState.profiles.find(item => item.id === id)!;
      modelState = { ...modelState, ...profile, configured: true, activeId: id }; return structuredClone(modelState); },
  };
  const approvals: LibraryApprovalDraft[] = [], controller = new AbortController();
  let decide: LibraryToolOptions['confirm'] = async draft => { approvals.push(draft); return { id: 'approval', requestId: 'request', approved: true }; };
  const options: LibraryToolOptions = { signal: controller.signal, maxTextTokens: 5000, confirm: (draft, signal) => decide(draft, signal) };
  const kit = createLibraryTools({ library, models }, options);
  const call = (name: string, input: unknown = {}) => (kit.tools[name].execute as any)(input, { toolCallId: 'test-call', messages: [] });
  return { root, library, first: first.id, second: second.id, models, saves, approvals, controller, options, kit, call,
    setDecision(fn: LibraryToolOptions['confirm']) { decide = fn; } };
}

test('management reads use metadata only, expose no file-reader tools or credentials and leave library unchanged', async () => {
  const f = await fixture(), before = await readFile(f.library.file, 'utf8');
  const forbidden = ['read_text', 'prepare_fulltext', 'view_image', 'view_pdf_page', 'shell', 'read_file', 'papers_import'];
  forbidden.forEach(name => assert.equal(name in f.kit.tools, false));
  const info = await f.call('library_info'); assert.equal(info.total, 2);
  const page = await f.call('list_papers', { query: 'First' }); assert.equal(page.papers.length, 1); assert.equal(page.papers[0].id, f.first);
  const item = await f.call('get_paper', { id: f.first }); assert.equal(item.title, 'First known paper');
  assert.equal(item.directory, undefined); assert.equal(item.pdfPath, undefined); assert.equal(item.readingRecord, undefined);
  const field = await f.call('get_paper', { id: f.first, field: 'abstract' }); assert.equal(field.content, 'Verified abstract');
  const status = await f.call('list_models'); assert.equal(status.profiles[0].apiKey, undefined);
  assert.equal(f.approvals.length, 0); assert.equal(await readFile(f.library.file, 'utf8'), before);
});

test('every management mutation waits for an exact local preview, cancellation writes nothing', async () => {
  const f = await fixture(), before = await readFile(f.library.file, 'utf8');
  f.setDecision(async draft => {
    assert.equal(f.library.get(f.first).title, 'First known paper');
    assert.equal(draft.title, '修改文献元数据');
    assert.deepEqual(draft.changes[0].before, { title: 'First known paper' });
    assert.deepEqual(draft.changes[0].after, { title: 'Edited paper' });
    return { id: 'approval', requestId: 'request', approved: false };
  });
  const result = await f.call('change_library', { operation: 'metadata.update', params: { id: f.first, fields: { title: 'Edited paper' } } });
  assert.equal(result.cancelled, true); assert.equal(await readFile(f.library.file, 'utf8'), before);
});

test('approved writes reuse library APIs and preserve unrelated metadata and paper identity', async () => {
  const f = await fixture();
  const changed = await f.call('change_library', { operation: 'metadata.update', params: { id: f.first, fields: { title: 'Corrected' } } });
  assert.equal(changed.ok, true); assert.equal(f.library.get(f.first).title, 'Corrected');
  assert.deepEqual(f.library.get(f.first).authors, ['Known Author']); assert.equal(f.library.get(f.first).abstract, 'Verified abstract');
  const created = await f.call('change_library', { operation: 'folders.create', params: { name: 'Research' } });
  assert.equal(created.ok, true);
  await f.call('change_library', { operation: 'papers.move', params: { id: f.first, folderId: created.folder.id } });
  assert.equal(f.library.get(f.first).folderId, created.folder.id);
  const deleted = await f.call('change_library', { operation: 'folders.delete', params: { id: created.folder.id } });
  assert.equal(deleted.ok, true); assert.equal(f.library.get(f.first).folderId, null);
  assert.equal(f.library.list().length, 2); assert.equal(f.library.get(f.second).title, 'Second known paper');
  assert.match(f.approvals.at(-1)!.description, /1 篇论文/);
});

test('stale previews and invalid capability parameters cannot overwrite later user changes', async () => {
  const f = await fixture();
  f.setDecision(async () => {
    await f.library.saveMetadata(f.first, { ...f.library.get(f.first), title: 'Edited elsewhere' });
    return { id: 'approval', requestId: 'request', approved: true };
  });
  const result = await f.call('change_library', { operation: 'metadata.update', params: { id: f.first, fields: { title: 'Old proposed title' } } });
  assert.equal(result.stale, true); assert.equal(f.library.get(f.first).title, 'Edited elsewhere');
  f.setDecision(async () => { throw new Error('invalid operation must not reach approval'); });
  for (const [operation, params] of [
    ['papers.import', { paths: ['C:/secret.pdf'] }], ['metadata.update', { id: f.first, fields: { source: '手动' } }],
    ['papers.move', { id: f.first, folderId: null, path: 'C:/anything' }], ['tags.delete', { id: f.first, tagId: '../file' }],
  ]) assert.equal((await f.call('change_library', { operation, params })).ok, false);
  assert.equal(f.library.get(f.first).title, 'Edited elsewhere');
});

test('tag recoloring preview covers all affected papers, deletion requires its own confirmation', async () => {
  const f = await fixture();
  const one = await f.library.addTag(f.first, 'Shared', '#112233'); await f.library.addTag(f.second, 'SHARED', '#112233');
  const recolor = await f.call('change_library', { operation: 'tags.update', params: { id: f.first, tagId: one.id, text: 'Shared', color: '#445566' } });
  assert.equal(recolor.ok, true); assert.match(f.approvals[0].description, /全库 2 篇论文/);
  const after = f.approvals[0].changes[0].after as any; assert.deepEqual(after.affectedPapers.map((item: any) => item.paperId).sort(), [f.first, f.second].sort());
  assert.equal(f.library.get(f.second).tags![0].color, '#445566');
  f.setDecision(async draft => { assert.match(draft.description, /Shared/); return { id: 'a', requestId: 'r', approved: false }; });
  await f.call('change_library', { operation: 'tags.delete', params: { id: f.first, tagId: one.id } });
  assert.equal(f.library.get(f.first).tags!.length, 1);
});

test('monitoring tools display exact target and preserve pending status; no unconfirmed cloud changes', async () => {
  const f = await fixture(); let syncCalls = 0, monitorCalls = 0;
  f.library.cloudStatus = () => ({ signedIn: true, connected: false, syncing: false, server: 'https://monitor.invalid', user: { id: 'one', username: 'fixture' }, pending: 1, legacyPending: 0, newCitations: 0 });
  f.library.setCitationMonitoring = async (id, enabled) => { monitorCalls++; f.library.get(id).citationMonitoring = enabled; };
  f.library.cloudSync = async () => { syncCalls++; return f.library.cloudStatus(); };
  f.setDecision(async draft => {
    assert.match(draft.description, /First known paper/); assert.match(draft.description, /服务器确认/);
    return { id: 'a', requestId: 'r', approved: false };
  });
  await f.call('change_library', { operation: 'citations.setMonitoring', params: { id: f.first, enabled: true } });
  assert.equal(monitorCalls, 0);
  f.setDecision(async () => ({ id: 'a', requestId: 'r', approved: true }));
  assert.equal((await f.call('change_library', { operation: 'citations.setMonitoring', params: { id: f.first, enabled: true } })).ok, true);
  assert.equal(monitorCalls, 1);
  assert.equal((await f.call('sync_cloud')).pending, 1); assert.equal(syncCalls, 1);
});

test('assistant diagnostics identify a registered broken citation field without approval, writes or arbitrary file access', async () => {
  const f = await fixture(), p = f.library.get(f.first);
  await writeCitationSnapshot(f.library.directory, { version: 1, seed: citationSeed(p), providers: [], citations: [], lastAttemptAt: '', nextCheckAt: '' }, p.storageFolder);
  const file = join(f.library.citationDirectory(f.first), 'citations.json');
  const broken = JSON.stringify({ version: 1, seed: citationSeed(p), providers: [], lastAttemptAt: '', nextCheckAt: '', citations: [{ id: 'invalid' }] });
  await writeFile(file, broken);
  const result = await f.call('diagnose_cloud', { checkConnection: false });
  assert.equal(result.local.issues[0].paperId, f.first);
  assert.equal(result.local.issues[0].field, 'citations[0].id');
  assert.equal(result.local.issues[0].severity, 'error');
  assert.equal(result.connection.state, 'not_checked');
  assert.equal(f.approvals.length, 0); assert.equal(await readFile(file, 'utf8'), broken);
  assert.equal((await f.call('diagnose_cloud', { path: 'C:/secret' })).ok, false);
  assert.equal(f.kit.activity.some(step => step.tool === 'diagnose_cloud'), true);
});

test('new model API keys enter only through local decision; saving preserves prior profiles and selection', async () => {
  const f = await fixture(), secret = 'fixture-credential-do-not-send';
  f.setDecision(async draft => {
    assert.equal(JSON.stringify(draft).includes(secret), false); assert.equal((draft.modelDraft as any).apiKey, undefined);
    return { id: 'a', requestId: 'r', approved: true, apiKey: secret, withoutApiKey: false };
  });
  const added = await f.call('add_model', { name: 'New model', baseUrl: 'https://new.invalid/v1/', model: 'new-model', contextWindowTokens: 32768 });
  assert.equal(added.ok, true); assert.equal(added.activeId, 'legacy');
  assert.equal(f.saves[0].input.profileId, null); assert.equal(f.saves[0].activate, false); assert.equal(f.saves[0].input.apiKey, secret);
  assert.equal(JSON.stringify(added).includes(secret), false); assert.equal(JSON.stringify(f.kit.activity).includes(secret), false);
  assert.equal((await f.models.status()).profiles.length, 2);
  f.setDecision(async () => ({ id: 'a', requestId: 'r', approved: true }));
  const selected = await f.call('select_model', { id: added.profile.id }); assert.equal(selected.activeId, added.profile.id);
  assert.equal((await f.models.status()).profiles[0].id, 'legacy');
});

test('model save errors never echo local credential, cancellation during approval cannot write', async () => {
  const f = await fixture();
  f.models.save = async () => { throw new Error('server leaked fixture-secret-key'); };
  f.setDecision(async () => ({ id: 'a', requestId: 'r', approved: true, apiKey: 'fixture-secret-key', withoutApiKey: false }));
  const result = await f.call('add_model', { name: 'Model', baseUrl: 'https://new.invalid', model: 'test' });
  assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes('fixture-secret-key'), false);
  f.setDecision(async () => { f.controller.abort(); return { id: 'a', requestId: 'r', approved: true }; });
  await assert.rejects(f.call('change_library', { operation: 'papers.setRating', params: { id: f.first, rating: 5 } }));
  assert.equal(f.library.get(f.first).rating, undefined);
});

test('bounded fields and list pagination retain continuation offsets without loading attachments', async () => {
  const f = await fixture();
  await f.library.saveMetadata(f.first, { ...f.library.get(f.first), abstract: '证据内容'.repeat(1000) });
  f.options.maxTextTokens = 700;
  let offset = 0, joined = '', pages = 0;
  for (;;) {
    const result = await f.call('get_paper', { id: f.first, field: 'abstract', offset });
    assert.equal(result.ok, undefined); assert.ok(result.content.length > 0);
    joined += result.content; pages++; if (result.nextOffset === null) break; offset = result.nextOffset;
    if (pages >= 24) break;
  }
  assert.ok(pages > 1); assert.equal(joined, f.library.get(f.first).abstract);
});

async function holdNextWrite(library: Library) {
  const internal = library as any, persist = internal.persist.bind(library);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  let held = false;
  internal.persist = async () => { if (!held) { held = true; entered(); await gate; } return persist(); };
  const blocker = library.createFolder('Holding earlier write');
  await started;
  return { release, blocker };
}

test('approval guard rechecks after queued desktop edits and does not overwrite their newer state', async () => {
  const f = await fixture(), hold = await holdNextWrite(f.library);
  const earlierEdit = f.library.setRating(f.first, 2);
  const action = f.call('change_library', { operation: 'papers.setRating', params: { id: f.first, rating: 5 } });
  await new Promise<void>(resolve => setImmediate(resolve));
  hold.release(); await hold.blocker; await earlierEdit;
  const result = await action;
  assert.equal(result.ok, false); assert.equal(f.library.get(f.first).rating, 2);
  assert.equal(f.kit.activity.at(-1)?.status, 'failed');
});

test('stop while an approved mutation is queued prevents that mutation from running', async () => {
  const f = await fixture(), hold = await holdNextWrite(f.library);
  const action = f.call('change_library', { operation: 'papers.setRating', params: { id: f.first, rating: 5 } });
  const rejected = assert.rejects(action);
  await new Promise<void>(resolve => setImmediate(resolve));
  f.controller.abort(); hold.release(); await hold.blocker; await rejected;
  assert.equal(f.library.get(f.first).rating, undefined);
});

test('queued metadata edits to other fields are preserved when the Agent proposes a title-only change', async () => {
  const f = await fixture(), hold = await holdNextWrite(f.library);
  const earlierEdit = f.library.saveMetadata(f.first, { ...f.library.get(f.first), authors: ['New verified author'] });
  const action = f.call('change_library', { operation: 'metadata.update', params: { id: f.first, fields: { title: 'Proposed title' } } });
  await new Promise<void>(resolve => setImmediate(resolve));
  hold.release(); await hold.blocker; await earlierEdit;
  const result = await action;
  assert.equal(result.ok, false); assert.equal(f.library.get(f.first).title, 'First known paper');
  assert.deepEqual(f.library.get(f.first).authors, ['New verified author']);
});

test('failed metadata persistence restores the original in-memory and on-disk metadata', async () => {
  const f = await fixture(), original = structuredClone(f.library.get(f.first)), disk = await readFile(f.library.file, 'utf8');
  await mkdir(f.library.file + '.tmp');
  const result = await f.call('change_library', { operation: 'metadata.update', params: { id: f.first, fields: { title: 'Must not persist', publicationDate: '2025-03' } } });
  assert.equal(result.ok, false); assert.deepEqual(f.library.get(f.first), original); assert.equal(await readFile(f.library.file, 'utf8'), disk);
});

test('success remains success when a committed public configuration result exceeds the response budget', async () => {
  const f = await fixture(); f.options.maxTextTokens = 256;
  f.setDecision(async () => ({ id: 'a', requestId: 'r', approved: true, withoutApiKey: true }));
  const result = await f.call('add_model', { name: '模型'.repeat(30), baseUrl: 'https://new.invalid/' + 'a'.repeat(1800), model: 'model'.repeat(45) });
  assert.equal(result.ok, true); assert.ok(result.profile.id); assert.equal(f.saves.length, 1); assert.equal(f.kit.activity.at(-1)?.status, 'succeeded');
});
