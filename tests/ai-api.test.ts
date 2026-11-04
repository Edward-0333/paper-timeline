import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, access, rmdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Agent, request } from 'node:http';
import { Library } from '../electron/library';
import { localMetadata } from '../electron/metadata';
import { createDispatcher, startAiApi } from '../electron/ai-api';
import type { ExtractedPdf, Paper, PaperTag } from '../shared/types';
import capabilities from '../ai/capabilities.json';

const pdf: ExtractedPdf = { title: 'AI interface test paper', authors: ['Test Author'], year: 2025, pageCount: 1, firstPageText: 'text', doi: '', arxivId: '', abstract: 'Known abstract', thumbnail: 'large-base64-thumbnail' };
async function setup() {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(resolve('.test-data/ai-api-'));
  const library = new Library(join(root, 'library'), async () => pdf, async p => ({ metadata: localMetadata(p), matched: true, message: 'fixture match' }));
  await library.initialize();
  return { root, library, call: createDispatcher(library) };
}

test('AI discovery operations support import, pagination, classification, partial editing and guarded refresh', async () => {
  const { root, library, call } = await setup();
  const file = join(root, '论文 sample.pdf'); await writeFile(file, '%PDF-1.7\nAPI fixture');
  const folder = await call('folders.create', { name: '世界模型' }) as any;
  const imported = await call('papers.import', { paths: [file], folderId: folder.id }) as any;
  assert.equal(imported.imported, 1); assert.equal(imported.paperIds.length, 1);
  await library.whenIdle();
  const id = imported.paperIds[0];
  const list = await call('papers.list', { query: 'interface', folderId: folder.id, limit: 1 }) as any;
  assert.equal(list.total, 1); assert.equal(list.papers[0].id, id);
  assert.equal('thumbnail' in list.papers[0], false); assert.equal('abstract' in list.papers[0], false);
  assert.equal((await call('papers.list', { offset: 1 }) as any).papers.length, 0);
  const duplicate = await call('papers.import', { paths: [file] }) as any;
  assert.deepEqual(duplicate.paperIds, [id]); assert.equal(duplicate.duplicates, 1);
  const mixed = await call('papers.import', { paths: [file, join(root, 'missing.pdf')] }) as any;
  assert.equal(mixed.errors.length, 1); assert.deepEqual(mixed.paperIds, [id]);
  const originalPdf = await readFile(library.pdfPath(id));
  const original = await call('papers.get', { id }) as any;
  assert.equal(original.abstract, pdf.abstract); assert.equal('thumbnail' in original, false);
  assert.equal(original.folderId, folder.id); assert.equal(original.pdfPath, library.pdfPath(id));
  assert.equal(original.directory, library.paperDirectory(id));
  await access(join(original.directory, 'original.pdf'));
  await call('metadata.update', { id, fields: { publicationDate: '2024-02-29', title: 'Corrected title' } });
  assert.deepEqual(library.get(id).authors, pdf.authors); assert.equal(library.get(id).abstract, pdf.abstract);
  assert.equal(library.get(id).year, 2024); assert.equal(library.get(id).source, '手动');
  await assert.rejects(call('metadata.refresh', { id }), { code: 'MANUAL_METADATA' });
  assert.equal(library.get(id).title, 'Corrected title');
  assert.equal((await call('metadata.refresh', { id, replaceManual: true }) as any).accepted, true);
  await library.whenIdle();
  assert.equal(library.get(id).title, pdf.title); assert.equal(library.get(id).folderId, folder.id);
  await call('folders.rename', { id: folder.id, name: '规划' });
  assert.deepEqual((await call('folders.list') as any).folders, [{ id: folder.id, name: '规划', count: 1 }]);
  await call('papers.move', { id, folderId: null });
  assert.equal((await call('papers.list', { folderId: null }) as any).total, 1);
  await call('papers.move', { id, folderId: folder.id });
  await call('folders.delete', { id: folder.id });
  assert.equal(library.get(id).folderId, null); assert.deepEqual(await readFile(library.pdfPath(id)), originalPdf);
  const before = await readFile(library.file, 'utf8');
  const status = await call('app.status') as any;
  assert.equal(status.total, 1); assert.equal(status.pending, 0); assert.equal(status.storagePath, library.directory);
  assert.equal(await readFile(library.file, 'utf8'), before);
});

