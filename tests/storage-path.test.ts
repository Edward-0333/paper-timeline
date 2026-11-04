import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { resolveLibraryDirectory } from '../electron/storage-path';

const project = resolve('.');
test('source and project-packaged launches share the project library', () => {
  assert.equal(resolveLibraryDirectory({ isPackaged: false, appPath: project, executablePath: join(project, 'node_modules/electron/dist/electron.exe') }), join(project, 'library'));
  assert.equal(resolveLibraryDirectory({ isPackaged: true, appPath: join(project, 'release/win-unpacked/resources/app.asar'), executablePath: join(project, 'release/win-unpacked/Paper Timeline.exe') }), join(project, 'library'));
});
test('standalone packaged apps keep their library beside the executable', () => {
  const standalone = resolve('../standalone-storage-test');
  assert.equal(resolveLibraryDirectory({ isPackaged: true, appPath: join(standalone, 'resources/app.asar'), executablePath: join(standalone, 'Paper Timeline.exe') }), join(standalone, 'library'));
});
test('explicit data roots still isolate test libraries', () => {
  const dataRoot = resolve('.test-data/storage-override');
  assert.equal(resolveLibraryDirectory({ isPackaged: true, appPath: project, executablePath: join(project, 'release/win-unpacked/Paper Timeline.exe'), dataRoot }), join(dataRoot, 'library'));
});
