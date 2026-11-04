import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Library, readStoredLibrary } from '../electron/library';
import { localMetadata } from '../electron/metadata';
import { createDispatcher } from '../electron/ai-api';
import { inspectStorageSelection, prepareStorageChange } from '../electron/storage-settings';
import type { ExtractedPdf, MarkdownNote } from '../shared/types';

const pdf: ExtractedPdf = { title: 'Note fixture', authors: [], year: 2025, pageCount: 1, firstPageText: 'text', doi: '', arxivId: '', abstract: '' };
const extract = async () => pdf;
const lookup = async () => ({ metadata: localMetadata(pdf), matched: true, message: '' });
async function fixture() {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(resolve('.test-data/notes-'));
  const library = new Library(join(root, 'library'), extract, lookup);
  await library.initialize();
  const file = join(root, 'paper.pdf'); await writeFile(file, '%PDF-notes');
  await library.importPaths([file]); await library.whenIdle();
  const id = library.list()[0].id, source = join(root, '中文笔记.md');
  await writeFile(source, '\uFEFF---\r\ntitle: 笔记\r\n---\r\n# 摘要\r\n原文内容\r\n');
  return { root, library, id, source, call: createDispatcher(library) };
}

test('Markdown API copies exact bytes, survives source removal/restart, and preserves edits on duplicate import', async () => {
  const { root, library, id, source, call } = await fixture();
  assert.deepEqual(await call('notes.get', { id }), { note: null, path: null });
  const original = library.get(id), originalStatus = original.status, originalSource = original.source;
  const note = await call('notes.attach', { id, path: source }) as MarkdownNote;
  assert.equal(note.fileName, '中文笔记.md');
  const path = await library.markdownPath(id);
  assert.equal(path, join(library.directory, 'papers', library.get(id).storageFolder!, 'notes.md'));
  assert.deepEqual(await readFile(path), await readFile(source));
  await writeFile(path, '# 用户在库中编辑');
  assert.deepEqual(await call('notes.attach', { id, path: source }), note);
  assert.equal(await readFile(path, 'utf8'), '# 用户在库中编辑');
  await writeFile(source, '# 不同的来源内容');
  await assert.rejects(call('notes.attach', { id, path: source }), /已有笔记/);
  await unlink(source);
  const record = { source: '文献阅读.xlsx / Read 第 4 行', fields: [{ label: '重要性', value: '★★★★★' }, { label: '概述', value: '原始摘要\n第二行' }] };
  await call('papers.setReadingRecord', { id, record });
  assert.equal(library.get(id).status, originalStatus); assert.equal(library.get(id).source, originalSource);
  const reloaded = new Library(library.directory, extract, lookup); await reloaded.initialize();
  assert.deepEqual(reloaded.get(id).markdownNote, note); assert.deepEqual(reloaded.get(id).readingRecord, record);
  assert.equal(await readFile(await reloaded.markdownPath(id), 'utf8'), '# 用户在库中编辑');
  await library.retry(id); await library.whenIdle();
  assert.deepEqual(library.get(id).readingRecord, record); assert.deepEqual(library.get(id).markdownNote, note);
  const target = join(root, 'copied'); await mkdir(target);
  await prepareStorageChange(library, library.directory, 'copy', target);
  // Relocation must resolve the new root, not the source library or Obsidian path.
  await rename(library.directory, join(root, 'old-location'));
  const copied = new Library(target, extract, lookup); await copied.initialize();
  assert.equal(await readFile(await copied.markdownPath(id), 'utf8'), '# 用户在库中编辑');
  assert.deepEqual(copied.get(id).readingRecord, record);
  assert.equal((await inspectStorageSelection('open', target)).paperCount, 1);
});

test('bad extensions, relative paths, binary/oversize text and invalid records leave the library unchanged', async () => {
  const { root, library, source, id, call } = await fixture();
  const before = await readFile(library.file);
  await assert.rejects(call('notes.attach', { id, path: 'relative.md' }), /绝对路径/);
  await assert.rejects(call('notes.attach', { id, path: join(root, 'paper.pdf') }), /Markdown/);
  for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from('text\0binary'), Buffer.alloc(10 * 1024 * 1024 + 1, 'x')]) {
    await writeFile(source, bytes); await assert.rejects(library.attachMarkdown(id, source));
  }
  await assert.rejects(call('papers.setReadingRecord', { id, record: { source: 'Sheet', fields: [] } }));
  await assert.rejects(call('papers.setReadingRecord', { id, record: { source: ' ', fields: [{ label: 'x', value: 'y' }] } }));
  await assert.rejects(call('notes.attach', { id: 'a'.repeat(64), path: source }), { code: 'NOT_FOUND' });
  assert.deepEqual(await readFile(library.file), before);
});

