import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { unzip } from 'fflate';
import type { MineruEnvironment, MineruResult, MineruTier } from '../shared/mineru';
import { ensurePaperDirectory, paperStoragePaths } from './paper-storage';

const MAX_BYTES = 512 * 1024 * 1024;
export function validateMineruTier(tier: unknown): asserts tier is MineruTier {
  if (!['basic', 'standard', 'flash'].includes(tier as string)) throw new Error('请选择有效的 MinerU 解析模式');
}
export async function plainDirectory(path: string) {
  try { const s = await lstat(path); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('解析目录不支持文件链接'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; await mkdir(path); }
}
function safeMember(name: string) {
  return !!name && name.length <= 500 && !/[\\:\x00-\x1f]/.test(name) && !name.startsWith('/')
    && name.split('/').every(part => part !== '.' && part !== '..' && !!part && !/[. ]$/.test(part)
      && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}
export async function unpackMineruResult(archive: Uint8Array, target: string) {
  let total = 0, count = 0, invalid = false;
  if (archive.byteLength > MAX_BYTES) throw new Error('解析结果包超过 512 MB');
  const files = await new Promise<Record<string, Uint8Array>>((accept, reject) => {
    unzip(archive, { filter: entry => {
      if (entry.name.endsWith('/')) return false;
      total += entry.originalSize; count++;
      if (!safeMember(entry.name) || !/\.(md|json|png|jpe?g|webp|gif)$/i.test(entry.name)
        || entry.originalSize > 100 * 1024 * 1024 || total > MAX_BYTES || count > 10000) { invalid = true; return false; }
      return true;
    } }, (error, data) => error ? reject(new Error('MinerU 结果压缩包损坏')) : accept(data));
  });
  if (invalid) throw new Error('MinerU 结果包含无效路径、文件类型或过大的数据');
  if (!files['markdown.md'] || !files['middle_json.json']) throw new Error('MinerU 未生成完整的 Markdown 和 JSON');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(files['markdown.md']);
  if (!text.trim()) throw new Error('未提取到正文；扫描件请使用基础或标准解析');
  for (const name of ['middle_json.json', 'structured_content.json']) {
    if (files[name]) { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files[name])); if (!value || typeof value !== 'object') throw new Error('解析 JSON 格式异常'); }
  }
  // Every run gets a new, exclusive directory. Never unpack over an earlier result.
  await mkdir(target);
  for (const [name, data] of Object.entries(files)) {
    const file = join(target, ...name.split('/'));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data, { flag: 'wx' });
  }
  return { markdown: 'markdown.md', json: 'middle_json.json', images: Object.keys(files).filter(name => /\.(png|jpe?g|webp|gif)$/i.test(name)).length };
}
export async function mineruPaperDirectory(directory: string, id: string, create = false, storageFolder?: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('无效论文编号');
  const paths = paperStoragePaths(directory, { id, storageFolder });
  if (create && storageFolder) await ensurePaperDirectory(directory, storageFolder);
  for (const path of storageFolder ? [join(directory, 'papers'), paths.directory, paths.parsed] : [join(directory, 'parsed'), paths.parsed]) {
    if (create) await plainDirectory(path);
    else { try { const s = await lstat(path); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('解析目录不支持文件链接'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
  }
  return paths.parsed;
}
export function validateMineruResult(result: MineruResult) {
  if (!result || !/^[a-f0-9-]{36}$/.test(result.runId) || !/^[a-f0-9]{64}$/.test(result.pdfHash)
    || result.markdown !== 'markdown.md' || result.json !== 'middle_json.json' || !Number.isSafeInteger(result.images) || result.images < 0
    || typeof result.completedAt !== 'string' || !Number.isFinite(Date.parse(result.completedAt)) || typeof result.mineruVersion !== 'string') throw new Error('解析结果记录损坏，请保留 parsed 文件夹并检查备份');
  validateMineruTier(result.tier);
}
export async function readMineruResult(directory: string, id: string, storageFolder?: string): Promise<MineruResult | null> {
  const dir = await mineruPaperDirectory(directory, id, false, storageFolder), path = join(dir, 'result.json');
  try {
    const s = await lstat(path);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 16000) throw new Error('解析结果记录异常');
    const result = JSON.parse(await readFile(path, 'utf8')); validateMineruResult(result); return result;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
export async function saveMineruResult(directory: string, id: string, result: MineruResult, storageFolder?: string) {
  validateMineruResult(result);
  const dir = await mineruPaperDirectory(directory, id, true, storageFolder), path = join(dir, 'result.json'), temp = join(dir, '.' + randomUUID() + '.tmp');
  await readMineruResult(directory, id, storageFolder); // Refuse to overwrite a damaged or linked index.
  try {
    await writeFile(temp, JSON.stringify(result, null, 2), { flag: 'wx' });
    try { const s = await lstat(path + '.bak'); if (!s.isFile() || s.isSymbolicLink()) throw new Error('解析结果备份文件异常'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    try { await copyFile(path, path + '.bak'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await rename(temp, path);
  }
  finally { await unlink(temp).catch(() => {}); }
}
export async function mineruResultPath(directory: string, id: string, result: MineruResult, kind: 'markdown' | 'json' | 'directory', storageFolder?: string) {
  validateMineruResult(result);
  const base = await mineruPaperDirectory(directory, id, false, storageFolder), run = join(base, result.runId);
  const s = await lstat(run); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('解析结果目录缺失或为链接，请检查完整文献库');
  if (kind === 'directory') return run;
  const path = join(run, kind === 'markdown' ? result.markdown : result.json), f = await lstat(path);
  if (!f.isFile() || f.isSymbolicLink()) throw new Error('解析结果文件缺失或为链接，请检查完整文献库');
  return path;
}

export interface MineruRunner {
  environment(): Promise<MineruEnvironment>;
  convert(pdf: string, archive: string, tier: MineruTier, signal: AbortSignal): Promise<string>;
}
export class LocalMineru implements MineruRunner {
  constructor(private settingsDirectory: string, private searchDirectories: string[]) {}
  private get settings() { return join(this.settingsDirectory, 'mineru-settings.json'); }
  private async command() {
    try { const settings = JSON.parse(await readFile(this.settings, 'utf8')); if (typeof settings.executable === 'string') return this.checkPath(settings.executable); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const name = process.platform === 'win32' ? 'mineru-kit.exe' : 'mineru-kit';
    const candidates = [...this.searchDirectories.map(dir => join(dir, '.mineru-env', process.platform === 'win32' ? 'Scripts' : 'bin', name)),
      ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, name))];
    for (const candidate of candidates) { try { return await this.checkPath(candidate); } catch {} }
    throw new Error('未找到 MinerU 4.x 环境，请选择 mineru-kit 可执行文件，或按安装说明准备本机环境');
  }
  private async checkPath(path: string) {
    if (!isAbsolute(path) || /[\x00-\x1f]/.test(path) || (process.platform === 'win32' && extname(path).toLowerCase() !== '.exe')) throw new Error('请选择本机 MinerU 可执行文件');
    const stat = await lstat(path); if (!stat.isFile()) throw new Error('MinerU 路径不是文件'); return resolve(path);
  }
  private async env() {
    await mkdir(this.settingsDirectory, { recursive: true });
    const home = join(this.settingsDirectory, 'mineru-data'); await mkdir(home, { recursive: true });
    const config = join(home, 'paper-timeline-local.yaml');
    // A private config and clean MinerU variables prevent inherited remote model/API settings from uploading PDFs.
    const temporary = config + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, 'model:\n  source: modelscope\n  small_backend: onnx\n  vlm:\n    engine: llama-cpp\n    server_url: ""\nllm_aided:\n  features:\n    title_leveling: false\n    cross_page_table_cell_merge: false\n', { flag: 'wx' });
      await rename(temporary, config);
    } finally { await unlink(temporary).catch(() => {}); }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MINERU_') && key !== 'ELECTRON_RUN_AS_NODE'));
    return { ...env, MINERU_HOME: home, MINERU_CONFIG: config, MINERU_MODEL_SOURCE: 'modelscope', MINERU_MODEL_SMALL_BACKEND: 'onnx',
      MINERU_MODEL_VLM_ENGINE: 'llama-cpp', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_XET: '1', DO_NOT_TRACK: '1' };
  }
  private async execute(command: string, args: string[], signal: AbortSignal | undefined, timeout: number) {
    const env = await this.env();
    return new Promise<string>((accept, reject) => {
      if (signal?.aborted) { reject(new Error('转换已取消')); return; }
      const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: this.settingsDirectory });
      let tail = '', stopped = false;
      const collect = (data: Buffer) => { tail = (tail + data.toString('utf8')).slice(-12000); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const stop = () => { stopped = true;
        if (process.platform === 'win32' && child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else child.kill('SIGKILL');
      };
      signal?.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(stop, timeout);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
      child.once('error', error => { cleanup(); reject(new Error('无法启动 MinerU：' + error.message)); });
      child.once('close', code => { cleanup(); if (stopped) reject(new Error(signal?.aborted ? '转换已取消' : 'MinerU 运行超时，请检查环境后重试'));
        else if (code !== 0) reject(new Error('MinerU 转换失败：' + tail.replace(/\x1b\[[0-9;]*m/g, '').slice(-2500)));
        else accept(tail); });
    });
  }
  async environment(): Promise<MineruEnvironment> {
    try { const executable = await this.command(), output = await this.execute(executable, ['--version'], undefined, 60000);
      const version = output.match(/\b(4\.\d+\.\d+(?:[a-z0-9.+-]*)?)\b/i)?.[1];
      if (!version) return { ready: false, executable, message: '需要 MinerU 4.x，请选择兼容环境' };
      return { ready: true, executable, version, message: `MinerU ${version} · 本机解析` };
    } catch (e) { return { ready: false, message: e instanceof Error ? e.message : 'MinerU 环境不可用' }; }
  }
  async chooseExecutable(path: string) {
    const executable = await this.checkPath(path), output = await this.execute(executable, ['--version'], undefined, 60000);
    if (!/\b4\.\d+\.\d+\b/.test(output)) throw new Error('需要 MinerU 4.x；未修改现有环境设置');
    const temporary = this.settings + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary, JSON.stringify({ version: 1, executable }), { flag: 'wx' }); await rename(temporary, this.settings); }
    finally { await unlink(temporary).catch(() => {}); }
    return this.environment();
  }
  async convert(pdf: string, archive: string, tier: MineruTier, signal: AbortSignal) {
    validateMineruTier(tier);
    const environment = await this.environment(); if (!environment.ready) throw new Error(environment.message);
    const args = ['parse', pdf, '--output', archive, '--format', 'zip', '--pages', 'all', '--tier', tier];
    if (tier === 'flash') args.push('--ocr-mode', 'txt');
    await this.execute(environment.executable!, args, signal, 2 * 60 * 60 * 1000);
    return environment.version!;
  }
}
