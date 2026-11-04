import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Library } from '../electron/library';
import { createDispatcher } from '../electron/ai-api';
import { localMetadata } from '../electron/metadata';
import type { ExtractedPdf, Paper } from '../shared/types';

const pdf: ExtractedPdf = { title: 'Rating fixture', authors: ['Test Author'], year: 2025, pageCount: 1,
  firstPageText: 'fixture', doi: '', arxivId: '', abstract: '' };
async function fixture(withPdf = false) {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(resolve('.test-data/ratings-'));
  const makeLibrary = () => new Library(join(root, 'library'), async () => pdf,
    async p => ({ metadata: localMetadata(p), matched: true, message: 'fixture match' }));
  const library = makeLibrary(); await library.initialize();
  let id: string;
  if (withPdf) {
    const path = join(root, 'sample.pdf'); await writeFile(path, '%PDF-1.7\nrating fixture');
    const result = await library.importPaths([path]); await library.whenIdle(); id = result.paperIds![0];
  } else id = (await library.createPaper({ title: pdf.title }, null, false)).id;
  return { library, id, makeLibrary, call: createDispatcher(library) };
}

test('ratings save, update, clear and survive restart, manual metadata editing and refresh with or without a PDF', async () => {
  for (const withPdf of [false, true]) {
    const { library, id, makeLibrary } = await fixture(withPdf);
    const before = library.list()[0];
    assert.equal(before.rating, undefined);
    const changes: (number | undefined)[] = [];
    library.on('changed', state => changes.push(state.papers[0].rating));
    await library.setRating(id, 1);
    const { rating, ...unchanged } = library.list()[0];
    assert.equal(rating, 1); assert.deepEqual(unchanged, before);
    await Promise.all([library.setRating(id, 2), library.setRating(id, 3), library.setRating(id, 5)]);
    assert.deepEqual(changes, [1, 2, 3, 5]);
    await library.saveMetadata(id, { ...library.get(id), title: 'Corrected title' });
    assert.equal(library.get(id).rating, 5);
    await library.retry(id); await library.whenIdle();
    assert.equal(library.get(id).rating, 5);
    const restarted = makeLibrary(); await restarted.initialize();
    assert.equal(restarted.get(id).rating, 5);
    await restarted.setRating(id, null);
    const again = makeLibrary(); await again.initialize();
    assert.equal(Object.hasOwn(again.get(id), 'rating'), false);
  }
});

test('rating API returns the shared value in list/get and validates integers, clearing and paper IDs', async () => {
  const { library, call, id } = await fixture();
  assert.equal((await call('papers.setRating', { id, rating: 4 }) as Paper).rating, 4);
  assert.equal((await call('papers.get', { id }) as Paper).rating, 4);
  assert.equal((await call('papers.list') as { papers: Paper[] }).papers[0].rating, 4);
  const before = await readFile(library.file, 'utf8');
  for (const rating of [0, -1, 6, 2.5, '5', true, {}, [], undefined, NaN, Infinity]) {
    await assert.rejects(call('papers.setRating', { id, rating }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(library.setRating(id, rating as any), /评分/);
  }
  await assert.rejects(call('papers.setRating', { id }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(call('papers.setRating', { id, rating: 3, title: 'extra' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(call('metadata.update', { id, fields: { rating: 3 } }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(call('papers.setRating', { id: 'a'.repeat(64), rating: 2 }), { code: 'NOT_FOUND' });
  assert.equal(await readFile(library.file, 'utf8'), before);
  await call('papers.setRating', { id, rating: null });
  assert.equal(Object.hasOwn(await call('papers.get', { id }) as Paper, 'rating'), false);
});

test('failed rating writes restore both absent and existing values without emitting a change', async () => {
  for (const rated of [false, true]) {
    const { library, id } = await fixture();
    if (rated) await library.setRating(id, 4);
    const before = library.list(), file = await readFile(library.file, 'utf8');
    let events = 0; library.on('changed', () => events++);
    await mkdir(library.file + '.tmp');
    await assert.rejects(library.setRating(id, 2));
    await assert.rejects(library.setRating(id, null));
    assert.deepEqual(library.list(), before);
    assert.equal(await readFile(library.file, 'utf8'), file);
    assert.equal(events, 0);
  }
});

test('legacy unrated libraries are not rewritten and malformed stored ratings fail without overwriting data', async () => {
  const { library, id, makeLibrary } = await fixture();
  const legacy = await readFile(library.file, 'utf8');
  const restarted = makeLibrary(); await restarted.initialize();
  assert.equal(restarted.get(id).rating, undefined);
  assert.equal(await readFile(library.file, 'utf8'), legacy);
  for (const rating of [0, 6, 2.5, null, '4', {}, []]) {
    const data = JSON.parse(legacy); data.papers[0].rating = rating;
    const stored = JSON.stringify(data); await writeFile(library.file, stored);
    await assert.rejects(makeLibrary().initialize(), /评分/);
    assert.equal(await readFile(library.file, 'utf8'), stored);
  }
});

test('rating changes are rejected while the library is locked for migration', async () => {
  const { library, id } = await fixture();
  const unlock = await library.lockForStorageChange();
  await assert.rejects(library.setRating(id, 5), /切换/);
  unlock(); await library.setRating(id, 5);
  assert.equal(library.get(id).rating, 5);
});
