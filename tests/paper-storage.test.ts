import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Library, readStoredLibrary } from '../electron/library';
import { LEGACY_INDEX_BACKUP, migratePaperStorage } from '../electron/paper-migration';
import { ensurePaperDirectory, paperStoragePaths, storageFolderName, validateStorageFolder } from '../electron/paper-storage';
import { localMetadata } from '../electron/metadata';
import type { ExtractedPdf, Paper } from '../shared/types';

const extracted: ExtractedPdf = { title: '自动驾驶：An autonomous / vehicle?', authors: ['Test Author'], year: 2020, pageCount: 2,
  firstPageText: 'fixture', doi: '', arxivId: '', abstract: '' };
const bytes = Buffer.from('%PDF-1.7\nMigration fixture\n');
const id = createHash('sha256').update(bytes).digest('hex');
const secondId = 'b'.repeat(64);
const makeLibrary = (directory: string) => new Library(directory, async () => extracted,
  async p => ({ metadata: localMetadata(p), matched: true, message: 'fixture' }));
async function fixture() {
  await mkdir('.test-data', { recursive: true });
  const directory = await mkdtemp(resolve('.test-data/paper-folders-'));
  const paper: Paper = { ...localMetadata(extracted), id, fileName: 'original.pdf', fileSize: bytes.length, pageCount: 2,
    importedAt: '2026-10-20T00:00:00Z', status: 'matched', message: '', rating: 4,
    citationMonitoring: true, citationSubscription: { account: 'fixture-account', revision: 3 },
    tags: [{ id: '12345678-1234-4234-8234-123456789abc', text: '视觉', color: '#123456' }],
    markdownNote: { fileName: 'source.md', importedAt: '2026-10-20T00:00:00Z', sourceHash: 'a'.repeat(64) } };
  const second: Paper = { ...paper, id: secondId, title: 'Metadata only', pdfHash: null, markdownNote: undefined, tags: undefined };
  const original = JSON.stringify({ version: 1, papers: [paper, second], folders: [], timelines: [], extensionData: { keep: true } });
  await writeFile(join(directory, 'library.json'), original);
  return { directory, paper, original };
}
async function put(directory: string, path: string, value: string | Buffer) {
  const file = join(directory, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, value);
}

test('v1 migration preserves PDF, edited notes, all sidecars, IDs and unknown source files before publishing v2', async () => {
  const { directory, paper, original } = await fixture();
  const mappings = [
    [`pdfs/${id}.pdf`, 'original.pdf', bytes],
    [`notes/${id}.md`, 'notes.md', Buffer.from('---\r\ntitle: 已编辑\r\n---\r\n')],
    [`notes/${id}.md.bak`, 'notes.md.bak', Buffer.from('old note')],
    [`annotations/${id}.json`, 'annotations.json', Buffer.from('{"page":4,"zoom":1.15,"marks":[1]}')],
    [`annotations/${id}.json.bak`, 'annotations.json.bak', Buffer.from('{"page":3}')],
    [`parsed/${id}/result.json`, 'parsed/result.json', Buffer.from('{"runId":"a"}')],
    [`parsed/${id}/result.json.bak`, 'parsed/result.json.bak', Buffer.from('{"runId":"b"}')],
    [`parsed/${id}/a/images/diagram.png`, 'parsed/a/images/diagram.png', Buffer.from([0, 1, 2, 255])],
    [`parsed/${id}/b/paper.md`, 'parsed/b/paper.md', Buffer.from('# previous result')],
    [`citations/${id}/citations.json`, 'citations/citations.json', Buffer.from('{"citations":[1,2]}')],
    [`citations/${id}/future-paper.pdf`, 'citations/future-paper.pdf', Buffer.from('%PDF-future')],
  ] as const;
  for (const [source, , data] of mappings) await put(directory, source, data);
  await put(directory, 'pdfs/unindexed-extra.txt', 'keep unknown');
  await put(directory, 'sync/cloud.json', '{"libraryId":"keep-sync"}');
  const library = makeLibrary(directory); await library.initialize();
  const stored = JSON.parse(await readFile(library.file, 'utf8'));
  assert.equal(stored.version, 2); assert.deepEqual(stored.extensionData, { keep: true });
  const migrated = library.get(id), { storageFolder, ...fields } = migrated;
  assert.deepEqual(fields, paper); assert.match(storageFolder!, /__[a-f0-9]{12}$/);
  for (const [source, target, data] of mappings) {
    assert.deepEqual(await readFile(join(library.paperDirectory(id), target)), data);
    assert.deepEqual(await readFile(join(directory, source)), data);
  }
  assert.equal(await readFile(join(directory, LEGACY_INDEX_BACKUP), 'utf8'), original);
  assert.equal(await readFile(join(directory, 'pdfs/unindexed-extra.txt'), 'utf8'), 'keep unknown');
  assert.equal(await readFile(join(directory, 'sync/cloud.json'), 'utf8'), '{"libraryId":"keep-sync"}');
  assert.deepEqual(library.fileAvailability(id), { pdf: true, md: true });
  assert.deepEqual(library.fileAvailability(secondId), { pdf: false, md: false });
  assert.ok((await stat(library.paperDirectory(secondId))).isDirectory());
  assert.equal(await library.markdownPath(id), join(library.paperDirectory(id), 'notes.md'));
  await assert.rejects(stat(join(directory, '.paper-migration')), { code: 'ENOENT' });
});

