import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { extractPdf } from '../electron/pdf';
import { lookupMetadata } from '../electron/metadata';
const directory = resolve('../pdf');
const results: unknown[] = [];
await mkdir('test-results', { recursive: true });
for (const [index, file] of (await readdir(directory)).filter(p => /\.pdf$/i.test(p)).entries()) {
  const started = Date.now();
  const pdf = await extractPdf(join(directory, file), file);
  assert.ok(pdf.title.length > 12);
  assert.ok(pdf.pageCount > 0);
  if (pdf.thumbnail) await writeFile(`test-results/page-${index + 1}.png`, Buffer.from(pdf.thumbnail.split(',')[1], 'base64'));
  console.log(JSON.stringify({ file, title: pdf.title, doi: pdf.doi, arxivId: pdf.arxivId, authors: pdf.authors, text: pdf.firstPageText.slice(0, 550) }, null, 2));
  const result = process.argv.includes('--extract-only') ? null : await lookupMetadata(pdf);
  if (result) console.log(JSON.stringify({ matched: result.matched, message: result.message, metadata: result.metadata, ms: Date.now() - started }, null, 2));
  results.push({ file, extracted: { ...pdf, thumbnail: undefined }, result });
  await writeFile('test-results/sample-pdfs.json', JSON.stringify(results, null, 2));
}
console.log(`Checked ${results.length} sample PDFs; report: test-results/sample-pdfs.json`);
