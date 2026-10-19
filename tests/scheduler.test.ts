import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failedSchedule, freshSchedule, isScheduleDue, nextScheduleCheck, planSchedule, resumeSchedule } from '../desktop/bun/scheduler';
import { getShanghaiClock } from '../desktop/core/time';
import type { Settings } from '../desktop/shared/contracts';
import { DakaError } from '../desktop/core/errors';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialSettings, readStore, writeStore } from '../desktop/bun/store';
import { assertNotOnLeave, assertScheduleSettings, dateRange, groupedDates } from '../desktop/core/schedule-policy';

const settings: Settings = { ...initialSettings, scheduleEnabled: true };

test('Scheduled discovery follows the school timezone independently of per-task submission claims', () => {
  const now = new Date('2026-09-30T13:00:00Z');
  assert.equal(getShanghaiClock(now).date, '2026-09-30');
  assert.equal(getShanghaiClock(now).time, '21:00');
  assert.equal(isScheduleDue(settings, freshSchedule(), now, null), true);
  assert.equal(isScheduleDue(settings, freshSchedule(), new Date('2026-09-30T12:59:00Z'), null), false);
  assert.equal(isScheduleDue({ ...settings, scheduleEnabled: false }, freshSchedule(), now, null), false);
  assert.equal(isScheduleDue(settings, freshSchedule(), new Date('2026-10-01T13:00:00Z'), null), true);
});

test('An empty scan continues checking after one minute and does not consume the day', () => {
  const now = new Date('2026-10-09T13:00:00Z');
  const waiting = nextScheduleCheck(freshSchedule(), now);
  assert.equal(isScheduleDue(settings, waiting, new Date(now.getTime() + 59_999), null), false);
  assert.equal(isScheduleDue(settings, waiting, new Date(now.getTime() + 60_000), null), true);
});

test('Pre-submit transient failures retry at most three times and the retry budget survives disk reload', () => {
  const directory = mkdtempSync(join(tmpdir(), 'swu-scheduler-'));
  let now = new Date('2026-10-09T13:00:00Z');
  const initial = readStore(directory);
  let state = { ...initial, settings };
  const failure = new DakaError('RETRY_EXHAUSTED', 'HTTP 503', undefined);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.equal(isScheduleDue(settings, state.schedule, now, null), true);
    state = { ...state, schedule: failedSchedule(state.schedule, failure, failure.message, now) };
    writeStore(directory, state, null);
    const restored = readStore(directory);
    assert.equal(restored.schedule.failures, attempt);
    assert.equal(restored.lastScheduledDate, null);
    assert.equal(isScheduleDue(settings, restored.schedule, new Date(now.getTime() + 59_999), null), false);
    now = new Date(now.getTime() + 60_000);
    state = restored;
  }
  assert.equal(isScheduleDue(settings, state.schedule, now, null), false);
  assert.ok(state.schedule.pausedReason?.includes('HTTP 503'));
  assert.equal(isScheduleDue(settings, freshSchedule(), now, null), true);
  assert.equal(isScheduleDue(settings, state.schedule, new Date('2026-10-10T13:00:00Z'), null), true);
});

test('Actionable errors pause immediately; legacy day markers are preserved for safe migration', () => {
  const now = new Date('2026-10-09T13:00:00Z');
  for (const code of ['AUTH_REQUIRED', 'INVALID_POSITION', 'OUTSIDE_AREA', 'HTTP_ERROR'] as const) {
    const failure = new DakaError(code, code, undefined);
    const status = failedSchedule(freshSchedule(), failure, failure.message, now);
    assert.equal(status.failures, 1);
    assert.equal(isScheduleDue(settings, status, new Date(now.getTime() + 60_000), null), false);
  }
  const directory = mkdtempSync(join(tmpdir(), 'swu-submission-'));
  const state = { ...readStore(directory), settings, lastScheduledDate: getShanghaiClock(now).date };
  writeStore(directory, state, null);
  const restored = readStore(directory);
  assert.equal(restored.lastScheduledDate, '2026-10-09');
  assert.equal(isScheduleDue(settings, restored.schedule, now, null), true);
});

test('Version 2 empty-scan markers migrate without losing preferences or creating history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'swu-migration-'));
  const state = readStore(directory);
  const { location, scheduleMode, scheduleEndTime, pausedDates, leaveDates, ...previousSettings } = state.settings;
  assert.equal(location, null);
  assert.equal(scheduleMode, 'fixed'); assert.equal(scheduleEndTime, '23:00');
  assert.deepEqual(pausedDates, []); assert.deepEqual(leaveDates, []);
  writeFileSync(join(directory, 'state.json'), JSON.stringify({ schemaVersion: 2, settings: previousSettings,
    history: state.history, logs: state.logs, lastScheduledDate: '2026-10-09', session: null }));
  const restored = readStore(directory);
  assert.equal(restored.schemaVersion, 5);
  assert.equal(restored.lastScheduledDate, null);
  assert.deepEqual(restored.settings, state.settings);
  assert.deepEqual(restored.history, []);
  writeStore(directory, restored, restored.session);
  assert.equal(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).schemaVersion, 5);
});

