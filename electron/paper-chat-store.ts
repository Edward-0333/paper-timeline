import { randomUUID } from 'node:crypto';
import { copyFile, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Library } from './library';
import type { ModelChatHistory, StoredChatMessage } from '../shared/model-chat';
import { assertRegularFile, assertSafeDirectory } from './paper-storage';

const source = z.object({ id: z.string().max(300), label: z.string().max(500) }).strict();
const activity = z.object({ tool: z.string().max(80), label: z.string().max(100), status: z.enum(['succeeded', 'failed']) }).strict();
const message = z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(20000), sources: z.array(source).max(100).optional(), activity: z.array(activity).max(24).optional() }).strict();
const schema = z.object({ version: z.literal(1), messages: z.array(message).max(64) }).strict();
/** Only text and provenance are persisted. No raw tool results, image bytes or credentials. */
export class PaperChatStore {
  private writes = new Map<string, Promise<unknown>>();
  constructor(private library: Pick<Library, 'get' | 'paperDirectory'> & Partial<Pick<Library, 'refreshAiIndex'>>) {}
  private path(id: string) { this.library.get(id); return join(this.library.paperDirectory(id), 'chat.json'); }
  async load(id: string): Promise<ModelChatHistory> {
    await this.writes.get(id)?.catch(() => {}); const path = this.path(id);
    try {
      await assertRegularFile(path); if ((await lstat(path)).size > 2 * 1024 * 1024) throw new Error('large');
      const parsed = schema.parse(JSON.parse(await readFile(path, 'utf8')));
      if (parsed.messages.reduce((n, item) => n + item.content.length, 0) > 100000) throw new Error('large');
      return { messages: parsed.messages };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { messages: [] }; throw new Error('对话记录无法读取，请保留 chat.json 并检查备份。'); }
  }
  save(id: string, messages: StoredChatMessage[]) {
    const snapshot = structuredClone(messages);
    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      while (snapshot.length > 64 || snapshot.reduce((n, item) => n + item.content.length, 0) > 100000) snapshot.splice(0, Math.min(2, snapshot.length));
      schema.parse({ version: 1, messages: snapshot });
      const path = this.path(id), temporary = path + '.' + randomUUID() + '.tmp';
      await assertSafeDirectory(join(path, '..')); await assertRegularFile(path, true); await assertRegularFile(path + '.bak', true);
      // Refuse to replace a damaged existing transcript.
      try {
        const prior = schema.parse(JSON.parse(await readFile(path, 'utf8')));
        snapshot.forEach((item, index) => {
          const old = prior.messages[index];
          if (old?.role === item.role && old.content === item.content) {
            item.sources ??= old.sources; item.activity ??= old.activity;
          }
        });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('对话记录损坏，未覆盖原文件。'); }
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, messages: snapshot }, null, 2), { flag: 'wx' });
        try { await copyFile(path, path + '.bak'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await rename(temporary, path);
        await this.library.refreshAiIndex?.(id);
      } finally { await unlink(temporary).catch(() => {}); }
    });
    this.writes.set(id, next);
    void next.finally(() => { if (this.writes.get(id) === next) this.writes.delete(id); }).catch(() => {});
    return next;
  }
  async whenIdle() { await Promise.allSettled([...this.writes.values()]); }
}