test('AI parameter validation rejects unsafe or unsupported inputs before writes', async () => {
  const { call, library } = await setup();
  const before = JSON.stringify(library.state());
  const cases: [string, unknown][] = [
    ['papers.list', { limit: 101 }], ['papers.list', { offset: -1 }], ['papers.list', { status: 'done' }],
    ['papers.list', { folderId: {} }], ['papers.list', []], ['papers.list', { execute: 'anything' }],
    ...['', '   ', '\t', 'x'.repeat(81), 'line\nbreak', 'tag\u0001', 'tag\u0085', null, 1, [], {}]
      .map(tag => ['papers.list', { tag }] as [string, unknown]),
    ['papers.get', { id: '../library.json' }], ['metadata.refresh', { id: 'a'.repeat(64), replaceManual: 'true' }],
    ['metadata.update', { id: 'a'.repeat(64), fields: {} }],
    ['metadata.update', { id: 'a'.repeat(64), fields: { status: 'matched' } }],
    ['metadata.update', { id: 'a'.repeat(64), fields: JSON.parse('{"__proto__": {"title":"bad"}}') }],
    ['papers.import', { paths: ['relative.pdf'] }], ['papers.import', { paths: [] }],
    ['papers.import', { paths: Array(201).fill('C:/a.pdf') }],
    ['folders.create', { name: 'x'.repeat(81) }],
    ['tags.add', { id: 'a'.repeat(64), text: 'tag' }],
    ['tags.add', { id: 'a'.repeat(64), text: '', color: '#AABBCC' }],
    ['tags.add', { id: 'a'.repeat(64), text: '   ', color: '#AABBCC' }],
    ['tags.add', { id: 'a'.repeat(64), text: 'x'.repeat(81), color: '#AABBCC' }],
    ['tags.add', { id: 'a'.repeat(64), text: 'line\nbreak', color: '#AABBCC' }],
    ['tags.add', { id: 'a'.repeat(64), text: '\u0001', color: '#AABBCC' }],
    ['tags.add', { id: 'a'.repeat(64), text: 'tag\u0085', color: '#AABBCC' }],
    ['tags.add', { id: 'a'.repeat(64), text: 'tag', color: 'red' }],
    ['tags.add', { id: 'a'.repeat(64), text: 'tag', color: '#fff' }],
    ['tags.add', { id: 'a'.repeat(64), text: 'tag', color: 'url(file:///test)' }],
    ['tags.update', { id: 'a'.repeat(64), tagId: '../tag', text: 'tag', color: '#AABBCC' }],
    ['tags.delete', { id: 'a'.repeat(64), tagId: 'b'.repeat(64) }],
    ['tags.move', { id: 'a'.repeat(64), tagId: '../tag', position: { side: 'top', offset: 0.5 } }],
    ['tags.move', { id: 'a'.repeat(64), tagId: '00000000-0000-4000-8000-000000000000' }],
    ...[null, [], {}, { side: 'top' }, { offset: 0.5 }, { side: 'center', offset: 0.5 },
      { side: 'right', offset: -0.01 }, { side: 'bottom', offset: 1.01 }, { side: 'left', offset: '0.5' },
      { side: 'top', offset: NaN }, { side: 'top', offset: Infinity }, { side: 'top', offset: -Infinity },
      { side: 'top', offset: 0.5, x: 12 },
    ].map(position => ['tags.move', { id: 'a'.repeat(64), tagId: '00000000-0000-4000-8000-000000000000', position }] as [string, unknown]),
    ['metadata.update', { id: 'a'.repeat(64), fields: { tags: [] } }],
  ];
  for (const [operation, params] of cases) await assert.rejects(call(operation, params), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(call('shell.execute', {}), { code: 'UNKNOWN_OPERATION' });
  await assert.rejects(call('papers.get', { id: 'a'.repeat(64) }), { code: 'NOT_FOUND' });
  assert.equal(JSON.stringify(library.state()), before);
});

test('AI tag queries use names and intersect search, status and folders before pagination without writes', async () => {
  const { root, library, call } = await setup();
  const folder = await call('folders.create', { name: '标签查询测试' }) as { id: string };
  const ids: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const file = join(root, `tag-query-${index}.pdf`);
    await writeFile(file, `%PDF-tag query fixture ${index}`);
    const imported = await call('papers.import', { paths: [file], folderId: index < 2 ? folder.id : null }) as { paperIds: string[] };
    ids.push(imported.paperIds[0]);
  }
  await library.whenIdle();
  const firstTag = await call('tags.add', { id: ids[0], text: 'Research', color: '#112233' }) as PaperTag;
  await call('tags.add', { id: ids[1], text: 'research', color: '#445566' });
  await call('tags.add', { id: ids[2], text: 'RESEARCH', color: '#778899' });
  await call('tags.add', { id: ids[1], text: '视觉-动作', color: '#778899' });
  await call('metadata.update', { id: ids[1], fields: { title: 'Distinct title' } });
  const before = await readFile(library.file, 'utf8');
  const list = (params: Record<string, unknown> = {}) => call('papers.list', params) as Promise<{ total: number; papers: Paper[] }>;
  assert.equal((await list()).total, 4);
  const matching = await list({ tag: ' ReSeArCh ' });
  assert.equal(matching.total, 3);
  assert.deepEqual(matching.papers.map(item => item.id).sort(), ids.slice(0, 3).sort());
  assert.equal((await list({ tag: firstTag.id })).total, 0);
  assert.equal((await list({ tag: 'search' })).total, 0);
  assert.equal((await list({ tag: 'unknown' })).total, 0);
  assert.equal((await list({ tag: 'x'.repeat(80) })).total, 0);
  assert.deepEqual((await list({ tag: '视觉-动作' })).papers.map(item => item.id), [ids[1]]);
  const folderPage = await list({ tag: 'research', folderId: folder.id, status: 'matched', limit: 1, offset: 1 });
  assert.equal(folderPage.total, 2);
  assert.deepEqual(folderPage.papers, (await list({ tag: 'research', folderId: folder.id })).papers.slice(1, 2));
  assert.deepEqual((await list({ tag: 'research', query: 'Distinct', status: 'matched', folderId: folder.id })).papers.map(item => item.id), [ids[1]]);
  assert.equal((await list({ tag: 'research', query: 'Distinct', folderId: null })).total, 0);
  assert.equal((await list({ tag: 'research', status: 'review' })).total, 0);
  assert.deepEqual((await list({ tag: 'research', folderId: null })).papers.map(item => item.id), [ids[2]]);
  const lastPage = await list({ tag: 'research', offset: 3 });
  assert.equal(lastPage.total, 3); assert.equal(lastPage.papers.length, 0);
  assert.equal(await readFile(library.file, 'utf8'), before);
});

