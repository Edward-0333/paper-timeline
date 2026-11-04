import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';

/** No network input: PDF is resolved and checked by the main process. */
export async function renderPdfPage(path: string, pageNumber: number) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  const task = getDocument({ data: new Uint8Array(await readFile(path)), useSystemFonts: true, verbosity: 0 });
  try {
    const document = await task.promise;
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) throw new Error('page-range');
    const page = await document.getPage(pageNumber), initial = page.getViewport({ scale: 1 });
    const scale = Math.min(1.7, 1800 / Math.max(initial.width, initial.height));
    const viewport = page.getViewport({ scale });
    if (!Number.isFinite(viewport.width * viewport.height) || viewport.width * viewport.height > 4_000_000) throw new Error('page-size');
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas: canvas as never, canvasContext: canvas.getContext('2d') as never, viewport }).promise;
    return { data: canvas.toBuffer('image/png'), pages: document.numPages };
  } finally { await task.destroy(); }
}
if (parentPort) void renderPdfPage(workerData.path, workerData.page).then(
  result => parentPort!.postMessage({ ok: true, ...result }),
  () => parentPort!.postMessage({ ok: false }),
);
