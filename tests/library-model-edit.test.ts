import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Library } from '../electron/library';
import { ModelSettings, type ModelCipher } from '../electron/model-settings';
import { createLibraryTools, type LibraryToolOptions } from '../electron/library-agent-tools';
import { LibraryChatService } from '../electron/library-chat-service';
import type { LibraryApprovalDraft, LibraryChatApproval } from '../shared/library-chat';

const oldKey = 'fixture-original-private-key', newKey = 'fixture-replacement-private-key';
async function fixture() {
  await mkdir('.test-data', { recursive: true }); const directory = await mkdtemp(resolve('.test-data/library-model-edit-'));
  const library = new Library(join(directory, 'library'), async () => { throw new Error('no PDF'); }, async () => { throw new Error('no network'); });
  await library.initialize();
  const key = randomBytes(32); let encryption = true;
  const cipher: ModelCipher = {
    isEncryptionAvailable: () => encryption,
    encryptString(value) { const iv = randomBytes(12), enc = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([enc.update(value, 'utf8'), enc.final()]); return Buffer.concat([iv, enc.getAuthTag(), data]); },
    decryptString(bytes) { const dec = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); dec.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([dec.update(bytes.subarray(28)), dec.final()]).toString('utf8'); },
  };
  const models = new ModelSettings(join(directory, 'profile'), cipher);
  const first = await models.save({ profileId: null, name: 'First', baseUrl: 'https://fixture.invalid/v1', model: 'fixture-model', apiKey: oldKey, withoutApiKey: false });
  const second = await models.save({ profileId: null, name: 'Other', baseUrl: 'https://other.invalid/v1', model: 'other-model', withoutApiKey: true, contextWindowTokens: 65536 }, false);
  const id = first.activeId!, otherId = second.profiles.at(-1)!.id;
  const controller = new AbortController(), approvals: LibraryApprovalDraft[] = [];
  let confirm: LibraryToolOptions['confirm'] = async () => ({ id: 'a', requestId: 'r', approved: true });
  const kit = createLibraryTools({ library, models }, { signal: controller.signal, maxTextTokens: 6000,
    confirm: async (draft, signal) => { approvals.push(draft); return confirm(draft, signal); } });
  const call = (name: string, input: unknown = {}) => (kit.tools[name].execute as any)(input, { toolCallId: 'fixture', messages: [] });
  return { directory, library, models, id, otherId, kit, call, controller, approvals,
    decide(fn: LibraryToolOptions['confirm']) { confirm = fn; }, disableEncryption() { encryption = false; } };
}

test('query exposes effective context capacity and an approved partial edit preserves credentials, identity, selection and other profiles', async () => {
  const f = await fixture(), before = await f.models.status(), file = await readFile(f.models.file);
  const queried = await f.call('list_models');
  assert.equal(queried.contextWindowTokens, 32768); assert.equal(queried.contextWindowSource, 'default');
  assert.equal((await f.call('list_models', { id: f.otherId })).profile.contextWindowTokens, 65536);
  assert.equal(JSON.stringify(queried).includes(oldKey), false);
  f.decide(async draft => {
    assert.deepEqual(await readFile(f.models.file), file, 'no write before confirmation');
    assert.equal(draft.modelEdit?.profileId, f.id); assert.equal(draft.modelDraft, undefined, 'capacity edits do not request a key');
    assert.deepEqual(draft.changes.map(item => item.description), ['上下文容量']);
    assert.match(String(draft.changes[0].before), /32,768.*默认/); assert.equal(draft.changes[0].after, '128,000 token');
    return { id: 'a', requestId: 'r', approved: true };
  });
  const edited = await f.call('edit_model', { id: f.id, changes: { contextWindowTokens: 128000 } });
  assert.equal(edited.ok, true); const after = await f.models.status();
  assert.equal(after.contextWindowTokens, 128000); assert.equal(after.activeId, f.id); assert.equal(after.profiles.length, 2);
  assert.deepEqual(after.profiles[1], before.profiles[1]); assert.equal(after.model, before.model); assert.equal(after.baseUrl, before.baseUrl);
  await f.models.withActiveModel(async target => { assert.equal(target.apiKey, oldKey); });
  assert.ok(!(await readFile(f.models.file)).includes(Buffer.from(oldKey)));
  assert.equal((await f.call('list_models')).contextWindowSource, 'configured');
});

