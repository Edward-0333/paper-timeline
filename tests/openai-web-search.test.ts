import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tool, jsonSchema } from 'ai';
import { requestAgent, type AgentToolKit } from '../electron/paper-agent';
import { openaiSourceUrl, prepareOpenaiWebResponse } from '../electron/openai-web-sources';
import type { ModelChatRequest } from '../shared/model-chat';

const target = { baseUrl: 'https://fixture.invalid/v1', model: 'fixture-openai-model', apiKey: 'fixture-secret' };
const request = (): ModelChatRequest => ({ paperId: 'a'.repeat(64), requestId: randomUUID(), messages: [{ role: 'user', content: '搜索最新论文，并提供来源。' }] });
const kit = (): AgentToolKit => ({ tools: {}, activity: [], sources: [], imageMessage: () => null });
const options = (tools = kit()) => ({ system: 'Fixture library assistant.', hostedWebSearch: true, createTools: () => tools });
function response(output: any[]) {
  return new Response(JSON.stringify({ id: 'resp_fixture', object: 'response', created_at: 1, model: target.model, status: 'completed', output,
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }), { headers: { 'content-type': 'application/json' } });
}
const search = (id = 'ws_fixture') => ({ id, type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'latest research' } });
const message = (text: string, annotations: any[] = []) => ({ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations }] });
const citation = (text: string, url = 'https://example.com/paper', title = 'Research source') => ({ type: 'url_citation', start_index: text.indexOf(''), end_index: text.length, url, title });

test('native web search forces Responses, offers hosted tool and returns clickable actual sources', async () => {
  const text = 'Evidence. citeturn0search0';
  let calls = 0;
  const result = await requestAgent(target, request(), (async (url, init) => {
    calls++; assert.equal(String(url), target.baseUrl + '/responses');
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.store, false); assert.equal(payload.stream, false); assert.equal(payload.max_tool_calls, 3);
    assert.ok(payload.tools.some((item: any) => item.type === 'web_search'));
    assert.ok(!payload.tools.some((item: any) => item.name === 'search_web'));
    return response([search(), message(text, [citation(text)])]);
  }) as typeof fetch, options());
  assert.equal(result.ok, true, result.message); assert.equal(calls, 1);
  assert.equal(result.content, 'Evidence.  [Research source](<https://example.com/paper>)');
  assert.equal(result.sources?.[0].url, 'https://example.com/paper');
  assert.equal(result.sources?.[0].kind, 'web-search'); assert.ok(result.sources?.[0].retrievedAt);
  assert.deepEqual(result.activity, [{ tool: 'web_search', label: 'OpenAI 联网搜索', status: 'succeeded' }]);
});

test('off keeps existing Chat Completions without search; compression never offers hosted tools', async () => {
  const off = await requestAgent(target, request(), (async (url, init) => {
    assert.equal(String(url), target.baseUrl + '/chat/completions');
    assert.ok(!JSON.stringify(JSON.parse(String(init?.body)).tools ?? []).includes('web_search'));
    return new Response(JSON.stringify({ id: 'chat_fixture', object: 'chat.completion', created: 1, model: target.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'No search.' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch, { ...options(), hostedWebSearch: false });
  assert.equal(off.ok, true, off.message); assert.equal(off.sources?.length, 0);
  const compactRequest = { ...request(), compactOnly: true, messages: Array.from({ length: 14 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: 'Summarize fixture history. '.repeat(10) })) };
  let calls = 0;
  const compact = await requestAgent({ ...target, model: 'gpt-6-astra' }, compactRequest, (async (_url, init) => {
    calls++; const payload = JSON.parse(String(init?.body));
    assert.ok(!payload.tools?.length); assert.equal(payload.max_tool_calls, undefined);
    return response([message('Fixture summary.')]);
  }) as typeof fetch, options());
  assert.equal(compact.ok, true, compact.message); assert.ok(calls > 0); assert.equal(compact.sources, undefined);
});

test('unsupported hosted search returns a safe explicit error without compatibility or Tavily fallback', async () => {
  for (const status of [400, 404]) {
    let calls = 0;
    const result = await requestAgent(target, request(), (async url => {
      calls++; assert.equal(String(url), target.baseUrl + '/responses');
      return new Response(JSON.stringify({ error: { code: 'unsupported', param: 'tools', message: 'web_search not supported fixture-secret PRIVATE_PROMPT' } }), { status });
    }) as typeof fetch, options());
    assert.equal(result.ok, false); assert.equal(calls, 1);
    assert.match(result.message, /不支持 OpenAI 内置联网搜索/); assert.match(result.message, /未切换到 Tavily/);
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret|PRIVATE_PROMPT/);
  }
});

test('stopping native search aborts the current request and never retries', async () => {
  const controller = new AbortController(); let calls = 0;
  const pending = requestAgent(target, request(), (async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); controller.abort(); });
  }) as typeof fetch, { ...options(), signal: controller.signal });
  const result = await pending; assert.equal(result.cancelled, true); assert.equal(calls, 1);
});