test('AI multi-tag queries apply intersection or union before other filters and pagination', async () => {
  const { root, library, call } = await setup();
  const ids: string[] = [];
  for (let index = 0; index < 4; index++) {
    const file = join(root, 'multi-tag-' + index + '.pdf');
    await writeFile(file, '%PDF-multi-tag fixture ' + index);
    const imported = await call('papers.import', { paths: [file] }) as { paperIds: string[] };
    ids.push(imported.paperIds[0]);
  }
  await library.whenIdle();
  for (const id of ids.slice(0, 2)) await call('tags.add', { id, text: '视觉', color: '#112233' });
  for (const id of [ids[0], ids[2]]) await call('tags.add', { id, text: 'Network', color: '#445566' });
  await call('metadata.update', { id: ids[0], fields: { title: 'Distinct joint paper' } });
  const before = await readFile(library.file, 'utf8');
  const list = (params: Record<string, unknown>) => call('papers.list', params) as Promise<{ total: number; papers: Paper[] }>;
  const tags = ['视觉', ' NETWORK ', 'network'];
  assert.deepEqual((await list({ tags })).papers.map(item => item.id), [ids[0]]);
  assert.equal((await list({ tags, tagMode: 'all' })).total, 1);
  const union = await list({ tags, tagMode: 'any' });
  assert.deepEqual(union.papers.map(item => item.id).sort(), ids.slice(0, 3).sort());
  const page = await list({ tags, tagMode: 'any', limit: 1, offset: 1 });
  assert.equal(page.total, 3); assert.deepEqual(page.papers, union.papers.slice(1, 2));
  assert.deepEqual((await list({ tags, tagMode: 'any', query: 'Distinct', status: 'matched' })).papers.map(item => item.id), [ids[0]]);
  assert.equal((await list({ tags, tagMode: 'any', status: 'review' })).total, 0);
  for (const tagMode of ['all', 'any']) {
    assert.equal((await list({ tags: [], tagMode })).total, 4);
    assert.equal((await list({ tags: ['missing'], tagMode })).total, 0);
  }
  assert.equal((await list({ tags: ['视觉', 'missing'] })).total, 0);
  assert.equal((await list({ tags: ['视觉', 'missing'], tagMode: 'any' })).total, 2);
  for (const params of [
    { tag: '视觉', tags: ['视觉'] }, { tagMode: 'any' }, { tag: '视觉', tagMode: 'all' },
    { tags: '视觉' }, { tags: null }, { tags: [null] }, { tags: [''] }, { tags: ['   '] },
    { tags: ['bad\ntext'] }, { tags: ['x'.repeat(81)] }, { tags: Array(101).fill('视觉') },
    { tags: [], tagMode: 'xor' }, { tags: [], tagMode: null },
  ]) await assert.rejects(list(params), { code: 'INVALID_ARGUMENT' });
  assert.equal(await readFile(library.file, 'utf8'), before);
});

