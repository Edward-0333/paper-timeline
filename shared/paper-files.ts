import type { Paper, PaperFileKind, PaperTag } from './types';

export type TimelinePaperTag = PaperTag & { fileKind?: PaperFileKind };
export function paperPdfHash(paper: Paper): string | null { return paper.pdfHash === undefined ? paper.id : paper.pdfHash; }

export function hasPaperFile(paper: Paper, kind: PaperFileKind): boolean {
  return paper.availableFiles?.[kind] ?? (kind === 'pdf' ? paperPdfHash(paper) !== null && /\.pdf$/i.test(paper.fileName) : !!paper.markdownNote);
}

/** File entries are derived from attachments, not editable/filterable category tags. */
export function paperFrameTags(paper: Paper): TimelinePaperTag[] {
  const tags: TimelinePaperTag[] = [...(paper.tags ?? [])];
  for (const kind of ['pdf', 'md'] as const) {
    if (hasPaperFile(paper, kind)) tags.push({ id: `file:${kind}`, text: kind.toUpperCase(),
      color: kind === 'pdf' ? '#FCE3E3' : '#EEE8F7', fileKind: kind, position: paper.fileTagPositions?.[kind] });
  }
  return tags;
}
