import { z } from 'zod';
import type { AppState } from './contracts';

export const phaseSchema = z.enum(['idle', 'authenticating', 'syncing', 'locating', 'verifying', 'submitting', 'confirming']);

export const locationSchema = z.object({
  longitude: z.number().finite().min(-180).max(180),
  latitude: z.number().finite().min(-90).max(90),
  address: z.string().trim().min(1).max(500),
});
export const scheduleSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  failures: z.number().int().min(0).max(3),
  nextCheckAt: z.number().finite().nonnegative().nullable(),
  pausedReason: z.string().max(800).nullable(),
  targetTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable(),
});
export const settingsSchema = z.object({
  scheduleEnabled: z.boolean(), scheduleTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  scheduleMode: z.enum(['fixed', 'random']),
  scheduleEndTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  pausedDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(366),
  leaveDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(366),
  closeToTray: z.literal(false), launchAtLogin: z.boolean(), autoLogin: z.boolean().default(true), location: locationSchema.nullable()
}).strict();
export const historySchema = z.object({
  id: z.string(), timestamp: z.string().datetime(), taskId: z.string(), taskTitle: z.string(),
  outcome: z.enum(['success', 'already-signed', 'failed', 'unconfirmed']), message: z.string(), trigger: z.enum(['manual', 'scheduled'])
});
export const submissionSchema = z.object({
  account: z.string().min(1).max(500), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  taskId: z.string().min(1).max(500), formId: z.string().min(1).max(500), title: z.string().max(500),
  window: z.tuple([z.string(), z.string()]), recordId: z.string().nullable(),
  status: z.enum(['pending', 'confirmed', 'unresolved']), attemptedAt: z.string().datetime(), confirmedAt: z.string().datetime().nullable(),
  checks: z.number().int().min(0).max(3), nextCheckAt: z.number().finite().nonnegative().nullable(), lastError: z.string().max(800).nullable()
});
export const legacyHoldSchema = z.object({ account: z.string().nullable(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).nullable();
export const logSchema = z.object({
  id: z.string(), timestamp: z.string().datetime(), level: z.enum(['info', 'warning', 'error']), event: z.string(), message: z.string(),
  request: z.object({
    host: z.literal('of.swu.edu.cn'), path: z.string().regex(/^\/gateway\/[a-zA-Z0-9\/_-]+$/),
    method: z.enum(['GET', 'POST']), httpStatus: z.number().int().min(100).max(599).nullable(), businessCode: z.number().int().nullable(),
    responseBytes: z.number().int().nonnegative().nullable(), elapsedMs: z.number().int().nonnegative(), attempt: z.number().int().min(1).max(3),
  }).optional(),
});
export const appStateSchema: z.ZodType<AppState> = z.object({
  version: z.string(), phase: phaseSchema,
  sessionStatus: z.enum(['signed-out', 'unverified', 'valid', 'rejected']),
  rememberedLogin: z.boolean(),
  profile: z.object({ username: z.string(), displayName: z.string() }).nullable(),
  tasks: z.array(z.object({
    id: z.string(), formId: z.string(), cqfbid: z.string(), dormitoryFormId: z.string(), title: z.string(), date: z.string(),
    status: z.string(), signed: z.boolean(), studentId: z.string(), window: z.tuple([z.string(), z.string()]), address: z.string(), radius: z.string()
  })).max(1000), settings: settingsSchema,
  history: z.array(historySchema).max(200), logs: z.array(logSchema).max(600), lastSyncedAt: z.string().nullable(),
  lastScheduledDate: z.string().nullable(),
  submissions: z.array(submissionSchema).max(2000), legacyHold: legacyHoldSchema,
  schedule: scheduleSchema,
  lastPosition: z.object({ latitude: z.number(), longitude: z.number(), accuracy: z.number(), timestamp: z.number(), address: z.string() }).nullable(),
  authentication: z.object({ active: z.boolean(), stage: z.enum(['preparing', 'ready', 'submitting']), message: z.string(), captcha: z.string(), captchaCode: z.string().regex(/^(?:\d{4})?$/), result: z.enum(['pending', 'success', 'failed']) }).nullable()
});
