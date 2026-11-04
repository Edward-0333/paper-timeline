import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { Library } from '../electron/library';
import { createDispatcher } from '../electron/ai-api';
import { localMetadata } from '../electron/metadata';
import { prepareStorageChange } from '../electron/storage-settings';
import { PaperChatStore } from '../electron/paper-chat-store';

const extracted = { title: 'AI index fixture', authors: ['Fixture Author'], year: 2025, pageCount: 1,
  firstPageText: 'fixture', doi: '', arxivId: '', abstract: 'Fixture abstract' };
const make = (directory: string) => new Library(directory, async () => extracted,
  async pdf => ({ metadata: localMetadata(pdf), matched: true, message: 'fixture only' }));
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const manifestPath = (library: Library, id: string) => join(library.paperDirectory(id), 'paper-index.json');
const manifest = (library: Library, id: string) => json(manifestPath(library, id));
const catalog = (library: Library) => json(join(library.directory, 'ai-index', 'catalog.json'));

async function fixture() {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(resolve('.test-data/library-ai-index-'));
  const library = make(join(root, 'library')); await library.initialize();
  const { id } = await library.createPaper({ title: '中文索引：精确定位资料', authors: ['Fixture Author'], publicationDate: '2025', doi: '10.1234/index-fixture' }, null, false);
  return { root, library, id, call: createDispatcher(library) };
}

