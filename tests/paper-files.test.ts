import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Library, readStoredLibrary } from '../electron/library';
import { createDispatcher } from '../electron/ai-api';
import { localMetadata } from '../electron/metadata';
import { paperFrameTags } from '../shared/paper-files';
import { collectTagOptions, paperMatchesTags } from '../shared/paper-tags';
import { closestTagPosition, tagBox, tagEnvelope } from '../src/tag-layout';
import { prepareStorageChange } from '../electron/storage-settings';
import type { ExtractedPdf, Paper } from '../shared/types';

const pdf: ExtractedPdf = { title: 'File tag fixture', authors: ['Test'], year: 2025, pageCount: 1, firstPageText: 'text', doi: '', arxivId: '', abstract: '' };
const extract = async () => pdf, lookup = async () => ({ metadata: localMetadata(pdf), matched: true, message: '' });
async function fixture() {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(resolve('.test-data/file-tags-'));
  const library = new Library(join(root, 'library'), extract, lookup); await library.initialize();
  const source = join(root, 'sample.pdf'); await writeFile(source, '%PDF-file-tags');
  await library.importPaths([source]); await library.whenIdle();
  const id = library.list()[0].id;
  return { root, library, id, call: createDispatcher(library) };
}

test('file badges reflect present files, stay out of category filters and cannot be deleted as tags', async () => {
  const { root, library, id, call } = await fixture();
  assert.deepEqual(paperFrameTags(library.list()[0]).map(t => t.fileKind), ['pdf']);
  const md = join(root, '笔记.md'); await writeFile(md, '# 笔记'); await library.attachMarkdown(id, md);
  const tag = await library.addTag(id, 'PDF', '#123456'); // A user category with this name is still independent.
  const paper = library.list()[0], badges = paperFrameTags(paper);
  assert.deepEqual(badges.map(t => t.id), [tag.id, 'file:pdf', 'file:md']);
  assert.equal(collectTagOptions([paper]).length, 1);
  assert.equal(paperMatchesTags(paper, ['MD'], 'all'), false);
  const before = await readFile(library.file);
  for (const tagId of ['file:pdf', 'file:md']) {
    await assert.rejects(call('tags.delete', { id, tagId }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(library.deleteTag(id, tagId), /找不到/);
  }
  assert.deepEqual(await readFile(library.file), before);
  await rename(library.pdfPath(id), join(root, 'moved.pdf'));
  await rename(await library.markdownPath(id), join(root, 'moved.md'));
  assert.deepEqual(library.list()[0].availableFiles, { pdf: false, md: false });
  assert.deepEqual(paperFrameTags(library.list()[0]).map(t => t.id), [tag.id]);
  await assert.rejects(call('files.moveTag', { id, kind: 'pdf', position: { side: 'top', offset: 0.5 } }), /没有可用/);
  assert.deepEqual(await readFile(library.file), before, 'availability checks do not mutate storage');
});

test('file positions persist independently through reload, metadata refresh and library copy', async () => {
  const { root, library, id, call } = await fixture();
  const md = join(root, 'note.md'); await writeFile(md, 'original note'); await library.attachMarkdown(id, md);
  const tag = await library.addTag(id, 'World Model', '#AABBCC');
  const original = structuredClone(library.get(id)), pdfBytes = await readFile(library.pdfPath(id)), mdBytes = await readFile(await library.markdownPath(id));
  const positions = { pdf: { side: 'right', offset: 0.35 }, md: { side: 'top', offset: 0.8 } } as const;
  await call('files.moveTag', { id, kind: 'pdf', position: positions.pdf });
  await call('files.moveTag', { id, kind: 'md', position: positions.md });
  assert.deepEqual(library.get(id).fileTagPositions, positions);
  assert.deepEqual(library.get(id).tags, [tag]); assert.equal(library.get(id).status, original.status); assert.equal(library.get(id).source, original.source);
  assert.deepEqual(await readFile(library.pdfPath(id)), pdfBytes); assert.deepEqual(await readFile(await library.markdownPath(id)), mdBytes);
  const stored = JSON.parse(await readFile(library.file, 'utf8')).papers[0];
  assert.equal(stored.availableFiles, undefined, 'availability is derived, never saved');
  await library.retry(id); await library.whenIdle();
  const reloaded = new Library(library.directory, extract, lookup); await reloaded.initialize();
  assert.deepEqual(reloaded.get(id).fileTagPositions, positions);
  const target = join(root, 'copy'); await mkdir(target); await prepareStorageChange(reloaded, reloaded.directory, 'copy', target);
  const copied = new Library(target, extract, lookup); await copied.initialize();
  assert.deepEqual(copied.get(id).fileTagPositions, positions); assert.deepEqual(copied.list()[0].availableFiles, { pdf: true, md: true });
});

test('invalid, missing, locked and failed file moves preserve the previous positions', async () => {
  const { library, id, call } = await fixture();
  const position = { side: 'left', offset: 0.25 } as const;
  const before = await readFile(library.file);
  await assert.rejects(call('files.moveTag', { id, kind: 'md', position }), /没有可用/);
  for (const params of [{ id, kind: 'exe', position }, { id, kind: 'pdf', position: { side: 'inside', offset: 0 } }, { id, kind: 'pdf', position: { side: 'top', offset: 2 } }]) {
    await assert.rejects(call('files.moveTag', params), { code: 'INVALID_ARGUMENT' });
  }
  assert.deepEqual(await readFile(library.file), before);
  await library.moveFileTag(id, 'pdf', position);
  const persist = (library as any).persist;
  (library as any).persist = async () => { throw new Error('disk full'); };
  await assert.rejects(library.moveFileTag(id, 'pdf', { side: 'bottom', offset: 1 }), /disk full/);
  assert.deepEqual(library.get(id).fileTagPositions, { pdf: position });
  (library as any).persist = persist;
  await library.moveFileTag(id, 'pdf', position);
  const unlock = await library.lockForStorageChange();
  await assert.rejects(library.moveFileTag(id, 'pdf', position), /切换/); unlock();
  const stored = JSON.parse(await readFile(library.file, 'utf8'));
  stored.papers[0].fileTagPositions = { pdf: { side: 'top', offset: -1 } };
  await writeFile(library.file, JSON.stringify(stored));
  await assert.rejects(readStoredLibrary(library.directory), /标签位置/);
});

test('PDF/MD badges use the same edge projection and keep the frame envelope fixed', () => {
  const paper = { fileName: 'a.pdf', markdownNote: { fileName: 'a.md' }, tags: [{ id: 'category', text: 'World Model', color: '#AABBCC' }] } as Paper;
  const tags = paperFrameTags(paper).map(t => ({ ...t, width: t.fileKind ? 62 : 105, height: 26 }));
  const frame = { width: 240, height: 90 }, before = tagEnvelope(frame, tags);
  for (const tag of tags.filter(t => t.fileKind)) for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const box = tagBox(frame, tag, { side, offset: 0.4 });
    assert.deepEqual(closestTagPosition(frame, tag, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, side), { side, offset: 0.4 });
    assert.deepEqual(tagEnvelope(frame, tags.map(t => t.id === tag.id ? box : t)), before);
  }
});
