import type { Position, Task } from '../shared/contracts';
import { DakaError } from './errors';

export interface ShanghaiClock {
  date: string;
  time: string;
  dateTime: string;
  minuteOfDay: number;
}

export function getShanghaiClock(now: Date): ShanghaiClock {
  if (!Number.isFinite(now.getTime())) throw new DakaError('INVALID_TASK', '当前时间无效。', undefined);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const part = (name: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((entry) => entry.type === name)?.value;
    if (value === undefined) throw new DakaError('INVALID_TASK', `无法取得上海时间字段：${name}。`, undefined);
    return value;
  };
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  const time = `${part('hour')}:${part('minute')}`;
  return { date, time, dateTime: `${date} ${time}`, minuteOfDay: Number(part('hour')) * 60 + Number(part('minute')) };
}

export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function minutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  if (hour === undefined || minute === undefined) throw new DakaError('INVALID_TASK', '签到时段缺少小时或分钟。', undefined);
  return hour * 60 + minute;
}

export function assertCheckinWindow(task: Task, now: Date): void {
  const clock = getShanghaiClock(now);
  if (!isDate(task.date) || !task.window.every(isTime)) {
    throw new DakaError('INVALID_TASK', '任务日期或签到时段格式无效，请重新同步。', undefined);
  }
  const start = minutes(task.window[0]);
  const end = minutes(task.window[1]);
  if (end <= start) {
    throw new DakaError('INVALID_TASK', '当前任务包含跨午夜或空签到时段，无法确定服务端日期归属；请使用官方页面。', undefined);
  }
  if (clock.date !== task.date || clock.minuteOfDay < start || clock.minuteOfDay > end) {
    throw new DakaError('OUTSIDE_WINDOW', `签到仅限上海时间 ${task.date} ${task.window[0]}–${task.window[1]}。`, undefined);
  }
}

export function assertPosition(position: Position, now: Date): void {
  const age = now.getTime() - position.timestamp;
  if (!Number.isFinite(position.latitude) || position.latitude < -90 || position.latitude > 90
    || !Number.isFinite(position.longitude) || position.longitude < -180 || position.longitude > 180
    || !Number.isFinite(position.accuracy) || position.accuracy <= 0 || position.accuracy > 200
    || !Number.isFinite(position.timestamp) || !Number.isFinite(age) || age < -5_000 || age > 120_000
    || typeof position.address !== 'string' || position.address.length > 500) {
    throw new DakaError('INVALID_POSITION', '定位无效：请取得两分钟内的真实位置，精度应在 200 米以内。', undefined);
  }
}
