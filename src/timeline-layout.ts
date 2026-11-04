import { publicationDateOf } from '../shared/publication-date';
import type { Paper } from '../shared/types';

export const CARD_WIDTH = 268;
export const CARD_HEIGHT = 150;
export const AXIS_Y = 300;
export interface CardSize { width: number; height: number; frame?: { x: number; y: number; width: number; height: number } }
export interface TimelineNode extends CardSize { paper: Paper; date: string; x: number; y: number; anchorX: number; above: boolean }
export interface TimelineLayout { nodes: TimelineNode[]; undated: TimelineNode[]; width: number; height: number; axisY: number; axisEnd: number; undatedY: number }

const CARD_GAP = 24;
const AXIS_GAP = 66;
const MIN_ANCHOR_GAP = 104;

function measuredSize(paper: Paper, sizes?: ReadonlyMap<string, CardSize>): CardSize {
  const size = sizes?.get(paper.id);
  return {
    ...(size?.frame ? { frame: size.frame } : {}),
    width: size && Number.isFinite(size.width) && size.width > 0 ? size.width : CARD_WIDTH,
    height: size && Number.isFinite(size.height) && size.height > 0 ? size.height : CARD_HEIGHT,
  };
}

function compareDates(a: Paper, b: Paper) {
  const parts = (paper: Paper) => {
    const [year, month = 13, day = 32] = publicationDateOf(paper).split('-').map(Number);
    return [year, month, day];
  };
  const left = parts(a), right = parts(b);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
    || a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id);
}

/** Ordered spacing keeps cards readable; distances do not encode elapsed duration. */
export function layoutTimeline(papers: Paper[], sizes?: ReadonlyMap<string, CardSize>): TimelineLayout {
  const dated = papers.filter(paper => publicationDateOf(paper)).sort(compareDates);
  const unknown = papers.filter(paper => !publicationDateOf(paper)).sort((a, b) => a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id));
  const datedSizes = dated.map(paper => measuredSize(paper, sizes));
  const tallestAbove = datedSizes.reduce((height, size, index) => index % 2 === 0 ? Math.max(height, size.height) : height, 0);
  const axisY = Math.max(AXIS_Y, tallestAbove + AXIS_GAP + 84);
  const rowRight = [70 - CARD_GAP, 70 - CARD_GAP];
  let anchorX = 254;
  let previousYear = '';
  const nodes = dated.map((paper, index) => {
    const date = publicationDateOf(paper), year = date.slice(0, 4);
    const size = datedSizes[index];
    if (index) anchorX += MIN_ANCHOR_GAP;
    if (previousYear && previousYear !== year) anchorX += 84;
    const above = index % 2 === 0;
    const offset = above ? 22 : -22;
    const row = index % 2;
    const x = Math.max(anchorX - size.width / 2 + offset, rowRight[row] + CARD_GAP);
    anchorX = x + size.width / 2 - offset;
    rowRight[row] = x + size.width;
    const node = { paper, date, ...size, anchorX, above, x, y: above ? axisY - AXIS_GAP - size.height : axisY + AXIS_GAP };
    previousYear = year;
    return node;
  });
  const axisEnd = nodes.length ? Math.max(...rowRight, nodes.at(-1)!.anchorX) + 80 : 0;
  const datedBottom = nodes.reduce((bottom, node) => Math.max(bottom, node.y + node.height), axisY + 32);
  const undatedY = nodes.length ? datedBottom + 92 : 76;
  let undatedX = 70;
  let undatedBottom = 0;
  const undated = unknown.map(paper => {
    const size = measuredSize(paper, sizes);
    const node = { paper, date: '', ...size, x: undatedX, y: undatedY + 54, anchorX: 0, above: false };
    undatedX += size.width + CARD_GAP;
    undatedBottom = Math.max(undatedBottom, node.y + node.height);
    return node;
  });
  return { nodes, undated, axisY, axisEnd, undatedY,
    width: Math.max(760, axisEnd + 32, undated.length ? undatedX - CARD_GAP + 70 : 0),
    height: undated.length ? undatedBottom + 64 : Math.max(588, datedBottom + 72),
  };
}
