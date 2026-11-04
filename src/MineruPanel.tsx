import { useEffect, useState } from 'react';
import { FileText, FolderOpen, LoaderCircle, RefreshCw, Settings2, Sparkles, X } from 'lucide-react';
import type { Paper } from '../shared/types';
import { hasPaperFile } from '../shared/paper-files';
import { MINERU_TIERS, type MineruEnvironment, type MineruState, type MineruTier } from '../shared/mineru';
import './MineruPanel.css';

export default function MineruPanel({ paper }: { paper: Paper }) {
  const [state, setState] = useState<MineruState | null>(null);
  const [environment, setEnvironment] = useState<MineruEnvironment | null>(null);
  const [tier, setTier] = useState<MineruTier>('basic');
  const [working, setWorking] = useState(false), [checking, setChecking] = useState(false), [settings, setSettings] = useState(false), [error, setError] = useState('');
  const running = state?.status === 'running';
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try { const next = await window.paperApi!.conversionState(paper.id); if (active) { setState(next); if (next.status === 'running') timer = setTimeout(refresh, 1500); } }
      catch (e) { if (active) setError(e instanceof Error ? e.message : String(e)); }
    };
    void refresh(); return () => { active = false; clearTimeout(timer); };
  }, [paper.id, working]);
  const action = async (fn: () => Promise<unknown>) => { setWorking(true); setError(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setWorking(false); } };
  const check = async () => { setChecking(true); setError(''); try { setEnvironment(await window.paperApi!.mineruEnvironment()); } catch (e) { setError(String(e)); } finally { setChecking(false); } };
  const convert = () => action(async () => {
    const env = await window.paperApi!.mineruEnvironment(); setEnvironment(env);
    if (!env.ready) { setSettings(true); throw new Error(env.message); }
    await window.paperApi!.convertPdf(paper.id, tier); setState(await window.paperApi!.conversionState(paper.id));
  });
  return <section className="mineru-panel" aria-label="AI 可读全文">
    <div className="mineru-heading"><h3><Sparkles size={14} />AI 可读全文<span>MinerU · 本机</span></h3>
      <button className="icon-button" title="MinerU 环境设置" aria-label="MinerU 环境设置" aria-expanded={settings} onClick={() => { setSettings(!settings); if (!settings && !environment) void check(); }}><Settings2 size={15} /></button></div>
    <p className="mineru-description">将 PDF 全文转换为 Markdown、结构化 JSON 和图片，便于交给 AI 阅读。</p>
    {!hasPaperFile(paper, 'pdf') ? <p className="mineru-help">添加 PDF 原文后即可转换。</p> : <>
      <label className="mineru-mode"><span>解析模式</span><select aria-label="MinerU 解析模式" value={tier} disabled={running || working} onChange={e => setTier(e.target.value as MineruTier)}>{MINERU_TIERS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}</select></label>
      <p className="mineru-help">{MINERU_TIERS.find(t => t.value === tier)!.help}</p>
      <div className="mineru-actions">{running ? <><span className="mineru-progress" role="status"><LoaderCircle size={15} className="spin" />正在转换…</span><button className="text-button" disabled={working} onClick={() => action(async () => setState(await window.paperApi!.cancelConversion(paper.id)))}><X size={13} />取消</button></>
        : <button className="secondary-button" disabled={working || checking} onClick={convert}>{working ? <LoaderCircle size={15} className="spin" /> : state?.result ? <RefreshCw size={15} /> : <Sparkles size={15} />}{state?.result ? '重新转换' : '转换为 AI 可读格式'}</button>}</div>
    </>}
    {state && state.status !== 'idle' && <p className={`mineru-message ${state.status === 'failed' ? 'mineru-error' : ''}`} role="status">{state.message}</p>}
    {state?.result && <div className="mineru-result">
      <p>最近成功：{new Date(state.result.completedAt).toLocaleString('zh-CN', { hour12: false })} · {state.result.images} 张图片</p>
      <div className="mineru-actions"><button className="text-button" onClick={() => action(() => window.paperApi!.openConversion(paper.id, 'markdown'))}><FileText size={14} />打开全文 MD</button>
        <button className="text-button" onClick={() => action(() => window.paperApi!.openConversion(paper.id, 'directory'))}><FolderOpen size={14} />结果文件夹</button></div>
    </div>}
    {settings && <div className="mineru-settings">
      <p>{checking ? '正在检测 MinerU 环境…' : environment?.message || '选择已安装的 MinerU 4.x 环境'}</p>
      {environment?.executable && <p className="mineru-path">{environment.executable}</p>}
      <div className="mineru-actions"><button className="text-button" disabled={checking || working || running} onClick={() => action(async () => { const env = await window.paperApi!.chooseMineruExecutable(); if (env) setEnvironment(env); })}>选择 MinerU 程序</button><button className="text-button" disabled={checking || working} onClick={check}>重新检测</button></div>
      <details><summary>本机安装说明</summary><p>使用 Python 3.12，在软件文件夹中创建独立环境，然后安装 MinerU：</p><pre>python -m venv .mineru-env{'\n'}.mineru-env\Scripts\python.exe -m pip install mineru==4.0.12</pre><p>完成后选择 .mineru-env\Scripts\mineru-kit.exe。换电脑需重新准备环境；转换结果随完整文献库保留。</p></details>
    </div>}
    {error && <p className="mineru-error" role="alert">{error}</p>}
    <p className="mineru-help">PDF 留在本机；结果独立保存，阅读笔记和 PDF 标注保持原样。</p>
  </section>;
}
