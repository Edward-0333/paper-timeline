import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFile, rename, readFile, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { Library } from './library';
import type { Paper } from '../shared/types';
import { paperMatchesTags } from '../shared/paper-tags';
import { paperPdfHash } from '../shared/paper-files';
import capabilities from '../ai/capabilities.json';

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
const busy = (paper: Paper) => ['queued', 'extracting', 'searching'].includes(paper.status);
const paperData = ({ thumbnail: _thumbnail, ...paper }: Paper) => paper;

// Validate only the JSON Schema keywords used by the shared capability manifest.
// The same manifest documents and gates every public operation.
export function validateInput(schema: any, value: unknown, path = 'params'): void {
  const fail = () => { throw new ApiError('INVALID_ARGUMENT', `${path} 不符合能力清单中的参数格式`); };
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.includes(type) && !(types.includes('integer') && typeof value === 'number' && Number.isSafeInteger(value))) fail();
  if (schema.enum && !schema.enum.includes(value)) fail();
  if (typeof value === 'string' && ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) fail();
  if (typeof value === 'number' && (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) fail();
  if (Array.isArray(value)) {
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) fail();
    value.forEach((item, index) => validateInput(schema.items, item, `${path}[${index}]`));
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>, properties = schema.properties || {};
    if (schema.minProperties && Object.keys(record).length < schema.minProperties) fail();
    for (const key of schema.required || []) if (!Object.hasOwn(record, key)) fail();
    for (const [key, item] of Object.entries(record)) {
      if (!Object.hasOwn(properties, key)) fail();
      validateInput(properties[key], item, `${path}.${key}`);
    }
  }
}

