import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Library } from '../electron/library';
import { localMetadata } from '../electron/metadata';
import { inspectStorageSelection, prepareStorageChange, saveLibraryLocation } from '../electron/storage-settings';
import { readLibraryLocation, locationSettingsFile } from '../electron/storage-path';
import type { ExtractedPdf } from '../shared/types';
import { startAiApi } from '../electron/ai-api';
import { execFile } from 'node:child_process';
import { paperStoragePaths } from '../electron/paper-storage';

const pdf: ExtractedPdf = { title: 'Portable library paper', authors: ['Test Author'], year: 2025, pageCount: 1, firstPageText: 'fixture', doi: '', arxivId: '', abstract: '' };
async function fixture(withPaper = true) {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(resolve('.test-data/location-'));
  const library = new Library(join(root, 'library'), async () => pdf, async extracted => ({ metadata: localMetadata(extracted), matched: true, message: '' }));
  await library.initialize();
  if (withPaper) {
    const path = join(root, 'sample.pdf');
    await writeFile(path, '%PDF-1.7\nportable library test');
    await library.importPaths([path]); await library.whenIdle();
    const paper = library.list()[0];
    const folder = await library.createFolder('测试分类'); await library.movePaper(paper.id, folder.id);
    await library.addTag(paper.id, '测试标签', '#27B8AD');
    await library.setRating(paper.id, 4);
    await library.updateTimeline(library.state().timelines[0].id, { tags: ['测试标签'], position: { x: 111, y: -235 } });
  }
  const target = join(root, '目标 文献库'); await mkdir(target);
  return { root, library, target };
}

test('copy preserves papers, PDFs, folders, tags, ratings, timelines and backups, and excludes session credentials', async () => {
  const { root, library, target } = await fixture();
  await writeFile(join(library.directory, '.ai-session.json'), JSON.stringify({ pid: process.pid }));
  const before = await readFile(library.file);
  const pending = library.createTimeline({ x: 42, y: 800 });
  await prepareStorageChange(library, library.directory, 'copy', target);
  const added = await pending;
  assert.notDeepEqual(await readFile(library.file), before); // An already accepted write must be included.
  assert.deepEqual(await readFile(join(target, 'library.json')), await readFile(library.file));
  assert.equal(JSON.parse(await readFile(join(target, 'library.json'), 'utf8')).papers[0].rating, 4);
  assert.deepEqual(await readFile(join(target, 'library.json.bak')), await readFile(library.file + '.bak'));
  const paper = library.list()[0];
  assert.deepEqual(await readFile(paperStoragePaths(target, paper).pdf!), await readFile(library.pdfPath(paper.id)));
  assert.ok(JSON.parse(await readFile(join(target, 'library.json'), 'utf8')).timelines.some((t: any) => t.id === added.id));
  assert.deepEqual((await readdir(target)).sort(), ['library.json', 'library.json.bak', 'papers']);
  assert.equal(readLibraryLocation(join(root, 'library')), target);
  await assert.rejects(library.createFolder('late write'), /切换/);
  await assert.rejects(library.importPaths([]), /切换/);
  await assert.rejects(library.retry(library.list()[0].id), /切换/);
  await assert.rejects(library.saveMetadata(library.list()[0].id, library.list()[0]), /切换/);
});

test('opening an existing library validates all files without changing either library', async () => {
  const a = await fixture(), b = await fixture();
  const originalA = await readFile(a.library.file), originalB = await readFile(b.library.file);
  const preview = await inspectStorageSelection('open', b.library.directory, a.library.directory);
  assert.equal(preview.paperCount, 1);
  await prepareStorageChange(a.library, a.library.directory, 'open', b.library.directory);
  assert.equal(readLibraryLocation(a.library.directory), b.library.directory);
  assert.deepEqual(await readFile(a.library.file), originalA);
  assert.deepEqual(await readFile(b.library.file), originalB);
});

test('empty library creation does not copy the current papers, and saved relative paths travel with the app', async () => {
  const { root, library, target } = await fixture();
  const before = await readFile(library.file);
  await prepareStorageChange(library, library.directory, 'create', target);
  const data = JSON.parse(await readFile(join(target, 'library.json'), 'utf8'));
  assert.equal(data.papers.length, 0);
  assert.equal(data.version, 2);
  assert.deepEqual((await readdir(target)).sort(), ['library.json', 'papers']);
  assert.equal(data.timelines.length, 1);
  assert.deepEqual(await readFile(library.file), before);
  const settings = JSON.parse(await readFile(locationSettingsFile(library.directory), 'utf8'));
  assert.equal(settings.directory, '目标 文献库');
  const moved = join(root, 'copied-app'); await mkdir(moved);
  await writeFile(join(moved, 'library-location.json'), JSON.stringify(settings));
  assert.equal(readLibraryLocation(join(moved, 'library')), join(moved, '目标 文献库'));
});

