import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AppState, Settings } from '../shared/contracts';
import { historySchema, logSchema, scheduleSchema, settingsSchema, submissionSchema, legacyHoldSchema } from '../shared/validation';
import { getShanghaiClock } from '../core/time';
import { freshSchedule } from './scheduler';
import { assertScheduleSettings } from '../core/schedule-policy';

const sessionSchema = z.object({ username: z.string().min(1), displayName: z.string(), encryptedToken: z.string().min(1) });
export type StoredSession = z.infer<typeof sessionSchema>;
const schema = z.object({
  schemaVersion: z.literal(5), settings: settingsSchema, schedule: scheduleSchema,
  history: z.array(historySchema).max(200), logs: z.array(logSchema).max(600),
  lastScheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), session: sessionSchema.nullable(),
  submissions: z.array(submissionSchema).max(2000), legacyHold: legacyHoldSchema
});
export type SavedState = z.infer<typeof schema>;
const previousSettingsSchema = settingsSchema.omit({ scheduleMode: true, scheduleEndTime: true, pausedDates: true, leaveDates: true });
const version4Schema = schema.omit({ submissions: true, legacyHold: true }).extend({ schemaVersion: z.literal(4) });
const version3Schema = version4Schema.extend({
  schemaVersion: z.literal(3), settings: previousSettingsSchema, schedule: scheduleSchema.omit({ targetTime: true }),
});
const legacySchema = version3Schema.omit({ schedule: true }).extend({
  schemaVersion: z.literal(2), settings: previousSettingsSchema.omit({ location: true }),
});
export const initialSettings: Settings = { scheduleEnabled: false, scheduleTime: '21:00', scheduleMode: 'fixed', scheduleEndTime: '23:00',
  pausedDates: [], leaveDates: [], closeToTray: false, launchAtLogin: false, autoLogin: true, location: null };

export function readStore(directory: string): SavedState {
  const path = join(directory, 'state.json');
  if (!existsSync(path)) return { schemaVersion: 5, settings: { ...initialSettings, closeToTray: false }, schedule: freshSchedule(), history: [], logs: [], lastScheduledDate: null, session: null, submissions: [], legacyHold: null };
  const decoded: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const version = z.object({ schemaVersion: z.number() }).parse(decoded).schemaVersion;
  if (version === 2) {
    const legacy = legacySchema.parse(decoded);
    // A scan without an execution record did not reach submission in v2.
    const attempted = legacy.history.some(record => getShanghaiClock(new Date(record.timestamp)).date === legacy.lastScheduledDate);
    const lastScheduledDate = attempted ? legacy.lastScheduledDate : null;
    return { ...legacy, schemaVersion: 5, settings: { ...initialSettings, ...legacy.settings, location: null }, schedule: freshSchedule(),
      lastScheduledDate, submissions: [], legacyHold: lastScheduledDate === null ? null : { account: legacy.session?.username ?? null, date: lastScheduledDate } };
  }
  if (version === 3) {
    const previous = version3Schema.parse(decoded);
    return { ...previous, schemaVersion: 5, settings: { ...initialSettings, ...previous.settings }, schedule: { ...previous.schedule, targetTime: null },
      submissions: [], legacyHold: previous.lastScheduledDate === null ? null : { account: previous.session?.username ?? null, date: previous.lastScheduledDate } };
  }
  if (version === 4) {
    const previous = version4Schema.parse(decoded);
    assertScheduleSettings(previous.settings);
    return { ...previous, schemaVersion: 5, submissions: [], legacyHold: previous.lastScheduledDate === null ? null : { account: previous.session?.username ?? null, date: previous.lastScheduledDate } };
  }
  const saved = schema.parse(decoded);
  assertScheduleSettings(saved.settings);
  return { ...saved, submissions: saved.submissions.map(entry => entry.status === 'pending' && entry.checks >= 3
    ? { ...entry, status: 'unresolved', nextCheckAt: null, lastError: '上次末次回查未完整结束，自动核对已停止；请同步任务或到学校页面核实。' } : entry) };
}

export function writeStore(directory: string, state: Pick<AppState, 'settings' | 'schedule' | 'history' | 'logs' | 'lastScheduledDate' | 'submissions' | 'legacyHold'>, session: StoredSession | null): void {
  const saved = schema.parse({
    schemaVersion: 5, settings: state.settings, schedule: state.schedule, history: state.history.slice(0, 200), logs: state.logs.slice(-600),
    lastScheduledDate: state.lastScheduledDate, session, submissions: state.submissions, legacyHold: state.legacyHold
  });
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, 'state.json.pending');
  writeFileSync(temporary, JSON.stringify(saved, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, join(directory, 'state.json'));
}
