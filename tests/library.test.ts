import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Library } from '../electron/library';
import { localMetadata } from '../electron/metadata';
import type { ExtractedPdf, PaperTagPosition } from '../shared/types';
const pdf: ExtractedPdf = { title: 'A test paper on autonomous driving', authors: ['Test Author'], year: 2025, pageCount: 2, firstPageText: 'text', doi: '', arxivId: '', abstract: '' };
async function setup() { await mkdir('.test-data', { recursive: true }); return mkdtemp(resolve('.test-data/library-')); }
test('concurrent imports deduplicate by content, persist metadata, and retain an independent PDF copy', async () => {
  const root = await setup(), file = join(root, 'sample.pdf');
  await writeFile(file, '%PDF-1.7\nfixture');
  const library = new Library(join(root, 'library'), async () => pdf, async p => ({ metadata: localMetadata(p), matched: true, message: 'found' }));
  await library.initialize();
  const results = await Promise.all([library.importPaths([file]), library.importPaths([file])]);
  assert.equal(results.reduce((n, r) => n + r.imported, 0), 1);
  assert.equal(results.reduce((n, r) => n + r.duplicates, 0), 1);
  await library.whenIdle();
  const paper = library.list()[0]; assert.equal(paper.status, 'matched');
  await writeFile(file, 'original file changed');
  assert.match(await readFile(library.pdfPath(paper.id), 'utf8'), /^%PDF/);
  await library.saveMetadata(paper.id, { ...paper, title: 'Manually corrected title', year: 2024, publicationDate: '2024-02-29', doi: 'https://doi.org/10.1234/updated' });
  assert.equal(library.list()[0].url, 'https://doi.org/10.1234/updated');
  const restarted = new Library(join(root, 'library'), async () => pdf, async p => ({ metadata: localMetadata(p), matched: false, message: 'offline' }));
  await restarted.initialize();
  assert.equal(restarted.list()[0].title, 'Manually corrected title');
  assert.equal(restarted.list()[0].source, '手动');
  assert.equal(restarted.list()[0].publicationDate, '2024-02-29');
  assert.equal(restarted.list()[0].year, 2024);
  await assert.rejects(() => restarted.saveMetadata(paper.id, { ...paper, publicationDate: '2025-02-29' }), /发表日期/);
  assert.equal(restarted.list()[0].publicationDate, '2024-02-29');
  await restarted.saveMetadata(paper.id, { ...paper, publicationDate: '2023-11' });
  assert.equal(restarted.list()[0].year, 2023);
  await restarted.saveMetadata(paper.id, { ...paper, publicationDate: '' });
  assert.equal(restarted.list()[0].publicationDate, '');
  assert.equal(restarted.list()[0].year, null);
  await restarted.retry(paper.id); await restarted.whenIdle(); assert.equal(restarted.list()[0].status, 'review');
  assert.equal(restarted.list()[0].publicationDate, '2025');
});
test('invalid PDF input is rejected, and a failed parse does not stop the following file', async () => {
  const root = await setup();
  const fake = join(root, 'fake.pdf'), corrupt = join(root, 'corrupt.pdf'), good = join(root, 'good.pdf');
  await writeFile(fake, 'not a PDF'); await writeFile(corrupt, '%PDF-broken'); await writeFile(good, '%PDF-good');
  const library = new Library(join(root, 'library'), async (_path, name) => { if (name === 'corrupt.pdf') throw new Error('Invalid PDF'); return pdf; }, async p => ({ metadata: localMetadata(p), matched: true, message: 'found' }));
  await library.initialize();
  const result = await library.importPaths([fake, corrupt, good]);
  assert.equal(result.errors.length, 1); assert.equal(result.imported, 2);
  await library.whenIdle();
  assert.equal(library.list().find(p => p.fileName === 'corrupt.pdf')?.status, 'error');
  assert.equal(library.list().find(p => p.fileName === 'good.pdf')?.status, 'matched');
});
test('a corrupted library is never silently overwritten', async () => {
  const root = await setup(); const file = join(root, 'library.json'); await writeFile(file, '{broken');
  const library = new Library(root, async () => pdf, async p => ({ metadata: localMetadata(p), matched: false, message: '' }));
  await assert.rejects(() => library.initialize()); assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('folders persist with papers across rename, metadata refresh and restart without extra PDF copies', async () => {
  const root = await setup(), file = join(root, 'sample.pdf');
  await writeFile(file, '%PDF-1.7\nfolder fixture');
  const makeLibrary = () => new Library(join(root, 'library'), async () => pdf, async p => ({ metadata: localMetadata(p), matched: true, message: 'found' }));
  const library = makeLibrary(); await library.initialize();
  const folder = await library.createFolder('  世界模型  ');
  assert.equal(folder.name, '世界模型');
  const result = await library.importPaths([file], folder.id); await library.whenIdle();
  assert.equal(result.imported, 1);
  const paper = library.list()[0], originalPdf = await readFile(library.pdfPath(paper.id));
  assert.equal(paper.folderId, folder.id);
  await library.renameFolder(folder.id, '轨迹规划');
  await library.saveMetadata(paper.id, { ...paper, title: 'Edited paper' });
  assert.equal(library.list()[0].folderId, folder.id);
  await library.retry(paper.id); await library.whenIdle();
  assert.equal(library.list()[0].folderId, folder.id);
  const restarted = makeLibrary(); await restarted.initialize();
  assert.deepEqual(restarted.state().folders, [{ id: folder.id, name: '轨迹规划' }]);
  assert.equal(restarted.list()[0].folderId, folder.id);
  const second = await restarted.createFolder('其他论文');
  await restarted.movePaper(paper.id, second.id);
  assert.equal(restarted.list()[0].folderId, second.id);
  const duplicate = await restarted.importPaths([file], folder.id);
  assert.equal(duplicate.duplicates, 1); assert.equal(restarted.list()[0].folderId, second.id);
  await restarted.deleteFolder(second.id);
  assert.equal(restarted.list()[0].folderId, null);
  assert.deepEqual(await readFile(restarted.pdfPath(paper.id)), originalPdf);
  const again = makeLibrary(); await again.initialize();
  assert.equal(again.list()[0].folderId, null);
  assert.equal(again.state().folders.length, 1);
});

test('folder validation rejects duplicates, invalid references and malformed stored data', async () => {
  const root = await setup();
  const library = new Library(root, async () => pdf, async p => ({ metadata: localMetadata(p), matched: true, message: '' }));
  await library.initialize();
  const concurrent = await Promise.allSettled([library.createFolder('Papers'), library.createFolder(' papers ')]);
  assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
  for (const name of ['', 'a'.repeat(81), 'bad\nname']) await assert.rejects(() => library.createFolder(name));
  const before = await readFile(library.file, 'utf8');
  await assert.rejects(() => library.importPaths([], 'not-a-folder'), /文件夹/);
  await assert.rejects(() => library.movePaper('missing-paper', null), /文献/);
  await assert.rejects(() => library.renameFolder('bad', 'New'), /文件夹/);
  assert.equal(await readFile(library.file, 'utf8'), before);
  await writeFile(library.file, JSON.stringify({ version: 1, papers: [], folders: [{ id: 'bad', name: 'folder' }] }));
  const restarted = new Library(root, async () => pdf, async p => ({ metadata: localMetadata(p), matched: true, message: '' }));
  await assert.rejects(() => restarted.initialize(), /文件夹/);
});

test('old libraries migrate with a preserved index backup; failed folder saves roll back the visible organization', async () => {
  const root = await setup(), file = join(root, 'sample.pdf');
  await writeFile(file, '%PDF-1.7\nold schema fixture');
  const directory = join(root, 'library');
  const makeLibrary = () => new Library(directory, async () => pdf, async p => ({ metadata: localMetadata(p), matched: true, message: '' }));
  const first = new Library(join(root, 'seed'), async () => pdf, async p => ({ metadata: localMetadata(p), matched: true, message: '' }));
  await first.initialize(); await first.importPaths([file]); await first.whenIdle();
  const oldPaper = first.list()[0]; delete oldPaper.folderId; delete oldPaper.storageFolder;
  const legacy = JSON.stringify({ version: 1, papers: [oldPaper] });
  await mkdir(join(directory, 'pdfs'), { recursive: true });
  await writeFile(join(directory, 'pdfs', oldPaper.id + '.pdf'), await readFile(file));
  await writeFile(join(directory, 'library.json'), legacy);
  const library = makeLibrary(); await library.initialize();
  assert.equal(await readFile(join(directory, 'library.pre-paper-folders-v1.json'), 'utf8'), legacy);
  assert.equal(JSON.parse(await readFile(library.file, 'utf8')).version, 2); assert.deepEqual(library.state().folders, []);
  assert.equal(Object.hasOwn(library.list()[0], 'tags'), false);
  const folder = await library.createFolder('Saved');
  await library.movePaper(oldPaper.id, folder.id);
  const before = await readFile(library.file, 'utf8');
  await mkdir(library.file + '.tmp'); // Deliberately prevent atomic-write temp file creation.
  await assert.rejects(() => library.createFolder('Unsaved'));
  await assert.rejects(() => library.renameFolder(folder.id, 'Unsaved'));
  await assert.rejects(() => library.movePaper(oldPaper.id, null));
  await assert.rejects(() => library.deleteFolder(folder.id));
  assert.deepEqual(library.state().folders, [folder]);
  assert.equal(library.list()[0].folderId, folder.id);
  assert.equal(await readFile(library.file, 'utf8'), before);
});

async function taggedLibraryFixture() {
  const root = await setup(), file = join(root, 'sample.pdf'), directory = join(root, 'library');
  await writeFile(file, '%PDF-1.7\ntag fixture');
  const makeLibrary = () => new Library(directory, async () => pdf, async p => ({ metadata: localMetadata(p), matched: true, message: 'found' }));
  const library = makeLibrary(); await library.initialize(); await library.importPaths([file]); await library.whenIdle();
  return { library, makeLibrary, paper: library.list()[0] };
}

test('paper tags persist, keep stable IDs on edits, and survive metadata edits and refreshes', async () => {
  const { library, makeLibrary, paper } = await taggedLibraryFixture();
  const before = library.list()[0];
  const tag = await library.addTag(paper.id, '  单一网络  ', '#77bc88');
  assert.equal(tag.text, '单一网络'); assert.equal(tag.color, '#77BC88');
  assert.match(tag.id, /^[a-f0-9-]{36}$/);
  const after = library.list()[0]; delete after.tags;
  assert.deepEqual(after, before);
  tag.text = 'Changing a returned object must not mutate the library';
  assert.equal(library.list()[0].tags?.[0].text, '单一网络');
  await library.updateTag(paper.id, tag.id, '  视觉-动作  ', '#aaccdd');
  const expected = [{ id: tag.id, text: '视觉-动作', color: '#AACCDD' }];
  assert.deepEqual(library.list()[0].tags, expected);
  await library.saveMetadata(paper.id, { ...paper, title: 'Manually reviewed paper' });
  assert.deepEqual(library.list()[0].tags, expected);
  await library.retry(paper.id); await library.whenIdle();
  assert.deepEqual(library.list()[0].tags, expected);
  const restarted = makeLibrary(); await restarted.initialize();
  assert.deepEqual(restarted.list()[0].tags, expected);
  await restarted.deleteTag(paper.id, tag.id);
  const again = makeLibrary(); await again.initialize();
  assert.deepEqual(again.list()[0].tags, []);
});

test('concurrent tag additions retain all distinct tags and reject a simultaneous duplicate', async () => {
  const { library, makeLibrary, paper } = await taggedLibraryFixture();
  const results = await Promise.allSettled([
    library.addTag(paper.id, 'Planning', '#aabbcc'),
    library.addTag(paper.id, 'Vision', '#123456'),
    library.addTag(paper.id, ' planning ', '#654321'),
    library.addTag(paper.id, 'Control', '#fedcba'),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 3);
  const restarted = makeLibrary(); await restarted.initialize();
  const tags = restarted.list()[0].tags!;
  assert.deepEqual(tags.map(tag => tag.text), ['Planning', 'Vision', 'Control']);
  assert.equal(new Set(tags.map(tag => tag.id)).size, 3);
});

test('tag positions persist and survive edits, refreshes and concurrent moves without changing other paper data', async () => {
  const { library, makeLibrary, paper } = await taggedLibraryFixture();
  const first = await library.addTag(paper.id, 'First', '#123456');
  const second = await library.addTag(paper.id, 'Second', '#654321');
  const beforePaper = library.list()[0]; delete beforePaper.tags;
  const originalPdf = await readFile(library.pdfPath(paper.id));
  const position: PaperTagPosition = { side: 'left', offset: 0.3 };
  await library.moveTag(paper.id, first.id, position);
  position.offset = 0.9;
  assert.deepEqual(library.list()[0].tags?.[0].position, { side: 'left', offset: 0.3 });
  await Promise.all([
    library.moveTag(paper.id, first.id, { side: 'top', offset: 0 }),
    library.updateTag(paper.id, first.id, 'Edited', '#abcdef'),
    library.moveTag(paper.id, second.id, { side: 'right', offset: 1 }),
  ]);
  const expected = [
    { ...first, text: 'Edited', color: '#ABCDEF', position: { side: 'top', offset: 0 } },
    { ...second, position: { side: 'right', offset: 1 } },
  ];
  assert.deepEqual(library.list()[0].tags, expected);
  const afterPaper = library.list()[0]; delete afterPaper.tags;
  assert.deepEqual(afterPaper, beforePaper);
  assert.deepEqual(await readFile(library.pdfPath(paper.id)), originalPdf);
  await library.saveMetadata(paper.id, { ...paper, title: 'Edited metadata' });
  await library.retry(paper.id); await library.whenIdle();
  const restarted = makeLibrary(); await restarted.initialize();
  assert.deepEqual(restarted.list()[0].tags, expected);
  await restarted.moveTag(paper.id, first.id, { side: 'bottom', offset: 0.5 });
  const again = makeLibrary(); await again.initialize();
  assert.deepEqual(again.list()[0].tags?.[0].position, { side: 'bottom', offset: 0.5 });
});

test('legacy tags without positions load unchanged and can be moved', async () => {
  const { library, makeLibrary, paper } = await taggedLibraryFixture();
  const tag = await library.addTag(paper.id, 'Legacy', '#AABBCC');
  const stored = await readFile(library.file, 'utf8');
  const restarted = makeLibrary(); await restarted.initialize();
  assert.equal(await readFile(library.file, 'utf8'), stored);
  assert.equal(Object.hasOwn(restarted.list()[0].tags![0], 'position'), false);
  await restarted.moveTag(paper.id, tag.id, { side: 'left', offset: 0.4 });
  const again = makeLibrary(); await again.initialize();
  assert.deepEqual(again.list()[0].tags, [{ ...tag, position: { side: 'left', offset: 0.4 } }]);
});

test('invalid tag positions and missing references are rejected without mutations or events', async () => {
  const { library, paper } = await taggedLibraryFixture();
  const tag = await library.addTag(paper.id, 'Positioned', '#AABBCC');
  await library.moveTag(paper.id, tag.id, { side: 'bottom', offset: 0.5 });
  const beforePaper = library.list()[0], before = await readFile(library.file, 'utf8');
  let changes = 0; library.on('changed', () => { changes++; });
  for (const position of [
    null, undefined, [], 'bottom', {}, { side: 'top' }, { offset: 0 },
    { side: 'middle', offset: 0.5 }, { side: 'TOP', offset: 0.5 },
    { side: 'top', offset: -0.001 }, { side: 'top', offset: 1.001 },
    { side: 'top', offset: NaN }, { side: 'top', offset: Infinity },
    { side: 'top', offset: '0.5' }, { side: 'top', offset: null },
    { side: 'top', offset: 0.5, extra: true },
  ]) await assert.rejects(() => library.moveTag(paper.id, tag.id, position as PaperTagPosition), /标签位置/);
  await assert.rejects(() => library.moveTag('missing', tag.id, { side: 'top', offset: 0 }), /文献/);
  await assert.rejects(() => library.moveTag(paper.id, 'missing', { side: 'top', offset: 0 }), /标签/);
  assert.deepEqual(library.list()[0], beforePaper);
  assert.equal(await readFile(library.file, 'utf8'), before);
  assert.equal(changes, 0);
});

test('tag validation rejects unsafe colors, invalid text, duplicates and more than 32 tags without mutations', async () => {
  const { library, paper } = await taggedLibraryFixture();
  const first = await library.addTag(paper.id, 'First', '#ffffff');
  const second = await library.addTag(paper.id, 'Second', '#000000');
  const before = await readFile(library.file, 'utf8');
  for (const text of ['', '   ', 'a'.repeat(81), 'bad\nname', '\tname', 'bad\u0085name', null, 12]) {
    await assert.rejects(() => library.addTag(paper.id, text as string, '#123456'), /标签文字/);
    await assert.rejects(() => library.updateTag(paper.id, first.id, text as string, '#123456'), /标签文字/);
  }
  for (const color of ['', 'red', '#abc', '#11223344', '#gg2233', ' #112233', 'url(x)', null, 12]) {
    await assert.rejects(() => library.addTag(paper.id, 'Valid', color as string), /颜色/);
    await assert.rejects(() => library.updateTag(paper.id, first.id, 'Valid', color as string), /颜色/);
  }
  await assert.rejects(() => library.addTag(paper.id, ' first ', '#123456'), /同名标签/);
  await assert.rejects(() => library.updateTag(paper.id, first.id, 'SECOND', '#123456'), /同名标签/);
  await assert.rejects(() => library.addTag('missing', 'Tag', '#123456'), /文献/);
  await assert.rejects(() => library.updateTag(paper.id, 'missing', 'Tag', '#123456'), /标签/);
  await assert.rejects(() => library.deleteTag(paper.id, 'missing'), /标签/);
  assert.equal(await readFile(library.file, 'utf8'), before);
  assert.deepEqual(library.list()[0].tags, [first, second]);
  for (let i = 2; i < 32; i++) await library.addTag(paper.id, `Tag ${i}`, '#123456');
  await assert.rejects(() => library.addTag(paper.id, 'One more', '#123456'), /32/);
  assert.equal(library.list()[0].tags?.length, 32);
});

test('malformed stored tags fail initialization without overwriting the library', async () => {
  const { library, makeLibrary, paper } = await taggedLibraryFixture();
  const valid = { id: '8d00b7ef-6027-4695-aa20-cf838e689325', text: 'A tag', color: '#ABCDEF' };
  const malformed = [
    null, {}, [null], [{ ...valid, id: 'bad' }], [{ ...valid, text: '  ' }], [{ ...valid, text: ' untrimmed ' }],
    [{ ...valid, text: 'a'.repeat(81) }], [{ ...valid, text: 'bad\nname' }], [{ ...valid, color: 'red' }],
    [valid, { ...valid, text: 'Another tag' }], [valid, { ...valid, id: '8d00b7ef-6027-4695-aa20-cf838e689326', text: 'a TAG' }],
    ...[null, [], {}, { side: 'diagonal', offset: 0.5 }, { side: 'left', offset: -1 },
      { side: 'bottom', offset: 2 }, { side: 'right', offset: '0.5' }, { side: 'top', offset: null },
      { side: 'top', offset: 0.5, extra: true }].map(position => [{ ...valid, position }]),
    Array.from({ length: 33 }, (_, i) => ({ ...valid, id: `8d00b7ef-6027-4695-aa20-${String(i).padStart(12, '0')}`, text: `Tag ${i}` })),
  ];
  for (const tags of malformed) {
    const stored = JSON.stringify({ version: 1, papers: [{ ...paper, tags }], folders: [] });
    await writeFile(library.file, stored);
    await assert.rejects(() => makeLibrary().initialize(), /标签信息异常/);
    assert.equal(await readFile(library.file, 'utf8'), stored);
  }
});

test('failed tag saves restore previous tags, preserve old libraries and do not emit changes', async () => {
  for (const tagState of ['none', 'default', 'positioned']) {
    const { library, paper } = await taggedLibraryFixture();
    const tag = tagState !== 'none' ? await library.addTag(paper.id, 'Saved', '#123456') : undefined;
    if (tag && tagState === 'positioned') await library.moveTag(paper.id, tag.id, { side: 'left', offset: 0.25 });
    const beforePaper = library.list()[0], before = await readFile(library.file, 'utf8');
    let changes = 0; library.on('changed', () => { changes++; });
    await mkdir(library.file + '.tmp');
    await assert.rejects(() => library.addTag(paper.id, 'Unsaved', '#654321'));
    if (tag) {
      await assert.rejects(() => library.updateTag(paper.id, tag.id, 'Unsaved', '#654321'));
      await assert.rejects(() => library.moveTag(paper.id, tag.id, { side: 'right', offset: 0.75 }));
      await assert.rejects(() => library.deleteTag(paper.id, tag.id));
    }
    assert.deepEqual(library.list()[0], beforePaper);
    assert.equal(await readFile(library.file, 'utf8'), before);
    assert.equal(changes, 0);
  }
});