export function createDispatcher(library: Library) {
  let writes: Promise<unknown> = Promise.resolve();
  const paper = (id: string) => {
    try { return library.get(id); } catch { throw new ApiError('NOT_FOUND', '找不到这篇文献', 404); }
  };
  const folderExists = (id: string | null | undefined) => {
    if (id != null && !library.state().folders.some(f => f.id === id)) throw new ApiError('NOT_FOUND', '找不到这个文件夹', 404);
  };
  const tagExists = (id: string, tagId: string) => {
    if (!paper(id).tags?.some(tag => tag.id === tagId)) throw new ApiError('NOT_FOUND', '找不到这个标签', 404);
  };
  const timelineExists = (id: string) => {
    try { library.getTimeline(id); } catch { throw new ApiError('NOT_FOUND', '找不到这条时间线', 404); }
  };
  const handlers: Record<string, (p: any) => unknown> = {
    'documents.environment': () => library.mineruEnvironment(),
    'documents.convert': p => { paper(p.id); return library.convertPdf(p.id, p.tier ?? 'basic'); },
    'documents.get': async p => {
      paper(p.id); const state = await library.conversionState(p.id);
      return { ...state, paths: state.result ? { markdown: await library.conversionPath(p.id, 'markdown'), json: await library.conversionPath(p.id, 'json'), directory: await library.conversionPath(p.id, 'directory') } : null };
    },
    'documents.cancel': p => { paper(p.id); return library.cancelConversion(p.id); },
    'timelines.list': () => ({ timelines: library.state().timelines }),
    'timelines.create': p => library.createTimeline(p.position),
    'timelines.update': p => { timelineExists(p.id); return library.updateTimeline(p.id, p.changes); },
    'timelines.delete': async p => { timelineExists(p.id); await library.deleteTimeline(p.id); return { id: p.id, deleted: true }; },
    'app.status': () => {
      const papers = library.list();
      return { storagePath: library.directory, aiIndex: library.aiIndexStatus(), total: papers.length, pending: papers.filter(busy).length,
        statuses: Object.fromEntries(['queued', 'extracting', 'searching', 'matched', 'review', 'error'].map(status => [status, papers.filter(p => p.status === status).length])) };
    },
    'papers.list': p => {
      if (p.tag !== undefined && p.tags !== undefined) throw new ApiError('INVALID_ARGUMENT', 'tag 与 tags 不能同时提供');
      if (p.tagMode !== undefined && p.tags === undefined) throw new ApiError('INVALID_ARGUMENT', 'tagMode 需要配合 tags 使用');
      folderExists(p.folderId);
      const query = (p.query || '').trim().toLowerCase();
      const papers = library.list().filter(item => (!query || [item.title, ...item.authors, item.doi, item.arxivId, item.venue].join(' ').toLowerCase().includes(query))
        && (!p.status || item.status === p.status) && (p.folderId === undefined || (item.folderId ?? null) === p.folderId)
        && paperMatchesTags(item, p.tags ?? (p.tag === undefined ? [] : [p.tag]), p.tagMode ?? 'all'));
      const offset = p.offset ?? 0, limit = p.limit ?? 50;
      return { total: papers.length, offset, limit, papers: papers.slice(offset, offset + limit).map(item => { const { abstract: _abstract, ...summary } = paperData(item); return summary; }) };
    },
    'papers.get': p => ({ ...paperData(paper(p.id)), directory: library.paperDirectory(p.id), indexPath: library.paperIndexPath(p.id), citationMonitor: library.citationState(p.id), availableFiles: library.fileAvailability(p.id), pdfPath: paperPdfHash(paper(p.id)) === null ? null : library.pdfPath(p.id) }),
    'library.refreshIndex': () => library.rebuildAiIndex(),
    'citations.setMonitoring': async p => { paper(p.id); await library.setCitationMonitoring(p.id, p.enabled); return { id: p.id, enabled: paper(p.id).citationMonitoring === true, state: library.citationState(p.id) }; },
    'citations.get': p => { paper(p.id); return library.getCitations(p.id, p.offset, p.limit); },
    'cloud.status': () => library.cloudStatus(),
    'cloud.diagnose': p => library.cloudDiagnose(p),
    'cloud.sync': () => library.cloudSync(),
    'cloud.review': p => library.cloudReview(p.offset),
    'cloud.reconcile': () => library.cloudReconcile(),
    'cloud.importLegacy': p => library.cloudImportLegacy(p.id, p.revision),
    'cloud.stopLegacy': p => library.cloudStopLegacy(p.id, p.revision),
    'papers.create': p => library.createPaper(p.fields, p.folderId ?? null, p.retrieve ?? true),
    'papers.attachPdf': async p => { paper(p.id); if (!isAbsolute(p.path)) throw new ApiError('INVALID_ARGUMENT', 'PDF 路径必须是绝对路径'); await library.attachPdf(p.id, p.path); return paperData(library.list().find(item => item.id === p.id)!); },
    'papers.import': async p => {
      if (p.paths.some((file: string) => !isAbsolute(file))) throw new ApiError('INVALID_ARGUMENT', 'PDF 路径必须是绝对路径');
      folderExists(p.folderId);
      return library.importPaths(p.paths, p.folderId ?? null);
    },
    'notes.attach': p => { paper(p.id); return library.attachMarkdown(p.id, p.path); },
    'files.moveTag': async p => { paper(p.id); await library.moveFileTag(p.id, p.kind, p.position); return paperData(paper(p.id)); },
    'notes.get': async p => { const item = paper(p.id); return { note: item.markdownNote ?? null, path: item.markdownNote ? await library.markdownPath(p.id) : null }; },
    'papers.setReadingRecord': async p => { paper(p.id); await library.setReadingRecord(p.id, p.record); return paperData(paper(p.id)); },
    'papers.setRating': async p => { paper(p.id); await library.setRating(p.id, p.rating); return paperData(paper(p.id)); },
    'papers.setBriefNote': async p => { paper(p.id); await library.setBriefNote(p.id, p.text); return paperData(paper(p.id)); },
    'papers.markOpened': async p => { paper(p.id); await library.markOpened(p.id); return paperData(paper(p.id)); },
    'metadata.refresh': async p => {
      const item = paper(p.id);
      if (item.source === '手动' && !p.replaceManual) throw new ApiError('MANUAL_METADATA', '该文献有手动元数据。确实需要替换时传 replaceManual=true。', 409);
      const alreadyProcessing = busy(item);
      await library.retry(p.id);
      return { id: p.id, accepted: true, alreadyProcessing, status: paper(p.id).status, poll: 'papers.get' };
    },
    'metadata.update': async p => {
      const item = paper(p.id);
      if (busy(item)) throw new ApiError('BUSY', '请等待检索完成后再修改', 409);
      await library.saveMetadata(p.id, { ...item, ...p.fields });
      return paperData(paper(p.id));
    },
    'folders.list': () => { const state = library.state(); return { folders: state.folders.map(f => ({ ...f, count: state.papers.filter(p => p.folderId === f.id).length })) }; },
    'folders.create': p => library.createFolder(p.name),
    'folders.rename': async p => { folderExists(p.id); await library.renameFolder(p.id, p.name); return { id: p.id, name: library.state().folders.find(f => f.id === p.id)!.name }; },
    'folders.delete': async p => { folderExists(p.id); await library.deleteFolder(p.id); return { id: p.id, deleted: true, papersPreserved: true }; },
    'papers.move': async p => { paper(p.id); folderExists(p.folderId); await library.movePaper(p.id, p.folderId); return { id: p.id, folderId: p.folderId }; },
    'tags.add': p => { paper(p.id); return library.addTag(p.id, p.text, p.color); },
    'tags.update': async p => { tagExists(p.id, p.tagId); await library.updateTag(p.id, p.tagId, p.text, p.color); return paperData(paper(p.id)); },
    'tags.move': async p => { tagExists(p.id, p.tagId); await library.moveTag(p.id, p.tagId, p.position); return paperData(paper(p.id)); },
    'tags.delete': async p => { tagExists(p.id, p.tagId); await library.deleteTag(p.id, p.tagId); return { id: p.id, tagId: p.tagId, deleted: true }; },
  };
  // Fail startup if documentation and implementation ever drift apart.
  if (Object.keys(handlers).sort().join('|') !== capabilities.operations.map(op => op.name).sort().join('|')) throw new Error('AI capability manifest and handlers do not match');
  return async (operation: string, params: unknown = {}) => {
    const spec = capabilities.operations.find(op => op.name === operation);
    if (!spec) throw new ApiError('UNKNOWN_OPERATION', '能力清单中没有此操作', 404);
    validateInput(spec.inputSchema, params);
    if (!spec.mutates) return handlers[operation](params);
    const task = writes.catch(() => {}).then(() => handlers[operation](params));
    writes = task;
    return task;
  };
}

