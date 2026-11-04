import { build } from 'esbuild';
import { build as buildRenderer } from 'vite';
import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { buildChatStyles } from './chat-styles.mjs';
await buildChatStyles();
await build({
  entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts', 'pdf-worker': 'electron/pdf-worker.ts', 'agent-page-worker': 'electron/agent-page-worker.ts' },
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external',
  outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, sourcemap: true,
});
await buildRenderer();
// Vditor's source editor loads its parser, Chinese UI and toolbar icons locally.
// Its HTML preview and optional renderers remain disabled in the notes editor.
for (const relative of ['js/lute/lute.min.js', 'js/i18n/zh_CN.js', 'js/icons/ant.js']) {
  const destination = `dist/vendor/vditor/dist/${relative}`;
  await mkdir(destination.slice(0, destination.lastIndexOf('/')), { recursive: true });
  await copyFile(`node_modules/vditor/dist/${relative}`, destination);
}
await mkdir('dist/vendor/vditor/licenses', { recursive: true });
await copyFile('node_modules/vditor/LICENSE', 'dist/vendor/vditor/licenses/vditor-MIT.txt');
await copyFile('node_modules/diff-match-patch/LICENSE', 'dist/vendor/vditor/licenses/diff-match-patch-Apache-2.0.txt');
for (const name of await readdir('third_party/note-licenses')) {
  await copyFile(`third_party/note-licenses/${name}`, `dist/vendor/vditor/licenses/${name}`);
}
// Reader assets are served locally; no CDN or external fonts are used at runtime.
await mkdir('dist/reader-assets/licenses', { recursive: true });
await copyFile('node_modules/@embedpdf/snippet/dist/pdfium.wasm', 'dist/reader-assets/pdfium.wasm');
await copyFile('node_modules/@embedpdf/fonts-sc/fonts/NotoSansHans-Regular.otf', 'dist/reader-assets/NotoSansHans-Regular.otf');
for (const entry of await readdir('node_modules/@embedpdf', { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  for (const file of await readdir(`node_modules/@embedpdf/${entry.name}`)) {
    if (/^LICENSE(?:\..*)?$/.test(file)) await copyFile(`node_modules/@embedpdf/${entry.name}/${file}`, `dist/reader-assets/licenses/${entry.name}-${file}.txt`);
  }
}