function localPath(root: string, path: string) {
  assert.equal(isAbsolute(path), false, 'all stored references must survive a library move');
  const full = resolve(root, path), rel = relative(root, full);
  assert.ok(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
  return full;
}

test('AI navigation resolves stable paper identities, attached files and absent files without changing primary data', async () => {
  const { root, library, id, call } = await fixture();
  const empty = await library.createPaper({ title: '中文索引：另一篇无附件论文', doi: '10.1234/other-index-fixture' }, null, false);
  const source = join(root, 'source.pdf'), note = join(root, 'source.md');
  await writeFile(source, '%PDF-1.7\nIndex source bytes'); await writeFile(note, '# Personal note\n');
  await library.attachPdf(id, source); await library.attachMarkdown(id, note);
  await library.setBriefNote(id, '论文的个人精简评价'); await library.addTag(id, '世界模型', '#ABCDEF');
  const before = await readFile(library.file), pdf = await readFile(library.pdfPath(id)), md = await readFile(await library.markdownPath(id));
  const status = await call('app.status') as any;
  assert.equal(status.aiIndex.ready, true);
  assert.match(await readFile(status.aiIndex.entryPath, 'utf8'), /ai-index\/catalog\.json/);
  assert.equal(status.aiIndex.catalogPath, join(library.directory, 'ai-index', 'catalog.json'));
  const directory = await catalog(library);
  assert.equal(directory.total, 2); assert.equal(directory.generatedBy, 'paper-timeline-ai-index');
  const row = directory.papers.find((paper: any) => paper.id === id);
  assert.equal(row.title, library.get(id).title); assert.equal(row.doi, '10.1234/index-fixture');
  assert.deepEqual(row.tags, ['世界模型']); assert.equal(localPath(library.directory, row.directory), library.paperDirectory(id));
  const entry = await json(localPath(library.directory, row.index));
  assert.equal(entry.paper.id, id); assert.equal(entry.paper.briefNote, '论文的个人精简评价');
  assert.equal(entry.files.pdf.status, 'available'); assert.equal(entry.files.markdownNote.status, 'available');
  assert.equal(localPath(library.directory, entry.files.pdf.path), library.pdfPath(id));
  assert.equal(localPath(library.directory, entry.files.markdownNote.path), await library.markdownPath(id));
  assert.equal(entry.files.annotations.status, 'missing'); assert.equal(entry.parsed.status, 'missing');
  const absent = await manifest(library, empty.id);
  assert.equal(absent.files.pdf.status, 'not_attached'); assert.equal(absent.files.pdf.path, null);
  assert.equal(absent.files.markdownNote.status, 'not_attached');
  const detail = await call('papers.get', { id }) as any;
  assert.equal(detail.indexPath, manifestPath(library, id));
  await call('library.refreshIndex');
  await assert.rejects(call('library.refreshIndex', { path: root }), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(await readFile(library.file), before);
  assert.deepEqual(await readFile(library.pdfPath(id)), pdf); assert.deepEqual(await readFile(await library.markdownPath(id)), md);
  assert.equal(library.get(id).unread, true, 'reading the navigation must not mark the paper opened');
});

test('navigation follows metadata and sidecar saves while unchanged restart avoids rewriting generated files', async () => {
  const { root, library, id } = await fixture();
  const source = join(root, 'source.pdf'), note = join(root, 'source.md');
  await writeFile(source, '%PDF-1.7\nSidecar source bytes'); await writeFile(note, '# Existing note');
  await library.attachPdf(id, source); await library.attachMarkdown(id, note);
  const directory = library.paperDirectory(id);
  await library.saveMetadata(id, { ...library.get(id), title: 'Revised title, same document directory' });
  await library.setBriefNote(id, 'New assessment');
  const folder = await library.createFolder('实验'); await library.movePaper(id, folder.id); await library.renameFolder(folder.id, '实验与比较');
  const updated = await manifest(library, id);
  assert.equal(updated.paper.title, 'Revised title, same document directory');
  assert.equal(updated.paper.briefNote, 'New assessment'); assert.equal(updated.paper.folder.name, '实验与比较');
  assert.equal(library.paperDirectory(id), directory);
  const document = await library.readerDocument(id);
  await library.saveReaderState(id, { pdfHash: document.state.pdfHash, revision: 0, annotations: [], position: { page: 1, zoom: 1.25 } });
  assert.equal((await manifest(library, id)).files.annotations.status, 'available');
  const chat = new PaperChatStore(library);
  await chat.save(id, [{ role: 'user', content: 'Fixture conversation' }]);
  assert.equal((await manifest(library, id)).files.chat.status, 'available');
  const oldNote = await library.getMarkdownDocument(id);
  await library.saveMarkdownDocument(id, { content: '# Edited personal note', revision: oldNote.revision });
  assert.equal((await manifest(library, id)).files.markdownNote.status, 'available');
  const primary = await readFile(library.file);
  const files = [manifestPath(library, id), join(library.directory, 'AI-INDEX.md'), join(library.directory, 'ai-index', 'catalog.json')];
  const states = await Promise.all(files.map(async path => ({ path, bytes: await readFile(path), mtime: (await stat(path)).mtimeMs })));
  const again = make(library.directory); await again.initialize();
  for (const saved of states) {
    assert.deepEqual(await readFile(saved.path), saved.bytes);
    assert.equal((await stat(saved.path)).mtimeMs, saved.mtime, 'unchanged restart must not rewrite navigation');
  }
  assert.deepEqual(await readFile(library.file), primary);
});

test('library copy rebuilds portable navigation and resolves every available reference inside the destination', async () => {
  const { root, library, id } = await fixture();
  const source = join(root, 'source.pdf'), note = join(root, 'source.md');
  await writeFile(source, '%PDF-copy index'); await writeFile(note, '# Portable note');
  await library.attachPdf(id, source); await library.attachMarkdown(id, note);
  const before = await readFile(library.file), target = join(root, 'copied'); await mkdir(target);
  await prepareStorageChange(library, library.directory, 'copy', target);
  await rename(library.directory, join(root, 'original-library'));
  const copied = make(target); await copied.initialize();
  const directory = await catalog(copied), entry = await manifest(copied, id);
  assert.deepEqual(await readFile(copied.file), before);
  assert.equal(localPath(target, directory.papers[0].index), manifestPath(copied, id));
  for (const ref of Object.values(entry.files) as any[]) {
    if (ref.status === 'available') assert.ok((await stat(localPath(target, ref.path))).isFile());
  }
  assert.equal(await readFile(localPath(target, entry.files.markdownNote.path), 'utf8'), '# Portable note');
  assert.equal(JSON.stringify(entry).includes(library.directory), false);
});

test('generated-file conflicts preserve user bytes and do not undo successful primary writes', async () => {
  const { library, id, call } = await fixture();
  const target = manifestPath(library, id), userContent = '{"userData":"Keep this unrelated file"}';
  await writeFile(target, userContent);
  await library.setBriefNote(id, 'Primary save succeeds despite navigation conflict');
  assert.equal(library.get(id).briefNote, 'Primary save succeeds despite navigation conflict');
  assert.equal((await json(library.file)).papers[0].briefNote, library.get(id).briefNote);
  assert.equal(await readFile(target, 'utf8'), userContent);
  assert.equal((await call('app.status') as any).aiIndex.ready, false);
  assert.match((await call('library.refreshIndex') as any).error, /未覆盖/);
  await unlink(target); // Only the exact test file we created, never production data.
  assert.equal((await call('library.refreshIndex') as any).ready, true);
  assert.equal((await manifest(library, id)).paper.briefNote, library.get(id).briefNote);
});

test('a concurrent sidecar refresh cannot publish a metadata edit whose primary save fails', async () => {
  const { library, id } = await fixture();
  await library.setBriefNote(id, 'Saved personal assessment');
  const before = await readFile(library.file);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const mutable = library as any, originalPersist = mutable.persist;
  mutable.persist = async () => { enter(); await blocked; throw new Error('fixture primary write failure'); };
  const failedSave = assert.rejects(library.setBriefNote(id, 'Uncommitted draft must not enter the navigation'), /fixture primary write failure/);
  await entered;
  try {
    const chat = new PaperChatStore(library); await chat.save(id, [{ role: 'user', content: 'Concurrent fixture conversation' }]);
    assert.equal((await manifest(library, id)).paper.briefNote, 'Saved personal assessment');
  } finally { release(); await failedSave; mutable.persist = originalPersist; }
  assert.deepEqual(await readFile(library.file), before);
  assert.equal(library.get(id).briefNote, 'Saved personal assessment');
});

test('missing files and directory junctions are recorded as unavailable and never traversed', async () => {
  const { root, library, id, call } = await fixture();
  const source = join(root, 'source.pdf'); await writeFile(source, '%PDF-missing fixture'); await library.attachPdf(id, source);
  await unlink(library.pdfPath(id)); await call('library.refreshIndex');
  assert.equal((await manifest(library, id)).files.pdf.status, 'missing');
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'citations.json'), '{"outside":"must remain untouched"}');
  await symlink(outside, join(library.paperDirectory(id), 'citations'), process.platform === 'win32' ? 'junction' : 'dir');
  await call('library.refreshIndex');
  assert.equal((await manifest(library, id)).files.citations.status, 'unavailable');
  assert.deepEqual(await readdir(outside), ['citations.json']);
  assert.equal(await readFile(join(outside, 'citations.json'), 'utf8'), '{"outside":"must remain untouched"}');
  const other = await fixture();
  const outsideIndex = join(other.root, 'outside-index'); await mkdir(outsideIndex);
  await rename(join(other.library.directory, 'ai-index'), join(other.library.directory, 'ai-index-original'));
  await symlink(outsideIndex, join(other.library.directory, 'ai-index'), process.platform === 'win32' ? 'junction' : 'dir');
  await other.library.setBriefNote(other.id, 'Keep primary save functional');
  assert.equal((await other.call('app.status') as any).aiIndex.ready, false);
  assert.deepEqual(await readdir(outsideIndex), []);
});

