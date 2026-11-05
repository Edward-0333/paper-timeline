import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ModelSettings, type ModelCipher } from '../electron/model-settings';

const input = { name: '论文模型', baseUrl: 'https://models.example.test/v1/', model: 'research-model', apiKey: 'fixture-secret-do-not-return', withoutApiKey: false };
test('context capacities are per profile, validated and survive edits and model switches', async () => {
  const { store, directory, cipher } = await fixture();
  const first = await store.save({ ...input, contextWindowTokens: 32768 });
  const second = await store.save({ ...input, profileId: null, name: 'Smaller', model: 'smaller-model', contextWindowTokens: 8192 });
  assert.equal(second.contextWindowTokens, 8192);
  await store.select(first.activeId!);
  assert.equal((await store.status()).contextWindowTokens, 32768);
  await store.save({ ...input, profileId: first.activeId, apiKey: '', name: 'Edited' });
  assert.equal((await new ModelSettings(directory, cipher).status()).contextWindowTokens, 32768);
  const before = await readFile(store.file);
  for (const value of [0, 8191, 2000001, 12345.6, NaN, '32768', null]) {
    await assert.rejects(store.save({ ...input, contextWindowTokens: value as number }), /上下文/);
    assert.deepEqual(await readFile(store.file), before);
  }
});
async function fixture() {
  await mkdir('.test-data', { recursive: true }); const root = await mkdtemp(resolve('.test-data/model-settings-'));
  const key = randomBytes(32);
  const cipher: ModelCipher = {
    isEncryptionAvailable: () => true,
    encryptString: value => { const iv = randomBytes(12), enc = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([enc.update(value, 'utf8'), enc.final()]); return Buffer.concat([iv, enc.getAuthTag(), bytes]); },
    decryptString: bytes => { const dec = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); dec.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([dec.update(bytes.subarray(28)), dec.final()]).toString('utf8'); },
  };
  const directory = join(root, 'profile'), store = new ModelSettings(directory, cipher); return { root, directory, store, cipher };
}
test('model configuration encrypts its API key, returns only public fields, preserves keys on same-address edits and survives restart', async () => {
  const { store, directory, cipher } = await fixture(); assert.equal((await store.status()).configured, false);
  const saved = await store.save(input); assert.equal(saved.configured, true); assert.equal(saved.baseUrl, 'https://models.example.test/v1'); assert.equal(saved.hasApiKey, true);
  assert.equal(Object.hasOwn(saved, 'apiKey'), false); assert.equal(JSON.stringify(saved).includes(input.apiKey), false); assert.equal((await readFile(store.file)).includes(Buffer.from(input.apiKey)), false);
  assert.equal(JSON.parse(cipher.decryptString(await readFile(store.file))).profiles[0].apiKey, input.apiKey);
  await store.save({ ...input, model: 'another-model', apiKey: '' }); const reload = new ModelSettings(directory, cipher);
  assert.equal((await reload.status()).model, 'another-model'); assert.equal(JSON.parse(cipher.decryptString(await readFile(store.file))).profiles[0].apiKey, input.apiKey);
  assert.equal((await readdir(directory)).length, 1); // No plaintext or stale credential files.
});
test('changing endpoint cannot reuse a stored key; malformed values leave the existing configuration intact', async () => {
  const { store } = await fixture(); await store.save(input); const bytes = await readFile(store.file);
  await assert.rejects(store.save({ ...input, baseUrl: 'https://another.example.test/v1', apiKey: '' }), /地址已更改/);
  for (const value of [ { ...input, baseUrl: 'file:///secret' }, { ...input, baseUrl: 'https://user:password@host.test/v1' }, { ...input, baseUrl: 'https://host.test/v1?key=secret' },
    { ...input, name: ' ' }, { ...input, model: '\n' }, { ...input, apiKey: 'secret\ninjected' }, { ...input, apiKey: 'x'.repeat(8193) }, { ...input, arbitrary: 'unsupported' } ]) {
    await assert.rejects(store.save(value)); assert.deepEqual(await readFile(store.file), bytes);
  }
  await store.save({ ...input, baseUrl: 'https://another.example.test/v1', apiKey: 'new-key' }); assert.equal((await store.status()).baseUrl, 'https://another.example.test/v1');
});
test('explicit keyless local configuration and clear work, and concurrent writes are atomic and serialized', async () => {
  const { store, cipher } = await fixture(); await store.save(input);
  await store.save({ ...input, baseUrl: 'http://localhost:11434/v1', apiKey: undefined, withoutApiKey: true }); assert.equal((await store.status()).hasApiKey, false);
  assert.equal(JSON.parse(cipher.decryptString(await readFile(store.file))).profiles[0].apiKey, '');
  await Promise.all([store.save({ ...input, name: 'first' }), store.save({ ...input, name: 'second', apiKey: '' })]); assert.equal((await store.status()).name, 'second');
  await store.clear(); assert.equal((await store.status()).configured, false); await assert.rejects(readFile(store.file), { code: 'ENOENT' });
});
test('unavailable encryption, damaged credentials and path links do not silently replace or disclose secrets', async () => {
  const { store, root, directory, cipher } = await fixture(); await store.save(input); const bytes = await readFile(store.file);
  cipher.isEncryptionAvailable = () => false; await assert.rejects(store.save({ ...input, name: 'changed' }), /加密不可用/); assert.deepEqual(await readFile(store.file), bytes);
  cipher.isEncryptionAvailable = () => true; cipher.encryptString = () => { throw new Error(input.apiKey); };
  await assert.rejects(store.save(input), e => e instanceof Error && !e.message.includes(input.apiKey)); assert.deepEqual(await readFile(store.file), bytes);
  await writeFile(store.file, 'corrupt ciphertext'); await assert.rejects(store.status(), /无法读取或解密/); await assert.rejects(store.save(input), /无法读取或解密/); assert.equal(await readFile(store.file, 'utf8'), 'corrupt ciphertext');
  await store.clear(); const outside = join(root, 'outside'); await mkdir(outside); const linked = join(root, 'linked'); await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new ModelSettings(linked, cipher).save(input), /链接/); assert.deepEqual(await readdir(outside), []); assert.deepEqual(await readdir(directory), []);
});
test('connection testing uses draft inputs or same-address stored keys without saving or exposing credentials', async () => {
  const { store } = await fixture(); let calls = 0, auth = '', requestedModel = '';
  const fetcher: typeof fetch = async (_url, options) => {
    calls++; auth = new Headers(options?.headers).get('Authorization') || ''; requestedModel = JSON.parse(options?.body as string).model;
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }));
  };
  assert.equal((await store.testConnection({ ...input, name: '' }, fetcher)).ok, true);
  assert.equal(auth, 'Bearer ' + input.apiKey); await assert.rejects(readFile(store.file), { code: 'ENOENT' });
  await store.save(input); const stored = await readFile(store.file);
  const result = await store.testConnection({ ...input, apiKey: '', model: 'unsaved-model' }, fetcher);
  assert.equal(result.ok, true); assert.equal(auth, 'Bearer ' + input.apiKey); assert.equal(requestedModel, 'unsaved-model'); assert.equal(JSON.stringify(result).includes(input.apiKey), false);
  assert.deepEqual(await readFile(store.file), stored);
  await assert.rejects(store.testConnection({ ...input, apiKey: '', baseUrl: 'https://other.example.test/v1' }, fetcher), /地址已更改/); assert.equal(calls, 2);
  assert.equal((await store.testConnection({ ...input, apiKey: undefined, withoutApiKey: true, baseUrl: 'http://localhost:11434/v1' }, fetcher)).ok, true); assert.equal(auth, ''); assert.deepEqual(await readFile(store.file), stored);
});
test('only one connectivity probe runs at once and cancellation permits a new test', async () => {
  const { store } = await fixture(); let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const fetcher: typeof fetch = async (_url, options) => {
    started(); return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  };
  const pending = store.testConnection(input, fetcher);
  await assert.rejects(store.testConnection(input, fetcher), /正在测试/); await began; store.cancelConnectionTest();
  assert.match((await pending).message, /取消/);
  const next = await store.testConnection(input, async () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })));
  assert.equal(next.ok, true); await assert.rejects(readFile(store.file), { code: 'ENOENT' });
});

