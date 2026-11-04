import { lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Library } from './library';
import { mineruResultPath, readMineruResult } from './mineru';
import type { ModelChatContext } from '../shared/model-chat';
import { paperStoragePaths } from './paper-storage';

/** Inspect registered paths only; never read PDF, Markdown or annotation contents. */
export async function getModelChatContext(library: Pick<Library, 'directory' | 'get'>, paperId: string): Promise<ModelChatContext> {
  if (typeof paperId !== 'string' || !/^[a-f0-9]{64}$/.test(paperId)) throw new Error('无效论文编号');
  const paper = library.get(paperId), directory = resolve(library.directory);
  const paths = paperStoragePaths(directory, paper);
  const hash = paper.pdfHash === undefined ? paper.id : paper.pdfHash;
  const present = async (path: string): Promise<string | null> => {
    try {
      for (const parent of paper.storageFolder ? [join(directory, 'papers'), paths.directory, dirname(path)] : [dirname(path)]) {
        const dir = await lstat(parent); if (!dir.isDirectory() || dir.isSymbolicLink()) return null;
      }
      const stat = await lstat(path);
      return stat.isFile() && !stat.isSymbolicLink() ? path : null;
    } catch { return null; }
  };
  const [pdf, markdown, annotations] = await Promise.all([
    hash && /^[a-f0-9]{64}$/.test(hash) && paths.pdf ? present(paths.pdf) : null,
    paper.markdownNote ? present(paths.markdown) : null,
    present(paths.annotations),
  ]);
  let parsedDirectory: string | null = null;
  if (pdf) {
    try {
      const result = await readMineruResult(directory, paperId, paper.storageFolder);
      if (result && result.pdfHash === hash) {
        // Only the published successful run is relevant, not old runs or a partial conversion.
        await mineruResultPath(directory, paperId, result, 'markdown', paper.storageFolder);
        await mineruResultPath(directory, paperId, result, 'json', paper.storageFolder);
        parsedDirectory = await mineruResultPath(directory, paperId, result, 'directory', paper.storageFolder);
      }
    } catch { /* A missing or damaged optional output is unavailable, not a reason to stop ordinary chat. */ }
  }
  return { paperId, paperTitle: paper.title, workingDirectory: paths.directory, files: { pdf, markdown, annotations, parsedDirectory } };
}
