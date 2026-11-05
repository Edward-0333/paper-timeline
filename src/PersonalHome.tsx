import { useEffect, useRef, useState } from 'react';
import { BookOpen, Bot, Cloud, FileText, LogIn, MessageSquare, Radio, Settings2 } from 'lucide-react';
import type { Paper } from '../shared/types';
import { cloudConnectionLabel, type CloudStatus, type CloudReview } from '../shared/cloud';
import './PersonalHome.css';
import ModelSettingsCard from './ModelSettings';
import CloudConnectionDialog from './CloudConnectionDialog';
import SyncOverview from './SyncOverview';
import { collectionLabels, paperInCollection, type HomeMetric } from './home-collections';

const time = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无记录';
export default function PersonalHome({ papers, storagePath, onLibrary, onMetric, onAssistant, disabled }: {
  papers: Paper[]; storagePath: string; onLibrary: () => void; onMetric: (kind: HomeMetric) => void; onAssistant: () => void; disabled: boolean;
}) {
  const [cloud, setCloud] = useState<CloudStatus>({ signedIn: false, connected: false, syncing: false, pending: 0, legacyPending: 0, newCitations: 0 });
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [cloudLoading, setCloudLoading] = useState(true);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<CloudReview | null>(null);
  useEffect(() => {
    const api = window.paperApi;
    if (!api?.cloudStatus) { setCloudLoading(false); return; }
    let alive = true;
    const update = (s: CloudStatus) => { if (alive) setCloud(s); };
    const off = api.onCloudChanged(update);
    api.cloudStatus().then(update).catch(e => { if (alive) setError(String(e)); }).finally(() => { if (alive) setCloudLoading(false); });
    return () => { alive = false; off(); };
  }, []);
  async function action(fn: () => Promise<unknown>) {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError('');
    try { await fn(); setCloud(await window.paperApi!.cloudStatus()); return true; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
    finally { pending.current = false; setBusy(false); }
  }
  async function refreshReview(offset = 0) {
    let next = await window.paperApi!.cloudReview(offset);
    if (offset && !next.legacy.length) next = await window.paperApi!.cloudReview(0);
    setReview(next);
  }
  const metrics = [
    { kind: 'all' as const, label: '本地论文', icon: BookOpen },
    { kind: 'pdf' as const, label: collectionLabels.pdf, icon: FileText },
    { kind: 'md' as const, label: collectionLabels.md, icon: FileText },
    { kind: 'monitoring' as const, label: collectionLabels.monitoring, icon: Radio },
  ];
  return <main className="personal-home" aria-label="个人首页">
    <div className="home-welcome"><div><p>你的研究文献库</p><h1>{cloud.user ? `${cloud.user.username}，你好` : '个人首页'}</h1>
      <span>整理文献、追踪引用，继续上次的阅读。</span></div>
      <button className="primary-button" onClick={onLibrary}><BookOpen size={16} />打开文献库</button></div>
    <div className="home-metrics">{metrics.map(({ kind, label, icon: Icon }) => <button type="button" className="home-metric" key={kind}
      aria-label={label} disabled={disabled} onClick={() => onMetric(kind)} title={kind === 'all' ? '打开全部文献' : `打开${label}列表`}>
      <Icon size={20} /><span>{label}</span><strong>{papers.filter(paper => paperInCollection(paper, kind)).length}</strong></button>)}</div>
    <section className="home-card home-agent-card" aria-label="文献库助手入口">
      <div><h2><Bot size={20} />文献库助手</h2><p>通过对话整理分类和元数据，配置模型、管理云端引用监控。</p></div>
      <button className="primary-button" disabled={disabled || !window.paperApi?.chatLibrary} onClick={onAssistant}><MessageSquare size={16} />开始聊天</button>
    </section>
    <div className="home-config-cards">
      <ModelSettingsCard />
      <section className="home-card cloud-config-card" aria-label="云端引用监控">
        <div className="cloud-config-summary"><div className="cloud-config-title"><h2><Cloud size={19} />云端引用监控</h2>
        <span className={`cloud-connection ${cloud.error ? 'warning' : cloud.connected ? 'online' : ''}`}>{cloudConnectionLabel(cloud, cloudLoading)}</span></div>
          {cloud.signedIn ? <p className="cloud-config-account"><strong>{cloud.user?.username}</strong><span title={cloud.server}>{cloud.server}</span></p>
            : <p>连接 Paper Monitoring，每天自动追踪论文引用。</p>}
          {!!cloud.legacyPending && <p className="cloud-config-notice">{cloud.legacyPending} 篇旧本地监控待迁移</p>}
          {!connectionOpen && (error || cloud.error) && <p className="home-error" role="alert">{error || cloud.error}</p>}
          {!connectionOpen && cloud.failure?.title && <p className="cloud-failure-detail">相关论文：{cloud.failure.title}{cloud.failure.field && ` · ${cloud.failure.field}`}</p>}
        </div>
        <button type="button" className="secondary-button" disabled={cloudLoading || busy || !window.paperApi?.cloudStatus} onClick={() => { setError(''); setConnectionOpen(true); }}>
          {cloud.signedIn ? <Settings2 size={15} /> : <LogIn size={15} />}{cloud.signedIn ? '管理连接' : '登录并连接'}</button>
      </section>
    </div>
    <SyncOverview cloud={cloud} loading={cloudLoading} />
    <section className="home-card monitor-review" aria-label="监控清单对账">
      <div className="home-card-title"><h2>监控清单对账</h2><button className="secondary-button" disabled={!cloud.signedIn || busy || cloud.syncing} onClick={() => action(() => refreshReview())}>{busy ? '正在处理…' : review ? '刷新对账' : '检查监控差异'}</button></div>
      <p>当前库的订阅按本地开关管理；账户全部监控还包括旧网页和其他文献库。同一论文去重抓取，因此两处数量可能不同。</p>
      {cloud.signedIn && cloud.reconciliationSupported === false && <p className="cloud-migration">服务器需要升级才能使用对账；现有开关和引用同步仍可使用。</p>}
      {review && <>
        <div className="review-summary"><span>本库云端 {review.overview.libraryMonitored ?? '—'} 篇</span><span>账户全部 {review.overview.monitored} 篇</span><small>检查于 {time(review.checkedAt)}</small></div>
        <div className="review-section-title"><h3>当前库差异 · {review.differences.length} 项</h3>
          <button className="secondary-button" disabled={busy || cloud.syncing || !review.differences.length} onClick={() => action(async () => setReview(await window.paperApi!.cloudReconcile()))}>按本库开关对齐</button></div>
        <p>对齐会补交本库开关，并暂停当前库中找不到对应本地订阅的项目。旧网页和其他文献库的订阅分别保留。</p>
        {!review.differences.length ? <p className="review-empty">当前库开关与云端一致。</p> : <ul className="review-differences">{review.differences.map(d => <li key={d.localId}><strong>{d.title}</strong><span>{d.kind === 'orphan' ? '本库没有对应订阅，云端仍开启' : d.kind === 'version' ? '开关版本不同' : `本地${d.localEnabled ? '开启' : '关闭'} · 云端${d.remote ? d.remote.enabled ? '开启' : '关闭' : '未登记'}`}</span></li>)}</ul>}
        <div className="review-section-title"><h3>旧网页监控 · {review.total} 项待处理</h3></div>
        <p>“转入本库”会关联已有论文，或添加无 PDF 的文献条目，开启本库监控后停止这条旧订阅。“停止旧订阅”保留论文和历史引用；其他来源仍订阅时，云端继续抓取。</p>
        {!review.total ? <p className="review-empty">没有待处理的旧网页监控。</p> : <div className="legacy-monitors">{review.legacy.map(row => <article key={row.id}>
          <div><strong>{row.seed.title}</strong><p>{[row.seed.authors.join('、'), row.seed.year].filter(Boolean).join(' · ')}</p>
          {review.bindings.some(b => b.paperId === row.paperId && b.enabled) && <small>本库已监控，仍需处理旧订阅</small>}</div>
          <div className="legacy-actions"><button className="secondary-button" disabled={busy || cloud.syncing} onClick={() => action(async () => { await window.paperApi!.cloudImportLegacy(row.id, row.revision); await refreshReview(review.offset); })}>转入本库</button>
          <button className="secondary-button stop-legacy" disabled={busy || cloud.syncing} onClick={() => action(async () => { await window.paperApi!.cloudStopLegacy(row.id, row.revision); await refreshReview(review.offset); })}>停止旧订阅</button></div>
        </article>)}</div>}
        {review.total > 20 && <div className="review-pagination"><button className="secondary-button" disabled={busy || !review.offset} onClick={() => action(() => refreshReview(Math.max(0, review.offset - 20)))}>上一页</button><span>{review.offset + 1}–{Math.min(review.offset + 20, review.total)} / {review.total}</span><button className="secondary-button" disabled={busy || review.nextOffset === null} onClick={() => action(() => refreshReview(review.nextOffset!))}>下一页</button></div>}
      </>}
    </section>
    <div className="home-storage"><span>当前本地文献库</span><code>{storagePath || '正在读取…'}</code><small>统计包含无 PDF 的文献，不受列表或时间线筛选影响。</small></div>
    {connectionOpen && <CloudConnectionDialog cloud={cloud} busy={busy} error={error}
      onLogin={(server, username, password) => action(() => window.paperApi!.cloudLogin(server, username, password))}
      onSync={() => action(() => window.paperApi!.cloudSync())}
      onLogout={() => action(async () => { await window.paperApi!.cloudLogout(); setReview(null); })}
      onMigrate={() => action(() => window.paperApi!.cloudMigrate())}
      onClose={() => { setConnectionOpen(false); setError(''); }} />}
  </main>;
}