test('source rendering validates links and offsets, escapes titles, preserves cited prose and deduplicates', () => {
  const text = 'A statement. Another statement.';
  const body = { output: [message(text, [
    { type: 'url_citation', start_index: 0, end_index: 12, url: 'https://example.com/a', title: '<script>[click](javascript:evil)</script>' },
    { type: 'url_citation', start_index: 13, end_index: 31, url: 'https://example.com/a', title: 'Duplicate' },
    { type: 'url_citation', start_index: -1, end_index: 800, url: 'https://example.com/invalid', title: 'Invalid offset' },
    { type: 'url_citation', start_index: 0, end_index: 0, url: 'javascript:alert(1)', title: 'Unsafe' },
    { type: 'url_citation', start_index: 0, end_index: 0, url: 'https://example.com/?api_key=secret', title: 'Secret URL' },
  ])] };
  const result = prepareOpenaiWebResponse(body, value => value.replaceAll('fixture-secret', '[hidden]'));
  assert.equal(result.sources.length, 1);
  const rendered = body.output[0].content[0].text;
  assert.match(rendered, /^A statement\. /); assert.ok(rendered.includes('Another statement.'));
  assert.ok(rendered.includes('\\<script\\>')); assert.ok(rendered.includes('](<https://example.com/a>)'));
  assert.doesNotMatch(rendered, /\]\(javascript:|api_key|https:\/\/example.com\/invalid/);
  for (const value of ['https://user:password@example.com', 'file:///tmp/private', 'https://example.com/fixture-secret', 'https://example.com/%66ixture-secret', 'https://example.com/%2566ixture-secret', 'https://example.com/%252566ixture-secret', 'https://example.com/sk-OTHER_CREDENTIAL', 'https://example.com/\npath', 'https://example.com/?token=private']) {
    assert.equal(openaiSourceUrl(value, text => text.replaceAll('fixture-secret', '[hidden]')), null);
  }
});

test('native search cap is shared across model steps and tools stop at the total activity budget', async () => {
  const tools = kit(); let executions = 0;
  tools.tools.inspect = tool({ description: 'Inspect fixture.', inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }), execute: async () => {
    executions++; tools.activity.push({ tool: 'inspect', label: 'Inspect fixture', status: 'succeeded' }); return { ok: true };
  } });
  let calls = 0;
  const result = await requestAgent(target, request(), (async (_url, init) => {
    const payload = JSON.parse(String(init?.body)); calls++;
    if (calls === 1) return response([search('ws_1'), search('ws_2'), search('ws_3'), { id: 'fn_fixture', type: 'function_call', call_id: 'call_fixture', name: 'inspect', arguments: '{}' }]);
    assert.equal(payload.max_tool_calls, undefined); assert.ok(!payload.tools?.some((item: any) => item.type === 'web_search'));
    return response([message('Finished.')]);
  }) as typeof fetch, options(tools));
  assert.equal(result.ok, true, result.message); assert.equal(calls, 2); assert.equal(executions, 1); assert.equal(result.activity?.length, 4);
  const overLimit = await requestAgent(target, request(), (async () => response([search('ws_1'), search('ws_2'), search('ws_3'), search('ws_4'), message('Too many.')])) as typeof fetch, options());
  assert.equal(overLimit.ok, false); assert.match(overLimit.message, /次数上限/);
});

test('hosted searches and local mutations cannot exceed the shared 24-call budget', async () => {
  const tools = kit(); let executions = 0, calls = 0;
  tools.activity.push(...Array.from({ length: 23 }, () => ({ tool: 'prior', label: 'Prior fixture operation', status: 'succeeded' as const })));
  tools.tools.mutate = tool({ description: 'Mutate fixture.', inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }), execute: async () => {
    executions++; tools.activity.push({ tool: 'mutate', label: 'Mutated fixture', status: 'succeeded' }); return { ok: true };
  } });
  const result = await requestAgent(target, request(), (async (_url, init) => {
    calls++; const payload = JSON.parse(String(init?.body));
    if (calls === 1) {
      assert.equal(payload.max_tool_calls, 1);
      return response([search(), { id: 'fn_mutate', type: 'function_call', call_id: 'call_mutate', name: 'mutate', arguments: '{}' }]);
    }
    assert.ok(!payload.tools?.length);
    return response([message('Budget reached.')]);
  }) as typeof fetch, options(tools));
  assert.equal(result.ok, true, result.message); assert.equal(executions, 0); assert.equal(result.activity?.length, 24);
});

test('multiple citations at the same offset remain clickable and explicit page reads have the correct source kind', () => {
  const text = 'Evidence. citeturn0search0';
  const body = { output: [{ id: 'ws_page', type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://example.com/paper' } },
    message(text, [citation(text), citation(text, 'https://example.com/other', 'Second source')])] };
  const result = prepareOpenaiWebResponse(body, value => value);
  assert.equal(result.sources.length, 2); assert.equal(result.sources[0].kind, 'web-page');
  const content = (body.output[1] as any).content[0].text;
  assert.match(content, /\[Research source\]\(<https:\/\/example.com\/paper>\)/);
  assert.match(content, /\[Second source\]\(<https:\/\/example.com\/other>\)/);
});
