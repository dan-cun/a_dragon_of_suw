import { z } from 'zod';
import { parseUserScript, type ScriptProgram } from './ocs-assets';
import { savedScriptSchema, type SavedScript } from './ocs-document';
import { createGmStorage, type GmStorage } from './ocs-gm-storage';
import { ownedPath } from './ocs-storage';
import { gmKeySchema, gmValue, gmValues, type GmValue, type GmValues } from '../ocs/gm-types';
import { ocsConfigCatalog, ocsConfigFieldKey, ocsConfigPrivateMarker, validateOcsConfigValue } from '../shared/ocs-config';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ocsConfigSyncAuthorizationSchema = z.object({ id: z.string().uuid(), digest: digestSchema, authorized: z.boolean() }).strict();
export type OcsConfigSyncAuthorization = z.infer<typeof ocsConfigSyncAuthorizationSchema>;
export interface OcsConfigSyncStats { writtenKeys: number; restoredKeys: number; removedKeys: number }
export interface OcsConfigSyncPlan { scriptId: string; digest: string; values: GmValues }
interface SyncJournal { original: GmValues; keys: string[] }

// OCSJS 5.2.1 uses easy-us 1.0.15 namespaceKey and GMStoreProvider.set without JSON stringification.
// The scalar catalog and common.settings.answererWrappers are the explicitly supported sync subset.
const syncKeys = new Set([...ocsConfigCatalog.groups.flatMap(group => group.fields.map(ocsConfigFieldKey)), 'common.settings.answererWrappers']);

function verifiedProgram(program: ScriptProgram): ScriptProgram {
  z.string().uuid().parse(program.id);
  const parsed = parseUserScript(program.id, program.content);
  if (parsed.digest !== program.digest) throw new TypeError('OCS config sync source digest changed; reload the imported script.');
  if (!parsed.supported || !program.supported || !parsed.grants.includes('GM_getValue')) throw new TypeError('OCS config sync requires a supported imported script with GM_getValue.');
  return parsed;
}

/** The caller must stop every owned browser before changing authorization or applying/revoking sync. */
export function updateOcsConfigSyncAuthorization(script: SavedScript, program: ScriptProgram, input: OcsConfigSyncAuthorization): SavedScript {
  const current = savedScriptSchema.parse(script);
  const request = ocsConfigSyncAuthorizationSchema.parse(input);
  if (request.id !== current.id || request.digest !== current.digest || program.id !== current.id || program.digest !== current.digest) throw new TypeError('OCS config sync authorization refers to a stale script identity or source digest.');
  // Revocation must remain possible even when a script no longer has supported grants.
  if (parseUserScript(program.id, program.content).digest !== current.digest) throw new TypeError('OCS config sync authorization source digest changed; reload the imported script.');
  if (request.authorized) verifiedProgram(program);
  return { ...current, configSyncDigest: request.authorized ? current.digest : null };
}

function hasPrivateMarker(value: GmValue): boolean {
  if (value === ocsConfigPrivateMarker) return true;
  if (Array.isArray(value)) return value.some(hasPrivateMarker);
  return value !== null && typeof value === 'object' && Object.values(value).some(hasPrivateMarker);
}

/** Copy only present, supported flat keys. Never flatten objects, inject defaults or expose helper credentials. */
export function convertOcsConfigToGmValues(globalConfigJson: string): GmValues {
  if (Buffer.byteLength(globalConfigJson) > 524_288) throw new RangeError('OCS config sync input exceeds 512 KiB.');
  let raw: unknown;
  try { raw = JSON.parse(globalConfigJson); }
  catch (cause) { throw new SyntaxError('OCS config sync requires valid private configuration JSON.', { cause }); }
  const document = gmValue(raw, 0);
  if (document === null || typeof document !== 'object' || Array.isArray(document)) throw new TypeError('OCS config sync configuration must be a JSON object.');
  const selected = gmValues(Object.fromEntries(Object.entries(document).filter(([key]) => syncKeys.has(key))));
  if (Object.values(selected).some(hasPrivateMarker)) throw new TypeError('OCS config sync requires merged private values, not public redaction markers.');
  for (const group of ocsConfigCatalog.groups) for (const field of group.fields) {
    const key = ocsConfigFieldKey(field);
    if (Object.hasOwn(selected, key)) validateOcsConfigValue(field, selected[key]);
  }
  if (Object.hasOwn(selected, 'common.settings.answererWrappers') && !Array.isArray(selected['common.settings.answererWrappers'])) throw new TypeError('OCS common.settings.answererWrappers must be an array.');
  return selected;
}

