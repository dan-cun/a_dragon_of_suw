import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { CalendarDays, Flame, Info } from 'lucide-react';
import type { Outcome, RunRecord } from '../shared/contracts';
import { buildHeatmap, shiftCalendarDate, type HeatmapDay } from './heatmap-model';
import './heatmap.css';

interface HeatmapProps { history: readonly RunRecord[] }
type CalendarStyle = CSSProperties & { '--heatmap-weeks': number };
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
const outcomeLabels: Record<Outcome, string> = { success: '签到成功', 'already-signed': '服务端确认已签到', failed: '执行失败', unconfirmed: '待确认' };

function dayLabel(day: HeatmapDay): string {
  if (day.future) return `${day.date}，尚未到该日期`;
  return `${day.date}，${day.signed ? '已打卡' : '暂无确认记录'}，${day.failedAttempts} 次失败，${day.unconfirmedAttempts} 次待确认`;
}

function Heatmap({ history }: HeatmapProps) {
  const [now, setNow] = useState(() => new Date());
  const model = useMemo(() => buildHeatmap(history, now, 26), [history, now]);
  const [selectedDate, setSelectedDate] = useState(model.today);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const days = model.weeks.flatMap(week => week.days);
  const selected = days.find(day => day.date === selectedDate) ?? days.find(day => day.date === model.today);
  const style: CalendarStyle = { '--heatmap-weeks': model.weeks.length };

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  function navigate(event: KeyboardEvent<HTMLButtonElement>, date: string): void {
    const offset = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
    if (offset === undefined) return;
    event.preventDefault();
    const targetDate = shiftCalendarDate(date, offset);
    const target = days.find(day => day.date === targetDate && !day.future);
    if (!target) return;
    const button = buttons.current.get(target.date);
    if (!button) throw new Error('Calendar navigation target is not mounted.');
    setSelectedDate(target.date);
    button.focus();
  }

  return <section className="panel heatmap-panel" data-testid="checkin-heatmap">
    <div className="section-header"><div><h2>打卡热力表</h2><p>近 26 周 · 北京时间 · 本机保存的确认记录</p></div><span className="heatmap-period">{model.start.replaceAll('-', '.')} — {model.today.replaceAll('-', '.')}</span></div>
    <div className="heatmap-stats">
      <div><span className="heatmap-stat-icon confirmed"><CalendarDays size={18} /></span><div><strong data-testid="heatmap-confirmed-days">{model.confirmedDays}<small>天</small></strong><span>已打卡天数</span></div></div>
      <div><span className="heatmap-stat-icon streak"><Flame size={18} /></span><div><strong data-testid="heatmap-longest-streak">{model.longestStreak}<small>天</small></strong><span>区间内最长连续记录</span></div></div>
    </div>
    <div className="heatmap-scroll" data-testid="heatmap-scroll"><div className="heatmap-calendar" style={style}>
      <div className="heatmap-months" aria-hidden="true">{model.weeks.map(week => <span key={week.days[0]?.date}>{week.month}</span>)}</div>
      <div className="heatmap-body"><div className="heatmap-weekdays" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div>
        <div className="heatmap-weeks" role="group" aria-label="按日期选择打卡记录，方向键可切换日期">
          {model.weeks.map(week => <div className="heatmap-week" key={week.days[0]?.date}>{week.days.map(day => <button
            key={day.date} ref={button => { if (button) buttons.current.set(day.date, button); else buttons.current.delete(day.date); }}
            data-testid={`heatmap-day-${day.date}`} data-signed={day.signed}
            className={`heatmap-cell ${day.signed ? 'day-signed' : 'day-unconfirmed'} ${day.future ? 'future' : ''} ${day.date === model.today ? 'today' : ''} ${day.date === selected?.date ? 'selected' : ''}`}
            disabled={day.future} aria-label={dayLabel(day)} aria-pressed={day.date === selected?.date}
            title={dayLabel(day)} tabIndex={day.date === selected?.date ? 0 : -1}
            onClick={() => setSelectedDate(day.date)} onKeyDown={event => navigate(event, day.date)}>
            {(day.failedAttempts > 0 || day.unconfirmedAttempts > 0) && <span className="heatmap-attention" aria-hidden="true" />}
          </button>)}</div>)}
        </div>
      </div>
    </div></div>
    <div className="heatmap-legend" data-testid="heatmap-legend"><span>每天一次打卡，每格代表一天</span><div><span className="heatmap-swatch day-unconfirmed" />暂无确认记录<span className="heatmap-swatch day-signed" />已打卡<span className="heatmap-attention legend-dot" /><span>有失败或待确认记录</span></div></div>
    {selected && <div className="heatmap-detail" data-testid="heatmap-detail" aria-live="polite">
      <div className="heatmap-detail-heading"><h3 data-testid="heatmap-selected-date">{selected.date} <span>{selected.date === model.today ? '今天 · ' : ''}北京时间</span></h3><span className="tag neutral-tag">{selected.signed ? '已打卡' : '暂无确认记录'} · {selected.records.length} 条执行记录</span></div>
      {selected.records.length === 0 ? <div className="heatmap-empty" data-testid="heatmap-day-empty"><CalendarDays size={22} /><p>这一天没有本机保存的签到记录。空白不代表漏签。</p></div> : <div className="heatmap-records" data-testid="heatmap-day-records">{selected.records.map(record => <div className="heatmap-record" key={record.id}><div><strong>{record.taskTitle}</strong><p>{record.message}</p><span>{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(record.timestamp))} · {record.trigger === 'scheduled' ? '定时执行' : '手动执行'}</span></div><span className={`tag outcome-${record.outcome}`}>{outcomeLabels[record.outcome]}</span></div>)}</div>}
    </div>}
    <div className="heatmap-footnote"><Info size={15} /><p>统计最近 200 条本机执行记录。成功或服务端确认已签到才计入；同一天无论执行多少次，都只计一天。这里不是学校完整考勤记录。</p></div>
  </section>;
}

export default Heatmap;
