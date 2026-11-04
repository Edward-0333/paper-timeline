import test from 'node:test';
import assert from 'node:assert/strict';
import type { PaperTagPosition } from '../shared/types';
import { closestTagPosition, defaultTagPositions, tagBounds, tagBox, tagEnvelope, type TagBox, type TagSize } from '../src/tag-layout';

const sides: PaperTagPosition['side'][] = ['top', 'right', 'bottom', 'left'];
const body = { width: 300, height: 120 }, tag = { width: 80, height: 24 };
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} differs from ${expected}`);

function assertTouchesFrame(frame: TagSize, box: TagBox, side: PaperTagPosition['side']) {
  if (side === 'top') near(box.y + box.height, 1);
  if (side === 'bottom') near(box.y, frame.height - 1);
  if (side === 'left') near(box.x + box.width, 1);
  if (side === 'right') near(box.x, frame.width - 1);
  const overlapX = Math.min(frame.width, box.x + box.width) - Math.max(0, box.x);
  const overlapY = Math.min(frame.height, box.y + box.height) - Math.max(0, box.y);
  assert.ok(overlapX > 0 && overlapY > 0, 'the label must share a border pixel with the frame');
  assert.equal(Math.min(overlapX, overlapY), 1);
}

test('tags stay in contact with all four frame edges at both endpoints and intermediate offsets', () => {
  for (const side of sides) for (const offset of [0, 0.25, 0.5, 1]) {
    const box = tagBox(body, tag, { side, offset });
    assertTouchesFrame(body, box, side);
    assert.equal(box.width, tag.width); assert.equal(box.height, tag.height);
    if (side === 'top' || side === 'bottom') {
      near(box.x, 220 * offset);
      assert.ok(box.x >= 0 && box.x + box.width <= body.width);
    } else {
      near(box.y, 96 * offset);
      assert.ok(box.y >= 0 && box.y + box.height <= body.height);
    }
  }
});

test('out-of-range offsets clamp to the end of each edge without moving the label away from the border', () => {
  for (const side of sides) {
    assert.deepEqual(tagBox(body, tag, { side, offset: -12 }), tagBox(body, tag, { side, offset: 0 }));
    assert.deepEqual(tagBox(body, tag, { side, offset: 12 }), tagBox(body, tag, { side, offset: 1 }));
  }
});

test('dragged label centers project to the nearest legal edge and retain their along-edge position', () => {
  const probes = [
    { point: { x: 95, y: -300 }, expected: { side: 'top', offset: 0.25 } },
    { point: { x: 205, y: 400 }, expected: { side: 'bottom', offset: 0.75 } },
    { point: { x: -300, y: 36 }, expected: { side: 'left', offset: 0.25 } },
    { point: { x: 600, y: 84 }, expected: { side: 'right', offset: 0.75 } },
    { point: { x: -30, y: -300 }, expected: { side: 'top', offset: 0 } },
    { point: { x: 330, y: -300 }, expected: { side: 'top', offset: 1 } },
  ] as const;
  for (const { point, expected } of probes) {
    const actual = closestTagPosition(body, tag, point, 'bottom');
    assert.equal(actual.side, expected.side); near(actual.offset, expected.offset);
    assertTouchesFrame(body, tagBox(body, tag, actual), actual.side);
  }
  for (const side of sides) for (const offset of [0, 0.3, 1]) {
    const box = tagBox(body, tag, { side, offset });
    const actual = closestTagPosition(body, tag, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 'bottom');
    assert.equal(actual.side, side); near(actual.offset, offset);
  }
});

test('equal-distance edge choices keep the preferred edge instead of flickering at ties', () => {
  const frame = { width: 100, height: 100 }, square = { width: 20, height: 20 };
  for (const side of sides) assert.deepEqual(closestTagPosition(frame, square, { x: 50, y: 50 }, side), { side, offset: 0.5 });
  assert.deepEqual(closestTagPosition(body, tag, { x: 150, y: 60 }, 'top'), { side: 'top', offset: 0.5 });
  assert.deepEqual(closestTagPosition(body, tag, { x: 150, y: 60 }, 'bottom'), { side: 'bottom', offset: 0.5 });
});

test('oversized and exactly fitting tags remain finite and touching the frame', () => {
  for (const large of [{ width: 500, height: 24 }, { width: 80, height: 250 }, { width: 500, height: 250 }, body]) {
    for (const side of sides) for (const offset of [0, 0.5, 1]) {
      const box = tagBox(body, large, { side, offset });
      assert.ok(Object.values(box).every(Number.isFinite));
      assertTouchesFrame(body, box, side);
    }
    for (const point of [{ x: -500, y: -500 }, { x: 150, y: 60 }, { x: 800, y: 500 }]) {
      const position = closestTagPosition(body, large, point, 'bottom');
      assert.ok(Number.isFinite(position.offset) && position.offset >= 0 && position.offset <= 1);
      assertTouchesFrame(body, tagBox(body, large, position), position.side);
    }
    const defaults = defaultTagPositions(body, [{ id: 'large', ...large }]);
    const position = defaults.get('large')!;
    assert.ok(Number.isFinite(position.offset));
    assertTouchesFrame(body, tagBox(body, large, position), position.side);
  }
});

test('two new labels form a centered, non-overlapping group below the frame', () => {
  const tags = [{ id: 'first', width: 80, height: 24 }, { id: 'second', width: 100, height: 24 }];
  const before = structuredClone(tags), positions = defaultTagPositions(body, tags);
  const first = tagBox(body, tags[0], positions.get('first')!), second = tagBox(body, tags[1], positions.get('second')!);
  assert.equal(positions.get('first')!.side, 'bottom'); assert.equal(positions.get('second')!.side, 'bottom');
  assertTouchesFrame(body, first, 'bottom'); assertTouchesFrame(body, second, 'bottom');
  near(second.x - first.x - first.width, 5);
  near(first.x, body.width - second.x - second.width);
  assert.deepEqual(tags, before);
  assert.equal(defaultTagPositions(body, []).size, 0);
});

test('default placement uses other edges when the bottom is full and bounds contain the frame and every label', () => {
  const tags = Array.from({ length: 4 }, (_, index) => ({ id: String(index), width: 260, height: 80 }));
  const positions = defaultTagPositions(body, tags);
  assert.equal(new Set([...positions.values()].map(position => position.side)).size, 4);
  const boxes = tags.map(tag => {
    const position = positions.get(tag.id)!;
    const box = tagBox(body, tag, position);
    assertTouchesFrame(body, box, position.side);
    return box;
  });
  const bounds = tagBounds(body, boxes);
  assert.deepEqual(bounds, { x: 259, y: 79, width: 818, height: 278 });
  for (const box of [{ x: 0, y: 0, ...body }, ...boxes]) {
    assert.ok(box.x + bounds.x >= 0 && box.y + bounds.y >= 0);
    assert.ok(box.x + bounds.x + box.width <= bounds.width);
    assert.ok(box.y + bounds.y + box.height <= bounds.height);
  }
  const empty = tagBounds(body, []);
  near(empty.x, 0); near(empty.y, 0);
  assert.equal(empty.width, body.width); assert.equal(empty.height, body.height);
});

test('the fixed tag envelope contains every legal position on all four borders', () => {
  const tags = [tag, { width: 140, height: 42 }, { width: 500, height: 250 }];
  const envelope = tagEnvelope(body, tags);
  assert.deepEqual(envelope, { x: 499, y: 249, width: 1298, height: 618 });
  for (const size of tags) for (const side of sides) for (const offset of [0, 0.1, 0.25, 0.5, 0.9, 1]) {
    const box = tagBox(body, size, { side, offset });
    assertTouchesFrame(body, box, side);
    assert.ok(box.x + envelope.x >= 0 && box.y + envelope.y >= 0);
    assert.ok(box.x + envelope.x + box.width <= envelope.width);
    assert.ok(box.y + envelope.y + box.height <= envelope.height);
  }
});

test('papers without labels keep their exact original frame size and origin', () => {
  for (const frame of [body, { width: 220, height: 68 }, { width: 360, height: 500 }]) {
    assert.deepEqual(tagEnvelope(frame, []), { x: 0, y: 0, ...frame });
  }
});

test('moving labels across sides or saving their positions never changes the layout envelope', () => {
  const sizes = [tag, { width: 140, height: 42 }];
  const initial = tagEnvelope(body, sizes.map(size => tagBox(body, size, { side: 'bottom', offset: 0.5 })));
  assert.deepEqual(initial, { x: 139, y: 41, width: 578, height: 202 });
  for (const side of sides) for (const offset of [0, 0.25, 0.5, 0.75, 1]) {
    const boxes = sizes.map((size, index) => tagBox(body, size, { side, offset: index ? 1 - offset : offset }));
    assert.deepEqual(tagEnvelope(body, boxes), initial, 'dragging must not change the frame origin or reserved size');
    assert.deepEqual(tagEnvelope(body, JSON.parse(JSON.stringify(boxes))), initial, 'restored positions must reserve the same space');
  }
});