test('cancel, stop, unknown IDs and invalid edits never change a configuration', async () => {
  const f = await fixture(), before = await readFile(f.models.file);
  for (const input of [{ id: f.id, changes: {} }, { id: 'missing', changes: { name: 'Bad' } },
    { id: f.id, changes: { contextWindowTokens: 1 } }, { id: f.id, changes: { contextWindowTokens: 128000.5 } },
    { id: f.id, changes: { apiKey: newKey } }, { id: f.id, changes: { name: '\nInvalid' } },
    { id: f.id, changes: { baseUrl: 'https://user:secret@example.org' } }, { id: f.id, changes: { model: 'next' }, apiKey: newKey }]) {
    // Surrounding whitespace is valid; an embedded control character is not.
    if ('name' in input.changes) input.changes.name = 'Bad\nName';
    assert.equal((await f.call('edit_model', input)).ok, false);
  }
  assert.equal(f.approvals.length, 0);
  f.decide(async () => ({ id: 'a', requestId: 'r', approved: false }));
  assert.equal((await f.call('edit_model', { id: f.id, changes: { name: 'Cancelled' } })).cancelled, true);
  f.decide(async () => { f.controller.abort(); return { id: 'a', requestId: 'r', approved: true }; });
  await assert.rejects(f.call('edit_model', { id: f.id, changes: { contextWindowTokens: 128000 } }));
  assert.deepEqual(await readFile(f.models.file), before);
});

test('editing another profile changes only requested fields and keeps active choice; identical changes do not write', async () => {
  const f = await fixture();
  const changed = await f.call('edit_model', { id: f.otherId, changes: { name: 'Renamed', model: 'next-model', contextWindowTokens: 128000 } });
  assert.equal(changed.ok, true); assert.equal(changed.activeId, f.id);
  const status = await f.models.status(); assert.equal(status.profiles[1].name, 'Renamed'); assert.equal(status.profiles[1].hasApiKey, false);
  const before = await readFile(f.models.file), count = f.approvals.length;
  assert.equal((await f.call('edit_model', { id: f.otherId, changes: { name: 'Renamed' } })).unchanged, true);
  assert.equal(f.approvals.length, count); assert.deepEqual(await readFile(f.models.file), before);
});

test('endpoint and key changes require separate local credential entry and never reuse an old endpoint key', async () => {
  const f = await fixture(), before = await readFile(f.models.file);
  f.decide(async draft => {
    assert.equal(draft.modelDraft?.baseUrl, 'https://new.invalid/v1'); assert.ok(!JSON.stringify(draft).includes(oldKey));
    return { id: 'a', requestId: 'r', approved: true, apiKey: '', withoutApiKey: false };
  });
  assert.equal((await f.call('edit_model', { id: f.id, changes: { baseUrl: 'https://new.invalid/v1/' } })).ok, false);
  assert.deepEqual(await readFile(f.models.file), before);
  f.decide(async () => ({ id: 'a', requestId: 'r', approved: true, apiKey: newKey, withoutApiKey: false }));
  const result = await f.call('edit_model', { id: f.id, changes: { baseUrl: 'https://new.invalid/v1/' } });
  assert.equal(result.ok, true); assert.ok(!JSON.stringify(result).includes(newKey));
  await f.models.withActiveModel(async target => { assert.equal(target.apiKey, newKey); assert.equal(target.baseUrl, 'https://new.invalid/v1'); });
  f.decide(async () => ({ id: 'a', requestId: 'r', approved: true, withoutApiKey: true }));
  assert.equal((await f.call('edit_model', { id: f.id, changes: {}, replaceApiKey: true })).ok, true);
  assert.equal((await f.models.status()).hasApiKey, false);
});

test('concurrent desktop edits invalidate confirmed previews inside the serialized save queue', async () => {
  const f = await fixture(); let desktopWrite: Promise<unknown> | undefined;
  f.decide(async () => {
    desktopWrite = f.models.save({ profileId: f.id, name: 'Desktop newer name', baseUrl: 'https://fixture.invalid/v1', model: 'fixture-model', withoutApiKey: false });
    return { id: 'a', requestId: 'r', approved: true };
  });
  const result = await f.call('edit_model', { id: f.id, changes: { contextWindowTokens: 128000 } });
  await desktopWrite;
  assert.equal(result.stale, true); const status = await f.models.status();
  assert.equal(status.name, 'Desktop newer name'); assert.equal(status.contextWindowTokens, undefined);
});

