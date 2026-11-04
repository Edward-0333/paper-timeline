// Explicit offline maintenance entry point. Uses the same validated migration as app startup.
import { lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { readStoredLibrary } from '../electron/library';
import { LEGACY_INDEX_BACKUP, migratePaperStorage } from '../electron/paper-migration';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--library' || !isAbsolute(args[1])) {
  throw new Error('用法：node --import tsx scripts/migrate-paper-folders.ts --library <完整文献库路径>；执行前关闭 Paper Timeline。');
}
const directory = resolve(args[1]);
try {
  await lstat(join(directory, '.ai-session.json'));
  throw new Error('文献库仍有桌面会话，请关闭 Paper Timeline 后再迁移。');
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const before = await readStoredLibrary(directory);
if (before.papers.some(paper => ['queued', 'extracting', 'searching'].includes(paper.status))) {
  throw new Error('文献库存在未完成的检索，请使用桌面启动流程迁移并恢复任务。');
}
await migratePaperStorage(directory, before);
const after = await readStoredLibrary(directory);
if (after.version !== 2 || after.papers.length !== before.papers.length) throw new Error('迁移后的索引核对失败，请保留所有文件并检查备份。');
console.log(JSON.stringify({ directory, previousVersion: before.version, version: after.version,
  papers: after.papers.length, pdfs: after.papers.filter(p => p.pdfHash !== null).length,
  notes: after.papers.filter(p => p.markdownNote).length,
  ...(before.version === 1 ? { originalIndexBackup: join(directory, LEGACY_INDEX_BACKUP), originalTreesRetained: true } : {}),
}, null, 2));
