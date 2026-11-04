import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, findIdentifiers, normalizeDoi, filenameTitle } from '../electron/pdf';
import { lookupMetadata, parseArxivFeed, parseArxivHtml, parseCrossref, titleSimilarity } from '../electron/metadata';
import type { ExtractedPdf } from '../shared/types';
const pdf: ExtractedPdf = { title: 'Learning Based MPC for Autonomous Driving Using a Low Dimensional Residual Model', authors: [], year: null, pageCount: 8, firstPageText: 'text', doi: '10.1109/test.123', arxivId: '', abstract: 'Local abstract' };
const work = { DOI: pdf.doi, title: [pdf.title], author: [{ given: 'Yaoyu', family: 'Li' }], published: { 'date-parts': [[2025, 6, 1]] }, 'container-title': ['ICRA'] };
test('extracts identifiers without using a reference-list DOI', () => {
  assert.deepEqual(findIdentifiers('arXiv: 2601.05083v2\nReferences\n10.1234/wrong'), { doi: '', arxivId: '2601.05083v2' });
  assert.equal(findIdentifiers('DOI: 10.1109/TRO.2025.3600144.').doi, '10.1109/tro.2025.3600144');
  assert.equal(normalizeDoi('https://doi.org/10.1000/a(b).'), '10.1000/a(b)');
  assert.equal(normalizeDoi('(10.1000/a)'), '(10.1000/a)');
});
test('normalizes publisher markup and filename prefix', () => {
  assert.equal(cleanText('SA-TP<inline-formula><tex-math>$^{2}$</tex-math></inline-formula>: A Model'), 'SA-TP2: A Model');
  assert.equal(filenameTitle('Li 等 - 2025 - A Paper Title.pdf'), 'A Paper Title');
  assert.equal(titleSimilarity('Hydra-MDP++: End-to-End Driving', 'Hydra MDP End to End Driving'), 1);
  assert.ok(titleSimilarity(pdf.title, 'A Review of Driving Models') < 0.75);
});
test('parses authoritative metadata, without inventing absent abstracts', () => {
  const m = parseCrossref(work);
  assert.equal(m.year, 2025); assert.equal(m.publicationDate, '2025-06-01'); assert.deepEqual(m.authors, ['Yaoyu Li']); assert.equal(m.abstract, '');
  const feed = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2601.05083v2</id><title>Driving on Registers</title><author><name>Ellington Kirby</name></author><published>2026-01-08</published><summary>Abstract here.</summary></entry></feed>';
  assert.equal(parseArxivFeed(feed)[0].arxivId, '2601.05083v2');
  assert.deepEqual(parseArxivFeed(feed)[0].authors, ['Ellington Kirby']);
  assert.deepEqual(parseArxivFeed('<feed></feed>'), []);
  const html = '<meta name="citation_title" content="Test title"><meta name="citation_author" content="Test Author"><meta name="citation_date" content="2025/01/03"><blockquote class="abstract"><span class="descriptor">Abstract:</span>Actual abstract</blockquote>';
  assert.equal(parseArxivHtml(html, '2501.00001')?.abstract, 'Actual abstract');
});
test('publication fields keep date precision and exclude revision or indexing timestamps', () => {
  const metadata = parseArxivFeed('<feed><entry><id>https://arxiv.org/abs/2512.00001v2</id><published>2025-12-31T23:59:00Z</published><updated>2026-04-02T03:04:05Z</updated><title>Test</title></entry></feed>')[0];
  assert.equal(metadata.publicationDate, '2025-12-31');
  assert.equal(metadata.year, 2025);
  const html = '<meta name="citation_title" content="Test"><meta name="citation_date" content="2026/04/02"><div class="submission-history"><a>[v1]</a> Wed, 31 Dec 2025 23:59:00 UTC<br>[v2] Thu, 2 Apr 2026 03:04:05 UTC</div>';
  assert.equal(parseArxivHtml(html, '2512.00001v2')?.publicationDate, '2025-12-31');
  assert.equal(parseArxivHtml('<meta name="citation_title" content="Test"><div class="dateline">[Submitted on 8 Jan 2026 (v1), last revised 3 Feb 2026 (this version, v2)]</div>', '2601.05083v2')?.publicationDate, '2026-01-08');
  assert.equal(parseArxivHtml('<meta name="citation_title" content="Test"><meta name="citation_date" content="2026/04/02">', '2512.00001v2')?.publicationDate, '');
  for (const parts of [[2025], [2025, 4], [2025, 4, 2]]) {
    const expected = parts.map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('-');
    assert.equal(parseCrossref({ published: { 'date-parts': [parts] }, indexed: { 'date-parts': [[2026, 9, 18]] } }).publicationDate, expected);
  }
  assert.equal(parseCrossref({ published: { 'date-parts': [[null]] }, 'published-online': { 'date-parts': [[2025, 3, 20]] }, 'published-print': { 'date-parts': [[2025, 4]] } }).publicationDate, '2025-03-20');
  const missing = parseCrossref({ created: { 'date-parts': [[2026, 9, 18]] }, indexed: { 'date-parts': [[2026, 9, 18]] }, event: { start: { 'date-parts': [[2026, 9, 18]] } } });
  assert.equal(missing.publicationDate, ''); assert.equal(missing.year, null);
});
test('an exact DOI must also agree with the PDF title', async () => {
  const result = await lookupMetadata(pdf, async () => new Response(JSON.stringify({ message: work })));
  assert.equal(result.matched, true); assert.equal(result.metadata.source, 'Crossref');
  assert.equal(result.metadata.abstractSource, 'PDF');
  const wrong = await lookupMetadata(pdf, async url => new Response(JSON.stringify({ message: url.includes('?') ? { items: [] } : { ...work, title: ['An entirely different medical study'] } })));
  assert.equal(wrong.matched, false); assert.equal(wrong.metadata.title, pdf.title);
});
test('ambiguous title matches remain reviewable', async () => {
  const result = await lookupMetadata({ ...pdf, doi: '' }, async () => new Response(JSON.stringify({ message: { items: [work, { ...work, DOI: '10.1234/another' }] } })));
  assert.equal(result.matched, false);
});
test('title-only matching accepts a strong unique match', async () => {
  const result = await lookupMetadata({ ...pdf, doi: '' }, async () => new Response(JSON.stringify({ message: { items: [work, { title: ['Unrelated text'] }] } })));
  assert.equal(result.matched, true); assert.equal(result.metadata.matchMethod, '标题高相似匹配');
});
test('offline requests and HTTP 429 preserve local information', async () => {
  for (const fetcher of [async () => { throw new Error('offline'); }, async () => new Response('', { status: 429 })]) {
    const result = await lookupMetadata(pdf, fetcher);
    assert.equal(result.matched, false); assert.equal(result.metadata.title, pdf.title); assert.equal(result.metadata.abstract, pdf.abstract);
    assert.match(result.message, /重试/);
  }
});
