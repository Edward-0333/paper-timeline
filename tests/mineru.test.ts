import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { Library } from '../electron/library';
import { localMetadata } from '../electron/metadata';
import { prepareStorageChange } from '../electron/storage-settings';
import { unpackMineruResult, type MineruRunner } from '../electron/mineru';
import { createDispatcher } from '../electron/ai-api';
import { paperStoragePaths } from '../electron/paper-storage';

const pdf = { title: 'MinerU fixture', authors: [], year: 2025, pageCount: 2, firstPageText: 'text', doi: '', arxivId: '', abstract: '' };
const extract = async () => pdf, lookup = async () => ({ metadata: localMetadata(pdf), matched: true, message: '' });
const packageBytes = () => zipSync({ 'markdown.md': strToU8('# Full text\n\n![Figure](images/a.png)'), 'middle_json.json': strToU8('{"pages":[{},{}]}'), 'structured_content.json': strToU8('{"blocks":[]}'), 'images/a.png': new Uint8Array([1, 2, 3]) });
async function fixture() {
  await mkdir('.test-data', { recursive: true }); const root = await mkdtemp(resolve('.test-data/mineru-'));
  const library = new Library(join(root, 'library'), extract, lookup); await library.initialize();
  const source = join(root, 'source.pdf'); await writeFile(source, '%PDF-1.7\nMinerU fixture');
  await library.importPaths([source]); await library.whenIdle(); const id = library.list()[0].id;
  const runner: MineruRunner = { environment: async () => ({ ready: true, message: 'Fixture only' }), convert: async (_pdf, path) => { await writeFile(path, packageBytes()); return '4.0.12'; } };
  library.startMineru(runner); return { root, library, id, runner };
}
test('MinerU full text stays separate from notes/annotations and survives restart and verified library copy', async () => {
  const { library, root, id } = await fixture(), call = createDispatcher(library);
  const note = join(root, 'note.md'); await writeFile(note, '# My reading notes'); await library.attachMarkdown(id, note);
  const doc = await library.readerDocument(id); await library.saveReaderState(id, { pdfHash: doc.state.pdfHash, revision: 0, annotations: [] });
  const paths = paperStoragePaths(library.directory, library.get(id));
  const index = await readFile(library.file), source = await readFile(library.pdfPath(id)), mark = await readFile(paths.annotations);
  assert.equal((await call('documents.convert', { id }) as any).accepted, true); await library.whenIdle();
  const state = await call('documents.get', { id }) as any;
  assert.equal(state.status, 'succeeded'); assert.equal(state.result.tier, 'basic'); assert.equal(state.result.images, 1);
  assert.equal(state.result.pdfHash, createHash('sha256').update(source).digest('hex'));
  assert.match(await readFile(state.paths.markdown, 'utf8'), /# Full text/); assert.ok(await readFile(join(state.paths.directory, 'images', 'a.png')));
  assert.deepEqual(await readFile(library.file), index); assert.deepEqual(await readFile(library.pdfPath(id)), source); assert.deepEqual(await readFile(paths.annotations), mark);
  assert.equal(state.paths.directory, join(paths.directory, 'parsed', state.result.runId));
  assert.equal(await readFile(await library.markdownPath(id), 'utf8'), '# My reading notes');
  const reload = new Library(library.directory, extract, lookup); await reload.initialize(); assert.deepEqual((await reload.conversionState(id)).result, state.result);
  const target = join(root, 'copy'); await mkdir(target); await prepareStorageChange(library, library.directory, 'copy', target);
  await rename(library.directory, join(root, 'old-library')); const copied = new Library(target, extract, lookup); await copied.initialize();
  assert.equal(await readFile(await copied.conversionPath(id, 'markdown'), 'utf8'), '# Full text\n\n![Figure](images/a.png)');
  assert.deepEqual(await readFile(join(await copied.conversionPath(id, 'directory'), 'images', 'a.png')), Buffer.from([1, 2, 3]));
});
test('deduplicates a running conversion, rejects concurrent documents/copy, cancels and preserves earlier results', async () => {
  const { library, id, root } = await fixture(); await library.convertPdf(id); await library.whenIdle(); const saved = (await library.conversionState(id)).result;
  const other = await library.createPaper({ title: 'Other' }, null, false);
  library.startMineru({ environment: async () => ({ ready: true, message: '' }), convert: async (_pdf, _archive, _tier, signal) => { await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); return ''; } });
  await library.convertPdf(id); assert.equal((await library.convertPdf(id)).alreadyProcessing, true);
  await assert.rejects(library.convertPdf(other.id), /已有论文/);
  const target = join(root, 'blocked-copy'); await mkdir(target); await assert.rejects(prepareStorageChange(library, library.directory, 'copy', target), /PDF 正在转换/);
  await library.cancelConversion(id); assert.equal((await library.conversionState(id)).status, 'cancelled'); assert.deepEqual((await library.conversionState(id)).result, saved);
  library.startMineru({ environment: async () => ({ ready: true, message: '' }), convert: async () => { throw new Error('model unavailable'); } });
  await library.convertPdf(id); await library.whenIdle(); assert.equal((await library.conversionState(id)).status, 'failed'); assert.deepEqual((await library.conversionState(id)).result, saved);
  assert.ok(await readFile(await library.conversionPath(id, 'markdown')));
});
test('rejects missing PDFs/unknown modes and damaged or linked outputs without touching other files', async () => {
  const { library, root, id } = await fixture(), call = createDispatcher(library);
  const other = await library.createPaper({ title: 'No PDF' }, null, false);
  await assert.rejects(library.convertPdf(other.id), /PDF/); await assert.rejects(library.convertPdf(id, 'remote' as any), /解析模式/);
  await assert.rejects(call('documents.convert', { id, tier: 'remote' }), { code: 'INVALID_ARGUMENT' });
  await library.convertPdf(id); await library.whenIdle(); const saved = (await library.conversionState(id)).result!;
  await writeFile(library.pdfPath(id), '%PDF-1.7\nchanged'); await assert.rejects(library.conversionPath(id, 'markdown'), /不一致/);
  const outside = join(root, 'outside'); await mkdir(outside); const parsed = paperStoragePaths(library.directory, library.get(id)).parsed; await rename(parsed, parsed + '-old');
  await symlink(outside, parsed, process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(library.convertPdf(id), /链接/);
  assert.deepEqual(await readdir(outside), []); assert.ok(saved);
});
test('validates MinerU zip content and paths before writing any extracted files', async () => {
  await mkdir('.test-data', { recursive: true }); const root = await mkdtemp(resolve('.test-data/mineru-zip-'));
  const extras: Record<string, Uint8Array>[] = [ { '../escape.md': strToU8('outside') }, { 'images/evil.exe': strToU8('exe') }, { 'C:/outside.json': strToU8('{}') }, { 'images/a\\b.png': strToU8('x') } ];
  for (const [i, extra] of extras.entries()) {
    const bytes = zipSync({ 'markdown.md': strToU8('hello'), 'middle_json.json': strToU8('{}'), ...extra });
    await assert.rejects(unpackMineruResult(bytes, join(root, String(i))), /无效路径/);
  }
  await assert.rejects(unpackMineruResult(zipSync({ 'markdown.md': strToU8('') }), join(root, 'missing')), /完整/);
  await assert.rejects(unpackMineruResult(zipSync({ 'markdown.md': strToU8(''), 'middle_json.json': strToU8('{}') }), join(root, 'empty')), /未提取/);
  assert.deepEqual(await readdir(root), []);
});
test('failed publication and a changed source retain the old index; graceful shutdown rejects new conversions', async () => {
  const { library, id } = await fixture(); await library.convertPdf(id); await library.whenIdle();
  const saved = (await library.conversionState(id)).result!, path = join(paperStoragePaths(library.directory, library.get(id)).parsed, 'result.json');
  await library.convertPdf(id); await library.whenIdle();
  assert.deepEqual(JSON.parse(await readFile(path + '.bak', 'utf8')), saved);
  const current = await readFile(path); await rename(path + '.bak', path + '.previous'); await mkdir(path + '.bak');
  await library.convertPdf(id); await library.whenIdle(); assert.equal((await library.conversionState(id)).status, 'failed'); assert.deepEqual(await readFile(path), current);
  library.startMineru({ environment: async () => ({ ready: true, message: '' }), convert: async (_pdf, archive) => {
    await writeFile(library.pdfPath(id), '%PDF-1.7\nreplaced during parsing'); await writeFile(archive, packageBytes()); return '4.0.12';
  } });
  await library.convertPdf(id); await library.whenIdle(); assert.equal((await library.conversionState(id)).status, 'failed'); assert.match((await library.conversionState(id)).message, /PDF 已变化/); assert.deepEqual(await readFile(path), current);
  await library.stopConversions(); await assert.rejects(library.convertPdf(id), /退出/);
});
