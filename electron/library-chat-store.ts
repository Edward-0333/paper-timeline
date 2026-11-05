import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Library } from './library';
import { PaperChatStore } from './paper-chat-store';
import { assertRegularFile, assertSafeDirectory } from './paper-storage';
import { LIBRARY_CHAT_ID, type LibraryConversation, type LibraryConversationList } from '../shared/library-chat';
import { MODEL_CHAT_LIMITS, type ChatCompaction, type StoredChatMessage } from '../shared/model-chat';

const ID = /^[a-f0-9]{64}$/;
const MAX_SESSIONS = 10000, MAX_INDEX_BYTES = 4 * 1024 * 1024;
const ARCHIVE_FILES = ['chat.json', 'chat.json.bak', 'chat-context.json', 'chat-context.json.bak'] as const;
const date = z.string().max(40).refine(value => Number.isFinite(Date.parse(value)));
const entrySchema = z.object({ id: z.string().regex(ID), title: z.string().min(1).max(80), createdAt: date, updatedAt: date,
  messageCount: z.number().int().min(0).max(MODEL_CHAT_LIMITS.messages), customTitle: z.boolean().optional() }).strict();
const indexSchema = z.object({ version: z.literal(1), activeId: z.string().regex(ID).nullable(), conversations: z.array(entrySchema).max(MAX_SESSIONS),
  pendingDeletionIds: z.array(z.string().regex(ID)).max(MAX_SESSIONS).optional() }).strict()
  .refine(value => {
    const ids = new Set(value.conversations.map(entry => entry.id)), pending = value.pendingDeletionIds ?? [];
    return ids.size === value.conversations.length && (ids.size ? value.activeId !== null && ids.has(value.activeId) : value.activeId === null)
      && new Set(pending).size === pending.length && pending.every(id => !ids.has(id));
  });