test('AI tags persist, remain discoverable and preserve paper metadata and PDFs', async () => {
  const { root, library, call } = await setup();
  const file = join(root, 'tagged.pdf'); await writeFile(file, '%PDF-tagged API fixture');
  const imported = await call('papers.import', { paths: [file] }) as { paperIds: string[] };
  await library.whenIdle();
  const id = imported.paperIds[0];
  const original = structuredClone(library.get(id)), originalPdf = await readFile(library.pdfPath(id));
  const tag = await call('tags.add', { id, text: '  视觉-动作  ', color: '#9AD4D6' }) as PaperTag;
  assert.match(tag.id, /^[a-f0-9-]{36}$/); assert.equal(tag.text, '视觉-动作'); assert.equal(tag.color, '#9AD4D6');
  assert.deepEqual((await call('papers.get', { id }) as Paper).tags, [tag]);
  assert.deepEqual((await call('papers.list') as { papers: Paper[] }).papers[0].tags, [tag]);
  const updated = await call('tags.update', { id, tagId: tag.id, text: '单一网络', color: '#7BC58C' }) as Paper;
  assert.deepEqual(updated.tags, [{ id: tag.id, text: '单一网络', color: '#7BC58C' }]);
  assert.equal('thumbnail' in updated, false);
  for (const key of ['title', 'source', 'status', 'matchMethod', 'publicationDate', 'abstract'] as const) assert.equal(updated[key], original[key]);
  assert.deepEqual(updated.authors, original.authors);
  const keep = await call('tags.add', { id, text: 'Research', color: '#AABBCC' }) as PaperTag;
  const beforeInvalid = JSON.stringify(library.state());
  await assert.rejects(call('tags.add', { id, text: 'research', color: '#AABBCC' }));
  await assert.rejects(call('tags.update', { id, tagId: tag.id, text: 'RESEARCH', color: '#AABBCC' }));
  const missingTagId = '00000000-0000-4000-8000-000000000000';
  await assert.rejects(call('tags.update', { id, tagId: missingTagId, text: 'missing', color: '#AABBCC' }), { code: 'NOT_FOUND' });
  await assert.rejects(call('tags.delete', { id, tagId: missingTagId }), { code: 'NOT_FOUND' });
  await assert.rejects(call('tags.add', { id: 'a'.repeat(64), text: 'missing paper', color: '#AABBCC' }), { code: 'NOT_FOUND' });
  assert.equal(JSON.stringify(library.state()), beforeInvalid);
  assert.deepEqual(await call('tags.delete', { id, tagId: tag.id }), { id, tagId: tag.id, deleted: true });
  await call('metadata.refresh', { id }); await library.whenIdle();
  assert.deepEqual((await call('papers.get', { id }) as Paper).tags, [keep]);
  const reloaded = new Library(library.directory, async () => { throw new Error('Reload should not parse a completed paper'); }, async () => { throw new Error('Reload should not search a completed paper'); });
  await reloaded.initialize();
  assert.deepEqual(reloaded.get(id).tags, [keep]);
  assert.equal(reloaded.get(id).source, original.source); assert.equal(reloaded.get(id).status, original.status);
  assert.deepEqual(await readFile(library.pdfPath(id)), originalPdf);
});

