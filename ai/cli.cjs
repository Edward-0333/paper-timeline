const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const manifest = require('./capabilities.json');
const root = path.resolve(__dirname, '..');
const emit = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const failure = (code, message) => Object.assign(new Error(message), { code });

function defaultLibraryDirectory() {
  if (process.env.PAPER_TIMELINE_DATA) return path.join(path.resolve(process.env.PAPER_TIMELINE_DATA), 'library');
  let candidate = root;
  for (let level = 0; level < 4; level++) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8')).name === 'paper-timeline' && fs.existsSync(path.join(candidate, 'electron/main.ts'))) return path.join(candidate, 'library');
    } catch {}
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return path.join(root, 'library');
}

function libraryDirectory(override) {
  if (override) return path.resolve(override);
  const defaultDirectory = defaultLibraryDirectory();
  const settings = path.join(path.dirname(defaultDirectory), 'library-location.json');
  try {
    const value = JSON.parse(fs.readFileSync(settings, 'utf8'));
    if (value.version !== 1 || typeof value.directory !== 'string' || !value.directory.trim() || /[\x00-\x1f]/.test(value.directory)) throw new Error();
    return path.resolve(path.dirname(settings), value.directory);
  } catch (error) {
    if (error.code === 'ENOENT') return defaultDirectory;
    throw failure('INVALID_SETTINGS', '文献库位置设置无效，请在软件中重新选择文献库');
  }
}
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
    emit({ ok: true, apiVersion: '1', usage: ['PaperAI.cmd capabilities', 'PaperAI.cmd call app.status', 'PaperAI.cmd call papers.list --file query.json', 'PaperAI.cmd call metadata.refresh --file request.json'], options: { '--file': 'UTF-8 JSON 参数文件；推荐用于 Windows 路径和中文', '--json': '直接传 JSON 参数', '--library': '指定完整文献库目录；不会创建或修改该目录' }, guide: path.join(root, 'ai/README.md') }); return;
  }
  if (args[0] === 'capabilities' && args.length === 1) { emit({ ok: true, apiVersion: '1', result: manifest }); return; }
  if (args[0] !== 'call' || !args[1]) throw failure('INVALID_ARGUMENT', '使用 PaperAI.cmd help 查看用法');
  const operation = args[1];
  if (!manifest.operations.some(item => item.name === operation)) throw failure('UNKNOWN_OPERATION', '能力清单中没有此操作');
  let params = {}, override, hasParams = false;
  for (let i = 2; i < args.length; i += 2) {
    const option = args[i], value = args[i + 1];
    if (!value || !['--file', '--json', '--library'].includes(option)) throw failure('INVALID_ARGUMENT', `无效选项：${option}`);
    if (option === '--library') { if (override) throw failure('INVALID_ARGUMENT', '--library 只能指定一次'); override = value; continue; }
    if (hasParams) throw failure('INVALID_ARGUMENT', '--file 和 --json 只能使用其中一个且仅使用一次');
    hasParams = true;
    try { params = JSON.parse((option === '--file' ? fs.readFileSync(value, 'utf8') : value).replace(/^\uFEFF/, '')); }
    catch { throw failure('INVALID_JSON', '无法读取参数 JSON，请检查文件路径、UTF-8 编码和 JSON 格式'); }
  }
  const directory = libraryDirectory(override);
  let session;
  try { session = JSON.parse(fs.readFileSync(path.join(directory, '.ai-session.json'), 'utf8')); }
  catch { throw failure('APP_NOT_RUNNING', '没有找到运行中的接口。请先打开新版 Paper Timeline，并确认文献库目录；接口也可能已被 PAPER_TIMELINE_AI=0 禁用。'); }
  if (session.apiVersion !== '1' || session.host !== '127.0.0.1' || !Number.isInteger(session.port) || session.port < 1 || session.port > 65535 || !/^[a-f0-9]{64}$/.test(session.token) || pathKey(session.storagePath || '') !== pathKey(directory)) throw failure('INVALID_SESSION', '接口会话无效，请重启软件');
  const data = Buffer.from(JSON.stringify({ operation, params }));
  if (data.length > manifest.limits.requestBytes) throw failure('REQUEST_TOO_LARGE', '请求不能超过 1 MB');
  const result = await new Promise((resolve, reject) => {
    // Local credentials must never pass through a configured HTTP proxy.
    const agent = new http.Agent({ keepAlive: false, proxyEnv: {} });
    const request = http.request({ hostname: '127.0.0.1', port: session.port, path: '/v1/call', method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json', 'Content-Length': data.length }, agent }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 32 * 1024 * 1024) { response.destroy(failure('INVALID_RESPONSE', '返回数据过大')); return; } chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        try { const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (typeof result.ok !== 'boolean' || result.apiVersion !== '1') throw new Error(); resolve(result); }
        catch { reject(failure('INVALID_RESPONSE', '接口返回格式无效，请检查软件版本')); }
      });
    });
    request.setTimeout(120000, () => request.destroy(failure('TIMEOUT', '等待响应超时，操作可能已提交。请先查询状态，不要盲目重复写操作。')));
    request.on('error', error => reject(error.code === 'TIMEOUT' ? error : failure('CONNECTION_FAILED', '无法连接软件。请确认软件仍在运行，必要时重启；操作结果不确定时先查询状态。')));
    request.end(data);
  });
  emit(result);
  if (!result.ok) process.exitCode = 1;
}
main().catch(error => { emit({ ok: false, apiVersion: '1', error: { code: error.code || 'CLI_ERROR', message: error.message } }); process.exitCode = 1; });
