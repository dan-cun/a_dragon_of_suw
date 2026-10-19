import { z } from 'zod';
import { ocsBrowserSchema, ocsSettingsSchema } from '../shared/ocs';

const identifier = z.string().uuid();
export const savedBrowserSchema = ocsBrowserSchema.omit({ phase: true, pid: true, owned: true, lastError: true });
export const savedScriptSchema = z.object({ id: identifier, name: z.string(), version: z.string(), source: z.string(), enabled: z.boolean(), digest: z.string().regex(/^[a-f0-9]{64}$/), configSyncDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional() }).strict();
export const savedExtensionSchema = z.object({ id: identifier, name: z.string(), version: z.string(), enabled: z.boolean() }).strict();
export const automationSchema = z.object({ browserId: identifier, name: z.string(), values: z.array(z.object({ key: z.string(), value: z.string() }).strict()).max(30) }).strict();
export const ocsDocumentSchema = z.object({
  schemaVersion: z.literal(1), browsers: z.array(savedBrowserSchema).max(100),
  userScripts: z.array(savedScriptSchema).max(100), extensions: z.array(savedExtensionSchema).max(30),
  settings: ocsSettingsSchema, automations: z.array(automationSchema).max(100)
}).strict().superRefine((document, context) => {
  for (const collection of [document.browsers, document.userScripts, document.extensions]) {
    if (new Set(collection.map(value => value.id)).size !== collection.length) context.addIssue({ code: 'custom', message: 'Duplicate OCS identifier.' });
  }
  if (new Set(document.automations.map(value => value.browserId)).size !== document.automations.length) context.addIssue({ code: 'custom', message: 'Duplicate OCS automation.' });
  if (document.automations.some(value => !document.browsers.some(browser => browser.id === value.browserId))) context.addIssue({ code: 'custom', message: 'OCS automation browser does not exist.' });
});
export type OcsDocument = z.infer<typeof ocsDocumentSchema>;
export type SavedBrowser = z.infer<typeof savedBrowserSchema>;
export type SavedScript = z.infer<typeof savedScriptSchema>;
export type SavedExtension = z.infer<typeof savedExtensionSchema>;
export type Automation = z.infer<typeof automationSchema>;

export function emptyOcsDocument(): OcsDocument {
  return { schemaVersion: 1, browsers: [], userScripts: [], extensions: [], automations: [], settings: { syncEnabled: false, enableDialogs: false, forceUpdateScripts: false, globalConfigJson: '{}' } };
}
