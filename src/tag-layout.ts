import type { PaperTagPosition } from '../shared/types';

export interface TagSize { width: number; height: number }
export interface TagBox extends TagSize { x: number; y: number }
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const sides: PaperTagPosition['side'][] = ['bottom', 'top', 'right', 'left'];

/** Positions are relative to the paper frame, with one shared border pixel. */
export function tagBox(body: TagSize, tag: TagSize, position: PaperTagPosition): TagBox {
  const x = Math.max(0, body.width - tag.width) * clamp(position.offset);
  const y = Math.max(0, body.height - tag.height) * clamp(position.offset);
  switch (position.side) {
    case 'top': return { ...tag, x, y: 1 - tag.height };
    case 'bottom': return { ...tag, x, y: body.height - 1 };
    case 'left': return { ...tag, x: 1 - tag.width, y };
    case 'right': return { ...tag, x: body.width - 1, y };
  }
}

/** Project the dragged label's center onto the four legal edge paths. */
export function closestTagPosition(body: TagSize, tag: TagSize, point: { x: number; y: number }, preferredSide: PaperTagPosition['side']): PaperTagPosition {
  const candidates = [preferredSide, ...sides.filter(side => side !== preferredSide)];
  let best: PaperTagPosition = { side: preferredSide, offset: 0.5 }, distance = Infinity;
  for (const side of candidates) {
    const horizontal = side === 'top' || side === 'bottom';
    const room = horizontal ? body.width - tag.width : body.height - tag.height;
    const offset = room > 0 ? clamp(((horizontal ? point.x : point.y) - (horizontal ? tag.width : tag.height) / 2) / room) : 0.5;
    const box = tagBox(body, tag, { side, offset });
    const next = (point.x - box.x - tag.width / 2) ** 2 + (point.y - box.y - tag.height / 2) ** 2;
    if (next < distance) { best = { side, offset }; distance = next; }
  }
  return best;
}

/** Put new labels together below the frame, using other edges when needed. */
export function defaultTagPositions(body: TagSize, tags: (TagSize & { id: string })[]): Map<string, PaperTagPosition> {
  const rows = sides.map(side => ({ side, used: 0, tags: [] as typeof tags }));
  for (const tag of tags) {
    const row = rows.find(row => {
      const horizontal = row.side === 'bottom' || row.side === 'top';
      return row.used + (row.tags.length ? 5 : 0) + (horizontal ? tag.width : tag.height) <= (horizontal ? body.width : body.height);
    }) ?? rows.reduce((a, b) => a.tags.length <= b.tags.length ? a : b);
    row.used += (row.tags.length ? 5 : 0) + (row.side === 'bottom' || row.side === 'top' ? tag.width : tag.height);
    row.tags.push(tag);
  }
  const positions = new Map<string, PaperTagPosition>();
  for (const row of rows) {
    const length = row.side === 'bottom' || row.side === 'top' ? body.width : body.height;
    let start = Math.max(0, (length - row.used) / 2);
    for (const tag of row.tags) {
      const size = row.side === 'bottom' || row.side === 'top' ? tag.width : tag.height;
      positions.set(tag.id, { side: row.side, offset: length > size ? clamp(start / (length - size)) : 0.5 });
      start += size + 5;
    }
  }
  return positions;
}

export function tagBounds(body: TagSize, boxes: TagBox[]) {
  const left = Math.min(0, ...boxes.map(box => box.x)), top = Math.min(0, ...boxes.map(box => box.y));
  const right = Math.max(body.width, ...boxes.map(box => box.x + box.width));
  const bottom = Math.max(body.height, ...boxes.map(box => box.y + box.height));
  return { x: -left, y: -top, width: right - left, height: bottom - top };
}

/** Reserve every possible edge position so moving a label cannot reflow the paper or canvas. */
export function tagEnvelope(body: TagSize, tags: TagSize[]) {
  const x = Math.max(0, ...tags.map(tag => tag.width - 1));
  const y = Math.max(0, ...tags.map(tag => tag.height - 1));
  return { x, y, width: body.width + x * 2, height: body.height + y * 2 };
}
