import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Library } from '../electron/library';
import { createDispatcher } from '../electron/ai-api';
import { localMetadata } from '../electron/metadata';
import { defaultTimelines, timelinePapers } from '../shared/timelines';
import { layoutTimelineBoard } from '../src/timeline-board';
import type { ExtractedPdf, Paper, TimelineTrack } from '../shared/types';

const pdf: ExtractedPdf = { title: 'Timeline test', authors: [], year: 2025, pageCount: 1, firstPageText: 'text', doi: '', arxivId: '', abstract: '' };
const makeLibrary = (directory: string) => new Library(directory, async () => pdf, async p => ({ metadata: localMetadata(p), matched: true, message: 'fixture' }));
async function setup() {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(resolve('.test-data/timelines-'));
  const library = makeLibrary(join(root, 'library'));
  await library.initialize();
  return { root, library, call: createDispatcher(library) };
}

test('legacy libraries migrate with one default track, and deleting all tracks survives restart', async () => {
  const { library } = await setup();
  const legacy = JSON.stringify({ version: 1, papers: [], folders: [] });
  await writeFile(library.file, legacy);
  const reopened = makeLibrary(library.directory); await reopened.initialize();
  assert.deepEqual(reopened.state().timelines, defaultTimelines());
  assert.equal(await readFile(join(library.directory, 'library.pre-paper-folders-v1.json'), 'utf8'), legacy);
  assert.equal(JSON.parse(await readFile(library.file, 'utf8')).version, 2);
  await reopened.deleteTimeline(reopened.state().timelines[0].id);
  const empty = makeLibrary(library.directory); await empty.initialize();
  assert.deepEqual(empty.state().timelines, []);
  const newTrack = await empty.createTimeline();
  assert.equal(newTrack.configured, false);
  assert.deepEqual(newTrack.position, { x: 32, y: 275 });
});

test('independent timeline API CRUD persists filters and positions while preserving papers and PDFs', async () => {
  const { root, library, call } = await setup();
  const file = join(root, 'fixture.pdf'); await writeFile(file, '%PDF-timeline fixture');
  await library.importPaths([file]); await library.whenIdle();
  const paper = library.list()[0]; await library.addTag(paper.id, '视觉', '#112233');
  const papersBefore = library.list(), pdfBefore = await readFile(library.pdfPath(paper.id));
  const original = library.state().timelines[0];
  const added = await call('timelines.create', { position: { x: -40, y: 900 } }) as TimelineTrack;
  assert.equal(added.configured, false);
  assert.deepEqual(timelinePapers(library.list(), added), []);
  await Promise.all([
    call('timelines.update', { id: added.id, changes: { tags: [' 视觉 ', 'NETWORK', 'network'], tagMode: 'any' } }),
    call('timelines.update', { id: added.id, changes: { position: { x: 300, y: -500 } } }),
  ]);
  const changed = library.getTimeline(added.id);
  assert.deepEqual(changed.tags, ['视觉', 'network']); assert.equal(changed.tagMode, 'any');
  assert.deepEqual(changed.position, { x: 300, y: -500 }); assert.equal(changed.configured, true);
  assert.equal(timelinePapers(library.list(), changed).length, 1);
  assert.deepEqual(library.getTimeline(original.id), original);
  const restarted = makeLibrary(library.directory); await restarted.initialize();
  assert.deepEqual(restarted.state().timelines, library.state().timelines);
  const response = await call('timelines.list') as { timelines: TimelineTrack[] };
  response.timelines[0].position.x = 999; assert.deepEqual(library.getTimeline(original.id), original);
  await call('timelines.delete', { id: added.id });
  assert.deepEqual(library.state().timelines, [original]);
  assert.deepEqual(library.list(), papersBefore); assert.deepEqual(await readFile(library.pdfPath(paper.id)), pdfBefore);
});

test('invalid timeline API inputs and unknown IDs fail before mutating storage', async () => {
  const { library, call } = await setup();
  const track = await library.createTimeline();
  const before = await readFile(library.file, 'utf8'); let changes = 0;
  library.on('changed', () => changes++);
  for (const input of [{}, { tags: [''] }, { tags: ['bad\ntext'] }, { tags: Array(101).fill('tag') },
    { tags: ['x'.repeat(81)] }, { tagMode: 'xor' }, { position: { x: 0 } }, { position: { x: null, y: 2 } },
    { position: { x: Infinity, y: 0 } }, { position: { x: 100001, y: 0 } }, { configured: true }, { tags: null }]) {
    await assert.rejects(call('timelines.update', { id: track.id, changes: input }), { code: 'INVALID_ARGUMENT' });
  }
  for (const position of [null, { x: NaN, y: 0 }, { x: 0, y: 0, z: 0 }]) {
    await assert.rejects(call('timelines.create', { position }), { code: 'INVALID_ARGUMENT' });
  }
  const missing = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  await assert.rejects(call('timelines.update', { id: missing, changes: { tags: [] } }), { code: 'NOT_FOUND' });
  await assert.rejects(call('timelines.delete', { id: missing }), { code: 'NOT_FOUND' });
  assert.equal(changes, 0); assert.equal(await readFile(library.file, 'utf8'), before);
});

