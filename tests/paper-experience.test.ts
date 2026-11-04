import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rmdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Library } from '../electron/library';
import { localMetadata } from '../electron/metadata';
import { createDispatcher } from '../electron/ai-api';

async function fixture() {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(resolve('.test-data/paper-experience-'));
  const make = () => new Library(join(root, 'library'), async () => ({ title: 'Experience PDF fixture', authors: ['Fixture Author'], year: 2025,
    doi: '', arxivId: '', abstract: '', firstPageText: 'fixture', pageCount: 1 }),
  async pdf => ({ metadata: localMetadata(pdf), matched: true, message: 'fixture' }));
  const library = make(); await library.initialize();
  const { id } = await library.createPaper({ title: 'Concise reading comment fixture', authors: ['Test Author'], publicationDate: '2025' }, null, false);
  return { root, library, id, make };
}

test('brief notes and explicit opened state persist independently of metadata, tags, rating and attachments', async () => {
  const { root, library, id, make } = await fixture();
  const pdf = join(root, 'original.pdf'), markdown = join(root, 'note.md');
  await writeFile(pdf, '%PDF-1.7\nOriginal fixture bytes'); await writeFile(markdown, '# Original Markdown\n');
  await library.attachPdf(id, pdf); await library.attachMarkdown(id, markdown);
  await library.addTag(id, 'Review', '#BFE4C4'); await library.setRating(id, 4);
  const original = structuredClone(library.get(id)), originalPdf = await readFile(library.pdfPath(id)), originalMd = await readFile(await library.markdownPath(id));
  assert.equal(original.unread, true);
  await library.setBriefNote(id, '  思路简洁。\r\n实验设计值得借鉴。  ');
  assert.equal(library.get(id).briefNote, '思路简洁。\n实验设计值得借鉴。');
  await library.markOpened(id);
  const beforeNoOpBackup = await readFile(library.file + '.bak', 'utf8');
  let changes = 0; library.on('changed', () => changes++);
  await library.markOpened(id); await library.setBriefNote(id, '思路简洁。\n实验设计值得借鉴。');
  assert.equal(changes, 0); assert.equal(await readFile(library.file + '.bak', 'utf8'), beforeNoOpBackup);
  const reopened = make(); await reopened.initialize();
  assert.equal(reopened.get(id).unread, undefined); assert.equal(reopened.get(id).briefNote, '思路简洁。\n实验设计值得借鉴。');
  const { unread: _unread, briefNote: _briefNote, ...remaining } = reopened.get(id);
  const { unread: _oldUnread, ...originalRemaining } = original;
  assert.deepEqual(remaining, originalRemaining);
  assert.deepEqual(await readFile(reopened.pdfPath(id)), originalPdf); assert.deepEqual(await readFile(await reopened.markdownPath(id)), originalMd);
  await reopened.setBriefNote(id, '  \n '); assert.equal(reopened.get(id).briefNote, undefined);
});

test('new PDF imports are unread and duplicates or metadata refresh never restore a cleared dot', async () => {
  const { root, library } = await fixture();
  const source = join(root, 'import.pdf'); await writeFile(source, '%PDF-1.7\nNew import fixture');
  const id = (await library.importPaths([source])).paperIds![0]; await library.whenIdle();
  assert.equal(library.get(id).unread, true);
  await library.setBriefNote(id, 'Keep my assessment.'); await library.markOpened(id);
  assert.equal((await library.importPaths([source])).duplicates, 1);
  await library.retry(id); await library.whenIdle();
  assert.equal(library.get(id).unread, undefined); assert.equal(library.get(id).briefNote, 'Keep my assessment.');
});

test('brief-note and opened writes roll back on storage failure and reject invalid input without changing disk', async () => {
  const { library, id } = await fixture();
  await library.setBriefNote(id, 'Original assessment.');
  const before = await readFile(library.file, 'utf8');
  await mkdir(library.file + '.tmp');
  await assert.rejects(library.setBriefNote(id, 'Unsaved replacement.'));
  await assert.rejects(library.markOpened(id));
  assert.equal(library.get(id).briefNote, 'Original assessment.'); assert.equal(library.get(id).unread, true);
  assert.equal(await readFile(library.file, 'utf8'), before);
  await rmdir(library.file + '.tmp');
  for (const value of ['x'.repeat(1001), 'bad\u0000text', 5, null]) await assert.rejects(library.setBriefNote(id, value as string));
  assert.equal(await readFile(library.file, 'utf8'), before);
  await library.setBriefNote(id, 'Recovered after the failed write.');
  const unlock = await library.lockForStorageChange();
  try { await assert.rejects(library.setBriefNote(id, 'Busy')); await assert.rejects(library.markOpened(id)); } finally { unlock(); }
  await library.markOpened(id); assert.equal(library.get(id).unread, undefined);
});

test('legacy entries stay opened, API reads are side-effect free and explicit operations validate arguments', async () => {
  const { library, id, make } = await fixture();
  const raw = JSON.parse(await readFile(library.file, 'utf8')); delete raw.papers[0].unread;
  await writeFile(library.file, JSON.stringify(raw, null, 2));
  const reopened = make(); await reopened.initialize(); const call = createDispatcher(reopened);
  const before = await readFile(library.file, 'utf8');
  await call('papers.list'); await call('papers.get', { id }); await call('papers.markOpened', { id });
  assert.equal(await readFile(library.file, 'utf8'), before);
  const fresh = await reopened.createPaper({ title: 'New unread API paper' }, null, false);
  await call('papers.get', { id: fresh.id }); assert.equal(reopened.get(fresh.id).unread, true);
  await call('papers.setBriefNote', { id: fresh.id, text: 'An explicit personal comment.' });
  await call('papers.markOpened', { id: fresh.id }); assert.equal(reopened.get(fresh.id).unread, undefined);
  await assert.rejects(call('papers.markOpened', { id: fresh.id, unread: true }));
  await assert.rejects(call('papers.setBriefNote', { id: fresh.id, text: 'x'.repeat(1001) }));
  assert.equal(reopened.get(fresh.id).briefNote, 'An explicit personal comment.');
});

test('malformed stored personal fields are rejected before rewriting the library', async () => {
  for (const fields of [{ briefNote: 10 }, { briefNote: 'x'.repeat(1001) }, { briefNote: 'bad\u0000text' }, { unread: 'yes' }]) {
    const { library, make } = await fixture();
    const raw = JSON.parse(await readFile(library.file, 'utf8')); Object.assign(raw.papers[0], fields);
    const before = JSON.stringify(raw, null, 2); await writeFile(library.file, before);
    await assert.rejects(make().initialize()); assert.equal(await readFile(library.file, 'utf8'), before);
  }
});
