/** Desktop-only note editing. Revisions identify exact UTF-8 file bytes. */
export interface MarkdownDocument {
  id: string;
  content: string;
  revision: string;
  fileName: string;
  path: string;
}
export interface MarkdownUpdate { content: string; revision: string }
export const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024;

export function validateMarkdownUpdate(value: MarkdownUpdate) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['content', 'revision'].includes(key))
    || typeof value.content !== 'string' || typeof value.revision !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.revision)) throw new Error('Markdown 保存数据格式无效');
  if (value.content.includes('\0')) throw new Error('Markdown 笔记不能包含二进制内容');
  if (value.content.length > MAX_MARKDOWN_BYTES) throw new Error('Markdown 笔记不能超过 10 MB');
  // Reject lone surrogates rather than silently replacing user text during encoding.
  for (let index = 0; index < value.content.length; index++) {
    const code = value.content.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.content.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Markdown 文字编码无效');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Markdown 文字编码无效');
  }
  if (new TextEncoder().encode(value.content).length > MAX_MARKDOWN_BYTES) throw new Error('Markdown 笔记不能超过 10 MB');
}