test('saving to the list and selecting an active profile are independent and survive restart', async () => {
  const { store, directory, cipher } = await fixture();
  const first = await store.save({ ...input, profileId: null }, false);
  const reload = new ModelSettings(directory, cipher);
  assert.equal((await reload.status()).activeId, null);
  const selected = await reload.select(first.profiles[0].id);
  const next = await reload.save({ ...input, profileId: null, model: 'second-model' }, false);
  assert.equal(next.activeId, selected.activeId);
  const before = await readFile(reload.file);
  await assert.rejects(reload.select('absent'), /找不到/);
  await reload.select(first.profiles[0].id); assert.deepEqual(await readFile(reload.file), before);
  const switched = await reload.select(next.profiles[1].id);
  assert.deepEqual(switched.profiles, next.profiles);
  assert.deepEqual(await store.status(), switched);
});

test('legacy encrypted profile survives adding a second model, independent key reuse and restart', async () => {
  const { store, directory, cipher } = await fixture();
  await mkdir(directory);
  const legacy = { version: 1, name: input.name, model: input.model, baseUrl: 'https://models.example.test/v1', apiKey: input.apiKey, updatedAt: new Date().toISOString() };
  const bytes = cipher.encryptString(JSON.stringify(legacy));
  await writeFile(store.file, bytes);
  const first = await store.status();
  assert.equal(first.profiles.length, 1); assert.deepEqual(await readFile(store.file), bytes);
  const draft = { ...input, name: 'Second', model: 'second', profileId: null, apiKey: '' };
  await assert.rejects(store.save(draft), /请填写 API Key/);
  await assert.rejects(store.testConnection(draft, async () => { throw new Error('unexpected request'); }), /请填写 API Key/);
  const second = await store.save({ ...draft, apiKey: 'second-key' });
  assert.equal(second.profiles.length, 2); assert.notEqual(first.activeId, second.activeId);
  const reload = new ModelSettings(directory, cipher);
  assert.deepEqual(await reload.status(), second);
  const edit = { ...input, profileId: first.activeId!, apiKey: '' };
  await reload.testConnection(edit, async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + input.apiKey);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
  });
  assert.equal((await reload.status()).activeId, second.activeId);
  const switched = await reload.save(edit); assert.equal(switched.activeId, first.activeId);
  assert.ok(!JSON.stringify(switched).includes(input.apiKey) && !JSON.stringify(switched).includes('second-key'));
  const after = await readFile(store.file);
  await assert.rejects(reload.save({ ...edit, profileId: 'missing' }), /找不到/);
  assert.deepEqual(await readFile(store.file), after);
  const remaining = await reload.clear(first.activeId!);
  assert.equal(remaining.activeId, second.activeId); assert.equal(remaining.profiles.length, 1);
});