test('same-name colors are reused on add, recolored across papers and adopted when renaming into a group', async () => {
  const { library, call } = await setup();
  const ids: string[] = [];
  for (const title of ['Color original', 'Color peer', 'Color rename', 'Color fresh']) {
    ids.push((await call('papers.create', { fields: { title }, retrieve: false }) as { id: string }).id);
  }
  const original = await call('tags.add', { id: ids[0], text: 'Research', color: '#aabbcc' }) as PaperTag;
  const peer = await call('tags.add', { id: ids[1], text: ' research ', color: '#112233' }) as PaperTag;
  assert.equal(original.color, '#AABBCC');
  assert.equal(peer.color, '#AABBCC');
  const rename = await call('tags.add', { id: ids[2], text: 'Previous name', color: '#223344' }) as PaperTag;
  const fresh = await call('tags.add', { id: ids[3], text: 'Fresh source', color: '#223344' }) as PaperTag;
  const unrelated = await call('tags.add', { id: ids[1], text: 'Unrelated', color: '#ABCDEF' }) as PaperTag;
  await call('tags.move', { id: ids[0], tagId: original.id, position: { side: 'left', offset: 0.25 } });
  await call('tags.move', { id: ids[1], tagId: peer.id, position: { side: 'top', offset: 0.75 } });
  const before = library.state();
  let notifications = 0;
  library.on('changed', () => { notifications += 1; });
  await call('tags.update', { id: ids[0], tagId: original.id, text: ' RESEARCH ', color: '#445566' });
  assert.equal(notifications, 1);
  assert.deepEqual(library.get(ids[0]).tags, [{ ...original, text: 'RESEARCH', color: '#445566', position: { side: 'left', offset: 0.25 } }]);
  assert.deepEqual(library.get(ids[1]).tags, [{ ...peer, color: '#445566', position: { side: 'top', offset: 0.75 } }, unrelated]);
  for (const item of library.state().papers) {
    const previous = before.papers.find(paper => paper.id === item.id)!;
    const { tags: _tags, ...rest } = item, { tags: _previousTags, ...previousRest } = previous;
    assert.deepEqual(rest, previousRest);
  }
  await call('tags.update', { id: ids[2], tagId: rename.id, text: 'ReSeArCh', color: '#FFFFFF' });
  assert.deepEqual(library.get(ids[2]).tags, [{ ...rename, text: 'ReSeArCh', color: '#445566' }]);
  assert.equal(library.get(ids[1]).tags![0].text, 'research');
  assert.equal(library.get(ids[0]).tags![0].color, '#445566');
  await call('tags.update', { id: ids[3], tagId: fresh.id, text: 'Unique destination', color: '#778899' });
  assert.deepEqual(library.get(ids[3]).tags, [{ ...fresh, text: 'Unique destination', color: '#778899' }]);
  const saved = await readFile(library.file, 'utf8');
  for (const [id, tagId, text, color] of [
    [ids[1], unrelated.id, ' RESEARCH ', '#000000'],
    [ids[0], original.id, 'Research', 'red'],
    [ids[0], original.id, 'Research\n', '#000000'],
  ]) await assert.rejects(call('tags.update', { id, tagId, text, color }));
  await assert.rejects(call('tags.add', { id: ids[3], text: 'Research', color: 'red' }));
  assert.equal(await readFile(library.file, 'utf8'), saved);
  const reloaded = new Library(library.directory, async () => pdf, async p => ({ metadata: localMetadata(p), matched: true, message: 'fixture' }));
  await reloaded.initialize();
  for (const id of ids) assert.deepEqual(reloaded.get(id).tags, library.get(id).tags);
});

