import { memo, useState } from 'react';
import { Streamdown, type PluginConfig } from 'streamdown';
import { code } from '@streamdown/code';
import { createMathPlugin } from '@streamdown/math';
import { cjk } from '@streamdown/cjk';
import { normalizeChatMath } from './chat-math';
// Chromium needs @font-face in the document, even when the formula is in a shadow root.
import 'katex/dist/katex.min.css';

const plugins: PluginConfig = { code, cjk, math: createMathPlugin({ singleDollarTextMath: true, errorColor: '#a45446' }) };
const translations = { copyCode: '复制代码', copyTable: '复制表格', copyTableAsMarkdown: '复制为 Markdown',
  copyTableAsCsv: '复制为 CSV', copyTableAsTsv: '复制为 TSV', copied: '已复制', close: '关闭', viewFullscreen: '全屏查看', exitFullscreen: '退出全屏' };

/** Model output is data. Permit web links and local footnotes; never load model-supplied images or HTML. */
export function chatMarkdownUrl(value: string): string {
  if (value.startsWith('#')) return value;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : '';
  } catch { return ''; }
}

const ChatMarkdown = memo(function ChatMarkdown({ content }: { content: string }) {
  const [error, setError] = useState('');
  return <div className="reader-ai-markdown">
    <Streamdown mode="static" prefix="ptmd" plugins={plugins} translations={translations} skipHtml urlTransform={chatMarkdownUrl}
      controls={{ code: { copy: true, download: false }, table: { copy: false, download: false, fullscreen: false } }}
      codeBlockMaxHeight={360} tableMaxHeight={360} lineNumbers={false} components={{
      a: ({ href, children, title }) => href ? <a href={href} title={title || href} rel="noreferrer" onAuxClick={event => event.preventDefault()} onClick={event => {
        event.preventDefault(); event.stopPropagation();
        if (href.startsWith('#')) {
          const scope = event.currentTarget.closest('.reader-ai-markdown');
          try { scope?.querySelector<HTMLElement>('#' + CSS.escape(decodeURIComponent(href.slice(1))))?.scrollIntoView({ block: 'nearest' }); } catch { /* Invalid footnote target. */ }
        } else {
          setError(''); void window.paperApi!.openChatLink(href).catch(() => setError('无法打开链接，请复制地址后在浏览器打开。'));
        }
      }}>{children}</a> : <span>{children}</span>,
      img: ({ alt }) => <span className="reader-ai-image-label">[图片{alt ? `：${alt}` : ''}]</span>,
    }}>{normalizeChatMath(content)}</Streamdown>
    {error && <p className="reader-ai-link-error" role="alert">{error}</p>}
  </div>;
});
export default ChatMarkdown;