/** Prepare in private host memory only; neither the plan nor its values may be returned to the renderer. */
export function prepareOcsConfigSync(program: ScriptProgram, authorizationDigest: string | null | undefined, globalConfigJson: string): OcsConfigSyncPlan {
  const parsed = verifiedProgram(program);
  if (authorizationDigest !== parsed.digest) throw new TypeError('OCS private configuration access is not authorized for this exact script digest.');
  return { scriptId: parsed.id, digest: parsed.digest, values: convertOcsConfigToGmValues(globalConfigJson) };
}

function readJournal(values: GmValues): SyncJournal {
  if (Object.keys(values).length === 0) return { original: {}, keys: [] };
  const raw = z.object({ original: z.unknown(), keys: z.array(gmKeySchema).max(128) }).strict().parse(values);
  const original = gmValues(raw.original);
  if (new Set(raw.keys).size !== raw.keys.length || Object.keys(original).some(key => !raw.keys.includes(key))) throw new TypeError('OCS config sync journal ownership is invalid.');
  if (raw.keys.some(key => !syncKeys.has(key))) throw new TypeError('OCS config sync journal contains an unsupported key.');
  return { original, keys: raw.keys };
}

function restoreValues(current: GmValues, journal: SyncJournal): { values: GmValues; restoredKeys: number; removedKeys: number } {
  const untouched = Object.fromEntries(Object.entries(current).filter(([key]) => !journal.keys.includes(key)));
  const removedKeys = journal.keys.filter(key => !Object.hasOwn(journal.original, key) && Object.hasOwn(current, key)).length;
  return { values: gmValues({ ...untouched, ...journal.original }), restoredKeys: Object.keys(journal.original).length, removedKeys };
}

function journalStorage(root: string, profileId: string, scriptId: string, digest: string): GmStorage {
  // Keep the ownership journal outside the root given to the script runtime: GM APIs cannot alter it.
  return createGmStorage(ownedPath(root, 'config-sync-journal'), profileId, scriptId, digest);
}

/** Call only when syncEnabled is true, with current authorization, before attaching any script runtime. */
export async function applyOcsConfigSync(root: string, profileId: string, program: ScriptProgram, authorizationDigest: string | null | undefined, globalConfigJson: string): Promise<OcsConfigSyncStats> {
  const plan = prepareOcsConfigSync(program, authorizationDigest, globalConfigJson);
  const storage = createGmStorage(root, profileId, plan.scriptId, plan.digest);
  const journalStore = journalStorage(root, profileId, plan.scriptId, plan.digest);
  const current = await storage.read();
  const journal = readJournal(await journalStore.read());
  const restored = restoreValues(current, journal);
  const keys = [...new Set([...journal.keys, ...Object.keys(plan.values)])];
  const original = gmValues({ ...journal.original, ...Object.fromEntries(Object.entries(current).filter(([key]) => Object.hasOwn(plan.values, key) && !journal.keys.includes(key))) });
  const next = gmValues({ ...restored.values, ...plan.values });
  // Validate and persist ownership before values: interrupted writes remain explicitly revocable.
  const pendingJournal = gmValues({ original, keys });
  await journalStore.save(pendingJournal);
  await storage.save(next);
  const syncedOriginal = gmValues(Object.fromEntries(Object.entries(original).filter(([key]) => Object.hasOwn(plan.values, key))));
  await journalStore.save(gmValues({ original: syncedOriginal, keys: Object.keys(plan.values) }));
  return { writtenKeys: Object.keys(plan.values).length, restoredKeys: restored.restoredKeys, removedKeys: restored.removedKeys };
}

/** Restore overwritten originals and delete injected keys, preserving all other script data. Disclosed secrets cannot be recalled. */
export async function revokeOcsConfigSync(root: string, profileId: string, scriptId: string, digest: string): Promise<OcsConfigSyncStats> {
  digestSchema.parse(digest);
  const storage = createGmStorage(root, profileId, scriptId, digest);
  const journalStore = journalStorage(root, profileId, scriptId, digest);
  const journal = readJournal(await journalStore.read());
  if (journal.keys.length === 0) return { writtenKeys: 0, restoredKeys: 0, removedKeys: 0 };
  const restored = restoreValues(await storage.read(), journal);
  // Clear ownership last so a failed write can be retried without losing original values.
  await storage.save(restored.values);
  await journalStore.save({});
  return { writtenKeys: 0, restoredKeys: restored.restoredKeys, removedKeys: restored.removedKeys };
}
