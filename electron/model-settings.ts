import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyModelConfiguration, modelBaseUrl, type ModelConfiguration, type ModelConfigurationInput } from '../shared/model-settings';
import { probeModelConnection, type ConnectionOptions } from './model-connectivity';
import { requestModelChat, type ChatOptions } from './model-chat';
import { validateChatRequest, validChatRequestId, type ModelChatContext, type ModelChatRequest, type ModelChatResult, type StoredChatMessage } from '../shared/model-chat';
import type { PaperAgentAccess } from './paper-agent-tools';

interface ModelSecret { id: string; name: string; baseUrl: string; model: string; apiKey: string; updatedAt: string }
interface ModelStore { version: 2; activeId: string | null; profiles: ModelSecret[] }
const MAX_PROFILES = 32;
export interface ModelCipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
const text = (value: unknown, label: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value.trim())) throw new Error(`${label}需为 1–${max} 个字符，不能包含控制字符`);
  return value.trim();
};
function validateInput(value: ModelConfigurationInput, testing = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['profileId', 'name', 'baseUrl', 'model', 'apiKey', 'withoutApiKey'].includes(k))
    || (value.profileId != null && typeof value.profileId !== 'string')
    || typeof value.withoutApiKey !== 'boolean' || (value.apiKey !== undefined && typeof value.apiKey !== 'string')) throw new Error('大模型配置格式不正确');
  return { name: text(testing && typeof value.name === 'string' && !value.name.trim() ? '连通性测试' : value.name, '配置名称', 80), baseUrl: modelBaseUrl(value.baseUrl), model: text(value.model, '模型名称', 256),
    apiKey: value.apiKey?.trim() || '', withoutApiKey: value.withoutApiKey };
}
function validateStored(value: ModelSecret) {
  if (!value || typeof value.id !== 'string' || !/^(legacy|[a-f0-9-]{36})$/.test(value.id) || Object.keys(value).some(k => !['id', 'name', 'baseUrl', 'model', 'apiKey', 'updatedAt'].includes(k))
    || typeof value.apiKey !== 'string' || value.apiKey.length > 8192 || /[\x00-\x1f\x7f]/.test(value.apiKey)
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('配置格式不正确');
  text(value.name, '配置名称', 80); text(value.model, '模型名称', 256); modelBaseUrl(value.baseUrl);
}
function profileFor(store: ModelStore | null, id: string | null | undefined) {
  const target = id === undefined ? store?.activeId : id;
  if (target == null) return null;
  const profile = store?.profiles.find(p => p.id === target);
  if (!profile) throw new Error('找不到此模型配置，请重新打开设置');
  return profile;
}
function summary(store: ModelStore | null): ModelConfiguration {
  if (!store) return emptyModelConfiguration();
  const profiles = store.profiles.map(({ apiKey, ...profile }) => ({ ...profile, hasApiKey: !!apiKey }));
  if (store.activeId === null) return { ...emptyModelConfiguration(), profiles };
  const { id: activeId, ...fields } = profiles.find(p => p.id === store.activeId)!;
  return { ...fields, configured: true, activeId, profiles };
}

/** Desktop-only credentials. Never include the API key in a renderer/AI response or a portable library. */
export class ModelSettings {
  private writes: Promise<unknown> = Promise.resolve();
  private connectionTest?: { controller: AbortController; done: Promise<unknown> };
  private chats = new Map<string, { controller: AbortController; done: Promise<ModelChatResult>; paperId: string }>();
  constructor(private directory: string, private cipher: ModelCipher, private chatContext?: (paperId: string) => Promise<ModelChatContext>, private agentAccess?: (paperId: string) => PaperAgentAccess,
    private saveChat?: (paperId: string, messages: StoredChatMessage[]) => Promise<void>) {}
  get file() { return join(this.directory, 'llm-config.bin'); }
  private async check() {
    for (const [path, directory] of [[this.directory, true], [this.file, false]] as const) {
      try { const s = await lstat(path); if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) throw new Error('大模型配置路径异常，不支持文件链接'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  }
  private async read(): Promise<ModelStore | null> {
    await this.check();
    let bytes: Buffer;
    try { if ((await lstat(this.file)).size > 4 * 1024 * 1024) throw new Error('大模型配置文件过大'); bytes = await readFile(this.file); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    try {
      const value = JSON.parse(this.cipher.decryptString(bytes));
      if (value.version === 1) {
        const { version, ...fields } = value;
        const profile = { ...fields, id: 'legacy' };
        validateStored(profile);
        return { version: 2, activeId: profile.id, profiles: [profile] };
      }
      if (value.version !== 2 || !Array.isArray(value.profiles) || !value.profiles.length || value.profiles.length > MAX_PROFILES) throw new Error();
      value.profiles.forEach(validateStored);
      const ids = new Set(value.profiles.map((p: ModelSecret) => p.id));
      if (ids.size !== value.profiles.length || (value.activeId !== null && !ids.has(value.activeId))) throw new Error();
      return value;
    }
    catch { throw new Error('无法读取或解密大模型配置，请重新打开设置；可清除配置后重新填写'); }
  }
  async status() { await this.writes.catch(() => {}); return summary(await this.read()); }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writes.catch(() => {}).then(fn); this.writes = next; return next;
  }
  private resolveInput(input: ModelConfigurationInput, store: ModelStore | null, testing = false) {
    const value = validateInput(input, testing), previous = profileFor(store, input.profileId);
    let apiKey = value.withoutApiKey ? '' : value.apiKey;
    if (value.withoutApiKey && value.apiKey) throw new Error('已选择无需 API Key，请清空密钥输入');
    if (!value.withoutApiKey && !apiKey) {
      if (previous?.apiKey && previous.baseUrl === value.baseUrl) apiKey = previous.apiKey;
      else throw new Error(previous?.apiKey ? '接口地址已更改，请重新填写 API Key' : '请填写 API Key，或选择此接口无需密钥');
    }
    if (apiKey.length > 8192 || /[\x00-\x1f\x7f]/.test(apiKey)) throw new Error('API Key 格式不正确');
    return { ...value, apiKey, previous };
  }
  async testConnection(input: ModelConfigurationInput, fetcher: typeof fetch, options: ConnectionOptions = {}) {
    if (this.connectionTest) throw new Error('正在测试连接，请稍候或取消当前测试');
    const controller = new AbortController();
    const done = (async () => {
      await this.writes.catch(() => {});
      const value = this.resolveInput(input, await this.read(), true);
      return probeModelConnection(value, fetcher, { ...options, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
    })();
    this.connectionTest = { controller, done };
    try { return await done; } finally { if (this.connectionTest?.controller === controller) this.connectionTest = undefined; }
  }
  cancelConnectionTest() { this.connectionTest?.controller.abort(); }
  async chat(input: ModelChatRequest, fetcher: typeof fetch, options: Omit<ChatOptions, 'context' | 'agent'> = {}): Promise<ModelChatResult> {
    const request = validateChatRequest(input);
    if (!request) return { ok: false, message: '消息格式或长度不正确，请缩短对话后重试。' };
    if (this.chats.has(request.requestId)) return { ok: false, message: '此消息正在生成回复，请等待或停止当前请求。' };
    if (this.chats.size >= 4) return { ok: false, message: '同时生成的对话过多，请等待其他回复完成后重试。' };
    const controller = new AbortController();
    const done = (async (): Promise<ModelChatResult> => {
      let value: ModelSecret | null;
      // Bind the request before resolving paper context or starting a tool loop.
      try { value = await this.serialize(async () => profileFor(await this.read(), undefined)); }
      catch {
        if (controller.signal.aborted || options.signal?.aborted) return { ok: false, cancelled: true, message: '已停止生成。' };
        return { ok: false, message: '无法读取大模型配置，请在个人首页检查或重新配置。' };
      }
      if (controller.signal.aborted || options.signal?.aborted) return { ok: false, cancelled: true, message: '已停止生成。' };
      if (!value) return { ok: false, message: '请先在个人首页配置 API 大模型，再发送消息。' };
      let context: ModelChatContext;
      try {
        if (!this.chatContext) throw new Error('context-unavailable');
        context = await this.chatContext(request.paperId);
      } catch { return { ok: false, message: '无法确认当前文献的工作目录，请重新打开文献后重试。' }; }
      if (controller.signal.aborted || options.signal?.aborted) return { ok: false, cancelled: true, message: '已停止生成。' };
      const result = await requestModelChat(value, request, fetcher, { ...options, context, agent: this.agentAccess?.(request.paperId), signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
      // Persisted user turns receive the same credential redaction as model replies.
      if (result.ok && value.apiKey) for (const message of request.messages) message.content = message.content.split(value.apiKey).join('[已隐藏密钥]');
      if (result.ok && result.content && this.saveChat) {
        try { await this.saveChat(request.paperId, [...request.messages, { role: 'assistant', content: result.content, sources: result.sources, activity: result.activity }]); }
        catch { result.historyWarning = '本次回答已完成，但对话记录保存失败，请保留当前页面并检查资料文件夹。'; }
      }
      return result;
    })();
    this.chats.set(request.requestId, { controller, done, paperId: request.paperId });
    try { return await done; } finally { if (this.chats.get(request.requestId)?.controller === controller) this.chats.delete(request.requestId); }
  }
  cancelChat(requestId: string) {
    if (!validChatRequestId(requestId)) throw new Error('无效 AI 请求编号');
    this.chats.get(requestId)?.controller.abort();
  }
  cancelAllChats() { for (const entry of this.chats.values()) entry.controller.abort(); }
  hasActiveChat(paperId: string) { return [...this.chats.values()].some(entry => entry.paperId === paperId); }
  select(id: string) {
    return this.serialize(async () => {
      const store = await this.read();
      if (!store || typeof id !== 'string' || !store.profiles.some(profile => profile.id === id)) throw new Error('找不到此模型配置，请重新打开设置');
      if (store.activeId === id) return summary(store);
      return this.write({ ...store, activeId: id });
    });
  }
  save(input: ModelConfigurationInput, activate = true) {
    return this.serialize(async () => {
      if (typeof activate !== 'boolean') throw new Error('模型启用参数不正确');
      const store = await this.read();
      const { previous, name, baseUrl, model, apiKey } = this.resolveInput(input, store);
      const profiles = store?.profiles.slice() ?? [];
      const next = { id: previous?.id ?? randomUUID(), name, baseUrl, model, apiKey, updatedAt: new Date().toISOString() };
      if (previous) profiles[profiles.indexOf(previous)] = next;
      else {
        if (profiles.length >= MAX_PROFILES) throw new Error('最多可保存 32 套模型配置');
        profiles.push(next);
      }
      return this.write({ version: 2, activeId: activate ? next.id : store?.activeId ?? null, profiles });
    });
  }
  private async write(next: ModelStore) {
    if (!this.cipher.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，未保存配置；请检查系统密钥服务');
    let encrypted: Buffer;
    try { encrypted = this.cipher.encryptString(JSON.stringify(next)); }
    catch { throw new Error('无法加密大模型配置，原有配置已保留'); }
    await this.check(); await mkdir(this.directory, { recursive: true });
    const temp = join(this.directory, 'llm-' + randomUUID() + '.tmp');
    try { await writeFile(temp, encrypted, { flag: 'wx', mode: 0o600 }); await rename(temp, this.file); }
    finally { await unlink(temp).catch(() => {}); }
    return summary(next);
  }
  clear(profileId?: string) {
    return this.serialize(async () => {
      // Empty-argument clear also supports the existing explicit recovery action for unreadable settings.
      const store = await this.read().catch(error => {
        if (profileId !== undefined) throw error;
        return null;
      });
      if (store || profileId !== undefined) {
        const target = profileFor(store, profileId);
        if (!store || !target) throw new Error('找不到此模型配置');
        const profiles = store.profiles.filter(p => p.id !== target.id);
        if (profiles.length) return this.write({ version: 2, profiles, activeId: store.activeId === target.id ? profiles[0].id : store.activeId });
      }
      await this.check();
      try { await unlink(this.file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      return emptyModelConfiguration();
    });
  }
  async whenIdle() { await this.writes.catch(() => {}); await Promise.allSettled([...this.chats.values()].map(entry => entry.done)); }
}
