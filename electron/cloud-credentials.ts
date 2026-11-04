import { safeStorage } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import type { CloudOptions } from './cloud-client';

/** OS-encrypted credentials stay in this machine's profile, outside the portable library. */
export function cloudCredentials(userData: string, library: string): CloudOptions['credentials'] {
  const dir = join(userData, 'cloud-sessions');
  const file = join(dir, createHash('sha256').update(library).digest('hex') + '.bin');
  const check = async () => {
    for (const path of [dir, file]) {
      try { if ((await lstat(path)).isSymbolicLink()) throw new Error('登录信息不能写入文件链接'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  };
  return {
    async read() {
      await check();
      try { return JSON.parse(safeStorage.decryptString(await readFile(file))); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    },
    async write(value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法保存登录，请检查系统密钥服务');
      await check(); await mkdir(dir, { recursive: true });
      const tmp = join(dir, randomUUID() + '.tmp');
      try { await writeFile(tmp, safeStorage.encryptString(JSON.stringify(value)), { flag: 'wx', mode: 0o600 }); await rename(tmp, file); }
      finally { await unlink(tmp).catch(() => {}); }
    },
    async clear() { await check(); try { await unlink(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } },
  };
}
