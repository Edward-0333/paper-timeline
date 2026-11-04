import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Library, readStoredLibrary } from '../electron/library';
import { citationSeed, writeCitationSnapshot } from '../electron/citation-monitor';
import { createCitationLibraryIndex } from '../shared/citation-library';
import type { CitationRecord } from '../shared/citation-monitor';
import type { Paper } from '../shared/types';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const record = (title: string, fields: Partial<CitationRecord> = {}): CitationRecord => ({
  id: hash(title), title, authors: ['Fixture Author'], year: 2024, publicationDate: '2024-06', venue: 'Fixture Journal',
  doi: '', arxivId: '', abstract: 'A cached abstract.', url: '', sources: [], firstSeenAt: '2026-10-23T00:00:00.000Z',
  lastSeenAt: '2026-10-23T00:00:00.000Z', ...fields,
});
const fakePaper = (title: string, fields: Partial<Paper> = {}): Paper => ({
  id: hash(`paper:${title}`), title, authors: [], year: null, publicationDate: '', venue: '', doi: '', arxivId: '', abstract: '',
  url: '', source: '导入', matchMethod: '', fileName: '', fileSize: 0, pageCount: 0, importedAt: '2026-10-23T00:00:00.000Z',
  status: 'review', message: '', ...fields,
});
async function fixture() {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(resolve('.test-data/citation-library-'));
  let extracts = 0, lookups = 0;
  const make = () => new Library(join(root, 'library'), async () => { extracts++; throw new Error('Unexpected PDF parsing'); },
    async () => { lookups++; throw new Error('Unexpected metadata request'); });
  const library = make(); await library.initialize();
  const seed = await library.createPaper({ title: 'Monitored seed' }, null, false);
  const save = async (citations: CitationRecord[], seedId = seed.id) => writeCitationSnapshot(library.directory, {
    version: 1, seed: citationSeed(library.get(seedId)), lastAttemptAt: '', nextCheckAt: '', providers: [], citations,
  }, library.get(seedId).storageFolder);
  return { root, library, make, seed, save, calls: () => ({ extracts, lookups }) };
}

test('citation library matching normalizes identifiers and exact titles without merging identifier conflicts', () => {
  const doi = fakePaper('DOI title', { doi: 'https://doi.org/10.1234/Alpha%2FBeta' });
  const arxiv = fakePaper('arXiv title', { arxivId: '2401.12345v2' });
  const titled = fakePaper('Étude: A  Study');
  const match = createCitationLibraryIndex([doi, arxiv, titled]);
  assert.equal((match(record('New title', { doi: 'DOI: 10.1234/ALPHA/beta' })) as any).paper?.id, doi.id);
  assert.equal((match(record('New arxiv', { arxivId: 'https://arxiv.org/pdf/2401.12345v8.pdf' })) as any).paper?.id, arxiv.id);
  assert.equal((match(record(' etude — a study ')) as any).paper?.id, titled.id);
  assert.equal(match(record('DOI title', { doi: '10.9999/different' })).status, 'missing');
  assert.equal(match(record('arXiv title', { arxivId: '2402.54321' })).status, 'missing');
  assert.equal(match(record('Unrelated title')).status, 'missing');
});

test('citation library matching refuses multiple candidates and contradictory strong identifiers', () => {
  const first = fakePaper('Same title', { id: hash('first'), doi: '10.1234/one', arxivId: '2401.12345' });
  const second = fakePaper('Same title', { id: hash('second'), doi: '10.1234/two', arxivId: '2402.54321' });
  const match = createCitationLibraryIndex([first, second]);
  assert.equal(match(record('Same title')).status, 'ambiguous');
  assert.equal(match(record('Strong bridge', { doi: first.doi, arxivId: second.arxivId })).status, 'conflict');
  assert.equal(match(record('Conflict one candidate', { doi: first.doi, arxivId: second.arxivId })).status, 'conflict');
  assert.equal(createCitationLibraryIndex([first, { ...first, id: second.id }])(record('Known DOI', { doi: first.doi })).status, 'ambiguous');
});

test('citation provenance survives corrections and matches provider IDs across citation lists', () => {
  const original = record('Original title', { sources: [{ provider: 'openalex', id: 'https://openalex.org/W123' }] });
  const corrected = fakePaper('Manually corrected title', { doi: '10.1234/corrected', citationOrigins: [{ id: original.id, sources: original.sources }] });
  const match = createCitationLibraryIndex([corrected]);
  assert.equal((match(original) as any).paper?.id, corrected.id);
  assert.equal((match(record('Another title', { sources: [{ provider: 'openalex', id: 'w123' }] })) as any).paper?.id, corrected.id);
  assert.equal(match(record('Different paper', { sources: [{ provider: 'semantic_scholar', id: 'W123' }] })).status, 'missing');
  assert.equal(createCitationLibraryIndex([fakePaper('Blank source', { citationOrigins: [{ id: hash('blank'), sources: [{ provider: 'openalex', id: '' }] }] })])(
    record('Unrelated source', { sources: [{ provider: 'openalex', id: '  ' }] })).status, 'missing');
});

