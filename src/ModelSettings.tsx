import { useEffect, useRef, useState } from 'react';
import { Bot, Check, Eye, EyeOff, LoaderCircle, Plus, Settings2, Wifi, X } from 'lucide-react';
import { emptyModelConfiguration, modelBaseUrl, type ModelConfiguration, type ModelConnectionResult } from '../shared/model-settings';
import { DEFAULT_CONTEXT_WINDOW } from '../shared/model-chat';
import './ModelSettings.css';

const message = (e: unknown) => e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '大模型配置操作失败';
export default function ModelSettingsCard() {
  const [config, setConfig] = useState<ModelConfiguration>(emptyModelConfiguration);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [open, setOpen] = useState(false), [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    if (!window.paperApi?.getModelConfig) { setLoading(false); return; }
    window.paperApi.getModelConfig().then(value => { if (active) setConfig(value); }).catch(e => { if (active) setError(message(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  return <>
    <section className="home-card model-config-card" aria-label="API 大模型配置">
      <div className="model-config-summary"><div className="model-config-title"><h2><Bot size={19} />API 大模型</h2><span className={`cloud-connection ${config.configured ? 'online' : ''}`}>{loading ? '读取中' : config.configured ? '已配置' : config.profiles.length ? '待选择' : '未配置'}</span></div>
        {config.configured ? <p><strong>{config.name}</strong><span>{config.model}</span><code>{config.baseUrl}</code><span>已保存 {config.profiles.length} 个模型</span></p> : <p>{config.profiles.length ? `已保存 ${config.profiles.length} 个模型，请选择要使用的模型。` : '配置模型服务，在 PDF 阅读器的 AI 侧栏中聊天。'}</p>}
        {saved && <span className="model-save-notice" role="status"><Check size={13} />配置已保存</span>}
        {error && <p className="form-error" role="alert">{error}</p>}</div>
      <button className="secondary-button" disabled={loading || !window.paperApi?.getModelConfig} onClick={() => { setSaved(false); setOpen(true); }}><Settings2 size={15} />配置大模型</button>
    </section>
    {open && <ModelSettingsDialog config={config} loadError={error} onClose={() => setOpen(false)} onSaved={value => { setConfig(value); setError(''); setSaved(value.configured); }} />}
  </>;
}

export function ModelSettingsDialog({ config, loadError, onClose, onSaved }: { config: ModelConfiguration; loadError: string; onClose: () => void; onSaved: (config: ModelConfiguration) => void }) {
  const [view, setView] = useState<'list' | 'add' | 'edit'>('list');
  const [profileId, setProfileId] = useState<string | null>(config.activeId ?? config.profiles[0]?.id ?? null);
  const selected = config.profiles.find(profile => profile.id === profileId);
  const [name, setName] = useState(config.name), [baseUrl, setBaseUrl] = useState(config.baseUrl), [model, setModel] = useState(config.model);
  const [contextWindow, setContextWindow] = useState(String(config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW));
  const [apiKey, setApiKey] = useState(''), [withoutApiKey, setWithoutApiKey] = useState(config.configured && !config.hasApiKey), [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false), [error, setError] = useState(loadError);
  const [testing, setTesting] = useState(false), [testResult, setTestResult] = useState<ModelConnectionResult | null>(null);
  const working = saving || testing;
  const form = useRef<HTMLFormElement>(null), pending = useRef(false);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; return () => previous?.focus(); }, []);
  useEffect(() => {
    const focusTarget = view === 'list'
      ? form.current?.querySelector('input:checked') ?? form.current?.querySelector('.model-add:not(:disabled), .model-clear')
      : form.current?.querySelector('#model-config-name');
    if (focusTarget instanceof HTMLElement) focusTarget.focus();
  }, [view]);
  useEffect(() => { setTestResult(null); }, [name, baseUrl, model, apiKey, withoutApiKey]);
  useEffect(() => () => { void window.paperApi?.cancelModelConnectionTest?.().catch(() => {}); }, []);
  let addressChanged = true;
  try { addressChanged = modelBaseUrl(baseUrl) !== selected?.baseUrl; } catch {}
  const differentModel = !!selected && (addressChanged || model.trim() !== selected.model);
  function openForm(id: string | null) {
    const profile = config.profiles.find(item => item.id === id);
    setProfileId(id);
    setName(profile?.name ?? ''); setBaseUrl(profile?.baseUrl ?? ''); setModel(profile?.model ?? '');
    setContextWindow(String(profile?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW));
    setWithoutApiKey(!!profile && !profile.hasApiKey);
    setApiKey(''); setVisible(false); setError(''); setTestResult(null);
    setView(id ? 'edit' : 'add');
  }
  function showList(id: string | null) {
    setView('list'); setProfileId(id); setError(''); setApiKey(''); setVisible(false); setTestResult(null);
  }
  function cancel() {
    if (view === 'list') onClose();
    else showList(config.activeId ?? config.profiles[0]?.id ?? null);
  }
  async function choose() {
    if (pending.current || !profileId) return;
    pending.current = true; setSaving(true); setError('');
    try { onSaved(await window.paperApi!.selectModelConfig(profileId)); onClose(); }
    catch (e) { setError(message(e)); }
    finally { pending.current = false; setSaving(false); }
  }
  const saveLabel = differentModel ? '另存为新模型' : '保存配置';
  async function save(replace = false) {
    if (pending.current || !form.current?.reportValidity()) return;
    if (replace && (!selected || !differentModel || !window.confirm(`将已保存的「${selected.name}」（${selected.model}）替换为「${name}」（${model}）？替换后，原配置将从列表中移除。`))) return;
    const saveAsNew = differentModel && !replace;
    if (saveAsNew && !withoutApiKey && !apiKey.trim()) {
      setError('请为新模型填写 API Key，或勾选此接口无需 API Key。');
      form.current.querySelector<HTMLInputElement>('#model-config-key')?.focus();
      return;
    }
    pending.current = true; setSaving(true); setError('');
    try {
      const id = saveAsNew ? null : profileId;
      const value = await window.paperApi!.saveModelConfig({ profileId: id, name, baseUrl, model, withoutApiKey, apiKey: withoutApiKey ? undefined : apiKey,
        contextWindowTokens: contextWindow.trim() ? Number(contextWindow) : undefined }, false);
      onSaved(value); showList(id ?? value.profiles.at(-1)!.id);
    }
    catch (e) { setError(message(e)); }
    finally { pending.current = false; setSaving(false); }
  }
  async function clear() {
    if (loadError && !selected && !window.confirm('是否清除本机全部模型配置及密钥？')) return;
    if (pending.current) return; pending.current = true; setSaving(true); setError('');
    try { const value = await window.paperApi!.clearModelConfig(selected?.id); onSaved(value); showList(value.activeId ?? value.profiles[0]?.id ?? null); }
    catch (e) { setError(message(e)); }
    finally { pending.current = false; setSaving(false); }
  }
  async function testConnection() {
    if (pending.current) return;
    const fields = ['#model-config-url', '#model-config-model', '#model-config-key'];
    for (const selector of fields) { const field = form.current?.querySelector<HTMLInputElement>(selector); if (field && !field.reportValidity()) return; }
    pending.current = true; setTesting(true); setTestResult(null); setError('');
    try { setTestResult(await window.paperApi!.testModelConnection({ profileId, name, baseUrl, model, withoutApiKey, apiKey: withoutApiKey ? undefined : apiKey })); }
    catch (e) { setError(message(e)); }
    finally { pending.current = false; setTesting(false); }
  }
  async function cancelTest() {
    try { await window.paperApi!.cancelModelConnectionTest(); } catch (e) { setError(message(e)); }
  }
  return <div className="modal-backdrop" onDragEnter={e => e.stopPropagation()} onDrop={e => { e.preventDefault(); e.stopPropagation(); }}>
    <form ref={form} className="edit-modal model-settings" role="dialog" aria-modal="true" aria-labelledby="model-settings-title" onSubmit={event => { event.preventDefault(); if (view !== 'list') void save(); }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape' && !saving) { event.preventDefault(); if (testing) void cancelTest(); else cancel(); }
        if (event.key !== 'Tab') return;
        const fields = [...form.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
        if (!fields.length) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1)?.focus(); }
        if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0].focus(); }
      }}>
      <div className="modal-heading"><h2 id="model-settings-title">{view === 'list' ? '配置大模型' : view === 'add' ? '添加大模型' : '编辑大模型'}</h2><button type="button" className="icon-button" aria-label="关闭大模型配置" disabled={working} onClick={onClose}><X size={19} /></button></div>
      {view === 'list' ? <>
        <div className="modal-fields">
          {config.profiles.length ? <fieldset className="model-list"><legend>已保存的模型</legend>
            {config.profiles.map(profile => <label key={profile.id} className={profileId === profile.id ? 'highlighted' : ''}>
              <input type="radio" name="saved-model" value={profile.id} checked={profileId === profile.id} disabled={working}
                onChange={() => { setProfileId(profile.id); setError(''); }} />
              <span className="model-row-info"><strong>{profile.name}</strong><small>{profile.model} · {profile.baseUrl}</small></span>
              {profile.id === config.activeId && <small className="model-current">当前使用</small>}
            </label>)}</fieldset> : !loadError && <p className="model-settings-intro">还没有已保存的模型，点击「添加」配置第一个模型。</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-button model-add" disabled={working || !!loadError} onClick={() => openForm(null)}><Plus size={15} />添加</button>
          {selected && <button type="button" className="text-button" disabled={working} onClick={() => openForm(selected.id)}>编辑</button>}
          {loadError && <button type="button" className="text-button" disabled={working} onClick={clear}>清除配置</button>}
          <button type="button" className="secondary-button" disabled={working} onClick={onClose}>取消</button>
          <button type="button" className="primary-button" disabled={working || !selected} onClick={choose}>选择</button>
        </div>
      </> : <>
      <div className="modal-fields">
        <p className="model-settings-intro">{differentModel ? '接口地址或模型 ID 已更改。另存后，两套配置都可以在列表中选择。' : '填写 OpenAI 兼容接口信息。保存后返回模型列表。'}</p>
        <label htmlFor="model-config-name">配置名称</label><input id="model-config-name" required maxLength={80} placeholder="例如：我的论文阅读模型" value={name} onChange={e => setName(e.target.value)} disabled={working} />
        <label htmlFor="model-config-url">API 接口地址 <span>Base URL</span></label><input id="model-config-url" type="url" required maxLength={2048} placeholder="https://你的模型服务地址/v1" spellCheck={false} autoComplete="off" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} disabled={working} />
        <label htmlFor="model-config-model">模型名称</label><input id="model-config-model" required maxLength={256} placeholder="填写服务商提供的模型 ID" spellCheck={false} value={model} onChange={e => setModel(e.target.value)} disabled={working} />
        <label htmlFor="model-config-context">上下文容量 <span>token</span></label><input id="model-config-context" type="number" min={8192} max={2000000} step={1} placeholder={String(DEFAULT_CONTEXT_WINDOW)} value={contextWindow} onChange={e => setContextWindow(e.target.value)} disabled={working} />
        <p className="model-settings-help">用于自动摘要压缩。默认按 32,768 token 保守预算，请按服务商公布的容量调整；生成摘要会调用当前模型。</p>
        {!withoutApiKey && <><label htmlFor="model-config-key">API Key {selected?.hasApiKey && !addressChanged && !differentModel && <span>已保存，留空保持不变</span>}</label>
          <div className="model-key-field"><input id="model-config-key" type={visible ? 'text' : 'password'} required={!selected?.hasApiKey || addressChanged} maxLength={8192} autoComplete="new-password" spellCheck={false}
            placeholder={differentModel ? '另存为新模型时填写 API Key' : selected?.hasApiKey && !addressChanged ? '已保存密钥，留空保持不变' : '填写 API Key'} value={apiKey} onChange={e => setApiKey(e.target.value)} disabled={working} />
            <button className="icon-button" type="button" aria-label={visible ? '隐藏 API Key' : '显示 API Key'} aria-pressed={visible} disabled={working} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
          {selected?.hasApiKey && addressChanged && <p className="model-settings-help">接口地址更改后，需要重新填写对应的 API Key。</p>}</>}
        <label className="model-no-key"><input type="checkbox" checked={withoutApiKey} disabled={working} onChange={e => { setWithoutApiKey(e.target.checked); setApiKey(''); setVisible(false); }} />此接口无需 API Key（例如本地模型）</label>
        <p className="model-settings-help">API Key 使用系统加密保存在本机，不写入文献库。保存配置不会自动调用模型或发送论文。</p>
        <p className="model-settings-help">测试会向当前接口发送一条简短消息，可能产生少量 API 费用；不会发送论文内容，也不会保存本次修改。</p>
        {testResult && <p className={`model-test-result ${testResult.ok ? 'success' : 'failure'}`} role="status">{testResult.message}{testResult.ok && <span>耗时 {testResult.latencyMs} ms</span>}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <div className="modal-footer">{differentModel
        ? <button className="text-button model-clear" type="button" disabled={working} onClick={() => void save(true)}>替换原配置…</button>
        : (selected || loadError) && <button className="text-button model-clear" type="button" disabled={working} onClick={clear}>{config.profiles.length > 1 ? '删除所选配置' : '清除配置'}</button>}
        <button className="secondary-button" type="button" disabled={working} onClick={testConnection}>{testing ? <LoaderCircle size={15} className="spin" /> : <Wifi size={15} />}{testing ? '测试中…' : '测试连通性'}</button>
        <button className="secondary-button" type="button" disabled={saving} onClick={testing ? cancelTest : cancel}>{testing ? '取消测试' : '取消'}</button><button className="primary-button" type="submit" disabled={working}>{saving && <LoaderCircle size={15} className="spin" />}{saving ? '正在保存…' : saveLabel}</button></div>
      </>}
    </form>
  </div>;
}
