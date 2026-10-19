import { useState } from 'react';
import type { OcsState } from '../shared/ocs';
import { formatTime } from './OcsTypes';

export function Logs({ state }: { state: OcsState }) {
  const [browserId, setBrowserId] = useState('');
  const logs = state.logs.filter(log => !browserId || (browserId === 'system' ? log.browserId === null : log.browserId === browserId));
  const removedIds = [...new Set(state.logs.map(log => log.browserId).filter((id): id is string => id !== null && !state.browsers.some(browser => browser.id === id)))];
  return <section className="ocs-box ocs-stack" data-testid="ocs-logs">
    <div className="ocs-toolbar"><div><h2>运行日志</h2><p>后台返回的浏览器与模块日志，不将启动成功当作课程完成。</p></div><select data-testid="ocs-log-browser" aria-label="筛选浏览器日志" value={browserId} onChange={event => setBrowserId(event.target.value)}><option value="">全部浏览器与模块</option><option value="system">仅模块日志</option>{state.browsers.map(browser => <option key={browser.id} value={browser.id}>{browser.name}</option>)}{removedIds.map(id => <option key={id} value={id}>已移除浏览器 · {id.slice(0, 8)}</option>)}</select></div>
    <div className="ocs-log-list" role="log" aria-label="OCS 后台日志" aria-live="off" data-testid="ocs-log-list">{logs.length ? logs.map(log => <article key={log.sequence} className={`ocs-log ${log.level}`} data-testid={`ocs-log-${log.sequence}`}><div className="ocs-log-meta"><time dateTime={log.at}>{formatTime(log.at)}</time><span>{log.level === 'error' ? '错误' : log.level === 'warning' ? '警告' : '信息'}</span><span>{state.browsers.find(browser => browser.id === log.browserId)?.name ?? (log.browserId ? '已移除浏览器' : 'OCS 模块')}</span><code>{log.event}</code></div><p>{log.message}</p></article>) : <p className="ocs-empty ocs-compact-empty" data-testid="ocs-log-empty">此筛选下没有后台日志。</p>}</div>
    <p className="ocs-help">日志范围及保留数量由后台决定。自动刷新失败时停止更新，页面继续保留上一次读取结果。</p>
  </section>;
}