test('migration resumes from copied files after interruption and folder identity survives title edits and restart', async () => {
  const { directory, original } = await fixture(); await put(directory, `pdfs/${id}.pdf`, bytes);
  const first = makeLibrary(directory); await first.initialize(); const folder = first.paperDirectory(id);
  // Simulate interruption before the final index replacement, with published copies still present.
  await writeFile(first.file, original);
  const resumed = makeLibrary(directory); await resumed.initialize();
  assert.equal(resumed.paperDirectory(id), folder);
  assert.equal((await readdir(join(directory, 'papers'))).length, 2);
  await resumed.saveMetadata(id, { ...resumed.get(id), title: 'Changed title must not rename the folder' });
  const again = makeLibrary(directory); await again.initialize();
  assert.equal(again.paperDirectory(id), folder);
  assert.deepEqual(await readFile(again.pdfPath(id)), bytes);
  assert.equal(await readFile(join(directory, LEGACY_INDEX_BACKUP), 'utf8'), original);
});

test('a conflicting destination or malformed index causes no source mutation or index upgrade', async () => {
  const { directory, paper, original } = await fixture(); await put(directory, `pdfs/${id}.pdf`, bytes);
  const folder = storageFolderName(paper.title, id);
  await put(directory, `papers/${folder}/original.pdf`, 'different existing material');
  await assert.rejects(() => makeLibrary(directory).initialize(), /不同内容/);
  assert.equal(await readFile(join(directory, 'library.json'), 'utf8'), original);
  assert.deepEqual(await readFile(join(directory, `pdfs/${id}.pdf`)), bytes);
  assert.equal(await readFile(join(directory, `papers/${folder}/original.pdf`), 'utf8'), 'different existing material');
  await assert.rejects(stat(join(directory, LEGACY_INDEX_BACKUP)), { code: 'ENOENT' });
  const corrupt = '{broken'; await writeFile(join(directory, 'library.json'), corrupt);
  await assert.rejects(() => makeLibrary(directory).initialize());
  assert.equal(await readFile(join(directory, 'library.json'), 'utf8'), corrupt);
});

test('staging failure retains the original index and all original bytes, then permits a clean retry', async () => {
  const { directory, paper, original } = await fixture(); await put(directory, `pdfs/${id}.pdf`, bytes);
  const stageId = createHash('sha256').update(original).digest('hex').slice(0, 16);
  const staged = join(directory, '.paper-migration', stageId, 'papers', storageFolderName(paper.title, id), 'original.pdf');
  await put(directory, staged.slice(directory.length + 1), 'conflicting partial stage');
  await assert.rejects(() => makeLibrary(directory).initialize(), /不同内容/);
  assert.equal(await readFile(join(directory, 'library.json'), 'utf8'), original);
  assert.equal(await readFile(join(directory, LEGACY_INDEX_BACKUP), 'utf8'), original);
  assert.deepEqual(await readFile(join(directory, `pdfs/${id}.pdf`)), bytes);
  await assert.rejects(stat(join(directory, 'papers')), { code: 'ENOENT' });
  // Restore this known fixture file only; no production data is touched.
  await writeFile(staged, bytes);
  const recovered = makeLibrary(directory); await recovered.initialize();
  assert.deepEqual(await readFile(recovered.pdfPath(id)), bytes);
});

