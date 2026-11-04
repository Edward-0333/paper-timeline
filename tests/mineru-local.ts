// Explicit, opt-in real model validation; not run by the offline unit suite.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Library } from '../electron/library';
import { LocalMineru } from '../electron/mineru';
import { localMetadata } from '../electron/metadata';
await mkdir('.test-data', { recursive: true });
const root = await mkdtemp(resolve('.test-data/mineru-real-'));
const pdf = { title: 'Real MinerU basic model validation', authors: [], year: 2025, pageCount: 1, firstPageText: 'fixture', doi: '', arxivId: '', abstract: '' };
const library = new Library(join(root, 'library'), async () => pdf, async () => ({ metadata: localMetadata(pdf), matched: true, message: '' }));
await library.initialize();
const sources = resolve('../pdf'), source = join(sources, (await readdir(sources)).find(n => n.includes('Learning Based MPC'))!);
const imported = await library.importPaths([source]); await library.whenIdle(); const id = imported.paperIds![0];
const mineru = new LocalMineru(resolve('.cache/mineru-validation'), [resolve('.')]); library.startMineru(mineru);
console.log('Environment:', await mineru.environment()); await library.convertPdf(id, 'basic');
const timer = setInterval(() => console.log('Real MinerU conversion still running:', root), 30000);
try {
  await library.whenIdle(); const state = await library.conversionState(id); console.log(JSON.stringify(state, null, 2));
  assert.equal(state.status, 'succeeded', state.message);
  const md = await readFile(await library.conversionPath(id, 'markdown'), 'utf8'); assert.ok(md.length > 2000); assert.ok(state.result!.images > 0);
  console.log(JSON.stringify({ root, characters: md.length, images: state.result!.images, result: 'passed' }));
} finally { clearInterval(timer); await library.stopConversions(); }
