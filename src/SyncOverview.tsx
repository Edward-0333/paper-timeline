import { Activity, Clock3, CloudDownload, RefreshCw, TrendingUp } from 'lucide-react';
import type { CloudStatus } from '../shared/cloud';
import './SyncOverview.css';

const number = new Intl.NumberFormat('zh-CN');
const count = (value: number | undefined) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const display = (value: number | undefined) => value === undefined ? '—' : number.format(value);

interface ChartRow { label: string; value: number | undefined; color: string; unknown: string }
function CountChart({ title, description, rows }: { title: string; description: string; rows: ChartRow[] }) {
  const maximum = Math.max(0, ...rows.map(row => row.value ?? 0));
  return <figure className="sync-chart" aria-label={title}>
    <figcaption><h3>{title}</h3><p>{description}</p></figcaption>
    <div className="sync-chart-plot" role="img" aria-label={rows.map(row => `${row.label}：${row.value === undefined ? row.unknown : `${number.format(row.value)} 篇`}`).join('；')}>
      {rows.map(row => <div key={row.label} className="sync-chart-row" data-label={row.label} data-value={row.value ?? 'unknown'}
        title={`${row.label}：${row.value === undefined ? row.unknown : `${number.format(row.value)} 篇`}`}>
        <div className="sync-chart-label"><span><i style={{ backgroundColor: row.color }} />{row.label}</span><strong>{display(row.value)}<small>篇</small></strong></div>
        <div className={`sync-chart-track ${row.value === undefined ? 'unknown' : ''}`}><span className="sync-chart-fill" style={{ width: `${maximum ? (row.value ?? 0) / maximum * 100 : 0}%`, backgroundColor: row.color }} /></div>
        {row.value === undefined && <span className="sync-chart-unavailable">{row.unknown}</span>}
      </div>)}
      {maximum > 0 && <div className="sync-chart-axis" aria-hidden="true"><span>0</span><span>{number.format(maximum)} 篇</span></div>}
    </div>
  </figure>;
}

function RecentTime({ label, value, server = false }: { label: string; value?: string | null; server?: boolean }) {
  const date = value ? new Date(value) : null;
  const valid = date && !Number.isNaN(date.getTime());
  const Icon = server ? CloudDownload : RefreshCw;
  return <div className={`sync-recent-time ${server ? 'server' : 'local'}`}>
    <span className="sync-time-icon" aria-hidden="true"><Icon size={17} /></span>
    <div><span>{label}</span>{valid ? <time dateTime={date.toISOString()}>{date.toLocaleString('zh-CN', { hour12: false })}</time> : <span className="sync-no-time">尚无记录</span>}</div>
  </div>;
}

export default function SyncOverview({ cloud, loading }: { cloud: CloudStatus; loading: boolean }) {
  const overview = loading ? undefined : cloud.overview;
  const noData = loading ? '正在读取' : cloud.signedIn ? '同步后显示' : '登录同步后显示';
  const state = loading ? '读取中' : cloud.syncing ? '同步中' : cloud.connected ? '已连接' : overview || cloud.lastSyncAt ? '离线缓存' : '尚无云端数据';
  const syncFailed = !loading && !cloud.syncing && cloud.connected && !!cloud.error;
  const freshCitations = !loading && cloud.lastSyncAt ? count(cloud.newCitations) : undefined;
  const localPending = loading ? undefined : count(cloud.pending);
  const legacy = count(overview?.legacyMonitored);
  return <section className="home-card sync-overview" aria-label="同步概况">
    <div className="sync-overview-heading"><h2><Activity size={18} />同步概况</h2>
      <span className={`sync-data-state ${syncFailed ? 'warning' : cloud.connected ? 'connected' : ''}`}><i className={cloud.syncing ? 'sync-active' : ''} />{syncFailed ? '同步失败 · 上次完整同步数据' : state}</span></div>
    <div className="sync-visuals">
      <CountChart title="监控论文数量对比" description="当前文献库与整个账户的监控规模" rows={[
        { label: '本库云端已确认监控', value: count(overview?.libraryMonitored), color: '#4C7CDE', unknown: overview ? '服务器升级后显示' : noData },
        { label: '账户全部云端监控', value: count(overview?.monitored), color: '#55AAA5', unknown: noData },
      ]} />
      <CountChart title="云端抓取状态" description="账户当前的队列与更新异常" rows={[
        { label: '云端待抓取', value: count(overview?.queued), color: '#D8A03F', unknown: noData },
        { label: '云端未完整更新', value: count(overview?.failed), color: '#D47B70', unknown: noData },
      ]} />
      <div className="sync-round-summary">
        <div className="sync-number-stat sync-new-citations" data-label="本轮同步新增引用">
          <h3><TrendingUp size={16} />本轮同步新增引用</h3><div><strong>{display(freshCitations)}</strong><span>篇</span></div>
        </div>
        <div className="sync-pending-stats">
          <div className="sync-number-stat" data-label="本库待同步开关"><span>本库待同步开关</span><div><strong>{display(localPending)}</strong><small>项</small></div></div>
          <div className="sync-number-stat" data-label="旧网页监控待处理"><span>旧网页监控待处理</span><div><strong>{display(legacy)}</strong><small>项</small></div></div>
        </div>
      </div>
    </div>
    <div className="sync-recent-times"><RecentTime label="服务器最近成功抓取" value={loading ? undefined : overview?.lastServerFetchAt} server />
      <RecentTime label="本地最近完整同步" value={loading ? undefined : cloud.lastSyncAt} /></div>
    <p className="home-footnote sync-overview-note"><Clock3 size={13} aria-hidden="true" /><span>服务器时间表示相关论文中最近一次成功抓取；部分来源失败时，旧结果仍可查阅。未连接时显示上次同步的记录。</span></p>
  </section>;
}