test('explicit citation import copies cached metadata offline, creates portable no-PDF records, and preserves the citation snapshot', async () => {
  const f = await fixture();
  const citation = record('Selected citing paper', { doi: 'https://doi.org/10.1234/ALPHA', url: 'https://example.org/paper', sources: [{ provider: 'openalex', id: 'W100' }] });
  await f.save([citation, record('Not selected')]);
  const before = await readFile(join(f.library.citationDirectory(f.seed.id), 'citations.json'), 'utf8');
  let changes = 0; f.library.on('changed', () => { changes++; });
  const added = await f.library.addCitation(f.seed.id, citation.id);
  assert.equal(added.created, true); assert.equal(added.accepted, false); assert.equal(f.library.list().length, 2);
  const paper = f.library.get(added.id);
  assert.equal(paper.unread, true, 'newly added citations start unopened');
  assert.equal(paper.title, citation.title); assert.deepEqual(paper.authors, citation.authors);
  assert.equal(paper.year, 2024); assert.equal(paper.publicationDate, '2024-06'); assert.equal(paper.venue, citation.venue);
  assert.equal(paper.doi, '10.1234/alpha'); assert.equal(paper.abstract, citation.abstract); assert.equal(paper.url, citation.url);
  assert.equal(paper.source, '导入'); assert.equal(paper.status, 'review'); assert.equal(paper.folderId, null); assert.equal(paper.pdfHash, null);
  assert.equal(paper.citationMonitoring, undefined); assert.equal(paper.citationSubscription, undefined);
  assert.deepEqual(paper.citationOrigins, [{ id: citation.id, sources: citation.sources }]);
  assert.deepEqual(f.library.fileAvailability(added.id), { pdf: false, md: false });
  assert.deepEqual(await readdir(f.library.paperDirectory(added.id)), ['paper-index.json']);
  assert.equal(changes, 1); await f.library.whenIdle(); assert.deepEqual(f.calls(), { extracts: 0, lookups: 0 });
  assert.equal(await readFile(join(f.library.citationDirectory(f.seed.id), 'citations.json'), 'utf8'), before);
  const restarted = f.make(); await restarted.initialize();
  assert.equal(restarted.list().length, 2); assert.deepEqual(restarted.get(added.id).citationOrigins, paper.citationOrigins);
  assert.deepEqual(await restarted.addCitation(f.seed.id, citation.id), { id: added.id, created: false, accepted: false });
});

test('duplicate citation imports preserve existing metadata, files, tags, ratings and classification', async () => {
  const f = await fixture();
  const folder = await f.library.createFolder('Keep classification');
  const existing = await f.library.createPaper({ title: 'Verified local title', doi: '10.1234/existing', abstract: 'Keep local abstract' }, folder.id, false);
  const tag = await f.library.addTag(existing.id, 'Keep tag', '#112233'); await f.library.setRating(existing.id, 5);
  const note = join(f.root, 'note.md'); await writeFile(note, '# Keep note'); await f.library.attachMarkdown(existing.id, note);
  const pdf = join(f.root, 'paper.pdf'); await writeFile(pdf, '%PDF-1.7\nkeep pdf'); await f.library.attachPdf(existing.id, pdf);
  const citation = record('Different provider title', { doi: 'https://doi.org/10.1234/EXISTING' }); await f.save([citation]);
  const before = structuredClone(f.library.get(existing.id)); const index = await readFile(f.library.file, 'utf8');
  assert.deepEqual(await f.library.addCitation(f.seed.id, citation.id), { id: existing.id, created: false, accepted: false });
  assert.deepEqual(f.library.get(existing.id), before); assert.deepEqual(f.library.get(existing.id).tags, [tag]);
  assert.equal(await readFile(f.library.file, 'utf8'), index);
  assert.equal(await readFile(await f.library.markdownPath(existing.id), 'utf8'), '# Keep note');
  assert.equal(await readFile(f.library.pdfPath(existing.id), 'utf8'), '%PDF-1.7\nkeep pdf');
});

