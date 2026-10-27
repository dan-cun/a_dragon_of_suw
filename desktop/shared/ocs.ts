import { z } from 'zod';
import type { Result } from './contracts';
import { ocsLoginResultSchema } from './ocs-login';
import { ocsPronunciationStateSchema, ocsPronunciationPrepareSchema, ocsPronunciationSpeakSchema, ocsPronunciationStopSchema } from './ocs-pronunciation';
import { tsinghuaStateSchema, tsinghuaOpenSchema, tsinghuaSelectSchema, tsinghuaStartSchema, tsinghuaStopSchema, tsinghuaRefreshSchema, tsinghuaScoreSchema, tsinghuaSliderSchema } from './ocs-tsinghua';

const id = z.string().uuid();
const text = z.string().max(2000);
const browserMetadataSchema = z.object({
  name: z.string().trim().min(1).max(100), folder: z.string().max(100), notes: text,
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  startUrl: z.string().max(2000).refine(value => value === 'about:blank' || /^https?:\/\//i.test(value), 'Browser start URL must use HTTP(S) or about:blank.')
});
export const ocsSettingsSchema = z.object({ syncEnabled: z.boolean(), enableDialogs: z.boolean(), forceUpdateScripts: z.boolean(), globalConfigJson: z.string().max(524288) }).strict();
export type OcsSettings = z.infer<typeof ocsSettingsSchema>;
export const ocsBrowserSchema = browserMetadataSchema.extend({
  id, phase: z.enum(['stopped', 'starting', 'running', 'stopping', 'failed']),
  pid: z.number().int().positive().nullable(), owned: z.boolean(), lastError: z.string().nullable(),
  automationName: z.string().nullable(), createdAt: z.string(), updatedAt: z.string()
});
export type OcsBrowser = z.infer<typeof ocsBrowserSchema>;
export const ocsStateSchema = z.object({
  version: z.literal('2.12.0'), integration: z.literal('source'), phase: z.enum(['ready', 'unavailable']),
  message: z.string(), dataDirectory: z.string(), browserExecutable: z.string(),
  configurationRevision: z.number().int().nonnegative(),
  browsers: z.array(ocsBrowserSchema),
  userScripts: z.array(z.object({ id, name: z.string(), version: z.string(), source: z.string(), enabled: z.boolean(), digest: z.string().regex(/^[a-f0-9]{64}$/), configSyncAuthorized: z.boolean() }).strict()),
  extensions: z.array(z.object({ id, name: z.string(), version: z.string(), enabled: z.boolean() })),
  settings: ocsSettingsSchema,
  pronunciation: ocsPronunciationStateSchema,
  tsinghua: z.array(tsinghuaStateSchema).max(100),
  automationRun: z.object({ browserId: id, at: z.string(), result: ocsLoginResultSchema }).strict().nullable(),
  automationCatalog: z.array(z.object({ name: z.string(), fields: z.array(z.object({ key: z.string(), label: z.string(), secret: z.boolean(), initialValue: z.string() })) })),
  logs: z.array(z.object({ sequence: z.number().int(), at: z.string(), browserId: id.nullable(), level: z.enum(['info', 'warning', 'error']), event: z.string(), message: z.string() })),
  capabilities: z.array(z.object({ id: z.string(), label: z.string(), available: z.boolean(), detail: z.string() })),
  preview: z.object({ browserId: id, image: z.string().max(8388608), at: z.string() }).nullable()
});
export type OcsState = z.infer<typeof ocsStateSchema>;
export const ocsCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('state') }).strict(),
  z.object({ command: z.literal('data') }).strict(),
  ocsPronunciationPrepareSchema, ocsPronunciationSpeakSchema, ocsPronunciationStopSchema,
  tsinghuaOpenSchema, tsinghuaSelectSchema, tsinghuaStartSchema, tsinghuaStopSchema, tsinghuaRefreshSchema, tsinghuaScoreSchema, tsinghuaSliderSchema,
  z.object({ command: z.literal('browser-create'), browser: browserMetadataSchema }).strict(),
  z.object({ command: z.literal('browser-update'), id, browser: browserMetadataSchema }).strict(),
  z.object({ command: z.literal('browser-delete'), id }).strict(),
  z.object({ command: z.literal('browser-start'), id }).strict(),
  z.object({ command: z.literal('browser-stop'), id }).strict(),
  z.object({ command: z.literal('browser-focus'), id }).strict(),
  z.object({ command: z.literal('browser-preview'), id }).strict(),
  z.object({ command: z.literal('browsers-stop') }).strict(),
  z.object({ command: z.literal('automation-save'), id, name: z.string().min(1).max(200), values: z.array(z.object({ key: z.string().min(1).max(100), value: text }).strict()).max(30) }).strict(),
  z.object({ command: z.literal('automation-clear'), id }).strict(),
  z.object({ command: z.literal('automation-run'), id, name: z.string().min(1).max(200), confirmed: z.literal(true) }).strict(),
  z.object({ command: z.literal('script-import'), name: z.string().min(1).max(200), content: z.string().min(1).max(524288) }).strict(),
  z.object({ command: z.literal('script-download'), url: z.url().max(2000) }).strict(),
  z.object({ command: z.literal('script-install-tsinghua'), confirmed: z.literal(true) }).strict(),
  z.object({ command: z.literal('script-enable'), id, enabled: z.boolean() }).strict(),
  z.object({ command: z.literal('script-delete'), id }).strict(),
  z.object({ command: z.literal('script-config-sync'), id, digest: z.string().regex(/^[a-f0-9]{64}$/), authorized: z.boolean(), confirmed: z.literal(true) }).strict(),
  z.object({ command: z.literal('extension-import'), directory: z.string().min(1).max(2000) }).strict(),
  z.object({ command: z.literal('extension-enable'), id, enabled: z.boolean() }).strict(),
  z.object({ command: z.literal('extension-delete'), id }).strict(),
  z.object({ command: z.literal('settings-save'), settings: ocsSettingsSchema }).strict()
]);
export type OcsCommand = z.infer<typeof ocsCommandSchema>;
declare global { interface Window { ocs: { execute(command: OcsCommand): Promise<Result<OcsState>> } } }

