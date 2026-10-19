import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { chromium, type CDPSession, type Page } from 'playwright-core';
import { z } from 'zod';
import { loadScript, parseUserScript, type ScriptProgram } from '../desktop/bun/ocs-assets';
import { emptyOcsDocument, savedScriptSchema, type SavedScript } from '../desktop/bun/ocs-document';
import { createOcsRepository } from '../desktop/bun/ocs-storage';
import { applyOcsConfigSync, convertOcsConfigToGmValues, prepareOcsConfigSync, revokeOcsConfigSync, updateOcsConfigSyncAuthorization } from '../desktop/bun/ocs-config-sync';
import { createGmStorage } from '../desktop/bun/ocs-gm-storage';
import { mergeConfig, publicConfig } from '../desktop/bun/ocs-privacy';
import { attachUserScripts, type UserScriptController } from '../desktop/ocs/userscripts';

function authoredScript(id: string): ScriptProgram {
  return parseUserScript(id, ['// ==UserScript==', '// @name OCS exact authorization test', '// @namespace OCS official self-claim is not trust', '// @version 1', '// @match http://127.0.0.1/*', '// @grant GM_info', '// @grant GM_getValue', '// @grant GM_setValue', '// ==/UserScript==', 'globalThis.__syncRead = GM_getValue("common.settings.answererWrappers", null);'].join('\n'));
}
function saved(program: ScriptProgram): SavedScript {
  return { id: program.id, name: program.name, version: program.version, source: 'authored-integration', enabled: true, digest: program.digest };
}
async function isolatedDirectory(): Promise<string> {
  const base = process.env['SWU_OCS_CONFIG_SYNC_WORK'];
  if (!base || !isAbsolute(base) || !resolve(base).startsWith(resolve('work') + '\\ocs-config-sync-')) throw new Error('An explicit unique work/ocs-config-sync-* evidence directory is required.');
  await mkdir(base, { recursive: true });
  return await mkdtemp(join(base, 'store-'));
}

test('config authorization binds exact UUID and source digest, never metadata trust', () => {
  const program = authoredScript(randomUUID());
  const item = saved(program);
  expect(savedScriptSchema.parse(item).configSyncDigest).toBeUndefined();
  expect(savedScriptSchema.parse({ ...item, configSyncDigest: null }).configSyncDigest).toBeNull();
  const authorized = updateOcsConfigSyncAuthorization(item, program, { id: item.id, digest: item.digest, authorized: true });
  expect(authorized.configSyncDigest).toBe(program.digest);
  expect(item.configSyncDigest).toBeUndefined();
  expect(() => prepareOcsConfigSync(program, undefined, '{}')).toThrow('not authorized');
  expect(() => updateOcsConfigSyncAuthorization(item, program, { id: randomUUID(), digest: item.digest, authorized: true })).toThrow('stale');
  expect(() => updateOcsConfigSyncAuthorization(item, program, { id: item.id, digest: '0'.repeat(64), authorized: true })).toThrow('stale');
  const changed = parseUserScript(program.id, program.content + '\nvoid 0;');
  expect(() => prepareOcsConfigSync(changed, authorized.configSyncDigest, '{}')).toThrow('not authorized');
  expect(() => prepareOcsConfigSync({ ...program, content: changed.content }, authorized.configSyncDigest, '{}')).toThrow('digest changed');
  expect(updateOcsConfigSyncAuthorization(authorized, program, { id: item.id, digest: item.digest, authorized: false }).configSyncDigest).toBeNull();
});

test('configuration conversion preserves native flat values and excludes helper and nested data', () => {
  const input = JSON.stringify({ 'common.settings.thread': 2, 'cx.new.study.volume': 0.2, 'common.settings.answererWrappers': [{ name: 'authored', headers: { authorization: randomUUID() } }], common: { settings: { thread: 3 } }, server: { port: 15319, authToken: randomUUID() }, 'render.panel.fontSize': 14, 'background.app.closeSync': false, 'zhs.study.studyRecord': [] });
  const result = convertOcsConfigToGmValues(input);
  expect(Object.keys(result).sort()).toEqual(['common.settings.answererWrappers', 'common.settings.thread', 'cx.new.study.volume']);
  expect(result['common.settings.thread']).toBe(2);
  expect(result['cx.new.study.volume']).toBe(0.2);
  expect(Array.isArray(result['common.settings.answererWrappers'])).toBe(true);
  expect(() => convertOcsConfigToGmValues(publicConfig(input))).toThrow('redaction markers');
  expect(convertOcsConfigToGmValues(mergeConfig(publicConfig(input), input))).toEqual(result);
  expect(() => convertOcsConfigToGmValues('[]')).toThrow('JSON object');
  expect(() => convertOcsConfigToGmValues('{')).toThrow('valid private');
  expect(() => convertOcsConfigToGmValues('{"common.settings.thread":1e999}')).toThrow('finite JSON');
  expect(() => convertOcsConfigToGmValues('{"__proto__":1}')).toThrow();
  expect(() => convertOcsConfigToGmValues('{"common.settings.thread":{}}')).toThrow('有效数字');
  expect(() => convertOcsConfigToGmValues('{"common.settings.thread":4}')).toThrow('范围');
  expect(() => convertOcsConfigToGmValues(JSON.stringify({ 'common.settings.answererWrappers': 'bad' }))).toThrow('must be an array');
});