test('invalid, occupied, nested or incomplete destinations do not overwrite data or save settings', async () => {
  const { root, library, target } = await fixture();
  const before = await readFile(library.file);
  await writeFile(join(target, 'keep.txt'), 'do not overwrite');
  await assert.rejects(prepareStorageChange(library, library.directory, 'copy', target), /空文件夹/);
  await assert.rejects(inspectStorageSelection('open', target, library.directory), /library.json/);
  await assert.rejects(inspectStorageSelection('copy', library.directory, library.directory), /当前/);
  await assert.rejects(inspectStorageSelection('copy', join(library.directory, 'papers'), library.directory), /独立/);
  await assert.rejects(inspectStorageSelection('copy', root, library.directory), /独立/);
  const broken = join(root, 'broken'); await mkdir(broken); await mkdir(paperStoragePaths(broken, library.list()[0]).directory, { recursive: true });
  await writeFile(join(broken, 'library.json'), before);
  await assert.rejects(prepareStorageChange(library, library.directory, 'open', broken), /缺少 PDF/);
  await assert.rejects(inspectStorageSelection('open', join(root, 'missing'), library.directory));
  await assert.rejects(readFile(locationSettingsFile(library.directory)), { code: 'ENOENT' });
  assert.deepEqual(await readFile(library.file), before);
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'do not overwrite');
  await library.createFolder('still usable');
});

