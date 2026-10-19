import type { ScheduleStatus, Settings } from '../shared/contracts';
import { getShanghaiClock } from '../core/time';
import { DakaError } from '../core/errors';
import { randomInt } from 'node:crypto';
import { assertScheduleSettings, isAutomaticWindowOpen } from '../core/schedule-policy';

export function freshSchedule(): ScheduleStatus {
  return { date: null, failures: 0, nextCheckAt: null, pausedReason: null, targetTime: null };
}

export function resumeSchedule(status: ScheduleStatus): ScheduleStatus {
  return { ...freshSchedule(), date: status.date, targetTime: status.targetTime };
}

function minutes(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

export function planSchedule(settings: Settings, status: ScheduleStatus, now: Date): ScheduleStatus {
  assertScheduleSettings(settings);
  const clock = getShanghaiClock(now);
  if (status.date === clock.date && status.targetTime !== null) return status;
  let targetTime = settings.scheduleTime;
  if (settings.scheduleMode === 'random') {
    const end = minutes(settings.scheduleEndTime);
    const start = Math.min(end, Math.max(minutes(settings.scheduleTime), clock.minuteOfDay));
    const late = 22 * 60;
    // Assign 75% probability to the late interval when both intervals remain available.
    const afterClass = start < late && end >= late ? randomInt(4) < 3 : start >= late;
    const lower = afterClass ? Math.max(start, late) : start;
    const upper = afterClass ? end : Math.min(end, late - 1);
    const selected = randomInt(lower, upper + 1);
    targetTime = `${String(Math.floor(selected / 60)).padStart(2, '0')}:${String(selected % 60).padStart(2, '0')}`;
  }
  const current = status.date === clock.date ? status : freshSchedule();
  return { ...current, date: clock.date, targetTime };
}

export function isScheduleDue(settings: Settings, status: ScheduleStatus, now: Date, boundaryEnd: string | null): boolean {
  const current = getShanghaiClock(now);
  const targetTime = status.date === current.date ? status.targetTime : null;
  const target = targetTime ?? (settings.scheduleMode === 'fixed' ? settings.scheduleTime : null);
  const eligible = isAutomaticWindowOpen(settings, now, boundaryEnd) && target !== null && current.time >= target;
  return eligible && (status.date !== current.date || (status.pausedReason === null
    && (status.nextCheckAt === null || now.getTime() >= status.nextCheckAt)));
}

export function nextScheduleCheck(status: ScheduleStatus, now: Date): ScheduleStatus {
  return { ...status, date: getShanghaiClock(now).date, failures: 0, nextCheckAt: now.getTime() + 60_000, pausedReason: null };
}

export function failedSchedule(status: ScheduleStatus, error: Error, message: string, now: Date): ScheduleStatus {
  const date = getShanghaiClock(now).date;
  const failures = Math.min(3, (status.date === date ? status.failures : 0) + 1);
  const transient = error instanceof DakaError && ['NETWORK_ERROR', 'TIMEOUT', 'RETRY_EXHAUSTED'].includes(error.code);
  const retry = transient && failures < 3;
  return { ...status, date, failures, nextCheckAt: retry ? now.getTime() + 60_000 : null,
    pausedReason: retry ? null : `${message} 请处理后重新登录、保存坐标或点击恢复检查。`.slice(0, 800) };
}
