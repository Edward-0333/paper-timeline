import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Library } from './library';
import { MODEL_CHAT_LIMITS, type ChatCompaction, type ModelChatHistory, type StoredChatMessage } from '../shared/model-chat';
import { assertRegularFile, assertSafeDirectory } from './paper-storage';

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024, MAX_CONTEXT_BYTES = 256 * 1024;
const source = z.object({ id: z.string().max(300), label: z.string().max(500),
  url: z.string().max(2048).refine(value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/[\x00-\x20\x7f]/.test(value); }
    catch { return false; }
  }).optional(),
  retrievedAt: z.string().max(40).refine(value => Number.isFinite(Date.parse(value))).optional(),
  kind: z.enum(['web-search', 'web-page']).optional(),
}).strict();
const activity = z.object({ tool: z.string().max(80), label: z.string().max(100), status: z.enum(['succeeded', 'failed']) }).strict();
const message = z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(MODEL_CHAT_LIMITS.messageCharacters), sources: z.array(source).max(100).optional(), activity: z.array(activity).max(24).optional() }).strict();
// Keep the original format readable. Its limits now protect local storage, not the model window.
const archiveSchema = z.object({ version: z.literal(1), messages: z.array(message).max(MODEL_CHAT_LIMITS.messages) }).strict()
  .refine(value => value.messages.reduce((n, item) => n + item.content.length, 0) <= MODEL_CHAT_LIMITS.totalCharacters);
