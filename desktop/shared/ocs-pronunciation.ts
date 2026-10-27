import { z } from 'zod';

export const ocsPronunciationVoiceSchema = z.object({ id: z.string().min(1).max(300), name: z.string().min(1).max(300), language: z.string().min(1).max(40) }).strict();
export type OcsPronunciationVoice = z.infer<typeof ocsPronunciationVoiceSchema>;
export const ocsPronunciationStateSchema = z.object({
  engine: z.literal('windows-system-speech'), catalogue: z.enum(['unprepared', 'ready', 'unavailable']),
  voices: z.array(ocsPronunciationVoiceSchema).max(100),
  phase: z.enum(['idle', 'requested', 'speaking', 'stopping', 'ended', 'stopped', 'failed']),
  owned: z.boolean(), message: z.string(), errorCode: z.string().nullable()
}).strict();
export type OcsPronunciationState = z.infer<typeof ocsPronunciationStateSchema>;
export const ocsPronunciationPrepareSchema = z.object({ command: z.literal('pronunciation-prepare') }).strict();
export const ocsPronunciationSpeakSchema = z.object({ command: z.literal('pronunciation-speak'), voiceId: z.string().min(1).max(300), text: z.string().trim().min(1).max(2000), rate: z.number().int().min(-5).max(5) }).strict();
export type OcsPronunciationSpeak = z.infer<typeof ocsPronunciationSpeakSchema>;
export const ocsPronunciationStopSchema = z.object({ command: z.literal('pronunciation-stop') }).strict();
