import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ExtractedPdf } from '../shared/types';

export const cleanText = (text: string) => text.replace(/<[^>]*>/g, '').replace(/\$?\^\{([^}]+)\}\$?/g, '$1').replace(/\u00ad/g, '').replace(/[\uFB00-\uFB04]/g, c => ({ 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl' }[c] || c)).replace(/\s+/g, ' ').trim();
export function filenameTitle(file: string) {
  return basename(file, '.pdf').replace(/^.*?\s+-\s+(?:(?:19|20)\d{2}\s+-\s+)?/, '').replace(/\$\^\{(.*?)\}\$/g, '$1').trim();
}
export function normalizeDoi(value: string) {
  return value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi\s*:\s*/i, '').replace(/[.,;]+$/, '').replace(/\)+$/, match => {
    const opens = (value.match(/\(/g) || []).length;
    const closes = (value.match(/\)/g) || []).length;
    return match.slice(0, Math.max(0, match.length - Math.max(0, closes - opens)));
  }).toLowerCase();
}
export function findIdentifiers(text: string) {
  const arxiv = text.match(/arxiv\s*:\s*(\d{4}\.\d{4,5}(?:v\d+)?|[a-z.-]+\/\d{7}(?:v\d+)?)/i)
    || text.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?|[a-z.-]+\/\d{7}(?:v\d+)?)/i);
  // Never search the bibliography: its identifiers belong to other papers.
  const ownText = text.split(/\b(?:References|Bibliography)\b/i)[0];
  const doi = ownText.match(/\b10\.\d{4,9}\/[A-Z0-9._;()/:+\-]+/i);
  return { doi: doi ? normalizeDoi(doi[0]) : '', arxivId: arxiv?.[1] || '' };
}
function validTitle(title: string) {
  return title.length > 12 && title.length < 500 && !/^(untitled|microsoft|latex|word|template|paper title|arxiv|acrobat|full page)/i.test(title) && !/\.pdf$/i.test(title);
}
export async function extractPdf(filePath: string, originalName = filePath): Promise<ExtractedPdf> {
  const data = new Uint8Array(await readFile(filePath));
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data, useSystemFonts: true, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const rawItems = content.items.filter((i): i is typeof i & { str: string; transform: number[]; height: number; width: number } => 'str' in i);
    const lines: { y: number; height: number; items: { x: number; str: string }[] }[] = [];
    for (const item of rawItems) {
      if (!item.str.trim() || Math.abs(item.transform[0]) < 0.1) continue;
      let line = lines.find(l => Math.abs(l.y - item.transform[5]) < 3);
      if (!line) { line = { y: item.transform[5], height: item.height, items: [] }; lines.push(line); }
      line.height = Math.max(line.height, item.height);
      line.items.push({ x: item.transform[4], str: item.str });
    }
    lines.sort((a, b) => b.y - a.y);
    const readable = lines.map(l => ({ ...l, text: cleanText(l.items.sort((a, b) => a.x - b.x).map(i => i.str).join(' ')) }));
    const firstPageText = readable.map(l => l.text).join('\n');
    const infoResult = await doc.getMetadata();
    const info = infoResult.info as Record<string, unknown>;
    const metaTitle = cleanText(String(info.Title || infoResult.metadata?.get('dc:title') || ''));
    const upper = readable.filter(l => l.y > page.view[3] * 0.55 && l.text.length > 5 && !/^(arxiv|https?:|preprint|published|accepted)/i.test(l.text));
    const maxHeight = Math.max(...upper.map(l => l.height));
    const titleLines = upper.filter(l => l.height >= maxHeight * 0.85);
    const layoutTitle = cleanText(titleLines.map(l => l.text).join(' '));
    const title = validTitle(metaTitle) ? metaTitle : validTitle(layoutTitle) ? layoutTitle : filenameTitle(originalName);
    const identifiers = findIdentifiers([String(info.Subject || ''), String(info.Keywords || ''), rawItems.map(i => i.str).join(' ')].join('\n'));
    const authorText = cleanText(String(info.Author || ''));
    const authors = authorText && !/^(anonymous|author|unknown|microsoft)/i.test(authorText) ? authorText.split(/\s*;\s*|\s+and\s+/).filter(Boolean) : [];
    const abstractItem = rawItems.find(item => /\bAbstract\b/i.test(item.str));
    const pageMiddle = (page.view[0] + page.view[2]) / 2;
    const twoColumns = abstractItem && rawItems.some(i => i.transform[4] > pageMiddle + 10 && i.transform[5] < abstractItem.transform[5] - 20 && i.transform[5] > abstractItem.transform[5] - 80);
    const abstractText = abstractItem ? readable.filter(l => l.y <= abstractItem.transform[5] + 4 && l.y > 70).map(l => cleanText(l.items.filter(i => !twoColumns || (abstractItem.transform[4] < pageMiddle ? i.x < pageMiddle : i.x >= pageMiddle)).map(i => i.str).join(' '))).join('\n') : firstPageText;
    const abstractMatch = abstractText.match(/\bAbstract\b\s*[—–:-]?\s*([\s\S]*?)(?=\n\s*(?:1[.\s]|I[.\s])\s*(?:Introduction|INTRODUCTION)|\n\s*(?:Index Terms|Keywords)|$)/i);
    const yearMatch = firstPageText.match(/(?:©|copyright|published|accepted)\s*.*?\b((?:19|20)\d{2})\b/i);
    let thumbnail: string | undefined;
    try {
      const { createCanvas } = await import('@napi-rs/canvas');
      const viewport = page.getViewport({ scale: 360 / page.view[2] });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas: canvas as never, canvasContext: canvas.getContext('2d') as never, viewport }).promise;
      thumbnail = canvas.toDataURL('image/png');
    } catch { /* Text import remains available if page rendering is unsupported. */ }
    return { title, authors, pageCount: doc.numPages, firstPageText, ...identifiers, abstract: abstractMatch ? cleanText(abstractMatch[1]).slice(0, 6000) : '', year: yearMatch ? Number(yearMatch[1]) : null, thumbnail };
  } finally { await task.destroy(); }
}
