import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, symlink, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { zipSync, strToU8 } from 'fflate';
import { Library } from '../electron/library';
import { localMetadata } from '../electron/metadata';
import { getModelChatContext } from '../electron/model-chat-context';
import { createPaperTools } from '../electron/paper-agent-tools';
import { requestModelChat } from '../electron/model-chat';
import { PaperChatStore } from '../electron/paper-chat-store';
import { ModelSettings } from '../electron/model-settings';
import { renderPdfPage } from '../electron/agent-page-worker';
import { prepareStorageChange } from '../electron/storage-settings';
import type { ModelChatRequest } from '../shared/model-chat';
import { estimateTextTokens } from '../shared/model-chat';
import { SUMMARY_MARKER, SUMMARY_SYSTEM } from '../electron/chat-compaction';

const target = { baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture-agent-model', apiKey: 'fixture-agent-secret' };
function pdf() {
  const stream = 'BT /F1 18 Tf 72 700 Td (PAPER AGENT ORIGINAL PAGE) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let raw = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((item, i) => { offsets.push(Buffer.byteLength(raw)); raw += `${i + 1} 0 obj\n${item}\nendobj\n`; });
  const xref = Buffer.byteLength(raw);
  return raw + `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
async function fixture() {
  await mkdir('.test-data', { recursive: true }); const root = await mkdtemp(resolve('.test-data/paper-agent-'));
  const library = new Library(join(root, 'library'), async () => ({ title: 'Agent paper', authors: [], year: null, doi: '', arxivId: '', abstract: '', firstPageText: '', pageCount: 1 }),
    async extracted => ({ metadata: localMetadata(extracted), matched: true, message: 'fixture' }));
  await library.initialize(); const source = join(root, 'fixture.pdf'); await writeFile(source, pdf());
  const id = (await library.importPaths([source])).paperIds![0]; await library.whenIdle();
  const other = (await library.createPaper({ title: 'OTHER_PAPER_PRIVATE' }, null, false)).id;
  const canvas = createCanvas(100, 70); canvas.getContext('2d').fillStyle = '#e13236'; canvas.getContext('2d').fillRect(0, 0, 100, 70);
  const image = canvas.toBuffer('image/png'); let conversions = 0;
  const archive = () => zipSync({ 'markdown.md': strToU8('# Agent paper\n## Results\nCURRENT_PAPER_EVIDENCE gain is 12 percent.\n![Figure 1](images/figure.png)\n'),
    'middle_json.json': strToU8('{}'), 'images/figure.png': image });
  library.startMineru({ environment: async () => ({ ready: true, message: 'fixture' }), convert: async (_path, output) => { conversions++; await writeFile(output, archive()); return 'fixture-mineru'; } });
  return { root, library, id, other, image, archive, conversions: () => conversions };
}
const request = (id: string): ModelChatRequest => ({ paperId: id, requestId: randomUUID(), messages: [{ role: 'user', content: '请分析当前论文，核对图表和原始页面。' }] });
const response = (content: unknown, tool?: { name: string; args: unknown }) => new Response(JSON.stringify({ id: 'fixture-' + randomUUID(), model: target.model,
  created: 1, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content,
    ...(tool ? { tool_calls: [{ id: 'call-' + randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : {}) },
    finish_reason: tool ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } });
const execute = (kit: ReturnType<typeof createPaperTools>, name: string, args: unknown) => (kit.tools[name].execute as Function)(args, { toolCallId: 'unit-call', messages: [] });

test('AI SDK loops through MinerU, full text, images and original PDF; only current-paper data leaves the host', async () => {
  const f = await fixture(), context = await getModelChatContext(f.library, f.id), original = await readFile(f.library.pdfPath(f.id));
  let calls = 0; const payloads: any[] = [], progress: string[] = [];
  const result = await requestModelChat(target, request(f.id), (async (url, init) => {
    assert.equal(String(url), target.baseUrl + '/chat/completions'); assert.equal(init!.redirect, 'manual');
    assert.equal(new Headers(init!.headers).get('Authorization'), 'Bearer ' + target.apiKey);
    const payload = JSON.parse(String(init!.body)); payloads.push(payload); calls++;
    assert.equal(JSON.stringify(payload).includes('OTHER_PAPER_PRIVATE'), false); assert.equal(JSON.stringify(payload).includes(target.apiKey), false);
    if (calls === 1) return response(null, { name: 'prepare_fulltext', args: {} });
    if (calls === 2) return response(null, { name: 'read_text', args: { source: 'fulltext' } });
    if (calls === 3) { assert.match(JSON.stringify(payload), /CURRENT_PAPER_EVIDENCE/); return response(null, { name: 'list_images', args: {} }); }
    if (calls === 4) {
      const content = JSON.parse(payload.messages.filter((m: any) => m.role === 'tool').at(-1).content);
      return response(null, { name: 'view_image', args: { imageId: content.images[0].imageId } });
    }
    if (calls === 5) {
      const images = payload.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'image_url') : []);
      assert.equal(images.length, 1); assert.match(images[0].image_url.url, /^data:image\/png;base64,/);
      return response(null, { name: 'view_pdf_page', args: { page: 1 } });
    }
    const images = payload.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'image_url') : []);
    assert.equal(images.length, 2); return response('结果提升12%，见全文第3行及 PDF 第1页。');
  }) as typeof fetch, { context, agent: { library: f.library, paperId: f.id, renderPage: renderPdfPage }, progress: label => progress.push(label) });
  assert.equal(result.ok, true, result.message); assert.equal(calls, 6); assert.equal(f.conversions(), 1);
  assert.equal(result.activity?.length, 5); assert.equal(result.sources?.length, 3); assert.ok(progress.some(label => label.includes('MinerU')));
  assert.deepEqual(await readFile(f.library.pdfPath(f.id)), original);
  assert.ok(payloads[0].tools.some((t: any) => t.function.name === 'read_text'));
});

test('follow-up searches re-read changed text, and fulltext reads disclose continuation rather than silent truncation', async () => {
  const f = await fixture(); await f.library.convertPdf(f.id); await f.library.whenIdle();
  const fulltext = await f.library.conversionPath(f.id, 'markdown');
  const kit = createPaperTools({ library: f.library, paperId: f.id }, { signal: new AbortController().signal });
  const old = await execute(kit, 'search_text', { source: 'fulltext', query: '12 percent' }); assert.equal(old.totalMatches, 1);
  await writeFile(fulltext, 'updated evidence 27 percent\n' + Array.from({ length: 100 }, () => 'x'.repeat(1000)).join('\n'));
  const fresh = await execute(kit, 'search_text', { source: 'fulltext', query: '27 percent' });
  assert.equal(fresh.totalMatches, 1); assert.notEqual(fresh.hits[0].ref, old.hits[0].ref);
  const first = await execute(kit, 'read_text', { source: 'fulltext' }); assert.equal(first.hasMore, true); assert.ok(first.nextLine > 1);
  const next = await execute(kit, 'read_text', { source: 'fulltext', startLine: first.nextLine }); assert.equal(next.hasMore, false);
  assert.equal(next.endLine, first.totalLines);
});

test('PDF agent uses the modern OpenAI limit, negotiates an explicit limit rejection once, and retains tool history', async () => {
  const f = await fixture(), options = { context: await getModelChatContext(f.library, f.id), agent: { library: f.library, paperId: f.id } };
  for (const gateway of [false, true]) {
    const bodies: any[] = [];
    const result = await requestModelChat({ ...target, baseUrl: gateway ? target.baseUrl : 'https://api.openai.com/v1' }, request(f.id), async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      assert.ok(body.tools.some((tool: any) => tool.function.name === 'paper_info'));
      if (body.max_tokens != null) {
        assert.equal(gateway, true); assert.equal(bodies.length, 1);
        return Response.json({ error: { param: 'max_tokens', code: 'unsupported_parameter', message: 'Use max_completion_tokens instead' } }, { status: 400 });
      }
      assert.equal(body.max_completion_tokens, 4096);
      if (!body.messages.some((m: any) => m.role === 'tool')) return response(null, { name: 'paper_info', args: {} });
      return response('读取成功');
    }, options);
    assert.equal(result.ok, true, result.message);
    assert.equal(bodies.length, gateway ? 3 : 2);
    assert.equal(result.activity?.length, 1);
    if (gateway) {
      const { max_tokens, ...before } = bodies[0];
      const { max_completion_tokens, ...after } = bodies[1];
      assert.equal(max_tokens, max_completion_tokens); assert.deepEqual(before, after);
    }
  }
});

test('unrelated HTTP 400 errors give safe specific advice without replaying the request', async () => {
  const f = await fixture(), options = { context: await getModelChatContext(f.library, f.id), agent: { library: f.library, paperId: f.id } };
  for (const [code, param, label] of [
    ['invalid_function_parameters', 'tools[0].function.parameters', '工具的参数格式'],
    ['invalid_image', 'messages[2].content', '图片输入'],
    ['model_not_found', 'model', '模型不存在'],
    ['context_length_exceeded', 'messages', '上下文长度'],
  ]) {
    let calls = 0;
    const result = await requestModelChat(target, request(f.id), async () => {
      calls++;
      return Response.json({ error: { code, param, message: 'PRIVATE_TEXT unsupported max_tokens ' + target.apiKey } }, { status: 400 });
    }, options);
    assert.equal(result.ok, false); assert.ok(result.message.includes(label)); assert.equal(calls, 1);
    assert.ok(!result.message.includes('PRIVATE_TEXT') && !result.message.includes(target.apiKey));
  }
});

test('valid full text is reused unless the user explicitly requests a new parse', async () => {
  const f = await fixture(), kit = createPaperTools({ library: f.library, paperId: f.id }, { signal: new AbortController().signal });
  assert.equal((await execute(kit, 'prepare_fulltext', {})).reused, false);
  assert.equal((await execute(kit, 'prepare_fulltext', {})).reused, true); assert.equal(f.conversions(), 1);
  assert.equal((await execute(kit, 'prepare_fulltext', { force: true, tier: 'flash' })).reused, false); assert.equal(f.conversions(), 2);
  assert.equal((await f.library.conversionState(f.id)).result?.tier, 'flash');
});

test('disguised files and huge raster headers are rejected before image decoding or transmission', async () => {
  const f = await fixture(); await f.library.convertPdf(f.id); await f.library.whenIdle();
  const path = join(await f.library.conversionPath(f.id, 'directory'), 'images', 'figure.png');
  const kit = createPaperTools({ library: f.library, paperId: f.id }, { signal: new AbortController().signal });
  const imageId = (await execute(kit, 'list_images', {})).images[0].imageId;
  await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///private"/></svg>');
  assert.equal((await execute(kit, 'view_image', { imageId })).ok, false);
  const large = Buffer.from(f.image); large.writeUInt32BE(100000, 16); await writeFile(path, large);
  assert.equal((await execute(kit, 'view_image', { imageId })).ok, false);
  assert.equal(kit.imageMessage(), null); assert.equal(kit.sources.length, 0);
});

test('unknown tools, forged paper IDs and path traversal never grant access to another paper or arbitrary files', async () => {
  const f = await fixture(); let calls = 0;
  const result = await requestModelChat(target, request(f.id), (async (_url, init) => {
    calls++; const body = String(init!.body); assert.equal(body.includes('PRIVATE_OUTSIDE_DATA'), false);
    if (calls === 1) return response(null, { name: 'read_text', args: { source: 'notes', paperId: f.other, path: '../../llm-config.bin' } });
    if (calls === 2) return response(null, { name: 'shell', args: { command: 'read other papers' } });
    return response('工具不允许访问该资料。');
  }) as typeof fetch, { context: await getModelChatContext(f.library, f.id), agent: { library: f.library, paperId: f.id } });
  assert.equal(result.ok, true, result.message); assert.equal(result.activity?.length, 0); assert.equal(result.sources?.length, 0);
  const mismatched = await requestModelChat(target, request(f.id), (async () => { assert.fail('must not fetch'); }) as typeof fetch,
    { context: await getModelChatContext(f.library, f.id), agent: { library: f.library, paperId: f.other } });
  assert.equal(mismatched.ok, false);
});

test('linked paper attachments are rejected without exposing their target or contents', async () => {
  const f = await fixture(), outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'notes.md'), 'PRIVATE_OUTSIDE_DATA');
  const note = join(f.root, 'note.md'); await writeFile(note, 'original'); await f.library.attachMarkdown(f.id, note);
  const originalDirectory = f.library.paperDirectory(f.id), moved = originalDirectory + '.original'; await rename(originalDirectory, moved);
  await symlink(outside, originalDirectory, 'junction');
  const kit = createPaperTools({ library: f.library, paperId: f.id }, { signal: new AbortController().signal });
  const result = await execute(kit, 'read_text', { source: 'notes' }); assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_OUTSIDE_DATA'), false); assert.equal(kit.sources.length, 0);
});

test('stopping an agent cancels its own MinerU job, while a pre-existing manual conversion continues', async () => {
  for (const manual of [false, true]) {
    const f = await fixture(); let started!: () => void, complete!: () => void;
    const began = new Promise<void>(accept => started = accept);
    f.library.startMineru({ environment: async () => ({ ready: true, message: 'fixture' }), convert: async (_path, output, _tier, signal) => {
      await new Promise<void>((accept, reject) => { complete = accept; signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); started(); });
      await writeFile(output, f.archive()); return 'fixture';
    } });
    if (manual) await f.library.convertPdf(f.id);
    const controller = new AbortController(), kit = createPaperTools({ library: f.library, paperId: f.id }, { signal: controller.signal });
    const pending = execute(kit, 'prepare_fulltext', {}); await began; await new Promise(accept => setTimeout(accept, 30)); controller.abort();
    await assert.rejects(pending);
    assert.equal((await f.library.conversionState(f.id)).status, manual ? 'running' : 'cancelled');
    if (manual) { complete(); await f.library.whenIdle(); assert.equal((await f.library.conversionState(f.id)).status, 'succeeded'); }
  }
});

test('run limits stop tool loops and model errors remain private and are not retried', async () => {
  const f = await fixture(), options = { context: await getModelChatContext(f.library, f.id), agent: { library: f.library, paperId: f.id } };
  let calls = 0;
  const limited = await requestModelChat(target, request(f.id), (async () => { calls++; return response(null, { name: 'paper_info', args: {} }); }) as typeof fetch, options);
  assert.equal(limited.ok, false); assert.equal(calls, 12);
  calls = 0;
  const denied = await requestModelChat(target, request(f.id), (async () => { calls++; return new Response(JSON.stringify({ error: { message: target.apiKey } }), { status: 401 }); }) as typeof fetch, options);
  assert.equal(denied.ok, false); assert.match(denied.message, /401/); assert.equal(calls, 1); assert.equal(JSON.stringify(denied).includes(target.apiKey), false);
});

test('keyless endpoints omit authorization, stalled replies can be stopped, and oversized responses are bounded', async () => {
  const f = await fixture(), options = { context: await getModelChatContext(f.library, f.id), agent: { library: f.library, paperId: f.id } };
  const local = await requestModelChat({ ...target, apiKey: '' }, request(f.id), (async (_url, init) => {
    assert.equal(new Headers(init!.headers).has('Authorization'), false); return response('local answer');
  }) as typeof fetch, options); assert.equal(local.ok, true);
  const oversized = await requestModelChat(target, request(f.id), (async () => new Response('x', { headers: { 'content-length': '2000000' } })) as typeof fetch, options);
  assert.equal(oversized.ok, false); assert.match(oversized.message, /过大/);
  const controller = new AbortController();
  const pending = requestModelChat(target, request(f.id), (async (_url, init) => new Promise<Response>((_accept, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('stopped')), { once: true }); setTimeout(() => controller.abort(), 10);
  })) as typeof fetch, { ...options, signal: controller.signal });
  const stopped = await pending; assert.equal(stopped.cancelled, true);
});

test('conversation and evidence survive reload and copying; corrupt history is preserved rather than overwritten', async () => {
  const f = await fixture(), store = new PaperChatStore(f.library);
  assert.deepEqual(await store.load(f.id), { messages: [] });
  const messages = [{ role: 'user' as const, content: 'question' }, { role: 'assistant' as const, content: 'answer', sources: [{ id: 'fulltext:v1:L1-L2', label: '全文 L1–L2' }], activity: [{ tool: 'read_text', label: '读取全文', status: 'succeeded' as const }] }];
  await store.save(f.id, messages); assert.deepEqual((await new PaperChatStore(f.library).load(f.id)).messages, messages);
  await store.save(f.id, [...messages.map(({ role, content }) => ({ role, content })), { role: 'user', content: 'follow-up' }, { role: 'assistant', content: 'follow-up answer' }]);
  assert.deepEqual((await store.load(f.id)).messages[1].sources, messages[1].sources);
  const destination = join(f.root, 'copied-library'); await mkdir(destination);
  await prepareStorageChange(f.library, f.library.directory, 'copy', destination);
  const copied = new Library(destination, async () => { throw new Error('no extraction expected'); }, async () => { throw new Error('no metadata lookup expected'); });
  await copied.initialize();
  assert.deepEqual(await new PaperChatStore(copied).load(f.id), await store.load(f.id));
  const path = join(f.library.paperDirectory(f.id), 'chat.json'); await writeFile(path, '{damaged');
  await assert.rejects(store.load(f.id)); await assert.rejects(store.save(f.id, [])); assert.equal(await readFile(path, 'utf8'), '{damaged');
});

test('saved credential is redacted from persisted turns and a storage failure does not discard the reply', async () => {
  const f = await fixture(); let persisted: unknown, saves = 0;
  const store = new ModelSettings(join(f.root, 'profile'), { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() },
    id => getModelChatContext(f.library, id), id => ({ library: f.library, paperId: id }), async (_id, messages) => { persisted = messages; if (++saves > 1) throw new Error('disk fixture'); });
  await store.save({ ...target, name: 'fixture', withoutApiKey: false });
  const input = request(f.id); input.messages[0].content = 'question ' + target.apiKey;
  const result = await store.chat(input, (async () => response('answer ' + target.apiKey)) as typeof fetch);
  assert.equal(result.ok, true, result.message); assert.match(result.historyWarning!, /保存失败/);
  assert.equal(JSON.stringify(persisted).includes(target.apiKey), false); assert.equal(result.content!.includes(target.apiKey), false);
});

test('PDF source-page rendering produces an actual bounded image and rejects out-of-range pages', async () => {
  const f = await fixture(); const image = await renderPdfPage(f.library.pdfPath(f.id), 1);
  assert.equal(image.pages, 1); assert.equal(image.data.subarray(1, 4).toString(), 'PNG');
  await assert.rejects(renderPdfPage(f.library.pdfPath(f.id), 2));
});

test('the bound SDK model summarizes long history without tools, then answers from portable memory', async () => {
  const f = await fixture(), input = request(f.id), payloads: any[] = [];
  input.messages = [...Array.from({ length: 80 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const,
    content: `ARCHIVE_MESSAGE_${index} ` + 'original evidence '.repeat(100) })), { role: 'user', content: 'LATEST_ANALYSIS_QUESTION' }];
  const before = structuredClone(input.messages);
  const result = await requestModelChat(target, input, async (url, init) => {
    assert.equal(String(url), target.baseUrl + '/chat/completions');
    const body = JSON.parse(String(init?.body)); payloads.push(body);
    if (!body.tools?.length) {
      assert.match(body.messages[0].content, /Summarize/); assert.equal(body.model, target.model);
      assert.ok(estimateTextTokens(body.messages.map((item: any) => item.content).join('')) < 21504);
      return response('Goal: compare methods. Gain 12% (fulltext:v1:L3). Pending: limitations.');
    }
    assert.ok(JSON.stringify(body.messages).includes(SUMMARY_MARKER));
    assert.ok(!JSON.stringify(body.messages).includes('ARCHIVE_MESSAGE_0 '));
    assert.ok(JSON.stringify(body.messages).includes('LATEST_ANALYSIS_QUESTION'));
    return response('A continuing analysis based on the history summary.');
  }, { context: await getModelChatContext(f.library, f.id), agent: { library: f.library, paperId: f.id } });
  assert.equal(result.ok, true, result.message); assert.ok(payloads.filter(body => !body.tools?.length).length > 1);
  assert.ok(result.compaction?.coveredMessages! > 64); assert.ok(result.contextUsage?.compacted);
  assert.deepEqual(input.messages, before); assert.equal(result.activity?.length, 0);
});

test('manual compaction only produces memory, while failed or truncated summaries are never accepted', async () => {
  const f = await fixture(), input = request(f.id);
  input.compactOnly = true;
  input.messages = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `Small history ${index}.` }));
  const options = { context: await getModelChatContext(f.library, f.id), agent: { library: f.library, paperId: f.id } };
  let calls = 0;
  const manual = await requestModelChat(target, input, async (_url, init) => {
    calls++; assert.equal(JSON.parse(String(init?.body)).tools, undefined); return response('Goal and unresolved questions retained.');
  }, options);
  assert.equal(manual.ok, true, manual.message); assert.equal(manual.content, undefined); assert.equal(calls, 1); assert.ok(manual.compaction);
  for (const kind of ['http', 'empty', 'length']) {
    const rejected = await requestModelChat(target, input, async () => {
      if (kind === 'http') return Response.json({ error: { message: target.apiKey } }, { status: 429 });
      const data = await response(kind === 'empty' ? '' : 'incomplete summary').json();
      if (kind === 'length') data.choices[0].finish_reason = 'length';
      return Response.json(data);
    }, options);
    assert.equal(rejected.ok, false); assert.match(rejected.message, /摘要/); assert.equal(rejected.compaction, undefined);
    assert.ok(!JSON.stringify(rejected).includes(target.apiKey));
  }
});

test('a manual summary can be stopped, and archive-save failure prevents any model call', async () => {
  const f = await fixture(), input = request(f.id), controller = new AbortController();
  input.compactOnly = true; input.messages = Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'Historical message ' + index }));
  const stopped = await requestModelChat(target, input, async (_url, init) => new Promise<Response>((_resolve, reject) => {
    assert.equal(JSON.parse(String(init?.body)).tools, undefined);
    init!.signal!.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
    setTimeout(() => controller.abort(), 10);
  }), { context: await getModelChatContext(f.library, f.id), agent: { library: f.library, paperId: f.id }, signal: controller.signal });
  assert.equal(stopped.cancelled, true); assert.equal(stopped.compaction, undefined);
  const store = new ModelSettings(join(f.root, 'blocked-profile'), { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() },
    id => getModelChatContext(f.library, id), id => ({ library: f.library, paperId: id }), async () => { throw new Error('disk fixture'); });
  await store.save({ ...target, name: 'fixture', withoutApiKey: false });
  const result = await store.chat(request(f.id), async () => assert.fail('do not transmit when preserving the archive failed'));
  assert.equal(result.ok, false); assert.match(result.message, /保存/);
});

test('minimum configured context supports short text and current bulky source material is bounded', async () => {
  const f = await fixture(), options = { context: await getModelChatContext(f.library, f.id), agent: { library: f.library, paperId: f.id } };
  let smallCalls = 0;
  const short = await requestModelChat({ ...target, contextWindowTokens: 8192 }, request(f.id), async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.max_tokens, 2048); smallCalls++;
    return smallCalls === 1 ? response(null, { name: 'paper_info', args: {} }) : response('A short answer.');
  }, options);
  assert.equal(short.ok, true, short.message);
  assert.equal(smallCalls, 2);
  await f.library.convertPdf(f.id); await f.library.whenIdle();
  await writeFile(await f.library.conversionPath(f.id, 'markdown'), Array.from({ length: 2000 }, (_, n) => `Evidence line ${n}: ` + 'x'.repeat(60)).join('\n'));
  let calls = 0; const observations: unknown[] = [];
  const result = await requestModelChat(target, request(f.id), async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls++;
    if (calls === 1) return response(null, { name: 'read_text', args: { source: 'fulltext' } });
    const tools = body.messages.filter((message: any) => message.role === 'tool').map((message: any) => JSON.parse(message.content));
    observations.push(tools.map((tool: any) => ({ compacted: tool.compacted, hasMore: tool.hasMore, nextLine: tool.nextLine, length: tool.content?.length, ok: tool.ok })));
    assert.ok(tools.at(-1).hasMore); assert.ok(tools.at(-1).content.length < 60000);
    if (calls < 8) return response(null, { name: 'read_text', args: { source: 'fulltext', startLine: tools.at(-1).nextLine } });
    assert.ok(tools.some((tool: any) => tool.compacted));
    assert.ok(tools.filter((tool: any) => tool.compacted).every((tool: any) => tool.ref && tool.nextLine));
    return response('Read selected sections; further pages remain.');
  }, options);
  assert.equal(result.ok, true, result.message + JSON.stringify({ calls, observations })); assert.ok(result.contextUsage!.estimatedTokens <= result.contextUsage!.inputBudgetTokens);
  assert.equal(calls, 8);
});