test('concurrent citation additions serialize and share one record across parent papers', async () => {
  const f = await fixture(); const other = await f.library.createPaper({ title: 'Other monitored seed' }, null, false);
  const citation = record('Concurrent citing paper', { sources: [{ provider: 'semantic_scholar', id: 'abc123' }] });
  await f.save([citation]);
  await f.save([record('Changed title in second snapshot', { sources: citation.sources })], other.id);
  const second = (await f.library.getCitations(other.id)).citations[0];
  const results = await Promise.all([f.library.addCitation(f.seed.id, citation.id), f.library.addCitation(f.seed.id, citation.id), f.library.addCitation(other.id, second.id)]);
  assert.equal(new Set(results.map(value => value.id)).size, 1); assert.equal(results.filter(value => value.created).length, 1);
  assert.equal(f.library.list().length, 3);
  await f.library.saveMetadata(results[0].id, { ...f.library.get(results[0].id), title: 'Manually renamed citing paper', doi: '10.1234/corrected' });
  assert.equal((await f.library.addCitation(f.seed.id, citation.id)).id, results[0].id);
});

test('citation import uses known year for an invalid date, preserves unknown dates and rejects invalid identities or metadata', async () => {
  const f = await fixture();
  const year = record('Year only', { publicationDate: '', year: 2023 });
  const unknown = record('Unknown date', { publicationDate: '', year: null });
  const invalid = record('Invalid date', { publicationDate: '2024-02-30' });
  const malformed = record('Malformed DOI', { doi: 'not-a-doi' });
  await f.save([year, unknown, invalid, malformed]);
  const yearResult = await f.library.addCitation(f.seed.id, year.id); assert.equal(f.library.get(yearResult.id).publicationDate, '2023');
  const unknownResult = await f.library.addCitation(f.seed.id, unknown.id); assert.equal(f.library.get(unknownResult.id).publicationDate, ''); assert.equal(f.library.get(unknownResult.id).year, null);
  const invalidResult = await f.library.addCitation(f.seed.id, invalid.id); assert.equal(f.library.get(invalidResult.id).publicationDate, '2024');
  const count = f.library.list().length;
  await assert.rejects(f.library.addCitation('../bad', year.id), /ID/);
  await assert.rejects(f.library.addCitation(f.seed.id, 'not-an-id'), /ID/);
  await assert.rejects(f.library.addCitation(f.seed.id, hash('missing')), /缓存/);
  await assert.rejects(f.library.addCitation(f.seed.id, malformed.id), /DOI/);
  assert.equal(f.library.list().length, count);
  const existing = await f.library.createPaper({ title: 'Strong conflict existing', doi: '10.1234/one', arxivId: '2401.12345' }, null, false);
  const conflict = record('Conflicting citation', { doi: '10.1234/one', arxivId: '2402.54321' }); await f.save([conflict]);
  await assert.rejects(f.library.addCitation(f.seed.id, conflict.id), /冲突/);
  assert.equal(f.library.get(existing.id).arxivId, '2401.12345');
});

test('failed citation persistence rolls back in-memory insertion and preserves the original index and snapshot', async () => {
  const f = await fixture(); const citation = record('Cannot persist'); await f.save([citation]);
  const index = await readFile(f.library.file, 'utf8'), snapshot = await readFile(join(f.library.citationDirectory(f.seed.id), 'citations.json'), 'utf8');
  await mkdir(f.library.file + '.tmp');
  await assert.rejects(f.library.addCitation(f.seed.id, citation.id));
  assert.equal(f.library.list().length, 1); assert.equal(await readFile(f.library.file, 'utf8'), index);
  assert.equal(await readFile(join(f.library.citationDirectory(f.seed.id), 'citations.json'), 'utf8'), snapshot);
});

test('stored citation import origins are validated before library loading and malformed data is not rewritten', async () => {
  const f = await fixture(); const original = JSON.parse(await readFile(f.library.file, 'utf8'));
  const invalid = [null, {}, [null], [{ id: 'bad', sources: [] }], [{ id: hash('valid'), sources: null }],
    [{ id: hash('valid'), sources: [null] }], [{ id: hash('valid'), sources: [{ provider: 'other', id: 'x' }] }],
    [{ id: hash('valid'), sources: [{ provider: 'openalex', id: 2 }] }]];
  for (const value of invalid) {
    const data = structuredClone(original); data.papers[0].citationOrigins = value;
    const source = JSON.stringify(data); await writeFile(f.library.file, source);
    await assert.rejects(readStoredLibrary(f.library.directory), /引用入库来源/);
    assert.equal(await readFile(f.library.file, 'utf8'), source);
  }
  original.papers[0].citationOrigins = [{ id: hash('valid'), sources: [{ provider: 'openalex', id: 'W123' }] }];
  await writeFile(f.library.file, JSON.stringify(original));
  assert.deepEqual((await readStoredLibrary(f.library.directory)).papers[0].citationOrigins, original.papers[0].citationOrigins);
});
