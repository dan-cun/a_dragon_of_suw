import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { dateRange, groupedDates } from '../core/schedule-policy';

interface Props {
  id: string;
  title: string;
  description: string;
  dates: string[];
  locked: boolean;
  onChange: (dates: string[]) => void;
}

export default function ScheduleDates({ id, title, description, dates, locked, onChange }: Props) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState('');
  function addRange(): void {
    try {
      const next = [...new Set([...dates, ...dateRange(start, end || start)])].sort();
      if (next.length > 366) throw new Error('每类日期最多保存 366 天，请移除不再需要的日期。');
      onChange(next); setError(''); setStart(''); setEnd('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '日期无法添加。'); }
  }
  return <section className="date-rule" data-testid={`${id}-rules`}>
    <h3>{title}</h3><p>{description}</p>
    <div className="date-rule-inputs">
      <label htmlFor={`${id}-start`}>开始日期<input id={`${id}-start`} data-testid={`${id}-start`} type="date" value={start} disabled={locked} onChange={event => setStart(event.target.value)} /></label>
      <label htmlFor={`${id}-end`}>结束日期（单日可留空）<input id={`${id}-end`} data-testid={`${id}-end`} type="date" min={start} value={end} disabled={locked} onChange={event => setEnd(event.target.value)} /></label>
      <button className="button secondary" data-testid={`${id}-add`} disabled={locked || !start} onClick={addRange}><Plus size={16} />添加日期</button>
    </div>
    {error && <p className="date-rule-error" role="alert" data-testid={`${id}-error`}>{error}</p>}
    <div className="date-rule-list" data-testid={`${id}-list`}>{groupedDates(dates).map(range => <span key={range.start} className="tag neutral-tag">{range.start}{range.start !== range.end ? ` 至 ${range.end}` : ''}<button data-testid={`${id}-remove-${range.start}`} className="date-rule-remove" aria-label={`移除 ${range.start} 至 ${range.end}`} disabled={locked} onClick={() => onChange(dates.filter(date => date < range.start || date > range.end))}><X size={14} /></button></span>)}</div>
    {dates.length === 0 && <p className="date-rule-empty">尚未设置日期</p>}
  </section>;
}
