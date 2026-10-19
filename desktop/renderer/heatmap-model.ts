import type { RunRecord } from '../shared/contracts';
import { getShanghaiClock } from '../core/time';

const millisecondsPerDay = 86_400_000;

export interface HeatmapDay {
  date: string;
  future: boolean;
  signed: boolean;
  failedAttempts: number;
  unconfirmedAttempts: number;
  records: readonly RunRecord[];
}

export interface HeatmapWeek {
  month: string;
  days: readonly HeatmapDay[];
}

export interface HeatmapModel {
  today: string;
  start: string;
  weeks: readonly HeatmapWeek[];
  confirmedDays: number;
  longestStreak: number;
}

function dayNumber(date: string): number {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) throw new RangeError('Invalid check-in calendar date.');
  return Math.floor(timestamp / millisecondsPerDay);
}

export function shiftCalendarDate(date: string, offset: number): string {
  if (!Number.isInteger(offset)) throw new RangeError('Calendar offset must be an integer.');
  return new Date((dayNumber(date) + offset) * millisecondsPerDay).toISOString().slice(0, 10);
}

/** Aggregate one confirmed check-in per Shanghai date without mutating history. */
export function buildHeatmap(history: readonly RunRecord[], now: Date, weekCount: number): HeatmapModel {
  if (!Number.isInteger(weekCount) || weekCount < 1 || weekCount > 53) throw new RangeError('Calendar week count must be between 1 and 53.');
  const today = getShanghaiClock(now).date;
  const todayNumber = dayNumber(today);
  const mondayOffset = (new Date(todayNumber * millisecondsPerDay).getUTCDay() + 6) % 7;
  const startNumber = todayNumber - mondayOffset - (weekCount - 1) * 7;
  const grouped = new Map<string, RunRecord[]>();
  for (const record of history) {
    const date = getShanghaiClock(new Date(record.timestamp)).date;
    const number = dayNumber(date);
    if (number < startNumber || number > todayNumber) continue;
    const records = grouped.get(date);
    if (records) records.push(record);
    else grouped.set(date, [record]);
  }
  const weeks: HeatmapWeek[] = [];
  let confirmedDays = 0;
  let longestStreak = 0;
  let streak = 0;
  let previousMonth = '';
  for (let week = 0; week < weekCount; week += 1) {
    const days: HeatmapDay[] = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const number = startNumber + week * 7 + weekday;
      const date = new Date(number * millisecondsPerDay).toISOString().slice(0, 10);
      const records = [...(grouped.get(date) ?? [])].sort((left, right) => right.timestamp.localeCompare(left.timestamp));
      const signed = records.some(record => record.outcome === 'success' || record.outcome === 'already-signed');
      if (signed) {
        confirmedDays += 1;
        streak += 1;
        longestStreak = Math.max(longestStreak, streak);
      } else streak = 0;
      days.push({ date, future: number > todayNumber, signed,
        failedAttempts: records.filter(record => record.outcome === 'failed').length,
        unconfirmedAttempts: records.filter(record => record.outcome === 'unconfirmed').length, records });
    }
    const first = days[0];
    if (!first) throw new RangeError('Calendar week has no days.');
    const monthDate = week === 0 ? first : days.find(day => !day.future && day.date.endsWith('-01')) ?? first;
    const monthKey = monthDate.date.slice(0, 7);
    const month = monthKey === previousMonth ? '' : `${Number(monthDate.date.slice(5, 7))}月`;
    previousMonth = monthKey;
    weeks.push({ month, days });
  }
  return { today, start: new Date(startNumber * millisecondsPerDay).toISOString().slice(0, 10), weeks,
    confirmedDays, longestStreak };
}