test('failed timeline saves roll back create, update and delete without change events', async () => {
  const { library } = await setup(); const track = await library.createTimeline();
  const before = library.state(), stored = await readFile(library.file, 'utf8');
  let events = 0; library.on('changed', () => events++);
  await mkdir(library.file + '.tmp');
  await assert.rejects(library.createTimeline());
  await assert.rejects(library.updateTimeline(track.id, { tags: ['视觉'], position: { x: 3, y: 4 } }));
  await assert.rejects(library.deleteTimeline(track.id));
  assert.deepEqual(library.state(), before); assert.equal(events, 0);
  assert.equal(await readFile(library.file, 'utf8'), stored);
});

test('malformed stored timelines fail safely instead of resetting saved views', async () => {
  const { library } = await setup();
  for (const timelines of [null, [defaultTimelines()[0], defaultTimelines()[0]], [{ ...defaultTimelines()[0], position: { x: 'bad', y: 0 } }]]) {
    const text = JSON.stringify({ version: 1, papers: [], timelines });
    await writeFile(library.file, text);
    await assert.rejects(makeLibrary(library.directory).initialize());
    assert.equal(await readFile(library.file, 'utf8'), text);
  }
});

const paper = (id: string, tags: string[], publicationDate = '2025'): Paper => ({ ...localMetadata(pdf), publicationDate,
  id, fileName: id + '.pdf', fileSize: 20, pageCount: 1, importedAt: '', status: 'matched', message: '',
  year: publicationDate ? 2025 : null, tags: tags.map((text, i) => ({ id: id + i, text, color: '#ABCDEF' })) });

test('each lane matches independently, may share a paper, and keeps its filter anchor when content changes', () => {
  const papers = [paper('both', ['视觉', '网络']), paper('vision', ['视觉']), paper('network', ['网络']), paper('unknown', ['无日期'], '')];
  const first = { ...defaultTimelines()[0], tags: ['视觉'], position: { x: 80, y: 300 } };
  const second: TimelineTrack = { ...first, id: 'second', tags: ['网络'], position: { x: -200, y: 1000 } };
  const initial = layoutTimelineBoard(papers, [first, second]);
  assert.deepEqual(initial.lanes.map(lane => lane.papers.map(p => p.id)), [['both', 'vision'], ['both', 'network']]);
  const enlarged = layoutTimelineBoard(papers, [{ ...first, tags: ['视觉', '网络'], tagMode: 'all' }, second], new Map([['both', { width: 360, height: 1400 }]]));
  for (const lane of enlarged.lanes) {
    assert.equal(lane.x + 32, lane.track.position.x); assert.equal(lane.y + lane.filterTop, lane.track.position.y);
  }
  const moved = layoutTimelineBoard(papers, [{ ...first, position: { x: -450, y: -600 } }, second]);
  assert.deepEqual(moved.lanes[1], initial.lanes[1], 'moving one track must not move another');
  assert.equal(moved.lanes[0].x - initial.lanes[0].x, -530);
  assert.equal(moved.lanes[0].y - initial.lanes[0].y, -900);
  const filtered = layoutTimelineBoard(papers, [{ ...first, tags: ['missing'] }, second]);
  assert.deepEqual(filtered.lanes[1], initial.lanes[1], 'filtering one track must not relayout another');
  const undated = layoutTimelineBoard(papers, [{ ...first, tags: ['无日期'] }]).lanes[0];
  assert.equal(undated.layout.nodes.length, 0); assert.equal(undated.layout.undated.length, 1);
  const blank = layoutTimelineBoard(papers, [{ ...first, configured: false }]).lanes[0];
  assert.equal(blank.papers.length, 0); assert.equal(blank.layout.axisEnd, 0);
  for (const lane of moved.lanes) {
    assert.ok(lane.x >= moved.left && lane.y >= moved.top);
    assert.ok(lane.x + lane.layout.width <= moved.right && lane.y + lane.layout.height <= moved.bottom);
  }
});

test('a large selected-tag legend fits the board and reserves a separate column for papers', () => {
  const first = { ...defaultTimelines()[0], tags: ['视觉'], position: { x: -100, y: 300 } };
  const second = { ...first, id: 'second', position: { x: 30, y: 1800 } };
  const papers = [paper('dated', ['视觉']), paper('undated', ['视觉'], '')];
  const baseline = layoutTimelineBoard(papers, [first, second]);
  const enlarged = layoutTimelineBoard(papers, [first, second], undefined, new Map([[first.id, { width: 240, height: 1600 }]]));
  const lane = enlarged.lanes[0];
  assert.equal(lane.x + 32, first.position.x);
  assert.equal(lane.y + lane.filterTop, first.position.y);
  assert.equal(lane.layout.axisY - lane.filterTop, 800, 'the axis connects to the middle of the legend');
  for (const node of [...lane.layout.nodes, ...lane.layout.undated]) {
    assert.ok(node.x >= 32 + 240 + 24, 'paper bounds including badges must stay out of the legend column');
  }
  assert.ok(first.position.y + 1600 <= enlarged.bottom, 'fit must contain every selected label');
  assert.deepEqual(enlarged.lanes[1], baseline.lanes[1], 'resizing one legend must not move another timeline');
  assert.equal(baseline.lanes[0].filterWidth, 144, 'the fallback must not be mutated by measured layout');
});
