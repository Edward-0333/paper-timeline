import test from 'node:test';
import assert from 'node:assert/strict';
import { chatPrefixHash, estimateAgentMessages, estimateConversation, fitToolContext, memoryMessages, prepareChatCompaction, SUMMARY_MARKER, SUMMARY_SYSTEM, validCompaction } from '../electron/chat-compaction';
import { estimateTextTokens, type ChatCompaction, type ModelChatMessage } from '../shared/model-chat';
import type { ModelMessage } from 'ai';

const paperId = 'a'.repeat(64);
const history = (pairs = 36, size = 400): ModelChatMessage[] => Array.from({ length: pairs * 2 }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user', content: `[turn-${index}] ` + 'source evidence '.repeat(size / 16),
}));
const signal = () => new AbortController().signal;
const options = (messages: ModelChatMessage[]) => ({ paperId, model: 'fixture-model', messages, budget: 3000,
  summaryInputBudget: 4000, signal: signal(), summarize: async () => 'Goal: understand the method. Confirmed gain 12%; verify fulltext:v1:L3-L5. Pending: limitations.' });

test('short conversation stays verbatim without a summary request', async () => {
  const messages = [{ role: 'user' as const, content: 'What is the paper about?' }];
  const result = await prepareChatCompaction({ ...options(messages), summarize: async () => assert.fail('no API call') });
  assert.deepEqual(result.messages, messages); assert.equal(result.compaction, null); assert.equal(result.changed, false);
  assert.notEqual(result.messages, messages);
});

test('automatic compaction processes every old message in bounded batches and retains archive and recent messages', async () => {
  const messages = [...history(), { role: 'user' as const, content: 'LATEST_QUESTION' }], before = structuredClone(messages);
  const chunks: string[] = [];
  const result = await prepareChatCompaction({ ...options(messages), summarize: async input => {
    assert.ok(estimateTextTokens(SUMMARY_SYSTEM) + estimateTextTokens(JSON.stringify({ previousSummary: input.previousSummary, transcript: input.transcript })) < 4000);
    chunks.push(input.transcript); return 'Known gain: 12%. Source fulltext:v1:L3-L5. Open question: limitations.';
  } });
  assert.ok(chunks.length > 1); assert.ok(result.compaction); assert.ok(result.changed);
  assert.equal(result.compaction!.prefixHash, chatPrefixHash(messages, result.compaction!.coveredMessages));
  for (let index = 0; index < result.compaction!.coveredMessages; index++) assert.ok(chunks.join('').includes(`[turn-${index}]`));
  assert.deepEqual(messages, before); assert.deepEqual(result.messages.at(-1), messages.at(-1));
  assert.match(result.messages[0].content, /conversation memory/); assert.ok(estimateConversation(result.messages) <= 3000);
});

test('manual compaction works before the threshold and an unchanged compacted prefix is a no-op', async () => {
  const messages = history(5, 20);
  const result = await prepareChatCompaction({ ...options(messages), force: true });
  assert.ok(result.compaction); assert.equal(result.compaction.coveredMessages, 4);
  const again = await prepareChatCompaction({ ...options(messages), existing: result.compaction, summarize: async () => assert.fail('reuse cached summary') });
  assert.equal(again.changed, false); assert.deepEqual(again.compaction, result.compaction);
  const tiny = await prepareChatCompaction({ ...options(history(1, 20)), force: true, summarize: async () => assert.fail('keep recent pair') });
  assert.equal(tiny.changed, false);
});

test('summary validity is paper- and prefix-bound, including the unsummarized latest message', async () => {
  const messages = history(6, 80), result = await prepareChatCompaction({ ...options(messages), force: true });
  const state = result.compaction!;
  assert.ok(validCompaction(state, paperId, messages));
  assert.equal(validCompaction(state, 'b'.repeat(64), messages), false);
  const changed = structuredClone(messages); changed[0].content = 'Changed old question';
  assert.equal(validCompaction(state, paperId, changed), false);
  assert.equal(validCompaction({ ...state, coveredMessages: messages.length, prefixHash: chatPrefixHash(messages, messages.length) }, paperId, messages), false);
  let previous = 'not-called';
  await prepareChatCompaction({ ...options(changed), existing: state, force: true, summarize: async input => { previous = input.previousSummary; return 'Fresh replacement'; } });
  assert.equal(previous, '');
});