test('failed saves roll back the attachment; locked storage rejects attachment writes', async () => {
  const { library, id, source } = await fixture();
  const originalPersist = (library as any).persist;
  (library as any).persist = async () => { throw new Error('disk full'); };
  await assert.rejects(library.attachMarkdown(id, source), /disk full/);
  assert.equal(library.get(id).markdownNote, undefined);
  await assert.rejects(readFile(join(library.directory, 'papers', library.get(id).storageFolder!, 'notes.md')), { code: 'ENOENT' });
  (library as any).persist = originalPersist;
  await library.attachMarkdown(id, source);
  const unlock = await library.lockForStorageChange();
  await assert.rejects(library.attachMarkdown(id, source), /切换/);
  unlock(); await library.attachMarkdown(id, source);
});

test('missing or invalid stored notes block opening/copying without leaving a partial destination', async () => {
  const { root, library, id, source } = await fixture();
  await library.attachMarkdown(id, source);
  await unlink(await library.markdownPath(id));
  await assert.rejects(library.markdownPath(id), /丢失/);
  await assert.rejects(inspectStorageSelection('open', library.directory), /缺少 Markdown/);
  const target = join(root, 'target'); await mkdir(target);
  await assert.rejects(prepareStorageChange(library, library.directory, 'copy', target), /丢失/);
  assert.deepEqual(await readdir(target), []);
  const stored = JSON.parse(await readFile(library.file, 'utf8'));
  stored.papers[0].markdownNote.fileName = '../unsafe.md';
  await writeFile(library.file, JSON.stringify(stored));
  await assert.rejects(readStoredLibrary(library.directory), /笔记信息异常/);
});

test('internal Markdown saves exact UTF-8 with a recoverable backup without changing import identity or library metadata', async () => {
  const { library, id, source } = await fixture();
  await library.attachMarkdown(id, source);
  const index = await readFile(library.file), original = await readFile(source), metadata = structuredClone(library.get(id));
  const document = await library.getMarkdownDocument(id);
  assert.equal(document.content, original.toString('utf8'));
  assert.equal(document.fileName, '中文笔记.md');
  assert.equal(document.path, await library.markdownPath(id));
  assert.match(document.revision, /^[a-f0-9]{64}$/);
  const content = document.content + '\r\n## 新的分析\r\n中文、公式 $x^2$ 和 emoji 😀\r\n';
  const saved = await library.saveMarkdownDocument(id, { content, revision: document.revision });
  assert.equal(saved.content, content); assert.notEqual(saved.revision, document.revision);
  assert.deepEqual(await readFile(saved.path + '.bak'), original);
  assert.equal(await readFile(saved.path, 'utf8'), content);
  assert.deepEqual(await readFile(library.file), index); assert.deepEqual(library.get(id), metadata);
  // Reimport uses the original sourceHash and must never overwrite edits made inside the app.
  await library.attachMarkdown(id, source);
  assert.equal((await library.getMarkdownDocument(id)).content, content);
  const unlock = await library.lockForStorageChange();
  await assert.rejects(library.saveMarkdownDocument(id, { content: 'blocked', revision: saved.revision }), /切换/);
  unlock();
});