test('Version 5 state without the auto-login switch keeps automatic login enabled by default', () => {
  const directory = mkdtempSync(join(tmpdir(), 'swu-auto-login-'));
  const state = readStore(directory);
  const { autoLogin, ...settingsWithoutAutoLogin } = state.settings;
  assert.equal(autoLogin, true);
  writeFileSync(join(directory, 'state.json'), JSON.stringify({ ...state, settings: settingsWithoutAutoLogin }));
  const restored = readStore(directory);
  assert.equal(restored.settings.autoLogin, true);
});

test('Random plans stay within the window, favor after-class times, and survive resume and disk reload', () => {
  const randomSettings: Settings = { ...settings, scheduleMode: 'random', scheduleTime: '21:05', scheduleEndTime: '23:00' };
  const beforeWindow = new Date('2026-10-09T12:00:00Z');
  let lateCount = 0;
  for (let index = 0; index < 2048; index += 1) {
    const plan = planSchedule(randomSettings, freshSchedule(), beforeWindow);
    assert.ok(plan.targetTime !== null && plan.targetTime >= '21:05' && plan.targetTime <= '23:00');
    if (plan.targetTime >= '22:00') lateCount += 1;
  }
  assert.ok(lateCount / 2048 > 0.65 && lateCount / 2048 < 0.85);
  const directory = mkdtempSync(join(tmpdir(), 'swu-random-'));
  const plan = planSchedule(randomSettings, freshSchedule(), beforeWindow);
  const initial = readStore(directory);
  writeStore(directory, { ...initial, settings: randomSettings, schedule: plan }, null);
  const restored = readStore(directory);
  assert.equal(planSchedule(restored.settings, restored.schedule, new Date('2026-10-09T14:20:00Z')).targetTime, plan.targetTime);
  assert.equal(planSchedule(randomSettings, resumeSchedule(plan), beforeWindow).targetTime, plan.targetTime);
  assert.equal(isScheduleDue(randomSettings, plan, new Date('2026-10-09T15:01:00Z'), null), false);
  assert.equal(isScheduleDue(randomSettings, plan, new Date('2026-10-09T15:01:00Z'), '23:30'), true);
  const lateStart = planSchedule(randomSettings, freshSchedule(), new Date('2026-10-09T14:45:00Z'));
  assert.ok(lateStart.targetTime !== null && lateStart.targetTime >= '22:45');
  assert.throws(() => assertScheduleSettings({ ...randomSettings, scheduleEndTime: '20:00' }));
});

test('Paused dates stop automation while leave dates also prohibit manual submissions', () => {
  const now = new Date('2026-10-09T14:00:00Z');
  const paused = { ...settings, pausedDates: ['2026-10-09'] };
  assert.equal(isScheduleDue(paused, freshSchedule(), now, null), false);
  assert.doesNotThrow(() => assertNotOnLeave(paused, now));
  const leave = { ...settings, leaveDates: ['2026-10-09'] };
  assert.equal(isScheduleDue(leave, freshSchedule(), now, null), false);
  assert.throws(() => assertNotOnLeave(leave, now), (error: Error) => error instanceof DakaError && error.code === 'LEAVE_DAY');
  assert.doesNotThrow(() => assertNotOnLeave(leave, new Date('2026-10-10T14:00:00Z')));
  assert.deepEqual(dateRange('2026-10-09', '2026-10-11'), ['2026-10-09', '2026-10-10', '2026-10-11']);
  assert.deepEqual(groupedDates(['2026-10-11', '2026-10-09', '2026-10-10']), [{ start: '2026-10-09', end: '2026-10-11' }]);
  assert.throws(() => dateRange('2026-02-30', '2026-03-01'));
});

test('Version 3 migration preserves today submission and retry state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'swu-v3-'));
  const state = readStore(directory);
  const { scheduleMode, scheduleEndTime, pausedDates, leaveDates, ...previousSettings } = state.settings;
  assert.equal(scheduleMode, 'fixed'); assert.equal(scheduleEndTime, '23:00'); assert.deepEqual(pausedDates, []); assert.deepEqual(leaveDates, []);
  const failure = failedSchedule(freshSchedule(), new DakaError('TIMEOUT', 'Timeout', undefined), 'Timeout', new Date('2026-10-09T13:00:00Z'));
  const { targetTime, ...previousSchedule } = failure;
  assert.equal(targetTime, null);
  writeFileSync(join(directory, 'state.json'), JSON.stringify({ ...state, schemaVersion: 3, settings: previousSettings, schedule: previousSchedule, lastScheduledDate: '2026-10-09' }));
  const restored = readStore(directory);
  assert.equal(restored.schemaVersion, 5);
  assert.equal(restored.lastScheduledDate, '2026-10-09');
  assert.equal(restored.schedule.failures, 1);
  assert.equal(restored.schedule.nextCheckAt, failure.nextCheckAt);
});