type SessionIndex = z.infer<typeof indexSchema>;
type SessionEntry = SessionIndex['conversations'][number];
function validId(id: string) { if (typeof id !== 'string' || !ID.test(id)) throw new Error('无效文献库会话编号'); }
function publicEntry({ customTitle: _customTitle, ...entry }: SessionEntry): LibraryConversation { return { ...entry }; }
function titleFrom(messages: StoredChatMessage[]) {
  const text = messages.find(message => message.role === 'user')?.content.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '新会话';
  let title = '';
  for (const character of text) { if (title.length + character.length > 80) break; title += character; }
  return title;
}
async function regular(path: string, allowMissing = false) {
  await assertRegularFile(path, allowMissing);
  try { if ((await lstat(path)).nlink > 1) throw new Error('会话索引不能使用文件链接'); }
  catch (error) { if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** Independent library conversations. Legacy files are registered in place, never moved or rewritten on discovery. */
export class LibraryChatStore {
  readonly directory: string;
  private readonly archive: PaperChatStore;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(libraryDirectory: string) {
    this.directory = join(libraryDirectory, 'assistant');
    this.archive = new PaperChatStore({
      get: (id: string) => { validId(id); return { id }; },
      paperDirectory: (id: string) => this.conversationDirectory(id),
    } as unknown as Pick<Library, 'get' | 'paperDirectory'>);
  }
  get indexPath() { return join(this.directory, 'sessions.json'); }
  conversationDirectory(id: string) {
    validId(id);
    return id === LIBRARY_CHAT_ID ? this.directory : join(this.directory, 'conversations', id);
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writes.catch(() => {}).then(fn); this.writes = next; return next;
  }
  private async prepare(path = this.directory) {
    await assertSafeDirectory(path); await mkdir(path, { recursive: true }); await assertSafeDirectory(path);
  }
  private async writeIndex(index: SessionIndex) {
    indexSchema.parse(index);
    const body = JSON.stringify(index, null, 2);
    if (Buffer.byteLength(body) > MAX_INDEX_BYTES) throw new Error('会话列表过大，现有记录已保留。');
    await this.prepare(); await regular(this.indexPath, true); await regular(this.indexPath + '.bak', true);
    const temporary = this.indexPath + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, body, { flag: 'wx' });
      try { await copyFile(this.indexPath, this.indexPath + '.bak'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await rename(temporary, this.indexPath);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  private async readIndex(): Promise<SessionIndex | null> {
    try {
      await regular(this.indexPath);
      if ((await lstat(this.indexPath)).size > MAX_INDEX_BYTES) throw new Error('large');
      const bytes = await readFile(this.indexPath);
      if (bytes.length > MAX_INDEX_BYTES) throw new Error('large');
      return indexSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('会话列表无法读取，请保留 assistant/sessions.json 并检查备份，现有会话未被覆盖。');
    }
  }
  private async ensureIndex(): Promise<SessionIndex> {
    const existing = await this.readIndex();
    if (existing) return existing;
    // Missing a previously published index must not silently hide newer conversations.
    await regular(this.indexPath + '.bak', true);
    let backupExists = false, hasConversationDirectories = false;
    try { await lstat(this.indexPath + '.bak'); backupExists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const conversationsPath = join(this.directory, 'conversations');
    await assertSafeDirectory(conversationsPath);
    try { hasConversationDirectories = (await readdir(conversationsPath)).length > 0; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (backupExists || hasConversationDirectories) throw new Error('会话列表缺失，请保留 assistant 文件夹并从 sessions.json.bak 恢复，未重新创建列表。');
    let messages: StoredChatMessage[] = [], brokenLegacy = false;
    try { messages = (await this.archive.load(LIBRARY_CHAT_ID)).messages; }
    catch { brokenLegacy = true; }
    let updatedAt = new Date().toISOString();
    try { updatedAt = (await lstat(join(this.directory, 'chat.json'))).mtime.toISOString(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const entry: SessionEntry = { id: LIBRARY_CHAT_ID, title: brokenLegacy ? '历史会话（记录待检查）' : titleFrom(messages),
      createdAt: updatedAt, updatedAt, messageCount: messages.length };
    const index: SessionIndex = { version: 1, activeId: entry.id, conversations: [entry] };
    await this.writeIndex(index); return index;
  }
  private find(index: SessionIndex, id: string) {
    validId(id);
    const entry = index.conversations.find(item => item.id === id);
    if (!entry) throw new Error('找不到这条会话，请刷新会话历史。');
    return entry;
  }
  private async checkArchive(entry: SessionEntry) {
    if (!entry.messageCount) return;
    try { await regular(join(this.conversationDirectory(entry.id), 'chat.json')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('会话记录缺失，请保留 chat.json.bak 并检查资料目录，未创建空记录覆盖历史。');
      throw error;
    }
  }
  private listing(index: SessionIndex): LibraryConversationList {
    return { activeId: index.activeId, conversations: index.conversations.map(publicEntry)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)),
      ...(index.pendingDeletionIds?.length ? { cleanupWarning: '会话已从历史中删除，但部分记录文件尚未清理完成。解除文件占用或路径异常后，重新打开会话历史将自动重试。' } : {}) };
  }
  private async checkDeletionFiles(id: string) {
    const directory = this.conversationDirectory(id);
    await assertSafeDirectory(directory);
    for (const name of ARCHIVE_FILES) await regular(join(directory, name), true);
  }
  private async purgeConversation(id: string) {
    // Never remove the session directory: the legacy one also owns the index and all newer sessions,
    // and either kind can contain files placed there by the user.
    await this.checkDeletionFiles(id);
    for (const name of ARCHIVE_FILES) {
      const path = join(this.conversationDirectory(id), name);
      await regular(path, true);
      try { await unlink(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  private async finishDeletions(index: SessionIndex): Promise<SessionIndex> {
    const pending = index.pendingDeletionIds ?? [], remaining: string[] = [];
    if (!pending.length) return index;
    for (const id of pending) {
      try { await this.purgeConversation(id); }
      catch { remaining.push(id); }
    }
    if (remaining.length === pending.length) return index;
    const completed = { ...index };
    if (remaining.length) completed.pendingDeletionIds = remaining;
    else delete completed.pendingDeletionIds;
    try { await this.writeIndex(completed); return completed; }
    // The deletion is already committed. Retain its durable cleanup queue and report a warning,
    // rather than telling the UI that deletion failed or reintroducing removed conversations.
    catch { return index; }
  }
  list() { return this.serialize(async () => this.listing(await this.finishDeletions(await this.ensureIndex()))); }
  remove(id: string) {
    validId(id);
    return this.serialize(async () => {
      const index = await this.ensureIndex(); this.find(index, id);
      await this.checkDeletionFiles(id);
      const rows = this.listing(index).conversations, position = rows.findIndex(entry => entry.id === id);
      const remaining = rows.filter(entry => entry.id !== id);
      const next: SessionIndex = { ...index, conversations: index.conversations.filter(entry => entry.id !== id),
        activeId: index.activeId === id ? remaining[Math.min(position, remaining.length - 1)]?.id ?? null : index.activeId,
        pendingDeletionIds: [...(index.pendingDeletionIds ?? []), id] };
      // Publish intent before touching any archive. A crash before publication leaves everything
      // intact; a crash afterwards is recovered by the bounded cleanup queue on the next list().
      await this.writeIndex(next);
      return this.listing(await this.finishDeletions(next));
    });
  }
  create() {
    return this.serialize(async () => {
      const index = await this.ensureIndex();
      if (index.conversations.length >= MAX_SESSIONS) throw new Error('会话数量已达到保存上限，现有会话仍可继续使用。');
      await this.prepare(join(this.directory, 'conversations'));
      let id: string;
      for (;;) {
        id = randomBytes(32).toString('hex');
        if (id === LIBRARY_CHAT_ID || index.conversations.some(entry => entry.id === id) || index.pendingDeletionIds?.includes(id)) continue;
        try { await mkdir(this.conversationDirectory(id)); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      const now = new Date().toISOString(), entry: SessionEntry = { id, title: '新会话', createdAt: now, updatedAt: now, messageCount: 0 };
      await this.writeIndex({ ...index, activeId: id, conversations: [...index.conversations, entry] });
      return publicEntry(entry);
    });
  }
  select(id: string) {
    validId(id);
    return this.serialize(async () => {
      const index = await this.ensureIndex(); this.find(index, id);
      if (index.activeId !== id) { index.activeId = id; await this.writeIndex(index); }
      return this.listing(index);
    });
  }
  rename(id: string, title: string) {
    validId(id);
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(title)) return Promise.reject(new Error('会话标题需为 1–80 个字符，不能包含控制字符。'));
    return this.serialize(async () => {
      const index = await this.ensureIndex(), entry = this.find(index, id);
      entry.title = title.trim(); entry.customTitle = true; await this.writeIndex(index); return publicEntry(entry);
    });
  }
  load(id = LIBRARY_CHAT_ID) {
    validId(id);
    return this.serialize(async () => { await this.checkArchive(this.find(await this.ensureIndex(), id)); return this.archive.load(id); });
  }
  loadCompaction(id = LIBRARY_CHAT_ID) {
    validId(id);
    return this.serialize(async () => { await this.checkArchive(this.find(await this.ensureIndex(), id)); return this.archive.loadCompaction(id); });
  }
  save(messages: StoredChatMessage[], id = LIBRARY_CHAT_ID) {
    validId(id); const snapshot = structuredClone(messages);
    return this.serialize(async () => {
      const index = await this.ensureIndex(), entry = this.find(index, id);
      await this.checkArchive(entry);
      await this.prepare(this.conversationDirectory(id));
      await this.archive.save(id, snapshot);
      entry.messageCount = snapshot.length; entry.updatedAt = new Date().toISOString();
      if (!entry.customTitle) entry.title = titleFrom(snapshot);
      await this.writeIndex(index);
    });
  }
  saveCompaction(state: ChatCompaction, id = state.paperId) {
    validId(id); const snapshot = structuredClone(state);
    return this.serialize(async () => {
      await this.checkArchive(this.find(await this.ensureIndex(), id)); await this.prepare(this.conversationDirectory(id)); await this.archive.saveCompaction(id, snapshot);
    });
  }
  clear(id = LIBRARY_CHAT_ID) {
    validId(id);
    return this.serialize(async () => {
      const index = await this.ensureIndex(), entry = this.find(index, id);
      await this.checkArchive(entry);
      await this.prepare(this.conversationDirectory(id)); await this.archive.clear(id);
      entry.messageCount = 0; entry.updatedAt = new Date().toISOString(); if (!entry.customTitle) entry.title = '新会话';
      await this.writeIndex(index);
    });
  }
  async whenIdle() { await this.writes.catch(() => {}); await this.archive.whenIdle(); }
}