test('note compare-and-save serializes concurrent changes and retries a lost response idempotently', async () => {
  const { library, id, source } = await fixture(); await library.attachMarkdown(id, source);
  const first = await library.getMarkdownDocument(id);
  const changes = [first.content + '\nA', first.content + '\nB'];
  const results = await Promise.allSettled(changes.map(content => library.saveMarkdownDocument(id, { content, revision: first.revision })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const saved = await library.getMarkdownDocument(id), backup = await readFile(saved.path + '.bak');
  assert.equal(saved.content, changes[0]);
  const retry = await library.saveMarkdownDocument(id, { content: saved.content, revision: first.revision });
  assert.deepEqual(retry, saved); assert.deepEqual(await readFile(saved.path + '.bak'), backup);
  const fresh = new Library(library.directory, extract, lookup); await fresh.initialize();
  assert.deepEqual(await fresh.getMarkdownDocument(id), saved);
});

test('external note changes and failed backup publication preserve existing content and draft conflict revisions', async () => {
  const { library, id, source } = await fixture(); await library.attachMarkdown(id, source);
  const first = await library.getMarkdownDocument(id);
  const next = await library.saveMarkdownDocument(id, { content: '# saved', revision: first.revision });
  const backup = await readFile(first.path + '.bak');
  await writeFile(first.path, '# external edit');
  await assert.rejects(library.saveMarkdownDocument(id, { content: '# stale draft', revision: next.revision }), /外部修改/);
  assert.equal(await readFile(first.path, 'utf8'), '# external edit');
  assert.deepEqual(await readFile(first.path + '.bak'), backup);
  await unlink(first.path + '.bak'); await mkdir(first.path + '.bak');
  const external = await library.getMarkdownDocument(id);
  await assert.rejects(library.saveMarkdownDocument(id, { content: '# new draft', revision: external.revision }), /本地文件/);
  assert.equal(await readFile(first.path, 'utf8'), '# external edit');
  assert.deepEqual((await readdir(join(library.directory, 'papers', library.get(id).storageFolder!))).sort(), ['notes.md', 'notes.md.bak', 'original.pdf', 'paper-index.json']);
});

test('missing, invalid UTF-8, binary and oversized registered notes are never replaced by an editor save', async () => {
  const { library, id, source } = await fixture();
  await assert.rejects(library.getMarkdownDocument(id), /还没有/);
  await assert.rejects(library.saveMarkdownDocument(id, { content: '# new', revision: 'a'.repeat(64) }), /还没有/);
  await library.attachMarkdown(id, source); const document = await library.getMarkdownDocument(id);
  const before = await readFile(library.file);
  for (const bytes of [Buffer.from([0xff]), Buffer.from('text\0binary'), Buffer.alloc(10 * 1024 * 1024 + 1, 'x')]) {
    await writeFile(document.path, bytes);
    await assert.rejects(library.getMarkdownDocument(id));
    await assert.rejects(library.saveMarkdownDocument(id, { content: '# draft', revision: document.revision }));
    assert.deepEqual(await readFile(document.path), bytes);
  }
  await unlink(document.path);
  await assert.rejects(library.saveMarkdownDocument(id, { content: '# draft', revision: document.revision }), /丢失/);
  await assert.rejects(readFile(document.path), { code: 'ENOENT' });
  assert.deepEqual(await readFile(library.file), before);
});

test('editor rejects linked notes, linked backups, linked parent directories and invalid update payloads', async () => {
  const { root, library, id, source } = await fixture(); await library.attachMarkdown(id, source);
  const document = await library.getMarkdownDocument(id), original = await readFile(document.path);
  const invalid = [null, {}, { content: '# note', revision: '../' }, { content: 'text\0binary', revision: document.revision },
    { content: '\ud800', revision: document.revision }, { content: '\udc00', revision: document.revision },
    { content: 'é'.repeat(6 * 1024 * 1024), revision: document.revision },
    { content: 'ok', revision: document.revision, path: source }];
  for (const update of invalid) await assert.rejects(library.saveMarkdownDocument(id, update as any));
  assert.deepEqual(await readFile(document.path), original);
  const outside = join(root, 'outside.md'); await writeFile(outside, '# untouched');
  await link(outside, document.path + '.bak');
  await assert.rejects(library.saveMarkdownDocument(id, { content: '# edit', revision: document.revision }), /链接/);
  assert.equal(await readFile(outside, 'utf8'), '# untouched'); await unlink(document.path + '.bak');
  await unlink(document.path); await link(outside, document.path);
  await assert.rejects(library.getMarkdownDocument(id), /链接/); await unlink(document.path); await writeFile(document.path, original);
  const folder = join(library.directory, 'papers', library.get(id).storageFolder!), moved = join(root, 'moved');
  await rename(folder, moved); await symlink(moved, folder, 'junction');
  await assert.rejects(library.getMarkdownDocument(id), /链接/);
  await assert.rejects(library.saveMarkdownDocument(id, { content: '# edit', revision: document.revision }), /链接/);
  assert.deepEqual(await readFile(join(moved, 'notes.md')), original);
});
