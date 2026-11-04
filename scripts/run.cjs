const { spawn, spawnSync } = require('node:child_process');
const { join, dirname } = require('node:path');
const { homedir } = require('node:os');
const fs = require('node:fs');
const bundled = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe');
const version = Number(process.versions.node.split('.')[0]);
const runtime = version >= 22 ? process.execPath : fs.existsSync(bundled) ? bundled : null;
if (!runtime) { console.error('Please install Node.js 22.16+ (recommended: Node.js 24 LTS).'); process.exit(1); }
const command = process.argv[2] || 'start';
const env = { ...process.env, NODE_USE_ENV_PROXY: '1', PATH: dirname(runtime) + require('node:path').delimiter + process.env.PATH };
delete env.ELECTRON_RUN_AS_NODE;
function run(args) {
  const r = spawnSync(runtime, args, { env, stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) process.exit(r.status || 1);
}
const bin = (p) => join('node_modules', p);
if (command === 'typecheck') run([bin('typescript/bin/tsc')]);
else if (command === 'test') run(['--import', 'tsx', '--test', 'tests/library-ai-index.test.ts', 'tests/paper-experience.test.ts', 'tests/metadata.test.ts', 'tests/library.test.ts', 'tests/storage-path.test.ts', 'tests/storage-settings.test.ts', 'tests/publication-date.test.ts', 'tests/timeline-layout.test.ts', 'tests/tag-layout.test.ts', 'tests/paper-tags.test.ts', 'tests/timelines.test.ts', 'tests/ai-api.test.ts', 'tests/notes.test.ts', 'tests/paper-files.test.ts', 'tests/citations.test.ts', 'tests/citation-library.test.ts', 'tests/ratings.test.ts', 'tests/citation-monitor.test.ts', 'tests/reader.test.ts', 'tests/reader-zoom.test.ts', 'tests/mineru.test.ts', 'tests/model-settings.test.ts', 'tests/model-connectivity.test.ts', 'tests/model-chat.test.ts', 'tests/paper-storage.test.ts', 'tests/paper-agent.test.ts', 'tests/chat-markdown.test.ts']);
else if (command === 'test:ai-index') run(['--import', 'tsx', '--test', 'tests/library-ai-index.test.ts']);
else if (command === 'test:experience') run(['--import', 'tsx', 'tests/paper-experience-desktop.ts', ...process.argv.slice(3)]);
else if (command === 'test:reader') run(['--import', 'tsx', 'tests/pdf-reader.ts', ...process.argv.slice(3)]);
else if (command === 'test:mineru') run(['--import', 'tsx', process.argv.includes('--models') ? 'tests/mineru-local.ts' : 'tests/mineru-desktop.ts', ...process.argv.slice(3)]);
else if (command === 'test:model-settings') run(['--import', 'tsx', 'tests/model-settings-desktop.ts', ...process.argv.slice(3)]);
else if (command === 'test:connectivity') run(['--import', 'tsx', 'tests/model-connectivity-desktop.ts', ...process.argv.slice(3)]);
else if (command === 'test:home-collections') run(['--import', 'tsx', 'tests/home-collections-desktop.ts', ...process.argv.slice(3)]);
else if (command === 'test:cloud') run(['--import', 'tsx', 'tests/cloud-desktop.ts', ...process.argv.slice(3)]);
else if (command === 'test:sync-overview') run(['--import', 'tsx', 'tests/sync-overview-desktop.ts', ...process.argv.slice(3)]);
else if (command === 'test:notes') run(['--import', 'tsx', 'tests/notes-desktop.ts', ...process.argv.slice(3)]);
else if (command === 'test:citations') run(['--import', 'tsx', 'tests/citations-desktop.ts', ...process.argv.slice(3)]);
else if (command === 'test:tag-delete') run(['--import', 'tsx', 'tests/tag-delete-desktop.ts', ...process.argv.slice(3)]);
else if (command === 'test:tag-colors') run(['--import', 'tsx', 'tests/tag-colors-desktop.ts', ...process.argv.slice(3)]);
else if (command === 'test:chat') run(['--import', 'tsx', 'tests/pdf-chat-desktop.ts', ...process.argv.slice(3)]);
else if (command === 'test:pdf') run(['--import', 'tsx', 'tests/sample-pdfs.ts']);
else if (command === 'test:ratings') run(['tests/ratings.cjs']);
else if (command === 'test:timeline-viewport') run(['tests/timeline-viewport.cjs']);
else if (command === 'test:timeline-pan') run(['tests/timeline-pan.cjs', ...process.argv.slice(3)]);
else if (command === 'test:timeline-selection') run(['tests/timeline-selection.cjs']);
else if (command === 'test:desktop') run([process.argv.includes('--ai') ? 'tests/ai-desktop.cjs' : process.argv.includes('--folders') ? 'tests/folders.cjs' : process.argv.includes('--timeline') ? 'tests/timeline.cjs' : process.argv.includes('--storage') ? 'tests/storage-desktop.cjs' : process.argv.includes('--visual') ? 'tests/visual.cjs' : process.argv.includes('--packaged') ? 'tests/packaged.cjs' : 'tests/desktop.cjs', ...process.argv.slice(3)]);
else {
  run([bin('typescript/bin/tsc')]);
  run(['scripts/build.mjs']);
  if (command === 'build') process.exit(0);
  if (command === 'package') {
    run([bin('electron-builder/out/cli/cli.js'), '--win', '--dir']);
    process.exit(0);
  }
  if (!['start', 'dev'].includes(command)) { console.error('Unknown command:', command); process.exit(1); }
  const electron = require('electron');
  const child = spawn(electron, ['.'], { stdio: 'inherit', env, windowsHide: true });
  child.on('exit', code => process.exit(code || 0));
}
