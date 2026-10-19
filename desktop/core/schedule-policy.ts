import type { Settings, Task } from '../shared/contracts';
import { DakaError } from './errors';
import { getShanghaiClock, isDate } from './time';

export function assertScheduleSettings(settings: Settings): void {
  if (settings.scheduleMode === 'random' && settings.scheduleEndTime <= settings.scheduleTime) {
    throw new DakaError('INVALID_TASK', '随机时间段的结束时间必须晚于开始时间，不支持跨午夜。', undefined);
  }
  if (![...settings.pausedDates, ...settings.leaveDates].every(isDate)) {
    throw new DakaError('INVALID_TASK', '暂停或请假日期无效，请重新选择日期。', undefined);
  }
}

export function assertNotOnLeave(settings: Settings, now: Date): void {
  if (settings.leaveDates.includes(getShanghaiClock(now).date)) {
    throw new DakaError('LEAVE_DAY', '今天已设置为请假，手动和自动打卡均已禁止。', undefined);
  }
}

export function assertTaskNotOnLeave(task: Task): void {
  if (['请假', '已请假', '请假中'].includes(task.status.trim())) {
    throw new DakaError('LEAVE_DAY', '学校任务标记为请假，已禁止提交。', undefined);
  }
}

export function isAutomaticWindowOpen(settings: Settings, now: Date, boundaryEnd: string | null): boolean {
  const clock = getShanghaiClock(now);
  const knownTaskEnds = boundaryEnd !== null;
  return settings.scheduleEnabled && !settings.leaveDates.includes(clock.date) && !settings.pausedDates.includes(clock.date)
    && clock.time >= settings.scheduleTime
    && (settings.scheduleMode === 'fixed' || knownTaskEnds || clock.time <= settings.scheduleEndTime);
}

export function dateRange(start: string, end: string): string[] {
  if (!isDate(start) || !isDate(end) || end < start) throw new Error('请选择有效日期，结束日期不能早于开始日期。');
  const first = Date.parse(`${start}T00:00:00Z`);
  const count = (Date.parse(`${end}T00:00:00Z`) - first) / 86_400_000 + 1;
  if (count > 366) throw new Error('一次最多选择 366 天。');
  return Array.from({ length: count }, (_, index) => new Date(first + index * 86_400_000).toISOString().slice(0, 10));
}

export function groupedDates(dates: readonly string[]): { start: string; end: string }[] {
  return [...new Set(dates)].sort().reduce<{ start: string; end: string }[]>((ranges, date) => {
    const previous = ranges.at(-1);
    if (previous && Date.parse(`${date}T00:00:00Z`) - Date.parse(`${previous.end}T00:00:00Z`) === 86_400_000) {
      return [...ranges.slice(0, -1), { start: previous.start, end: date }];
    }
    return [...ranges, { start: date, end: date }];
  }, []);
}