test('real DPAPI sync persists exact script/profile isolation and revokes only owned keys', async () => {
  const root = await isolatedDirectory();
  const profileId = randomUUID();
  const program = authoredScript(randomUUID());
  const authorized = updateOcsConfigSyncAuthorization(saved(program), program, { id: program.id, digest: program.digest, authorized: true });
  const repository = createOcsRepository(root);
  await repository.save({ ...emptyOcsDocument(), userScripts: [authorized] });
  expect((await createOcsRepository(root).read()).userScripts[0]?.configSyncDigest).toBe(program.digest);
  const store = createGmStorage(root, profileId, program.id, program.digest);
  const secret = 'authored-private-' + randomUUID();
  const config = JSON.stringify({ 'common.settings.thread': 2, 'common.settings.answererWrappers': [{ name: 'authored', headers: { authorization: secret } }] });
  await store.save({ 'common.settings.thread': 1, scriptOwned: { keep: true } });
  await expect(applyOcsConfigSync(root, profileId, program, null, config)).rejects.toThrow('not authorized');
  expect(await store.read()).toEqual({ 'common.settings.thread': 1, scriptOwned: { keep: true } });
  expect(await applyOcsConfigSync(root, profileId, program, authorized.configSyncDigest, config)).toEqual({ writtenKeys: 2, restoredKeys: 0, removedKeys: 0 });
  const values = await createGmStorage(root, profileId, program.id, program.digest).read();
  expect(values['common.settings.thread']).toBe(2);
  expect(JSON.stringify(values).includes(secret)).toBe(true);
  const encrypted = await readFile(join(root, 'gm-values', profileId, program.id, program.digest + '.dpapi.json'), 'utf8');
  expect(encrypted.includes(secret)).toBe(false);
  expect(JSON.parse(encrypted).protection).toBe('windows-current-user-dpapi');
  expect(await createGmStorage(root, randomUUID(), program.id, program.digest).read()).toEqual({});
  expect(await createGmStorage(root, profileId, randomUUID(), program.digest).read()).toEqual({});
  const changed = parseUserScript(program.id, program.content + '\nvoid 1;');
  expect(await createGmStorage(root, profileId, program.id, changed.digest).read()).toEqual({});
  await expect(applyOcsConfigSync(root, profileId, changed, authorized.configSyncDigest, config)).rejects.toThrow('not authorized');
  await store.save({ ...values, scriptLater: 7 });
  expect((await applyOcsConfigSync(root, profileId, program, authorized.configSyncDigest, '{"common.settings.thread":3}')).writtenKeys).toBe(1);
  const updated = await store.read();
  expect(updated['common.settings.answererWrappers']).toBeUndefined();
  expect(updated['scriptLater']).toBe(7);
  const revoked = await revokeOcsConfigSync(root, profileId, program.id, program.digest);
  expect(revoked.restoredKeys).toBe(1);
  expect(await store.read()).toEqual({ 'common.settings.thread': 1, scriptOwned: { keep: true }, scriptLater: 7 });
  expect(await revokeOcsConfigSync(root, profileId, program.id, program.digest)).toEqual({ writtenKeys: 0, restoredKeys: 0, removedKeys: 0 });
  await applyOcsConfigSync(root, profileId, program, authorized.configSyncDigest, '{"common.settings.thread":2,"cx.new.study.volume":0.3}');
  await applyOcsConfigSync(root, profileId, program, authorized.configSyncDigest, '{"common.settings.thread":1}');
  await store.save({ ...(await store.read()), 'cx.new.study.volume': 0.7 });
  expect((await applyOcsConfigSync(root, profileId, program, authorized.configSyncDigest, '{"common.settings.thread":2}')).writtenKeys).toBe(1);
  expect(await store.read()).toMatchObject({ 'common.settings.thread': 2, 'cx.new.study.volume': 0.7, scriptOwned: { keep: true }, scriptLater: 7 });
  const released = await revokeOcsConfigSync(root, profileId, program.id, program.digest);
  expect(released.restoredKeys).toBe(1);
  expect(await store.read()).toEqual({ 'common.settings.thread': 1, 'cx.new.study.volume': 0.7, scriptOwned: { keep: true }, scriptLater: 7 });
  expect(await revokeOcsConfigSync(root, profileId, program.id, program.digest)).toEqual({ writtenKeys: 0, restoredKeys: 0, removedKeys: 0 });
  const full = Object.fromEntries(Array.from({ length: 128 }, (_, index) => ['script-' + index, index]));
  await store.save(full);
  await expect(applyOcsConfigSync(root, profileId, program, authorized.configSyncDigest, config)).rejects.toThrow('128 keys');
  expect(await store.read()).toEqual(full);
  await store.save({ scriptOwned: 'x'.repeat(500_000) });
  const oversized = JSON.stringify({ 'common.settings.answererWrappers': [{ data: 'y'.repeat(30_000) }] });
  await expect(applyOcsConfigSync(root, profileId, program, authorized.configSyncDigest, oversized)).rejects.toThrow('512 KiB');
  expect(JSON.stringify(await store.read()).length).toBe(JSON.stringify({ scriptOwned: 'x'.repeat(500_000) }).length);
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts', program.id + '.user.js'), changed.content, 'utf8');
  await expect(loadScript(root, authorized)).rejects.toThrow('内容校验失败');
  await writeFile(join(root, 'result.json'), JSON.stringify({ status: 'passed', dpapi: true, scriptProfileDigestIsolation: true, revokeRestoresOriginal: true, quotaFailurePreservesValues: true, loadScriptToctou: true, schoolAccounts: false, modelRequests: 0 }));
}, 60_000);

