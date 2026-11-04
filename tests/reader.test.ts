import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rename, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Library } from '../electron/library';
import { localMetadata } from '../electron/metadata';
import { prepareStorageChange } from '../electron/storage-settings';
import { validateReaderUpdate } from '../shared/reader';
import { packReaderValue, unpackReaderValue } from '../src/reader-transfer';
import { paperStoragePaths } from '../electron/paper-storage';
const pdf = { title: 'Reader fixture', authors: [], year: 2025, pageCount: 2, firstPageText: 'text', doi: '', arxivId: '', abstract: '' };
const extract = async () => pdf;
const lookup = async () => ({ metadata: localMetadata(pdf), matched: true, message: '' });
async function fixture() {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(resolve('.test-data/reader-'));
  const library = new Library(join(root, 'library'), extract, lookup); await library.initialize();
  const source = join(root, 'source.pdf'); await writeFile(source, '%PDF-1.7\nreader fixture');
  await library.importPaths([source]); await library.whenIdle();
  return { root, library, id: library.list()[0].id, source };
}
test('reader stores revisioned annotations separately, keeps original bytes, and survives library relocation', async () => {
  const { root, library, id, source } = await fixture();
  const before = await readFile(library.file), original = await readFile(source);
  const doc = await library.readerDocument(id);
  assert.deepEqual(Buffer.from(doc.data), original); assert.equal(doc.state.annotations, null);
  await assert.rejects(readFile(paperStoragePaths(library.directory, library.get(id)).annotations), { code: 'ENOENT' });
  const annotations = [{ annotation: { id: 'test-mark', type: 9, pageIndex: 0, custom: { text: 'multi\nline' } } }];
  const saved = await library.saveReaderState(id, { pdfHash: doc.state.pdfHash, revision: 0, annotations, position: { page: 2, zoom: 1.5 } });
  assert.equal(saved.revision, 1); assert.deepEqual(saved.annotations, annotations);
  const moved = await library.saveReaderState(id, { pdfHash: saved.pdfHash, revision: saved.revision, position: { page: 1, zoom: 0.75 } });
  assert.deepEqual(moved.annotations, annotations); assert.equal(moved.revision, 2);
  const path = paperStoragePaths(library.directory, library.get(id)).annotations;
  assert.deepEqual(JSON.parse(await readFile(path + '.bak', 'utf8')), saved);
  const reload = new Library(library.directory, extract, lookup); await reload.initialize();
  assert.deepEqual(await reload.readerState(id), moved);
  assert.deepEqual(await readFile(library.pdfPath(id)), original); assert.deepEqual(await readFile(source), original);
  assert.deepEqual(await readFile(library.file), before);
  const target = join(root, 'copied'); await mkdir(target);
  await prepareStorageChange(library, library.directory, 'copy', target);
  await rename(library.directory, join(root, 'old-library'));
  const copied = new Library(target, extract, lookup); await copied.initialize();
  assert.deepEqual(await copied.readerState(id), moved);
  assert.deepEqual(await readFile(paperStoragePaths(target, copied.get(id)).annotations + '.bak'), Buffer.from(JSON.stringify(saved, null, 2)));
});
test('stale revisions, replaced PDFs, corrupt sidecars and failed backups cannot erase saved annotations', async () => {
  const { library, id } = await fixture(), doc = await library.readerDocument(id);
  await library.saveReaderState(id, { pdfHash: doc.state.pdfHash, revision: 0, annotations: [] });
  const path = paperStoragePaths(library.directory, library.get(id)).annotations, saved = await readFile(path);
  const results = await Promise.allSettled([1, 2].map(page => library.saveReaderState(id, { pdfHash: doc.state.pdfHash, revision: 1, position: { page, zoom: 1 } })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  const newer = await readFile(path);
  await writeFile(library.pdfPath(id), '%PDF-1.7\nchanged fixture');
  await assert.rejects(library.saveReaderState(id, { pdfHash: doc.state.pdfHash, revision: 2, annotations: [] }), /变化/);
  await assert.rejects(library.readerDocument(id), /不一致/);
  assert.deepEqual(await readFile(path), newer);
  await writeFile(library.pdfPath(id), Buffer.from(doc.data));
  await writeFile(path, '{broken'); await assert.rejects(library.readerDocument(id), /损坏/);
  await assert.rejects(library.saveReaderState(id, { pdfHash: doc.state.pdfHash, revision: 2, annotations: [] }), /损坏/);
  assert.equal(await readFile(path, 'utf8'), '{broken');
  await writeFile(path, saved);
  await rename(path + '.bak', path + '.previous'); await mkdir(path + '.bak');
  await assert.rejects(library.saveReaderState(id, { pdfHash: doc.state.pdfHash, revision: 1, annotations: [] }));
  assert.deepEqual(await readFile(path), saved);
  assert(!(await readdir(paperStoragePaths(library.directory, library.get(id)).directory)).some(p => p.endsWith('.tmp')));
});
test('invalid IDs, missing PDFs and symlinked annotation folders reject writes', async () => {
  const { library, root, id } = await fixture(), doc = await library.readerDocument(id);
  await assert.rejects(library.readerDocument('../outside'));
  const created = await library.createPaper({ title: 'No PDF' }, null, false);
  await assert.rejects(library.readerDocument(created.id), /PDF/);
  const outside = join(root, 'outside'); await mkdir(outside);
  const paperDirectory = paperStoragePaths(library.directory, library.get(id)).directory;
  await rename(paperDirectory, paperDirectory + '-old');
  // Keep a valid original available through the link so annotation safety, not a missing PDF, rejects it.
  await writeFile(join(outside, 'original.pdf'), Buffer.from(doc.data));
  await symlink(outside, paperDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(library.saveReaderState(id, { pdfHash: doc.state.pdfHash, revision: 0, annotations: [] }), /链接/);
  assert.deepEqual(await readdir(outside), ['original.pdf']);
});
test('annotation JSON is bounded and rejects nonfinite values, traversal keys and unknown properties', () => {
  const base = { pdfHash: 'a'.repeat(64), revision: 0 };
  for (const value of [ { ...base, revision: -1 }, { ...base, position: { page: 0, zoom: 1 } }, { ...base, position: { page: 1, zoom: Infinity } },
    { ...base, annotations: [NaN] }, { ...base, annotations: [new Date()] }, { ...base, annotations: JSON.parse('[{"__proto__":{}}]') },
    { ...base, annotations: new Array(10001).fill(null) }, { ...base, annotations: ['x'.repeat(20 * 1024 * 1024)] }, { ...base, extra: true } ]) {
    assert.throws(() => validateReaderUpdate(value as any));
  }
  const input = { date: new Date('2026-01-01T01:02:03Z'), data: new Uint8Array([0, 128, 255]).buffer };
  const restored = unpackReaderValue(JSON.parse(JSON.stringify(packReaderValue(input)))) as typeof input;
  assert.equal(restored.date.toISOString(), input.date.toISOString()); assert.deepEqual(new Uint8Array(restored.data), new Uint8Array(input.data));
});