test('MinerU navigation identifies only the published run and distinguishes stale or corrupt results', async () => {
  const { root, library, id, call } = await fixture();
  const source = join(root, 'source.pdf'); await writeFile(source, '%PDF-mineru index fixture'); await library.attachPdf(id, source);
  const archive = zipSync({ 'markdown.md': strToU8('# Full text'), 'middle_json.json': strToU8('{"pages":[]}'),
    'structured_content.json': strToU8('{"blocks":[]}'), 'images/figure.png': new Uint8Array([1, 2, 3]) });
  library.startMineru({ environment: async () => ({ ready: true, message: 'fixture' }), convert: async (_pdf, path) => { await writeFile(path, archive); return '4.0.12'; } });
  await library.convertPdf(id); await library.whenIdle();
  const result = (await library.conversionState(id)).result!, entry = await manifest(library, id);
  assert.equal(entry.parsed.status, 'available'); assert.equal(entry.parsed.runId, result.runId); assert.equal(entry.parsed.registeredPdfMatches, true);
  assert.equal(entry.files.markdownNote.status, 'not_attached');
  assert.equal(await readFile(localPath(library.directory, entry.parsed.markdown.path), 'utf8'), '# Full text');
  assert.ok(entry.parsed.artifacts.some((ref: any) => ref.path.endsWith('/images/figure.png') && ref.status === 'available'));
  const pointerPath = localPath(library.directory, entry.parsed.pointer.path), originalPointer = await readFile(pointerPath);
  const previous = join(library.paperDirectory(id), 'parsed', 'old-run'); await mkdir(previous); await writeFile(join(previous, 'old.md'), 'not current');
  await call('library.refreshIndex'); assert.equal(JSON.stringify((await manifest(library, id)).parsed).includes('old-run'), false);
  const stale = { ...result, pdfHash: 'f'.repeat(64) }; await writeFile(pointerPath, JSON.stringify(stale));
  await call('library.refreshIndex');
  const staleEntry = (await manifest(library, id)).parsed;
  assert.equal(staleEntry.registeredPdfMatches, false);
  assert.notEqual(staleEntry.status, 'available', 'stale parsed output must not be presented as current full text');
  await writeFile(pointerPath, '{broken'); await call('library.refreshIndex');
  assert.equal((await manifest(library, id)).parsed.status, 'unavailable');
  assert.equal(await readFile(pointerPath, 'utf8'), '{broken');
  await writeFile(pointerPath, originalPointer); await call('library.refreshIndex');
  assert.equal((await manifest(library, id)).parsed.status, 'available');
  // An explicit rescan must invalidate the optimized parsed-file cache after external edits.
  const imagePath = localPath(library.directory, entry.parsed.artifacts.find((ref: any) => ref.path.endsWith('/images/figure.png')).path);
  await unlink(imagePath); await call('library.refreshIndex');
  assert.equal((await manifest(library, id)).parsed.artifacts.some((ref: any) => ref.path.endsWith('/images/figure.png')), false);
  await unlink(library.pdfPath(id)); await call('library.refreshIndex');
  assert.equal((await manifest(library, id)).parsed.status, 'source_unavailable');
});
