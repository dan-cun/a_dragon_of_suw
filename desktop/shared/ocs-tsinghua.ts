import { z } from 'zod';

export const TSINGHUA_LEGACY_HOME = 'https://www.tsinghuaelt.com/legacy/home';
export const tsinghuaQuestionKindSchema = z.enum(['unknown', 'reading', 'single', 'multiple', 'judge', 'dropdown', 'fill', 'drag', 'listen_fill', 'audio', 'video', 'listen_repeat', 'oral', 'roleplay']);
export const tsinghuaMediaSchema = z.object({
  kind: z.enum(['audio', 'video']), phase: z.enum(['unloaded', 'paused', 'playing', 'ended', 'failed']),
  currentTime: z.number().finite().nonnegative(), duration: z.number().finite().nonnegative().nullable(),
  playbackRate: z.number().finite().positive(), muted: z.boolean(), errorCode: z.number().int().nullable()
}).strict();
export const tsinghuaResultSchema = z.object({
  observedAt: z.string(), source: z.enum(['exercise-submit', 'exercise-record', 'course-score', 'page']),
  accepted: z.boolean().nullable(), httpStatus: z.number().int().nullable(),
  score: z.number().finite().nullable(), maximumScore: z.number().finite().positive().nullable(),
  correctCount: z.number().int().nonnegative().nullable(), totalCount: z.number().int().positive().nullable(),
  accuracyPercent: z.number().min(0).max(100).nullable(), completionPercent: z.number().min(0).max(100).nullable(),
  message: z.string().max(1000)
}).strict();
export const tsinghuaQuestionSchema = z.object({
  id: z.string().min(1).max(200), kind: tsinghuaQuestionKindSchema, title: z.string().max(500),
  text: z.string().max(16000), referenceText: z.string().max(16000),
  page: z.number().int().positive().nullable(), totalPages: z.number().int().positive().nullable(),
  answered: z.boolean().nullable(), media: z.array(tsinghuaMediaSchema).max(20)
}).strict();
export const tsinghuaStateSchema = z.object({
  browserId: z.string().uuid(), runId: z.string().uuid().nullable(),
  phase: z.enum(['idle', 'opening', 'awaiting-login', 'selecting-course', 'navigating', 'ready', 'running', 'playing', 'awaiting-recording', 'awaiting-result', 'stopping', 'stopped', 'completed', 'failed']),
  owned: z.boolean(), message: z.string().max(2000), errorCode: z.string().nullable(), updatedAt: z.string(),
  courses: z.array(z.object({ id: z.number().int().positive(), title: z.string().min(1).max(500) }).strict()).max(100),
  courseId: z.number().int().positive().nullable(), courseTitle: z.string().max(500).nullable(),
  question: tsinghuaQuestionSchema.nullable(), result: tsinghuaResultSchema.nullable(),
  script: z.object({ installed: z.boolean(), enabled: z.boolean(), adapterVersion: z.string().nullable(), sourceDigest: z.string().nullable(), executionDigest: z.string().nullable() }).strict()
}).strict();
export type TsinghuaQuestionKind = z.infer<typeof tsinghuaQuestionKindSchema>;
export type TsinghuaQuestion = z.infer<typeof tsinghuaQuestionSchema>;
export type TsinghuaResult = z.infer<typeof tsinghuaResultSchema>;
export type TsinghuaState = z.infer<typeof tsinghuaStateSchema>;

export const tsinghuaOpenSchema = z.object({ command: z.literal('tsinghua-open'), id: z.string().uuid() }).strict();
export const tsinghuaSelectSchema = z.object({ command: z.literal('tsinghua-select-course'), id: z.string().uuid(), courseId: z.number().int().positive() }).strict();
export const tsinghuaStartSchema = z.object({ command: z.literal('tsinghua-start'), id: z.string().uuid(), confirmed: z.literal(true) }).strict();
export const tsinghuaStopSchema = z.object({ command: z.literal('tsinghua-stop'), id: z.string().uuid() }).strict();
export const tsinghuaRefreshSchema = z.object({ command: z.literal('tsinghua-refresh'), id: z.string().uuid() }).strict();
export const tsinghuaScoreSchema = z.object({ command: z.literal('tsinghua-read-score'), id: z.string().uuid() }).strict();
export const tsinghuaSliderSchema = z.object({ command: z.literal('tsinghua-verify-slider'), id: z.string().uuid(), confirmed: z.literal(true) }).strict();
export type TsinghuaCommand = z.infer<typeof tsinghuaOpenSchema> | z.infer<typeof tsinghuaSelectSchema> | z.infer<typeof tsinghuaStartSchema> | z.infer<typeof tsinghuaStopSchema> | z.infer<typeof tsinghuaRefreshSchema> | z.infer<typeof tsinghuaScoreSchema> | z.infer<typeof tsinghuaSliderSchema>;