test('same-name recolor rolls back every affected paper when its single atomic save fails', async () => {
  const { library, call } = await setup();
  const ids: string[] = [];
  for (const title of ['Rollback first', 'Rollback second']) ids.push((await call('papers.create', { fields: { title }, retrieve: false }) as { id: string }).id);
  const first = await call('tags.add', { id: ids[0], text: 'Common', color: '#112233' }) as PaperTag;
  await call('tags.add', { id: ids[1], text: 'COMMON', color: '#445566' });
  const before = library.state(), source = await readFile(library.file, 'utf8'), backup = await readFile(library.file + '.bak', 'utf8');
  let notifications = 0; library.on('changed', () => { notifications += 1; });
  await mkdir(library.file + '.tmp');
  await assert.rejects(call('tags.update', { id: ids[0], tagId: first.id, text: 'common', color: '#778899' }));
  assert.deepEqual(library.state(), before);
  assert.equal(await readFile(library.file, 'utf8'), source);
  assert.equal(await readFile(library.file + '.bak', 'utf8'), backup);
  assert.equal(notifications, 0);
  await rmdir(library.file + '.tmp');
  await call('tags.update', { id: ids[0], tagId: first.id, text: 'common', color: '#778899' });
  assert.deepEqual(ids.map(id => library.get(id).tags![0].color), ['#778899', '#778899']);
  assert.equal(await readFile(library.file + '.bak', 'utf8'), source);
});

test('startup unifies legacy tag colors deterministically with one backup and no repeated writes', async () => {
  const { library, call } = await setup();
  const ids: string[] = [];
  for (const title of ['Migration first', 'Migration second', 'Migration third', 'Migration untagged']) ids.push((await call('papers.create', { fields: { title }, retrieve: false }) as { id: string }).id);
  for (const id of ids.slice(0, 3)) await call('tags.add', { id, text: 'Research', color: '#AABBCC' });
  for (const id of ids.slice(0, 2)) await call('tags.add', { id, text: 'Tie', color: '#998877' });
  await call('tags.move', { id: ids[0], tagId: library.get(ids[0]).tags![0].id, position: { side: 'bottom', offset: 0.4 } });
  await call('papers.setRating', { id: ids[0], rating: 4 });
  const source = JSON.parse(await readFile(library.file, 'utf8'));
  source.papers.find((paper: Paper) => paper.id === ids[0]).tags[0].color = '#aabbcc';
  source.papers.find((paper: Paper) => paper.id === ids[1]).tags[0].text = 'RESEARCH';
  source.papers.find((paper: Paper) => paper.id === ids[2]).tags[0].color = '#112233';
  source.papers.find((paper: Paper) => paper.id === ids[1]).tags[1].color = '#112233';
  const original = JSON.stringify(source, null, 2);
  await writeFile(library.file, original, 'utf8');
  const makeLibrary = () => new Library(library.directory, async () => pdf, async p => ({ metadata: localMetadata(p), matched: true, message: 'fixture' }));
  const migrated = makeLibrary(); await migrated.initialize();
  assert.equal(await readFile(library.file + '.bak', 'utf8'), original);
  const result = JSON.parse(await readFile(library.file, 'utf8'));
  const expected = structuredClone(source);
  for (const paper of expected.papers) for (const tag of paper.tags ?? []) tag.color = tag.text.toLowerCase() === 'research' ? '#AABBCC' : '#112233';
  assert.deepEqual(result, expected);
  const saved = await readFile(library.file, 'utf8'), indexTime = (await stat(library.file)).mtimeMs, backupTime = (await stat(library.file + '.bak')).mtimeMs;
  await new Promise(resolve => setTimeout(resolve, 30));
  const reloaded = makeLibrary(); await reloaded.initialize();
  assert.equal(await readFile(library.file, 'utf8'), saved);
  assert.equal((await stat(library.file)).mtimeMs, indexTime);
  assert.equal((await stat(library.file + '.bak')).mtimeMs, backupTime);
  assert.equal(await readFile(library.file + '.bak', 'utf8'), original);
});

