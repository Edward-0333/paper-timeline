import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Library } from '../electron/library';
import { paperStoragePaths } from '../electron/paper-storage';
import { localMetadata, type LookupResult } from '../electron/metadata';
import { createDispatcher } from '../electron/ai-api';
import { inspectStorageSelection, prepareStorageChange } from '../electron/storage-settings';
import { paperFrameTags } from '../shared/paper-files';
import type { ExtractedPdf } from '../shared/types';

async function fixture(lookup: (p: ExtractedPdf) => Promise<LookupResult> = async p => ({ metadata: localMetadata(p), matched: false, message: '未匹配，已保留 PDF 信息' })) {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(resolve('.test-data/citations-'));
  let extracts = 0;
  const make = () => new Library(join(root, 'library'), async () => { extracts++; throw new Error('No PDF should be parsed'); }, lookup);
  const library = make(); await library.initialize();
  return { root, library, make, call: createDispatcher(library), extracts: () => extracts };
}

test('citation-only papers retrieve metadata without parsing PDF, preserve partial seeds and deduplicate after corrected titles', async () => {
  const f = await fixture(async p => ({ metadata: { ...localMetadata(p), source: 'Crossref', title: 'Corrected online title', authors: ['Full Author'], publicationDate: '2023-05', year: 2023, abstract: '', venue: '' }, matched: true, message: 'matched' }));
  const created = await f.call('papers.create', { fields: { title: 'Imported title', publicationDate: '2022', venue: 'Known venue', abstract: 'Known abstract' } }) as any;
  await f.library.whenIdle();
  const paper = await f.call('papers.get', { id: created.id }) as any;
  assert.equal(f.extracts(), 0); assert.equal(paper.pdfPath, null); assert.equal(paper.status, 'matched');
  assert.equal(paper.title, 'Corrected online title'); assert.equal(paper.publicationDate, '2023-05');
  assert.equal(paper.venue, 'Known venue'); assert.equal(paper.abstract, 'Known abstract'); assert.equal(paper.abstractSource, '导入');
  assert.deepEqual(paper.availableFiles, { pdf: false, md: false }); assert.deepEqual(paperFrameTags(paper), []);
  const duplicate = await f.call('papers.create', { fields: { title: ' imported TITLE ' } }) as any;
  assert.deepEqual(duplicate, { id: paper.id, created: false, accepted: false });
  const restarted = f.make(); await restarted.initialize(); assert.equal(restarted.list().length, 1);
  assert.equal(restarted.get(paper.id).pdfHash, null); assert.deepEqual(await readdir(f.library.paperDirectory(paper.id)), ['paper-index.json']);
});

test('unmatched or failed lookups retain imported information and do not invent dates', async () => {
  const f = await fixture();
  const created = await f.library.createPaper({ title: 'No matching citation', authors: ['Original Author'], venue: 'Original Venue' });
  await f.library.whenIdle(); const p = f.library.get(created.id);
  assert.equal(p.status, 'review'); assert.equal(p.year, null); assert.equal(p.publicationDate, '');
  assert.deepEqual(p.authors, ['Original Author']); assert.equal(p.venue, 'Original Venue'); assert.equal(p.source, '导入');
  assert.doesNotMatch(p.message, /PDF/);
  const fail = await fixture(async () => { throw new Error('offline'); });
  const result = await fail.library.createPaper({ title: 'Keep despite network failure', publicationDate: '2020' });
  await fail.library.whenIdle(); assert.equal(fail.library.get(result.id).status, 'error'); assert.equal(fail.library.get(result.id).year, 2020);
});

test('citation validation rejects invalid fields, dates and identifiers without saving', async () => {
  const f = await fixture();
  for (const fields of [{}, { title: ' ' }, { title: 'Valid', publicationDate: '2024-02-30' }, { title: 'Valid', doi: 'garbage' }, { title: 'Valid', extra: true }]) {
    await assert.rejects(f.call('papers.create', { fields }));
  }
  assert.equal(f.library.list().length, 0);
});

test('PDF attachment preserves citation identity, notes and tags, supports deduplicated imports and portable copying', async () => {
  const f = await fixture();
  const { id } = await f.library.createPaper({ title: 'Paper with future attachment', publicationDate: '2021' }, null, false);
  const noPdf = await f.library.createPaper({ title: 'Paper remaining without PDF' }, null, false);
  const note = join(f.root, 'note.md'); await writeFile(note, '# Portable note');
  await f.library.attachMarkdown(id, note); await f.library.attachMarkdown(noPdf.id, note);
  const tag = await f.library.addTag(id, 'Category', '#112233');
  const pdf = join(f.root, 'original.pdf'); await writeFile(pdf, '%PDF-1.7\nattachment fixture');
  await f.call('papers.attachPdf', { id, path: pdf });
  assert.equal(f.library.get(id).title, 'Paper with future attachment'); assert.deepEqual(f.library.get(id).tags, [tag]);
  assert.equal(f.library.fileAvailability(id).pdf, true); assert.notEqual(f.library.get(id).pdfHash, id);
  assert.equal(await readFile(await f.library.markdownPath(id), 'utf8'), '# Portable note');
  const duplicate = await f.library.importPaths([pdf]); assert.equal(duplicate.duplicates, 1); assert.deepEqual(duplicate.paperIds, [id]);
  await assert.rejects(f.library.attachPdf(id, pdf), /不能覆盖/);
  await assert.rejects(f.library.attachPdf(noPdf.id, pdf), /另一篇/);
  assert.equal((await inspectStorageSelection('open', f.library.directory)).paperCount, 2);
  const target = join(f.root, 'copy'); await mkdir(target);
  await prepareStorageChange(f.library, f.library.directory, 'copy', target);
  assert.equal((await inspectStorageSelection('open', target)).paperCount, 2);
  assert.equal(await readFile(paperStoragePaths(target, f.library.get(noPdf.id)).markdown, 'utf8'), '# Portable note');
  assert.deepEqual(await readFile(paperStoragePaths(target, f.library.get(id)).pdf!), await readFile(pdf));
});

test('interrupted citation lookup resumes and failed create/attach writes roll back', async () => {
  const f = await fixture(); const { id } = await f.library.createPaper({ title: 'Resume citation' }, null, false);
  const data = JSON.parse(await readFile(f.library.file, 'utf8')); data.papers[0].status = 'searching';
  await writeFile(f.library.file, JSON.stringify(data));
  const restart = f.make(); await restart.initialize(); await restart.whenIdle();
  assert.equal(restart.get(id).status, 'review'); assert.equal(f.extracts(), 0);
  await mkdir(restart.file + '.tmp');
  await assert.rejects(restart.createPaper({ title: 'Cannot save' }, null, false)); assert.equal(restart.list().length, 1);
  const pdf = join(f.root, 'failed.pdf'); await writeFile(pdf, '%PDF-1.7\nrollback');
  await assert.rejects(restart.attachPdf(id, pdf)); assert.equal(restart.get(id).pdfHash, null);
  assert.deepEqual(await readdir(restart.paperDirectory(id)), ['paper-index.json']);
});