test('switching models reuses portable text and smaller budgets re-summarize without touching old state', async () => {
  const messages = history(6, 20);
  const first = await prepareChatCompaction({ ...options(messages), force: true, summarize: async () => 'Fact and source. '.repeat(80) });
  const saved = structuredClone(first.compaction!);
  const switched = await prepareChatCompaction({ ...options(messages), model: 'different-provider', existing: first.compaction,
    summarize: async () => assert.fail('model identity does not invalidate ordinary text') });
  assert.equal(switched.compaction?.summary, saved.summary);
  const reduced = await prepareChatCompaction({ ...options(messages), model: 'smaller-model', budget: 500, existing: first.compaction,
    summarize: async input => { assert.ok(input.previousSummary); return 'Fact: gain 12%, fulltext:L3. Pending: limits.'; } });
  assert.ok(reduced.changed); assert.equal(reduced.compaction?.model, 'smaller-model');
  assert.ok(estimateConversation(reduced.messages) <= 500); assert.deepEqual(first.compaction, saved);
});

test('split long escaped and non-ASCII messages without skipping text or exceeding summary input budget', async () => {
  const raw = ('\\"中文🧪').repeat(2500);
  const messages: ModelChatMessage[] = [{ role: 'user', content: raw }, { role: 'assistant', content: 'Old answer.' }, { role: 'user', content: 'Keep latest.' }];
  const parts: string[] = [];
  const result = await prepareChatCompaction({ ...options(messages), force: true, summarize: async input => {
    assert.ok(estimateTextTokens(SUMMARY_SYSTEM) + estimateTextTokens(JSON.stringify({ previousSummary: input.previousSummary, transcript: input.transcript })) < 4000);
    parts.push(input.transcript); return 'Preserved question and source pointers.';
  } });
  assert.equal(result.compaction!.coveredMessages, 2); assert.ok(parts.length > 3);
  const text = parts.join('').replace(/\n\[message \d+, role=(user|assistant), character offset=\d+\]\n/g, '');
  assert.equal(text, raw + 'Old answer.');
});

test('summary failure, invalid output and cancellation leave source history and prior memory intact', async () => {
  const messages = history(), before = structuredClone(messages), initial = await prepareChatCompaction(options(messages));
  for (const bad of ['', '\0', 'x'.repeat(13000)]) await assert.rejects(prepareChatCompaction({ ...options(messages), force: true, summarize: async () => bad }));
  const saved = structuredClone(initial.compaction), extended = [...messages, ...history(10)];
  await assert.rejects(prepareChatCompaction({ ...options(extended), existing: saved, summarize: async () => { throw new Error('fixture-failure'); } }), /fixture-failure/);
  const controller = new AbortController();
  await assert.rejects(prepareChatCompaction({ ...options(messages), force: true, signal: controller.signal,
    summarize: async () => { controller.abort(); return 'Canceled result'; } }));
  assert.deepEqual(messages, before); assert.deepEqual(initial.compaction, saved);
});

test('oversized current question cannot be silently summarized away', async () => {
  const messages: ModelChatMessage[] = [{ role: 'user', content: 'x'.repeat(20000) }];
  await assert.rejects(prepareChatCompaction({ ...options(messages), budget: 500, summarize: async () => assert.fail('must preserve latest question') }), /context-budget/);
  assert.equal(memoryMessages(messages, null)[0].content.length, 20000);
});

test('old tool results reduce to navigable pointers without dropping call pairs, current evidence, or reasoning', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'Analyze evidence' },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'retained reasoning', providerOptions: { fixture: { encrypted: 'OPAQUE' } } },
      { type: 'tool-call', toolCallId: 'old-call', toolName: 'read_text', input: { source: 'fulltext' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'old-call', toolName: 'read_text', output: { type: 'json', value: { ref: 'fulltext:v:L1-L3', nextLine: 4, hasMore: true, content: 'OLD_BULK '.repeat(5000) } } }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'new-call', toolName: 'search_text', input: { query: 'gain' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'new-call', toolName: 'search_text', output: { type: 'json', value: { content: 'LATEST_EVIDENCE' } } }] },
  ];
  const original = structuredClone(messages), fitted = fitToolContext(messages, 2000);
  assert.ok(estimateAgentMessages(fitted) < 2000); assert.equal(fitted.length, messages.length);
  assert.match(JSON.stringify(fitted), /fulltext:v:L1-L3/); assert.match(JSON.stringify(fitted), /LATEST_EVIDENCE/); assert.match(JSON.stringify(fitted), /OPAQUE/);
  assert.ok(!JSON.stringify(fitted).includes('OLD_BULK')); assert.deepEqual(messages, original);
  assert.ok(JSON.stringify(fitted).includes('old-call')); assert.ok(JSON.stringify(fitted).includes('new-call'));
  assert.equal(SUMMARY_MARKER.includes('memory'), true);
});