test('failed startup color migration keeps disk and loaded tags and never starts pending retrieval', async () => {
  const { library, call } = await setup();
  const ids: string[] = [];
  for (const title of ['Failed startup first', 'Failed startup second']) ids.push((await call('papers.create', { fields: { title }, retrieve: false }) as { id: string }).id);
  for (const id of ids) await call('tags.add', { id, text: 'Same', color: '#112233' });
  const source = JSON.parse(await readFile(library.file, 'utf8'));
  source.papers[0].tags[0].color = '#445566';
  source.papers[0].status = 'queued';
  const original = JSON.stringify(source, null, 2); await writeFile(library.file, original, 'utf8');
  const backup = await readFile(library.file + '.bak', 'utf8');
  await mkdir(library.file + '.tmp');
  let retrievals = 0;
  const failed = new Library(library.directory, async () => { retrievals += 1; return pdf; }, async p => {
    retrievals += 1; return { metadata: localMetadata(p), matched: true, message: 'fixture' };
  });
  await assert.rejects(failed.initialize());
  assert.equal(retrievals, 0);
  for (const id of ids) assert.deepEqual(failed.get(id).tags, source.papers.find((paper: Paper) => paper.id === id).tags);
  assert.equal(await readFile(library.file, 'utf8'), original);
  assert.equal(await readFile(library.file + '.bak', 'utf8'), backup);
  await rmdir(library.file + '.tmp');
});