async function readBody(request: IncomingMessage) {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes <= capabilities.limits.requestBytes) chunks.push(chunk);
  }
  if (bytes > capabilities.limits.requestBytes) throw new ApiError('REQUEST_TOO_LARGE', '请求不能超过 1 MB', 413);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError('INVALID_JSON', '请求内容不是有效 JSON'); }
}

export async function startAiApi(library: Library) {
  const dispatch = createDispatcher(library);
  const token = randomBytes(32).toString('hex');
  const sessionPath = join(library.directory, '.ai-session.json');
  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
    try {
      const authorization = Buffer.from(request.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${token}`);
      const address = server.address();
      const host = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : '';
      if (request.headers.origin !== undefined || request.headers.host !== host || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) throw new ApiError('UNAUTHORIZED', '此接口仅供已授权的本机客户端使用', 401);
      if (request.method === 'GET' && request.url === '/v1/capabilities') { send(200, { ok: true, apiVersion: '1', result: capabilities }); return; }
      if (request.method !== 'POST' || request.url !== '/v1/call') throw new ApiError('NOT_FOUND', '没有此接口', 404);
      if (!request.headers['content-type']?.startsWith('application/json')) throw new ApiError('INVALID_ARGUMENT', '请求需使用 application/json');
      if (Number(request.headers['content-length']) > capabilities.limits.requestBytes) throw new ApiError('REQUEST_TOO_LARGE', '请求不能超过 1 MB', 413);
      const body = await readBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.operation !== 'string' || Object.keys(body).some(key => !['operation', 'params'].includes(key))) throw new ApiError('INVALID_ARGUMENT', '需要 operation 和可选的 params');
      const result = await dispatch(body.operation, body.params ?? {});
      send(200, { ok: true, apiVersion: '1', operation: body.operation, result });
    } catch (error) {
      const known = error instanceof ApiError;
      send(known ? error.status : 400, { ok: false, apiVersion: '1', error: { code: known ? error.code : 'OPERATION_FAILED', message: error instanceof Error ? error.message : '操作失败' } });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法创建本地 AI 接口');
  try {
    const session = { apiVersion: '1', host: '127.0.0.1', port: address.port, token, pid: process.pid, storagePath: library.directory };
    await writeFile(sessionPath + '.tmp', JSON.stringify(session), { mode: 0o600 });
    await rename(sessionPath + '.tmp', sessionPath);
  } catch (error) { server.close(); throw error; }
  return {
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      try { const session = JSON.parse(await readFile(sessionPath, 'utf8')); if (session.token === token) await unlink(sessionPath); } catch { /* Already removed or replaced. */ }
    },
  };
}
