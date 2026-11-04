import { memo, useState } from 'react';
import { Streamdown, type PluginConfig } from 'streamdown';
import { code } from '@streamdown/code';
import { createMathPlugin } from '@streamdown/math';
import { cjk } from '@streamdown/cjk';
import { chatMarkdownUrl } from './ChatMarkdown';
import { normalizeChatMath } from './chat-math';
import '../.generated/streamdown.css';
import 'katex/dist/katex.min.css';

const plugins: PluginConfig = { code, cjk, math: createMathPlugin({ singleDollarTextMath: true, errorColor: '#a45446' }) };
const translations = { copyCode: '复制代码', copyTable: '复制表格', copied: '已复制', close: '关闭', viewFullscreen: '全屏查看', exitFullscreen: '退出全屏' };

/** Notes are untrusted Markdown. Images are represented without loading a local or remote URL. */
const NoteMarkdown = memo(function NoteMarkdown({ content }: { content: string }) {
  const [error, setError] = useState('');
  // Display leading YAML as document properties rather than Markdown headings.
  // This is a read-only view; the exact original text remains in the editor.
  const frontmatter = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);
  const body = frontmatter ? content.slice(frontmatter[0].length) : content;
  return <div className="note-markdown">
    {frontmatter && <details className="note-frontmatter"><summary>文档属性（YAML）</summary><pre>{frontmatter[1]}</pre></details>}
    <Streamdown mode="static" prefix="ptmd" plugins={plugins} translations={translations} skipHtml urlTransform={chatMarkdownUrl}
      controls={{ code: { copy: true, download: false }, table: { copy: false, download: false, fullscreen: false } }}
      codeBlockMaxHeight={480} tableMaxHeight={480} lineNumbers={false} components={{
        a: ({ href, children, title }) => href ? <a href={href} title={title || href} rel="noreferrer" onAuxClick={event => event.preventDefault()} onClick={event => {
          event.preventDefault(); event.stopPropagation();
          if (href.startsWith('#')) {
            try { event.currentTarget.closest('.note-markdown')?.querySelector<HTMLElement>('#' + CSS.escape(decodeURIComponent(href.slice(1))))?.scrollIntoView({ block: 'nearest' }); } catch { /* Invalid anchor. */ }
          } else {
            setError(''); void window.paperApi!.openChatLink(href).catch(() => setError('无法打开链接，请复制地址后在浏览器打开。'));
          }
        }}>{children}</a> : <span>{children}</span>,
        img: ({ alt }) => <span className="note-image-placeholder" title="笔记图片附件暂不加载，图片引用仍保留在 Markdown 中。">[图片{alt ? `：${alt}` : ''}]</span>,
      }}>{normalizeChatMath(body)}</Streamdown>
    {error && <p className="note-link-error" role="alert">{error}</p>}
  </div>;
});
export default NoteMarkdown;