test('busy jobs block switching; an active destination library cannot be opened', async () => {
  const { root, library, target } = await fixture(false);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const busy = new Library(join(root, 'busy'), async () => { await pending; return pdf; }, async extracted => ({ metadata: localMetadata(extracted), matched: true, message: '' }));
  await busy.initialize(); const path = join(root, 'job.pdf'); await writeFile(path, '%PDF-job'); await busy.importPaths([path]);
  await assert.rejects(prepareStorageChange(busy, library.directory, 'copy', target), /检索/);
  release(); await busy.whenIdle();
  await writeFile(join(busy.directory, '.ai-session.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(inspectStorageSelection('open', busy.directory, library.directory), /正在被另一个/);
});

test('copy failure rolls back created files and leaves the original library editable', async () => {
  const { root, library, target } = await fixture();
  const before = await readFile(library.file);
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'keep');
  const paths = paperStoragePaths(library.directory, library.list()[0]);
  await writeFile(join(paths.directory, 'a-extra.txt'), 'copied before failure');
  await symlink(outside, join(paths.directory, 'z-linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareStorageChange(library, library.directory, 'copy', target), /链接/);
  assert.deepEqual(await readdir(target), []);
  assert.deepEqual(await readFile(library.file), before);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
  await library.createFolder('after failure');
});

test('copy includes all live paper resources and user extras, excludes transient files and historical trees, and reopens', async () => {
  const { root, library, target } = await fixture();
  const id = library.list()[0].id;
  const note = join(root, 'note.md'); await writeFile(note, '# portable note'); await library.attachMarkdown(id, note);
  const paper = library.list()[0];
  const source = paperStoragePaths(library.directory, paper);
  const entries: Record<string, string> = {
    'annotations.json': '{"fixture":"annotations"}',
    'annotations.json.bak': '{"fixture":"previous annotations"}',
    'parsed/result.json': '{"fixture":"result index"}',
    'parsed/result.json.bak': '{"fixture":"previous result"}',
    'parsed/run/images/page.png': 'image bytes',
    'citations/citations.json': '{"fixture":"citations"}',
    'citations/citations.json.bak': '{"fixture":"previous citations"}',
    'supplementary/data.csv': 'column\nvalue',
    'reading-report.md': '# My report',
  };
  for (const [name, content] of Object.entries(entries)) {
    const parts = name.split('/'); parts.pop();
    await mkdir(join(source.directory, ...parts), { recursive: true });
    await writeFile(join(source.directory, name), content);
  }
  await writeFile(join(source.directory, 'pending.tmp'), 'unfinished');
  await writeFile(join(source.directory, '.ai-session.json'), 'not copied');
  await writeFile(join(source.directory, 'llm-config.bin'), 'not copied');
  await mkdir(join(library.directory, 'sync')); await writeFile(join(library.directory, 'sync', 'cloud.json'), '{"fixture":"sync"}');
  await mkdir(join(library.directory, 'pdfs')); await writeFile(join(library.directory, 'pdfs', 'old.pdf'), 'historical only');
  await writeFile(join(library.directory, 'library.pre-paper-folders-v1.json'), '{"fixture":"backup"}');
  const oldBackup = JSON.stringify({ version: 1, papers: [] });
  await writeFile(library.file + '.bak', oldBackup);
  await prepareStorageChange(library, library.directory, 'copy', target);
  const destination = paperStoragePaths(target, paper);
  for (const [name, content] of Object.entries(entries)) assert.equal(await readFile(join(destination.directory, name), 'utf8'), content);
  assert.equal(await readFile(destination.markdown, 'utf8'), '# portable note');
  assert.deepEqual(await readFile(destination.pdf!), await readFile(source.pdf!));
  assert.equal(await readFile(join(target, 'sync', 'cloud.json'), 'utf8'), '{"fixture":"sync"}');
  for (const name of ['pending.tmp', '.ai-session.json', 'llm-config.bin']) await assert.rejects(readFile(join(destination.directory, name)), { code: 'ENOENT' });
  await assert.rejects(readdir(join(target, 'pdfs')), { code: 'ENOENT' });
  assert.equal(await readFile(join(library.directory, 'pdfs', 'old.pdf'), 'utf8'), 'historical only');
  assert.equal(await readFile(library.file + '.bak', 'utf8'), oldBackup);
  assert.deepEqual(await readFile(join(target, 'library.json.bak')), await readFile(join(target, 'library.json')));
  const reopened = new Library(target, async () => pdf, async extracted => ({ metadata: localMetadata(extracted), matched: true, message: '' })); await reopened.initialize();
  assert.equal(reopened.list()[0].id, id);
  assert.equal(reopened.list()[0].storageFolder, paper.storageFolder);
  assert.equal(await reopened.markdownPath(id), destination.markdown);
  assert.equal(reopened.pdfPath(id), destination.pdf);
  assert.equal((await inspectStorageSelection('open', target)).paperCount, 1);
});

test('v1 libraries can be selected without migration or changes', async () => {
  const { root, library } = await fixture();
  const legacy = join(root, 'legacy'); await mkdir(join(legacy, 'pdfs'), { recursive: true });
  const paper = { ...library.list()[0] }; delete paper.storageFolder;
  await copyFile(library.pdfPath(paper.id), join(legacy, 'pdfs', paper.id + '.pdf'));
  const content = JSON.stringify({ version: 1, papers: [paper], folders: library.state().folders, timelines: library.state().timelines });
  await writeFile(join(legacy, 'library.json'), content);
  const before = (await readdir(legacy)).sort();
  assert.equal((await inspectStorageSelection('open', legacy, library.directory)).paperCount, 1);
  assert.equal(await readFile(join(legacy, 'library.json'), 'utf8'), content);
  assert.deepEqual((await readdir(legacy)).sort(), before);
});

test('missing linked resources abort copying and leave an empty destination', async () => {
  const { root, library, target } = await fixture();
  const id = library.list()[0].id;
  const note = join(root, 'missing-note.md'); await writeFile(note, '# note'); await library.attachMarkdown(id, note);
  await unlink(await library.markdownPath(id));
  await assert.rejects(prepareStorageChange(library, library.directory, 'copy', target), /丢失/);
  assert.deepEqual(await readdir(target), []);
  await library.createFolder('editable after missing file');
});

test('invalid location settings are not silently treated as an empty default library', async () => {
  const { library } = await fixture();
  await writeFile(locationSettingsFile(library.directory), '{invalid');
  assert.throws(() => readLibraryLocation(library.directory), /重新选择/);
});

test('CLI follows the selected library and Windows path casing without an explicit override', async () => {
  const { root, library } = await fixture();
  const profile = join(root, 'profile'); await mkdir(profile);
  await saveLibraryLocation(join(profile, 'library'), process.platform === 'win32' ? library.directory.toUpperCase() : library.directory);
  const service = await startAiApi(library);
  try {
    const output = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['ai/cli.cjs', 'call', 'app.status'], { cwd: process.cwd(), env: { ...process.env, PAPER_TIMELINE_DATA: profile }, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    const result = JSON.parse(output);
    assert.equal(result.ok, true); assert.equal(result.result.total, 1);
    assert.equal(result.result.storagePath, library.directory);
  } finally { await service.close(); }
});
