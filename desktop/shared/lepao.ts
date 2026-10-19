import { z } from 'zod';

export const lepaoCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.enum(['state', 'check', 'certificate', 'stop', 'cleanup']) }).strict(),
  z.object({ command: z.enum(['dry', 'activate', 'remove', 'forget']), member: z.string().trim().min(1).max(100) }).strict(),
  z.object({ command: z.enum(['capture', 'run']), member: z.string().trim().min(1).max(100), allowSystemProxy: z.literal(true) }).strict(),
  z.object({ command: z.literal('add'), name: z.string().trim().min(1).max(80), student: z.string().regex(/^[A-Za-z0-9_-]{3,40}$/), school: z.number().int().positive().max(100000) }).strict(),
]);
export type LepaoCommand = z.infer<typeof lepaoCommandSchema>;
export const lepaoOperationSchema = z.object({
  id: z.uuid(), action: z.enum(['check', 'certificate', 'capture', 'dry', 'run']), member: z.string().nullable(), memberLabel: z.string().nullable(),
  startedAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }).nullable(),
  phase: z.enum(['preparing', 'waiting-login', 'validating', 'executing', 'confirming', 'restoring', 'stopping', 'finished']),
  status: z.enum(['running', 'succeeded', 'cancelled', 'timed-out', 'needs-session', 'pending-review', 'invalid', 'failed']),
  message: z.string().max(1500), cancelRequested: z.boolean(), proxyRestored: z.boolean().nullable(),
});
export type LepaoOperation = z.infer<typeof lepaoOperationSchema>;
export const lepaoSnapshotSchema = z.object({
  operation: lepaoOperationSchema.nullable(),
  busy: z.boolean(), action: z.string().max(100), result: z.string().max(1500), proxyRecoveryNeeded: z.boolean(),
  members: z.array(z.object({ key: z.string(), label: z.string(), student: z.string(), enabled: z.boolean(), state: z.string(), active: z.boolean(),
    sessionState: z.enum(['missing', 'available', 'expired', 'consumed', 'invalid']), expiresAt: z.string().nullable(),
    lastSubmission: z.object({ submittedAt: z.iso.datetime({ offset: true }), checkedAt: z.iso.datetime({ offset: true }).nullable(),
      distanceKm: z.number().finite().nonnegative().nullable(), durationSeconds: z.number().finite().nonnegative().nullable(),
      status: z.enum(['valid', 'invalid', 'pending']) }).nullable() })).max(100),
  privacy: z.object({ storage: z.literal('windows-dpapi'), sessionRetentionHours: z.literal(24), rawFiles: z.number().int().nonnegative(), rawBytes: z.number().int().nonnegative(), lastCleanupAt: z.string().nullable() }).nullable(),
  capabilities: z.object({
    proxyReady: z.boolean(), wechatFound: z.boolean(), certificateTrusted: z.boolean(), certificatePresent: z.boolean(),
    certificateHint: z.string(), upstreamMode: z.enum(['direct', 'proxy']), upstreamReady: z.boolean(), licenseValid: z.boolean(),
  }).nullable(),
});
export const lepaoLogSchema = z.object({ id: z.string(), time: z.string(), level: z.enum(['info', 'warning', 'error']), message: z.string().max(1500) });
export const lepaoStateSchema = lepaoSnapshotSchema.extend({ logs: z.array(lepaoLogSchema).max(300) });
export type LepaoState = z.infer<typeof lepaoStateSchema>;

export interface LepaoBridge {
  execute(command: LepaoCommand): Promise<import('./contracts').Result<LepaoState>>;
}

declare global {
  interface Window { lepao: LepaoBridge }
}
