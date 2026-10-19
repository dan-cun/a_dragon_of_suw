import { Clock3, Info } from 'lucide-react';
import type { Settings } from '../shared/contracts';
import ScheduleDates from './ScheduleDates';

interface Props {
  settings: Settings;
  locked: boolean;
  onChange: (settings: Partial<Settings>) => void;
}

export default function SchedulePreferences({ settings, locked, onChange }: Props) {
  return <section className="panel settings-panel">
    <div className="section-header"><div><h2>签到安排</h2><p>北京时间；设置后点击下方“保存设置”生效。</p></div><Clock3 size={21} className="section-icon" /></div>
    <div className="setting-row"><div><h3>定时签到</h3><p>使用已保存坐标；每项任务独立防重，已提交的任务只核对结果。</p></div><input data-testid="schedule-enabled" aria-label="定时签到" type="checkbox" className="toggle" disabled={locked} checked={settings.scheduleEnabled} onChange={event => onChange({ scheduleEnabled: event.target.checked })} /></div>
    <div className="setting-row"><div><h3>时间安排</h3><p>随机模式每天选定一次，重启和恢复检查不会重新抽取。</p></div><select data-testid="schedule-mode" aria-label="时间安排" className="time-input" disabled={locked} value={settings.scheduleMode} onChange={event => onChange({ scheduleMode: event.target.value === 'random' ? 'random' : 'fixed' })}><option value="fixed">固定时间</option><option value="random">时间段内随机</option></select></div>
    <div className="setting-row"><div><h3>{settings.scheduleMode === 'random' ? '随机时间段' : '执行时间'}</h3><p>{settings.scheduleMode === 'random' ? '跨越 22:00 的区间，有 75% 概率选在 22:00 之后；同一任务不会重复提交。' : '到点后每 60 秒检查开放任务。'}</p></div><div className="schedule-time-range"><input data-testid="schedule-time" aria-label="开始时间（北京时间）" type="time" className="time-input" required disabled={locked} value={settings.scheduleTime} onChange={event => onChange({ scheduleTime: event.target.value })} />{settings.scheduleMode === 'random' && <><span>至</span><input data-testid="schedule-end-time" aria-label="结束时间（北京时间）" type="time" className="time-input" required disabled={locked} value={settings.scheduleEndTime} onChange={event => onChange({ scheduleEndTime: event.target.value })} /></>}</div></div>
    <ScheduleDates id="paused" title="暂停自动打卡" description="实习或其他安排可按单日、连续日期段暂停。只停止自动任务，手动操作仍可用。" dates={settings.pausedDates} locked={locked} onChange={dates => onChange({ pausedDates: dates })} />
    <ScheduleDates id="leave" title="请假：禁止打卡" description="请假日期同时禁止手动和自动打卡。请在这里登记请假日期；尚未接入学校请假单同步。" dates={settings.leaveDates} locked={locked} onChange={dates => onChange({ leaveDates: dates })} />
    <div className="info-note"><Info size={17} /><p>电脑须开机联网，后台保持运行且登录会话有效。随机时点后无任务会继续检查，超过所设结束时间不再自动补打。请假或暂停日期不自动发现或提交任务；已提交结果仍可有限只读核对。提交前暂时故障最多连续尝试 3 轮。</p></div>
  </section>;
}
