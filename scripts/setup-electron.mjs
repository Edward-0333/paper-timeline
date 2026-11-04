import { downloadArtifact } from '@electron/get';
import { createRequire } from 'node:module';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const require = createRequire(import.meta.url);
const { version } = require('electron/package.json');
const checksums = require('electron/checksums.json');
const { extract } = require('@electron-internal/extract-zip');
let previous = -1;
const mirror = process.argv.includes('--mirror') ? 'https://npmmirror.com/mirrors/electron/' : undefined;
console.log(`Installing Electron ${version}; release checksum verification enabled.`);
const zip = await downloadArtifact({ version, artifactName: 'electron', platform: 'win32', arch: 'x64', checksums,
  cacheRoot: resolve('.cache/electron'), mirrorOptions: mirror ? { mirror } : undefined,
  downloadOptions: { signal: AbortSignal.timeout(180000), getProgressCallback: ({ percent }) => { const progress = Math.floor(percent * 10) * 10; if (progress !== previous) { previous = progress; console.log(`Download ${progress}%`); } } },
});
const dist = resolve('node_modules/electron/dist');
await mkdir(dist, { recursive: true });
await extract(zip, { dir: dist });
try { await rename(join(dist, 'electron.d.ts'), resolve('node_modules/electron/electron.d.ts')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
await writeFile('node_modules/electron/path.txt', 'electron.exe');
console.log('Electron installed.');