const compactionSchema = z.object({
  version: z.literal(1), paperId: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().min(1).max(12000).refine(value => !!value.trim() && !value.includes('\0')),
  coveredMessages: z.number().int().min(0).max(MODEL_CHAT_LIMITS.messages),
  prefixHash: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.string().max(40).refine(value => Number.isFinite(Date.parse(value))),
  model: z.string().min(1).max(256).refine(value => !!value.trim() && !/[\x00-\x1f\x7f]/.test(value)),
}).strict();
const sameMessage = (a: StoredChatMessage, b: StoredChatMessage) => a.role === b.role && a.content === b.content;
function prefixHash(messages: StoredChatMessage[], count: number) {
  return createHash('sha256').update(JSON.stringify(messages.slice(0, count).map(({ role, content }) => ({ role, content })))).digest('hex');
}
async function regular(path: string, allowMissing = false) {
  await assertRegularFile(path, allowMissing);
  try { if ((await lstat(path)).nlink > 1) throw new Error('对话资料不能使用文件链接'); }
  catch (error) { if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function readJson(path: string, maxBytes: number) {
  await regular(path);
  if ((await lstat(path)).size > maxBytes) throw new Error('large');
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw new Error('large');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
async function readArchive(path: string): Promise<StoredChatMessage[] | null> {
  try { return archiveSchema.parse(await readJson(path, MAX_ARCHIVE_BYTES)).messages; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('对话记录无法读取，请保留 chat.json 并检查备份。'); }
}
async function readCompaction(path: string, paperId: string): Promise<ChatCompaction | null> {
  try {
    const raw = await readJson(path, MAX_CONTEXT_BYTES);
    // Explicit clear writes a null marker, preserving the previous summary in .bak.
    if (raw === null) return null;
    const state = compactionSchema.parse(raw);
    if (state.paperId !== paperId) throw new Error('wrong-paper');
    return state;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('上下文摘要无法读取，请保留 chat-context.json 并检查备份。'); }
}
async function atomicWrite(path: string, value: unknown, maxBytes: number) {
  const body = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(body, 'utf8') > maxBytes) throw new Error('聊天存档过大，原记录已保留。');
  await assertSafeDirectory(dirname(path)); await regular(path, true); await regular(path + '.bak', true);
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, body, { flag: 'wx' });
    try { await copyFile(path, path + '.bak'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Complete text/provenance archive plus a separately replaceable, paper-scoped summary. */
export class PaperChatStore {
  private writes = new Map<string, Promise<unknown>>();
  constructor(private library: Pick<Library, 'get' | 'paperDirectory'> & Partial<Pick<Library, 'refreshAiIndex'>>) {}
  private path(id: string, context = false) { this.library.get(id); return join(this.library.paperDirectory(id), context ? 'chat-context.json' : 'chat.json'); }
  private serialize<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.writes.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    this.writes.set(id, next);
    void next.finally(() => { if (this.writes.get(id) === next) this.writes.delete(id); }).catch(() => {});
    return next;
  }
  async load(id: string): Promise<ModelChatHistory> {
    await this.writes.get(id)?.catch(() => {});
    return { messages: await readArchive(this.path(id)) ?? [] };
  }
  save(id: string, messages: StoredChatMessage[]) {
    const snapshot = structuredClone(messages);
    return this.serialize(id, async () => {
      archiveSchema.parse({ version: 1, messages: snapshot });
      const path = this.path(id), prior = await readArchive(path);
      if (prior) {
        // An old reader/session must never overwrite a longer or divergent archive.
        // Clearing has a separate explicit operation and never uses this path.
        if (snapshot.length < prior.length || prior.some((old, index) => !sameMessage(old, snapshot[index]))) {
          throw new Error('对话记录已更新，未覆盖历史。请重新打开当前论文的聊天后继续。');
        }
        prior.forEach((old, index) => {
          snapshot[index].sources ??= old.sources; snapshot[index].activity ??= old.activity;
        });
        if (JSON.stringify(prior) === JSON.stringify(snapshot)) return;
      }
      await atomicWrite(path, { version: 1, messages: snapshot }, MAX_ARCHIVE_BYTES);
      await this.library.refreshAiIndex?.(id);
    });
  }
  async loadCompaction(id: string): Promise<ChatCompaction | null> {
    await this.writes.get(id)?.catch(() => {});
    const state = await readCompaction(this.path(id, true), id);
    if (!state || state.coveredMessages === 0) return null;
    const messages = await readArchive(this.path(id)) ?? [];
    if (state.coveredMessages > messages.length || prefixHash(messages, state.coveredMessages) !== state.prefixHash) return null;
    return state;
  }
  saveCompaction(id: string, input: ChatCompaction) {
    const snapshot = structuredClone(input);
    return this.serialize(id, async () => {
      const state = compactionSchema.parse(snapshot);
      if (state.paperId !== id) throw new Error('摘要不属于当前论文，未保存。');
      const path = this.path(id, true), prior = await readCompaction(path, id);
      const messages = await readArchive(this.path(id)) ?? [];
      if (!state.coveredMessages || state.coveredMessages > messages.length || prefixHash(messages, state.coveredMessages) !== state.prefixHash) {
        throw new Error('摘要与聊天记录不一致，未保存。');
      }
      if (prior && prior.coveredMessages > state.coveredMessages && prior.coveredMessages <= messages.length
        && prefixHash(messages, prior.coveredMessages) === prior.prefixHash) throw new Error('已有更新的上下文摘要，未覆盖。');
      if (JSON.stringify(prior) === JSON.stringify(state)) return;
      await atomicWrite(path, state, MAX_CONTEXT_BYTES);
      await this.library.refreshAiIndex?.(id);
    });
  }
  clear(id: string) {
    return this.serialize(id, async () => {
      const path = this.path(id), contextPath = this.path(id, true);
      // Check every destination first. A broken transcript is never silently replaced.
      await readArchive(path);
      for (const file of [path, path + '.bak', contextPath, contextPath + '.bak']) await regular(file, true);
      // Invalidate the summary first. If clearing the archive fails, its full history remains.
      // An interrupted clear can never apply an old summary to a new conversation.
      await atomicWrite(contextPath, null, MAX_CONTEXT_BYTES);
      await atomicWrite(path, { version: 1, messages: [] }, MAX_ARCHIVE_BYTES);
      await this.library.refreshAiIndex?.(id);
    });
  }
  async whenIdle() { await Promise.allSettled([...this.writes.values()]); }
}
