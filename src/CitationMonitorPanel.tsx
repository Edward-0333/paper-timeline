import { useState } from 'react';
import { FolderOpen, LoaderCircle, Radio } from 'lucide-react';
import type { Paper } from '../shared/types';
import './CitationMonitorPanel.css';

const timeLabel = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
export default function CitationMonitorPanel({ paper, onChange, onOpen }: {
  paper: Paper; onChange: (enabled: boolean) => Promise<void>; onOpen: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const enabled = paper.citationMonitoring === true, state = paper.citationMonitor;
  const fetching = state?.status === 'fetching' || state?.status === 'queued';
  const toggle = async () => {
    setSaving(true); setError('');
    try { await onChange(!enabled); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };
  return <section className="citation-monitor-panel" aria-label="引用监控">
    <div className="citation-monitor-heading">
      <div><h3><Radio size={15} />引用监控</h3><p>服务器每天北京时间 08:00 开始检查</p></div>
      <button className={`citation-monitor-switch ${enabled ? 'is-on' : ''}`} type="button"
        role="switch" aria-checked={enabled} aria-label="引用监控开关" disabled={saving}
        onClick={toggle} title={enabled ? '关闭引用监控' : '开启引用监控'}>
        <span className="citation-monitor-switch-label" aria-hidden="true">{enabled ? 'ON' : 'OFF'}</span>
        <span className="citation-monitor-switch-knob" aria-hidden="true">{saving && <LoaderCircle size={15} className="spin" />}</span>
      </button>
    </div>
    <div className="citation-monitor-status" aria-live="polite">
      {enabled ? <span>{fetching && <LoaderCircle size={13} className="spin" />}
        {state?.status === 'migration' ? '旧监控待迁移' : state?.status === 'pending' ? '等待同步到服务器' : state?.status === 'fetching' ? '服务器正在拉取…' : state?.status === 'queued' ? '服务器等待拉取…'
          : state?.status === 'partial' ? '部分来源更新成功' : state?.status === 'error' ? '本轮未完成，将自动重试' : '监控已开启'}
      </span> : <span>{state?.status === 'pending' ? '关闭请求待同步' : '监控已关闭'}</span>}
      <span>已保存 {state?.count ?? 0} 篇</span>
    </div>
    {state?.lastSuccessAt && <p className="citation-monitor-time">最近更新：{timeLabel(state.lastSuccessAt)}</p>}
    {enabled && state?.nextCheckAt && <p className="citation-monitor-time">下次检查：{timeLabel(state.nextCheckAt)}</p>}
    {state?.message && <p className="citation-monitor-warning">{state.message}</p>}
    <div className="citation-monitor-footer">
      <small>云端抓取 · 连接后同步 · 仅保存引用数据</small>
      {paper.citationMonitoring !== undefined && <button className="text-button" type="button" title="打开此论文的引用数据文件夹"
        onClick={async () => { setError(''); try { await onOpen(); } catch (err) { setError(String(err)); } }}>
        <FolderOpen size={13} />数据目录
      </button>}
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
