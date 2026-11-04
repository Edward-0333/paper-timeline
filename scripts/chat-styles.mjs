import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Only Streamdown gets these utilities. Prefixes avoid collisions with the
// PDF viewer's Tailwind styles inside its shadow root; no preflight is added.
export async function buildChatStyles() {
  const css = await readFile('src/ChatMarkdown.css', 'utf8');
  const compiler = await compile(css, { base: resolve('src'), onDependency() {} });
  const scanner = new Scanner({ sources: ['streamdown', '@streamdown/code', '@streamdown/math', '@streamdown/cjk'].map(name => ({
    base: resolve('node_modules', name, 'dist'), pattern: '*.js', negated: false,
  })) });
  await mkdir('.generated', { recursive: true });
  await writeFile('.generated/streamdown.css', compiler.build(scanner.scan().map(candidate => 'ptmd:' + candidate)));
}
