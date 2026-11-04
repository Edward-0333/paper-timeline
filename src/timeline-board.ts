import type { Paper, TimelineTrack } from '../shared/types';
import { timelinePapers } from '../shared/timelines';
import { layoutTimeline, type CardSize, type TimelineLayout } from './timeline-layout';

export interface TimelineLaneLayout {
  track: TimelineTrack;
  papers: Paper[];
  layout: TimelineLayout;
  x: number;
  y: number;
  filterTop: number;
  filterWidth: number;
  contentOffsetX: number;
}
/** The filter box is the fixed anchor, even when filtering changes card heights. */
export function layoutTimelineBoard(papers: Paper[], tracks: TimelineTrack[], sizes?: ReadonlyMap<string, CardSize>, filterSizes?: ReadonlyMap<string, CardSize>) {
  const lanes: TimelineLaneLayout[] = tracks.map(track => {
    const matches = timelinePapers(papers, track);
    const layout = matches.length ? layoutTimeline(matches, sizes) : {
      nodes: [], undated: [], width: track.configured ? 640 : 176, height: 110,
      axisY: 45, axisEnd: 0, undatedY: 76,
    };
    const measured = filterSizes?.get(track.id);
    const hasTags = track.configured && track.tags.length > 0;
    const filterWidth = measured && Number.isFinite(measured.width) && measured.width > 0 ? measured.width : hasTags ? 144 : 112;
    const filterHeight = measured && Number.isFinite(measured.height) && measured.height > 0 ? measured.height : hasTags ? 41 + track.tags.length * 27 : 50;
    const nodes = [...layout.nodes, ...layout.undated];
    // A tall tag legend needs its own column, including room for paper badges.
    const contentOffsetX = hasTags && nodes.length ? Math.max(0, 32 + filterWidth + 24 - Math.min(...nodes.map(node => node.x))) : 0;
    if (contentOffsetX) {
      for (const node of nodes) { node.x += contentOffsetX; node.anchorX += contentOffsetX; }
      if (layout.axisEnd) layout.axisEnd += contentOffsetX;
      layout.width += contentOffsetX;
    }
    const filterTop = layout.nodes.length ? layout.axisY - filterHeight / 2 : 20;
    layout.width = Math.max(layout.width, 32 + filterWidth + 32, !matches.length && track.configured ? filterWidth + 496 : 0);
    layout.height = Math.max(layout.height, filterTop + filterHeight + 40);
    return { track, papers: matches, layout, filterTop, filterWidth, contentOffsetX, x: track.position.x - 32, y: track.position.y - filterTop };
  });
  const left = Math.min(0, ...lanes.map(lane => lane.x));
  const top = Math.min(0, ...lanes.map(lane => Math.min(lane.y, lane.track.position.y - 28)));
  const right = Math.max(left + (lanes.length ? 240 : 760), ...lanes.map(lane => lane.x + lane.layout.width));
  const bottom = Math.max(top + (lanes.length ? 160 : 400), ...lanes.map(lane => lane.y + lane.layout.height));
  return { lanes, left, top, right, bottom, width: right - left, height: bottom - top };
}
