import test from 'node:test';
import assert from 'node:assert/strict';
import { AXIS_Y, CARD_HEIGHT, CARD_WIDTH, layoutTimeline, type CardSize, type TimelineLayout } from '../src/timeline-layout';
import type { Paper } from '../shared/types';

const paper = (id: string, date: string, year: number | null = Number(date.slice(0, 4)) || null): Paper => ({ id, title: id, publicationDate: date, year,
  authors: [], venue: '', doi: '', arxivId: '', abstract: '', url: '', source: 'PDF', matchMethod: '', fileName: `${id}.pdf`, fileSize: 20, pageCount: 1, status: 'matched', message: '', importedAt: '2026-09-18T00:00:00Z' });

function assertSeparatedAndContained(layout: TimelineLayout) {
  const all = [...layout.nodes, ...layout.undated];
  for (const node of all) {
    assert.ok(node.x >= 0 && node.y >= 0 && node.x + node.width <= layout.width && node.y + node.height <= layout.height,
      `card ${node.paper.id} outside scene`);
    if (node.date) {
      assert.equal(node.above ? layout.axisY - node.y - node.height : node.y - layout.axisY, 66);
      assert.ok(node.anchorX < layout.axisEnd);
      assert.ok(node.x + node.width < layout.axisEnd);
    }
  }
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    const overlap = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    assert.equal(overlap, false, `overlapping cards ${a.paper.id} and ${b.paper.id}`);
  }
  for (let i = 1; i < layout.nodes.length; i++) {
    assert.ok(layout.nodes[i].anchorX - layout.nodes[i - 1].anchorX >= 104);
  }
  if (layout.nodes.length && layout.undated.length) {
    assert.ok(layout.undatedY > Math.max(...layout.nodes.map(node => node.y + node.height)));
  }
}

test('map progresses left to right by publication date and separates undated papers', () => {
  const input = [paper('unknown', ''), paper('year-only', '2025'), paper('latest', '2026-01-08'), paper('month-only', '2025-04'), paper('tie-b', '2025-04-02'), paper('tie-a', '2025-04-02'), paper('earliest', '', 2024)];
  const before = [...input];
  const layout = layoutTimeline(input);
  assert.deepEqual(layout.nodes.map(n => n.paper.id), ['earliest', 'tie-a', 'tie-b', 'month-only', 'year-only', 'latest']);
  assert.deepEqual(layout.undated.map(n => n.paper.id), ['unknown']);
  assert.equal(layout.nodes[0].date, '2024');
  assert.equal(layout.undated[0].date, '');
  assert.deepEqual(input, before);
  assert.ok(layout.undated[0].y > Math.max(...layout.nodes.map(n => n.y + n.height)));
  for (let i = 1; i < layout.nodes.length; i++) assert.ok(layout.nodes[i].anchorX > layout.nodes[i - 1].anchorX);
  assertSeparatedAndContained(layout);
});

test('dense dates and large year gaps keep cards separate before their first measurement', () => {
  const input = Array.from({ length: 60 }, (_, i) => ({ ...paper(String(i).padStart(3, '0'), i < 25 ? '2025-04-02' : i < 45 ? '2025' : i < 50 ? '1900' : ''), title: 'A very long paper title '.repeat(30) + i }));
  const layout = layoutTimeline(input);
  const all = [...layout.nodes, ...layout.undated];
  assert.equal(all.length, 60);
  assert.ok(all.every(node => node.width === CARD_WIDTH && node.height === CARD_HEIGHT));
  assert.equal(layout.axisY, AXIS_Y);
  assertSeparatedAndContained(layout);
});

test('mixed measured widths and heights remain separate for dense same-day papers', () => {
  const input = Array.from({ length: 60 }, (_, i) => paper(String(i).padStart(3, '0'), i < 48 ? '2025-04-02' : ''));
  const sizes = new Map<string, CardSize>(input.map((item, i) => [item.id, {
    width: [190, 360, 224, 310][i % 4],
    height: [96, 188, 122, 260, 340][i % 5],
  }]));
  const layout = layoutTimeline(input, sizes);
  assert.deepEqual(layout.nodes.map(node => node.paper.id), input.slice(0, 48).map(item => item.id));
  for (const node of [...layout.nodes, ...layout.undated]) {
    assert.equal(node.width, sizes.get(node.paper.id)!.width);
    assert.equal(node.height, sizes.get(node.paper.id)!.height);
  }
  assertSeparatedAndContained(layout);
});

test('very tall cards move the axis and undated section to preserve clearances', () => {
  const input = [paper('a', '2025-04-01'), paper('b', '2025-04-02'), paper('c', '2025-04-03'), paper('unknown', '')];
  const sizes = new Map<string, CardSize>([
    ['a', { width: 360, height: 1500 }], ['b', { width: 340, height: 1200 }],
    ['c', { width: 190, height: 96 }], ['unknown', { width: 360, height: 1800 }],
  ]);
  const layout = layoutTimeline(input, sizes);
  assert.ok(layout.axisY > AXIS_Y);
  assert.equal(layout.nodes[0].y, 84);
  assert.equal(layout.undatedY, layout.nodes[1].y + layout.nodes[1].height + 92);
  assertSeparatedAndContained(layout);
  assertSeparatedAndContained(layoutTimeline(input.slice(0, 3), sizes));
});

test('shorter measured cards also reduce horizontal spacing without mutating sizes', () => {
  const input = Array.from({ length: 12 }, (_, i) => paper(String(i).padStart(2, '0'), '2025-04-02'));
  const shortSizes = new Map(input.map(item => [item.id, { width: 190, height: 96 }]));
  const before = structuredClone(shortSizes);
  const compact = layoutTimeline(input, shortSizes);
  const long = layoutTimeline(input, new Map(input.map(item => [item.id, { width: 360, height: 220 }])));
  assert.ok(compact.width < long.width);
  assert.deepEqual(shortSizes, before);
  assertSeparatedAndContained(compact);
  assertSeparatedAndContained(long);
});

test('empty and undated-only libraries do not create dated axis nodes', () => {
  assert.deepEqual(layoutTimeline([]).nodes, []);
  const layout = layoutTimeline([paper('b', ''), paper('a', '')]);
  assert.equal(layout.axisEnd, 0); assert.deepEqual(layout.nodes, []);
  assert.deepEqual(layout.undated.map(n => n.paper.id), ['a', 'b']);
  assertSeparatedAndContained(layout);
});

test('undated-only papers accumulate actual widths and the tallest height determines scene bounds', () => {
  const input = [paper('c', ''), paper('a', ''), paper('b', '')];
  const sizes = new Map<string, CardSize>([
    ['a', { width: 190, height: 1100 }], ['b', { width: 360, height: 200 }], ['c', { width: 220, height: 96 }],
  ]);
  const layout = layoutTimeline(input, sizes);
  assert.deepEqual(layout.undated.map(node => node.x), [70, 284, 668]);
  assert.equal(layout.height, layout.undated[0].y + 1100 + 64);
  assertSeparatedAndContained(layout);
});

test('missing or zero measurements use a finite first-render size', () => {
  const input = [paper('a', '2025'), paper('b', '2026'), paper('unknown', '')];
  const sizes = new Map<string, CardSize>([['b', { width: 0, height: Number.NaN }]]);
  const layout = layoutTimeline(input, sizes);
  for (const node of [...layout.nodes, ...layout.undated]) {
    assert.equal(node.width, CARD_WIDTH);
    assert.equal(node.height, CARD_HEIGHT);
  }
  assertSeparatedAndContained(layout);
});