test('AI tag moves persist all four sides and survive editing, refresh and reload', async () => {
  const { root, library, call } = await setup();
  const file = join(root, 'movable-tag.pdf'); await writeFile(file, '%PDF-movable tag API fixture');
  const imported = await call('papers.import', { paths: [file] }) as { paperIds: string[] };
  await library.whenIdle();
  const id = imported.paperIds[0], original = structuredClone(library.get(id));
  const originalPdf = await readFile(library.pdfPath(id));
  const tag = await call('tags.add', { id, text: '可移动标签', color: '#9AD4D6' }) as PaperTag;
  const other = await call('tags.add', { id, text: '固定标签', color: '#AABBCC' }) as PaperTag;
  for (const position of [
    { side: 'top', offset: 0 }, { side: 'right', offset: 1 },
    { side: 'bottom', offset: 0.5 }, { side: 'left', offset: 0.25 },
  ]) {
    const moved = await call('tags.move', { id, tagId: tag.id, position }) as Paper;
    assert.deepEqual(moved.tags, [{ ...tag, position }, other]);
    assert.equal('thumbnail' in moved, false);
    for (const key of ['title', 'source', 'status', 'matchMethod', 'publicationDate', 'abstract'] as const) assert.equal(moved[key], original[key]);
    assert.deepEqual((await call('papers.list') as { papers: Paper[] }).papers[0].tags, moved.tags);
  }
  const position = { side: 'left', offset: 0.25 };
  const updated = await call('tags.update', { id, tagId: tag.id, text: '已编辑标签', color: '#7BC58C' }) as Paper;
  const expected = [{ ...tag, text: '已编辑标签', color: '#7BC58C', position }, other];
  assert.deepEqual(updated.tags, expected);
  const beforeInvalid = await readFile(library.file, 'utf8');
  await assert.rejects(call('tags.move', { id, tagId: other.id, position: { side: 'bottom', offset: 2 } }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(call('tags.move', { id, tagId: '00000000-0000-4000-8000-000000000000', position }), { code: 'NOT_FOUND' });
  await assert.rejects(call('tags.move', { id: 'a'.repeat(64), tagId: tag.id, position }), { code: 'NOT_FOUND' });
  assert.equal(await readFile(library.file, 'utf8'), beforeInvalid);
  await call('metadata.refresh', { id }); await library.whenIdle();
  assert.deepEqual((await call('papers.get', { id }) as Paper).tags, expected);
  const reloaded = new Library(library.directory, async () => { throw new Error('Reload should not parse a completed paper'); }, async () => { throw new Error('Reload should not search a completed paper'); });
  await reloaded.initialize();
  assert.deepEqual(reloaded.get(id).tags, expected);
  assert.deepEqual(await readFile(library.pdfPath(id)), originalPdf);
});

test('AI reports queued work without allowing metadata edits during processing', async () => {
  const { root } = await setup();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const library = new Library(join(root, 'busy-library'), async () => { await gate; return pdf; }, async p => ({ metadata: localMetadata(p), matched: true, message: 'done' }));
  await library.initialize();
  const call = createDispatcher(library), file = join(root, 'busy.pdf'); await writeFile(file, '%PDF-busy');
  const result = await call('papers.import', { paths: [file] }) as any, id = result.paperIds[0];
  try {
    assert.equal((await call('app.status') as any).pending, 1);
    assert.equal((await call('metadata.refresh', { id }) as any).alreadyProcessing, true);
    await assert.rejects(call('metadata.update', { id, fields: { title: 'Too early' } }), { code: 'BUSY' });
    await call('tags.add', { id, text: '处理中已添加', color: '#AABBCC' });
  } finally { release(); await library.whenIdle(); }
  assert.equal((await call('papers.get', { id }) as any).status, 'matched');
  assert.equal((await call('papers.get', { id }) as Paper).tags?.[0].text, '处理中已添加');
});

test('loopback API authenticates clients, blocks browser requests, limits bodies, and cleans sessions', async () => {
  const { library } = await setup();
  const service = await startAiApi(library);
  const sessionPath = join(library.directory, '.ai-session.json');
  const session = JSON.parse(await readFile(sessionPath, 'utf8'));
  function send(method: string, url: string, body = '', headers: Record<string, string> = {}) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: session.port, path: url, method, agent: new Agent({ keepAlive: false, proxyEnv: {} }), headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json', ...headers } }, res => {
        const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })); res.on('error', reject);
      });
      req.on('error', reject); req.end(body);
    });
  }
  try {
    assert.equal(session.host, '127.0.0.1');
    const discovery = await send('GET', '/v1/capabilities');
    assert.deepEqual(discovery.body.result, capabilities);
    const invalidHeaders: Record<string, string>[] = [{ Authorization: '' }, { Authorization: 'Bearer wrong' }, { Origin: 'https://example.com' }, { Host: 'evil.invalid' }];
    for (const headers of invalidHeaders) {
      const blocked = await send('POST', '/v1/call', JSON.stringify({ operation: 'folders.create', params: { name: 'Blocked' } }), headers);
      assert.equal(blocked.status, 401); assert.equal(blocked.body.error.code, 'UNAUTHORIZED');
      assert.equal(JSON.stringify(blocked.body).includes(session.token), false);
    }
    assert.equal(library.state().folders.length, 0);
    assert.equal((await send('POST', '/v1/call', '{broken')).body.error.code, 'INVALID_JSON');
    assert.equal((await send('POST', '/v1/call', JSON.stringify({ operation: 'app.status', eval: 'bad' }))).body.error.code, 'INVALID_ARGUMENT');
    assert.equal((await send('POST', '/v1/call', ' '.repeat(1048577))).status, 413);
    const status = await send('POST', '/v1/call', JSON.stringify({ operation: 'app.status' }));
    assert.equal(status.body.result.total, 0);
  } finally { await service.close(); }
  await assert.rejects(access(sessionPath));
  const restarted = await startAiApi(library);
  try { assert.notEqual(JSON.parse(await readFile(sessionPath, 'utf8')).token, session.token); }
  finally { await restarted.close(); }
});