test('stopping while a confirmed save waits in the queue cancels that save; encryption failure preserves original settings', async () => {
  const f = await fixture(), internal = f.models as any, originalWrite = internal.write.bind(f.models);
  let release!: () => void, entered!: () => void, desktopWrite: Promise<unknown> | undefined;
  const gate = new Promise<void>(done => { release = done; }), started = new Promise<void>(done => { entered = done; });
  let held = false;
  internal.write = async (...args: unknown[]) => { if (!held) { held = true; entered(); await gate; } return originalWrite(...args); };
  f.decide(async () => {
    desktopWrite = f.models.save({ profileId: f.otherId, name: 'Other changed', baseUrl: 'https://other.invalid/v1', model: 'other-model', withoutApiKey: true }, false);
    await started; return { id: 'a', requestId: 'r', approved: true };
  });
  const action = f.call('edit_model', { id: f.id, changes: { contextWindowTokens: 128000 } });
  const rejected = assert.rejects(action); await started; await new Promise<void>(done => setImmediate(done));
  f.controller.abort(); release(); await desktopWrite; await rejected;
  assert.equal((await f.models.status()).contextWindowTokens, undefined);
  const g = await fixture(), before = await readFile(g.models.file);
  g.decide(async () => { g.disableEncryption(); return { id: 'a', requestId: 'r', approved: true }; });
  assert.equal((await g.call('edit_model', { id: g.id, changes: { contextWindowTokens: 128000 } })).ok, false);
  assert.deepEqual(await readFile(g.models.file), before);
});

const reply = (content: string | null, tool?: { name: string; args: unknown }) => new Response(JSON.stringify({
  id: 'chatcmpl-' + randomUUID(), object: 'chat.completion', created: 1, model: 'fixture-model', choices: [{ index: 0,
    message: { role: 'assistant', content, ...(tool ? { tool_calls: [{ id: 'call-' + randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : {}) },
    finish_reason: tool ? 'tool_calls' : 'stop' }],
}), { headers: { 'content-type': 'application/json' } });

test('service edit confirmation is single-use, keys stay private, this turn remains bound and the next uses the edited config', async () => {
  const f = await fixture(), service = new LibraryChatService(f.library, f.models), requestId = randomUUID(); let calls = 0;
  const payloads: string[] = []; let approval!: LibraryChatApproval;
  const result = await service.chat({ requestId, messages: [{ role: 'user', content: '修改当前模型和容量' }] }, async (_url, init) => {
    payloads.push(String(init?.body)); const body = JSON.parse(String(init?.body)); calls++;
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + oldKey); assert.equal(body.model, 'fixture-model');
    assert.match(body.messages[0].content, /"contextWindowTokens":32768/);
    if (calls === 1) return reply(null, { name: 'edit_model', args: { id: f.id, changes: { model: 'edited-model', contextWindowTokens: 128000 }, replaceApiKey: true } });
    assert.ok(!String(init?.body).includes(newKey));
    return reply('已保存 ' + newKey);
  }, { progress: event => {
    if (!event.approval) return; approval = event.approval;
    assert.ok(approval.modelEdit); assert.ok(approval.modelDraft);
    assert.throws(() => service.resolveApproval({ id: approval.id, requestId, approved: true, withoutApiKey: false, apiKey: '' }), /密钥/);
    service.resolveApproval({ id: approval.id, requestId, approved: true, withoutApiKey: false, apiKey: newKey });
    assert.throws(() => service.resolveApproval({ id: approval.id, requestId, approved: true, withoutApiKey: true }), /确认已结束/);
  } });
  assert.equal(result.ok, true, result.message); assert.equal(result.contextUsage?.contextWindowTokens, 32768);
  assert.ok(!JSON.stringify(result).includes(newKey)); assert.ok(!payloads.join('').includes(newKey));
  const history = await service.history(); assert.ok(!JSON.stringify(history).includes(newKey));
  const next = await service.chat({ requestId: randomUUID(), messages: [...history.messages.map(({ role, content }) => ({ role, content })), { role: 'user', content: '继续' }] }, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, 'edited-model');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + newKey);
    assert.match(body.messages[0].content, /"contextWindowTokens":128000/); return reply('新配置已用于本轮。');
  });
  assert.equal(next.ok, true, next.message); assert.equal(next.contextUsage?.contextWindowTokens, 128000);
});