test('index replacement between validation and migration aborts before any write', async () => {
  const { directory, original } = await fixture();
  const validated = await readStoredLibrary(directory);
  const changed = JSON.stringify({ ...JSON.parse(original), folders: [{ id: '12345678-1234-4234-8234-123456789abc', name: 'Changed concurrently' }] });
  await writeFile(join(directory, 'library.json'), changed);
  await assert.rejects(() => migratePaperStorage(directory, validated), /校验后发生变化/);
  assert.equal(await readFile(join(directory, 'library.json'), 'utf8'), changed);
  await assert.rejects(stat(join(directory, LEGACY_INDEX_BACKUP)), { code: 'ENOENT' });
  await assert.rejects(stat(join(directory, 'papers')), { code: 'ENOENT' });
});

test('safe stable names handle forbidden characters, reserved words and prefix collisions; v2 requires distinct safe folders', async () => {
  const a = 'a'.repeat(64), b = 'a'.repeat(12) + 'b'.repeat(52);
  const first = storageFolderName('CON: / <bad>? * .', a), second = storageFolderName('CON: / <bad>? * .', b, [first]);
  assert.notEqual(first.toLowerCase(), second.toLowerCase()); assert.ok(first.startsWith('CON bad'));
  validateStorageFolder(storageFolderName('😀'.repeat(60), a));
  for (const invalid of ['../outside', '..', 'bad/name', 'bad\\name', 'C:escape', 'CON', 'NUL.txt', 'tail.', 'tail ', '']) {
    assert.throws(() => validateStorageFolder(invalid));
  }
  const { directory, paper } = await fixture();
  for (const storageFolder of [undefined, '../outside', 'CON', 'bad:stream']) {
    const original = JSON.stringify({ version: 2, papers: [{ ...paper, storageFolder }] });
    await writeFile(join(directory, 'library.json'), original);
    await assert.rejects(() => readStoredLibrary(directory));
    await assert.rejects(() => makeLibrary(directory).initialize());
    assert.equal(await readFile(join(directory, 'library.json'), 'utf8'), original);
  }
  await writeFile(join(directory, 'library.json'), JSON.stringify({ version: 2, papers: [
    { ...paper, storageFolder: 'Same' }, { ...paper, id: secondId, tags: undefined, storageFolder: 'same' },
  ] }));
  await assert.rejects(() => readStoredLibrary(directory), /重复/);
});

test('legacy missing files remain unavailable and new metadata/PDF/notes all use the same stable folder', async () => {
  const { directory } = await fixture(); const library = makeLibrary(directory); await library.initialize();
  assert.deepEqual(library.fileAvailability(id), { pdf: false, md: false });
  const created = await library.createPaper({ title: 'New catalog paper' }, null, false);
  const folder = library.paperDirectory(created.id);
  const source = join(directory, 'external.pdf'), note = join(directory, 'external.md');
  await writeFile(source, '%PDF-new material'); await writeFile(note, '# New note');
  await library.attachPdf(created.id, source); await library.attachMarkdown(created.id, note);
  assert.equal(library.pdfPath(created.id), join(folder, 'original.pdf'));
  assert.equal(await library.markdownPath(created.id), join(folder, 'notes.md'));
  assert.equal(library.get(created.id).id, created.id);
  assert.equal(paperStoragePaths(directory, library.get(created.id)).directory, folder);
  const standalone = join(directory, 'new-library'); const fresh = makeLibrary(standalone); await fresh.initialize();
  assert.equal(JSON.parse(await readFile(fresh.file, 'utf8')).version, 2);
  const imported = await fresh.importPaths([source]); await fresh.whenIdle();
  assert.equal(imported.imported, 1); assert.match(fresh.pdfPath(imported.paperIds![0]), /original\.pdf$/);
  await assert.rejects(stat(join(standalone, 'pdfs')), { code: 'ENOENT' });
});

test('directory junctions are rejected before writes and cannot redirect paper folders', async () => {
  const { directory, original } = await fixture(); const outside = join(directory, 'outside'); await mkdir(outside);
  await symlink(outside, join(directory, 'papers'), 'junction');
  await assert.rejects(() => makeLibrary(directory).initialize(), /链接/);
  await assert.rejects(() => ensurePaperDirectory(directory, 'some-paper'), /链接/);
  assert.deepEqual(await readdir(outside), []);
  assert.equal(await readFile(join(directory, 'library.json'), 'utf8'), original);
  await assert.rejects(stat(join(directory, LEGACY_INDEX_BACKUP)), { code: 'ENOENT' });
});
