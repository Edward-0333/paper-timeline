import { parentPort, workerData } from 'node:worker_threads';
import { extractPdf } from './pdf';
extractPdf(workerData.path, workerData.fileName).then(
  value => parentPort?.postMessage({ ok: true, value }),
  error => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }),
);