const contextSchema = z.object({ context: z.object({ id: z.number().int(), name: z.string() }) });
async function observe(page: Page): Promise<{ session: CDPSession; worlds: Map<number, string> }> {
  const session = await page.context().newCDPSession(page);
  const worlds = new Map<number, string>();
  session.on('Runtime.executionContextCreated', (value: unknown) => { const context = contextSchema.parse(value).context; worlds.set(context.id, context.name); });
  session.on('Runtime.executionContextsCleared', () => worlds.clear());
  await session.send('Runtime.enable');
  return { session, worlds };
}
async function isolatedRead(inspector: Awaited<ReturnType<typeof observe>>, scriptId: string): Promise<unknown> {
  for (const [contextId, name] of inspector.worlds) {
    if (!name.startsWith('swu-gm-')) continue;
    const reply = await inspector.session.send('Runtime.evaluate', { contextId, expression: '({id:globalThis.__syncScriptId,values:globalThis.__syncRead,keys:GM_listValues()})', returnByValue: true });
    if (reply.exceptionDetails) throw new Error('OCS isolated read expression failed.');
    const value = z.object({ id: z.string(), values: z.unknown(), keys: z.array(z.string()) }).parse(reply.result.value);
    if (value.id === scriptId) return value;
  }
  throw new Error('Exact imported script isolated world was not observed.');
}

const chromeTest = process.env['SWU_OCS_CONFIG_SYNC_BROWSER'] ? test : test.skip;
chromeTest('real Chrome isolated script reads private synced values while same-name sibling and page cannot', async () => {
  const executablePath = process.env['SWU_OCS_CONFIG_SYNC_BROWSER'];
  if (!executablePath || !isAbsolute(executablePath)) throw new Error('Explicit Chrome executable is required.');
  const root = await isolatedDirectory();
  const profileId = randomUUID();
  const source = authoredScript(randomUUID()).content.replace('// @grant GM_setValue', '// @grant GM_setValue\n// @grant GM_listValues');
  const approvedId = randomUUID();
  const siblingId = randomUUID();
  const approved = parseUserScript(approvedId, source + '\n globalThis.__syncScriptId=' + JSON.stringify(approvedId) + ';');
  const sibling = parseUserScript(siblingId, source + '\n globalThis.__syncScriptId=' + JSON.stringify(siblingId) + ';');
  const secret = randomUUID();
  const config = JSON.stringify({ 'common.settings.answererWrappers': [{ headers: { authorization: secret } }] });
  await applyOcsConfigSync(root, profileId, approved, approved.digest, config);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response('<!doctype html><html><body><div id="sync-test"></div></body></html>', { headers: { 'Content-Type': 'text/html' } }); } });
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking', '--no-first-run'] });
  let controller: UserScriptController | null = null;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const inspector = await observe(page);
    controller = await attachUserScripts(context, [approved, sibling], (_id, outcome) => { if (outcome === 'failed') throw new Error('Authored sync read script failed.'); }, { root, profileId });
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'load' });
    await controller.flush();
    const first = z.object({ values: z.unknown(), keys: z.array(z.string()) }).parse(await isolatedRead(inspector, approved.id));
    const second = z.object({ values: z.unknown(), keys: z.array(z.string()) }).parse(await isolatedRead(inspector, sibling.id));
    expect(JSON.stringify(first.values).includes(secret)).toBe(true);
    expect(first.keys).toEqual(['common.settings.answererWrappers']);
    expect(second.values).toBeNull();
    expect(second.keys).toEqual([]);
    expect(await page.evaluate(() => typeof Reflect.get(globalThis, 'GM_getValue'))).toBe('undefined');
    expect((await page.content()).includes(secret)).toBe(false);
    await controller.dispose(); controller = null;
    await context.close();
    await revokeOcsConfigSync(root, profileId, approved.id, approved.digest);
    expect(await createGmStorage(root, profileId, approved.id, approved.digest).read()).toEqual({});
    await writeFile(join(root, 'chrome-result.json'), JSON.stringify({ status: 'passed', realChrome: true, isolatedWorldPrivateRead: true, sameNameSiblingDenied: true, pageDenied: true, journalNotExposed: true, revokedKeysRemoved: true, schoolAccounts: false, modelRequests: 0 }));
  } finally {
    if (controller) await controller.dispose();
    await browser.close();
    await server.stop(true);
  }
}, 60_000);
